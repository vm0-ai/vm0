import { Command, Option } from "commander";
import chalk from "chalk";
import { generateWebVoice } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { dispatchGenerate } from "../generate/lib/dispatch";
import type { GenerationType } from "../generate/lib/lister";

interface VoiceOptions {
  prompt?: string;
  text?: string;
  provider?: string;
  voice: string;
  instructions?: string;
  all?: boolean;
}

interface VoiceGenerateCommandConfig {
  name: string;
  generationType: GenerationType;
  usageCommand: string;
  examples: string;
}

export function createVoiceGenerateCommand(
  config: VoiceGenerateCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description("Generate a billed speech audio file from text")
    .option("--prompt <text>", "Text to speak; can also be piped via stdin")
    .addOption(new Option("--text <text>", "Alias for --prompt").hideHelp())
    .option(
      "--provider <name>",
      "Provider: 'built-in' to run vm0's pipeline, or a connector name (heygen, elevenlabs, ...) to get its skill-invocation guidance",
    )
    .option(
      "--all",
      "When listing providers (no --prompt given), include unavailable or not-yet-authorized connectors",
    )
    .option("--voice <voice>", "OpenAI voice to use", "marin")
    .option("--instructions <text>", "Voice style instructions")
    .addHelpText(
      "after",
      `
Examples:
${config.examples}

Output:
  Prints the generated /f/ audio file URL and metadata. With no --prompt
  and no piped input, prints the provider menu instead.

Notes:
  - Authenticates via ZERO_TOKEN (requires file:write capability)
  - Charges org credits after successful audio generation
  - Uses gpt-4o-mini-tts with WAV output`,
    )
    .action(
      withErrorHandler(async (options: VoiceOptions) => {
        const dispatch = await dispatchGenerate({
          generationType: config.generationType,
          provider: options.provider,
          prompt: options.prompt ?? options.text,
          all: options.all,
        });
        if (dispatch.outcome === "handled") return;
        const text = dispatch.prompt;

        const result = await generateWebVoice({
          text,
          voice: options.voice,
          instructions: options.instructions,
        });

        console.log(chalk.green(`✓ Voice generated: ${result.url}`));
        console.log(chalk.dim(`  File: ${result.filename}`));
        console.log(chalk.dim(`  Duration: ${result.durationSeconds}s`));
        console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
        console.log(chalk.dim(`  Model: ${result.model}`));
        console.log(chalk.dim(`  Voice: ${result.voice}`));
      }),
    );
}
