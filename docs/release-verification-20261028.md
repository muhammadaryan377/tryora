# Release verification — 28 October 2026

Verified in the `tryora-assistant-v2` worktree. This is local verification;
the deployed Railway backend is a different revision and was not replaced.

## Results

- Full workspace suite with `TRYORA_E2E=1`: 771 passed, 10 skipped, zero failures.
  Core: 75 passed. Shopify app: 696 passed, including 30 browser tests.
- Full workspace `npm run typecheck`: passed after the test updates.
- Full workspace `npm run build`: passed during the preceding audit; subsequent
  changes affect test fixtures/assertions and explanatory comments only.
- `git diff --check`: passed.

## Changes

Updated stale assertions for the current welcome text, photo-first navigation,
Square swatch controls, numeric swatch size input and advanced mapping section.
The fabric browser fixture now models standalone Shopify Files creation,
processing and saved-file lookup. It also checks that uploaded samples stay
out of the product media gallery.

Assistant transport tests verify progress and the grounded final text instead
of expecting raw model fragments. Chat preview tests retain exact product and
variant assertions, explicit Generate confirmation, a single generated job and
delivery acknowledgement. They verify the current no-email chat behavior,
including when legacy lead settings are present. No test was newly skipped.
Application behavior was not changed to make the tests pass.

## Limits

The 10 existing opt-in tests for live Shopify data, isolated PostgreSQL and paid
AI generation remain skipped. Browser tests use local Shopify/Prisma/model
fixtures. These results do not establish live billing, fresh installation,
webhook delivery, paid image quality or Shopify App Store approval.

The user independently confirmed that the production Privacy requests page
loads and Prisma reports all five migrations applied after the manual table
repair. This audit did not independently query production or rerun that repair.
