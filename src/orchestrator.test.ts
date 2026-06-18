import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator, ValidationError, type Clock } from "./orchestrator";
import { Deployments } from "./deployments";
import { History } from "./history";
import { EventHub } from "./events";
import type { DeployDeps } from "./deployer";
import type { Config } from "./config";
import type { ProgressEvent } from "./types";

const config: Config = {
  acurastMnemonic: "a b c",
  rpcWss: "wss://rpc",
  ipfsEndpoint: "https://ipfs",
  ipfsApiKey: "key",
  apiBaseUrl: "https://api.qvac.acurast.dev",
  apiKeys: ["k"],
  publicDeployKey: "p",
  domainSuffix: "tunnel.acurast.dev",
  port: 8080,
  dataDir: "/unused",
  publicDeployRatePerHour: 5,
  corsOrigins: ["*"],
};

interface Timer {
  fn: () => void;
  at: number;
  cancelled: boolean;
}

function makeClock() {
  let ms = 0;
  const timers: Timer[] = [];
  const clock: Clock = {
    nowIso: () => new Date(ms).toISOString(),
    nowMs: () => ms,
    schedule: (fn, d) => {
      const t: Timer = { fn, at: ms + d, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
  return {
    clock,
    advance(d: number) {
      ms += d;
      for (const t of timers) {
        if (!t.cancelled && t.at <= ms) {
          t.cancelled = true;
          t.fn();
        }
      }
    },
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

/** Fake deps whose deployProject drives the status callback through phase A. */
function fakeDeps(opts: { fail?: boolean } = {}): DeployDeps {
  return {
    loadAcurastConfig: () => ({}),
    convertConfigToJob: () => ({}),
    walletFromMnemonic: async () => ({}),
    deployProject: async (_c, _j, options) => {
      if (opts.fail) throw new Error("chain rejected");
      for (const s of [
        "Uploaded",
        "Prepared",
        "Submit",
        "WaitingForMatch",
        "Matched",
        "Acknowledged",
        "EnvironmentVariablesSet",
      ]) {
        options.statusCallback(s);
      }
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orch-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function build(deps: DeployDeps, clock: Clock) {
  const deployments = new Deployments();
  const history = new History(dir);
  const events = new EventHub();
  const orchestrator = new Orchestrator({
    config,
    deployments,
    history,
    events,
    deps,
    clock,
    tunnelTimeoutMs: 1000,
  });
  return { deployments, history, events, orchestrator };
}

describe("Orchestrator", () => {
  it("runs the full happy path to ready", async () => {
    const { clock } = makeClock();
    const { orchestrator, deployments, events } = build(fakeDeps(), clock);
    const seen: ProgressEvent[] = [];

    const id = await orchestrator.start("qvac", { model: "m" }, true);
    events.subscribe(id, (e) => seen.push(e));
    await flush();

    // phase A complete -> awaiting-tunnel
    expect(deployments.view(id)?.status).toBe("awaiting-tunnel");
    expect(deployments.view(id)?.phase).toBe("env-set");

    // workload reports tunnel up
    await orchestrator.handleCallback(id, deployments.get(id)!.token, {
      event: "started",
      webUrl: "https://abc.tunnel.acurast.dev:8443",
    });
    expect(deployments.view(id)?.tunnelUrl).toBe("https://abc.tunnel.acurast.dev:8443");

    await orchestrator.handleCallback(id, deployments.get(id)!.token, { event: "model_ready" });
    const v = deployments.view(id)!;
    expect(v.status).toBe("ready");
    expect(v.progress).toBe(1);
    expect(seen.at(-1)?.status).toBe("ready");
  });

  it("rejects an unknown template", async () => {
    const { clock } = makeClock();
    const { orchestrator } = build(fakeDeps(), clock);
    await expect(orchestrator.start("nope", {}, false)).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects invalid params", async () => {
    const { clock } = makeClock();
    const { orchestrator } = build(fakeDeps(), clock);
    await expect(
      orchestrator.start("qvac", { model: 123 }, false),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("marks failed when the SDK throws", async () => {
    const { clock } = makeClock();
    const { orchestrator, deployments } = build(fakeDeps({ fail: true }), clock);
    const id = await orchestrator.start("qvac", {}, false);
    await flush();
    const v = deployments.view(id)!;
    expect(v.status).toBe("failed");
    expect(v.error).toMatch(/chain rejected/);
  });

  it("times out while awaiting the tunnel", async () => {
    const { clock, advance } = makeClock();
    const { orchestrator, deployments } = build(fakeDeps(), clock);
    const id = await orchestrator.start("qvac", {}, false);
    await flush();
    expect(deployments.view(id)?.status).toBe("awaiting-tunnel");
    advance(1000); // fire the tunnel timeout
    await flush();
    expect(deployments.view(id)?.status).toBe("timed-out");
  });

  it("fails the deployment on a model_error callback", async () => {
    const { clock } = makeClock();
    const { orchestrator, deployments } = build(fakeDeps(), clock);
    const id = await orchestrator.start("qvac", {}, false);
    await flush();
    await orchestrator.handleCallback(id, deployments.get(id)!.token, {
      event: "model_error",
      message: "oom loading model",
    });
    const v = deployments.view(id)!;
    expect(v.status).toBe("failed");
    expect(v.error).toMatch(/oom/);
  });

  it("rejects a callback with a bad token", async () => {
    const { clock } = makeClock();
    const { orchestrator } = build(fakeDeps(), clock);
    const id = await orchestrator.start("qvac", {}, false);
    await flush();
    const ok = await orchestrator.handleCallback(id, "wrong-token", { event: "model_ready" });
    expect(ok).toBe(false);
  });

  it("persists history that can rebuild the same state", async () => {
    const { clock } = makeClock();
    const { orchestrator, history } = build(fakeDeps(), clock);
    const id = await orchestrator.start("qvac", {}, true);
    await flush();
    await orchestrator.handleCallback(id, "x", { event: "log" }); // ignored
    // deterministically wait for the serialized history writes to flush
    await history.drain();

    const records = await history.readAll();
    const rebuilt = new Deployments();
    rebuilt.rebuildFrom(records);
    expect(rebuilt.view(id)?.status).toBe("awaiting-tunnel");
    expect(rebuilt.view(id)?.public).toBe(true);
  });
});
