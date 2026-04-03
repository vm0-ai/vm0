import { Command } from "commander";
import { hostStartCommand } from "./host";
import {
  clientScreenshotCommand,
  clientInfoCommand,
  clientLeftClickDragCommand,
  clientLeftMouseDownCommand,
  clientLeftMouseUpCommand,
  clientScrollCommand,
  clientReadClipboardCommand,
  clientWriteClipboardCommand,
} from "./client";

const hostCommand = new Command()
  .name("host")
  .description("Manage computer-use host daemon")
  .addCommand(hostStartCommand);

const clientCommand = new Command()
  .name("client")
  .description("Interact with remote computer-use host")
  .addCommand(clientScreenshotCommand)
  .addCommand(clientInfoCommand)
  .addCommand(clientLeftClickDragCommand)
  .addCommand(clientLeftMouseDownCommand)
  .addCommand(clientLeftMouseUpCommand)
  .addCommand(clientScrollCommand)
  .addCommand(clientReadClipboardCommand)
  .addCommand(clientWriteClipboardCommand);

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
  Get screen info (from agent):      zero computer-use client info
  Drag from A to B:                  zero computer-use client left-click-drag 100 100 500 500
  Press mouse button:                zero computer-use client left-mouse-down 200 300
  Release mouse button:              zero computer-use client left-mouse-up 500 500
  Scroll down at position:           zero computer-use client scroll 500 300 down 5
  Read clipboard text:               zero computer-use client read-clipboard
  Write clipboard text:              zero computer-use client write-clipboard "hello"`,
  );
