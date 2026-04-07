import { Command } from "commander";
import { hostStartCommand, hostStopCommand } from "./host";
import {
  clientScreenshotCommand,
  clientZoomCommand,
  clientInfoCommand,
  clientLeftClickCommand,
  clientRightClickCommand,
  clientMiddleClickCommand,
  clientDoubleClickCommand,
  clientTripleClickCommand,
  clientLeftClickDragCommand,
  clientLeftMouseDownCommand,
  clientLeftMouseUpCommand,
  clientScrollCommand,
  clientReadClipboardCommand,
  clientWriteClipboardCommand,
  clientKeyCommand,
  clientHoldKeyCommand,
  clientTypeCommand,
  clientOpenAppCommand,
  clientMouseMoveCommand,
  clientCursorPositionCommand,
} from "./client";

const hostCommand = new Command()
  .name("host")
  .description("Manage computer-use host daemon")
  .addCommand(hostStartCommand)
  .addCommand(hostStopCommand);

const clientCommand = new Command()
  .name("client")
  .description("Interact with remote computer-use host")
  .addCommand(clientScreenshotCommand)
  .addCommand(clientZoomCommand)
  .addCommand(clientInfoCommand)
  .addCommand(clientLeftClickCommand)
  .addCommand(clientRightClickCommand)
  .addCommand(clientMiddleClickCommand)
  .addCommand(clientDoubleClickCommand)
  .addCommand(clientTripleClickCommand)
  .addCommand(clientLeftClickDragCommand)
  .addCommand(clientLeftMouseDownCommand)
  .addCommand(clientLeftMouseUpCommand)
  .addCommand(clientScrollCommand)
  .addCommand(clientReadClipboardCommand)
  .addCommand(clientWriteClipboardCommand)
  .addCommand(clientKeyCommand)
  .addCommand(clientHoldKeyCommand)
  .addCommand(clientTypeCommand)
  .addCommand(clientOpenAppCommand)
  .addCommand(clientMouseMoveCommand)
  .addCommand(clientCursorPositionCommand);

clientCommand.addHelpText(
  "after",
  `
Coordinate System:
  All coordinates use macOS logical points, not physical pixels.
  On Retina displays, logical size = physical size / scaleFactor.
  Run "info" to check your screen's logical dimensions.

Examples:
  zero computer-use client screenshot
  zero computer-use client zoom --x 0 --y 0 --width 500 --height 500
  zero computer-use client info
  zero computer-use client left-click 500 300
  zero computer-use client scroll 500 300 down 5
  zero computer-use client key "cmd+c"`,
);

export const zeroComputerUseCommand = new Command()
  .name("computer-use")
  .description("Remote desktop control for cloud agents")
  .addCommand(hostCommand)
  .addCommand(clientCommand);
