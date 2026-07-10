import { readFileSync } from "fs";
import { Command } from "commander";
import type { SendTeamsMessageBody } from "@vm0/api-contracts/contracts/integrations";
import chalk from "chalk";
import { sendTeamsMessage } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

type TeamsCardInput = NonNullable<SendTeamsMessageBody["card"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTeamsCard(value: string): TeamsCardInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid JSON for --card flag", {
      cause: new Error("Provide a valid Adaptive Card JSON object"),
    });
  }

  if (
    !isRecord(parsed) ||
    parsed.type !== "AdaptiveCard" ||
    typeof parsed.version !== "string"
  ) {
    throw new Error("Invalid Adaptive Card for --card flag", {
      cause: new Error(
        'Provide a JSON object with "type": "AdaptiveCard" and a version',
      ),
    });
  }

  return parsed as TeamsCardInput;
}

export const sendCommand = new Command()
  .name("send")
  .description("Send a message to a Microsoft Teams conversation or DM a user")
  .option("-c, --conversation-id <id>", "Teams conversation ID")
  .option("-u, --user <id>", 'Teams user ID for DM (use "me" for yourself)')
  .option("-t, --text <message>", "Message text")
  .option("--activity-id <id>", "Activity ID to reply to")
  .option("--thread <id>", "Alias for --activity-id")
  .option("--card <json>", "Adaptive Card JSON string")
  .addHelpText(
    "after",
    `
Examples:
  Simple message:        zero teams message send -c 19:thread@thread.tacv2 -t "Hello!"
  DM a user:             zero teams message send -u 29:user-id -t "Hello!"
  DM yourself:           zero teams message send -u me -t "Hello!"
  Thread reply:          zero teams message send -c 19:thread@thread.tacv2 --thread root-activity -t "reply"
  Adaptive Card:         zero teams message send -c 19:thread@thread.tacv2 --card '{"type":"AdaptiveCard","version":"1.4","body":[{"type":"TextBlock","text":"Hello","wrap":true}]}'

Notes:
  - Either --conversation-id or --user is required; they are mutually exclusive
  - Either --text or --card is required; text can be provided with --text or piped on stdin
  - Use the Conversation ID and Activity ID from the current Teams run prompt`,
  )
  .action(
    withErrorHandler(
      async (options: {
        conversationId?: string;
        user?: string;
        text?: string;
        activityId?: string;
        thread?: string;
        card?: string;
      }) => {
        let text = options.text;
        const { conversationId, user, card: cardJson } = options;

        if (!conversationId && !user) {
          throw new Error(
            "Either --conversation-id or --user must be provided",
            {
              cause: new Error(
                'Usage: zero teams message send -c CONVERSATION_ID -t "your message"\n       zero teams message send -u USER_ID -t "your message"',
              ),
            },
          );
        }
        if (conversationId && user) {
          throw new Error(
            "--conversation-id and --user are mutually exclusive",
            {
              cause: new Error(
                "Provide either --conversation-id to send to a conversation or --user to DM a user, not both",
              ),
            },
          );
        }

        const activityId = options.activityId ?? options.thread;
        if (user && activityId) {
          throw new Error(
            "--activity-id and --thread can only be used with --conversation-id",
            {
              cause: new Error(
                "Thread replies require an existing Teams conversation",
              ),
            },
          );
        }

        if (!text && !process.stdin.isTTY) {
          try {
            text = readFileSync("/dev/stdin", "utf8").trim();
          } catch {
            // stdin not readable; fall through to the missing-text validation.
          }
        }

        const card = cardJson ? parseTeamsCard(cardJson) : undefined;

        if (!text && !card) {
          throw new Error(
            "Either --text, --card, or piped stdin must be provided",
            {
              cause: new Error(
                'Usage: zero teams message send -c CONVERSATION_ID -t "your message"',
              ),
            },
          );
        }

        const body: SendTeamsMessageBody = {
          ...(conversationId ? { conversationId } : { user }),
          ...(activityId ? { activityId } : {}),
          ...(text ? { text } : {}),
          ...(card ? { card } : {}),
        };
        const result = await sendTeamsMessage({
          ...body,
        });

        const activityInfo = result.activityId
          ? ` (activity_id: ${result.activityId})`
          : "";
        console.log(chalk.green(`✓ Message sent${activityInfo}`));
      },
    ),
  );
