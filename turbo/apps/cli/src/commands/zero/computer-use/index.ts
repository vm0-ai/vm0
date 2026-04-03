import { Command } from "commander";
import { hostStartCommand } from "./host";
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
  .addCommand(hostStartCommand);

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
  Zoom into a region (from agent):   zero computer-use client zoom --x 0 --y 0 --width 500 --height 500
  Get screen info (from agent):      zero computer-use client info
  Left click at (500, 300):          zero computer-use client left-click 500 300
  Double click at (100, 200):        zero computer-use client double-click 100 200
  Drag from A to B:                  zero computer-use client left-click-drag 100 100 500 500
  Press mouse button:                zero computer-use client left-mouse-down 200 300
  Release mouse button:              zero computer-use client left-mouse-up 500 500
  Scroll down at position:           zero computer-use client scroll 500 300 down 5
  Read clipboard text:               zero computer-use client read-clipboard
  Write clipboard text:              zero computer-use client write-clipboard "hello"
  Press key combo:                   zero computer-use client key "cmd+c"
  Hold shift for 2 seconds:          zero computer-use client hold-key "shift" 2000
  Type text:                         zero computer-use client type "Hello, world!"
  Open an application:               zero computer-use client open-app Safari
  Open by bundle ID:                 zero computer-use client open-app "com.apple.Safari"
  Move mouse to (100, 200):          zero computer-use client mouse-move 100 200
  Get cursor position:               zero computer-use client cursor-position`,
  );
