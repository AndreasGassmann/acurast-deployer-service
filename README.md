# Acurast Deployer Service

A small self-hosted service that holds an Acurast deployer mnemonic and deploys
curated workloads to the Acurast network via [`@acurast/sdk`](https://www.npmjs.com/package/@acurast/sdk).
It has simple API-key access control, records deployment history to a JSONL file
(no database), streams live progress over SSE, and learns the registered
**Acurast Tunnel** URL via an inbound webhook the deployed workload calls back.

A companion **Astro** landing page explains the [`acurast-qvac`](https://github.com/Acurast/acurast-qvac)
project (a private on-device LLM server) and offers a one-click deploy with live
progress, ETAs, the final tunnel URL, and a list of public deployments.

- `qvac.acurast.dev` — landing page (static)
- `qvac-api.acurast.dev` — backend API

## Architecture

```
        qvac.acurast.dev            qvac-api.acurast.dev
              │                            │
         ┌────▼────────────────────────────▼────┐
         │     Traefik (existing, TLS + route)    │
         └────┬────────────────────────────┬─────┘
   Host rule  │                            │ Host rule
              ▼                   ┌─────────▼──────────────┐
   ┌──────────────────┐          │  Express API (holds     │
   │ web: nginx static │          │  mnemonic) @acurast/sdk │
   │ (Astro build)     │          └─────────┬──────────────┘
   └──────────────────┘                     │ deploy
                                            ▼  Acurast network
                                            │ workload POSTs lifecycle
                                  POST /api/tunnel/:id?token=…  (CALLBACK_URL)
```

A deployment runs in two phases:

1. **Phase A (SDK):** `deployProject` streams statuses, mapped to
   `uploaded → prepared → submitted → matching → matched → ack → env-set`.
2. **Phase B (workload):** after env vars are set the workload boots, opens the
   Acurast Tunnel, and POSTs lifecycle events to the per-deployment `CALLBACK_URL`:
   `started` (carries the tunnel `webUrl`) → `model_loading` → `model_ready`.

There is no protocol-level time estimate, so per-phase ETAs are hardcoded per
template (`src/templates/qvac.ts`).

## Prerequisites

- **Funded mnemonic** — the deployer account must hold ACU (mainnet) to pay for
  deployments.
- **IPFS endpoint + API key** — deployment code is bundled and uploaded to IPFS.
- **No DNS work** for tunnels — `DOMAIN_SUFFIX` defaults to the shared,
  Acurast-managed `tunnel.acurast.dev` zone (wildcard A + `_acu` TXT already
  published). Only a custom vanity domain needs your own records.
- **DNS + TLS for the two app domains**: `qvac.acurast.dev` and
  `qvac-api.acurast.dev` point at your host. This setup uses Cloudflare
  (proxied / orange-cloud) in front of Traefik, and Traefik serves a manual
  origin cert from its file provider — add an `acurast.dev` cert to your
  Traefik `certs.yml` (no ACME/certresolver).

## Configuration

Copy `.env.example` to `.env` and fill it in. All variables:

| Var | Required | Notes |
|---|---|---|
| `ACURAST_MNEMONIC` | yes | Deployer seed. Never logged, never in history. |
| `RPC_WSS` | yes | Substrate RPC websocket (mainnet by default). |
| `NETWORK` | no | `mainnet` (default) or `canary`. Overrides the manifest `network` and is injected into the workload. Keep in sync with `RPC_WSS`. |
| `SSH_AUTHORIZED_KEYS` | yes | Public key(s) for the workload's SSH debug shell (`authorized_keys` format, `\n`-separated). The workload exits if unset. |
| `IPFS_ENDPOINT` / `IPFS_API_KEY` | no | IPFS upload target. Defaults to Acurast's hosted proxy (no key needed); set both to use your own Pinata-compatible service. |
| `API_BASE_URL` | yes | Public URL of this API; used to mint `CALLBACK_URL`. |
| `API_KEYS` | yes | Comma-separated full-access keys. |
| `PUBLIC_DEPLOY_KEY` | yes | qvac-only, rate-limited key baked into the landing page. |
| `DOMAIN_SUFFIX` | no | Defaults to `tunnel.acurast.dev`. Injected as `DOMAIN_SUFFIX_<NETWORK>`; its DNS records must point at the selected network's relays. |
| `PORT` | no | Default `8080`. |
| `DATA_DIR` | no | Default `./data`. |
| `PUBLIC_DEPLOY_RATE_PER_HOUR` | no | Default `5`. |

## Local development

```bash
npm install            # uses .npmrc legacy-peer-deps (Acurast/polkadot peer ranges)
npm test               # 43 unit/integration tests (SDK + chain mocked)
npm run typecheck
npm run dev            # tsx watch on src/server.ts

cd web && npm install && npm run dev   # Astro landing page
```

## Docker

Routing + TLS are handled by your **existing Traefik** via labels — there is no
proxy in this compose file. Traefik must already be running and own the external
network named in `.env`.

```bash
cp .env.example .env   # fill in real values incl. the TRAEFIK_* vars
docker compose up -d --build
```

- `api` — the Express service (history persisted to `./data`). Labelled for
  `API_HOST` on port 8080.
- `web` — the Astro static build served by nginx. Labelled for `WEB_HOST`.

Both containers join the external `TRAEFIK_NETWORK` (e.g. `proxy`) and are routed
by Host rule on the `TRAEFIK_ENTRYPOINT` (e.g. `websecure`) with `tls=true`. TLS
uses Traefik's file-provider certs — add an `acurast.dev` cert to your Traefik
`certs.yml` (no ACME). Adjust the `.env` values to match your Traefik. The landing
page bakes `PUBLIC_API_BASE` (= `API_BASE_URL`) and `PUBLIC_DEPLOY_KEY` at build
time via the `web` build args.

## API

All endpoints under `qvac-api.acurast.dev`. Auth via `x-api-key` header (or
`Authorization: Bearer <key>`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | none | liveness |
| `GET` | `/templates` | key | list templates |
| `POST` | `/deployments` | key | `{template, params, public}` → `202 {id}` |
| `GET` | `/deployments/:id` | key¹ | current state (poll) |
| `GET` | `/deployments/:id/events` | key¹ | SSE progress stream |
| `GET` | `/deployments` | full key, or `?public=true` (no key) | history list |
| `POST` | `/api/tunnel/:id?token=…` | per-deploy token | inbound workload callback |

¹ public deployments are readable without a key.

The **public deploy key** may only deploy the `qvac` template and is rate-limited
per IP, so it is safe to expose in the static landing page.

## The qvac payload

The real [`Acurast/acurast-qvac`](https://github.com/Acurast/acurast-qvac) project
is **vendored** under `src/templates/qvac/`:

- `acurast.json` — the upstream manifest verbatim (project `qvac-llm`, Shell
  runtime, mainnet, attested devices only, the termux proot Ubuntu image + its
  real `sha256`, `includeEnvironmentVariables: ["CALLBACK_URL","NETWORK",
  "DOMAIN_SUFFIX_MAINNET","SSH_AUTHORIZED_KEYS"]`).
  The deployer overrides the `network` field with `NETWORK` at deploy time.
- `app/` — the deployable payload (`start.sh`, `server.mjs`, `tunnel.py`,
  `callback.sh`, `www/`, …). `fileUrl: "app"` resolves next to the manifest.
- `UPSTREAM_COMMIT` — the source commit it was vendored from.

The build copies these into `dist/templates/qvac/`. To refresh from upstream:

```bash
sh scripts/vendor-qvac.sh
```

This service injects `CALLBACK_URL`, `NETWORK`, `DOMAIN_SUFFIX_<NETWORK>` and
`SSH_AUTHORIZED_KEYS` as encrypted env vars (the workload exits if `NETWORK` or
`SSH_AUTHORIZED_KEYS` is unset); the workload's `tunnel.py` / `callback.sh` POST
lifecycle events back — `started` (carries `webUrl` plus the SSH debug-tunnel
fields `sshUrl`/`sshPort`/`connect`), `model_loading`, `model_ready`, and
`model_error` — which the orchestrator maps to phases and the final tunnel URL.
The SSH `connect` command is logged and persisted to `history.jsonl`
(`sshCommand`) but never exposed through the API. The workload's non-fatal
"No secondary tunnel returned" error is logged without failing the deployment.

## Caveats (verify before a live deploy)

- `@acurast/sdk` is reached through an injectable interface (`src/deployer.ts`);
  signatures were verified against the published types but **no live on-chain
  deploy** has been run here — confirm `deployProject` argument shapes against the
  SDK before relying on it.
- The `CALLBACK_URL` event convention is implemented by the workload, not a
  protocol guarantee.
- The shared `tunnel.acurast.dev` zone must resolve to the relays of the selected
  `NETWORK` (mainnet by default); subdomains are ephemeral. Confirm the `_acu`
  preimage / relay IPs if you switch to a custom domain.
- The manifest's `maxCostPerExecution` spends real ACU on mainnet — review before
  high-volume use.
