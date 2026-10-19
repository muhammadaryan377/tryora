// Checks the "email after the first image" flow. Run with the harness server started with LEAD_TIMING=after.
import { createRequire } from "node:module";
const require = createRequire("/opt/npm-tools/node_modules/");
const { chromium } = require("playwright");
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto("http://localhost:4599/");
await p.click(".tryora-launch");
await p.setInputFiles("[data-file=upload]", "room.jpg");
await p.waitForSelector("text=Photo checked");
await p.click("[data-act=generate]");
await p.waitForSelector("[data-act=another]", { timeout: 10000 });
await p.screenshot({ path: "shots/after-result.png" });
await p.click("[data-act=another]");
await p.click("[data-act=swatch][data-value=Olive]");
await p.click("[data-act=generate]");
console.log("second image asks for email:", await p.isVisible("text=Enter your email to create another image"));
await b.close();
