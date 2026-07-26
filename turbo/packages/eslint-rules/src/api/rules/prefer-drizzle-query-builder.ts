import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
  type TSESLint,
} from "@typescript-eslint/utils";
import {
  canHaveModifiers,
  getModifiers,
  isFunctionDeclaration,
  isReturnStatement,
  isVariableDeclaration,
  isVariableDeclarationList,
  NodeFlags,
  SyntaxKind,
  TypeFlags,
  type Node,
  type Type,
  type VariableDeclaration,
} from "typescript";

import {
  isDrizzleColumnType,
  isDrizzleDeclaration,
  isDrizzleSqlTag,
  isDrizzleSymbol,
  isDrizzleTableType,
  isDrizzleWrapperType,
  isNamedDrizzleSignature,
  resolvedSymbol,
} from "../drizzle.ts";
import { createExecuteRawRowsMatcher } from "../execute-raw-rows.ts";
import {
  SQL_TEMPLATE_EXPRESSION_BOUNDARY,
  sqlCodeMask,
} from "../sql-lexing.ts";
import { analyzeDirectSql } from "../sql-analysis/direct-sql-analysis.ts";
import { createRule } from "../utils.ts";

interface SqlTokenBase {
  readonly end: number;
  readonly start: number;
}

interface ExpressionToken extends SqlTokenBase {
  readonly expressionIndex: number;
  readonly kind: "expression";
}

interface NumberToken extends SqlTokenBase {
  readonly kind: "number";
  readonly value: string;
}

interface PunctuationToken extends SqlTokenBase {
  readonly kind: "punctuation";
  readonly value: "(" | ")" | "," | ";";
}

interface WordToken extends SqlTokenBase {
  readonly kind: "word";
  readonly value: string;
}

type SqlToken = ExpressionToken | NumberToken | PunctuationToken | WordToken;

interface PaginatedJoinedSelectMatch {
  readonly clauseExpressionIndexes: readonly number[];
  readonly joinTableExpressionIndexes: readonly number[];
  readonly limitExpressionIndex: number | undefined;
  readonly selectedExpressionIndexes: readonly number[];
  readonly sourceTableExpressionIndex: number;
}

interface SimpleLockingSelectMatch {
  readonly lockTableExpressionIndex: number | undefined;
  readonly sourceTableExpressionIndex: number | undefined;
}

interface SimpleLockingCteUpdateMatch {
  readonly lockTableExpressionIndex: number;
  readonly orderColumnExpressionIndex: number;
  readonly selectedColumnExpressionIndex: number;
  readonly sourceTableExpressionIndex: number;
  readonly targetTableExpressionIndex: number;
}

interface SimpleDeleteMatch {
  readonly targetTableExpressionIndex: number | undefined;
}

interface SimpleUnnestUpdateMatch {
  readonly targetTableExpressionIndex: number;
}

interface SimpleUpsertMatch {
  readonly targetTableExpressionIndex: number | undefined;
}

interface ScalarCteBodyMatch {
  readonly guaranteedOneRow: boolean;
}

interface TopLevelCallMatch {
  readonly body: string;
  readonly end: number;
}

interface CompleteSqlStatement {
  readonly end: number;
  readonly hasTrailingSemicolon: boolean;
  readonly tokens: readonly SqlToken[];
}

interface ComposedSqlTemplate {
  readonly expandedFactory: boolean;
  readonly expressions: readonly TSESTree.Expression[];
  readonly source: string;
}

interface RelationMatch {
  readonly cursor: number;
  readonly endToken: SqlToken;
}

const RESULT_FIELD_ARGUMENT = new Map<string, number>([
  ["returning", 0],
  ["select", 0],
  ["selectDistinct", 0],
  ["selectDistinctOn", 1],
]);

const UNSUPPORTED_TOP_LEVEL_WHERE_KEYWORDS = new Set([
  "EXCEPT",
  "FETCH",
  "FOR",
  "GROUP",
  "HAVING",
  "INTERSECT",
  "LIMIT",
  "OFFSET",
  "ORDER",
  "QUALIFY",
  "UNION",
  "WINDOW",
]);

const UNSUPPORTED_SCALAR_QUERY_KEYWORDS = new Set([
  ...UNSUPPORTED_TOP_LEVEL_WHERE_KEYWORDS,
  "INTO",
  "OVER",
]);

const UNSUPPORTED_SCALAR_CTE_KEYWORDS = new Set([
  "CROSS",
  "DISTINCT",
  "EXCEPT",
  "FETCH",
  "FOR",
  "FULL",
  "GROUP",
  "HAVING",
  "INNER",
  "INTERSECT",
  "INTO",
  "JOIN",
  "LATERAL",
  "LEFT",
  "OFFSET",
  "ORDER",
  "OUTER",
  "OVER",
  "QUALIFY",
  "RECURSIVE",
  "RIGHT",
  "UNION",
  "USING",
  "WINDOW",
  "WITH",
]);

const UNSUPPORTED_PAGINATED_JOINED_SELECT_KEYWORDS = new Set([
  "CROSS",
  "DISTINCT",
  "EXCEPT",
  "FETCH",
  "FOR",
  "FULL",
  "GROUP",
  "HAVING",
  "INTERSECT",
  "INTO",
  "LATERAL",
  "OFFSET",
  "QUALIFY",
  "RIGHT",
  "UNION",
  "USING",
  "WINDOW",
  "WITH",
]);

const UNSUPPORTED_LOCKING_SELECT_KEYWORDS = new Set([
  "DISTINCT",
  "EXCEPT",
  "FETCH",
  "FULL",
  "GROUP",
  "HAVING",
  "INNER",
  "INTERSECT",
  "INTO",
  "JOIN",
  "LEFT",
  "NOWAIT",
  "OFFSET",
  "OUTER",
  "QUALIFY",
  "RIGHT",
  "UNION",
  "USING",
  "WINDOW",
  "WITH",
]);

const UNSUPPORTED_DELETE_PREDICATE_KEYWORDS = new Set([
  "CURRENT",
  "FETCH",
  "LIMIT",
  "OFFSET",
  "ORDER",
  "RETURNING",
  "USING",
]);

const UNSUPPORTED_UPDATE_PREDICATE_KEYWORDS = new Set([
  "CURRENT",
  "FETCH",
  "LIMIT",
  "ORDER",
  "RETURNING",
]);

const UNSUPPORTED_UPSERT_ASSIGNMENT_KEYWORDS = new Set(["RETURNING", "WHERE"]);

const BUILDER_SELECT_CLAUSE_KEYWORDS = new Set([
  "GROUP",
  "LIMIT",
  "ORDER",
  "WHERE",
]);

const BUILDER_SELECT_JOIN_KEYWORDS = new Set(["INNER", "JOIN", "LEFT"]);

const UNSUPPORTED_BUILDER_SELECT_KEYWORDS = new Set([
  "CROSS",
  "DISTINCT",
  "EXCEPT",
  "FETCH",
  "FOR",
  "FULL",
  "HAVING",
  "INTERSECT",
  "INTO",
  "LATERAL",
  "MERGE",
  "NATURAL",
  "OFFSET",
  "QUALIFY",
  "RETURNING",
  "RIGHT",
  "USING",
  "WINDOW",
]);

const SIMPLE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/u;
const SIMPLE_OR_QUOTED_IDENTIFIER_PATTERN =
  /^(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:""|[^"])+")$/u;

function quasiText(node: TSESTree.TemplateElement): string {
  return node.value.cooked ?? node.value.raw;
}

function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (node.computed && node.property.type === AST_NODE_TYPES.Literal) {
    return typeof node.property.value === "string" ? node.property.value : null;
  }
  return null;
}

function topLevelTokens(source: string): readonly SqlToken[] | undefined {
  const tokens: SqlToken[] = [];
  let depth = 0;
  let expressionIndex = 0;
  let offset = 0;

  while (offset < source.length) {
    const character = source[offset];
    if (character === SQL_TEMPLATE_EXPRESSION_BOUNDARY) {
      if (depth === 0) {
        tokens.push({
          kind: "expression",
          expressionIndex,
          start: offset,
          end: offset + 1,
        });
      }
      expressionIndex += 1;
      offset += 1;
      continue;
    }
    if (character === "(") {
      if (depth === 0) {
        tokens.push({
          kind: "punctuation",
          value: "(",
          start: offset,
          end: offset + 1,
        });
      }
      depth += 1;
      offset += 1;
      continue;
    }
    if (character === ")") {
      if (depth === 0) {
        return undefined;
      }
      depth -= 1;
      if (depth === 0) {
        tokens.push({
          kind: "punctuation",
          value: ")",
          start: offset,
          end: offset + 1,
        });
      }
      offset += 1;
      continue;
    }
    if (depth !== 0 || /\s/.test(character ?? "")) {
      offset += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(character ?? "")) {
      const start = offset;
      offset += 1;
      while (/[A-Za-z0-9_$]/.test(source[offset] ?? "")) {
        offset += 1;
      }
      tokens.push({
        kind: "word",
        value: source.slice(start, offset).toUpperCase(),
        start,
        end: offset,
      });
      continue;
    }
    if (/[0-9]/.test(character ?? "")) {
      const start = offset;
      offset += 1;
      while (/[0-9]/.test(source[offset] ?? "")) {
        offset += 1;
      }
      tokens.push({
        kind: "number",
        value: source.slice(start, offset),
        start,
        end: offset,
      });
      continue;
    }
    if (character === "," || character === ";") {
      tokens.push({
        kind: "punctuation",
        value: character,
        start: offset,
        end: offset + 1,
      });
    }
    offset += 1;
  }

  return depth === 0 ? tokens : undefined;
}

function isWord(token: SqlToken | undefined, value: string): boolean {
  return token?.kind === "word" && token.value === value;
}

function expressionIndex(token: SqlToken | undefined): number | undefined {
  return token?.kind === "expression" ? token.expressionIndex : undefined;
}

function onlyWhitespaceBetween(
  source: string,
  left: SqlToken,
  right: SqlToken,
): boolean {
  return source.slice(left.end, right.start).trim() === "";
}

function isPunctuation(
  token: SqlToken | undefined,
  value: PunctuationToken["value"],
): boolean {
  return token?.kind === "punctuation" && token.value === value;
}

function completeSqlStatement(
  syntaxSource: string,
): CompleteSqlStatement | undefined {
  const tokens = topLevelTokens(syntaxSource);
  if (tokens === undefined || tokens.length === 0) {
    return undefined;
  }

  let end = tokens.length;
  let hasTrailingSemicolon = false;
  let statementEnd = syntaxSource.length;
  const trailingToken = tokens[end - 1];
  if (isPunctuation(trailingToken, ";")) {
    if (
      trailingToken === undefined ||
      syntaxSource.slice(trailingToken.end).trim() !== ""
    ) {
      return undefined;
    }
    hasTrailingSemicolon = true;
    statementEnd = trailingToken.start;
    end -= 1;
  }

  const statementTokens = tokens.slice(0, end);
  const firstToken = statementTokens[0];
  if (
    firstToken === undefined ||
    syntaxSource.slice(0, firstToken.start).trim() !== "" ||
    statementTokens.some((token) => {
      return isPunctuation(token, ";");
    })
  ) {
    return undefined;
  }

  return {
    end: statementEnd,
    hasTrailingSemicolon,
    tokens: statementTokens,
  };
}

function isBuilderSelectBoundary(token: SqlToken | undefined): boolean {
  return (
    token?.kind === "word" &&
    (BUILDER_SELECT_CLAUSE_KEYWORDS.has(token.value) ||
      BUILDER_SELECT_JOIN_KEYWORDS.has(token.value))
  );
}

function builderSelectRelationMatch(
  syntaxSource: string,
  tokens: readonly SqlToken[],
  start: number,
): RelationMatch | undefined {
  const relation = tokens[start];
  if (
    relation === undefined ||
    (relation.kind !== "expression" && relation.kind !== "word")
  ) {
    return undefined;
  }

  let cursor = start + 1;
  let endToken = relation;
  const possibleAsKeyword = tokens[cursor];
  if (isWord(possibleAsKeyword, "AS")) {
    const alias = tokens[cursor + 1];
    if (
      possibleAsKeyword === undefined ||
      alias?.kind !== "word" ||
      !onlyWhitespaceBetween(syntaxSource, endToken, possibleAsKeyword) ||
      !onlyWhitespaceBetween(syntaxSource, possibleAsKeyword, alias)
    ) {
      return undefined;
    }
    cursor += 2;
    endToken = alias;
  } else {
    const possibleAlias = tokens[cursor];
    if (
      possibleAlias?.kind === "word" &&
      !isBuilderSelectBoundary(possibleAlias)
    ) {
      if (!onlyWhitespaceBetween(syntaxSource, endToken, possibleAlias)) {
        return undefined;
      }
      cursor += 1;
      endToken = possibleAlias;
    }
  }

  return { cursor, endToken };
}

