/**
 * Conservative, deterministic intent plan for Room Assistant.
 * Keeps the shopper's actual words authoritative. This plan is explanatory context,
 * NOT permission to fabricate product references, colours or store facts.
 */
export type ShopperIntent =
  | "acknowledgement" | "product_discovery" | "room_recommendation" | "more_options"
  | "product_question" | "comparison" | "preview" | "room_analysis" | "store_support" | "general";

export interface IntentPlan {
  intent: ShopperIntent;
  standaloneQuery: string;
  inheritedCategory: string | null;
  needsRoomFit: boolean;
}

const CATEGORY = /\b(beds?|bedframes?|sofas?|couches?|settees?|armchairs?|chairs?|tables?|wardrobes?|desks?|rugs?|ottomans?|mattresses?|headboards?|shelves?|dressers?)\b/i;
const FOLLOW_UP = /^(?:and\s+)?(?:what about|how about|also|and|in (?:grey|gray|cream|beige|black|white|green|blue)|something|any|cheaper|more expensive|better|the (?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)|this|that|it|those|same|another)\b/i;
const ACK = /^(?:(?:ok(?:ay)?|great|perfect|lovely|nice|thanks|thank you|alright|got it)|(?:(?:this|that|it|the preview)\s+)?(?:looks?|sounds?)\s+(?:good|great|nice|perfect)|i\s+(?:really\s+)?(?:like|love)\s+(?:it|this|that))(?:[!., ]*)$/i;

function categoryOf(text: string): string | null {
  const match = text.match(CATEGORY);
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  if (/^bed/.test(word)) return "bed";
  if (/^(sofa|couch|settee)/.test(word)) return "sofa";
  if (/^(chair|armchair)/.test(word)) return "chair";
  if (/^table/.test(word)) return "table";
  if (/^wardrobe/.test(word)) return "wardrobe";
  if (/^desk/.test(word)) return "desk";
  if (/^rug/.test(word)) return "rug";
  if (/^ottoman/.test(word)) return "ottoman";
  if (/^mattress/.test(word)) return "mattress";
  if (/^headboard/.test(word)) return "headboard";
  if (/^shelf/.test(word)) return "shelf";
  return "dresser";
}

export function planShopperTurn(input: {
  latest: string;
  previousUserMessages: string[];
  roomKnown: boolean;
  newRoomPhoto: boolean;
  referencedProductName?: string | null;
  selectedProductName?: string | null;
}): IntentPlan {
  const latest = input.latest.trim().slice(0, 800);
  const lower = latest.toLowerCase();
  // Carry a previous category only for an actual elliptical follow-up, never for a new subject.
  const mentionedCategory = categoryOf(latest);
  const previousCategory = input.previousUserMessages.slice(-8).reverse()
    .map(categoryOf).find((value): value is string => !!value) ?? null;
  const inheritedCategory = !mentionedCategory && FOLLOW_UP.test(latest) ? previousCategory : null;
  const knownCategory = mentionedCategory ?? inheritedCategory;
  const preview = /\b(preview|visuali[sz]e)\b|\b(?:show|see)\b[^.!?]*\b(?:in my room|in this room)\b|\bhow (?:does|would|will) (?:it|this|that) look\b/i.test(lower);
  const compare = /\b(compare|versus|vs\.?|difference|which (?:is|one is) (?:better|cheaper|more expensive)|which one (?:costs? less|costs? more)|cheapest|least expensive|most expensive|lower price|higher price)\b/i.test(lower);
  const more = /\b(show|see|give|any)\s+(?:me\s+)?(?:more|moes|mroe)\b|\b(?:more|other|different|another)\s+(?:options?|products?|choices?|ones?|sofas?|beds?)\b|\b(?:something else|anything else)\b/i.test(lower);
  const support = /\b(ship|ships|shipping|deliver(?:y|ies)?|return(?:s)?|refund|warrant(?:y|ies)|order status|opening hours|contact)\b/i.test(lower);
  const question = /\b(price|cost|how much|dimensions?|measurements?|materials?|fabrics?|colou?rs?|sizes?|stock|available|availability|made of|does it have|what about|tell me about|can you explain|is it|does this|what is)\b/i.test(lower);
  const discovery = /\b(show|recommend|suggest|find|looking for|need|pick|choose|best for|what (?:would|will) (?:suit|look|work|be)|which (?:one|furniture))\b/i.test(lower);
  const explanation = /\bwhy\b.*\b(?:only|show|shown|two|three|\d+)\b/i.test(lower);
  const roomMention = /\b(room|bedroom|living room|my space|this space|here)\b/i.test(lower) || input.newRoomPhoto;
  const intent: ShopperIntent =
    ACK.test(latest) ? "acknowledgement" :
    explanation ? "product_question" :
    compare ? "comparison" :
    preview ? "preview" :
    more ? "more_options" :
    input.newRoomPhoto && !discovery && !mentionedCategory ? "room_analysis" :
    support ? "store_support" :
    roomMention && (discovery || input.newRoomPhoto) ? "room_recommendation" :
    question ? "product_question" :
    discovery ? "product_discovery" : "general";
  const references = input.referencedProductName || input.selectedProductName || null;
  const contextual = [
    `Latest shopper request: ${JSON.stringify(latest)}.`,
    `Intent: ${intent.replaceAll("_", " ")}.`,
    ...(references ? [`Referenced product in verified conversation: ${JSON.stringify(references)}.`] : []),
    ...(knownCategory ? [`Furniture category: ${knownCategory}.`] : []),
    ...(input.roomKnown ? ["Use verified observations from the active room (never an older room)."] : []),
    ...(inheritedCategory ? ["This is a follow-up to that earlier furniture category, not a new unrelated search."] : []),
    ...(intent === "comparison" ? ["Answer the comparison directly using verified prices or attributes. Do not generate another recommendation batch unless explicitly requested."] : []),
    ...(intent === "product_question" ? ["Answer the actual question first. Do not replace it with new product cards or a generic preview offer."] : []),
    ...(intent === "acknowledgement" ? ["Respond briefly and naturally. Do not repeat a product card or preview."] : []),
    "Use the latest request to override conflicting earlier preferences. Do not infer an unstated price, variant or product.",
  ];
  return {
    intent,
    standaloneQuery: contextual.join(" "),
    inheritedCategory,
    needsRoomFit: input.roomKnown && ["room_recommendation", "product_discovery", "more_options", "comparison"].includes(intent),
  };
}
