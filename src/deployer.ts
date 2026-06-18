/**
 * Thin wrapper over @acurast/sdk. Loads the template's acurast.json, derives the
 * deployer wallet from the mnemonic, and calls deployProject with injected env
 * vars + a status callback. SDK status strings are mapped to our Phase vocabulary.
 *
 * The SDK is reached through an injectable `DeployDeps` so the orchestrator can be
 * unit-tested without a live chain / IPFS.
 */
import { dirname, isAbsolute, resolve } from "node:path";
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
      // The SDK expects an array of {key,value} (it `.map`s over this); a plain
      // object crashes setEnvironmentVariablesMulti with "envVars.map is not a function".
      envVars: Array<{ key: string; value: string }>;
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
  /**
   * Called once with the job's scheduled end time (ms since epoch) — the
   * deterministic moment the workload stops running, from the SDK-computed
   * `job.schedule.endTime` (startTime + maxExecutionTime).
   */
  onScheduledEnd?: (endTimeMs: number) => void;
  deps: DeployDeps;
}

/** Run a deployment to completion of phase A (SDK stream). Throws on SDK error. */
export async function runDeploy(args: RunDeployArgs): Promise<void> {
  const { config, template, callbackUrl, onPhase, onScheduledEnd, deps } = args;

  console.log(
    `[deployer] start template=${template.id} project=${template.projectName} ` +
      `configPath=${template.acurastConfigPath}`,
  );

  const acurastConfig = deps.loadAcurastConfig({
    filePath: template.acurastConfigPath,
    project: template.projectName,
  });

  // The SDK stats `fileUrl` relative to process.cwd() (see checkIsFolder /
  // zipFolder in @acurast/sdk). Our acurast.json uses a relative `fileUrl`
  // ("app") which only resolves from the template dir, not from wherever the
  // server is launched — on the server that yields `ENOENT stat 'app'`. Rebase
  // any relative, non-ipfs fileUrl to an absolute path next to the acurast.json.
  const cfg = acurastConfig as { fileUrl?: string };
  if (cfg && typeof cfg.fileUrl === "string") {
    const original = cfg.fileUrl;
    if (!original.startsWith("ipfs://") && !isAbsolute(original)) {
      const resolved = resolve(dirname(template.acurastConfigPath), original);
      cfg.fileUrl = resolved;
      console.log(`[deployer] rebased fileUrl '${original}' -> '${resolved}' (cwd=${process.cwd()})`);
    } else {
      console.log(`[deployer] fileUrl '${original}' left as-is (absolute or ipfs)`);
    }
  } else {
    console.warn(`[deployer] acurast config has no string fileUrl; SDK may fail to locate payload`);
  }

  const job = deps.convertConfigToJob(acurastConfig);

  // The job carries a concrete schedule: it stops running at `endTime`
  // (startTime + maxExecutionTime). Report it so the deployment can be marked
  // expired at exactly that moment — no callback anchoring or guesswork.
  const endTime = (job as { schedule?: { endTime?: unknown } })?.schedule?.endTime;
  if (typeof endTime === "number" && Number.isFinite(endTime)) {
    console.log(`[deployer] scheduled end time = ${new Date(endTime).toISOString()}`);
    onScheduledEnd?.(endTime);
  } else {
    console.warn(`[deployer] job has no numeric schedule.endTime; expiry will not be set`);
  }

  const wallet = await deps.walletFromMnemonic(config.acurastMnemonic);

  const envRecord = template.injectedEnv({
    callbackUrl,
    domainSuffix: config.domainSuffix,
  });
  // The SDK wants an array of {key,value}, not a plain object.
  const envVars = Object.entries(envRecord).map(([key, value]) => ({ key, value }));
  console.log(
    `[deployer] deploying: rpc=${config.rpcWss} ipfs=${config.ipfsEndpoint} ` +
      `callbackUrl=${callbackUrl} envKeys=[${Object.keys(envRecord).join(",")}]`,
  );

  await deps.deployProject(acurastConfig, job, {
    wallet,
    rpcEndpoint: config.rpcWss,
    ipfs: { endpoint: config.ipfsEndpoint, apiKey: config.ipfsApiKey },
    envVars,
    statusCallback: (status: string) => {
      const phase = sdkStatusToPhase(status);
      console.log(`[deployer] sdk status='${status}' -> phase=${phase ?? "(unmapped)"}`);
      if (phase) onPhase(phase);
    },
  });
  console.log(`[deployer] deployProject resolved (phase A complete) for template=${template.id}`);
}