function builderSelectClauseEnd(
  tokens: readonly SqlToken[],
  start: number,
): number {
  let cursor = start;
  while (cursor < tokens.length && !isBuilderSelectBoundary(tokens[cursor])) {
    cursor += 1;
  }
  return cursor;
}

/**
 * Recognizes only read-only SELECT graphs whose statement-level structure is
 * directly represented by Drizzle's select, join, predicate, grouping,
 * ordering, limit, and unionAll builders. Expressions may remain SQL leaves.
 */
function builderReadSelectMatch(
  syntaxSource: string,
  allowUnionAll: boolean,
): boolean {
  const statement = completeSqlStatement(syntaxSource);
  if (statement === undefined) {
    return false;
  }
  const tokens = statement.tokens;
  const compoundIndexes = tokens.flatMap((token, index) => {
    return isWord(token, "UNION") ||
      isWord(token, "INTERSECT") ||
      isWord(token, "EXCEPT")
      ? [index]
      : [];
  });
  if (!allowUnionAll && compoundIndexes.length > 0) {
    return false;
  }

  const arms: Array<{
    readonly end: number;
    readonly tokens: readonly SqlToken[];
  }> = [];
  let armStart = 0;
  for (const compoundIndex of compoundIndexes) {
    const compoundKeyword = tokens[compoundIndex];
    const allKeyword = tokens[compoundIndex + 1];
    if (
      compoundKeyword === undefined ||
      allKeyword === undefined ||
      !isWord(compoundKeyword, "UNION") ||
      !isWord(allKeyword, "ALL") ||
      !onlyWhitespaceBetween(syntaxSource, compoundKeyword, allKeyword)
    ) {
      return false;
    }
    arms.push({
      end: compoundKeyword.start,
      tokens: tokens.slice(armStart, compoundIndex),
    });
    armStart = compoundIndex + 2;
  }
  arms.push({
    end: statement.end,
    tokens: tokens.slice(armStart),
  });

  return arms.every((arm) => {
    const armTokens = arm.tokens;
    const selectKeyword = armTokens[0];
    if (
      selectKeyword === undefined ||
      !isWord(selectKeyword, "SELECT") ||
      armTokens.some((token) => {
        return (
          token.kind === "word" &&
          UNSUPPORTED_BUILDER_SELECT_KEYWORDS.has(token.value)
        );
      })
    ) {
      return false;
    }

    const fromIndexes = armTokens.flatMap((token, index) => {
      return isWord(token, "FROM") ? [index] : [];
    });
    const fromIndex = fromIndexes.length === 1 ? fromIndexes[0] : undefined;
    const fromKeyword =
      fromIndex === undefined ? undefined : armTokens[fromIndex];
    if (
      fromIndex === undefined ||
      fromIndex <= 1 ||
      fromKeyword === undefined ||
      syntaxSource.slice(selectKeyword.end, fromKeyword.start).trim() === ""
    ) {
      return false;
    }

    const source = builderSelectRelationMatch(
      syntaxSource,
      armTokens,
      fromIndex + 1,
    );
    if (
      source === undefined ||
      !onlyWhitespaceBetween(
        syntaxSource,
        fromKeyword,
        armTokens[fromIndex + 1],
      )
    ) {
      return false;
    }
    let cursor = source.cursor;
    let previousToken = source.endToken;

    while (
      isWord(armTokens[cursor], "INNER") ||
      isWord(armTokens[cursor], "LEFT") ||
      isWord(armTokens[cursor], "JOIN")
    ) {
      const joinStart = armTokens[cursor];
      if (
        joinStart === undefined ||
        !onlyWhitespaceBetween(syntaxSource, previousToken, joinStart)
      ) {
        return false;
      }

      let joinKeyword = joinStart;
      if (isWord(joinStart, "INNER") || isWord(joinStart, "LEFT")) {
        cursor += 1;
        let prefixEnd = joinStart;
        if (isWord(joinStart, "LEFT") && isWord(armTokens[cursor], "OUTER")) {
          const outerKeyword = armTokens[cursor];
          if (
            outerKeyword === undefined ||
            !onlyWhitespaceBetween(syntaxSource, prefixEnd, outerKeyword)
          ) {
            return false;
          }
          prefixEnd = outerKeyword;
          cursor += 1;
        }
        joinKeyword = armTokens[cursor];
        if (
          joinKeyword === undefined ||
          !isWord(joinKeyword, "JOIN") ||
          !onlyWhitespaceBetween(syntaxSource, prefixEnd, joinKeyword)
        ) {
          return false;
        }
      }
      cursor += 1;

      const joined = builderSelectRelationMatch(
        syntaxSource,
        armTokens,
        cursor,
      );
      if (
        joined === undefined ||
        !onlyWhitespaceBetween(syntaxSource, joinKeyword, armTokens[cursor])
      ) {
        return false;
      }
      cursor = joined.cursor;
      const onKeyword = armTokens[cursor];
      if (
        onKeyword === undefined ||
        !isWord(onKeyword, "ON") ||
        !onlyWhitespaceBetween(syntaxSource, joined.endToken, onKeyword)
      ) {
        return false;
      }
      cursor += 1;
      const conditionEnd = builderSelectClauseEnd(armTokens, cursor);
      const conditionEndOffset =
        conditionEnd === armTokens.length
          ? arm.end
          : armTokens[conditionEnd]?.start;
      if (
        conditionEndOffset === undefined ||
        syntaxSource.slice(onKeyword.end, conditionEndOffset).trim() === ""
      ) {
        return false;
      }
      cursor = conditionEnd;
      previousToken = armTokens[cursor - 1] ?? onKeyword;
    }

    if (isWord(armTokens[cursor], "WHERE")) {
      const whereKeyword = armTokens[cursor];
      if (
        whereKeyword === undefined ||
        !onlyWhitespaceBetween(syntaxSource, previousToken, whereKeyword)
      ) {
        return false;
      }
      cursor += 1;
      const predicateEnd = builderSelectClauseEnd(armTokens, cursor);
      const predicateEndOffset =
        predicateEnd === armTokens.length
          ? arm.end
          : armTokens[predicateEnd]?.start;
      if (
        predicateEndOffset === undefined ||
        syntaxSource.slice(whereKeyword.end, predicateEndOffset).trim() === ""
      ) {
        return false;
      }
      cursor = predicateEnd;
      previousToken = armTokens[cursor - 1] ?? whereKeyword;
    }

    if (isWord(armTokens[cursor], "GROUP")) {
      const groupKeyword = armTokens[cursor];
      const byKeyword = armTokens[cursor + 1];
      if (
        groupKeyword === undefined ||
        byKeyword === undefined ||
        !isWord(byKeyword, "BY") ||
        !onlyWhitespaceBetween(syntaxSource, previousToken, groupKeyword) ||
        !onlyWhitespaceBetween(syntaxSource, groupKeyword, byKeyword)
      ) {
        return false;
      }
      cursor += 2;
      const groupingEnd = builderSelectClauseEnd(armTokens, cursor);
      const groupingEndOffset =
        groupingEnd === armTokens.length
          ? arm.end
          : armTokens[groupingEnd]?.start;
      if (
        groupingEndOffset === undefined ||
        syntaxSource.slice(byKeyword.end, groupingEndOffset).trim() === ""
      ) {
        return false;
      }
      cursor = groupingEnd;
      previousToken = armTokens[cursor - 1] ?? byKeyword;
    }

    if (isWord(armTokens[cursor], "ORDER")) {
      const orderKeyword = armTokens[cursor];
      const byKeyword = armTokens[cursor + 1];
      if (
        orderKeyword === undefined ||
        byKeyword === undefined ||
        !isWord(byKeyword, "BY") ||
        !onlyWhitespaceBetween(syntaxSource, previousToken, orderKeyword) ||
        !onlyWhitespaceBetween(syntaxSource, orderKeyword, byKeyword)
      ) {
        return false;
      }
      cursor += 2;
      const orderingEnd = builderSelectClauseEnd(armTokens, cursor);
      const orderingEndOffset =
        orderingEnd === armTokens.length
          ? arm.end
          : armTokens[orderingEnd]?.start;
      if (
        orderingEndOffset === undefined ||
        syntaxSource.slice(byKeyword.end, orderingEndOffset).trim() === ""
      ) {
        return false;
      }
      cursor = orderingEnd;
      previousToken = armTokens[cursor - 1] ?? byKeyword;
    }

    if (isWord(armTokens[cursor], "LIMIT")) {
      const limitKeyword = armTokens[cursor];
      const limitValue = armTokens[cursor + 1];
      if (
        limitKeyword === undefined ||
        limitValue === undefined ||
        (limitValue.kind !== "expression" && limitValue.kind !== "number") ||
        cursor + 2 !== armTokens.length ||
        !onlyWhitespaceBetween(syntaxSource, previousToken, limitKeyword) ||
        !onlyWhitespaceBetween(syntaxSource, limitKeyword, limitValue) ||
        syntaxSource.slice(limitValue.end, arm.end).trim() !== ""
      ) {
        return false;
      }
      return true;
    }

    return (
      cursor === armTokens.length &&
      syntaxSource.slice(previousToken.end, arm.end).trim() === ""
    );
  });
}

/**
 * Recognizes a complete local-helper-composed WITH query only when every CTE
 * is a read-only builder-owned SELECT and the final graph is a SELECT or
 * UNION ALL. Unsupported CTE modifiers and data-modifying bodies fail closed.
 */
function completeBuilderCteSelectMatch(syntaxSource: string): boolean {
  const statement = completeSqlStatement(syntaxSource);
  if (statement === undefined) {
    return false;
  }
  const tokens = statement.tokens;
  const withKeyword = tokens[0];
  if (withKeyword === undefined || !isWord(withKeyword, "WITH")) {
    return false;
  }

  const cteNames = new Set<string>();
  let cursor = 1;
  let previousToken = withKeyword;
  while (cursor < tokens.length && !isWord(tokens[cursor], "SELECT")) {
    const name = tokens[cursor];
    const asKeyword = tokens[cursor + 1];
    const open = tokens[cursor + 2];
    const close = tokens[cursor + 3];
    if (
      name?.kind !== "word" ||
      asKeyword === undefined ||
      open === undefined ||
      close === undefined ||
      !isWord(asKeyword, "AS") ||
      !isPunctuation(open, "(") ||
      !isPunctuation(close, ")") ||
      cteNames.has(name.value) ||
      !onlyWhitespaceBetween(syntaxSource, previousToken, name) ||
      !onlyWhitespaceBetween(syntaxSource, name, asKeyword) ||
      !onlyWhitespaceBetween(syntaxSource, asKeyword, open) ||
      !builderReadSelectMatch(syntaxSource.slice(open.end, close.start), false)
    ) {
      return false;
    }
    cteNames.add(name.value);
    cursor += 4;

    const separator = tokens[cursor];
    if (!isPunctuation(separator, ",")) {
      previousToken = close;
      break;
    }
    if (!onlyWhitespaceBetween(syntaxSource, close, separator)) {
      return false;
    }
    previousToken = separator;
    cursor += 1;
  }

  const selectKeyword = tokens[cursor];
  if (
    cteNames.size === 0 ||
    selectKeyword === undefined ||
    !isWord(selectKeyword, "SELECT") ||
    !onlyWhitespaceBetween(syntaxSource, previousToken, selectKeyword)
  ) {
    return false;
  }
  return builderReadSelectMatch(
    syntaxSource.slice(selectKeyword.start, statement.end),
    true,
  );
}

const SCALAR_AGGREGATE_FUNCTIONS = new Set([
  "AVG",
  "COUNT",
  "MAX",
  "MIN",
  "SUM",
]);
const SCALAR_COALESCE_FUNCTIONS = new Set(["COALESCE"]);

