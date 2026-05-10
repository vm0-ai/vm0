import { basename, join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import { downloadTelegramFile } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

/**
 * Derive a local output path for a Telegram file id.
 * Uses the system temp directory.
 *
 * `basename` strips any path separators from `fileId` so a hostile id like
 * `../etc/passwd` cannot escape `tmpdir()`.
 */
function defaultOutPath(fileId: string): string {
  return join(tmpdir(), `telegram-${basename(fileId)}`);
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download a Telegram file by id using the bot token")
  .argument("<file-id>", "Telegram file id from a [Telegram file] block")
  .option(
    "-o, --out <path>",
    "Output path for the downloaded file (default: /tmp/telegram-<file-id>)",
  )
  .requiredOption(
    "--bot-id <bot-id>",
    "Telegram bot id from the [Telegram file] block",
  )
  .addHelpText(
    "after",
    `
Examples:
  Download to default temp path: zero telegram download-file AgACAgUAAxkBAA --bot-id 123456789
  Download to explicit path:     zero telegram download-file AgACAgUAAxkBAA --bot-id 123456789 -o /tmp/photo.jpg

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/telegram-AgACAgUAAxkBAA","mimetype":"image/jpeg","size":12345}

How to read the downloaded file:
  - Images (png/jpg/gif/webp/svg): open the file path with your image viewing tool
  - Videos (mp4/mov/webm): extract frames first with
      ffmpeg -i <path> -vf "fps=1" -q:v 2 /tmp/<file-id>_frame_%03d.jpg
    then view the extracted frames
  - PDF/text/csv/json/markdown: read the file directly

Notes:
  - Uses the Telegram bot token on the server side
  - Streams the file bytes directly to disk`,
  )
  .action(
    withErrorHandler(
      async (fileId: string, options: { out?: string; botId: string }) => {
        const outPath = options.out ?? defaultOutPath(fileId);
        const result = await downloadTelegramFile(
          fileId,
          options.botId,
          outPath,
        );
        console.log(JSON.stringify(result));
      },
    ),
  );
