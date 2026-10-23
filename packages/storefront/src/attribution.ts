// Sales attribution shared by the product popup and the Room Assistant.

/**
 * Notes on the shopper's basket that they saw this product in their room. Shopify copies basket notes onto the
 * order, which is how the merchant's dashboard counts sales from Tryora. Underscored notes are hidden from shoppers.
 */
export async function tagBasket(productId: string) {
  try {
    const id = productId.split("/").pop()!;
    const cart = await (await fetch("/cart.js", { credentials: "same-origin" })).json();
    const seen = new Set(String(cart?.attributes?._tryora_products ?? "").split(",").filter(Boolean));
    if (seen.has(id)) return;
    seen.add(id);
    await fetch("/cart/update.js", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: { _tryora: "1", _tryora_products: [...seen].join(",") } }),
    });
  } catch {
    /* never get in the shopper's way */
  }
}
