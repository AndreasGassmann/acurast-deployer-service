#!/usr/bin/env node
/**
 * QVAC LLM server for the Acurast Cargo deployment.
 *
 * Loads a model through the QVAC SDK (@qvac/sdk, backed by qvac-fabric-llm.cpp)
 * and exposes, on a single local HTTP port:
 *
 *   GET  /                      -> the bundled chat frontend (www/index.html)
 *   GET  /health                -> JSON status the frontend polls
 *   GET  /info                  -> device + runtime + model info
 *   GET  /v1/models             -> OpenAI-style list of switchable models
 *   POST /v1/models/switch      -> load a different model at runtime
 *   POST /v1/chat/completions   -> OpenAI-compatible chat endpoint (SSE streaming)
 *
 * The Acurast tunnel (tunnel.py) forwards the public URL to this port, so the
 * frontend and the LLM API share one origin and the page can call the model
 * with a plain same-origin fetch.
 */

import http from "node:http";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as qvac from "@qvac/sdk";
const { loadModel, completion, unloadModel } = qvac;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.WEB_PORT || 8080);
const HOST = "127.0.0.1";
const SYSTEM_PROMPT = process.env.CUSTOM_SYSTEM_PROMPT || "";
const CALLBACK_URL = process.env.CALLBACK_URL || "";

const START_TIME = Date.now();

// --- Switchable models -----------------------------------------------------
// Curated set of small, instruction-tuned text LLMs that fit a phone. Each id
// is the QVAC SDK export name; we keep only the ones actually present in the
// installed SDK (namespace lookup), so the list degrades gracefully across SDK
// versions instead of crashing on a missing named import.
const CURATED = [
  { id: "LLAMA_3_2_1B_INST_Q4_0", label: "Llama 3.2 1B Instruct", params: "1B", quant: "Q4_0" },
  { id: "LLAMA_TOOL_CALLING_1B_INST_Q4_K", label: "Llama 1B Tool-Calling", params: "1B", quant: "Q4_K" },
  { id: "SMOLLM2_360M_INST_Q8", label: "SmolLM2 360M Instruct", params: "360M", quant: "Q8" },
  { id: "SALAMANDRATA_2B_INST_Q4", label: "SalamandraTA 2B Instruct", params: "2B", quant: "Q4" },
  { id: "QWEN3_4B_INST_Q4_K_M", label: "Qwen3 4B Instruct", params: "4B", quant: "Q4_K_M" },
  { id: "BITNET_1B_INST_TQ2_0", label: "BitNet 1B Instruct", params: "1B", quant: "TQ2_0" },
];
const AVAILABLE = CURATED.filter((m) => qvac[m.id]);
const AVAILABLE_BY_ID = Object.fromEntries(AVAILABLE.map((m) => [m.id, m]));

// Default model: QVAC_MODEL env if it's one we offer, else the first available.
const DEFAULT_MODEL =
  (process.env.QVAC_MODEL && AVAILABLE_BY_ID[process.env.QVAC_MODEL] && process.env.QVAC_MODEL) ||
  (AVAILABLE[0] && AVAILABLE[0].id) ||
  "LLAMA_3_2_1B_INST_Q4_0";

let modelId = null;
let currentModel = null; // id of the loaded model
let modelReady = false;
let modelError = null;
let switching = false;

// --- server-side error log (surfaced to the frontend via GET /errors) -------
const MAX_ERRORS = 100;
const errorLog = [];

function logError(err, context = "") {
  const entry = {
    timestamp: Date.now(),
    context,
    message: String((err && err.message) || err),
    stack: err && err.stack ? String(err.stack) : null,
  };
  errorLog.push(entry);
  if (errorLog.length > MAX_ERRORS) errorLog.shift();
  console.error(`[error]${context ? " " + context : ""}:`, err);
  return entry;
}

