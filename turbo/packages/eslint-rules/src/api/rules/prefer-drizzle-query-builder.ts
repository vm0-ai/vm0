import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";

import {
  isDrizzleColumnType,
  isDrizzleDeclaration,
  isDrizzleTableType,
} from "../drizzle.ts";
import {
  SQL_TEMPLATE_EXPRESSION_BOUNDARY,
  sqlCodeMask,
} from "../sql-lexing.ts";
import {
  createSqlSourceComposer,
  type LegacySqlSource,
  renderLegacySqlSource,
} from "../sql-analysis/sql-source.ts";
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

interface SimpleLockingSelectMatch {
  readonly lockTableExpressionIndex: number | undefined;
  readonly sourceTableEnd: number;
  readonly sourceTableExpressionIndex: number | undefined;
  readonly sourceTableStart: number;
}

interface SimpleLockingCteUpdateMatch {
  readonly lockTableExpressionIndex: number;
  readonly orderColumnExpressionIndex: number;
  readonly selectedColumnExpressionIndex: number;
  readonly sourceTableExpressionIndex: number;
  readonly targetTableExpressionIndex: number;
}

interface SimpleDeleteMatch {
  readonly targetTableEnd: number;
  readonly targetTableExpressionIndex: number | undefined;
  readonly targetTableStart: number;
}

interface SimpleUnnestUpdateMatch {
  readonly targetTableExpressionIndex: number;
}

interface SimpleUpsertMatch {
  readonly targetTableEnd: number;
  readonly targetTableExpressionIndex: number | undefined;
  readonly targetTableStart: number;
}

interface CompleteSqlStatement {
  readonly end: number;
  readonly hasTrailingSemicolon: boolean;
  readonly tokens: readonly SqlToken[];
}

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