function topLevelCallMatch(
  source: string,
  names: ReadonlySet<string>,
): TopLevelCallMatch | undefined {
  const tokens = topLevelTokens(source);
  const name = tokens?.[0];
  const open = tokens?.[1];
  const close = tokens?.[2];
  if (
    name?.kind !== "word" ||
    !names.has(name.value) ||
    open === undefined ||
    close === undefined ||
    !isPunctuation(open, "(") ||
    !isPunctuation(close, ")") ||
    source.slice(0, name.start).trim() !== "" ||
    !onlyWhitespaceBetween(source, name, open) ||
    source.slice(open.end, close.start).trim() === ""
  ) {
    return undefined;
  }
  return {
    body: source.slice(open.end, close.start),
    end: close.end,
  };
}

function isScalarSelectionSuffix(source: string): boolean {
  return /^(?:\s*::\s*[A-Za-z_][A-Za-z0-9_$]*)*(?:\s+AS\s+[A-Za-z_][A-Za-z0-9_$]*)?\s*$/iu.test(
    source,
  );
}

function isCompleteScalarAggregateCall(source: string): boolean {
  const aggregate = topLevelCallMatch(source, SCALAR_AGGREGATE_FUNCTIONS);
  return aggregate !== undefined && source.slice(aggregate.end).trim() === "";
}

function isScalarCoalesceFallback(source: string): boolean {
  const value = source.trim();
  return (
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value) ||
    /^(?:FALSE|NULL|TRUE)$/iu.test(value) ||
    value === SQL_TEMPLATE_EXPRESSION_BOUNDARY
  );
}

/**
 * An ungrouped aggregate guarantees one row only while its complete target
 * expression stays scalar. PostgreSQL target-list set-returning functions can
 * otherwise expand the aggregate result to zero or multiple rows.
 */
function isGuaranteedOneRowAggregateSelection(selection: string): boolean {
  const aggregate = topLevelCallMatch(selection, SCALAR_AGGREGATE_FUNCTIONS);
  if (
    aggregate !== undefined &&
    isScalarSelectionSuffix(selection.slice(aggregate.end))
  ) {
    return true;
  }

  const coalesce = topLevelCallMatch(selection, SCALAR_COALESCE_FUNCTIONS);
  if (
    coalesce === undefined ||
    !isScalarSelectionSuffix(selection.slice(coalesce.end))
  ) {
    return false;
  }
  const commas =
    topLevelTokens(coalesce.body)?.filter((token) => {
      return isPunctuation(token, ",");
    }) ?? [];
  const comma = commas.length === 1 ? commas[0] : undefined;
  return (
    comma !== undefined &&
    isCompleteScalarAggregateCall(coalesce.body.slice(0, comma.start)) &&
    isScalarCoalesceFallback(coalesce.body.slice(comma.end))
  );
}

function scalarCteBodyMatch(
  syntaxSource: string,
): ScalarCteBodyMatch | undefined {
  const statement = completeSqlStatement(syntaxSource);
  if (statement === undefined || statement.hasTrailingSemicolon) {
    return undefined;
  }
  const tokens = statement.tokens;
  if (
    !isWord(tokens[0], "SELECT") ||
    tokens.some((token) => {
      return (
        token.kind === "word" &&
        UNSUPPORTED_SCALAR_CTE_KEYWORDS.has(token.value)
      );
    }) ||
    (syntaxSource.match(/\bSELECT\b/giu)?.length ?? 0) !== 1
  ) {
    return undefined;
  }

  const fromIndexes = tokens.flatMap((token, index) => {
    return isWord(token, "FROM") ? [index] : [];
  });
  const whereIndexes = tokens.flatMap((token, index) => {
    return isWord(token, "WHERE") ? [index] : [];
  });
  const limitIndexes = tokens.flatMap((token, index) => {
    return isWord(token, "LIMIT") ? [index] : [];
  });
  const fromIndex = fromIndexes.length === 1 ? fromIndexes[0] : undefined;
  const whereIndex = whereIndexes.length === 1 ? whereIndexes[0] : undefined;
  const limitIndex = limitIndexes.length === 1 ? limitIndexes[0] : undefined;
  const selectKeyword = tokens[0];
  const fromKeyword = fromIndex === undefined ? undefined : tokens[fromIndex];
  const sourceTable =
    fromIndex === undefined ? undefined : tokens[fromIndex + 1];
  const whereKeyword =
    whereIndex === undefined ? undefined : tokens[whereIndex];
  if (
    selectKeyword === undefined ||
    fromIndex === undefined ||
    whereIndex === undefined ||
    fromKeyword === undefined ||
    sourceTable === undefined ||
    whereKeyword === undefined ||
    fromIndex <= 1 ||
    whereIndex !== fromIndex + 2 ||
    sourceTable.kind !== "word" ||
    !onlyWhitespaceBetween(syntaxSource, fromKeyword, sourceTable) ||
    !onlyWhitespaceBetween(syntaxSource, sourceTable, whereKeyword) ||
    syntaxSource.slice(selectKeyword.end, fromKeyword.start).trim() === ""
  ) {
    return undefined;
  }

  let predicateEnd = statement.end;
  if (limitIndex !== undefined) {
    const limitKeyword = tokens[limitIndex];
    const limitValue = tokens[limitIndex + 1];
    if (
      limitKeyword === undefined ||
      limitValue?.kind !== "number" ||
      limitValue.value !== "1" ||
      limitIndex !== tokens.length - 2 ||
      limitIndex <= whereIndex + 1 ||
      !onlyWhitespaceBetween(syntaxSource, limitKeyword, limitValue) ||
      syntaxSource.slice(limitValue.end, statement.end).trim() !== ""
    ) {
      return undefined;
    }
    predicateEnd = limitKeyword.start;
  }
  if (syntaxSource.slice(whereKeyword.end, predicateEnd).trim() === "") {
    return undefined;
  }

  const selection = syntaxSource.slice(selectKeyword.end, fromKeyword.start);
  const guaranteedOneRow = isGuaranteedOneRowAggregateSelection(selection);
  if (!guaranteedOneRow && limitIndex === undefined) {
    return undefined;
  }

  return { guaranteedOneRow };
}

function scalarCteReference(syntaxSource: string): string | undefined {
  const statement = completeSqlStatement(syntaxSource);
  if (statement === undefined || statement.hasTrailingSemicolon) {
    return undefined;
  }
  const tokens = statement.tokens;
  const selectKeyword = tokens[0];
  const selectedColumn = tokens[1];
  const fromKeyword = tokens[2];
  const sourceCte = tokens[3];
  if (
    tokens.length !== 4 ||
    selectKeyword === undefined ||
    selectedColumn?.kind !== "word" ||
    fromKeyword === undefined ||
    sourceCte?.kind !== "word" ||
    !isWord(selectKeyword, "SELECT") ||
    !isWord(fromKeyword, "FROM") ||
    !onlyWhitespaceBetween(syntaxSource, selectKeyword, selectedColumn) ||
    !onlyWhitespaceBetween(syntaxSource, selectedColumn, fromKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, fromKeyword, sourceCte) ||
    syntaxSource.slice(sourceCte.end, statement.end).trim() !== ""
  ) {
    return undefined;
  }
  return sourceCte.value;
}

/**
 * Recognizes a narrow CTE projection that can preserve scalar-subquery
 * cardinality with one aggregate CTE as the FROM anchor and LIMIT 1 CTEs as
 * left joins. Unsupported CTE clauses and outer expressions fail closed.
 */
function completeScalarCteProjectionMatch(syntaxSource: string): boolean {
  const statement = completeSqlStatement(syntaxSource);
  if (statement === undefined) {
    return false;
  }
  const tokens = statement.tokens;
  const withKeyword = tokens[0];
  if (withKeyword === undefined || !isWord(withKeyword, "WITH")) {
    return false;
  }

  const ctes = new Map<string, ScalarCteBodyMatch>();
  let cursor = 1;
  let previousToken = withKeyword;
  while (cursor < tokens.length && !isWord(tokens[cursor], "SELECT")) {
    const name = tokens[cursor];
    const asKeyword = tokens[cursor + 1];
    const open = tokens[cursor + 2];
    const close = tokens[cursor + 3];
    if (
      name?.kind !== "word" ||
      asKeyword === undefined ||
      open === undefined ||
      close === undefined ||
      !isWord(asKeyword, "AS") ||
      !isPunctuation(open, "(") ||
      !isPunctuation(close, ")") ||
      !onlyWhitespaceBetween(syntaxSource, previousToken, name) ||
      !onlyWhitespaceBetween(syntaxSource, name, asKeyword) ||
      !onlyWhitespaceBetween(syntaxSource, asKeyword, open) ||
      ctes.has(name.value)
    ) {
      return false;
    }
    const body = scalarCteBodyMatch(syntaxSource.slice(open.end, close.start));
    if (body === undefined) {
      return false;
    }
    ctes.set(name.value, body);
    cursor += 4;

    const separator = tokens[cursor];
    if (!isPunctuation(separator, ",")) {
      previousToken = close;
      break;
    }
    if (!onlyWhitespaceBetween(syntaxSource, close, separator)) {
      return false;
    }
    previousToken = separator;
    cursor += 1;
  }

  const selectKeyword = tokens[cursor];
  if (
    ctes.size < 2 ||
    selectKeyword === undefined ||
    !isWord(selectKeyword, "SELECT") ||
    !onlyWhitespaceBetween(syntaxSource, previousToken, selectKeyword)
  ) {
    return false;
  }
  cursor += 1;

  const referencedCtes = new Set<string>();
  const resultAliases = new Set<string>();
  let hasGuaranteedOneRowReference = false;
  previousToken = selectKeyword;
  while (cursor < tokens.length) {
    const open = tokens[cursor];
    const close = tokens[cursor + 1];
    const asKeyword = tokens[cursor + 2];
    const alias = tokens[cursor + 3];
    if (
      open === undefined ||
      close === undefined ||
      asKeyword === undefined ||
      alias?.kind !== "word" ||
      !isPunctuation(open, "(") ||
      !isPunctuation(close, ")") ||
      !isWord(asKeyword, "AS") ||
      !onlyWhitespaceBetween(syntaxSource, previousToken, open) ||
      !onlyWhitespaceBetween(syntaxSource, close, asKeyword) ||
      !onlyWhitespaceBetween(syntaxSource, asKeyword, alias) ||
      resultAliases.has(alias.value)
    ) {
      return false;
    }
    const reference = scalarCteReference(
      syntaxSource.slice(open.end, close.start),
    );
    const cte = reference === undefined ? undefined : ctes.get(reference);
    if (reference === undefined || cte === undefined) {
      return false;
    }
    referencedCtes.add(reference);
    resultAliases.add(alias.value);
    hasGuaranteedOneRowReference ||= cte.guaranteedOneRow;
    cursor += 4;

    const separator = tokens[cursor];
    if (separator === undefined) {
      if (syntaxSource.slice(alias.end, statement.end).trim() !== "") {
        return false;
      }
      previousToken = alias;
      break;
    }
    if (
      !isPunctuation(separator, ",") ||
      !onlyWhitespaceBetween(syntaxSource, alias, separator)
    ) {
      return false;
    }
    previousToken = separator;
    cursor += 1;
  }

  return (
    cursor === tokens.length &&
    previousToken.kind === "word" &&
    hasGuaranteedOneRowReference &&
    referencedCtes.size === ctes.size
  );
}

function isSimpleIdentifierList(
  syntaxSource: string,
  open: SqlToken,
  close: SqlToken,
): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_$]*)*$/u.test(
    syntaxSource.slice(open.end, close.start).trim(),
  );
}

function hasSimpleAssignments(
  source: string,
  syntaxSource: string,
  start: number,
  end: number,
  targetPattern: RegExp,
): boolean {
  const segments: Array<{ readonly start: number; readonly end: number }> = [];
  let depth = 0;
  let segmentStart = start;

  for (let offset = start; offset < end; offset += 1) {
    const character = syntaxSource[offset];
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      segments.push({ start: segmentStart, end: offset });
      segmentStart = offset + 1;
    }
  }
  segments.push({ start: segmentStart, end });

  return segments.every((segment) => {
    let assignmentOffset = -1;
    let assignmentDepth = 0;
    for (let offset = segment.start; offset < segment.end; offset += 1) {
      const character = syntaxSource[offset];
      if (character === "(") {
        assignmentDepth += 1;
      } else if (character === ")") {
        assignmentDepth -= 1;
      } else if (character === "=" && assignmentDepth === 0) {
        assignmentOffset = offset;
        break;
      }
    }
    if (assignmentOffset === -1) {
      return false;
    }
    const target = source.slice(segment.start, assignmentOffset).trim();
    const value = source.slice(assignmentOffset + 1, segment.end).trim();
    return targetPattern.test(target) && value !== "";
  });
}

