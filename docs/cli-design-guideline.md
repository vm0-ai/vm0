# CLI Design Guideline

## Philosophy: Agent First, Human Friendly

VM0 CLI is designed with a clear priority: **AI agents are the primary user, humans are the secondary user**.

This does not mean the CLI is hostile to humans. It means that when an AI agent can use the CLI effectively, humans benefit too. Atomic commands are easier for everyone to understand. Non-interactive flags make both agent automation and CI/CD work. Actionable output helps everyone know what to do next.

Every CLI design decision should be evaluated through this lens: **Can an AI agent use this command effectively?**

## The Three Principles

### 1. Atomic Command

Each command performs exactly one operation.

When commands are atomic, agents can freely compose them to fulfill their own intent. An agent calling `vm0 secret set` knows it is setting exactly one secret — no hidden side effects, no implicit operations, no surprises.

Complex workflows are not built into single commands. Instead, they emerge from agents orchestrating atomic commands in whatever order and combination serves their goal.

**Example — an agent deploying and running an agent:**

```bash
# Each step is one atomic command. The agent decides the order and combination.
vm0 secret set MY_API_KEY --body "sk-..."
vm0 compose vm0.yaml
vm0 run my-agent "analyze the dataset"
vm0 logs <run-id>
```

The agent composes these atomic commands based on its own intent. It might skip `secret set` if the secret already exists, or run `vm0 logs` only if the run fails. The CLI does not impose a fixed workflow — the agent does.

**Guidelines:**
- One command, one operation
- Do not combine unrelated operations into a single command
- If a command internally does A, B, and C, consider whether those should be three separate commands
- Wizard-style commands (like `onboard`) may exist as human convenience, but the underlying atomic commands must always be available

### 2. TTY & Non-TTY

Every command must work in both TTY (interactive terminal) and non-TTY (programmatic) modes.

AI agents like Claude Code operate in non-TTY mode — they spawn CLI processes, pass arguments, and read output. They cannot respond to interactive prompts. If a command only works interactively, agents cannot use it.

**Example — the same command in both modes:**

TTY mode (human at terminal):
```
$ vm0 secret set API_KEY
? Enter secret value: ********
✓ Secret "API_KEY" saved
```

Non-TTY mode (agent or CI/CD):
```
$ vm0 secret set API_KEY --body "sk-..."
✓ Secret "API_KEY" saved
```

If the agent forgets the `--body` flag in non-TTY mode:
```
$ vm0 secret set API_KEY
✗ --body is required in non-interactive mode
  Usage: vm0 secret set <name> --body "your-secret-value"
```

**Guidelines:**
- All required inputs must be expressible as flags or arguments
- Interactive prompts are a convenience layer for humans, not a requirement
- In non-TTY mode, if a required input is missing, fail with a clear error showing the correct flag usage
- Destructive actions should require `--yes` in non-TTY mode instead of interactive confirmation
- Design the non-interactive interface first, then add interactive prompts on top

### 3. Guided Flow

Every command output should guide the user to the next logical action.

Commands do not exist in isolation. They form a connected flow where each command's output naturally leads to the next step. This is critical for AI agents — when an agent finishes executing a command, the output tells it what to do next.

**Three scenarios:**

**Success → Next Step**

After a successful operation, show what can be done next:
```
✓ Compose created: user/my-agent:a1b2c3d4

Run your agent:
  vm0 run user/my-agent:a1b2c3d4 "your prompt"
```

**Error → Remediation**

When an error occurs, show how to resolve it:
```
✗ Not authenticated
  Run: vm0 auth login
```

```
✗ Concurrent run limit reached
  Use 'vm0 run list' to view runs, 'vm0 run kill <id>' to cancel
```

**Empty State → Creation**

When a list is empty, show how to create the first item:
```
No secrets found

To add a secret:
  vm0 secret set MY_API_KEY --body <value>
```

**Guidelines:**
- Every success message should include a next-step command when applicable
- Every error message should include a remediation hint — either a command to run or a clear explanation of how to fix the issue
- Every empty list should guide toward creation
- The agent should never reach a dead end where the output provides no direction forward

---

## Output Conventions

### Symbols

| Symbol | Color | Usage |
|--------|-------|-------|
| `✓` | `chalk.green` | Success, completion |
| `✗` | `chalk.red` | Error, failure |
| `⚠` | `chalk.yellow` | Warning, deprecation |
| `▶` | `chalk.bold` | Operation started |

Always use Unicode symbols. Never use ASCII alternatives like `x`, `Error:`, or `[OK]`.

### Colors

| Color | Usage |
|-------|-------|
| `chalk.red()` | Errors only |
| `chalk.green()` | Success only |
| `chalk.yellow()` | Warnings, disabled status |
| `chalk.cyan()` | Commands, code examples |
| `chalk.dim()` | Secondary info, hints, timestamps, table headers |
| `chalk.bold()` | Section headers |

