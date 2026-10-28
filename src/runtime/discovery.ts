import type { JsonSchema, ToolDef } from "../types.js";

/**
 * Discovery mode. Instead of one MCP tool per endpoint (GitHub's API alone is
 * 1,200+), the server exposes three: search_endpoints, describe_endpoint, and
 * call_endpoint. An agent then pays for three tool definitions instead of
 * thousands, and picks an endpoint from a short list of search results rather
 * than a tool list too long to reason over.
 *
 * This module holds the pure parts: keyword search and the text the agent
 * reads. The tools themselves are registered in server.ts.
 */

export interface EndpointMatch {
  tool: ToolDef;
  score: number;
}

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 25;

/** Query words that name an action, mapped to the HTTP methods that perform it. */
const VERB_METHODS: Record<string, readonly string[]> = {
  get: ["GET"], fetch: ["GET"], read: ["GET"], list: ["GET"], show: ["GET"],
  find: ["GET"], search: ["GET"], view: ["GET"],
  create: ["POST"], add: ["POST"], new: ["POST"], send: ["POST"], post: ["POST"],
  make: ["POST"], submit: ["POST"],
  update: ["PUT", "PATCH"], edit: ["PUT", "PATCH"], change: ["PUT", "PATCH"],
  modify: ["PUT", "PATCH"], set: ["PUT", "PATCH"], rename: ["PUT", "PATCH"], replace: ["PUT"],
  delete: ["DELETE"], remove: ["DELETE"], destroy: ["DELETE"],
};

/** Words APIs abbreviate in their names and paths, mapped to the short form. */
const ALIASES: Record<string, string> = { repository: "repo" };

const STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "to", "in", "on", "by", "with", "and", "or",
  "my", "me", "i", "all", "from", "some", "this", "that",
]);

/**
 * Normalized words of a name, path, or sentence: camelCase and snake_case are
 * split, everything is lowercased, a plural is reduced to its singular, and a
 * few long forms to the abbreviation APIs use, so "listIssues", "/issues", and
 * "issue" all share the word "issue", and "repositories" matches "repos".
 */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => {
      const one = singular(word);
      return ALIASES[one] ?? one;
    });
}

function singular(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

interface SearchIndex {
  name: Set<string>;
  path: Set<string>;
  tags: Set<string>;
  text: Set<string>;
  params: Set<string>;
}

/** Each tool's words, computed once: an API can have thousands of endpoints. */
const indexes = new WeakMap<ToolDef, SearchIndex>();

function indexOf(tool: ToolDef): SearchIndex {
  let index = indexes.get(tool);
  if (!index) {
    index = {
      // The original operationId keeps its word boundaries (getPetById); the
      // sanitized name has lost them (getpetbyid).
      name: new Set(words(tool.operationId ?? tool.name)),
      path: new Set(words(tool.pathTemplate)),
      tags: new Set((tool.tags ?? []).flatMap(words)),
      text: new Set(words(tool.description)),
      params: new Set(tool.params.flatMap((p) => words(p.sourceName))),
    };
    indexes.set(tool, index);
  }
  return index;
}

/**
 * Rank endpoints against a keyword query. A word scores by where it appears
 * (name > path > tags > description and parameters), an action word like
 * "create" or "delete" scores for endpoints using the matching HTTP method,
 * and endpoints matching every word rank above those matching only some.
 *
 * Then specificity: an endpoint whose name the query explains fully beats one
 * with words the query never asked for, so "create issue" picks issues_create
 * over issues_create_comment, which would otherwise collect more points simply
 * by mentioning "issue" in more places.
 */
export function searchEndpoints(
  tools: ToolDef[],
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
): EndpointMatch[] {
  const terms = [...new Set(words(query))].filter((w) => !STOPWORDS.has(w));
  if (terms.length === 0) return [];

  const matches: EndpointMatch[] = [];
  for (const tool of tools) {
    const index = indexOf(tool);
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      let points = 0;
      if (index.name.has(term)) points += 4;
      if (index.path.has(term)) points += 3;
      if (index.tags.has(term)) points += 2;
      if (index.text.has(term)) points += 1;
      if (index.params.has(term)) points += 1;
      if (VERB_METHODS[term]?.includes(tool.method)) points += 3;
      if (points > 0) matched++;
      score += points;
    }
    if (matched === 0) continue;

    // A name word is explained fully when the query has it, and half when the
    // query names the same HTTP action ("fetch" for "get"), so "get post"
    // still prefers getpost over listposts.
    const explains = (word: string): number => {
      if (terms.includes(word)) return 1;
      const methods = VERB_METHODS[word];
      return methods && terms.some((t) => VERB_METHODS[t]?.some((m) => methods.includes(m))) ? 0.5 : 0;
    };
    const nameWords = [...index.name];
    const explained = nameWords.reduce((sum, word) => sum + explains(word), 0);
    const coverage = nameWords.length ? explained / nameWords.length : 0;
    score += (matched === terms.length ? 5 : 0) + 8 * coverage - (nameWords.length - explained);
    matches.push({ tool, score });
  }
  // Ties go to the shorter path (the general endpoint), then by name.
  const depth = (t: ToolDef) => t.pathTemplate.split("/").length;
  return matches
    .sort((a, b) => b.score - a.score || depth(a.tool) - depth(b.tool) || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit);
}

/** An endpoint's one-line summary, without the "(HTTP METHOD path)" suffix. */
export function summaryOf(tool: ToolDef): string {
  const first = tool.description.split("\n")[0]?.trim() ?? "";
  return first.startsWith("(HTTP ") || first === `${tool.method} ${tool.pathTemplate}` ? "" : first;
}

/** The search results as the agent reads them. */
export function formatSearch(query: string, matches: EndpointMatch[], total: number): string {
  if (matches.length === 0) {
    return (
      `No endpoints matched "${query}" (out of ${total}). Names, paths, tags, and ` +
      `descriptions are searched; try other words for the action or the resource.`
    );
  }
  const lines = matches.map(({ tool }) => {
    const summary = summaryOf(tool);
    return `${tool.name}: ${tool.method} ${tool.pathTemplate}${summary ? `\n  ${summary}` : ""}`;
  });
  return (
    `${matches.length} of ${total} endpoints match "${query}":\n\n${lines.join("\n")}\n\n` +
    `Use describe_endpoint for an endpoint's parameters, then call_endpoint to run it.`
  );
}

/** The JSON Schema of an endpoint's arguments, as call_endpoint expects them. */
export function inputSchemaOf(tool: ToolDef): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const p of tool.params) {
    properties[p.name] = { ...p.schema, ...(p.description ? { description: p.description } : {}) };
    if (p.required) required.push(p.name);
  }
  if (tool.body) {
    properties.body = { ...tool.body.schema, description: tool.body.description ?? "Request body payload." };
    if (tool.body.required) required.push("body");
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** Everything an agent needs to call one endpoint. */
export function describeEndpoint(tool: ToolDef): string {
  return JSON.stringify(
    {
      name: tool.name,
      method: tool.method,
      path: tool.pathTemplate,
      description: tool.description,
      readOnly: tool.annotations?.readOnlyHint ?? tool.method === "GET",
      destructive: tool.annotations?.destructiveHint ?? false,
      inputSchema: inputSchemaOf(tool),
    },
    null,
    2,
  );
}
