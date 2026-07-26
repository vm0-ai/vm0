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
  type Expression as TypeScriptExpression,
  type Node,
  type Signature,
  type Symbol as TypeScriptSymbol,
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

const RELATIONAL_QUERY_METHODS = new Set(["findFirst", "findMany"]);

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
      emptyFragment:
        "Use Drizzle sql.empty() for this intentionally empty SQL fragment.",
      queryBuilder:
        "Use a Drizzle select builder for this complete schema-backed query.",
      typedApi: "Use Drizzle {{helper}}(...) for this equivalent SQL-tag leaf.",
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
    const reportedStructuralFindings = new WeakMap<
      TSESTree.Node,
      Set<string>
    >();
    const resolvedCallSignatureCache = new WeakMap<
      TSESTree.CallExpression,
      Signature | null
    >();
    const sqlSourceComposer = createSqlSourceComposer(
      context.sourceCode,
      checker,
      services,
      isSafeSqlTerminalUse,
    );
    const sqlCapabilityChecks: SqlCapabilityChecks = {
      hasDirectResultMapping: hasDirectMapWith,
      hasParameterListOrigin,
      isInlineParameterList: isInlineParameterListSqlJoin,
    };

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
            messageId: "queryBuilder",
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
      },
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
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
      },
    };
  },
});
