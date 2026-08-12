# Okou first-party producer cutover

This document is the authoritative source audit and deployment-compatibility
record for issue #26432. It covers the first-party producer cutover only. The
temporary `zero` executable remains available until the production drain gate
for child C is proven.

## Foundation

The cutover starts from release commit
`916a75a6910fb873b17b3c07e7dbb9bdf61ad15e`, which contains Task A merge
`c41cbe9f9ce38ee1bc9266f3fd1cfa5ac95e26c7`. Production selected the immutable
dual-entry artifact at
`https://static.vm0.io/okou-cli/916a75a6910fb873b17b3c07e7dbb9bdf61ad15e/package.tgz`.
Its manifest SHA-256 is
`afb3206d491ba9686512af3eb132c2797f8e2cf57ef509967a6885d86dc116c9`.
Production and independent CDN checks executed `okou`, the temporary `zero`
alias, and the old `zero __agent-loop` boundary from that artifact. <!-- okou-cutover-audit: compatibility-only -->

## Deployment compatibility

| API / release artifact | Runner or guest-agent | Expected entry point | Evidence |
| --- | --- | --- | --- |
| New API with dual-entry artifact | New Runner | `okou __agent-loop` | The guest-agent process-boundary integration test puts a fake `npx` on `PATH` and asserts the exact Pi standby launch argv. The Runner E2E separately exercises the canonical user command and real CLI HTTP boundary. |
| New API with dual-entry artifact | Old Runner | `zero __agent-loop` | The artifact smoke test and Runner E2E execute the legacy internal boundary. | <!-- okou-cutover-audit: compatibility-only -->
| Old API selecting the recorded dual-entry artifact | New Runner | `okou __agent-loop` | Safe because both entry points are present in the immutable artifact. |
| Old API selecting a pre-Okou artifact | New Runner | unsupported | Never deploy this pairing. Roll API and Runner back together to an old/old pairing instead. |

Old queued and active execution contexts keep their immutable historical
artifact URL. They are not rewritten and continue with the Runner and artifact
pairing admitted for that execution.

The command-boundary suites execute Commander parsing, validation, output,
request construction, and exit behavior. MSW stays at the production HTTP
boundary. No command arguments are added to Runner E2E trace output.

## Supported producer audit

The following repository-controlled sources now emit `okou`:

- guest-agent and Pi standby bootstrap;
- API-authored system prompts, templates, run guidance, callback examples,
  recovery hints, and plan-upgrade guidance;
- CLI help, examples, generated commands, authoring instructions, recovery
  guidance, service identity, and MCP client identity;
- in-repository seed metadata, resource indexes, fixtures, platform mocks,
  E2E operations, development tooling, and current operational documentation.

The executable audit is
`.github/scripts/audit-okou-cli-cutover.sh`. It scans the current command tree
and retired command spellings across tracked and
untracked non-ignored files, checks the guest-agent
bootstrap directly, prints only category plus file and line number, and fails
on an unclassified reference. It never prints command arguments, secrets,
identifiers, or content. Its shell test proves both the failure boundary and
the output-redaction property.

The external first-party durable source `vm0-ai/vm0-skills` was audited at
commit `8efee9aaeedbcd5a372401679beac740daad9101`. Sixteen files contained 149
executable legacy references:

- current command-tree references: `agentphone/SKILL.md`,
  `computer-use/SKILL.md`, `finicity/SKILL.md`, `gen/SKILL.md`,
  `github-copilot/SKILL.md`, `goal/SKILL.md`, `google-slides/SKILL.md`,
  `illustration-template/cozy-parlor/SPEC.md`, `lovart/SKILL.md`,
  `nano-banana/SKILL.md`, `seedance/SKILL.md`, `workflow-setup/SKILL.md`, and
  `workflow-setup/references/trigger-setup.md`;
- unsupported retired npm command trees: `local-agent/SKILL.md` and
  `local-browser/SKILL.md`, plus the `local-agent` marketplace registration.

The 13 current command-tree files contained 115 references. The companion
owning-repository change
[`vm0-ai/vm0-skills#323`](https://github.com/vm0-ai/vm0-skills/pull/323)
migrates every one to `okou`. The two retired npm
command trees and marketplace registration contained the other 34 references.
Because neither command is registered by the current CLI and npm publication
remains retired, the companion change removes both obsolete skills and the
registration rather than presenting them as Okou commands. No supported
first-party executable legacy reference remains in that audited source.

Repository-controlled seed metadata has been updated. Arbitrary user-owned
workflow bodies, instructions, and templates are not rewritten: their meaning
cannot be established from an embedded string alone. A user-owned legacy
command is unsupported content until its owner deliberately migrates it. Old
execution contexts are historical immutable content, not migration targets.

## Exact residual classification

- **Compatibility-only:** the packed `zero` alias, artifact/workflow smoke
  checks, serial CLI alias tests, old-Runner `zero __agent-loop` coverage, and <!-- okou-cutover-audit: compatibility-only -->
  compatibility documentation.
- **Approved internal protocol:** `ZERO_*` environment variables, token scope,
  `/api/zero/**`, `commands/zero`, database and backend domain identifiers, and
  the Slack `/zero model` interaction. The separate Zero Computer Use Desktop
  product identity is also outside this CLI cutover. These are not executable
  CLI producers.
- **Historical:** changelogs, migration notes, retired `zero secret`, <!-- okou-cutover-audit: historical -->
  `zero variable`, `zero schedule`, and `zero automation` documentation, plus <!-- okou-cutover-audit: historical -->
  immutable old execution contexts.
- **Unsupported user-owned content:** arbitrary persisted text that still names
  the legacy entry point. It is not rewritten automatically.
- **External first-party durable content:** the 13 supported `vm0-skills`
  sources listed above are migrated by the companion change; the two retired
  npm command-tree skills are removed. They are not treated as user-owned text
  and leave no external first-party executable residual.

The in-repository audit must report zero unclassified references before merge.

## Production evidence required before child C

After this child merges and releases, record all of the following on the issue:

1. The child B merge commit, release commit, exact Turbo run, and exact
   release-please run with terminal conclusions.
2. The production API deployment and exact immutable CLI artifact URL and
   manifest digest it selects.
3. Deployed Runner versions and a command-boundary production proof that newly
   admitted work uses an Okou-invoking guest-agent. The evidence may record the
   entry-point category and bounded counts, but must not record arguments,
   secrets, identifiers, or user content.
4. API and Runner cutover timestamps, queue state, active execution state, and
   finalization state. Derive and cite the conservative maximum lifetime from
   the then-current queue, execution, and finalization source; elapsed time by
   itself is not drain proof.
5. A rerun of both repository audits, confirmation that the companion
   `vm0-skills` migration is deployed to the durable-content source, and the
   remaining production legacy-entry evidence.
6. Proof that no old Runner can claim new work and that all work admitted under
   an old pairing is terminal before removing the alias.

Rollback to the last known-good dual-entry release
`916a75a6910fb873b17b3c07e7dbb9bdf61ad15e`. Never pair an Okou-invoking new
Runner with a pre-Okou artifact. A rollback past the dual-entry foundation must
roll both API and Runner back to a compatible old/old pair.
