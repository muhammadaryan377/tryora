
// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FabricColourManager,
  type FabricManagerData,
} from "../app/components/fabric-colour-manager";
import { parseFabricDraft } from "../app/customization/fabric-manager";

let root: Root;
let container: HTMLDivElement;

const save = vi.fn();
const upload = vi.fn();

function fixture(): FabricManagerData {
  return {
    installationReady: true,
    advanced: true,
    products: {
      nodes: [
        {
          id: "p1",
          title: "Duke Winged Bed",
        },
      ],
      pageInfo: {
        hasNextPage: false,
        endCursor: null,
      },
    },
    selected: {
      productId: "p1",
      title: "Duke Winged Bed",
      image: null,
      mode: "manual",
      providerId: "manual_mapping",
      revision: "v1",
      diagnostics: {},
      warning: "",
      explicitlyOff: false,
      options: [],
      variants: [],
      media: [],
      native: {
        issue: null,
        optionName: null,
        fabricOptionName: null,
        selections: [],
      },
      syncedAt: "2026-10-25T00:00:00Z",
      saved: false,
      draft: {
        roles: {},
        bindings: [],
        fabrics: [
          {
            id: "linen",
            name: "Linen",
            description: "Soft woven fabric",
            enabled: true,
            textureMediaId: null,
            hex: "#DDDDDD",
            colours: [
              {
                id: "ivory",
                name: "Ivory",
                enabled: true,
                hex: "#E8E0D3",
                swatchMediaId: null,
              },
            ],
          },
        ],
      },
    },
  };
}

function button(text: string): HTMLButtonElement {
  const result = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((b) => b.textContent?.trim() === text);

  if (!result) {
    throw new Error(`Missing button: ${text}`);
  }

  return result;
}

async function render(data: FabricManagerData) {
  await act(async () => {
    root.render(
      React.createElement(FabricColourManager, {
        data,
        save,
        upload,
      })
    );
  });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  save.mockClear();
  upload.mockClear();

  container = document.createElement("div");
  document.body.append(container);

  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });

  container.remove();
});

