import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { ToolDef } from "../types.js";

/**
 * Semantic-enrichment pass (the product's headline differentiator).
 *
 * The structural generator in `tools.ts` produces deterministic, no-LLM tool
 * definitions. This pass sends those raw stubs to Claude and rewrites the
 * names and descriptions into natural language an agent can select correctly —
 * e.g. `post_v1_contacts` → `create_contact` with a real description.
 *
 * Structured outputs guarantee the model returns validated JSON matching our
 * schema, so there is no fragile parsing and the model retries on mismatch.
 */

export interface EnrichOptions {
  /** Claude model id. Defaults to claude-opus-4-8. */
  model?: string;
  /** Reasoning effort. Defaults to "low" — this is a bulk rewriting task. */
  effort?: "low" | "medium" | "high";
  /** Tools per LLM request. Defaults to 25 to keep output bounded. */
  batchSize?: number;
  /** Inject a client (e.g. for testing). Defaults to a new Anthropic(). */
  client?: Anthropic;
  /** Progress callback, one call per completed batch. */
  onBatch?: (done: number, total: number) => void;
}

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_EFFORT = "low" as const;
const DEFAULT_BATCH_SIZE = 25;

// ---- Structured-output schema ----
// Note: structured outputs forbid free-form object maps (additionalProperties
// must be false), so parameter descriptions come back as an array of pairs.
const EnrichedTool = z.object({
  index: z.number().int().describe("Index of the tool within the batch."),
  name: z
    .string()
    .describe("Improved snake_case tool name an agent will understand."),
  description: z
    .string()
    .describe("One or two sentences describing what the tool does and when to use it."),
  parameters: z
    .array(
      z.object({
        name: z.string().describe("The parameter's existing name, unchanged."),
        description: z.string().describe("Plain-language explanation of the parameter."),
      }),
    )
    .describe("Descriptions for each input parameter."),
});
const EnrichmentBatch = z.object({ tools: z.array(EnrichedTool) });
export type EnrichmentBatchResult = z.infer<typeof EnrichmentBatch>;

const SYSTEM_PROMPT =
  "You rewrite raw REST API endpoints into clear, agent-ready MCP tool " +
  "definitions. AI agents read your names and descriptions to decide which " +
  "tool to call, so be specific and action-oriented. Use imperative " +
  "snake_case names (create_contact, list_orders, get_user_by_id). Keep " +
  "descriptions to one or two sentences. Never invent parameters — describe " +
  "only the ones provided, keeping each parameter's name exactly as given.";

/**
 * Enrich a list of tools in place-safe fashion: returns new ToolDef objects
 * with improved name/description/param descriptions. Order is preserved.
 */
export async function enrichTools(
  tools: ToolDef[],
  options: EnrichOptions = {},
): Promise<ToolDef[]> {
  if (tools.length === 0) return [];

  const client = options.client ?? new Anthropic();
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const batches = chunk(tools, batchSize);
  const enriched: ToolDef[] = [];
  let done = 0;

  for (const batch of batches) {
    let result: EnrichmentBatchResult | null;
    try {
      const response = await client.messages.parse({
        model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        output_config: {
          effort,
          format: zodOutputFormat(EnrichmentBatch),
        },
        messages: [{ role: "user", content: buildBatchPrompt(batch) }],
      });
      result = response.parsed_output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Enrichment request failed for model "${model}". The endpoint must be ` +
          `the Anthropic API (or a compatible gateway) with structured-output ` +
          `support. Check ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL.\n  ${message}`,
      );
    }

    enriched.push(...applyEnrichment(batch, result ?? { tools: [] }));

    done += batch.length;
    options.onBatch?.(done, tools.length);
  }

  // Names may collide after rewriting; re-establish uniqueness across the set.
  return dedupeNames(enriched);
}

/** Render a batch of tool stubs as the user prompt for one LLM request. */
export function buildBatchPrompt(batch: ToolDef[]): string {
  const lines: string[] = [
    "Rewrite each of the following API endpoints into an agent-ready tool.",
    "Return one entry per endpoint, echoing back its `index`.",
    "",
  ];
  batch.forEach((tool, index) => {
    lines.push(`Endpoint ${index}:`);
    lines.push(`  method+path: ${tool.method} ${tool.pathTemplate}`);
    lines.push(`  current name: ${tool.name}`);
    const summary = firstLine(tool.description);
    if (summary) lines.push(`  current description: ${summary}`);
    if (tool.params.length > 0) {
      lines.push(`  parameters:`);
      for (const p of tool.params) {
        const loc = `${p.location}${p.required ? ", required" : ""}`;
        const desc = p.description ? ` — ${p.description}` : "";
        lines.push(`    - ${p.name} (${loc})${desc}`);
      }
    }
    if (tool.body) lines.push(`    - body (request payload)`);
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * Merge model output back onto the original tools by index. Anything the model
 * omitted falls through to the deterministic original, so enrichment can only
 * improve a tool, never drop one.
 */
export function applyEnrichment(
  batch: ToolDef[],
  result: EnrichmentBatchResult,
): ToolDef[] {
  const byIndex = new Map<number, EnrichmentBatchResult["tools"][number]>();
  for (const t of result.tools) byIndex.set(t.index, t);

  return batch.map((tool, index) => {
    const e = byIndex.get(index);
    if (!e) return tool;

    const paramDescriptions = new Map(
      e.parameters.map((p) => [p.name, p.description]),
    );

    return {
      ...tool,
      name: sanitizeName(e.name) || tool.name,
      description: e.description.trim() || tool.description,
      params: tool.params.map((p) => {
        const desc = paramDescriptions.get(p.name);
        return desc ? { ...p, description: desc } : p;
      }),
    };
  });
}

// ---- helpers ----

function sanitizeName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function dedupeNames(tools: ToolDef[]): ToolDef[] {
  const used = new Set<string>();
  return tools.map((tool) => {
    let name = tool.name;
    let i = 2;
    while (used.has(name)) name = `${tool.name}_${i++}`;
    used.add(name);
    return name === tool.name ? tool : { ...tool, name };
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}
