import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  queryCcSwitchBalance,
  readCcSwitchSnapshot,
  resolveCcSwitchDatabasePath,
} from "../scripts/ccswitch-client.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-ccswitch-"));
const databasePath = path.join(root, "cc-switch.db");
const database = new DatabaseSync(databasePath);
database.exec(`
  CREATE TABLE providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',
    is_current INTEGER NOT NULL DEFAULT 0, sort_index INTEGER, created_at INTEGER
  );
  CREATE TABLE usage_daily_rollups (
    date TEXT, app_type TEXT, provider_id TEXT, request_count INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER, total_cost_usd REAL
  );
  CREATE TABLE proxy_request_logs (
    request_id TEXT, provider_id TEXT, app_type TEXT, model TEXT, request_model TEXT,
    total_cost_usd REAL, latency_ms INTEGER, created_at INTEGER, status_code INTEGER
  );
`);
const usageCode = `({
  request: { url: "{{baseUrl}}/v1/usage", method: "GET", headers: { Authorization: "Bearer {{apiKey}}" } },
  extractor: function(response) { return { isValid: true, remaining: response.balance, unit: "USD", extra: "今日 $0.42 · 1234 tokens" }; }
})`;
const settings = JSON.stringify({ auth: { OPENAI_API_KEY: "test-secret" }, config: 'base_url = "https://provider.example"' });
const meta = JSON.stringify({ usage_script: { enabled: true, code: usageCode, timeout: 5 } });
database.prepare("INSERT INTO providers VALUES (?, 'codex', ?, ?, ?, 1, 0, 1)").run("provider-a", "测试供应商", settings, meta);
database.prepare("INSERT INTO usage_daily_rollups VALUES (date('now','localtime'), 'codex', ?, 2, 100, 20, 300, 0, 0.25)").run("provider-a");
database.prepare("INSERT INTO proxy_request_logs VALUES ('r1', ?, 'codex', 'fallback', 'model-x', 0.125, 456, 1700000000000, 200)").run("provider-a");
database.close();

assert.equal(resolveCcSwitchDatabasePath(null, { USERPROFILE: root }), path.join(root, ".cc-switch", "cc-switch.db"));
const snapshot = readCcSwitchSnapshot({ databasePath });
assert.equal(snapshot.provider.id, "provider-a");
assert.equal(snapshot.provider.name, "测试供应商");
assert.equal(snapshot.usage.variables.apiKey, "test-secret");
assert.equal(snapshot.stats.todayTokens, 420);
assert.equal(snapshot.stats.totalTokens, 420);
assert.equal(snapshot.stats.latest.model, "model-x");
assert.equal(snapshot.stats.latest.latencyMs, 456);

let request;
const balance = await queryCcSwitchBalance(snapshot, {
  fetchImpl: async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ balance: 19.5 }), { status: 200, headers: { "content-type": "application/json" } });
  },
});
assert.equal(request.url, "https://provider.example/v1/usage");
assert.equal(request.options.method, "GET");
assert.equal(request.options.headers.Authorization, "Bearer test-secret");
assert.equal(balance.remaining, 19.5);

const postSnapshot = structuredClone(snapshot);
postSnapshot.usage.code = `({ request: { url: "https://provider.example/usage", method: "POST" }, extractor: function(x) { return x; } })`;
await assert.rejects(() => queryCcSwitchBalance(postSnapshot, { fetchImpl: async () => new Response("{}") }), /只允许 GET/);

const unsafeSnapshot = structuredClone(snapshot);
unsafeSnapshot.usage.code = `({ request: { url: "https://provider.example/usage", method: "GET" }, extractor: function() { return process.env; } })`;
await assert.rejects(() => queryCcSwitchBalance(unsafeSnapshot, { fetchImpl: async () => new Response("{}", { status: 200 }) }), /process is not defined/);

const unresolvedSnapshot = structuredClone(snapshot);
unresolvedSnapshot.usage.variables.apiKey = null;
await assert.rejects(() => queryCcSwitchBalance(unresolvedSnapshot, { fetchImpl: async () => new Response("{}") }), /缺少变量/);

await fs.rm(root, { recursive: true, force: true });
console.log("CC Switch integration tests passed.");

