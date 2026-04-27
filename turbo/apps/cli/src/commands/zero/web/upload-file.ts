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
  - Allowed types: png / jpeg / gif / webp / svg / mp4 / webm / mov / pdf / txt / csv / md / html / json`,
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