const SIMPLE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/u;
const SIMPLE_OR_QUOTED_IDENTIFIER_PATTERN =
  /^(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:""|[^"])+")$/u;

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
    targetTableEnd: targetTable.end,
    targetTableExpressionIndex:
      targetTable.kind === "expression"
        ? targetTable.expressionIndex
        : undefined,
    targetTableStart: targetTable.start,
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
    targetTableEnd: targetTable.end,
    targetTableExpressionIndex:
      targetTable.kind === "expression"
        ? targetTable.expressionIndex
        : undefined,
    targetTableStart: targetTable.start,
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
    sourceTableEnd: sourceTable.end,
    sourceTableExpressionIndex:
      sourceTable.kind === "expression"
        ? sourceTable.expressionIndex
        : undefined,
    sourceTableStart: sourceTable.start,
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

export const preferDrizzleQueryBuilder = createRule({
  name: "prefer-drizzle-query-builder",
  defaultOptions: [],
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer Drizzle query builders for complete schema-backed deletes, updates, and upserts",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      deleteQueryBuilder:
        "Use a Drizzle delete builder for this complete single-target query.",
      lockingCteUpdateQueryBuilder:
        "Use Drizzle $with(...), select().for(...), and update().from(...) builders for this complete locking CTE update.",
      unnestUpdateQueryBuilder:
        "Use a Drizzle update builder with .from(...) for this complete unnest-backed update.",
      upsertQueryBuilder:
        "Use a Drizzle insert builder with .onConflictDoUpdate(...) for this complete single-row upsert.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const completeSqlInspections: Array<() => void> = [];
    const drizzleExecuteMemberCache = new WeakMap<
      TSESTree.MemberExpression,
      boolean
    >();

    function isDrizzleExecuteMember(node: TSESTree.MemberExpression): boolean {
      if (memberName(node) !== "execute") {
        return false;
      }
      const cached = drizzleExecuteMemberCache.get(node);
      if (cached !== undefined) {
        return cached;
      }
      const tsProperty = services.esTreeNodeToTSNodeMap.get(node.property);
      const result =
        checker
          .getSymbolAtLocation(tsProperty)
          ?.declarations?.some(isDrizzleDeclaration) === true;
      drizzleExecuteMemberCache.set(node, result);
      return result;
    }

    function isSafeSqlTerminalUse(node: TSESTree.Expression): boolean {
      const parent = node.parent;
      return (
        parent.type === AST_NODE_TYPES.CallExpression &&
        parent.arguments.length === 1 &&
        parent.arguments[0] === node &&
        parent.callee.type === AST_NODE_TYPES.MemberExpression &&
        isDrizzleExecuteMember(parent.callee)
      );
    }

    const sqlSourceComposer = createSqlSourceComposer(
      context.sourceCode,
      checker,
      services,
      isSafeSqlTerminalUse,
    );

    function expressionType(node: TSESTree.Expression) {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return {
        location: tsNode,
        type: checker.getTypeAtLocation(tsNode),
      };
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

    function writeVariantMessage(
      rendered: LegacySqlSource,
    ):
      | "deleteQueryBuilder"
      | "lockingCteUpdateQueryBuilder"
      | "unnestUpdateQueryBuilder"
      | "upsertQueryBuilder"
      | null {
      const syntaxSource = sqlCodeMask(rendered.source);
      const statement = completeSqlStatement(syntaxSource);
      if (statement === undefined) {
        return null;
      }
      const deleteMatch = simpleDeleteMatch(syntaxSource, statement);
      const unnestUpdateMatch =
        deleteMatch === undefined
          ? simpleUnnestUpdateMatch(rendered.source, syntaxSource, statement)
          : undefined;
      const lockingCteUpdateMatch =
        deleteMatch === undefined && unnestUpdateMatch === undefined
          ? simpleLockingCteUpdateMatch(
              rendered.source,
              syntaxSource,
              statement,
            )
          : undefined;
      const upsertMatch =
        deleteMatch === undefined &&
        unnestUpdateMatch === undefined &&
        lockingCteUpdateMatch === undefined
          ? simpleUpsertMatch(rendered.source, syntaxSource, statement)
          : undefined;
      const match =
        deleteMatch ??
        unnestUpdateMatch ??
        lockingCteUpdateMatch ??
        upsertMatch;
      if (match === undefined) {
        return null;
      }

      const targetTableExpressionIndex = match.targetTableExpressionIndex;
      const literalTarget =
        deleteMatch !== undefined &&
        deleteMatch.targetTableExpressionIndex === undefined
          ? deleteMatch
          : upsertMatch !== undefined &&
              upsertMatch.targetTableExpressionIndex === undefined
            ? upsertMatch
            : undefined;
      if (
        literalTarget !== undefined &&
        rendered.literalRanges.some((range) => {
          return (
            range.depth > 0 &&
            range.start < literalTarget.targetTableEnd &&
            range.end > literalTarget.targetTableStart
          );
        })
      ) {
        return null;
      }
      if (targetTableExpressionIndex !== undefined) {
        const targetTable = rendered.expressions[targetTableExpressionIndex];
        if (targetTable === undefined) {
          return null;
        }
        const targetTableType = expressionType(targetTable);
        if (
          !isDrizzleTableType(
            checker,
            targetTableType.type,
            targetTableType.location,
          )
        ) {
          return null;
        }
      }

      if (lockingCteUpdateMatch !== undefined) {
        const expressions = rendered.expressions;
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
          return null;
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
          return null;
        }
      }

      return deleteMatch !== undefined
        ? "deleteQueryBuilder"
        : unnestUpdateMatch !== undefined
          ? "unnestUpdateQueryBuilder"
          : lockingCteUpdateMatch !== undefined
            ? "lockingCteUpdateQueryBuilder"
            : "upsertQueryBuilder";
    }

    function scheduleCompleteWriteInspection(
      node: TSESTree.CallExpression,
    ): void {
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
        query.type === AST_NODE_TYPES.SpreadElement ||
        !sqlSourceComposer.couldCompose(query)
      ) {
        return;
      }
      const executeMember = node.callee;
      completeSqlInspections.push(() => {
        if (!isDrizzleExecuteMember(executeMember)) {
          return;
        }
        const source = sqlSourceComposer.compose(query);
        if (source === null) {
          return;
        }
        const messages = source.variants.map((variant) => {
          return writeVariantMessage(renderLegacySqlSource(variant));
        });
        const messageId = messages[0];
        if (
          messageId === undefined ||
          messageId === null ||
          messages.some((message) => {
            return message !== messageId;
          })
        ) {
          return;
        }
        context.report({ node: query, messageId });
      });
    }

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        scheduleCompleteWriteInspection(node);
      },
      "Program:exit"(): void {
        for (const inspect of completeSqlInspections) {
          inspect();
        }
      },
    };
  },
});
