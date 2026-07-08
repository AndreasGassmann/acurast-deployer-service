/** Entry point: load config, wire services, replay history, resume, listen. */
import { loadConfig } from "./config.js";
import { History } from "./history.js";
import { Deployments } from "./deployments.js";
import { EventHub } from "./events.js";
import { Orchestrator } from "./orchestrator.js";
import { realDeps } from "./deployer.js";
import { mockDeps } from "./deployer-mock.js";
import { createApp } from "./app.js";
import { computeEstimates } from "./estimates.js";
import { listTemplates } from "./templates/index.js";
import type { Phase } from "./types.js";

// A deploy runs detached and the SDK can throw outside any awaited path (e.g. in
// its internal env-var step), which would otherwise crash the whole service and
// drop every in-flight deployment. Log and keep serving instead of exiting.
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("uncaughtException:", err);
});

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const history = new History(config.dataDir);
  const events = new EventHub();

  // Rebuild state from the only persistence we have.
  const records = await history.readAll();

  // Derive per-phase ETA estimates from history (per template), falling back to
  // each template's baked-in guesses. Computed once at boot.
  const estimates: Record<string, Record<Phase, number>> = {};
  for (const t of listTemplates()) {
    const forTemplate = records.filter((r) => r.template === t.id);
    estimates[t.id] = computeEstimates(forTemplate, t.estimates);
  }

  const deployments = new Deployments(estimates);
  const inFlight = deployments.rebuildFrom(records);

  const mock = process.env.MOCK_DEPLOY === "true";
  const deps = mock ? mockDeps() : await realDeps();
  if (mock) {
    // eslint-disable-next-line no-console
    console.log("MOCK_DEPLOY=true — using simulated deployments (no chain/IPFS).");
  }
  const orchestrator = new Orchestrator({
    config,
    deployments,
    history,
    events,
    deps,
    tunnelTimeoutMs: config.tunnelTimeoutMs,
    modelLoadTimeoutMs: config.modelLoadTimeoutMs,
  });

  // Re-arm tunnel-wait timeouts for deploys that were in flight at shutdown.
  orchestrator.resumeInFlight(inFlight);

  // Expire ready deploys past their run window + clean up old non-working ones.
  // Runs once now (clears anything stale from before the restart) then periodically.
  const SWEEP_INTERVAL_MS = 60 * 1000;
  await orchestrator.sweep(Date.now());
  setInterval(() => {
    void orchestrator.sweep(Date.now());
  }, SWEEP_INTERVAL_MS).unref();

  const app = createApp({ config, deployments, events, orchestrator });
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `acurast-deployer-service listening on :${config.port} ` +
        `(replayed ${records.length} history records, ${inFlight.length} resumed)`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
