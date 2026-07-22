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
  type Symbol as TypeScriptSymbol,
  type Type,
  type VariableDeclaration,
} from "typescript";

import {
  isDrizzleArrayColumnType,
  isDrizzleColumnType,
  isDrizzleSqlTag,
  isDrizzleSymbol,
  isDrizzleTableType,
  isDrizzleWrapperType,
  isNamedDrizzleSignature,
  resolvedSymbol,
} from "../drizzle.ts";
import { createRule } from "../utils.ts";

const COMPARISON_HELPERS = new Map<string, string>([
  ["=", "eq"],
  ["<>", "ne"],
  [">", "gt"],
  [">=", "gte"],
  ["<", "lt"],
  ["<=", "lte"],
]);

type BooleanToken = "operand" | "and" | "or" | "(" | ")";
type BooleanExpressionKind = "operand" | "and" | "or";
type ExistenceKeyword =
  | "and"
  | "exists"
  | "from"
  | "inner"
  | "join"
  | "limit"
  | "not"
  | "on"
  | "select"
  | "where"
  | "one"
  | "("
  | ")";

interface ExistenceExpressionToken {
  readonly kind: "expression";
  readonly index: number;
}

type ExistenceToken = ExistenceKeyword | ExistenceExpressionToken;

interface ExistenceTemplateMatch {
  readonly helper: "exists" | "notExists";
  readonly tableExpressionIndexes: readonly number[];
  readonly predicateExpressionIndexes: readonly number[];
}

function quasiText(node: TSESTree.TemplateElement): string {
  return node.value.cooked ?? node.value.raw;
}

interface NullPredicateMatch {
  helper: "isNull" | "isNotNull";
  length: number;
}

function nullPredicateMatch(quasi: string): NullPredicateMatch | undefined {
  const match = /^\s*IS\s+(NOT\s+)?NULL\b/i.exec(quasi);
  if (match === null) {
    return undefined;
  }
  return {
    helper: match[1] === undefined ? "isNull" : "isNotNull",
    length: match[0].length,
  };
}

function hasPredicateLeftBoundary(quasi: string): boolean {
  const prefix = quasi.trimEnd();
  return (
    prefix === "" ||
    prefix.endsWith("(") ||
    /\b(?:AND|HAVING|NOT|ON|OR|WHEN|WHERE)$/i.test(prefix)
  );
}

function removeRightOperandPostfix(quasi: string): string | undefined {
  let suffix = quasi;
  while (/^\s*::/.test(suffix)) {
    const cast =
      /^\s*::\s*[a-z_][\w$]*(?:\s*\.\s*[a-z_][\w$]*)?(?:\s*\([^()]*\))?(?:\s*\[\s*\])*/i.exec(
        suffix,
      );
    if (cast === null) {
      return undefined;
    }
    suffix = suffix.slice(cast[0].length);
  }

  const timeZone = /^\s+AT\s+TIME\s+ZONE\s+'(?:''|[^'])*'/i.exec(suffix);
  if (timeZone !== null) {
    suffix = suffix.slice(timeZone[0].length);
  }
  return suffix;
}

function hasPredicateRightBoundary(quasi: string): boolean {
  const withoutPostfix = removeRightOperandPostfix(quasi);
  if (withoutPostfix === undefined) {
    return false;
  }
  const suffix = withoutPostfix.trimStart();
  return (
    suffix === "" ||
    /^[),;]/.test(suffix) ||
    /^(?:AND|ELSE|END|EXCEPT|FETCH|FOR|FULL|GROUP|HAVING|INNER|INTERSECT|LEFT|LIMIT|OFFSET|ON|OR|ORDER|RETURNING|RIGHT|THEN|UNION|WHEN|WHERE)\b/i.test(
      suffix,
    )
  );
}

function hasPatternRightBoundary(quasi: string): boolean {
  const escape = /^\s+ESCAPE\s+'(?:''|[^'])*'/i.exec(quasi);
  return hasPredicateRightBoundary(
    escape === null ? quasi : quasi.slice(escape[0].length),
  );
}

function membershipRightBoundary(quasi: string): boolean {
  const close = /^\s*\)/.exec(quasi);
  return (
    close !== null && hasPredicateRightBoundary(quasi.slice(close[0].length))
  );
}

