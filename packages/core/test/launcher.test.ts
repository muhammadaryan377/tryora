import { describe, expect, it } from "vitest";
import { defaultLauncher, launchersToRender, validateLauncher } from "../src/launcher.js";

describe("launcher settings", () => {
  it("defaults to a Tryora button with 'See it in your room'", () => {
    const s = defaultLauncher("gallery");
    expect(s.mode).toBe("tryora");
    expect(s.wording).toBe("See it in your room");
  });

  it("Studio uses the theme's own button colour", () => {
    expect(defaultLauncher("studio").background).toBeNull();
  });

  it("'own button only' hides Tryora buttons but keeps custom triggers working", () => {
    const s = { ...defaultLauncher("gallery"), mode: "own" as const };
    expect(launchersToRender(s, "desktop")).toEqual({ tryora: null, listenForOwn: true });
  });

  it("'both' shows one Tryora launcher and listens for custom triggers", () => {
    const s = { ...defaultLauncher("hearth"), mode: "both" as const, type: "floating" as const };
    expect(launchersToRender(s, "mobile")).toEqual({ tryora: "floating", listenForOwn: true });
  });

  it("respects device visibility", () => {
    const s = { ...defaultLauncher("noir"), showOnMobile: false };
    expect(launchersToRender(s, "mobile").tryora).toBeNull();
    expect(launchersToRender(s, "desktop").tryora).toBe("overlay");
  });

  it("validates merchant input", () => {
    expect(validateLauncher(defaultLauncher("gallery"))).toEqual([]);
    const bad = { ...defaultLauncher("gallery"), wording: " ", background: "blue", showOnMobile: false, showOnDesktop: false };
    expect(validateLauncher(bad)).toHaveLength(3);
    // Hidden on both devices is fine when the merchant uses only their own button.
    expect(validateLauncher({ ...defaultLauncher("gallery"), mode: "own", showOnMobile: false, showOnDesktop: false })).toEqual([]);
  });
});
