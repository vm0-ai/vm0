import { join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import { downloadWebFile } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

/**
 * Derive a local output path for a web-uploaded file id.
 * Uses the system temp directory.
 */
function defaultOutPath(fileId: string): string {
  return join(tmpdir(), `web-${fileId}`);
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download a web-uploaded file by id")
  .argument("<file-id>", "File id (UUID returned by the upload API)")
  .option(
    "-o, --out <path>",
    "Output path for the downloaded file (default: /tmp/web-<file-id>)",
  )
  .addHelpText(
    "after",
    `
Examples:
  Download to default temp path: zero web download-file abc-123-def
  Download to explicit path:     zero web download-file abc-123-def -o /tmp/report.pdf

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/web-abc-123-def","mimetype":"application/pdf","size":12345}

How to read the downloaded file:
  - Images (png/jpg/gif/webp/svg): open the file path with your image viewing tool
  - Videos (mp4/mov/webm): extract frames first with
      ffmpeg -i <path> -vf "fps=1" -q:v 2 /tmp/<file-id>_frame_%03d.jpg
    then view the extracted frames
  - PDF/text/csv/json/markdown: read the file directly

Notes:
  - Authenticates via ZERO_TOKEN
  - Streams the file bytes directly to disk`,
  )
  .action(
    withErrorHandler(async (fileId: string, options: { out?: string }) => {
      const outPath = options.out ?? defaultOutPath(fileId);
      const result = await downloadWebFile(fileId, outPath);
      console.log(JSON.stringify(result));
    }),
  );
