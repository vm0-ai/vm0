import { Command } from "commander";
import { slackChannelListQuerySchema } from "@okouai/api-contracts/contracts/integrations-slack-read";
import { listSlackChannels } from "../../../lib/api/domains/integrations-slack";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List public channels and private channels visible to the bot")
  .option("--limit <count>", "Maximum channels in one page (1-200)", "100")
  .option("--cursor <cursor>", "Continue from a previous page's nextCursor")
  .option("--json", "Print the response as JSON")
  .addHelpText(
    "after",
    `
Examples:
  okou slack channel list
  okou slack channel list --limit 100 --json
  okou slack channel list --cursor <next-cursor>

Notes:
  - Public channels include channels the bot has not joined. Private channels are visible only after the bot joins.
  - Archived channels are excluded. This command does not list DMs or join channels.
  - Use the returned channel ID with okou slack message history --channel <id>.
  - For an unjoined channel, open its link and add Okou via the channel name > Agents & apps.
  - Requires slack:read. Each call reads one page; an empty page can still have a nextCursor.`,
  )
  .action(
    withErrorHandler(
      async (options: { limit: string; cursor?: string; json?: boolean }) => {
        const parsed = slackChannelListQuerySchema.safeParse(options);
        if (!parsed.success) {
          throw new Error(
            parsed.error.issues
              .map((issue) => {
                return `${issue.path.join(".")}: ${issue.message}`;
              })
              .join("\n"),
          );
        }
        const result = await listSlackChannels(parsed.data);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.channels.length === 0) {
          console.log(
            "No channels on this page. Private channels appear after Okou is invited.",
          );
        }
        for (const channel of result.channels) {
          console.log(
            `${channel.id}  #${channel.name}  ${channel.isPrivate ? "private" : "public"}  ${channel.isMember ? "joined" : "invite Okou first"}`,
          );
          console.log(channel.channelUrl);
        }
        if (result.nextCursor) console.log(`Next cursor: ${result.nextCursor}`);
        console.log("Read history: okou slack message history --channel <id>");
      },
    ),
  );
