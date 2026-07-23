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
  isImportDeclaration,
  isImportSpecifier,
  isNamespaceImport,
  isReturnStatement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  NodeFlags,
  SyntaxKind,
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
import {
  SQL_TEMPLATE_EXPRESSION_BOUNDARY,
  sqlCodeMask,
} from "../sql-lexing.ts";
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

interface SimpleSelectMatch {
  readonly joinConditionExpressionIndexes: readonly number[];
  readonly joinTableExpressionIndexes: readonly number[];
  readonly selectedColumnExpressionIndex: number;
  readonly sourceTableExpressionIndex: number;
}

interface SimpleLockingSelectMatch {
  readonly sourceTableExpressionIndex: number | undefined;
}

interface SimpleDeleteMatch {
  readonly targetTableExpressionIndex: number | undefined;
}

interface SimpleUpsertMatch {
  readonly targetTableExpressionIndex: number | undefined;
}

interface CompleteSqlStatement {
  readonly end: number;
  readonly tokens: readonly SqlToken[];
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

const UNSUPPORTED_UPSERT_ASSIGNMENT_KEYWORDS = new Set(["RETURNING", "WHERE"]);

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

function importSource(node: Node): string | undefined {
  let current: Node | undefined = node;
  while (current !== undefined && !isImportDeclaration(current)) {
    current = current.parent;
  }
  return current !== undefined && isStringLiteral(current.moduleSpecifier)
    ? current.moduleSpecifier.text.replaceAll("\\", "/")
    : undefined;
}

function isRawRowsModule(source: string | undefined): boolean {
  return (
    source !== undefined &&
    /(?:^|\/)lib\/db-raw-rows(?:\.[cm]?[jt]s)?$/.test(source)
  );
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
  let statementEnd = syntaxSource.length;
  const trailingToken = tokens[end - 1];
  if (isPunctuation(trailingToken, ";")) {
    if (
      trailingToken === undefined ||
      syntaxSource.slice(trailingToken.end).trim() !== ""
    ) {
      return undefined;
    }
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

  return { end: statementEnd, tokens: statementTokens };
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
    const target = syntaxSource.slice(segment.start, assignmentOffset).trim();
    const value = source.slice(assignmentOffset + 1, segment.end).trim();
    return /^[A-Za-z_][A-Za-z0-9_$]*$/u.test(target) && value !== "";
  });
}

function simpleDeleteMatch(
  syntaxSource: string,
  tokens: readonly SqlToken[],
): SimpleDeleteMatch | undefined {
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
    !hasSimpleAssignments(source, syntaxSource, setKeyword.end, statement.end)
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

  let lockStart = end - 2;
  let lockTokens = tokens.slice(lockStart, end);
  if (
    lockTokens.length !== 2 ||
    !isWord(lockTokens[0], "FOR") ||
    !isWord(lockTokens[1], "UPDATE")
  ) {
    lockStart = end - 4;
    lockTokens = tokens.slice(lockStart, end);
    if (
      lockTokens.length !== 4 ||
      !isWord(lockTokens[0], "FOR") ||
      !isWord(lockTokens[1], "UPDATE") ||
      !isWord(lockTokens[2], "SKIP") ||
      !isWord(lockTokens[3], "LOCKED")
    ) {
      return undefined;
    }
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
    sourceTableExpressionIndex:
      sourceTable.kind === "expression"
        ? sourceTable.expressionIndex
        : undefined,
  };
}

