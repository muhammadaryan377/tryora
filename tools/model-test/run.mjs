#!/usr/bin/env node
/**
 * Tryora image model test. Runs each test case (a room photo + product photos) through each configured
 * model and writes the images, a CSV of cost/speed, and a side-by-side report.html for review.
 *
 * Needs Node 22+. No packages to install.
 *   node tools/model-test/run.mjs                 # all cases, all models in models.json
 *   node tools/model-test/run.mjs --models openai-gpt-image-2,gemini-2.5-flash-image --runs 2
 *   node tools/model-test/run.mjs --list-gemini   # show Gemini image models your key can use
 *
 * Keys come from a .env file (searched upward from this folder): OPENAI_API_KEY, GOOGLE_API_KEY.
 * Keys are never printed. Test photos and outputs stay on this computer and are git-ignored.
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
loadEnv(here);

const config = JSON.parse(readFileSync(join(here, "models.json"), "utf8"));
const prompts = JSON.parse(readFileSync(join(here, "prompt.json"), "utf8"));

if (args["list-gemini"]) {
  await listGeminiModels();
  process.exit(0);
}

const wanted = args.models ? String(args.models).split(",") : config.models.filter((m) => m.enabled !== false).map((m) => m.id);
const models = config.models.filter((m) => wanted.includes(m.id));
const runs = Number(args.runs ?? 1);
const casesDir = join(here, "inputs");
const cases = loadCases(casesDir, args.cases ? String(args.cases).split(",") : null);

if (!cases.length) {
  console.error(`No test cases found in ${casesDir}. See tools/model-test/README.md.`);
  process.exit(1);
}
for (const m of models) {
  const key = m.provider === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY";
  if (!process.env[key]) {
    console.error(`Missing ${key} in .env (needed for ${m.id}).`);
    process.exit(1);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(here, "output", stamp);
mkdirSync(outDir, { recursive: true });
const rows = [];

for (const c of cases) {
  mkdirSync(join(outDir, c.name), { recursive: true });
  for (const m of models) {
    for (let r = 1; r <= runs; r++) {
      const label = `${c.name} / ${m.id} / run ${r}`;
      process.stdout.write(`${label} ... `);
      const prompt = buildPrompt(c.meta);
      const started = Date.now();
      try {
        const res = m.provider === "openai" ? await runOpenAI(m, c, prompt) : await runGemini(m, c, prompt);
        const seconds = (Date.now() - started) / 1000;
        const file = `${m.id}-run${r}.${res.ext}`;
        writeFileSync(join(outDir, c.name, file), res.image);
        const cost = estimateCost(m, res.usage);
        rows.push({ case: c.name, model: m.id, run: r, ok: true, seconds, costUsd: cost, file, usage: JSON.stringify(res.usage ?? {}), error: "" });
        console.log(`ok ${seconds.toFixed(1)}s ~$${cost.toFixed(4)}`);
      } catch (e) {
        const seconds = (Date.now() - started) / 1000;
        rows.push({ case: c.name, model: m.id, run: r, ok: false, seconds, costUsd: 0, file: "", usage: "", error: String(e.message ?? e).slice(0, 300) });
        console.log(`FAILED (${String(e.message ?? e).slice(0, 120)})`);
      }
    }
  }
}

writeCsv(join(outDir, "results.csv"), rows);
writeReport(join(outDir, "report.html"), cases, models, rows, runs);
printSummary(models, rows);
console.log(`\nOpen ${join(outDir, "report.html")} to compare the images.`);

// ---------------------------------------------------------------------------------------------

function buildPrompt(meta) {
  const t = meta.placement === "place" ? prompts.place : prompts.replace;
  return t
    .replaceAll("{product}", meta.product)
    .replaceAll("{option}", meta.option ?? "the colour shown in the product photos")
    .replaceAll("{target}", meta.target ?? "the existing bed");
}

async function runOpenAI(m, c, prompt) {
  const form = new FormData();
  form.append("model", m.model);
  form.append("prompt", prompt);
  form.append("n", "1");
  if (m.size) form.append("size", m.size);
  if (m.quality) form.append("quality", m.quality);
  if (m.input_fidelity) form.append("input_fidelity", m.input_fidelity);
  for (const img of [c.room, ...c.products]) {
    form.append("image[]", new Blob([img.bytes], { type: img.mime }), img.name);
  }
  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${json?.error?.message ?? "request failed"}`);
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image");
  return { image: Buffer.from(b64, "base64"), ext: m.output_format ?? "png", usage: json.usage };
}

async function runGemini(m, c, prompt) {
  const parts = [{ text: prompt }];
  parts.push({ text: "Image 1: the shopper's room." });
  parts.push({ inline_data: { mime_type: c.room.mime, data: c.room.bytes.toString("base64") } });
  c.products.forEach((p, i) => {
    parts.push({ text: `Image ${i + 2}: product reference photo.` });
    parts.push({ inline_data: { mime_type: p.mime, data: p.bytes.toString("base64") } });
  });
  const body = { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE"] } };
  if (m.image_size) body.generationConfig.imageConfig = { imageSize: m.image_size };
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GOOGLE_API_KEY },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${json?.error?.message ?? "request failed"}`);
  const out = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
  const data = out?.inlineData ?? out?.inline_data;
  if (!data) throw new Error(`Gemini returned no image (finish: ${json?.candidates?.[0]?.finishReason ?? "unknown"})`);
  const mime = data.mimeType ?? data.mime_type ?? "image/png";
  return { image: Buffer.from(data.data, "base64"), ext: mime.split("/")[1] ?? "png", usage: json.usageMetadata };
}

async function listGeminiModels() {
  if (!process.env.GOOGLE_API_KEY) return console.error("Missing GOOGLE_API_KEY in .env");
  const resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": process.env.GOOGLE_API_KEY },
  });
  const json = await resp.json();
  for (const mod of json.models ?? []) if (/image/i.test(mod.name)) console.log(mod.name.replace("models/", ""), "-", mod.displayName);
}

/** Estimated cost in USD. Prices live in models.json and must be checked against the official pricing pages. */
function estimateCost(m, usage) {
  const p = m.pricing ?? {};
  if (p.per_image !== undefined) return p.per_image;
  if (m.provider === "openai" && usage) {
    const textIn = usage.input_tokens_details?.text_tokens ?? 0;
    const imageIn = usage.input_tokens_details?.image_tokens ?? 0;
    const out = usage.output_tokens ?? 0;
    return (textIn * (p.text_in_per_m ?? 0) + imageIn * (p.image_in_per_m ?? 0) + out * (p.image_out_per_m ?? 0)) / 1e6;
  }
  return 0;
}

