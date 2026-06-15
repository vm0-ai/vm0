import { Command } from "commander";
import { withErrorHandler } from "../../lib/command";
import {
  requestDeveloperSupportConsent,
  submitDeveloperSupport,
} from "../../lib/api";

export const zeroDeveloperSupportCommand = new Command()
  .name("developer-support")
  .description("Submit a diagnostic report to the dev team")
  .requiredOption("--title <text>", "Issue title")
  .requiredOption("--description <text>", "Diagnostic description")
  .option("--consent-code <code>", "User-provided verification code")
  .addHelpText(
    "after",
    `
Examples:
  Step 1 — Get consent code:
    zero developer-support --title "GitHub 403 error" --description "Connector connected but API returns 403"

  Step 2 — Submit with code:
    zero developer-support --title "GitHub 403 error" --description "Connector connected but API returns 403" --consent-code A7X3

Notes:
  - The consent code must be provided by the user to confirm sharing their conversation
  - The dev team will receive a diagnostic bundle with conversation, environment, and connector info`,
  )
  .action(
    withErrorHandler(
      async (options: {
        title: string;
        description: string;
        consentCode?: string;
      }) => {
        if (!options.consentCode) {
          const { consentCode } = await requestDeveloperSupportConsent({
            title: options.title,
            description: options.description,
          });
          console.log(
            "Consent required to share chat history with developers.",
          );
          console.log(`Code: ${consentCode}`);
          console.log("Ask the user to confirm by providing this code.");
        } else {
          const { reference } = await submitDeveloperSupport({
            title: options.title,
            description: options.description,
            consentCode: options.consentCode,
          });
          console.log("Developer support request submitted successfully.");
          console.log(`Reference: ${reference}`);
        }
      },
    ),
  );
