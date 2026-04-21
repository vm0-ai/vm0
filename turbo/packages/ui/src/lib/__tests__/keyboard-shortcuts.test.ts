import { describe, expect, it } from "vitest";
import {
  getShortcutParts,
  matchShortcut,
  processShortcut,
  type KeyboardEventLike,
} from "../keyboard-shortcuts";

function createEvent(
  overrides: Partial<KeyboardEventLike> & { key: string },
): KeyboardEventLike {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    target: document.createElement("div"),
    preventDefault: () => {},
    ...overrides,
  };
}

describe("matchShortcut", () => {
  it("should match a simple key", () => {
    expect(matchShortcut("j", createEvent({ key: "j" }))).toBe(true);
  });

  it("should not match a different key", () => {
    expect(matchShortcut("j", createEvent({ key: "k" }))).toBe(false);
  });

  it("should match case-insensitively", () => {
    expect(matchShortcut("enter", createEvent({ key: "Enter" }))).toBe(true);
    expect(matchShortcut("escape", createEvent({ key: "Escape" }))).toBe(true);
  });

  it("should not match simple key when modifier is pressed", () => {
    expect(matchShortcut("j", createEvent({ key: "j", metaKey: true }))).toBe(
      false,
    );
    expect(matchShortcut("j", createEvent({ key: "j", ctrlKey: true }))).toBe(
      false,
    );
  });

  it("should not match simple key when shift is pressed", () => {
    expect(matchShortcut("j", createEvent({ key: "j", shiftKey: true }))).toBe(
      false,
    );
  });

  it("should match mod+key with ctrlKey (non-Mac environment)", () => {
    // In vitest, navigator.userAgent doesn't contain "Mac"
    expect(
      matchShortcut("mod+b", createEvent({ key: "b", ctrlKey: true })),
    ).toBe(true);
  });

  it("should not match mod+key without modifier", () => {
    expect(matchShortcut("mod+b", createEvent({ key: "b" }))).toBe(false);
  });

  it("should match mod+shift+enter", () => {
    expect(
      matchShortcut(
        "mod+shift+enter",
        createEvent({ key: "Enter", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
  });

  it("should not match mod+shift+enter without shift", () => {
    expect(
      matchShortcut(
        "mod+shift+enter",
        createEvent({ key: "Enter", ctrlKey: true }),
      ),
    ).toBe(false);
  });

  it("should match space key", () => {
    expect(matchShortcut(" ", createEvent({ key: " " }))).toBe(true);
  });

  it("should match shift+/ when event reports ? (US layout)", () => {
    expect(
      matchShortcut("shift+/", createEvent({ key: "?", shiftKey: true })),
    ).toBe(true);
  });
});

describe("processShortcut", () => {
  it("should call callback and return true on match", () => {
    let called = false;
    const prevented = { value: false };
    const e = createEvent({
      key: "j",
      preventDefault: () => {
        prevented.value = true;
      },
    });

    const result = processShortcut(
      {
        j: () => {
          called = true;
        },
      },
      e,
    );

    expect(result).toBe(true);
    expect(called).toBe(true);
    expect(prevented.value).toBe(true);
  });

  it("should return false on no match", () => {
    const result = processShortcut(
      {
        k: () => {},
      },
      createEvent({ key: "j" }),
    );

    expect(result).toBe(false);
  });

  it("should return false when isComposing is true on event", () => {
    let called = false;
    const result = processShortcut(
      {
        enter: () => {
          called = true;
        },
      },
      createEvent({ key: "Enter", isComposing: true }),
    );

    expect(result).toBe(false);
    expect(called).toBe(false);
  });

  it("should return false when isComposing override is true", () => {
    let called = false;
    const result = processShortcut(
      {
        enter: () => {
          called = true;
        },
      },
      createEvent({ key: "Enter", isComposing: false }),
      { isComposing: true },
    );

    expect(result).toBe(false);
    expect(called).toBe(false);
  });

  it("should match first binding and stop", () => {
    const calls: string[] = [];
    processShortcut(
      {
        j: () => {
          calls.push("first");
        },
        j2: () => {
          calls.push("second");
        },
      },
      createEvent({ key: "j" }),
    );

    expect(calls).toEqual(["first"]);
  });
});

describe("getShortcutParts", () => {
  it("renders arrow keys as symbols", () => {
    expect(getShortcutParts("arrowup")).toEqual(["↑"]);
    expect(getShortcutParts("arrowdown")).toEqual(["↓"]);
    expect(getShortcutParts("arrowleft")).toEqual(["←"]);
    expect(getShortcutParts("arrowright")).toEqual(["→"]);
  });

  it("renders enter as ⏎", () => {
    expect(getShortcutParts("enter")).toEqual(["⏎"]);
  });

  it("renders escape as ⎋", () => {
    expect(getShortcutParts("escape")).toEqual(["⎋"]);
  });

  it("renders space as ␣", () => {
    expect(getShortcutParts("space")).toEqual(["␣"]);
  });

  it("renders mod as Ctrl in non-Mac environment", () => {
    expect(getShortcutParts("mod+k")).toEqual(["Ctrl", "k"]);
  });

  it("renders shift as Shift in non-Mac environment", () => {
    expect(getShortcutParts("shift+enter")).toEqual(["Shift", "⏎"]);
  });

  it("renders alt as Alt in non-Mac environment", () => {
    expect(getShortcutParts("alt+f")).toEqual(["Alt", "f"]);
  });

  it("renders ctrl as Ctrl in non-Mac environment", () => {
    expect(getShortcutParts("ctrl+c")).toEqual(["Ctrl", "c"]);
  });

  it("renders shift+/ as [Shift, /] — parseShortcut alias is match-only, not display", () => {
    // parseShortcut maps "shift+/" → key="?" for matching purposes only.
    // getShortcutParts is display-only and must show the literal "/" the caller wrote.
    expect(getShortcutParts("shift+/")).toEqual(["Shift", "/"]);
  });

  it("renders combined modifier+key shortcut", () => {
    expect(getShortcutParts("mod+shift+enter")).toEqual(["Ctrl", "Shift", "⏎"]);
  });

  it("renders plain alphabetic key without capitalisation", () => {
    expect(getShortcutParts("j")).toEqual(["j"]);
  });
});
