import { Command } from "commander";
import { authenticate } from "../../lib/api/auth";
import { withErrorHandler } from "../../lib/command";

export const loginCommand = new Command()
  .name("login")
  .description("Log in to VM0 (use VM0_API_URL env var to set API URL)")
  .action(
    withErrorHandler(async () => {
      await authenticate();
    }),
  );
