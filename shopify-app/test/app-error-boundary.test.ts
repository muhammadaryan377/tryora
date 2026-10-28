import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const state = vi.hoisted(() => ({ error: undefined as unknown, shopifyError: vi.fn() }));
vi.mock("react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-router")>(),
  useRouteError: () => state.error,
}));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { error: state.shopifyError, headers: vi.fn() },
}));
import { ErrorBoundary } from "../app/routes/app";

beforeEach(() => vi.clearAllMocks());

describe("embedded app error recovery", () => {
  it.each([
    new Error("private database credentials"),
    { status: 503, statusText: "Unavailable", internal: false, data: "private SQL" },
  ])("shows recovery without exposing internal failure details", (error) => {
    state.error = error;
    const html = renderToStaticMarkup(createElement(ErrorBoundary));
    expect(html).toContain("Unable to load this page");
    expect(html).toContain("Try again");
    expect(html).toContain('href="/app"');
    expect(html).not.toContain("private");
    expect(state.shopifyError).not.toHaveBeenCalled();
  });

  it("preserves Shopify authentication response handling", () => {
    state.error = { status: 401, statusText: "Unauthorized", internal: false, data: "auth response" };
    state.shopifyError.mockReturnValue(null);
    ErrorBoundary();
    expect(state.shopifyError).toHaveBeenCalledWith(state.error);
  });
});
