import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildBatchPrompt,
  applyEnrichment,
  enrichTools,
  type EnrichmentBatchResult,
} from "../src/generator/enrich.js";
import type { ToolDef } from "../src/types.js";

function tool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "post_v1_contacts",
    description: "POST /v1/contacts\n\n(HTTP POST /v1/contacts)",
    method: "POST",
    pathTemplate: "/v1/contacts",
    params: [
      {
        name: "limit",
        sourceName: "limit",
        location: "query",
        required: false,
        schema: { type: "integer" },
      },
    ],
    security: [],
    ...overrides,
  };
}

test("buildBatchPrompt includes method, path, name, and params", () => {
  const prompt = buildBatchPrompt([tool()]);
  assert.match(prompt, /Endpoint 0:/);
  assert.match(prompt, /POST \/v1\/contacts/);
  assert.match(prompt, /current name: post_v1_contacts/);
  assert.match(prompt, /limit \(query\)/);
});

test("applyEnrichment rewrites name, description, and param descriptions", () => {
  const batch = [tool()];
  const result: EnrichmentBatchResult = {
    tools: [
      {
        index: 0,
        name: "Create Contact", // exercises sanitization
        description: "Create a new contact in the CRM.",
        parameters: [{ name: "limit", description: "Max results to return." }],
      },
    ],
  };
  const [enriched] = applyEnrichment(batch, result);
  assert.equal(enriched.name, "create_contact");
  assert.equal(enriched.description, "Create a new contact in the CRM.");
  assert.equal(enriched.params[0].description, "Max results to return.");
  // Structural fields are untouched.
  assert.equal(enriched.method, "POST");
  assert.equal(enriched.pathTemplate, "/v1/contacts");
});

test("applyEnrichment leaves a tool untouched when the model omits it", () => {
  const batch = [tool()];
  const [enriched] = applyEnrichment(batch, { tools: [] });
  assert.equal(enriched.name, "post_v1_contacts");
});

test("enrichTools dedupes colliding names the model produces", async () => {
  const batch = [tool({ name: "a" }), tool({ name: "b" })];
  // Fake client: both tools get rewritten to the same name.
  const fakeClient = {
    beta: { messages: {
      parse: async () => ({
        parsed_output: {
          tools: [
            { index: 0, name: "get_thing", description: "First.", parameters: [] },
            { index: 1, name: "get_thing", description: "Second.", parameters: [] },
          ],
        },
      }),
    } },
  } as unknown as Anthropic;

  const enriched = await enrichTools(batch, { client: fakeClient });
  assert.deepEqual(
    enriched.map((t) => t.name),
    ["get_thing", "get_thing_2"],
  );
});

test("enrichTools batches and reports progress", async () => {
  const tools = Array.from({ length: 5 }, (_, i) => tool({ name: `t${i}` }));
  let calls = 0;
  const fakeClient = {
    beta: { messages: {
      parse: async (params: { messages: { content: string }[] }) => {
        calls++;
        // Echo back enriched entries for whatever indices the prompt described.
        const count = (params.messages[0].content.match(/Endpoint \d+:/g) ?? [])
          .length;
        return {
          parsed_output: {
            tools: Array.from({ length: count }, (_, i) => ({
              index: i,
              name: `enriched_${i}`,
              description: "desc",
              parameters: [],
            })),
          },
        };
      },
    } },
  } as unknown as Anthropic;

  const progress: Array<[number, number]> = [];
  const enriched = await enrichTools(tools, {
    client: fakeClient,
    batchSize: 2,
    onBatch: (done, total) => progress.push([done, total]),
  });

  assert.equal(calls, 3); // 2 + 2 + 1
  assert.equal(enriched.length, 5);
  assert.deepEqual(progress, [
    [2, 5],
    [4, 5],
    [5, 5],
  ]);
});

test("enrichTools returns empty for empty input without calling the API", async () => {
  let called = false;
  const fakeClient = {
    beta: { messages: { parse: async () => ((called = true), { parsed_output: { tools: [] } }) } },
  } as unknown as Anthropic;
  const result = await enrichTools([], { client: fakeClient });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("an API error names its likely fix instead of a generic endpoint hint", async () => {
  const failingWith = (err: Error) =>
    ({ beta: { messages: { parse: async () => Promise.reject(err) } } }) as unknown as Anthropic;
  const cases: Array<[Error, RegExp, RegExp | undefined]> = [
    [new Anthropic.AuthenticationError(401, {}, "invalid x-api-key", new Headers()), /Check ANTHROPIC_API_KEY/, /structured-output/],
    [new Anthropic.NotFoundError(404, {}, "model: nope", new Headers()), /Check the --model id/, undefined],
    [new Anthropic.APIConnectionError({ message: "Connection error." }), /Couldn't reach the API/, /structured-output/],
  ];
  for (const [err, hint, notHint] of cases) {
    await assert.rejects(
      () => enrichTools([tool()], { client: failingWith(err) }),
      (e: Error) => hint.test(e.message) && (!notHint || !notHint.test(e.message)),
      err.constructor.name,
    );
  }
});

test("refusal fallbacks are on for Opus 5.5 by default and off for other models", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const fakeClient = {
    beta: { messages: { parse: async (params: Record<string, unknown>) => (seen.push(params), { parsed_output: { tools: [] } }) } },
  } as unknown as Anthropic;
  await enrichTools([tool()], { client: fakeClient });
  await enrichTools([tool()], { client: fakeClient, model: "claude-haiku-5-5" });

  assert.equal(seen[0].model, "claude-opus-5-5");
  assert.deepEqual(seen[0].betas, ["server-side-fallback-2026-06-01"]);
  assert.deepEqual(seen[0].fallbacks, [{ model: "claude-opus-4-8" }]);
  assert.equal(seen[1].fallbacks, undefined);
  assert.equal(seen[1].betas, undefined);
});

test("a batch the model declines is reported, not silently left unenriched", async () => {
  const warnings: string[] = [];
  const fakeClient = {
    beta: { messages: { parse: async () => ({ parsed_output: null, stop_reason: "refusal" }) } },
  } as unknown as Anthropic;
  const [result] = await enrichTools([tool()], { client: fakeClient, onWarning: (m) => warnings.push(m) });
  assert.equal(result.name, "post_v1_contacts", "the tool keeps its generated name");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /skipped 1 tools \(stop reason: refusal\)/);
});
