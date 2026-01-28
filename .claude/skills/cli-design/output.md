# Output Formatting

## Spacing Conventions

### Two-Space Indentation

All secondary information uses 2-space indentation:

```typescript
console.log(chalk.green("✓ Created successfully"));
console.log(chalk.dim("  Version: abc12345"));     // 2 spaces
console.log(chalk.dim("  Size: 1.5 MB"));          // 2 spaces
```

### Blank Lines for Sections

Use blank lines to separate logical sections:

```typescript
// Section 1: Status
console.log(chalk.green("✓ Compose created"));
console.log(chalk.dim("  Version: abc12345"));

console.log();  // Blank line

// Section 2: Next steps
console.log("Next steps:");
console.log(chalk.cyan("  vm0 run my-agent"));
```

### No Trailing Periods

Messages should not end with periods:

```typescript
// ✅ Correct
console.log(chalk.dim("No items found"));
console.log(chalk.dim("Cancelled"));

// ❌ Wrong
console.log(chalk.dim("No items found."));
console.log(chalk.dim("Cancelled."));
```

## Message Patterns

### Success Messages

```typescript
// Simple success
console.log(chalk.green("✓ Created successfully"));

// Success with name
console.log(chalk.green(`✓ Created: ${name}`));

// Success with action context
console.log(chalk.green(`✓ Initialized volume: ${volumeName}`));
```

### Error Messages

```typescript
// Simple error
console.error(chalk.red("✗ Operation failed"));

// Error with context
console.error(chalk.red(`✗ Not found: ${name}`));

// Error with suggestion
console.error(chalk.red("✗ Not authenticated"));
console.error(chalk.dim("  Run: vm0 auth login"));

// Error with examples
console.error(chalk.red(`✗ Invalid format: ${value}`));
console.log();
console.log("Valid formats:");
console.log(chalk.dim("  daily, weekly, monthly, once"));
```

### Empty States

```typescript
// Empty list
if (items.length === 0) {
  console.log(chalk.dim("No volumes found"));
  console.log(chalk.dim("  Create one with: vm0 volume init && vm0 volume push"));
  return;
}
```

### Progress Messages

```typescript
// Starting operation
console.log(`Uploading: ${filename}`);

// Progress step
console.log(chalk.dim("Getting download URL..."));

// Completion
console.log(chalk.green(`✓ Downloaded ${formatBytes(size)}`));
```

### Next Steps

```typescript
console.log();
console.log("Next steps:");
console.log(`  1. Edit ${chalk.cyan("AGENTS.md")} to customize your agent`);
console.log(`  2. Run: ${chalk.cyan('vm0 cook "your prompt"')}`);
```

## Formatting Utilities

### Use Shared Utilities

Always import from shared utilities instead of creating local implementations:

```typescript
import { formatBytes, formatRelativeTime } from "../../lib/utils/file-utils";
import { formatDuration } from "../../lib/utils/duration-formatter";

// formatBytes
console.log(formatBytes(1536));        // "1.50 KB"
console.log(formatBytes(1048576));     // "1.00 MB"

// formatRelativeTime
console.log(formatRelativeTime(date)); // "5 minutes ago"

// formatDuration
console.log(formatDuration(125000));   // "2m 5s"
```

### Version ID Shortening

SHA-256 hashes (64 chars) are shortened to 8 characters for display:

```typescript
const shortVersion = versionId.slice(0, 8);  // "abc12345"
console.log(chalk.dim(`  Version: ${shortVersion}`));
```

### Timestamp Formatting

```typescript
// ISO format without milliseconds
const formatted = timestamp.toISOString().replace(/\.\d{3}Z$/, "Z");
// Result: "2024-01-15T10:30:00Z"
```

## Command Examples

When showing command examples, use cyan color:

```typescript
// Single command
console.log("Run:");
console.log(chalk.cyan("  vm0 auth login"));

// Multiple commands
console.log("Examples:");
console.log(chalk.cyan("  vm0 run my-agent \"start working\""));
console.log(chalk.cyan("  vm0 run my-agent:abc123 \"prompt\""));

// YAML/code examples
console.log("Use in vm0.yaml:");
console.log(chalk.cyan("  environment:"));
console.log(chalk.cyan(`    KEY: \${{ secrets.KEY }}`));
```

## Anti-Patterns

### Inconsistent Indentation

```typescript
// ❌ Wrong - mixed indentation
console.log(chalk.green("✓ Success"));
console.log(chalk.dim(" Version: abc"));    // 1 space
console.log(chalk.dim("   Size: 1 MB"));    // 3 spaces

// ✅ Correct - consistent 2-space indent
console.log(chalk.green("✓ Success"));
console.log(chalk.dim("  Version: abc"));   // 2 spaces
console.log(chalk.dim("  Size: 1 MB"));     // 2 spaces
```

### Missing Blank Lines

```typescript
// ❌ Wrong - cramped output
console.log(chalk.green("✓ Created"));
console.log("Next steps:");
console.log(chalk.cyan("  vm0 run"));

// ✅ Correct - clear sections
console.log(chalk.green("✓ Created"));
console.log();  // Blank line
console.log("Next steps:");
console.log(chalk.cyan("  vm0 run"));
```

### Hardcoded Formatting

```typescript
// ❌ Wrong - hardcoded bytes formatting
console.log(`Size: ${(size / 1024).toFixed(2)} KB`);

// ✅ Correct - use shared utility
import { formatBytes } from "../../lib/utils/file-utils";
console.log(`Size: ${formatBytes(size)}`);
```
