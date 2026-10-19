import { createHash, randomUUID } from "node:crypto";
import prisma from "./db.server";
import { tryora } from "./tryora.server";
import {
  DEFAULT_WORDING,
  MockImageProvider,
  TRIAL_CREDITS,
  TryoraError,
  defaultLauncher,
  resolveSwatches,
  type ImageProvider,
  type LauncherSettings,
  type Placement,
  type TemplateName,
} from "./core/index";
import { defaultNoun } from "./products.server";

/**
 * Storefront side of Tryora, reached through the Shopify app proxy (/apps/tryora/*).
 * Shopper photos and generated images exist only in this process's memory for the life of one job,
 * and are dropped as soon as the image is delivered, fails, or expires. They are never written to disk or the database.
 */

// Swapped for a real provider once the owner adds an API key and approves the model.
export const provider: ImageProvider = new MockImageProvider(1500);

type AdminGraphql = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

export interface Swatch {
  value: string;
  image: string | null;
  colour: string | null;
  available: boolean;
  group: string | null;
}

export async function storefrontConfig(admin: AdminGraphql, shopId: string, productId: string) {
  const gid = productId.startsWith("gid://") ? productId : `gid://shopify/Product/${productId}`;
  const config = await prisma.productPreviewConfig.findUnique({ where: { shopId_productId: { shopId, productId: gid } } });
  if (!config?.enabled || config.readiness !== "ready") return { enabled: false as const };

  const res = await admin.graphql(
    `#graphql
    query TryoraStorefrontProduct($id: ID!) {
      product(id: $id) {
        id title productType
        featuredMedia { preview { image { url } } }
        options { name optionValues { name swatch { color image { image { url } } } } }
        variants(first: 250) { nodes { availableForSale image { url(transform: { maxWidth: 160, maxHeight: 160 }) } selectedOptions { name value } } }
      }
    }`,
    { variables: { id: gid } },
  );
  const json: any = await res.json();
  const p = json.data?.product;
  if (!p) return { enabled: false as const };

  const optionName = config.visualOptionName;
  const option = optionName ? p.options.find((o: any) => o.name === optionName) : null;
  // One colour (e.g. just a black sofa) needs no swatches: the product's own photos are used.
  const values = (option?.optionValues ?? []).length > 1 ? option.optionValues : [];
  const swatches: Swatch[] = values.map((v: any) => {
    const variants = p.variants.nodes.filter((n: any) =>
      n.selectedOptions.some((s: any) => s.name === optionName && s.value === v.name),
    );
    return {
      value: v.name,
      image: v.swatch?.image?.image?.url ?? null,
      colour: v.swatch?.color ?? null,
      available: variants.some((n: any) => n.availableForSale),
      group: null, // colour groups come from merchant settings (not built yet), so no chips show
    };
  });
  const shopRow = await prisma.shop.findUnique({ where: { id: shopId } });
  // The popup only asks for its settings when the app embed is on in the theme, so this marks setup step 3 done.
  if (shopRow && !shopRow.storefrontEnabled) {
    await prisma.shop.update({ where: { id: shopId }, data: { storefrontEnabled: true } }).catch(() => {});
  }
  // Fill gaps with the merchant's own colours, or name-based guesses if they approved guessing.
  const resolved = resolveSwatches(
    swatches.map((s) => ({ value: s.value, shopifyColour: s.colour, shopifyImage: s.image })),
    (config.swatchColours as Record<string, string>) ?? {},
    { approved: !!shopRow?.swatchAutoFill, photoColours: cachedPhotoColours(config.photoColours) },
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
    optionName,
    swatches,
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

export async function checkPhoto(image: Uint8Array) {
  if (image.length > 8 * 1024 * 1024) return { ok: false as const, reason: "dark_or_blurred" as const };
  const a = await provider.analyseRoom(image, "front");
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
}

const jobs = new Map<string, Transient>();
const TRANSIENT_TTL_MS = 10 * 60_000;

function drop(jobId: string) {
  const t = jobs.get(jobId);
  if (!t) return;
  clearTimeout(t.timer);
  t.image = undefined;
  jobs.delete(jobId);
}

export function errorCode(e: unknown): string {
  return e instanceof TryoraError ? e.code : "UNEXPECTED";
}

export async function startPreview(input: {
  shopId: string;
  productId: string;
  optionValue: string;
  visitorId: string;
  idempotencyKey: string;
  leadStepDone: boolean;
  room: Uint8Array;
}) {
  const config = await prisma.productPreviewConfig.findUnique({
    where: { shopId_productId: { shopId: input.shopId, productId: input.productId } },
  });
  if (!config?.enabled) throw new TryoraError("NOT_FOUND", "Product not set up");

  const roomPhotoHash = createHash("sha256").update(input.room).digest("hex").slice(0, 32);
  const { job, deduplicated } = await tryora.createPreview({
    shopId: input.shopId,
    idempotencyKey: input.idempotencyKey,
    visitorId: input.visitorId,
    productId: input.productId,
    optionValue: input.optionValue,
    referenceVersion: config.referenceMediaId ?? "none",
    roomPhotoHash,
    leadStepDone: input.leadStepDone,
  });
  if (deduplicated) return { jobId: job.id };

  const t: Transient = {
    shopId: input.shopId,
    stage: "preparing",
    timer: setTimeout(() => drop(job.id), TRANSIENT_TTL_MS),
  };
  jobs.set(job.id, t);
  void run(job.id, t, {
    room: input.room,
    optionValue: input.optionValue,
    itemNoun: config.itemNoun ?? "item",
    placement: config.placement as Placement,
  });
  return { jobId: job.id };
}

async function run(
  jobId: string,
  t: Transient,
  req: { room: Uint8Array; optionValue: string; itemNoun: string; placement: Placement },
) {
  try {
    await tryora.transition(jobId, "QUEUED");
    t.stage = "generating";
    await tryora.transition(jobId, "GENERATING", { attempts: 1 });
    const result = await provider.generate({
      roomImage: req.room,
      productReferences: [],
      productDescription: "",
      itemNoun: req.itemNoun,
      optionValue: req.optionValue,
      placement: req.placement,
    });
    t.stage = "checking_result";
    await tryora.transition(jobId, "CHECKING_RESULT");
    const ready = await tryora.markReadyToDeliver(jobId, result.costMicros);
    t.image = result.image;
    t.mimeType = result.mimeType;
    t.token = ready.job.deliveryToken;
    t.stage = "ready";
  } catch (e) {
    t.stage = "failed";
    t.error = errorCode(e);
    t.image = undefined;
    await tryora.transition(jobId, "FAILED", { reasonCode: "PROVIDER_ERROR" }).catch(() => {});
  }
}

export function pollPreview(shopId: string, jobId: string) {
  const t = jobs.get(jobId);
  if (!t || t.shopId !== shopId) return { stage: "expired" as const };
  if (t.stage === "ready" && t.image) {
    return {
      stage: "ready" as const,
      token: t.token!,
      image: `data:${t.mimeType};base64,${Buffer.from(t.image).toString("base64")}`,
    };
  }
  if (t.stage === "failed") {
    drop(jobId);
    return { stage: "failed" as const };
  }
  return { stage: t.stage };
}

/** The browser confirms it has shown the image. Only now is the credit used, and the bytes are dropped. */
export async function acknowledge(shopId: string, jobId: string, token: string) {
  const job = await tryora.getJob(jobId);
  if (!job || job.shopId !== shopId) throw new TryoraError("NOT_FOUND");
  await tryora.acknowledgeDelivery(jobId, token);
  drop(jobId);
  await prisma.event.create({ data: { shopId, name: "delivered", productId: job.productId, option: job.optionValue, jobId } });
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
    if (customerRef && input.marketing) {
      await admin.graphql(
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
    }
    await prisma.leadDelivery.update({
      where: { id: lead.id },
      data: customerRef ? { status: "accepted", customerRef } : { status: "failed", lastError: String(err ?? "unknown").slice(0, 200) },
    });
  } catch (e) {
    await prisma.leadDelivery.update({ where: { id: lead.id }, data: { status: "failed", lastError: String(e).slice(0, 200) } });
  }

  // Nothing about the shopper is kept by Tryora (owner decision): consent is recorded by Shopify on the customer.
  await prisma.event.create({ data: { shopId: input.shopId, name: "lead_captured", productId: input.productId } });
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
