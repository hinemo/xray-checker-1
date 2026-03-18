import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..", "..");
const outDir = resolve(root, "out");
const distDir = resolve(root, "dist");

async function main() {
  if (!existsSync(outDir)) {
    throw new Error("Export output not found. Run next build first.");
  }

  await rm(distDir, { recursive: true, force: true });
  await cp(outDir, distDir, { recursive: true });
  console.log("Copied Next.js export to dist/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
