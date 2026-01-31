import { nextJsConfig } from "@vm0/eslint-config/next-js";

/** @type {import("eslint").Linter.Config} */
export default [
  ...nextJsConfig,
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ClassDeclaration",
          message:
            "Classes are not allowed. Use functions and plain objects instead.",
        },
        {
          selector: "ClassExpression",
          message:
            "Classes are not allowed. Use functions and plain objects instead.",
        },
      ],
    },
  },
];
