import { Command } from "commander";
import { missingTokenCommand } from "./missing-token";

export const zeroDoctorCommand = new Command()
  .name("doctor")
  .description("Diagnostic tools for troubleshooting agent issues")
  .addCommand(missingTokenCommand);
