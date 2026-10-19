import { describe, expect, it } from "vitest";
import { initialFlow, isViewed, reduce, type FlowEvent, type FlowState } from "../src/flow.js";

function run(state: FlowState, ...events: FlowEvent[]) {
  const commands: string[] = [];
  for (const e of events) {
    const t = reduce(state, e);
    state = t.state;
    commands.push(...t.commands.map((c) => c.type));
  }
  return { state, commands };
}

const ready: FlowEvent[] = [
  { type: "PHOTO_SELECTED", photoId: "room-1" },
  { type: "PHOTO_CHECKED", check: { status: "ok", detected: "existing_item" } },
];

const deliver = (option: string): FlowEvent => ({
  type: "JOB_DELIVERED",
  result: { option, imageHandle: `blob:${option}`, jobId: `job-${option}` },
});

describe("popup flow", () => {
  it("asks for the email before the first generation only", () => {
    let s = initialFlow({ leadMode: "required", defaultOption: "Oat" });
    let r = run(s, ...ready, { type: "GENERATE_PRESSED" });
    expect(r.state.step).toBe("emailStep");
    expect(r.commands).not.toContain("CREATE_PREVIEW");

    r = run(r.state, { type: "LEAD_SUBMITTED" });
    expect(r.state.step).toBe("generating");
    expect(r.commands).toEqual(["SUBMIT_LEAD", "CREATE_PREVIEW"]);

    r = run(r.state, deliver("Oat"), { type: "TRY_ANOTHER_COLOUR" }, { type: "SELECT_OPTION", option: "Olive" }, { type: "GENERATE_PRESSED" });
    expect(r.state.step).toBe("generating"); // no second email step
    expect(r.commands).toEqual(["CREATE_PREVIEW"]);
  });

  it("required email cannot be skipped; skippable email can", () => {
    const req = run(initialFlow({ leadMode: "required", defaultOption: "Oat" }), ...ready, { type: "GENERATE_PRESSED" }, { type: "LEAD_SKIPPED" });
    expect(req.state.step).toBe("emailStep");
    const skip = run(initialFlow({ leadMode: "skippable", defaultOption: "Oat" }), ...ready, { type: "GENERATE_PRESSED" }, { type: "LEAD_SKIPPED" });
    expect(skip.state.step).toBe("generating");
  });

  it("Try another colour returns to step 2 with the same photo, and marks viewed colours", () => {
    const { state } = run(initialFlow({ leadMode: "off", defaultOption: "Oat" }), ...ready, { type: "GENERATE_PRESSED" }, deliver("Oat"), { type: "TRY_ANOTHER_COLOUR" });
    expect(state.step).toBe("photoReady");
    expect(state.photo?.id).toBe("room-1");
    expect(isViewed(state, "Oat")).toBe(true);
    expect(isViewed(state, "Olive")).toBe(false);
  });

  it("re-viewing an already generated colour is instant and creates no job", () => {
    const r = run(
      initialFlow({ leadMode: "off", defaultOption: "Oat" }),
      ...ready,
      { type: "GENERATE_PRESSED" },
      deliver("Oat"),
      { type: "TRY_ANOTHER_COLOUR" },
    );
    const again = run(r.state, { type: "SELECT_OPTION", option: "Oat" }, { type: "GENERATE_PRESSED" });
    expect(again.state.step).toBe("result");
    expect(again.state.shownOption).toBe("Oat");
    expect(again.commands).not.toContain("CREATE_PREVIEW");
  });

  it("Use a different room returns to step 2 with the photo cleared and releases old images", () => {
    const r = run(initialFlow({ leadMode: "off", defaultOption: "Oat" }), ...ready, { type: "GENERATE_PRESSED" }, deliver("Oat"));
    const next = run(r.state, { type: "USE_DIFFERENT_ROOM" });
    expect(next.state.step).toBe("photoReady");
    expect(next.state.photo).toBeNull();
    expect(next.state.selectedOption).toBe("Oat"); // colour choice kept
    expect(Object.keys(next.state.results)).toHaveLength(0);
    expect(next.commands).toContain("RELEASE_IMAGES");
  });

  it("locks colour changes while a job runs", () => {
    const r = run(initialFlow({ leadMode: "off", defaultOption: "Oat" }), ...ready, { type: "GENERATE_PRESSED" }, { type: "SELECT_OPTION", option: "Rust" });
    expect(r.state.selectedOption).toBe("Oat");
    expect(r.state.generation?.option).toBe("Oat");
  });

  it("a failed later attempt keeps the earlier successful result", () => {
    const r = run(
      initialFlow({ leadMode: "off", defaultOption: "Oat" }),
      ...ready,
      { type: "GENERATE_PRESSED" },
      deliver("Oat"),
      { type: "TRY_ANOTHER_COLOUR" },
      { type: "SELECT_OPTION", option: "Olive" },
      { type: "GENERATE_PRESSED" },
      { type: "JOB_FAILED", reason: "generation_failed" },
    );
    expect(r.state.step).toBe("result");
    expect(r.state.shownOption).toBe("Oat");
    expect(r.state.notice).toBe("generation_failed");
  });

  it("cannot generate until the photo check passes", () => {
    const r = run(
      initialFlow({ leadMode: "off", defaultOption: "Oat" }),
      { type: "PHOTO_SELECTED", photoId: "room-1" },
      { type: "GENERATE_PRESSED" },
      { type: "PHOTO_CHECKED", check: { status: "needsCorrection", reason: "wrong_angle" } },
      { type: "GENERATE_PRESSED" },
    );
    expect(r.state.step).toBe("photoReady");
    expect(r.commands).not.toContain("CREATE_PREVIEW");
  });

  it("ignores a late result after the shopper changed room", () => {
    const r = run(
      initialFlow({ leadMode: "off", defaultOption: "Oat" }),
      ...ready,
      { type: "GENERATE_PRESSED" },
      { type: "REMOVE_PHOTO" }, // blocked while generating
    );
    expect(r.state.photo?.id).toBe("room-1");
  });
});

