/**
 * Thin wrapper over @acurast/sdk. Loads the template's acurast.json, derives the
 * deployer wallet from the mnemonic, and calls deployProject with injected env
 * vars + a status callback. SDK status strings are mapped to our Phase vocabulary.
 *
 * The SDK is reached through an injectable `DeployDeps` so the orchestrator can be
 * unit-tested without a live chain / IPFS.
 */
import type { Config } from "./config.js";
import type { Phase } from "./types.js";
import type { Template } from "./templates/index.js";

/** SDK surface we depend on (see research report for verified signatures). */
export interface DeployDeps {
  loadAcurastConfig: (opts: { filePath: string; project: string }) => unknown;
  convertConfigToJob: (config: unknown) => unknown;
  walletFromMnemonic: (mnemonic: string) => Promise<unknown>;
  deployProject: (
    config: unknown,
    job: unknown,
    options: {
      wallet: unknown;
      rpcEndpoint: string;
      ipfs: { endpoint: string; apiKey: string };
      envVars: Record<string, string>;
      statusCallback: (status: string, data?: unknown) => void;
    },
  ) => Promise<unknown>;
}

/** Map the SDK's DeploymentStatus strings to our Phase enum. */
const STATUS_TO_PHASE: Record<string, Phase> = {
  Uploaded: "uploaded",
  Prepared: "prepared",
  Submit: "submitted",
  WaitingForMatch: "matching",
  Matched: "matched",
  Acknowledged: "ack",
  EnvironmentVariablesSet: "env-set",
};

export function sdkStatusToPhase(status: string): Phase | null {
  return STATUS_TO_PHASE[status] ?? null;
}

/** Lazily load the real SDK. Only imported when an actual deploy runs. */
export async function realDeps(): Promise<DeployDeps> {
  const sdk = await import("@acurast/sdk");
  const chain = await import("@acurast/sdk/chain");
  return {
    loadAcurastConfig: (opts) => (sdk as any).loadAcurastConfig(opts),
    convertConfigToJob: (config) => (chain as any).convertConfigToJob(config),
    walletFromMnemonic: (mnemonic) => (chain as any).walletFromMnemonic(mnemonic),
    deployProject: (config, job, options) => (sdk as any).deployProject(config, job, options),
  };
}

export interface RunDeployArgs {
  config: Config;
  template: Template;
  callbackUrl: string;
  /** Called for each recognized deploy phase (phase A only). */
  onPhase: (phase: Phase) => void;
  deps: DeployDeps;
}

/** Run a deployment to completion of phase A (SDK stream). Throws on SDK error. */
export async function runDeploy(args: RunDeployArgs): Promise<void> {
  const { config, template, callbackUrl, onPhase, deps } = args;

  const acurastConfig = deps.loadAcurastConfig({
    filePath: template.acurastConfigPath,
    project: template.projectName,
  });
  const job = deps.convertConfigToJob(acurastConfig);
  const wallet = await deps.walletFromMnemonic(config.acurastMnemonic);

  const envVars = template.injectedEnv({
    callbackUrl,
    domainSuffix: config.domainSuffix,
  });

  await deps.deployProject(acurastConfig, job, {
    wallet,
    rpcEndpoint: config.rpcWss,
    ipfs: { endpoint: config.ipfsEndpoint, apiKey: config.ipfsApiKey },
    envVars,
    statusCallback: (status: string) => {
      const phase = sdkStatusToPhase(status);
      if (phase) onPhase(phase);
    },
  });
}
