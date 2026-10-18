/**
 * Image provider adapter. The app talks only to this interface, so the model can be swapped after the
 * model test without touching the rest of the app. Real providers sit behind a feature flag.
 */

export interface ProviderCapabilities {
  name: string;
  /** Whether the provider can guarantee no retention of inputs/outputs under our configuration/contract. */
  zeroRetentionConfirmed: boolean;
  supportsCancel: boolean;
  supportsMaskedEdit: boolean;
}

export interface RoomAnalysis {
  outcome: "accepted" | "needs_correction" | "unsupported";
  reason?: "wrong_angle" | "dark_or_blurred" | "area_cut_off" | "unclear_target";
  detected?: "existing_item" | "empty_space";
  /** Uncertain findings must be phrased as uncertainty in the UI. */
  confidence: number;
  costMicros: number;
}

export interface GenerateRequest {
  /** Transient bytes only. Must never be logged, queued durably or written to disk. */
  roomImage: Uint8Array;
  productReferences: Uint8Array[];
  swatch?: Uint8Array;
  productDescription: string;
  optionValue: string;
  placement: "replace" | "place";
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
  analyseRoom(roomImage: Uint8Array, referenceAngle: string): Promise<RoomAnalysis>;
  generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult>;
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

  async generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const wait = req.optionValue === "SLOW" ? this.delayMs * 10 : this.delayMs;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, wait);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
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
