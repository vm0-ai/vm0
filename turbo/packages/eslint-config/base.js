import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import oxlint from "eslint-plugin-oxlint";
import turboPlugin from "eslint-plugin-turbo";
import tseslint from "typescript-eslint";

import { noAbortSignalInObjectParams } from "./no-abort-signal-in-object-params.js";

export { oxlint };

const okouPlugin = {
  rules: {
    "no-abort-signal-in-object-params": noAbortSignalInObjectParams,
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
    "no-fetch-spy": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow spying on fetch with vi.spyOn. Use MSW instead.",
        },
        messages: {
          noFetchSpy:
            'Do not spy on fetch with vi.spyOn(globalThis, "fetch"). Use MSW to intercept HTTP requests instead. See: https://mswjs.io/docs/getting-started',
        },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            const { callee } = node;
            if (
              callee.type === "MemberExpression" &&
              callee.object.type === "Identifier" &&
              callee.object.name === "vi" &&
              callee.property.type === "Identifier" &&
              callee.property.name === "spyOn" &&
              node.arguments.length >= 2 &&
              node.arguments[0].type === "Identifier" &&
              ["globalThis", "global", "window"].includes(
                node.arguments[0].name,
              ) &&
              node.arguments[1].type === "Literal" &&
              node.arguments[1].value === "fetch"
            ) {
              context.report({ node, messageId: "noFetchSpy" });
            }
          },
        };
      },
    },
    "no-legacy-automation-identifiers": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow retired workflow automation entity identifiers",
        },
        messages: {
          legacyIdentifier:
            'The legacy entity has been renamed to Automation. Rename "{{name}}" to use workflow automation terminology.',
        },
        schema: [],
      },
      create(context) {
        return {
          Identifier(node) {
            const normalizedName = node.name.replaceAll("_", "").toLowerCase();
            const retiredEntityName = ["workflow", "trigger"].join("");
            if (normalizedName.includes(retiredEntityName)) {
              context.report({
                node,
                messageId: "legacyIdentifier",
                data: { name: node.name },
              });
            }
          },
        };
      },
    },
    "no-re-export": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow forwarding exports from another module",
        },
        messages: {
          noReExport:
            "Do not re-export from another module. Import from the defining module instead.",
        },
        schema: [],
      },
      create(context) {
        return {
          ExportAllDeclaration(node) {
            context.report({ node, messageId: "noReExport" });
          },
          ExportNamedDeclaration(node) {
            if (node.source) {
              context.report({ node, messageId: "noReExport" });
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
      okou: okouPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
      "arrow-body-style": ["error", "always"],
      complexity: ["error", { max: 20 }],
      "okou/no-msw-bypass": "error",
      "okou/no-re-export": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "okou/no-legacy-automation-identifiers": "error",
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
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      "okou/no-fetch-spy": "error",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", ".turbo/**", "coverage/**"],
  },
];
