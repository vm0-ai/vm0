import { Command } from "commander";
import { writeFile, mkdir } from "fs/promises";
import { basename, join } from "path";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { callHost } from "../../../lib/computer-use/client";

// `data.format` flows from the remote host response into a path; `basename`
// strips any separators so a hostile value like `../../etc/passwd` cannot
// escape the screenshot directory.
function safeFormat(format: string): string {
  return basename(format);
}

function mouseClickCommand(
  name: string,
  action: string,
  description: string,
): Command {
  return new Command()
    .name(name)
    .description(description)
    .argument("<x>", "X coordinate (points)")
    .argument("<y>", "Y coordinate (points)")
    .action(
      withErrorHandler(async (xStr: string, yStr: string) => {
        const x = parseInt(xStr, 10);
        const y = parseInt(yStr, 10);
        if (Number.isNaN(x) || Number.isNaN(y)) {
          throw new Error("Coordinates must be integers");
        }
        const response = await callHost("/mouse", {
          method: "POST",
          body: { action, x, y },
        });
        const data = await response.json();
        process.stdout.write(JSON.stringify(data) + "\n");
      }),
    );
}

export const clientScreenshotCommand = new Command()
  .name("screenshot")
  .description("Capture a screenshot from the remote host")
  .action(
    withErrorHandler(async () => {
      const response = await callHost("/screenshot");
      const data = (await response.json()) as {
        width: number;
        height: number;
        scaleFactor: number;
        format: string;
        image: string;
      };

      const dir = "/tmp/computer-use";
      await mkdir(dir, { recursive: true });

      const timestamp = Date.now();
      const filePath = join(
        dir,
        `screenshot-${timestamp}.${safeFormat(data.format)}`,
      );
      const buffer = Buffer.from(data.image, "base64");
      await writeFile(filePath, buffer);

      // Path to stdout for programmatic consumption
      process.stdout.write(`${filePath}\n`);

      // Metadata to stderr for human/debug consumption
      process.stderr.write(
        JSON.stringify({
          width: data.width,
          height: data.height,
          scaleFactor: data.scaleFactor,
        }) + "\n",
      );
    }),
  );

export const clientZoomCommand = new Command()
  .name("zoom")
  .description("Capture a region screenshot from the remote host")
  .requiredOption("--x <number>", "X coordinate of the region")
  .requiredOption("--y <number>", "Y coordinate of the region")
  .requiredOption("--width <number>", "Width of the region")
  .requiredOption("--height <number>", "Height of the region")
  .action(
    withErrorHandler(
      async (opts: { x: string; y: string; width: string; height: string }) => {
        const params = new URLSearchParams({
          x: opts.x,
          y: opts.y,
          width: opts.width,
          height: opts.height,
        });
        const response = await callHost(`/zoom?${params.toString()}`);
        const data = (await response.json()) as {
          width: number;
          height: number;
          scaleFactor: number;
          format: string;
          image: string;
        };

        const dir = "/tmp/computer-use";
        await mkdir(dir, { recursive: true });

        const timestamp = Date.now();
        const filePath = join(
          dir,
          `zoom-${timestamp}.${safeFormat(data.format)}`,
        );
        const buffer = Buffer.from(data.image, "base64");
        await writeFile(filePath, buffer);

        process.stdout.write(`${filePath}\n`);

        process.stderr.write(
          JSON.stringify({
            width: data.width,
            height: data.height,
            scaleFactor: data.scaleFactor,
          }) + "\n",
        );
      },
    ),
  );

export const clientInfoCommand = new Command()
  .name("info")
  .description("Get screen info from the remote host")
  .action(
    withErrorHandler(async () => {
      const response = await callHost("/info");
      const data = (await response.json()) as {
        width: number;
        height: number;
        scaleFactor: number;
      };

      process.stdout.write(JSON.stringify(data) + "\n");
    }),
  );

export const clientLeftClickCommand = mouseClickCommand(
  "left-click",
  "left_click",
  "Perform a left click at coordinates",
);

export const clientRightClickCommand = mouseClickCommand(
  "right-click",
  "right_click",
  "Perform a right click at coordinates",
);

export const clientMiddleClickCommand = mouseClickCommand(
  "middle-click",
  "middle_click",
  "Perform a middle click at coordinates",
);

export const clientDoubleClickCommand = mouseClickCommand(
  "double-click",
  "double_click",
  "Perform a double click at coordinates",
);

export const clientTripleClickCommand = mouseClickCommand(
  "triple-click",
  "triple_click",
  "Perform a triple click at coordinates",
);

export const clientLeftClickDragCommand = new Command()
  .name("left-click-drag")
  .description("Drag from (startX, startY) to (endX, endY)")
  .argument("<startX>", "Start X coordinate")
  .argument("<startY>", "Start Y coordinate")
  .argument("<endX>", "End X coordinate")
  .argument("<endY>", "End Y coordinate")
  .action(
    withErrorHandler(
      async (startX: string, startY: string, endX: string, endY: string) => {
        await callHost("/mouse", {
          method: "POST",
          body: {
            action: "left_click_drag",
            startX: Number(startX),
            startY: Number(startY),
            endX: Number(endX),
            endY: Number(endY),
          },
        });
        process.stdout.write("ok\n");
      },
    ),
  );