function simpleDeleteMatch(
  syntaxSource: string,
  statement: CompleteSqlStatement,
): SimpleDeleteMatch | undefined {
  const tokens = statement.tokens;
  const trailingToken = tokens[tokens.length - 1];
  if (
    !statement.hasTrailingSemicolon &&
    (trailingToken === undefined ||
      syntaxSource.slice(trailingToken.end, statement.end).trim() !== "")
  ) {
    return undefined;
  }

  const deleteKeyword = tokens[0];
  const fromKeyword = tokens[1];
  const targetTable = tokens[2];
  const whereKeyword = tokens[3];
  if (
    tokens.length <= 4 ||
    !isWord(deleteKeyword, "DELETE") ||
    !isWord(fromKeyword, "FROM") ||
    (targetTable?.kind !== "word" && targetTable?.kind !== "expression") ||
    !isWord(whereKeyword, "WHERE") ||
    deleteKeyword === undefined ||
    fromKeyword === undefined ||
    whereKeyword === undefined ||
    !onlyWhitespaceBetween(syntaxSource, deleteKeyword, fromKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, fromKeyword, targetTable) ||
    !onlyWhitespaceBetween(syntaxSource, targetTable, whereKeyword)
  ) {
    return undefined;
  }

  if (
    tokens.slice(4).some((token) => {
      return (
        (token.kind === "word" &&
          UNSUPPORTED_DELETE_PREDICATE_KEYWORDS.has(token.value)) ||
        isPunctuation(token, ",")
      );
    })
  ) {
    return undefined;
  }

  return {
    targetTableExpressionIndex:
      targetTable.kind === "expression"
        ? targetTable.expressionIndex
        : undefined,
  };
}

function simpleUnnestUpdateMatch(
  source: string,
  syntaxSource: string,
  statement: CompleteSqlStatement,
): SimpleUnnestUpdateMatch | undefined {
  const tokens = statement.tokens;
  const trailingToken = tokens[tokens.length - 1];
  if (
    !statement.hasTrailingSemicolon &&
    (trailingToken === undefined ||
      syntaxSource.slice(trailingToken.end, statement.end).trim() !== "")
  ) {
    return undefined;
  }

  const setIndexes = tokens.flatMap((token, index) => {
    return isWord(token, "SET") ? [index] : [];
  });
  const fromIndexes = tokens.flatMap((token, index) => {
    return isWord(token, "FROM") ? [index] : [];
  });
  const whereIndexes = tokens.flatMap((token, index) => {
    return isWord(token, "WHERE") ? [index] : [];
  });
  if (
    setIndexes.length !== 1 ||
    fromIndexes.length !== 1 ||
    whereIndexes.length !== 1
  ) {
    return undefined;
  }

  const setIndex = setIndexes[0];
  const fromIndex = fromIndexes[0];
  const whereIndex = whereIndexes[0];
  if (
    setIndex === undefined ||
    fromIndex === undefined ||
    whereIndex === undefined
  ) {
    return undefined;
  }

  const updateKeyword = tokens[0];
  const targetTable = tokens[1];
  const setKeyword = tokens[setIndex];
  const fromKeyword = tokens[fromIndex];
  const unnestKeyword = tokens[fromIndex + 1];
  const sourceOpen = tokens[fromIndex + 2];
  const sourceClose = tokens[fromIndex + 3];
  const asKeyword = tokens[fromIndex + 4];
  const sourceAlias = tokens[fromIndex + 5];
  const sourceColumnsOpen = tokens[fromIndex + 6];
  const sourceColumnsClose = tokens[fromIndex + 7];
  const whereKeyword = tokens[whereIndex];
  if (
    setIndex !== 2 ||
    whereIndex !== fromIndex + 8 ||
    !isWord(updateKeyword, "UPDATE") ||
    targetTable?.kind !== "expression" ||
    !isWord(setKeyword, "SET") ||
    !isWord(fromKeyword, "FROM") ||
    !isWord(unnestKeyword, "UNNEST") ||
    !isPunctuation(sourceOpen, "(") ||
    !isPunctuation(sourceClose, ")") ||
    !isWord(asKeyword, "AS") ||
    sourceAlias?.kind !== "word" ||
    !isPunctuation(sourceColumnsOpen, "(") ||
    !isPunctuation(sourceColumnsClose, ")") ||
    !isWord(whereKeyword, "WHERE") ||
    updateKeyword === undefined ||
    setKeyword === undefined ||
    fromKeyword === undefined ||
    unnestKeyword === undefined ||
    sourceOpen === undefined ||
    sourceClose === undefined ||
    asKeyword === undefined ||
    sourceColumnsOpen === undefined ||
    sourceColumnsClose === undefined ||
    whereKeyword === undefined ||
    !onlyWhitespaceBetween(syntaxSource, updateKeyword, targetTable) ||
    !onlyWhitespaceBetween(syntaxSource, targetTable, setKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, fromKeyword, unnestKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, unnestKeyword, sourceOpen) ||
    !onlyWhitespaceBetween(syntaxSource, sourceClose, asKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, asKeyword, sourceAlias) ||
    !onlyWhitespaceBetween(syntaxSource, sourceAlias, sourceColumnsOpen) ||
    !onlyWhitespaceBetween(syntaxSource, sourceColumnsClose, whereKeyword) ||
    syntaxSource.slice(sourceOpen.end, sourceClose.start).trim() === "" ||
    !isSimpleIdentifierList(
      syntaxSource,
      sourceColumnsOpen,
      sourceColumnsClose,
    ) ||
    !hasSimpleAssignments(
      source,
      syntaxSource,
      setKeyword.end,
      fromKeyword.start,
      SIMPLE_OR_QUOTED_IDENTIFIER_PATTERN,
    ) ||
    syntaxSource.slice(whereKeyword.end, statement.end).trim() === "" ||
    tokens.slice(whereIndex + 1).some((token) => {
      return (
        token.kind === "word" &&
        UNSUPPORTED_UPDATE_PREDICATE_KEYWORDS.has(token.value)
      );
    })
  ) {
    return undefined;
  }

  return {
    targetTableExpressionIndex: targetTable.expressionIndex,
  };
}

function simpleUpsertMatch(
  source: string,
  syntaxSource: string,
  statement: CompleteSqlStatement,
): SimpleUpsertMatch | undefined {
  const tokens = statement.tokens;
  const insertKeyword = tokens[0];
  const intoKeyword = tokens[1];
  const targetTable = tokens[2];
  const insertColumnsOpen = tokens[3];
  const insertColumnsClose = tokens[4];
  const valuesKeyword = tokens[5];
  const valuesOpen = tokens[6];
  const valuesClose = tokens[7];
  const onKeyword = tokens[8];
  const conflictKeyword = tokens[9];
  const conflictTargetOpen = tokens[10];
  const conflictTargetClose = tokens[11];
  const doKeyword = tokens[12];
  const updateKeyword = tokens[13];
  const setKeyword = tokens[14];

  if (
    tokens.length <= 15 ||
    !isWord(insertKeyword, "INSERT") ||
    !isWord(intoKeyword, "INTO") ||
    (targetTable?.kind !== "word" && targetTable?.kind !== "expression") ||
    !isPunctuation(insertColumnsOpen, "(") ||
    !isPunctuation(insertColumnsClose, ")") ||
    !isWord(valuesKeyword, "VALUES") ||
    !isPunctuation(valuesOpen, "(") ||
    !isPunctuation(valuesClose, ")") ||
    !isWord(onKeyword, "ON") ||
    !isWord(conflictKeyword, "CONFLICT") ||
    !isPunctuation(conflictTargetOpen, "(") ||
    !isPunctuation(conflictTargetClose, ")") ||
    !isWord(doKeyword, "DO") ||
    !isWord(updateKeyword, "UPDATE") ||
    !isWord(setKeyword, "SET") ||
    insertKeyword === undefined ||
    intoKeyword === undefined ||
    insertColumnsOpen === undefined ||
    insertColumnsClose === undefined ||
    valuesKeyword === undefined ||
    valuesOpen === undefined ||
    valuesClose === undefined ||
    onKeyword === undefined ||
    conflictKeyword === undefined ||
    conflictTargetOpen === undefined ||
    conflictTargetClose === undefined ||
    doKeyword === undefined ||
    updateKeyword === undefined ||
    setKeyword === undefined ||
    !onlyWhitespaceBetween(syntaxSource, insertKeyword, intoKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, intoKeyword, targetTable) ||
    !onlyWhitespaceBetween(syntaxSource, targetTable, insertColumnsOpen) ||
    !onlyWhitespaceBetween(syntaxSource, insertColumnsClose, valuesKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, valuesKeyword, valuesOpen) ||
    !onlyWhitespaceBetween(syntaxSource, valuesClose, onKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, onKeyword, conflictKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, conflictKeyword, conflictTargetOpen) ||
    !onlyWhitespaceBetween(syntaxSource, conflictTargetClose, doKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, doKeyword, updateKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, updateKeyword, setKeyword) ||
    !isSimpleIdentifierList(
      syntaxSource,
      insertColumnsOpen,
      insertColumnsClose,
    ) ||
    source.slice(valuesOpen.end, valuesClose.start).trim() === "" ||
    !isSimpleIdentifierList(
      syntaxSource,
      conflictTargetOpen,
      conflictTargetClose,
    ) ||
    tokens.slice(15).some((token) => {
      return (
        token.kind === "word" &&
        UNSUPPORTED_UPSERT_ASSIGNMENT_KEYWORDS.has(token.value)
      );
    }) ||
    !hasSimpleAssignments(
      source,
      syntaxSource,
      setKeyword.end,
      statement.end,
      SIMPLE_IDENTIFIER_PATTERN,
    )
  ) {
    return undefined;
  }

  return {
    targetTableExpressionIndex:
      targetTable.kind === "expression"
        ? targetTable.expressionIndex
        : undefined,
  };
}

