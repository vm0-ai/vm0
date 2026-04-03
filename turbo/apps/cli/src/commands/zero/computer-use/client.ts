import { Command } from "commander";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import { callHost } from "../../../lib/computer-use/client";

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
      const filePath = join(dir, `screenshot-${timestamp}.${data.format}`);
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
