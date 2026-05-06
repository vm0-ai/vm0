import { Command } from "commander";
import { uploadWebFile } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const uploadFileCommand = new Command()
  .name("upload-file")
  .description("Upload a local file and print a permanent URL")
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .option("--content-type <mime>", "Override inferred content type")
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:           zero web upload-file -f /tmp/report.pdf
  Override content-type:   zero web upload-file -f /tmp/data --content-type text/csv

Output:
  Prints a JSON object to stdout on success:
    {"id":"...","filename":"...","contentType":"...","size":N,"url":"https://..."}

Notes:
  - Authenticates via ZERO_TOKEN (requires file:write capability)
  - Returned URL is permanent (serves a short-lived signed redirect on access)
  - Safe to persist in chat messages or share over external channels
  - Max file size: 1 GB
  - Allowed image types: png / jpeg / gif / webp / avif / svg
  - Allowed video types: mp4 / webm / mov
  - Allowed audio types: aac / flac / m4a / mp3 / mp4 / mpga / ogg / opus / wav / webm
  - Allowed document/text types: pdf / txt / csv / md / html / json / doc(x) / xls(x) / ppt(x) / odt / ods / odp / rtf
  - Use --content-type for ambiguous extensions like .mp4 or .webm when needed`,
  )
  .action(
    withErrorHandler(
      async (options: { file: string; contentType?: string }) => {
        const result = await uploadWebFile(options.file, {
          contentType: options.contentType,
        });
        console.log(JSON.stringify(result));
      },
    ),
  );
