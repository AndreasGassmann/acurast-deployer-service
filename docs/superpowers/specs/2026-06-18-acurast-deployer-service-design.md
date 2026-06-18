# Acurast Deployer Service — Design

Date: 2026-06-18

## Purpose

A small, self-hosted Node.js service that holds an Acurast deployer mnemonic and
deploys curated workloads to the Acurast network via `@acurast/sdk`. It exposes a
simple HTTP API with API-key access control, records deployment history to a JSONL
file (no database), streams live deployment progress (SSE), and receives an inbound
webhook from the deployed workload to learn the registered Acurast Tunnel URL.

A companion Astro landing page explains the `acurast-qvac` project and offers a
one-click deploy with live progress, time estimates, and the final tunnel URL, plus
a public list of deployments others can use.

Domains:
- `qvac.acurast.dev` — Astro landing page (static)
- `api.qvac.acurast.dev` — Express backend API

## Non-goals (YAGNI)

- No database. The only persistence is `data/history.jsonl`.
- No user accounts, sessions, or key-management UI. API keys are static (env/config).
- No arbitrary-repo build pipeline. Deployables are curated **templates**.
- No live on-chain status beyond what the SDK `statusCallback` emits plus the
  workload's inbound callback. (Optional on-chain `storedJobStatus` subscription is
  out of scope for v1.)

## Key external facts (from research, may need live confirmation)

- Use **`@acurast/sdk` v1.2.2** directly (not `@acurast/cli`). Peer deps:
  `@polkadot/api`, `@polkadot/keyring`, `@polkadot/util-crypto`.
- The SDK **never reads `process.env`** — mnemonic, RPC endpoint, and IPFS creds are
  passed explicitly.
- Core calls: `loadAcurastConfig(...)` → `convertConfigToJob(config)` →
  `walletFromMnemonic(mnemonic)` → `deployProject(config, job, options)` where
  `options = { wallet, rpcEndpoint, ipfs: { endpoint, apiKey }, envVars, statusCallback }`.
- **SDK `DeploymentStatus`** emitted in practice:
  `Uploaded → Prepared → Submit → WaitingForMatch → Matched → Acknowledged →
  EnvironmentVariablesSet`. The later `Started/ExecutionDone/Finalized` exist in the
  enum but are **not emitted** today.
- **Acurast Tunnel is NOT an SDK call.** The deployed workload registers the tunnel
  itself (native `_STD_.tunnel.start()` / `tunnel.py`, Shell runtime) and POSTs
  lifecycle events to a `CALLBACK_URL`. That callback is our inbound webhook.
  Tunnel events: `started` (carries `url`), `model_loading`, `model_ready`, `log`,
  `error`. Tunnel URL format: `https://<clientId>.<DOMAIN_SUFFIX>:8443` where
  `clientId` is ephemeral per deployment. `DOMAIN_SUFFIX` defaults to
  **`tunnel.acurast.dev`**, a shared Acurast-managed zone whose `*` A record (→ a
  canary relay) and `_acu` TXT record are **already published** (verified via live
  DNS) — so **no DNS work is required** for the default flow. A custom domain is
  optional and then needs your own wildcard A + `_acu` TXT records.
- **No time estimates exist** in the protocol/SDK. We hardcode per-template,
  per-phase duration estimates for the UI.
- `acurast-qvac` (github.com/Acurast/acurast-qvac): runs an on-device LLM inference
  server (OpenAI-compatible API + React chat UI) behind the tunnel. Shell runtime,
  `network: canary`, `assignmentStrategy: Single`, `numberOfReplicas: 1`, one-time
  ~2h job, `includeEnvironmentVariables: ["CALLBACK_URL","DOMAIN_SUFFIX"]`.

Flagged unverified: no official end-to-end SDK example (signatures from tarball
type defs); the `CALLBACK_URL` event convention is app-implemented, not a protocol
guarantee; `_acu` TXT preimage and current canary relay IPs need live confirmation;
no live on-chain deploy was performed.

