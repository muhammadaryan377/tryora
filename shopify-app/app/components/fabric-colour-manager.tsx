import { useEffect, useState } from "react";
import { emptyFabricDraft, type FabricDraft, type ManagedFabric, type ManagedBinding } from "../customization/fabric-manager";

type Media = { id: string; url: string };
export interface FabricManagerData {
  installationReady: boolean;
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
  return <span className="fabric-sample" style={{ borderRadius: round ? "50%" : 12, background: hex || "#f6f5f2" }}>
    {url ? <img src={url} alt={label} /> : <span>{hex ? "" : "No image"}</span>}
  </span>;
}
function MediaField({ label, value, media, change, upload, disabled }: { label: string; value: string | null; media: Media[]; change: (id: string | null) => void; upload: (file: File) => Promise<Media | null>; disabled: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [imagePage, setImagePage] = useState(0);
  return <div style={field}>
    <label>{label}<select aria-label={label} style={control} value={value ?? ""} onChange={(e) => change(e.currentTarget.value || null)} disabled={busy}>
      <option value="">No image selected</option>{value && !media.some((m) => m.id === value) && <option value={value}>Removed image - select again</option>}
      {media.map((m) => <option key={m.id} value={m.id}>{m.id.split("/").pop()}</option>)}
    </select></label>
    <div className="fabric-media-choices">{media.slice(imagePage * 24, (imagePage + 1) * 24).map((m) => <button key={m.id} type="button" aria-label={`Use image ${m.id.split("/").pop()} for ${label}`} aria-pressed={m.id === value} onClick={() => change(m.id)}>
      <img src={m.url} alt="Product media" loading="lazy" /></button>)}</div>
    {media.length > 24 && <div className="fabric-actions"><button type="button" disabled={imagePage === 0} onClick={() => setImagePage(imagePage - 1)}>Previous images</button><button type="button" disabled={(imagePage + 1) * 24 >= media.length} onClick={() => setImagePage(imagePage + 1)}>Next images</button></div>}
    <label className="fabric-upload">{busy ? "Uploading image..." : "Upload actual image"}<input aria-label={`Upload ${label}`} type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled || busy} onChange={async (e) => {
      const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (!file) return;
      setBusy(true); setError(""); try { const m = await upload(file); if (m) change(m.id); } catch (err) { setError(err instanceof Error ? err.message : "Upload failed."); } finally { setBusy(false); }
    }} /></label>{error && <p role="alert">{error}</p>}
  </div>;
}
export function FabricColourManager({ data, save, upload, error, busy = false }: {
  data: FabricManagerData; save: (mode: "native" | "manual", draft: FabricDraft) => void;
  upload: (file: File) => Promise<Media | null>; error?: string; busy?: boolean;
}) {
  const p = data.selected;
  const [mode, setMode] = useState<"native" | "manual">(p?.mode ?? "native"), [draft, setDraft] = useState<FabricDraft>(p?.draft ?? emptyFabricDraft());
  const [editColour, setEditColour] = useState(""), [bindingPage, setBindingPage] = useState(0);
  const [step, setStep] = useState(1), [fabricId, setFabricId] = useState(p?.draft.fabrics[0]?.id ?? ""), [media, setMedia] = useState(p?.media ?? []);
  useEffect(() => { setMode(p?.mode ?? "native"); setDraft(p?.draft ?? emptyFabricDraft()); setMedia(p?.media ?? []); setFabricId(p?.draft.fabrics[0]?.id ?? ""); }, [p?.productId, p?.revision]);
  const fabric = draft.fabrics.find((f) => f.id === fabricId), mediaUrl = (id: string | null) => media.find((m) => m.id === id)?.url;
  const updateFabric = (id: string, patch: Partial<ManagedFabric>) => setDraft((d) => {
    const previous = d.fabrics.find((f) => f.id === id)!;
    const renamedColours = new Set((patch.colours ?? []).filter((c) => previous.colours.find((x) => x.id === c.id)?.name !== c.name).map((c) => c.id));
    return { ...d, fabrics: d.fabrics.map((f) => f.id === id ? { ...f, ...patch } : f), bindings: d.bindings.map((b) => b.fabricId === id &&
      (patch.name !== undefined && patch.name !== previous.name || renamedColours.has(b.colourId)) ? { ...b, reviewed: false } : b) };
  });
  const updateBinding = (id: string, patch: Partial<ManagedBinding>) => setDraft((d) => ({ ...d, bindings: d.bindings.map((b) => b.id === id ? { ...b, ...patch, reviewed: patch.reviewed ?? false } : b) }));
  const uploadImage = async (file: File) => { const m = await upload(file); if (m) setMedia((all) => [...all.filter((x) => x.id !== m.id), m]); return m; };
  useEffect(() => setBindingPage(0), [fabricId]);
  const fabricBindings = draft.bindings.filter((b) => !fabricId || b.fabricId === fabricId);
  const currentBindingPage = Math.min(bindingPage, Math.max(0, Math.ceil(fabricBindings.length / 6) - 1));
  const disabledUpload = !data.installationReady || p?.mode !== "manual" || !p?.revision;
  const link = p ? `/app/fabrics?product=${encodeURIComponent(p.productId)}` : "/app/fabrics";
  return <s-page heading="Fabrics & Colours">
    <style>{` .fabric-manager { color:#202223;font:14px/1.5 Inter,system-ui,sans-serif;max-width:1020px;margin:auto } .fabric-manager h2{font-size:20px;margin:16px 0}.fabric-manager h3{font-size:18px;margin:12px 0}.fabric-manager button{font:inherit;cursor:pointer}.fabric-manager label{display:grid;gap:6px}.fabric-manager p{color:#656565}.fabric-manager .fabric-card{border:1px solid #dedede;border-radius:16px;padding:18px;margin:14px 0;background:white}.fabric-manager .fabric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px}.fabric-manager .fabric-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.fabric-manager .fabric-row>*{min-width:0}.fabric-sample{width:68px;height:68px;display:inline-flex;align-items:center;justify-content:center;overflow:hidden;flex:none;font-size:11px;color:#777}.fabric-sample img{width:100%;height:100%;object-fit:cover}.fabric-manager .fabric-tabs{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}.fabric-manager .fabric-tabs button{border:0;border-radius:24px;padding:9px 18px;background:#f4f4f4}.fabric-manager .fabric-tabs button[aria-current=step]{background:#e4e8df;font-weight:600}.fabric-manager .fabric-add{width:100%;border:1px solid #ccc;background:white;border-radius:14px;padding:18px;text-align:left}.fabric-manager .fabric-media-choices{display:flex;gap:7px;overflow-x:auto;max-width:100%;padding:5px}.fabric-media-choices button{border:1px solid #ccc;border-radius:8px;padding:2px;background:white;flex:none;width:54px;height:54px}.fabric-media-choices button[aria-pressed=true]{outline:2px solid #4e6a49}.fabric-media-choices img{width:100%;height:100%;object-fit:cover}.fabric-upload{font-size:13px;color:#525252}.fabric-manager input[type=file]{max-width:100%}.fabric-manager .fabric-muted{font-size:13px;color:#777}.fabric-manager details{overflow-wrap:anywhere}.fabric-manager .fabric-actions{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px}.fabric-manager .fabric-actions button{border:1px solid #ccc;border-radius:8px;padding:8px 12px;background:white}.fabric-manager .fabric-actions button:disabled{opacity:.5;cursor:default}.fabric-manager input[type=checkbox]{width:18px;height:18px}.fabric-manager .fabric-check{display:flex;align-items:center;gap:8px}.fabric-manager .fabric-primary{background:#303d2f!important;color:white;padding:12px 22px!important}.fabric-manager button:focus-visible,.fabric-manager input:focus-visible,.fabric-manager select:focus-visible{outline:3px solid #45633b;outline-offset:3px}`}</style>
    <div className="fabric-manager">
      <s-section heading="Product configuration">
        <label>Shopify product<select aria-label="Shopify product" style={control} value={p?.productId ?? ""} onChange={(e) => { if (e.currentTarget.value) window.location.assign(`/app/fabrics?product=${encodeURIComponent(e.currentTarget.value)}`); }}>
          <option value="">Select a Shopify product</option>{p && !data.products.nodes.some((x) => x.id === p.productId) && <option value={p.productId}>{p.title}</option>}
          {data.products.nodes.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label>
        {data.products.pageInfo.hasNextPage && <s-link href={`${link}${p ? "&" : "?"}after=${encodeURIComponent(data.products.pageInfo.endCursor ?? "")}`}>Next 25 products</s-link>}
        {!p && <p>Select a real Shopify product to manage its fabrics, colours and approved product references.</p>}
      </s-section>
      {p && <>
        <div className="fabric-row" style={{ margin: "20px 0" }}>{p.image && <img src={p.image} alt={p.title} width={72} height={72} style={{ objectFit: "cover", borderRadius: 12 }} />}<div><h2>{p.title}</h2><s-link href={`/app/products/${p.productId.split("/").pop()}`}>Product preview settings</s-link></div></div>
        {error && <s-banner heading="Configuration needs review" tone="critical"><p role="alert">{error}</p></s-banner>}
        {p.saved && !error && <s-banner heading="Configuration saved" tone="success"><p role="status">Mode and product mappings saved. Unreviewed combinations remain blocked.</p></s-banner>}
        {p.explicitlyOff && <s-banner heading="Product previews are OFF" tone="warning"><p>Saving fabrics or switching mode does not enable this product. Review Product preview settings when ready.</p></s-banner>}
        {!data.installationReady && <s-banner heading="Manual setup is not enabled" tone="info"><p>Your app administrator needs to enable merchant-managed customization for this installation. Shopify-native previews continue to work.</p></s-banner>}
        {p.warning && <s-banner heading="Saved mapping needs attention" tone="warning"><p>{p.warning}</p></s-banner>}
        {p.providerId === "cloudlift" && <p>Existing reviewed Cloudlift native-linked mapping is preserved under Manual Setup. Saving does not create an automatic third-party integration.</p>}
        <s-section heading="Configuration mode">
          <label>Mode<select aria-label="Configuration mode" style={control} value={mode} onChange={(e) => setMode(e.currentTarget.value as "native" | "manual")}>
            <option value="native">Shopify Native - Automatic</option><option value="manual">Manual Setup - Merchant Managed</option>
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
        </s-section> : <s-section heading="Manual Fabric & Colour Manager">
          <p>Samples help shoppers choose. Only a reviewed exact variant and a separate approved full-product reference can authorize a preview. External-only configurations remain unready.</p>
          <div className="fabric-tabs" aria-label="Setup steps">{["Fabric", "Colours", "Mapping"].map((label, i) => <button type="button" key={label} aria-current={step === i + 1 ? "step" : undefined} onClick={() => setStep(i + 1)}>{i + 1}. {label}</button>)}</div>
          {draft.fabrics.length > 0 && <label>Fabric<select aria-label="Selected fabric" style={control} value={fabricId} onChange={(e) => setFabricId(e.currentTarget.value)}>{draft.fabrics.map((f) => <option key={f.id} value={f.id}>{f.name || "Unnamed fabric"}</option>)}</select></label>}
          {step === 1 && <>
            {draft.fabrics.map((f) => <div className="fabric-card" key={f.id}>
              <div className="fabric-row"><Sample url={mediaUrl(f.textureMediaId)} label={`${f.name} texture`} round={false} /><h3>{f.name || "New fabric"}</h3></div>
              <div className="fabric-grid"><label>Fabric name<input aria-label={`Fabric name ${f.id}`} style={control} maxLength={140} value={f.name} onChange={(e) => updateFabric(f.id, { name: e.currentTarget.value })} /></label>
                <label>Description<textarea style={control} maxLength={1000} value={f.description} onChange={(e) => updateFabric(f.id, { description: e.currentTarget.value })} /></label></div>
              <MediaField label={`Fabric texture ${f.name}`} value={f.textureMediaId} media={media} change={(id) => updateFabric(f.id, { textureMediaId: id })} upload={uploadImage} disabled={disabledUpload} />
              <label className="fabric-check"><input type="checkbox" checked={f.enabled} onChange={(e) => updateFabric(f.id, { enabled: e.currentTarget.checked })} />Fabric enabled</label>
              <div className="fabric-actions"><button type="button" onClick={() => { setFabricId(f.id); setStep(2); }}>Manage colours</button><button type="button" onClick={() => { if (confirm("Remove this fabric, its colours and their mappings from Tryora? Shopify images and variants are kept.")) setDraft((d) => ({ ...d, fabrics: d.fabrics.filter((x) => x.id !== f.id), bindings: d.bindings.filter((b) => b.fabricId !== f.id) })); }}>Remove fabric</button></div>
            </div>)}
            <button className="fabric-add" type="button" onClick={() => { const id = uid(); setDraft((d) => ({ ...d, fabrics: [...d.fabrics, { id, name: "", description: "", enabled: true, textureMediaId: null, colours: [] }] })); setFabricId(id); }}>+ Add Fabric</button>
          </>}
          {step === 2 && (fabric ? <>
            <h3>{fabric.name || "Fabric"} &rarr; Add Colours</h3>
            {fabric.colours.map((c) => <div className="fabric-card" key={c.id}>
              <div className="fabric-row"><Sample url={mediaUrl(c.swatchMediaId)} hex={c.hex} label={`${fabric.name} ${c.name} swatch`} /><h3>{c.name || "New colour"}</h3></div>
              <p>{!fabric.enabled || !c.enabled ? "Disabled" : p.warning ? "Reference mapping needs review." : draft.bindings.some((b) => b.colourId === c.id && b.reviewed && b.referenceMediaIds.length && b.variantId)
                ? "Full-product reference linked; validated against Shopify on save and each preview." : "Swatch configured \u2014 Preview not ready."}</p>
              <details open={editColour === c.id}><summary onClick={(e) => { e.preventDefault(); setEditColour(editColour === c.id ? "" : c.id); }}>Edit colour and sample</summary>
              <div className="fabric-grid"><label>Colour name<input aria-label={`Colour name ${c.id}`} style={control} maxLength={140} value={c.name} onChange={(e) => updateFabric(fabric.id, { colours: fabric.colours.map((x) => x.id === c.id ? { ...x, name: e.currentTarget.value } : x) })} /></label>
                <label>Optional HEX (#RRGGBB)<input aria-label={`HEX ${c.id}`} style={control} placeholder="#RRGGBB" maxLength={7} value={c.hex ?? ""} onChange={(e) => updateFabric(fabric.id, { colours: fabric.colours.map((x) => x.id === c.id ? { ...x, hex: e.currentTarget.value || null } : x) })} /></label></div>
              {/^#[0-9a-f]{6}$/i.test(c.hex ?? "") && <label className="fabric-muted">Adjust the entered HEX colour<input type="color" aria-label={`Pick HEX ${c.id}`} value={/^#[0-9a-f]{6}$/i.test(c.hex ?? "") ? c.hex! : "#000000"} onChange={(e) => updateFabric(fabric.id, { colours: fabric.colours.map((x) => x.id === c.id ? { ...x, hex: e.currentTarget.value } : x) })} /></label>}
              <MediaField label={`Colour swatch ${fabric.name} ${c.name}`} value={c.swatchMediaId} media={media} change={(id) => updateFabric(fabric.id, { colours: fabric.colours.map((x) => x.id === c.id ? { ...x, swatchMediaId: id } : x) })} upload={uploadImage} disabled={disabledUpload} />
              <label className="fabric-check"><input type="checkbox" checked={c.enabled} onChange={(e) => updateFabric(fabric.id, { colours: fabric.colours.map((x) => x.id === c.id ? { ...x, enabled: e.currentTarget.checked } : x) })} />Colour enabled</label>
              </details>
              <div className="fabric-actions"><button type="button" onClick={() => setStep(3)}>Map product reference</button><button type="button" onClick={() => { if (confirm("Remove this colour and its Tryora mappings? Shopify images and variants are kept.")) { updateFabric(fabric.id, { colours: fabric.colours.filter((x) => x.id !== c.id) }); setDraft((d) => ({ ...d, bindings: d.bindings.filter((b) => b.colourId !== c.id) })); } }}>Remove colour</button></div>
            </div>)}
            <button className="fabric-add" type="button" onClick={() => { const id = uid(); setEditColour(id); updateFabric(fabric.id, { colours: [...fabric.colours, { id, name: "", enabled: true, swatchMediaId: null, hex: null }] }); }}>+ Add another colour</button>
          </> : <p>Add a fabric first, then add its colours.</p>)}
          {step === 3 && <>
            <h3>Map exact product references</h3>
            <div className="fabric-grid">{(["fabric", "colour", "size", "composite"] as const).map((role) => <label key={role}>Native {role} option<select aria-label={`${role} option role`} style={control} value={draft.roles[role] ?? ""} onChange={(e) => { const value = e.currentTarget.value; setDraft((d) => { const roles = { ...d.roles }; if (value) roles[role] = value; else delete roles[role]; return { ...d, roles, bindings: d.bindings.map((b) => ({ ...b, reviewed: false })) }; }); }}>
              <option value="">Not mapped</option>{p.options.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
            </select></label>)}</div>
            {fabricBindings.length > 6 && <div className="fabric-actions"><p>Showing {currentBindingPage * 6 + 1}-{Math.min((currentBindingPage + 1) * 6, fabricBindings.length)} of {fabricBindings.length} bindings for this fabric.</p><button type="button" disabled={currentBindingPage === 0} onClick={() => setBindingPage(currentBindingPage - 1)}>Previous bindings</button><button type="button" disabled={(currentBindingPage + 1) * 6 >= fabricBindings.length} onClick={() => setBindingPage(currentBindingPage + 1)}>Next bindings</button></div>}
            {fabricBindings.slice(currentBindingPage * 6, (currentBindingPage + 1) * 6).map((b) => { const f = draft.fabrics.find((x) => x.id === b.fabricId)!, c = f.colours.find((x) => x.id === b.colourId)!;
              return <div className="fabric-card" key={b.id}><h3>{f.name} / {c.name}</h3>
                <label>Exact Shopify variant<select aria-label={`Variant ${b.id}`} style={control} value={b.variantId ?? ""} onChange={(e) => { const v = p.variants.find((v) => v.id === e.currentTarget.value); updateBinding(b.id, { variantId: v?.id ?? null, nativeOptions: Object.fromEntries(v?.selectedOptions.map((o) => [o.name, o.value]) ?? []) }); }}>
                  <option value="">Not linked - preview blocked</option>{b.variantId && !p.variants.some((v) => v.id === b.variantId) && <option value={b.variantId}>Stale variant - select again</option>}
                  {p.variants.map((v) => <option key={v.id} value={v.id}>{v.selectedOptions.map((o) => `${o.name}: ${o.value}`).join(" / ")} - {v.id.split("/").pop()}{v.availableForSale ? "" : " (unavailable)"}</option>)}
                </select></label>
                <p className="fabric-muted">Every complete native option is preserved. Swatch names do not create purchasable variants.</p>
                <MediaField label={`Full-product reference ${f.name} ${c.name} ${b.id}`} value={b.referenceMediaIds[0] ?? null} media={media} change={(id) => updateBinding(b.id, { referenceMediaIds: id ? [id] : [] })} upload={uploadImage} disabled={disabledUpload} />
                <label className="fabric-check"><input type="checkbox" checked={b.reviewed} onChange={(e) => updateBinding(b.id, { reviewed: e.currentTarget.checked })} />I reviewed the full product appearance and exact size, headboard, storage and other configuration.</label>
                {draft.roles.composite && <KeyValues label="Reviewed preserved configuration" values={b.preserved} change={(values) => updateBinding(b.id, { preserved: values })} />}
                {(!b.variantId || Object.keys(b.externalValues).length > 0) && <KeyValues label="External option values (saved only; not preview authorization)" values={b.externalValues} change={(values) => updateBinding(b.id, { externalValues: values })} />}
                <p role="status">{p.diagnostics[b.id] ?? "Save to validate this exact reference mapping."}</p>
                <button type="button" onClick={() => { if (confirm("Remove this reference binding?")) setDraft((d) => ({ ...d, bindings: d.bindings.filter((x) => x.id !== b.id) })); }}>Remove binding</button>
              </div>;
            })}
            {fabric?.colours.map((c) => <button className="fabric-add" key={c.id} type="button" onClick={() => { setBindingPage(Math.floor(fabricBindings.length / 6)); setDraft((d) => ({ ...d, bindings: [...d.bindings, { id: uid(), fabricId: fabric.id, colourId: c.id, variantId: null, nativeOptions: {}, preserved: {}, externalValues: {}, referenceMediaIds: [], reviewed: false }] })); }}>+ Map {fabric.name} / {c.name} to a variant and full-product reference</button>)}
            {!draft.fabrics.length && <p>Add fabrics and colours before mapping product references.</p>}
          </>}
          <p className="fabric-muted">Uploads add images to this product's Shopify media/gallery. Save Manual Setup before uploading. Removing a Tryora sample or mapping never deletes Shopify images or variants.</p>
          <s-button href={link}>Refresh from Shopify</s-button>
        </s-section>}
        <div className="fabric-actions"><button className="fabric-primary" type="button" disabled={busy || !data.installationReady || mode === "manual" && p.importBlocked} onClick={() => save(mode, draft)}>{busy ? "Validating..." : "Save configuration"}</button><s-link href={`/app/customization?product=${encodeURIComponent(p.productId)}`}>Inspect existing integration settings</s-link></div>
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
