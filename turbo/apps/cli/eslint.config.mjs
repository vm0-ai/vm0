import { config } from "@vm0/eslint-config/base";

export default [
  ...config,
  {
    files: ["sandbox-proxy.ts"],
    rules: {
      "turbo/no-undeclared-env-vars": "off",
    },
  },
];
