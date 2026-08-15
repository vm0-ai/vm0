import { command } from "ccstate";
import { localStorageSignals } from "../external/local-storage";
import { Level, logger } from "../log";
import { jsonParseOr } from "../utils";

const DEBUG_LOGGER_STORAGE_KEY = "debugLogger";

const debugLoggerStorage = localStorageSignals(DEBUG_LOGGER_STORAGE_KEY);

const L = logger("Logger");

export const setupLoggers$ = command(({ get }) => {
  const debugLoggers = get(debugLoggerStorage.get$);
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

export const setDebugLoggerLocalStorage$ = debugLoggerStorage.set$;

export const extendDebugLoggerLocalStorage$ = command(
  ({ get, set }, loggerName: string): void => {
    const debugLoggers = get(debugLoggerStorage.get$);
    const loggerNames = debugLoggers
      ? jsonParseOr<string[]>(debugLoggers, [])
      : [];
    if (loggerNames.includes(loggerName)) {
      return;
    }

    set(debugLoggerStorage.set$, JSON.stringify([...loggerNames, loggerName]));
  },
);