function loadCases(dir, only) {
  if (!existsSync(dir)) return [];
  const isImage = (f) => [".jpg", ".jpeg", ".png", ".webp"].includes(extname(f).toLowerCase());
  const mimeOf = (f) => ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" })[extname(f).toLowerCase()];
  const cases = [];
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    if (only && !only.includes(name)) continue;
    const folder = join(dir, name);
    const files = readdirSync(folder).filter(isImage);
    const roomFile = files.find((f) => f.toLowerCase().startsWith("room"));
    const productFiles = files.filter((f) => f.toLowerCase().startsWith("product")).sort();
    const metaPath = join(folder, "case.json");
    if (!roomFile || !productFiles.length || !existsSync(metaPath)) {
      console.warn(`Skipping ${name}: needs room.*, product*.* and case.json`);
      continue;
    }
    const read = (f) => ({ name: f, mime: mimeOf(f), bytes: readFileSync(join(folder, f)) });
    cases.push({ name, room: read(roomFile), products: productFiles.map(read), meta: JSON.parse(readFileSync(metaPath, "utf8")), roomFile });
  }
  return cases;
}

function writeCsv(path, rows) {
  const cols = ["case", "model", "run", "ok", "seconds", "costUsd", "file", "usage", "error"];
  const esc = (v) => `"${String(v).replaceAll('"', '""')}"`;
  writeFileSync(path, [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"));
}

function writeReport(path, cases, models, rows, runs) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  let html = `<!doctype html><meta charset="utf-8"><title>Tryora model test</title>
<style>body{font:14px system-ui;margin:24px;background:#f6f4ef;color:#222}h2{margin-top:40px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
figure{margin:0;background:#fff;padding:10px;border-radius:10px}img{width:100%;border-radius:6px}
figcaption{margin-top:6px}.fail{color:#a33}table{border-collapse:collapse}td,th{padding:4px 10px;border-bottom:1px solid #ddd;text-align:left}</style>
<h1>Tryora image model test</h1><p>Score each image 1–5 for: product accuracy, colour accuracy, room unchanged, realism.</p>`;
  html += summaryTable(models, rows, esc);
  for (const c of cases) {
    html += `<h2>${esc(c.name)}</h2><p>${esc(c.meta.product)} — ${esc(c.meta.option ?? "")}</p><div class="grid">`;
    html += `<figure><img src="../../inputs/${esc(c.name)}/${esc(c.roomFile)}"><figcaption>Original room</figcaption></figure>`;
    for (const m of models) for (let r = 1; r <= runs; r++) {
      const row = rows.find((x) => x.case === c.name && x.model === m.id && x.run === r);
      if (!row) continue;
      html += row.ok
        ? `<figure><img src="${esc(c.name)}/${esc(row.file)}"><figcaption><b>${esc(m.id)}</b> run ${r} · ${row.seconds.toFixed(1)}s · ~$${row.costUsd.toFixed(4)}</figcaption></figure>`
        : `<figure><figcaption class="fail"><b>${esc(m.id)}</b> run ${r} failed: ${esc(row.error)}</figcaption></figure>`;
    }
    html += `</div>`;
  }
  writeFileSync(path, html);
}

function summaryTable(models, rows, esc) {
  let t = `<table><tr><th>Model</th><th>Success</th><th>Avg seconds</th><th>Avg cost (est.)</th></tr>`;
  for (const m of models) {
    const mine = rows.filter((r) => r.model === m.id);
    const ok = mine.filter((r) => r.ok);
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    t += `<tr><td>${esc(m.id)}</td><td>${ok.length}/${mine.length}</td><td>${avg(ok.map((r) => r.seconds)).toFixed(1)}</td><td>$${avg(ok.map((r) => r.costUsd)).toFixed(4)}</td></tr>`;
  }
  return t + `</table><p><small>Costs are estimates from models.json; check the official pricing pages.</small></p>`;
}

function printSummary(models, rows) {
  console.log("\nModel                          ok    avg s   avg $");
  for (const m of models) {
    const mine = rows.filter((r) => r.model === m.id);
    const ok = mine.filter((r) => r.ok);
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    console.log(`${m.id.padEnd(30)} ${`${ok.length}/${mine.length}`.padEnd(5)} ${avg(ok.map((r) => r.seconds)).toFixed(1).padStart(6)}  ${avg(ok.map((r) => r.costUsd)).toFixed(4)}`);
  }
}

function loadEnv(start) {
  let dir = resolve(start);
  for (let i = 0; i < 6; i++) {
    const p = join(dir, ".env");
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
      return;
    }
    dir = dirname(dir);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[k] = next; i++; } else out[k] = true;
  }
  return out;
}
