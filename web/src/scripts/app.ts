// Client logic for the QVAC landing page: one-click deploy, live progress via
// polling (EventSource can't send the x-api-key header), and the public list.

const API_BASE = import.meta.env.PUBLIC_API_BASE;
const DEPLOY_KEY = import.meta.env.PUBLIC_DEPLOY_KEY;

interface DeploymentView {
  id: string;
  template: string;
  status:
    | "created"
    | "deploying"
    | "awaiting-tunnel"
    | "tunnel-ready"
    | "ready"
    | "expired"
    | "failed"
    | "timed-out";
  phase: string | null;
  public: boolean;
  createdAt: string;
  tunnelUrl: string | null;
  error: string | null;
  chainDeploymentId: string | null;
  etaSeconds: number | null;
  progress: number;
  lastMessage: string | null;
}

const HUB_EXPLORER = "https://hub.acurast.com/explorer/deployment";

/** Link to the deployment on the Acurast hub explorer, when the chain id is known. */
function explorerLink(v: DeploymentView): string {
  if (!v.chainDeploymentId) return "";
  return `<a class="explorer" href="${HUB_EXPLORER}/${v.chainDeploymentId}" target="_blank" rel="noreferrer">View on explorer ↗</a>`;
}

// Major milestones shown in the UI (a subset of backend phases, grouped).
const STEPS: { phases: string[]; label: string }[] = [
  { phases: ["uploaded", "prepared", "submitted"], label: "Uploading & submitting deployment" },
  { phases: ["matching", "matched"], label: "Matching a processor" },
  { phases: ["ack", "env-set"], label: "Provisioning the device" },
  { phases: ["started"], label: "Opening the tunnel" },
  { phases: ["model-loading"], label: "Loading the model" },
  { phases: ["model-ready"], label: "Ready" },
];

