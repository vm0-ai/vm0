import { Command } from "commander";
import { hostStartCommand } from "./host";
import { clientScreenshotCommand, clientInfoCommand } from "./client";

const hostCommand = new Command()
  .name("host")
  .description("Manage computer-use host daemon")
  .addCommand(hostStartCommand);

const clientCommand = new Command()
  .name("client")
  .description("Interact with remote computer-use host")
  .addCommand(clientScreenshotCommand)
  .addCommand(clientInfoCommand);

export const zeroComputerUseCommand = new Command()
  .name("computer-use")
  .description("Remote desktop control for cloud agents")
  .addCommand(hostCommand)
  .addCommand(clientCommand)
  .addHelpText(
    "after",
    `
Examples:
  Start the host daemon (on macOS):  zero computer-use host start
  Take a screenshot (from agent):    zero computer-use client screenshot
  Get screen info (from agent):      zero computer-use client info`,
  );
