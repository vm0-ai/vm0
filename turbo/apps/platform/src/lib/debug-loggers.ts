import { getLoggers, Level } from "../signals/log.ts";
import type { DebugLoggers } from "../types/global-method.ts";

function createLoggerControl(
  name: string,
  onDebugEnabled: ((loggerName: string) => void) | undefined,
): DebugLoggers[string] {
  const loggerInstance = getLoggers()[name];
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
        onDebugEnabled?.(name);
      } else if (loggerInstance.level === Level.Debug) {
        loggerInstance.level = Level.Info;
      }
    },
  };
}

export function createDebugLoggers(
  onDebugEnabled?: (loggerName: string) => void,
): DebugLoggers {
  const result: DebugLoggers = {};
  for (const name of Object.keys(getLoggers())) {
    result[name] = createLoggerControl(name, onDebugEnabled);
  }
  return result;
}
