import path from "node:path";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const SCRIPT_TIMEOUT_MS = 100;
const CREDENTIAL_PATTERN = /\{\{([A-Za-z0-9_]+)\}\}/g;

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

export function resolveCcSwitchDatabasePath(explicit, environment = process.env) {
  if (explicit) return path.resolve(explicit);
  if (!environment.USERPROFILE) return null;
  return path.join(environment.USERPROFILE, ".cc-switch", "cc-switch.db");
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseBaseUrl(configText) {
  const text = String(configText || "");
  const match = text.match(/^\s*base_url\s*=\s*(["'])(.*?)\1\s*$/mi);
  return match?.[2]?.trim() || null;
}

function validateCredential(value, label) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 8192 || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${label} 无效`);
  }
  return normalized;
}

function parseUsageDefinition(code) {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    name: "ccswitch-usage-script",
    codeGeneration: { strings: false, wasm: false },
  });
  const script = new vm.Script(`"use strict"; (${String(code || "")})`, {
    filename: "ccswitch-usage-script.js",
  });
  const definition = script.runInContext(context, { timeout: SCRIPT_TIMEOUT_MS });
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error("CC Switch 余额脚本没有返回对象");
  }
  if (!definition.request || typeof definition.request !== "object") {
    throw new Error("CC Switch 余额脚本缺少 request");
  }
  if (typeof definition.extractor !== "function") {
    throw new Error("CC Switch 余额脚本缺少 extractor");
  }
  sandbox.__usageDefinition = definition;
  return { context, definition };
}

function interpolate(value, variables, label) {
  const unresolved = new Set();
  const rendered = String(value ?? "").replace(CREDENTIAL_PATTERN, (_, key) => {
    const replacement = variables[key];
    if (replacement == null || replacement === "") {
      unresolved.add(key);
      return "";
    }
    return String(replacement);
  });
  if (unresolved.size) throw new Error(`${label} 缺少变量：${[...unresolved].join(", ")}`);
  return rendered;
}

function validateRequestUrl(value) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("CC Switch 余额查询只允许 HTTPS 或本机回环 HTTP");
  }
  if (url.username || url.password) throw new Error("CC Switch 余额查询地址不能包含凭据");
  return url;
}

async function readLimitedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RESPONSE_BYTES) throw new Error("CC Switch 余额接口响应过大");
    return JSON.parse(buffer.toString("utf8"));
  }
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("CC Switch 余额接口响应过大");
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function executeExtractor(runtime, response) {
  runtime.context.__usageResponse = JSON.parse(JSON.stringify(response));
  try {
    const result = new vm.Script("__usageDefinition.extractor(__usageResponse)")
      .runInContext(runtime.context, { timeout: SCRIPT_TIMEOUT_MS });
    return result && typeof result === "object" && !Array.isArray(result)
      ? JSON.parse(JSON.stringify(result))
      : {};
  } finally {
    delete runtime.context.__usageResponse;
  }
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 100_000_000_000 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function readCurrentProvider(database) {
  return database.prepare(`
    SELECT id, name, settings_config, meta
    FROM providers
    WHERE app_type = 'codex' AND is_current = 1
    ORDER BY sort_index, created_at
    LIMIT 1
  `).get() || null;
}

function readProviderStats(database, providerId) {
  const today = database.prepare(`
    SELECT
      COALESCE(SUM(request_count), 0) AS requests,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS tokens,
      COALESCE(SUM(total_cost_usd), 0) AS cost
    FROM usage_daily_rollups
    WHERE app_type = 'codex' AND provider_id = ? AND date = date('now', 'localtime')
  `).get(providerId);
  const total = database.prepare(`
    SELECT
      COALESCE(SUM(request_count), 0) AS requests,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS tokens,
      COALESCE(SUM(total_cost_usd), 0) AS cost
    FROM usage_daily_rollups
    WHERE app_type = 'codex' AND provider_id = ?
  `).get(providerId);
  const latest = database.prepare(`
    SELECT request_id, model, request_model, total_cost_usd, latency_ms, created_at, status_code
    FROM proxy_request_logs
    WHERE app_type = 'codex' AND provider_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(providerId) || null;
  return {
    todayTokens: Math.max(0, Number(today?.tokens) || 0),
    totalTokens: Math.max(0, Number(total?.tokens) || 0),
    todayCostUsd: Math.max(0, Number(today?.cost) || 0),
    totalCostUsd: Math.max(0, Number(total?.cost) || 0),
    latest: latest ? {
      model: String(latest.request_model || latest.model || "").trim() || null,
      costUsd: finite(latest.total_cost_usd),
      latencyMs: finite(latest.latency_ms),
      createdAt: normalizeTimestamp(latest.created_at),
      statusCode: finite(latest.status_code),
    } : null,
  };
}

export function readCcSwitchSnapshot({ databasePath } = {}) {
  const resolved = resolveCcSwitchDatabasePath(databasePath);
  if (!resolved) return null;
  let database;
  try {
    database = new DatabaseSync(resolved, { open: true, readOnly: true, timeout: 2500 });
    const provider = readCurrentProvider(database);
    if (!provider) return null;
    const settings = parseJson(provider.settings_config);
    const meta = parseJson(provider.meta);
    const usage = meta.usage_script || meta.usageScript || null;
    const usageObject = usage && typeof usage === "object" && !Array.isArray(usage) ? usage : null;
    const code = usageObject ? usageObject.code : typeof usage === "string" ? usage : null;
    const auth = settings.auth && typeof settings.auth === "object" ? settings.auth : {};
    const variables = {
      baseUrl: validateCredential(usageObject?.baseUrl || parseBaseUrl(settings.config), "CC Switch Base URL"),
      apiKey: validateCredential(auth.OPENAI_API_KEY || auth.ANTHROPIC_AUTH_TOKEN || auth.GEMINI_API_KEY, "CC Switch API Key"),
      accessToken: validateCredential(usageObject?.accessToken, "CC Switch Access Token"),
      userId: validateCredential(usageObject?.userId || usageObject?.user_id, "CC Switch User ID"),
    };
    return {
      provider: { id: String(provider.id), name: String(provider.name || provider.id) },
      usage: code && usageObject?.enabled !== false ? {
        code: String(code),
        timeoutMs: Math.max(1000, Math.min(60_000, Number(usageObject?.timeout) * 1000 || DEFAULT_TIMEOUT_MS)),
        variables,
      } : null,
      stats: readProviderStats(database, String(provider.id)),
    };
  } finally {
    database?.close();
  }
}

export async function queryCcSwitchBalance(snapshot, { fetchImpl = fetch } = {}) {
  if (!snapshot?.usage?.code) return null;
  const runtime = parseUsageDefinition(snapshot.usage.code);
  const request = runtime.definition.request;
  const method = String(request.method || "GET").toUpperCase();
  if (method !== "GET") throw new Error("CC Switch 联动只允许 GET 余额查询");
  const url = validateRequestUrl(interpolate(request.url, snapshot.usage.variables, "CC Switch 余额查询地址"));
  const headers = {};
  for (const [name, rawValue] of Object.entries(request.headers || {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new Error("CC Switch 余额查询包含无效请求头");
    const value = interpolate(rawValue, snapshot.usage.variables, `CC Switch 请求头 ${name}`);
    if (value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error("CC Switch 余额查询包含无效请求头值");
    headers[name] = value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), snapshot.usage.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`CC Switch 余额接口返回 HTTP ${response.status}`);
    const payload = await readLimitedJson(response);
    return executeExtractor(runtime, payload);
  } finally {
    clearTimeout(timer);
  }
}

export function formatCcSwitchTime(value) {
  const timestamp = normalizeTimestamp(value);
  if (!timestamp) return "--";
  const date = new Date(timestamp);
  const pad = part => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

