import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config, oxlint } from "@okouai/eslint-config/base";
import { apiLintPlugin } from "@okouai/eslint-rules/api";
import ccstatePlugin from "@okouai/eslint-rules/ccstate";

const packageRoot = dirname(fileURLToPath(import.meta.url));

// The gateway type-check project (tsconfig.gateways.json) is the single source
// of truth for which modules are allowed to resolve the isolated SDKs, so read
// its file list rather than restating it here. Globs would silently under-
// enforce the boundary, so reject them.
const gatewayModules = JSON.parse(
  fs.readFileSync(resolve(packageRoot, "tsconfig.gateways.json"), "utf8"),
).include.map((entry) => {
  if (entry.includes("*")) {
    throw new Error(
      `tsconfig.gateways.json must list files, not globs: ${entry}`,
    );
  }
  return resolve(packageRoot, entry);
});

// Third-party declaration surfaces that only the gateway project may resolve.
// Add a scope here once its clients move into tsconfig.gateways.json; see
// the ablation numbers in PR #25714.
const isolatedDependencies = [
  "@aws-sdk",
  "@clerk",
  "@slack",
  "@smithy",
  "stripe",
];

const gatewayBoundaryOptions = {
  modules: gatewayModules,
  isolatedDependencies,
};

const restrictedSyntax = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message:
      "Use env(name) from lib/env (or signals/external/env) instead of process.env. process.env is only allowed in lib/env.ts.",
  },
  {
    selector:
      "CallExpression[callee.object.name='vi'][callee.property.name='stubEnv']",
    message:
      "Use mockEnv(name, value) from lib/env instead of vi.stubEnv. vi.stubEnv is only allowed in __tests__/env-stub.ts for module-load-time bootstrap.",
  },
  {
    selector:
      "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message:
      "Use now() from lib/time instead of Date.now() so tests can mock time.",
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      "Use nowDate() from lib/time instead of new Date() so tests can mock time.",
  },
  {
    selector: "CallExpression[callee.name='setTimeout']",
    message:
      "Use delay() from the signal-timers package instead of setTimeout, and pass the correct AbortSignal.",
  },
  {
    selector: "CallExpression[callee.name='setInterval']",
    message:
      "Use delay() from the signal-timers package instead of setInterval, and pass the correct AbortSignal.",
  },
  {
    selector: "CallExpression[callee.property.name='setTimeout']",
    message:
      "Use delay() from the signal-timers package instead of setTimeout, and pass the correct AbortSignal.",
  },
  {
    selector: "CallExpression[callee.property.name='setInterval']",
    message:
      "Use delay() from the signal-timers package instead of setInterval, and pass the correct AbortSignal.",
  },
  {
    selector: "TryStatement",
    message:
      "try/catch is not allowed. Centralize guarded operations in signals/utils.ts (e.g. safeJsonParse).",
  },
];

// Promise chaining ban — see issue #13535. .then/.catch hide error and
// loading state; production code should await and centralize guarded async
// work in signals/utils.ts (settle, safeJsonParse, detach, etc.).
const promiseChainSyntax = [
  {
    selector: "CallExpression[callee.property.name='then']",
    message:
      "Promise.then is not allowed. Use await, or centralize the guarded async in signals/utils.ts (settle, detach).",
  },
  {
    selector: "CallExpression[callee.property.name='catch']",
    message:
      "Promise.catch is not allowed. Use settle from signals/utils.ts (or detach for fire-and-forget).",
  },
];

// Narrow exception policy for the promise-chain ban (issue #13535):
// only infrastructure that wraps runtime primitives stays on raw
// .then/.catch. Production code under src/signals/routes and
// src/signals/services must route through the centralized helpers
// (settle, tapError, onRejection, detach, bestEffort).
const promiseChainAllowlist = [
  // pg/OTel instrumentation: needs .then chains around the wrapped pg.query
  // call to attach span lifecycle without forcing an async wrapper around
  // every callback-style overload.
  "src/lib/db-instrumentation.ts",
  // Logger flush: detached `?.catch(() => {})` on Sentry flush in process exit
  // path; cannot use signals/utils helpers because lib/ must not import them.
  "src/lib/log.ts",
  // Centralized async helpers — these implement .then/.catch so the rest of
  // the codebase doesn't have to.
  "src/signals/utils.ts",
  // Runtime wrapper around @vercel/functions waitUntil. It tracks promise
  // settlement for tests while leaving business code on domain helpers.
  "src/signals/context/wait-until.ts",
];

