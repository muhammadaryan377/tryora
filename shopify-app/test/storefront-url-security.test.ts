import { describe, expect, it } from "vitest";
import { safeImageUrl, safeProductUrl } from "../../packages/storefront/src/assistant/url-security";

describe("storefront navigation URL hardening", () => {
  it.each([
    "/products/aria",
    "/products/aria?variant=11",
    "/products/lit-t%C3%AAte-de-lit",
    "/products/%E5%BA%8A",
    "/products/x_y-z",
  ])("keeps a legitimate relative Shopify product URL: %s", (url) => {
    expect(safeProductUrl(url)).toBe(url);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,alert(1)",
    "//attacker.example/products/bed",
    "https://attacker.example/products/bed",
    "/products/../admin",
    "/products/%2e%2e/admin",
    "/products/%2fadmin",
    "/products/%5Cadmin",
    "/products/bed?redirect=https://attacker.example",
    "/products/bed?variant=11&redirect=https://attacker.example",
    "/products/bed#danger",
    "/products/bed\\danger",
    "/products/a b",
    "/admin",
    "/products/%ZZ",
    "/products/%00bed",
    "/products/bed?variant=not-a-number",
  ])("blocks malicious or out-of-scope product navigation: %s", (url) => {
    expect(safeProductUrl(url)).toBeNull();
  });

  it.each(["https://cdn.shopify.com/aria.jpg", "https://images.example.com/colour.png"])("permits an https thumbnail: %s", (url) => {
    expect(safeImageUrl(url)).toBe(url);
  });

  it.each([
    "javascript:alert(1)",
    "data:image/svg+xml;base64,AAA",
    "blob:untrusted",
    "http://cdn.shopify.com/aria.jpg",
    "https://user:password@cdn.shopify.com/aria.jpg",
    'https://evil.test/a" onerror="alert(1)',
  ])("blocks an unsafe image protocol or attribute payload: %s", (url) => {
    expect(safeImageUrl(url)).toBeNull();
  });

  it("handles wrong types and malformed values safely", () => {
    expect(safeProductUrl(null)).toBeNull();
    expect(safeImageUrl(undefined)).toBeNull();
    expect(safeProductUrl("/products/" + "a".repeat(3000))).toBeNull();
    expect(safeImageUrl("https://example.com/a.png\n")).toBeNull();
  });
});
