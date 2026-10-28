# Release verification - 28 October 2026

This report supersedes the earlier verification of the older integration branch.
Latest origin/main (72e9f10) was merged into the integration worktree, preserving
its billing, privacy, lead verification, fabric/colour selection and media changes.
The merge does not deploy Railway or merge the integration branch into main.

## Results

- Full workspace suite with TRYORA_E2E=1: 839 passed, 10 skipped, zero failures.
  Core: 75 passed. Shopify app: 764 passed, including 31 browser tests.
- Full workspace production build: passed with the merged source.
- Full workspace typecheck, including Prisma client generation: passed.
- Git diff whitespace/conflict checks: passed.

## Preserved requirements

- Chatbot Required email collection blocks generation until submission.
- Skippable leads permit Skip through the server endpoint. Existing tests also
  cover after-first-preview timing and rejection of forged client lead flags.
- Browser tests select an exact fabric/colour variant, require explicit Generate
  confirmation, and check one preview job, matching variant and delivery ack.
- Verified replies stream progressively over SSE and long-poll, including short
  replies. Raw model drafts remain buffered until tool validation and formatting.
  Chunk size was reduced from 56 to 16 characters so short replies also progress.
- Cancellation stops subsequent verified chunks and prevents a final event.
- Fabric samples use Shopify Files, with save/reload and gallery isolation checks.
- Square/Circle swatch controls and incomplete mapping checks remain covered.

No approved lead or progressive streaming test was removed to accept a regression.
The earlier no-email assertion was replaced with Required/Skippable browser flows.
Proxy polling/cancel fixtures now use /apps/visully to match the latest main.

## Limits

Ten existing opt-in tests for live Shopify data, isolated PostgreSQL and paid AI
remain skipped. Browser tests use local Shopify/Prisma/model fixtures. These
results do not establish live billing, fresh install, webhook delivery, paid image
quality or Shopify App Store approval. No production database mutation was run.
