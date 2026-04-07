import { execFile } from "child_process";
import { readFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

interface ScreenInfo {
  width: number;
  height: number;
  scaleFactor: number;
}

interface ScreenshotResult extends ScreenInfo {
  image: string;
  format: string;
}

interface RegionParams {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Capture a screenshot on macOS using the screencapture command.
 * Returns the image as a base64 string at logical resolution along with screen metadata.
 */
export async function captureScreenshot(): Promise<ScreenshotResult> {
  const tmpPath = join(tmpdir(), `vm0-screenshot-${randomUUID()}.jpg`);

  try {
    await execFileAsync("screencapture", ["-x", "-t", "jpg", tmpPath]);
    const info = await getScreenInfo();

    if (info.scaleFactor > 1) {
      await execFileAsync("sips", [
        "-z",
        String(info.height),
        String(info.width),
        "-s",
        "formatOptions",
        "80",
        tmpPath,
      ]);
    }

    const buffer = await readFile(tmpPath);

    return {
      image: buffer.toString("base64"),
      width: info.width,
      height: info.height,
      scaleFactor: info.scaleFactor,
      format: "jpg",
    };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * Capture a screenshot of a specific screen region on macOS.
 * Uses screencapture -R x,y,w,h to crop to the given rectangle (logical coordinates).
 * Returns the image at logical resolution to match the coordinate space.
 */
export async function captureRegionScreenshot(
  region: RegionParams,
): Promise<ScreenshotResult> {
  const tmpPath = join(tmpdir(), `vm0-zoom-${randomUUID()}.jpg`);

  try {
    const regionArg = `${region.x},${region.y},${region.width},${region.height}`;
    await execFileAsync("screencapture", [
      "-x",
      "-t",
      "jpg",
      "-R",
      regionArg,
      tmpPath,
    ]);

    const info = await getScreenInfo();

    if (info.scaleFactor > 1) {
      await execFileAsync("sips", [
        "-z",
        String(region.height),
        String(region.width),
        "-s",
        "formatOptions",
        "80",
        tmpPath,
      ]);
    }

    const buffer = await readFile(tmpPath);

    return {
      image: buffer.toString("base64"),
      width: region.width,
      height: region.height,
      scaleFactor: info.scaleFactor,
      format: "jpg",
    };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

interface DisplayResolution {
  _spdisplays_pixels?: string;
  _spdisplays_resolution?: string;
  spdisplays_resolution?: string;
}

interface DisplayData {
  spdisplays_ndrvs?: DisplayResolution[];
}

/**
 * Get screen logical resolution and scale factor on macOS using system_profiler.
 * Returns logical (point) dimensions that match the coordinate space used by all operations.
 */
export async function getScreenInfo(): Promise<ScreenInfo> {
  const { stdout } = await execFileAsync("system_profiler", [
    "SPDisplaysDataType",
    "-json",
  ]);

  const data = JSON.parse(stdout) as { SPDisplaysDataType?: DisplayData[] };
  const displays = data.SPDisplaysDataType ?? [];

  for (const gpu of displays) {
    const screens = gpu.spdisplays_ndrvs ?? [];
    for (const screen of screens) {
      const pixelStr = screen._spdisplays_pixels;
      if (pixelStr) {
        const pixelMatch = pixelStr.match(/(\d+)\s*x\s*(\d+)/);
        if (pixelMatch?.[1] && pixelMatch[2]) {
          const physicalWidth = parseInt(pixelMatch[1], 10);
          const physicalHeight = parseInt(pixelMatch[2], 10);

          const resStr =
            screen._spdisplays_resolution ?? screen.spdisplays_resolution ?? "";
          const resMatch = resStr.match(/(\d+)\s*x\s*(\d+)/);

          let scaleFactor: number;
          let logicalWidth: number;
          let logicalHeight: number;

          if (resMatch?.[1] && resMatch[2]) {
            logicalWidth = parseInt(resMatch[1], 10);
            logicalHeight = parseInt(resMatch[2], 10);
            scaleFactor = Math.round(physicalWidth / logicalWidth);
          } else {
            const isRetina = /retina/i.test(resStr);
            scaleFactor = isRetina ? 2 : 1;
            logicalWidth = Math.floor(physicalWidth / scaleFactor);
            logicalHeight = Math.floor(physicalHeight / scaleFactor);
          }

          return {
            width: logicalWidth,
            height: logicalHeight,
            scaleFactor,
          };
        }
      }
    }
  }

  return { width: 1920, height: 1080, scaleFactor: 1 };
}
