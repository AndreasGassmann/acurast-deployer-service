import { describe, it, expect } from "vitest";
import { Deployments } from "./deployments";
import { PHASE_ORDER } from "./types";
import type { HistoryRecord, Phase } from "./types";

const NOW = "2026-06-18T00:00:00.000Z";

describe("Deployments", () => {
  it("creates with a unique id + token and 'created' status", () => {
    const d = new Deployments();
    const a = d.create("qvac", false, NOW);
    const b = d.create("qvac", false, NOW);
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    expect(d.view(a.id)?.status).toBe("created");
  });

  it("verifies the per-deployment token", () => {
    const d = new Deployments();
    const { id, token } = d.create("qvac", false, NOW);
    expect(d.verifyToken(id, token)).toBe(true);
    expect(d.verifyToken(id, "wrong")).toBe(false);
    expect(d.verifyToken("nope", token)).toBe(false);
  });

  it("derives status from phase", () => {
    const d = new Deployments();
    const { id } = d.create("qvac", false, NOW);
    d.setPhase(id, "matching", NOW);
    expect(d.view(id)?.status).toBe("deploying");
    d.setPhase(id, "env-set", NOW);
    expect(d.view(id)?.status).toBe("awaiting-tunnel");
    // model-ready alone stays awaiting-tunnel — terminal "ready" also needs the
    // tunnel URL, which the orchestrator confirms (tunnel + model both up).
    d.setPhase(id, "model-ready", NOW);
    expect(d.view(id)?.status).toBe("awaiting-tunnel");
  });

  it("keeps phase monotonic when events arrive out of order", () => {
    const d = new Deployments();
    const { id } = d.create("qvac", false, NOW);
    d.setPhase(id, "model-ready", NOW); // model finishes before the tunnel reports
    d.setPhase(id, "started", NOW); // late tunnel event must not regress progress
    expect(d.view(id)?.phase).toBe("model-ready");
  });

  it("computes monotonic progress and an ETA that shrinks", () => {
    const d = new Deployments();
    const { id } = d.create("qvac", false, NOW);
    const initial = d.view(id)!;
    expect(initial.progress).toBe(0);

    d.setPhase(id, "matching", NOW);
    const mid = d.view(id)!;
    d.setPhase(id, "env-set", NOW);
    const later = d.view(id)!;
    expect(later.progress).toBeGreaterThan(mid.progress);
    expect(later.etaSeconds!).toBeLessThan(mid.etaSeconds!);

    d.setPhase(id, "model-ready", NOW);
    const done = d.view(id)!;
    expect(done.progress).toBe(1);
    expect(done.etaSeconds).toBe(0);
  });

  it("lists public-only and sorts newest first", () => {
    const d = new Deployments();
    d.create("qvac", true, "2026-06-18T00:00:01.000Z");
    d.create("qvac", false, "2026-06-18T00:00:02.000Z");
    const pubId = d.create("qvac", true, "2026-06-18T00:00:03.000Z").id;
    const pub = d.list({ publicOnly: true });
    expect(pub).toHaveLength(2);
    expect(pub[0].id).toBe(pubId); // newest first
    expect(pub.every((v) => v.public)).toBe(true);
  });

  it("hides failed/timed-out deploys from the public list but keeps them via view()", () => {
    const d = new Deployments();
    const failed = d.create("qvac", true, "2026-06-18T00:00:01.000Z").id;
    const ok = d.create("qvac", true, "2026-06-18T00:00:02.000Z").id;
    d.setStatus(failed, "failed", "2026-06-18T00:00:03.000Z", { error: "boom" });
    const pub = d.list({ publicOnly: true });
    expect(pub.map((v) => v.id)).toEqual([ok]);
    // Deployer still sees their own failure via the direct lookup.
    expect(d.view(failed)?.status).toBe("failed");
    // Full (keyed) list still includes it.
    expect(d.list().map((v) => v.id)).toContain(failed);
  });

  it("rebuilds from history and reports in-flight deploys", () => {
    const d = new Deployments();
    const records: HistoryRecord[] = [
      { ts: NOW, id: "done1", template: "qvac", event: "x", phase: "model-ready", status: "ready", public: true, tunnelUrl: "https://t" },
      { ts: NOW, id: "live1", template: "qvac", event: "x", phase: "env-set", status: "awaiting-tunnel", public: false },
    ];
    const inFlight = d.rebuildFrom(records);
    expect(inFlight).toEqual(["live1"]);
    expect(d.view("done1")?.tunnelUrl).toBe("https://t");
    expect(d.view("done1")?.progress).toBe(1);
  });

  it("restores the callback token from history so callbacks survive a restart", () => {
    const d = new Deployments();
    const records: HistoryRecord[] = [
      { ts: NOW, id: "live1", template: "qvac", event: "created", phase: null, status: "created", public: false, token: "tok-123" },
      { ts: NOW, id: "live1", template: "qvac", event: "x", phase: "env-set", status: "awaiting-tunnel", public: false },
    ];
    d.rebuildFrom(records);
    expect(d.verifyToken("live1", "tok-123")).toBe(true);
    expect(d.verifyToken("live1", "wrong")).toBe(false);
  });

  it("keeps tunnel-ready deploys in the public list (usable, model still loading)", () => {
    const d = new Deployments();
    const { id } = d.create("qvac", true, NOW);
    d.setStatus(id, "tunnel-ready", NOW, { tunnelUrl: "https://t" });
    const pub = d.list({ publicOnly: true });
    expect(pub.map((v) => v.id)).toContain(id);
  });

  it("surfaces the latest message in the view", () => {
    const d = new Deployments();
    const { id } = d.create("qvac", true, NOW);
    expect(d.view(id)?.lastMessage).toBeNull();
    d.setMessage(id, "Loading the model");
    expect(d.view(id)?.lastMessage).toBe("Loading the model");
  });

  it("uses injected per-template estimates over the template fallback", () => {
    const custom: Record<string, Record<Phase, number>> = {
      qvac: {
        uploaded: 100,
        prepared: 0,
        submitted: 0,
        matching: 0,
        matched: 0,
        ack: 0,
        "env-set": 0,
        started: 0,
        "model-loading": 0,
        "model-ready": 0,
      },
    };
    const d = new Deployments(custom);
    const { id } = d.create("qvac", false, NOW);
    // No phase yet -> etaSeconds equals the injected total (100), not the template's.
    expect(d.view(id)?.etaSeconds).toBe(100);
  });

  it("keeps PHASE_ORDER and qvac estimates in sync", () => {
    // every phase must have an estimate (guards against a typo'd phase key)
    const d = new Deployments();
    const { id } = d.create("qvac", false, NOW);
    for (const p of PHASE_ORDER) {
      d.setPhase(id, p, NOW);
      const v = d.view(id)!;
      expect(v.etaSeconds).not.toBeNull();
      expect(v.etaSeconds).toBeGreaterThanOrEqual(0);
    }
  });
});
