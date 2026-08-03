import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTools } from "../src/generator/tools.js";
import type { OpenAPIDoc } from "../src/parser/openapi.js";

/** A minimal spec exercising every HTTP verb the annotation rules key off. */
const SPEC: OpenAPIDoc = {
  openapi: "3.0.0",
  paths: {
    "/items": {
      get: { operationId: "listItems", responses: {} },
      post: { operationId: "createItem", responses: {} },
    },
    "/items/{id}": {
      get: { operationId: "getItem", responses: {} },
      put: { operationId: "replaceItem", responses: {} },
      patch: { operationId: "patchItem", responses: {} },
      delete: { operationId: "deleteItem", responses: {} },
      head: { operationId: "headItem", responses: {} },
    },
  },
};

function byOpId(tools: ReturnType<typeof buildTools>, opId: string) {
  const t = tools.find((x) => x.name.toLowerCase().includes(opId.toLowerCase()) || x.name === opId);
  assert.ok(t, `expected a tool derived from operationId "${opId}"`);
  return t;
}

test("GET/HEAD default to read-only, non-destructive, idempotent annotations", () => {
  const tools = buildTools(SPEC, {});
  for (const opId of ["listItems", "getItem", "headItem"]) {
    const t = byOpId(tools, opId);
    assert.deepEqual(t.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  }
});

test("POST defaults to neither read-only nor destructive", () => {
  const tools = buildTools(SPEC, {});
  const t = byOpId(tools, "createItem");
  assert.deepEqual(t.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
});

test("DELETE and PUT default to destructive + idempotent; PATCH destructive but not idempotent", () => {
  const tools = buildTools(SPEC, {});
  assert.deepEqual(byOpId(tools, "deleteItem").annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(byOpId(tools, "replaceItem").annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(byOpId(tools, "patchItem").annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
});

test("destructiveMethods override lets an operator mark PUT/PATCH as safe", () => {
  const tools = buildTools(SPEC, {}, { destructiveMethods: new Set(["delete"]) });
  assert.equal(byOpId(tools, "replaceItem").annotations?.destructiveHint, false);
  assert.equal(byOpId(tools, "patchItem").annotations?.destructiveHint, false);
  assert.equal(byOpId(tools, "deleteItem").annotations?.destructiveHint, true);
});