### Message Formatting

```typescript
// Success
console.log(chalk.green(`✓ Created: ${name}`));

// Error with suggestion
console.error(chalk.red(`✗ Not found: ${name}`));
console.error(chalk.dim("  Run: vm0 auth login"));

// Warning
console.log(chalk.yellow(`⚠ Field deprecated`));

// Empty state
console.log(chalk.dim("No items found"));
```

### Spacing Rules

- **Two-space indentation** for all secondary information
- **Blank lines** between logical sections
- **No trailing periods** on messages

```typescript
console.log(chalk.green("✓ Created successfully"));
console.log(chalk.dim("  Version: abc12345"));     // 2 spaces

console.log();  // Blank line between sections

console.log("Next steps:");
console.log(chalk.cyan("  vm0 run my-agent"));
```

---

## Interactive Prompts

### Shared Utilities

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

Never use `readline` directly or import the `prompts` library directly.

### Interactive Mode Pattern

```typescript
if (options.name) {
  name = options.name;
} else if (!isInteractive()) {
  console.error(chalk.red("✗ --name required in non-interactive mode"));
  console.error(chalk.dim("  Usage: vm0 init --name <name>"));
  process.exit(1);
} else {
  const result = await promptText("Enter name", defaultValue);
  if (result === undefined) {
    console.log(chalk.dim("Cancelled"));
    return;
  }
  name = result;
}
```

### Cancellation

All prompts return `undefined` when cancelled. Handle consistently:
- Message: `"Cancelled"` (no period, not "Aborted")
- Exit: `return` gracefully, do not `process.exit(1)`

---

## Error Handling

### Standard Pattern

```typescript
try {
  // Command logic
} catch (error) {
  if (error instanceof Error) {
    if (error.message.includes("Not authenticated")) {
      console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
    } else if (error.message.includes("not found")) {
      console.error(chalk.red(`✗ Not found: ${identifier}`));
      console.error(chalk.dim("  Run: vm0 agent list"));
    } else {
      console.error(chalk.red(`✗ ${error.message}`));
    }
  } else {
    console.error(chalk.red("✗ An unexpected error occurred"));
  }
  process.exit(1);
}
```

### Exit Codes

- `process.exit(1)` on all errors
- `return` (implicit exit 0) on success or user cancellation

### Validate Early

```typescript
if (!isValidStorageName(name)) {
  console.error(chalk.red(`✗ Invalid volume name: "${name}"`));
  console.error(chalk.dim("  Must be 3-64 characters, lowercase alphanumeric with hyphens"));
  console.error(chalk.dim("  Example: my-dataset, user-data-v2"));
  process.exit(1);
}
```

---

## Table Formatting

### Standard Pattern

```typescript
// 1. Handle empty state
if (items.length === 0) {
  console.log(chalk.dim("No volumes found"));
  console.log(chalk.dim("  Create one with: vm0 volume init && vm0 volume push"));
  return;
}

// 2. Calculate column widths from content
const nameWidth = Math.max(4, ...items.map((i) => i.name.length));
const sizeWidth = Math.max(4, ...items.map((i) => formatBytes(i.size).length));

// 3. Print dim header
const header = [
  "NAME".padEnd(nameWidth),
  "SIZE".padStart(sizeWidth),
  "UPDATED",
].join("  ");
console.log(chalk.dim(header));

// 4. Print rows
for (const item of items) {
  const row = [
    item.name.padEnd(nameWidth),
    formatBytes(item.size).padStart(sizeWidth),
    formatRelativeTime(item.updatedAt),
  ].join("  ");
  console.log(row);
}
```

### Column Rules

- Text columns: left-aligned with `padEnd`
- Numeric columns: right-aligned with `padStart`
- Column spacing: always two spaces (`.join("  ")`)
- Missing values: use `chalk.dim("-")`

---

## Shared Utilities

Always import from shared utilities. Never create local implementations.

### Prompt Utilities (`lib/utils/prompt-utils.ts`)

- `isInteractive()` — check if running in TTY
- `promptText(message, initial?, validate?)` — text input
- `promptConfirm(message, initial?)` — yes/no confirmation
- `promptSelect(message, choices, initial?)` — selection list
- `promptPassword(message)` — masked input

### Formatting Utilities (`lib/utils/file-utils.ts`)

- `formatBytes(bytes)` — `"1.50 KB"`, `"1.00 MB"`
- `formatRelativeTime(date)` — `"5 minutes ago"`

### Duration Formatting (`lib/utils/duration-formatter.ts`)

- `formatDuration(ms)` — `"2m 5s"`

### Version Display

SHA-256 hashes are shortened to 8 characters: `versionId.slice(0, 8)`
