import { Command } from "commander";
import { setupToken } from "../../lib/api/auth";

export const setupTokenCommand = new Command()
  .name("setup-token")
  .description("Output auth token for CI/CD environments")
  .action(async () => {
    await setupToken();
  });
