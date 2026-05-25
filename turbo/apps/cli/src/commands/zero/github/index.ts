import { Command } from "commander";
import { downloadFileCommand } from "./download-file";
import { labelListenerCommand } from "./label-listener";
import { uploadFileCommand } from "./upload-file";

export const zeroGithubCommand = new Command()
  .name("github")
  .description("Manage GitHub integration files and label listeners")
  .addCommand(downloadFileCommand)
  .addCommand(labelListenerCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:    zero github upload-file -f /tmp/report.pdf -r vm0-ai/vm0 -i 42
  Download a file:  zero github download-file https://github.com/user-attachments/assets/abc123 -o /tmp/out.png
  List labels:      zero github label-listener list`,
  );
