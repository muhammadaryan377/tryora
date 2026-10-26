import { describe, expect, it } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { loader } from "../app/routes/_index/route";

describe("app launch", () => {
  it.each([
    ["", "/app"],
    ["?embedded=1&host=encoded-host", "/app?embedded=1&host=encoded-host"],
    ["?shop=demo.myshopify.com&host=encoded-host&hmac=signed", "/app?shop=demo.myshopify.com&host=encoded-host&hmac=signed"],
  ])("opens Home and preserves launch context: %s", (query, destination) => {
    try {
      loader({ request: new Request(`https://app.example/${query}`) } as LoaderFunctionArgs);
      expect.fail("Expected a Home redirect");
    } catch (response) {
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(302);
      expect((response as Response).headers.get("Location")).toBe(destination);
    }
  });
});
