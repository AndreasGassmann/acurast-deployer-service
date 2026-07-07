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
  network: "mainnet",
  sshAuthorizedKeys: "ssh-ed25519 AAAA test@host",
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
    // Mirrors the real SDK: the job carries a concrete schedule end time (ms).
    convertConfigToJob: () => ({ schedule: { endTime: 7200 * 1000 } }),
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
        options.statusCallback(s, s === "WaitingForMatch" ? { jobIds: [[{ acurast: "x" }, 999]] } : undefined);
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
    // on-chain deployment id captured from the WaitingForMatch payload
    expect(deployments.view(id)?.chainDeploymentId).toBe("999");

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

  it("only goes ready once both the tunnel and the model are up (any order)", async () => {
    const { clock } = makeClock();
    const { orchestrator, deployments } = build(fakeDeps(), clock);
    const id = await orchestrator.start("qvac", {}, true);
    await flush();
    const token = deployments.get(id)!.token;

    // model_ready arrives BEFORE the tunnel — must not be terminal-ready yet.
    await orchestrator.handleCallback(id, token, { event: "model_ready" });
    expect(deployments.view(id)?.status).toBe("awaiting-tunnel");
    expect(deployments.view(id)?.tunnelUrl).toBeNull();

    // tunnel reports late -> now ready, with the URL.
    await orchestrator.handleCallback(id, token, {
      event: "started",
      webUrl: "https://abc.tunnel.acurast.dev:8443",
    });
    const v = deployments.view(id)!;
    expect(v.status).toBe("ready");
    expect(v.tunnelUrl).toBe("https://abc.tunnel.acurast.dev:8443");
    expect(v.phase).toBe("model-ready"); // phase didn't regress to "started"
  });

  it("expires a ready deployment once its run window elapses", async () => {
    const { clock, advance } = makeClock();
    const { orchestrator, deployments } = build(fakeDeps(), clock);
    const id = await orchestrator.start("qvac", {}, true);
    await flush();
    await orchestrator.handleCallback(id, deployments.get(id)!.token, {
      event: "started",
      webUrl: "https://abc.tunnel.acurast.dev:8443",
    });
    await orchestrator.handleCallback(id, deployments.get(id)!.token, { event: "model_ready" });
    expect(deployments.view(id)?.status).toBe("ready");
    // qvac maxRunSeconds = 7200; expiry is anchored at ready (clock ms = 0).
    expect(deployments.view(id)?.expiresAt).toBe(new Date(7200 * 1000).toISOString());

    advance(7200 * 1000 - 1);
    await orchestrator.sweep(clock.nowMs()); // not yet due
    expect(deployments.view(id)?.status).toBe("ready");

    advance(1);
    await orchestrator.sweep(clock.nowMs()); // due
    expect(deployments.view(id)?.status).toBe("expired");
    // hidden from the public gallery once expired
    expect(deployments.list({ publicOnly: true }).some((v) => v.id === id)).toBe(false);
  });

  it("cleans up old non-working deployments after the retention window", async () => {
    const { clock, advance } = makeClock();
    const { orchestrator, deployments } = build(fakeDeps({ fail: true }), clock);
    const id = await orchestrator.start("qvac", {}, false);
    await flush();
    expect(deployments.view(id)?.status).toBe("failed");

    advance(60 * 60 * 1000 - 1);
    await orchestrator.sweep(clock.nowMs()); // within retention -> kept
    expect(deployments.view(id)).toBeDefined();

    advance(1);
    await orchestrator.sweep(clock.nowMs()); // aged out -> removed
    expect(deployments.view(id)).toBeUndefined();
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

  it("does not fail the deployment on tunnel.py's non-fatal secondary-tunnel error", async () => {
    const { clock } = makeClock();
    const { orchestrator, deployments } = build(fakeDeps(), clock);
    const id = await orchestrator.start("qvac", {}, false);
    await flush();
    await orchestrator.handleCallback(id, deployments.get(id)!.token, {
      event: "error",
      message: "No secondary tunnel returned — the processor build may predate support",
    });
    expect(deployments.view(id)?.status).toBe("awaiting-tunnel");
    // the deployment still completes normally afterwards
    await orchestrator.handleCallback(id, deployments.get(id)!.token, {
      event: "started",
      webUrl: "https://abc.tunnel.acurast.dev:8443",
    });
    await orchestrator.handleCallback(id, deployments.get(id)!.token, { event: "model_ready" });
    expect(deployments.view(id)?.status).toBe("ready");
  });

  it("persists the SSH connect command to history without exposing it in views", async () => {
    const { clock } = makeClock();
    const { orchestrator, deployments, history } = build(fakeDeps(), clock);
    const id = await orchestrator.start("qvac", {}, true);
    await flush();
    const connect = "ssh -o ProxyCommand='openssl s_client ...' root@abc";
    await orchestrator.handleCallback(id, deployments.get(id)!.token, {
      event: "started",
      webUrl: "https://abc.tunnel.acurast.dev:8443",
      sshUrl: "https://def.tunnel.acurast.dev",
      sshPort: 2222,
      connect,
    });
    await history.drain();
    const records = await history.readAll();
    expect(records.find((r) => r.event === "callback:started")?.sshCommand).toBe(connect);
    expect(JSON.stringify(deployments.view(id))).not.toContain("ssh");
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
