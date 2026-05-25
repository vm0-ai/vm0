import { basename, join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import { downloadGithubFile } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

function defaultOutPath(fileId: string, filename?: string): string {
  return join(tmpdir(), `github-${filename || basename(fileId) || "file"}`);
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download a file from a GitHub context block")
  .argument("<file-id>", "ID from a [GitHub file] block")
  .option(
    "-o, --out <path>",
    "Output path for the downloaded file (default: /tmp/github-<filename-or-id>)",
  )
  .option("--filename <name>", "Filename hint from the [GitHub file] block")
  .addHelpText(
    "after",
    `
Examples:
  Download to default temp path: zero github download-file 8a6e1f02-0a08-4cf0-b3ac-f2892ed6f0ba --filename screenshot.png
  Download to explicit path:     zero github download-file 8a6e1f02-0a08-4cf0-b3ac-f2892ed6f0ba -o /tmp/screenshot.png

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/github-screenshot.png","mimetype":"image/png","size":12345}

How to read the downloaded file:
  - Images (png/jpg/gif/webp/svg): open the file path with your image viewing tool
  - Videos (mp4/mov/webm): extract frames first with
      ffmpeg -i <path> -vf "fps=1" -q:v 2 /tmp/github_frame_%03d.jpg
    then view the extracted frames
  - PDF/text/csv/json/markdown: read the file directly

Notes:
  - The file id comes from a [GitHub file] block
  - Streams the file bytes from VM0 storage directly to disk`,
  )
  .action(
    withErrorHandler(
      async (fileId: string, options: { out?: string; filename?: string }) => {
        const outPath = options.out ?? defaultOutPath(fileId, options.filename);
        const result = await downloadGithubFile(
          fileId,
          outPath,
          options.filename,
        );
        console.log(JSON.stringify(result));
      },
    ),
  );
