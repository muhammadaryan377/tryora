/**
 * Tryora storefront popup. Bundled into the theme app extension as assets/tryora.js.
 * Follows the approved flow in packages/core/src/flow.ts. Room photos and generated images stay in this
 * browser tab's memory only (object URLs), and are released when the shopper changes room or leaves.
 */
import {
  initialFlow,
  isViewed,
  leadSatisfied,
  photoNote,
  showLeadOnResult,
  photoProblemMessage,
  reduce,
  type FlowCommand,
  type FlowEvent,
  type FlowState,
} from "../../core/src/flow.js";
import { launchersToRender, type LauncherSettings } from "../../core/src/launcher.js";
import type { PhotoProblem } from "../../core/src/provider.js";
import { acknowledgeWithRetry, createWithRetry, decodePreview } from "./reliability.js";
import { classifyCloudliftOption, nativeSourceVariantId } from "./cloudlift-events.js";
import { RoomAssistant, buildAssistantLauncher, fetchAssistantConfig, wasOpen } from "./assistant.js";
import { PROXY } from "./proxy.js";

interface VariantChoice {
  id: string;
  image: string | null;
  options: Record<string, string>;
}

interface Swatch {
  value: string;
  label?: string;
  image: string | null;
  colour: string | null;
  available: boolean;
  group: string | null;
  variants: VariantChoice[];
}

interface Config {
  enabled: boolean;
  available: boolean;
  productId: string;
  product: string;
  productImage: string | null;
  itemNoun: string;
  placement: string;
  setting: "indoor" | "outdoor" | "either";
  optionName: string | null;
  selectorLabel?: string | null;
  swatches: Swatch[];
  fabricOptionName?: string | null;
  selectionOptionNames?: string[];
  productVariants?: VariantChoice[];
  singleVariants?: VariantChoice[];
  providerId?: string;
  mappingRevision?: string;
  style: { template: string; accent: string | null; useThemeFont: boolean };
  launcher: LauncherSettings;
  lead: { mode: "required" | "skippable" | "off"; timing: "before" | "after"; showOptIn: boolean; optInWording: string };
  offer: { code: string; headline: string; details: string } | null;
  mock: boolean;
}

/** Option value used for products with a single style (no colour choice). Never shown to shoppers. */
const SINGLE = "__single__";
const COMPACT_DESKTOP = 12;
const ISSUE_CATEGORIES: [string, string][] = [
  ["wrong_product", "It's not the right product"],
  ["wrong_colour", "The colour is wrong"],
  ["room_changed", "My room was changed"],
  ["placement_problem", "It's in the wrong place or the wrong size"],
];
const STAGES: { key: string; label: (c: string) => string }[] = [
  { key: "checking_photo", label: () => "Photo checked" },
  { key: "preparing", label: () => "Preparing image" },
  { key: "generating", label: (c) => (c ? `Generating ${c} image` : "Generating image") },
  { key: "checking_result", label: () => "Checking result" },
];

// ---------- small helpers ----------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const isMobile = () => window.matchMedia("(max-width: 749px)").matches;

function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function visitorId(): string {
  const existing = store("tryora_vid");
  if (existing) return existing;
  const id = crypto.randomUUID();
  return store("tryora_vid", id) ?? id;
}

async function post(path: string, data: Record<string, string | Blob>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(data)) form.append(k, v);
  const res = await fetch(`${PROXY}/${path}`, { method: "POST", body: form, credentials: "same-origin", signal: AbortSignal.timeout(40_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? "REQUEST_FAILED"), { code: body.error ?? "REQUEST_FAILED" });
  return body;
}

/** Shrinks the photo in the browser before upload. Returns null for files we can't read. */
async function preparePhoto(file: File): Promise<{ blob: Blob; url: string } | { problem: string }> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
    return { problem: "unsupported_format" };
  }
  if (file.size > 25 * 1024 * 1024) return { problem: "too_large" };
  try {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width < 400 || bitmap.height < 300) return { problem: "too_small" };
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.86));
    if (!blob) return { problem: "unreadable" };
    return { blob, url: URL.createObjectURL(blob) };
  } catch {
    return { problem: "unreadable" };
  }
}

const FILE_PROBLEMS: Record<string, string> = {
  unsupported_format: "That file type isn't supported. Please use a JPG, PNG or HEIC photo.",
  too_large: "That photo is too large. Please choose one under 25 MB.",
  too_small: "That photo is too small. Please use a larger photo of your room.",
  unreadable: "We couldn't open that photo. Please try another one.",
};

const NOTICES: Record<string, string> = {
  generation_failed: "Something went wrong making your image. No credit was used – please try again.",
  result_rejected: "We weren't happy with that image, so we didn't show it. Please try again or use another photo.",
  quota_reached: "You've reached the preview limit for now. Your images so far are still here.",
  previews_paused: "New previews are temporarily unavailable. Please try again later.",
  connection_lost: "Connection lost. Please check your internet and try again.",
  taking_longer: "This is taking a little longer than usual…",
};

/**
 * Notes on the shopper's basket that they saw this product in their room. Shopify copies basket notes onto the
 * order, which is how the merchant's dashboard counts sales from Tryora. Underscored notes are hidden from shoppers.
 */
async function tagBasket(productId: string) {
  try {
    const id = productId.split("/").pop()!;
    const cart = await (await fetch("/cart.js", { credentials: "same-origin" })).json();
    const seen = new Set(String(cart?.attributes?._tryora_products ?? "").split(",").filter(Boolean));
    if (seen.has(id)) return;
    seen.add(id);
    await fetch("/cart/update.js", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: { _tryora: "1", _tryora_products: [...seen].join(",") } }),
    });
  } catch {
    /* never get in the shopper's way */
  }
}

// ---------- the popup ----------

