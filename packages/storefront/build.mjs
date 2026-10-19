// Bundles the shopper popup into the theme app extension. Run: npm run build -w @tryora/storefront
import { build } from "esbuild";
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020", "safari14"],
  outfile: "../../shopify-app/extensions/tryora-theme/assets/tryora.js",
  legalComments: "none",
});
console.log("built tryora.js");
