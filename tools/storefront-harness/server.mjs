// Local stand-in for the Shopify app proxy, for screenshot tests of the popup. Not deployed.
import http from "node:http";
import { readFileSync } from "node:fs";
const ASSETS = "../../shopify-app/extensions/tryora-theme/assets";
const NAMES = ["Oat","Olive","Rust","Sand","Stone","Ivory","Chalk","Taupe","Mink","Charcoal","Silver","Slate","Pebble","Cocoa","Espresso","Camel","Mustard","Ochre","Terracotta","Blush","Rose","Burgundy","Sage","Forest","Navy"];
const HEX = ["#d8c6ae","#6b6a2e","#b5532a","#cdb79a","#a59e93","#ece4d6","#e6e1d8","#9c8a78","#8b7766","#4a4a4a","#b9bcbf","#6f7a83","#a69e94","#6b4a3a","#3e2b22","#b88a5a","#c9962e","#c08a3e","#c06a4a","#e0b2a8","#c9a39a","#7d2533","#9aa68a","#355e3b","#24345a"];
const template = process.env.STYLE ?? "gallery";
const count = Number(process.env.SWATCHES ?? 3);
const config = () => ({
  enabled: true, available: true, productId: "gid://shopify/Product/1", product: "Form Sofa",
  productImage: "/product.jpg", itemNoun: "sofa", placement: "replace", setting: "indoor", optionName: "Colour",
  swatches: NAMES.slice(0, count).map((n, i) => ({ value: n, image: null, colour: HEX[i], available: n !== "Rust" && n !== "Rose", group: null })),
  style: { template, accent: null, useThemeFont: false },
  launcher: { mode: "tryora", type: "overlay", wording: "See it in your room", showIcon: true, background: "#111111", text: "#ffffff", radiusPx: 999, position: "bottom-right", offsetPx: { x: 16, y: 16 }, showOnMobile: true, showOnDesktop: true },
  lead: { mode: process.env.LEAD ?? "required", timing: process.env.LEAD_TIMING ?? "before", showOptIn: true, optInWording: "Email me offers and updates from Nordhaus. I can unsubscribe at any time." },
  offer: { code: "MYROOM15", headline: "15% off this sofa", details: "This sofa only. Cannot be combined." },
  mock: true,
});
const jobs = new Map();
const send = (res, data, type = "application/json") => { res.writeHead(200, { "Content-Type": type }); res.end(typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/") return send(res, readFileSync("page.html"), "text/html");
  if (u.pathname.endsWith(".jpg")) return send(res, readFileSync("." + u.pathname), "image/jpeg");
  if (u.pathname.startsWith("/assets/")) return send(res, readFileSync(ASSETS + u.pathname.slice(7)), u.pathname.endsWith(".css") ? "text/css" : "text/javascript");
  if (u.pathname === "/apps/tryora/config") return send(res, config());
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    if (u.pathname === "/apps/tryora/check") return send(res, { ok: true, detected: "existing_item" });
    if (u.pathname === "/apps/tryora/preview") { const id = "job" + jobs.size; jobs.set(id, Date.now()); return send(res, { jobId: id }); }
    const m = u.pathname.match(/^\/apps\/tryora\/preview\/(.+)$/);
    if (m) { const age = Date.now() - jobs.get(m[1]); const hold = Number(process.env.HOLD ?? 2500);
      if (age < hold) return send(res, { stage: age < hold / 2 ? "preparing" : "generating" });
      return send(res, { stage: "ready", token: "t", image: "data:image/jpeg;base64," + readFileSync("room.jpg").toString("base64") }); }
    return send(res, { ok: true });
  });
}).listen(Number(process.env.PORT ?? 4599));
