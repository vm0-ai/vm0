import { config, oxlint } from "@vm0/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["**/dist/**"],
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
      "src/auth-providers/connectors/test-oauth/**",
    ],
    rules: {
      "vm0/no-abort-signal-in-object-params": "error",
    },
  },
  // Public package entry points may aggregate implementation modules.
  {
    files: ["src/firewall-types.ts", "src/firewall-metadata/policy.ts"],
    rules: {
      "vm0/no-re-export": "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