function simpleLockingSelectMatch(
  syntaxSource: string,
): SimpleLockingSelectMatch | undefined {
  const tokens = topLevelTokens(syntaxSource);
  if (tokens === undefined || !isWord(tokens[0], "SELECT")) {
    return undefined;
  }
  if ((syntaxSource.match(/\bSELECT\b/gi) ?? []).length !== 1) {
    return undefined;
  }

  let end = tokens.length;
  const trailingToken = tokens[end - 1];
  if (trailingToken?.kind === "punctuation" && trailingToken.value === ";") {
    if (syntaxSource.slice(trailingToken.end).trim() !== "") {
      return undefined;
    }
    end -= 1;
  } else if (
    trailingToken === undefined ||
    syntaxSource.slice(trailingToken.end).trim() !== ""
  ) {
    return undefined;
  }
  if (
    tokens.slice(0, end).some((token) => {
      return token.kind === "punctuation" && token.value === ";";
    })
  ) {
    return undefined;
  }

  let lockTableExpressionIndex: number | undefined;
  let lockStart = end - 2;
  let lockTokens = tokens.slice(lockStart, end);
  if (
    lockTokens.length !== 2 ||
    !isWord(lockTokens[0], "FOR") ||
    !isWord(lockTokens[1], "UPDATE")
  ) {
    lockStart = end - 4;
    lockTokens = tokens.slice(lockStart, end);
    const lockTargetExpressionIndex = expressionIndex(lockTokens[3]);
    const skipsLockedRows =
      lockTokens.length === 4 &&
      isWord(lockTokens[0], "FOR") &&
      isWord(lockTokens[1], "UPDATE") &&
      isWord(lockTokens[2], "SKIP") &&
      isWord(lockTokens[3], "LOCKED");
    const locksSpecificTable =
      lockTokens.length === 4 &&
      isWord(lockTokens[0], "FOR") &&
      isWord(lockTokens[1], "UPDATE") &&
      isWord(lockTokens[2], "OF") &&
      lockTargetExpressionIndex !== undefined;
    if (!skipsLockedRows && !locksSpecificTable) {
      return undefined;
    }
    lockTableExpressionIndex = locksSpecificTable
      ? lockTargetExpressionIndex
      : undefined;
  }
  if (
    lockStart <= 0 ||
    lockTokens.some((token, index) => {
      const next = lockTokens[index + 1];
      return (
        next !== undefined && !onlyWhitespaceBetween(syntaxSource, token, next)
      );
    })
  ) {
    return undefined;
  }
  const lockKeyword = lockTokens[0];
  if (lockKeyword === undefined) {
    return undefined;
  }

  const statementTokens = tokens.slice(0, lockStart);
  if (
    statementTokens.some((token) => {
      return (
        token.kind === "word" &&
        UNSUPPORTED_LOCKING_SELECT_KEYWORDS.has(token.value)
      );
    })
  ) {
    return undefined;
  }

  const fromIndexes = statementTokens.flatMap((token, index) => {
    return isWord(token, "FROM") ? [index] : [];
  });
  const whereIndexes = statementTokens.flatMap((token, index) => {
    return isWord(token, "WHERE") ? [index] : [];
  });
  const orderIndexes = statementTokens.flatMap((token, index) => {
    return isWord(token, "ORDER") ? [index] : [];
  });
  const limitIndexes = statementTokens.flatMap((token, index) => {
    return isWord(token, "LIMIT") ? [index] : [];
  });
  if (
    fromIndexes.length !== 1 ||
    whereIndexes.length !== 1 ||
    orderIndexes.length > 1 ||
    limitIndexes.length > 1
  ) {
    return undefined;
  }

  const fromIndex = fromIndexes[0];
  const whereIndex = whereIndexes[0];
  const selectKeyword = statementTokens[0];
  const fromKeyword =
    fromIndex === undefined ? undefined : statementTokens[fromIndex];
  const whereKeyword =
    whereIndex === undefined ? undefined : statementTokens[whereIndex];
  if (
    fromIndex === undefined ||
    whereIndex === undefined ||
    fromIndex <= 0 ||
    whereIndex !== fromIndex + 2 ||
    selectKeyword === undefined ||
    fromKeyword === undefined ||
    whereKeyword === undefined ||
    syntaxSource.slice(selectKeyword.end, fromKeyword.start).trim() === "" ||
    syntaxSource.slice(fromKeyword.end, whereKeyword.start).trim() === ""
  ) {
    return undefined;
  }

  const sourceTable = statementTokens[fromIndex + 1];
  if (
    sourceTable === undefined ||
    (sourceTable.kind !== "word" && sourceTable.kind !== "expression")
  ) {
    return undefined;
  }

  const orderIndex = orderIndexes[0];
  const limitIndex = limitIndexes[0];
  if (
    (orderIndex !== undefined && orderIndex <= whereIndex) ||
    (limitIndex !== undefined &&
      (limitIndex <= whereIndex ||
        (orderIndex !== undefined && limitIndex <= orderIndex)))
  ) {
    return undefined;
  }

  const whereEndIndex = orderIndex ?? limitIndex ?? statementTokens.length;
  const whereEndToken =
    whereEndIndex === statementTokens.length
      ? lockKeyword
      : statementTokens[whereEndIndex];
  if (
    whereEndToken === undefined ||
    syntaxSource.slice(whereKeyword.end, whereEndToken.start).trim() === ""
  ) {
    return undefined;
  }

  if (orderIndex !== undefined) {
    const orderKeyword = statementTokens[orderIndex];
    const byKeyword = statementTokens[orderIndex + 1];
    const orderEndIndex = limitIndex ?? statementTokens.length;
    const orderEndToken =
      orderEndIndex === statementTokens.length
        ? lockKeyword
        : statementTokens[orderEndIndex];
    if (
      orderKeyword === undefined ||
      byKeyword === undefined ||
      orderEndToken === undefined ||
      !isWord(byKeyword, "BY") ||
      !onlyWhitespaceBetween(syntaxSource, orderKeyword, byKeyword) ||
      syntaxSource.slice(byKeyword.end, orderEndToken.start).trim() === ""
    ) {
      return undefined;
    }
  }

  if (limitIndex !== undefined) {
    const limitKeyword = statementTokens[limitIndex];
    const limitValue = statementTokens[limitIndex + 1];
    if (
      limitKeyword === undefined ||
      limitValue?.kind !== "number" ||
      limitValue.value !== "1" ||
      limitIndex + 2 !== statementTokens.length ||
      !onlyWhitespaceBetween(syntaxSource, limitKeyword, limitValue) ||
      !onlyWhitespaceBetween(syntaxSource, limitValue, lockKeyword)
    ) {
      return undefined;
    }
  }

  return {
    lockTableExpressionIndex,
    sourceTableExpressionIndex:
      sourceTable.kind === "expression"
        ? sourceTable.expressionIndex
        : undefined,
  };
}

function simpleLockingCteUpdateMatch(
  source: string,
  syntaxSource: string,
  statement: CompleteSqlStatement,
): SimpleLockingCteUpdateMatch | undefined {
  const tokens = statement.tokens;
  const trailingToken = tokens[tokens.length - 1];
  if (
    !statement.hasTrailingSemicolon &&
    (trailingToken === undefined ||
      syntaxSource.slice(trailingToken.end, statement.end).trim() !== "")
  ) {
    return undefined;
  }

  const withKeyword = tokens[0];
  const cteName = tokens[1];
  const asKeyword = tokens[2];
  const cteOpen = tokens[3];
  const cteClose = tokens[4];
  const updateKeyword = tokens[5];
  const targetTable = tokens[6];
  const setKeyword = tokens[7];
  if (
    tokens.length <= 11 ||
    !isWord(withKeyword, "WITH") ||
    cteName?.kind !== "word" ||
    !isWord(asKeyword, "AS") ||
    !isPunctuation(cteOpen, "(") ||
    !isPunctuation(cteClose, ")") ||
    !isWord(updateKeyword, "UPDATE") ||
    targetTable?.kind !== "expression" ||
    !isWord(setKeyword, "SET") ||
    withKeyword === undefined ||
    asKeyword === undefined ||
    cteOpen === undefined ||
    cteClose === undefined ||
    updateKeyword === undefined ||
    setKeyword === undefined ||
    !onlyWhitespaceBetween(syntaxSource, withKeyword, cteName) ||
    !onlyWhitespaceBetween(syntaxSource, cteName, asKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, asKeyword, cteOpen) ||
    !onlyWhitespaceBetween(syntaxSource, cteClose, updateKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, updateKeyword, targetTable) ||
    !onlyWhitespaceBetween(syntaxSource, targetTable, setKeyword)
  ) {
    return undefined;
  }

  const fromIndexes = tokens.flatMap((token, index) => {
    return isWord(token, "FROM") ? [index] : [];
  });
  const whereIndexes = tokens.flatMap((token, index) => {
    return isWord(token, "WHERE") ? [index] : [];
  });
  if (fromIndexes.length !== 1 || whereIndexes.length !== 1) {
    return undefined;
  }
  const fromIndex = fromIndexes[0];
  const whereIndex = whereIndexes[0];
  if (fromIndex === undefined || whereIndex === undefined) {
    return undefined;
  }
  const fromKeyword = tokens[fromIndex];
  const cteSource = tokens[fromIndex + 1];
  const whereKeyword = tokens[whereIndex];
  if (
    fromIndex <= 8 ||
    whereIndex !== fromIndex + 2 ||
    !isWord(fromKeyword, "FROM") ||
    cteSource?.kind !== "word" ||
    cteSource.value !== cteName.value ||
    !isWord(whereKeyword, "WHERE") ||
    fromKeyword === undefined ||
    whereKeyword === undefined ||
    !onlyWhitespaceBetween(syntaxSource, fromKeyword, cteSource) ||
    !onlyWhitespaceBetween(syntaxSource, cteSource, whereKeyword) ||
    !hasSimpleAssignments(
      source,
      syntaxSource,
      setKeyword.end,
      fromKeyword.start,
      SIMPLE_OR_QUOTED_IDENTIFIER_PATTERN,
    ) ||
    syntaxSource.slice(whereKeyword.end, statement.end).trim() === "" ||
    tokens.slice(whereIndex + 1).some((token) => {
      return (
        token.kind === "word" &&
        UNSUPPORTED_UPDATE_PREDICATE_KEYWORDS.has(token.value)
      );
    })
  ) {
    return undefined;
  }

  const innerSyntaxSource = syntaxSource.slice(cteOpen.end, cteClose.start);
  const lockingMatch = simpleLockingSelectMatch(innerSyntaxSource);
  if (
    lockingMatch?.sourceTableExpressionIndex === undefined ||
    lockingMatch.lockTableExpressionIndex === undefined
  ) {
    return undefined;
  }
  const innerTokens = topLevelTokens(innerSyntaxSource);
  if (innerTokens === undefined) {
    return undefined;
  }
  const innerFromIndex = innerTokens.findIndex((token) => {
    return isWord(token, "FROM");
  });
  const innerOrderIndex = innerTokens.findIndex((token) => {
    return isWord(token, "ORDER");
  });
  const innerForIndex = innerTokens.findIndex((token) => {
    return isWord(token, "FOR");
  });
  const selectedColumn = innerTokens[1];
  const orderByKeyword = innerTokens[innerOrderIndex + 1];
  const orderColumn = innerTokens[innerOrderIndex + 2];
  const possibleOrderDirection = innerTokens[innerOrderIndex + 3];
  const orderEndIndex =
    isWord(possibleOrderDirection, "ASC") ||
    isWord(possibleOrderDirection, "DESC")
      ? innerOrderIndex + 4
      : innerOrderIndex + 3;
  if (
    innerFromIndex !== 2 ||
    selectedColumn?.kind !== "expression" ||
    innerOrderIndex <= innerFromIndex ||
    !isWord(orderByKeyword, "BY") ||
    orderColumn?.kind !== "expression" ||
    orderEndIndex !== innerForIndex
  ) {
    return undefined;
  }

  // The outer prefix contains no interpolations, so expression indexes from
  // the nested SELECT address the full tagged template unchanged.
  return {
    lockTableExpressionIndex: lockingMatch.lockTableExpressionIndex,
    orderColumnExpressionIndex: orderColumn.expressionIndex,
    selectedColumnExpressionIndex: selectedColumn.expressionIndex,
    sourceTableExpressionIndex: lockingMatch.sourceTableExpressionIndex,
    targetTableExpressionIndex: targetTable.expressionIndex,
  };
}

function isPaginatedJoinedSelectClauseBoundary(
  token: SqlToken | undefined,
): boolean {
  return (
    isWord(token, "INNER") ||
    isWord(token, "LEFT") ||
    isWord(token, "WHERE") ||
    isWord(token, "ORDER") ||
    isWord(token, "LIMIT")
  );
}

function expressionIndexesBetween(
  tokens: readonly SqlToken[],
  start: number,
  end: number,
): number[] {
  return tokens.slice(start, end).flatMap((token) => {
    return token.kind === "expression" ? [token.expressionIndex] : [];
  });
}

/**
 * Recognizes only the recurring schema-backed join shape that Drizzle can own:
 * joins, a predicate, optional ordering, and a bounded result. Unsupported
 * statement features fail closed instead of being approximated.
 */
