import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config as baseConfig, oxlint } from "@okouai/eslint-config/base";
import ccstatePlugin from "@okouai/eslint-rules/ccstate";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginReact from "eslint-plugin-react";

const eslintCacheInputPaths = globSync(
  [
    "eslint.config.js",
    "package.json",
    "../../package.json",
    "../../pnpm-lock.yaml",
    "../../pnpm-workspace.yaml",
    "../../turbo.json",
    "../../{apps,packages}/*/turbo.{json,jsonc}",
    "../../packages/eslint-config/**/*.{js,cjs,mjs,json}",
    "../../packages/eslint-rules/package.json",
    "../../packages/eslint-rules/src/ccstate/**/*.ts",
  ],
  {
    cwd: import.meta.dirname,
    exclude: [
      "../../packages/eslint-config/**/*.node.js",
      "../../packages/eslint-rules/src/ccstate/__tests__/**",
    ],
  },
).sort();
const eslintCacheHash = createHash("sha256");

// Cached results must only depend on the linted file, its calculated config,
// and the inputs above. Add new external inputs here before enabling a rule
// that reads them; type-aware or other cross-file rules need broader invalidation.
for (const inputPath of eslintCacheInputPaths) {
  eslintCacheHash.update(inputPath).update("\0");
  eslintCacheHash
    .update(readFileSync(resolve(import.meta.dirname, inputPath)))
    .update("\0");
}

