import { defineConfig } from "astro/config";

// Static site (SSG). Deploy progress + public list are fetched client-side from
// the deployer API, so no SSR/adapter is needed.
export default defineConfig({
  output: "static",
  site: "https://qvac.acurast.dev",
});
