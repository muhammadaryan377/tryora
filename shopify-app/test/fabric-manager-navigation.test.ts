// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricColourManager, type FabricManagerData } from "../app/components/fabric-colour-manager";
import { emptyFabricDraft } from "../app/customization/fabric-manager";

const FIRST = "gid://shopify/Product/101";
const SECOND = "gid://shopify/Product/202";
const products = { nodes: [{ id: FIRST, title: "Aspen Bed" }, { id: SECOND, title: "Aria Bed" }], pageInfo: { hasNextPage: false, endCursor: null } };

const base: FabricManagerData = { installationReady: true, products, selected: null };
const selected: FabricManagerData["selected"] = {
  productId: FIRST, title: "Aspen Bed", image: null, mode: "native", providerId: "shopify_native",
  revision: "rev1", draft: emptyFabricDraft(), diagnostics: {}, warning: "", explicitlyOff: false,
  options: [], variants: [], media: [],
  native: { issue: null, optionName: null, fabricOptionName: null, selections: [] },
  syncedAt: "2026-10-25T10:00:00.000Z", saved: false,
};

const roots: Root[] = [];
const hosts: HTMLDivElement[] = [];
async function mount(data: FabricManagerData, selectProduct: (id: string) => void, save: (mode: "native" | "manual", draft: any) => void = () => {}) {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(FabricColourManager, {
      data, selectProduct, save, upload: async () => null,
    }));
  });
  return host;
}
async function choose(host: HTMLElement, id: string) {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Shopify product"]');
  expect(select).not.toBeNull();
  await act(async () => {
    select!.value = id;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const host of hosts.splice(0)) host.remove();
});

describe("embedded Fabrics & Colours product navigation", () => {
  it("shows round/square shape and 25-100px swatch size with a 50px default", async () => {
    const draft = emptyFabricDraft();
    draft.fabrics.push({ id: "linen", name: "Linen", description: "", enabled: true, textureMediaId: null, hex: "#dad4c7",
      colours: [{ id: "cream", name: "Cream", enabled: true, hex: "#f5eee4", swatchMediaId: null }] });
    const save = vi.fn();
    const host = await mount({ ...base, startInManualMode: true, selected: { ...selected!, mode: "manual", draft } }, vi.fn(), save);
    const round = host.querySelector<HTMLButtonElement>('button[aria-label="Circle swatches"]')!;
    const square = host.querySelector<HTMLButtonElement>('button[aria-label="Square swatches"]')!;
    const size = host.querySelector<HTMLInputElement>('input[aria-label="Swatch size"]')!;
    expect(round.getAttribute("aria-pressed")).toBe("true");
    expect(size.value).toBe("50");
    expect(size.min).toBe("25"); expect(size.max).toBe("100");
    await act(async () => { square.click(); });
    expect(square.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { size.value = "100"; size.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { host.querySelector<HTMLButtonElement>(".fm-save button")!.click(); });
    expect(save).toHaveBeenCalledTimes(1);
    const sent = save.mock.calls[0]?.[1];
    expect(sent.presentation?.shape).toBe("square");
    expect(sent.presentation?.size).toBeGreaterThanOrEqual(25);
    expect(sent.presentation?.size).toBeLessThanOrEqual(100);
    expect(sent.fabrics[0]?.hex).toBe("#dad4c7");
  });

  it("blocks saving a name-only fabric or a colour without HEX/image", async () => {
    const draft = emptyFabricDraft();
    draft.fabrics.push({ id: "linen", name: "Linen", description: "", enabled: true, textureMediaId: null, hex: null,
      colours: [{ id: "cream", name: "Cream", enabled: true, hex: null, swatchMediaId: null }] });
    const host = await mount({ ...base, startInManualMode: true, selected: { ...selected!, mode: "manual", draft } }, vi.fn());
    expect(host.querySelector<HTMLButtonElement>(".fm-save button")!.disabled).toBe(true);
    expect(host.textContent).toContain("Each fabric and colour needs a name plus a HEX colour or sample image");
  });


  it("opens the screenshot's Manual Setup editor for a selected product without saving anything", async () => {
    const save = vi.fn(), navigate = vi.fn();
    const host = await mount({ ...base, startInManualMode: true, selected }, navigate, save);
    const mode = host.querySelector<HTMLSelectElement>('select[aria-label="Configuration mode"]');
    expect(mode?.value).toBe("manual");
    expect(host.textContent).toContain("Aspen Bed");
    expect(host.textContent).toContain("Untitled fabric");
    expect(host.textContent).toContain("0 colours");
    expect(host.textContent).toContain("Each fabric and colour needs a name plus a HEX colour or sample image before saving.");
    expect(host.textContent).toContain("Unsaved changes");
    expect(save).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>(".fm-save button")?.disabled).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps saved merchant fabrics rather than replacing them with an untitled draft", async () => {
    const draft = emptyFabricDraft();
    draft.fabrics.push({ id: "saved_velvet", name: "Plush Velvet", description: "", enabled: true, textureMediaId: null,
      colours: [{ id: "cream", name: "Cream", enabled: true, hex: "#e7decf", swatchMediaId: null }] });
    const host = await mount({ ...base, startInManualMode: true, selected: { ...selected!, mode: "manual", draft } }, vi.fn());
    expect(host.textContent).toContain("Plush Velvet");
    expect(host.textContent).toContain("Cream");
    expect(host.textContent).not.toContain("Untitled fabric");
    expect(host.textContent).toContain("No unsaved changes");
  });

  it("does not bypass the server's manual-setup rollout gate", async () => {
    const host = await mount({ ...base, installationReady: false, startInManualMode: true, selected }, vi.fn());
    const mode = host.querySelector<HTMLSelectElement>('select[aria-label="Configuration mode"]');
    expect(mode?.value).toBe("native");
    expect(host.textContent).not.toContain("Untitled fabric");
    expect(host.textContent).toContain("Your app administrator needs to authorize merchant-managed customization for this installation.");
  });

  it("delegates product selection to the authenticated client router", async () => {
    const navigate = vi.fn();
    const host = await mount(base, navigate);
    await choose(host, FIRST);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(FIRST);
  });

  it("asks before discarding unsaved fabric manager edits during SPA navigation", async () => {
    const navigate = vi.fn();
    const host = await mount({ ...base, selected }, navigate);
    const mode = host.querySelector<HTMLSelectElement>('select[aria-label="Configuration mode"]')!;
    await act(async () => { mode.value = "manual"; mode.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.textContent).toContain("Unsaved changes");

    await choose(host, SECOND);
    expect(navigate).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Switch products without saving them?");
    await act(async () => {
      [...host.querySelectorAll("button")].find((button) => button.textContent === "Keep editing")!.click();
    });
    expect(navigate).not.toHaveBeenCalled();

    await choose(host, SECOND);
    await act(async () => {
      [...host.querySelectorAll("button")].find((button) => button.textContent === "Discard changes and switch")!.click();
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(SECOND);
  });
});
