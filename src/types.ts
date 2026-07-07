/** Shared domain types for deployments, phases, and history records. */

/** Overall lifecycle status of a deployment. */
export type DeploymentStatus =
  | "created"
  | "deploying" // SDK phase A in progress
  | "awaiting-tunnel" // env vars set, waiting for workload callback
  | "ready" // tunnel live + app ready
  | "expired" // ran its allotted execution time; tunnel no longer live
  | "failed"
  | "timed-out";

/**
 * Ordered phases a deployment passes through. Phase A (SDK statusCallback) then
 * phase B (workload CALLBACK_URL events). Used to drive the progress bar + ETA.
 */
export type Phase =
  // Phase A — emitted by the SDK deploy stream
  | "uploaded"
  | "prepared"
  | "submitted"
  | "matching"
  | "matched"
  | "ack"
  | "env-set"
  // Phase B — emitted by the deployed workload via CALLBACK_URL
  | "started"
  | "model-loading"
  | "model-ready";

export const PHASE_ORDER: Phase[] = [
  "uploaded",
  "prepared",
  "submitted",
  "matching",
  "matched",
  "ack",
  "env-set",
  "started",
  "model-loading",
  "model-ready",
];

/** Public, non-secret view of a deployment (safe to return over the API). */
export interface DeploymentView {
  id: string;
  template: string;
  status: DeploymentStatus;
  phase: Phase | null;
  public: boolean;
  createdAt: string;
  updatedAt: string;
  tunnelUrl: string | null;
  error: string | null;
  /** On-chain numeric job id (for the hub explorer link); null until known. */
  chainDeploymentId: string | null;
  /** When a ready deployment stops running (ISO); null until ready. */
  expiresAt: string | null;
  /** Hardcoded per-template estimate (seconds) for the current phase. */
  etaSeconds: number | null;
  /** 0..1 progress derived from phase order. */
  progress: number;
}

/** One line in history.jsonl. Never contains the mnemonic or secret params. */
export interface HistoryRecord {
  ts: string;
  id: string;
  template: string;
  event: string;
  phase: Phase | null;
  status: DeploymentStatus;
  public: boolean;
  tunnelUrl?: string;
  error?: string;
  expiresAt?: string;
  chainDeploymentId?: string;
  /**
   * Per-deployment callback token, persisted once on the "created" record so an
   * in-flight deployment can still authenticate its workload callbacks after a
   * service restart. Not a chain secret — only authorizes the tunnel callback.
   */
  token?: string;
  /**
   * SSH-over-TLS connect command for the workload's debug shell, persisted on the
   * `callback:started` record. Operator-only (needs the matching private key
   * anyway) — deliberately NOT exposed in any API view.
   */
  sshCommand?: string;
}

/** SSE event payload pushed to subscribers. */
export interface ProgressEvent {
  id: string;
  status: DeploymentStatus;
  phase: Phase | null;
  progress: number;
  etaSeconds: number | null;
  tunnelUrl: string | null;
  error: string | null;
}
