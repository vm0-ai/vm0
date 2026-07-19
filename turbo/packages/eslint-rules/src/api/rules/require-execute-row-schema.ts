import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
} from "@typescript-eslint/utils";

import { createRule } from "../utils.ts";

function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (node.computed && node.property.type === AST_NODE_TYPES.Literal) {
    return typeof node.property.value === "string" ? node.property.value : null;
  }
  return null;
}

function onlyDestructuresRowCount(pattern: TSESTree.BindingName): boolean {
  if (
    pattern.type !== AST_NODE_TYPES.ObjectPattern ||
    pattern.properties.length !== 1
  ) {
    return false;
  }
  const [property] = pattern.properties;
  return (
    property?.type === AST_NODE_TYPES.Property &&
    !property.computed &&
    ((property.key.type === AST_NODE_TYPES.Identifier &&
      property.key.name === "rowCount") ||
      (property.key.type === AST_NODE_TYPES.Literal &&
        property.key.value === "rowCount"))
  );
}

interface ExecuteUsage {
  readonly kind: "discarded" | "row-count" | "raw-result";
  readonly assertion: TSESTree.Node | null;
}

function resultAssertion(node: TSESTree.CallExpression): TSESTree.Node | null {
  let current: TSESTree.Node = node;

  while (current.parent) {
    const parent: TSESTree.Node = current.parent;
    if (
      (parent.type === AST_NODE_TYPES.AwaitExpression &&
        parent.argument === current) ||
      (parent.type === AST_NODE_TYPES.ChainExpression &&
        parent.expression === current) ||
      (parent.type === AST_NODE_TYPES.TSNonNullExpression &&
        parent.expression === current)
    ) {
      current = parent;
      continue;
    }
    if (
      (parent.type === AST_NODE_TYPES.TSAsExpression ||
        parent.type === AST_NODE_TYPES.TSTypeAssertion) &&
      parent.expression === current
    ) {
      return parent;
    }
    if (
      parent.type === AST_NODE_TYPES.MemberExpression &&
      parent.object === current
    ) {
      current = parent;
      continue;
    }
    if (
      parent.type === AST_NODE_TYPES.CallExpression &&
      parent.callee === current
    ) {
      current = parent;
      continue;
    }
    break;
  }

  return null;
}

function executeUsage(node: TSESTree.CallExpression): ExecuteUsage {
  let current: TSESTree.Node = node;
  const assertion = resultAssertion(node);

  while (current.parent) {
    const parent: TSESTree.Node = current.parent;
    if (
      (parent.type === AST_NODE_TYPES.AwaitExpression &&
        parent.argument === current) ||
      (parent.type === AST_NODE_TYPES.ChainExpression &&
        parent.expression === current) ||
      (parent.type === AST_NODE_TYPES.TSNonNullExpression &&
        parent.expression === current) ||
      ((parent.type === AST_NODE_TYPES.TSAsExpression ||
        parent.type === AST_NODE_TYPES.TSTypeAssertion) &&
        parent.expression === current)
    ) {
      current = parent;
      continue;
    }
    if (
      parent.type === AST_NODE_TYPES.MemberExpression &&
      parent.object === current
    ) {
      return {
        kind: memberName(parent) === "rowCount" ? "row-count" : "raw-result",
        assertion,
      };
    }
    if (
      parent.type === AST_NODE_TYPES.VariableDeclarator &&
      parent.init === current
    ) {
      return {
        kind: onlyDestructuresRowCount(parent.id) ? "row-count" : "raw-result",
        assertion,
      };
    }
    if (
      parent.type === AST_NODE_TYPES.ExpressionStatement &&
      parent.expression === current
    ) {
      return { kind: "discarded", assertion };
    }
    return { kind: "raw-result", assertion };
  }

  return { kind: "raw-result", assertion };
}

