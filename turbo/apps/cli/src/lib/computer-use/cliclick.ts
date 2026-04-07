import { execFile } from "child_process";
import { promisify } from "util";
import { setTimeout as sleep } from "timers/promises";

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
  | "triple_click"
  | "move";

const ACTION_COMMANDS: Record<MouseAction, string> = {
  left_click: "c",
  right_click: "rc",
  middle_click: "mc",
  double_click: "dc",
  triple_click: "tc",
  move: "m",
};

export const VALID_ACTIONS = new Set<string>(Object.keys(ACTION_COMMANDS));

/**
 * Check whether cliclick is available on the system.
 * Returns true if installed, false otherwise.
 */
export async function isCliclickInstalled(): Promise<boolean> {
  try {
    await execFileAsync("which", ["cliclick"]);
    return true;
  } catch {
    return false;
  }
}

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
 * Execute a mouse action at the given coordinates using cliclick.
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

/**
 * Get the current cursor position using cliclick.
 * Returns coordinates in points.
 */
export async function getCursorPosition(): Promise<{
  x: number;
  y: number;
}> {
  await checkCliclickInstalled();
  const { stdout } = await execFileAsync("cliclick", ["p"]);
  const parts = stdout.trim().split(",");
  const xStr = parts[0];
  const yStr = parts[1];
  if (parts.length !== 2 || xStr === undefined || yStr === undefined) {
    throw new Error(`Unexpected cliclick output: ${stdout.trim()}`);
  }
  const x = parseInt(xStr, 10);
  const y = parseInt(yStr, 10);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    throw new Error(`Failed to parse cursor position: ${stdout.trim()}`);
  }
  return { x, y };
}

const VALID_SPECIAL_KEYS = new Set([
  "cmd",
  "ctrl",
  "alt",
  "shift",
  "fn",
  "arrow-up",
  "arrow-down",
  "arrow-left",
  "arrow-right",
  "tab",
  "esc",
  "space",
  "delete",
  "return",
  "enter",
  "home",
  "end",
  "page-up",
  "page-down",
  ...Array.from({ length: 19 }, (_, i) => {
    return `f${i + 1}`;
  }),
]);

function isValidKeyName(key: string): boolean {
  return VALID_SPECIAL_KEYS.has(key) || key.length === 1;
}

function parseKeyCombo(keys: string): {
  modifiers: string[];
  mainKey: string;
} {
  const parts = keys.split("+");
  if (
    parts.length === 0 ||
    parts.some((p) => {
      return p === "";
    })
  ) {
    throw new Error(`Invalid key combo: "${keys}"`);
  }

  const mainKey = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1);

  for (const key of parts) {
    if (!isValidKeyName(key)) {
      throw new Error(
        `Unknown key: "${key}". Valid keys: single characters, or special keys like cmd, ctrl, alt, shift, tab, esc, return, arrow-up, f1-f19, etc.`,
      );
    }
  }

  return { modifiers, mainKey };
}

/**
 * Build the cliclick command to press or type a key.
 * Special keys (return, tab, arrow-up, etc.) use `kp:`, regular characters use `t:`.
 */
function keyAction(key: string): string {
  return VALID_SPECIAL_KEYS.has(key) ? `kp:${key}` : `t:${key}`;
}

/**
 * Press a key combination using cliclick.
 * Accepts combo strings like "cmd+c", "ctrl+shift+s", or single keys like "return".
 */
export async function pressKey(keys: string): Promise<void> {
  const { modifiers, mainKey } = parseKeyCombo(keys);

  if (modifiers.length === 0) {
    await execFileAsync("cliclick", [keyAction(mainKey)]);
    return;
  }

  const args: string[] = [];
  for (const mod of modifiers) {
    args.push(`kd:${mod}`);
  }
  args.push(keyAction(mainKey));
  for (let i = modifiers.length - 1; i >= 0; i--) {
    args.push(`ku:${modifiers[i]}`);
  }
  await execFileAsync("cliclick", args);
}

/**
 * Hold key(s) down for a specified duration then release.
 * Accepts combo strings like "shift" or "cmd+shift".
 */
export async function holdKey(keys: string, durationMs: number): Promise<void> {
  const { modifiers, mainKey } = parseKeyCombo(keys);
  const allKeys = [...modifiers, mainKey];

  const downArgs = allKeys.map((k) => {
    return `kd:${k}`;
  });
  const upArgs = [...allKeys].reverse().map((k) => {
    return `ku:${k}`;
  });

  await execFileAsync("cliclick", downArgs);
  await sleep(durationMs);
  await execFileAsync("cliclick", upArgs);
}

/**
 * Type text at the current cursor position using cliclick.
 */
export async function typeText(text: string): Promise<void> {
  await execFileAsync("cliclick", [`t:${text}`]);
}