// Post a lifecycle event to CALLBACK_URL (same webhook start.sh / tunnel.py use).
async function postCallback(payload) {
  if (!CALLBACK_URL) return;
  try {
    await fetch(CALLBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error("callback POST failed:", err?.message || err);
  }
}

// Load `id`, unloading whatever is currently loaded first. Sets module state and
// emits webhook events. `switching` is set synchronously before the first await
// so concurrent requests observe the in-progress switch immediately.
async function switchModel(id) {
  const entry = AVAILABLE_BY_ID[id];
  if (!entry) throw new Error(`unknown model: ${id}`);
  if (switching) throw new Error("a model switch is already in progress");

  switching = true;
  modelReady = false;
  modelError = null;
  try {
    if (modelId) {
      try {
        await unloadModel({ modelId });
      } catch (err) {
        logError(err, "unloadModel");
      }
      modelId = null;
    }
    console.log(`Loading QVAC model: ${id}`);
    postCallback({ event: "model_loading", model: id });
    const loaded = await loadModel({
      modelSrc: qvac[id],
      modelType: "llm",
      onProgress: (progress) => console.log("model load progress:", progress),
    });
    modelId = loaded;
    currentModel = id;
    modelReady = true;
    console.log(`QVAC model ready: ${id} (${loaded})`);
    postCallback({ event: "model_ready", model: id, modelId: loaded });
  } catch (err) {
    modelError = err;
    logError(err, `loadModel ${id}`);
    postCallback({ event: "model_error", model: id, message: String(err?.message || err) });
    throw err;
  } finally {
    switching = false;
  }
}

async function initModel() {
  // Local smoke-testing escape hatch: skip the (large) model download/load so the
  // HTTP surface can be exercised without a GPU/model. Never set on the processor.
  if (process.env.QVAC_SKIP_MODEL) {
    modelError = new Error("model loading skipped (QVAC_SKIP_MODEL set)");
    console.warn("QVAC_SKIP_MODEL set — not loading a model.");
    return;
  }
  switchModel(DEFAULT_MODEL).catch(() => {}); // errors recorded in modelError
}

const indexHtml = await readFile(path.join(__dirname, "www", "index.html"), "utf8");

// --- device / runtime info -------------------------------------------------

function readFirst(paths) {
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const v = readFileSync(p, "utf8").replace(/\0/g, "").trim();
        if (v) return v;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function readCpuinfoField(field) {
  try {
    const txt = readFileSync("/proc/cpuinfo", "utf8");
    const re = new RegExp(`^${field}\\s*:\\s*(.+)$`, "mi");
    const m = txt.match(re);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function readMeminfoBytes(field) {
  try {
    const txt = readFileSync("/proc/meminfo", "utf8");
    const m = txt.match(new RegExp(`^${field}:\\s*(\\d+)\\s*kB`, "mi"));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

async function getInfo() {
  const cpus = os.cpus() || [];
  const deviceModel =
    readFirst(["/sys/firmware/devicetree/base/model", "/proc/device-tree/model"]) ||
    readCpuinfoField("Hardware") ||
    readCpuinfoField("model name") ||
    null;

  const gpu = readFirst([
    "/sys/class/kgsl/kgsl-3d0/gpu_model", // Qualcomm Adreno
    "/sys/devices/platform/gpu/gpu_model",
  ]);

  let storage = null;
  try {
    const dir = path.join(os.homedir() || "/root", ".qvac");
    const target = existsSync(dir) ? dir : "/";
    const s = await statfs(target);
    storage = {
      path: target,
      totalBytes: s.blocks * s.bsize,
      freeBytes: s.bfree * s.bsize,
      availableBytes: s.bavail * s.bsize,
    };
  } catch (err) {
    storage = { error: String(err?.message || err) };
  }

  return {
    timestamp: Date.now(),
    timeSinceStartSec: (Date.now() - START_TIME) / 1000,
    llm: {
      ready: modelReady,
      switching,
      currentModel,
      error: modelError ? String(modelError.message || modelError) : null,
      availableModels: AVAILABLE,
    },
    device: {
      model: deviceModel,
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSec: os.uptime(),
      loadAvg: os.loadavg(),
      cpu: {
        model: (cpus[0] && cpus[0].model) || readCpuinfoField("model name") || null,
        cores: cpus.length || null,
        speedMHz: (cpus[0] && cpus[0].speed) || null,
      },
      gpu,
      memory: {
        totalBytes: readMeminfoBytes("MemTotal") ?? os.totalmem(),
        availableBytes: readMeminfoBytes("MemAvailable") ?? os.freemem(),
      },
      storage,
    },
  };
}

// --- HTTP plumbing ---------------------------------------------------------

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  setCors(res);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function buildHistory(messages) {
  const history = [];
  if (SYSTEM_PROMPT) history.push({ role: "system", content: SYSTEM_PROMPT });
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m && typeof m.content === "string" && m.role) {
      history.push({ role: m.role, content: m.content });
    }
  }
  return history;
}

function sseChunk(res, delta, finishReason = null) {
  const payload = {
    id: "chatcmpl-qvac",
    object: "chat.completion.chunk",
    created: Math.floor(START_TIME / 1000),
    model: currentModel || "qvac",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function notReadyPayload() {
  return {
    error: {
      message: switching
        ? "A model switch is in progress, try again shortly."
        : modelError
        ? `Model failed to load: ${modelError.message || modelError}`
        : "Model is still loading, try again shortly.",
      type: "model_not_ready",
    },
  };
}

async function handleChatCompletion(req, res) {
  if (!modelReady) return sendJson(res, 503, notReadyPayload());

  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body" } });
  }

  const history = buildHistory(body.messages);
  const wantStream = body.stream !== false;

  let result;
  try {
    result = completion({ modelId, history, stream: true });
  } catch (err) {
    logError(err, "completion");
    return sendJson(res, 500, { error: { message: String((err && err.message) || err) } });
  }

  if (!wantStream) {
    let text = "";
    try {
      for await (const token of result.tokenStream) text += token;
    } catch (err) {
      logError(err, "completion stream (non-streaming)");
      return sendJson(res, 500, { error: { message: String((err && err.message) || err) } });
    }
    return sendJson(res, 200, {
      id: "chatcmpl-qvac",
      object: "chat.completion",
      created: Math.floor(START_TIME / 1000),
      model: currentModel || "qvac",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    });
  }

  setCors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sseChunk(res, { role: "assistant", content: "" });
  try {
    for await (const token of result.tokenStream) sseChunk(res, { content: token });
    sseChunk(res, {}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    logError(err, "completion stream");
    try {
      res.write("data: [DONE]\n\n");
    } catch {}
    res.end();
  }
}

async function handleModelSwitch(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body" } });
  }
  const id = body.model || body.id;
  if (!id || !AVAILABLE_BY_ID[id]) {
    return sendJson(res, 400, {
      error: { message: `Unknown model "${id}". See GET /v1/models.` },
    });
  }
  if (switching) {
    return sendJson(res, 409, { error: { message: "A model switch is already in progress." } });
  }
  if (id === currentModel && modelReady) {
    return sendJson(res, 200, { status: "ready", model: id, message: "Model already loaded." });
  }
  // Kick off the (possibly long) load in the background; switchModel sets
  // `switching` synchronously, so the client can poll /health from here.
  switchModel(id).catch(() => {});
  return sendJson(res, 202, { status: "switching", model: id });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);

  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    setCors(res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(indexHtml);
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      status: modelReady ? "ok" : "error",
      message: modelReady
        ? "QVAC LLM running on Acurast. All data is private."
        : switching
        ? "Switching model..."
        : modelError
        ? `Model failed to load: ${modelError.message || modelError}`
        : "Model is still loading...",
      model: currentModel || "qvac",
      switching,
      errorCount: errorLog.length,
      timeSinceStart: (Date.now() - START_TIME) / 1000,
    });
  }

  if (req.method === "GET" && url.pathname === "/info") {
    return sendJson(res, 200, await getInfo());
  }

  if (req.method === "GET" && url.pathname === "/errors") {
    return sendJson(res, 200, { count: errorLog.length, errors: errorLog });
  }

  if (req.method === "POST" && url.pathname === "/errors/clear") {
    errorLog.length = 0;
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return sendJson(res, 200, {
      object: "list",
      data: AVAILABLE.map((m) => ({
        id: m.id,
        object: "model",
        label: m.label,
        params: m.params,
        quant: m.quant,
        current: m.id === currentModel,
      })),
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/models/switch") {
    return handleModelSwitch(req, res);
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    return handleChatCompletion(req, res);
  }

  sendJson(res, 404, { error: { message: "Not found" } });
});

async function main() {
  console.log(`Available models: ${AVAILABLE.map((m) => m.id).join(", ") || "(none!)"}`);
  server.listen(PORT, HOST, () => {
    console.log(`QVAC LLM server listening on http://${HOST}:${PORT}`);
  });
  // Load the default model in the background so the web server (and /health) is
  // up immediately while the model downloads/initializes.
  initModel();
}

async function shutdown() {
  try {
    if (modelId) await unloadModel({ modelId });
  } catch (err) {
    console.error("unloadModel failed:", err);
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Capture (don't crash on) background failures so they show up in GET /errors.
process.on("uncaughtException", (err) => logError(err, "uncaughtException"));
process.on("unhandledRejection", (reason) =>
  logError(reason instanceof Error ? reason : new Error(String(reason)), "unhandledRejection")
);

main();
