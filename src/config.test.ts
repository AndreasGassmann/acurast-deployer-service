import { describe, it, expect } from "vitest";
import { loadConfig } from "./config";

const base = {
  ACURAST_MNEMONIC: "a b c",
  RPC_WSS: "wss://rpc",
  API_BASE_URL: "https://api.qvac.acurast.dev/",
  API_KEYS: "k1, k2 ,k3",
  PUBLIC_DEPLOY_KEY: "pub",
};

describe("loadConfig", () => {
  it("parses a valid env and trims trailing slash from base url", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(c.apiKeys).toEqual(["k1", "k2", "k3"]);
    expect(c.apiBaseUrl).toBe("https://api.qvac.acurast.dev");
    expect(c.publicDeployKey).toBe("pub");
    expect(c.port).toBe(8080);
  });

  it("defaults DOMAIN_SUFFIX to the shared Acurast zone", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(c.domainSuffix).toBe("tunnel.acurast.dev");
  });

  it("defaults IPFS to the Acurast proxy with no API key", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(c.ipfsEndpoint).toBe("https://ipfs-proxy.acurast.prod.gke.papers.tech");
    expect(c.ipfsApiKey).toBe("");
  });

  it("honours a custom IPFS endpoint + key (trailing slash trimmed)", () => {
    const c = loadConfig({
      ...base,
      IPFS_ENDPOINT: "https://my-pinata/",
      IPFS_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(c.ipfsEndpoint).toBe("https://my-pinata");
    expect(c.ipfsApiKey).toBe("k");
  });

  it("honours a custom DOMAIN_SUFFIX", () => {
    const c = loadConfig({ ...base, DOMAIN_SUFFIX: "my.example.com" } as NodeJS.ProcessEnv);
    expect(c.domainSuffix).toBe("my.example.com");
  });

  it("throws when a required var is missing", () => {
    const { ACURAST_MNEMONIC, ...rest } = base;
    void ACURAST_MNEMONIC;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/ACURAST_MNEMONIC/);
  });

  it("throws when API_KEYS is empty", () => {
    expect(() => loadConfig({ ...base, API_KEYS: " , " } as NodeJS.ProcessEnv)).toThrow(
      /at least one key/,
    );
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ ...base, PORT: "abc" } as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });
});
