import { translationRequestSchema } from "@okouai/api-contracts/contracts/translation";
import { Command, InvalidArgumentError } from "commander";

import { callTranslation } from "../../lib/api/domains/translation";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface TranslateOptions {
  readonly to: string;
  readonly from?: string;
}

export const translateCommand = new Command()
  .name("translate")
  .description("Translate text through a managed translation model")
  .argument("<text>", "Text to translate")
  .requiredOption("--to <language>", "Target language name or code")
  .option("--from <language>", "Source language name or code")
  .action(
    withErrorHandler(async (text: string, options: TranslateOptions) => {
      const request = translationRequestSchema.safeParse({
        text,
        targetLanguage: options.to,
        ...(options.from === undefined ? {} : { sourceLanguage: options.from }),
      });
      if (!request.success) {
        throw new InvalidArgumentError(
          request.error.issues[0]?.message ?? "translation request is invalid",
        );
      }

      const response = await callTranslation(request.data);
      console.log(response.text);
    }),
  )
  .addHelpText(
    "after",
    `
Examples:
  Auto-detect source:  okou translate "Hello, world" --to "Simplified Chinese"
  Specify both:        okou translate "Bonjour" --from French --to English

Notes:
  - Available only inside agent runs with the translation:write capability
  - Uses a fixed Okou-managed Qwen 7B translation model
  - Prints only the translated text`,
  );
