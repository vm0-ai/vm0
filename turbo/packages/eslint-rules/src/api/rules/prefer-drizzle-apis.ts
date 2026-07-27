import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  canHaveModifiers,
  getModifiers,
  isAsExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isSatisfiesExpression,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isTypeAssertionExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  NodeFlags,
  SyntaxKind,
  TypeFlags,
  type Expression as TypeScriptExpression,
  type Node,
  type Signature,
  type Symbol as TypeScriptSymbol,
  type Type,
  type VariableDeclaration,
} from "typescript";

import {
  isDrizzleDeclaration,
  isDrizzleSqlTag,
  isDrizzleSymbol,
  isNamedDrizzleSignature,
  resolvedSymbol,
} from "../drizzle.ts";
import { createExecuteRawRowsMatcher } from "../execute-raw-rows.ts";
import {
  analyzeSql,
  type SqlAnalysis,
  type SqlAnalysisContext,
  type SqlCapabilityChecks,
} from "../sql-analysis/sql-analysis.ts";
import { createSqlSourceComposer } from "../sql-analysis/sql-source.ts";
import { createRule } from "../utils.ts";

const PREDICATE_HELPERS = new Set([
  "and",
  "arrayContained",
  "arrayContains",
  "arrayOverlaps",
  "between",
  "eq",
  "exists",
  "gt",
  "gte",
  "ilike",
  "inArray",
  "isNotNull",
  "isNull",
  "like",
  "lt",
  "lte",
  "ne",
  "not",
  "notBetween",
  "notExists",
  "notIlike",
  "notInArray",
  "notLike",
  "or",
]);

const SELECTION_HELPERS = new Set([
  "asc",
  "avg",
  "avgDistinct",
  "count",
  "countDistinct",
  "desc",
  "max",
  "min",
  "sum",
  "sumDistinct",
]);

const SELECTION_OBJECT_METHODS = new Set([
  "returning",
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "set",
  "values",
]);

const STRUCTURED_RESULT_ARGUMENT = new Map<string, number>([
  ["returning", 0],
  ["select", 0],
  ["selectDistinct", 0],
  ["selectDistinctOn", 1],
]);

const RELATIONAL_QUERY_METHODS = new Set(["findFirst", "findMany"]);

const WRITE_BUILDER_DATABASE_PROPERTIES = [
  "$with",
  "delete",
  "execute",
  "insert",
  "select",
  "update",
  "with",
] as const;

