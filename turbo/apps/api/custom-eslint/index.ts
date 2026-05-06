import { noCatchAbort } from "./rules/no-catch-abort.ts";
import { noFnDollarSuffix } from "./rules/no-fn-dollar-suffix.ts";
import { noGetterSetterParams } from "./rules/no-getter-setter-params.ts";
import { noLoggerInfo } from "./rules/no-logger-info.ts";
import { noPackageVariable } from "./rules/no-package-variable.ts";
import { noStoreInParams } from "./rules/no-store-in-params.ts";
import { noTestViMocks } from "./rules/no-test-vi-mocks.ts";
import { signalCheckAwait } from "./rules/signal-check-await.ts";

export const apiLintPlugin = {
  meta: {
    name: "api",
    version: "1.0.0",
  },
  rules: {
    "no-catch-abort": noCatchAbort,
    "no-fn-dollar-suffix": noFnDollarSuffix,
    "no-getter-setter-params": noGetterSetterParams,
    "no-logger-info": noLoggerInfo,
    "no-package-variable": noPackageVariable,
    "no-store-in-params": noStoreInParams,
    "no-test-vi-mocks": noTestViMocks,
    "signal-check-await": signalCheckAwait,
  },
};
