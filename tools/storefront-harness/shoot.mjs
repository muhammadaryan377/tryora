// Screenshots every popup step for one style. Usage: STYLE=gallery SWATCHES=3 node shoot.mjs <outdir>
import { createRequire } from "node:module";
const require = createRequire("/opt/npm-tools/node_modules/");
const { chromium } = require("playwright");
const out = process.argv[2];
const style = process.env.STYLE ?? "gallery";
const many = Number(process.env.SWATCHES ?? 3) > 12;
const browser = await chromium.launch();
for (const [device, viewport] of [["desktop", { width: 1280, height: 860 }], ["mobile", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: device === "mobile" ? 2 : 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = (n) => page.screenshot({ path: `${out}/${style}-${device}${many ? "-many" : ""}-${n}.png` });
  await page.goto(`http://localhost:${process.env.PORT ?? 4599}/`);
  await page.waitForSelector(".tryora-launch");
  if (!many) await shot("00-launcher");
  await page.click(".tryora-launch");
  await page.waitForSelector(".tryora__dialog");
  await shot("01-opening");
  await page.setInputFiles("[data-file=upload]", "room.jpg");
  await page.waitForSelector("text=Photo checked");
  await shot("02-photo-ready");
  if (many) {
    await page.click("[data-act=more] >> nth=0");
    await page.waitForSelector(".tryora__panel");
    await shot("03-all-colours");
  } else {
    await page.click("[data-act=generate]");
    await shot("03-email");
    await page.fill("input[name=email]", "shopper@example.com");
    await page.click("[data-act=lead-submit]");
    await page.waitForTimeout(1900);
    await shot("04-generating");
    await page.waitForSelector("[data-act=another]", { timeout: 10000 });
    await shot("05-result");
    await page.click("[data-act=another]");
    await page.click("[data-act=swatch][data-value=Olive]");
    await shot("06-another-colour");
  }
  if (errors.length) console.log(device, "ERRORS", errors);
  await page.close();
}
await browser.close();
console.log("done", style);