function hasOrderingLeftBoundary(quasi: string): boolean {
  const prefix = quasi.trimEnd();
  return (
    prefix === "" ||
    prefix.endsWith(",") ||
    prefix.endsWith("(") ||
    /\bORDER\s+BY$/i.test(prefix)
  );
}

interface OrderingMatch {
  helper: "asc" | "desc";
}

function orderingMatch(quasi: string): OrderingMatch | undefined {
  const direction = /^\s+(ASC|DESC)\b/i.exec(quasi);
  if (direction === null) {
    return undefined;
  }
  let length = direction[0].length;
  const nulls = /^\s+NULLS\s+(?:FIRST|LAST)\b/i.exec(quasi.slice(length));
  if (nulls !== null) {
    length += nulls[0].length;
  }
  const suffix = quasi.slice(length).trimStart();
  if (
    suffix !== "" &&
    !/^[,);]/.test(suffix) &&
    !/^(?:FETCH|FOR|LIMIT|OFFSET)\b/i.test(suffix)
  ) {
    return undefined;
  }
  return {
    helper: direction[1]?.toLowerCase() === "asc" ? "asc" : "desc",
  };
}

interface AggregateMatch {
  helper: "count" | "countDistinct" | "max" | "min" | "sum";
  start: number;
}

function aggregateMatch(quasi: string): AggregateMatch | undefined {
  const countDistinct = /\bCOUNT\s*\(\s*DISTINCT\s*$/i.exec(quasi);
  if (countDistinct !== null) {
    return { helper: "countDistinct", start: countDistinct.index };
  }
  const aggregate = /\b(SUM|COUNT|MAX|MIN)\s*\(\s*$/i.exec(quasi);
  if (aggregate === null) {
    return undefined;
  }
  const helper = aggregate[1]?.toLowerCase();
  if (
    helper !== "sum" &&
    helper !== "count" &&
    helper !== "max" &&
    helper !== "min"
  ) {
    return undefined;
  }
  return { helper, start: aggregate.index };
}

function aggregateRemainder(quasi: string): string | undefined {
  const close = /^\s*\)/.exec(quasi);
  return close === null ? undefined : quasi.slice(close[0].length);
}

function tokenizeBooleanQuasi(quasi: string): BooleanToken[] | undefined {
  const tokens: BooleanToken[] = [];
  let offset = 0;
  while (offset < quasi.length) {
    const whitespace = /^\s+/.exec(quasi.slice(offset));
    if (whitespace !== null) {
      offset += whitespace[0].length;
      continue;
    }
    const character = quasi[offset];
    if (character === "(" || character === ")") {
      tokens.push(character);
      offset += 1;
      continue;
    }
    const operator = /^(AND|OR)\b/i.exec(quasi.slice(offset));
    if (operator === null) {
      return undefined;
    }
    tokens.push(operator[1]?.toLowerCase() === "and" ? "and" : "or");
    offset += operator[0].length;
  }
  return tokens;
}

function booleanTokens(quasis: readonly string[]): BooleanToken[] | undefined {
  const tokens: BooleanToken[] = [];
  for (let index = 0; index < quasis.length; index += 1) {
    const quasiTokens = tokenizeBooleanQuasi(quasis[index] ?? "");
    if (quasiTokens === undefined) {
      return undefined;
    }
    tokens.push(...quasiTokens);
    if (index < quasis.length - 1) {
      tokens.push("operand");
    }
  }
  return tokens;
}

function booleanHelper(quasis: readonly string[]): "and" | "or" | undefined {
  const tokens = booleanTokens(quasis);
  if (tokens === undefined) {
    return undefined;
  }
  const parsedTokens = tokens;
  let offset = 0;

  function primary(): BooleanExpressionKind | undefined {
    const token = parsedTokens[offset];
    if (token === "operand") {
      offset += 1;
      return "operand";
    }
    if (token !== "(") {
      return undefined;
    }
    offset += 1;
    const expression = disjunction();
    if (expression === undefined || parsedTokens[offset] !== ")") {
      return undefined;
    }
    offset += 1;
    return expression;
  }

  function conjunction(): BooleanExpressionKind | undefined {
    let expression = primary();
    if (expression === undefined) {
      return undefined;
    }
    while (parsedTokens[offset] === "and") {
      offset += 1;
      if (primary() === undefined) {
        return undefined;
      }
      expression = "and";
    }
    return expression;
  }

  function disjunction(): BooleanExpressionKind | undefined {
    let expression = conjunction();
    if (expression === undefined) {
      return undefined;
    }
    while (parsedTokens[offset] === "or") {
      offset += 1;
      if (conjunction() === undefined) {
        return undefined;
      }
      expression = "or";
    }
    return expression;
  }

  const expression = disjunction();
  return offset === parsedTokens.length && expression !== "operand"
    ? expression
    : undefined;
}

function tokenizeExistenceQuasi(quasi: string): ExistenceKeyword[] | undefined {
  const tokens: ExistenceKeyword[] = [];
  let offset = 0;
  while (offset < quasi.length) {
    const whitespace = /^\s+/.exec(quasi.slice(offset));
    if (whitespace !== null) {
      offset += whitespace[0].length;
      continue;
    }
    const character = quasi[offset];
    if (character === "(" || character === ")") {
      tokens.push(character);
      offset += 1;
      continue;
    }
    const one = /^1\b/.exec(quasi.slice(offset));
    if (one !== null) {
      tokens.push("one");
      offset += one[0].length;
      continue;
    }
    const keyword =
      /^(AND|EXISTS|FROM|INNER|JOIN|LIMIT|NOT|ON|SELECT|WHERE)\b/i.exec(
        quasi.slice(offset),
      );
    if (keyword === null) {
      return undefined;
    }
    const value = keyword[1]?.toLowerCase();
    if (
      value !== "and" &&
      value !== "exists" &&
      value !== "from" &&
      value !== "inner" &&
      value !== "join" &&
      value !== "limit" &&
      value !== "not" &&
      value !== "on" &&
      value !== "select" &&
      value !== "where"
    ) {
      return undefined;
    }
    tokens.push(value);
    offset += keyword[0].length;
  }
  return tokens;
}

function existenceTokens(
  quasis: readonly string[],
): ExistenceToken[] | undefined {
  const tokens: ExistenceToken[] = [];
  for (let index = 0; index < quasis.length; index += 1) {
    const quasiTokens = tokenizeExistenceQuasi(quasis[index] ?? "");
    if (quasiTokens === undefined) {
      return undefined;
    }
    tokens.push(...quasiTokens);
    if (index < quasis.length - 1) {
      tokens.push({ kind: "expression", index });
    }
  }
  return tokens;
}

function existenceTemplateMatch(
  quasis: readonly string[],
): ExistenceTemplateMatch | undefined {
  const tokens = existenceTokens(quasis);
  if (tokens === undefined) {
    return undefined;
  }
  const parsedTokens = tokens;
  let offset = 0;
  const tableExpressionIndexes: number[] = [];
  const predicateExpressionIndexes: number[] = [];

  function consume(keyword: ExistenceKeyword): boolean {
    if (parsedTokens[offset] !== keyword) {
      return false;
    }
    offset += 1;
    return true;
  }

  function consumeExpression(target: number[]): boolean {
    const token = parsedTokens[offset];
    if (typeof token === "string" || token === undefined) {
      return false;
    }
    target.push(token.index);
    offset += 1;
    return true;
  }

  const negated = consume("not");
  if (
    !consume("exists") ||
    !consume("(") ||
    !consume("select") ||
    !consume("one") ||
    !consume("from") ||
    !consumeExpression(tableExpressionIndexes)
  ) {
    return undefined;
  }

  while (consume("inner")) {
    if (
      !consume("join") ||
      !consumeExpression(tableExpressionIndexes) ||
      !consume("on") ||
      !consumeExpression(predicateExpressionIndexes)
    ) {
      return undefined;
    }
  }

  if (!consume("where") || !consumeExpression(predicateExpressionIndexes)) {
    return undefined;
  }
  while (consume("and")) {
    if (!consumeExpression(predicateExpressionIndexes)) {
      return undefined;
    }
  }
  if (consume("limit") && !consume("one")) {
    return undefined;
  }
  if (!consume(")") || offset !== parsedTokens.length) {
    return undefined;
  }

  return {
    helper: negated ? "notExists" : "exists",
    tableExpressionIndexes,
    predicateExpressionIndexes,
  };
}

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
      crossJoinLateral:
        "Use Drizzle crossJoinLateral(...) for this equivalent lateral join.",
      emptyFragment:
        "Use Drizzle sql.empty() for this intentionally empty SQL fragment.",
      typedApi: "Use Drizzle {{helper}}(...) for this equivalent SQL-tag leaf.",
      existencePredicate:
        "Use Drizzle {{helper}}(...) with a select builder for this equivalent existence predicate.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    function expressionType(node: TSESTree.Expression): {
      readonly location: Node;
      readonly type: Type;
    } {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return {
        location: tsNode,
        type: checker.getTypeAtLocation(tsNode),
      };
    }

    function report(node: TSESTree.Node, helper: string): void {
      context.report({
        node,
        messageId: "typedApi",
        data: { helper },
      });
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
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const signature = checker.getResolvedSignature(tsNode);
      return (
        signature !== undefined && isNamedDrizzleSignature(signature, name)
      );
    }

    function isDrizzleMethod(
      node: TSESTree.MemberExpression,
      name: string,
    ): boolean {
      if (memberName(node) !== name) {
        return false;
      }
      const tsProperty = services.esTreeNodeToTSNodeMap.get(node.property);
      return isDrizzleSymbol(checker, checker.getSymbolAtLocation(tsProperty));
    }

    function isTrueSqlTag(node: TSESTree.Expression): boolean {
      if (node.type !== AST_NODE_TYPES.TaggedTemplateExpression) {
        return false;
      }
      const quasi = node.quasi.quasis[0];
      return (
        isDrizzleSqlTag(checker, services, node.tag) &&
        node.quasi.expressions.length === 0 &&
        node.quasi.quasis.length === 1 &&
        quasi !== undefined &&
        quasiText(quasi).trim().toLowerCase() === "true"
      );
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

    function isStringOrDrizzleWrapper(type: Type): boolean {
      if (type.isUnion()) {
        return type.types.every(isStringOrDrizzleWrapper);
      }
      if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
        return false;
      }
      if ((type.flags & TypeFlags.TypeParameter) !== 0) {
        const constraint = checker.getBaseConstraintOfType(type);
        return constraint !== undefined && isStringOrDrizzleWrapper(constraint);
      }
      return (
        (type.flags & TypeFlags.StringLike) !== 0 ||
        isDrizzleWrapperType(checker, type)
      );
    }

    function isOptionalDrizzleContext(type: Type | undefined): boolean {
      if (type === undefined || !type.isUnion()) {
        return false;
      }
      let hasUndefined = false;
      let hasWrapper = false;
      for (const member of type.types) {
        if ((member.flags & TypeFlags.Undefined) !== 0) {
          hasUndefined = true;
        } else if (
          (member.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0 ||
          !isDrizzleWrapperType(checker, member)
        ) {
          return false;
        } else {
          hasWrapper = true;
        }
      }
      return hasUndefined && hasWrapper;
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

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }
        const method = memberName(node.callee);
        if (method !== "innerJoinLateral" && method !== "leftJoinLateral") {
          return;
        }
        if (
          !isDrizzleMethod(node.callee, method) ||
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
          !isTrueSqlTag(condition)
        ) {
          return;
        }
        if (
          method === "leftJoinLateral" &&
          !leftLateralIsNullRejected(node, relation)
        ) {
          return;
        }
        context.report({ node, messageId: "crossJoinLateral" });
      },
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
        if (!isDrizzleSqlTag(checker, services, node.tag)) {
          return;
        }

        const quasis = node.quasi.quasis.map(quasiText);
        const expressions = node.quasi.expressions;
        if (
          expressions.length === 0 &&
          quasis.length === 1 &&
          quasis[0] === ""
        ) {
          context.report({ node, messageId: "emptyFragment" });
          return;
        }
        const existence = existenceTemplateMatch(quasis);
        if (
          existence !== undefined &&
          existence.tableExpressionIndexes.every((index) => {
            const expressionNode = expressions[index];
            if (expressionNode === undefined) {
              return false;
            }
            const expression = expressionType(expressionNode);
            return isDrizzleTableType(
              checker,
              expression.type,
              expression.location,
            );
          }) &&
          existence.predicateExpressionIndexes.every((index) => {
            const expressionNode = expressions[index];
            return (
              expressionNode !== undefined &&
              isDrizzleWrapperType(checker, expressionType(expressionNode).type)
            );
          })
        ) {
          context.report({
            node,
            messageId: "existencePredicate",
            data: { helper: existence.helper },
          });
          return;
        }
        for (let index = 0; index < expressions.length - 1; index += 1) {
          const leftNode = expressions[index];
          const rightNode = expressions[index + 1];
          if (leftNode === undefined || rightNode === undefined) {
            continue;
          }
          const left = expressionType(leftNode);
          const right = expressionType(rightNode);
          const middle = quasis[index + 1] ?? "";
          const suffix = quasis[index + 2] ?? "";
          if (
            hasPredicateLeftBoundary(quasis[index] ?? "") &&
            hasPredicateRightBoundary(suffix)
          ) {
            const comparison = COMPARISON_HELPERS.get(middle.trim());
            if (
              comparison !== undefined &&
              isDrizzleWrapperType(checker, left.type)
            ) {
              report(leftNode, comparison);
            }
          }
          if (
            middle.trim().toUpperCase() === "LIKE" &&
            hasPredicateLeftBoundary(quasis[index] ?? "") &&
            hasPatternRightBoundary(suffix) &&
            isDrizzleWrapperType(checker, left.type) &&
            isStringOrDrizzleWrapper(right.type)
          ) {
            report(leftNode, "like");
          }
          if (
            /^\s+IN\s*\(\s*$/i.test(middle) &&
            hasPredicateLeftBoundary(quasis[index] ?? "") &&
            membershipRightBoundary(suffix) &&
            isDrizzleColumnType(checker, left.type, left.location) &&
            hasParameterListOrigin(rightNode)
          ) {
            report(leftNode, "inArray");
          }
          if (
            middle.trim() === "@>" &&
            hasPredicateLeftBoundary(quasis[index] ?? "") &&
            hasPredicateRightBoundary(suffix) &&
            isDrizzleArrayColumnType(checker, left.type, left.location) &&
            isDrizzleWrapperType(checker, right.type)
          ) {
            report(leftNode, "arrayContains");
          }
        }

        for (let index = 0; index < expressions.length; index += 1) {
          const expressionNode = expressions[index];
          if (expressionNode === undefined) {
            continue;
          }
          const expression = expressionType(expressionNode);
          const prefix = quasis[index] ?? "";
          const suffix = quasis[index + 1] ?? "";

          const nullMatch = nullPredicateMatch(suffix);
          if (
            nullMatch !== undefined &&
            hasPredicateLeftBoundary(prefix) &&
            hasPredicateRightBoundary(suffix.slice(nullMatch.length)) &&
            isDrizzleWrapperType(checker, expression.type)
          ) {
            report(expressionNode, nullMatch.helper);
          }

          const order = orderingMatch(suffix);
          if (
            order !== undefined &&
            hasOrderingLeftBoundary(prefix) &&
            isDrizzleWrapperType(checker, expression.type)
          ) {
            report(expressionNode, order.helper);
          }

          const aggregate = aggregateMatch(prefix);
          const aggregateSuffix = aggregateRemainder(suffix);
          if (
            aggregate === undefined ||
            aggregateSuffix === undefined ||
            /^\s*OVER\b/i.test(aggregateSuffix) ||
            !isDrizzleWrapperType(checker, expression.type)
          ) {
            continue;
          }
          const isWholeAggregate =
            expressions.length === 1 &&
            prefix.slice(0, aggregate.start).trim() === "" &&
            aggregateSuffix.trim() === "";
          if (!isWholeAggregate) {
            if (aggregate.helper !== "min") {
              report(expressionNode, aggregate.helper);
            }
          } else if (
            (aggregate.helper === "max" || aggregate.helper === "min") &&
            isDrizzleColumnType(checker, expression.type, expression.location)
          ) {
            report(node, aggregate.helper);
          }
        }

        const boolean = booleanHelper(quasis);
        if (boolean === undefined) {
          return;
        }
        if (
          !expressions.every((expressionNode) => {
            return isDrizzleWrapperType(
              checker,
              expressionType(expressionNode).type,
            );
          })
        ) {
          return;
        }
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        if (isOptionalDrizzleContext(checker.getContextualType(tsNode))) {
          report(node, boolean);
        }
      },
    };
  },
});
