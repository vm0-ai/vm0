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

    function isDrizzleSqlTypeImport(identifier: TSESTree.Identifier): boolean {
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
        definition.node.type !== AST_NODE_TYPES.ImportSpecifier
      ) {
        return false;
      }
      const importedName =
        definition.node.imported.type === AST_NODE_TYPES.Identifier
          ? definition.node.imported.name
          : definition.node.imported.value;
      return importedName === "SQL" || importedName === "SQLWrapper";
    }

    function isDrizzleNamespaceImport(
      identifier: TSESTree.Identifier,
    ): boolean {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(identifier),
        identifier,
      );
      return (
        variable?.defs.some((candidate) => {
          return (
            candidate.type === "ImportBinding" &&
            candidate.parent.type === AST_NODE_TYPES.ImportDeclaration &&
            candidate.parent.source.value === "drizzle-orm" &&
            candidate.node.type === AST_NODE_TYPES.ImportNamespaceSpecifier
          );
        }) === true
      );
    }

    function isDrizzleNamespaceType(
      typeName: TSESTree.TSQualifiedName,
    ): boolean {
      return (
        typeName.left.type === AST_NODE_TYPES.Identifier &&
        isDrizzleNamespaceImport(typeName.left) &&
        (typeName.right.name === "SQL" || typeName.right.name === "SQLWrapper")
      );
    }

    function localTypeAlias(
      identifier: TSESTree.Identifier,
    ): TSESTree.TypeNode | null {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(identifier),
        identifier,
      );
      const definition = variable?.defs.find((candidate) => {
        return (
          candidate.type === "Type" &&
          candidate.node.type === AST_NODE_TYPES.TSTypeAliasDeclaration
        );
      });
      return definition?.node.type === AST_NODE_TYPES.TSTypeAliasDeclaration
        ? definition.node.typeAnnotation
        : null;
    }

    function isDrizzleSqlType(
      typeNode: TSESTree.TypeNode,
      seen: ReadonlySet<TSESTree.Node>,
    ): boolean {
      if (seen.has(typeNode)) {
        return false;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(typeNode);

      if (typeNode.type === AST_NODE_TYPES.TSTypeReference) {
        if (typeNode.typeName.type === AST_NODE_TYPES.TSQualifiedName) {
          return isDrizzleNamespaceType(typeNode.typeName);
        }
        if (typeNode.typeName.type !== AST_NODE_TYPES.Identifier) {
          return false;
        }
        if (isDrizzleSqlTypeImport(typeNode.typeName)) {
          return true;
        }
        const alias = localTypeAlias(typeNode.typeName);
        return alias !== null && isDrizzleSqlType(alias, nextSeen);
      }
      if (
        typeNode.type === AST_NODE_TYPES.TSUnionType ||
        typeNode.type === AST_NODE_TYPES.TSIntersectionType
      ) {
        return typeNode.types.some((member) => {
          return isDrizzleSqlType(member, nextSeen);
        });
      }
      return false;
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

    function variableDeclaredType(
      identifier: TSESTree.Identifier,
    ): TSESTree.TypeNode | null {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(identifier),
        identifier,
      );
      for (const declaration of variable?.identifiers ?? []) {
        const annotation = declaration.typeAnnotation?.typeAnnotation;
        if (annotation) {
          return annotation;
        }
      }
      return null;
    }

    type LocalFunction =
      | TSESTree.FunctionDeclaration
      | TSESTree.FunctionExpression
      | TSESTree.ArrowFunctionExpression;

    function localFunction(
      identifier: TSESTree.Identifier,
    ): LocalFunction | null {
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
      return functionNode ?? variableFunction;
    }

    function localFunctionResult(
      identifier: TSESTree.Identifier,
    ): TSESTree.Expression | null {
      const body = localFunction(identifier)?.body;
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

    function localFunctionDeclaredResult(
      identifier: TSESTree.Identifier,
    ): TSESTree.TypeNode | null {
      return localFunction(identifier)?.returnType?.typeAnnotation ?? null;
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
        expression.type === AST_NODE_TYPES.TSTypeAssertion
      ) {
        return (
          isDrizzleSqlType(expression.typeAnnotation, nextSeen) ||
          isDrizzleQueryExpression(expression.expression, nextSeen)
        );
      }
      if (
        expression.type === AST_NODE_TYPES.TSNonNullExpression ||
        expression.type === AST_NODE_TYPES.ChainExpression
      ) {
        return isDrizzleQueryExpression(expression.expression, nextSeen);
      }
      if (expression.type === AST_NODE_TYPES.Identifier) {
        const initializer = variableInitializer(expression);
        if (
          initializer !== null &&
          isDrizzleQueryExpression(initializer, nextSeen)
        ) {
          return true;
        }
        const declaredType = variableDeclaredType(expression);
        return (
          declaredType !== null && isDrizzleSqlType(declaredType, nextSeen)
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
        if (returned !== null && isDrizzleQueryExpression(returned, nextSeen)) {
          return true;
        }
        const declaredResult = localFunctionDeclaredResult(expression.callee);
        return (
          declaredResult !== null && isDrizzleSqlType(declaredResult, nextSeen)
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
