import { config as baseConfig, oxlint } from "@vm0/eslint-config/base";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginReact from "eslint-plugin-react";
import ccstatePlugin from "./custom-eslint/index.ts";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...baseConfig,
  {
    ...pluginReact.configs.flat.recommended,
    settings: { react: { version: "detect" } },
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
      // Non-type-aware rules
      "ccstate/signal-dollar-suffix": "error",
      "ccstate/no-export-state": "error",
      "ccstate/signal-check-await": "error",
      "ccstate/tsx-in-views": "error",
      "ccstate/test-context-in-hooks": "error",
      "ccstate/setup-page-render": "error",
      "ccstate/no-side-effect-in-render": "error",
      "ccstate/no-non-zero-api": "error",
      "ccstate/no-new-abort-controller": "error",
      "ccstate/no-direct-local-storage": "error",
      "ccstate/no-detach-in-signals": "error",
      "ccstate/no-direct-fetch": "error",
      "ccstate/no-empty-promise-catch": "error",
      "ccstate/no-void-statement": "error",
      "ccstate/no-abort-swallower": "error",
      "ccstate/require-accept": "error",
    },
  },
  // Type-aware rules (only for TypeScript files)
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "ccstate/no-package-variable": [
        "error",
        {
          allowedMutableTypes: [
            { from: "package", name: "State", package: "ccstate" },
            { from: "package", name: "Computed", package: "ccstate" },
            { from: "package", name: "Command", package: "ccstate" },
            { from: "file", name: "ConsoleLogger" },
            { from: "file", name: "TestContext" },
            { from: "package", name: "Store", package: "ccstate" },
            { from: "file", name: "LocationOverrides" },
            { from: "file", name: "PromiseTracker" },
            { from: "file", name: "LoggerRegistry" },
          ],
        },
      ],
      "ccstate/no-get-signal": "error",
      "ccstate/computed-const-args-package-scope": "error",
      "ccstate/no-store-in-params": [
        "error",
        {
          // setupRouter is the app-boundary bootstrap function that must bridge
          // the Store instance into React's StoreProvider context system.
          allowedFunctions: ["setupRouter"],
        },
      ],
      "ccstate/command-async-signal": "error",
      "ccstate/no-getter-setter-params": "error",
    },
  },
  {
    files: ["**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "ccstate/prefer-user-event": [
        "error",
        {
          // scroll and wheel events cannot be simulated by userEvent; allow
          // dispatchEvent with these event types for tests that verify
          // auto-scroll behaviour (including the user-input gate check).
          // beforeinstallprompt and appinstalled are browser-generated PWA events
          // that cannot be triggered via userEvent.
          allowedEventTypes: [
            "appinstalled",
            "beforeinstallprompt",
            // Custom class used in pwa-install tests to carry the prompt()
            // callback; cannot be replaced by userEvent (browser-generated PWA event).
            "beforeinstallpromptevent",
            "scroll",
            "wheel",
          ],
        },
      ],
      "ccstate/no-test-delay": "error",
      "ccstate/no-get-by-role-name": "error",
      "ccstate/no-user-clear-tab": "error",
      "ccstate/no-raw-msw-http": "error",
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
  // View files below use fetch$ for multipart file uploads that lack ts-rest
  // contracts — migrate them to zeroClient$ when contracts are added.
  {
    files: [
      "src/signals/fetch.ts",
      "src/signals/api-client.ts",
      "src/signals/zero-page/chat-draft.ts",
      "src/signals/__tests__/fetch.test.ts",
      "src/signals/voice-io/voice-io-tts.ts",
      "src/signals/voice-io/voice-io-stt.ts",
      "src/views/zero-page/components/org-manage/org-general-tab.tsx",
      "src/views/agents-page/agents-page.tsx",
      "src/views/zero-page/zero-settings-tab.tsx",
      "src/lib/push-notifications.ts",
    ],
    rules: {
      "ccstate/no-direct-fetch": "off",
    },
  },
  // Allow raw http.* in the fetch$ wrapper self-tests. The file exercises the
  // wrapper against synthetic URLs (`/test`, `/api/zero/items`) that do not
  // correspond to any ts-rest contract — see the file-level comment in
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
  // Ban try statements in production source code.
  // Use accept() for API errors, useLoadableSet for loading states.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/__tests__/**", "src/mocks/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TryStatement",
          message:
            "try statements are not allowed. Use accept() for API errors, useLoadableSet for loading states.",
        },
      ],
    },
  },
  // utils.ts is the centralised infrastructure file for try/catch patterns:
  // JSON.parse guard, best-effort wrappers, polling with transient-error backoff,
  // and race-under-signal finally cleanup. All try statements here are intentional.
  {
    files: ["src/signals/utils.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  {
    ignores: [
      "dist/**",
      "public/**",
      "vite.config.ts",
      "vitest.config.ts",
      "custom-eslint/**",
      "src/mocks/**",
      "src/__tests__/**",
    ],
  },
  ...oxlint.buildFromOxlintConfigFile("../../.oxlintrc.json"),
];
