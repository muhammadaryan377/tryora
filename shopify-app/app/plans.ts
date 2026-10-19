// Agreed pricing (build brief section 9). USD, per store, before tax. Shared by billing and the sales report.
export const PLANS = [
  { id: "starter", name: "Starter", price: 34.8, previews: 100 },
  { id: "growth", name: "Growth", price: 82.8, previews: 250 },
  { id: "scale", name: "Scale", price: 178.8, previews: 600 },
] as const;
export const TOP_UP = { price: 34.8, previews: 100 };
