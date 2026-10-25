import { useEffect, useRef, useState } from "react";
import { hexToRgb } from "../customization/colour-values";
import { DEFAULT_SWATCH_PRESENTATION, emptyFabricDraft, type FabricDraft, type ManagedBinding, type ManagedColour, type ManagedFabric } from "../customization/fabric-manager";
import { referenceChoices, sampleChoices } from "../customization/media-roles";

type Media = { id: string; url: string; alt?: string | null };
export interface FabricManagerData {
  installationReady: boolean;
  /** Sidebar entry opens the merchant workspace, without saving a provider change. */
  startInManualMode?: boolean;
  /** Keep legacy reviewed variant editor out of the simple merchant setup. */
  advanced?: boolean;
  manualSetupReason?: string;
  products: { nodes: { id: string; title: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  selected: null | {
    productId: string; title: string; image: string | null; mode: "native" | "manual"; providerId: string; revision: string;
    draft: FabricDraft; importBlocked?: boolean; diagnostics: Record<string, string>; warning: string; sampleNotice?: string; legacyGallerySamples?: number; explicitlyOff: boolean;
    options: { name: string; optionValues: { name: string; swatch?: { color?: string; image?: { image?: { url: string } } } }[] }[];
    variants: { id: string; availableForSale: boolean; image?: { url: string } | null; selectedOptions: { name: string; value: string }[] }[];
    media: Media[]; native: { issue: string | null; optionName: string | null; fabricOptionName: string | null; selections: { value: string; label?: string; group: string | null; image: string | null; colour: string | null; available?: boolean }[] };
    syncedAt: string; saved: boolean;
  };
}
/** Render the same timestamp on the Railway server and in shoppers' browser timezones.
 * Localized dates during SSR cause React hydration errors 418/425. */
export function formatSyncedAtUtc(iso: string): string {
  const timestamp = new Date(iso);
  if (Number.isNaN(timestamp.getTime())) return "Time unavailable";
  return timestamp.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
const uid = () => crypto.randomUUID();
const HEX = /^#[0-9a-f]{6}$/i;
const MAPPINGS_PER_PAGE = 6;

type Tone = "success" | "attention" | "warning" | "neutral";
/** One merchant-facing readiness state per mapping; "ready" mirrors the server's publish rules and never relaxes them. */
interface Readiness { key: "ready" | "review" | "reference" | "variant" | "blocked"; label: string; hint: string; tone: Tone }

/** A real sample image, a merchant-entered HEX colour, or a labelled empty placeholder. Never a borrowed photo. */
function Thumb({ url, hex, label, empty, shape = "square", size = 48 }: { url?: string | null; hex?: string | null; label: string; empty: string; shape?: "round" | "square"; size?: number }) {
  const blank = !url && !hex;
  return <span className={`fm-thumb fm-thumb--${shape}${blank ? " is-empty" : ""}`} role="img" aria-label={blank ? `${label}: ${empty}` : label}
    style={{ width: size, height: size, background: !url && hex ? hex : undefined }}>
    {url ? <img src={url} alt="" /> : blank ? <span>{empty}</span> : null}
  </span>;
}

/** Upload, replace, choose or remove one image in its own role (fabric texture, colour sample or furniture reference). */
function MediaField({ label, role, value, media, change, upload, disabled, kind, sampleIds }: {
  label: string; role: string; value: string | null; media: Media[]; change: (id: string | null) => void;
  upload: (file: File, purpose: "sample" | "reference") => Promise<Media | null>; disabled: boolean;
  kind: "sample" | "reference"; sampleIds: ReadonlySet<string>;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState(false);
  const selected = media.find((m) => m.id === value);
  // Samples come only from images uploaded as samples; furniture photos never appear here, and samples never appear as references.
  const choices = kind === "sample" ? sampleChoices(media) : referenceChoices(media, sampleIds);
  return <div className={`fm-media fabric-media-field fabric-media-${kind}`}>
    <Thumb url={selected?.url} label={`Selected ${role}`} empty={`No ${role}`} size={72} />
    <div className="fm-media-body">
      <strong>{selected ? `${role[0]!.toUpperCase()}${role.slice(1)}` : `No ${role} yet`}</strong>
      {value && !selected && <p role="alert" className="fm-error">This image is no longer available in Shopify. Choose it again.</p>}
      <div className="fm-actions">
        <label className={`fm-btn${disabled || busy ? " is-disabled" : ""}`}>
          {busy ? "Uploading…" : selected ? "Replace image" : "Upload image"}
          <input className="fm-file" aria-label={`Upload ${label}`} type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled || busy} onChange={async (e) => {
            const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (!file) return;
            if (file.size > 8 * 1024 * 1024 || file.size === 0) { setError("Choose a JPG, PNG or WebP image under 8 MB."); return; }
            setBusy(true); setError(""); setDone(false);
            try { const image = await upload(file, kind); if (image) { change(image.id); setDone(true); } }
            catch (err) { setError(err instanceof Error ? err.message : "Image upload failed."); }
            finally { setBusy(false); }
          }} />
        </label>
        {selected && <button type="button" className="fm-link" disabled={disabled || busy} onClick={() => { change(null); setDone(false); }}>Remove</button>}
      </div>
      <p className="fm-muted">{kind === "sample" ? "Close-up photo of the real material. JPG, PNG or WebP, up to 8 MB." : "A complete photo of this exact configuration, used for AI previews."}</p>
      {choices.length > 0 && <details className="fm-choices fabric-existing-images">
        <summary>{kind === "sample" ? "Choose an uploaded sample" : "Choose a product photo"} ({choices.length})</summary>
        <div className="fm-choice-grid fabric-media-choices">{choices.slice(0, 48).map((m) =>
          <button key={m.id} type="button" disabled={disabled || busy} aria-label={`Use image ${m.id.split("/").pop()} as ${role}`} aria-pressed={m.id === value} onClick={() => change(m.id)}>
            <img src={m.url} alt="" loading="lazy" />
          </button>)}</div>
      </details>}
      {done && !error && <p role="status" className="fm-ok">Uploaded and selected.</p>}
      {error && <p role="alert" className="fm-error fabric-upload-error">{error}</p>}
    </div>
  </div>;
}

/** Inline two-step removal: the embedded admin cannot rely on window.confirm. */
function RemoveButton({ label, onConfirm, disabled }: { label: string; onConfirm: () => void; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button type="button" className="fm-link fm-danger" disabled={disabled} onClick={() => setAsking(true)}>{label}</button>;
  return <span className="fm-confirm" role="group" aria-label={label}>
    <span>Remove from Tryora? Shopify images and variants are kept.</span>
    <button type="button" className="fm-btn fm-btn--danger" onClick={() => { setAsking(false); onConfirm(); }}>Remove</button>
    <button type="button" className="fm-link" onClick={() => setAsking(false)}>Keep</button>
  </span>;
}

function workspaceMode(data: FabricManagerData): "native" | "manual" {
  return data.startInManualMode && data.installationReady && !data.selected?.importBlocked && data.selected
    ? "manual" : data.selected?.mode ?? "native";
}

/** A client-only draft shown for a new product. No Shopify configuration is written until Save. */
function workspaceDraft(data: FabricManagerData): FabricDraft {
  const draft = data.selected?.draft ?? emptyFabricDraft();
  if (!data.startInManualMode || !data.installationReady || data.selected?.importBlocked ||
      !data.selected || draft.fabrics.length) return draft;
  const productNumber = data.selected.productId.split("/").pop() ?? "first";
  return { ...draft, fabrics: [{
    id: `draft_${productNumber}`, name: "", description: "", enabled: true, textureMediaId: null, colours: [],
  }] };
}

export function FabricColourManager({ data, save, upload, selectProduct, error, busy = false }: {
  data: FabricManagerData; save: (mode: "native" | "manual", draft: FabricDraft) => void;
  upload: (file: File, purpose: "sample" | "reference") => Promise<Media | null>;
  /** Production uses the authenticated React Router transition, not a full iframe reload. */
  selectProduct?: (productId: string) => void;
  error?: string; busy?: boolean;
}) {
  const p = data.selected;
  const [mode, setMode] = useState<"native" | "manual">(() => workspaceMode(data)), [draft, setDraft] = useState<FabricDraft>(() => workspaceDraft(data));
  const [fabricId, setFabricId] = useState(() => workspaceDraft(data).fabrics[0]?.id ?? ""), [media, setMedia] = useState(p?.media ?? []);
  const [editingFabric, setEditingFabric] = useState(false);
  const [pendingProduct, setPendingProduct] = useState<string | null>(null);
  const [colourDraft, setColourDraft] = useState<(ManagedColour & { isNew: boolean }) | null>(null);
  const [mappingScope, setMappingScope] = useState<"fabric" | "all">("fabric"), [mappingPage, setMappingPage] = useState(0);
  // Ready mappings collapse to one summary line; anything incomplete, or opened by the merchant, shows its editor.
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const toggleRow = (id: string) => setOpenRows((rows) => { const next = new Set(rows); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const initial = useRef(JSON.stringify({ mode: p?.mode ?? "native", draft: p?.draft ?? emptyFabricDraft() }));
  const saving = useRef(false);
  useEffect(() => {
    const openedDraft = workspaceDraft(data);
    setMode(workspaceMode(data)); setDraft(openedDraft); setMedia(p?.media ?? []); setFabricId(openedDraft.fabrics[0]?.id ?? "");
    setColourDraft(null); setEditingFabric(false); setPendingProduct(null); saving.current = false;
    initial.current = JSON.stringify({ mode: p?.mode ?? "native", draft: p?.draft ?? emptyFabricDraft() });
  }, [p?.productId, p?.revision, data.startInManualMode, data.installationReady]);
  useEffect(() => { setMappingPage(0); setColourDraft(null); }, [fabricId]);
  const dirty = JSON.stringify({ mode, draft }) !== initial.current;
  const switchProduct = (next: string) => {
    if (!next || next === p?.productId) return;
    if (selectProduct && dirty) {
      // SPA navigation has no beforeunload event; confirm in the page before
      // discarding a merchant's unsaved fabric, colour or mapping edits.
      setPendingProduct(next);
      return;
    }
    if (selectProduct) selectProduct(next);
    else window.location.assign(`/app/fabrics?product=${encodeURIComponent(next)}`);
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { if (!saving.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const fabric = draft.fabrics.find((f) => f.id === fabricId);
  const swatchShape = draft.presentation?.shape ?? DEFAULT_SWATCH_PRESENTATION.shape;
  const swatchSize = draft.presentation?.size ?? DEFAULT_SWATCH_PRESENTATION.size;
  const sampleReady = (name: string, hex: string | null | undefined, image: string | null | undefined) =>
    !!name.trim() && (!!image || !!hex && HEX.test(hex));
  const updateSwatchPresentation = (patch: Partial<{ shape: "round" | "square"; size: number }>) =>
    setDraft((value) => ({ ...value, presentation: { shape: swatchShape, size: swatchSize, ...patch } }));
  const mediaUrl = (id: string | null) => media.find((m) => m.id === id)?.url;
  const sampleIds = new Set(draft.fabrics.flatMap((f) => [f.textureMediaId, ...f.colours.map((c) => c.swatchMediaId)]).filter((id): id is string => !!id));
  const manual = mode === "manual";
  const disabledUpload = !data.installationReady || !manual || !!p?.importBlocked;
  const updateFabric = (id: string, patch: Partial<ManagedFabric>) => setDraft((d) => {
    const previous = d.fabrics.find((f) => f.id === id)!;
    const renamedColours = new Set((patch.colours ?? []).filter((c) => previous.colours.find((x) => x.id === c.id)?.name !== c.name).map((c) => c.id));
    // Renaming a fabric or colour changes what shoppers see, so its exact mappings must be reviewed again.
    return { ...d, fabrics: d.fabrics.map((f) => f.id === id ? { ...f, ...patch } : f), bindings: d.bindings.map((b) => b.fabricId === id &&
      (patch.name !== undefined && patch.name !== previous.name || renamedColours.has(b.colourId)) ? { ...b, reviewed: false } : b) };
  });
  const updateBinding = (id: string, patch: Partial<ManagedBinding>) => setDraft((d) => ({ ...d, bindings: d.bindings.map((b) => b.id === id ? { ...b, ...patch, reviewed: patch.reviewed ?? false } : b) }));
  const uploadImage = async (file: File, purpose: "sample" | "reference") => { const m = await upload(file, purpose); if (m) setMedia((all) => [...all.filter((x) => x.id !== m.id), m]); return m; };
  const addFabric = () => { const id = uid(); setDraft((d) => ({ ...d, fabrics: [...d.fabrics, { id, name: "", description: "", enabled: true, textureMediaId: null, hex: null, colours: [] }] })); setFabricId(id); setEditingFabric(true); };
  const removeFabric = (id: string) => { setDraft((d) => ({ ...d, fabrics: d.fabrics.filter((x) => x.id !== id), bindings: d.bindings.filter((b) => b.fabricId !== id) })); setFabricId(draft.fabrics.find((x) => x.id !== id)?.id ?? ""); setEditingFabric(false); };
  const addMapping = (colourId?: string) => {
    const c = colourId ? fabric?.colours.find((x) => x.id === colourId) : fabric?.colours[0]; if (!fabric || !c) return;
    const binding: ManagedBinding = { id: uid(), fabricId: fabric.id, colourId: c.id, variantId: null, nativeOptions: {}, preserved: {}, externalValues: {}, referenceMediaIds: [], reviewed: false };
    setDraft((d) => ({ ...d, bindings: [...d.bindings, binding] }));
    const scopedCount = draft.bindings.filter((b) => mappingScope === "all" || b.fabricId === fabric.id).length + 1;
    setMappingPage(Math.floor((scopedCount - 1) / MAPPINGS_PER_PAGE));
    requestAnimationFrame(() => document.getElementById("fm-mapping")?.scrollIntoView({ block: "start" }));
  };
  const saveColour = () => {
    if (!fabric || !colourDraft || !sampleReady(colourDraft.name, colourDraft.hex, colourDraft.swatchMediaId)) return;
    const { isNew, ...colour } = colourDraft;
    updateFabric(fabric.id, { colours: isNew ? [...fabric.colours, colour] : fabric.colours.map((x) => x.id === colour.id ? colour : x) });
    setColourDraft(null);
  };

  /** Mirrors the server's publish checks so the badge never claims more than saving will accept. */
  const readiness = (b: ManagedBinding): Readiness => {
    const f = draft.fabrics.find((x) => x.id === b.fabricId), c = f?.colours.find((x) => x.id === b.colourId);
    const live = p?.variants.find((v) => v.id === b.variantId);
    if (!f?.enabled || !c?.enabled) return { key: "blocked", label: "Disabled", hint: "Turn this fabric and colour back on to preview it.", tone: "neutral" };
    if (Object.keys(b.externalValues).length) return { key: "blocked", label: "Saved only", hint: "External option values need an exact Shopify variant before they can be previewed.", tone: "neutral" };
    if (!b.variantId) return { key: "variant", label: "Colour requires mapping", hint: "Link the exact Shopify variant for this colour.", tone: "attention" };
    const exact = live && live.selectedOptions.length === Object.keys(b.nativeOptions).length && live.selectedOptions.every((o) => b.nativeOptions[o.name] === o.value);
    if (!exact) return { key: "variant", label: "Variant needs relinking", hint: "This Shopify variant changed or was removed. Select it again.", tone: "warning" };
    if (draft.bindings.filter((o) => o.variantId === b.variantId).length > 1) return { key: "variant", label: "Variant used twice", hint: "Each Shopify variant can belong to one colour only.", tone: "warning" };
    const references = b.referenceMediaIds.filter((id) => media.some((m) => m.id === id) && !sampleIds.has(id));
    if (!references.length) return { key: "reference", label: "Exact variant linked", hint: "Add a full furniture reference photo for this variant.", tone: "attention" };
    if (!b.reviewed) return { key: "review", label: "Furniture reference requires review", hint: "Confirm the photo shows this exact fabric, colour and configuration.", tone: "attention" };
    if (!live.availableForSale) return { key: "blocked", label: "Variant unavailable", hint: "Shopify reports this variant unavailable for sale.", tone: "warning" };
    if (p?.warning) return { key: "blocked", label: "Mapping needs attention", hint: p.warning, tone: "warning" };
    return { key: "ready", label: "Ready for AI preview", hint: "", tone: "success" };
  };
  const colourStatus = (f: ManagedFabric, c: ManagedColour): { label: string; tone: Tone } => {
    if (!c.enabled) return { label: "Disabled", tone: "neutral" };
    const states = draft.bindings.filter((b) => b.fabricId === f.id && b.colourId === c.id).map(readiness);
    if (states.some((s) => s.key === "ready")) return { label: "Ready for AI preview", tone: "success" };
    if (states.length) return { label: states[0]!.label, tone: states[0]!.tone };
    return c.swatchMediaId ? { label: "Sample added", tone: "neutral" } : { label: "Needs sample", tone: "neutral" };
  };
  const ready = draft.bindings.filter((b) => readiness(b).key === "ready").length;
  const invalidSamples = draft.fabrics.some((f) =>
    !sampleReady(f.name, f.hex, f.textureMediaId) ||
    f.colours.some((c) => !sampleReady(c.name, c.hex, c.swatchMediaId)));
  const saveBlocked = !data.installationReady || manual && (!!p?.importBlocked || invalidSamples || !!colourDraft);
  const saveHint = !manual || !data.installationReady ? "" : p?.importBlocked ? "This product's existing integration must be reviewed before editing." :
    colourDraft ? "Save or cancel the colour you're editing first." : invalidSamples ? "Each fabric and colour needs a name plus a HEX colour or sample image before saving." : "";
  const workspaceQuery = data.startInManualMode ? "&workspace=manual" : "";
  const link = p ? `/app/fabrics?product=${encodeURIComponent(p.productId)}${workspaceQuery}` : data.startInManualMode ? "/app/fabrics?workspace=manual" : "/app/fabrics";
  const scoped = draft.bindings.filter((b) => mappingScope === "all" || b.fabricId === fabricId);
  const pageCount = Math.max(1, Math.ceil(scoped.length / MAPPINGS_PER_PAGE));
  const currentPage = Math.min(mappingPage, pageCount - 1);
  const steps = [
    { label: "Fabric & texture", done: draft.fabrics.some((f) => sampleReady(f.name, f.hex, f.textureMediaId)) },
    { label: "Colours & samples", done: draft.fabrics.some((f) => f.colours.some((c) => sampleReady(c.name, c.hex, c.swatchMediaId))) },
    { label: "Saved", done: !dirty && !!p?.revision },
  ];

  return <s-page heading="Fabrics & Colours" inlineSize="large">
    <style>{STYLES}</style>
    <div className="fabric-manager">
      <header className="fm-card fm-header">
        <div className="fm-product">
          {p?.image ? <img className="fm-product-image" src={p.image} alt="" width={56} height={56} /> : <span className="fm-product-image fm-thumb is-empty"><span>No photo</span></span>}
          <label className="fm-field fm-grow"><span className="fm-label">Product</span>
            <select aria-label="Shopify product" value={p?.productId ?? ""} onChange={(e) => switchProduct(e.currentTarget.value)}>
              <option value="">Select a Shopify product</option>{p && !data.products.nodes.some((x) => x.id === p.productId) && <option value={p.productId}>{p.title}</option>}
              {data.products.nodes.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
          {p && <label className="fm-field"><span className="fm-label">Setup mode</span>
            <select aria-label="Configuration mode" value={mode} onChange={(e) => setMode(e.currentTarget.value as "native" | "manual")}>
              <option value="native">Shopify Native - Automatic</option><option value="manual" disabled={!data.installationReady}>Manual Setup - Merchant Managed{data.installationReady ? "" : " (not enabled)"}</option>
            </select>
          </label>}
          {p && <div className="fm-save">
            <span className={`fm-pill fm-pill--${dirty || colourDraft ? "attention" : "success"}`} role="status">{colourDraft ? "Editing a colour" : dirty ? "Unsaved changes" : p.saved ? "Saved" : "No unsaved changes"}</span>
            <button className="fm-btn fm-btn--primary" type="button" disabled={busy || saveBlocked} onClick={() => { saving.current = true; save(mode, manual ? { ...draft, presentation: draft.presentation ?? DEFAULT_SWATCH_PRESENTATION } : draft); }}>{busy ? "Saving…" : "Save changes"}</button>
          </div>}
        </div>
        {p && <div className="fm-subhead">
          <span className="fm-muted">{p.title} · <s-link href={`/app/products/${p.productId.split("/").pop()}`}>Product preview settings</s-link></span>
          {manual && <ol className="fm-steps" aria-label="Setup progress">{steps.map((s) => <li key={s.label} className={s.done ? "is-done" : ""}><span aria-hidden="true">{s.done ? "✓" : ""}</span>{s.label}{s.done ? <span className="fm-sr"> (done)</span> : null}</li>)}</ol>}
          {manual && <span className="fm-muted fm-tabular fm-ready-count">{ready} preview-ready colour configurations</span>}
        </div>}
        {saveHint && <p className="fm-muted fm-save-hint" role="status">{saveHint}</p>}
        {pendingProduct && <div className="fm-navigation-confirm" role="alert">
          <p>You have unsaved fabric or colour changes. Switch products without saving them?</p>
          <div className="fm-actions">
            <button type="button" className="fm-btn fm-btn--primary" onClick={() => { if (!pendingProduct) return; const next = pendingProduct; setPendingProduct(null); selectProduct?.(next); }}>Discard changes and switch</button>
            <button type="button" className="fm-btn" onClick={() => setPendingProduct(null)}>Keep editing</button>
          </div>
        </div>}
        {p && <s-link href={`/app/fabrics?browse=1${workspaceQuery}`}>Browse more products</s-link>}
        {!p && data.products.pageInfo.hasNextPage && <s-link href={`/app/fabrics?browse=1&after=${encodeURIComponent(data.products.pageInfo.endCursor ?? "")}${workspaceQuery}`}>Next 25 products</s-link>}
      </header>
      {!p && <section className="fm-card fm-empty"><h2>Choose a product to start</h2><p className="fm-muted">Pick a Shopify product above to manage its fabrics, colours and AI preview references.</p></section>}
      {p && <>
        {error && <s-banner heading="Configuration needs review" tone="critical"><p role="alert">{error}</p></s-banner>}
        {p.saved && !error && !dirty && <s-banner heading="Configuration saved" tone="success"><p role="status">Mode and product mappings saved. Unreviewed combinations stay blocked from AI previews.</p></s-banner>}
        {p.explicitlyOff && <s-banner heading="Product previews are OFF" tone="warning"><p>Saving fabrics or switching mode does not turn this product on. Review Product preview settings when ready.</p></s-banner>}
        {!data.installationReady && <s-banner heading="Manual setup is not enabled" tone="info"><p>{data.manualSetupReason || "Your app administrator needs to authorize merchant-managed customization for this installation. Shopify-native previews continue to work."}</p></s-banner>}
        {p.warning && <s-banner heading="Saved mapping needs attention" tone="warning"><p>{p.warning}</p></s-banner>}
        {p.sampleNotice && <s-banner heading="Some samples need real sample images" tone="warning"><p>{p.sampleNotice}</p></s-banner>}
        {!!p.legacyGallerySamples && <s-banner heading="Older fabric samples are still in the product gallery" tone="warning">
          <p>{p.legacyGallerySamples} previously uploaded sample image(s) are attached to this Shopify product. New sample uploads use Shopify Files and will not be added to the product gallery. Review existing samples and remove their product-media copies only after confirming any saved references are updated; Tryora does not delete product images automatically.</p>
        </s-banner>}
        {p.providerId === "cloudlift" && <p className="fm-muted">Existing reviewed Cloudlift native-linked mapping is preserved under Manual Setup. Saving does not create an automatic third-party integration.</p>}

        {!manual ? <section className="fm-card" aria-labelledby="fm-native-title">
          <div className="fm-section-head"><div><h2 id="fm-native-title">Shopify options</h2><p className="fm-muted">Fabrics and colours come from this product's Shopify options. Last synced <time dateTime={p.syncedAt}>{formatSyncedAtUtc(p.syncedAt)}</time>.</p></div><s-button href={link}>Refresh from Shopify</s-button></div>
          {p.native.issue && <s-banner heading="Preview option mapping needs review" tone="warning"><p>{p.native.issue}. Review Product preview settings; no other option is chosen automatically.</p></s-banner>}
          {!p.native.selections.length ? <p className="fm-muted">No native fabric or colour choices were found for this product's preview option.</p>
            : <ul className="fm-native-grid">{p.native.selections.map((s) => <li key={s.value} className="fm-native">
              <Thumb url={s.image} hex={s.colour} label={`${[s.group, s.label ?? s.value].filter(Boolean).join(" ")} sample`} empty="No swatch" shape="round" size={44} />
              <div><strong>{[s.group, s.label ?? s.value].filter(Boolean).join(" / ")}</strong>
                <span className="fm-muted">{s.image ? "Actual Shopify swatch image" : s.colour ? "Shopify colour value" : "Text label - no swatch supplied by Shopify"}</span></div>
              <span className={`fm-pill fm-pill--${s.available ? "success" : "neutral"}`}>{s.available ? "Available" : "Not for sale"}</span>
            </li>)}</ul>}
          <details className="fm-details"><summary>Inspect {p.variants.length} exact Shopify variants</summary><ul className="fm-variant-list">{p.variants.map((v) => <li key={v.id}>
            <span>{v.selectedOptions.map((o) => `${o.name}: ${o.value}`).join(" / ")}</span><span className="fm-muted">{v.availableForSale ? "Available" : "Unavailable"} · {v.id.split("/").pop()}</span></li>)}</ul></details>
        </section> : <fieldset disabled={!data.installationReady} className="fabric-manager-fields">
          <legend className="fm-sr">Manual fabric and colour setup</legend>
          <div className="fabric-workspace fm-workspace">
            <aside className="fm-card fm-fabrics" aria-labelledby="fm-fabrics-title">
              <div className="fm-section-head"><h2 id="fm-fabrics-title">Fabrics <span className="fm-count">{draft.fabrics.length}</span></h2></div>
              <button className="fm-btn fm-btn--primary fm-add" type="button" disabled={!data.installationReady || !!p.importBlocked} onClick={addFabric}>+ Add fabric</button>
              <div className="fabric-list fm-fabric-list" role="list">{draft.fabrics.map((f) => {
                const draftItem = !f.name.trim();
                return <button role="listitem" className="fabric-list-item fm-fabric-item" type="button" key={f.id} aria-pressed={f.id === fabricId} onClick={() => { if (f.id !== fabricId) { setFabricId(f.id); setEditingFabric(draftItem); } }}>
                  <Thumb url={mediaUrl(f.textureMediaId)} hex={f.hex && HEX.test(f.hex) ? f.hex : null} label={`${f.name || "Untitled fabric"} texture`} empty="No texture" size={44} />
                  <span className="fm-fabric-text"><strong>{draftItem ? "Untitled fabric" : f.name}</strong>
                    <small>{f.colours.length} {f.colours.length === 1 ? "colour" : "colours"}{f.enabled ? "" : " · Disabled"}</small></span>
                  {draftItem && <span className="fm-pill fm-pill--attention">Draft</span>}
                </button>;
              })}</div>
              {!draft.fabrics.length && <p className="fm-muted">No fabrics yet. Add the first fabric this product is sold in.</p>}
            </aside>

            <section className="fm-card fm-detail" aria-label="Selected fabric">
              {!fabric ? <div className="fm-empty"><h2>Add a fabric to begin</h2><p className="fm-muted">Each fabric holds its own colours and samples, such as Plush Velvet with Cream, Grey and Navy.</p></div> : <>
                <div className="fm-fabric-head">
                  <Thumb url={mediaUrl(fabric.textureMediaId)} hex={fabric.hex && HEX.test(fabric.hex) ? fabric.hex : null} label={`${fabric.name || "Untitled fabric"} texture`} empty="No texture" size={64} />
                  <div className="fm-grow"><h2>{fabric.name || "Untitled fabric"}</h2>
                    <p className="fm-muted">{fabric.description || (fabric.textureMediaId ? "Fabric texture added." : "Upload a close-up of this fabric's texture.")}</p></div>
                  {!fabric.enabled && <span className="fm-pill fm-pill--neutral">Disabled</span>}
                  <button type="button" className="fm-btn" aria-expanded={editingFabric} onClick={() => setEditingFabric(!editingFabric)}>{editingFabric ? "Close editor" : "Edit fabric"}</button>
                </div>
                {editingFabric && <div className="fm-editor fabric-editor" role="group" aria-label="Edit fabric">
                  <div className="fm-editor-grid">
                    <label className="fm-field"><span className="fm-label">Fabric name</span><input aria-label={`Fabric name ${fabric.id}`} maxLength={140} value={fabric.name} placeholder="e.g. Plush Velvet" autoFocus={!fabric.name}
                      aria-invalid={!fabric.name.trim()} onChange={(e) => updateFabric(fabric.id, { name: e.currentTarget.value })} /></label>
                    <label className="fm-field"><span className="fm-label">Description <span className="fm-muted">(optional)</span></span><textarea rows={2} maxLength={1000} value={fabric.description} onChange={(e) => updateFabric(fabric.id, { description: e.currentTarget.value })} /></label>
                  </div>
                  <div className="fm-field"><span className="fm-label">Fabric HEX colour <span className="fm-muted">(or add a texture image)</span></span>
                    <div className="fm-hex">
                      <input type="color" aria-label={`Pick fabric colour ${fabric.id}`} value={HEX.test(fabric.hex ?? "") ? fabric.hex! : "#ffffff"}
                        onChange={(e) => updateFabric(fabric.id, { hex: e.currentTarget.value })} />
                      <input aria-label={`Fabric HEX ${fabric.id}`} placeholder="#RRGGBB" maxLength={7}
                        value={fabric.hex ?? ""} aria-invalid={!!fabric.hex && !HEX.test(fabric.hex)}
                        onChange={(e) => updateFabric(fabric.id, { hex: e.currentTarget.value.trim() || null })} />
                      {fabric.hex && <button type="button" className="fm-link" onClick={() => updateFabric(fabric.id, { hex: null })}>Clear</button>}
                    </div>
                  </div>
                  <MediaField label={`Fabric texture ${fabric.name}`} role="fabric texture" kind="sample" sampleIds={sampleIds} value={fabric.textureMediaId} media={media} change={(id) => updateFabric(fabric.id, { textureMediaId: id })} upload={uploadImage} disabled={disabledUpload} />
                  {!sampleReady(fabric.name, fabric.hex, fabric.textureMediaId) && <p className="fm-muted" role="status">Fabric name and either HEX colour or texture image are required.</p>
                  <div className="fm-editor-foot">
                    <label className="fm-check"><input type="checkbox" checked={fabric.enabled} onChange={(e) => updateFabric(fabric.id, { enabled: e.currentTarget.checked })} />Show this fabric to shoppers</label>
                    <RemoveButton label="Remove fabric" onConfirm={() => removeFabric(fabric.id)} />
                    <span className="fm-grow" />
                    <button type="button" className="fm-btn" onClick={() => setEditingFabric(false)}>Done</button>
                  </div>
                </div>}

                <div className="fm-section-head fm-colours-head"><h3>Colours <span className="fm-count">{fabric.colours.length}</span></h3>
                  <div className="fm-swatch-prefs" role="group" aria-label="Swatch appearance">
                    <span className="fm-label">Swatch shape</span>
                    <button type="button" className="fm-btn fm-shape" aria-label="Circle swatches" aria-pressed={swatchShape === "round"} onClick={() => updateSwatchPresentation({ shape: "round" })}><span className="fm-shape-circle" /></button>
                    <button type="button" className="fm-btn fm-shape" aria-label="Square swatches" aria-pressed={swatchShape === "square"} onClick={() => updateSwatchPresentation({ shape: "square" })}><span className="fm-shape-square" /></button>
                    <label className="fm-swatch-size">Swatch size
                      <input aria-label="Swatch size" type="number" min={25} max={100} step={1} value={swatchSize}
                        onChange={(e) => { const n = Number(e.currentTarget.value); if (Number.isInteger(n) && n >= 25 && n <= 100) updateSwatchPresentation({ size: n }); }} />
                      <span>px</span>
                    </label>
                  </div>
                  <button className="fm-btn" type="button" disabled={!!colourDraft} onClick={() => setColourDraft({ id: uid(), name: "", enabled: true, swatchMediaId: null, hex: null, isNew: true })}>+ Add colour</button></div>
                {fabric.colours.length ? <ul className="fm-colour-grid">{fabric.colours.map((c) => {
                  const status = colourStatus(fabric, c);
                  return <li key={c.id}><button type="button" className={`fm-colour${colourDraft?.id === c.id ? " is-editing" : ""}${c.enabled ? "" : " is-off"}`} aria-label={`Edit colour ${c.name}`} onClick={() => setColourDraft({ ...c, isNew: false })}>
                    <Thumb url={mediaUrl(c.swatchMediaId)} hex={HEX.test(c.hex ?? "") ? c.hex : null} label={`${fabric.name} ${c.name} sample`} empty="No sample" shape={swatchShape} size={swatchSize} />
                    <span className="fm-colour-text"><strong>{c.name}</strong><small className="fm-tabular">{c.swatchMediaId ? "Sample photo" : c.hex ? c.hex.toUpperCase() : "No sample yet"}</small></span>
                    <span className={`fm-pill fm-pill--${status.tone}`}>{status.label}</span>
                  </button></li>;
                })}</ul> : !colourDraft && <p className="fm-muted">No colours for {fabric.name || "this fabric"} yet. Each colour needs a name and HEX colour or sample photo.</p>}

                {colourDraft && <div className="fm-editor fm-colour-editor" role="group" aria-label={colourDraft.isNew ? "New colour" : `Edit ${colourDraft.name}`}>
                  <h3>{colourDraft.isNew ? `New colour for ${fabric.name || "this fabric"}` : `Edit ${colourDraft.name || "colour"}`}</h3>
                  <div className="fm-editor-grid">
                    <label className="fm-field"><span className="fm-label">Colour name</span><input aria-label={`Colour name ${colourDraft.id}`} maxLength={140} value={colourDraft.name} placeholder="e.g. Cream" autoFocus
                      onChange={(e) => setColourDraft({ ...colourDraft, name: e.currentTarget.value })} /></label>
                    <div className="fm-field"><span className="fm-label">HEX colour <span className="fm-muted">(optional)</span></span>
                      <div className="fm-hex">
                        <input type="color" aria-label={`Pick colour ${colourDraft.id}`} value={HEX.test(colourDraft.hex ?? "") ? colourDraft.hex! : "#ffffff"} onChange={(e) => setColourDraft({ ...colourDraft, hex: e.currentTarget.value })} />
                        <input aria-label={`HEX ${colourDraft.id}`} placeholder="#RRGGBB" maxLength={7} value={colourDraft.hex ?? ""} aria-invalid={!!colourDraft.hex && !HEX.test(colourDraft.hex)}
                          onChange={(e) => setColourDraft({ ...colourDraft, hex: e.currentTarget.value.trim() || null })} />
                        {colourDraft.hex && <button type="button" className="fm-link" onClick={() => setColourDraft({ ...colourDraft, hex: null })}>Clear</button>}
                      </div>
                      <span className="fm-muted fm-tabular fm-rgb" aria-live="polite">{colourDraft.hex && HEX.test(colourDraft.hex) ? `RGB ${hexToRgb(colourDraft.hex)}` : colourDraft.hex ? "" : "Provide a HEX colour or sample photo. Both are allowed."}</span>
                      {colourDraft.hex && !HEX.test(colourDraft.hex) && <span role="alert" className="fm-error">Use the #RRGGBB format, for example #F2E8D5.</span>}
                    </div>
                  </div>
                  <MediaField label={`Colour sample ${fabric.name} ${colourDraft.name}`} role="colour sample" kind="sample" sampleIds={sampleIds} value={colourDraft.swatchMediaId} media={media}
                    change={(id) => setColourDraft((c) => c && { ...c, swatchMediaId: id })} upload={uploadImage} disabled={disabledUpload} />
                  <div className="fm-editor-foot">
                    <label className="fm-check"><input type="checkbox" checked={colourDraft.enabled} onChange={(e) => setColourDraft({ ...colourDraft, enabled: e.currentTarget.checked })} />Show this colour to shoppers</label>
                    {!colourDraft.isNew && <RemoveButton label="Remove colour" onConfirm={() => { const id = colourDraft.id; updateFabric(fabric.id, { colours: fabric.colours.filter((x) => x.id !== id) }); setDraft((d) => ({ ...d, bindings: d.bindings.filter((b) => b.colourId !== id) })); setColourDraft(null); }} />}
                    <span className="fm-grow" />
                    <button type="button" className="fm-btn" onClick={() => setColourDraft(null)}>Cancel</button>
                    <button type="button" className="fm-btn fm-btn--primary" disabled={!sampleReady(colourDraft.name, colourDraft.hex, colourDraft.swatchMediaId)} onClick={saveColour}>Save colour</button>
                  </div>
                </div>}
              </>}
            </section>
          </div>

          {data.advanced && <details open className="fm-advanced-setup">
            <summary>Advanced AI preview setup</summary>
          <section id="fm-mapping" className="fm-card fabric-mapping" aria-labelledby="fm-mapping-title">
            <div className="fm-section-head"><div><h2 id="fm-mapping-title">Variants & AI preview readiness</h2>
              <p className="fm-muted">Link each colour to its exact Shopify variant and a full furniture photo. Only reviewed, exact mappings can create AI previews.</p></div>
              <button className="fm-btn" type="button" disabled={!fabric?.colours.length} onClick={() => addMapping()}>+ Add mapping</button></div>
            <div className="fm-scope" role="group" aria-label="Show mappings for">
              <button type="button" aria-pressed={mappingScope === "fabric"} onClick={() => { setMappingScope("fabric"); setMappingPage(0); }}>{fabric?.name || "This fabric"} ({draft.bindings.filter((b) => b.fabricId === fabricId).length})</button>
              <button type="button" aria-pressed={mappingScope === "all"} onClick={() => { setMappingScope("all"); setMappingPage(0); }}>All fabrics ({draft.bindings.length})</button>
            </div>
            {!scoped.length ? <p className="fm-muted">No mappings yet. Add one for each colour and configuration you sell.</p> : <ul className="fm-map-list">{scoped.slice(currentPage * MAPPINGS_PER_PAGE, (currentPage + 1) * MAPPINGS_PER_PAGE).map((b) => {
              const f = draft.fabrics.find((x) => x.id === b.fabricId)!, c = f.colours.find((x) => x.id === b.colourId)!, state = readiness(b);
              const expanded = state.key !== "ready" || openRows.has(b.id);
              const live = p.variants.find((v) => v.id === b.variantId);
              return <li key={b.id} className={`fm-map-row${expanded ? " is-open" : ""}`} data-state={state.key}>
                <div className="fm-map-head">
                  <Thumb url={mediaUrl(c.swatchMediaId)} hex={HEX.test(c.hex ?? "") ? c.hex : null} label={`${f.name} ${c.name} sample`} empty="No sample" shape="round" size={36} />
                  <span className="fm-map-title"><strong>{f.name || "Untitled fabric"} / {c.name}</strong>
                    {!expanded && live && <small className="fm-muted">{live.selectedOptions.map((o) => o.value).join(" · ")}</small>}</span>
                  {!expanded && <Thumb url={mediaUrl(b.referenceMediaIds[0] ?? null)} label="Full furniture reference" empty="No photo" size={36} />}
                  <span className={`fm-pill fm-pill--${state.tone} fm-map-status`}>{state.label}</span>
                  {state.key === "ready" && <button type="button" className="fm-link" aria-expanded={expanded} onClick={() => toggleRow(b.id)}>{expanded ? "Close" : "Edit"}</button>}
                </div>
                {expanded && <>
                {state.hint && <p className="fm-muted fm-map-hint">{state.hint}</p>}
                <div className="fm-map-grid">
                  <label className="fm-field"><span className="fm-label">Fabric</span><select aria-label={`Fabric for mapping ${b.id}`} value={b.fabricId} onChange={(e) => { const target = draft.fabrics.find((x) => x.id === e.currentTarget.value); if (target?.colours[0]) updateBinding(b.id, { fabricId: target.id, colourId: target.colours[0].id, variantId: null, nativeOptions: {}, referenceMediaIds: [] }); }}>
                    {draft.fabrics.map((x) => <option key={x.id} value={x.id} disabled={!x.colours.length}>{x.name || "Untitled fabric"}</option>)}</select></label>
                  <label className="fm-field"><span className="fm-label">Colour</span><select aria-label={`Colour for mapping ${b.id}`} value={b.colourId} onChange={(e) => updateBinding(b.id, { colourId: e.currentTarget.value, variantId: null, nativeOptions: {}, referenceMediaIds: [] })}>
                    {f.colours.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
                  <label className="fm-field"><span className="fm-label">Exact Shopify variant</span><select aria-label={`Variant ${b.id}`} value={b.variantId ?? ""} onChange={(e) => { const v = p.variants.find((v) => v.id === e.currentTarget.value); updateBinding(b.id, { variantId: v?.id ?? null, nativeOptions: Object.fromEntries(v?.selectedOptions.map((o) => [o.name, o.value]) ?? []) }); }}>
                    <option value="">Not linked - preview blocked</option>{b.variantId && !p.variants.some((v) => v.id === b.variantId) && <option value={b.variantId}>Stale variant - select again</option>}
                    {p.variants.map((v) => <option key={v.id} value={v.id}>{v.selectedOptions.map((o) => `${o.name}: ${o.value}`).join(" / ")} - {v.id.split("/").pop()}{v.availableForSale ? "" : " (unavailable)"}</option>)}
                  </select></label>
                </div>
                <details className="fm-details fm-reference" open={!!b.variantId && !b.referenceMediaIds.length}>
                  <summary><Thumb url={mediaUrl(b.referenceMediaIds[0] ?? null)} label="Full furniture reference" empty="No photo" size={32} /> Full furniture reference</summary>
                  <MediaField label={`Full furniture reference ${f.name} ${c.name} ${b.id}`} role="full furniture reference" kind="reference" sampleIds={sampleIds} value={b.referenceMediaIds[0] ?? null} media={media} change={(id) => updateBinding(b.id, { referenceMediaIds: id ? [id] : [] })} upload={uploadImage} disabled={disabledUpload} />
                </details>
                <div className="fm-map-foot">
                  <label className="fm-check"><input type="checkbox" checked={b.reviewed} onChange={(e) => updateBinding(b.id, { reviewed: e.currentTarget.checked })} />The photo shows this exact fabric, colour, size, headboard and storage</label>
                  <RemoveButton label="Remove mapping" onConfirm={() => setDraft((d) => ({ ...d, bindings: d.bindings.filter((x) => x.id !== b.id) }))} />
                </div>
                {(draft.roles.composite || !b.variantId || Object.keys(b.externalValues).length > 0) && <details className="fm-details"><summary>More options</summary>
                  {draft.roles.composite && <KeyValues label="Reviewed preserved configuration" values={b.preserved} change={(values) => updateBinding(b.id, { preserved: values })} />}
                  {(!b.variantId || Object.keys(b.externalValues).length > 0) && <KeyValues label="External option values (saved only; not preview authorization)" values={b.externalValues} change={(values) => updateBinding(b.id, { externalValues: values })} />}
                </details>}
                {p.diagnostics[b.id] && <p className="fm-muted fm-diagnostic" role="status">Last save: {p.diagnostics[b.id]}</p>}
                </>}
              </li>;
            })}</ul>}
            {pageCount > 1 && <div className="fm-actions fm-pager"><span className="fm-muted fm-tabular">Showing {currentPage * MAPPINGS_PER_PAGE + 1}-{Math.min((currentPage + 1) * MAPPINGS_PER_PAGE, scoped.length)} of {scoped.length}</span>
              <button type="button" className="fm-btn" disabled={currentPage === 0} onClick={() => setMappingPage(currentPage - 1)}>Previous</button>
              <button type="button" className="fm-btn" disabled={currentPage + 1 >= pageCount} onClick={() => setMappingPage(currentPage + 1)}>Next</button></div>}
            <details className="fm-details fm-roles"><summary>Shopify option roles (advanced)</summary><div className="fm-map-grid">{(["fabric", "colour", "size", "composite"] as const).map((role) => <label className="fm-field" key={role}><span className="fm-label">Native {role} option</span>
              <select aria-label={`${role} option role`} value={draft.roles[role] ?? ""} onChange={(e) => { const value = e.currentTarget.value; setDraft((d) => { const roles = { ...d.roles }; if (value) roles[role] = value; else delete roles[role]; return { ...d, roles, bindings: d.bindings.map((b) => ({ ...b, reviewed: false })) }; }); }}>
                <option value="">Not mapped</option>{p.options.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}</select></label>)}</div></details>
          </section>
          </details>}
          <p className="fm-muted fm-footnote">Fabric textures and colour samples are saved to Shopify Files, not the product gallery. Full furniture reference photos may use product media. Removing selections from Tryora never deletes Shopify images or variants. <s-link href={link}>Refresh from Shopify</s-link></p>
        </fieldset>}
        <p className="fm-footnote"><s-link href={`/app/customization?product=${encodeURIComponent(p.productId)}`}>Inspect existing integration settings</s-link></p>
      </>}
    </div>
  </s-page>;
}

function KeyValues({ label, values, change }: { label: string; values: Record<string, string>; change: (value: Record<string, string>) => void }) {
  const [name, setName] = useState(""), [value, setValue] = useState("");
  return <fieldset className="fm-kv"><legend>{label}</legend>
    {Object.entries(values).map(([key, val]) => <div className="fm-actions" key={key}><span>{key}: {val}</span><button type="button" className="fm-link" onClick={() => { const next = { ...values }; delete next[key]; change(next); }}>Remove {key}</button></div>)}
    <div className="fm-map-grid fm-kv-grid"><label className="fm-field"><span className="fm-label">Exact option/dimension name</span><input value={name} onChange={(e) => setName(e.currentTarget.value)} /></label>
      <label className="fm-field"><span className="fm-label">Exact value</span><input value={value} onChange={(e) => setValue(e.currentTarget.value)} /></label></div>
    <button type="button" className="fm-btn" onClick={() => { if (name.trim() && value.trim()) { change({ ...values, [name]: value }); setName(""); setValue(""); } }}>Add exact value</button>
  </fieldset>;
}

/* Polaris-aligned surfaces, type and spacing; Tryora's deep green stays the single accent. */
const STYLES = `
.fabric-manager{--fm-surface:#fff;--fm-subtle:#f7f7f7;--fm-text:#303030;--fm-muted:#616161;--fm-line:#e3e3e3;--fm-line-strong:#c9c9c9;--fm-accent:#303d2f;--fm-accent-soft:#eef1ea;
  --fm-success:#0c5132;--fm-success-bg:#cdfee1;--fm-attention:#5e4200;--fm-attention-bg:#ffeb78;--fm-warning:#8e1f0b;--fm-warning-bg:#fedad9;--fm-neutral-bg:#ebebeb;
  color:var(--fm-text);font:13px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;display:grid;gap:12px;max-width:1240px;margin:0 auto}
.fabric-manager *{box-sizing:border-box}
.fabric-manager h2{font-size:15px;font-weight:650;margin:0;text-wrap:balance}.fabric-manager h3{font-size:14px;font-weight:650;margin:0}.fabric-manager p{margin:0}
.fm-card{background:var(--fm-surface);border-radius:12px;box-shadow:0 1px 0 rgba(26,26,26,.07),0 0 0 1px rgba(26,26,26,.06);padding:16px;min-width:0}
.fm-muted{color:var(--fm-muted)}.fm-tabular{font-variant-numeric:tabular-nums}.fm-grow{flex:1;min-width:0}.fm-error{color:var(--fm-warning)}.fm-ok{color:var(--fm-success)}
.fm-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.fm-header{display:grid;gap:10px}.fm-product{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.fm-product-image{width:56px;height:56px;border-radius:10px;object-fit:cover;flex:none}
.fm-subhead{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;border-top:1px solid var(--fm-line);padding-top:10px}
.fm-swatch-prefs{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fm-shape{display:grid;place-items:center;width:42px;height:42px;padding:7px}
.fm-shape[aria-pressed="true"]{border-color:var(--fm-accent);box-shadow:0 0 0 1px var(--fm-accent)}
.fm-shape-circle,.fm-shape-square{width:22px;height:22px;background:var(--fm-accent)}
.fm-shape-circle{border-radius:50%}.fm-shape-square{border-radius:3px}
.fm-swatch-size{display:inline-flex;align-items:center;gap:5px;font-size:12px;margin-left:10px}
.fabric-manager .fm-swatch-size input{width:64px;min-width:64px;min-height:36px;border:1px solid var(--fm-line-strong);border-radius:8px;padding:5px}
.fm-ready-count{margin-left:auto}
.fm-save{display:flex;align-items:center;gap:10px;margin-left:auto}.fm-save-hint{text-align:right}
.fm-field{display:grid;gap:4px;min-width:0;align-content:start}.fm-label{font-weight:550;font-size:12px}
.fabric-manager select,.fabric-manager input:not([type=checkbox]):not([type=color]):not([type=file]),.fabric-manager textarea{font:inherit;color:inherit;background:var(--fm-surface);border:1px solid var(--fm-line-strong);border-radius:8px;padding:7px 10px;min-height:34px;width:100%;min-width:0}
.fabric-manager textarea{resize:vertical}.fabric-manager [aria-invalid=true]{border-color:var(--fm-warning)!important}
.fm-product .fm-field{min-width:200px}.fm-product .fm-grow{min-width:240px}
.fm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-weight:550;min-height:32px;padding:6px 12px;border-radius:8px;border:1px solid var(--fm-line-strong);background:var(--fm-surface);color:var(--fm-text);cursor:pointer;position:relative;white-space:nowrap;box-shadow:0 1px 0 rgba(0,0,0,.05)}
.fm-btn:hover{background:var(--fm-subtle)}.fm-btn--primary{background:var(--fm-accent);border-color:var(--fm-accent);color:#fff}.fm-btn--primary:hover{background:#243024}
.fm-btn--danger{background:var(--fm-warning);border-color:var(--fm-warning);color:#fff}.fm-btn--danger:hover{background:#6f1808}
.fm-btn:disabled,.fm-btn.is-disabled{opacity:.5;cursor:default}.fm-btn:focus-within{outline:2px solid var(--fm-accent);outline-offset:2px}
.fm-link{font:inherit;border:0;background:none;color:var(--fm-accent);text-decoration:underline;padding:4px;cursor:pointer}.fm-link:disabled{opacity:.5}.fm-danger{color:var(--fm-warning)}
.fabric-manager button:focus-visible,.fabric-manager select:focus-visible,.fabric-manager input:focus-visible,.fabric-manager textarea:focus-visible,.fabric-manager summary:focus-visible{outline:2px solid var(--fm-accent);outline-offset:2px}
.fm-file{position:absolute;inset:0;opacity:0;width:100%;cursor:pointer}.fm-file:disabled{cursor:default}
.fm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fm-pill{display:inline-flex;align-items:center;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:550;white-space:nowrap;line-height:1.4}
.fm-pill--success{background:var(--fm-success-bg);color:var(--fm-success)}.fm-pill--attention{background:var(--fm-attention-bg);color:var(--fm-attention)}
.fm-pill--warning{background:var(--fm-warning-bg);color:var(--fm-warning)}.fm-pill--neutral{background:var(--fm-neutral-bg);color:var(--fm-muted)}
.fm-count{display:inline-block;margin-left:6px;border-radius:999px;background:var(--fm-neutral-bg);padding:0 7px;font-size:12px;font-weight:550;color:var(--fm-muted)}
.fm-steps{display:flex;gap:6px;flex-wrap:wrap;list-style:none;margin:0;padding:0}
.fm-steps li{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px 3px 4px;background:var(--fm-subtle);color:var(--fm-muted);font-size:12px}
.fm-steps li>span[aria-hidden]{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--fm-line-strong);font-size:11px}
.fm-steps li.is-done{color:var(--fm-success)}.fm-steps li.is-done>span[aria-hidden]{background:var(--fm-success);border-color:var(--fm-success);color:#fff}
.fm-thumb{display:inline-grid;place-items:center;flex:none;overflow:hidden;border-radius:8px;background:var(--fm-subtle);box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);max-width:100%}
.fm-thumb--round{border-radius:50%}.fm-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.fm-thumb.is-empty{box-shadow:none;border:1px dashed var(--fm-line-strong);background:var(--fm-surface)}
.fm-thumb.is-empty span{font-size:10px;line-height:1.15;color:var(--fm-muted);text-align:center;padding:2px}
.fm-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.fm-workspace{display:grid;grid-template-columns:minmax(220px,280px) minmax(0,1fr);gap:12px;align-items:start}
.fm-fabrics{display:grid;gap:10px;position:sticky;top:12px}.fm-add{width:100%}
.fm-fabric-list{display:grid;gap:4px}
.fm-fabric-item{display:flex;align-items:center;gap:10px;width:100%;text-align:left;font:inherit;color:inherit;border:1px solid transparent;border-radius:10px;padding:6px;background:none;cursor:pointer}
.fm-fabric-item:hover{background:var(--fm-subtle)}.fm-fabric-item[aria-pressed=true]{background:var(--fm-accent-soft);border-color:#b9c4ad}
.fm-fabric-text{display:grid;min-width:0;flex:1}.fm-fabric-text strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fm-fabric-text small{color:var(--fm-muted)}
.fm-detail{display:grid;gap:14px}.fm-fabric-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.fm-empty{display:grid;gap:6px;justify-items:start;padding:8px 0}
.fm-editor{display:grid;gap:12px;background:var(--fm-subtle);border-radius:10px;padding:14px}
.fm-editor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}
.fm-editor-foot,.fm-map-foot{display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap}
.fm-check{display:inline-flex;align-items:center;gap:8px;cursor:pointer}.fm-check input{width:16px;height:16px;accent-color:var(--fm-accent);flex:none}
.fm-confirm{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--fm-warning-bg);color:var(--fm-warning);border-radius:8px;padding:4px 8px}
.fm-media{display:flex;gap:12px;align-items:flex-start;background:var(--fm-surface);border-radius:10px;padding:10px;box-shadow:0 0 0 1px var(--fm-line)}
.fm-media-body{display:grid;gap:6px;min-width:0;flex:1}
.fm-choices summary{cursor:pointer;color:var(--fm-accent);font-weight:550;width:max-content;max-width:100%}
.fm-choice-grid{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;max-height:160px;overflow:auto}
.fm-choice-grid button{width:48px;height:48px;padding:2px;border-radius:8px;border:1px solid var(--fm-line-strong);background:var(--fm-surface);cursor:pointer}
.fm-choice-grid button[aria-pressed=true]{outline:2px solid var(--fm-accent);outline-offset:1px}.fm-choice-grid img{width:100%;height:100%;object-fit:cover;border-radius:6px;display:block}
.fm-colours-head{align-items:center}
.fm-colour-grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
.fm-colour{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-rows:auto auto;column-gap:10px;row-gap:6px;align-items:center;width:100%;text-align:left;font:inherit;color:inherit;background:var(--fm-surface);border:1px solid var(--fm-line);border-radius:10px;padding:10px;cursor:pointer}
.fm-colour:hover{border-color:var(--fm-line-strong)}.fm-colour.is-editing{border-color:var(--fm-accent);box-shadow:0 0 0 1px var(--fm-accent)}.fm-colour.is-off .fm-thumb{opacity:.45}
.fm-colour .fm-thumb{grid-row:1/3}.fm-colour-text{display:grid;min-width:0}.fm-colour-text strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fm-colour-text small{color:var(--fm-muted)}
.fm-colour .fm-pill{justify-self:start;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.fm-hex{display:flex;align-items:center;gap:8px}.fm-hex input[type=color]{width:40px;height:34px;padding:2px;border:1px solid var(--fm-line-strong);border-radius:8px;background:var(--fm-surface);flex:none;cursor:pointer}
.fm-hex input:not([type=color]){max-width:130px}
.fm-scope{display:inline-flex;gap:2px;background:var(--fm-subtle);border-radius:8px;padding:2px;margin:10px 0;flex-wrap:wrap;max-width:100%}
.fm-scope button{font:inherit;border:0;background:none;border-radius:6px;padding:5px 10px;cursor:pointer;color:var(--fm-muted)}
.fm-scope button[aria-pressed=true]{background:var(--fm-surface);color:var(--fm-text);font-weight:550;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.fm-map-list{list-style:none;margin:0;padding:0;display:grid}
.fm-map-row{display:grid;gap:10px;padding:14px 0;border-top:1px solid var(--fm-line)}.fm-map-row:first-child{border-top:0;padding-top:4px}
.fm-map-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.fm-map-hint{margin-top:-4px}
.fm-map-title{display:grid;flex:1 1 180px;min-width:0}.fm-map-title small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-map-row:not(.is-open){padding:10px 0}
.fm-map-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,2.2fr);gap:10px}.fm-kv-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.fm-details summary{cursor:pointer;font-weight:550;display:flex;align-items:center;gap:8px;width:max-content;max-width:100%}.fm-details[open]>summary{margin-bottom:8px}
.fm-roles{margin-top:12px;border-top:1px solid var(--fm-line);padding-top:12px}
.fm-kv{border:1px solid var(--fm-line);border-radius:8px;padding:10px;margin:8px 0;display:grid;gap:8px}
.fm-native-grid{list-style:none;margin:12px 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}
.fm-native{display:flex;align-items:center;gap:10px;border:1px solid var(--fm-line);border-radius:10px;padding:10px}.fm-native div{display:grid;min-width:0;flex:1}
.fm-variant-list{list-style:none;margin:8px 0 0;padding:0;display:grid}.fm-variant-list li{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--fm-line)}
.fabric-manager-fields{border:0;padding:0;margin:0;min-width:0;display:grid;gap:12px}.fabric-manager-fields:disabled{opacity:.65}
.fm-footnote{font-size:12px}.fm-pager{justify-content:flex-end;margin-top:8px}
@media(max-width:760px){
  .fm-workspace{grid-template-columns:1fr}.fm-fabrics{position:static}
  .fm-fabric-list{display:flex;overflow-x:auto;gap:6px;padding-bottom:4px;scroll-snap-type:x mandatory}
  .fm-fabric-item{flex:0 0 auto;width:auto;max-width:220px;border-color:var(--fm-line);scroll-snap-align:start}
  .fm-map-grid,.fm-kv-grid{grid-template-columns:1fr}.fm-save{margin-left:0;width:100%;justify-content:space-between}.fm-save-hint{text-align:left}
  .fm-product .fm-field,.fm-product .fm-grow{min-width:100%}.fm-ready-count{margin-left:0}
}
`;
