// Copies packages/core/src into shopify-app/app/core so the app (deployed from shopify-app/ only) can use it.
// Edit the engine in packages/core, run its tests, then run: node scripts/sync-core.mjs
import { cpSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const src = "packages/core/src";
const dest = "shopify-app/app/core";
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
for (const f of readdirSync(dest)) {
  const p = join(dest, f);
  writeFileSync(p, "// GENERATED from packages/core/src by scripts/sync-core.mjs. Do not edit here.\n" + readFileSync(p, "utf8"));
}
console.log("core synced to", dest);
