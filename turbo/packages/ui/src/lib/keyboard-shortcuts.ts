/**
 * Cross-platform keyboard shortcut matching using a string DSL.
 *
 * Shortcut strings use `+` as separator with these modifiers:
 * - `mod` — Command on Mac, Ctrl on Windows/Linux
 * - `ctrl` — Control key on every platform
 * - `shift` — Shift key
 * - `alt` — Option on Mac, Alt on Windows/Linux
 *
 * Examples: `"mod+b"`, `"ctrl+shift+1"`, `"j"`, `"escape"`
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeyboardEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  /** @deprecated Used for Safari IME workaround: keyCode 229 = IME processing. */
  keyCode?: number;
  /** React SyntheticEvent exposes isComposing/keyCode on nativeEvent. */
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  target: EventTarget | null;
  preventDefault(): void;
}

interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

// ---------------------------------------------------------------------------
// Platform detection (once at module load)
// ---------------------------------------------------------------------------

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.toLowerCase().split("+");
  let mod = false;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let key = "";

  for (const part of parts) {
    switch (part) {
      case "mod": {
        mod = true;
        break;
      }
      case "ctrl": {
        ctrl = true;
        break;
      }
      case "shift": {
        shift = true;
        break;
      }
      case "alt": {
        alt = true;
        break;
      }
      default: {
        key = part;
      }
    }
  }

  // Browsers report e.key as the produced character, so "shift+/" on a US
  // layout emits "?". Treat the physical-key form as an alias so callers can
  // write "shift+/" (common UI convention) and still match.
  if (shift && key === "/") {
    key = "?";
  }

  return { mod, ctrl, shift, alt, key };
}

const SHIFTED_DIGIT_KEYS: Record<string, string> = {
  "0": ")",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
};

function eventDigit(e: KeyboardEventLike): string | null {
  const codeMatch = e.code?.match(/^(?:Digit|Numpad)([0-9])$/);
  if (codeMatch) {
    return codeMatch[1]!;
  }
  const key = e.key.toLowerCase();
  if (/^[0-9]$/.test(key)) {
    return key;
  }
  for (const [digit, shiftedKey] of Object.entries(SHIFTED_DIGIT_KEYS)) {
    if (key === shiftedKey) {
      return digit;
    }
  }
  return null;
}

function matchesShortcutKey(parsed: ParsedShortcut, e: KeyboardEventLike) {
  if (parsed.shift && /^[0-9]$/.test(parsed.key)) {
    return eventDigit(e) === parsed.key;
  }
  return e.key.toLowerCase() === parsed.key;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export function matchShortcut(shortcut: string, e: KeyboardEventLike): boolean {
  const parsed = parseShortcut(shortcut);
  const expectedMetaKey = parsed.mod && isMac;
  const expectedCtrlKey = parsed.ctrl || (parsed.mod && !isMac);

  return (
    e.metaKey === expectedMetaKey &&
    e.ctrlKey === expectedCtrlKey &&
    e.shiftKey === parsed.shift &&
    e.altKey === parsed.alt &&
    matchesShortcutKey(parsed, e)
  );
}

// ---------------------------------------------------------------------------
// Input filtering
// ---------------------------------------------------------------------------

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

// ---------------------------------------------------------------------------
// processShortcut — for use inside input/textarea handlers (use case 2)
// ---------------------------------------------------------------------------

export function processShortcut(
  bindings: Record<string, (e: KeyboardEventLike) => void>,
  e: KeyboardEventLike,
  options?: { isComposing?: boolean },
): boolean {
  // Safari fires compositionend before keydown, so isComposing is already
  // false. However keyCode remains 229 (IME processing) — use that as
  // a fallback to detect composition-ending keystrokes.
  const keyCode = e.keyCode ?? e.nativeEvent?.keyCode;
  const isComposingProp =
    options?.isComposing ?? e.isComposing ?? e.nativeEvent?.isComposing;
  const composing = isComposingProp === true || keyCode === 229;
  if (composing) {
    return false;
  }

  for (const [shortcut, callback] of Object.entries(bindings)) {
    if (matchShortcut(shortcut, e)) {
      e.preventDefault();
      callback(e);
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Display labels
// ---------------------------------------------------------------------------

const KEY_DISPLAY_NAMES: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "⏎",
  escape: "⎋",
  backspace: "⌫",
  tab: "⇥",
  space: "␣",
  f2: "F2",
};

function formatKey(key: string): string {
  return KEY_DISPLAY_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

export function getShortcutLabel(shortcut: string): string {
  const parsed = parseShortcut(shortcut);

  if (isMac) {
    const parts: string[] = [];
    if (parsed.mod) {
      parts.push("⌘");
    }
    if (parsed.ctrl) {
      parts.push("⌃");
    }
    if (parsed.shift) {
      parts.push("⇧");
    }
    if (parsed.alt) {
      parts.push("⌥");
    }
    parts.push(formatKey(parsed.key));
    return parts.join("");
  }

  const parts: string[] = [];
  if (parsed.mod) {
    parts.push("Ctrl");
  }
  if (parsed.ctrl) {
    parts.push("Ctrl");
  }
  if (parsed.shift) {
    parts.push("Shift");
  }
  if (parsed.alt) {
    parts.push("Alt");
  }
  parts.push(formatKey(parsed.key));
  return parts.join("+");
}

/**
 * Returns individual key parts for rendering each as a separate element.
 * Handles `ctrl` as a distinct modifier (not `mod`). Common keys (arrows,
 * enter, escape, etc.) are rendered as their conventional symbols.
 */
export function getShortcutParts(shortcut: string): string[] {
  const segments = shortcut.toLowerCase().split("+");
  const result: string[] = [];
  let key = "";

  for (const segment of segments) {
    switch (segment) {
      case "mod":
        result.push(isMac ? "⌘" : "Ctrl");
        break;
      case "ctrl":
        result.push(isMac ? "⌃" : "Ctrl");
        break;
      case "shift":
        result.push(isMac ? "⇧" : "Shift");
        break;
      case "alt":
        result.push(isMac ? "⌥" : "Alt");
        break;
      default:
        key = segment;
    }
  }

  if (key) {
    result.push(KEY_DISPLAY_NAMES[key] ?? key);
  }
  return result;
}
