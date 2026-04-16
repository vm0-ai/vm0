import { Command } from "commander";
import { downloadFileCommand } from "./download-file";

export const zeroWebCommand = new Command()
  .name("web")
  .description("Download files uploaded via the web chat UI")
  .addCommand(downloadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Download a file:  zero web download-file <file-id> -o /tmp/out.pdf`,
  );
