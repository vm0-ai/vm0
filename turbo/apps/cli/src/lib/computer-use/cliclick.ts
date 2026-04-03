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
 * Press a key combination using cliclick.
 * Accepts combo strings like "cmd+c", "ctrl+shift+s", or single keys like "return".
 */
export async function pressKey(keys: string): Promise<void> {
  const { modifiers, mainKey } = parseKeyCombo(keys);

  if (modifiers.length === 0) {
    await execFileAsync("cliclick", [`kp:${mainKey}`]);
    return;
  }

  const args: string[] = [];
  for (const mod of modifiers) {
    args.push(`kd:${mod}`);
  }
  args.push(`kp:${mainKey}`);
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