describe("two-column fabric manager interactions", () => {
  it("offers two shapes and supports typing and single-pixel size steps", async () => {
    const data = fixture();
    data.selected!.draft.swatchAppearance = { shape: "rectangle", size: 50 };
    await render(data);
    expect(container.querySelectorAll('.fm-swatch-prefs .fm-shape')).toHaveLength(2);
    expect(container.querySelector('[aria-label="Rectangle swatches"]')).toBeNull();
    expect(container.querySelector('[aria-label="Square swatches"]')!.getAttribute('aria-pressed')).toBe('true');
    const input = container.querySelector<HTMLInputElement>('[aria-label="Swatch size"]')!;
    const increase = container.querySelector<HTMLButtonElement>('[aria-label="Increase swatch size"]')!;
    const decrease = container.querySelector<HTMLButtonElement>('[aria-label="Decrease swatch size"]')!;
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await type('');
    expect(input.value).toBe('');
    await type('7');
    expect(input.value).toBe('7');
    await type('75');
    expect(container.querySelector<HTMLElement>('.fm-colour .fm-thumb')!.style.width).toBe('75px');
    await act(async () => { increase.click(); });
    expect(input.value).toBe('76');
    await act(async () => { decrease.click(); });
    expect(input.value).toBe('75');
    await type('25');
    expect(decrease.disabled).toBe(true);
    await type('100');
    expect(increase.disabled).toBe(true);
    await act(async () => { button('Save changes').click(); });
    expect(save.mock.calls[0]![1].presentation).toEqual({ shape: 'square', size: 100 });
  });

  it("adds a colour by name alone and keeps optional colour and image controls", async () => {
    const data = fixture();
    data.selected!.draft.fabrics[0]!.hex = null;
    await render(data);
    await act(async () => { button("+ Add colour").click(); });
    const name = container.querySelector<HTMLInputElement>('.fm-colour-editor input[aria-label^="Colour name"]')!;
    const hex = container.querySelector<HTMLInputElement>('.fm-colour-editor input[aria-label^="HEX "]')!;
    const setValue = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    expect(name.required).toBe(true);
    expect(container.querySelector('.fm-colour-editor input[type="color"]')).not.toBeNull();
    expect(container.querySelector('.fm-colour-editor input[type="file"]')).not.toBeNull();
    await setValue(name, "   ");
    expect(button("Save colour").disabled).toBe(true);
    await setValue(name, "Cream");
    expect(button("Save colour").disabled).toBe(false);
    await setValue(hex, "#bad");
    expect(button("Save colour").disabled).toBe(true);
    await setValue(hex, "#AABBCC");
    expect(button("Save colour").disabled).toBe(false);
    await setValue(hex, "");
    await act(async () => { button("Save colour").click(); });
    expect(button("Save changes").disabled).toBe(false);
    await act(async () => { button("Save changes").click(); });
    const saved = parseFabricDraft(save.mock.calls[0]![1]);
    expect(saved.fabrics[0]!.hex).toBeNull();
    expect(saved.fabrics[0]!.colours.at(-1)).toMatchObject({ name: "Cream", hex: null, swatchMediaId: null });
  });

  it(
    "saves shape and size, restores them after reload, and keeps exact mapping drafts intact",
    async () => {
      const data = fixture();

      await render(data);

      // Verify two-column layout.
      expect(
        container.querySelectorAll(".fm-workspace > *")
      ).toHaveLength(2);

      expect(container.textContent).not.toContain(
        "Customer preview"
      );

      // Select square swatches.
      const squareButton =
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Square swatches"]'
        );

      expect(squareButton).not.toBeNull();

      await act(async () => {
        squareButton!.click();
      });

      expect(
        squareButton!.getAttribute("aria-pressed")
      ).toBe("true");

      // Find the controlled swatch-size input.
      const size =
        container.querySelector<HTMLInputElement>(
          '[aria-label="Swatch size"]'
        );

      expect(size).not.toBeNull();

      // Update the input using its native setter.
      // This allows React to detect the actual change.
      await act(async () => {
        const setter =
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
          )?.set;

        if (!setter) {
          throw new Error(
            "Native input value setter not found"
          );
        }

        setter.call(size, "100");

        size!.dispatchEvent(
          new Event("input", { bubbles: true })
        );

        size!.dispatchEvent(
          new Event("change", { bubbles: true })
        );
      });

      // Confirm the swatch has updated dimensions.
      const swatch =
        container.querySelector<HTMLElement>(
          ".fm-colour .fm-thumb"
        );

      expect(swatch).not.toBeNull();

      expect(swatch!.style.width).toBe("100px");
      expect(swatch!.style.height).toBe("100px");

      // Save the configuration.
      await act(async () => {
        button("Save changes").click();
      });

      expect(save).toHaveBeenCalledTimes(1);

      const saved = parseFabricDraft(
        save.mock.calls[0]![1]
      );

      // Confirm the saved appearance.
      expect(saved.presentation).toEqual({
        shape: "square",
        size: 100,
      });

      // Verify fabric data is preserved.
      expect(saved.fabrics).toEqual(
        data.selected!.draft.fabrics
      );

      expect(saved.bindings).toEqual([]);

      // Simulate reloading saved data.
      data.selected = {
        ...data.selected!,
        revision: "v2",
        draft: saved,
        saved: true,
      };

      await render(data);

      // Confirm the square preference is restored.
      const restoredSquare =
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Square swatches"]'
        );

      expect(restoredSquare).not.toBeNull();

      expect(
        restoredSquare!.getAttribute("aria-pressed")
      ).toBe("true");

      const restoredSize =
        container.querySelector<HTMLInputElement>(
          '[aria-label="Swatch size"]'
        );

      expect(restoredSize?.value).toBe("100");
    }
  );

  it(
    "opens colour and fabric editors and blocks page save while a colour is unfinished",
    async () => {
      await render(fixture());

      // Open an existing colour.
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Edit colour Ivory"]'
          )!
          .click();
      });

      expect(
        container.querySelector(".fm-colour-editor")
      ).not.toBeNull();

      // Page save must be blocked during colour editing.
      expect(button("Save changes").disabled).toBe(true);

      // Cancel colour editing.
      await act(async () => {
        button("Cancel").click();
      });

      // Open the fabric editor.
      await act(async () => {
        button("Edit fabric").click();
      });

      expect(
        container.querySelector(
          ".fabric-editor input[type=file]"
        )
      ).not.toBeNull();

      // Close fabric editor.
      await act(async () => {
        button("Done").click();
      });

      // Add a new colour.
      await act(async () => {
        button("+ Add colour").click();
      });

      // Empty colours must not be saved.
      expect(button("Save colour").disabled).toBe(true);

      await act(async () => {
        button("Cancel").click();
      });

      // Advanced settings should still be available.
      expect(
        container.querySelector(
          ".fm-advanced-setup > summary"
        )?.textContent
      ).toContain("Advanced AI preview setup");

      expect(button("+ Add mapping")).toBeDefined();
    }
  );
});
