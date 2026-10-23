/**
 * Store knowledge for the Room Assistant: Shopify shop policies, published Online Store pages (FAQ, About,
 * Delivery…), merchant-written assistant notes and public contact details.
 *
 * Full texts are split into sections and only the sections relevant to a question are sent to the model, so long
 * policies keep their later clauses without sending every policy on every message.
 *
 * Online Store pages require the read_online_store_pages scope. Without it the page query is refused by Shopify and
 * the assistant continues with policies, notes and contact details only.
 */
import type { AdminGraphql } from "../preview-product.server";
import { buildIndex, chunkText, expandQuery, htmlToText, scoreIndex, type SearchIndex } from "./text";
import { adminQuery, type ShopifyBudget } from "./catalogue.server";
import { logAssistant } from "./log.server";

const FRESH_MS = 10 * 60_000;
const MAX_PAGES = 30;
const MAX_SOURCE_CHARS = 30_000;
const MAX_CACHED_SHOPS = 100;

export const STORE_INFO_QUERY = `#graphql
  query TryoraAssistantStoreInfo {
    shop {
      name contactEmail
      primaryDomain { url }
      shopPolicies { type title url body }
    }
  }`;

export const STORE_PAGES_QUERY = `#graphql
  query TryoraAssistantPages {
    pages(first: ${MAX_PAGES}) { nodes { title handle body isPublished } }
  }`;

export interface KnowledgeSection {
  source: "policy" | "page" | "merchant_notes" | "contact";
  title: string;
  url: string | null;
  text: string;
}

export interface StoreKnowledge {
  shopId: string;
  shopName: string;
  sections: KnowledgeSection[];
  index: SearchIndex<KnowledgeSection>;
  pagesAvailable: boolean;
  loadedAt: number;
  notesKey: string;
}

const POLICY_LABELS: Record<string, string> = {
  REFUND_POLICY: "Returns and refunds",
  SHIPPING_POLICY: "Shipping and delivery",
  PRIVACY_POLICY: "Privacy",
  TERMS_OF_SERVICE: "Terms of service",
  CONTACT_INFORMATION: "Contact information",
  LEGAL_NOTICE: "Legal notice",
  SUBSCRIPTION_POLICY: "Subscriptions",
};

function sectionsFrom(source: KnowledgeSection["source"], title: string, url: string | null, text: string): KnowledgeSection[] {
  return chunkText(text.slice(0, MAX_SOURCE_CHARS)).map((chunk, index, all) => ({
    source,
    title: all.length > 1 ? `${title} (part ${index + 1} of ${all.length})` : title,
    url,
    text: chunk,
  }));
}

export function buildKnowledge(shopId: string, input: {
  shopName: string;
  contactEmail?: string | null;
  domain?: string | null;
  policies: { type?: string; title?: string; url?: string; body?: string }[];
  pages: { title?: string; handle?: string; body?: string; isPublished?: boolean }[];
  notes: string;
  pagesAvailable: boolean;
}, loadedAt = Date.now()): StoreKnowledge {
  const sections: KnowledgeSection[] = [];
  for (const policy of input.policies) {
    const text = htmlToText(String(policy.body ?? ""));
    if (!text) continue;
    const title = POLICY_LABELS[String(policy.type)] ?? String(policy.title ?? "Store policy");
    sections.push(...sectionsFrom("policy", title, policy.url ? String(policy.url) : null, text));
  }
  for (const page of input.pages) {
    if (page.isPublished === false) continue;
    const text = htmlToText(String(page.body ?? ""));
    if (!text || !page.handle) continue;
    sections.push(...sectionsFrom("page", String(page.title ?? page.handle), `/pages/${encodeURIComponent(page.handle)}`, text));
  }
  if (input.notes.trim()) sections.push(...sectionsFrom("merchant_notes", "Store information from the merchant", null, input.notes));
  const contact = [
    `Store name: ${input.shopName}`,
    input.contactEmail ? `Customer contact email: ${input.contactEmail}` : "",
    input.domain ? `Website: ${input.domain}` : "",
  ].filter(Boolean).join(". ");
  sections.push({ source: "contact", title: "Contact the store", url: null, text: `${contact}. Contact, email, help, support, customer service.` });
  return {
    shopId,
    shopName: input.shopName,
    sections,
    index: buildIndex(sections, (section) => [{ text: section.title, weight: 2 }, { text: section.text, weight: 1 }]),
    pagesAvailable: input.pagesAvailable,
    loadedAt,
    notesKey: input.notes,
  };
}

const cache = new Map<string, StoreKnowledge>();
export function resetAssistantKnowledgeCache() { cache.clear(); }
export function invalidateAssistantKnowledge(shopId: string) { cache.delete(shopId); }

export async function loadStoreKnowledge(admin: AdminGraphql, shopId: string, notes: string, budget: ShopifyBudget): Promise<StoreKnowledge> {
  const cached = cache.get(shopId);
  if (cached && cached.shopId === shopId && cached.notesKey === notes && Date.now() - cached.loadedAt < FRESH_MS) return cached;
  const info = await adminQuery(admin, STORE_INFO_QUERY, {}, "store_info", budget);
  let pages: any[] = [];
  let pagesAvailable = false;
  try {
    const data = await adminQuery(admin, STORE_PAGES_QUERY, {}, "store_pages", budget);
    pages = data.pages?.nodes ?? [];
    pagesAvailable = true;
  } catch {
    // Expected while the app lacks read_online_store_pages; already logged without content.
  }
  const knowledge = buildKnowledge(shopId, {
    shopName: String(info.shop?.name ?? ""),
    contactEmail: info.shop?.contactEmail ?? null,
    domain: info.shop?.primaryDomain?.url ?? null,
    policies: info.shop?.shopPolicies ?? [],
    pages,
    notes,
    pagesAvailable,
  });
  cache.set(shopId, knowledge);
  while (cache.size > MAX_CACHED_SHOPS) cache.delete(cache.keys().next().value!);
  logAssistant("catalogue_loaded", { shop: shopId, stage: "knowledge", pages: pages.length, complete: pagesAvailable }, "info");
  return knowledge;
}

/** The most relevant sections for a question, bounded in count and size. */
export function retrieveKnowledge(knowledge: StoreKnowledge, query: string, limit = 4): KnowledgeSection[] {
  const ranked = scoreIndex(knowledge.index, expandQuery(query))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(6, Math.max(1, limit)))
    .map((entry) => entry.item);
  return ranked;
}
