import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock("../app/db.server", () => ({
  default: {
    assistantTokenUsage: {
      upsert: vi.fn(async (args: any) => { usage.rows.push(args.create); return args.create; }),
      create: vi.fn(async (args: any) => { usage.rows.push(args.data); return args.data; }),
    },
  },
}));

import { checkAssistantRoomPhoto, ROOM_PHOTO_MESSAGES } from "../app/assistant/photo-check.server";
import { setAssistantLogSink } from "../app/assistant/log.server";

const SHOP = "demo.myshopify.com";
const image = (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();
const model = (answer: string | Error) => {
  const create = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return { id: "resp_photo", model: "gpt-4.1-mini", status: "completed", output_text: answer, usage: { input_tokens: 120, output_tokens: 6 } };
  });
  return { client: { responses: { create } } as any, create };
};
const logs: any[] = [];

beforeEach(() => {
  usage.rows.length = 0;
  logs.length = 0;
  setAssistantLogSink((line) => logs.push(JSON.parse(line)));
});

describe("Room Assistant photo check", () => {
  it.each([
    ["room", true],
    ["unclear", false],
    ["unrelated", false],
    ["product_only", false],
  ] as const)("returns the %s verdict with its message", async (verdict, ok) => {
    const { client, create } = model(JSON.stringify({ verdict }));
    const result = await checkAssistantRoomPhoto({ shopId: SHOP, photo: await image(900, 700, "#b8a990"), client, env: {} as any });
    expect(result).toEqual({ ok, verdict, message: ROOM_PHOTO_MESSAGES[verdict], checked: true });
    const request = (create.mock.calls[0] as any[])[0];
    expect(request.store).toBe(false);
    expect(request.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(request.input[0].content[1]).toMatchObject({ type: "input_image", detail: "low" });
    expect(request.input[0].content[1].image_url).toMatch(/^data:image\/jpeg;base64,/);
    // Billed tokens are recorded like other chatbot calls, without any photo content.
    expect(usage.rows).toEqual([expect.objectContaining({ source: "chatbot", shopId: SHOP, inputTokens: 120, outputTokens: 6 })]);
  });

  it("uses the requested wording", () => {
    expect(ROOM_PHOTO_MESSAGES).toEqual({
      room: "Your room photo is ready!",
      unclear: "This photo is a little unclear. Could you upload a clearer picture of your room?",
      unrelated: "This doesn't look like a room photo. Please upload a picture of the room you'd like to furnish.",
      product_only: "I can see the furniture, but I'll need a photo of your room to create a preview.",
    });
  });

  it.each([
    ["a nearly black photo", () => image(900, 700, "#060606")],
    ["a tiny image", () => image(120, 120, "#b8a990")],
    ["unreadable bytes", async () => Buffer.from("not an image at all")],
  ])("rejects %s as unclear without a model call", async (_label, make) => {
    const { client, create } = model(JSON.stringify({ verdict: "room" }));
    const result = await checkAssistantRoomPhoto({ shopId: SHOP, photo: new Uint8Array(await make()), client, env: {} as any });
    expect(result).toMatchObject({ ok: false, verdict: "unclear", message: ROOM_PHOTO_MESSAGES.unclear });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["the model is unavailable", new Error("upstream down")],
    ["the answer is not a known verdict", JSON.stringify({ verdict: "kitchen" })],
  ])("accepts the photo, marked unchecked, when %s", async (_label, answer) => {
    const { client } = model(answer as string | Error);
    const result = await checkAssistantRoomPhoto({ shopId: SHOP, photo: await image(900, 700, "#b8a990"), client, env: {} as any });
    expect(result).toEqual({ ok: true, verdict: "room", message: ROOM_PHOTO_MESSAGES.room, checked: false });
    expect(logs.some((line) => line.event === "room_photo_check_unavailable")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("upstream down");
  });
});
