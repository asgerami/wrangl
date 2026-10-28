import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTools, hasChanges } from "../src/generator/diff.js";
import type { ToolDef } from "../src/types.js";

function tool(over: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "get_thing",
    description: "Get a thing.",
    method: "GET",
    pathTemplate: "/things/{id}",
    params: [
      {
        name: "id",
        sourceName: "id",
        location: "path",
        required: true,
        schema: { type: "string" },
        style: "simple",
        explode: false,
      },
    ],
    body: undefined,
    security: [],
    ...over,
  };
}

test("detects added and removed tools", () => {
  const a = [tool({ name: "x" }), tool({ name: "y" })];
  const b = [tool({ name: "y" }), tool({ name: "z" })];
  const diff = diffTools(a, b);
  assert.deepEqual(diff.added, ["z"]);
  assert.deepEqual(diff.removed, ["x"]);
  assert.equal(diff.changed.length, 0);
  assert.equal(hasChanges(diff), true);
});

test("identical tool sets produce no changes", () => {
  const a = [tool({ name: "x" })];
  const b = [tool({ name: "x" })];
  const diff = diffTools(a, b);
  assert.equal(hasChanges(diff), false);
});

test("flags description, params, endpoint, security, output changes", () => {
  const before = [tool({ name: "x" })];
  const after = [
    tool({
      name: "x",
      description: "Changed.",
      method: "POST",
      security: ["bearerAuth"],
      outputSchema: { type: "object", properties: { id: { type: "integer" } } },
      params: [
        {
          name: "id",
          sourceName: "id",
          location: "query", // was path
          required: false,
          schema: { type: "string" },
          style: "form",
          explode: true,
        },
      ],
    }),
  ];
  const diff = diffTools(before, after);
  assert.equal(diff.changed.length, 1);
  const changes = diff.changed[0].changes;
  for (const expected of ["endpoint", "description", "params", "security", "output"]) {
    assert.ok(changes.includes(expected), `expected change "${expected}" in ${changes}`);
  }
});

test("a param's type, enum, or description change is detected, as are annotations", () => {
  const base = tool();
  const param = base.params[0];
  const variants: Array<[string, ToolDef]> = [
    ["type", tool({ params: [{ ...param, schema: { type: "integer" } }] })],
    ["enum", tool({ params: [{ ...param, schema: { type: "string", enum: ["a", "b"] } }] })],
    ["description", tool({ params: [{ ...param, description: "The thing's id." }] })],
  ];
  for (const [what, next] of variants) {
    assert.deepEqual(diffTools([base], [next]).changed, [{ name: "get_thing", changes: ["params"] }], what);
  }

  const destructive = tool({ annotations: { destructiveHint: true } });
  assert.deepEqual(diffTools([base], [destructive]).changed[0].changes, ["annotations"]);
});

test("body changes are detected", () => {
  const before = [tool({ name: "x" })];
  const after = [
    tool({
      name: "x",
      body: { required: true, contentType: "application/json", schema: { type: "object" } },
    }),
  ];
  assert.deepEqual(diffTools(before, after).changed[0].changes, ["body"]);
});
