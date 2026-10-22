import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createImageProvider } from "../app/image-provider.server";
import { MAX_IMAGE_BYTES } from "../app/preview-images.server";

// Never uses a real API unless explicitly enabled. Inputs are local files; output is not saved.
describe.skipIf(process.env.TRYORA_OPENAI_SMOKE !== "1")("opt-in paid OpenAI smoke test", () => {
  it("edits a real room using the selected product", async () => {
    const load = async (name: string) => {
      const path = process.env[name];
      if (!path || (await stat(path)).size > MAX_IMAGE_BYTES) throw new Error(`Set ${name} to an image under 8 MiB`);
      return readFile(path);
    };
    const provider = createImageProvider({ ...process.env, IMAGE_PROVIDER: "openai" });
    const request = { roomImage: await load("TRYORA_SMOKE_ROOM"), productReferences: [await load("TRYORA_SMOKE_PRODUCT")],
      productDescription: process.env.TRYORA_SMOKE_DESCRIPTION ?? "Selected bed in the product photograph", itemNoun: "bed", optionValue: "as photographed", placement: "replace" as const };
    const result = await provider.generate(request);
    expect(result.image.length).toBeGreaterThan(0);
    expect((await provider.checkResult(request, result)).outcome).toBe("accepted");
  }, 170_000);
});