export const requireExecuteRowSchema = createRule({
  name: "require-execute-row-schema",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require runtime schemas for rows returned by Drizzle execute",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      rowTypeArgument:
        "Drizzle execute row generics are compile-only. Remove the type argument and use executeRawRows(...) with a runtime schema.",
      rawResult:
        "Do not consume raw rows from Drizzle execute. Use executeRawRows(...) with a runtime schema; direct execute is only for discarded results or rowCount.",
      assertedResult:
        "A TypeScript assertion does not validate a Drizzle execute result. Decode rows with executeRawRows(...) instead.",
    },
  },
  create(context) {
    function drizzleImportKind(
      identifier: TSESTree.Identifier,
    ): "namespace" | "sql" | null {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(identifier),
        identifier,
      );
      const definition = variable?.defs.find((candidate) => {
        return candidate.type === "ImportBinding";
      });
      if (
        !definition ||
        definition.parent.type !== AST_NODE_TYPES.ImportDeclaration ||
        definition.parent.source.value !== "drizzle-orm" ||
        definition.parent.importKind === "type"
      ) {
        return null;
      }

      const specifier = definition.node;
      if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
        return "namespace";
      }
      if (
        specifier.type !== AST_NODE_TYPES.ImportSpecifier ||
        specifier.importKind === "type"
      ) {
        return null;
      }
      const importedName =
        specifier.imported.type === AST_NODE_TYPES.Identifier
          ? specifier.imported.name
          : specifier.imported.value;
      return importedName === "sql" ? "sql" : null;
    }

    function isDrizzleSqlTag(tag: TSESTree.Expression): boolean {
      if (tag.type === AST_NODE_TYPES.Identifier) {
        return drizzleImportKind(tag) === "sql";
      }
      return (
        tag.type === AST_NODE_TYPES.MemberExpression &&
        tag.object.type === AST_NODE_TYPES.Identifier &&
        drizzleImportKind(tag.object) === "namespace" &&
        memberName(tag) === "sql"
      );
    }

    function isDrizzleSqlObject(expression: TSESTree.Expression): boolean {
      if (expression.type === AST_NODE_TYPES.Identifier) {
        return drizzleImportKind(expression) === "sql";
      }
      return (
        expression.type === AST_NODE_TYPES.MemberExpression &&
        expression.object.type === AST_NODE_TYPES.Identifier &&
        drizzleImportKind(expression.object) === "namespace" &&
        memberName(expression) === "sql"
      );
    }

    function variableInitializer(
      identifier: TSESTree.Identifier,
    ): TSESTree.Expression | null {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(identifier),
        identifier,
      );
      const definition = variable?.defs.find((candidate) => {
        return (
          candidate.type === "Variable" &&
          candidate.node.type === AST_NODE_TYPES.VariableDeclarator
        );
      });
      const initializer =
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator
          ? definition.node.init
          : null;
      return initializer ?? null;
    }

    function localFunctionResult(
      identifier: TSESTree.Identifier,
    ): TSESTree.Expression | null {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(identifier),
        identifier,
      );
      const definition = variable?.defs.find((candidate) => {
        return candidate.type === "FunctionName";
      });
      const functionNode =
        definition?.type === "FunctionName" &&
        (definition.node.type === AST_NODE_TYPES.FunctionDeclaration ||
          definition.node.type === AST_NODE_TYPES.FunctionExpression)
          ? definition.node
          : null;
      const initializer = variableInitializer(identifier);
      const variableFunction =
        initializer?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
        initializer?.type === AST_NODE_TYPES.FunctionExpression
          ? initializer
          : null;
      const body = functionNode?.body ?? variableFunction?.body;
      if (!body) {
        return null;
      }
      if (body.type !== AST_NODE_TYPES.BlockStatement) {
        return body;
      }
      const returns = body.body.filter((statement) => {
        return statement.type === AST_NODE_TYPES.ReturnStatement;
      });
      if (returns.length !== 1) {
        return null;
      }
      return returns[0]?.argument ?? null;
    }

    function isDrizzleQueryExpression(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node>,
    ): boolean {
      if (seen.has(expression)) {
        return false;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(expression);

      if (expression.type === AST_NODE_TYPES.TaggedTemplateExpression) {
        return isDrizzleSqlTag(expression.tag);
      }
      if (
        expression.type === AST_NODE_TYPES.TSAsExpression ||
        expression.type === AST_NODE_TYPES.TSTypeAssertion ||
        expression.type === AST_NODE_TYPES.TSNonNullExpression ||
        expression.type === AST_NODE_TYPES.ChainExpression
      ) {
        return isDrizzleQueryExpression(expression.expression, nextSeen);
      }
      if (expression.type === AST_NODE_TYPES.Identifier) {
        const initializer = variableInitializer(expression);
        return (
          initializer !== null &&
          isDrizzleQueryExpression(initializer, nextSeen)
        );
      }
      if (expression.type === AST_NODE_TYPES.ConditionalExpression) {
        return (
          isDrizzleQueryExpression(expression.consequent, nextSeen) ||
          isDrizzleQueryExpression(expression.alternate, nextSeen)
        );
      }
      if (expression.type === AST_NODE_TYPES.LogicalExpression) {
        return (
          isDrizzleQueryExpression(expression.left, nextSeen) ||
          isDrizzleQueryExpression(expression.right, nextSeen)
        );
      }
      if (expression.type === AST_NODE_TYPES.SequenceExpression) {
        const last = expression.expressions.at(-1);
        return last !== undefined && isDrizzleQueryExpression(last, nextSeen);
      }
      if (
        expression.type === AST_NODE_TYPES.CallExpression &&
        expression.callee.type === AST_NODE_TYPES.Identifier
      ) {
        const returned = localFunctionResult(expression.callee);
        return (
          returned !== null && isDrizzleQueryExpression(returned, nextSeen)
        );
      }
      if (
        expression.type !== AST_NODE_TYPES.CallExpression ||
        expression.callee.type !== AST_NODE_TYPES.MemberExpression
      ) {
        return false;
      }
      const receiver = expression.callee.object;
      if (receiver.type === AST_NODE_TYPES.Super) {
        return false;
      }
      return (
        isDrizzleSqlObject(receiver) ||
        isDrizzleQueryExpression(receiver, nextSeen)
      );
    }

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        if (
          node.callee.type !== AST_NODE_TYPES.MemberExpression ||
          memberName(node.callee) !== "execute"
        ) {
          return;
        }
        const query = node.arguments[0];
        if (
          !query ||
          query.type === AST_NODE_TYPES.SpreadElement ||
          !isDrizzleQueryExpression(query, new Set())
        ) {
          return;
        }

        if (node.typeArguments?.params.length) {
          context.report({ node, messageId: "rowTypeArgument" });
        }

        const usage = executeUsage(node);
        if (usage.assertion) {
          context.report({
            node: usage.assertion,
            messageId: "assertedResult",
          });
        }
        if (usage.kind === "raw-result") {
          context.report({ node, messageId: "rawResult" });
        }
      },
    };
  },
});
