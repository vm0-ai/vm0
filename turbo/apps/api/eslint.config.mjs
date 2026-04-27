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
