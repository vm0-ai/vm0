import { basename, join } from "path";
import { tmpdir } from "os";
import { Command } from "commander";
import { downloadGithubFile } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

function defaultOutPath(fileUrl: string): string {
  try {
    const parsed = new URL(fileUrl);
    const pathName = basename(parsed.pathname);
    return join(tmpdir(), `github-${pathName || "file"}`);
  } catch {
    return join(tmpdir(), "github-file");
  }
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download a GitHub attachment or raw file URL")
  .argument("<url>", "URL from a [GitHub file] block")
  .option(
    "-o, --out <path>",
    "Output path for the downloaded file (default: /tmp/github-<url-basename>)",
  )
  .option("--filename <name>", "Filename hint from the [GitHub file] block")
  .addHelpText(
    "after",
    `
Examples:
  Download to default temp path: zero github download-file https://github.com/user-attachments/assets/abc123
  Download to explicit path:     zero github download-file https://github.com/user-attachments/assets/abc123 -o /tmp/screenshot.png

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/github-abc123","mimetype":"image/png","size":12345}

How to read the downloaded file:
  - Images (png/jpg/gif/webp/svg): open the file path with your image viewing tool
  - Videos (mp4/mov/webm): extract frames first with
      ffmpeg -i <path> -vf "fps=1" -q:v 2 /tmp/github_frame_%03d.jpg
    then view the extracted frames
  - PDF/text/csv/json/markdown: read the file directly

Notes:
  - Uses the GitHub App installation on the server side
  - Streams the file bytes directly to disk`,
  )
  .action(
    withErrorHandler(
      async (fileUrl: string, options: { out?: string; filename?: string }) => {
        const outPath = options.out ?? defaultOutPath(fileUrl);
        const result = await downloadGithubFile(
          fileUrl,
          outPath,
          options.filename,
        );
        console.log(JSON.stringify(result));
      },
    ),
  );