export class Tryora {
  private state: FlowState;
  private root: HTMLElement | null = null;
  private lastFocus: Element | null = null;
  private photos = new Map<string, { blob: Blob; url: string }>();
  private images = new Map<string, string>(); // jobId -> object URL
  private fileProblem: string | null = null;
  private panel: "none" | "swatches" | "issue" = "none";
  private issueSent = false;
  private email = "";
  private firstName = "";
  private marketing = false;
  private emailError = "";
  private copied = false;
  private configurationNotice: string | null = null;
  private pageOptions: Record<string, string> = {};
  private fabric: string | null = null;
  private configurationEpoch = 0;
  private cloudliftUnverifiedSelection = false;
  private cloudliftExpectedNative: { name: string; value: string } | null = null;
  private readonly cloudliftChanged = (event: Event) => {
    if (!this.root || this.cfg.providerId !== "cloudlift") return;
    const options = new Set((this.cfg.productVariants ?? []).flatMap((v) =>
      Object.keys(v.options).filter((name) => !name.startsWith("__tryora_"))));
    const signal = classifyCloudliftOption((event as CustomEvent<unknown>).detail, options);
    if (signal.kind === "native") this.cloudliftExpectedNative = { name: signal.name, value: signal.value };
    else this.cloudliftUnverifiedSelection = true; // External/custom option: cannot verify its image identity.

    // A Cloudlift change can modify furniture appearance without changing a native variant ID.
    // Revoke stale results and invalidate in-flight work even if the form ID is unchanged.
    if (!this.syncPageConfiguration()) {
      this.configurationEpoch++;
      for (const url of this.images.values()) URL.revokeObjectURL(url);
      this.images.clear();
      this.state = { ...this.state, generation: null, results: {}, shownOption: null, notice: null,
        step: !this.cfg.available ? "unavailable" : this.state.photo ? "photoReady" : "opening" };
    }
    this.render();
  };
  private pageWatchTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pageChangeHandler = () => { if (this.root && this.syncPageConfiguration()) this.render(); };

  private syncPageConfiguration(): boolean {
    const page = productPageOptions(this.cfg);
    const same = Object.keys(page).length === Object.keys(this.pageOptions).length && Object.entries(page).every(([name, value]) => this.pageOptions[name] === value);
    if (same) return false;
    this.configurationEpoch++;
    this.pageOptions = page;
    this.fabric = this.cfg.fabricOptionName ? page[this.cfg.fabricOptionName] ?? this.fabric : null;
    for (const url of this.images.values()) URL.revokeObjectURL(url);
    this.images.clear();
    this.state = { ...this.state, generation: null, results: {}, shownOption: null, notice: null,
      selectedOption: this.cfg.swatches.length ? this.visibleSwatches().find((x) => this.selectedVariant(x.value))?.value ?? null : SINGLE,
      step: !this.cfg.available ? "unavailable" : this.state.photo ? "photoReady" : "opening" };
    return true;
  }

  constructor(private readonly cfg: Config) {
    this.pageOptions = productPageOptions(cfg);
    this.fabric = cfg.fabricOptionName ? this.pageOptions[cfg.fabricOptionName] ?? cfg.swatches[0]?.group ?? null : null;
    const firstAvailable = this.visibleSwatches().find((s) => s.available && this.selectedVariant(s.value))?.value ?? null;
    const onPage = cfg.swatches.find((x) => Object.entries(this.pageOptions).length > 0 &&
      x.variants.some((v) => Object.entries(this.pageOptions).every(([name, value]) => !value || v.options[name] === value)))?.value ?? preselected(cfg);
    const defaultOption = onPage && this.selectedVariant(onPage) ? onPage : firstAvailable;
    this.state = initialFlow({ leadMode: cfg.lead.mode, leadTiming: cfg.lead.timing ?? "before", defaultOption: cfg.swatches.length ? defaultOption : SINGLE });
    if (!cfg.available) this.state = reduce(this.state, { type: "PREVIEWS_UNAVAILABLE" }).state;
  }

  open() {
    if (this.root) return;
    this.syncPageConfiguration();
    this.lastFocus = document.activeElement;
    const root = document.createElement("div");
    root.className = "tryora";
    root.dataset.tryoraStyle = this.cfg.style.template;
    if (this.cfg.style.accent) root.style.setProperty("--t-accent", this.cfg.style.accent);
    if (this.cfg.style.useThemeFont) root.classList.add("tryora--theme-font");
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("change", (e) => this.onChange(e));
    root.addEventListener("input", (e) => this.onInput(e));
    root.addEventListener("keydown", (e) => this.onKey(e));
    document.body.appendChild(root);
    document.documentElement.classList.add("tryora-open");
    this.root = root;
    document.addEventListener("change", this.pageChangeHandler);
    if (this.cfg.providerId === "cloudlift") {
      window.addEventListener("option:changed", this.cloudliftChanged);
      window.addEventListener("options:rendered", this.pageChangeHandler);
    }
    // Some themes change the cart-form ID programmatically without a change event.
    this.pageWatchTimer = setInterval(this.pageChangeHandler, 750);
    this.render();
    (root.querySelector("[data-autofocus]") as HTMLElement | null)?.focus();
  }

  /** Closing keeps any running job and results; reopening on this page shows them again. */
  close() {
    if (!this.root) return;
    document.removeEventListener("change", this.pageChangeHandler);
    if (this.cfg.providerId === "cloudlift") {
      window.removeEventListener("option:changed", this.cloudliftChanged);
      window.removeEventListener("options:rendered", this.pageChangeHandler);
    }
    clearInterval(this.pageWatchTimer);
    this.pageWatchTimer = undefined;
    this.root.remove();
    this.root = null;
    document.documentElement.classList.remove("tryora-open");
    (this.lastFocus as HTMLElement | null)?.focus?.();
  }

  private dispatch(event: FlowEvent) {
    const { state, commands } = reduce(this.state, event);
    this.state = state;
    if (event.type !== "SELECT_OPTION") this.panel = this.panel === "swatches" ? "swatches" : "none";
    this.render();
    for (const c of commands) void this.run(c);
  }

