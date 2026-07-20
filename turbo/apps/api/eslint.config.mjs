import { config, oxlint } from "@vm0/eslint-config/base";
import { apiLintPlugin } from "@vm0/eslint-rules/api";

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

// Raw-SQL ratchet (issue #22106): hand-written SQL through the Drizzle `sql`
// escape hatch is banned in application query code because it is not checked
// against the schema and its `sql<...>` generic performs no runtime decoding
// (production incident #22115). Existing usage is frozen in this allowlist.
// Cleanup PRs migrate a file to schema-aware query builders and delete its
// entry. Never add entries without an aligned exception (e.g. advisory locks).
const rawSqlAllowlist = [
  "src/scripts/dev-bench-seed.ts",
  "src/scripts/dev-seed.ts",
  "src/signals/routes/audio-transcriptions-v1.ts",
  "src/signals/routes/runners.ts",
  "src/signals/routes/test-artifact-preview-state.ts",
  "src/signals/routes/test-cron-cleanup-sandboxes-state.ts",
  "src/signals/routes/test-cron-sync-skills-state.ts",
  "src/signals/routes/test-runtime-state.ts",
  "src/signals/routes/test-slack-state.ts",
  "src/signals/routes/test-storage-archive-size-backfill-state.ts",
  "src/signals/routes/test-system-storage-presigned-url-cache-state.ts",
  "src/signals/routes/test-teams-state.ts",
  "src/signals/routes/test-telegram-state.ts",
  "src/signals/routes/test-workflow-skill-storage-presigned-url-cache-state.ts",
  "src/signals/routes/zero-artifacts.ts",
  "src/signals/routes/zero-chat-messages.ts",
  "src/signals/routes/zero-chat-threads-mark-agent-read.ts",
  "src/signals/routes/zero-chat-threads-mark-read.ts",
  "src/signals/services/agent-event-consumer-chat-assistant.service.ts",
  "src/signals/services/agent-run-create.service.ts",
  "src/signals/services/agent-run-storage.service.ts",
  "src/signals/services/agent-webhook-checkpoints.service.ts",
  "src/signals/services/agent-webhook-complete.service.ts",
  "src/signals/services/agent-webhook-firewall-auth.service.ts",
  "src/signals/services/artifact-preview.service.ts",
  "src/signals/services/auth-state-lock.service.ts",
  "src/signals/services/billing-customer.service.ts",
  "src/signals/services/chat-message-queue.service.ts",
  "src/signals/services/chat-thread.service.ts",
  "src/signals/services/cli-auth.service.ts",
  "src/signals/services/connector-catalog-sync.service.ts",
  "src/signals/services/connector-check.service.ts",
  "src/signals/services/connector-credential-runtime.service.ts",
  "src/signals/services/connector-external-code.service.ts",
  "src/signals/services/connector-oauth-device-auth.service.ts",
  "src/signals/services/cron-aggregate-insights.service.ts",
  "src/signals/services/cron-aggregate-usage.service.ts",
  "src/signals/services/cron-backfill-storage-archive-sizes.service.ts",
  "src/signals/services/cron-billing-entitlements.service.ts",
  "src/signals/services/cron-cleanup-sandboxes.service.ts",
  "src/signals/services/cron-compact-chat-thread-snapshots.service.ts",
  "src/signals/services/cron-computer-use-screenshot-cleanup.service.ts",
  "src/signals/services/cron-telegram-cleanup.service.ts",
  "src/signals/services/diagnostic-bundle.service.ts",
  "src/signals/services/google-calendar-workflow-event.service.ts",
  "src/signals/services/internal-chat-run-callback.service.ts",
  "src/signals/services/model-stats.service.ts",
  "src/signals/services/notion-workflow-event.service.ts",
  "src/signals/services/onboarding-credit-grants.service.ts",
  "src/signals/services/org-concurrency-entitlements.service.ts",
  "src/signals/services/org-limited-free-bootstrap.service.ts",
  "src/signals/services/run-uploaded-files.service.ts",
  "src/signals/services/runner-job-queue-lifecycle.service.ts",
  "src/signals/services/runner-session-affinity.ts",
  "src/signals/services/system-storage-presigned-url-cache.service.ts",
  "src/signals/services/usage-allowance.service.ts",
  "src/signals/services/usage.service.ts",
  "src/signals/services/webhooks-stripe.service.ts",
  "src/signals/services/zero-billing-status.service.ts",
  "src/signals/services/zero-chat-incomplete-context.service.ts",
  "src/signals/services/zero-chat-message-shared.service.ts",
  "src/signals/services/zero-chat-queued-message.service.ts",
  "src/signals/services/zero-chat-thread-event.service.ts",
  "src/signals/services/zero-chat-thread.service.ts",
  "src/signals/services/zero-chat-usage-message.service.ts",
  "src/signals/services/zero-computer-use.service.ts",
  "src/signals/services/zero-connector-data.service.ts",
  "src/signals/services/zero-credit-low-balance-alert.service.ts",
  "src/signals/services/zero-credit-recharge.service.ts",
  "src/signals/services/zero-credit-usage.service.ts",
  "src/signals/services/zero-email-common.service.ts",
  "src/signals/services/zero-goal.service.ts",
  "src/signals/services/zero-insights.service.ts",
  "src/signals/services/zero-mail.service.ts",
  "src/signals/services/zero-managed-usage.service.ts",
  "src/signals/services/zero-model-provider.service.ts",
  "src/signals/services/zero-push-subscriptions.service.ts",
  "src/signals/services/zero-run-admission.service.ts",
  "src/signals/services/zero-run-bootstrap-context.service.ts",
  "src/signals/services/zero-run-built-in-admission.service.ts",
  "src/signals/services/zero-run-queue.service.ts",
  "src/signals/services/zero-runs.service.ts",
  "src/signals/services/zero-teams-connect.service.ts",
  "src/signals/services/zero-usage-insight.service.ts",
  "src/signals/services/zero-usage-record.service.ts",
  "src/signals/services/zero-usage-reporting-ledger.ts",
  "src/signals/services/zero-voice-io-post.service.ts",
  "src/test-fixtures/chat-messages.ts",
  "src/test-fixtures/legacy-goals.ts",
  "src/test-fixtures/org-metadata.ts",
  "src/test-fixtures/usage-pricing.ts",
  "src/test-fixtures/user-behavior-count.ts",
];

