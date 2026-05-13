import { basename, join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import { downloadPhoneFile } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

function defaultOutPath(fileId: string): string {
  return join(tmpdir(), `phone-${basename(fileId)}`);
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download an AgentPhone media file by id")
  .argument(
    "<file-id>",
    "AgentPhone message id from an [AgentPhone file] block",
  )
  .option(
    "-o, --out <path>",
    "Output path for the downloaded file (default: /tmp/phone-<file-id>)",
  )
  .addHelpText(
    "after",
    `
Examples:
  Download to default temp path: zero phone download-file msg_123
  Download to explicit path:     zero phone download-file msg_123 -o /tmp/photo.jpg

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/phone-msg_123","mimetype":"image/jpeg","size":12345}

How to read the downloaded file:
  - Images (png/jpg/gif/webp/svg): open the file path with your image viewing tool
  - Videos (mp4/mov/webm): extract frames first with
      ffmpeg -i <path> -vf "fps=1" -q:v 2 /tmp/<file-id>_frame_%03d.jpg
    then view the extracted frames
  - PDF/text/csv/json/markdown: read the file directly`,
  )
  .action(
    withErrorHandler(async (fileId: string, options: { out?: string }) => {
      const outPath = options.out ?? defaultOutPath(fileId);
      const result = await downloadPhoneFile(fileId, outPath);
      console.log(JSON.stringify(result));
    }),
  );
