export function deriveSqlSpanName(sql: string): string | null {
  const trimmed = sql.trim();
  const opMatch = /^(SELECT|INSERT|UPDATE|DELETE|WITH|MERGE)/i.exec(trimmed);
  if (!opMatch?.[1]) {
    return null;
  }
  const op = opMatch[1].toUpperCase();
  const tableMatch =
    /\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:ONLY\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i.exec(
      trimmed,
    );
  return tableMatch ? `${op} ${tableMatch[1]}` : op;
}
