# Epic #17307 — retire "schedule", single Automations surface

## Merged
- PR-1 #17315 automationWebhookTriggers switch (gates webhook trigger create/inbound/rotate)
- PR-2 #17334 trigger_source="automation" writers + dual readers (insight SQL, usage-record sourceExpr, banking gate, logs filter inArray, core bucket map, platform detail page)
- PR-3a #17340 zeroAutomations enabled:true for all
- PR-3b #17352 platform → /api/v2/automations directly; automations-mode.ts deleted → automations-api.ts; labels constant; v2 create auto-generates description (automations/describe.ts shared module); MSW api-automations-v2.ts handlers
- PR-3c #17354 delete zeroAutomations switch + automationsEnabled$ gates (in queue 16:0x)
- PR-4a #17356 capabilities schedule:* → automation:* ; LEGACY_CAPABILITY_ALIASES normalized at token parse (permanent); AGENT_EXCLUDED automation:delete; routes require automation:* (in queue; 1st eject was checks_timed_out flake, merge-group CI was green)

## Ready local branch (push after 17356 merges)
- `feat/remove-cli-schedule-commands` (stacked on feat/automation-capabilities): zero schedule tree deleted + rename stub (commands/zero/schedule.ts, hidden from token help via absent COMMAND_CAPABILITY_MAP entry); automation setup/status/webhook hidden aliases deleted; CLI domains zero-schedules/zero-automations/webhook-automations deleted; e2e t20 bats → automation lifecycle + stub notice; ser-t06 smoke → automation; schedule-utils pruned to formatRelativeTime/formatDateTime; promptSelect+deprecation.ts deleted; visibility tests updated (stub hidden for tokens, invokable).
- Rebase: `git rebase --onto origin/main feat/automation-capabilities feat/remove-cli-schedule-commands`

## Remaining
1. **PR-4c surfaces deletion** (after CLI PR merges): delete routes zero-schedules.ts + automations.ts (flat alias) + webhook-automations.ts; keep zero-schedules.service.ts (v2 service imports loadAgentForDeploy/persistManualRunSideEffects/resolveScheduleRunModelContext); delete legacy web rewrites (api-backend-rewrites.js: ZERO_SCHEDULES_* + flat AUTOMATIONS_* entries, keep AUTOMATIONS_V2_*); delete platform MSW api-schedules.ts/api-automations.ts (platform tests import createMockScheduleResponse from api-schedules — move helper into schedules-store or api-automations-v2); delete API test suites for deleted routes; contracts: keep scheduleResponseSchema/ScheduleResponse type (platform view model uses it), delete router objects — knip guides.
2. **PR-4d path move** (after 4c): contract paths /api/v2/automations* → /api/automations*, /api/v2/automation-triggers/* → /api/automation-triggers/*; server dual-mount /api/v2/* via Hono path-rewrite middleware (find mount point in apps/api/src — route registry by contract path); web rewrites add new paths, keep /api/v2 entries for old platform builds; cron caller unaffected.
3. **PR-5 migration** (BLOCKED until PR-2 readers live in prod): standalone `UPDATE zero_runs SET trigger_source='automation' WHERE trigger_source='schedule'` via drizzle-kit generate --custom; release PR #17342 still open as of 16:00 — check `gh pr list --search release` + /is-in-production for #17334 before starting. Per #17280: migration-only PR, no code.
4. **PR-6 cleanup**: /api/cron/execute-schedules → execute-automations dual-path + coordinate vercel.json/cron caller; platform /schedules route → /automations + redirect; zero-runs-create.service.ts:774 comment + buildAgentToolsPrompt already updated; internal renames (zero-schedules.service.ts → automations-compat or fold into v2 service); remove /api/v2 dual-mount later; logs.ts contract triggerSourceSchema drop "schedule" after migration; usage-record sourceExpr WHEN 'automation' THEN 'schedule' display key rename ('schedule' bucket label → 'automation'?) — decide with user; e2e/docs sweep.
5. **Final acceptance**: rg -i schedule → only zero_runs.schedule_id, chat_messages.schedule_* data columns + LEGACY_CAPABILITY_ALIASES; all runs trigger_source=automation; webhook switch off = schedule parity; old tokens work.

## Gotchas
- Forks of /pr-review-merge share this checkout; commit before switching branches.
- Merge queue: enqueuePullRequest GraphQL; eject reason via REMOVED_FROM_MERGE_QUEUE_EVENT; checks_timed_out with green turbo run = flaky required check, re-enqueue.
- zero tokens expire in 2h → capability transition windows are short.
- monitor task brcwm3jo9 watches 17354+17356 to terminal state.
