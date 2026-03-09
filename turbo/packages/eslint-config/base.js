import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import tseslint from "typescript-eslint";

const vm0Plugin = {
  rules: {
    "no-msw-bypass": {
      meta: {
        type: "problem",
        docs: {
          description:
            'Disallow onUnhandledRequest: "bypass" in MSW server configuration',
        },
        messages: {
          noBypass:
            'Use onUnhandledRequest: "error" instead of "bypass". All MSW requests must be explicitly handled.',
        },
        schema: [],
      },
      create(context) {
        return {
          Property(node) {
            if (
              node.key.type === "Identifier" &&
              node.key.name === "onUnhandledRequest" &&
              node.value.type === "Literal" &&
              node.value.value === "bypass"
            ) {
              context.report({ node: node.value, messageId: "noBypass" });
            }
          },
        };
      },
    },
    "no-relative-vi-mock": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow vi.mock() with relative paths — mock at external boundaries instead",
        },
        messages: {
          noRelativeMock:
            "Do not use vi.mock() with relative paths. Mock at external boundaries (globalThis.fetch, console, etc.) instead of internal modules.",
        },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            if (
              node.callee.type === "MemberExpression" &&
              node.callee.object.type === "Identifier" &&
              node.callee.object.name === "vi" &&
              node.callee.property.type === "Identifier" &&
              node.callee.property.name === "mock" &&
              node.arguments.length > 0 &&
              node.arguments[0].type === "Literal" &&
              typeof node.arguments[0].value === "string" &&
              (node.arguments[0].value.startsWith("./") ||
                node.arguments[0].value.startsWith("../"))
            ) {
              context.report({ node, messageId: "noRelativeMock" });
            }
          },
        };
      },
    },
  },
};

/**
 * A shared ESLint configuration for the repository.
 *
 * IMPORTANT: All workspace lint scripts MUST use `--max-warnings 0`.
 * This is a hard team requirement — do NOT remove it from any package.json.
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
      vm0: vm0Plugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
      complexity: ["error", { max: 20 }],
      "vm0/no-msw-bypass": "error",
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
