# Colors & Symbols

## Symbol Standards

The CLI uses Unicode symbols for visual feedback. **Never use ASCII alternatives.**

### Success Symbol: `✓`

```typescript
// ✅ Correct
console.log(chalk.green("✓ Created successfully"));
console.log(chalk.green("✓ Upload complete"));
console.log(chalk.green("✓ Authenticated"));

// ❌ Wrong - ASCII checkmark or other variations
console.log(chalk.green("Done Created successfully"));
console.log(chalk.green("OK Created successfully"));
console.log(chalk.green("[OK] Created successfully"));
```

### Error Symbol: `✗`

The error symbol is Unicode `✗` (U+2717), **not** lowercase `x`.

```typescript
// ✅ Correct
console.error(chalk.red("✗ Not authenticated"));
console.error(chalk.red("✗ File not found"));
console.error(chalk.red("✗ Invalid format"));

// ❌ Wrong - lowercase x
console.error(chalk.red("x Not authenticated"));

// ❌ Wrong - "Error:" prefix
console.error(chalk.red("Error: Not authenticated"));

// ❌ Wrong - other variations
console.error(chalk.red("[ERROR] Not authenticated"));
console.error(chalk.red("FAILED: Not authenticated"));
```

### Warning Symbol: `⚠`

```typescript
// ✅ Correct
console.log(chalk.yellow("⚠ Field 'image' is deprecated"));
console.log(chalk.yellow("⚠ This action cannot be undone"));

// ❌ Wrong
console.log(chalk.yellow("Warning: Field deprecated"));
console.log(chalk.yellow("[WARN] Field deprecated"));
```

### Started Symbol: `▶`

Used with `chalk.bold()` for operation start messages.

```typescript
// ✅ Correct
console.log(chalk.bold("▶ Run started"));
console.log(chalk.bold("▶ Processing files"));

// ❌ Wrong
console.log(chalk.bold("Starting run..."));
console.log(chalk.bold("[START] Run started"));
```

## Color Semantics

### Red: Errors Only

```typescript
// ✅ Correct - error messages
console.error(chalk.red("✗ Authentication failed"));
console.error(chalk.red("✗ Invalid configuration"));

// ❌ Wrong - using red for non-errors
console.log(chalk.red("Important notice"));  // Use yellow for warnings
```

### Green: Success Only

```typescript
// ✅ Correct - success messages
console.log(chalk.green("✓ Deployed successfully"));
console.log(chalk.green("enabled"));  // Status indicator

// ❌ Wrong - using green for non-success
console.log(chalk.green("Processing..."));  // Use dim for progress
```

### Yellow: Warnings and Disabled Status

```typescript
// ✅ Correct - warnings
console.log(chalk.yellow("⚠ API key will expire soon"));
console.log(chalk.yellow("disabled"));  // Status indicator

// Already initialized (not an error, but noteworthy)
console.log(chalk.yellow(`Volume already initialized: ${name}`));
```

### Cyan: Commands and Code

```typescript
// ✅ Correct - command examples
console.log(chalk.cyan("  vm0 auth login"));
console.log(chalk.cyan("  vm0 compose <file>"));

// Code snippets
console.log(chalk.cyan(`  environment:`));
console.log(chalk.cyan(`    KEY: \${{ secrets.KEY }}`));
```

### Dim: Secondary Information

```typescript
// ✅ Correct - metadata, hints, timestamps
console.log(chalk.dim(`  Version: ${versionId}`));
console.log(chalk.dim(`  Updated: 5 minutes ago`));
console.log(chalk.dim("  Run: vm0 help for more info"));

// Table headers
console.log(chalk.dim("NAME        SIZE    UPDATED"));

// Cancellation
console.log(chalk.dim("Cancelled"));
```

### Bold: Section Headers

```typescript
// ✅ Correct - section headers
console.log(chalk.bold("▶ Run started"));
console.log(chalk.bold("Scope Information:"));
console.log(chalk.bold("Processing volumes:"));
```

## Combined Patterns

### Success with Details

```typescript
console.log(chalk.green(`✓ Created: ${name}`));
console.log(chalk.dim(`  Version: ${version}`));
console.log(chalk.dim(`  Size: ${formatBytes(size)}`));
```

### Error with Suggestion

```typescript
console.error(chalk.red("✗ Not authenticated"));
console.error(chalk.dim("  Run: vm0 auth login"));
```

### Warning with Context

```typescript
console.log(chalk.yellow(`⚠ Agent "${name}": 'image' field is deprecated`));
console.log(chalk.dim("  Use 'apps' instead"));
```

### Status Indicators in Tables

```typescript
const status = item.enabled
  ? chalk.green("enabled")
  : chalk.yellow("disabled");
```

## Anti-Patterns

### Mixed Styles

```typescript
// ❌ Wrong - inconsistent error formats
console.error(chalk.red("✗ Error A"));
console.error(chalk.red("Error: Error B"));  // Different format!
console.error(chalk.red("x Error C"));        // Different symbol!
```

### Wrong Color for Context

```typescript
// ❌ Wrong - red for non-error
console.log(chalk.red("Note: Check your configuration"));

// ✅ Correct - yellow for warning/note
console.log(chalk.yellow("Note: Check your configuration"));
```

### Overusing Colors

```typescript
// ❌ Wrong - too many colors
console.log(chalk.blue("Name: ") + chalk.green(name) + chalk.cyan(" (active)"));

// ✅ Correct - minimal coloring
console.log(`Name: ${name} ${chalk.green("(active)")}`);
```
