import { Command } from "commander";
import { logout } from "../../lib/api/auth";
import { withErrorHandler } from "../../lib/command";

export const logoutCommand = new Command()
  .name("logout")
  .description("Log out of VM0")
  .action(
    withErrorHandler(async () => {
      await logout();
    }),
  );
