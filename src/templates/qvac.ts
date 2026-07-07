/**
 * qvac template — deploys the acurast-qvac on-device LLM server (OpenAI-compatible
 * API + chat UI) behind an Acurast Tunnel.
 *
 * The deployable payload (`app/` + `acurast.json`) is vendored under
 * `src/templates/qvac/` from github.com/Acurast/acurast-qvac. See the README for
 * how to refresh it. The workload reads CALLBACK_URL, NETWORK (canary|mainnet),
 * DOMAIN_SUFFIX_<NETWORK> and SSH_AUTHORIZED_KEYS — it exits if NETWORK or
 * SSH_AUTHORIZED_KEYS is unset — and POSTs lifecycle events back.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Template } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

const paramSchema = z
  .object({
    /** Model id understood by the qvac server. */
    model: z.string().min(1).default("LLAMA_3_2_1B_INST_Q4_0"),
  })
  .strict();

export const qvacTemplate: Template = {
  id: "qvac",
  displayName: "Acurast QVAC",
  description:
    "Private on-device LLM inference server (OpenAI-compatible API + chat UI) " +
    "running on an Acurast processor, exposed via an Acurast Tunnel.",
  acurastConfigPath: join(here, "qvac", "acurast.json"),
  // The vendored acurast.json names its project "qvac-llm" (template id stays "qvac").
  projectName: "qvac-llm",
  paramSchema,
  injectedEnv: ({ callbackUrl, domainSuffix, network, sshAuthorizedKeys }) => ({
    CALLBACK_URL: callbackUrl,
    NETWORK: network,
    // tunnel.py picks the suffix from DOMAIN_SUFFIX_<NETWORK>; the unsuffixed
    // DOMAIN_SUFFIX is no longer read.
    [`DOMAIN_SUFFIX_${network.toUpperCase()}`]: domainSuffix,
    SSH_AUTHORIZED_KEYS: sshAuthorizedKeys,
  }),
  // No protocol time estimates exist; these are hand-tuned per-phase guesses (seconds).
  estimates: {
    uploaded: 15,
    prepared: 10,
    submitted: 10,
    matching: 90,
    matched: 10,
    ack: 30,
    "env-set": 15,
    started: 60,
    "model-loading": 90,
    "model-ready": 0,
  },
};