const apiTestExternalBehaviorMessage =
  "API tests must exercise external behavior through API endpoints. Do not test internal implementation details. See docs/testing/testing-external-behavior.md.";

const apiTestDirectDbImportMessage =
  "API tests must not import DB handles directly. Exercise setup and assertions through API endpoints; add a test route only when an external-behavior exception is justified.";

const productionRouteTestImportMessage =
  "Production route composition must not import test-only routes. Mount required test fixture routes explicitly from tests.";

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
  ...config,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      api: apiLintPlugin,
    },
    rules: {
      "api/no-catch-abort": "error",
      "api/no-fn-dollar-suffix": "error",
      "api/no-getter-setter-params": "error",
      "api/no-logger-info": "error",
      "api/no-new-promise": "error",
      "api/no-store-in-params": "error",
      "api/require-execute-row-schema": "error",
      "api/signal-check-await": "error",
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
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/__tests__/**",
      "src/**/*.test.ts",
      "src/**/__benches__/**",
      ...rawSqlAllowlist,
    ],
    plugins: {
      api: apiLintPlugin,
    },
    rules: {
      "api/no-raw-sql": "error",
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
    files: ["src/signals/route.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./routes/test-*", "./routes/test-*/**"],
              message: productionRouteTestImportMessage,
            },
          ],
          paths: [
            {
              name: "./routes/cli-auth-test",
              message: productionRouteTestImportMessage,
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
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@vm0/db/schema",
              message: apiTestExternalBehaviorMessage,
            },
          ],
          patterns: [
            {
              group: ["@vm0/db/schema/*"],
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
