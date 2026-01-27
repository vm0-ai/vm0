---
name: CLI Design
description: Design patterns and conventions for the vm0 CLI user experience
---

# CLI Design Skill

This skill defines the design patterns and conventions for the vm0 CLI. These patterns ensure a consistent, professional user experience across all commands.

## When to Use This Skill

Use this skill when:
- Writing new CLI commands
- Reviewing CLI code in pull requests
- Fixing inconsistencies in existing commands
- Understanding CLI output conventions

## Quick Reference

### Symbols

| Symbol | Color | Usage |
|--------|-------|-------|
| `✓` | `chalk.green` | Success, completion |
| `✗` | `chalk.red` | Error, failure |
| `⚠` | `chalk.yellow` | Warning, deprecation |
| `▶` | `chalk.bold` | Operation started |

### Colors

| Color | Usage | Example |
|-------|-------|---------|
| `chalk.red()` | Errors | `✗ Not authenticated` |
| `chalk.green()` | Success | `✓ Created successfully` |
| `chalk.yellow()` | Warnings | `⚠ Field deprecated` |
| `chalk.cyan()` | Commands, code | `vm0 auth login` |
| `chalk.dim()` | Secondary info | Timestamps, hints |
| `chalk.bold()` | Headers | `▶ Run started` |

### Message Patterns

```typescript
// Success
console.log(chalk.green(`✓ Created: ${name}`));

// Error
console.error(chalk.red(`✗ Not found: ${name}`));
console.error(chalk.dim("  Run: vm0 auth login"));

// Warning
console.log(chalk.yellow(`⚠ Field deprecated`));

// Empty state
console.log(chalk.dim("No items found"));

// Commands/code examples
console.log(chalk.cyan("  vm0 compose <file>"));
```

## The Five Rules

### 1. Use Unicode Symbols, Not ASCII

```typescript
// ✅ Correct
console.error(chalk.red("✗ Failed"));
console.log(chalk.green("✓ Success"));

// ❌ Wrong
console.error(chalk.red("x Failed"));
console.error(chalk.red("Error: Failed"));
```

### 2. Two-Space Indentation for Details

```typescript
console.error(chalk.red("✗ Operation failed"));
console.error(chalk.dim("  Details here"));      // 2 spaces
console.error(chalk.dim("  Run: vm0 help"));     // 2 spaces
```

### 3. No Periods in Messages

```typescript
// ✅ Correct
console.log(chalk.dim("No items found"));
console.log(chalk.dim("Cancelled"));

// ❌ Wrong
console.log(chalk.dim("No items found."));
console.log(chalk.dim("Cancelled."));
```

### 4. Use Shared Utilities

```typescript
// ✅ Correct - use shared utilities
import { formatBytes } from "../../lib/utils/file-utils";
import { promptConfirm } from "../../lib/utils/prompt-utils";

// ❌ Wrong - local implementations
function formatBytes(bytes: number) { ... }  // Duplicate!
```

### 5. Check Interactive Mode

```typescript
import { isInteractive, promptText } from "../../lib/utils/prompt-utils";

if (options.name) {
  name = options.name;
} else if (!isInteractive()) {
  console.error(chalk.red("✗ --name required in non-interactive mode"));
  process.exit(1);
} else {
  name = await promptText("Enter name");
}
```

## Detailed Guidelines

For comprehensive patterns and examples:

- **Colors & Symbols** → Read `colors.md`
- **Output Formatting** → Read `output.md`
- **Interactive Prompts** → Read `prompts.md`
- **Error Handling** → Read `errors.md`
- **Tables** → Read `tables.md`

## Common Violations

### Wrong Error Symbol

```typescript
// ❌ Wrong (lowercase x)
console.error(chalk.red("x Invalid input"));
console.error(chalk.red("Error: Invalid input"));

// ✅ Correct (Unicode ✗)
console.error(chalk.red("✗ Invalid input"));
```

### Wrong Success Format

```typescript
// ❌ Wrong
console.log(chalk.green("Done Created item"));

// ✅ Correct
console.log(chalk.green("✓ Created item"));
```

### Custom Confirmation

```typescript
// ❌ Wrong - custom readline
const rl = readline.createInterface({ ... });
rl.question("Confirm? (y/N)", (answer) => { ... });

// ✅ Correct - use shared utility
import { promptConfirm } from "../../lib/utils/prompt-utils";
const confirmed = await promptConfirm("Confirm?");
```

### Duplicate Utilities

```typescript
// ❌ Wrong - local formatBytes
function formatBytes(bytes: number): string {
  // ... implementation
}

// ✅ Correct - import shared
import { formatBytes } from "../../lib/utils/file-utils";
```

## File Locations

### Shared Utilities
- `lib/utils/prompt-utils.ts` - Interactive prompts
- `lib/utils/file-utils.ts` - formatBytes, formatRelativeTime
- `lib/events/event-renderer.ts` - Run event rendering

### Example Commands
- `commands/agent/list.ts` - Table output
- `commands/init.ts` - Interactive prompts
- `commands/compose.ts` - Complex workflow
- `commands/credential/set.ts` - Error handling
