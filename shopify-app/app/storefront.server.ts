import { createHash, randomUUID } from "node:crypto";
import prisma from "./db.server";
import { tryora } from "./tryora.server";
import {
  DEFAULT_WORDING,
  TRIAL_CREDITS,
  TryoraError,
  defaultLauncher,
  resolveSwatches,
  type ImageProvider,
  type LauncherSettings,
  type Placement,
  type TemplateName,
  type GenerateRequest,
  type Placement as PlacementType,
  type Setting,
} from "./core/index";
import { defaultNoun } from "./products.server";
import { ensureAutoProductConfig } from "./auto-products.server";
import { abortable, downloadReference, normaliseImage } from "./preview-images.server";
import { PREVIEW_PRODUCT_QUERY, resolvePreviewProduct, type AdminGraphql } from "./preview-product.server";
import { remoteJob, workerId } from "./preview-worker.server";
import { createImageProvider } from "./image-provider.server";
import { nativeSelections } from "./core/customization";
import { eligibleVariants } from "./native-selection.server";
import { loadProviderSetting } from "./customization/provider-config.server";
import { providerAdapter, resolveConfiguredPreview } from "./customization/registry.server";
import { manualStorefrontData } from "./customization/validation.server";
/**
 * Storefront side of Tryora, reached through the Shopify app proxy (/apps/tryora/*).
 * Image bytes are handled in process memory and never written to disk or the database here.
 * Delivery, failure and expiry clear the result and abort outstanding work. Providers must honour
 * cancellation; OpenAI additionally requires an explicit data-policy acknowledgement.
 * Job/cost metadata is persisted; zero retention is not claimed for OpenAI.
 */
