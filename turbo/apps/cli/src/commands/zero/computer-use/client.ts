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