## Architecture

```
            qvac.acurast.dev            api.qvac.acurast.dev
                  │                              │
             ┌────▼──────────────────────────────▼────┐
             │            Caddy (auto-TLS)              │
             └────┬──────────────────────────────┬─────┘
        static    │                              │ reverse proxy
   ┌──────────────▼─────┐             ┌──────────▼───────────────┐
   │  Astro static build │   ──API──▶  │  Express backend (Node)   │
   │  (landing + deploy) │             │  holds mnemonic           │
   └─────────────────────┘             └──────────┬───────────────┘
                                                   │ @acurast/sdk + @polkadot/*
                                                   ▼
                                             Acurast network
                                                   │ workload POSTs lifecycle
                                       POST /api/tunnel/:id?token=…  (CALLBACK_URL)
```

Docker Compose services: `caddy` (reverse proxy + auto-TLS), `api` (Node/Express).
The Astro site is built to static files and served by Caddy from a shared volume
(a `web` build step, not a long-running service).

### Backend modules (isolated units)

- `config.ts` — load + validate env at boot. Required: `ACURAST_MNEMONIC`,
  `RPC_WSS`, `IPFS_ENDPOINT`, `IPFS_API_KEY`, `API_BASE_URL`,
  `API_KEYS` (comma-separated full-access keys), `PUBLIC_DEPLOY_KEY` (qvac-only,
  rate-limited), `PORT`, `DATA_DIR`. Optional: `DOMAIN_SUFFIX` (default
  `tunnel.acurast.dev`).
- `auth.ts` — `x-api-key` middleware. Full keys → all templates + read all history
  via their key. `PUBLIC_DEPLOY_KEY` → may only deploy template `qvac`, rate-limited
  per IP. Public deployment reads need no key.
- `templates/` — registry. A template =
  `{ id, displayName, description, acurastConfigPath, paramSchema, injectedEnv(ctx),
  estimates }`. `templates/qvac/` vendors the `acurast-qvac` payload (`app/` +
  `acurast.json`). Adding a deployable = add a folder + register it.
- `deployer.ts` — wraps the SDK: load config, build job, derive wallet, call
  `deployProject` with injected `envVars` and a `statusCallback`. Pure of HTTP.
- `deployments.ts` — in-memory deployment state store. Rebuilt by replaying
  `history.jsonl` at boot. Tracks status, current phase, estimates, tunnelUrl.
- `history.ts` — append-only writer/reader for `data/history.jsonl`.
- `events.ts` — SSE hub; per-deployment subscriber fan-out of progress events.
- `tunnel-webhook` (route) — receives the workload `CALLBACK_URL` POSTs, validates
  the per-deploy token, updates deployment state, pushes SSE.
- `routes/*` + `server.ts` — Express wiring.

## HTTP API (under api.qvac.acurast.dev)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/templates` | key | list templates + param schemas |
| POST | `/deployments` | key | start deploy `{template, params, public}` → `{id}` (202) |
| GET | `/deployments/:id` | key or public | current state (polling fallback) |
| GET | `/deployments/:id/events` | key or public | SSE progress stream |
| GET | `/deployments` | key (own) / `?public=true` no-key | history list |
| POST | `/api/tunnel/:id?token=…` | per-deploy token | inbound workload callback |
| GET | `/healthz` | none | liveness |

Auth notes: a public deployment is readable (`GET /deployments/:id`, its events, and
in the `?public=true` list) without an API key. The tunnel callback is authorized by
an unguessable per-deployment `token`, not an API key.

## Deploy flow + progress

1. `POST /deployments`: validate key (and template scope for public key), validate
   params against the template `paramSchema`, generate `id` + unguessable `token`,
   append `created` record, return `202 {id}`.
