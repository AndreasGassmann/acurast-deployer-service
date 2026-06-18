// Copies non-TS template assets (acurast.json + the deployable app/ payloads)
// from src/templates into dist/templates so the compiled service can read them.
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "src/templates";
const DST = "dist/templates";

if (!existsSync(SRC)) process.exit(0);

for (const entry of readdirSync(SRC)) {
  const srcPath = join(SRC, entry);
  if (!statSync(srcPath).isDirectory()) continue; // skip *.ts in templates root
  // copy everything under the template dir except *.ts source files
  cpSync(srcPath, join(DST, entry), {
    recursive: true,
    filter: (p) => !p.endsWith(".ts"),
  });
}

console.log("copied template assets -> dist/templates");
