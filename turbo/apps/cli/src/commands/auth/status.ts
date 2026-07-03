import { Command } from "commander";
import { checkAuthStatus } from "../../lib/api/auth";
import { withErrorHandler } from "../../lib/command";

export const statusCommand = new Command()
  .name("status")
  .description("Show current authentication status")
  .action(
    withErrorHandler(async () => {
      await checkAuthStatus();
    }),
  );
