// Curated quick commands surfaced per connector in the chat composer's slash
// menu. Each command only inserts a natural-language prompt into the composer —
// the agent does the actual work — so this is a discoverability scaffold, not a
// hardcoded API surface. Prompts deliberately avoid hardcoding any repository or
// account: the menu is user-facing, so the agent resolves the target from the
// conversation context (or asks). Keep the list short and high-signal per
// connector; the connector's display label comes from the connector registry.
import type { ConnectorType } from "@vm0/connectors/connectors";

export interface ConnectorCommand {
  /** Short menu label, sentence case, no trailing punctuation. */
  readonly label: string;
  /** Natural-language prompt inserted into the composer when picked. */
  readonly prompt: string;
}

interface ConnectorCommandGroup {
  readonly connectorType: ConnectorType;
  readonly commands: readonly ConnectorCommand[];
}

// v1: GitHub only. Pull-request commands first, then issue commands.
export const CONNECTOR_COMMAND_GROUPS: readonly ConnectorCommandGroup[] = [
  {
    connectorType: "github",
    commands: [
      { label: "List PRs", prompt: "List my open pull requests" },
      {
        label: "Review PR",
        prompt: "Review this pull request and tell me what needs changing",
      },
      { label: "Merge PR", prompt: "Merge this pull request" },
      {
        label: "List issues",
        prompt: "Show the GitHub issues assigned to me",
      },
      { label: "Create issue", prompt: "Create a GitHub issue: " },
    ],
  },
];
