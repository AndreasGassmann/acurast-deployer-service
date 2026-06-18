/**
 * Express app factory. Pure wiring over the injected services so it can be tested
 * with supertest against a mocked orchestrator/store.
 */
import express, { type Express, type Request, type Response } from "express";
import type { Config } from "./config.js";
import type { Deployments } from "./deployments.js";
import type { EventHub } from "./events.js";
import { Orchestrator, ValidationError, type CallbackEvent } from "./orchestrator.js";
import { identify, requireKey, requireFullKey } from "./auth.js";
import { RateLimiter } from "./rate-limit.js";
import { listTemplates } from "./templates/index.js";

export interface AppDeps {
  config: Config;
  deployments: Deployments;
  events: EventHub;
  orchestrator: Orchestrator;
}

export function createApp(deps: AppDeps): Express {
  const { config, deployments, events, orchestrator } = deps;
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "256kb" }));
  app.use(identify(config));

  const publicLimiter = new RateLimiter(
    config.publicDeployRatePerHour,
    60 * 60 * 1000,
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // List available templates (any valid key).
  app.get("/templates", requireKey, (_req, res) => {
    res.json(
      listTemplates().map((t) => ({
        id: t.id,
        displayName: t.displayName,
        description: t.description,
      })),
    );
  });

  // Start a deployment.
  app.post("/deployments", requireKey, async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const templateId = String(body.template ?? "");
    const wantPublic = body.public === true;

    if (req.auth!.kind === "public") {
      if (templateId !== "qvac") {
        res.status(403).json({ error: "public key may only deploy the qvac template" });
        return;
      }
      const ip = req.ip ?? "unknown";
      if (!publicLimiter.check(ip, Date.now())) {
        res.status(429).json({ error: "rate limit exceeded" });
        return;
      }
    }

    try {
      const id = await orchestrator.start(templateId, body.params, wantPublic);
      res.status(202).json({ id });
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "deployment failed to start" });
    }
  });

  // Read a single deployment (public deployments need no key).
  app.get("/deployments/:id", (req: Request, res: Response) => {
    const view = deployments.view(req.params.id);
    if (!view) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (!view.public && !req.auth) {
      res.status(401).json({ error: "missing or invalid API key" });
      return;
    }
    res.json(view);
  });

  // SSE progress stream (public deployments need no key).
  app.get("/deployments/:id/events", (req: Request, res: Response) => {
    const view = deployments.view(req.params.id);
    if (!view) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (!view.public && !req.auth) {
      res.status(401).json({ error: "missing or invalid API key" });
      return;
    }
    streamEvents(req, res, events, deployments, req.params.id);
  });

  // History list. ?public=true => public deployments, no key. Else full key required.
  app.get("/deployments", (req: Request, res: Response) => {
    if (req.query.public === "true") {
      res.json(deployments.list({ publicOnly: true }));
      return;
    }
    requireFullKey(req, res, () => {
      res.json(deployments.list());
    });
  });

  // Inbound workload callback (authorized by per-deployment token, not an API key).
  app.post("/api/tunnel/:id", async (req: Request, res: Response) => {
    const token = String(req.query.token ?? "");
    const event = req.body as CallbackEvent;
    if (!event || typeof event.event !== "string") {
      res.status(400).json({ error: "invalid callback body" });
      return;
    }
    const ok = await orchestrator.handleCallback(req.params.id, token, event);
    if (!ok) {
      res.status(403).json({ error: "invalid deployment id or token" });
      return;
    }
    res.json({ ok: true });
  });

  return app;
}

function streamEvents(
  req: Request,
  res: Response,
  events: EventHub,
  deployments: Deployments,
  id: string,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Emit the current state immediately so late subscribers are in sync.
  const current = deployments.view(id);
  if (current) {
    send({
      id: current.id,
      status: current.status,
      phase: current.phase,
      progress: current.progress,
      etaSeconds: current.etaSeconds,
      tunnelUrl: current.tunnelUrl,
      error: current.error,
    });
  }

  const unsubscribe = events.subscribe(id, (event) => {
    send(event);
    if (event.status === "ready" || event.status === "failed" || event.status === "timed-out") {
      res.end();
    }
  });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
