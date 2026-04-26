import { noCatchAbort } from "./rules/no-catch-abort.ts";
import { noGetterSetterParams } from "./rules/no-getter-setter-params.ts";
import { noLoggerInfo } from "./rules/no-logger-info.ts";

export const apiLintPlugin = {
  meta: {
    name: "api",
    version: "1.0.0",
  },
  rules: {
    "no-catch-abort": noCatchAbort,
    "no-getter-setter-params": noGetterSetterParams,
    "no-logger-info": noLoggerInfo,
  },
};
