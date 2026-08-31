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
    ],
  });