export const preferDrizzleApis = createRule({
  name: "prefer-drizzle-apis",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Prefer schema-aware Drizzle APIs for exactly equivalent SQL constructions",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      crossJoin:
        "Use Drizzle crossJoin(...) for this equivalent inner join on true.",
      crossJoinLateral:
        "Use Drizzle crossJoinLateral(...) for this equivalent lateral join.",
      composedCteQueryBuilder:
        "Use Drizzle $with(...), select(), joins, grouping, ordering, and set-operation builders for this complete locally composed read query.",
      deleteQueryBuilder:
        "Use Drizzle delete(...).where(...) for this complete schema-backed delete query.",
      emptyFragment:
        "Use Drizzle sql.empty() for this intentionally empty SQL fragment.",
      existsQueryBuilder:
        "Use a Drizzle select builder and row existence check for this complete schema-backed EXISTS query.",
      lockingQueryBuilder:
        "Use a Drizzle select builder with .for(...) for this complete locking query.",
      lockingCteUpdateQueryBuilder:
        "Use Drizzle $with(...), a locking select builder, and update(...).from(...) for this complete locking update query.",
      queryBuilder:
        "Use a Drizzle select builder for this complete schema-backed query.",
      scalarCteQueryBuilder:
        "Use Drizzle $with(...), select(), and joins for this complete scalar CTE projection.",
      structuredScalarQuery:
        "Use a Drizzle query builder or joined relation instead of a complete raw scalar query in a structured result field.",
      typedApi: "Use Drizzle {{helper}}(...) for this equivalent SQL-tag leaf.",
      unnestUpdateQueryBuilder:
        "Use Drizzle update(...).set(...).from(...).where(...) for this complete unnest-backed update query.",
      upsertQueryBuilder:
        "Use Drizzle insert(...).values(...).onConflictDoUpdate(...) for this complete schema-backed upsert.",
      existencePredicate:
        "Use Drizzle {{helper}}(...) with a select builder for this equivalent existence predicate.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const executeRawRowsMatcher = createExecuteRawRowsMatcher(
      context.sourceCode.ast,
      checker,
      services,
    );
    const structuralCallInspections: Array<() => void> = [];
    const structuredScalarCandidates =
      new Set<TSESTree.TaggedTemplateExpression>();
    const structuredSelectionCalls: TSESTree.CallExpression[] = [];
    const reportedStructuralFindings = new WeakMap<
      TSESTree.Node,
      Set<string>
    >();
    const resolvedCallSignatureCache = new WeakMap<
      TSESTree.CallExpression,
      Signature | null
    >();
    const structuredResultPropertyCache: Record<
      "execute" | "from",
      Map<Type, boolean>
    > = {
      execute: new Map<Type, boolean>(),
      from: new Map<Type, boolean>(),
    };
    const sqlSourceComposer = createSqlSourceComposer(
      context.sourceCode,
      checker,
      services,
      isSafeSqlTerminalUse,
    );
    const sqlCapabilityChecks: SqlCapabilityChecks = {
      acceptsOptionalSql,
      allowsWriteQueryBuilder,
      hasDirectResultMapping: hasDirectMapWith,
      hasParameterListOrigin,
      isInlineParameterList: isInlineParameterListSqlJoin,
    };

    function allowsWriteQueryBuilder(node: TSESTree.Expression): boolean {
      const use = outerTransparentNode(node);
      const parent = use.parent;
      return (
        parent?.type === AST_NODE_TYPES.CallExpression &&
        parent.arguments.length === 1 &&
        parent.arguments[0] === use &&
        isDirectDrizzleDatabaseExecuteCall(parent)
      );
    }

    function acceptsOptionalSql(node: TSESTree.Expression): boolean {
      if (isRelationalWhereCallbackResult(node)) {
        return true;
      }
      const parent = node.parent;
      if (
        parent.type === AST_NODE_TYPES.TemplateLiteral &&
        parent.expressions.includes(node) &&
        parent.parent.type === AST_NODE_TYPES.TaggedTemplateExpression &&
        parent.parent.quasi === parent
      ) {
        return isDrizzleSqlTag(checker, services, parent.parent.tag);
      }
      if (
        parent.type !== AST_NODE_TYPES.CallExpression ||
        !parent.arguments.includes(node)
      ) {
        return false;
      }
      if (
        isNamedDrizzleCall(parent, "and") ||
        isNamedDrizzleCall(parent, "or")
      ) {
        return true;
      }
      const predicateIndex = predicateArgumentIndex(parent);
      const method =
        parent.callee.type === AST_NODE_TYPES.MemberExpression
          ? memberName(parent.callee)
          : undefined;
      return (
        method !== undefined &&
        predicateIndex !== undefined &&
        parent.arguments[predicateIndex] === node &&
        isDrizzleMethodCall(parent, method)
      );
    }

    function isRelationalWhereCallbackResult(
      node: TSESTree.Expression,
    ): boolean {
      const parent = node.parent;
      const callback =
        (parent.type === AST_NODE_TYPES.ArrowFunctionExpression ||
          parent.type === AST_NODE_TYPES.FunctionExpression) &&
        parent.body === node
          ? parent
          : parent.type === AST_NODE_TYPES.ReturnStatement &&
              parent.argument === node &&
              parent.parent.type === AST_NODE_TYPES.BlockStatement &&
              parent.parent.body.length === 1 &&
              (parent.parent.parent.type ===
                AST_NODE_TYPES.ArrowFunctionExpression ||
                parent.parent.parent.type ===
                  AST_NODE_TYPES.FunctionExpression) &&
              parent.parent.parent.body === parent.parent
            ? parent.parent.parent
            : undefined;
      if (callback === undefined) {
        return false;
      }
      const property = callback.parent;
      return (
        property.type === AST_NODE_TYPES.Property &&
        property.value === callback &&
        staticPropertyName(property) === "where"
      );
    }

    function isExecuteRawRowsCallee(node: TSESTree.Expression): boolean {
      return executeRawRowsMatcher(node);
    }

    function reportTypedApi(node: TSESTree.Node, helper: string): void {
      context.report({
        node,
        messageId: "typedApi",
        data: { helper },
      });
    }

    function reportStructuralAnalysis(analysis: SqlAnalysis): void {
      for (const finding of analysis.findings) {
        const key =
          finding.kind === "query-builder"
            ? finding.kind
            : finding.kind === "empty-fragment"
              ? finding.kind
              : `${finding.kind}:${finding.helper}`;
        const reported = reportedStructuralFindings.get(finding.node);
        if (reported?.has(key) === true) {
          continue;
        }
        if (reported === undefined) {
          reportedStructuralFindings.set(finding.node, new Set([key]));
        } else {
          reported.add(key);
        }
        if (finding.kind === "query-builder") {
          context.report({
            node: finding.node,
            messageId:
              finding.capability === "composed-cte"
                ? "composedCteQueryBuilder"
                : finding.capability === "delete"
                  ? "deleteQueryBuilder"
                  : finding.capability === "exists"
                    ? "existsQueryBuilder"
                    : finding.capability === "locking"
                      ? "lockingQueryBuilder"
                      : finding.capability === "locking-cte-update"
                        ? "lockingCteUpdateQueryBuilder"
                        : finding.capability === "scalar-cte"
                          ? "scalarCteQueryBuilder"
                          : finding.capability === "structured-scalar"
                            ? "structuredScalarQuery"
                            : finding.capability === "unnest-update"
                              ? "unnestUpdateQueryBuilder"
                              : finding.capability === "upsert"
                                ? "upsertQueryBuilder"
                                : "queryBuilder",
          });
        } else if (finding.kind === "empty-fragment") {
          context.report({
            node: finding.node,
            messageId: "emptyFragment",
          });
        } else if (finding.kind === "existence-predicate") {
          context.report({
            node: finding.node,
            messageId: "existencePredicate",
            data: { helper: finding.helper },
          });
        } else {
          reportTypedApi(finding.node, finding.helper);
        }
      }
    }

    function memberName(node: TSESTree.MemberExpression): string | undefined {
      if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
        return node.property.name;
      }
      return node.computed &&
        node.property.type === AST_NODE_TYPES.Literal &&
        typeof node.property.value === "string"
        ? node.property.value
        : undefined;
    }

    function isNamedDrizzleCall(
      node: TSESTree.CallExpression,
      name: string,
    ): boolean {
      const signature = resolvedCallSignature(node);
      return (
        signature !== undefined && isNamedDrizzleSignature(signature, name)
      );
    }

    function resolvedCallSignature(
      node: TSESTree.CallExpression,
    ): Signature | undefined {
      const cached = resolvedCallSignatureCache.get(node);
      if (cached !== undefined) {
        return cached ?? undefined;
      }
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const signature = checker.getResolvedSignature(tsNode);
      resolvedCallSignatureCache.set(node, signature ?? null);
      return signature;
    }

    function isDrizzleMethodCall(
      node: TSESTree.CallExpression,
      name: string,
    ): boolean {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        memberName(node.callee) !== name
      ) {
        return false;
      }
      const declaration = resolvedCallSignature(node)?.declaration;
      return declaration !== undefined && isDrizzleDeclaration(declaration);
    }

    function typeHasDirectDrizzleProperty(
      type: Type,
      property: string,
    ): boolean {
      if (type.isUnion()) {
        return type.types.every((member) => {
          return typeHasDirectDrizzleProperty(member, property);
        });
      }
      if ((type.flags & TypeFlags.TypeParameter) !== 0) {
        const constraint = checker.getBaseConstraintOfType(type);
        return (
          constraint !== undefined &&
          typeHasDirectDrizzleProperty(constraint, property)
        );
      }
      const symbol = resolvedSymbol(
        checker,
        checker.getPropertyOfType(type, property),
      );
      return (
        symbol?.declarations !== undefined &&
        symbol.declarations.length > 0 &&
        symbol.declarations.every(isDrizzleDeclaration)
      );
    }

    function isDirectDrizzleDatabaseType(type: Type): boolean {
      if (type.isUnion()) {
        return type.types.every(isDirectDrizzleDatabaseType);
      }
      if (type.isIntersection()) {
        return type.types.some(isDirectDrizzleDatabaseType);
      }
      if ((type.flags & TypeFlags.TypeParameter) !== 0) {
        const constraint = checker.getBaseConstraintOfType(type);
        return (
          constraint !== undefined && isDirectDrizzleDatabaseType(constraint)
        );
      }
      const symbol = resolvedSymbol(checker, type.getSymbol());
      return (
        symbol?.declarations !== undefined &&
        symbol.declarations.length > 0 &&
        symbol.declarations.every(isDrizzleDeclaration)
      );
    }

    function hasUnassertedDatabaseReceiverOrigin(
      node: Node,
      visited: Set<TypeScriptSymbol>,
    ): boolean {
      if (isAsExpression(node) || isTypeAssertionExpression(node)) {
        return false;
      }
      if (
        isNonNullExpression(node) ||
        isParenthesizedExpression(node) ||
        isSatisfiesExpression(node)
      ) {
        return hasUnassertedDatabaseReceiverOrigin(node.expression, visited);
      }
      if (isPropertyAccessExpression(node)) {
        return hasUnassertedDatabaseReceiverOrigin(node.expression, visited);
      }
      if (!isIdentifier(node)) {
        return true;
      }
      const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(node));
      if (
        symbol === undefined ||
        visited.has(symbol) ||
        symbol.declarations === undefined ||
        symbol.declarations.length === 0
      ) {
        return false;
      }
      visited.add(symbol);
      const stable = symbol.declarations.every((declaration) => {
        if (!isVariableDeclaration(declaration)) {
          return true;
        }
        if (declaration.initializer === undefined) {
          return true;
        }
        return (
          isVariableDeclarationList(declaration.parent) &&
          (declaration.parent.flags & NodeFlags.Const) !== 0 &&
          hasUnassertedDatabaseReceiverOrigin(declaration.initializer, visited)
        );
      });
      visited.delete(symbol);
      return stable;
    }

    function isDirectDrizzleDatabaseExecuteCall(
      node: TSESTree.CallExpression,
    ): boolean {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        !isDrizzleMethodCall(node, "execute")
      ) {
        return false;
      }
      const receiver = services.esTreeNodeToTSNodeMap.get(node.callee.object);
      const receiverType = checker.getTypeAtLocation(receiver);
      return (
        hasUnassertedDatabaseReceiverOrigin(receiver, new Set()) &&
        isDirectDrizzleDatabaseType(receiverType) &&
        WRITE_BUILDER_DATABASE_PROPERTIES.every((property) => {
          return typeHasDirectDrizzleProperty(receiverType, property);
        })
      );
    }

    function methodReturnsDrizzleProperty(
      type: Type,
      property: "execute" | "from",
    ): boolean {
      const cache = structuredResultPropertyCache[property];
      const cached = cache.get(type);
      if (cached !== undefined) {
        return cached;
      }
      const result = type.isUnion()
        ? type.types.every((member) => {
            return methodReturnsDrizzleProperty(member, property);
          })
        : type.getCallSignatures().length > 0 &&
          type.getCallSignatures().every((signature) => {
            const returnType = checker.getReturnTypeOfSignature(signature);
            return isDrizzleSymbol(
              checker,
              checker.getPropertyOfType(returnType, property),
            );
          });
      cache.set(type, result);
      return result;
    }

    function isStructuredResultCall(
      node: TSESTree.CallExpression,
      method: string,
    ): boolean {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        !isDrizzleMethodCall(node, method)
      ) {
        return false;
      }
      const type = checker.getTypeAtLocation(
        services.esTreeNodeToTSNodeMap.get(node.callee),
      );
      return methodReturnsDrizzleProperty(
        type,
        method === "returning" ? "execute" : "from",
      );
    }

    function predicateArgumentIndex(
      node: TSESTree.CallExpression,
    ): number | undefined {
      if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
        return undefined;
      }
      const method = memberName(node.callee);
      if (method === "where" || method === "having") {
        return 0;
      }
      return method === "innerJoin" ||
        method === "leftJoin" ||
        method === "rightJoin" ||
        method === "fullJoin" ||
        method === "innerJoinLateral" ||
        method === "leftJoinLateral"
        ? 1
        : undefined;
    }

    function isDrizzleHelperUse(
      call: TSESTree.CallExpression,
      node: TSESTree.Expression,
    ): boolean {
      const name =
        call.callee.type === AST_NODE_TYPES.Identifier
          ? call.callee.name
          : call.callee.type === AST_NODE_TYPES.MemberExpression
            ? memberName(call.callee)
            : undefined;
      return (
        name !== undefined &&
        (PREDICATE_HELPERS.has(name) || SELECTION_HELPERS.has(name)) &&
        call.arguments.includes(node) &&
        isNamedDrizzleCall(call, name)
      );
    }

    function selectionObjectCall(
      node: TSESTree.Expression,
    ): TSESTree.CallExpression | undefined {
      let current: TSESTree.Node = node;
      while (true) {
        const parent: TSESTree.Node = current.parent;
        if (
          parent.type === AST_NODE_TYPES.Property &&
          parent.value === current &&
          parent.parent.type === AST_NODE_TYPES.ObjectExpression
        ) {
          current = parent.parent;
          continue;
        }
        if (
          parent.type === AST_NODE_TYPES.ArrayExpression &&
          parent.elements.includes(current)
        ) {
          current = parent;
          continue;
        }
        if (
          parent.type !== AST_NODE_TYPES.CallExpression ||
          !parent.arguments.includes(current) ||
          parent.callee.type !== AST_NODE_TYPES.MemberExpression
        ) {
          return undefined;
        }
        const method = memberName(parent.callee);
        return method !== undefined &&
          SELECTION_OBJECT_METHODS.has(method) &&
          isDrizzleMethodCall(parent, method)
          ? parent
          : undefined;
      }
    }

    function isDirectDrizzleMethodUse(
      call: TSESTree.CallExpression,
      node: TSESTree.Expression,
    ): boolean {
      if (
        call.callee.type !== AST_NODE_TYPES.MemberExpression ||
        !call.arguments.includes(node)
      ) {
        return false;
      }
      const method = memberName(call.callee);
      if (method === undefined || !isDrizzleMethodCall(call, method)) {
        return false;
      }
      if (
        method === "execute" ||
        method === "from" ||
        method === "groupBy" ||
        method === "orderBy"
      ) {
        return true;
      }
      const predicateIndex = predicateArgumentIndex(call);
      return (
        predicateIndex !== undefined && call.arguments[predicateIndex] === node
      );
    }

    function isSafeSqlTerminalUse(node: TSESTree.Expression): boolean {
      const parent = node.parent;
      if (parent.type === AST_NODE_TYPES.MemberExpression) {
        const method = memberName(parent);
        const call = parent.parent;
        if (
          parent.object === node &&
          (method === "as" || method === "mapWith") &&
          call.type === AST_NODE_TYPES.CallExpression &&
          call.callee === parent &&
          isDrizzleMethodCall(call, method)
        ) {
          return true;
        }
      }
      if (selectionObjectCall(node) !== undefined) {
        return true;
      }
      if (
        parent.type !== AST_NODE_TYPES.CallExpression ||
        parent.arguments.some((argument) => {
          return argument.type === AST_NODE_TYPES.SpreadElement;
        })
      ) {
        return false;
      }
      return (
        (parent.arguments.length === 3 &&
          parent.arguments[1] === node &&
          isExecuteRawRowsCallee(parent.callee)) ||
        isDirectDrizzleMethodUse(parent, node) ||
        isDrizzleHelperUse(parent, node)
      );
    }

    function inspectRawQueryCall(node: TSESTree.CallExpression): void {
      if (
        node.arguments.length !== 3 ||
        node.arguments.some((argument) => {
          return argument.type === AST_NODE_TYPES.SpreadElement;
        })
      ) {
        return;
      }
      const query = node.arguments[1];
      if (
        query === undefined ||
        query.type === AST_NODE_TYPES.SpreadElement ||
        !isExecuteRawRowsCallee(node.callee) ||
        !sqlSourceComposer.couldCompose(query)
      ) {
        return;
      }
      structuralCallInspections.push(() => {
        const analysis = analyzeSql(
          query,
          "statement",
          checker,
          services,
          sqlSourceComposer,
          sqlCapabilityChecks,
        );
        reportStructuralAnalysis(analysis);
      });
    }

    function inspectPredicateCall(node: TSESTree.CallExpression): void {
      if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
        return;
      }
      const method = memberName(node.callee);
      const predicateIndex = predicateArgumentIndex(node);
      if (method === undefined || predicateIndex === undefined) {
        return;
      }
      const predicate = node.arguments[predicateIndex];
      if (
        predicate === undefined ||
        predicate.type === AST_NODE_TYPES.SpreadElement ||
        !sqlSourceComposer.couldCompose(predicate)
      ) {
        return;
      }
      structuralCallInspections.push(() => {
        const analysis = analyzeSql(
          predicate,
          "predicate",
          checker,
          services,
          sqlSourceComposer,
          sqlCapabilityChecks,
        );
        if (
          analysis.findings.length === 0 &&
          !(method === "innerJoin" && analysis.isTruePredicate)
        ) {
          return;
        }
        if (!isDrizzleMethodCall(node, method)) {
          return;
        }
        reportStructuralAnalysis(analysis);
        if (method === "innerJoin" && analysis.isTruePredicate) {
          context.report({ node, messageId: "crossJoin" });
        }
      });
    }

    function contextRoots(node: TSESTree.Node): readonly TSESTree.Expression[] {
      if (node.type === AST_NODE_TYPES.ObjectExpression) {
        return node.properties.flatMap((property) => {
          return property.type === AST_NODE_TYPES.Property &&
            property.kind === "init" &&
            !property.computed
            ? contextRoots(property.value)
            : [];
        });
      }
      if (node.type === AST_NODE_TYPES.ArrayExpression) {
        return node.elements.flatMap((element) => {
          return element === null ||
            element.type === AST_NODE_TYPES.SpreadElement
            ? []
            : contextRoots(element);
        });
      }
      if (
        node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
        node.type === AST_NODE_TYPES.FunctionExpression
      ) {
        if (node.body.type !== AST_NODE_TYPES.BlockStatement) {
          return contextRoots(node.body);
        }
        if (
          node.body.body.length !== 1 ||
          node.body.body[0]?.type !== AST_NODE_TYPES.ReturnStatement ||
          node.body.body[0].argument === null
        ) {
          return [];
        }
        return contextRoots(node.body.body[0].argument);
      }
      if (
        node.type === AST_NODE_TYPES.CallExpression ||
        node.type === AST_NODE_TYPES.ChainExpression ||
        node.type === AST_NODE_TYPES.ConditionalExpression ||
        node.type === AST_NODE_TYPES.Identifier ||
        node.type === AST_NODE_TYPES.TaggedTemplateExpression ||
        node.type === AST_NODE_TYPES.TSAsExpression ||
        node.type === AST_NODE_TYPES.TSNonNullExpression ||
        node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
        node.type === AST_NODE_TYPES.TSTypeAssertion
      ) {
        return sqlSourceComposer.couldCompose(node) ? [node] : [];
      }
      return [];
    }

    function transparentNode(node: TSESTree.Node): TSESTree.Node | undefined {
      if (
        node.type === AST_NODE_TYPES.TSAsExpression ||
        node.type === AST_NODE_TYPES.TSTypeAssertion ||
        node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
        node.type === AST_NODE_TYPES.TSNonNullExpression ||
        node.type === AST_NODE_TYPES.ChainExpression
      ) {
        return node.expression;
      }
      return undefined;
    }

    function variableInScope(
      node: TSESTree.Identifier,
    ): TSESLint.Scope.Variable | undefined {
      let scope: TSESLint.Scope.Scope | null =
        context.sourceCode.getScope(node);
      while (scope !== null) {
        const variable = scope.variables.find((candidate) => {
          return candidate.name === node.name;
        });
        if (variable !== undefined) {
          return variable;
        }
        scope = scope.upper;
      }
      return undefined;
    }

    function outerTransparentNode(node: TSESTree.Node): TSESTree.Node {
      let current = node;
      while (
        current.parent !== undefined &&
        transparentNode(current.parent) === current
      ) {
        current = current.parent;
      }
      return current;
    }

    function structuredResultArgument(node: TSESTree.Node): boolean {
      const use = outerTransparentNode(node);
      const call = use.parent;
      if (
        call === undefined ||
        call.type !== AST_NODE_TYPES.CallExpression ||
        call.callee.type !== AST_NODE_TYPES.MemberExpression
      ) {
        return false;
      }
      const method = memberName(call.callee);
      const argumentIndex =
        method === undefined
          ? undefined
          : STRUCTURED_RESULT_ARGUMENT.get(method);
      return (
        method !== undefined &&
        argumentIndex !== undefined &&
        call.arguments[argumentIndex] === use &&
        isStructuredResultCall(call, method)
      );
    }

    function hasExportModifier(node: Node): boolean {
      return (
        canHaveModifiers(node) &&
        getModifiers(node)?.some((modifier) => {
          return modifier.kind === SyntaxKind.ExportKeyword;
        }) === true
      );
    }

    function localSelectionInitializer(
      node: TSESTree.Node,
    ): TSESTree.Node | undefined {
      if (node.type !== AST_NODE_TYPES.Identifier) {
        return undefined;
      }
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const declaration = resolvedSymbol(
        checker,
        checker.getSymbolAtLocation(tsNode),
      )?.valueDeclaration;
      const variable = variableInScope(node);
      if (
        declaration === undefined ||
        !isVariableDeclaration(declaration) ||
        declaration.getSourceFile() !== tsNode.getSourceFile() ||
        !isConstVariable(declaration) ||
        hasExportModifier(declaration.parent.parent) ||
        declaration.initializer === undefined ||
        variable === undefined ||
        !variable.references.every((reference) => {
          return (
            reference.init === true ||
            (reference.identifier.type === AST_NODE_TYPES.Identifier &&
              (reference.identifier === node ||
                structuredResultArgument(reference.identifier)))
          );
        })
      ) {
        return undefined;
      }
      return services.tsNodeToESTreeNodeMap.get(declaration.initializer);
    }

    function localSelectionReturn(
      node: TSESTree.Node,
    ): TSESTree.Node | undefined {
      if (
        node.type !== AST_NODE_TYPES.CallExpression ||
        node.callee.type !== AST_NODE_TYPES.Identifier ||
        node.arguments.some((argument) => {
          return argument.type === AST_NODE_TYPES.SpreadElement;
        })
      ) {
        return undefined;
      }
      const tsCallee = services.esTreeNodeToTSNodeMap.get(node.callee);
      const declaration = resolvedSymbol(
        checker,
        checker.getSymbolAtLocation(tsCallee),
      )?.valueDeclaration;
      const variable = variableInScope(node.callee);
      if (
        declaration === undefined ||
        !isFunctionDeclaration(declaration) ||
        declaration.getSourceFile() !== tsCallee.getSourceFile() ||
        declaration.body === undefined ||
        declaration.body.statements.length !== 1 ||
        hasExportModifier(declaration) ||
        variable === undefined ||
        !variable.references.every((reference) => {
          if (reference.init === true || reference.identifier === node.callee) {
            return true;
          }
          if (reference.identifier.type !== AST_NODE_TYPES.Identifier) {
            return false;
          }
          const callee = outerTransparentNode(reference.identifier);
          const call = callee.parent;
          return (
            call !== undefined &&
            call.type === AST_NODE_TYPES.CallExpression &&
            call.callee === callee &&
            structuredResultArgument(call)
          );
        })
      ) {
        return undefined;
      }
      const statement = declaration.body.statements[0];
      return statement !== undefined &&
        isReturnStatement(statement) &&
        statement.expression !== undefined
        ? services.tsNodeToESTreeNodeMap.get(statement.expression)
        : undefined;
    }

    function isDrizzleResultWrapper(node: TSESTree.CallExpression): boolean {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        node.arguments.length !== 1 ||
        node.arguments[0]?.type === AST_NODE_TYPES.SpreadElement
      ) {
        return false;
      }
      const method = memberName(node.callee);
      return (
        (method === "as" || method === "mapWith") &&
        isDrizzleMethodCall(node, method)
      );
    }

    function structuredScalarRoots(
      node: TSESTree.Node,
      visited: Set<TSESTree.Node>,
    ): readonly TSESTree.TaggedTemplateExpression[] {
      if (visited.has(node)) {
        return [];
      }
      visited.add(node);
      const transparent = transparentNode(node);
      if (transparent !== undefined) {
        return structuredScalarRoots(transparent, visited);
      }
      if (node.type === AST_NODE_TYPES.ConditionalExpression) {
        return [
          ...structuredScalarRoots(node.consequent, visited),
          ...structuredScalarRoots(node.alternate, visited),
        ];
      }
      const initializer = localSelectionInitializer(node);
      if (initializer !== undefined) {
        return structuredScalarRoots(initializer, visited);
      }
      const returned = localSelectionReturn(node);
      if (returned !== undefined) {
        return structuredScalarRoots(returned, visited);
      }
      if (node.type === AST_NODE_TYPES.ObjectExpression) {
        return node.properties.flatMap((property) => {
          return property.type === AST_NODE_TYPES.SpreadElement
            ? structuredScalarRoots(property.argument, visited)
            : structuredScalarRoots(property.value, visited);
        });
      }
      if (node.type === AST_NODE_TYPES.ArrayExpression) {
        return node.elements.flatMap((element) => {
          return element === null ||
            element.type === AST_NODE_TYPES.SpreadElement
            ? []
            : structuredScalarRoots(element, visited);
        });
      }
      if (
        node.type === AST_NODE_TYPES.CallExpression &&
        node.callee.type === AST_NODE_TYPES.MemberExpression &&
        isDrizzleResultWrapper(node)
      ) {
        return structuredScalarRoots(node.callee.object, visited);
      }
      return node.type === AST_NODE_TYPES.TaggedTemplateExpression &&
        structuredScalarCandidates.has(node)
        ? [node]
        : [];
    }

    function inspectStructuredSelectionCall(
      node: TSESTree.CallExpression,
    ): void {
      if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
        return;
      }
      const method = memberName(node.callee);
      const argumentIndex =
        method === undefined
          ? undefined
          : STRUCTURED_RESULT_ARGUMENT.get(method);
      const fields =
        argumentIndex === undefined ? undefined : node.arguments[argumentIndex];
      if (
        method === undefined ||
        argumentIndex === undefined ||
        fields === undefined ||
        fields.type === AST_NODE_TYPES.SpreadElement
      ) {
        return;
      }
      structuredSelectionCalls.push(node);
    }

    function inspectStructuredSelections(): void {
      if (structuredScalarCandidates.size === 0) {
        return;
      }
      for (const call of structuredSelectionCalls) {
        const method =
          call.callee.type === AST_NODE_TYPES.MemberExpression
            ? memberName(call.callee)
            : undefined;
        const argumentIndex =
          method === undefined
            ? undefined
            : STRUCTURED_RESULT_ARGUMENT.get(method);
        const fields =
          argumentIndex === undefined
            ? undefined
            : call.arguments[argumentIndex];
        if (
          method === undefined ||
          fields === undefined ||
          fields.type === AST_NODE_TYPES.SpreadElement ||
          !isStructuredResultCall(call, method)
        ) {
          continue;
        }
        const roots = structuredScalarRoots(fields, new Set<TSESTree.Node>());
        for (const root of roots) {
          reportAnalysis(root, "structured-selection");
        }
      }
    }

    function reportAnalysis(
      node: TSESTree.Expression,
      analysisContext: SqlAnalysisContext,
    ): SqlAnalysis {
      const analysis = analyzeSql(
        node,
        analysisContext,
        checker,
        services,
        sqlSourceComposer,
        sqlCapabilityChecks,
      );
      reportStructuralAnalysis(analysis);
      return analysis;
    }

    function inspectAdditionalContextCall(node: TSESTree.CallExpression): void {
      const helper =
        node.callee.type === AST_NODE_TYPES.Identifier
          ? node.callee.name
          : node.callee.type === AST_NODE_TYPES.MemberExpression
            ? memberName(node.callee)
            : undefined;
      const helperContext =
        helper === undefined
          ? undefined
          : PREDICATE_HELPERS.has(helper)
            ? "predicate"
            : SELECTION_HELPERS.has(helper)
              ? "selection"
              : undefined;
      if (helper !== undefined && helperContext !== undefined) {
        const roots = node.arguments.flatMap((argument) => {
          return argument.type === AST_NODE_TYPES.SpreadElement
            ? []
            : contextRoots(argument);
        });
        if (roots.length > 0) {
          structuralCallInspections.push(() => {
            const analyses = roots.map((root) => {
              return analyzeSql(
                root,
                helperContext,
                checker,
                services,
                sqlSourceComposer,
                sqlCapabilityChecks,
              );
            });
            if (
              !analyses.some((analysis) => {
                return analysis.findings.length > 0;
              })
            ) {
              return;
            }
            if (!isNamedDrizzleCall(node, helper)) {
              return;
            }
            for (const analysis of analyses) {
              reportStructuralAnalysis(analysis);
            }
          });
        }
      }

      if (node.callee.type === AST_NODE_TYPES.MemberExpression) {
        const member = node.callee;
        const method = memberName(member);
        if (method === undefined) {
          return;
        }
        if (
          (method === "as" || method === "mapWith") &&
          sqlSourceComposer.couldCompose(member.object)
        ) {
          const root = member.object;
          structuralCallInspections.push(() => {
            const analysis = analyzeSql(
              root,
              "selection",
              checker,
              services,
              sqlSourceComposer,
              sqlCapabilityChecks,
            );
            if (analysis.findings.length === 0) {
              return;
            }
            if (isDrizzleMethodCall(node, method)) {
              reportStructuralAnalysis(analysis);
            }
          });
        }

        let analysisContext:
          | "ordering"
          | "relation"
          | "selection"
          | "statement"
          | undefined;
        let argumentsToInspect = node.arguments;
        if (method === "execute") {
          analysisContext = "statement";
        } else if (method === "from") {
          analysisContext = "relation";
          argumentsToInspect = node.arguments.slice(0, 1);
        } else if (method === "orderBy") {
          analysisContext = "ordering";
        } else if (method === "groupBy") {
          analysisContext = "selection";
        } else if (
          method === "innerJoin" ||
          method === "innerJoinLateral" ||
          method === "leftJoin" ||
          method === "leftJoinLateral" ||
          method === "rightJoin" ||
          method === "fullJoin"
        ) {
          analysisContext = "relation";
          argumentsToInspect = node.arguments.slice(0, 1);
        } else if (SELECTION_OBJECT_METHODS.has(method)) {
          analysisContext = "selection";
        }
        if (analysisContext === undefined) {
          return;
        }
        const roots = argumentsToInspect.flatMap((argument) => {
          return argument.type === AST_NODE_TYPES.SpreadElement
            ? []
            : contextRoots(argument);
        });
        if (roots.length === 0) {
          return;
        }
        structuralCallInspections.push(() => {
          const analyses = roots.map((root) => {
            return analyzeSql(
              root,
              analysisContext,
              checker,
              services,
              sqlSourceComposer,
              sqlCapabilityChecks,
            );
          });
          if (
            !analyses.some((analysis) => {
              return analysis.findings.length > 0;
            })
          ) {
            return;
          }
          if (!isDrizzleMethodCall(node, method)) {
            return;
          }
          for (const analysis of analyses) {
            reportStructuralAnalysis(analysis);
          }
        });
        return;
      }
    }

    function staticPropertyName(node: TSESTree.Property): string | undefined {
      if (node.computed) {
        return undefined;
      }
      if (node.key.type === AST_NODE_TYPES.Identifier) {
        return node.key.name;
      }
      return node.key.type === AST_NODE_TYPES.Literal &&
        typeof node.key.value === "string"
        ? node.key.value
        : undefined;
    }

    interface ContextualRoot {
      readonly context: "ordering" | "predicate" | "selection";
      readonly node: TSESTree.Expression;
    }

    function relationalConfigRoots(
      node: TSESTree.ObjectExpression,
    ): readonly ContextualRoot[] {
      return node.properties.flatMap((property) => {
        if (
          property.type !== AST_NODE_TYPES.Property ||
          property.kind !== "init"
        ) {
          return [];
        }
        const name = staticPropertyName(property);
        if (
          name === "with" &&
          property.value.type === AST_NODE_TYPES.ObjectExpression
        ) {
          return property.value.properties.flatMap((relation) => {
            return relation.type === AST_NODE_TYPES.Property &&
              relation.kind === "init" &&
              relation.value.type === AST_NODE_TYPES.ObjectExpression
              ? relationalConfigRoots(relation.value)
              : [];
          });
        }
        const analysisContext =
          name === "where"
            ? "predicate"
            : name === "orderBy"
              ? "ordering"
              : name === "extras"
                ? "selection"
                : undefined;
        return analysisContext === undefined
          ? []
          : contextRoots(property.value).map((root) => {
              return { context: analysisContext, node: root };
            });
      });
    }

    function inspectRelationalQueryCall(node: TSESTree.CallExpression): void {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        node.arguments.length === 0
      ) {
        return;
      }
      const method = memberName(node.callee);
      const config = node.arguments[0];
      if (
        method === undefined ||
        !RELATIONAL_QUERY_METHODS.has(method) ||
        config?.type !== AST_NODE_TYPES.ObjectExpression
      ) {
        return;
      }
      const roots = relationalConfigRoots(config);
      if (roots.length === 0) {
        return;
      }
      structuralCallInspections.push(() => {
        const analyses = roots.map((root) => {
          return analyzeSql(
            root.node,
            root.context,
            checker,
            services,
            sqlSourceComposer,
            sqlCapabilityChecks,
          );
        });
        if (
          !analyses.some((analysis) => {
            return analysis.findings.length > 0;
          })
        ) {
          return;
        }
        if (!isDrizzleMethodCall(node, method)) {
          return;
        }
        for (const analysis of analyses) {
          reportStructuralAnalysis(analysis);
        }
      });
    }

    function inspectLateralJoin(node: TSESTree.CallExpression): void {
      if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
        return;
      }
      const method = memberName(node.callee);
      if (
        (method !== "innerJoinLateral" && method !== "leftJoinLateral") ||
        node.arguments.length !== 2
      ) {
        return;
      }
      const relation = node.arguments[0];
      const condition = node.arguments[1];
      if (
        relation === undefined ||
        relation.type === AST_NODE_TYPES.SpreadElement ||
        condition === undefined ||
        condition.type === AST_NODE_TYPES.SpreadElement ||
        !sqlSourceComposer.couldCompose(condition)
      ) {
        return;
      }
      structuralCallInspections.push(() => {
        const analysis = analyzeSql(
          condition,
          "predicate",
          checker,
          services,
          sqlSourceComposer,
          sqlCapabilityChecks,
        );
        if (analysis.findings.length === 0 && !analysis.isTruePredicate) {
          return;
        }
        if (!isDrizzleMethodCall(node, method)) {
          return;
        }
        reportStructuralAnalysis(analysis);
        if (
          !analysis.isTruePredicate ||
          (method === "leftJoinLateral" &&
            !leftLateralIsNullRejected(node, relation))
        ) {
          return;
        }
        context.report({ node, messageId: "crossJoinLateral" });
      });
    }

    function expressionSymbol(
      node: TSESTree.Expression,
    ): TypeScriptSymbol | undefined {
      if (node.type !== AST_NODE_TYPES.Identifier) {
        return undefined;
      }
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return resolvedSymbol(checker, checker.getSymbolAtLocation(tsNode));
    }

    function isRelationField(
      node: TSESTree.Expression,
      relationSymbol: TypeScriptSymbol | undefined,
    ): boolean {
      return (
        relationSymbol !== undefined &&
        node.type === AST_NODE_TYPES.MemberExpression &&
        node.object.type === AST_NODE_TYPES.Identifier &&
        expressionSymbol(node.object) === relationSymbol
      );
    }

    function nullRejectsRelation(
      node: TSESTree.Expression,
      relationSymbol: TypeScriptSymbol | undefined,
    ): boolean {
      if (node.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      if (isNamedDrizzleCall(node, "isNotNull")) {
        const argument = node.arguments[0];
        return (
          node.arguments.length === 1 &&
          argument !== undefined &&
          argument.type !== AST_NODE_TYPES.SpreadElement &&
          isRelationField(argument, relationSymbol)
        );
      }
      if (!isNamedDrizzleCall(node, "and")) {
        return false;
      }
      return node.arguments.some((argument) => {
        return (
          argument.type !== AST_NODE_TYPES.SpreadElement &&
          nullRejectsRelation(argument, relationSymbol)
        );
      });
    }

    function leftLateralIsNullRejected(
      node: TSESTree.CallExpression,
      relation: TSESTree.Expression,
    ): boolean {
      const relationSymbol = expressionSymbol(relation);
      if (relationSymbol === undefined) {
        return false;
      }
      const whereMember = node.parent;
      if (
        whereMember.type !== AST_NODE_TYPES.MemberExpression ||
        whereMember.object !== node ||
        memberName(whereMember) !== "where"
      ) {
        return false;
      }
      const whereCall = whereMember.parent;
      if (
        whereCall.type !== AST_NODE_TYPES.CallExpression ||
        whereCall.callee !== whereMember ||
        whereCall.arguments.length !== 1
      ) {
        return false;
      }
      const predicate = whereCall.arguments[0];
      return (
        predicate !== undefined &&
        predicate.type !== AST_NODE_TYPES.SpreadElement &&
        nullRejectsRelation(predicate, relationSymbol)
      );
    }

    function hasDirectMapWith(
      node: TSESTree.TaggedTemplateExpression,
    ): boolean {
      const member = node.parent;
      if (
        member.type !== AST_NODE_TYPES.MemberExpression ||
        member.object !== node
      ) {
        return false;
      }
      const call = member.parent;
      return (
        call.type === AST_NODE_TYPES.CallExpression &&
        call.callee === member &&
        isDrizzleMethodCall(call, "mapWith") &&
        call.arguments.length === 1 &&
        call.arguments[0]?.type !== AST_NODE_TYPES.SpreadElement
      );
    }

    function isConstVariable(declaration: VariableDeclaration): boolean {
      return (
        isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & NodeFlags.Const) !== 0
      );
    }

    function isDrizzleSqlTagNode(node: TypeScriptExpression): boolean {
      const symbolLocation = isPropertyAccessExpression(node)
        ? node.name
        : node;
      const symbol = resolvedSymbol(
        checker,
        checker.getSymbolAtLocation(symbolLocation),
      );
      if (symbol?.getName() === "sql" && isDrizzleSymbol(checker, symbol)) {
        return true;
      }
      return checker
        .getTypeAtLocation(node)
        .getCallSignatures()
        .some((signature) => {
          return isNamedDrizzleSignature(signature, "sql");
        });
    }

    function returnedExpression(
      node: TypeScriptExpression,
    ): TypeScriptExpression | undefined {
      if (!isArrowFunction(node) && !isFunctionExpression(node)) {
        return undefined;
      }
      if (!isBlock(node.body)) {
        return node.body;
      }
      if (node.body.statements.length !== 1) {
        return undefined;
      }
      const statement = node.body.statements[0];
      return statement !== undefined &&
        isReturnStatement(statement) &&
        statement.expression !== undefined
        ? statement.expression
        : undefined;
    }

    function isParameterSqlTemplate(
      node: TypeScriptExpression,
      parameter: Node,
    ): boolean {
      if (
        !isTaggedTemplateExpression(node) ||
        !isDrizzleSqlTagNode(node.tag) ||
        !isTemplateExpression(node.template) ||
        node.template.head.text !== "" ||
        node.template.templateSpans.length !== 1
      ) {
        return false;
      }
      const span = node.template.templateSpans[0];
      if (
        span?.literal.text !== "" ||
        !isIdentifier(span.expression) ||
        !isIdentifier(parameter)
      ) {
        return false;
      }
      return (
        resolvedSymbol(
          checker,
          checker.getSymbolAtLocation(span.expression),
        ) === resolvedSymbol(checker, checker.getSymbolAtLocation(parameter))
      );
    }

    function isParameterFragmentMap(node: TypeScriptExpression): boolean {
      if (
        !isCallExpression(node) ||
        !isPropertyAccessExpression(node.expression) ||
        node.expression.name.text !== "map" ||
        node.arguments.length !== 1
      ) {
        return false;
      }
      const collectionType = checker.getTypeAtLocation(
        node.expression.expression,
      );
      if (
        !checker.isArrayType(collectionType) &&
        !checker.isTupleType(collectionType)
      ) {
        return false;
      }
      const callback = node.arguments[0];
      if (callback === undefined || isSpreadElement(callback)) {
        return false;
      }
      const expression = returnedExpression(callback);
      const parameter =
        (isArrowFunction(callback) || isFunctionExpression(callback)) &&
        callback.parameters.length === 1
          ? callback.parameters[0]?.name
          : undefined;
      return (
        expression !== undefined &&
        parameter !== undefined &&
        isParameterSqlTemplate(expression, parameter)
      );
    }

    function isCommaSqlTemplate(node: TypeScriptExpression): boolean {
      return (
        isTaggedTemplateExpression(node) &&
        isDrizzleSqlTagNode(node.tag) &&
        isNoSubstitutionTemplateLiteral(node.template) &&
        node.template.text.trim() === ","
      );
    }

    function isParameterListSqlJoin(node: TypeScriptExpression): boolean {
      if (
        !isCallExpression(node) ||
        !isPropertyAccessExpression(node.expression) ||
        node.expression.name.text !== "join" ||
        !isDrizzleSqlTagNode(node.expression.expression) ||
        node.arguments.length !== 2
      ) {
        return false;
      }
      const values = node.arguments[0];
      const separator = node.arguments[1];
      return (
        values !== undefined &&
        separator !== undefined &&
        !isSpreadElement(values) &&
        !isSpreadElement(separator) &&
        isParameterFragmentMap(values) &&
        isCommaSqlTemplate(separator)
      );
    }

    function parameterListOrigin(
      node: TypeScriptExpression,
      visited: Set<Node>,
    ): boolean {
      if (visited.has(node)) {
        return false;
      }
      visited.add(node);
      if (isParameterListSqlJoin(node)) {
        return true;
      }

      if (isIdentifier(node)) {
        const declaration = resolvedSymbol(
          checker,
          checker.getSymbolAtLocation(node),
        )?.valueDeclaration;
        return (
          declaration !== undefined &&
          isVariableDeclaration(declaration) &&
          declaration.getSourceFile() === node.getSourceFile() &&
          isConstVariable(declaration) &&
          declaration.initializer !== undefined &&
          parameterListOrigin(declaration.initializer, visited)
        );
      }

      if (
        !isCallExpression(node) ||
        node.arguments.length !== 0 ||
        !isIdentifier(node.expression)
      ) {
        return false;
      }
      const declaration = resolvedSymbol(
        checker,
        checker.getSymbolAtLocation(node.expression),
      )?.valueDeclaration;
      if (
        declaration === undefined ||
        !isFunctionDeclaration(declaration) ||
        declaration.getSourceFile() !== node.getSourceFile() ||
        declaration.parameters.length !== 0 ||
        declaration.body === undefined ||
        declaration.body.statements.length !== 1
      ) {
        return false;
      }
      const statement = declaration.body.statements[0];
      return (
        statement !== undefined &&
        isReturnStatement(statement) &&
        statement.expression !== undefined &&
        parameterListOrigin(statement.expression, visited)
      );
    }

    function hasParameterListOrigin(node: TSESTree.Expression): boolean {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return (
        isExpression(tsNode) && parameterListOrigin(tsNode, new Set<Node>())
      );
    }

    function isInlineParameterListSqlJoin(node: TSESTree.Expression): boolean {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return isExpression(tsNode) && isParameterListSqlJoin(tsNode);
    }

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        inspectRawQueryCall(node);
        inspectPredicateCall(node);
        inspectAdditionalContextCall(node);
        inspectLateralJoin(node);
        inspectRelationalQueryCall(node);
        inspectStructuredSelectionCall(node);
      },
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
        const literalSource = node.quasi.quasis
          .map((quasi) => {
            return quasi.value.cooked ?? quasi.value.raw;
          })
          .join(" ");
        if (
          /^\s*\(\s*SELECT\b/iu.test(literalSource) &&
          /\bFROM\b/iu.test(literalSource) &&
          /\bWHERE\b/iu.test(literalSource) &&
          /\bLIMIT\s+1\s*\)\s*$/iu.test(literalSource)
        ) {
          structuredScalarCandidates.add(node);
        }
        const firstQuasi = node.quasi.quasis[0];
        const isExactEmpty =
          node.quasi.expressions.length === 0 &&
          node.quasi.quasis.length === 1 &&
          firstQuasi !== undefined &&
          (firstQuasi.value.cooked ?? firstQuasi.value.raw) === "";
        if (!isExactEmpty) {
          return;
        }
        structuralCallInspections.push(() => {
          if (!isDrizzleSqlTag(checker, services, node.tag)) {
            return;
          }
          reportAnalysis(node, "predicate");
        });
      },
      "Program:exit"(): void {
        for (const inspect of structuralCallInspections) {
          inspect();
        }
        inspectStructuredSelections();
      },
    };
  },
});
