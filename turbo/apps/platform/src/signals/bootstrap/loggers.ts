import { command } from "ccstate";
import { localStorageSignals } from "../external/local-storage";
import { Level, logger } from "../log";
import { throwIfAbort } from "../utils";

const { get$ } = localStorageSignals("debugLoggers");

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
      L.infoGroup("Enable DEBUG for loggers:");
      for (const name of loggerNames) {
        L.info(name);
        const l = logger(name);
        l.level = Level.Debug;
      }
      L.infoGroupEnd();
    }
  }
});
