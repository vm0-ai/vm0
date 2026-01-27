# Table Formatting

## Standard Table Pattern

Tables are constructed manually with dynamic column widths:

```typescript
// 1. Calculate column widths based on content
const nameWidth = Math.max(4, ...items.map((i) => i.name.length));
const sizeWidth = Math.max(4, ...items.map((i) => formatBytes(i.size).length));

// 2. Print header in dim
const header = [
  "NAME".padEnd(nameWidth),
  "SIZE".padStart(sizeWidth),    // Right-align numbers
  "UPDATED",
].join("  ");                     // Two spaces between columns
console.log(chalk.dim(header));

// 3. Print rows
for (const item of items) {
  const row = [
    item.name.padEnd(nameWidth),
    formatBytes(item.size).padStart(sizeWidth),
    formatRelativeTime(item.updatedAt),
  ].join("  ");
  console.log(row);
}
```

## Column Alignment

### Text Columns: Left-Aligned

```typescript
name.padEnd(nameWidth)       // Left-align with padEnd
status.padEnd(statusWidth)
```

### Numeric Columns: Right-Aligned

```typescript
formatBytes(size).padStart(sizeWidth)     // Right-align with padStart
String(count).padStart(countWidth)
```

## Column Spacing

Always use **two spaces** between columns:

```typescript
const row = [col1, col2, col3].join("  ");  // Two spaces
```

## Empty State Handling

Always check for empty data before rendering table:

```typescript
if (items.length === 0) {
  console.log(chalk.dim("No volumes found"));
  console.log(chalk.dim("  Create one with: vm0 volume init && vm0 volume push"));
  return;
}

// Only render table if items exist
const nameWidth = Math.max(4, ...items.map((i) => i.name.length));
// ...
```

## Placeholder Values

Use `chalk.dim("-")` for missing or null values:

```typescript
const version = item.headVersionId
  ? item.headVersionId.slice(0, 8)
  : chalk.dim("-");
```

## Complete Example

```typescript
export async function listVolumes(): Promise<void> {
  const volumes = await getVolumes();

  // Empty state
  if (volumes.length === 0) {
    console.log(chalk.dim("No volumes found"));
    console.log(chalk.dim("  Create one with: vm0 volume init && vm0 volume push"));
    return;
  }

  // Calculate column widths
  const nameWidth = Math.max(4, ...volumes.map((v) => v.name.length));
  const sizeWidth = Math.max(4, ...volumes.map((v) => formatBytes(v.size).length));

  // Print header
  const header = [
    "NAME".padEnd(nameWidth),
    "SIZE".padStart(sizeWidth),
    "UPDATED",
  ].join("  ");
  console.log(chalk.dim(header));

  // Print rows
  for (const volume of volumes) {
    const row = [
      volume.name.padEnd(nameWidth),
      formatBytes(volume.size).padStart(sizeWidth),
      formatRelativeTime(volume.updatedAt),
    ].join("  ");
    console.log(row);
  }
}
```

## Status Columns

For status indicators, use appropriate colors:

```typescript
const status = schedule.enabled
  ? chalk.green("enabled")
  : chalk.yellow("disabled");

const row = [
  schedule.name.padEnd(nameWidth),
  status.padEnd(statusWidth),
  schedule.cron.padEnd(cronWidth),
  nextRun,
].join("  ");
```

## Summary/Total Rows

For tables with totals, use a separator and bold text:

```typescript
// Print separator
console.log(chalk.dim("─".repeat(totalWidth)));

// Print totals
console.log(
  `${"TOTAL".padEnd(nameWidth)}${totalCount.padStart(countWidth)}    ${totalTime}`
);
```

## Anti-Patterns

### Hardcoded Widths

```typescript
// ❌ Wrong - hardcoded widths
const row = `${name.padEnd(20)}  ${size.padStart(10)}`;

// ✅ Correct - dynamic widths
const nameWidth = Math.max(4, ...items.map((i) => i.name.length));
const row = `${name.padEnd(nameWidth)}  ${size.padStart(sizeWidth)}`;
```

### Inconsistent Spacing

```typescript
// ❌ Wrong - mixed spacing
const row = `${col1} ${col2}   ${col3}`;

// ✅ Correct - consistent two-space
const row = [col1, col2, col3].join("  ");
```

### Missing Empty State

```typescript
// ❌ Wrong - crashes on empty array
const nameWidth = Math.max(4, ...items.map((i) => i.name.length));
// Error: Math.max with no arguments

// ✅ Correct - check first
if (items.length === 0) {
  console.log(chalk.dim("No items found"));
  return;
}
```

### Header Not Dim

```typescript
// ❌ Wrong - header same style as data
console.log("NAME  SIZE  UPDATED");

// ✅ Correct - header in dim
console.log(chalk.dim("NAME  SIZE  UPDATED"));
```

## Alternative List Format

For hierarchical data, use an indented list format:

```typescript
console.log(chalk.bold("Model Providers:"));
console.log();

for (const [framework, providers] of Object.entries(byFramework)) {
  console.log(`  ${chalk.cyan(framework)}:`);
  for (const provider of providers) {
    const defaultMark = provider.isDefault ? chalk.green(" (default)") : "";
    console.log(`    - ${provider.type}${defaultMark}`);
  }
}

console.log();
console.log(chalk.dim(`Total: ${count} provider(s)`));
```

**Note**: This format is acceptable for hierarchical data but standard table format is preferred for flat lists.
