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
async function mount(data: FabricManagerData, selectProduct: (id: string) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(FabricColourManager, {
      data, selectProduct, save: () => {}, upload: async () => null,
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
  it("delegates product selection to the authenticated client router", async () => {
    const navigate = vi.fn();
    const host = await mount(base, navigate);
    await choose(host, FIRST);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(FIRST);
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
    expect(navigate).toHaveBeenCalledExactlyOnceWith(SECOND);
  });
});
