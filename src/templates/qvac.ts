/**
 * qvac template — deploys the acurast-qvac on-device LLM server (OpenAI-compatible
 * API + chat UI) behind an Acurast Tunnel.
 *
 * The deployable payload (`app/` + `acurast.json`) is vendored under
 * `src/templates/qvac/` from github.com/Acurast/acurast-qvac. See the README for
 * how to refresh it. The workload reads CALLBACK_URL + DOMAIN_SUFFIX (declared in
 * the acurast.json `includeEnvironmentVariables`) and POSTs lifecycle events back.
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
  projectName: "qvac",
  paramSchema,
  injectedEnv: ({ callbackUrl, domainSuffix }) => ({
    CALLBACK_URL: callbackUrl,
    DOMAIN_SUFFIX: domainSuffix,
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
