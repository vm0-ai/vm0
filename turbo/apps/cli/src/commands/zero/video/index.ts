import { Command } from "commander";
import { transcribeCommand } from "./transcribe";
import { framesCommand } from "./frames";

export const zeroVideoCommand = new Command()
  .name("video")
  .description("Video processing utilities")
  .addCommand(transcribeCommand)
  .addCommand(framesCommand)
  .addHelpText(
    "after",
    `
Examples:
  Transcribe a video:  zero video transcribe --url "https://..."
  Web file:            zero video transcribe --file-id abc-123
  Extract frames:      zero video frames --url "https://..." --at 00:21,01:40

Tip (video understanding):
  Transcribe first to get a timestamped index, then extract only the
  frames worth seeing instead of watching the whole video.`,
  );
