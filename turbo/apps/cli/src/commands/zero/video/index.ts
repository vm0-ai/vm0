import { Command } from "commander";
import { transcribeCommand } from "./transcribe";

export const zeroVideoCommand = new Command()
  .name("video")
  .description("Video processing utilities")
  .addCommand(transcribeCommand)
  .addHelpText(
    "after",
    `
Examples:
  Transcribe a video:  zero video transcribe --url "https://..."
  Web file:            zero video transcribe --file-id abc-123`,
  );
