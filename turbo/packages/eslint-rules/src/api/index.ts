import { noCatchAbort } from "./rules/no-catch-abort.ts";
import { noFnDollarSuffix } from "./rules/no-fn-dollar-suffix.ts";
import { noGetterSetterParams } from "./rules/no-getter-setter-params.ts";
import { noLoggerInfo } from "./rules/no-logger-info.ts";
import { noNewPromise } from "./rules/no-new-promise.ts";
import { noPackageVariable } from "./rules/no-package-variable.ts";
import { noStoreInParams } from "./rules/no-store-in-params.ts";
import { noSqlRaw } from "./rules/no-sql-raw.ts";
import { noTestViMocks } from "./rules/no-test-vi-mocks.ts";
import { noUnsafeSqlInterpolation } from "./rules/no-unsafe-sql-interpolation.ts";
import { preferDrizzleApis } from "./rules/prefer-drizzle-apis.ts";
import { preferDrizzleQueryBuilder } from "./rules/prefer-drizzle-query-builder.ts";
import { requireExecuteRowSchema } from "./rules/require-execute-row-schema.ts";
import { requireSqlResultMapping } from "./rules/require-sql-result-mapping.ts";
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
    "no-package-variable": noPackageVariable,
    "no-store-in-params": noStoreInParams,
    "no-sql-raw": noSqlRaw,
    "no-test-vi-mocks": noTestViMocks,
    "no-unsafe-sql-interpolation": noUnsafeSqlInterpolation,
    "prefer-drizzle-apis": preferDrizzleApis,
    "prefer-drizzle-query-builder": preferDrizzleQueryBuilder,
    "require-execute-row-schema": requireExecuteRowSchema,
    "require-sql-result-mapping": requireSqlResultMapping,
    "signal-check-await": signalCheckAwait,
  },
};
