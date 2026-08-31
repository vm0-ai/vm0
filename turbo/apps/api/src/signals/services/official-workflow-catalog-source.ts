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

## Diagnose once

Run \`okou doctor connectors --json\` exactly once per scheduled or manual run. Parse its standard output as JSON and accept it only when \`schemaVersion\` is \`1\`. Treat that one report as the sole source of diagnostic facts. Do not supplement, verify, or reinterpret it from any other source.

If the command fails, its output is not valid JSON, or its schema version is unsupported, return a diagnosis-unavailable report under an **Unknown** heading. State the observed failure without claiming that any connector or workflow is healthy.

## Report valid results

- If \`summary.checked === 0\`, report that no owned or installed workflows were available to check. Treat this as a distinct no-workflows result, not an all-clear over diagnosed workflows.
- Group every connector entry with a non-null action by identical \`action.kind\` and exact \`action.url\`. Include the repair link once for each group, then list every affected workflow with the connector's returned readiness status and reason. Never merge entries whose exact URLs differ, even when their action kinds or connector labels match, because the URL identifies the target Agent.
- Under **Unknown**, list every connector whose status is \`unavailable\` and every workflow with a non-null \`error\`. Include the returned workflow identity and reason or error message. Unknown is never healthy.
- Emit a short all-clear only when \`summary.checked > 0\`, \`summary.attention === 0\`, and \`summary.unknown === 0\`.
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
