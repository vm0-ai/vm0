# Phase 4 (Slice 2) sub-plan for #16847 — multi-trigger API + redesigned CLI

Prereqs: flip (PR-6) merged + baked; ideally Phase 3 PR-7 (reads cutover) done so
there is a single source of truth. Drafted 2026-06-10 while the Phase 1 train
merged; re-validate against code before executing.

## Decisions to fold in

- B3: webhook inbound dispatch must check `automation_triggers.enabled` in
  addition to `automations.enabled` (becomes user-visible once per-trigger
  disable ships).
- B4: CHECK constraint on `automation_triggers` — time kinds carry exactly one
  of cron_expression/at_time/interval_seconds; webhook carries token+secret.
- D1: converge `interpreter_kind` values "time"/"webhook" → "default"
  (migration + code default).
- B2: `triggerSource` on runs — decide "schedule" (continuity) vs "automation";
  leaning: keep "schedule" for time fires until analytics consumers are
  audited, document in the API.
- Slice-2 design note from review: should webhook fires honor
  `automations.append_system_prompt`? (today: payload-only context).

## API (apps/api, Hono + ts-rest contract `automations-v2` or extend automations.ts)

Automation CRUD (auth: same as schedules surface):
- POST   /api/automations            create {name, agentId, instruction, description?, appendSystemPrompt?, + optional first-trigger sugar: cron|once|loop|webhook params}
- GET    /api/automations            list (each with triggers[] summary)
- GET    /api/automations/:ref       show (ref = id or name) + triggers[]
- PATCH  /api/automations/:ref       update (name/instruction/agent/description/appendSystemPrompt)
- DELETE /api/automations/:ref
- POST   /api/automations/:ref/enable|disable
- POST   /api/automations/:ref/run   manual fire (instruction-only, no event)

Trigger sub-resource:
- POST   /api/automations/:ref/triggers          add {kind: cron|once|loop|webhook, config...} → webhook returns inbound URL + one-time secret
- GET    /api/automations/:ref/triggers          list
- GET    /api/automation-triggers/:id            show
- DELETE /api/automation-triggers/:id
- POST   /api/automation-triggers/:id/enable|disable
- POST   /api/automation-triggers/:id/rotate-secret   (webhook only)

Contract shape: triggers[] array (kind-discriminated union); keep the existing
flat single-trigger alias surface as deprecated compat (D2: ids become
automation ids at the Phase 3 contract cutover — announce).

Poller note: time triggers created natively (no source schedule) already fire
via executeDueTriggers$ post-flip; manual run uses the trigger-less
"automation-time"-like path (decide: synthesize event {kind:"manual"}? v1 can
reuse automation-time with a null triggerId? — needs a provenance decision;
simplest: zeroRunMetadata {automationId} only, triggerSource "manual"?).

## CLI (apps/cli, zero automation command tree per epic body)

- create/list/show/update/delete/enable/disable/run + trigger add/list/show/rm/
  enable/disable/rotate-secret; create sugar --cron/--once/--loop/--webhook.
- Deprecated aliases printing notices: `zero schedule *`, old
  `zero automation setup|webhook *` → route to new model.

## Suggested PR slicing (parallelizable after API contract PR)

1. db: B4 CHECK constraint + D1 interpreter_kind default migration
2. api: automation CRUD (create/list/show/update/delete/enable/disable/run)
3. api: trigger sub-resource CRUD + rotate-secret + B3 fix in webhook dispatch
4. cli: new command tree (depends on 2+3 contracts)
5. cli: deprecated alias mapping + notices
6. docs + announcement (D2 id semantics)