  private async run(c: FlowCommand) {
    switch (c.type) {
      case "START_PHOTO_CHECK": {
        const photo = this.photos.get(c.photoId);
        if (!photo) return;
        try {
          const r = await post("check", { photo: photo.blob, visitor: visitorId(), product: this.cfg.productId });
          if (this.state.photo?.id !== c.photoId) return;
          this.dispatch({
            type: "PHOTO_CHECKED",
            check: r.ok ? { status: "ok", detected: r.detected } : { status: "needsCorrection", reason: r.reason },
          });
        } catch (e: any) {
          if (this.state.photo?.id !== c.photoId) return;
          if (e?.code === "RATE_LIMITED") {
            this.fileProblem = "We're very busy right now. Please try again in a few minutes.";
            return this.dispatch({ type: "REMOVE_PHOTO" });
          }
          this.fileProblem = "We couldn't check your photo. Please try uploading it again.";
          this.dispatch({ type: "REMOVE_PHOTO" });
        }
        return;
      }
      case "RELEASE_IMAGES": {
        const p = this.photos.get(c.photoId);
        if (p) URL.revokeObjectURL(p.url);
        this.photos.delete(c.photoId);
        for (const url of this.images.values()) URL.revokeObjectURL(url);
        this.images.clear();
        return;
      }
      case "SUBMIT_LEAD": {
        // Fire and forget: the preview never waits on saving the email.
        void post("lead", {
          email: this.email,
          firstName: this.firstName,
          marketing: this.marketing ? "1" : "0",
          wording: this.cfg.lead.optInWording,
          product: this.cfg.productId,
          option: this.state.selectedOption ?? "",
        }).catch(() => {});
        return;
      }
      case "CREATE_PREVIEW":
        return this.generate(c.option, c.photoId);
    }
  }

