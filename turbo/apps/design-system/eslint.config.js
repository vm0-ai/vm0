import globals from "globals";

import { config } from "@okouai/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  { ignores: ["dist/**", "src/generated/**"] },
  {
    // The generators run under Node, not in the browser.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
];
