import { Command } from "commander";
import { logout } from "../../lib/api/auth";

export const logoutCommand = new Command()
  .name("logout")
  .description("Log out of VM0")
  .action(async () => {
    await logout();
  });