const apiTestExternalBehaviorMessage =
  "API tests must exercise external behavior through API endpoints. Do not test internal implementation details. See docs/testing/testing-external-behavior.md.";

const apiTestDirectDbImportMessage =
  "API tests must not import DB handles directly. Exercise setup and assertions through API endpoints; add a test route only when an external-behavior exception is justified.";

const productionRouteTestImportMessage =
  "Production source must not import test-only routes. Mount required test fixture routes explicitly from tests through setupApp().";

const lowerLayerRouteImportMessage =
  "Lower layers must not import HTTP route or bootstrap aggregation modules. Move shared behavior to lib, command, computed, external, or service modules.";

const apiTestDirectDbImportPatterns = [
  "./lib/db",
  "./lib/db.ts",
  "./external/db",
  "./external/db.ts",
  "../lib/db",
  "../lib/db.ts",
  "../external/db",
  "../external/db.ts",
  "../signals/external/db",
  "../signals/external/db.ts",
  "../../lib/db",
  "../../lib/db.ts",
  "../../external/db",
  "../../external/db.ts",
  "../../signals/external/db",
  "../../signals/external/db.ts",
  "../../../lib/db",
  "../../../lib/db.ts",
  "../../../external/db",
  "../../../external/db.ts",
  "../../../signals/external/db",
  "../../../signals/external/db.ts",
  "../../../../lib/db",
  "../../../../lib/db.ts",
  "../../../../external/db",
  "../../../../external/db.ts",
  "../../../../signals/external/db",
  "../../../../signals/external/db.ts",
  "src/lib/db",
  "src/lib/db.ts",
  "src/signals/external/db",
  "src/signals/external/db.ts",
];

const apiTestServiceImportPatterns = [
  "./*.service",
  "./*.service.ts",
  "./services/*",
  "./services/**/*",
  "../*.service",
  "../*.service.ts",
  "../services/*",
  "../services/**/*",
  "../signals/services/*",
  "../signals/services/**/*",
  "../../services/*",
  "../../services/**/*",
  "../../signals/services/*",
  "../../signals/services/**/*",
  "../../../services/*",
  "../../../services/**/*",
  "../../../signals/services/*",
  "../../../signals/services/**/*",
  "../../../../services/*",
  "../../../../services/**/*",
  "../../../../signals/services/*",
  "../../../../signals/services/**/*",
  "src/signals/services/*",
  "src/signals/services/**/*",
];