2. Async worker calls `deployProject(config, job, { wallet, rpcEndpoint, ipfs,
   envVars: { CALLBACK_URL: \`${API_BASE_URL}/api/tunnel/${id}?token=${token}\`,
   DOMAIN_SUFFIX }, statusCallback })`.
3. `statusCallback` maps SDK status → phase, appends JSONL, pushes SSE. **Phase A
   (deploy):** `uploaded → prepared → submitted → matching → matched → ack →
   env-set`.
4. After `env-set`, state = `awaiting-tunnel`. The workload boots, registers the
   tunnel, and POSTs to the callback. **Phase B (workload):** `started` (store
   `tunnelUrl`), `model_loading`, `model_ready` → status `ready`.
5. Each phase carries a hardcoded per-template **estimate** (seconds) so the UI can
   render a progress bar + ETA.
6. Terminal states: `ready`, `failed` (SDK throw or `error` event), `timed-out`
   (overall deadline or per-phase deadline, esp. `awaiting-tunnel`).

## Data + persistence

`data/history.jsonl` is the only persistence. One JSON object per line:

```
{ "ts", "id", "template", "event", "phase", "status", "public",
  "tunnelUrl?", "error?" }
```

- The mnemonic is never logged and never written to JSONL.
- Deploy params are recorded only if free of secrets; the public deploy key path
  records template + `public` flag, not sensitive values.
- **Boot replay:** rebuild in-memory state from JSONL. Any deployment left in a
  non-terminal state (in-flight at shutdown) is **resumed**: re-arm the
  `awaiting-tunnel` timeout from its last timestamp; if already past deadline →
  `timed-out`.

## Landing page (Astro v6, qvac.acurast.dev)

- Static SSG build. Sections: an "what is acurast-qvac" explainer, a one-click
  **Deploy** button (with public/private toggle), and a **public deployments list**
  fetched from `GET /deployments?public=true`.
- Deploy interaction: button → `POST /deployments` using the **baked-in public
  deploy key** (qvac-only, rate-limited) → open SSE `/deployments/:id/events` →
  render live progress bar + phase labels + ETA → on `ready`, show the tunnel URL
  (clickable, "open chat").
- The public deploy key is restricted server-side to template `qvac` and
  rate-limited per IP, so exposing it in the static page is acceptable for v1.

## Errors

- Bad/missing API key → 401. Public key used for non-qvac template → 403.
- Invalid params / unknown template → 400 / 404.
- Tunnel callback with bad token → 403.
- SDK throw during deploy → deployment `failed` with reason in JSONL + SSE.
- Per-phase + overall timeouts → `timed-out`.

## Testing

- Unit tests (SDK + chain mocked): auth scoping, template param validation,
  `history.jsonl` append + boot replay/resume, estimate/ETA computation, SSE hub
  fan-out, tunnel-callback token validation + state transition, deploy worker
  against a stubbed `deployProject` (drives `statusCallback` through all phases).
- No live on-chain test in CI (needs a funded mnemonic + IPFS keys). An optional,
  manually-gated integration test can perform a real deploy.

## Docker

- `docker-compose.yml`: `caddy` (auto-TLS, routes `api.qvac.acurast.dev` → `api`,
  serves `qvac.acurast.dev` static from the Astro build volume) and `api` (Node).
- `Caddyfile` defines both site blocks.
- Astro built to static (its own build stage / step) into the volume Caddy serves.
- Secrets via `.env` (mnemonic, IPFS key, API keys). `.env.example` documents all.

## Operational prerequisites (out-of-band, documented in README)

- Fund the deployer mnemonic with cACU (canary).
- Obtain IPFS endpoint + API key.
- `DOMAIN_SUFFIX` DNS: **none required** by default — `tunnel.acurast.dev` is a
  shared Acurast-managed zone with `*` A + `_acu` TXT already published. Only if you
  opt into a custom vanity domain do you publish your own wildcard A (→ canary
  relays) + `_acu` TXT; confirm the `_acu` preimage and current relay IPs against the
  live tunnel first.
