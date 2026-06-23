import { z } from "zod";
import type { JsonSchema, ToolDef } from "../types.js";

/**
 * Convert a generated tool's params + body into a Zod raw shape — the form the
 * MCP SDK's `registerTool({ inputSchema })` expects. Each property becomes a
 * Zod type carrying its description and optionality so agents see rich schemas.
 */
export function toolInputShape(tool: ToolDef): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const param of tool.params) {
    let zodType = jsonSchemaToZod(param.schema);
    if (param.description) zodType = zodType.describe(param.description);
    shape[param.name] = param.required ? zodType : zodType.optional();
  }

  if (tool.body) {
    let bodyType = jsonSchemaToZod(tool.body.schema);
    const desc = tool.body.description ?? "Request body payload.";
    bodyType = bodyType.describe(desc);
    shape.body = tool.body.required ? bodyType : bodyType.optional();
  }

  return shape;
}

/**
 * Best-effort JSON Schema → Zod conversion covering the constructs that show
 * up in real OpenAPI specs. Unknown shapes fall back to `z.any()` so we never
 * fail to register a tool.
 */
export function jsonSchemaToZod(schema: JsonSchema | undefined): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();

  // Handle `type: [...]` unions and nullable by reducing to the primary type.
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const literals: z.ZodTypeAny[] = schema.enum.map((v) =>
      z.literal(v as string | number | boolean),
    );
    const enumType =
      literals.length === 1
        ? literals[0]
        : z.union(
            literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
          );
    return applyNullable(enumType, schema);
  }

  let base: z.ZodTypeAny;
  switch (type) {
    case "string":
      base = z.string();
      break;
    case "integer":
      base = z.number().int();
      break;
    case "number":
      base = z.number();
      break;
    case "boolean":
      base = z.boolean();
      break;
    case "array":
      base = z.array(jsonSchemaToZod(schema.items));
      break;
    case "object":
      base = objectToZod(schema);
      break;
    default:
      // No declared type (or unsupported) — accept anything.
      base = z.any();
  }

  return applyNullable(base, schema);
}

function objectToZod(schema: JsonSchema): z.ZodTypeAny {
  const properties = schema.properties;
  if (!properties || Object.keys(properties).length === 0) {
    // Free-form object; preserve arbitrary keys.
    return z.record(z.string(), z.any());
  }
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    let prop = jsonSchemaToZod(propSchema);
    if (propSchema.description) prop = prop.describe(propSchema.description);
    shape[key] = required.has(key) ? prop : prop.optional();
  }
  // Passthrough so additionalProperties aren't silently dropped at the edge.
  return z.object(shape).passthrough();
}

function applyNullable(base: z.ZodTypeAny, schema: JsonSchema): z.ZodTypeAny {
  const isNullable =
    schema.nullable === true ||
    (Array.isArray(schema.type) && schema.type.includes("null"));
  return isNullable ? base.nullable() : base;
}
