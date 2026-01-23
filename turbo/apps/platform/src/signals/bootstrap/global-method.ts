import { command } from "ccstate";
import { getLoggers, Level, logger } from "../log";
import type { DebugLoggers } from "../../types/global-method";

const L = logger("GlobalMethod");

function createLoggerControl(name: string) {
  const loggers = getLoggers();
  const loggerInstance = loggers[name];
  if (!loggerInstance) {
    throw new Error(`Logger "${name}" not found`);
  }

  return {
    get debug() {
      return loggerInstance.shouldLog(Level.Debug);
    },
    set debug(value: boolean) {
      if (value) {
        loggerInstance.level = Level.Debug;
      } else if (loggerInstance.level === Level.Debug) {
        loggerInstance.level = Level.Info;
      }
    },
  };
}

export const setupGlobalMethod$ = command((_, signal: AbortSignal) => {
  L.debug("Setting up global method vm0");

  window._vm0 = {
    get loggers() {
      const loggers = getLoggers();
      const result: DebugLoggers = {};
      for (const name of Object.keys(loggers)) {
        result[name] = createLoggerControl(name);
      }
      return result;
    },
  };

  signal.addEventListener("abort", () => {
    L.debug("Cleaning up global method vm0");
    delete window._vm0;
  });
});
