import { command } from "ccstate";
import { getLoggers, Level, logger } from "../log";
import type { DebugLoggers } from "../../types/global-method";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  detachedSetFeatureSwitch$,
  featureSwitch$,
} from "../external/feature-switch";
import { inspectLogInput$ } from "./inspect-log-input";
import { extendDebugLoggerLocalStorage$ } from "./loggers";

const L = logger("GlobalMethod");

const createLoggerControl$ = command(({ set }, name: string) => {
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
        set(extendDebugLoggerLocalStorage$, name);
      } else if (loggerInstance.level === Level.Debug) {
        loggerInstance.level = Level.Info;
      }
    },
  };
});

export const setupGlobalMethod$ = command(
  async ({ set, get }, signal: AbortSignal) => {
    L.debug("Setting up global method vm0");

    window._vm0 = {
      get loggers() {
        const loggers = getLoggers();
        const result: DebugLoggers = {};
        for (const name of Object.keys(loggers)) {
          result[name] = set(createLoggerControl$, name);
        }
        return result;
      },
      featureSwitches: {},
      inspectLogs() {
        get(inspectLogInput$)?.click();
      },
    };

    signal.addEventListener("abort", () => {
      L.debug("Cleaning up global method vm0");
      delete window._vm0;
    });

    const features = await get(featureSwitch$);
    signal.throwIfAborted();

    window._vm0.featureSwitches = new Proxy(features, {
      set(_, prop: FeatureSwitchKey, value: boolean) {
        set(detachedSetFeatureSwitch$, { [prop]: value }, signal);
        return true;
      },
    });
  },
);
