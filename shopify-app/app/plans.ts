// USD, per store, before tax. Shared by billing and the sales report.
export const PLANS = [
  { id: "starter", name: "Starter", price: 29, previews: 100 },
  { id: "growth", name: "Growth", price: 69, previews: 300 },
  { id: "scale", name: "Scale", price: 159, previews: 800 },
] as const;
export const TOP_UP = { price: 25, previews: 100 };
