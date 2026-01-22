import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import tseslint from "typescript-eslint";

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const config = [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
      complexity: ["error", { max: 20 }],
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts", "*.config.mjs", "*.config.js"],
        },
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: false },
      ],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/naming-convention": [
        "error",
        // Variables and parameters: camelCase, UPPER_CASE, or PascalCase
        {
          selector: ["variable", "parameter"],
          format: ["camelCase", "UPPER_CASE", "PascalCase"],
          leadingUnderscore: "allow",
          trailingUnderscore: "allow",
          filter: {
            // Exclude magic variables like __CLI_VERSION__
            regex: "^__.*__$",
            match: false,
          },
        },
        // Properties: allow any format (API fields, etc may use snake_case)
        {
          selector: "property",
          format: null,
        },
        // Functions: camelCase or PascalCase (React components)
        {
          selector: "function",
          format: ["camelCase", "PascalCase"],
        },
        // Type-like: PascalCase
        {
          selector: "typeLike",
          format: ["PascalCase"],
        },
        // Enum members: flexible
        {
          selector: "enumMember",
          format: ["camelCase", "UPPER_CASE", "PascalCase"],
        },
      ],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", ".turbo/**", "coverage/**"],
  },
];
