/** Template = a curated, deployable workload definition. */
import type { ZodTypeAny } from "zod";
import type { Phase } from "../types.js";

export interface InjectedEnvContext {
  callbackUrl: string;
  domainSuffix: string;
}

export interface Template {
  id: string;
  displayName: string;
  description: string;
  /** Absolute or project-relative path to the vendored acurast.json. */
  acurastConfigPath: string;
  /** The acurast.json project name to deploy (key under `projects`). */
  projectName: string;
  /** Validates `POST /deployments` params for this template. */
  paramSchema: ZodTypeAny;
  /** Builds the encrypted env vars injected into the deployment. */
  injectedEnv: (ctx: InjectedEnvContext) => Record<string, string>;
  /** Per-phase duration estimates in seconds (drives the UI progress bar + ETA). */
  estimates: Record<Phase, number>;
}