export const clientLeftMouseDownCommand = new Command()
  .name("left-mouse-down")
  .description("Press and hold the left mouse button at (x, y)")
  .argument("<x>", "X coordinate")
  .argument("<y>", "Y coordinate")
  .action(
    withErrorHandler(async (x: string, y: string) => {
      await callHost("/mouse", {
        method: "POST",
        body: { action: "left_mouse_down", x: Number(x), y: Number(y) },
      });
      process.stdout.write("ok\n");
    }),
  );

export const clientLeftMouseUpCommand = new Command()
  .name("left-mouse-up")
  .description("Release the left mouse button at (x, y)")
  .argument("<x>", "X coordinate")
  .argument("<y>", "Y coordinate")
  .action(
    withErrorHandler(async (x: string, y: string) => {
      await callHost("/mouse", {
        method: "POST",
        body: { action: "left_mouse_up", x: Number(x), y: Number(y) },
      });
      process.stdout.write("ok\n");
    }),
  );

export const clientScrollCommand = new Command()
  .name("scroll")
  .description("Scroll at the given screen position")
  .argument("<x>", "X coordinate")
  .argument("<y>", "Y coordinate")
  .argument("<direction>", "Scroll direction: up, down, left, right")
  .argument("[amount]", "Scroll amount in lines (default 3)")
  .action(
    withErrorHandler(
      async (x: string, y: string, direction: string, amount?: string) => {
        await callHost("/mouse", {
          method: "POST",
          body: {
            action: "scroll",
            x: Number(x),
            y: Number(y),
            direction,
            ...(amount !== undefined && { amount: Number(amount) }),
          },
        });
        process.stdout.write("ok\n");
      },
    ),
  );

export const clientReadClipboardCommand = new Command()
  .name("read-clipboard")
  .description("Read text content from the remote clipboard")
  .action(
    withErrorHandler(async () => {
      const response = await callHost("/clipboard");
      const data = (await response.json()) as { text: string };
      process.stdout.write(data.text);
    }),
  );

export const clientWriteClipboardCommand = new Command()
  .name("write-clipboard")
  .description("Write text content to the remote clipboard")
  .argument("<text>", "Text to write to clipboard")
  .action(
    withErrorHandler(async (text: string) => {
      await callHost("/clipboard", {
        method: "POST",
        body: { text },
      });
      process.stdout.write("ok\n");
    }),
  );

export const clientKeyCommand = new Command()
  .name("key")
  .description("Press a key or key combination (e.g., cmd+c, return)")
  .argument("<combo>", "Key combo string (e.g., cmd+c, ctrl+shift+s, return)")
  .action(
    withErrorHandler(async (combo: string) => {
      await callHost("/keyboard", {
        method: "POST",
        body: { action: "key", keys: combo },
      });
      process.stdout.write("ok\n");
    }),
  );

export const clientHoldKeyCommand = new Command()
  .name("hold-key")
  .description("Hold a key or key combination for a duration")
  .argument("<combo>", "Key combo string (e.g., shift, cmd+shift)")
  .argument("<durationMs>", "Duration to hold in milliseconds")
  .action(
    withErrorHandler(async (combo: string, durationStr: string) => {
      const durationMs = parseInt(durationStr, 10);
      if (Number.isNaN(durationMs) || durationMs <= 0) {
        throw new Error("durationMs must be a positive integer");
      }
      await callHost("/keyboard", {
        method: "POST",
        body: { action: "hold_key", keys: combo, durationMs },
      });
      process.stdout.write("ok\n");
    }),
  );

export const clientTypeCommand = new Command()
  .name("type")
  .description("Type text at the current cursor position")
  .argument("<text>", "Text to type")
  .action(
    withErrorHandler(async (text: string) => {
      await callHost("/keyboard", {
        method: "POST",
        body: { action: "type", text },
      });
      process.stdout.write("ok\n");
    }),
  );

export const clientOpenAppCommand = new Command()
  .name("open-app")
  .description("Open or activate a macOS application by name or bundle ID")
  .argument(
    "<nameOrBundleId>",
    "App name (e.g., Safari) or bundle ID (e.g., com.apple.Safari)",
  )
  .action(
    withErrorHandler(async (nameOrBundleId: string) => {
      await callHost("/open-application", {
        method: "POST",
        body: { nameOrBundleId },
      });
      process.stdout.write("ok\n");
    }),
  );

export const clientMouseMoveCommand = mouseClickCommand(
  "mouse-move",
  "move",
  "Move mouse pointer to coordinates",
);

export const clientCursorPositionCommand = new Command()
  .name("cursor-position")
  .description("Get current cursor position from the remote host")
  .action(
    withErrorHandler(async () => {
      const response = await callHost("/cursor-position");
      const data = (await response.json()) as { x: number; y: number };
      process.stdout.write(JSON.stringify(data) + "\n");
    }),
  );
