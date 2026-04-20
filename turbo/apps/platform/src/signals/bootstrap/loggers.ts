import { command } from "ccstate";
import { localStorageSignals } from "../external/local-storage";
import { Level, logger } from "../log";
import { jsonParseOr } from "../utils";

const { get$, set$ } = localStorageSignals("debugLogger");

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
export const extendDebugLoggerLocalStorage$ = command(
  ({ get, set }, loggerName: string) => {
    const debugLoggers = get(get$);
    const loggerNames = debugLoggers
      ? jsonParseOr<string[]>(debugLoggers, [])
      : [];
    if (!loggerNames.includes(loggerName)) {
      loggerNames.push(loggerName);
      set(set$, JSON.stringify(loggerNames));
    }
  },
);
