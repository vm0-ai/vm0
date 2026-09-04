Closes #31693.

## Problem

Slice 1 of #31616 (#31653) made the shared OpenRouter helper reject any `finish_reason` other than `"stop"` — `signals/external/openrouter.ts:159`. That turned a previously silent truncation into a hard failure, which is the right behaviour, but no test covered it for the four migrated fast-path callers.

The gap became concrete during #31616. Slice 2 (#31698) enabled `reasoning: { effort: "low" }` while leaving budgets sized for a non-reasoning model. Gemini 3 draws thinking tokens from the same `max_output_tokens` budget as the answer, so those calls returned `finish_reason: "length"` and produced nothing. It reached production and ran for 74 minutes before #31715 raised the budgets.

#31715 pinned only the chat title and recommended follow-up budgets. Reverting the notification summary budget from 512 to 35, or the run summary budget from 768 to 80, still left the suite green — reintroducing exactly the defect that shipped.

## Change

**`helpers/api-bdd-chat-callbacks.ts`** — the shared mock previously hard-coded `finish_reason: "stop"` and parsed only `messages`, so tests could not observe the request or simulate truncation. The body schema now also captures `model`, `max_tokens` and `reasoning`, and a handler may return `{ content, finishReason: "length" }` instead of a bare string.

**`chat-callbacks.bdd.test.ts`** — four new tests:

| Test | Asserts |
|---|---|
| pins the model, reasoning effort, and token budget of every fast-path completion | title 512, follow-ups 1024, notification summary 512, run summary 768 — each with `google/gemini-3.8-flash` and `effort: "low"` |
| discards a token-limited notification summary instead of pushing truncated text | the push falls back to `"Your task is complete"` and the truncated text is never pushed |
| leaves the thread untitled when the title completion is token-limited | no title event is written, so the next round retries |
| suppresses token-limited recommended follow-ups instead of storing partial JSON | the completed lifecycle marker carries no `recommendedFollowups` |

All four fail if a `finish_reason` bypass is reintroduced, and the first fails if any budget regresses.

## Notes

Run summary is written to run metadata and is not exposed through a user-facing contract, so it is covered by pinning its request rather than by an entry-point assertion. That is the specific regression that shipped, so it is the one worth guarding.

No production code changed.

## Verification

`prettier --check` and `eslint` pass on both files. The API workspace type-check and the BDD suite need more memory and a live Postgres than this container has, so they are left to the PR pipeline.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
