import { command } from "ccstate";

import { onRef } from "../utils.ts";

export const focusDesktopAuthHeadingRef$ = onRef(
  command(
    (_context, heading: HTMLHeadingElement, signal: AbortSignal): void => {
      signal.throwIfAborted();
      heading.focus();
    },
  ),
);
