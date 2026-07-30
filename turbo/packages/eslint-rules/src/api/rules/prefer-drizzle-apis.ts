import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  isArrowFunction,
  isBlock,
  isCallExpression,
  isExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isReturnStatement,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  NodeFlags,
  TypeFlags,
  type Expression as TypeScriptExpression,
  type Node,
  type Signature,
  type Symbol as TypeScriptSymbol,
  type Type,
  type VariableDeclaration,
} from "typescript";

import {
  getDrizzleColumnMetadata,
  isDrizzleDeclaration,
  isDrizzlePgCoreDeclaration,
  isDrizzleSqlTag,
  isDrizzleSqlType,
  isDrizzleSymbol,
  isNamedDrizzleSignature,
  resolvedSymbol,
} from "../drizzle.ts";
import { createExecuteRawRowsMatcher } from "../execute-raw-rows.ts";
import {
  analyzeSql,
  analyzeSqlSource,
  sqlTagMightContainHelper,
  type SqlAnalysis,
  type SqlAnalysisContext,
  type SqlCapabilityChecks,
  type SqlAnalysisFinding,
} from "../sql-analysis/sql-analysis.ts";
import {
  createSqlSourceComposer,
  type SqlSource,
} from "../sql-analysis/sql-source.ts";
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

// This lint models the conventional, type-correct Drizzle patterns used in this
// repository. It assumes bindings remain unchanged after creation and uses the
// project's default identifier casing. Unusual TypeScript or runtime
// metaprogramming is out of scope; dynamic SQL from ordinary code is still
// analyzed conservatively.
export const preferDrizzleApis = createRule({
  name: "prefer-drizzle-apis",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Prefer schema-aware Drizzle APIs for exactly equivalent SQL in conventional type-correct Drizzle code",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      crossJoin:
        "Use Drizzle crossJoin(...) for this equivalent inner join on true.",
      crossJoinLateral:
        "Use Drizzle crossJoinLateral(...) for this equivalent lateral join.",
      directColumn:
        "Select the Drizzle column directly instead of using an identity SQL wrapper.",
      composedCteQueryBuilder:
        "Use Drizzle $with(...), select(), joins, grouping, ordering, and set-operation builders for this complete read CTE query.",
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
      unstableGrouping:
        "Group by a reusable expression or real input field instead of a repeated expression, positional ordinal, or computed output alias.",
      structuredScalarQuery:
        "Use a Drizzle select builder for this complete raw scalar query.",
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
    const sourceLocalCandidates: TSESTree.TaggedTemplateExpression[] = [];
    const deferredSourceLocalCandidates: TSESTree.TaggedTemplateExpression[] =
      [];
    const structuralCallInspections: Array<() => void> = [];
    const structuredScalarCandidates =
      new Set<TSESTree.TaggedTemplateExpression>();
    const directColumnCandidates = new Set<TSESTree.TaggedTemplateExpression>();
    const structuredSelectionCalls: TSESTree.CallExpression[] = [];
    const reportedDirectColumnSelections = new WeakSet<TSESTree.Node>();
    const reportedStructuralFindings = new WeakMap<
      TSESTree.Node,
      Set<string>
    >();
    const coveredSourceFindings = new Set<string>();
    const reportedSourceLocalFindings = new Set<string>();
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
    );
    const sqlCapabilityChecks: SqlCapabilityChecks = {
      acceptsOptionalSql,
      allowsWriteQueryBuilder,
      hasDirectResultMapping: hasDirectMapWith,
      hasParameterListOrigin,
      isInlineParameterList: isInlineParameterListSqlJoin,
    };

    function allowsWriteQueryBuilder(
      node: TSESTree.Expression,
      expandedTemplates: ReadonlySet<TSESTree.TaggedTemplateExpression>,
    ): boolean {
      const use = outerTransparentNode(node);
      const parent = use.parent;
      return (
        [...expandedTemplates].every((template) => {
          return isDrizzleSqlTag(checker, services, template.tag);
        }) &&
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
      if (hasExplicitOptionalSqlReturnContract(node)) {
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

    function isOptionalDrizzleSqlType(type: Type, location: Node): boolean {
      const members = type.isUnion() ? type.types : [type];
      let hasOptional = false;
      let hasSql = false;
      for (const member of members) {
        if ((member.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0) {
          hasOptional = true;
          continue;
        }
        if (
          (member.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0 ||
          !isDrizzleSqlType(checker, member, location)
        ) {
          return false;
        }
        hasSql = true;
      }
      return hasOptional && hasSql;
    }

    function hasExplicitOptionalSqlReturnContract(
      node: TSESTree.Expression,
    ): boolean {
      const result = outerTransparentNode(node);
      const returnStatement = result.parent;
      if (
        returnStatement?.type !== AST_NODE_TYPES.ReturnStatement ||
        returnStatement.argument !== result ||
        returnStatement.parent.type !== AST_NODE_TYPES.BlockStatement
      ) {
        return false;
      }
      const declaration = returnStatement.parent.parent;
      if (
        declaration.type !== AST_NODE_TYPES.FunctionDeclaration ||
        declaration.body !== returnStatement.parent
      ) {
        return false;
      }
      const tsDeclaration = services.esTreeNodeToTSNodeMap.get(declaration);
      if (
        !isFunctionDeclaration(tsDeclaration) ||
        tsDeclaration.type === undefined
      ) {
        return false;
      }
      const signature = checker.getSignatureFromDeclaration(tsDeclaration);
      return (
        signature !== undefined &&
        isOptionalDrizzleSqlType(
          checker.getReturnTypeOfSignature(signature),
          tsDeclaration,
        )
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

    function reportStructuralFindings(
      findings: readonly SqlAnalysisFinding[],
      sourceLocal = false,
    ): void {
      for (const finding of findings) {
        if (finding.kind === "query-builder") {
          for (const sourceKey of finding.coveredSourceKeys ?? []) {
            coveredSourceFindings.add(sourceKey);
          }
        }
        const sourceKey =
          finding.kind === "helper" || finding.kind === "existence-predicate"
            ? `${finding.kind}:${finding.helper}:${finding.sourceKey}`
            : finding.kind === "query-builder" &&
                finding.sourceKey !== undefined
              ? `${finding.kind}:${finding.capability}:${finding.sourceKey}`
              : undefined;
        if (sourceKey !== undefined) {
          if (sourceLocal && coveredSourceFindings.has(sourceKey)) {
            continue;
          }
          if (sourceLocal) {
            reportedSourceLocalFindings.add(sourceKey);
          } else if (reportedSourceLocalFindings.has(sourceKey)) {
            continue;
          }
        }
        const key =
          finding.kind === "query-builder"
            ? `${finding.kind}:${finding.capability}:${finding.sourceKey ?? ""}`
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

    function reportStructuralAnalysis(analysis: SqlAnalysis): void {
      reportStructuralFindings(analysis.findings);
    }

    function memberName(node: TSESTree.MemberExpression): string | undefined {
      return !node.computed && node.property.type === AST_NODE_TYPES.Identifier
        ? node.property.name
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
      const update = resolvedSymbol(
        checker,
        checker.getPropertyOfType(receiverType, "update"),
      );
      return (
        isDrizzleSymbol(checker, receiverType.getSymbol()) &&
        update?.declarations?.some(isDrizzlePgCoreDeclaration) === true
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
        predicate.type === AST_NODE_TYPES.SpreadElement
      ) {
        return;
      }
      const roots = contextRoots(predicate);
      if (roots.length === 0) {
        return;
      }
      structuralCallInspections.push(() => {
        const analyses = roots.map((root) => {
          return analyzeSql(
            root,
            root === predicate ? "predicate" : "optional-predicate",
            checker,
            services,
            sqlSourceComposer,
            sqlCapabilityChecks,
          );
        });
        const isTrueJoinPredicate =
          roots.length === 1 &&
          roots[0] === predicate &&
          analyses[0]?.isTruePredicate === true;
        if (
          !analyses.some((analysis) => {
            return analysis.findings.length > 0;
          }) &&
          !(method === "innerJoin" && isTrueJoinPredicate)
        ) {
          return;
        }
        if (!isDrizzleMethodCall(node, method)) {
          return;
        }
        for (const analysis of analyses) {
          reportStructuralAnalysis(analysis);
        }
        if (method === "innerJoin" && isTrueJoinPredicate) {
          context.report({ node, messageId: "crossJoin" });
        }
      });
    }

    function inspectSqlJoinCall(node: TSESTree.CallExpression): void {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        memberName(node.callee) !== "join" ||
        !acceptsOptionalSql(node) ||
        !sqlSourceComposer.couldCompose(node)
      ) {
        return;
      }
      structuralCallInspections.push(() => {
        reportAnalysis(node, "predicate");
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
          return element === null
            ? []
            : element.type === AST_NODE_TYPES.SpreadElement
              ? contextRoots(element.argument)
              : contextRoots(element);
        });
      }
      if (node.type === AST_NODE_TYPES.ConditionalExpression) {
        return [
          ...contextRoots(node.consequent),
          ...contextRoots(node.alternate),
        ];
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

    function transparentNode(
      node: TSESTree.Node,
    ): TSESTree.Expression | undefined {
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
      if (
        declaration === undefined ||
        !isVariableDeclaration(declaration) ||
        declaration.getSourceFile() !== tsNode.getSourceFile() ||
        !isConstVariable(declaration) ||
        declaration.initializer === undefined
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
      if (
        declaration === undefined ||
        !isFunctionDeclaration(declaration) ||
        declaration.getSourceFile() !== tsCallee.getSourceFile() ||
        declaration.body === undefined ||
        declaration.body.statements.length !== 1
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

    function structuredFieldRoots(
      node: TSESTree.Node,
      visited: Set<TSESTree.Node>,
    ): readonly TSESTree.Expression[] {
      if (visited.has(node)) {
        return [];
      }
      visited.add(node);
      const transparent = transparentNode(node);
      if (transparent !== undefined) {
        return structuredFieldRoots(transparent, visited);
      }
      if (node.type === AST_NODE_TYPES.ObjectExpression) {
        return node.properties.flatMap((property) => {
          return property.type === AST_NODE_TYPES.SpreadElement
            ? structuredFieldRoots(property.argument, visited)
            : structuredFieldRoots(property.value, visited);
        });
      }
      if (node.type === AST_NODE_TYPES.ArrayExpression) {
        return node.elements.flatMap((element) => {
          return element === null
            ? []
            : element.type === AST_NODE_TYPES.SpreadElement
              ? structuredFieldRoots(element.argument, visited)
              : structuredFieldRoots(element, visited);
        });
      }
      const initializer = localSelectionInitializer(node);
      if (
        initializer?.type === AST_NODE_TYPES.ObjectExpression ||
        initializer?.type === AST_NODE_TYPES.ArrayExpression
      ) {
        return structuredFieldRoots(initializer, visited);
      }
      const returned = localSelectionReturn(node);
      if (
        returned?.type === AST_NODE_TYPES.ObjectExpression ||
        returned?.type === AST_NODE_TYPES.ArrayExpression
      ) {
        return structuredFieldRoots(returned, visited);
      }
      return isSqlCompositionExpression(node) ? [node] : [];
    }

    function isSqlCompositionExpression(
      node: TSESTree.Node,
    ): node is TSESTree.Expression {
      return (
        node.type === AST_NODE_TYPES.CallExpression ||
        node.type === AST_NODE_TYPES.ChainExpression ||
        node.type === AST_NODE_TYPES.ConditionalExpression ||
        node.type === AST_NODE_TYPES.Identifier ||
        node.type === AST_NODE_TYPES.TaggedTemplateExpression ||
        node.type === AST_NODE_TYPES.TSAsExpression ||
        node.type === AST_NODE_TYPES.TSNonNullExpression ||
        node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
        node.type === AST_NODE_TYPES.TSTypeAssertion
      );
    }

    function composeDirectColumnSource(
      node: TSESTree.Expression,
    ): SqlSource | null {
      return sqlSourceComposer.couldCompose(node)
        ? sqlSourceComposer.compose(node)
        : null;
    }

    function columnMetadata(node: TSESTree.Expression) {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return getDrizzleColumnMetadata(
        checker,
        checker.getTypeAtLocation(tsNode),
        tsNode,
      );
    }

    // Identity-wrapper linting intentionally recognizes only normal stable
    // identifier/property access. Calls, computed access, and other unusual
    // metaprogramming stay opaque even when their static type resembles a
    // Drizzle column.
    function isConventionalColumnExpression(
      node: TSESTree.Expression,
    ): boolean {
      if (node.type === AST_NODE_TYPES.Identifier) {
        return true;
      }
      return (
        node.type === AST_NODE_TYPES.MemberExpression &&
        !node.computed &&
        !node.optional &&
        node.property.type === AST_NODE_TYPES.Identifier &&
        (node.object.type === AST_NODE_TYPES.Identifier ||
          (node.object.type === AST_NODE_TYPES.MemberExpression &&
            isConventionalColumnExpression(node.object)))
      );
    }

    function isSameColumnExpression(
      left: TSESTree.Expression,
      right: TSESTree.Expression,
    ): boolean {
      const leftMetadata = columnMetadata(left);
      const rightMetadata = columnMetadata(right);
      return (
        isConventionalColumnExpression(left) &&
        isConventionalColumnExpression(right) &&
        leftMetadata !== undefined &&
        rightMetadata !== undefined &&
        leftMetadata.databaseName === rightMetadata.databaseName &&
        leftMetadata.tableName === rightMetadata.tableName &&
        context.sourceCode.getText(left) === context.sourceCode.getText(right)
      );
    }

    function callReceiver(
      node: TSESTree.CallExpression,
    ): TSESTree.Expression | undefined {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        node.callee.object.type === AST_NODE_TYPES.Super
      ) {
        return undefined;
      }
      return node.callee.object;
    }

    function directDrizzleCall(
      node: TSESTree.Expression,
      method: string,
    ): TSESTree.CallExpression | undefined {
      return node.type === AST_NODE_TYPES.CallExpression &&
        node.callee.type === AST_NODE_TYPES.MemberExpression &&
        memberName(node.callee) === method &&
        isDrizzleMethodCall(node, method)
        ? node
        : undefined;
    }

    function singleCallArgument(
      node: TSESTree.CallExpression,
    ): TSESTree.Expression | undefined {
      const argument = node.arguments[0];
      return node.arguments.length === 1 &&
        argument !== undefined &&
        argument.type !== AST_NODE_TYPES.SpreadElement
        ? argument
        : undefined;
    }

    interface DirectGroupingQuery {
      readonly selection: TSESTree.ObjectExpression;
    }

    // Grouping lint intentionally follows only the normal direct query shape
    // used in this repository. Query factories, joins, spreads, computed
    // properties, and transformed callback results remain opaque.
    function directGroupingQuery(
      node: TSESTree.CallExpression,
    ): DirectGroupingQuery | undefined {
      let previous = callReceiver(node);
      if (previous === undefined) {
        return undefined;
      }

      if (
        previous.type === AST_NODE_TYPES.CallExpression &&
        previous.callee.type === AST_NODE_TYPES.MemberExpression &&
        memberName(previous.callee) === "where"
      ) {
        const where = directDrizzleCall(previous, "where");
        if (
          where === undefined ||
          singleCallArgument(where) === undefined ||
          callReceiver(where) === undefined
        ) {
          return undefined;
        }
        previous = callReceiver(where);
        if (previous === undefined) {
          return undefined;
        }
      }

      const from = directDrizzleCall(previous, "from");
      const source = from === undefined ? undefined : singleCallArgument(from);
      const beforeFrom = from === undefined ? undefined : callReceiver(from);
      if (source === undefined || beforeFrom === undefined) {
        return undefined;
      }

      const select = directDrizzleCall(beforeFrom, "select");
      const selection =
        select === undefined ? undefined : singleCallArgument(select);
      const database = select === undefined ? undefined : callReceiver(select);
      return selection?.type === AST_NODE_TYPES.ObjectExpression &&
        database?.type === AST_NODE_TYPES.Identifier
        ? { selection }
        : undefined;
    }

    interface DirectSelectionField {
      readonly isComputedSql: boolean;
      readonly propertyName: string;
      readonly sqlTemplate: TSESTree.TaggedTemplateExpression | undefined;
    }

    interface DirectSelectedSql {
      readonly template: TSESTree.TaggedTemplateExpression | undefined;
    }

    function directSelectedSql(
      node: TSESTree.Expression,
    ): DirectSelectedSql | undefined {
      const asCall = directDrizzleCall(node, "as");
      const alias =
        asCall === undefined ? undefined : singleCallArgument(asCall);
      let source = asCall === undefined ? undefined : callReceiver(asCall);
      if (
        alias?.type !== AST_NODE_TYPES.Literal ||
        typeof alias.value !== "string" ||
        alias.value === "" ||
        source === undefined
      ) {
        return undefined;
      }

      const tsSource = services.esTreeNodeToTSNodeMap.get(source);
      if (
        !isDrizzleSqlType(
          checker,
          checker.getTypeAtLocation(tsSource),
          tsSource,
        )
      ) {
        return undefined;
      }

      const mapWith = directDrizzleCall(source, "mapWith");
      if (mapWith !== undefined) {
        if (singleCallArgument(mapWith) === undefined) {
          return undefined;
        }
        source = callReceiver(mapWith);
      }
      return {
        template:
          source?.type === AST_NODE_TYPES.TaggedTemplateExpression &&
          isDrizzleSqlTag(checker, services, source.tag)
            ? source
            : undefined,
      };
    }

    function directSelectionFields(
      node: TSESTree.ObjectExpression,
    ): readonly DirectSelectionField[] | undefined {
      const fields: DirectSelectionField[] = [];
      for (const property of node.properties) {
        if (
          property.type !== AST_NODE_TYPES.Property ||
          property.kind !== "init" ||
          property.computed ||
          property.method ||
          property.key.type !== AST_NODE_TYPES.Identifier
        ) {
          return undefined;
        }

        const selectedSql =
          property.value.type === AST_NODE_TYPES.CallExpression
            ? directSelectedSql(property.value)
            : undefined;
        fields.push({
          isComputedSql: selectedSql !== undefined,
          propertyName: property.key.name,
          sqlTemplate: selectedSql?.template,
        });
      }
      return fields;
    }

    function templateElementText(node: TSESTree.TemplateElement): string {
      return node.value.cooked ?? node.value.raw;
    }

    function selectedGroupingOrdinal(
      node: TSESTree.TaggedTemplateExpression,
    ): number | undefined {
      const quasi = node.quasi.quasis[0];
      if (
        node.quasi.expressions.length !== 0 ||
        node.quasi.quasis.length !== 1 ||
        quasi === undefined
      ) {
        return undefined;
      }
      const text = templateElementText(quasi).trim();
      if (!/^[1-9]\d*$/u.test(text)) {
        return undefined;
      }
      const ordinal = Number(text);
      return Number.isSafeInteger(ordinal) ? ordinal : undefined;
    }

    function directGroupingCallbackFields(
      node: TSESTree.Expression,
    ): readonly string[] | undefined {
      if (
        (node.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
          node.type !== AST_NODE_TYPES.FunctionExpression) ||
        node.params.length !== 1
      ) {
        return undefined;
      }
      const parameter = node.params[0];
      if (parameter?.type !== AST_NODE_TYPES.ObjectPattern) {
        return undefined;
      }

      const selectedFieldByLocalName = new Map<string, string>();
      for (const property of parameter.properties) {
        if (
          property.type !== AST_NODE_TYPES.Property ||
          property.kind !== "init" ||
          property.computed ||
          property.method ||
          property.key.type !== AST_NODE_TYPES.Identifier ||
          property.value.type !== AST_NODE_TYPES.Identifier
        ) {
          return undefined;
        }
        selectedFieldByLocalName.set(property.value.name, property.key.name);
      }

      const result =
        node.body.type === AST_NODE_TYPES.BlockStatement
          ? node.body.body.length === 1 &&
            node.body.body[0]?.type === AST_NODE_TYPES.ReturnStatement
            ? node.body.body[0].argument
            : undefined
          : node.body;
      if (result === undefined || result === null) {
        return undefined;
      }
      const returned =
        result.type === AST_NODE_TYPES.Identifier
          ? [result]
          : result.type === AST_NODE_TYPES.ArrayExpression &&
              result.elements.every((element) => {
                return element?.type === AST_NODE_TYPES.Identifier;
              })
            ? result.elements
            : undefined;
      if (returned === undefined) {
        return undefined;
      }

      const selectedFields = returned.map((identifier) => {
        return identifier === null ||
          identifier.type !== AST_NODE_TYPES.Identifier
          ? undefined
          : selectedFieldByLocalName.get(identifier.name);
      });
      return selectedFields.every(
        (field): field is string => field !== undefined,
      )
        ? selectedFields
        : undefined;
    }

    function isSameDirectSqlTemplate(
      left: TSESTree.TaggedTemplateExpression,
      right: TSESTree.TaggedTemplateExpression,
    ): boolean {
      return (
        left.quasi.expressions.length > 0 &&
        context.sourceCode.getText(left) === context.sourceCode.getText(right)
      );
    }

    function inspectUnstableGroupingCall(node: TSESTree.CallExpression): void {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        memberName(node.callee) !== "groupBy" ||
        node.arguments.length !== 1
      ) {
        return;
      }
      const grouping = node.arguments[0];
      if (
        grouping === undefined ||
        grouping.type === AST_NODE_TYPES.SpreadElement
      ) {
        return;
      }

      structuralCallInspections.push(() => {
        if (!isDrizzleMethodCall(node, "groupBy")) {
          return;
        }
        const query = directGroupingQuery(node);
        const fields =
          query === undefined
            ? undefined
            : directSelectionFields(query.selection);
        if (query === undefined || fields === undefined) {
          return;
        }

        const callbackFields = directGroupingCallbackFields(grouping);
        if (
          callbackFields?.some((propertyName) => {
            return fields.some((field) => {
              return field.propertyName === propertyName && field.isComputedSql;
            });
          }) === true
        ) {
          context.report({ node: grouping, messageId: "unstableGrouping" });
          return;
        }

        if (
          grouping.type !== AST_NODE_TYPES.TaggedTemplateExpression ||
          !isDrizzleSqlTag(checker, services, grouping.tag)
        ) {
          return;
        }
        const ordinal = selectedGroupingOrdinal(grouping);
        const ordinalField =
          ordinal === undefined ? undefined : fields[ordinal - 1];
        const matchingFields =
          ordinal === undefined
            ? fields.filter((field) => {
                return (
                  field.sqlTemplate !== undefined &&
                  isSameDirectSqlTemplate(grouping, field.sqlTemplate)
                );
              })
            : [];
        if (ordinalField === undefined && matchingFields.length !== 1) {
          return;
        }
        context.report({ node: grouping, messageId: "unstableGrouping" });
      });
    }

    function unwrapDirectColumnResult(node: TSESTree.Expression): {
      readonly alias: string | undefined;
      readonly mapWith: TSESTree.Expression | undefined;
      readonly source: TSESTree.Expression;
    } | null {
      let current = node;
      let alias: string | undefined;
      let mapWith: TSESTree.Expression | undefined;
      while (true) {
        const transparent = transparentNode(current);
        if (transparent !== undefined) {
          current = transparent;
          continue;
        }
        if (
          current.type !== AST_NODE_TYPES.CallExpression ||
          current.callee.type !== AST_NODE_TYPES.MemberExpression ||
          !isDrizzleResultWrapper(current)
        ) {
          return { alias, mapWith, source: current };
        }
        const method = memberName(current.callee);
        const argument = current.arguments[0];
        if (
          method === "as" &&
          alias === undefined &&
          argument?.type === AST_NODE_TYPES.Literal &&
          typeof argument.value === "string"
        ) {
          alias = argument.value;
        } else if (
          method === "mapWith" &&
          mapWith === undefined &&
          argument !== undefined &&
          argument.type !== AST_NODE_TYPES.SpreadElement
        ) {
          mapWith = argument;
        } else {
          return null;
        }
        current = current.callee.object;
      }
    }

    function inspectNestedDirectColumn(
      node: TSESTree.TaggedTemplateExpression,
    ): void {
      const template = node.parent;
      const outer =
        template.type === AST_NODE_TYPES.TemplateLiteral
          ? template.parent
          : undefined;
      const expression = node.quasi.expressions[0];
      if (
        outer?.type !== AST_NODE_TYPES.TaggedTemplateExpression ||
        outer.quasi !== template ||
        !template.expressions.includes(node) ||
        expression === undefined ||
        !isDrizzleSqlTag(checker, services, node.tag) ||
        !isDrizzleSqlTag(checker, services, outer.tag) ||
        !isConventionalColumnExpression(expression) ||
        columnMetadata(expression) === undefined ||
        reportedDirectColumnSelections.has(node)
      ) {
        return;
      }
      reportedDirectColumnSelections.add(node);
      context.report({ node, messageId: "directColumn" });
    }

    function inspectDirectColumnSelection(node: TSESTree.Expression): void {
      const result = unwrapDirectColumnResult(node);
      if (result === null) {
        return;
      }
      const source = composeDirectColumnSource(result.source);
      const variant = source?.variants[0];
      if (
        source === null ||
        source.variants.length !== 1 ||
        variant === undefined ||
        ![...source.expandedTemplates].every((template) => {
          return isDrizzleSqlTag(checker, services, template.tag);
        })
      ) {
        return;
      }
      const expressions = variant.chunks.filter((chunk) => {
        return chunk.kind === "expression";
      });
      const expression = expressions[0];
      if (
        expressions.length !== 1 ||
        expression === undefined ||
        expression.depth !== 0 ||
        variant.chunks.some((chunk) => {
          return chunk.kind === "literal" && chunk.text !== "";
        })
      ) {
        return;
      }
      const metadata = columnMetadata(expression.expression);
      // A bare SQL result uses noopDecoder, so selecting the column directly
      // is equivalent only when the wrapper explicitly uses that same column
      // as its result decoder.
      if (
        !isConventionalColumnExpression(expression.expression) ||
        metadata === undefined ||
        (result.alias !== undefined &&
          result.alias !== metadata.databaseName) ||
        result.mapWith === undefined ||
        !isSameColumnExpression(expression.expression, result.mapWith) ||
        reportedDirectColumnSelections.has(node)
      ) {
        return;
      }
      reportedDirectColumnSelections.add(node);
      context.report({ node, messageId: "directColumn" });
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
      if (
        structuredScalarCandidates.size === 0 &&
        directColumnCandidates.size === 0
      ) {
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
        if (directColumnCandidates.size > 0) {
          for (const field of structuredFieldRoots(
            fields,
            new Set<TSESTree.Node>(),
          )) {
            inspectDirectColumnSelection(field);
          }
        }
        if (structuredScalarCandidates.size > 0) {
          const roots = structuredScalarRoots(fields, new Set<TSESTree.Node>());
          for (const root of roots) {
            reportAnalysis(root, "structured-selection");
          }
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
            ? contextRoots(argument.argument)
            : contextRoots(argument);
        });
        if (roots.length > 0) {
          structuralCallInspections.push(() => {
            const analyses = roots.map((root) => {
              return analyzeSql(
                root,
                helper === "and" || helper === "or"
                  ? "optional-predicate"
                  : helperContext,
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
            ? contextRoots(argument.argument)
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
      readonly context:
        | "ordering"
        | "optional-predicate"
        | "predicate"
        | "selection"
        | "write-expression";
      readonly node: TSESTree.Expression;
    }

    function conflictUpdateRoots(
      options: TSESTree.ObjectExpression,
    ): readonly ContextualRoot[] {
      return options.properties.flatMap<ContextualRoot>((property) => {
        if (
          property.type !== AST_NODE_TYPES.Property ||
          property.kind !== "init"
        ) {
          return [];
        }
        const name = staticPropertyName(property);
        if (
          name === "set" &&
          property.value.type === AST_NODE_TYPES.ObjectExpression
        ) {
          return property.value.properties.flatMap<ContextualRoot>((field) => {
            return field.type === AST_NODE_TYPES.Property &&
              field.kind === "init" &&
              !field.computed
              ? contextRoots(field.value).map((root) => {
                  return { context: "write-expression", node: root };
                })
              : [];
          });
        }
        return name === "setWhere" || name === "targetWhere"
          ? contextRoots(property.value).map((root) => {
              return { context: "optional-predicate", node: root };
            })
          : [];
      });
    }

    function inspectConflictUpdateCall(node: TSESTree.CallExpression): void {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        memberName(node.callee) !== "onConflictDoUpdate" ||
        node.arguments.length !== 1
      ) {
        return;
      }
      const options = node.arguments[0];
      if (
        options === undefined ||
        options.type !== AST_NODE_TYPES.ObjectExpression
      ) {
        return;
      }
      const roots = conflictUpdateRoots(options);
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
          }) ||
          !isDrizzleMethodCall(node, "onConflictDoUpdate")
        ) {
          return;
        }
        for (const analysis of analyses) {
          reportStructuralAnalysis(analysis);
        }
      });
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
        inspectSqlJoinCall(node);
        inspectUnstableGroupingCall(node);
        inspectAdditionalContextCall(node);
        inspectConflictUpdateCall(node);
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
        if (
          node.quasi.expressions.length === 1 &&
          node.quasi.quasis.length === 2 &&
          node.quasi.quasis.every((quasi) => {
            return (quasi.value.cooked ?? quasi.value.raw) === "";
          })
        ) {
          directColumnCandidates.add(node);
        }
        const firstQuasi = node.quasi.quasis[0];
        const isExactEmpty =
          node.quasi.expressions.length === 0 &&
          node.quasi.quasis.length === 1 &&
          firstQuasi !== undefined &&
          (firstQuasi.value.cooked ?? firstQuasi.value.raw) === "";
        if (!isExactEmpty) {
          if (sqlTagMightContainHelper(node)) {
            const hasSelect = /\bSELECT\b/iu.test(literalSource);
            const leadingLiteral =
              node.quasi.quasis[0]?.value.cooked ??
              node.quasi.quasis[0]?.value.raw ??
              "";
            const isStatement =
              /^\s*(?:DELETE|INSERT|SELECT|UPDATE|WITH)\b/iu.test(
                leadingLiteral,
              );
            // Conventional scalar fragments are also analyzed at their typed
            // predicate use site. Defer their local leaves so the complete
            // query diagnostic can suppress only the descendants it owns.
            (hasSelect && !isStatement
              ? deferredSourceLocalCandidates
              : sourceLocalCandidates
            ).push(node);
          }
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
        function reportSourceLocal(
          nodes: readonly TSESTree.TaggedTemplateExpression[],
        ): void {
          for (const node of nodes) {
            if (!isDrizzleSqlTag(checker, services, node.tag)) {
              continue;
            }
            reportStructuralFindings(
              analyzeSqlSource(
                node,
                checker,
                services,
                sqlSourceComposer,
                sqlCapabilityChecks,
              ),
              true,
            );
          }
        }

        reportSourceLocal(sourceLocalCandidates);
        for (const inspect of structuralCallInspections) {
          inspect();
        }
        for (const node of directColumnCandidates) {
          inspectNestedDirectColumn(node);
        }
        inspectStructuredSelections();
        reportSourceLocal(deferredSourceLocalCandidates);
      },
    };
  },
});
