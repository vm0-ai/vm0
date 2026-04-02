import { command } from "ccstate";
import { getLoggers, Level, logger } from "../log";
import type { DebugLoggers } from "../../types/global-method";
import { FeatureSwitchKey } from "@vm0/core";
import {
  featureSwitch$,
  overrideFeatureSwitch$,
} from "../external/feature-switch";
import { loadInspectLogFile$ } from "../activity-page/inspect-log-signals";
import { detachedNavigateTo$ } from "../route";
import { pathname } from "../location";
import { ROUTES } from "../route-paths";

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

export const setupGlobalMethod$ = command(
  async ({ set, get }, signal: AbortSignal) => {
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
      featureSwitches: {},
      inspectLogs() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.style.display = "none";
        document.body.appendChild(input);

        input.addEventListener("change", () => {
          const file = input.files?.[0];
          input.remove();
          if (!file) {
            return;
          }
          set(loadInspectLogFile$, file, signal)
            .then(() => {
              if (pathname() !== "/activities/inspect") {
                set(detachedNavigateTo$, ROUTES.activityInspect);
              }
            })
            .catch((error: unknown) => {
              L.error("Failed to parse inspect log", error);
            });
        });

        // Clean up if dialog is cancelled
        input.addEventListener("cancel", () => {
          input.remove();
        });

        input.click();
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
        set(overrideFeatureSwitch$, { [prop]: value });
        return value;
      },
    });
  },
);
