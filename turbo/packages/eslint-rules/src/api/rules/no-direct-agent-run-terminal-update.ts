import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import {
  importReference,
  memberName,
  propertyName,
  resolveLocalExpression,
} from "../syntax.ts";
import { createRule } from "../utils.ts";

const ACTIVE_RUN_STATUSES = new Set(["queued", "pending", "running"]);
const AGENT_RUN_SCHEMA_MODULE = "@okouai/db/schema/agent-run";

function stringLiteralValue(node: TSESTree.Property["value"]): string | null {
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
    return node.value;
  }
  if (
    node.type === AST_NODE_TYPES.TSAsExpression ||
    node.type === AST_NODE_TYPES.TSNonNullExpression ||
    node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
    node.type === AST_NODE_TYPES.TSTypeAssertion
  ) {
    return stringLiteralValue(node.expression);
  }
  return null;
}

function updatesAgentRuns(
  sourceCode: Parameters<typeof resolveLocalExpression>[0],
  expression: TSESTree.Expression,
): boolean {
  const update = resolveLocalExpression(sourceCode, expression);
  if (
    update.type !== AST_NODE_TYPES.CallExpression ||
    update.callee.type !== AST_NODE_TYPES.MemberExpression ||
    memberName(update.callee) !== "update"
  ) {
    return false;
  }
  const table = update.arguments[0];
  if (!table || table.type === AST_NODE_TYPES.SpreadElement) {
    return false;
  }
  const resolvedTable = resolveLocalExpression(sourceCode, table);
  if (resolvedTable.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }
  const imported = importReference(sourceCode, resolvedTable);
  return (
    imported?.source === AGENT_RUN_SCHEMA_MODULE &&
    imported.importedName === "agentRuns"
  );
}

function unsafeAgentRunUpdateValues(
  sourceCode: Parameters<typeof resolveLocalExpression>[0],
  expression: TSESTree.Expression,
  visited: ReadonlySet<TSESTree.Node> = new Set(),
): TSESTree.Node | null {
  const values = resolveLocalExpression(sourceCode, expression);
  if (visited.has(values)) {
    return values;
  }
  if (values.type === AST_NODE_TYPES.ConditionalExpression) {
    const nextVisited = new Set(visited).add(values);
    return (
      unsafeAgentRunUpdateValues(sourceCode, values.consequent, nextVisited) ??
      unsafeAgentRunUpdateValues(sourceCode, values.alternate, nextVisited)
    );
  }
  if (values.type !== AST_NODE_TYPES.ObjectExpression) {
    return values;
  }
  const nextVisited = new Set(visited).add(values);
  for (const entry of values.properties) {
    if (entry.type === AST_NODE_TYPES.SpreadElement) {
      const nested = unsafeAgentRunUpdateValues(
        sourceCode,
        entry.argument,
        nextVisited,
      );
      if (nested) {
        return nested;
      }
      continue;
    }
    if (entry.type !== AST_NODE_TYPES.Property) {
      return entry;
    }
    const name = propertyName(entry);
    if (name === null) {
      return entry;
    }
    if (name !== "status") {
      continue;
    }
    const value = stringLiteralValue(entry.value);
    if (value === null || !ACTIVE_RUN_STATUSES.has(value)) {
      return entry;
    }
  }
  return null;
}

export const noDirectAgentRunTerminalUpdate = createRule({
  name: "no-direct-agent-run-terminal-update",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require terminal Agent run transitions to use the lifecycle boundary",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      directTerminalUpdate:
        "Use transitionAgentRunsToTerminal() so the terminal status and attached lifecycle cleanup commit together.",
    },
  },
  create(context) {
    return {
      CallExpression(node): void {
        if (
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          memberName(node.callee) !== "set" ||
          !updatesAgentRuns(context.sourceCode, node.callee.object)
        ) {
          return;
        }
        const values = node.arguments[0];
        if (!values) {
          return;
        }
        if (values.type === AST_NODE_TYPES.SpreadElement) {
          context.report({
            node: values,
            messageId: "directTerminalUpdate",
          });
          return;
        }
        const unsafeValues = unsafeAgentRunUpdateValues(
          context.sourceCode,
          values,
        );
        if (unsafeValues) {
          context.report({
            node: unsafeValues,
            messageId: "directTerminalUpdate",
          });
        }
      },
    };
  },
});
