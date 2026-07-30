import { readFileSync, statSync } from "fs";
import { basename, extname } from "path";
import { Command } from "commander";
import { completeTeamsFileUpload, initTeamsFileUpload } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".json": "application/json",
};

function inferContentType(localPath: string): string {
  const ext = extname(localPath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

export const uploadFileCommand = new Command()
  .name("upload-file")
  .description(
    "Upload a local file to a Microsoft Teams conversation as the bot",
  )
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .requiredOption("-c, --conversation-id <id>", "Teams conversation ID")
  .option("--activity-id <id>", "Activity ID to reply to")
  .option("-t, --text <message>", "Message text to accompany the file")
  .option("--content-type <mime>", "Override inferred content type")
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:     zero teams upload-file -f /tmp/report.pdf -c 19:thread@thread.tacv2
  Upload to thread:  zero teams upload-file -f /tmp/log.txt -c 19:thread@thread.tacv2 --activity-id root-activity
  With message text: zero teams upload-file -f /tmp/data.csv -c 19:thread@thread.tacv2 -t "Daily report"

Output:
  Prints a JSON object to stdout on success:
    {"activityId":"...","conversationId":"19:...","filename":"report.pdf","mimetype":"application/pdf","size":12345,"url":"https://..."}

Notes:
  - Uploads through VM0 storage first, then sends the Teams message with the file URL
  - Use the Conversation ID and Activity ID from the current Teams run prompt`,
  )
  .action(
    withErrorHandler(
      async (options: {
        file: string;
        conversationId: string;
        activityId?: string;
        text?: string;
        contentType?: string;
      }) => {
        let fileSize: number;
        try {
          const stat = statSync(options.file);
          if (!stat.isFile()) {
            throw new Error(`Not a regular file: ${options.file}`);
          }
          fileSize = stat.size;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Not ")) {
            throw error;
          }
          throw new Error(`File not found: ${options.file}`);
        }

        if (fileSize === 0) {
          throw new Error("File is empty");
        }

        const filename = basename(options.file);
        const contentType =
          options.contentType ?? inferContentType(options.file);
        const prepared = await initTeamsFileUpload({
          filename,
          contentType,
          length: fileSize,
          supportsUploadHeaders: true,
        });

        const fileContent = readFileSync(options.file);
        const uploadResponse = await fetch(prepared.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": prepared.contentType,
            ...prepared.uploadHeaders,
          },
          body: new Uint8Array(fileContent),
        });

        if (!uploadResponse.ok) {
          throw new Error(
            `File upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
          );
        }

        const result = await completeTeamsFileUpload({
          uploadId: prepared.uploadId,
          conversationId: options.conversationId,
          activityId: options.activityId,
          contentType: prepared.contentType,
          text: options.text,
        });

        console.log(JSON.stringify(result));
      },
    ),
  );
