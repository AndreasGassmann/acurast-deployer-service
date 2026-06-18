/** Entry point: load config, wire services, replay history, resume, listen. */
import { loadConfig } from "./config.js";
import { History } from "./history.js";
import { Deployments } from "./deployments.js";
import { EventHub } from "./events.js";
import { Orchestrator } from "./orchestrator.js";
import { realDeps } from "./deployer.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const history = new History(config.dataDir);
  const deployments = new Deployments();
  const events = new EventHub();

  // Rebuild state from the only persistence we have.
  const records = await history.readAll();
  const inFlight = deployments.rebuildFrom(records);

  const deps = await realDeps();
  const orchestrator = new Orchestrator({ config, deployments, history, events, deps });

  // Re-arm tunnel-wait timeouts for deploys that were in flight at shutdown.
  orchestrator.resumeInFlight(inFlight);

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
