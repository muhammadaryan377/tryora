# Chatbot preview credit gate

New chatbot requests require a positive available preview balance for the
authenticated merchant. `requireAssistantEnabled` reads `tryora.balance(shopId)`
before streamed turns or the legacy JSON message handler can invoke the model.
The check uses the ledger's available balance, including reservations and expiry,
rather than trusting the storefront's cached `previewsAvailable` flag.

Zero available credits return `CREDITS_EXHAUSTED`. If balance lookup fails, the
request returns `PROVIDER_UNAVAILABLE` and does not continue to AI generation.
The storefront explains that the assistant is paused because preview credits
have run out. Retry/new messages check the current balance again, allowing chat
to resume after credits are renewed or topped up without a page reload.

This gate does not consume an extra preview credit for chat messages. Existing
image credit reservation/consumption, chatbot lead collection, exact variants
and explicit Generate confirmation remain in place. No database migration is
needed. Requests already admitted are not cancelled by a later balance change.

Regression coverage checks zero-credit poll/SSE admission before any model call,
merchant isolation, renewal, database lookup failure, and the storefront's
pause/retry recovery. The legacy message endpoint uses the same admission guard.

Validation on 28 October 2026: core 75 passed; app 769 passed with browser tests
enabled and four workers (10 existing opt-in tests skipped). Production build
and workspace typecheck passed. An earlier unrestricted run hit unrelated
launcher startup/shutdown timeouts; the four-worker run passed without changing
their assertions or timeouts. No live database or paid model test was run.