function paginatedJoinedSelectMatch(
  syntaxSource: string,
  selectionKind: "literal-one" | "schema-expression",
): PaginatedJoinedSelectMatch | undefined {
  const statement = completeSqlStatement(syntaxSource);
  if (statement === undefined) {
    return undefined;
  }
  const tokens = statement.tokens;
  if (
    !isWord(tokens[0], "SELECT") ||
    tokens.some((token) => {
      return (
        token.kind === "word" &&
        UNSUPPORTED_PAGINATED_JOINED_SELECT_KEYWORDS.has(token.value)
      );
    })
  ) {
    return undefined;
  }

  const fromIndexes = tokens.flatMap((token, index) => {
    return isWord(token, "FROM") ? [index] : [];
  });
  const fromIndex = fromIndexes.length === 1 ? fromIndexes[0] : undefined;
  const selectKeyword = tokens[0];
  const fromKeyword = fromIndex === undefined ? undefined : tokens[fromIndex];
  if (
    fromIndex === undefined ||
    fromIndex <= 1 ||
    selectKeyword === undefined ||
    fromKeyword === undefined ||
    syntaxSource.slice(selectKeyword.end, fromKeyword.start).trim() === ""
  ) {
    return undefined;
  }

  const selectedExpressionIndexes = expressionIndexesBetween(
    tokens,
    1,
    fromIndex,
  );
  if (selectionKind === "literal-one") {
    const selectedToken = tokens[1];
    if (
      fromIndex !== 2 ||
      selectedToken?.kind !== "number" ||
      selectedToken.value !== "1" ||
      !onlyWhitespaceBetween(syntaxSource, selectKeyword, selectedToken) ||
      !onlyWhitespaceBetween(syntaxSource, selectedToken, fromKeyword)
    ) {
      return undefined;
    }
  } else if (selectedExpressionIndexes.length === 0) {
    return undefined;
  }

  let cursor = fromIndex + 1;
  const sourceTableExpressionIndex = expressionIndex(tokens[cursor]);
  const sourceTable = tokens[cursor];
  if (
    sourceTableExpressionIndex === undefined ||
    sourceTable === undefined ||
    !onlyWhitespaceBetween(syntaxSource, fromKeyword, sourceTable)
  ) {
    return undefined;
  }
  cursor += 1;

  const joinTableExpressionIndexes: number[] = [];
  const clauseExpressionIndexes: number[] = [];
  while (isWord(tokens[cursor], "INNER") || isWord(tokens[cursor], "LEFT")) {
    const joinKind = tokens[cursor];
    cursor += 1;
    let joinPrefixEnd = joinKind;
    if (isWord(joinKind, "LEFT") && isWord(tokens[cursor], "OUTER")) {
      const outerKeyword = tokens[cursor];
      if (
        outerKeyword === undefined ||
        !onlyWhitespaceBetween(syntaxSource, joinKind, outerKeyword)
      ) {
        return undefined;
      }
      joinPrefixEnd = outerKeyword;
      cursor += 1;
    }
    const joinKeyword = tokens[cursor];
    if (
      joinKind === undefined ||
      joinPrefixEnd === undefined ||
      joinKeyword === undefined ||
      !isWord(joinKeyword, "JOIN") ||
      !onlyWhitespaceBetween(syntaxSource, joinPrefixEnd, joinKeyword)
    ) {
      return undefined;
    }
    cursor += 1;

    const joinTable = tokens[cursor];
    const joinTableExpressionIndex = expressionIndex(joinTable);
    if (
      joinTable === undefined ||
      joinTableExpressionIndex === undefined ||
      !onlyWhitespaceBetween(syntaxSource, joinKeyword, joinTable)
    ) {
      return undefined;
    }
    joinTableExpressionIndexes.push(joinTableExpressionIndex);
    cursor += 1;

    const onKeyword = tokens[cursor];
    if (
      onKeyword === undefined ||
      !isWord(onKeyword, "ON") ||
      !onlyWhitespaceBetween(syntaxSource, joinTable, onKeyword)
    ) {
      return undefined;
    }
    cursor += 1;
    const conditionStart = cursor;
    while (
      cursor < tokens.length &&
      !isPaginatedJoinedSelectClauseBoundary(tokens[cursor])
    ) {
      cursor += 1;
    }
    const conditionEnd =
      cursor === tokens.length ? statement.end : tokens[cursor]?.start;
    const conditionExpressionIndexes = expressionIndexesBetween(
      tokens,
      conditionStart,
      cursor,
    );
    if (
      conditionEnd === undefined ||
      syntaxSource.slice(onKeyword.end, conditionEnd).trim() === "" ||
      conditionExpressionIndexes.length === 0
    ) {
      return undefined;
    }
    clauseExpressionIndexes.push(...conditionExpressionIndexes);
  }
  if (joinTableExpressionIndexes.length === 0) {
    return undefined;
  }

  const whereKeyword = tokens[cursor];
  if (whereKeyword === undefined || !isWord(whereKeyword, "WHERE")) {
    return undefined;
  }
  cursor += 1;
  const whereStart = cursor;
  while (
    cursor < tokens.length &&
    !isWord(tokens[cursor], "ORDER") &&
    !isWord(tokens[cursor], "LIMIT")
  ) {
    cursor += 1;
  }
  const whereEnd =
    cursor === tokens.length ? statement.end : tokens[cursor]?.start;
  const whereExpressionIndexes = expressionIndexesBetween(
    tokens,
    whereStart,
    cursor,
  );
  if (
    whereEnd === undefined ||
    syntaxSource.slice(whereKeyword.end, whereEnd).trim() === "" ||
    whereExpressionIndexes.length === 0
  ) {
    return undefined;
  }
  clauseExpressionIndexes.push(...whereExpressionIndexes);

  if (isWord(tokens[cursor], "ORDER")) {
    const orderKeyword = tokens[cursor];
    const byKeyword = tokens[cursor + 1];
    if (
      orderKeyword === undefined ||
      byKeyword === undefined ||
      !isWord(byKeyword, "BY") ||
      !onlyWhitespaceBetween(syntaxSource, orderKeyword, byKeyword)
    ) {
      return undefined;
    }
    cursor += 2;
    const orderStart = cursor;
    while (cursor < tokens.length && !isWord(tokens[cursor], "LIMIT")) {
      cursor += 1;
    }
    const orderEnd =
      cursor === tokens.length ? statement.end : tokens[cursor]?.start;
    const orderExpressionIndexes = expressionIndexesBetween(
      tokens,
      orderStart,
      cursor,
    );
    if (
      orderEnd === undefined ||
      syntaxSource.slice(byKeyword.end, orderEnd).trim() === "" ||
      orderExpressionIndexes.length === 0
    ) {
      return undefined;
    }
    clauseExpressionIndexes.push(...orderExpressionIndexes);
  }

  const limitKeyword = tokens[cursor];
  const limitValue = tokens[cursor + 1];
  if (
    limitKeyword === undefined ||
    limitValue === undefined ||
    !isWord(limitKeyword, "LIMIT") ||
    (limitValue.kind !== "number" && limitValue.kind !== "expression") ||
    cursor + 2 !== tokens.length ||
    !onlyWhitespaceBetween(syntaxSource, limitKeyword, limitValue) ||
    syntaxSource.slice(limitValue.end, statement.end).trim() !== ""
  ) {
    return undefined;
  }

  return {
    clauseExpressionIndexes,
    joinTableExpressionIndexes,
    limitExpressionIndex:
      limitValue.kind === "expression" ? limitValue.expressionIndex : undefined,
    selectedExpressionIndexes,
    sourceTableExpressionIndex,
  };
}

function completePaginatedExistsSelectMatch(
  syntaxSource: string,
): PaginatedJoinedSelectMatch | undefined {
  const statement = completeSqlStatement(syntaxSource);
  if (statement === undefined) {
    return undefined;
  }
  const tokens = statement.tokens;
  const selectKeyword = tokens[0];
  const existsKeyword = tokens[1];
  const open = tokens[2];
  const close = tokens[3];
  if (
    tokens.length !== 6 ||
    selectKeyword === undefined ||
    existsKeyword === undefined ||
    open === undefined ||
    close === undefined ||
    !isWord(selectKeyword, "SELECT") ||
    !isWord(existsKeyword, "EXISTS") ||
    !isPunctuation(open, "(") ||
    !isPunctuation(close, ")") ||
    !isWord(tokens[4], "AS") ||
    tokens[5]?.kind !== "word" ||
    !onlyWhitespaceBetween(syntaxSource, selectKeyword, existsKeyword) ||
    !onlyWhitespaceBetween(syntaxSource, existsKeyword, open) ||
    syntaxSource.slice(close.end, tokens[4]?.start).trim() !== "" ||
    syntaxSource.slice(tokens[4]?.end, tokens[5]?.start).trim() !== "" ||
    syntaxSource.slice(tokens[5]?.end, statement.end).trim() !== ""
  ) {
    return undefined;
  }

  const innerSyntaxSource = syntaxSource.slice(open.end, close.start);
  // The validated outer statement has no interpolations before its inner
  // SELECT, so the inner expression indexes already address the full template.
  return paginatedJoinedSelectMatch(innerSyntaxSource, "literal-one");
}

function parenthesizedScalarSelect(
  source: string,
  syntaxSource: string,
): boolean {
  let start = 0;
  while (/\s/.test(syntaxSource[start] ?? "")) {
    start += 1;
  }
  let end = syntaxSource.length - 1;
  while (end >= start && /\s/.test(syntaxSource[end] ?? "")) {
    end -= 1;
  }
  if (syntaxSource[start] !== "(" || syntaxSource[end] !== ")") {
    return false;
  }

  let depth = 0;
  for (let offset = start; offset <= end; offset += 1) {
    const character = syntaxSource[offset];
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0 || (depth === 0 && offset !== end)) {
        return false;
      }
    }
  }
  if (depth !== 0) {
    return false;
  }

  const innerSource = source.slice(start + 1, end);
  const innerSyntaxSource = syntaxSource.slice(start + 1, end);
  const tokens = topLevelTokens(innerSyntaxSource);
  if (tokens === undefined || !isWord(tokens[0], "SELECT")) {
    return false;
  }
  if (
    tokens.some((token, index) => {
      return (
        (token.kind === "punctuation" && token.value === ";") ||
        (token.kind === "word" &&
          UNSUPPORTED_SCALAR_QUERY_KEYWORDS.has(token.value) &&
          !(token.value === "LIMIT" && index === tokens.length - 2))
      );
    })
  ) {
    return false;
  }

  const fromIndex = tokens.findIndex((token, index) => {
    return index > 0 && isWord(token, "FROM");
  });
  const whereIndex = tokens.findIndex((token, index) => {
    return index > fromIndex && isWord(token, "WHERE");
  });
  const limitIndex = tokens.length - 2;
  const limitKeyword = tokens[limitIndex];
  const limitValue = tokens[limitIndex + 1];
  const selectKeyword = tokens[0];
  const fromKeyword = tokens[fromIndex];
  const whereKeyword = tokens[whereIndex];
  if (
    fromIndex <= 0 ||
    whereIndex <= fromIndex ||
    limitIndex <= whereIndex ||
    !isWord(limitKeyword, "LIMIT") ||
    limitValue?.kind !== "number" ||
    limitValue.value !== "1" ||
    selectKeyword === undefined ||
    fromKeyword === undefined ||
    whereKeyword === undefined ||
    innerSource.slice(selectKeyword.end, fromKeyword.start).trim() === "" ||
    innerSource.slice(fromKeyword.end, whereKeyword.start).trim() === "" ||
    innerSource.slice(whereKeyword.end, limitKeyword.start).trim() === "" ||
    innerSyntaxSource.slice(limitKeyword.end, limitValue.start).trim() !== "" ||
    innerSyntaxSource.slice(limitValue.end).trim() !== ""
  ) {
    return false;
  }

  return true;
}

