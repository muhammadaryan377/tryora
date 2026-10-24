# Approved Room Assistant UI — 24 October 2026

Branch: feat/approved-room-assistant-ui.
Base: a44efe4, including the premium selector fixes and Claude's 59510c3, bbf7edb,
5223bec conversation-state fixes. Implementation is local only.

## Application changes

- packages/storefront/src/assistant/drawer.ts: approved three-card welcome, camera
  badges, separate preview/recommendation photo-choice screens, back navigation,
  lightweight inline SVG room illustrations, composer camera sheet and keyboard focus.
- packages/storefront/src/main.ts: pass the verified preview configuration's item noun
  into the drawer. Unknown categories use "product"; no current product offers a
  catalogue-selection flow rather than implying a selected bed.
- shopify-app/extensions/tryora-theme/assets/tryora.css: cream/olive photo panels,
  rounded cards, serif headings, circular camera controls and responsive two-column
  photo choices. Header and composer remain outside the scrolling content.
- shopify-app/extensions/tryora-theme/assets/tryora.js: rebuilt from source.
- shopify-app/test/room-assistant-ui.test.ts and assistant-browser.e2e.test.ts:
  updated navigation assertions and new behavioral/rendering regressions.

No backend, database, API scopes, checkout, provider authorization, approved-reference
resolver, billing or credit rules were changed.

## Three distinct intents

1. Preview current product opens a photo-choice screen. A valid attachment returns to
   the composer with the preview request drafted, preserving the current product and
   live variant context. Sending enters the existing verified card, eligibility, email,
   Generate Preview and authorized endpoint flow. Upload alone does not generate.
2. Recommend opens the room-photo screen. A valid photo drafts the recommendation
   request; sending uses the existing grounded catalogue and room-observation pipeline.
3. Composer camera opens "Add a photo to your message". Attachment plus arbitrary
   text can be sent together. Opening this sheet clears a prior welcome-preview intent.
   A photo-only chat message asks for room/furniture guidance and never implies an
   automatic furniture generation request.

Back navigation preserves entries, selections, room notes and typed draft. Existing
New chat, Clear conversation, Forget room, history and memory behavior remains.
Photo preparation arriving after Forget room is discarded and its object URL revoked.

## Camera and upload

On coarse-pointer/mobile devices, Take photo activates the existing native image input
with accept=image/* and capture=environment. The operating system/browser controls
whether the rear camera, a chooser or another supported capture UI appears.
Cancelling without a file leaves state unchanged.

There was no existing desktop webcam capture implementation. Desktop Take photo
therefore shows an explicit "Choose Upload photo" explanation without unexpectedly
opening a file picker. The Upload action remains available. Native input capture does
not expose a reliable camera-permission-denied event; guidance explains the upload
fallback rather than claiming permission was granted or a photo was captured.

Both inputs use the existing prepareRoomPhoto path: supported format check, 25 MB
source cap, decodable image/dimension validation and max-1600px JPEG normalization.
Invalid files show errors without being sent; retry, thumbnail, replacement and removal
reuse the existing composer. No new upload backend or camera dependency was added.
HEIC decoding and native camera capture remain browser/device dependent.

Privacy wording accurately states that the photo is sent to the AI provider and that
Tryora retains photo bytes in page memory. It does not claim provider zero retention.
Image bytes are not written to sessionStorage.

## Verification

- Full npm test: 75 core + 431 app passed; 22 app skipped in standard mode.
- npm run typecheck: passed.
- npm run build: passed; tracked bundle rebuilt for /apps/tryora.
- TRYORA_E2E=1, assistant-browser.e2e + popup-browser.e2e: 12 passed in Chrome.
  This includes 2 new approved-screen desktop/mobile journeys, 6 preserved assistant
  journeys, and 4 preserved premium selector layout tests.
- Shopify AI Toolkit: final CSS and generated JS assets passed validation.
- git diff --check: passed.
- Nine new unit tests verify clean cards, verified category wording, preserved state,
  mobile capture input and cancellation, desktop fallback, retry, image+text chat,
  no forced preview, Forget room preparation races, keyboard dismissal and no-product flow.

Chrome uses local synthetic product/proxy/model fixtures. These results do not establish
authenticated Shopify app-proxy behavior, real AI output, real camera permissions,
Avelor mapping coverage or production deployment correctness.

## Screenshots

Actual built UI screenshots were inspected against the supplied reference. Initial mobile
welcome scroll clipping was fixed and covered by a browser assertion.

Files are local ignored QA artifacts under:
tools/storefront-harness/shots/approved-ui/

- approved-1280-welcome.png / approved-390-welcome.png
- approved-1280-preview-photo.png / approved-390-preview-photo.png
- approved-1280-recommend-photo.png / approved-390-recommend-photo.png
- approved-1280-composer-sheet.png / approved-390-composer-sheet.png
- approved-1280-photo-draft.png / approved-390-photo-draft.png

Recreate from shopify-app with TRYORA_E2E=1 and TRYORA_E2E_SCREENSHOTS set to an output
directory, using npx vitest run test/assistant-browser.e2e.test.ts.

## Review, deployment and rollback

1. Review this branch including its preserved base commits. Record current Railway
   deployment and active Shopify app/extension version before any authorized rollout.
2. Stage the matching backend and built extension revision. On an authenticated store,
   verify current native variant selection, mapped/manual/Cloudlift restrictions, room
   photo analysis, grounded recommendations, email gate, approved references and credits.
3. Test actual iOS Safari and Android Chrome capture, denied permissions, cancellation,
   HEIC, invalid/large files, retries, keyboard access, history and Forget room.
4. After separate approval, release the matching Railway build and Shopify theme
   extension assets using the existing app. This UI patch requires no migrations,
   new permissions, provider activation or production settings change.
5. Verify the active extension version and served asset revision and smoke-test the three
   entry points plus the existing product popup. On regression, restore the previously
   recorded compatible Shopify extension/app version and Railway deployment. No database
   rollback is required for this patch.

Nothing has been pushed, merged, deployed or released, and no production settings changed.

## Local follow-up: popup result routing (24 October 2026)

The welcome preview card now opens the existing product-preview UI using a separate
Tryora instance. Only this instance hands its decoded generated result to the chat.
The ordinary product launcher, window.Tryora.open, #tryora links and "Use product preview
instead" retain their normal popup-result behavior.

The handoff contains in-memory image/room Blobs and the exact variant/options already
validated by the normal generation pipeline. The chat owns separate object URLs and
renders its existing preview/download card. No new generation endpoint or client image
URL authorization was added. Delivery acknowledgement stays with the popup and occurs
only after the chat confirms that it displayed the result; rejected/stale deliveries are
not acknowledged. Jobs cannot be retargeted by reopening a popup.

New chat/Clear conversation/Forget room invalidate older chat destinations. The latest
popup room photo replaces any previous draft attachment and stale room observations.
The existing before/after email gates remain in force; the first "after" email step
appears in chat following the delivered image.

Regression coverage includes exact identity, independent normal popup delivery,
deduplication, no acknowledgement on rejection, stale conversation rejection and email
gates. Desktop/mobile Chrome tests exercise both launcher paths and verify separate
result destinations and one acknowledgement per delivery. Screenshots are local synthetic
QA artifacts under tools/storefront-harness/shots/chat-popup-handoff/:
handoff-390-chat-result.png and handoff-390-original-popup-result.png (also 1280px versions).

This is local work only: no production deployment, migration, push or merchant settings
change. Real-store validation still requires the actual approved product/reference mapping.
