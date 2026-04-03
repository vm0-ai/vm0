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
 * Returns the image as a base64 string along with screen metadata.
 */
export async function captureScreenshot(): Promise<ScreenshotResult> {
  const tmpPath = join(tmpdir(), `vm0-screenshot-${randomUUID()}.jpg`);

  try {
    await execFileAsync("screencapture", ["-x", "-t", "jpg", tmpPath]);
    const buffer = await readFile(tmpPath);
    const info = await getScreenInfo();

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
 * Uses screencapture -R x,y,w,h to crop to the given rectangle.
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
    const buffer = await readFile(tmpPath);

    return {
      image: buffer.toString("base64"),
      width: region.width,
      height: region.height,
      scaleFactor: 1,
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
 * Get screen resolution and scale factor on macOS using system_profiler.
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
        const match = pixelStr.match(/(\d+)\s*x\s*(\d+)/);
        if (match?.[1] && match[2]) {
          const width = parseInt(match[1], 10);
          const height = parseInt(match[2], 10);

          const resStr =
            screen._spdisplays_resolution ?? screen.spdisplays_resolution ?? "";
          const isRetina = /retina/i.test(resStr);
          const scaleFactor = isRetina ? 2 : 1;

          return { width, height, scaleFactor };
        }
      }
    }
  }

  return { width: 1920, height: 1080, scaleFactor: 1 };
}
