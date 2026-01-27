# Interactive Prompts

## Use Shared Utilities

Always use the prompt utilities from `lib/utils/prompt-utils.ts`:

```typescript
import {
  isInteractive,
  promptText,
  promptConfirm,
  promptSelect,
  promptPassword,
} from "../../lib/utils/prompt-utils";
```

## Interactive Mode Check

Always check `isInteractive()` before prompting:

```typescript
if (options.name) {
  // Use provided option
  name = options.name;
} else if (!isInteractive()) {
  // Non-interactive mode - require flag
  console.error(chalk.red("✗ --name flag is required in non-interactive mode"));
  console.error(chalk.dim("  Usage: vm0 init --name <name>"));
  process.exit(1);
} else {
  // Interactive prompt
  const result = await promptText("Enter name", defaultValue);
  if (result === undefined) {
    console.log(chalk.dim("Cancelled"));
    return;
  }
  name = result;
}
```

## Prompt Types

### Text Input

```typescript
const name = await promptText(
  "Enter agent name",       // Message
  defaultValue,             // Optional default
  (value) => {              // Optional validation
    if (!isValid(value)) {
      return "Must be 3-64 characters";  // Error message
    }
    return true;  // Valid
  }
);

if (name === undefined) {
  console.log(chalk.dim("Cancelled"));
  return;
}
```

### Confirmation

```typescript
const confirmed = await promptConfirm(
  "Delete this item?",  // Message
  false                  // Default value (false = No)
);

if (!confirmed) {
  console.log(chalk.dim("Cancelled"));
  return;
}
```

### Selection

```typescript
const choice = await promptSelect(
  "Select frequency:",
  [
    { title: "Daily", value: "daily", description: "Run every day" },
    { title: "Weekly", value: "weekly", description: "Run once per week" },
    { title: "Monthly", value: "monthly" },
  ],
  0  // Default index
);

if (choice === undefined) {
  console.log(chalk.dim("Cancelled"));
  return;
}
```

### Password Input

```typescript
const secret = await promptPassword("Enter API key:");

if (!secret) {
  console.log(chalk.dim("Cancelled"));
  return;
}
```

## Cancellation Handling

All prompts return `undefined` when cancelled (Ctrl+C). Handle this consistently:

```typescript
const name = await promptText("Enter name");
if (name === undefined) {
  console.log(chalk.dim("Cancelled"));
  return;  // Exit gracefully, don't throw
}
```

**Important**: The cancellation message is `"Cancelled"` (no period, not "Aborted").

## Anti-Patterns

### Custom readline Implementation

```typescript
// ❌ Wrong - custom readline
import * as readline from "readline";

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

// ✅ Correct - use shared utility
import { promptConfirm } from "../../lib/utils/prompt-utils";
const confirmed = await promptConfirm(message);
```

### Direct prompts Library Usage

```typescript
// ❌ Wrong - direct prompts import
import prompts from "prompts";
const response = await prompts({
  type: "confirm",
  name: "value",
  message: "Continue?",
});

// ✅ Correct - use wrapper
import { promptConfirm } from "../../lib/utils/prompt-utils";
const confirmed = await promptConfirm("Continue?");
```

### Inconsistent Cancellation

```typescript
// ❌ Wrong - inconsistent messages
console.log(chalk.dim("Cancelled."));   // Period
console.log(chalk.dim("Aborted."));     // Different word

// ✅ Correct - consistent message
console.log(chalk.dim("Cancelled"));    // No period
```

### Missing Interactive Check

```typescript
// ❌ Wrong - no interactive check
const name = await promptText("Enter name");  // Fails in CI!

// ✅ Correct - check first
if (!isInteractive()) {
  console.error(chalk.red("✗ --name required in non-interactive mode"));
  process.exit(1);
}
const name = await promptText("Enter name");
```

## Non-Interactive Mode

For CI/CD and scripting, all required values must be providable via flags:

```typescript
export const initCommand = new Command()
  .name("init")
  .description("Initialize a volume")
  .option("-n, --name <name>", "Volume name (required in non-interactive mode)")
  .action(async (options) => {
    let volumeName: string;

    if (options.name) {
      volumeName = options.name;
    } else if (!isInteractive()) {
      console.error(chalk.red("✗ --name flag is required in non-interactive mode"));
      console.error(chalk.dim("  Usage: vm0 volume init --name <volume-name>"));
      process.exit(1);
    } else {
      const name = await promptText("Enter volume name", defaultName);
      if (name === undefined) {
        console.log(chalk.dim("Cancelled"));
        return;
      }
      volumeName = name;
    }

    // Continue with volumeName...
  });
```

## Validation Patterns

### Inline Validation

```typescript
const name = await promptText(
  "Enter name",
  undefined,
  (value) => {
    if (value.length < 3) {
      return "Name must be at least 3 characters";
    }
    if (!/^[a-z0-9-]+$/.test(value)) {
      return "Name must be lowercase alphanumeric with hyphens";
    }
    return true;
  }
);
```

### Validation After Prompt

```typescript
const name = await promptText("Enter name");
if (name === undefined) {
  console.log(chalk.dim("Cancelled"));
  return;
}

if (!isValidName(name)) {
  console.error(chalk.red(`✗ Invalid name: "${name}"`));
  console.error(chalk.dim("  Names must be 3-64 characters, lowercase"));
  process.exit(1);
}
```
