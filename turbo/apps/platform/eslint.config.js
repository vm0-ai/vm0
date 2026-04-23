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
      "ccstate/no-non-zero-api": "error",
      "ccstate/no-new-abort-controller": "error",
      "ccstate/no-new-promise": "error",
      "ccstate/no-direct-local-storage": "error",
      "ccstate/no-detach-in-signals": "error",
      "ccstate/no-direct-fetch": "error",
      "ccstate/no-empty-promise-catch": "error",
      "ccstate/no-void-statement": "error",
      "ccstate/no-abort-swallower": "error",
      "ccstate/require-accept": "error",
      "ccstate/require-client-signal": "error",
      "ccstate/command-async-signal": "error",
      "ccstate/no-getter-setter-params": "error",
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
    files: ["**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "ccstate/no-test-delay": "error",
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
  // Allow new Promise() in the dedicated helper that wraps a one-shot
  // browser DOM event pair (<img> load/error). No ambient signal exists at
  // the DOM layer; isolating the pattern to a single-purpose file keeps the
  // rule active for the rest of org-general-tab.tsx.
  {
    files: [
      "src/views/zero-page/components/org-manage/read-image-dimensions.ts",
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
  // voice-chat-candidate-session.ts wraps three browser APIs that are specified
  // to throw: JSON.parse on untrusted Realtime DC event data, navigator.wakeLock.request
  // (OS deny or hidden document), and navigator.mediaDevices.getUserMedia (permission
  // denied or no hardware). Each try block has recovery logic that cannot use accept()
  // or useLoadableSet.
  {
    files: ["src/signals/voice-chat-candidate/voice-chat-candidate-session.ts"],
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
      "eslint.config.ablation.mjs",
      // Asset files — not JS/TS, would cause parse errors when matched by
      // broad file globs in .oxlintrc.json overrides (e.g. src/views/**/*.*)
      "**/*.svg",
      "**/*.png",
      "**/*.webp",
      "**/*.css",
    ],
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
  // react/jsx-uses-vars marked JSX identifiers as "used" for ESLint's no-unused-vars.
  // Both no-unused-vars and @typescript-eslint/no-unused-vars are now handled by
  // oxlint, so this rule is no longer needed.
  { rules: { "react/jsx-uses-vars": "off" } },
];
