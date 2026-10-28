/**
 * Product media has three roles that must never be confused:
 * - fabric texture and colour sample: close-up material photos the merchant uploaded through Visully as samples;
 * - full furniture reference: the complete product photo the AI preview is generated from.
 *
 * The sample role is proven only by the marker Visully writes as the Shopify alt text when it uploads a sample. A product
 * gallery photo is never a sample because of its position, file name, or because an older mapping pointed at it.
 */
export const SAMPLE_ALT_PREFIX = "Visully fabric sample ";
export const REFERENCE_ALT_PREFIX = "Visully furniture reference ";

// Previous Shopify media retains the historic alt marker. Both prefixes are trusted,
// so a rename never turns a genuine fabric sample into a full-product reference.
const LEGACY_SAMPLE_ALT_PREFIX = "Tryora fabric sample ";

type MediaLike = { alt?: string | null };
export const isSampleMedia = (media: MediaLike | null | undefined) =>
  !!media?.alt && (media.alt.startsWith(SAMPLE_ALT_PREFIX) || media.alt.startsWith(LEGACY_SAMPLE_ALT_PREFIX));

/** Media offered in the fabric texture / colour sample picker: classified samples only. */
export function sampleChoices<T extends MediaLike>(media: T[]): T[] {
  return media.filter(isSampleMedia);
}

/** Media offered as a full furniture reference: never a classified sample or an image bound as a sample. */
export function referenceChoices<T extends MediaLike & { id: string }>(media: T[], boundSampleIds: ReadonlySet<string>): T[] {
  return media.filter((m) => !isSampleMedia(m) && !boundSampleIds.has(m.id));
}
