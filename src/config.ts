/**
 * Loads and validates service configuration from an environment object.
 *
 * Kept pure (takes `env` explicitly) so it can be unit-tested without touching
 * `process.env`. The Acurast SDK never reads env itself; these values are passed
 * to the deployer explicitly.
 */

export interface Config {
  acurastMnemonic: string;
  rpcWss: string;
  /** Target Acurast network; drives the manifest `network` field and the NETWORK env injected into workloads. */
  network: "canary" | "mainnet";
  /**
   * Public key(s) allowed to SSH into deployed workloads (authorized_keys format,
   * `\n`-separated). The qvac workload exits if this is unset, so it is required.
   */
  sshAuthorizedKeys: string;
  ipfsEndpoint: string;
  ipfsApiKey: string;
  apiBaseUrl: string;
  apiKeys: string[];
  publicDeployKey: string;
  domainSuffix: string;
  port: number;
  dataDir: string;
  publicDeployRatePerHour: number;
  /** Allowed CORS origins; ["*"] allows any. */
  corsOrigins: string[];
}

const DEFAULT_DOMAIN_SUFFIX = "tunnel.acurast.dev";

// Acurast's hosted IPFS proxy (same default the @acurast/cli ships). Pinata-
// compatible (`/pinning/pinFileToIPFS`) and needs no API key, so deploys work
// out of the box without provisioning Pinata credentials.
const DEFAULT_IPFS_ENDPOINT = "https://ipfs-proxy.acurast.prod.gke.papers.tech";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v.trim() === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v.trim();
}

function splitKeys(raw: string): string[] {
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKeys = splitKeys(required(env, "API_KEYS"));
  if (apiKeys.length === 0) {
    throw new Error("API_KEYS must contain at least one key");
  }

  const portRaw = env.PORT?.trim() || "8080";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }

  const networkRaw = env.NETWORK?.trim() || "mainnet";
  if (networkRaw !== "canary" && networkRaw !== "mainnet") {
    throw new Error(`Invalid NETWORK: ${networkRaw} (expected "canary" or "mainnet")`);
  }

  const rateRaw = env.PUBLIC_DEPLOY_RATE_PER_HOUR?.trim() || "5";
  const publicDeployRatePerHour = Number(rateRaw);
  if (!Number.isInteger(publicDeployRatePerHour) || publicDeployRatePerHour < 0) {
    throw new Error(`Invalid PUBLIC_DEPLOY_RATE_PER_HOUR: ${rateRaw}`);
  }

  return {
    acurastMnemonic: required(env, "ACURAST_MNEMONIC"),
    rpcWss: required(env, "RPC_WSS"),
    network: networkRaw,
    sshAuthorizedKeys: required(env, "SSH_AUTHORIZED_KEYS"),
    // Default to the Acurast IPFS proxy (no key required). Override both to use
    // your own Pinata-compatible pinning service.
    ipfsEndpoint: (env.IPFS_ENDPOINT?.trim() || DEFAULT_IPFS_ENDPOINT).replace(/\/+$/, ""),
    ipfsApiKey: env.IPFS_API_KEY?.trim() || "",
    apiBaseUrl: required(env, "API_BASE_URL").replace(/\/+$/, ""),
    apiKeys,
    publicDeployKey: required(env, "PUBLIC_DEPLOY_KEY"),
    domainSuffix: env.DOMAIN_SUFFIX?.trim() || DEFAULT_DOMAIN_SUFFIX,
    port,
    dataDir: env.DATA_DIR?.trim() || "./data",
    publicDeployRatePerHour,
    corsOrigins: splitKeys(env.CORS_ORIGINS?.trim() || "*"),
  };
}