const eslintCacheFingerprint = eslintCacheHash.digest("hex");

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...baseConfig,
  {
    ...pluginReact.configs.flat.recommended,
    settings: {
      react: { version: "detect" },
      "vm0/eslint-cache-fingerprint": eslintCacheFingerprint,
    },
  },
  {
    plugins: {
      "react-hooks": pluginReactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    plugins: {
      ccstate: ccstatePlugin,
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      // Moved to oxlint (react plugin) — not in eslint-plugin-oxlint mapping, explicit off required.
      "react/require-render-return": "off",
      // Redundant in TypeScript projects (type system enforces these) and not in oxlint.
      "react/prop-types": "off",
      "react/no-deprecated": "off",
      "ccstate/signal-dollar-suffix": "error",
      "ccstate/no-export-state": "error",
      "ccstate/signal-check-await": "error",
      "ccstate/tsx-in-views": "error",
      "ccstate/test-context-in-hooks": "error",
      "ccstate/setup-page-render": "error",
      "ccstate/no-side-effect-in-render": "error",
      "ccstate/no-new-abort-controller": "error",
      "ccstate/no-new-promise": "error",
      "ccstate/no-direct-local-storage": "error",
      "ccstate/no-direct-session-storage": "error",
      "ccstate/no-detach-in-signals": "error",
      "ccstate/no-direct-fetch": "error",
      "ccstate/no-empty-promise-catch": "error",
      "ccstate/no-void-statement": "error",
      "ccstate/no-abort-swallower": "error",
      "ccstate/no-react-class-component": "error",
      "ccstate/prefer-ui-components": "error",
      "ccstate/require-accept": "error",
      "ccstate/require-client-signal": "error",
      "ccstate/command-async-signal": "error",
      "ccstate/no-computed-signal": "error",
      "ccstate/no-getter-setter-params": "error",
      "ccstate/no-accessor-escape": "error",
      "ccstate/no-store-in-params": [
        "error",
        {
          // setupRouter is the app-boundary bootstrap function that must bridge
          // the Store instance into React's StoreProvider context system.
          allowedFunctions: ["setupRouter"],
        },
      ],
      "ccstate/no-get-signal": "error",
      "ccstate/no-package-variable": [
        "error",
        {
          allowedConstructors: [
            "LocationOverrides",
            "PromiseTracker",
            "LoggerRegistry",
          ],
        },
      ],
      "ccstate/computed-const-args-package-scope": "error",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/**/__tests__/**",
      "src/**/test/**",
      "src/**/tests/**",
      "src/**/mocks/**",
      "src/**/test-fixtures/**",
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
      "src/**/test-context.{ts,tsx}",
      "src/signals/fetch.ts",
    ],
    rules: {
      "vm0/no-abort-signal-in-object-params": "error",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/time.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "Date",
          property: "now",
          message:
            "Use now() from src/lib/time instead of Date.now() so tests can control the platform clock.",
        },
      ],
    },
  },
  {
    files: ["**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "ccstate/no-test-delay": "error",
      "ccstate/no-manual-mock-cleanup": "error",
      "ccstate/no-get-by-role-name": "error",
      "ccstate/no-user-clear-tab": "error",
      "ccstate/no-raw-msw-http": "error",
      "ccstate/no-mockapi-raw-async": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name=/^(it|test)$/][arguments.2.type='Literal']",
          message:
            "Do not set test timeout. The default timeout (5000ms) is sufficient — a single test should complete within 500ms. Polling intervals are reduced to 10ms in tests, so do not rely on extending timeout to fix flaky tests. Find and fix the underlying timing issue instead.",
        },
        {
          selector:
            "CallExpression[callee.name='describe'][arguments.2.type='Literal']",
          message:
            "Do not set test timeout. The default timeout (5000ms) is sufficient — a single test should complete within 500ms. Polling intervals are reduced to 10ms in tests, so do not rely on extending timeout to fix flaky tests. Find and fix the underlying timing issue instead.",
        },
        {
          selector:
            "CallExpression[callee.name='waitFor'] > ObjectExpression > Property[key.name='timeout']",
          message:
            "Do not set test timeout. The default timeout (5000ms) is sufficient — a single test should complete within 500ms. Polling intervals are reduced to 10ms in tests, so do not rely on extending timeout to fix flaky tests. Find and fix the underlying timing issue instead.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Use nowDate() from src/lib/time instead of new Date() so tests can control the platform clock.",
        },
      ],
    },
  },
  {
    files: [
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
      "src/**/__tests__/**/*.{ts,tsx}",
    ],
    ignores: ["src/signals/__tests__/test-helpers.ts"],
    rules: {
      "ccstate/no-test-after-each": "error",
    },
  },
  {
    files: ["src/mocks/**/*.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Use nowDate() from src/lib/time instead of new Date() so tests can control the platform clock.",
        },
      ],
    },
  },
  // Enforce unique route param names in route definitions
  {
    files: ["src/signals/route-paths.ts"],
    rules: {
      "ccstate/no-duplicate-route-param": "error",
    },
  },
  // Allow detach() in signal infrastructure (definition site)
  {
    files: ["src/signals/utils.ts"],
    rules: {
      "ccstate/no-detach-in-signals": "off",
    },
  },
  // Allow direct fetch$ in the abstraction layers and tests.
  // View files below use fetch$ for multipart file uploads that lack typed
  // contracts — migrate them to apiClient$ when contracts are added.
  {
    files: [
      "src/signals/fetch.ts",
      "src/signals/api-client.ts",
      "src/signals/okou-page/chat-draft.ts",
      "src/signals/__tests__/fetch.test.ts",
      "src/signals/voice-io/voice-io-stt.ts",
      "src/views/okou-page/components/org-manage/org-general-tab.tsx",
      "src/views/agents-page/agents-page.tsx",
      "src/views/okou-page/settings-tab.tsx",
      "src/lib/push-notifications.ts",
    ],
    rules: {
      "ccstate/no-direct-fetch": "off",
    },
  },
  // Allow raw http.* in the fetch$ wrapper self-tests. The file exercises the
  // wrapper against synthetic URLs (`/test`, `/api/zero/items`) that do not
  // correspond to any typed contract — see the file-level comment in
  // src/signals/__tests__/fetch.test.ts for the full rationale.
  {
    files: ["src/signals/__tests__/fetch.test.ts"],
    rules: {
      "ccstate/no-raw-msw-http": "off",
    },
  },
  // Allow direct localStorage in the abstraction layer only
  {
    files: ["src/signals/external/local-storage.ts"],
    rules: {
      "ccstate/no-direct-local-storage": "off",
    },
  },
  // Allow Promise primitives in the centralized deferred helper and dedicated
  // browser wrappers. App code should continue using createDeferredPromise().
  {
    files: [
      "src/signals/utils.ts",
      "src/polyfill.ts",
      "src/views/okou-page/components/org-manage/read-image-dimensions.ts",
    ],
    rules: {
      "ccstate/no-new-promise": "off",
    },
  },
  // Allow new AbortController in signal infrastructure, test helpers, and
  // views that need a controller outliving the page signal (e.g. post-navigate
  // async work).
  {
    files: [
      "src/signals/utils.ts",
      "src/polyfill.ts",
      "src/signals/__tests__/test-helpers.ts",
      "src/signals/__tests__/utils.test.ts",
      "src/signals/__tests__/realtime.test.ts",
      "src/signals/zero-page/__tests__/poll-slack-connection.test.ts",
    ],
    rules: {
      "ccstate/no-new-abort-controller": "off",
    },
  },
  // Ban try statements and raw .then()/.catch() in production source code.
  // - try/catch: use accept() for API errors, useLoadableSet for loading states.
  // - .then/.catch: production code must await and surface state via ccstate
  //   loadables; the centralized helpers in signals/utils.ts (bestEffort,
  //   tapError, onRejection, settle, toVoid, detach) wrap the legitimate
  //   Promise primitive usage — see issue #13535.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/**/__tests__/**",
      "src/mocks/**",
      // Infrastructure: utils.ts implements the centralized Promise helpers,
      // so it is exempted from the .then/.catch ban via the override below.
      "src/signals/utils.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TryStatement",
          message:
            "try statements are not allowed. Use accept() for API errors, useLoadableSet for loading states.",
        },
        {
          selector: "ImportExpression",
          message:
            "Dynamic JavaScript imports are not allowed. Keep application code in the single bundle; locale resources remain separate JSON assets.",
        },
        {
          selector: "CallExpression[callee.property.name='then']",
          message:
            "Promise.then is not allowed. Use await, or one of the helpers in signals/utils.ts (bestEffort, tapError, onRejection, settle, toVoid).",
        },
        {
          selector: "CallExpression[callee.property.name='catch']",
          message:
            "Promise.catch is not allowed. Use the helpers in signals/utils.ts (bestEffort, tapError, onRejection, settle).",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Use nowDate() from src/lib/time instead of new Date() so tests can control the platform clock.",
        },
      ],
    },
  },
  // utils.ts hosts the centralized Promise helpers that wrap try/catch and
  // .then/.catch. Keep the try-statement ban so new try blocks still need
  // explicit per-line opt-out, but allow .then/.catch in the helper bodies.
  {
    files: ["src/signals/utils.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TryStatement",
          message:
            "try statements are not allowed. Use accept() for API errors, useLoadableSet for loading states.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Use nowDate() from src/lib/time instead of new Date() so tests can control the platform clock.",
        },
      ],
    },
  },
  // Every catch in production source must re-throw cancellation before it does
  // anything else, so an aborted page never reports a failure or persists a
  // fallback. The ignore list matches the try-statement ban above: test and
  // mock code carries no abort contract, and utils.ts implements the
  // centralized helpers (onRejection, settle, tapError) whose whole purpose is
  // to observe a rejection — including an abort — before re-throwing it.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/__tests__/**", "src/mocks/**", "src/signals/utils.ts"],
    rules: {
      "ccstate/no-catch-abort": "error",
    },
  },
  {
    ignores: [
      "dist/**",
      "public/**",
      "vite.config.ts",
      "vitest.config.ts",
      "src/mocks/**",
      "src/__tests__/**",
      // Asset files — not JS/TS, would cause parse errors when matched by
      // broad file globs in .oxlintrc.json overrides (e.g. src/views/**/*.*)
      "**/*.svg",
      "**/*.png",
      "**/*.webp",
      "**/*.css",
    ],
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "ably",
              allowTypeImports: true,
              message:
                "Use src/lib/ably-realtime.ts for the modular runtime; direct imports are type-only.",
            },
            {
              name: "@clerk/clerk-js",
              message:
                "Use src/lib/clerk-runtime.ts so Clerk loads the official browser runtime without bundled wallet adapters.",
            },
            {
              name: "@clerk/ui",
              message:
                "Hosted Clerk UI is not part of platform auth; use the app-owned Auth v2 components.",
            },
            {
              name: "@solana/web3.js",
              message:
                "Wallet support is not part of the platform auth surface.",
            },
            {
              name: "katex",
              message: "Markdown math rendering is intentionally disabled.",
            },
            {
              name: "rehype-katex",
              message: "Markdown math rendering is intentionally disabled.",
            },
            {
              name: "remark-math",
              message: "Markdown math rendering is intentionally disabled.",
            },
            {
              name: "@tabler/icons-react",
              message:
                "Use lucide-react or a shared @okouai/ui brand icon instead.",
            },
          ],
        },
      ],
    },
  },
  // react/jsx-uses-vars marked JSX identifiers as "used" for ESLint's no-unused-vars.
  // Both no-unused-vars and @typescript-eslint/no-unused-vars are now handled by
  // oxlint, so this rule is no longer needed.
  { rules: { "react/jsx-uses-vars": "off" } },
];
