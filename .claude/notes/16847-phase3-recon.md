# Phase 3 recon for #16847 (PR-7 reads cutover + PR-8 drop)

Recon by Explore agent on 2026-06-10, against feat/flip-poller-to-triggers. Key
conclusions (full report in session transcript):

## PR-7 scope (atomic: reads to new tables + stop dual-write)

- `zero-schedules.service.ts` six functions: `deploySchedule$` (592),
  `deleteSchedule$` (766), `enableSchedule$` (810), `disableSchedule$` (715),
  `runScheduleNow$` (1122), `zeroScheduleList` (1257) — migrate reads to
  `automations` + `automation_triggers`; remove the four
  `syncScheduleToAutomationSafely`/`deleteScheduleAutomationSafely` calls.
- `runScheduleNow$` is the critical path: must accept both scheduleId
  (legacy, resolves via `automations.source_schedule_id`) and automationId
  (alias surface maps it at routes/automations.ts:298), read trigger config
  from the trigger row, instruction from the automation, and post-flip emit
  TRIGGER callbacks (not schedule callbacks) so the recurrence advances on the
  trigger table.
- `zero-usage-insight.service.ts:516` LEFT JOINs zero_agent_schedules on
  zero_runs.schedule_id — must join automations/triggers instead (runs now
  carry automation_id/trigger_id provenance).
- `internal-callbacks-schedule.ts` stays live through PR-7 (in-flight runs
  dispatched pre-cutover still carry schedule callbacks); drop in PR-8.
- Response shape of `/api/zero/schedules` must stay identical (ScheduleResponse
  incl. id semantics: keep returning source schedule ids during PR-7? D2 says
  ids become automation ids at contract cutover — needs the announcement).

## Stable surfaces (no change needed in PR-7)

- Web platform: `apps/platform/src/signals/zero-page/automations-mode.ts` is a
  feature-gated abstraction; stable as long as contracts hold.
- CLI: contract-driven (`zero-schedules.ts`, `zero-automations.ts` domains).

## PR-8 (drop, after bake)

- Drop `executeDueSchedules$`, internal-callbacks-schedule routes,
  schedule-dual-write.ts, `scheduleToAutomation`, zero_agent_schedules table +
  `automations.source_schedule_id`, the dormant-poller describe in
  cron-execute-schedules.test.ts; decide B2 (triggerSource "schedule" vs
  "automation"); announce D2 id semantics.

## Flip-gate reminders (PR-6)

- 0444–0446 applied in prod BEFORE the flip merges (release in between; code
  deploys on merge, migrations at release).
- Reconciliation SQL zero rows (packages/db/scripts/reconcile-schedule-automation-mirror.sql).
- Prod precheck 2026-06-10: 280/280 mapped, 0 unmapped, 19 runtime-drift rows
  (0446 converges them).
- Transitional staleness post-flip: /api/zero/schedules runtime fields freeze
  until PR-7 — schedules fire correctly, listed next-run times go stale.