function simpleSelectMatch(
  source: string,
  syntaxSource: string,
): SimpleSelectMatch | undefined {
  const tokens = topLevelTokens(syntaxSource);
  if (tokens === undefined) {
    return undefined;
  }

  let cursor = 0;
  if (!isWord(tokens[cursor], "SELECT")) {
    return undefined;
  }
  cursor += 1;
  const selectedColumnExpressionIndex = expressionIndex(tokens[cursor]);
  if (selectedColumnExpressionIndex === undefined) {
    return undefined;
  }
  cursor += 1;

  if (isWord(tokens[cursor], "AS")) {
    const aliasKeyword = tokens[cursor];
    cursor += 1;
    if (tokens[cursor]?.kind === "word" && !isWord(tokens[cursor], "FROM")) {
      cursor += 1;
    } else {
      const from = tokens[cursor];
      if (
        aliasKeyword === undefined ||
        from === undefined ||
        !isWord(from, "FROM") ||
        !/^"(?:[^"]|"")+"$/s.test(
          source.slice(aliasKeyword.end, from.start).trim(),
        )
      ) {
        return undefined;
      }
    }
  }

  if (!isWord(tokens[cursor], "FROM")) {
    return undefined;
  }
  cursor += 1;
  const sourceTableExpressionIndex = expressionIndex(tokens[cursor]);
  if (sourceTableExpressionIndex === undefined) {
    return undefined;
  }
  cursor += 1;

  const joinTableExpressionIndexes: number[] = [];
  const joinConditionExpressionIndexes: number[] = [];
  while (isWord(tokens[cursor], "INNER")) {
    cursor += 1;
    if (!isWord(tokens[cursor], "JOIN")) {
      return undefined;
    }
    cursor += 1;
    const joinTableIndex = expressionIndex(tokens[cursor]);
    if (joinTableIndex === undefined) {
      return undefined;
    }
    joinTableExpressionIndexes.push(joinTableIndex);
    cursor += 1;
    if (!isWord(tokens[cursor], "ON")) {
      return undefined;
    }
    cursor += 1;
    const joinConditionIndex = expressionIndex(tokens[cursor]);
    if (joinConditionIndex === undefined) {
      return undefined;
    }
    joinConditionExpressionIndexes.push(joinConditionIndex);
    cursor += 1;
  }

  if (!isWord(tokens[cursor], "WHERE")) {
    return undefined;
  }
  cursor += 1;

  let end = tokens.length;
  const trailingToken = tokens[end - 1];
  if (trailingToken?.kind === "punctuation" && trailingToken.value === ";") {
    end -= 1;
  }
  const limitKeywordIndex = end - 2;
  const limitValue = tokens[limitKeywordIndex + 1];
  if (
    cursor >= limitKeywordIndex ||
    !isWord(tokens[limitKeywordIndex], "LIMIT") ||
    limitValue?.kind !== "number" ||
    limitValue.value !== "1"
  ) {
    return undefined;
  }
  for (let index = cursor; index < limitKeywordIndex; index += 1) {
    const token = tokens[index];
    if (
      token === undefined ||
      (token.kind === "word" &&
        UNSUPPORTED_TOP_LEVEL_WHERE_KEYWORDS.has(token.value)) ||
      (token.kind === "punctuation" && token.value === ";")
    ) {
      return undefined;
    }
  }

  return {
    joinConditionExpressionIndexes,
    joinTableExpressionIndexes,
    selectedColumnExpressionIndex,
    sourceTableExpressionIndex,
  };
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
        "Prefer Drizzle query builders for complete simple deletes, upserts, selects, locking selects, and scalar result queries",
      recommended: true,
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      queryBuilder:
        "Use a Drizzle select builder for this complete schema-backed query.",
      lockingQueryBuilder:
        "Use a Drizzle select builder with .for(...) for this complete locking query.",
      deleteQueryBuilder:
        "Use a Drizzle delete builder for this complete single-target query.",
      upsertQueryBuilder:
        "Use a Drizzle insert builder with .onConflictDoUpdate(...) for this complete single-row upsert.",
      structuredScalarQuery:
        "Use a Drizzle query builder or joined relation instead of a complete raw scalar query in a structured result field.",
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const directRawRowsBindings = new Set<string>();
    const rawRowsNamespaces = new Set<string>();
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

    for (const statement of context.sourceCode.ast.body) {
      if (
        statement.type !== AST_NODE_TYPES.ImportDeclaration ||
        typeof statement.source.value !== "string" ||
        !isRawRowsModule(statement.source.value)
      ) {
        continue;
      }
      for (const specifier of statement.specifiers) {
        if (
          specifier.type === AST_NODE_TYPES.ImportSpecifier &&
          ((specifier.imported.type === AST_NODE_TYPES.Identifier &&
            specifier.imported.name === "executeRawRows") ||
            (specifier.imported.type === AST_NODE_TYPES.Literal &&
              specifier.imported.value === "executeRawRows"))
        ) {
          directRawRowsBindings.add(specifier.local.name);
        } else if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
          rawRowsNamespaces.add(specifier.local.name);
        }
      }
    }

    function isExecuteRawRowsCallee(node: TSESTree.Expression): boolean {
      if (node.type === AST_NODE_TYPES.Identifier) {
        if (!directRawRowsBindings.has(node.name)) {
          return false;
        }
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const symbol = checker.getSymbolAtLocation(tsNode);
        return (
          symbol?.declarations?.some((declaration) => {
            return (
              isImportSpecifier(declaration) &&
              (declaration.propertyName?.text ?? declaration.name.text) ===
                "executeRawRows" &&
              isRawRowsModule(importSource(declaration))
            );
          }) === true
        );
      }
      if (
        node.type !== AST_NODE_TYPES.MemberExpression ||
        memberName(node) !== "executeRawRows" ||
        node.object.type !== AST_NODE_TYPES.Identifier ||
        !rawRowsNamespaces.has(node.object.name)
      ) {
        return false;
      }
      const tsObject = services.esTreeNodeToTSNodeMap.get(node.object);
      const symbol = checker.getSymbolAtLocation(tsObject);
      return (
        symbol?.declarations?.some((declaration) => {
          return (
            isNamespaceImport(declaration) &&
            isRawRowsModule(importSource(declaration))
          );
        }) === true
      );
    }

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
      const deleteMatch = simpleDeleteMatch(syntaxSource, statement.tokens);
      const upsertMatch =
        deleteMatch === undefined
          ? simpleUpsertMatch(source, syntaxSource, statement)
          : undefined;
      const match = deleteMatch ?? upsertMatch;
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

      context.report({
        node: query,
        messageId:
          deleteMatch === undefined
            ? "upsertQueryBuilder"
            : "deleteQueryBuilder",
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

        const source = query.quasi.quasis
          .map(quasiText)
          .join(SQL_TEMPLATE_EXPRESSION_BOUNDARY);
        const syntaxSource = sqlCodeMask(source);
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
          context.report({ node: query, messageId: "lockingQueryBuilder" });
          return;
        }

        const match = simpleSelectMatch(source, syntaxSource);
        if (match === undefined) {
          return;
        }

        const selectedColumn =
          query.quasi.expressions[match.selectedColumnExpressionIndex];
        const sourceTable =
          query.quasi.expressions[match.sourceTableExpressionIndex];
        if (selectedColumn === undefined || sourceTable === undefined) {
          return;
        }
        const selectedColumnType = expressionType(selectedColumn);
        const sourceTableType = expressionType(sourceTable);
        if (
          !isDrizzleColumnType(
            checker,
            selectedColumnType.type,
            selectedColumnType.location,
          ) ||
          !isDrizzleTableType(
            checker,
            sourceTableType.type,
            sourceTableType.location,
          ) ||
          !match.joinTableExpressionIndexes.every((index) => {
            const expression = query.quasi.expressions[index];
            if (expression === undefined) {
              return false;
            }
            const expressionValue = expressionType(expression);
            return isDrizzleTableType(
              checker,
              expressionValue.type,
              expressionValue.location,
            );
          }) ||
          !match.joinConditionExpressionIndexes.every((index) => {
            const expression = query.quasi.expressions[index];
            return (
              expression !== undefined &&
              isDrizzleWrapperType(checker, expressionType(expression).type)
            );
          })
        ) {
          return;
        }

        context.report({ node: query, messageId: "queryBuilder" });
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
