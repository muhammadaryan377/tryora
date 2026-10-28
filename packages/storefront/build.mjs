// Bundles the shopper popup into the theme app extension. Run: npm run build -w @tryora/storefront
import { build } from "esbuild";

// Visully production uses /apps/visully. Isolated staging builds may set VISULLY_PROXY_PATH (e.g. /apps/visully-staging),
// and should write to a separate checkout so the committed bundle is never replaced by a staging build.
const proxy = process.env.VISULLY_PROXY_PATH ?? process.env.TRYORA_PROXY_PATH ?? "/apps/visully";
if (!/^\/(apps|a|community|tools)\/[a-z0-9-]{1,30}$/.test(proxy)) throw new Error(`Invalid app proxy path: ${proxy}`);

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020", "safari14"],
  outfile: "../../shopify-app/extensions/tryora-theme/assets/tryora.js",
  legalComments: "none",
  define: { __TRYORA_PROXY__: JSON.stringify(proxy) },
});
console.log(`built tryora.js (${proxy})`);