const PHASE_LABEL: Record<string, string> = {
  uploaded: "Uploading deployment",
  prepared: "Preparing",
  submitted: "Submitting on-chain",
  matching: "Matching a processor",
  matched: "Processor matched",
  ack: "Processor acknowledged",
  "env-set": "Environment set",
  started: "Tunnel opening",
  "model-loading": "Loading model",
  "model-ready": "Ready",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const deployBtn = $<HTMLButtonElement>("deployBtn");
const publicToggle = $<HTMLInputElement>("publicToggle");
const progressEl = $<HTMLDivElement>("progress");
const barFill = $<HTMLSpanElement>("barFill");
const phaseLabel = $<HTMLSpanElement>("phaseLabel");
const etaLabel = $<HTMLSpanElement>("etaLabel");
const logLabel = $<HTMLDivElement>("logLabel");
const stepsEl = $<HTMLUListElement>("steps");
const resultEl = $<HTMLDivElement>("result");
const publicList = $<HTMLDivElement>("publicList");

let pollTimer: number | undefined;
let etaTimer: number | undefined;
let localEta = 0;
// Phase whose estimate localEta currently reflects. The server ETA is a static
// per-phase estimate, so we only re-sync localEta when the phase changes —
// otherwise each poll would reset the local countdown and it'd never tick down.
let etaPhase: string | null | undefined = undefined;

function renderSteps(currentPhase: string | null): void {
  const currentIdx = currentPhase
    ? STEPS.findIndex((s) => s.phases.includes(currentPhase))
    : -1;
  stepsEl.innerHTML = STEPS.map((s, i) => {
    const cls = i < currentIdx ? "done" : i === currentIdx ? "active" : "";
    return `<li class="${cls}"><span class="dot"></span>${s.label}</li>`;
  }).join("");
}

function fmtEta(sec: number): string {
  // Past the estimate we don't know how much longer — be honest instead of
  // implying it's about to finish (deploys can genuinely run 3x the estimate).
  if (sec <= 0) return "taking longer than expected — still working…";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `~${m}m ${s}s remaining` : `~${s}s remaining`;
}

function startEtaCountdown(): void {
  if (etaTimer) clearInterval(etaTimer);
  localEta = 0;
  etaPhase = undefined;
  etaTimer = window.setInterval(() => {
    if (localEta > 0) {
      localEta -= 1;
      etaLabel.textContent = fmtEta(localEta);
    }
  }, 1000);
}

function applyView(v: DeploymentView): void {
  // Never imply 100% before we're truly ready — cap the bar until the terminal
  // ready state so a slow model doesn't sit at a full-looking bar.
  const pct = v.status === "ready" ? 100 : Math.min(95, Math.round(v.progress * 100));
  barFill.style.width = `${pct}%`;
  phaseLabel.textContent = v.phase ? PHASE_LABEL[v.phase] ?? v.phase : "Starting…";
  renderSteps(v.phase);
  logLabel.textContent = v.lastMessage ?? "";
  if (v.etaSeconds != null) {
    if (v.phase !== etaPhase) {
      // New phase: adopt its fresh estimate.
      etaPhase = v.phase;
      localEta = v.etaSeconds;
    } else {
      // Same phase: never let the countdown jump back up.
      localEta = Math.min(localEta, v.etaSeconds);
    }
    etaLabel.textContent = fmtEta(localEta);
  }
  // Tunnel is live but the model may still be loading — surface the usable link
  // right away (non-terminal, so polling continues until fully ready).
  if (v.status === "tunnel-ready" && v.tunnelUrl) {
    deployBtn.disabled = false;
    deployBtn.textContent = "Deploy now";
    resultEl.className = "result show ok";
    const explorer = explorerLink(v);
    resultEl.innerHTML =
      `Your QVAC instance is reachable (model still loading):<br />` +
      `<a href="${v.tunnelUrl}" target="_blank" rel="noreferrer">${v.tunnelUrl}</a>` +
      (explorer ? `<br />${explorer}` : "");
  }
}

function finish(v: DeploymentView): void {
  if (pollTimer) clearTimeout(pollTimer);
  if (etaTimer) clearInterval(etaTimer);
  deployBtn.disabled = false;
  deployBtn.textContent = "Deploy now";

  logLabel.textContent = "";
  if (v.status === "ready" && v.tunnelUrl) {
    barFill.style.width = "100%";
    phaseLabel.textContent = "Ready";
    etaLabel.textContent = "";
    resultEl.className = "result show ok";
    const explorer = explorerLink(v);
    resultEl.innerHTML =
      `Your QVAC instance is live:<br /><a href="${v.tunnelUrl}" target="_blank" rel="noreferrer">${v.tunnelUrl}</a>` +
      (explorer ? `<br />${explorer}` : "");
  } else {
    resultEl.className = "result show err";
    const explorer = explorerLink(v);
    const msg =
      v.status === "timed-out"
        ? "Timed out waiting for the tunnel. Please try again."
        : `Deployment failed${v.error ? `: ${v.error}` : "."}`;
    resultEl.innerHTML = explorer ? `${msg}<br />${explorer}` : msg;
  }
  void loadPublic();
}

async function poll(id: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/deployments/${id}`, {
      headers: { "x-api-key": DEPLOY_KEY },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const v = (await res.json()) as DeploymentView;
    applyView(v);
    if (v.status === "ready" || v.status === "failed" || v.status === "timed-out") {
      finish(v);
      return;
    }
  } catch {
    // transient error — keep polling
  }
  pollTimer = window.setTimeout(() => void poll(id), 1500);
}

async function deploy(): Promise<void> {
  deployBtn.disabled = true;
  deployBtn.textContent = "Deploying…";
  resultEl.className = "result";
  progressEl.classList.add("show");
  barFill.style.width = "0%";
  renderSteps(null);
  startEtaCountdown();

  try {
    const res = await fetch(`${API_BASE}/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": DEPLOY_KEY },
      body: JSON.stringify({ template: "qvac", public: publicToggle.checked }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `status ${res.status}`);
    }
    const { id } = (await res.json()) as { id: string };
    void poll(id);
  } catch (err) {
    if (etaTimer) clearInterval(etaTimer);
    deployBtn.disabled = false;
    deployBtn.textContent = "Deploy now";
    resultEl.className = "result show err";
    resultEl.textContent = `Could not start deployment: ${(err as Error).message}`;
  }
}

async function loadPublic(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/deployments?public=true`);
    if (!res.ok) throw new Error();
    const items = (await res.json()) as DeploymentView[];
    if (items.length === 0) {
      publicList.innerHTML = `<span class="empty">No public deployments yet — be the first!</span>`;
      return;
    }
    publicList.innerHTML = items
      .map((v) => {
        const when = new Date(v.createdAt).toLocaleString();
        // A live tunnel (ready OR model-still-loading) is usable, so link it.
        const right =
          (v.status === "ready" || v.status === "tunnel-ready") && v.tunnelUrl
            ? `<a href="${v.tunnelUrl}" target="_blank" rel="noreferrer">Open →</a>`
            : `<span class="pill ${v.status}">${v.status}</span>`;
        const explorer = explorerLink(v);
        return `<div class="deploy-item">
            <div><div>${v.template}</div><div class="meta">${v.id} · ${when}${explorer ? ` · ${explorer}` : ""}</div></div>
            <div>${right}</div>
          </div>`;
      })
      .join("");
  } catch {
    publicList.innerHTML = `<span class="empty">Could not load public deployments.</span>`;
  }
}

deployBtn.addEventListener("click", () => void deploy());
void loadPublic();
