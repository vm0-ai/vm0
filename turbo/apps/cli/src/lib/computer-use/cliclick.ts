import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Drag from (startX, startY) to (endX, endY) using cliclick.
 * Sends dd (drag down) at start, then du (drag up) at end.
 */
export async function leftClickDrag(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): Promise<void> {
  await execFileAsync("cliclick", [
    `dd:${startX},${startY}`,
    `du:${endX},${endY}`,
  ]);
}

/**
 * Press and hold the left mouse button at (x, y).
 */
export async function leftMouseDown(x: number, y: number): Promise<void> {
  await execFileAsync("cliclick", [`dd:${x},${y}`]);
}

/**
 * Release the left mouse button at (x, y).
 */
export async function leftMouseUp(x: number, y: number): Promise<void> {
  await execFileAsync("cliclick", [`du:${x},${y}`]);
}
