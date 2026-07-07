/**
 * Mock SDK deps for local end-to-end testing WITHOUT a chain, IPFS, or funds.
 * Enabled by MOCK_DEPLOY=true. It drives phase A through the status callback, then
 * simulates the deployed workload by POSTing the tunnel lifecycle events to the
 * deployment's own CALLBACK_URL (the URL the orchestrator injected via envVars).
 */
import type { DeployDeps } from "./deployer.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(url: string, body: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // best-effort simulation
  }
}

export function mockDeps(): DeployDeps {
  return {
    loadAcurastConfig: () => ({ mock: true }),
    // Mirror the real job's concrete schedule; short window so expiry is testable locally.
    convertConfigToJob: () => ({ schedule: { endTime: Date.now() + 2 * 60 * 1000 } }),
    walletFromMnemonic: async () => ({ address: "mock" }),
    deployProject: async (_config, _job, options) => {
      const seq = [
        "Uploaded",
        "Prepared",
        "Submit",
        "WaitingForMatch",
        "Matched",
        "Acknowledged",
        "EnvironmentVariablesSet",
      ];
      for (const status of seq) {
        // Mirror the real SDK: WaitingForMatch carries the on-chain job id.
        const data =
          status === "WaitingForMatch"
            ? { jobIds: [[{ acurast: "mock" }, 12345]] }
            : undefined;
        options.statusCallback(status, data);
        await delay(400);
      }

      // Simulate the workload booting and reporting the tunnel, detached so the
      // SDK call resolves at env-set just like the real flow.
      const callbackUrl = options.envVars.find((e) => e.key === "CALLBACK_URL")?.value;
      if (callbackUrl) {
        void (async () => {
          await delay(1000);
          await post(callbackUrl, {
            event: "started",
            webUrl: "https://mock-clientid.tunnel.acurast.dev:8443",
            sshUrl: "https://mock-sshclientid.tunnel.acurast.dev",
            sshPort: 2222,
            connect:
              "ssh -o ProxyCommand='openssl s_client -quiet " +
              "-servername mock-sshclientid.tunnel.acurast.dev " +
              "-connect mock-sshclientid.tunnel.acurast.dev:443' root@mock-sshclientid",
          });
          await delay(1200);
          await post(callbackUrl, { event: "model_loading" });
          await delay(1200);
          await post(callbackUrl, { event: "model_ready" });
        })();
      }
    },
  };
}
