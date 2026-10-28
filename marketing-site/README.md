# Visully marketing site

One self-contained page (`index.html`) plus `assets/`. No build step, no dependencies.
Fonts load from Google Fonts; everything else is local.

Published as a Claude artifact. To host it anywhere else, serve this folder as static files.

## What the demos are
The hero, the Room Assistant thread and the fabric switcher are HTML/CSS reproductions of the
real app's UI, not screenshots. Copy and prices follow `shopify-app/app/plans.ts`.

- `assets/room-1400.jpg`, `room-700.jpg` — the shopper's empty room, before any preview.
- `assets/result-*.jpg` — the same room photographed with the sofa in it, one per fabric
  (oat, navy, forest, clay). These are real AI composites generated from the empty room, not
  cut-outs pasted on, so the perspective, contact shadow and window light are consistent.
  The hero stacks all four and cross-fades between them, which is what the app actually does.
  `sm-*.jpg` are the smaller copies used in the filmstrip, chat and fabric sections.
- `assets/sofa.webp` — the product photo on white, used only for the chat's catalogue cards.

## Updating prices
Prices appear in the pricing section only. The monthly/annual toggle reads `data-m` / `data-a`
on each plan's price, and `data-a` on `.annual-note`. Keep them in step with `app/plans.ts`.