export default [
  {
    ignores: [".typecheck/**"],
  },
  ...config,
  {
    files: ["src/**/*.ts"],
    plugins: {
      api: apiLintPlugin,
      ccstate: ccstatePlugin,
    },
    rules: {
      "api/no-catch-abort": "error",
      "api/no-fn-dollar-suffix": "error",
      "api/no-getter-setter-params": "error",
      "api/no-logger-info": "error",
      "api/no-new-promise": "error",
      "api/no-sql-raw": "error",
      "api/no-store-in-params": "error",
      "api/no-unsafe-sql-interpolation": "error",
      "api/prefer-drizzle-apis": "error",
      "api/require-execute-row-schema": "error",
      "api/require-sql-result-mapping": "error",
      "api/signal-check-await": "error",
      "ccstate/no-accessor-escape": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/__tests__/**",
      "src/**/test/**",
      "src/**/tests/**",
      "src/**/mocks/**",
      "src/**/test-fixtures/**",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "src/**/test-context.ts",
      "src/signals/routes/test-*.ts",
    ],
    rules: {
      "vm0/no-abort-signal-in-object-params": [
        "error",
        {
          allowedFunctions: [
            "createApp",
            "createAppWithRoutes",
            "readTextLines",
            "createDir",
            "remove",
            "createTempFile",
            "exec",
          ],
        },
      ],
    },
  },
  {
    files: ["src/scripts/dev-seed.ts"],
    rules: {
      // PostgreSQL's DO statement requires a code literal, so this local-only
      // seed script uses pg.escapeLiteral before passing the block to sql.raw.
      "api/no-sql-raw": "off",
    },
  },
  {
    files: ["src/signals/utils.ts"],
    rules: {
      "api/no-new-promise": "off",
    },
  },
  {
    files: ["src/lib/db-raw-rows.ts"],
    rules: {
      // This is the single reviewed boundary that turns driver rows into
      // schema-derived values before returning them to application code.
      "api/require-execute-row-schema": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "api/no-package-variable": "error",
    },
  },
  // Gateway boundary. Tests are exempt: they type-check in their own smaller
  // program, so an SDK import there does not land in the core program.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/__tests__/**/*.ts", "src/**/*.test.ts"],
    rules: {
      "api/gateway-typecheck-boundary": ["error", gatewayBoundaryOptions],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/lib/env.ts", "src/lib/time.ts", "src/__tests__/env-stub.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...restrictedSyntax,
        ...promiseChainSyntax,
      ],
    },
  },
  // Restore the rule without the promise-chain selectors for allowlisted
  // files and test files. Tests intentionally drive promise edge cases;
  // allowlisted production files are tracked legacy surface (see
  // `promiseChainAllowlist` comment). env-stub.ts stays excluded so its
  // bootstrap-only process.env / vi.stubEnv usage is not re-flagged here.
  {
    files: [
      "src/**/__tests__/**/*.ts",
      "src/**/*.test.ts",
      ...promiseChainAllowlist,
    ],
    ignores: ["src/__tests__/env-stub.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...restrictedSyntax],
    },
  },
  {
    files: ["src/**/__tests__/**/*.ts", "src/**/*.test.ts"],
    ignores: ["src/__tests__/env-stub.ts", "src/__tests__/mocks.ts"],
    rules: {
      "api/no-test-vi-mocks": "error",
    },
  },
  {
    files: [
      "src/**/__tests__/**/*.ts",
      "src/**/*.test.ts",
      "src/test-fixtures/**/*.ts",
      "src/signals/routes/test-*.ts",
    ],
    rules: {
      "api/no-cross-test-time-staggering": "error",
      "api/no-global-sweep-test-routes": "error",
      "api/no-legacy-shared-state-markers": "error",
      "api/no-production-staff-entitlement-mutation": "error",
      "api/no-unowned-usage-pricing": "error",
    },
  },
  {
    ignores: ["**/dist/**", ".vercel/**"],
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
  {
    files: ["src/signals/services/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Program",
          message:
            "Service-directory tests must live behind API endpoint boundaries. Put coverage under routes/__tests__ or document a narrow exception in services/__tests__.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/__tests__/**/*.ts",
      "src/**/*.test.ts",
      "src/test-fixtures/thread-bound-run-admission.ts",
      "src/signals/routes/test-run-fixture.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/agent-runs-create.service"],
              importNames: ["createTestFixtureAgentRun$"],
              message:
                "Production run sources must use createQueueFirstAgentRun$ so every run is bound to a chat thread.",
            },
          ],
        },
      ],
    },
  },
  {
    // Keep finite persisted/state-machine contract matrices as narrow
    // exceptions. Route tests cover constructible behavior, while these exact
    // transition inputs are not available through production APIs.
    files: [
      // Content hashes are a byte-identical cryptographic contract shared with
      // guest-agent; route behavior cannot pin the serializer's full corpus.
      "src/signals/services/__tests__/storage-content-hash.service.test.ts",
      // Pi resource snapshots are a byte-identical discovery contract shared
      // with the sandbox runtime; route output cannot expose its full virtual
      // filesystem, ignore-rule, and precedence matrix.
      "src/signals/services/__tests__/pi-resource-snapshot.service.test.ts",
      "src/signals/services/__tests__/connector-catalog-rejection-authority.test.ts",
      "src/signals/services/__tests__/connector-authorization-provider-state.test.ts",
      // Preview job-ref aliases are process environment state, and both Stripe
      // metadata entry points must share one value-free resolution matrix that
      // cannot be observed completely through a single production API route.
      "src/signals/services/__tests__/stripe-preview-metadata.service.test.ts",
      // A pre-migration schema cannot be constructed through a production API.
      // This focused transaction validates the rollout contract against real
      // PostgreSQL tables before and after the autonomy-budget columns exist.
      "src/signals/services/__tests__/autonomy-budget-rollout.test.ts",
      // A pre-0835 table cannot be constructed through a production API. This
      // focused transaction proves Calendar watch reads and initial writes stay
      // legal on both sides of the transition-column migration.
      "src/signals/services/__tests__/google-calendar-watch-rollout.test.ts",
      // A physical relation versus a compatibility view cannot be selected
      // through the production API. This focused PostgreSQL test proves the
      // exact Agent Draft writer through both rollout targets.
      "src/signals/services/__tests__/agent-draft-write.service.test.ts",
      "src/signals/services/__tests__/workflow-automation-context.test.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...restrictedSyntax],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/__tests__/**/*.ts",
      "src/signals/routes/test-*.ts",
      "src/signals/routes/cli-auth-test.ts",
      "src/signals/route.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/routes/test-*", "**/routes/test-*/**"],
              message: productionRouteTestImportMessage,
            },
            {
              group: ["**/routes/cli-auth-test"],
              message: productionRouteTestImportMessage,
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/signals/route.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/routes/test-*", "**/routes/test-*/**"],
              message: productionRouteTestImportMessage,
            },
            {
              group: ["**/routes/cli-auth-test"],
              message: productionRouteTestImportMessage,
            },
            {
              group: ["**/agent-runs-create.service"],
              importNames: ["createTestFixtureAgentRun$"],
              message:
                "Production run sources must use createQueueFirstAgentRun$ so every run is bound to a chat thread.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/lib/**/*.ts",
      "src/signals/commands/**/*.ts",
      "src/signals/computed/**/*.ts",
      "src/signals/external/**/*.ts",
      "src/signals/services/**/*.ts",
    ],
    ignores: [
      "src/**/__tests__/**/*.ts",
      "src/**/__benches__/**/*.ts",
      "src/**/*.bench.ts",
      "src/**/*.spec.ts",
      "src/**/*.suite.ts",
      "src/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/routes/*",
                "**/routes/**/*",
                "**/signals/route",
                "**/signals/route.ts",
                "**/signals/e2e-routes",
                "**/signals/e2e-routes.ts",
                "**/production-bootstrap",
                "**/production-bootstrap.ts",
              ],
              message: lowerLayerRouteImportMessage,
            },
            {
              group: ["**/agent-runs-create.service"],
              importNames: ["createTestFixtureAgentRun$"],
              message:
                "Production run sources must use createQueueFirstAgentRun$ so every run is bound to a chat thread.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/__tests__/**/*.ts", "src/**/*.test.ts"],
    ignores: [
      // Central test lifecycle owns connection-pool teardown; it does not
      // construct or assert API behavior.
      "src/__tests__/test-context.ts",
      // A finite event-type matrix locks persisted payload rendering and
      // policy lookup byte-for-byte; individual provider routes cannot cover
      // every lookup-table row without duplicating the contract under test.
      "src/signals/services/__tests__/workflow-automation-context.test.ts",
      // Content hashes are a byte-identical cryptographic contract shared with
      // guest-agent; route behavior cannot pin the serializer's full corpus.
      "src/signals/services/__tests__/storage-content-hash.service.test.ts",
      // Pi resource snapshots are a byte-identical discovery contract shared
      // with the sandbox runtime; route output cannot expose its full virtual
      // filesystem, ignore-rule, and precedence matrix.
      "src/signals/services/__tests__/pi-resource-snapshot.service.test.ts",
      // Preview job-ref aliases are process environment state, and both Stripe
      // metadata entry points must share one value-free resolution matrix that
      // cannot be observed completely through a single production API route.
      "src/signals/services/__tests__/stripe-preview-metadata.service.test.ts",
      // A pre-migration schema cannot be constructed through a production API.
      // This focused transaction validates the rollout contract against real
      // PostgreSQL tables before and after the autonomy-budget columns exist.
      "src/signals/services/__tests__/autonomy-budget-rollout.test.ts",
      // A pre-0835 table cannot be constructed through a production API. This
      // focused transaction proves Calendar watch reads and initial writes stay
      // legal on both sides of the transition-column migration.
      "src/signals/services/__tests__/google-calendar-watch-rollout.test.ts",
      // A physical relation versus a compatibility view cannot be selected
      // through the production API. This focused PostgreSQL test proves the
      // exact Agent Draft writer through both rollout targets.
      "src/signals/services/__tests__/agent-draft-write.service.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@okouai/db/schema",
              message: apiTestExternalBehaviorMessage,
            },
          ],
          patterns: [
            {
              group: ["@okouai/db/schema/*"],
              message: apiTestExternalBehaviorMessage,
            },
            {
              group: apiTestServiceImportPatterns,
              message: apiTestExternalBehaviorMessage,
            },
            {
              group: apiTestDirectDbImportPatterns,
              message: apiTestDirectDbImportMessage,
            },
          ],
        },
      ],
    },
  },
];
