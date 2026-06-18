// Client logic for the QVAC landing page: one-click deploy, live progress via
// polling (EventSource can't send the x-api-key header), and the public list.

const API_BASE = import.meta.env.PUBLIC_API_BASE;
const DEPLOY_KEY = import.meta.env.PUBLIC_DEPLOY_KEY;

interface DeploymentView {
  id: string;
  template: string;
  status: "created" | "deploying" | "awaiting-tunnel" | "ready" | "failed" | "timed-out";
  phase: string | null;
  public: boolean;
  createdAt: string;
  tunnelUrl: string | null;
  error: string | null;
  etaSeconds: number | null;
  progress: number;
}

// Major milestones shown in the UI (a subset of backend phases, grouped).
const STEPS: { phases: string[]; label: string }[] = [
  { phases: ["uploaded", "prepared", "submitted"], label: "Uploading & submitting job" },
  { phases: ["matching", "matched"], label: "Matching a processor" },
  { phases: ["ack", "env-set"], label: "Provisioning the device" },
  { phases: ["started"], label: "Opening the tunnel" },
  { phases: ["model-loading"], label: "Loading the model" },
  { phases: ["model-ready"], label: "Ready" },
];

const PHASE_LABEL: Record<string, string> = {
  uploaded: "Uploading job",
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
const stepsEl = $<HTMLUListElement>("steps");
const resultEl = $<HTMLDivElement>("result");
const publicList = $<HTMLDivElement>("publicList");

let pollTimer: number | undefined;
let etaTimer: number | undefined;
let localEta = 0;

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
  if (sec <= 0) return "almost done…";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `~${m}m ${s}s remaining` : `~${s}s remaining`;
}

function startEtaCountdown(): void {
  if (etaTimer) clearInterval(etaTimer);
  etaTimer = window.setInterval(() => {
    if (localEta > 0) {
      localEta -= 1;
      etaLabel.textContent = fmtEta(localEta);
    }
  }, 1000);
}

function applyView(v: DeploymentView): void {
  barFill.style.width = `${Math.round(v.progress * 100)}%`;
  phaseLabel.textContent = v.phase ? PHASE_LABEL[v.phase] ?? v.phase : "Starting…";
  renderSteps(v.phase);
  if (v.etaSeconds != null) {
    localEta = v.etaSeconds;
    etaLabel.textContent = fmtEta(localEta);
  }
}

function finish(v: DeploymentView): void {
  if (pollTimer) clearTimeout(pollTimer);
  if (etaTimer) clearInterval(etaTimer);
  deployBtn.disabled = false;
  deployBtn.textContent = "Deploy now";

  if (v.status === "ready" && v.tunnelUrl) {
    barFill.style.width = "100%";
    phaseLabel.textContent = "Ready";
    etaLabel.textContent = "";
    resultEl.className = "result show ok";
    resultEl.innerHTML = `Your QVAC instance is live:<br /><a href="${v.tunnelUrl}" target="_blank" rel="noreferrer">${v.tunnelUrl}</a>`;
  } else {
    resultEl.className = "result show err";
    resultEl.textContent =
      v.status === "timed-out"
        ? "Timed out waiting for the tunnel. Please try again."
        : `Deployment failed${v.error ? `: ${v.error}` : "."}`;
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
        const right =
          v.status === "ready" && v.tunnelUrl
            ? `<a href="${v.tunnelUrl}" target="_blank" rel="noreferrer">Open →</a>`
            : `<span class="pill ${v.status}">${v.status}</span>`;
        return `<div class="deploy-item">
            <div><div>${v.template}</div><div class="meta">${v.id} · ${when}</div></div>
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
