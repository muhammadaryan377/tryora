// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FabricColourManager, type FabricManagerData } from "../app/components/fabric-colour-manager";
import { parseFabricDraft } from "../app/customization/fabric-manager";
let root: Root, container: HTMLDivElement;
const save = vi.fn(), upload = vi.fn();
function fixture(): FabricManagerData {
  return { installationReady: true, products: { nodes: [{ id: "p1", title: "Duke Winged Bed" }], pageInfo: { hasNextPage: false, endCursor: null } }, selected: {
    productId: "p1", title: "Duke Winged Bed", image: null, mode: "manual", providerId: "manual_mapping", revision: "v1", diagnostics: {}, warning: "", explicitlyOff: false,
    options: [], variants: [], media: [], native: { issue: null, optionName: null, fabricOptionName: null, selections: [] }, syncedAt: "2026-10-25T00:00:00Z", saved: false,
    draft: { roles: {}, bindings: [], fabrics: [{ id: "linen", name: "Linen", description: "Soft woven fabric", enabled: true, textureMediaId: null, colours: [{ id: "ivory", name: "Ivory", enabled: true, hex: "#E8E0D3", swatchMediaId: null }] }] },
  } };
}
function button(text: string) { const result = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text); if (!result) throw new Error(`Missing ${text}`); return result; }
async function render(data: FabricManagerData) { await act(async () => root.render(React.createElement(FabricColourManager, { data, save, upload }))); }
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; save.mockClear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe('two-column fabric manager interactions', () => {
  it('saves shape and size, restores them after reload, and keeps exact mapping drafts intact', async () => {
    const data = fixture(); await render(data);
    expect(container.querySelectorAll('.fm-workspace > *')).toHaveLength(2);
    expect(container.textContent).not.toContain('Customer preview');
    await act(async () => button('Rectangle').click());
    const size = container.querySelector<HTMLSelectElement>('[aria-label="Swatch size"]')!;
    await act(async () => { size.value = '100'; size.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector<HTMLElement>('.fm-colour .fm-thumb')!.style.height).toBe('70px');
    await act(async () => button('Save changes').click());
    const saved = parseFabricDraft(save.mock.calls[0]![1]);
    expect(saved.swatchAppearance).toEqual({ shape: 'rectangle', size: 100 });
    expect(saved.fabrics).toEqual(data.selected!.draft.fabrics);
    expect(saved.bindings).toEqual([]);
    data.selected = { ...data.selected!, revision: 'v2', draft: saved, saved: true }; await render(data);
    expect(button('Rectangle').getAttribute('aria-pressed')).toBe('true');
    expect(size.value).toBe('100');
  });
  it('opens colour and fabric editors and blocks page save while a colour is unfinished', async () => {
    await render(fixture());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit colour Ivory"]')!.click());
    expect(container.querySelector('.fm-colour-editor')).not.toBeNull();
    expect(button('Save changes').disabled).toBe(true);
    await act(async () => button('Cancel').click());
    await act(async () => button('Edit fabric').click());
    expect(container.querySelector('.fabric-editor input[type=file]')).not.toBeNull();
    await act(async () => button('Done').click());
    await act(async () => button('+ Add colour').click());
    expect(button('Save colour').disabled).toBe(true);
    await act(async () => button('Cancel').click());
    expect(container.querySelector('#fm-mapping > summary')?.textContent).toContain('Advanced settings');
    expect(button('+ Add mapping')).toBeDefined();
  });
});
