import { zeroTranslationRequestSchema } from "@vm0/api-contracts/contracts/zero-translation";
import { Command, InvalidArgumentError } from "commander";

import { callZeroTranslation } from "../../../lib/api/domains/zero-translation";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

interface TranslateOptions {
  readonly to: string;
  readonly from?: string;
}

export const zeroTranslateCommand = new Command()
  .name("translate")
  .description("Translate text through a managed translation model")
  .argument("<text>", "Text to translate")
  .requiredOption("--to <language>", "Target language name or code")
  .option("--from <language>", "Source language name or code")
  .action(
    withErrorHandler(async (text: string, options: TranslateOptions) => {
      const request = zeroTranslationRequestSchema.safeParse({
        text,
        targetLanguage: options.to,
        ...(options.from === undefined ? {} : { sourceLanguage: options.from }),
      });
      if (!request.success) {
        throw new InvalidArgumentError(
          request.error.issues[0]?.message ?? "translation request is invalid",
        );
      }

      const response = await callZeroTranslation(request.data);
      console.log(response.text);
    }),
  )
  .addHelpText(
    "after",
    `
Examples:
  Auto-detect source:  zero translate "Hello, world" --to "Simplified Chinese"
  Specify both:        zero translate "Bonjour" --from French --to English

Notes:
  - Available only inside Zero runs with the translation:write capability
  - Uses a fixed vm0-managed Qwen 7B translation model
  - Prints only the translated text`,
  );
