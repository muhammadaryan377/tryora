export type AssistantPageType = "home" | "product" | "collection" | "other";

export interface RoomAssistantSettings {
  enabled: boolean;
  greeting: string;
  launcherLabel: string;
  launcherPosition: "bottom-left" | "bottom-right";
  launcherColour: string;
  pages: Record<AssistantPageType, boolean>;
  excludedProducts: string[];
  excludedCollections: string[];
  /** Merchant-written facts for shoppers (delivery areas, showroom, warranty…). Quoted only when relevant. */
  knowledge: string;
}

export const MAX_ASSISTANT_KNOWLEDGE = 8000;

export interface AssistantPageContext {
  pageType: string;
  productId?: string;
  productHandle?: string;
  collectionId?: string;
  collectionHandle?: string;
}

export const DEFAULT_ROOM_ASSISTANT_SETTINGS: RoomAssistantSettings = {
  enabled: false,
  greeting: "Hi, how can I help today?",
  launcherLabel: "Room assistant",
  launcherPosition: "bottom-right",
  launcherColour: "#6f7046",
  pages: { home: false, product: true, collection: false, other: false },
  excludedProducts: [],
  excludedCollections: [],
  knowledge: "",
};

const cleanTokens = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim()).filter(Boolean))].slice(0, 100)
  : [];

export function roomAssistantSettings(copy: unknown): RoomAssistantSettings {
  const source = ((copy as { assistant?: Partial<RoomAssistantSettings> } | null)?.assistant ?? {}) as Partial<RoomAssistantSettings>;
  const pages = source.pages ?? {} as Partial<RoomAssistantSettings["pages"]>;
  return {
    enabled: source.enabled === true,
    greeting: typeof source.greeting === "string" && source.greeting.trim()
      ? source.greeting.trim().slice(0, 120)
      : DEFAULT_ROOM_ASSISTANT_SETTINGS.greeting,
    launcherLabel: typeof source.launcherLabel === "string" && source.launcherLabel.trim()
      ? source.launcherLabel.trim().slice(0, 40)
      : DEFAULT_ROOM_ASSISTANT_SETTINGS.launcherLabel,
    launcherPosition: source.launcherPosition === "bottom-left" ? "bottom-left" : "bottom-right",
    launcherColour: typeof source.launcherColour === "string" && /^#[0-9a-f]{6}$/i.test(source.launcherColour)
      ? source.launcherColour
      : DEFAULT_ROOM_ASSISTANT_SETTINGS.launcherColour,
    pages: {
      home: pages.home === true,
      product: pages.product !== false,
      collection: pages.collection === true,
      other: pages.other === true,
    },
    excludedProducts: cleanTokens(source.excludedProducts),
    excludedCollections: cleanTokens(source.excludedCollections),
    knowledge: typeof source.knowledge === "string" ? source.knowledge.trim().slice(0, MAX_ASSISTANT_KNOWLEDGE) : "",
  };
}

function pageKind(pageType: string): AssistantPageType {
  if (pageType === "index") return "home";
  if (pageType === "product") return "product";
  if (pageType === "collection") return "collection";
  return "other";
}

const normalized = (value: string | undefined) => value?.trim().toLowerCase() ?? "";

export function roomAssistantVisible(settings: RoomAssistantSettings, page: AssistantPageContext): boolean {
  if (!settings.enabled || !settings.pages[pageKind(page.pageType)]) return false;
  if (page.pageType === "product") {
    const excluded = new Set(settings.excludedProducts.map(normalized));
    if (excluded.has(normalized(page.productId)) || excluded.has(normalized(page.productHandle))) return false;
  }
  if (page.pageType === "collection") {
    const excluded = new Set(settings.excludedCollections.map(normalized));
    if (excluded.has(normalized(page.collectionId)) || excluded.has(normalized(page.collectionHandle))) return false;
  }
  return true;
}

export function parseExclusionList(value: unknown): string[] {
  return [...new Set(String(value ?? "").split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean))].slice(0, 100);
}
