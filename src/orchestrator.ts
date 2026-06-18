/**
 * Deployment orchestration: validates params, starts deploys, threads phase A
 * (SDK) and phase B (workload callback) updates through the store, history, and
 * SSE hub, and enforces the awaiting-tunnel timeout. Clock and timers are injected
 * so the whole flow is unit-testable without real time or a live chain.
 */
import type { Config } from "./config.js";
import type { Deployments } from "./deployments.js";
import type { History } from "./history.js";
import type { EventHub } from "./events.js";
import type { DeployDeps } from "./deployer.js";
import { runDeploy } from "./deployer.js";
import { getTemplate } from "./templates/index.js";
import type { DeploymentStatus, Phase, ProgressEvent } from "./types.js";

export interface Clock {
  /** Current time as an ISO string. */
  nowIso(): string;
  /** Current time in ms (for timers). */
  nowMs(): number;
  /** Schedule fn after ms; returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/**
 * Lifecycle event shape POSTed by the workload to CALLBACK_URL.
 * Matches the acurast-qvac payload: `started` carries `webUrl` (tunnel.py /
 * callback.sh), model events carry `model`, errors carry `message`.
 */
export interface CallbackEvent {
  event: "started" | "model_loading" | "model_ready" | "model_error" | "log" | "error";
  /** Tunnel URL on the `started` event (real field name). */
  webUrl?: string;
  /** Accepted as a fallback for `webUrl`. */
  url?: string;
  message?: string;
  model?: string;
}

const CALLBACK_TO_PHASE: Record<string, Phase> = {
  started: "started",
  model_loading: "model-loading",
  model_ready: "model-ready",
};

export interface OrchestratorOptions {
  config: Config;
  deployments: Deployments;
  history: History;
  events: EventHub;
  deps: DeployDeps;
  clock?: Clock;
  /** ms to wait for the workload tunnel callback before timing out. */
  tunnelTimeoutMs?: number;
  /** ms a failed/timed-out/expired deploy lingers before cleanup. */
  cleanupRetentionMs?: number;
}

const DEFAULT_TUNNEL_TIMEOUT_MS = 15 * 60 * 1000;
/** How long failed/timed-out/expired deploys linger before cleanup. */
const DEFAULT_CLEANUP_RETENTION_MS = 60 * 60 * 1000;

export class Orchestrator {
  private readonly config: Config;
  private readonly deployments: Deployments;
  private readonly history: History;
  private readonly events: EventHub;
  private readonly deps: DeployDeps;
  private readonly clock: Clock;
  private readonly tunnelTimeoutMs: number;
  private readonly cleanupRetentionMs: number;
  private readonly timers = new Map<string, () => void>();

  constructor(opts: OrchestratorOptions) {
    this.config = opts.config;
    this.deployments = opts.deployments;
    this.history = opts.history;
    this.events = opts.events;
    this.deps = opts.deps;
    this.clock = opts.clock ?? systemClock;
    this.tunnelTimeoutMs = opts.tunnelTimeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS;
    this.cleanupRetentionMs = opts.cleanupRetentionMs ?? DEFAULT_CLEANUP_RETENTION_MS;
  }

  /**
   * Periodic maintenance: expire ready deploys past their run window, then drop
   * non-working deploys that have aged out. Safe to call repeatedly (boot + interval).
   */
  async sweep(nowMs: number): Promise<void> {
    for (const id of this.deployments.dueForExpiry(nowMs)) {
      console.log(`[orchestrator] id=${id} run window elapsed; marking expired`);
      await this.setTerminal(id, "expired");
    }
    const removed = this.deployments.pruneOld(nowMs, this.cleanupRetentionMs);
    if (removed.length > 0) {
      console.log(`[orchestrator] cleaned up ${removed.length} old deployment(s): ${removed.join(", ")}`);
    }
  }

  /**
   * Validate + start a deployment. Returns the new id. The actual chain work runs
   * detached; callers get progress via the store / SSE.
   */
  async start(templateId: string, params: unknown, requestedPublic: boolean): Promise<string> {
    const template = getTemplate(templateId);
    if (!template) throw new ValidationError(`unknown template: ${templateId}`, 404);

    const parsed = template.paramSchema.safeParse(params ?? {});
    if (!parsed.success) {
      throw new ValidationError(`invalid params: ${parsed.error.message}`, 400);
    }
    // `public` is a listing flag (not a deploy param), set explicitly by the caller.
    const isPublic = requestedPublic;

    const now = this.clock.nowIso();
    const { id, token } = this.deployments.create(templateId, isPublic, now);
    // Persist the token once so callbacks still authenticate after a restart.
    await this.record(id, "created", null, { token });

    const callbackUrl = `${this.config.apiBaseUrl}/api/tunnel/${id}?token=${token}`;
    console.log(`[orchestrator] start id=${id} template=${template.id} public=${isPublic}`);

    // Detached: run the deploy without blocking the HTTP response.
    void this.runDeployment(id, template.id, callbackUrl);
    return id;
  }

