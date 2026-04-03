import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type ScrollDirection = "up" | "down" | "left" | "right";

const DEFAULT_SCROLL_AMOUNT = 3;

/**
 * Scroll at the given screen position using cliclick (mouse move) + osascript (CGEvent scroll).
 *
 * cliclick handles cursor positioning; osascript with CoreGraphics CGEvent API
 * handles the scroll wheel event (cliclick has no native scroll support).
 */
export async function scroll(
  x: number,
  y: number,
  direction: ScrollDirection,
  amount: number = DEFAULT_SCROLL_AMOUNT,
): Promise<void> {
  // Move cursor to target position
  await execFileAsync("cliclick", [`m:${x},${y}`]);

  // CGEvent scroll: positive dy = scroll up, negative dy = scroll down
  // Second wheel axis: positive dx = scroll left, negative dx = scroll right
  let dy = 0;
  let dx = 0;
  switch (direction) {
    case "up":
      dy = amount;
      break;
    case "down":
      dy = -amount;
      break;
    case "left":
      dx = amount;
      break;
    case "right":
      dx = -amount;
      break;
  }

  const script = [
    "ObjC.import('CoreGraphics');",
    `var e = $.CGEventCreateScrollWheelEvent(null, 0, 2, ${dy}, ${dx});`,
    "$.CGEventPost($.kCGHIDEventTap, e);",
  ].join(" ");

  await execFileAsync("osascript", ["-l", "JavaScript", "-e", script]);
}
