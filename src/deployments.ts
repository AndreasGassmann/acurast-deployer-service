/**
 * In-memory deployment state store. Rebuilt by replaying history.jsonl at boot.
 * Computes progress (0..1) and ETA (seconds to ready) from the phase order and the
 * template's hardcoded per-phase estimates.
 */
import { randomBytes } from "node:crypto";
import { PHASE_ORDER } from "./types.js";
import type {
  DeploymentStatus,
  DeploymentView,
  HistoryRecord,
  Phase,
} from "./types.js";
import { getTemplate } from "./templates/index.js";

const TERMINAL: DeploymentStatus[] = ["ready", "failed", "timed-out"];

interface Internal {
  id: string;
  template: string;
  public: boolean;
  status: DeploymentStatus;
  phase: Phase | null;
  createdAt: string;
  updatedAt: string;
  tunnelUrl: string | null;
  error: string | null;
  /** Per-deployment unguessable token authorizing the tunnel callback. */
  token: string;
}

function genId(): string {
  return "dep_" + randomBytes(9).toString("hex");
}

function genToken(): string {
  return randomBytes(24).toString("hex");
}

function isTerminal(status: DeploymentStatus): boolean {
  return TERMINAL.includes(status);
}

export class Deployments {
  private readonly items = new Map<string, Internal>();

  /** Create a new deployment. `now` injected for deterministic tests. */
  create(template: string, isPublic: boolean, now: string): { id: string; token: string } {
    const id = genId();
    const token = genToken();
    this.items.set(id, {
      id,
      template,
      public: isPublic,
      status: "created",
      phase: null,
      createdAt: now,
      updatedAt: now,
      tunnelUrl: null,
      error: null,
      token,
    });
    return { id, token };
  }

  get(id: string): Internal | undefined {
    return this.items.get(id);
  }

  verifyToken(id: string, token: string): boolean {
    const item = this.items.get(id);
    return !!item && item.token === token && token.length > 0;
  }

  setPhase(id: string, phase: Phase, now: string): void {
    const item = this.items.get(id);
    if (!item) return;
    item.phase = phase;
    item.updatedAt = now;
    // Derive status from phase unless already terminal.
    if (!isTerminal(item.status)) {
      if (phase === "model-ready") item.status = "ready";
      else if (PHASE_ORDER.indexOf(phase) >= PHASE_ORDER.indexOf("env-set"))
        item.status = "awaiting-tunnel";
      else item.status = "deploying";
    }
  }

  setStatus(
    id: string,
    status: DeploymentStatus,
    now: string,
    opts: { error?: string; tunnelUrl?: string } = {},
  ): void {
    const item = this.items.get(id);
    if (!item) return;
    item.status = status;
    item.updatedAt = now;
    if (opts.error !== undefined) item.error = opts.error;
    if (opts.tunnelUrl !== undefined) item.tunnelUrl = opts.tunnelUrl;
  }

  /** Compute the public, progress-annotated view of a deployment. */
  view(id: string): DeploymentView | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    return this.toView(item);
  }

  list(opts: { publicOnly?: boolean } = {}): DeploymentView[] {
    const out: DeploymentView[] = [];
    for (const item of this.items.values()) {
      if (opts.publicOnly && !item.public) continue;
      // Failed/timed-out deploys are hidden from the public gallery — the
      // deployer still sees their own outcome via the direct /deployments/:id
      // lookup (they hold the id). Keeps stale failures off the shared list.
      if (opts.publicOnly && (item.status === "failed" || item.status === "timed-out")) continue;
      out.push(this.toView(item));
    }
    // newest first
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

  /**
   * Replay history records to rebuild state. Returns the ids of deployments left
   * in a non-terminal state (in-flight at shutdown) so the caller can re-arm
   * their tunnel-wait timeouts.
   */
  rebuildFrom(records: HistoryRecord[]): string[] {
    for (const r of records) {
      let item = this.items.get(r.id);
      if (!item) {
        item = {
          id: r.id,
          template: r.template,
          public: r.public,
          status: r.status,
          phase: r.phase,
          createdAt: r.ts,
          updatedAt: r.ts,
          tunnelUrl: r.tunnelUrl ?? null,
          error: r.error ?? null,
          token: "", // tokens are not persisted; replayed deploys can't be re-callbacked
        };
        this.items.set(r.id, item);
      } else {
        item.status = r.status;
        item.phase = r.phase;
        item.updatedAt = r.ts;
        if (r.tunnelUrl !== undefined) item.tunnelUrl = r.tunnelUrl;
        if (r.error !== undefined) item.error = r.error;
      }
    }
    const inFlight: string[] = [];
    for (const item of this.items.values()) {
      if (!isTerminal(item.status)) inFlight.push(item.id);
    }
    return inFlight;
  }

  private toView(item: Internal): DeploymentView {
    const { progress, etaSeconds } = this.computeProgress(item);
    return {
      id: item.id,
      template: item.template,
      status: item.status,
      phase: item.phase,
      public: item.public,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      tunnelUrl: item.tunnelUrl,
      error: item.error,
      etaSeconds,
      progress,
    };
  }

  private computeProgress(item: Internal): { progress: number; etaSeconds: number | null } {
    if (item.status === "ready") return { progress: 1, etaSeconds: 0 };
    if (item.status === "failed" || item.status === "timed-out") {
      return { progress: this.phaseProgress(item.phase), etaSeconds: null };
    }
    if (item.phase === null) return { progress: 0, etaSeconds: this.totalEstimate(item.template) };
    const progress = this.phaseProgress(item.phase);
    const eta = this.remainingEstimate(item.template, item.phase);
    return { progress, etaSeconds: eta };
  }

  private phaseProgress(phase: Phase | null): number {
    if (phase === null) return 0;
    const idx = PHASE_ORDER.indexOf(phase);
    return (idx + 1) / PHASE_ORDER.length;
  }

  private totalEstimate(templateId: string): number | null {
    const t = getTemplate(templateId);
    if (!t) return null;
    return PHASE_ORDER.reduce((sum, p) => sum + (t.estimates[p] ?? 0), 0);
  }

  private remainingEstimate(templateId: string, phase: Phase): number | null {
    const t = getTemplate(templateId);
    if (!t) return null;
    const idx = PHASE_ORDER.indexOf(phase);
    let sum = 0;
    for (let i = idx + 1; i < PHASE_ORDER.length; i++) {
      sum += t.estimates[PHASE_ORDER[i]] ?? 0;
    }
    return sum;
  }
}
