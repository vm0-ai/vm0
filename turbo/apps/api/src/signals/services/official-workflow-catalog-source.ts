import {
  OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
  type OfficialWorkflowSourceCatalog,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";

const MORNING_BRIEF_INSTRUCTION = `# Morning Brief

Prepare a concise Markdown briefing that helps the user start the day with the most important current work.

## Collect current context

Attempt every source during each scheduled or manual run. Use only the ordinary connector skills, CLI commands, credentials, firewall rules, and capabilities available inside this sandbox.

- Gmail: follow the Gmail connector skill to review recent or unread messages that may need attention. Prefer decisions, requests, deadlines, and blocked work over routine mail.
- GitHub: follow the GitHub connector skill to review relevant notifications, review requests, assigned issues and pull requests, failing checks, and other recent work that may need action.
- Google Calendar: follow the Google Calendar connector skill to review today's schedule and near-term meetings, deadlines, or conflicts.
- Unread Chats: run \`okou chat list --unread --all-agents\`. For relevant unread threads, use \`okou chat messages --thread-id <thread-id> --output-dir threads\` to read the authorized history before summarizing it.

If a source, connector, thread, or capability is unavailable, say that it was unavailable and continue with the other sources. Never invent, infer, or claim source data that was not read.

## Produce the briefing

Return only the briefing as concise Markdown. Choose short headings and bullets based on the information actually found instead of following a fixed schema. Prioritize time-sensitive commitments, decisions, blockers, conflicts, and clear next actions; include source names and dates or times when useful.

Do not read application database tables or use internal application APIs, signed input or output URLs, or callback endpoints. Do not send email, drafts, chat messages, or provider-side updates. The platform owns any result-email delivery after the run succeeds.`;

const CONNECTOR_DOCTOR_INSTRUCTION = `# Connector Doctor

Produce a concise Markdown connector-readiness report in this Official Workflow's shared automation thread.

## Capture the diagnosis once

In one shell tool call, create a unique sandbox-local report file with \`mktemp\`, then run the aggregate diagnosis exactly once per scheduled or manual run and redirect its complete standard output directly into that file. Use this capture shape so the tool result contains only the path and status:

\`\`\`sh
report_file="$(mktemp "\${TMPDIR:-/tmp}/connector-doctor.XXXXXX.json")" &&
if okou doctor connectors --json >"$report_file"; then
  printf 'report_file=%s status=ok\\n' "$report_file"
else
  doctor_status=$?
  printf 'report_file=%s status=failed exit=%s\\n' "$report_file" "$doctor_status" >&2
  exit "$doctor_status"
fi
\`\`\`

Do not use \`tee\`, echo the raw output, switch to the human-readable CLI output, or depend on compact JSON whitespace or a higher tool-output limit. Check the command's exit status and do not rerun it, split it into per-workflow diagnoses, or call connector-readiness APIs separately. The capture call may return only the unique file path and a small success or failure status, never the report body.

All later commands must be local parsers against that same sandbox file. Treat that one captured report as the sole source of diagnostic facts. Do not supplement, verify, or reinterpret it from any other source. Keep the file sandbox-local; do not upload, attach, or send it.

## Validate locally and read the summary first

Before making any health claim, use a non-emitting local \`jq\` check or equivalent local parser against the file. It must parse the entire file successfully, prove that the root is an object with \`schemaVersion === 1\`, and validate the required schema-version-1 fields and types used below: all five non-negative integer summary counts, the \`workflows\` array, workflow and Agent identities, outcomes, connector statuses and reasons, exact action kinds and URLs, and workflow errors. A truncated or empty file, invalid JSON, an unsupported schema version, a missing required field, a type or value mismatch, or any local parsing or projection failure makes the diagnosis unavailable.

After validation, the first data-returning projection must contain only \`schemaVersion\` and \`summary\`. Never make a tool call that prints, reads, or returns the whole raw file; in particular, do not use \`cat\`, \`tee\`, an unfiltered \`jq\` query, or an equivalent whole-file read. Every later data-returning projection must select only the fields required by the chosen report branch and return at most 20 records per tool result. Use a count-only projection to determine whether paging is needed, then advance explicit offsets until every projected record for that branch has been consumed. Local parsers may scan the complete file internally, but the raw document must never cross the tool-return boundary.

If the Doctor command or local capture fails, or any validation condition above fails, return a diagnosis-unavailable report under an **Unknown** heading. State the observed failure without claiming that any connector or workflow is healthy.

## Report valid results

- If \`summary.checked === 0\`, report that no effective visible workflows were available to check. Treat this as a distinct no-workflows result, not an all-clear over diagnosed workflows. The validated summary is sufficient for this branch.
- Emit a short all-clear only when \`summary.checked > 0\`, \`summary.attention === 0\`, and \`summary.unknown === 0\`. For this branch, page through a projection containing only each checked workflow's returned identity and returned Agent identity. State that the aggregate covered effective visible workflows and include a compact inventory of every checked entry in \`workflows\`, grouped by its returned Agent identity. Use only workflow and Agent names or IDs present in the JSON.
- Otherwise, page through a projection of every connector entry with a non-null action, selecting only the workflow identity, connector status and reason, and exact \`action.kind\`, \`action.label\`, and \`action.url\`. Group entries by identical \`action.kind\` and exact \`action.url\`. Include the repair link once for each group, then list every affected workflow with the connector's returned readiness status and reason. Never merge entries whose exact URLs differ, even when their action kinds or connector labels match, because the URL identifies the target Agent.
- For the same non-all-clear branch, separately page through a projection of every connector whose status is \`unavailable\` and every workflow with a non-null \`error\`. Under **Unknown**, include the returned workflow identity and reason or error message. Unknown is never healthy.
- Keep the report concise and include only facts, counts, statuses, reasons, and repair links present in the returned JSON.

## Safety boundaries

Do not invoke connector or provider skills, third-party provider APIs, \`okou connector list\`, \`okou connector status\`, \`okou connector check\`, application-internal APIs, or application database tables. Do not write to or mutate application or provider state. Do not connect, reconnect, authorize, start OAuth flows, request permissions, create callbacks, mutate connectors, or follow repair links. Do not select or recommend models, and do not recommend workflow or Automation cleanup.

Return only the Markdown report. The platform delivers it to the shared automation thread. Do not send email or directly send any chat or other message.`;

/**
 * The sole deployed source candidate. Every Definition uses the same validated
 * release boundary and immutable shared-artifact publication path.
 */
export const OFFICIAL_WORKFLOW_SOURCE_CATALOG: OfficialWorkflowSourceCatalog =
  Object.freeze<OfficialWorkflowSourceCatalog>({
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_SCHEMA_VERSION,
    definitions: [
      {
        name: "morning-brief",
        lifecycle: "active",
        workflow: {
          displayName: "Morning Brief",
          description:
            "Summarize today's email, GitHub, calendar, and unread Chat priorities.",
          instruction: MORNING_BRIEF_INSTRUCTION,
          files: [],
        },
        blueprints: [
          {
            key: "daily-delivery",
            parameters: [
              {
                key: "timezone",
                type: "string",
                format: "timezone",
                required: true,
                derivation: { kind: "user-timezone" },
              },
            ],
            desiredState: {
              kind: "schedule",
              schedule: {
                type: "cron",
                cronExpression: "0 7 * * *",
                timezone: { parameter: "timezone" },
              },
            },
            runtime: { resultEmail: true },
          },
        ],
        presentation: { category: "productivity" },
      },
      {
        name: "connector-doctor",
        lifecycle: "active",
        workflow: {
          displayName: "Connector Doctor",
          description:
            "Diagnose connector readiness across your workflows and group exact repair actions.",
          instruction: CONNECTOR_DOCTOR_INSTRUCTION,
          files: [],
        },
        blueprints: [
          {
            key: "weekly-check",
            parameters: [
              {
                key: "timezone",
                type: "string",
                format: "timezone",
                required: true,
                derivation: { kind: "user-timezone" },
              },
            ],
            desiredState: {
              kind: "schedule",
              schedule: {
                type: "cron",
                cronExpression: "0 9 * * 1",
                timezone: { parameter: "timezone" },
              },
            },
            runtime: { resultEmail: false },
          },
        ],
        presentation: { category: "productivity" },
      },
    ],
  });
