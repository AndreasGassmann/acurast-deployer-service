import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { Deployments } from "./deployments";
import { History } from "./history";
import { EventHub } from "./events";
import { Orchestrator, type Clock } from "./orchestrator";
import type { DeployDeps } from "./deployer";

// Clock whose timers never fire, so detached deploys leave no lingering handles.
const inertClock: Clock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
  schedule: () => () => {},
};
import type { Config } from "./config";

const config: Config = {
  acurastMnemonic: "a b c",
  rpcWss: "wss://rpc",
  ipfsEndpoint: "https://ipfs",
  ipfsApiKey: "key",
  apiBaseUrl: "https://api.qvac.acurast.dev",
  apiKeys: ["full-key"],
  publicDeployKey: "public-key",
  domainSuffix: "tunnel.acurast.dev",
  port: 8080,
  dataDir: "/unused",
  publicDeployRatePerHour: 2,
};

const fakeDeps: DeployDeps = {
  loadAcurastConfig: () => ({}),
  convertConfigToJob: () => ({}),
  walletFromMnemonic: async () => ({}),
  deployProject: async (_c, _j, options) => {
    options.statusCallback("Uploaded");
    options.statusCallback("EnvironmentVariablesSet");
  },
};

let dir: string;
let deployments: Deployments;
let orchestrator: Orchestrator;
let history: History;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "app-"));
  deployments = new Deployments();
  history = new History(dir);
  const events = new EventHub();
  orchestrator = new Orchestrator({
    config,
    deployments,
    history,
    events,
    deps: fakeDeps,
    clock: inertClock,
    tunnelTimeoutMs: 60_000,
  });
  app = createApp({ config, deployments, events, orchestrator });
});
afterEach(async () => {
  // detached deploys keep writing history.jsonl after the response returns;
  // let them finish and flush before removing the temp dir
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
    await history.drain();
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("HTTP API", () => {
  it("GET /healthz is open", async () => {
    await request(app).get("/healthz").expect(200, { ok: true });
  });

  it("GET /templates requires a key", async () => {
    await request(app).get("/templates").expect(401);
    const res = await request(app).get("/templates").set("x-api-key", "full-key").expect(200);
    expect(res.body[0].id).toBe("qvac");
  });

  it("POST /deployments with a full key returns 202 + id", async () => {
    const res = await request(app)
      .post("/deployments")
      .set("x-api-key", "full-key")
      .send({ template: "qvac", public: true })
      .expect(202);
    expect(res.body.id).toMatch(/^dep_/);
  });

  it("public key may only deploy qvac", async () => {
    await request(app)
      .post("/deployments")
      .set("x-api-key", "public-key")
      .send({ template: "other" })
      .expect(403);
    await request(app)
      .post("/deployments")
      .set("x-api-key", "public-key")
      .send({ template: "qvac" })
      .expect(202);
  });

  it("public key is rate limited", async () => {
    const send = () =>
      request(app)
        .post("/deployments")
        .set("x-api-key", "public-key")
        .send({ template: "qvac" });
    await send().expect(202);
    await send().expect(202);
    await send().expect(429); // limit is 2/hour
  });

  it("unknown template returns 404, bad params 400", async () => {
    await request(app)
      .post("/deployments")
      .set("x-api-key", "full-key")
      .send({ template: "nope" })
      .expect(404);
    await request(app)
      .post("/deployments")
      .set("x-api-key", "full-key")
      .send({ template: "qvac", params: { model: 5 } })
      .expect(400);
  });

  it("public deployment is readable without a key; private needs one", async () => {
    const pub = deployments.create("qvac", true, new Date().toISOString());
    const priv = deployments.create("qvac", false, new Date().toISOString());

    await request(app).get(`/deployments/${pub.id}`).expect(200);
    await request(app).get(`/deployments/${priv.id}`).expect(401);
    await request(app).get(`/deployments/${priv.id}`).set("x-api-key", "full-key").expect(200);
    await request(app).get("/deployments/missing").expect(404);
  });

  it("GET /deployments?public=true needs no key; full list needs full key", async () => {
    deployments.create("qvac", true, new Date().toISOString());
    deployments.create("qvac", false, new Date().toISOString());

    const pub = await request(app).get("/deployments?public=true").expect(200);
    expect(pub.body).toHaveLength(1);

    await request(app).get("/deployments").expect(401);
    const all = await request(app).get("/deployments").set("x-api-key", "full-key").expect(200);
    expect(all.body).toHaveLength(2);
  });

  it("tunnel callback validates the per-deployment token", async () => {
    const { id, token } = deployments.create("qvac", false, new Date().toISOString());
    await request(app)
      .post(`/api/tunnel/${id}?token=wrong`)
      .send({ event: "started", url: "https://x" })
      .expect(403);
    await request(app)
      .post(`/api/tunnel/${id}?token=${token}`)
      .send({ event: "started", url: "https://abc.tunnel.acurast.dev:8443" })
      .expect(200);
    expect(deployments.view(id)?.tunnelUrl).toBe("https://abc.tunnel.acurast.dev:8443");
  });
});
