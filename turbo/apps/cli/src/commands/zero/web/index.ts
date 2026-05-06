import { Command } from "commander";
import { downloadFileCommand } from "./download-file";
import { uploadFileCommand } from "./upload-file";
import { voiceCommand } from "./voice";

export const zeroWebCommand = new Command()
  .name("web")
  .description("Upload, download, and generate files via the web chat endpoint")
  .addCommand(downloadFileCommand)
  .addCommand(voiceCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:    zero web upload-file -f /tmp/report.pdf
  Download a file:  zero web download-file <file-id> -o /tmp/out.pdf
  Generate speech:  zero web voice --text "Hello"`,
  );