import { photoNote } from "../src/flow.js";
import { defaultPlacement } from "../src/provider.js";

describe("product-agnostic copy", () => {
  it("shows the existing-item note only when an item was detected", () => {
    expect(photoNote({ status: "ok", detected: "existing_item" }, "bed")).toBe("Existing bed detected – we'll replace it");
    expect(photoNote({ status: "ok", detected: "empty_space" }, "bed")).toBe("Empty space – we'll place it here");
    expect(photoNote({ status: "ok", detected: "wall" }, "wallpaper")).toBe("Wall detected");
    expect(photoNote({ status: "ok" }, "sofa")).toBeNull(); // unsure: no note
    expect(photoNote({ status: "checking" }, "sofa")).toBeNull();
  });

  it("picks a sensible default placement from the product type", () => {
    expect(defaultPlacement("Sofa")).toBe("replace");
    expect(defaultPlacement("Wool rug")).toBe("floor_cover");
    expect(defaultPlacement("Wallpaper")).toBe("wall_cover");
    expect(defaultPlacement("Ceiling pendant")).toBe("light");
    expect(defaultPlacement("Ottoman")).toBe("replace");
  });
});

import { photoProblemMessage } from "../src/flow.js";

describe("photos that don't make sense", () => {
  it("a grass field for a sofa is blocked before any credit is used", () => {
    const r = run(
      initialFlow({ leadMode: "off", defaultOption: "Oat" }),
      { type: "PHOTO_SELECTED", photoId: "field" },
      { type: "PHOTO_CHECKED", check: { status: "needsCorrection", reason: "not_a_room" } },
      { type: "GENERATE_PRESSED" },
    );
    expect(r.state.step).toBe("photoReady");
    expect(r.commands).not.toContain("CREATE_PREVIEW");
    expect(photoProblemMessage("not_a_room", "sofa")).toContain("doesn't look like a room");
  });

  it("garden furniture asks for an outdoor photo instead", () => {
    expect(photoProblemMessage("wrong_setting", "bench", "outdoor")).toContain("outdoor spaces");
    expect(photoProblemMessage("not_a_room", "bench", "outdoor")).toContain("patio");
  });
});
