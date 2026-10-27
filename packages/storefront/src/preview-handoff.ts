/** In-memory, same-page delivery only. No event bus, image URLs or server authorization inputs. */
export interface PopupPreviewDelivery {
  jobId: string;
  productId: string;
  title: string;
  variantId: string | null;
  optionValue: string;
  selectionLabel: string;
  selectedOptions: Record<string, string>;
  image: Blob;
  room: Blob;
  leadDone: boolean;
}
export interface PopupPreviewHandoff {
  /** Returns true only once the decoded result has been displayed in the chat. */
  deliver: (result: PopupPreviewDelivery) => boolean;
  closed: () => void;
  leadDone: () => boolean;
  /** The initiating chatbot\u0027s independent lead setting, not the product-page popup\u0027s setting. */
  lead?: { mode: "off" | "required" | "skippable"; timing: "before" | "after"; showOptIn: boolean; optInWording: string };
}
