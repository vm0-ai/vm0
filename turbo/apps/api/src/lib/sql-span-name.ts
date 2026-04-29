// pg's default span name is "pg.query:SELECT <db>" — too generic to slice on.
// Pull the operation + first referenced table out of the parameterized SQL so
// RED metrics can group by a readable label. `db.statement` still carries the
// full parameterized SQL when the exact template matters.
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