export const provider: ImageProvider = createImageProvider();
export interface Swatch {
  value: string;
  label?: string;
  image: string | null;
  colour: string | null;
  available: boolean;
  group: string | null;
  /** Available, merchant-eligible Shopify variants for this colour. */
  variants: { id: string; image: string | null; options: Record<string, string> }[];
}
export async function storefrontConfig(admin: AdminGraphql, shopId: string, productId: string) {
  ensureSweep();
  await cleanupStalePreviews();
  const gid = productId.startsWith("gid://") ? productId : `gid://shopify/Product/${productId}`;
  const ensured = await ensureAutoProductConfig(admin, shopId, gid);
  if (!ensured) return { enabled: false as const };
  const config = await prisma.productPreviewConfig.findUnique({
    where: { shopId_productId: { shopId, productId: gid } },
    include: { choices: true },
  });
  if (!config?.enabled || config.readiness !== "ready") return { enabled: false as const };
  const providerSetting = await loadProviderSetting(shopId, gid);
  if (!providerAdapter(providerSetting.providerId).capabilities.authorization || (providerSetting.providerId !== "shopify_native" && !providerSetting.active)) return { enabled: false as const };
  const res = await admin.graphql(
    `#graphql
    query TryoraStorefrontProduct($id: ID!) {
      product(id: $id) {
        id title productType
        featuredMedia { preview { image { url } } }
        options { id name optionValues { id name swatch { color image { image { url } } } } }
        variants(first: 250) { nodes { id availableForSale image { url(transform: { maxWidth: 800, maxHeight: 800 }) } selectedOptions { name value } } pageInfo { hasNextPage endCursor } }
      }
    }`,
    { variables: { id: gid } },
  );
  const json: any = await res.json();
  const p = json.data?.product;
  if (!res.ok || json.errors?.length || !p) return { enabled: false as const };
  let page = p.variants.pageInfo;
  while (page?.hasNextPage) {
    const next = await admin.graphql(PREVIEW_PRODUCT_QUERY, { variables: { id: gid, after: page.endCursor } });
    const data = await next.json();
    if (!next.ok || data.errors?.length || !data.data?.product) return { enabled: false as const };
    const variants = data.data.product.variants;
    if (variants.pageInfo.hasNextPage && variants.pageInfo.endCursor === page.endCursor) throw new TryoraError("PROVIDER_UNAVAILABLE");
    p.variants.nodes.push(...variants.nodes);
    page = variants.pageInfo;
  }
  const model = nativeSelections(p.options, config.visualOptionName, p.variants.nodes);
  if (providerSetting.providerId === "shopify_native" && (model.issue || (config.autoConfigured && model.ambiguous))) return { enabled: false as const };
  if (providerSetting.providerId === "shopify_native" && model.fabricOptionName && !model.selections.length) return { enabled: false as const };
  const variantChoice = (v: any) => ({ id: v.id as string, image: v.image?.url ?? null,
    options: Object.fromEntries(v.selectedOptions.map((o: any) => [o.name, o.value])) as Record<string, string> });
  let swatches: Swatch[] = model.selections.map((selection) => {
    const variants = eligibleVariants(config, p.variants.nodes, selection).map(variantChoice);
    return { ...selection, available: variants.length > 0, variants };
  });
  let manualData: Awaited<ReturnType<typeof manualStorefrontData>> | undefined;
  if (providerSetting.providerId === "manual_mapping" || providerSetting.providerId === "cloudlift") {
    try {
      // Cloudlift native-linked mode uses the exact same reviewed native tuples.
      // Browser events never authorize a source variant or a product reference.
      const mappingSetting = providerSetting.providerId === "cloudlift"
        ? { ...providerSetting, providerId: "manual_mapping" }
        : providerSetting;
      manualData = await manualStorefrontData({ admin, config, setting: mappingSetting }, { product: p, variants: p.variants.nodes });
      if (providerSetting.providerId === "cloudlift") manualData = { ...manualData, providerId: "cloudlift" };
    } catch { return { enabled: false as const }; }
    swatches = manualData.swatches;
  }
  const shopRow = await prisma.shop.findUnique({ where: { id: shopId } });
  // The popup only asks for its settings when the app embed is on in the theme, so this marks setup step 3 done.
  if (shopRow && !shopRow.storefrontEnabled) {
    await prisma.shop.update({ where: { id: shopId }, data: { storefrontEnabled: true } }).catch(() => {});
  }
  // Fill gaps with the merchant's own colours, or name-based guesses if they approved guessing.
  const resolved = resolveSwatches(
    swatches.map((s) => ({ value: s.value, shopifyColour: s.colour, shopifyImage: s.image })),
    (manualData || model.fabricOptionName) ? {} : (config.swatchColours as Record<string, string>) ?? {},
    { approved: !manualData && !model.fabricOptionName && !!shopRow?.swatchAutoFill, photoColours: (manualData || model.fabricOptionName) ? {} : cachedPhotoColours(config.photoColours) },
  );
  swatches.forEach((s, i) => {
    s.colour = resolved[i]!.colour;
    s.image = resolved[i]!.image;
  });
  const [appearance, shop, campaign, balance] = await Promise.all([
    prisma.appearance.findFirst({ where: { shopId, scope: "store", scopeId: null } }),
    prisma.shop.findUnique({ where: { id: shopId } }),
    prisma.campaign.findFirst({ where: { shopId, active: true, mode: "offer" }, orderBy: { updatedAt: "desc" } }),
    tryora.balance(shopId),
  ]);
  const template = (appearance?.template as TemplateName) ?? "gallery";
  const launcher: LauncherSettings = { ...defaultLauncher(template), ...((appearance?.launchers as object) ?? {}) };
  const tokens = { accent: null as string | null, useThemeFont: true, ...((appearance?.tokens as object) ?? {}) };
  const lead = { showOptIn: true, optInWording: "", ...((shop?.leadSettings as object) ?? {}) } as {
    showOptIn: boolean;
    optInWording: string;
  };
  const shopName = shopId.replace(".myshopify.com", "").replace(/-/g, " ");
  const itemNoun = config.itemNoun ?? defaultNoun(p.productType, p.title);
  const copy = (campaign?.copy as { headline?: string; details?: string }) ?? {};
  return {
    enabled: true as const,
    available: balance.availableTotal > 0,
    productId: gid,
    product: p.title as string,
    productImage: (p.featuredMedia?.preview?.image?.url as string) ?? null,
    itemNoun,
    placement: config.placement as Placement,
    setting: config.setting as "indoor" | "outdoor" | "either",
    optionName: model.optionName,
    selectorLabel: model.selectorLabel,
    fabricOptionName: model.fabricOptionName,
    selectionOptionNames: model.optionNames,
    // Unavailable variants identify page context but are never offered for generation.
    productVariants: p.variants.nodes.map(variantChoice),
    singleVariants: eligibleVariants(config, p.variants.nodes).map(variantChoice),
    swatches,
    ...(manualData ?? {}),
    style: { template, accent: tokens.accent, useThemeFont: tokens.useThemeFont },
    launcher: { ...launcher, wording: launcher.wording || DEFAULT_WORDING },
    lead: {
      mode: (shop?.leadCapture ?? "required") as "required" | "skippable" | "off",
      timing: (shop?.leadTiming === "after" ? "after" : "before") as "before" | "after",
      showOptIn: lead.showOptIn,
      optInWording: lead.optInWording || `Email me offers and updates from ${shopName}. I can unsubscribe at any time.`,
    },
    offer: campaign?.code
      ? {
          code: campaign.code,
          headline: (copy.headline ?? "").replaceAll("{item}", itemNoun),
          details: (copy.details ?? "").replaceAll("{item}", itemNoun),
        }
      : null,
    mock: provider.capabilities().name === "mock",
  };
}
function cachedPhotoColours(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((raw as Record<string, { colour?: string | null }>) ?? {})) if (v?.colour) out[k] = v.colour;
  return out;
}
// ---------- Photo check (no credit used) ----------
function requireProvider() {
  const capabilities = provider.capabilities();
  const acknowledgedOpenAI = capabilities.name === "openai" && process.env.OPENAI_IMAGE_PRIVACY_ACKNOWLEDGED === "true";
  if ((!capabilities.zeroRetentionConfirmed && !acknowledgedOpenAI) || !capabilities.supportsCancel) throw new TryoraError("PROVIDER_UNAVAILABLE");
}
async function configuredProduct(admin: AdminGraphql, shopId: string, productId: string) {
  const gid = productId.startsWith("gid://") ? productId : `gid://shopify/Product/${productId}`;
  const config = await ensureAutoProductConfig(admin, shopId, gid);
  if (!config?.enabled || config.readiness !== "ready") throw new TryoraError("NOT_FOUND");
  const choices = await prisma.visualChoice.findMany({ where: { configId: config.id } });
  return { ...config, choices };
}
type UsageMetadata = { costMicros?: number; providerRequestId?: string; model?: string };
async function measured<T extends UsageMetadata>(shopId: string, jobId: string | undefined, stage: string, work: () => Promise<T>): Promise<T> {
  try {
    const value = await work();
    await prisma.providerUsage.create({ data: {
      shopId, jobId, stage, outcome: "completed", costMicros: value.costMicros,
      providerRequestId: value.providerRequestId, model: value.model,
    } });
    return value;
  } catch (e) {
    // Never persist raw exceptions: upstream messages can contain shopper data.
    const cost = (e as UsageMetadata | null)?.costMicros;
    await prisma.providerUsage.create({ data: {
      shopId, jobId, stage, outcome: "failed", costMicros: Number.isSafeInteger(cost) && cost! >= 0 ? cost : null,
    } }).catch(() => {});
    throw e;
  }
}
export async function checkPhoto(admin: AdminGraphql, image: Uint8Array, shopId: string, productId: string) {
  requireProvider();
  const config = await configuredProduct(admin, shopId, productId);
  let clean: Uint8Array;
  try { clean = await normaliseImage(image); }
  catch { return { ok: false as const, reason: "dark_or_blurred" as const }; }
  const signal = AbortSignal.timeout(30_000);
  const a = await measured(shopId, undefined, "photo_check", () => abortable(signal, () => provider.analyseRoom(clean, config.referenceAngle ?? "front", {
    placement: config.placement as Placement, setting: config.setting as Setting, itemNoun: config.itemNoun ?? "item",
  }, signal)));
  if (a.outcome === "accepted") return { ok: true as const, detected: a.confidence >= 0.7 ? a.detected : undefined };
  return { ok: false as const, reason: a.reason ?? "unclear_target" };
}
// ---------- Transient jobs ----------
interface Transient {
  shopId: string;
  stage: "preparing" | "generating" | "checking_result" | "ready" | "failed";
  image?: Uint8Array;
  mimeType?: string;
  token?: string;
  error?: string;
  timer: NodeJS.Timeout;
  controller: AbortController;
  expiresAt: number;
}
const jobs = new Map<string, Transient>();
const TRANSIENT_TTL_MS = 10 * 60_000;
const GENERATION_TIMEOUT_MS = 3 * 60_000;
let sweepTimer: NodeJS.Timeout | undefined;
let sweeping: Promise<unknown> | undefined;
export async function cleanupStalePreviews() {
  if (sweeping) return sweeping;
  sweeping = (async () => {
    for (const [id, t] of jobs) if (Date.now() >= t.expiresAt) await expire(id, t);
    await tryora.expireStale(TRANSIENT_TTL_MS);
  })().finally(() => { sweeping = undefined; });
  return sweeping;
}
function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void cleanupStalePreviews().catch(() => {}); }, 30_000);
  sweepTimer.unref();
}
async function expire(jobId: string, t: Transient) {
  t.controller.abort();
  drop(jobId);
  await tryora.transition(jobId, "EXPIRED", { reasonCode: "NOT_DELIVERED_IN_TIME" });
}
function drop(jobId: string) {
  const t = jobs.get(jobId);
  if (!t) return;
  clearTimeout(t.timer);
  t.controller.abort();
  t.image = undefined;
  jobs.delete(jobId);
}
export function errorCode(e: unknown): string {
  return e instanceof TryoraError ? e.code : "UNEXPECTED";
}
export async function startPreview(input: {
  admin: AdminGraphql;
  shopId: string;
  productId: string;
  optionValue: string;
  variantId?: string;
  sourceVariantId?: string;
  mappingRevision?: string;
  visitorId: string;
  idempotencyKey: string;
  leadStepDone: boolean;
  room: Uint8Array;
}) {
  requireProvider();
  ensureSweep();
  await cleanupStalePreviews();
  if (!input.idempotencyKey || input.idempotencyKey.length > 128) throw new TryoraError("BAD_REQUEST");
  if (input.productId.length > 256 || input.optionValue.length > 4096 ||
    (input.variantId?.length ?? 0) > 128 || (input.sourceVariantId?.length ?? 0) > 128 || (input.mappingRevision?.length ?? 0) > 128) throw new TryoraError("BAD_REQUEST");
  const config = await configuredProduct(input.admin, input.shopId, input.productId);
  const setting = await loadProviderSetting(input.shopId, config.productId);
  const product = await resolveConfiguredPreview({ admin: input.admin, config, setting, sourceVariantId: input.sourceVariantId }, input.optionValue, input.variantId, input.mappingRevision);
  const room = await normaliseImage(input.room);
  const analysisSignal = AbortSignal.timeout(30_000);
  const analysis = await measured(input.shopId, undefined, "generation_photo_check", () => abortable(analysisSignal, () => provider.analyseRoom(room, product.referenceAngle, {
    placement: config.placement as Placement, setting: config.setting as Setting, itemNoun: product.itemNoun,
  }, analysisSignal)));
  if (analysis.outcome !== "accepted") throw new TryoraError("BAD_PHOTO");
  const roomPhotoHash = createHash("sha256").update(room).digest("hex").slice(0, 32);
  const { job, deduplicated } = await tryora.createPreview({
    workerId,
    shopId: input.shopId,
    idempotencyKey: input.idempotencyKey,
    visitorId: input.visitorId,
    productId: config.productId,
    optionValue: product.optionValue,
    referenceVersion: product.referenceVersion,
    roomPhotoHash,
    leadStepDone: input.leadStepDone,
  });
  if (deduplicated) return { jobId: job.id };
  const t: Transient = {
    shopId: input.shopId,
    stage: "preparing",
    timer: setTimeout(() => { void expire(job.id, t).catch(() => {}); }, GENERATION_TIMEOUT_MS),
    controller: new AbortController(),
    expiresAt: Date.now() + GENERATION_TIMEOUT_MS,
  };
  t.timer.unref();
  jobs.set(job.id, t);
  void run(job.id, t, {
    room,
    optionValue: product.optionValue,
    itemNoun: product.itemNoun,
    placement: config.placement as Placement,
    urls: product.urls,
    description: product.description,
    analysisCost: analysis.costMicros,
  });
  return { jobId: job.id };
}
async function run(
  jobId: string,
  t: Transient,
  req: { room: Uint8Array; optionValue: string; itemNoun: string; placement: PlacementType; urls: string[]; description: string; analysisCost: number },
) {
  const signal = t.controller.signal;
  try {
    if ((await tryora.transition(jobId, "QUEUED")).ignored) { drop(jobId); return; }
    const references = await abortable(signal, () => Promise.all(req.urls.map((url) => downloadReference(url, signal))));
    t.stage = "generating";
    if ((await tryora.transition(jobId, "GENERATING", { attempts: 1, costMicros: req.analysisCost })).ignored) { drop(jobId); return; }
    const request: GenerateRequest = {
      roomImage: req.room,
      productReferences: references,
      productDescription: req.description,
      itemNoun: req.itemNoun,
      optionValue: req.optionValue,
      placement: req.placement,
    };
    const result = await measured(t.shopId, jobId, "generation", () => abortable(signal, () => provider.generate(request, signal)));
    signal.throwIfAborted();
    t.stage = "checking_result";
    if ((await tryora.transition(jobId, "CHECKING_RESULT", {
      providerRequestId: result.providerRequestId, costMicros: req.analysisCost + result.costMicros,
    })).ignored) { drop(jobId); return; }
    const image = await normaliseImage(result.image);
    const checked = await measured(t.shopId, jobId, "result_check", () => abortable(signal, () => provider.checkResult(request, result, signal)));
    if (checked.outcome !== "accepted") {
      await tryora.transition(jobId, "REJECTED", { reasonCode: "RESULT_REJECTED", costMicros: req.analysisCost + result.costMicros + checked.costMicros });
      throw new TryoraError("RESULT_REJECTED");
    }
    signal.throwIfAborted();
    const ready = await tryora.markReadyToDeliver(jobId, req.analysisCost + result.costMicros + checked.costMicros);
    if (ready.ignored || signal.aborted || jobs.get(jobId) !== t) { drop(jobId); return; }
    clearTimeout(t.timer);
    t.expiresAt = ready.job.deliveryTokenExpiresAt!.getTime();
    t.timer = setTimeout(() => { void expire(jobId, t).catch(() => {}); }, Math.max(0, t.expiresAt - Date.now()));
    t.timer.unref();
    t.image = image;
    t.mimeType = "image/jpeg";
    t.token = ready.job.deliveryToken;
    t.stage = "ready";
  } catch (e) {
    t.stage = "failed";
    t.error = errorCode(e);
    t.image = undefined;
    await tryora.transition(jobId, "FAILED", { reasonCode: t.error === "RESULT_REJECTED" ? "RESULT_REJECTED" : "PROVIDER_ERROR" }).catch(() => {});
  }
}
export async function pollPreview(shopId: string, jobId: string) {
  ensureSweep();
  const remote = await remoteJob("poll", shopId, jobId);
  return remote ?? pollLocalPreview(shopId, jobId);
}
export async function pollLocalPreview(shopId: string, jobId: string) {
  const t = jobs.get(jobId);
  if (!t) {
    const job = await tryora.getJob(jobId);
    if (job?.shopId === shopId) await tryora.transition(jobId, "EXPIRED", { reasonCode: "RESULT_LOST" });
    return { stage: "expired" as const };
  }
  if (t.shopId !== shopId) return { stage: "expired" as const };
  if (Date.now() >= t.expiresAt) { await expire(jobId, t); return { stage: "expired" as const }; }
  if (t.stage === "ready" && t.image) {
    return {
      stage: "ready" as const,
      token: t.token!,
      expiresAt: t.expiresAt,
      image: `data:${t.mimeType};base64,${Buffer.from(t.image).toString("base64")}`,
    };
  }
  if (t.stage === "failed") {
    drop(jobId);
    return { stage: "failed" as const, error: t.error };
  }
  return { stage: t.stage };
}
export async function dropLocalPreview(shopId: string, jobId: string) {
  if (jobs.get(jobId)?.shopId === shopId) drop(jobId);
  return { ok: true };
}
/** The browser confirms it has shown the image. Only now is the credit used, and the bytes are dropped. */
export async function acknowledge(shopId: string, jobId: string, token: string) {
  const job = await tryora.getJob(jobId);
  if (!job || job.shopId !== shopId) throw new TryoraError("NOT_FOUND");
  await tryora.acknowledgeDelivery(jobId, token);
  await prisma.event.upsert({
    where: { id: `delivered:${jobId}` }, update: {},
    create: { id: `delivered:${jobId}`, shopId, name: "delivered", productId: job.productId, option: job.optionValue, jobId },
  });
  await dropLocalPreview(shopId, jobId);
  // Credit settlement is durable even if the owner is temporarily unreachable. Its expiry still drops the bytes.
  await remoteJob("drop", shopId, jobId).catch(() => {});
}
// ---------- Lead capture ----------
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export async function captureLead(
  admin: AdminGraphql,
  input: { shopId: string; email: string; firstName?: string; marketing: boolean; wording: string; productId: string; optionValue?: string },
) {
  if (!EMAIL.test(input.email)) throw new TryoraError("BAD_EMAIL");
  const shop = await prisma.shop.findUnique({ where: { id: input.shopId } });
  const tag = ((shop?.leadSettings as { customerTag?: string }) ?? {}).customerTag || "tryora-lead";
  const lead = await prisma.leadDelivery.create({
    data: { shopId: input.shopId, productId: input.productId, optionValue: input.optionValue, status: "queued" },
  });
  let customerRef: string | null = null;
  let saved = false;
  try {
    const res = await admin.graphql(
      `#graphql
      mutation TryoraLead($input: CustomerSetInput!, $identifier: CustomerSetIdentifiers) {
        customerSet(input: $input, identifier: $identifier) { customer { id } userErrors { message } }
      }`,
      {
        variables: {
          identifier: { email: input.email },
          input: { email: input.email, firstName: input.firstName || undefined, tags: [tag] },
        },
      },
    );
    const json: any = await res.json();
    customerRef = json.data?.customerSet?.customer?.id ?? null;
    const err = json.errors?.[0]?.message ?? json.data?.customerSet?.userErrors?.[0]?.message;
    if (!res.ok || err || !customerRef) throw new Error("CUSTOMER_SAVE_FAILED");
    if (input.marketing) {
      const consentRes = await admin.graphql(
        `#graphql
        mutation TryoraConsent($input: CustomerEmailMarketingConsentUpdateInput!) {
          customerEmailMarketingConsentUpdate(input: $input) { userErrors { message } }
        }`,
        {
          variables: {
            input: {
              customerId: customerRef,
              emailMarketingConsent: { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" },
            },
          },
        },
      );
      const consentJson = await consentRes.json();
      if (!consentRes.ok || consentJson.errors?.length ||
          !consentJson.data?.customerEmailMarketingConsentUpdate ||
          consentJson.data.customerEmailMarketingConsentUpdate.userErrors?.length) throw new Error("CONSENT_SAVE_FAILED");
    }
    await prisma.leadDelivery.update({
      where: { id: lead.id },
      data: { status: "accepted", customerRef },
    });
    saved = true;
  } catch (e) {
    await prisma.leadDelivery.update({ where: { id: lead.id }, data: {
      status: "failed", customerRef,
      lastError: e instanceof Error && e.message === "CONSENT_SAVE_FAILED" ? "CONSENT_SAVE_FAILED" : "CUSTOMER_SAVE_FAILED",
    } });
  }
  // Email/name are sent to Shopify, not stored here. Checkbox wording is not retained here.
  // Delivery metadata and the customer reference are retained; consent state is recorded by Shopify.
  if (saved) await prisma.event.create({ data: { shopId: input.shopId, name: "lead_captured", productId: input.productId } });
  // The shopper's preview never waits on Shopify: a failed customer save is logged for the merchant, not shown to them.
  return { ok: true };
}
export async function reportIssue(shopId: string, jobId: string, category: string) {
  const job = await tryora.getJob(jobId);
  if (!job || job.shopId !== shopId) throw new TryoraError("NOT_FOUND");
  await prisma.issueReport.create({ data: { shopId, jobId, category } });
  return { ok: true };
}
export const newId = () => randomUUID();
export { TRIAL_CREDITS };
