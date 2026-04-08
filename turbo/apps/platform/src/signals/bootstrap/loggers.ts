import { command } from "ccstate";
import { localStorageSignals } from "../external/local-storage";
import { Level, logger } from "../log";
import { throwIfAbort } from "../utils";

const { get$, set$, clear$ } = localStorageSignals("debugLogger");

const L = logger("Logger");

export const setupLoggers$ = command(({ get }) => {
  const debugLoggers = get(get$);
  if (debugLoggers) {
    let loggerNames: string[] = [];
    try {
      loggerNames = JSON.parse(debugLoggers);
    } catch (error) {
      throwIfAbort(error);
      // silence JSON parse errors because this data only for debugging
    }
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
export const extendDebugLoggerLocalStorage$ = command(
  ({ get, set }, loggerName: string) => {
    const debugLoggers = get(get$);
    let loggerNames: string[] = [];
    if (debugLoggers) {
      try {
        loggerNames = JSON.parse(debugLoggers);
      } catch (error) {
        throwIfAbort(error);
        // Corrupted localStorage value — clear it and start fresh
        set(clear$);
      }
    }
    if (!loggerNames.includes(loggerName)) {
      loggerNames.push(loggerName);
      set(set$, JSON.stringify(loggerNames));
    }
  },
);
