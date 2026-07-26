import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Command } from "commander";
import type { FeishuResourceType } from "@vm0/api-contracts/contracts/integrations";

import { downloadFeishuFile } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

function defaultOutPath(fileKey: string): string {
  return join(tmpdir(), `feishu-${basename(fileKey).slice(0, 80)}`);
}

function parseResourceType(value: string): FeishuResourceType {
  if (value !== "file" && value !== "image") {
    throw new Error("--type must be either file or image");
  }
  return value;
}

export const downloadFileCommand = new Command()
  .name("download-file")
  .description("Download a file from a Feishu message")
  .argument("<message-id>", "Message ID from a [Feishu file] block")
  .argument("<file-key>", "File key from a [Feishu file] block")
  .requiredOption(
    "--type <type>",
    "Resource type from the block: file or image",
  )
  .option("-i, --installation <id>", "Feishu installation ID")
  .option("-o, --out <path>", "Output path (default: /tmp/feishu-<file-key>)")
  .addHelpText(
    "after",
    `
Examples:
  Download a file:   zero feishu download-file om_xxx file_xxx --type file
  Download an image: zero feishu download-file om_xxx img_xxx --type image -o /tmp/image.png
  Select an app:     zero feishu download-file om_xxx file_xxx --type file -i <installation-id>

Output:
  Prints a JSON object to stdout on success:
    {"path":"/tmp/feishu-file_xxx","mimetype":"application/pdf","size":12345}

Notes:
  - Use the message ID, file key, and type exactly as shown in a [Feishu file] block
  - Specify --installation when the organization has multiple Feishu bots
  - Streams the file bytes directly to disk`,
  )
  .action(
    withErrorHandler(
      async (
        messageId: string,
        fileKey: string,
        options: {
          readonly type: string;
          readonly installation?: string;
          readonly out?: string;
        },
      ) => {
        const outPath = options.out ?? defaultOutPath(fileKey);
        const result = await downloadFeishuFile(
          messageId,
          fileKey,
          parseResourceType(options.type),
          options.installation,
          outPath,
        );
        console.log(JSON.stringify(result));
      },
    ),
  );
