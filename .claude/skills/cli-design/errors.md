# Error Handling

## Standard Error Pattern

```typescript
try {
  // Command logic
} catch (error) {
  if (error instanceof Error) {
    // Handle specific error types
    if (error.message.includes("Not authenticated")) {
      console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
    } else if (error.message.includes("not found")) {
      console.error(chalk.red(`✗ Not found: ${identifier}`));
      console.error(chalk.dim("  Check the name and try again"));
    } else {
      // Generic error with details
      console.error(chalk.red("✗ Operation failed"));
      console.error(chalk.dim(`  ${error.message}`));
    }
  } else {
    console.error(chalk.red("✗ An unexpected error occurred"));
  }
  process.exit(1);
}
```

## Error Message Structure

### Basic Error

```typescript
console.error(chalk.red("✗ Operation failed"));
process.exit(1);
```

### Error with Details

```typescript
console.error(chalk.red("✗ Operation failed"));
console.error(chalk.dim(`  ${error.message}`));
process.exit(1);
```

### Error with Suggestion

```typescript
console.error(chalk.red("✗ Not authenticated"));
console.error(chalk.dim("  Run: vm0 auth login"));
process.exit(1);
```

### Error with Examples

```typescript
console.error(chalk.red(`✗ Invalid format: ${value}`));
console.log();
console.log("Valid formats:");
console.log(chalk.dim("  YYYY-MM-DD (e.g., 2024-01-15)"));
console.log(chalk.dim("  Relative (e.g., 7d, 30d)"));
process.exit(1);
```

## Common Error Types

### Authentication Errors

```typescript
if (error.message.includes("Not authenticated")) {
  console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
}
```

### Not Found Errors

```typescript
if (error.message.includes("not found")) {
  console.error(chalk.red(`✗ Agent not found: ${name}`));
  console.error(chalk.dim("  Make sure you've composed the agent first"));
  console.error(chalk.dim("  Run: vm0 agent list"));
}
```

### Validation Errors

```typescript
if (!isValid(value)) {
  console.error(chalk.red(`✗ Invalid value: "${value}"`));
  console.error(chalk.dim("  Must be 3-64 characters, lowercase alphanumeric with hyphens"));
  console.error(chalk.dim("  Example: my-dataset, user-data-v2"));
  process.exit(1);
}
```

### Configuration Errors

```typescript
if (error.message.includes("No scope configured")) {
  console.log(chalk.yellow("No scope configured"));
  console.log();
  console.log("Set your scope with:");
  console.log(chalk.cyan("  vm0 scope set <slug>"));
  console.log();
  console.log("Example:");
  console.log(chalk.dim("  vm0 scope set myusername"));
}
```

### File System Errors

```typescript
if (!existsSync(configPath)) {
  console.error(chalk.red(`✗ Config file not found: ${configPath}`));
  process.exit(1);
}
```

## Error Detection Patterns

Use `error.message.includes()` for error detection:

```typescript
if (error instanceof Error) {
  if (error.message.includes("Not authenticated")) {
    // Handle auth error
  } else if (error.message.includes("not found")) {
    // Handle not found
  } else if (error.message.includes("already exists")) {
    // Handle duplicate
  } else if (error.message.includes("reserved")) {
    // Handle reserved name
  } else {
    // Generic fallback
    console.error(chalk.red(`✗ ${error.message}`));
  }
}
```

## Exit Codes

Always exit with code 1 on errors:

```typescript
process.exit(1);
```

**Exception**: Normal cancellation (Ctrl+C on prompts) should return without exit:

```typescript
const name = await promptText("Enter name");
if (name === undefined) {
  console.log(chalk.dim("Cancelled"));
  return;  // Don't exit with error code
}
```

## Anti-Patterns

### Wrong Error Symbol

```typescript
// ❌ Wrong
console.error(chalk.red("x Failed"));
console.error(chalk.red("Error: Failed"));
console.error(chalk.red("FAILED: Operation"));

// ✅ Correct
console.error(chalk.red("✗ Failed"));
```

### Missing Exit Code

```typescript
// ❌ Wrong - missing exit
console.error(chalk.red("✗ Failed"));
// Code continues...

// ✅ Correct
console.error(chalk.red("✗ Failed"));
process.exit(1);
```

### Swallowing Errors

```typescript
// ❌ Wrong - silently swallow
try {
  await operation();
} catch {
  // Do nothing
}

// ✅ Correct - fail fast
await operation();  // Let error propagate
```

### Inconsistent Formatting

```typescript
// ❌ Wrong - mixed formats
console.error(chalk.red("✗ Error A"));
console.error(chalk.red("Error: Error B"));
console.error(chalk.red("x Error C"));

// ✅ Correct - consistent format
console.error(chalk.red("✗ Error A"));
console.error(chalk.red("✗ Error B"));
console.error(chalk.red("✗ Error C"));
```

## Validation Before Operations

For user input, validate early and provide clear feedback:

```typescript
// Validate name format
if (!isValidStorageName(volumeName)) {
  console.error(chalk.red(`✗ Invalid volume name: "${volumeName}"`));
  console.error(chalk.dim("  Volume names must be 3-64 characters, lowercase alphanumeric with hyphens"));
  console.error(chalk.dim("  Example: my-dataset, user-data-v2, training-set-2024"));
  process.exit(1);
}

// Check file exists
if (!existsSync(configFile)) {
  console.error(chalk.red(`✗ Config file not found: ${configFile}`));
  process.exit(1);
}

// Validate UUID format
if (!isUUID(checkpointId)) {
  console.error(chalk.red(`✗ Invalid checkpoint ID format: ${checkpointId}`));
  console.error(chalk.dim("  Checkpoint ID must be a valid UUID"));
  process.exit(1);
}
```
