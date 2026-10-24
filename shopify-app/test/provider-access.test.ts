import { describe, expect, it } from "vitest";
import { providerAccess } from "../app/customization/provider-access.server";
const enabled = { TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED: "true" };
describe("operator-managed installation authorization", () => {
 it("requires the exact master rollout flag even for an allowlisted shop", () => {
  for (const flag of [undefined, "false", "TRUE", "1"]) expect(providerAccess("allowed.myshopify.com", { TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED: flag, TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS: "allowed.myshopify.com" }).enabled).toBe(false);
 });
 it("preserves existing explicit global opt-in when no scoped policy exists", () => {
  expect(providerAccess("existing.myshopify.com", enabled)).toEqual({ enabled: true, reason: null });
  expect(providerAccess("", enabled).enabled).toBe(false);
 });
 it("matches exact canonical installation hostnames, allowing case normalization", () => {
  const env = { ...enabled, TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS: " Allowed.myshopify.com , second.myshopify.com " };
  expect(providerAccess("ALLOWED.myshopify.com", env).enabled).toBe(true);
  for (const shop of ["other.myshopify.com", "allowed.myshopify.com.evil.com", "notallowed.myshopify.com", "https://allowed.myshopify.com", " allowed.myshopify.com"]) expect(providerAccess(shop, env).enabled).toBe(false);
 });
 it.each(["", "   ", "*", "allowed.myshopify.com,", "https://allowed.myshopify.com", "allowed.myshopify.com,evil.com", "allowed.myshopify.com;second.myshopify.com"])("denies an empty or malformed policy %j instead of broadening access", (policy) => {
  expect(providerAccess("allowed.myshopify.com", { ...enabled, TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS: policy }).enabled).toBe(false);
 });
 it("does not cache a revoked grant", () => {
  const env = { ...enabled, TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS: "allowed.myshopify.com" };
  expect(providerAccess("allowed.myshopify.com", env).enabled).toBe(true);
  env.TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS = "";
  expect(providerAccess("allowed.myshopify.com", env).enabled).toBe(false);
 });
});
