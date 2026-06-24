import type { ToolDef } from "../types.js";

/**
 * Diff two sets of generated tools so a running server can hot-reload only what
 * actually changed when a spec is re-ingested (the "live sync" feature).
 */

export interface ToolChange {
  name: string;
  /** Human-readable list of what differs, e.g. "params", "description". */
  changes: string[];
}

export interface SpecDiff {
  added: string[];
  removed: string[];
  changed: ToolChange[];
}

/** Whether a diff contains any actual change. */
export function hasChanges(diff: SpecDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

export function diffTools(oldTools: ToolDef[], newTools: ToolDef[]): SpecDiff {
  const oldByName = new Map(oldTools.map((t) => [t.name, t]));
  const newByName = new Map(newTools.map((t) => [t.name, t]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: ToolChange[] = [];

  for (const name of newByName.keys()) {
    if (!oldByName.has(name)) added.push(name);
  }
  for (const name of oldByName.keys()) {
    if (!newByName.has(name)) removed.push(name);
  }
  for (const [name, oldTool] of oldByName) {
    const newTool = newByName.get(name);
    if (!newTool) continue;
    const changes = describeChanges(oldTool, newTool);
    if (changes.length > 0) changed.push({ name, changes });
  }

  return { added: added.sort(), removed: removed.sort(), changed };
}

/** Compare two tools of the same name and list which aspects differ. */
function describeChanges(a: ToolDef, b: ToolDef): string[] {
  const changes: string[] = [];
  if (a.method !== b.method || a.pathTemplate !== b.pathTemplate) changes.push("endpoint");
  if (a.description !== b.description) changes.push("description");
  if (paramSignature(a) !== paramSignature(b)) changes.push("params");
  if (bodySignature(a) !== bodySignature(b)) changes.push("body");
  if (sorted(a.security) !== sorted(b.security)) changes.push("security");
  if (stable(a.outputSchema) !== stable(b.outputSchema)) changes.push("output");
  return changes;
}

/** Stable signature of a tool's parameters (the parts the runtime depends on). */
function paramSignature(tool: ToolDef): string {
  return tool.params
    .map((p) => `${p.sourceName}:${p.location}:${p.required}:${p.style}:${p.explode}`)
    .sort()
    .join("|");
}

function bodySignature(tool: ToolDef): string {
  if (!tool.body) return "";
  return `${tool.body.contentType}:${tool.body.required}:${stable(tool.body.schema)}`;
}

function sorted(values: string[]): string {
  return [...values].sort().join(",");
}

function stable(value: unknown): string {
  // Both sides are produced by the same deterministic generator, so plain
  // stringify yields a consistent key order and is a sound equality check.
  return value === undefined ? "" : JSON.stringify(value);
}

/** One-line summary of a diff for logging. */
export function formatDiff(diff: SpecDiff): string {
  const parts = [
    `+${diff.added.length} added`,
    `~${diff.changed.length} changed`,
    `-${diff.removed.length} removed`,
  ];
  const detail: string[] = [];
  for (const n of diff.added) detail.push(`  + ${n}`);
  for (const c of diff.changed) detail.push(`  ~ ${c.name} (${c.changes.join(", ")})`);
  for (const n of diff.removed) detail.push(`  - ${n}`);
  return [parts.join("  "), ...detail].join("\n");
}
