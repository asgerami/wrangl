import { test } from "node:test";
import assert from "node:assert/strict";
import { ingest } from "../src/parser/openapi.js";
import { findCatalogEntry } from "../src/controlplane/seed.js";
import { searchEndpoints } from "../src/runtime/discovery.js";

/**
 * Discovery mode is only useful if search finds the endpoint an agent needs,
 * so this checks real tasks against two large, differently named specs:
 * GitHub (1,200+ endpoints, `issues/create` style ids) and Stripe (600+,
 * `PostCustomers` style ids, and POST for updates). Each task's endpoint must
 * rank in the top 3. Network: runs nightly, skipped with WRANGL_SKIP_NETWORK.
 */

const skip = process.env.WRANGL_SKIP_NETWORK === "1";

const TASKS: Record<string, Array<[query: string, endpoint: string]>> = {
  github: [
    ["create an issue", "POST /repos/{owner}/{repo}/issues"],
    ["list pull requests", "GET /repos/{owner}/{repo}/pulls"],
    ["merge a pull request", "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"],
    ["add labels to an issue", "POST /repos/{owner}/{repo}/issues/{issue_number}/labels"],
    ["get a repository", "GET /repos/{owner}/{repo}"],
    ["star a repository", "PUT /user/starred/{owner}/{repo}"],
    ["comment on an issue", "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"],
    ["create a release", "POST /repos/{owner}/{repo}/releases"],
  ],
  stripe: [
    ["create a customer", "POST /v1/customers"],
    ["list charges", "GET /v1/charges"],
    ["retrieve an invoice", "GET /v1/invoices/{invoice}"],
    ["create a payment intent", "POST /v1/payment_intents"],
    ["update a customer", "POST /v1/customers/{customer}"],
    ["list products", "GET /v1/products"],
    ["cancel a subscription", "DELETE /v1/subscriptions/{subscription_exposed_id}"],
    ["create a refund", "POST /v1/refunds"],
  ],
};

for (const [id, tasks] of Object.entries(TASKS)) {
  test(`discovery search finds the right ${id} endpoint in the top 3`, { skip, timeout: 300_000 }, async () => {
    const { tools } = await ingest(findCatalogEntry(id)!.spec);
    const misses: string[] = [];
    for (const [query, endpoint] of tasks) {
      const top = searchEndpoints(tools, query, 3).map((m) => `${m.tool.method} ${m.tool.pathTemplate}`);
      if (!top.includes(endpoint)) misses.push(`"${query}" -> wanted ${endpoint}, got ${top.join(" | ")}`);
    }
    assert.deepEqual(misses, []);
  });
}
