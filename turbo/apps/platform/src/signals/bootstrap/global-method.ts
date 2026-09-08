import { command } from "ccstate";
import { createDebugLoggers } from "../../lib/debug-loggers.ts";
import { getBuildCommitSha } from "../../lib/build-info";
import { appVersion$ } from "../app-version.ts";
import { logger } from "../log";
import { inspectLogInput$ } from "./inspect-log-input";
import { extendDebugLoggerLocalStorage$ } from "./loggers";

const L = logger("GlobalMethod");
const ENABLE_DEBUG_LOGGER_EVENT = "vm0:enable-debug-logger";

export const setupGlobalMethod$ = command(
  ({ get, set }, signal: AbortSignal) => {
    L.debug("Setting up global method vm0");
    const appVersion = get(appVersion$);

    window.addEventListener(
      ENABLE_DEBUG_LOGGER_EVENT,
      (event) => {
        if (
          !(event instanceof CustomEvent) ||
          typeof event.detail !== "string"
        ) {
          return;
        }
        set(extendDebugLoggerLocalStorage$, event.detail);
      },
      { signal },
    );

    window._okou = {
      get loggers() {
        return createDebugLoggers((name) => {
          window.dispatchEvent(
            new CustomEvent(ENABLE_DEBUG_LOGGER_EVENT, { detail: name }),
          );
        });
      },
      inspectLogs() {
        get(inspectLogInput$)?.click();
      },
      getBuildCommitSha,
      getBuildVersion: () => {
        return appVersion;
      },
    };

    signal.addEventListener("abort", () => {
      L.debug("Cleaning up global method vm0");
      delete window._okou;
    });
  },
);
