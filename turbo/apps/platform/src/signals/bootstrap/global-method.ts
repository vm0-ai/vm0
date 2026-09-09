import { command } from "ccstate";
import { createDebugLoggers } from "../../lib/debug-loggers.ts";
import { getBuildCommitSha } from "../../lib/build-info";
import { appVersion$ } from "../app-version.ts";
import { logger } from "../log";
import { inspectLogInput$ } from "./inspect-log-input";
import { extendDebugLoggerLocalStorage$ } from "./loggers";

const L = logger("GlobalMethod");
const ENABLE_DEBUG_LOGGER_EVENT = "okou:enable-debug-logger";

export const setupGlobalMethod$ = command(
  ({ get, set }, signal: AbortSignal) => {
    L.debug("Setting up global method _okou");
    const appVersion = get(appVersion$);
    const okou = window._okou;
    if (!okou) {
      throw new Error("Platform lifecycle was not initialized");
    }

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

    Object.defineProperty(okou, "loggers", {
      configurable: true,
      enumerable: true,
      get() {
        return createDebugLoggers((name) => {
          window.dispatchEvent(
            new CustomEvent(ENABLE_DEBUG_LOGGER_EVENT, { detail: name }),
          );
        });
      },
    });
    okou.inspectLogs = () => {
      get(inspectLogInput$)?.click();
    };
    okou.getBuildCommitSha = getBuildCommitSha;
    okou.getBuildVersion = () => {
      return appVersion;
    };

    signal.addEventListener("abort", () => {
      L.debug("Cleaning up global debug methods");
      delete okou.loggers;
      delete okou.inspectLogs;
      delete okou.getBuildCommitSha;
      delete okou.getBuildVersion;
    });
  },
);
