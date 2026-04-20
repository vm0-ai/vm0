import { Command } from "commander";
import { loginCommand } from "./login";
import { logoutCommand } from "./logout";
import { statusCommand } from "./status";
import { setupTokenCommand } from "./setup-token";

export const authCommand = new Command()
  .name("auth")
  .description("Authenticate vm0")
  .addCommand(loginCommand)
  .addCommand(logoutCommand)
  .addCommand(statusCommand)
  .addCommand(setupTokenCommand);
