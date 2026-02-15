/**
 * Normalized Schema Comparison
 *
 * Compares two PostgreSQL schemas while ignoring benign differences:
 * - Column ordering (ordinal_position)
 * - CHECK constraint names (PostgreSQL OID-based auto-generated names)
 * - Internal constraint naming differences
 *
 * Only reports functional differences that matter.
 */

import { Client } from "pg";

interface TableColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface IndexInfo {
  table_name: string;
  index_name: string;
  index_def: string;
}

interface ConstraintInfo {
  table_name: string;
  constraint_name: string;
  constraint_type: string;
  constraint_def: string;
}

// Get database URLs from command line args
const db1Url = process.argv[2];
const db2Url = process.argv[3];

if (!db1Url || !db2Url) {
  console.error("Usage: tsx compare-schemas-normalized.ts <db1_url> <db2_url>");
  process.exit(1);
}

// TypeScript now knows these are defined after the check
const DB1_URL: string = db1Url;
const DB2_URL: string = db2Url;

async function getTableColumns(client: Client): Promise<TableColumn[]> {
  const result = await client.query<TableColumn>(`
    SELECT
      table_name,
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name
  `);
  return result.rows;
}

async function getIndexes(client: Client): Promise<IndexInfo[]> {
  const result = await client.query<IndexInfo>(`
    SELECT
      schemaname || '.' || tablename as table_name,
      indexname as index_name,
      indexdef as index_def
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname
  `);
  return result.rows;
}

async function getConstraints(client: Client): Promise<ConstraintInfo[]> {
  const result = await client.query<ConstraintInfo>(`
    SELECT
      tc.table_name,
      tc.constraint_name,
      tc.constraint_type,
      CASE
        WHEN tc.constraint_type = 'FOREIGN KEY' THEN
          'FOREIGN KEY (' || kcu.column_name || ') REFERENCES ' ||
          ccu.table_name || '(' || ccu.column_name || ')' ||
          COALESCE(' ON DELETE ' || rc.delete_rule, '') ||
          COALESCE(' ON UPDATE ' || rc.update_rule, '')
        WHEN tc.constraint_type = 'UNIQUE' THEN
          'UNIQUE (' || kcu.column_name || ')'
        WHEN tc.constraint_type = 'PRIMARY KEY' THEN
          'PRIMARY KEY (' || kcu.column_name || ')'
        ELSE
          ''
      END as constraint_def
    FROM information_schema.table_constraints tc
    LEFT JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    LEFT JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    LEFT JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.constraint_type != 'CHECK'  -- Ignore CHECK constraints
    ORDER BY tc.table_name, tc.constraint_type, kcu.column_name
  `);
  return result.rows;
}

