import { useEffect, useState } from "react";
import { hexToRgb, rgbToHex } from "../customization/colour-values";
import { emptyFabricDraft, type FabricDraft, type ManagedFabric, type ManagedBinding } from "../customization/fabric-manager";

type Media = { id: string; url: string; alt?: string | null };
export interface FabricManagerData {
  installationReady: boolean;
  manualSetupReason?: string;
  products: { nodes: { id: string; title: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  selected: null | {
    productId: string; title: string; image: string | null; mode: "native" | "manual"; providerId: string; revision: string;
    draft: FabricDraft; importBlocked?: boolean; diagnostics: Record<string, string>; warning: string; explicitlyOff: boolean;
    options: { name: string; optionValues: { name: string; swatch?: { color?: string; image?: { image?: { url: string } } } }[] }[];
    variants: { id: string; availableForSale: boolean; image?: { url: string } | null; selectedOptions: { name: string; value: string }[] }[];
    media: Media[]; native: { issue: string | null; optionName: string | null; fabricOptionName: string | null; selections: { value: string; label?: string; group: string | null; image: string | null; colour: string | null; available?: boolean }[] };
    syncedAt: string; saved: boolean;
  };
}
const uid = () => crypto.randomUUID();
const control = { border: "1px solid #c8c8c8", borderRadius: 8, padding: "10px 12px", background: "white", width: "100%", boxSizing: "border-box" as const, font: "inherit" };
const field = { display: "grid", gap: 6 };
function Sample({ url, hex, label, round = true }: { url?: string | null; hex?: string | null; label: string; round?: boolean }) {
  return <span className="fabric-sample" role="img" aria-label={label} style={{ borderRadius: round ? "50%" : 12, background: hex || "#f6f5f2" }}>
    {url ? <img src={url} alt={label} /> : <span>{hex ? "" : "No image"}</span>}
  </span>;
}
function MediaField({ label, value, media, change, upload, disabled, kind, sampleIds }: {
  label: string; value: string | null; media: Media[]; change: (id: string | null) => void;
  upload: (file: File) => Promise<Media | null>; disabled: boolean;
  kind: "sample" | "reference"; sampleIds: ReadonlySet<string>;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [imagePage, setImagePage] = useState(0);
  const selected = media.find((m) => m.id === value);
  // The sample picker must never be a gallery of unrelated furniture photographs.
  const choices = media.filter((m) => kind === "sample"
    ? sampleIds.has(m.id) || m.alt?.startsWith("Tryora merchant upload ")
    : !sampleIds.has(m.id) || m.id === value);
  const pageCount = Math.ceil(choices.length / 24);
  const currentPage = Math.min(imagePage, Math.max(0, pageCount - 1));
  return <div className={`fabric-media-field fabric-media-${kind}`}>
    <div className="fabric-selected-image">
      <Sample url={selected?.url} label={label} round={false} />
      <div>
        <strong>{selected ? "Selected image" : kind === "sample" ? "No fabric sample uploaded" : "No product reference selected"}</strong>
        <p className="fabric-muted">{kind === "sample"
          ? "Upload an actual fabric texture or colour sample. Product photos are hidden from this picker."
          : "Use a complete product photograph matching the exact Shopify variant. A swatch alone cannot approve a room preview."}</p>
        {value && !selected && <p role="alert">Image missing from this product. Refresh and choose it again.</p>}
      </div>
    </div>
    <label className="fabric-upload-zone">
      <span>{busy ? "Uploading to Shopify..." : kind === "sample" ? "Upload fabric / colour sample" : "Upload full-product reference"}</span>
      <small>JPG, PNG or WebP · up to 8 MB</small>
      <input aria-label={`Upload ${label}`} type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled || busy} onChange={async (e) => {
        const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (!file) return;
        if (file.size > 8 * 1024 * 1024 || file.size === 0) { setError("Choose a nonempty image under 8 MB."); return; }
        setBusy(true); setError("");
        try { const image = await upload(file); if (image) { change(image.id); setImagePage(0); } }
        catch (err) { setError(err instanceof Error ? err.message : "Image upload failed."); }
        finally { setBusy(false); }
      }} />
    </label>
    {selected && <button className="fabric-clear-image" type="button" disabled={disabled || busy} onClick={() => change(null)}>Remove selection</button>}
    {choices.length > 0 && <details className="fabric-existing-images">
      <summary>{kind === "sample" ? "Choose an existing fabric / colour sample" : "Choose an existing product photo"} ({choices.length})</summary>
      <div className="fabric-media-choices">{choices.slice(currentPage * 24, (currentPage + 1) * 24).map((m) =>
        <button key={m.id} type="button" disabled={disabled || busy} aria-label={`Use image ${m.id.split("/").pop()} for ${label}`}
          aria-pressed={m.id === value} onClick={() => change(m.id)}>
          <img src={m.url} alt={kind === "sample" ? "Fabric or colour sample" : "Full product photograph"} loading="lazy" />
        </button>)}</div>
      {pageCount > 1 && <div className="fabric-actions">
        <button type="button" disabled={currentPage === 0} onClick={() => setImagePage(Math.max(0, currentPage - 1))}>Previous images</button>
        <button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setImagePage(Math.min(pageCount - 1, currentPage + 1))}>Next images</button>
      </div>}
    </details>}
    {error && <p role="alert" className="fabric-upload-error">{error}</p>}
  </div>;
}
export function FabricColourManager({ data, save, upload, error, busy = false }: {
  data: FabricManagerData; save: (mode: "native" | "manual", draft: FabricDraft) => void;
  upload: (file: File) => Promise<Media | null>; error?: string; busy?: boolean;
}) {
  const p = data.selected;
  const [mode, setMode] = useState<"native" | "manual">(p?.mode ?? "native"), [draft, setDraft] = useState<FabricDraft>(p?.draft ?? emptyFabricDraft());
  const [invalidRgb, setInvalidRgb] = useState<Set<string>>(new Set());
  const [fabricEditor, setFabricEditor] = useState(true);
  const [editColour, setEditColour] = useState(""), [bindingPage, setBindingPage] = useState(0);
  const [fabricId, setFabricId] = useState(p?.draft.fabrics[0]?.id ?? ""), [media, setMedia] = useState(p?.media ?? []);
  useEffect(() => { setInvalidRgb(new Set()); setMode(p?.mode ?? "native"); setDraft(p?.draft ?? emptyFabricDraft()); setMedia(p?.media ?? []); setFabricId(p?.draft.fabrics[0]?.id ?? ""); }, [p?.productId, p?.revision]);
  const fabric = draft.fabrics.find((f) => f.id === fabricId), mediaUrl = (id: string | null) => media.find((m) => m.id === id)?.url;
  const updateFabric = (id: string, patch: Partial<ManagedFabric>) => setDraft((d) => {
    const previous = d.fabrics.find((f) => f.id === id)!;
    const renamedColours = new Set((patch.colours ?? []).filter((c) => previous.colours.find((x) => x.id === c.id)?.name !== c.name).map((c) => c.id));
    return { ...d, fabrics: d.fabrics.map((f) => f.id === id ? { ...f, ...patch } : f), bindings: d.bindings.map((b) => b.fabricId === id &&
      (patch.name !== undefined && patch.name !== previous.name || renamedColours.has(b.colourId)) ? { ...b, reviewed: false } : b) };
  });
  const updateBinding = (id: string, patch: Partial<ManagedBinding>) => setDraft((d) => ({ ...d, bindings: d.bindings.map((b) => b.id === id ? { ...b, ...patch, reviewed: patch.reviewed ?? false } : b) }));
  const uploadImage = async (file: File) => { const m = await upload(file); if (m) setMedia((all) => [...all.filter((x) => x.id !== m.id), m]); return m; };
  useEffect(() => { setBindingPage(0); setFabricEditor(true); }, [fabricId]);
  const sampleIds = new Set(draft.fabrics.flatMap((f) => [f.textureMediaId, ...f.colours.map((c) => c.swatchMediaId)]).filter((id): id is string => !!id));
  const fabricBindings = draft.bindings;
  const currentBindingPage = Math.min(bindingPage, Math.max(0, Math.ceil(fabricBindings.length / 6) - 1));
  const disabledUpload = !data.installationReady || mode !== "manual" || !!p?.importBlocked;
  const addFabric = () => { const id = uid(); setDraft((d) => ({ ...d, fabrics: [...d.fabrics, { id, name: "", description: "", enabled: true, textureMediaId: null, colours: [] }] })); setFabricId(id); };
  const addColour = () => { if (!fabric) return; const id = uid(); setEditColour(id); updateFabric(fabric.id, { colours: [...fabric.colours, { id, name: "", enabled: true, swatchMediaId: null, hex: null }] }); };
  const addMapping = () => { const c = fabric?.colours[0]; if (!fabric || !c) return; setBindingPage(Math.floor(fabricBindings.length / 6)); setDraft((d) => ({ ...d, bindings: [...d.bindings, { id: uid(), fabricId: fabric.id, colourId: c.id, variantId: null, nativeOptions: {}, preserved: {}, externalValues: {}, referenceMediaIds: [], reviewed: false }] })); };
  const link = p ? `/app/fabrics?product=${encodeURIComponent(p.productId)}` : "/app/fabrics";
  return <s-page heading="Fabrics & Colours" inlineSize="large">
    <style>{` .fabric-manager { color:#202223;font:14px/1.5 Inter,system-ui,sans-serif;max-width:1020px;margin:auto } .fabric-manager h2{font-size:20px;margin:16px 0}.fabric-manager h3{font-size:18px;margin:12px 0}.fabric-manager button{font:inherit;cursor:pointer}.fabric-manager label{display:grid;gap:6px}.fabric-manager p{color:#656565}.fabric-manager .fabric-card{border:1px solid #dedede;border-radius:16px;padding:18px;margin:14px 0;background:white}.fabric-manager .fabric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px}.fabric-manager .fabric-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.fabric-manager .fabric-row>*{min-width:0}.fabric-sample{width:68px;height:68px;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;flex:none;font-size:11px;color:#777}.fabric-sample img{width:100%;height:100%;object-fit:cover}.fabric-manager .fabric-tabs{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}.fabric-manager .fabric-tabs button{border:0;border-radius:24px;padding:9px 18px;background:#f4f4f4}.fabric-manager .fabric-tabs button[aria-current=step]{background:#e4e8df;font-weight:600}.fabric-manager .fabric-add{width:100%;border:1px solid #ccc;background:white;border-radius:14px;padding:18px;text-align:left}.fabric-manager .fabric-media-choices{display:flex;gap:7px;overflow-x:auto;max-width:100%;padding:5px}.fabric-media-choices button{border:1px solid #ccc;border-radius:8px;padding:2px;background:white;flex:none;width:54px;height:54px}.fabric-media-choices button[aria-pressed=true]{outline:2px solid #4e6a49}.fabric-media-choices img{width:100%;height:100%;object-fit:cover}.fabric-upload{font-size:13px;color:#525252}.fabric-manager input[type=file]{max-width:100%}.fabric-manager .fabric-muted{font-size:13px;color:#777}.fabric-manager details{overflow-wrap:anywhere}.fabric-manager .fabric-actions{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px}.fabric-manager .fabric-actions button{border:1px solid #ccc;border-radius:8px;padding:8px 12px;background:white}.fabric-manager .fabric-actions button:disabled{opacity:.5;cursor:default}.fabric-manager input[type=checkbox]{width:18px;height:18px}.fabric-manager .fabric-check{display:flex;align-items:center;gap:8px}.fabric-manager .fabric-primary{background:#303d2f!important;color:white;padding:12px 22px!important}.fabric-manager button:focus-visible,.fabric-manager input:focus-visible,.fabric-manager select:focus-visible{outline:3px solid #45633b;outline-offset:3px}.fabric-manager{max-width:1440px}.fabric-manager-fields{border:0;padding:0;margin:0;min-width:0}.fabric-manager-fields:disabled{opacity:.65}.fabric-product-controls{display:flex;align-items:end;gap:16px;flex-wrap:wrap}.fabric-product-controls>label{flex:1;min-width:200px}.fabric-product-controls .fabric-actions{margin-top:0}.fabric-workspace{display:grid;grid-template-columns:250px minmax(0,1fr);gap:16px;margin-top:16px}.fabric-panel{border:1px solid #dedede;border-radius:12px;background:#fff;padding:14px;min-width:0}.fabric-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.fabric-count{font-size:12px;font-weight:400;border-radius:20px;background:#f4f4f4;padding:4px 10px}.fabric-list{display:grid;gap:8px}.fabric-list-item{display:flex;align-items:center;gap:10px;text-align:left;padding:10px;background:white;border:1px solid #dedede;border-radius:8px;width:100%}.fabric-list-item[aria-pressed=true]{background:#f5f0e9;border-color:#9b8c77}.fabric-list-item small{display:block;color:#666}.fabric-list-item .fabric-sample{width:48px;height:48px}.fabric-editor{margin-top:18px}.fabric-editor label{margin:12px 0}.fabric-table-wrap{overflow-x:auto;max-width:100%}.fabric-table{border-collapse:collapse;width:100%;min-width:720px;font-size:13px}.fabric-mapping .fabric-table{min-width:900px}.fabric-mapping td:nth-child(3){min-width:260px}.fabric-table th{text-align:left;background:#f7f8f9;font-weight:600;white-space:nowrap}.fabric-table th,.fabric-table td{padding:12px 8px;border-bottom:1px solid #e6e6e6;vertical-align:top}.fabric-table input:not([type=checkbox]),.fabric-table select{min-width:100px}.fabric-table .fabric-sample{width:48px;height:48px}.fabric-table details{min-width:110px;max-width:240px}.fabric-table details[open]{min-width:210px}.fabric-table button,.fabric-heading button,.fabric-editor button{padding:9px 12px;border:1px solid #ccc;border-radius:7px;background:white}.fabric-mapping{margin-top:16px}.fabric-table summary{cursor:pointer}.fabric-table input[aria-invalid=true]{border-color:#b42318}.fabric-media-field{display:grid;gap:10px;margin:8px 0}.fabric-selected-image{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid #e4e5e7;background:#fafaf8;border-radius:12px}.fabric-selected-image p{margin:3px 0 0}.fabric-upload-zone{border:1px dashed #758064;border-radius:12px;padding:12px;background:#f7f9f4;color:#32412d;cursor:pointer}.fabric-upload-zone span{font-weight:650}.fabric-upload-zone small{color:#555}.fabric-upload-zone input[type=file]{display:block;width:100%;margin-top:7px;font-size:12px}.fabric-existing-images{border:1px solid #e6e6e6;border-radius:10px;padding:8px}.fabric-existing-images summary{font-weight:500;cursor:pointer}.fabric-existing-images .fabric-media-choices{flex-wrap:wrap;max-height:182px;overflow:auto}.fabric-clear-image{justify-self:start;border:0;background:transparent;color:#5a6346;text-decoration:underline;padding:3px}.fabric-upload-error{color:#b42318!important}.fabric-colour-row td:nth-child(5){min-width:260px}.fabric-colour-row td:nth-child(5) .fabric-media-field{min-width:240px}.fabric-panel{box-shadow:0 1px 3px rgba(0,0,0,.035)}.fabric-swatch-edit{display:block;border:1px solid #7b876b!important;border-radius:8px;background:#f7f9f4!important;color:#33412f!important;padding:7px 10px!important;margin:8px 0;text-align:center}.fabric-colour-row td:nth-child(5) details{max-width:unset}.fabric-colour-row td:nth-child(5) details[open]{max-width:unset}@media(max-width:900px){.fabric-panel:not(.fabric-mapping) .fabric-table{min-width:0}.fabric-panel:not(.fabric-mapping) .fabric-table thead{display:none}.fabric-panel:not(.fabric-mapping) .fabric-table tbody{display:grid;gap:12px}.fabric-panel:not(.fabric-mapping) .fabric-colour-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;border:1px solid #e1e1dd;border-radius:12px;padding:12px}.fabric-panel:not(.fabric-mapping) .fabric-colour-row td{display:block;min-width:0;border:0;padding:4px}.fabric-panel:not(.fabric-mapping) .fabric-colour-row td:nth-child(5),.fabric-panel:not(.fabric-mapping) .fabric-colour-row td:nth-child(6){grid-column:1/-1}.fabric-panel:not(.fabric-mapping) .fabric-table-wrap{overflow:visible}}@media(max-width:900px){.fabric-workspace{grid-template-columns:1fr}.fabric-list{display:flex;overflow-x:auto;padding:3px}.fabric-list-item{min-width:190px;max-width:240px;flex:none}.fabric-panel{padding:12px}.fabric-manager h2{font-size:18px}}`}</style>
    <div className="fabric-manager">
      <p>Manage fabrics, colours and mapping for your products.</p>

      <s-section heading="Product configuration">
        <div className="fabric-product-controls"><label>Shopify product<select aria-label="Shopify product" style={control} value={p?.productId ?? ""} onChange={(e) => { if (e.currentTarget.value) window.location.assign(`/app/fabrics?product=${encodeURIComponent(e.currentTarget.value)}`); }}>
          <option value="">Select a Shopify product</option>{p && !data.products.nodes.some((x) => x.id === p.productId) && <option value={p.productId}>{p.title}</option>}
          {data.products.nodes.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label>{p && <div className="fabric-actions fabric-toolbar"><button className="fabric-primary" type="button" disabled={busy || !data.installationReady || mode === "manual" && (p.importBlocked || draft.fabrics.some((f) => f.colours.some((c) => invalidRgb.has(c.id))))} onClick={() => save(mode, draft)}>{busy ? "Validating..." : "Save changes"}</button><button type="button" disabled={!data.installationReady || mode !== "manual"} onClick={addFabric}>+ Add fabric</button></div>}</div>
        {data.products.pageInfo.hasNextPage && <s-link href={`${link}${p ? "&" : "?"}after=${encodeURIComponent(data.products.pageInfo.endCursor ?? "")}`}>Next 25 products</s-link>}
        {!p && <p>Select a real Shopify product to manage its fabrics, colours and approved product references.</p>}
      </s-section>
      {p && <>
        <div className="fabric-row" style={{ margin: "20px 0" }}>{p.image && <img src={p.image} alt={p.title} width={72} height={72} style={{ objectFit: "cover", borderRadius: 12 }} />}<div><h2>{p.title}</h2><s-link href={`/app/products/${p.productId.split("/").pop()}`}>Product preview settings</s-link></div></div>
        {error && <s-banner heading="Configuration needs review" tone="critical"><p role="alert">{error}</p></s-banner>}
        {p.saved && !error && <s-banner heading="Configuration saved" tone="success"><p role="status">Mode and product mappings saved. Unreviewed combinations remain blocked.</p></s-banner>}
        {p.explicitlyOff && <s-banner heading="Product previews are OFF" tone="warning"><p>Saving fabrics or switching mode does not enable this product. Review Product preview settings when ready.</p></s-banner>}
        {!data.installationReady && <s-banner heading="Manual setup is not enabled" tone="info"><p>{data.manualSetupReason || "Your app administrator needs to authorize merchant-managed customization for this installation. Shopify-native previews continue to work."}</p></s-banner>}
        {p.warning && <s-banner heading="Saved mapping needs attention" tone="warning"><p>{p.warning}</p></s-banner>}
        {p.providerId === "cloudlift" && <p>Existing reviewed Cloudlift native-linked mapping is preserved under Manual Setup. Saving does not create an automatic third-party integration.</p>}
        <s-section heading="Configuration mode">
          <label>Mode<select aria-label="Configuration mode" style={control} value={mode} onChange={(e) => setMode(e.currentTarget.value as "native" | "manual")}>
            <option value="native">Shopify Native - Automatic</option><option value="manual" disabled={!data.installationReady}>Manual Setup - Merchant Managed{data.installationReady ? "" : " (not enabled)"}</option>
          </select></label>
          <p>{mode === "native" ? "Automatically use fabrics, colours and variants configured in your Shopify product." : "Add your own fabrics, colours and swatch images for products using custom options."}</p>
        </s-section>
        {mode === "native" ? <s-section heading="Native Shopify options">
          <p>Last synced: <time dateTime={p.syncedAt}>{new Date(p.syncedAt).toLocaleString()}</time>. Live Shopify availability.</p>
          <s-button href={link}>Refresh from Shopify</s-button>
          <p>Read-only product data. Preview settings and exact approved references still control generation.</p>
          {p.native.issue && <s-banner heading="Preview option mapping needs review" tone="warning"><p>{p.native.issue}. Review Product preview settings; no alternative option is selected automatically.</p></s-banner>}
          {!p.native.selections.length && <p>No native fabric/colour preview combinations were found for this mapping. This does not mean the product has only one style.</p>}
          <div className="fabric-grid">{p.native.selections.map((s) => <div className="fabric-card" key={s.value}>
            <div className="fabric-row"><Sample url={s.image} hex={s.colour} label={`${s.group ?? ""} ${s.label ?? s.value} sample`} /><div><h3>{[s.group, s.label ?? s.value].filter(Boolean).join(" / ")}</h3><p>{s.image ? "Actual Shopify swatch image" : s.colour ? "Shopify colour value" : "Text label - no swatch supplied by Shopify"}</p><s-badge tone={s.available ? "success" : "neutral"}>{s.available ? "Available for sale" : "No available Shopify combination"}</s-badge></div></div>
          </div>)}</div>
          <details><summary>Inspect {p.variants.length} exact variants and additional options</summary>{p.variants.map((v) => <div className="fabric-card" key={v.id}><strong>{v.selectedOptions.map((o) => `${o.name}: ${o.value}`).join(" / ")}</strong><p>{v.id}</p><p>{v.availableForSale ? "Available for sale" : "Unavailable for sale"}</p>{v.image?.url && <img src={v.image.url} alt="Shopify variant photo" width={72} height={72} />}</div>)}</details>
        </s-section> : <s-section heading="Manual Fabric & Colour Manager"><fieldset disabled={!data.installationReady} className="fabric-manager-fields">
          <p>Samples help shoppers choose. Only a reviewed exact variant and a separate approved full-product reference can authorize a preview. External-only configurations remain unready.</p>
          <div className="fabric-workspace">
            <aside className="fabric-panel"><h2>Fabrics <span className="fabric-count">{draft.fabrics.length} fabrics</span></h2>
              <div className="fabric-list">{draft.fabrics.map((f) => <button className="fabric-list-item" type="button" key={f.id} aria-pressed={f.id === fabricId} onClick={() => setFabricId(f.id)}>
                <Sample url={mediaUrl(f.textureMediaId)} label={`${f.name} texture`} round={false} /><span><strong>{f.name || "New fabric"}</strong><small>{f.colours.length} colours{f.enabled ? "" : " ? Disabled"}</small></span><span aria-hidden="true">&rsaquo;</span>
              </button>)}</div>
              {!draft.fabrics.length && <p>Add a fabric to get started.</p>}
              {fabric && <details className="fabric-editor" open={fabricEditor}><summary onClick={(e) => { e.preventDefault(); setFabricEditor(!fabricEditor); }}>Edit selected fabric</summary>              <div className="fabric-grid"><label>Fabric name<input aria-label={`Fabric name ${fabric.id}`} style={control} maxLength={140} value={fabric.name} onChange={(e) => updateFabric(fabric.id, { name: e.currentTarget.value })} /></label>
                <label>Description<textarea style={control} maxLength={1000} value={fabric.description} onChange={(e) => updateFabric(fabric.id, { description: e.currentTarget.value })} /></label></div>
              <MediaField label={`Fabric texture ${fabric.name}`} kind="sample" sampleIds={sampleIds} value={fabric.textureMediaId} media={media} change={(id) => updateFabric(fabric.id, { textureMediaId: id })} upload={uploadImage} disabled={disabledUpload} />
              <label className="fabric-check"><input type="checkbox" checked={fabric.enabled} onChange={(e) => updateFabric(fabric.id, { enabled: e.currentTarget.checked })} />Fabric enabled</label>
<button type="button" onClick={() => { if (confirm("Remove this fabric, colours and mappings from Tryora? Shopify images and variants are kept.")) { setDraft((d) => ({ ...d, fabrics: d.fabrics.filter((x) => x.id !== fabric.id), bindings: d.bindings.filter((b) => b.fabricId !== fabric.id) })); setFabricId(draft.fabrics.find((x) => x.id !== fabric.id)?.id ?? ""); } }}>Remove fabric</button></details>}
            </aside>
            <section className="fabric-panel"><div className="fabric-heading"><h2>Colours for {fabric?.name || "selected fabric"} <span className="fabric-count">{fabric?.colours.length ?? 0} colours</span></h2><button className="fabric-primary" type="button" disabled={!fabric} onClick={addColour}>+ Add colour</button></div>
              <div className="fabric-table-wrap"><table className="fabric-table"><thead><tr><th scope="col">Colour swatch</th><th scope="col">Colour name</th><th scope="col">HEX</th><th scope="col">RGB</th><th scope="col">Colour sample image</th><th scope="col">Actions</th></tr></thead><tbody>{fabric?.colours.map((c) => <tr className="fabric-colour-row" key={c.id}>
                <td><Sample url={mediaUrl(c.swatchMediaId)} hex={/^#[0-9a-f]{6}$/i.test(c.hex ?? "") ? c.hex : null} label={`${c.name} colour`} /></td>
                <td><input aria-label={`Colour name ${c.id}`} style={control} maxLength={140} value={c.name} onChange={(e) => updateFabric(fabric.id, { colours: fabric.colours.map((x) => x.id === c.id ? { ...x, name: e.currentTarget.value } : x) })} /></td><td><input aria-label={`HEX ${c.id}`} style={control} placeholder="#RRGGBB" maxLength={7} value={c.hex ?? ""} onChange={(e) => updateFabric(fabric.id, { colours: fabric.colours.map((x) => x.id === c.id ? { ...x, hex: e.currentTarget.value || null } : x) })} /></td><td><RgbField hex={c.hex} label={`RGB ${c.id}`} invalid={(invalid) => setInvalidRgb((all) => { const next = new Set(all); if (invalid) next.add(c.id); else next.delete(c.id); return next; })} change={(hex) => updateFabric(fabric.id, { colours: fabric.colours.map((x) => x.id === c.id ? { ...x, hex } : x) })} /></td>
                <td><Sample url={mediaUrl(c.swatchMediaId)} label={`${fabric.name} ${c.name} sample`} round={false} /><button className="fabric-swatch-edit" type="button" onClick={() => setEditColour(editColour === c.id ? "" : c.id)}>{editColour === c.id ? "Close swatch upload" : "Upload / change swatch"}</button><details open={editColour === c.id}><summary onClick={(e) => { e.preventDefault(); setEditColour(editColour === c.id ? "" : c.id); }}>Edit sample image</summary><p>Sample image only; approve a full-product reference in Variant Mapping.</p>              <MediaField label={`Colour swatch ${fabric.name} ${c.name}`} kind="sample" sampleIds={sampleIds} value={c.swatchMediaId} media={media} change={(id) => updateFabric(fabric.id, { colours: fabric.colours.map((x) => x.id === c.id ? { ...x, swatchMediaId: id } : x) })} upload={uploadImage} disabled={disabledUpload} />
</details></td><td>              <label className="fabric-check"><input type="checkbox" checked={c.enabled} onChange={(e) => updateFabric(fabric.id, { colours: fabric.colours.map((x) => x.id === c.id ? { ...x, enabled: e.currentTarget.checked } : x) })} />Colour enabled</label>
<button type="button" onClick={() => { if (confirm("Remove this colour and its Tryora mappings? Shopify images and variants are kept.")) { updateFabric(fabric.id, { colours: fabric.colours.filter((x) => x.id !== c.id) }); setDraft((d) => ({ ...d, bindings: d.bindings.filter((b) => b.colourId !== c.id) })); } }}>Remove colour</button></td></tr>)}</tbody></table></div>
              {!fabric?.colours.length && <p>{fabric ? "Add colours for this fabric." : "Select or add a fabric to manage colours."}</p>}
            </section>
          </div>
          <section className="fabric-panel fabric-mapping"><div className="fabric-heading"><h2>Variant Mapping <span className="fabric-count">{draft.bindings.length} mappings</span></h2><button className="fabric-primary" type="button" disabled={!fabric?.colours.length} onClick={addMapping}>+ Add mapping</button></div>
            <p>Link exact Shopify variants and separately approved full-product references. Incomplete mappings cannot authorize previews.</p>
            <details><summary>Native option roles and composite configuration</summary><div className="fabric-grid">{(["fabric", "colour", "size", "composite"] as const).map((role) => <label key={role}>Native {role} option<select aria-label={`${role} option role`} style={control} value={draft.roles[role] ?? ""} onChange={(e) => { const value = e.currentTarget.value; setDraft((d) => { const roles = { ...d.roles }; if (value) roles[role] = value; else delete roles[role]; return { ...d, roles, bindings: d.bindings.map((b) => ({ ...b, reviewed: false })) }; }); }}>
              <option value="">Not mapped</option>{p.options.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
            </select></label>)}</div></details>
            {fabricBindings.length > 6 && <div className="fabric-actions"><p>Showing {currentBindingPage * 6 + 1}-{Math.min((currentBindingPage + 1) * 6, fabricBindings.length)} of {fabricBindings.length} product mappings.</p><button type="button" disabled={currentBindingPage === 0} onClick={() => setBindingPage(currentBindingPage - 1)}>Previous bindings</button><button type="button" disabled={(currentBindingPage + 1) * 6 >= fabricBindings.length} onClick={() => setBindingPage(currentBindingPage + 1)}>Next bindings</button></div>}
            <div className="fabric-table-wrap"><table className="fabric-table"><thead><tr><th scope="col">Fabric</th><th scope="col">Colour</th><th scope="col">Shopify Variant</th><th scope="col">Reference Image</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>{fabricBindings.slice(currentBindingPage * 6, (currentBindingPage + 1) * 6).map((b) => { const f = draft.fabrics.find((x) => x.id === b.fabricId)!, c = f.colours.find((x) => x.id === b.colourId)!;
              const live = p.variants.find((v) => v.id === b.variantId);
              const exact = live && live.selectedOptions.length === Object.keys(b.nativeOptions).length && live.selectedOptions.every((o) => b.nativeOptions[o.name] === o.value);
              const mapped = draft.bindings.filter((other) => other.variantId && other.variantId === b.variantId).length === 1 && !p.warning && f.enabled && c.enabled && b.reviewed && live?.availableForSale && exact && b.referenceMediaIds.length > 0 && b.referenceMediaIds.every((id) => media.some((m) => m.id === id) && !draft.fabrics.some((f) => f.textureMediaId === id || f.colours.some((c) => c.swatchMediaId === id))) && !Object.keys(b.externalValues).length;
              return <tr key={b.id}><td><select aria-label={`Fabric for mapping ${b.id}`} style={control} value={b.fabricId} onChange={(e) => { const target = draft.fabrics.find((x) => x.id === e.currentTarget.value); if (target?.colours[0]) updateBinding(b.id, { fabricId: target.id, colourId: target.colours[0].id, variantId: null, nativeOptions: {}, referenceMediaIds: [] }); }}>{draft.fabrics.map((x) => <option key={x.id} value={x.id} disabled={!x.colours.length}>{x.name}</option>)}</select></td>
              <td><select aria-label={`Colour for mapping ${b.id}`} style={control} value={b.colourId} onChange={(e) => updateBinding(b.id, { colourId: e.currentTarget.value, variantId: null, nativeOptions: {}, referenceMediaIds: [] })}>{f.colours.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td><td>
                <label>Exact Shopify variant<select aria-label={`Variant ${b.id}`} style={control} value={b.variantId ?? ""} onChange={(e) => { const v = p.variants.find((v) => v.id === e.currentTarget.value); updateBinding(b.id, { variantId: v?.id ?? null, nativeOptions: Object.fromEntries(v?.selectedOptions.map((o) => [o.name, o.value]) ?? []) }); }}>
                  <option value="">Not linked - preview blocked</option>{b.variantId && !p.variants.some((v) => v.id === b.variantId) && <option value={b.variantId}>Stale variant - select again</option>}
                  {p.variants.map((v) => <option key={v.id} value={v.id}>{v.selectedOptions.map((o) => `${o.name}: ${o.value}`).join(" / ")} - {v.id.split("/").pop()}{v.availableForSale ? "" : " (unavailable)"}</option>)}
                </select></label>
                <p className="fabric-muted">Every complete native option is preserved. Swatch names do not create purchasable variants.</p>
                </td><td><Sample url={mediaUrl(b.referenceMediaIds[0] ?? null)} label="Full-product reference" round={false} /><details><summary>Edit reference image</summary><MediaField label={`Full-product reference ${f.name} ${c.name} ${b.id}`} kind="reference" sampleIds={sampleIds} value={b.referenceMediaIds[0] ?? null} media={media} change={(id) => updateBinding(b.id, { referenceMediaIds: id ? [id] : [] })} upload={uploadImage} disabled={disabledUpload} />
                </details></td><td><s-badge tone={mapped ? "success" : "warning"}>{mapped ? "Mapped" : "Needs mapping"}</s-badge></td><td><details><summary>Review mapping</summary><label className="fabric-check"><input type="checkbox" checked={b.reviewed} onChange={(e) => updateBinding(b.id, { reviewed: e.currentTarget.checked })} />I reviewed the full product appearance and exact size, headboard, storage and other configuration.</label>
                {draft.roles.composite && <KeyValues label="Reviewed preserved configuration" values={b.preserved} change={(values) => updateBinding(b.id, { preserved: values })} />}
                {(!b.variantId || Object.keys(b.externalValues).length > 0) && <KeyValues label="External option values (saved only; not preview authorization)" values={b.externalValues} change={(values) => updateBinding(b.id, { externalValues: values })} />}
                <p role="status">{p.diagnostics[b.id] ?? "Save to validate this exact reference mapping."}</p>
                <button type="button" onClick={() => { if (confirm("Remove this reference binding?")) setDraft((d) => ({ ...d, bindings: d.bindings.filter((x) => x.id !== b.id) })); }}>Remove binding</button>
              </details></td></tr>;
            })}
</tbody></table></div>{!draft.bindings.length && <p>No mappings yet. Add a mapping to get started.</p>}</section>
          <p className="fabric-muted">Uploads add images to this product's Shopify media/gallery. Save changes after uploading your samples. Removing a Tryora sample or mapping never deletes Shopify images or variants.</p>
          <s-button href={link}>Refresh from Shopify</s-button>
        </fieldset></s-section>}
        <div className="fabric-actions"><s-link href={`/app/customization?product=${encodeURIComponent(p.productId)}`}>Inspect existing integration settings</s-link></div>
      </>}
    </div>
  </s-page>;
}
function KeyValues({ label, values, change }: { label: string; values: Record<string, string>; change: (value: Record<string, string>) => void }) {
  const [name, setName] = useState(""), [value, setValue] = useState("");
  return <fieldset style={{ border: "1px solid #ddd", borderRadius: 8, margin: "12px 0" }}><legend>{label}</legend>
    {Object.entries(values).map(([key, val]) => <div className="fabric-row" key={key}><span>{key}: {val}</span><button type="button" onClick={() => { const next = { ...values }; delete next[key]; change(next); }}>Remove {key}</button></div>)}
    <div className="fabric-grid"><label>Exact option/dimension name<input style={control} value={name} onChange={(e) => setName(e.currentTarget.value)} /></label><label>Exact value<input style={control} value={value} onChange={(e) => setValue(e.currentTarget.value)} /></label></div>
    <button type="button" onClick={() => { if (name.trim() && value.trim()) { change({ ...values, [name]: value }); setName(""); setValue(""); } }}>Add exact value</button>
  </fieldset>;
}

function RgbField({ hex, label, change, invalid }: { hex: string | null; label: string; change: (hex: string | null) => void; invalid: (invalid: boolean) => void }) {
  const display = hexToRgb(hex);
  const [value, setValue] = useState(display);
  useEffect(() => { setValue(display); invalid(false); }, [display]);
  return <div><input aria-label={label} style={control} placeholder="R, G, B" value={value} aria-invalid={!!value && !rgbToHex(value)} onChange={(e) => { const value = e.currentTarget.value; setValue(value); invalid(!!value.trim() && !rgbToHex(value)); if (!value.trim()) change(null); else { const parsed = rgbToHex(value); if (parsed) change(parsed); } }} />{value.trim() && !rgbToHex(value) && <span role="alert">Enter R, G, B from 0 to 255.</span>}</div>;
}
