import { config, oxlint } from "@vm0/eslint-config/base";
import { apiLintPlugin } from "./custom-eslint/index.ts";

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
// work in signals/utils.ts (safeAsync, safeJsonParse, detach, etc.).
const promiseChainSyntax = [
  {
    selector: "CallExpression[callee.property.name='then']",
    message:
      "Promise.then is not allowed. Use await, or centralize the guarded async in signals/utils.ts (safeAsync, detach).",
  },
  {
    selector: "CallExpression[callee.property.name='catch']",
    message:
      "Promise.catch is not allowed. Use safeAsync from signals/utils.ts (or detach for fire-and-forget).",
  },
];

// Files that still use raw .then/.catch as of issue #13535. The lint rule
// blocks new additions everywhere else; this allowlist captures the legacy
// surface so changes inside listed files do not regress, but they should be
// migrated incrementally. Tracked as tech debt — do not extend without
// migrating a listed file off raw promise chaining first.
const promiseChainAllowlist = [
  // Infrastructure: pg/OTel instrumentation, detached-promise tracking, and
  // sandbox wrappers wrap browser/runtime primitives; .then chains are the
  // intentional contract.
  "src/lib/db.ts",
  "src/lib/log.ts",
  "src/signals/utils.ts",
  "src/signals/external/sandbox.ts",
  "src/signals/external/sandbox-op-log.ts",
  "src/signals/external/realtime.ts",
  // Routes — pending migration to await + safeAsync.
  "src/signals/routes/agent-runs-cancel.ts",
  "src/signals/routes/integrations-telegram-link.ts",
  "src/signals/routes/internal-callbacks-chat.ts",
  "src/signals/routes/internal-callbacks-slack-org.ts",
  "src/signals/routes/internal-callbacks-voice-chat.ts",
  "src/signals/routes/internal-event-consumers-agentphone-typing.ts",
  "src/signals/routes/internal-event-consumers-telegram-typing.ts",
  "src/signals/routes/test-slack-dispatch-probe.ts",
  "src/signals/routes/test-telegram-state.ts",
  "src/signals/routes/user-export.ts",
  "src/signals/routes/webhooks-agent-complete.ts",
  "src/signals/routes/webhooks-clerk.ts",
  "src/signals/routes/webhooks-github.ts",
  "src/signals/routes/zero-agents.ts",
  "src/signals/routes/zero-chat-messages.ts",
  "src/signals/routes/zero-integrations-agentphone.ts",
  "src/signals/routes/zero-integrations-slack.ts",
  "src/signals/routes/zero-integrations-telegram.ts",
  "src/signals/routes/zero-runs-cancel.ts",
  "src/signals/routes/zero-slack-browser-connect.ts",
  "src/signals/routes/zero-slack-connect.ts",
  "src/signals/routes/zero-slack-oauth.ts",
  // Services — pending migration to await + safeAsync.
  "src/signals/services/agent-run-create.service.ts",
  "src/signals/services/agent-webhook-complete.service.ts",
  "src/signals/services/agent-webhook-events.service.ts",
  "src/signals/services/cli-auth-stripe.service.ts",
  "src/signals/services/diagnostic-bundle.service.ts",
  "src/signals/services/google-drive-artifact-sync.service.ts",
  "src/signals/services/integrations-github.service.ts",
  "src/signals/services/onboarding.service.ts",
  "src/signals/services/run-summary.service.ts",
  "src/signals/services/storage-volume-upload.service.ts",
  "src/signals/services/webhooks-clerk-cleanup.service.ts",
  "src/signals/services/zero-chat-title.service.ts",
  "src/signals/services/zero-connector-data.service.ts",
  "src/signals/services/zero-integrations-slack-message.service.ts",
  "src/signals/services/zero-org-data.service.ts",
  "src/signals/services/zero-permission-access-requests.service.ts",
  "src/signals/services/zero-run-cancel.service.ts",
  "src/signals/services/zero-schedules.service.ts",
  "src/signals/services/zero-slack-connect.service.ts",
  "src/signals/services/zero-slack-webhooks.service.ts",
  "src/signals/services/zero-telegram-data.service.ts",
  "src/signals/services/zero-telegram-post.service.ts",
];

export default [
  ...config,
  {
    files: ["src/**/*.ts", "custom-eslint/**/*.ts"],
    plugins: {
      api: apiLintPlugin,
    },
    rules: {
      "api/no-catch-abort": "error",
      "api/no-fn-dollar-suffix": "error",
      "api/no-getter-setter-params": "error",
      "api/no-logger-info": "error",
      "api/no-store-in-params": "error",
      "api/signal-check-await": "error",
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
];
