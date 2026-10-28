# Visully marketing site

One self-contained page (`index.html`) plus `assets/`. No build step, no dependencies.
Fonts load from Google Fonts; everything else is local.

Published as a Claude artifact. To host it anywhere else, serve this folder as static files.

## What the demos are
The hero, the Room Assistant thread and the fabric switcher are HTML/CSS reproductions of the
real app's UI, not screenshots. Copy and prices follow `shopify-app/app/plans.ts`.

- `assets/room-1400.jpg`, `room-700.jpg` — the shopper's room photo (generated).
- `assets/sofa.webp` — the product cut-out. `sofa-mask.webp` masks the fabric only, so the
  hero's colour switch tints the fabric and leaves the oak legs alone (same idea as the app's
  swatch resolution).
- `assets/result-*.jpg` — pre-rendered composites used in the filmstrip, chat and fabric sections.

## Updating prices
Prices appear in the pricing section only. The monthly/annual toggle reads `data-m` / `data-a`
on each plan's price, and `data-a` on `.annual-note`. Keep them in step with `app/plans.ts`.
