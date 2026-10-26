// GENERATED from packages/core/src by scripts/sync-core.mjs. Do not edit here.
/**
 * Image provider adapter. The app talks only to this interface, so the model can be swapped after the
 * model test without touching the rest of the app. Real providers sit behind a feature flag.
 */

/** How a product goes into a room photo. Chosen per product, with a default from the product type. */
export type Placement =
  | "replace" // swap an existing item: sofa, bed, chair, table, cabinet
  | "place" // put into an empty area
  | "floor_cover" // rug, flooring
  | "wall_cover" // wallpaper, paint, panelling
  | "wall_hang" // art, mirror
  | "light"; // pendant, lamp

export const DEFAULT_PLACEMENT: Record<string, Placement> = {
  sofa: "replace", bed: "replace", chair: "replace", armchair: "replace", table: "replace", cabinet: "replace",
  sideboard: "replace", wardrobe: "replace", rug: "floor_cover", flooring: "floor_cover", carpet: "floor_cover",
  wallpaper: "wall_cover", paint: "wall_cover", panelling: "wall_cover", art: "wall_hang", print: "wall_hang",
  mirror: "wall_hang", pendant: "light", lamp: "light", light: "light",
};

/** Default placement for a product type, falling back to "replace". */
export function defaultPlacement(productType: string): Placement {
  const key = productType.trim().toLowerCase();
  const exact = DEFAULT_PLACEMENT[key];
  if (exact) return exact;
  const hit = Object.keys(DEFAULT_PLACEMENT).find((k) => key.includes(k));
  return (hit && DEFAULT_PLACEMENT[hit]) || "replace";
}

/**
 * Why a room photo can't be used. Checked before any credit is reserved, so a rejected photo never costs
 * the merchant a credit.
 */
export type PhotoProblem =
  | "wrong_angle"
  | "dark_or_blurred"
  | "area_cut_off"
  | "unclear_target"
  | "not_a_room" // e.g. a field, a car, a screenshot, a pet close-up
  | "wrong_setting" // outdoor photo for an indoor product, or the reverse
  | "no_suitable_surface" // e.g. wallpaper but no wall visible, rug but no floor visible
  | "not_allowed"; // people as the main subject, unsafe or inappropriate content

/** Where a product is meant to be used. Garden furniture is "outdoor"; most products are "indoor". */
export type Setting = "indoor" | "outdoor" | "either";

export interface ProviderCapabilities {
  name: string;
  /** Whether the provider can guarantee no retention of inputs/outputs under our configuration/contract. */
  zeroRetentionConfirmed: boolean;
  supportsCancel: boolean;
  supportsMaskedEdit: boolean;
}

export interface RoomAnalysis {
  outcome: "accepted" | "needs_correction" | "unsupported";
  reason?: PhotoProblem;
  /** What the check found for this placement type. Omitted when the check is unsure: the UI then shows no note. */
  detected?: "existing_item" | "empty_space" | "wall" | "floor_area";
  /** Uncertain findings must be phrased as uncertainty in the UI. */
  confidence: number;
  costMicros: number;
  providerRequestId?: string;
  model?: string;
}

export interface RoomContext {
  placement: Placement;
  setting: Setting;
  itemNoun: string;
}

export interface ResultAnalysis {
  outcome: "accepted" | "rejected";
  costMicros: number;
  providerRequestId?: string;
  model?: string;
}

export interface GenerateRequest {
  /** Transient bytes only. Must never be logged, queued durably or written to disk. */
  roomImage: Uint8Array;
  productReferences: Uint8Array[];
  swatch?: Uint8Array;
  /** Separate texture reference; its colour must not override the selected colour sample. */
  fabricTexture?: Uint8Array;
  /** Preview-only merchant swatch. Not an actual Shopify variant or purchase option. */
  previewOnlyAppearance?: { fabric: string; colour: string; hex: string | null };
  productDescription: string;
  /** Shopper-facing noun for the product type, e.g. "sofa", "rug", "wallpaper". */
  itemNoun: string;
  optionValue: string;
  placement: Placement;
}

export interface GenerateResult {
  image: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  providerRequestId: string;
  model: string;
  costMicros: number;
}

export interface ImageProvider {
  capabilities(): ProviderCapabilities;
  analyseRoom(roomImage: Uint8Array, referenceAngle: string, context?: RoomContext, signal?: AbortSignal): Promise<RoomAnalysis>;
  generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult>;
  /** Check product/colour fidelity, placement and room preservation before delivery. */
  checkResult(req: GenerateRequest, result: GenerateResult, signal?: AbortSignal): Promise<ResultAnalysis>;
}

/**
 * Deterministic mock for development and tests. Clearly labelled: it does not produce real previews.
 * Behaviour can be steered by optionValue for testing: "FAIL" throws, "SLOW" waits longer.
 */
export class MockImageProvider implements ImageProvider {
  constructor(private readonly delayMs = 300) {}

  capabilities(): ProviderCapabilities {
    return { name: "mock", zeroRetentionConfirmed: true, supportsCancel: true, supportsMaskedEdit: false };
  }

  async analyseRoom(roomImage: Uint8Array): Promise<RoomAnalysis> {
    if (roomImage.length < 16) return { outcome: "needs_correction", reason: "dark_or_blurred", confidence: 0.9, costMicros: 0 };
    return { outcome: "accepted", detected: "existing_item", confidence: 0.9, costMicros: 0 };
  }

  async checkResult(): Promise<ResultAnalysis> {
    // Mock mode deliberately returns the unchanged room, and is labelled as such in the UI.
    return { outcome: "accepted", costMicros: 0 };
  }

  async generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    signal?.throwIfAborted();
    const wait = req.optionValue === "SLOW" ? this.delayMs * 10 : this.delayMs;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, wait);
      signal?.addEventListener("abort", abort, { once: true });
    });
    if (req.optionValue === "FAIL") throw new Error("Mock provider failure");
    // Returns the room image unchanged: the UI labels mock results "Development preview (not AI)".
    return {
      image: req.roomImage,
      mimeType: "image/jpeg",
      providerRequestId: `mock-${req.optionValue}-${req.roomImage.length}`,
      model: "mock-v1",
      costMicros: 0,
    };
  }
}
