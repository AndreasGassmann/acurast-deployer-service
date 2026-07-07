import { describe, it, expect } from "vitest";
import { sdkStatusToPhase, runDeploy, type DeployDeps } from "./deployer";
import { qvacTemplate } from "./templates/qvac";
import type { Config } from "./config";
import type { Phase } from "./types";

const config: Config = {
  acurastMnemonic: "a b c",
  rpcWss: "wss://rpc",
  network: "mainnet",
  sshAuthorizedKeys: "ssh-ed25519 AAAA test@host",
  ipfsEndpoint: "https://ipfs",
  ipfsApiKey: "key",
  apiBaseUrl: "https://api",
  apiKeys: ["k"],
  publicDeployKey: "p",
  domainSuffix: "tunnel.acurast.dev",
  port: 8080,
  dataDir: "./data",
  publicDeployRatePerHour: 5,
  corsOrigins: ["*"],
};

describe("sdkStatusToPhase", () => {
  it("maps known SDK statuses", () => {
    expect(sdkStatusToPhase("WaitingForMatch")).toBe("matching");
    expect(sdkStatusToPhase("EnvironmentVariablesSet")).toBe("env-set");
  });
  it("returns null for unknown / never-emitted statuses", () => {
    expect(sdkStatusToPhase("Started")).toBeNull();
    expect(sdkStatusToPhase("garbage")).toBeNull();
  });
});

describe("runDeploy", () => {
  it("drives onPhase from the SDK status callback and injects env vars", async () => {
    const phases: Phase[] = [];
    let capturedEnv: Array<{ key: string; value: string }> | null = null;

    const deps: DeployDeps = {
      loadAcurastConfig: () => ({ projects: {} }),
      convertConfigToJob: () => ({ job: true }),
      walletFromMnemonic: async () => ({ wallet: true }),
      deployProject: async (_c, _j, options) => {
        capturedEnv = options.envVars;
        for (const s of [
          "Uploaded",
          "Prepared",
          "Submit",
          "WaitingForMatch",
          "Matched",
          "Acknowledged",
          "EnvironmentVariablesSet",
        ]) {
          options.statusCallback(s);
        }
      },
    };

    await runDeploy({
      config,
      template: qvacTemplate,
      callbackUrl: "https://api/api/tunnel/dep_1?token=t",
      deps,
      onPhase: (p) => phases.push(p),
    });

    expect(phases).toEqual([
      "uploaded",
      "prepared",
      "submitted",
      "matching",
      "matched",
      "ack",
      "env-set",
    ]);
    expect(capturedEnv).toEqual([
      { key: "CALLBACK_URL", value: "https://api/api/tunnel/dep_1?token=t" },
      { key: "NETWORK", value: "mainnet" },
      { key: "DOMAIN_SUFFIX_MAINNET", value: "tunnel.acurast.dev" },
      { key: "SSH_AUTHORIZED_KEYS", value: "ssh-ed25519 AAAA test@host" },
    ]);
  });

  it("overrides the manifest network with the configured one", async () => {
    let deployedConfig: unknown = null;
    const deps: DeployDeps = {
      loadAcurastConfig: () => ({ network: "canary" }),
      convertConfigToJob: () => ({}),
      walletFromMnemonic: async () => ({}),
      deployProject: async (c) => {
        deployedConfig = c;
      },
    };
    await runDeploy({
      config,
      template: qvacTemplate,
      callbackUrl: "c",
      deps,
      onPhase: () => {},
    });
    expect((deployedConfig as { network?: string }).network).toBe("mainnet");
  });

  it("suffixes the domain env var for canary", async () => {
    let capturedEnv: Array<{ key: string; value: string }> | null = null;
    const deps: DeployDeps = {
      loadAcurastConfig: () => ({}),
      convertConfigToJob: () => ({}),
      walletFromMnemonic: async () => ({}),
      deployProject: async (_c, _j, options) => {
        capturedEnv = options.envVars;
      },
    };
    await runDeploy({
      config: { ...config, network: "canary" },
      template: qvacTemplate,
      callbackUrl: "c",
      deps,
      onPhase: () => {},
    });
    expect(capturedEnv).toContainEqual({ key: "NETWORK", value: "canary" });
    expect(capturedEnv).toContainEqual({
      key: "DOMAIN_SUFFIX_CANARY",
      value: "tunnel.acurast.dev",
    });
  });

  it("propagates SDK errors", async () => {
    const deps: DeployDeps = {
      loadAcurastConfig: () => ({}),
      convertConfigToJob: () => ({}),
      walletFromMnemonic: async () => ({}),
      deployProject: async () => {
        throw new Error("chain rejected");
      },
    };
    await expect(
      runDeploy({
        config,
        template: qvacTemplate,
        callbackUrl: "c",
        deps,
        onPhase: () => {},
      }),
    ).rejects.toThrow("chain rejected");
  });
});
