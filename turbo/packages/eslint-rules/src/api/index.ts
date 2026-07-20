import { noCatchAbort } from "./rules/no-catch-abort.ts";
import { noFnDollarSuffix } from "./rules/no-fn-dollar-suffix.ts";
import { noGetterSetterParams } from "./rules/no-getter-setter-params.ts";
import { noLoggerInfo } from "./rules/no-logger-info.ts";
import { noNewPromise } from "./rules/no-new-promise.ts";
import { noRawSql } from "./rules/no-raw-sql.ts";
import { noPackageVariable } from "./rules/no-package-variable.ts";
import { noStoreInParams } from "./rules/no-store-in-params.ts";
import { noTestViMocks } from "./rules/no-test-vi-mocks.ts";
import { requireExecuteRowSchema } from "./rules/require-execute-row-schema.ts";
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
    "no-new-promise": noNewPromise,
    "no-raw-sql": noRawSql,
    "no-package-variable": noPackageVariable,
    "no-store-in-params": noStoreInParams,
    "no-test-vi-mocks": noTestViMocks,
    "require-execute-row-schema": requireExecuteRowSchema,
    "signal-check-await": signalCheckAwait,
  },
};
