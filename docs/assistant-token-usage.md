# AI token usage

Chatbot calls use the `OPENAI-API-CHATBOOT` environment variable exclusively.
Image generation continues to use `OPENAI_API_KEY`. Configure the chatbot variable
using its exact name in the hosting environment; no key values belong in Git or usage records.

Apply the `202610290001_assistant_token_usage` migration with
`npm --prefix shopify-app run db:deploy` before deploying the updated app server.

- `AssistantTokenUsage`: one row per chatbot model response, with `source=chatbot`,
  shop, response ID, model, outcome, input/output/total tokens, cached input tokens,
  and timestamp. Tool rounds are separate responses. Response IDs are unique to
  avoid counting the same response twice. Usage is recorded before later reply
  validation, including incomplete responses when usage is available.
- `ProviderUsage`: existing image pipeline records now include `source=image` and
  nullable input/output/total token columns. Image generation copies the provider's
  returned usage. Local photo/result checks and older records have null token
  counts. Missing counts are not estimated.

Cached chatbot tokens are part of input tokens, not an additional token count.
Chatbot usage write failures emit a metadata-only warning without failing the reply.
Messages, prompts, images, visitor IDs and API keys are never written to these records.
Requests interrupted before the provider reports usage cannot have an exact token
count recorded; these tables are not a replacement for provider billing statements.