export const preferDrizzleQueryBuilder = createRule({
  name: "prefer-drizzle-query-builder",
  defaultOptions: [],
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer Drizzle query builders for complete schema-backed deletes, updates, upserts, selects, existence checks, locking selects, composed read-only CTEs, scalar CTE projections, and scalar result queries",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      queryBuilder:
        "Use a Drizzle select builder for this complete schema-backed query.",
      existsQueryBuilder:
        "Use a Drizzle select builder and row existence check for this complete schema-backed EXISTS query.",
      lockingQueryBuilder:
        "Use a Drizzle select builder with .for(...) for this complete locking query.",
      deleteQueryBuilder:
        "Use a Drizzle delete builder for this complete single-target query.",
      upsertQueryBuilder:
        "Use a Drizzle insert builder with .onConflictDoUpdate(...) for this complete single-row upsert.",
      unnestUpdateQueryBuilder:
        "Use a Drizzle update builder with .from(...) for this complete unnest-backed update.",
      lockingCteUpdateQueryBuilder:
        "Use Drizzle $with(...), select().for(...), and update().from(...) builders for this complete locking CTE update.",
      scalarCteQueryBuilder:
        "Use Drizzle $with(...), select(), and joins for this complete scalar CTE projection.",
      composedCteQueryBuilder:
        "Use Drizzle $with(...), select(), joins, grouping, ordering, and set-operation builders for this complete locally composed read query.",
      structuredScalarQuery:
        "Use a Drizzle query builder or joined relation instead of a complete raw scalar query in a structured result field.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const isExecuteRawRowsCallee = createExecuteRawRowsMatcher(
      context.sourceCode.ast,
      checker,
      services,
    );
    // Keep the type-aware consumer traversal out of files with no matching
    // syntax. The API baseline has hundreds of result calls but zero targets.
    const scalarQueryCandidates = new Set<TSESTree.TaggedTemplateExpression>();
    const structuredSelectionCalls: TSESTree.CallExpression[] = [];
    const reportedScalarQueries = new Set<TSESTree.TaggedTemplateExpression>();
    const resultPropertyTypes: Record<
      "execute" | "from",
      Map<Type, boolean>
    > = {
      execute: new Map<Type, boolean>(),
      from: new Map<Type, boolean>(),
    };

    function isDrizzleExecuteMember(node: TSESTree.MemberExpression): boolean {
      if (memberName(node) !== "execute") {
        return false;
      }
      const tsProperty = services.esTreeNodeToTSNodeMap.get(node.property);
      return (
        checker
          .getSymbolAtLocation(tsProperty)
          ?.declarations?.some(isDrizzleDeclaration) === true
      );
    }

    function expressionType(node: TSESTree.Expression) {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return {
        location: tsNode,
        type: checker.getTypeAtLocation(tsNode),
      };
    }

    function isNumberLikeType(type: Type): boolean {
      if (type.isUnion()) {
        return type.types.every(isNumberLikeType);
      }
      return (type.flags & (TypeFlags.Number | TypeFlags.NumberLiteral)) !== 0;
    }

    function isBoundScalarParameterType(type: Type): boolean {
      if ((type.flags & TypeFlags.TypeParameter) !== 0) {
        const constraint = checker.getBaseConstraintOfType(type);
        return (
          constraint !== undefined && isBoundScalarParameterType(constraint)
        );
      }
      if (type.isUnion()) {
        return type.types.every(isBoundScalarParameterType);
      }
      return (
        (type.flags &
          (TypeFlags.BigIntLike |
            TypeFlags.BooleanLike |
            TypeFlags.Null |
            TypeFlags.NumberLike |
            TypeFlags.StringLike)) !==
        0
      );
    }

    function isDrizzleWrapperExpression(
      node: TSESTree.Expression | undefined,
    ): boolean {
      return (
        node !== undefined &&
        isDrizzleWrapperType(checker, expressionType(node).type)
      );
    }

    function isDrizzleTableExpression(
      node: TSESTree.Expression | undefined,
    ): boolean {
      if (node === undefined) {
        return false;
      }
      const value = expressionType(node);
      return isDrizzleTableType(checker, value.type, value.location);
    }

    function isSchemaBackedPaginatedJoin(
      query: TSESTree.TaggedTemplateExpression,
      match: PaginatedJoinedSelectMatch,
    ): boolean {
      const expressions = query.quasi.expressions;
      const limitExpression =
        match.limitExpressionIndex === undefined
          ? undefined
          : expressions[match.limitExpressionIndex];
      return (
        isDrizzleTableExpression(
          expressions[match.sourceTableExpressionIndex],
        ) &&
        match.joinTableExpressionIndexes.every((index) => {
          return isDrizzleTableExpression(expressions[index]);
        }) &&
        match.selectedExpressionIndexes.every((index) => {
          return isDrizzleWrapperExpression(expressions[index]);
        }) &&
        match.clauseExpressionIndexes.every((index) => {
          return isDrizzleWrapperExpression(expressions[index]);
        }) &&
        (limitExpression === undefined ||
          isNumberLikeType(expressionType(limitExpression).type))
      );
    }

    function symbolAt(node: TSESTree.Node) {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return checker.getSymbolAtLocation(tsNode);
    }

    function methodReturnsDrizzleProperty(
      type: Type,
      property: "execute" | "from",
    ): boolean {
      const cache = resultPropertyTypes[property];
      const cached = cache.get(type);
      if (cached !== undefined) {
        return cached;
      }
      let result: boolean;
      if (type.isUnion()) {
        result = type.types.every((member) => {
          return methodReturnsDrizzleProperty(member, property);
        });
      } else {
        const signatures = type.getCallSignatures();
        result =
          signatures.length > 0 &&
          signatures.every((signature) => {
            const returnType = checker.getReturnTypeOfSignature(signature);
            return isDrizzleSymbol(
              checker,
              checker.getPropertyOfType(returnType, property),
            );
          });
      }
      cache.set(type, result);
      return result;
    }

    function hasOnlyDrizzleDeclarations(node: TSESTree.Node): boolean {
      const declarations = resolvedSymbol(
        checker,
        symbolAt(node),
      )?.declarations;
      return (
        declarations !== undefined &&
        declarations.length > 0 &&
        declarations.every(isDrizzleDeclaration)
      );
    }

    function hasOnlyNamedDrizzleSignatures(type: Type, name: string): boolean {
      if (type.isUnion()) {
        return type.types.every((member) => {
          return hasOnlyNamedDrizzleSignatures(member, name);
        });
      }
      const signatures = type.getCallSignatures();
      return (
        signatures.length > 0 &&
        signatures.every((signature) => {
          return isNamedDrizzleSignature(signature, name);
        })
      );
    }

    function structuredResultMethod(
      node: TSESTree.MemberExpression,
    ): string | null {
      const name = memberName(node);
      if (name === null || !RESULT_FIELD_ARGUMENT.has(name)) {
        return null;
      }
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      const type = checker.getTypeAtLocation(tsNode);
      const hasDrizzleIdentity =
        hasOnlyDrizzleDeclarations(node.property) ||
        hasOnlyNamedDrizzleSignatures(type, name);
      return hasDrizzleIdentity &&
        methodReturnsDrizzleProperty(
          type,
          name === "returning" ? "execute" : "from",
        )
        ? name
        : null;
    }

    function transparentExpression(node: TSESTree.Node): TSESTree.Node | null {
      if (
        node.type === AST_NODE_TYPES.TSAsExpression ||
        node.type === AST_NODE_TYPES.TSTypeAssertion ||
        node.type === AST_NODE_TYPES.TSSatisfiesExpression ||
        node.type === AST_NODE_TYPES.TSNonNullExpression ||
        node.type === AST_NODE_TYPES.ChainExpression
      ) {
        return node.expression;
      }
      return null;
    }

    function variableInScope(
      node: TSESTree.Identifier,
    ): TSESLint.Scope.Variable | null {
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
      return null;
    }

    function outerTransparentExpression(node: TSESTree.Node): TSESTree.Node {
      let current = node;
      while (
        current.parent !== undefined &&
        transparentExpression(current.parent) === current
      ) {
        current = current.parent;
      }
      return current;
    }

    function isStructuredResultArgument(node: TSESTree.Node): boolean {
      const use = outerTransparentExpression(node);
      const parent = use.parent;
      if (
        parent === undefined ||
        parent.type !== AST_NODE_TYPES.CallExpression ||
        parent.callee.type !== AST_NODE_TYPES.MemberExpression
      ) {
        return false;
      }
      const method = structuredResultMethod(parent.callee);
      const argumentIndex =
        method === null ? undefined : RESULT_FIELD_ARGUMENT.get(method);
      return (
        argumentIndex !== undefined && parent.arguments[argumentIndex] === use
      );
    }

    function isSafeConstReference(
      identifier: TSESTree.Identifier,
      currentReference: TSESTree.Identifier,
    ): boolean {
      return (
        identifier === currentReference ||
        isStructuredResultArgument(identifier)
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

    function variableIsExported(declaration: VariableDeclaration): boolean {
      return hasExportModifier(declaration.parent.parent);
    }

    function hasOnlySafeConstReferences(node: TSESTree.Identifier): boolean {
      // const freezes the binding, not the selected object. Stop when another
      // use could mutate or expose it outside a proven Drizzle result read.
      const variable = variableInScope(node);
      return (
        variable !== null &&
        variable.references.every((reference) => {
          return (
            reference.init === true ||
            (reference.identifier.type === AST_NODE_TYPES.Identifier &&
              isSafeConstReference(reference.identifier, node))
          );
        })
      );
    }

    function localConstInitializer(node: TSESTree.Node): TSESTree.Node | null {
      if (node.type !== AST_NODE_TYPES.Identifier) {
        return null;
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
        variableIsExported(declaration) ||
        declaration.initializer === undefined ||
        !hasOnlySafeConstReferences(node)
      ) {
        return null;
      }
      return services.tsNodeToESTreeNodeMap.get(declaration.initializer);
    }

    function isConstVariable(declaration: VariableDeclaration): boolean {
      return (
        isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & NodeFlags.Const) !== 0
      );
    }

    function isSafeFunctionReference(
      identifier: TSESTree.Identifier,
      currentReference: TSESTree.Identifier,
    ): boolean {
      if (identifier === currentReference) {
        return true;
      }
      const callee = outerTransparentExpression(identifier);
      const call = callee.parent;
      return (
        call !== undefined &&
        call.type === AST_NODE_TYPES.CallExpression &&
        call.callee === callee &&
        isStructuredResultArgument(call)
      );
    }

    function hasOnlySafeFunctionReferences(node: TSESTree.Identifier): boolean {
      const variable = variableInScope(node);
      return (
        variable !== null &&
        variable.references.every((reference) => {
          return (
            reference.init === true ||
            (reference.identifier.type === AST_NODE_TYPES.Identifier &&
              isSafeFunctionReference(reference.identifier, node))
          );
        })
      );
    }

    function localSingleReturn(node: TSESTree.Node): TSESTree.Node | null {
      // This intentionally covers only the historical local factory shape.
      // Parameter substitution and broader call flow remain opaque.
      if (
        node.type !== AST_NODE_TYPES.CallExpression ||
        node.callee.type !== AST_NODE_TYPES.Identifier ||
        node.arguments.some((argument) => {
          return argument.type === AST_NODE_TYPES.SpreadElement;
        })
      ) {
        return null;
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
        declaration.body.statements.length !== 1 ||
        hasExportModifier(declaration) ||
        !hasOnlySafeFunctionReferences(node.callee)
      ) {
        return null;
      }
      const statement = declaration.body.statements[0];
      if (
        statement === undefined ||
        !isReturnStatement(statement) ||
        statement.expression === undefined
      ) {
        return null;
      }
      return services.tsNodeToESTreeNodeMap.get(statement.expression);
    }

    function hasOnlyDirectCallReferences(node: TSESTree.Identifier): boolean {
      const variable = variableInScope(node);
      return (
        variable !== null &&
        variable.references.every((reference) => {
          if (reference.init === true) {
            return true;
          }
          const identifier = reference.identifier;
          if (identifier.type !== AST_NODE_TYPES.Identifier) {
            return false;
          }
          const callee = outerTransparentExpression(identifier);
          return (
            callee.parent?.type === AST_NODE_TYPES.CallExpression &&
            callee.parent.callee === callee
          );
        })
      );
    }

    function localSqlFactoryTemplate(node: TSESTree.Expression): {
      readonly declaration: Node;
      readonly template: TSESTree.TaggedTemplateExpression;
    } | null {
      let call: TSESTree.Node = node;
      let transparentCall = transparentExpression(call);
      while (transparentCall !== null) {
        call = transparentCall;
        transparentCall = transparentExpression(call);
      }
      if (
        call.type !== AST_NODE_TYPES.CallExpression ||
        call.callee.type !== AST_NODE_TYPES.Identifier ||
        call.arguments.some((argument) => {
          return argument.type === AST_NODE_TYPES.SpreadElement;
        }) ||
        !hasOnlyDirectCallReferences(call.callee) ||
        !isDrizzleWrapperType(checker, expressionType(call).type)
      ) {
        return null;
      }

      const tsCallee = services.esTreeNodeToTSNodeMap.get(call.callee);
      const declaration = resolvedSymbol(
        checker,
        checker.getSymbolAtLocation(tsCallee),
      )?.valueDeclaration;
      if (
        declaration === undefined ||
        !isFunctionDeclaration(declaration) ||
        declaration.getSourceFile() !== tsCallee.getSourceFile() ||
        declaration.body === undefined ||
        declaration.body.statements.length !== 1 ||
        hasExportModifier(declaration)
      ) {
        return null;
      }
      const statement = declaration.body.statements[0];
      if (
        statement === undefined ||
        !isReturnStatement(statement) ||
        statement.expression === undefined
      ) {
        return null;
      }

      let returned = services.tsNodeToESTreeNodeMap.get(statement.expression);
      let transparent = transparentExpression(returned);
      while (transparent !== null) {
        returned = transparent;
        transparent = transparentExpression(returned);
      }
      return returned.type === AST_NODE_TYPES.TaggedTemplateExpression
        ? { declaration, template: returned }
        : null;
    }

    function composeSqlTemplate(
      template: TSESTree.TaggedTemplateExpression,
      activeFactories: Set<Node>,
    ): ComposedSqlTemplate | null {
      if (!isDrizzleSqlTag(checker, services, template.tag)) {
        return null;
      }
      const firstQuasi = template.quasi.quasis[0];
      if (firstQuasi === undefined) {
        return null;
      }

      let source = quasiText(firstQuasi);
      let expandedFactory = false;
      const expressions: TSESTree.Expression[] = [];
      for (
        let index = 0;
        index < template.quasi.expressions.length;
        index += 1
      ) {
        const expression = template.quasi.expressions[index];
        const followingQuasi = template.quasi.quasis[index + 1];
        if (expression === undefined || followingQuasi === undefined) {
          return null;
        }

        const factory = localSqlFactoryTemplate(expression);
        if (factory !== null && !activeFactories.has(factory.declaration)) {
          activeFactories.add(factory.declaration);
          const nested = composeSqlTemplate(factory.template, activeFactories);
          activeFactories.delete(factory.declaration);
          if (nested !== null) {
            source += nested.source;
            expressions.push(...nested.expressions);
            expandedFactory = true;
          } else {
            source += SQL_TEMPLATE_EXPRESSION_BOUNDARY;
            expressions.push(expression);
          }
        } else {
          source += SQL_TEMPLATE_EXPRESSION_BOUNDARY;
          expressions.push(expression);
        }
        source += quasiText(followingQuasi);
      }

      return { expandedFactory, expressions, source };
    }

    function isComposedBuilderCteQuery(
      query: TSESTree.TaggedTemplateExpression,
    ): boolean {
      const firstQuasi = query.quasi.quasis[0];
      const firstExpression = query.quasi.expressions[0];
      if (
        firstQuasi === undefined ||
        firstExpression === undefined ||
        sqlCodeMask(quasiText(firstQuasi)).trim() !== "" ||
        localSqlFactoryTemplate(firstExpression) === null
      ) {
        return false;
      }

      const composition = composeSqlTemplate(query, new Set<Node>());
      return (
        composition !== null &&
        composition.expandedFactory &&
        completeBuilderCteSelectMatch(sqlCodeMask(composition.source)) &&
        composition.expressions.every((expression) => {
          const type = expressionType(expression).type;
          return (
            isBoundScalarParameterType(type) ||
            isDrizzleWrapperType(checker, type)
          );
        })
      );
    }

    function isDrizzleResultWrapper(node: TSESTree.CallExpression): boolean {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        node.arguments.some((argument) => {
          return argument.type === AST_NODE_TYPES.SpreadElement;
        })
      ) {
        return false;
      }
      const name = memberName(node.callee);
      if (
        (name !== "mapWith" && name !== "as") ||
        node.arguments.length !== 1
      ) {
        return false;
      }
      return isDrizzleSymbol(checker, symbolAt(node.callee.property));
    }

    function reportScalarQuery(node: TSESTree.TaggedTemplateExpression): void {
      if (
        !scalarQueryCandidates.has(node) ||
        reportedScalarQueries.has(node) ||
        !isDrizzleSqlTag(checker, services, node.tag)
      ) {
        return;
      }
      reportedScalarQueries.add(node);
      context.report({ node, messageId: "structuredScalarQuery" });
    }

    function inspectSelectedValue(
      node: TSESTree.Node,
      visited: Set<TSESTree.Node>,
    ): void {
      if (visited.has(node)) {
        return;
      }
      if (node.type === AST_NODE_TYPES.ObjectExpression) {
        inspectSelectionContainer(node, visited);
        return;
      }
      visited.add(node);

      const transparent = transparentExpression(node);
      if (transparent !== null) {
        inspectSelectedValue(transparent, visited);
        return;
      }
      const initializer = localConstInitializer(node);
      if (initializer !== null) {
        inspectSelectedValue(initializer, visited);
        return;
      }
      if (
        node.type === AST_NODE_TYPES.CallExpression &&
        node.callee.type === AST_NODE_TYPES.MemberExpression &&
        isDrizzleResultWrapper(node)
      ) {
        inspectSelectedValue(node.callee.object, visited);
        return;
      }
      if (node.type === AST_NODE_TYPES.TaggedTemplateExpression) {
        reportScalarQuery(node);
      }
    }

    function inspectSelectionContainer(
      node: TSESTree.Node,
      visited: Set<TSESTree.Node>,
    ): void {
      if (visited.has(node)) {
        return;
      }
      visited.add(node);

      const transparent = transparentExpression(node);
      if (transparent !== null) {
        inspectSelectionContainer(transparent, visited);
        return;
      }
      const initializer = localConstInitializer(node);
      if (initializer !== null) {
        inspectSelectionContainer(initializer, visited);
        return;
      }
      const returned = localSingleReturn(node);
      if (returned !== null) {
        inspectSelectionContainer(returned, visited);
        return;
      }
      if (node.type !== AST_NODE_TYPES.ObjectExpression) {
        return;
      }
      for (const property of node.properties) {
        if (property.type === AST_NODE_TYPES.SpreadElement) {
          inspectSelectionContainer(property.argument, visited);
        } else {
          inspectSelectedValue(property.value, visited);
        }
      }
    }

    function inspectStructuredSelection(node: TSESTree.CallExpression): void {
      if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
        return;
      }
      const method = structuredResultMethod(node.callee);
      if (method === null) {
        return;
      }
      const argumentIndex = RESULT_FIELD_ARGUMENT.get(method);
      const fields =
        argumentIndex === undefined ? undefined : node.arguments[argumentIndex];
      if (
        fields === undefined ||
        fields.type === AST_NODE_TYPES.SpreadElement
      ) {
        return;
      }
      inspectSelectionContainer(fields, new Set<TSESTree.Node>());
    }

    function inspectCompleteWrite(node: TSESTree.CallExpression): void {
      if (
        node.callee.type !== AST_NODE_TYPES.MemberExpression ||
        memberName(node.callee) !== "execute" ||
        node.arguments.length !== 1
      ) {
        return;
      }
      const query = node.arguments[0];
      if (
        query === undefined ||
        query.type !== AST_NODE_TYPES.TaggedTemplateExpression
      ) {
        return;
      }

      const source = query.quasi.quasis
        .map(quasiText)
        .join(SQL_TEMPLATE_EXPRESSION_BOUNDARY);
      const syntaxSource = sqlCodeMask(source);
      const statement = completeSqlStatement(syntaxSource);
      if (statement === undefined) {
        return;
      }
      const deleteMatch = simpleDeleteMatch(syntaxSource, statement);
      const unnestUpdateMatch =
        deleteMatch === undefined
          ? simpleUnnestUpdateMatch(source, syntaxSource, statement)
          : undefined;
      const lockingCteUpdateMatch =
        deleteMatch === undefined && unnestUpdateMatch === undefined
          ? simpleLockingCteUpdateMatch(source, syntaxSource, statement)
          : undefined;
      const upsertMatch =
        deleteMatch === undefined &&
        unnestUpdateMatch === undefined &&
        lockingCteUpdateMatch === undefined
          ? simpleUpsertMatch(source, syntaxSource, statement)
          : undefined;
      const match =
        deleteMatch ??
        unnestUpdateMatch ??
        lockingCteUpdateMatch ??
        upsertMatch;
      if (
        match === undefined ||
        !isDrizzleSqlTag(checker, services, query.tag) ||
        !isDrizzleExecuteMember(node.callee)
      ) {
        return;
      }

      const targetTableExpressionIndex = match.targetTableExpressionIndex;
      if (targetTableExpressionIndex !== undefined) {
        const targetTable = query.quasi.expressions[targetTableExpressionIndex];
        if (targetTable === undefined) {
          return;
        }
        const targetTableType = expressionType(targetTable);
        if (
          !isDrizzleTableType(
            checker,
            targetTableType.type,
            targetTableType.location,
          )
        ) {
          return;
        }
      }

      if (lockingCteUpdateMatch !== undefined) {
        const expressions = query.quasi.expressions;
        const sourceTable =
          expressions[lockingCteUpdateMatch.sourceTableExpressionIndex];
        const lockTable =
          expressions[lockingCteUpdateMatch.lockTableExpressionIndex];
        const selectedColumn =
          expressions[lockingCteUpdateMatch.selectedColumnExpressionIndex];
        const orderColumn =
          expressions[lockingCteUpdateMatch.orderColumnExpressionIndex];
        const targetTable =
          expressions[lockingCteUpdateMatch.targetTableExpressionIndex];
        if (
          sourceTable === undefined ||
          lockTable === undefined ||
          selectedColumn === undefined ||
          orderColumn === undefined ||
          targetTable === undefined
        ) {
          return;
        }
        const selectedColumnType = expressionType(selectedColumn);
        const orderColumnType = expressionType(orderColumn);
        if (
          !isDrizzleTableExpression(sourceTable) ||
          !isDrizzleTableExpression(lockTable) ||
          !isDrizzleColumnType(
            checker,
            selectedColumnType.type,
            selectedColumnType.location,
          ) ||
          !isDrizzleColumnType(
            checker,
            orderColumnType.type,
            orderColumnType.location,
          ) ||
          context.sourceCode.getText(sourceTable) !==
            context.sourceCode.getText(lockTable) ||
          context.sourceCode.getText(sourceTable) !==
            context.sourceCode.getText(targetTable) ||
          context.sourceCode.getText(selectedColumn) !==
            context.sourceCode.getText(orderColumn)
        ) {
          return;
        }
      }

      context.report({
        node: query,
        messageId:
          deleteMatch !== undefined
            ? "deleteQueryBuilder"
            : unnestUpdateMatch !== undefined
              ? "unnestUpdateQueryBuilder"
              : lockingCteUpdateMatch !== undefined
                ? "lockingCteUpdateQueryBuilder"
                : "upsertQueryBuilder",
      });
    }

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        inspectCompleteWrite(node);
        if (
          node.callee.type === AST_NODE_TYPES.MemberExpression &&
          RESULT_FIELD_ARGUMENT.has(memberName(node.callee) ?? "")
        ) {
          structuredSelectionCalls.push(node);
        }
        if (
          !isExecuteRawRowsCallee(node.callee) ||
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
          query.type !== AST_NODE_TYPES.TaggedTemplateExpression ||
          !isDrizzleSqlTag(checker, services, query.tag)
        ) {
          return;
        }
        if (
          analyzeDirectSql(query, "statement", checker, services).isSimpleSelect
        ) {
          return;
        }

        const source = query.quasi.quasis
          .map(quasiText)
          .join(SQL_TEMPLATE_EXPRESSION_BOUNDARY);
        const syntaxSource = sqlCodeMask(source);
        if (isComposedBuilderCteQuery(query)) {
          context.report({
            node: query,
            messageId: "composedCteQueryBuilder",
          });
          return;
        }
        if (
          completeScalarCteProjectionMatch(syntaxSource) &&
          query.quasi.expressions.every((expression) => {
            return isBoundScalarParameterType(expressionType(expression).type);
          })
        ) {
          context.report({ node: query, messageId: "scalarCteQueryBuilder" });
          return;
        }
        const lockingMatch = simpleLockingSelectMatch(syntaxSource);
        if (lockingMatch !== undefined) {
          const sourceTableExpressionIndex =
            lockingMatch.sourceTableExpressionIndex;
          if (sourceTableExpressionIndex !== undefined) {
            const sourceTable =
              query.quasi.expressions[sourceTableExpressionIndex];
            if (sourceTable === undefined) {
              return;
            }
            const sourceTableType = expressionType(sourceTable);
            if (
              !isDrizzleTableType(
                checker,
                sourceTableType.type,
                sourceTableType.location,
              )
            ) {
              return;
            }
          }
          const lockTableExpressionIndex =
            lockingMatch.lockTableExpressionIndex;
          if (lockTableExpressionIndex !== undefined) {
            const lockTable = query.quasi.expressions[lockTableExpressionIndex];
            if (!isDrizzleTableExpression(lockTable)) {
              return;
            }
          }
          context.report({ node: query, messageId: "lockingQueryBuilder" });
          return;
        }

        const joinedMatch = paginatedJoinedSelectMatch(
          syntaxSource,
          "schema-expression",
        );
        const existsMatch =
          joinedMatch === undefined
            ? completePaginatedExistsSelectMatch(syntaxSource)
            : undefined;
        if (joinedMatch === undefined && existsMatch === undefined) {
          return;
        }

        const structuredMatch = joinedMatch ?? existsMatch;
        if (
          structuredMatch === undefined ||
          !isSchemaBackedPaginatedJoin(query, structuredMatch)
        ) {
          return;
        }

        context.report({
          node: query,
          messageId:
            existsMatch === undefined ? "queryBuilder" : "existsQueryBuilder",
        });
      },
      TaggedTemplateExpression(node: TSESTree.TaggedTemplateExpression): void {
        const source = node.quasi.quasis
          .map(quasiText)
          .join(SQL_TEMPLATE_EXPRESSION_BOUNDARY);
        if (parenthesizedScalarSelect(source, sqlCodeMask(source))) {
          scalarQueryCandidates.add(node);
        }
      },
      "Program:exit"(): void {
        if (scalarQueryCandidates.size === 0) {
          return;
        }
        for (const call of structuredSelectionCalls) {
          inspectStructuredSelection(call);
        }
      },
    };
  },
});
