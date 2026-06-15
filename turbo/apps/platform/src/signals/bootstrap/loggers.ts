import { command } from "ccstate";
import { localStorageSignals } from "../external/local-storage";
import { Level, logger } from "../log";
import { jsonParseOr } from "../utils";

const DEBUG_LOGGER_STORAGE_KEY = "debugLogger";

const {
  get$,
  set$,
  updateRaw: updateDebugLoggerRaw,
} = localStorageSignals(DEBUG_LOGGER_STORAGE_KEY);

const L = logger("Logger");

export const setupLoggers$ = command(({ get }) => {
  const debugLoggers = get(get$);
  if (debugLoggers) {
    const loggerNames = jsonParseOr<string[]>(debugLoggers, []);
    if (loggerNames.length > 0) {
      L.warnGroup("Enable DEBUG for loggers:");
      for (const name of loggerNames) {
        L.warn(name);
        const l = logger(name);
        l.level = Level.Debug;
      }
      L.warnGroupEnd();
    }
  }
});

export const setDebugLoggerLocalStorage$ = set$;

export function extendDebugLoggerLocalStorage(loggerName: string): void {
  updateDebugLoggerRaw((debugLoggers) => {
    const loggerNames = debugLoggers
      ? jsonParseOr<string[]>(debugLoggers, [])
      : [];
    if (loggerNames.includes(loggerName)) {
      return debugLoggers;
    }
    return JSON.stringify([...loggerNames, loggerName]);
  });
}
