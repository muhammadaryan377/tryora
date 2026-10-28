// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { replaceWithSafeHtml, setSafeHtml } from "../../packages/storefront/src/html-guard";

describe("storefront HTML allowlist", () => {
  it("removes executable tags and event-handler attributes without dropping plain text", () => {
    const host = document.createElement("div");
    setSafeHtml(host, '<div class="safe" onclick="alert(1)">Hello<script>alert(1)</script><iframe src="https://evil.test"></iframe><img src="javascript:alert(1)" onerror="alert(1)"></div>');
    expect(host.querySelector(".safe")?.textContent).toBe("Hello");
    expect(host.querySelector("script,iframe")).toBeNull();
    expect(host.querySelector("[onclick],[onerror]")).toBeNull();
    expect(host.querySelector("img")?.hasAttribute("src")).toBe(false);
  });

  it("blocks unsafe links and permits canonical Shopify product links", () => {
    const host = document.createElement("div");
    setSafeHtml(host, '<a href="javascript:alert(1)">bad</a><a href="//evil.test/products/bed">off-store</a><a href="/products/aria?variant=11" data-ta="view-details">good</a>');
    const links = [...host.querySelectorAll("a")];
    expect(links[0]?.hasAttribute("href")).toBe(false);
    expect(links[1]?.hasAttribute("href")).toBe(false);
    expect(links[2]?.getAttribute("href")).toBe("/products/aria?variant=11");
    expect(links[2]?.getAttribute("data-ta")).toBe("view-details");
  });

  it("retains accessible inputs, safe room-blob imagery and fixed SVG icons", () => {
    const host = document.createElement("div");
    setSafeHtml(host, '<label for="lead">Email</label><input id="lead" type="email" value="abc@example.com" required><img src="blob:preview" alt="Your room"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4l5 6" fill="none"/></svg>');
    expect(host.querySelector("label")?.getAttribute("for")).toBe("lead");
    expect(host.querySelector("input")?.getAttribute("value")).toBe("abc@example.com");
    expect(host.querySelector("input")?.hasAttribute("required")).toBe(true);
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:preview");
    expect(host.querySelector("svg path")?.getAttribute("d")).toBe("M3 4l5 6");
  });

  it("removes CSS URL execution vectors while keeping approved layout sizes", () => {
    const host = document.createElement("div");
    setSafeHtml(host, '<span style="background:url(https://evil.test/pixel)">bad</span><span style="background-color:#123456;width:40px;border-radius:6px">good</span><img style="flex:0 0 40px;object-fit:cover" src="blob:room">');
    const spans = host.querySelectorAll("span");
    expect(spans[0]?.hasAttribute("style")).toBe(false);
    expect(spans[1]?.getAttribute("style")).toContain("background-color:#123456");
    expect(spans[1]?.getAttribute("style")).toContain("width:40px");
    expect(host.querySelector("img")?.getAttribute("style")).toContain("object-fit:cover");
  });

  it("forces noopener noreferrer for new-tab links", () => {
    const host = document.createElement("div");
    setSafeHtml(host, '<a href="/policies/privacy-policy" target="_blank" rel="opener">Privacy</a>');
    expect(host.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("allows local download URLs only when a download attribute is present", () => {
    const host = document.createElement("div");
    setSafeHtml(host, '<a href="blob:preview">unsafe navigate</a><a href="blob:preview" download="room.jpg">download</a>');
    const links = host.querySelectorAll("a");
    expect(links[0]?.hasAttribute("href")).toBe(false);
    expect(links[1]?.getAttribute("href")).toBe("blob:preview");
  });

  it("replaces a stream entry with sanitized rich text and retains its data attributes", () => {
    const host = document.createElement("div");
    host.append(document.createElement("section"));
    replaceWithSafeHtml(host.firstElementChild!, '<div data-entry="entry1"><strong>Great</strong><ul><li>one</li></ul><img src="data:text/html,bad"></div>');
    expect(host.querySelector("[data-entry='entry1'] strong")?.textContent).toBe("Great");
    expect(host.querySelectorAll("li")).toHaveLength(1);
    expect(host.querySelector("img")?.hasAttribute("src")).toBe(false);
  });
});
