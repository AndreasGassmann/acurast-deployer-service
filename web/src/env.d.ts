/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Base URL of the deployer API, e.g. https://api.qvac.acurast.dev */
  readonly PUBLIC_API_BASE: string;
  /** Restricted, qvac-only public deploy key baked into the static site. */
  readonly PUBLIC_DEPLOY_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
