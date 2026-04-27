import { noCatchAbort } from "./rules/no-catch-abort.ts";
import { noFnDollarSuffix } from "./rules/no-fn-dollar-suffix.ts";
import { noGetterSetterParams } from "./rules/no-getter-setter-params.ts";
import { noLoggerInfo } from "./rules/no-logger-info.ts";
import { noPackageVariable } from "./rules/no-package-variable.ts";
import { noTestViMocks } from "./rules/no-test-vi-mocks.ts";

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
    "no-test-vi-mocks": noTestViMocks,
  },
};
