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

export type MouseAction =
  | "left_click"
  | "right_click"
  | "middle_click"
  | "double_click"
  | "triple_click";

const ACTION_COMMANDS: Record<MouseAction, string> = {
  left_click: "c",
  right_click: "rc",
  middle_click: "mc",
  double_click: "dc",
  triple_click: "tc",
};

export const VALID_ACTIONS = new Set<string>(Object.keys(ACTION_COMMANDS));

/**
 * Verify that cliclick is installed on the system.
 * Throws with install instructions if not found.
 */
async function checkCliclickInstalled(): Promise<void> {
  try {
    await execFileAsync("which", ["cliclick"]);
  } catch {
    throw new Error("cliclick not found. Install with: brew install cliclick");
  }
}

/**
 * Execute a mouse click action at the given coordinates using cliclick.
 */
export async function executeMouseAction(
  action: MouseAction,
  x: number,
  y: number,
): Promise<void> {
  await checkCliclickInstalled();
  const prefix = ACTION_COMMANDS[action];
  await execFileAsync("cliclick", [`${prefix}:${x},${y}`]);
}
