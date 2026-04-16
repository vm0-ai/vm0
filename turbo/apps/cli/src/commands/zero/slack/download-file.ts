import { join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import { downloadSlackFile } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

/**
 * Derive a local output path for a Slack file id.
 * Uses the system temp directory; extension is appended later once the
 * mimetype is known.
 */
function defaultOutPath(fileId: string): string {
  return join(tmpdir(), `slack-${fileId}`);
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download a Slack file by id using the bot token")
  .argument("<file-id>", "Slack file id (e.g. F01234ABCD)")
  .option(
    "-o, --out <path>",
    "Output path for the downloaded file (default: /tmp/slack-<file-id>)",
  )
  .addHelpText(
    "after",
    `
Examples:
  Download to default temp path: zero slack download-file F01234ABCD
  Download to explicit path:     zero slack download-file F01234ABCD -o /tmp/image.png

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/slack-F01234ABCD","mimetype":"image/png","size":12345}

Notes:
  - Uses the bot token on the server side; no user Slack token is needed
  - Streams the file bytes directly to disk`,
  )
  .action(
    withErrorHandler(async (fileId: string, options: { out?: string }) => {
      const outPath = options.out ?? defaultOutPath(fileId);
      const result = await downloadSlackFile(fileId, outPath);
      console.log(JSON.stringify(result));
    }),
  );
