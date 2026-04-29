import { readFileSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { generateWebVoice } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface VoiceOptions {
  text?: string;
  voice: string;
  instructions?: string;
  json?: boolean;
}

function readText(options: VoiceOptions): string {
  if (options.text?.trim()) {
    return options.text.trim();
  }

  if (process.stdin.isTTY === false) {
    const text = readFileSync("/dev/stdin", "utf8").trim();
    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("--text is required", {
    cause: new Error('Usage: zero web voice --text "Hello"'),
  });
}

export const voiceCommand = new Command()
  .name("voice")
  .description("Generate a billed speech audio file from text")
  .option("--text <text>", "Text to speak; can also be piped via stdin")
  .option("--voice <voice>", "OpenAI voice to use", "marin")
  .option("--instructions <text>", "Voice style instructions")
  .option("--json", "Print metadata as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Generate speech:       zero web voice --text "Hello from vm0"
  Pipe text:             cat script.txt | zero web voice
  Pick a voice:          zero web voice --text "Ship it" --voice cedar

Output:
  Prints the generated /f/ audio file URL and metadata

Notes:
  - Authenticates via ZERO_TOKEN (requires file:write capability)
  - Charges org credits after successful audio generation
  - Uses gpt-4o-mini-tts with WAV output`,
  )
  .action(
    withErrorHandler(async (options: VoiceOptions) => {
      const text = readText(options);
      const result = await generateWebVoice({
        text,
        voice: options.voice,
        instructions: options.instructions,
      });

      if (options.json) {
        console.log(JSON.stringify(result));
        return;
      }

      console.log(chalk.green(`✓ Voice generated: ${result.url}`));
      console.log(chalk.dim(`  File: ${result.filename}`));
      console.log(chalk.dim(`  Duration: ${result.durationSeconds}s`));
      console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
      console.log(chalk.dim(`  Model: ${result.model}`));
      console.log(chalk.dim(`  Voice: ${result.voice}`));
    }),
  );
