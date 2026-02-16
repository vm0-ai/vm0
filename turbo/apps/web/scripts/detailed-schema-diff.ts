#!/usr/bin/env tsx
/**
 * Detailed Schema Diff
 *
 * Connects to two test databases and compares their schemas in detail
 */

import { execSync } from "node:child_process";
import { Client } from "pg";

// Parse DATABASE_URL to get connection details
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}
const dbUrl = new URL(DATABASE_URL);
const DB_HOST = dbUrl.hostname;
const DB_PORT = dbUrl.port;
const DB_USER = dbUrl.username;
const DB_PASSWORD = dbUrl.password;

function createDbUrl(dbName: string): string {
  const auth = DB_PASSWORD ? `${DB_USER}:${DB_PASSWORD}` : DB_USER;
  return `postgresql://${auth}@${DB_HOST}:${DB_PORT}/${dbName}`;
}

interface TableColumn {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface IndexInfo {
  tablename: string;
  indexname: string;
  indexdef: string;
}

interface ConstraintInfo {
  table_name: string;
  constraint_name: string;
  constraint_type: string;
}

async function getTableColumns(client: Client): Promise<TableColumn[]> {
  const result = await client.query(`
    SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  return result.rows;
}

async function getIndexes(client: Client): Promise<IndexInfo[]> {
  const result = await client.query(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname
  `);
  return result.rows;
}

async function getConstraints(client: Client): Promise<ConstraintInfo[]> {
  const result = await client.query(`
    SELECT table_name, constraint_name, constraint_type
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
    ORDER BY table_name, constraint_name
  `);
  return result.rows;
}

function compareArrays<T>(
  arr1: T[],
  arr2: T[],
  keyFn: (item: T) => string,
): {
  added: T[];
  removed: T[];
  modified: Array<{ key: string; old: T; new: T }>;
} {
  const map1 = new Map(arr1.map((item) => [keyFn(item), item]));
  const map2 = new Map(arr2.map((item) => [keyFn(item), item]));

  const added: T[] = [];
  const removed: T[] = [];
  const modified: Array<{ key: string; old: T; new: T }> = [];

  // Find added items
  for (const [key, item] of map2) {
    if (!map1.has(key)) {
      added.push(item);
    }
  }

  // Find removed items and modifications
  for (const [key, item1] of map1) {
    const item2 = map2.get(key);
    if (!item2) {
      removed.push(item1);
    } else {
      // Check if modified
      if (JSON.stringify(item1) !== JSON.stringify(item2)) {
        modified.push({ key, old: item1, new: item2 });
      }
    }
  }

  return { added, removed, modified };
}

function printColumnDiff(
  columnDiff: ReturnType<typeof compareArrays<TableColumn>>,
): void {
  if (columnDiff.added.length > 0) {
    console.log("✨ Added columns:");
    for (const col of columnDiff.added) {
      console.log(
        `  + ${col.table_name}.${col.column_name} (${col.data_type})`,
      );
    }
    console.log();
  }

  if (columnDiff.removed.length > 0) {
    console.log("❌ Removed columns:");
    for (const col of columnDiff.removed) {
      console.log(
        `  - ${col.table_name}.${col.column_name} (${col.data_type})`,
      );
    }
    console.log();
  }

  if (columnDiff.modified.length > 0) {
    console.log("🔄 Modified columns:");
    for (const { key, old, new: newCol } of columnDiff.modified) {
      console.log(`  ~ ${key}:`);
      if (old.ordinal_position !== newCol.ordinal_position) {
        console.log(
          `    Position: ${old.ordinal_position} → ${newCol.ordinal_position}`,
        );
      }
      if (old.data_type !== newCol.data_type) {
        console.log(`    Type: ${old.data_type} → ${newCol.data_type}`);
      }
      if (old.is_nullable !== newCol.is_nullable) {
        console.log(`    Nullable: ${old.is_nullable} → ${newCol.is_nullable}`);
      }
      if (old.column_default !== newCol.column_default) {
        console.log(
          `    Default: ${old.column_default} → ${newCol.column_default}`,
        );
      }
    }
    console.log();
  }

  if (
    columnDiff.added.length === 0 &&
    columnDiff.removed.length === 0 &&
    columnDiff.modified.length === 0
  ) {
    console.log("✅ No column differences\n");
  }
}

function printIndexDiff(
  indexDiff: ReturnType<typeof compareArrays<IndexInfo>>,
): void {
  if (indexDiff.added.length > 0) {
    console.log("✨ Added indexes:");
    for (const idx of indexDiff.added) {
      console.log(`  + ${idx.indexname} on ${idx.tablename}`);
      console.log(`    ${idx.indexdef}`);
    }
    console.log();
  }

  if (indexDiff.removed.length > 0) {
    console.log("❌ Removed indexes:");
    for (const idx of indexDiff.removed) {
      console.log(`  - ${idx.indexname} on ${idx.tablename}`);
      console.log(`    ${idx.indexdef}`);
    }
    console.log();
  }

  if (indexDiff.modified.length > 0) {
    console.log("🔄 Modified indexes:");
    for (const { key, old, new: newIdx } of indexDiff.modified) {
      console.log(`  ~ ${key}:`);
      console.log(`    Old: ${old.indexdef}`);
      console.log(`    New: ${newIdx.indexdef}`);
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
  constraintDiff: ReturnType<typeof compareArrays<ConstraintInfo>>,
): void {
  if (constraintDiff.added.length > 0) {
    console.log("✨ Added constraints:");
    for (const con of constraintDiff.added) {
      console.log(
        `  + ${con.constraint_name} on ${con.table_name} (${con.constraint_type})`,
      );
    }
    console.log();
  }

  if (constraintDiff.removed.length > 0) {
    console.log("❌ Removed constraints:");
    for (const con of constraintDiff.removed) {
      console.log(
        `  - ${con.constraint_name} on ${con.table_name} (${con.constraint_type})`,
      );
    }
    console.log();
  }

  if (constraintDiff.modified.length > 0) {
    console.log("🔄 Modified constraints:");
    for (const { key, old, new: newCon } of constraintDiff.modified) {
      console.log(`  ~ ${key}:`);
      console.log(
        `    Type: ${old.constraint_type} → ${newCon.constraint_type}`,
      );
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
  const db1 = "migration_test_existing";
  const db2 = "migration_test_generated";

  console.log("🔍 Analyzing schema differences in detail...\n");

  // Check if databases exist
  try {
    execSync(
      `psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${db1} -c "SELECT 1" > /dev/null 2>&1`,
    );
  } catch {
    console.error(
      `❌ Database ${db1} does not exist. Run the main test first.`,
    );
    process.exit(1);
  }

  const client1 = new Client({ connectionString: createDbUrl(db1) });
  const client2 = new Client({ connectionString: createDbUrl(db2) });

  await client1.connect();
  await client2.connect();

  try {
    // Compare table columns
    console.log("=== 1. Comparing Table Columns ===\n");
    const columns1 = await getTableColumns(client1);
    const columns2 = await getTableColumns(client2);
    const columnDiff = compareArrays(
      columns1,
      columns2,
      (c) => `${c.table_name}.${c.column_name}`,
    );
    printColumnDiff(columnDiff);

    // Compare indexes
    console.log("=== 2. Comparing Indexes ===\n");
    const indexes1 = await getIndexes(client1);
    const indexes2 = await getIndexes(client2);
    const indexDiff = compareArrays(
      indexes1,
      indexes2,
      (i) => `${i.tablename}.${i.indexname}`,
    );
    printIndexDiff(indexDiff);

    // Compare constraints
    console.log("=== 3. Comparing Constraints ===\n");
    const constraints1 = await getConstraints(client1);
    const constraints2 = await getConstraints(client2);
    const constraintDiff = compareArrays(
      constraints1,
      constraints2,
      (c) => `${c.table_name}.${c.constraint_name}`,
    );
    printConstraintDiff(constraintDiff);

    // Summary
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

    if (totalDiffs === 0) {
      console.log("✅ No structural differences found!");
      console.log("   The schemas are functionally identical.");
    } else {
      console.log(`Found ${totalDiffs} differences:`);
      console.log(
        `  Columns: ${columnDiff.added.length} added, ${columnDiff.removed.length} removed, ${columnDiff.modified.length} modified`,
      );
      console.log(
        `  Indexes: ${indexDiff.added.length} added, ${indexDiff.removed.length} removed, ${indexDiff.modified.length} modified`,
      );
      console.log(
        `  Constraints: ${constraintDiff.added.length} added, ${constraintDiff.removed.length} removed, ${constraintDiff.modified.length} modified`,
      );
    }
  } finally {
    await client1.end();
    await client2.end();
  }
}

main().catch(console.error);
