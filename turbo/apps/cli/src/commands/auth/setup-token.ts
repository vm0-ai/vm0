import { Command } from "commander";
import { setupToken } from "../../lib/api/auth";
import { withErrorHandler } from "../../lib/command";

export const setupTokenCommand = new Command()
  .name("setup-token")
  .description("Output auth token for CI/CD environments")
  .action(
    withErrorHandler(async () => {
      await setupToken();
    }),
  );