  private async runDeployment(id: string, templateId: string, callbackUrl: string): Promise<void> {
    const template = getTemplate(templateId)!;
    try {
      await runDeploy({
        config: this.config,
        template,
        callbackUrl,
        deps: this.deps,
        onPhase: (phase) => {
          void this.onPhase(id, phase);
        },
        onScheduledEnd: (endTimeMs) => {
          this.deployments.setExpiry(id, new Date(endTimeMs).toISOString());
        },
      });
      // SDK stream ended (at env-set). Arm the tunnel-wait timeout.
      console.log(`[orchestrator] id=${id} phase A done; awaiting tunnel callback`);
      this.armTunnelTimeout(id);
    } catch (err) {
      console.error(`[orchestrator] id=${id} deploy failed:`, err);
      await this.fail(id, err instanceof Error ? err.message : String(err));
    }
  }

  private async onPhase(id: string, phase: Phase): Promise<void> {
    const now = this.clock.nowIso();
    this.deployments.setPhase(id, phase, now);
    await this.record(id, `phase:${phase}`, phase);
  }

  /** Handle a workload callback event. Returns false if id/token invalid. */
  async handleCallback(id: string, token: string, event: CallbackEvent): Promise<boolean> {
    if (!this.deployments.verifyToken(id, token)) {
      console.warn(`[orchestrator] callback rejected: bad id/token id=${id}`);
      return false;
    }
    // Log the meaningful body fields, not just the event name.
    const detail = [
      event.message ? `message=${JSON.stringify(event.message)}` : null,
      event.webUrl ?? event.url ? `url=${event.webUrl ?? event.url}` : null,
      event.model ? `model=${event.model}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`[orchestrator] callback id=${id} event=${event.event}${detail ? ` ${detail}` : ""}`);

    if (event.event === "error" || event.event === "model_error") {
      await this.fail(id, event.message ?? "workload reported error");
      return true;
    }
    if (event.event === "log") {
      // logs don't change state; ignored for v1 (could be surfaced later)
      return true;
    }

    const phase = CALLBACK_TO_PHASE[event.event];
    if (!phase) return true;

    const now = this.clock.nowIso();
    const tunnelUrl = event.webUrl ?? event.url;
    if (event.event === "started" && tunnelUrl) {
      this.deployments.setStatus(id, "awaiting-tunnel", now, { tunnelUrl });
    }
    this.deployments.setPhase(id, phase, now);

    // The tunnel (`started`/webUrl) and the model (`model_ready`) are reported by
    // separate workload processes and can arrive in either order. The deployment
    // is only truly ready once we have BOTH — otherwise a model_ready that beats
    // the tunnel would go "ready" with no URL (useless to the user).
    const item = this.deployments.get(id);
    if (item && item.tunnelUrl && item.phase === "model-ready" && item.status !== "ready") {
      this.deployments.setStatus(id, "ready", now);
      this.clearTimer(id);
      console.log(`[orchestrator] id=${id} ready (tunnel + model both up)`);
    }

    await this.record(id, `callback:${event.event}`, phase);
    return true;
  }

  /** Re-arm tunnel-wait timeouts for in-flight deploys after a restart. */
  resumeInFlight(ids: string[]): void {
    for (const id of ids) {
      const item = this.deployments.get(id);
      if (!item) continue;
      // The token is persisted, so a resumed deploy can still receive its workload
      // callback. Re-arm a fresh tunnel-wait window in case nothing arrives.
      this.armTunnelTimeout(id);
    }
  }

  private armTunnelTimeout(id: string): void {
    this.clearTimer(id);
    const cancel = this.clock.schedule(() => {
      void this.timeout(id);
    }, this.tunnelTimeoutMs);
    this.timers.set(id, cancel);
  }

  private clearTimer(id: string): void {
    const cancel = this.timers.get(id);
    if (cancel) {
      cancel();
      this.timers.delete(id);
    }
  }

  private async timeout(id: string): Promise<void> {
    this.timers.delete(id);
    const item = this.deployments.get(id);
    if (!item || item.status === "ready" || item.status === "failed") return;
    await this.setTerminal(id, "timed-out", { error: "timed out waiting for tunnel" });
  }

  private async fail(id: string, message: string): Promise<void> {
    this.clearTimer(id);
    await this.setTerminal(id, "failed", { error: message });
  }

  private async setTerminal(
    id: string,
    status: DeploymentStatus,
    opts: { error?: string } = {},
  ): Promise<void> {
    const now = this.clock.nowIso();
    this.deployments.setStatus(id, status, now, opts);
    await this.record(id, `status:${status}`, this.deployments.get(id)?.phase ?? null);
  }

  /** Persist to history + publish SSE for the current view. */
  private async record(
    id: string,
    event: string,
    phase: Phase | null,
    extra: { token?: string } = {},
  ): Promise<void> {
    const view = this.deployments.view(id);
    if (!view) return;
    await this.history.append({
      ts: this.clock.nowIso(),
      id,
      template: view.template,
      event,
      phase,
      status: view.status,
      public: view.public,
      ...(view.tunnelUrl ? { tunnelUrl: view.tunnelUrl } : {}),
      ...(view.error ? { error: view.error } : {}),
      ...(view.expiresAt ? { expiresAt: view.expiresAt } : {}),
      ...(extra.token ? { token: extra.token } : {}),
    });
    const progress: ProgressEvent = {
      id,
      status: view.status,
      phase: view.phase,
      progress: view.progress,
      etaSeconds: view.etaSeconds,
      tunnelUrl: view.tunnelUrl,
      error: view.error,
    };
    this.events.publish(progress);
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}
