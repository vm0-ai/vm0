import { Command } from "commander";
import { checkAuthStatus } from "../../lib/api/auth";

export const statusCommand = new Command()
  .name("status")
  .description("Show current authentication status")
  .action(async () => {
    await checkAuthStatus();
  });
