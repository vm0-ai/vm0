import { describe, expect, it } from "vitest";

import indexHtml from "../../index.html?raw";

interface RecoveryWindow extends EventTarget {
  readonly confirm: (message: string) => boolean;
  readonly location: {
    readonly reload: () => void;
  };
}

function preloadRecoverySource(): string {
  const source = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/giu)]
    .map((match) => match[1])
    .find((script) => script?.includes('"vite:preloadError"'));
  if (source === undefined) {
    throw new Error("Unable to locate preload recovery in index.html");
  }
  return source;
}

function recoveryWindow(shouldReload: boolean) {
  const target = new EventTarget() as RecoveryWindow;
  const confirmationMessages: string[] = [];
  let reloadCount = 0;

  Object.defineProperties(target, {
    confirm: {
      value(message: string) {
        confirmationMessages.push(message);
        return shouldReload;
      },
    },
    location: {
      value: {
        reload() {
          reloadCount += 1;
        },
      },
    },
  });

  return {
    confirmationMessages,
    reloadCount: () => reloadCount,
    window: target,
  };
}

function installRecovery(windowObject: RecoveryWindow): void {
  const executeRecovery = new Function(
    "window",
    `${preloadRecoverySource()}\n//# sourceURL=preload-error-recovery-test.js`,
  ) as (windowObject: RecoveryWindow) => void;
  executeRecovery(windowObject);
}

function preloadErrorEvent(): Event {
  return Object.assign(new Event("vite:preloadError", { cancelable: true }), {
    payload: new Error("Unable to preload a deployment asset"),
  });
}

describe("preload error recovery", () => {
  it("keeps unsent work when refresh is not confirmed", () => {
    const recovery = recoveryWindow(false);
    installRecovery(recovery.window);

    const firstError = preloadErrorEvent();
    const repeatedError = preloadErrorEvent();
    recovery.window.dispatchEvent(firstError);
    recovery.window.dispatchEvent(repeatedError);

    expect(firstError.defaultPrevented).toBeTruthy();
    expect(repeatedError.defaultPrevented).toBeTruthy();
    expect(recovery.confirmationMessages).toHaveLength(1);
    expect(recovery.confirmationMessages[0]).toContain("unsent work");
    expect(recovery.reloadCount()).toBe(0);
  });

  it("refreshes once after explicit confirmation", () => {
    const recovery = recoveryWindow(true);
    installRecovery(recovery.window);

    recovery.window.dispatchEvent(preloadErrorEvent());
    recovery.window.dispatchEvent(preloadErrorEvent());

    expect(recovery.confirmationMessages).toHaveLength(1);
    expect(recovery.reloadCount()).toBe(1);
  });
});