  private async generate(option: string, photoId: string) {
    this.configurationNotice = null;
    if (this.syncPageConfiguration()) { this.render(); return; }
    if (this.cfg.providerId === "cloudlift" && (this.cloudliftUnverifiedSelection ||
        (this.cloudliftExpectedNative && this.pageOptions[this.cloudliftExpectedNative.name] !== this.cloudliftExpectedNative.value))) {
      this.configurationNotice = "These Cloudlift options are not linked to a verified Shopify variant. Preview is unavailable for this configuration. No credit was used.";
      return this.dispatch({ type: "JOB_FAILED", reason: "generation_failed" });
    }
    const epoch = this.configurationEpoch;
    const photo = this.photos.get(photoId);
    if (!photo) return this.dispatch({ type: "JOB_FAILED", reason: "generation_failed" });
    const variant = this.selectedVariant(option);
    if ((this.cfg.swatches.length || this.cfg.singleVariants) && !variant) {
      this.configurationNotice = "This combination cannot be previewed. Choose another available option or review the product page. No credit was used.";
      return this.dispatch({ type: "JOB_FAILED", reason: "generation_failed" });
    }
    this.dispatch({ type: "JOB_STAGE", stage: "checking_photo" });
    let jobId: string;
    try {
      const fields = {
        photo: photo.blob,
        product: this.cfg.productId,
        option,
        variant: variant?.id ?? "",
        mappingRevision: this.cfg.mappingRevision ?? "",
        // The server rechecks this complete native tuple and rejects ambiguity.
        sourceVariant: ["manual_mapping", "cloudlift"].includes(this.cfg.providerId ?? "")
          ? nativeSourceVariantId(this.pageOptions, this.cfg.productVariants ?? []) ?? ""
          : "",
        visitor: visitorId(),
        key: crypto.randomUUID(),
        leadDone: leadSatisfied(this.state) ? "1" : "0",
      };
      const r = await createWithRetry(() => post("preview", fields));
      jobId = r.jobId;
    } catch (e: any) {
      if (epoch !== this.configurationEpoch) return;
      const code = e?.code;
      if (code === "BAD_REQUEST" || code === "NOT_FOUND") {
        this.configurationNotice = "This combination or its product reference is no longer available for preview. Choose another available option or review the product page. No credit was used.";
      }
      const reason =
        code === "QUOTA_PRODUCT" || code === "QUOTA_STORE" || code === "RATE_LIMITED"
          ? "quota_reached"
          : code === "CREDITS_EXHAUSTED" || code === "PLAN_INACTIVE" || code === "DAILY_CAP"
            ? "previews_paused"
            : "generation_failed";
      return this.dispatch({ type: "JOB_FAILED", reason });
    }
    if (epoch !== this.configurationEpoch || this.syncPageConfiguration()) { this.render(); return; }
    this.dispatch({ type: "JOB_STARTED", jobId });
    this.dispatch({ type: "JOB_STAGE", stage: "preparing" });

    const started = Date.now();
    let slow = false;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1200));
      if (epoch !== this.configurationEpoch || this.syncPageConfiguration()) { this.render(); return; }
      if (this.state.photo?.id !== photoId) return; // shopper changed room
      if (Date.now() - started > 10 * 60_000) return this.dispatch({ type: "JOB_FAILED", reason: "connection_lost" });
      let r: any;
      try {
        const res = await fetch(`${PROXY}/preview/${jobId}`, { credentials: "same-origin", signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error("Polling unavailable");
        r = await res.json();
      } catch {
        continue;
      }
      if (epoch !== this.configurationEpoch || this.syncPageConfiguration()) { this.render(); return; }
      if (r.stage === "generating" || r.stage === "checking_result") this.dispatch({ type: "JOB_STAGE", stage: r.stage });
      if (!slow && Date.now() - started > 45_000) {
        slow = true;
        this.dispatch({ type: "JOB_SLOW" });
      }
      if (r.stage === "failed" || r.stage === "expired") return this.dispatch({ type: "JOB_FAILED", reason: r.error === "RESULT_REJECTED" ? "result_rejected" : "generation_failed" });
      if (r.stage === "ready") {
        let url: string | undefined;
        try {
          const blob = await (await fetch(r.image)).blob();
          url = URL.createObjectURL(blob);
          await decodePreview(url);
        } catch {
          if (url) URL.revokeObjectURL(url);
          if (epoch !== this.configurationEpoch) return;
          return this.dispatch({ type: "JOB_FAILED", reason: "generation_failed" });
        }
        if (epoch !== this.configurationEpoch || this.syncPageConfiguration()) { URL.revokeObjectURL(url); this.render(); return; }
        this.images.set(jobId, url);
        this.dispatch({ type: "JOB_DELIVERED", result: { option, imageHandle: url, jobId } });
        // Only once the image is on screen is the credit used.
        void acknowledgeWithRetry(() => post("ack", { job: jobId, token: r.token }), r.expiresAt ?? Date.now() + 5 * 60_000);
        void tagBasket(this.cfg.productId);
        return;
      }
    }
  }

  // ---------- events ----------

  private onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el) {
      if (e.target === this.root?.querySelector(".tryora__backdrop")) this.close();
      return;
    }
    const act = el.dataset.act!;
    const s = this.state;
    switch (act) {
      case "close":
        return this.close();
      case "fabric": {
        if (s.generation) return;
        const fabric = el.dataset.value!;
        if (!this.cfg.swatches.some((x) => x.group === fabric)) return;
        this.fabric = fabric;
        const next = this.visibleSwatches().find((x) => this.selectedVariant(x.value));
        // Changing fabric cannot retain a colour from the previous fabric.
        this.state = { ...s, selectedOption: next?.value ?? null, notice: null };
        return this.render();
      }
      case "swatch": {
        const v = el.dataset.value!;
        if (s.generation) return;
        if (!this.visibleSwatches().some((x) => x.value === v)) return;
        if (!isViewed(s, v) && !this.selectedVariant(v)) return;
        if (s.step === "result" && isViewed(s, v)) return this.dispatch({ type: "SHOW_RESULT", option: v });
        if (s.step === "opening" || s.step === "photoReady") {
          // Tapping a viewed colour reopens its image instantly, free.
          if (s.photo && isViewed(s, v)) return this.dispatch({ type: "SHOW_RESULT", option: v });
        }
        this.dispatch({ type: "SELECT_OPTION", option: v });
        if (this.panel === "swatches" && isMobile()) this.panel = "none";
        return this.render();
      }
      case "more":
        this.panel = this.panel === "swatches" ? "none" : "swatches";
        return this.render();
      case "panel-close":
        this.panel = "none";
        return this.render();
      case "take":
        return (this.root!.querySelector("[data-file=camera]") as HTMLInputElement).click();
      case "upload":
        return (this.root!.querySelector("[data-file=upload]") as HTMLInputElement).click();
      case "change-photo":
        return (this.root!.querySelector("[data-file=upload]") as HTMLInputElement).click();
      case "generate":
        return this.dispatch({ type: "GENERATE_PRESSED" });
      case "lead-submit":
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email.trim())) {
          this.emailError = "Please enter a valid email address.";
          return this.render();
        }
        this.emailError = "";
        return this.dispatch({ type: "LEAD_SUBMITTED" });
      case "lead-skip":
        return this.dispatch({ type: "LEAD_SKIPPED" });
      case "another":
        return this.dispatch({ type: "TRY_ANOTHER_COLOUR" });
      case "new-room":
        return this.dispatch({ type: "USE_DIFFERENT_ROOM" });
      case "download":
        return this.download();
      case "issue":
        this.panel = "issue";
        this.issueSent = false;
        return this.render();
      case "issue-send": {
        const job = s.shownOption ? s.results[s.shownOption]?.jobId : undefined;
        if (job) void post("issue", { job, category: el.dataset.value! }).catch(() => {});
        this.issueSent = true;
        return this.render();
      }
      case "copy":
        void navigator.clipboard?.writeText(this.cfg.offer!.code).catch(() => {});
        this.copied = true;
        return this.render();
      case "apply":
        window.location.href = `/discount/${encodeURIComponent(this.cfg.offer!.code)}?redirect=${encodeURIComponent(location.pathname + location.search)}`;
        return;
    }
  }

  private async onChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.dataset.file) {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      const prepared = await preparePhoto(file);
      if ("problem" in prepared) {
        this.fileProblem = FILE_PROBLEMS[prepared.problem] ?? FILE_PROBLEMS.unreadable!;
        return this.render();
      }
      this.fileProblem = null;
      const id = crypto.randomUUID();
      this.photos.set(id, prepared);
      return this.dispatch({ type: "PHOTO_SELECTED", photoId: id });
    }
    if (input.name === "marketing") this.marketing = input.checked;
  }

  private onInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.name === "email") this.email = input.value;
    if (input.name === "firstName") this.firstName = input.value;
  }

  private onKey(e: KeyboardEvent) {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      const target = e.target as HTMLElement;
      const group = target.closest('[role="radiogroup"]');
      if (group) {
        const buttons = [...group.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)')];
        const index = buttons.indexOf(target.closest('button') as HTMLButtonElement);
        if (index >= 0 && buttons.length) {
          e.preventDefault();
          const nextIndex = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 :
            (index + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 1) + buttons.length) % buttons.length;
          const next = buttons[nextIndex]!;
          const value = next.dataset.value;
          next.click();
          if (value) this.root?.querySelector<HTMLElement>(`[data-act="swatch"][data-value="${CSS.escape(value)}"]`)?.focus();
          return;
        }
      }
    }
    if (e.key === "Escape") {
      if (this.panel !== "none") {
        this.panel = "none";
        return this.render();
      }
      return this.close();
    }
    if (e.key !== "Tab" || !this.root) return;
    const focusable = [...this.root.querySelectorAll<HTMLElement>("button, a[href], input, [tabindex='0']")].filter(
      (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
    );
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus();
      e.preventDefault();
    }
  }

  private download() {
    const s = this.state;
    const r = s.shownOption ? s.results[s.shownOption] : undefined;
    if (!r) return;
    const a = document.createElement("a");
    a.href = r.imageHandle;
    a.download = `${[this.cfg.product, this.optionLabel(r.option)].filter(Boolean).join(" - ")} - in my room.jpg`.replace(/[\\/:*?"<>|]/g, "");
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- rendering ----------

  private render() {
    if (!this.root) return;
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active?.dataset?.act ? `${active.dataset.act}:${active.dataset.value ?? ""}` : active?.getAttribute("name");
    this.root.innerHTML = this.view();
    if (focusKey) {
      const [act, value] = focusKey.split(":");
      const again =
        this.root.querySelector<HTMLElement>(`[data-act="${act}"]${value ? `[data-value="${CSS.escape(value)}"]` : ""}`) ??
        this.root.querySelector<HTMLElement>(`[name="${focusKey}"]`);
      again?.focus();
    }
  }

  private t(s: string) {
    return esc(s.replaceAll("{item}", this.cfg.itemNoun).replaceAll("{product}", this.cfg.product));
  }

  private view(): string {
    const s = this.state;
    const c = this.cfg;
    const headings: Record<string, string> = {
      opening: `See this {item} in your room`,
      photoReady: s.photo ? "Your photo is ready" : "Add your room photo",
      emailStep: "Your room photo is ready",
      generating: this.optionLabel(s.generation?.option) ? `Creating your ${this.optionLabel(s.generation?.option)} image` : "Creating your image",
      result: "Your room, with {product}",
      unavailable: "Previews are unavailable",
    };
    const heading = this.t(headings[s.step]!);
    return `
      <div class="tryora__backdrop"></div>
      <div class="tryora__dialog" role="dialog" aria-modal="true" aria-labelledby="tryora-h">
        <div class="tryora__top">
          <span class="tryora__brand">${esc(document.title.split(/[|–-]/).pop()?.trim() || "")}</span>
          <button class="tryora__x" data-act="close" aria-label="Close">×</button>
        </div>
        <h2 class="tryora__h" id="tryora-h">${heading}</h2>
        <div class="tryora__body">
          <div class="tryora__visual">${this.visual()}</div>
          <div class="tryora__side">${this.side()}</div>
        </div>
        ${this.panel === "swatches" ? this.swatchPanel() : ""}
        ${this.panel === "issue" ? this.issuePanel() : ""}
        <input type="file" accept="image/*" capture="environment" data-file="camera" hidden>
        <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" data-file="upload" hidden>
      </div>`;
  }

  private visual(): string {
    const s = this.state;
    const c = this.cfg;
    if (s.step === "result" && s.shownOption) {
      const r = s.results[s.shownOption]!;
      return `<img class="tryora__img" src="${r.imageHandle}" alt="${esc(`${c.product}${this.optionLabel(r.option) ? ` in ${this.optionLabel(r.option)}` : ""}, shown in your room`)}">
        ${c.mock ? `<span class="tryora__mock">Development preview (not AI)</span>` : ""}
        <p class="tryora__label"><strong>${esc(c.product)}</strong>${this.optionLabel(r.option) ? ` · ${esc(this.optionLabel(r.option))}` : ""}</p>
        <p class="tryora__small">AI-generated visualisation for illustration only. Colour, scale, positioning and product details may differ. Check dimensions and product information before ordering.</p>
        <p class="tryora__strong">Download before leaving this page.</p>`;
    }
    const photo = s.photo ? this.photos.get(s.photo.id) : undefined;
    if (photo) return `<img class="tryora__img" src="${photo.url}" alt="Your room photo">`;
    if (s.step === "photoReady") {
      return `<button class="tryora__drop" data-act="upload">
          <span class="tryora__cam" aria-hidden="true">${CAMERA}</span>
          <strong>Take or upload a room photo</strong>
          <span>Match the front-on product view.</span>
        </button>`;
    }
    // Show the photograph of the actual selected colour instead of the generic
    // featured product, which may be in a different colour.
    const selectedPhoto = this.selectedVariant(s.selectedOption ?? "")?.image ?? c.productImage;
    return selectedPhoto
      ? `<img class="tryora__img tryora__img--product" src="${esc(selectedPhoto)}" alt="${esc(c.product)}">`
      : "";
  }

  private side(): string {
    const s = this.state;
    const c = this.cfg;
    const noticeText = s.notice === "generation_failed" && this.configurationNotice ? this.configurationNotice : s.notice ? NOTICES[s.notice] : "";
    const notice = s.notice ? `<p class="tryora__notice" role="status">${esc(noticeText ?? "")}</p>` : "";
    switch (s.step) {
      case "opening":
        return `
          ${this.swatches()}
          <h3 class="tryora__h3">Match this front-on view</h3>
          <p class="tryora__small">${this.t("Face the {item} area. Keep your phone level and include the floor and full space.")}</p>
          ${this.fileProblem ? `<p class="tryora__notice" role="alert">${esc(this.fileProblem)}</p>` : ""}
          <button class="tryora__btn" data-act="take" data-autofocus>Take photo</button>
          <button class="tryora__btn tryora__btn--ghost" data-act="upload">Upload photo</button>
          ${this.privacy()}`;
      case "photoReady": {
        if (!s.photo) {
          return `${this.swatches()}
            ${this.fileProblem ? `<p class="tryora__notice" role="alert">${esc(this.fileProblem)}</p>` : ""}
            <button class="tryora__btn" data-act="take">Take photo</button>
            <button class="tryora__btn tryora__btn--ghost" data-act="upload">Upload photo</button>
            <p class="tryora__small">Your selected product options are kept. Your photo will be checked automatically.</p>`;
        }
        const check = s.photo.check;
        const status =
          check.status === "checking"
            ? `<p class="tryora__check"><span class="tryora__spin"></span> Checking photo…</p>`
            : check.status === "ok"
              ? `<p class="tryora__check"><span class="tryora__dot">${TICK}</span> Photo checked</p>`
              : "";
        const problem =
          check.status === "needsCorrection"
            ? `<p class="tryora__notice" role="alert">${esc(photoProblemMessage(check.reason as PhotoProblem, c.itemNoun, c.setting))}</p>`
            : "";
        const note = photoNote(check, c.itemNoun);
        const viewedHint = Object.keys(s.results).length
          ? `<p class="tryora__small">Tap a viewed option to open it instantly. Free to view again.</p>`
          : "";
        return `
          ${status}
          <button class="tryora__link" data-act="change-photo">Change photo</button>
          ${this.fileProblem ? `<p class="tryora__notice" role="alert">${esc(this.fileProblem)}</p>` : ""}
          ${problem}
          ${this.swatches()}
          ${viewedHint}
          ${notice}
          <button class="tryora__btn" data-act="generate" ${check.status === "ok" && s.selectedOption ? "" : "disabled"}>Generate image</button>
          ${note ? `<p class="tryora__note">${esc(note)}</p>` : ""}`;
      }
      case "emailStep":
        return `
          <h3 class="tryora__h3 tryora__h3--first">${
            s.leadTiming === "after" ? "Enter your email to create another image" : "Enter your email to create your preview"
          }</h3>
          <p class="tryora__label"><strong>${esc(c.product)}</strong>${this.optionLabel(s.selectedOption) ? ` · ${esc(this.optionLabel(s.selectedOption))}` : ""}</p>
          ${this.leadFields("Generate image")}`;
      case "generating": {
        const g = s.generation!;
        const order = ["waiting", ...STAGES.map((x) => x.key)];
        const at = order.indexOf(g.stage);
        const list = STAGES.map((st, i) => {
          const idx = i + 1;
          const cls = idx < at ? "done" : idx === at ? "now" : "todo";
          return `<li class="tryora__stage tryora__stage--${cls}">${cls === "done" ? `<span class="tryora__dot">${TICK}</span>` : `<span class="tryora__ring"></span>`} ${esc(st.label(this.optionLabel(g.option)))}</li>`;
        }).join("");
        return `
          <ol class="tryora__stages" aria-live="polite">${list}</ol>
          ${notice}
          ${this.swatches(true)}
          <p class="tryora__small">You can close this and reopen it on this page.</p>`;
      }
      case "result":
        return `
          ${
            c.swatches.length > 1
              ? `<button class="tryora__btn" data-act="another" data-autofocus>Try another option</button>
          <button class="tryora__btn tryora__btn--ghost" data-act="download">Download image</button>`
              : `<button class="tryora__btn" data-act="download" data-autofocus>Download image</button>`
          }
          <p class="tryora__links"><button class="tryora__link" data-act="new-room">Use a different room</button> | <button class="tryora__link" data-act="issue">Report an issue</button></p>
          ${notice}
          ${
            showLeadOnResult(s)
              ? `<div class="tryora__leadcard">
                  <h3 class="tryora__h3 tryora__h3--first">${
                    c.offer ? esc(c.offer.headline) : "Keep in touch"
                  }</h3>
                  <p class="tryora__small">${
                    c.offer ? "Enter your email to get your code." : "Enter your email for updates from this store."
                  }</p>
                  ${this.leadFields(c.offer ? "Get my code" : "Submit")}
                </div>`
              : ""
          }
          ${
            // With "after" + required, the offer is the reason to give an email, so it shows once they have.
            showLeadOnResult(s) && c.lead.mode === "required" ? "" : this.voucher()
          }`;
      case "unavailable":
        return `<p>${esc(NOTICES.previews_paused!)}</p><button class="tryora__btn" data-act="close">Close</button>`;
    }
  }

  /** Email, first name and the (always unticked) marketing box. Shared by the email step and the result-screen card. */
  private leadFields(submitLabel: string): string {
    const c = this.cfg;
    return `
      <label class="tryora__field"><span>Email address</span>
        <input name="email" type="email" autocomplete="email" value="${esc(this.email)}" ${this.state.step === "emailStep" ? "data-autofocus" : ""} ${this.emailError ? 'aria-invalid="true"' : ""}></label>
      ${this.emailError ? `<p class="tryora__notice" role="alert">${esc(this.emailError)}</p>` : ""}
      <label class="tryora__field"><span>First name (optional)</span>
        <input name="firstName" autocomplete="given-name" value="${esc(this.firstName)}"></label>
      ${
        c.lead.showOptIn
          ? `<label class="tryora__opt"><input type="checkbox" name="marketing" ${this.marketing ? "checked" : ""}> <span>${esc(c.lead.optInWording)}</span></label>`
          : ""
      }
      <button class="tryora__btn" data-act="lead-submit">${esc(submitLabel)}</button>
      ${c.lead.mode === "skippable" ? `<button class="tryora__link" data-act="lead-skip">${this.state.step === "result" ? "No thanks" : "Skip"}</button>` : ""}
      <p class="tryora__small">Your image is never emailed.</p>
      ${this.privacy()}`;
  }

  private privacy() {
    return `<a class="tryora__link" href="/policies/privacy-policy" target="_blank" rel="noopener">Privacy</a>`;
  }

  private voucher(): string {
    const o = this.cfg.offer;
    if (!o) return "";
    return `<div class="tryora__voucher">
      <strong>${esc(o.headline)}</strong>
      <span class="tryora__code">${esc(o.code)}</span>
      <div class="tryora__row">
        <button class="tryora__btn tryora__btn--ghost tryora__btn--sm" data-act="copy">${this.copied ? "Copied" : "Copy code"}</button>
        <button class="tryora__btn tryora__btn--ghost tryora__btn--sm" data-act="apply">Apply offer</button>
      </div>
      ${o.details ? `<p class="tryora__small">${esc(o.details)}</p>` : ""}
    </div>`;
  }

  private optionLabel(value: string | null | undefined): string {
    const swatch = this.cfg.swatches.find((x) => x.value === value);
    return swatch ? [swatch.group, swatch.label ?? swatch.value].filter(Boolean).join(" / ") : value && value !== SINGLE ? value : "";
  }

  private visibleSwatches(): Swatch[] {
    return this.cfg.fabricOptionName ? this.cfg.swatches.filter((x) => x.group === this.fabric) : this.cfg.swatches;
  }

  private fabricPicker(locked: boolean): string {
    if (!this.cfg.fabricOptionName) return "";
    const fabrics = [...new Set(this.cfg.swatches.map((x) => x.group).filter((v): v is string => !!v))];
    return '<p class="tryora__label">Choose fabric</p><div class="tryora__chips" role="group" aria-label="Fabric">' +
      fabrics.map((f) => '<button type="button" class="tryora__gchip" data-act="fabric" data-value="' + esc(f) +
        '" aria-pressed="' + (this.fabric === f) + '" ' + (locked ? 'disabled' : '') + '>' + esc(f) + '</button>').join("") + '</div>';
  }

  private swatches(locked = false): string {
    const c = this.cfg;
    if (!c.swatches.length) return "";
    const all = this.visibleSwatches();
    const mobile = isMobile();
    let shown = all;
    let more = 0;
    if (!mobile && all.length > COMPACT_DESKTOP) {
      shown = all.slice(0, COMPACT_DESKTOP - 1);
      const selected = all.find((x) => x.value === this.state.selectedOption);
      if (selected && !shown.includes(selected)) shown = [...shown.slice(0, -1), selected];
      more = all.length - shown.length;
    }
    const selected = this.optionLabel(this.state.selectedOption);
    return '<div class="tryora__sw"><p class="tryora__label"><strong>' + esc(c.product) + '</strong>' +
      (selected ? ' · ' + esc(selected) : '') + '</p>' + this.fabricPicker(locked) +
      '<p class="tryora__label">Choose ' + esc(c.selectorLabel ?? c.optionName ?? 'option') + '</p>' +
      '<div class="tryora__swrow ' + (mobile ? 'tryora__swrow--scroll' : '') + '" role="radiogroup" aria-label="' + esc(c.selectorLabel ?? c.optionName ?? 'Options') + '">' +
      shown.map((x) => this.swatch(x, locked)).join("") +
      (more ? '<button class="tryora__more" data-act="more" aria-label="Show all options">+' + more + '<br>more</button>' : '') + '</div>' +
      (mobile && all.length > 5 ? '<button class="tryora__link" data-act="more">All ' + all.length + ' options</button>' : '') +
      (this.cfg.fabricOptionName && !all.some((x) => this.selectedVariant(x.value)) ? '<p class="tryora__small" role="status">No supported colours for this fabric and the selected product options.</p>' : '') +
      (!this.cfg.fabricOptionName && /fabric/i.test(c.selectorLabel ?? c.optionName ?? '') ? '<p class="tryora__small">Colour samples are not available from the Shopify product options. The preview uses its product reference.</p>' : '') + '</div>';
  }

  private selectedVariant(value: string): VariantChoice | null {
    const swatch = this.cfg.swatches.find((x) => x.value === value);
    const candidates = swatch?.variants ?? (!this.cfg.swatches.length ? this.cfg.singleVariants ?? [] : []);
    const varying = this.cfg.selectionOptionNames ?? (this.cfg.optionName ? [this.cfg.optionName] : []);
    const matching = candidates.filter((v) =>
      Object.keys(v.options).every((name) => varying.includes(name) || !!this.pageOptions[name]) &&
      Object.entries(this.pageOptions).every(([name, selected]) =>
        varying.includes(name) || !selected || v.options[name] === selected));
    // Missing or ambiguous context must never change size, headboard or storage.
    return matching.length === 1 ? matching[0]! : null;
  }

  private swatch(x: Swatch, locked: boolean): string {
    const selected = this.state.selectedOption === x.value;
    const viewed = isViewed(this.state, x.value);
    const available = x.available && !!this.selectedVariant(x.value);
    const disabled = locked || (!available && !viewed);
    const label = x.label ?? x.value;
    const text = !x.image && !x.colour;
    return '<button type="button" class="tryora__s ' + (selected ? 'is-selected ' : '') + (!available ? 'is-soldout ' : '') + (text ? 'is-text' : '') +
      '" data-act="swatch" data-value="' + esc(x.value) + '" role="radio" aria-checked="' + selected + '" ' + (disabled ? 'disabled' : '') +
      ' aria-label="' + esc(this.optionLabel(x.value)) + (viewed ? ', viewed' : '') + (!available ? ', unavailable for selected options' : '') + '">' +
      '<span class="tryora__chip"' + (!x.image && x.colour ? ' style="background:' + esc(x.colour) + '"' : '') + '>' +
      (x.image ? '<img src="' + esc(x.image) + '" alt="' + esc(label) + '" loading="lazy">' : text ? esc(label) : '') + '</span>' +
      (text ? '' : '<span class="tryora__sname">' + esc(label) + '</span>') +
      (locked && !selected ? '<span class="tryora__lock" aria-hidden="true">' + LOCK + '</span>' : '') +
      (viewed ? '<span class="tryora__viewed">' + TICK + ' Viewed</span>' : !available ? '<span class="tryora__sold">Unavailable</span>' : '') + '</button>';
  }

  private swatchPanel(): string {
    const all = this.visibleSwatches();
    const locked = !!this.state.generation;
    return '<div class="tryora__panel ' + (isMobile() ? 'tryora__panel--sheet' : '') + '" role="dialog" aria-label="All options">' +
      '<div class="tryora__ptop"><strong>All options</strong><button class="tryora__x" data-act="panel-close" aria-label="Close options">×</button></div>' +
      this.fabricPicker(locked) + '<div class="tryora__grid" role="radiogroup" aria-label="' + esc(this.cfg.selectorLabel ?? this.cfg.optionName ?? 'Options') + '">' +
      all.map((x) => this.swatch(x, locked)).join("") + '</div></div>';
  }

  private issuePanel(): string {
    return `<div class="tryora__panel" role="dialog" aria-label="Report an issue">
      <div class="tryora__ptop"><strong>Report an issue</strong><button class="tryora__x" data-act="panel-close" aria-label="Close">×</button></div>
      ${
        this.issueSent
          ? `<p>Thanks – we'll look into it. If the image was wrong, the store isn't charged for it.</p>`
          : ISSUE_CATEGORIES.map(([k, label]) => `<button class="tryora__btn tryora__btn--ghost" data-act="issue-send" data-value="${k}">${esc(label)}</button>`).join("")
      }
    </div>`;
  }
}

const TICK = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>`;
const LOCK = `<svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 7V5a4 4 0 018 0v2h1v8H3V7zm2 0h4V5a2 2 0 00-4 0z" fill="currentColor"/></svg>`;
const CAMERA = `<svg viewBox="0 0 24 24" width="36" height="36"><path d="M4 7h3l2-3h6l2 3h3v13H4z M12 17a4 4 0 100-8 4 4 0 000 8z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;

/** Read the current Shopify product variant when the popup opens. This also
 * handles theme pickers that update the cart form after the initial page load. */
function productPageOptions(cfg: Config): Record<string, string> {
  const root = document.getElementById("tryora-root");
  let initial: Record<string, string> = {};
  try {
    const names: string[] = JSON.parse(root?.dataset.optionNames ?? "[]");
    const values: string[] = JSON.parse(root?.dataset.variantOptions ?? "[]");
    initial = Object.fromEntries(names.map((name, i) => [name, values[i] ?? ""]));
  } catch { /* Missing context is handled conservatively by selectedVariant. */ }
  const id = document.querySelector<HTMLInputElement>('form[action*="/cart/add"] [name="id"]')?.value;
  if (id) {
    const current = (cfg.productVariants ?? cfg.swatches.flatMap((swatch) => swatch.variants ?? []))
      .find((variant) => variant.id.split("/").pop() === id);
    if (current) return current.options;
    // An unknown live selection must not fall back to stale Liquid defaults.
    return { __unsupported_variant__: id };
  }
  return initial;
}

/** The colour the shopper already picked on the product page, if available. */
function preselected(cfg: Config): string | null {
  const v = cfg.optionName ? productPageOptions(cfg)[cfg.optionName] : undefined;
  return v && cfg.swatches.some((s) => s.value === v && s.available) ? v : null;
}

// ---------- launchers ----------

function buildLauncher(cfg: Config, type: "overlay" | "floating" | "inline", open: () => void): HTMLElement {
  const l = cfg.launcher;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `tryora-launch tryora-launch--${type} tryora-launch--${cfg.style.template}`;
  if (l.background === null) btn.classList.add("button"); // theme's own button styling
  else btn.style.cssText = `background:${l.background};color:${l.text ?? "#fff"};border-radius:${l.radiusPx}px`;
  if (type === "floating") btn.style[l.position === "bottom-left" ? "left" : "right"] = `${l.offsetPx.x}px`;
  btn.innerHTML = `${l.showIcon ? `<span aria-hidden="true">${CAMERA.replace(/36/g, "18")}</span>` : ""}<span>${esc(l.wording)}</span>`;
  btn.addEventListener("click", open);
  return btn;
}

/** The main (first) product photo, so the button sits on the photo shoppers see first. Selectors are tried in priority order. */
function mediaContainer(): HTMLElement | null {
  const selectors = [
    "[data-tryora-media]",
    ".product__media-item", // Dawn and most Shopify themes
    ".product-media-container",
    ".product-single__media",
    ".product-gallery__image",
    ".product__media",
    "media-gallery",
    ".product-media",
  ];
  for (const sel of selectors) {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.offsetHeight > 120);
    if (!el) continue;
    // Prefer the box that wraps the image itself, which can be narrower than its slot.
    const inner = [...el.querySelectorAll<HTMLElement>(".product-media-container, .product__media, .media")].find(
      (e) => e.offsetHeight > 120,
    );
    return inner ?? el;
  }
  return null;
}

function variantPicker(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    "[data-tryora-inline], variant-picker, variant-selects, variant-radios, .product-form__input, .product__variants",
  );
}

/** Places the merchant's preview launcher exactly as configured (inline, overlay or floating). */
function mountPreviewLauncher(cfg: Config, open: () => void): HTMLElement | null {
  const device = isMobile() ? "mobile" : "desktop";
  const { tryora } = launchersToRender(cfg.launcher, device);
  if (!tryora) return null;
  const slot = document.querySelector<HTMLElement>("[data-tryora-slot]");
  if (tryora === "inline" || slot) {
    const where = slot ?? variantPicker();
    if (where) {
      const btn = buildLauncher(cfg, "inline", open);
      slot ? slot.appendChild(btn) : where.insertAdjacentElement("afterend", btn);
      return btn;
    }
  }
  if (tryora === "overlay") {
    const media = mediaContainer();
    if (media) {
      if (getComputedStyle(media).position === "static") media.style.position = "relative";
      const btn = buildLauncher(cfg, "overlay", open);
      media.appendChild(btn);
      return btn;
    }
  }
  const btn = buildLauncher(cfg, "floating", open);
  document.body.appendChild(btn);
  return btn;
}

/** Product previews: only for products the server reports as enabled and ready. */
async function bootPreview(productId: string | undefined): Promise<{ open: () => void; launcher: HTMLElement | null } | null> {
  if (!productId) return null;
  let cfg: Config;
  try {
    const res = await fetch(`${PROXY}/config?product=${encodeURIComponent(productId)}`, { credentials: "same-origin" });
    const body = await res.json();
    if (body?.enabled !== true) return null;
    cfg = body as Config;
  } catch {
    return null;
  }

  let popup: Tryora | null = null;
  const open = () => {
    popup ??= new Tryora(cfg);
    popup.open();
  };
  (window as any).Tryora = { open };

  // The merchant's own buttons: link to #tryora or add data-tryora.
  document.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest('a[href="#tryora"], [data-tryora]');
    if (el && !el.classList.contains("tryora-launch")) {
      e.preventDefault();
      open();
    }
  });
  if (location.hash === "#tryora") open();
  return { open, launcher: mountPreviewLauncher(cfg, open) };
}

/** Keeps the assistant launcher clear of a floating preview launcher on the same side of the screen. */
export function arrangeLaunchers(preview: HTMLElement | null, assistant: HTMLElement) {
  if (!preview?.classList.contains("tryora-launch--floating")) return;
  const side = preview.style.left ? "bottom-left" : "bottom-right";
  if (!assistant.classList.contains(`tryora-assistant-launch--${side}`)) return;
  const height = preview.offsetHeight || 44;
  assistant.style.setProperty("--ta-stack", `${height + 12}px`);
  assistant.classList.add("tryora-assistant-launch--stacked");
}

/** Room assistant: independent of product previews, so it also works on home and collection pages. */
async function bootAssistant(root: HTMLElement, productId: string | undefined, preview: Promise<{ open: () => void; launcher: HTMLElement | null } | null>) {
  const config = await fetchAssistantConfig(root);
  if (!config?.enabled) return;
  // The preview config request runs in parallel; it only decides whether "Preview this product" is offered.
  const current = await preview.catch(() => null);
  let assistant: RoomAssistant | null = null;
  let launcher: HTMLElement | null = null;
  const openAssistant = () => {
    assistant ??= new RoomAssistant(config, {
      productId,
      openCurrentPreview: current?.open,
      launcher,
      currentVariantId: () => document.querySelector<HTMLInputElement>('form[action*="/cart/add"] [name="id"]')?.value ?? null,
    });
    assistant.open();
  };
  (window as any).TryoraAssistant = { open: openAssistant };
  document.addEventListener("click", (event) => {
    const element = (event.target as HTMLElement).closest('a[href="#tryora-assistant"], [data-tryora-assistant]');
    if (element && !element.classList.contains("tryora-assistant-launch")) {
      event.preventDefault();
      openAssistant();
    }
  });
  launcher = buildAssistantLauncher(config, openAssistant);
  document.body.appendChild(launcher);
  arrangeLaunchers(current?.launcher ?? null, launcher);
  // Continue an open conversation after the shopper navigates within this tab.
  if (location.hash === "#tryora-assistant" || (config.shop && wasOpen(config.shop))) openAssistant();
}

export async function boot() {
  const root = document.getElementById("tryora-root");
  if (!root) return;
  const productId = root.dataset.productId;
  // Each feature fails independently: an assistant outage never hides previews, and vice versa.
  const preview = bootPreview(productId);
  await Promise.all([preview.catch(() => null), bootAssistant(root, productId, preview).catch(() => {})]);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void boot());
else void boot();