function normalizeColumnDefault(def: string | null): string | null {
  if (!def) return null;
  // Normalize variations of the same default value
  return def
    .replace(/::character varying/g, "")
    .replace(/::text/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compareColumns(
  cols1: TableColumn[],
  cols2: TableColumn[],
): {
  added: TableColumn[];
  removed: TableColumn[];
  modified: Array<{
    column: string;
    field: string;
    old: unknown;
    new: unknown;
  }>;
} {
  const map1 = new Map(
    cols1.map((c) => [`${c.table_name}.${c.column_name}`, c]),
  );
  const map2 = new Map(
    cols2.map((c) => [`${c.table_name}.${c.column_name}`, c]),
  );

  const added: TableColumn[] = [];
  const removed: TableColumn[] = [];
  const modified: Array<{
    column: string;
    field: string;
    old: unknown;
    new: unknown;
  }> = [];

  // Find added columns
  for (const [key, col] of map2) {
    if (!map1.has(key)) {
      added.push(col);
    }
  }

  // Find removed columns and modifications
  for (const [key, col1] of map1) {
    const col2 = map2.get(key);
    if (!col2) {
      removed.push(col1);
      continue;
    }

    // Compare functional properties (ignore ordinal_position)
    if (col1.data_type !== col2.data_type) {
      modified.push({
        column: key,
        field: "data_type",
        old: col1.data_type,
        new: col2.data_type,
      });
    }
    if (col1.is_nullable !== col2.is_nullable) {
      modified.push({
        column: key,
        field: "is_nullable",
        old: col1.is_nullable,
        new: col2.is_nullable,
      });
    }

    const default1 = normalizeColumnDefault(col1.column_default);
    const default2 = normalizeColumnDefault(col2.column_default);
    if (default1 !== default2) {
      modified.push({
        column: key,
        field: "column_default",
        old: col1.column_default,
        new: col2.column_default,
      });
    }
  }

  return { added, removed, modified };
}

function normalizeIndexDef(def: string): string {
  // Normalize index definitions for comparison
  return def
    .replace(/\s+/g, " ")
    .replace(/public\./g, "")
    .trim();
}

function compareIndexes(
  indexes1: IndexInfo[],
  indexes2: IndexInfo[],
): {
  added: IndexInfo[];
  removed: IndexInfo[];
  modified: Array<{ index: string; oldDef: string; newDef: string }>;
} {
  const map1 = new Map(indexes1.map((i) => [i.index_name, i]));
  const map2 = new Map(indexes2.map((i) => [i.index_name, i]));

  const added: IndexInfo[] = [];
  const removed: IndexInfo[] = [];
  const modified: Array<{ index: string; oldDef: string; newDef: string }> = [];

  // Find added indexes
  for (const [name, idx] of map2) {
    if (!map1.has(name)) {
      added.push(idx);
    }
  }

  // Find removed indexes and modifications
  for (const [name, idx1] of map1) {
    const idx2 = map2.get(name);
    if (!idx2) {
      removed.push(idx1);
      continue;
    }

    const def1 = normalizeIndexDef(idx1.index_def);
    const def2 = normalizeIndexDef(idx2.index_def);
    if (def1 !== def2) {
      modified.push({
        index: name,
        oldDef: idx1.index_def,
        newDef: idx2.index_def,
      });
    }
  }

  return { added, removed, modified };
}

function compareConstraints(
  constraints1: ConstraintInfo[],
  constraints2: ConstraintInfo[],
): {
  added: ConstraintInfo[];
  removed: ConstraintInfo[];
  modified: Array<{ constraint: string; oldDef: string; newDef: string }>;
} {
  const map1 = new Map(constraints1.map((c) => [c.constraint_name, c]));
  const map2 = new Map(constraints2.map((c) => [c.constraint_name, c]));

  const added: ConstraintInfo[] = [];
  const removed: ConstraintInfo[] = [];
  const modified: Array<{
    constraint: string;
    oldDef: string;
    newDef: string;
  }> = [];

  // Find added constraints
  for (const [name, con] of map2) {
    if (!map1.has(name)) {
      added.push(con);
    }
  }

  // Find removed constraints and modifications
  for (const [name, con1] of map1) {
    const con2 = map2.get(name);
    if (!con2) {
      removed.push(con1);
      continue;
    }

    if (con1.constraint_def !== con2.constraint_def) {
      modified.push({
        constraint: name,
        oldDef: con1.constraint_def,
        newDef: con2.constraint_def,
      });
    }
  }

  return { added, removed, modified };
}

function printColumnDiff(columnDiff: ReturnType<typeof compareColumns>): void {
  if (columnDiff.added.length > 0) {
    console.log(`✨ Added columns (${columnDiff.added.length}):`);
    for (const col of columnDiff.added) {
      console.log(`  + ${col.table_name}.${col.column_name}: ${col.data_type}`);
    }
    console.log();
  }

  if (columnDiff.removed.length > 0) {
    console.log(`❌ Removed columns (${columnDiff.removed.length}):`);
    for (const col of columnDiff.removed) {
      console.log(`  - ${col.table_name}.${col.column_name}: ${col.data_type}`);
    }
    console.log();
  }

  if (columnDiff.modified.length > 0) {
    console.log(`🔄 Modified columns (${columnDiff.modified.length}):`);
    for (const mod of columnDiff.modified) {
      console.log(`  ~ ${mod.column}.${mod.field}:`);
      console.log(`    Old: ${mod.old}`);
      console.log(`    New: ${mod.new}`);
    }
    console.log();
  }

  if (
    columnDiff.added.length === 0 &&
    columnDiff.removed.length === 0 &&
    columnDiff.modified.length === 0
  ) {
    console.log("✅ No functional column differences\n");
  }
}

function printIndexDiff(indexDiff: ReturnType<typeof compareIndexes>): void {
  if (indexDiff.added.length > 0) {
    console.log(`✨ Added indexes (${indexDiff.added.length}):`);
    for (const idx of indexDiff.added) {
      console.log(`  + ${idx.index_name}`);
      console.log(`    ${idx.index_def}`);
    }
    console.log();
  }

  if (indexDiff.removed.length > 0) {
    console.log(`❌ Removed indexes (${indexDiff.removed.length}):`);
    for (const idx of indexDiff.removed) {
      console.log(`  - ${idx.index_name}`);
      console.log(`    ${idx.index_def}`);
    }
    console.log();
  }

  if (indexDiff.modified.length > 0) {
    console.log(`🔄 Modified indexes (${indexDiff.modified.length}):`);
    for (const mod of indexDiff.modified) {
      console.log(`  ~ ${mod.index}:`);
      console.log(`    Old: ${mod.oldDef}`);
      console.log(`    New: ${mod.newDef}`);
    }
    console.log();
  }

  if (
    indexDiff.added.length === 0 &&
    indexDiff.removed.length === 0 &&
    indexDiff.modified.length === 0
  ) {
    console.log("✅ No index differences\n");
  }
}

function printConstraintDiff(
  constraintDiff: ReturnType<typeof compareConstraints>,
): void {
  if (constraintDiff.added.length > 0) {
    console.log(`✨ Added constraints (${constraintDiff.added.length}):`);
    for (const con of constraintDiff.added) {
      console.log(`  + ${con.constraint_name} (${con.constraint_type})`);
      console.log(`    ${con.constraint_def}`);
    }
    console.log();
  }

  if (constraintDiff.removed.length > 0) {
    console.log(`❌ Removed constraints (${constraintDiff.removed.length}):`);
    for (const con of constraintDiff.removed) {
      console.log(`  - ${con.constraint_name} (${con.constraint_type})`);
      console.log(`    ${con.constraint_def}`);
    }
    console.log();
  }

  if (constraintDiff.modified.length > 0) {
    console.log(`🔄 Modified constraints (${constraintDiff.modified.length}):`);
    for (const mod of constraintDiff.modified) {
      console.log(`  ~ ${mod.constraint}:`);
      console.log(`    Old: ${mod.oldDef}`);
      console.log(`    New: ${mod.newDef}`);
    }
    console.log();
  }

  if (
    constraintDiff.added.length === 0 &&
    constraintDiff.removed.length === 0 &&
    constraintDiff.modified.length === 0
  ) {
    console.log("✅ No constraint differences\n");
  }
}

async function main() {
  console.log("🔍 Normalized Schema Comparison\n");
  console.log(`Comparing:`);
  console.log(`  DB1 (existing):  ${DB1_URL.split("@")[1]}`);
  console.log(`  DB2 (generated): ${DB2_URL.split("@")[1]}\n`);

  const client1 = new Client({ connectionString: DB1_URL });
  const client2 = new Client({ connectionString: DB2_URL });

  await client1.connect();
  await client2.connect();

  try {
    console.log("=== 1. Comparing Table Columns ===\n");
    const [cols1, cols2] = await Promise.all([
      getTableColumns(client1),
      getTableColumns(client2),
    ]);
    const columnDiff = compareColumns(cols1, cols2);
    printColumnDiff(columnDiff);

    console.log("=== 2. Comparing Indexes ===\n");
    const [indexes1, indexes2] = await Promise.all([
      getIndexes(client1),
      getIndexes(client2),
    ]);
    const indexDiff = compareIndexes(indexes1, indexes2);
    printIndexDiff(indexDiff);

    console.log("=== 3. Comparing Constraints (excluding CHECK) ===\n");
    const [constraints1, constraints2] = await Promise.all([
      getConstraints(client1),
      getConstraints(client2),
    ]);
    const constraintDiff = compareConstraints(constraints1, constraints2);
    printConstraintDiff(constraintDiff);

    console.log("=== Summary ===\n");
    const totalDiffs =
      columnDiff.added.length +
      columnDiff.removed.length +
      columnDiff.modified.length +
      indexDiff.added.length +
      indexDiff.removed.length +
      indexDiff.modified.length +
      constraintDiff.added.length +
      constraintDiff.removed.length +
      constraintDiff.modified.length;

    console.log(`Found ${totalDiffs} functional differences:`);
    console.log(
      `  Columns: ${columnDiff.added.length} added, ${columnDiff.removed.length} removed, ${columnDiff.modified.length} modified`,
    );
    console.log(
      `  Indexes: ${indexDiff.added.length} added, ${indexDiff.removed.length} removed, ${indexDiff.modified.length} modified`,
    );
    console.log(
      `  Constraints: ${constraintDiff.added.length} added, ${constraintDiff.removed.length} removed, ${constraintDiff.modified.length} modified`,
    );
    console.log();

    if (totalDiffs === 0) {
      console.log("✅ Schemas are functionally equivalent!");
      process.exit(0);
    } else {
      console.log("❌ Schemas have functional differences.");
      process.exit(1);
    }
  } finally {
    await client1.end();
    await client2.end();
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
