import { statSync, readFileSync } from "fs";
import { basename } from "path";
import { Command } from "commander";
import chalk from "chalk";
import { initSlackFileUpload, completeSlackFileUpload } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const uploadFileCommand = new Command()
  .name("upload-file")
  .description("Upload a file to a Slack channel as the bot")
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .requiredOption("-c, --channel <id>", "Slack channel ID")
  .option("--thread <ts>", "Thread timestamp to post as a reply")
  .option("--title <title>", "Display title for the file")
  .option("--comment <text>", "Initial comment to accompany the file")
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:           zero slack upload-file -f /tmp/report.pdf -c C01234
  Upload to thread:        zero slack upload-file -f /tmp/log.txt -c C01234 --thread 1234567890.123456
  With title and comment:  zero slack upload-file -f /tmp/data.csv -c C01234 --title "Daily Report" --comment "Here's the report"

Notes:
  - Uses the bot token (not user SLACK_TOKEN), so no files:write permission is needed
  - Returns file_id and permalink for reference`,
  )
  .action(
    withErrorHandler(
      async (options: {
        file: string;
        channel: string;
        thread?: string;
        title?: string;
        comment?: string;
      }) => {
        // Validate file exists and get size
        let fileSize: number;
        try {
          const stat = statSync(options.file);
          fileSize = stat.size;
        } catch {
          throw new Error(`File not found: ${options.file}`);
        }

        if (fileSize === 0) {
          throw new Error("File is empty");
        }

        const filename = basename(options.file);

        // Step 1: Get pre-signed upload URL from server
        const { uploadUrl, fileId } = await initSlackFileUpload({
          filename,
          length: fileSize,
        });

        // Step 2: Upload file directly to Slack's pre-signed URL
        const fileContent = readFileSync(options.file);
        const uploadResponse = await fetch(uploadUrl, {
          method: "POST",
          body: fileContent,
        });

        if (!uploadResponse.ok) {
          throw new Error(
            `File upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
          );
        }

        // Step 3: Complete the upload and share to channel/thread
        const result = await completeSlackFileUpload({
          fileId,
          channel: options.channel,
          threadTs: options.thread,
          title: options.title,
          initialComment: options.comment,
        });

        console.log(chalk.green(`✓ File uploaded (file_id: ${result.fileId})`));
        console.log(chalk.dim(`  permalink: ${result.permalink}`));
      },
    ),
  );
