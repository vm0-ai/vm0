import { config, oxlint } from "@vm0/eslint-config/base";
import { apiLintPlugin } from "./custom-eslint/index.ts";

export default [
  ...config,
  {
    plugins: {
      api: apiLintPlugin,
    },
    rules: {
      "api/no-logger-info": "error",
    },
  },
  {
    files: ["src/signals/**/*.ts"],
    ignores: ["src/signals/external/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/lib/**"],
              message:
                "lib/ singletons must be re-exported through signals/external/. Do not import lib/ from other signals files.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/lib/env.ts", "src/__tests__/env-stub.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Use env(name) from lib/env (or signals/external/env) instead of process.env. process.env is only allowed in lib/env.ts.",
        },
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name='stubEnv']",
          message:
            "Use mockEnv(name, value) from lib/env instead of vi.stubEnv. vi.stubEnv is only allowed in __tests__/env-stub.ts for module-load-time bootstrap.",
        },
      ],
    },
  },
  {
    ignores: ["**/dist/**"],
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
