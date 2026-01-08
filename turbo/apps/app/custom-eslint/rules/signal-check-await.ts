/**
 * ESLint rule: signal-check-await
 *
 * Enforces that commands check AbortSignal after await expressions
 * to properly handle cancellation.
 *
 * Good:
 *   command(async ({ signal }) => {
 *     const data = await fetch(url);
 *     signal.throwIfAborted();
 *     // process data
 *   })
 *
 * Bad:
 *   command(async ({ signal }) => {
 *     const data = await fetch(url);
 *     // missing signal check after await
 *     processData(data);
 *   })
 */

import { ESLintUtils, TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/anthropics/vm0/blob/main/docs/eslint/${name}.md`,
);

type MessageIds = "missingSignalCheck";

export default createRule<[], MessageIds>({
  name: "signal-check-await",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Enforce AbortSignal check after await expressions in commands",
    },
    schema: [],
    messages: {
      missingSignalCheck:
        "Consider checking signal.throwIfAborted() after await to handle cancellation",
    },
  },
  defaultOptions: [],
  create(context) {
    let signalParamName: string | null = null;
    let inCommand = false;

    function isCommandCall(node: TSESTree.CallExpression): boolean {
      const callee = node.callee;
      return callee.type === "Identifier" && callee.name === "command";
    }

    function getSignalParamName(
      node: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
    ): string | null {
      const firstParam = node.params[0];
      if (!firstParam) {
        return null;
      }

      if (firstParam.type === "ObjectPattern") {
        for (const prop of firstParam.properties) {
          if (
            prop.type === "Property" &&
            prop.key.type === "Identifier" &&
            prop.key.name === "signal"
          ) {
            if (prop.value.type === "Identifier") {
              return prop.value.name;
            }
            return "signal";
          }
        }
      }

      return null;
    }

    function isSignalCheck(node: TSESTree.Node): boolean {
      if (!signalParamName) {
        return false;
      }

      if (node.type === "ExpressionStatement") {
        const expr = node.expression;
        if (expr.type === "CallExpression") {
          const callee = expr.callee;
          if (
            callee.type === "MemberExpression" &&
            callee.object.type === "Identifier" &&
            callee.object.name === signalParamName &&
            callee.property.type === "Identifier" &&
            callee.property.name === "throwIfAborted"
          ) {
            return true;
          }
        }
      }

      if (node.type === "IfStatement") {
        const test = node.test;
        if (
          test.type === "MemberExpression" &&
          test.object.type === "Identifier" &&
          test.object.name === signalParamName &&
          test.property.type === "Identifier" &&
          test.property.name === "aborted"
        ) {
          return true;
        }
      }

      return false;
    }

    function checkAwaitInBlock(statements: TSESTree.Statement[]): void {
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];

        let hasAwait = false;
        if (stmt?.type === "ExpressionStatement") {
          hasAwait = stmt.expression.type === "AwaitExpression";
        } else if (stmt?.type === "VariableDeclaration") {
          hasAwait = stmt.declarations.some(
            (d) => d.init?.type === "AwaitExpression",
          );
        }

        if (hasAwait) {
          const nextStmt = statements[i + 1];
          if (nextStmt && !isSignalCheck(nextStmt)) {
            context.report({
              node: stmt,
              messageId: "missingSignalCheck",
            });
          }
        }
      }
    }

    return {
      CallExpression(node) {
        if (isCommandCall(node) && node.arguments[0]) {
          const callback = node.arguments[0];
          if (
            callback.type === "ArrowFunctionExpression" ||
            callback.type === "FunctionExpression"
          ) {
            if (callback.async) {
              inCommand = true;
              signalParamName = getSignalParamName(callback);
            }
          }
        }
      },
      "CallExpression:exit"(node: TSESTree.CallExpression) {
        if (isCommandCall(node)) {
          inCommand = false;
          signalParamName = null;
        }
      },
      BlockStatement(node) {
        if (inCommand && signalParamName) {
          checkAwaitInBlock(node.body);
        }
      },
    };
  },
});
