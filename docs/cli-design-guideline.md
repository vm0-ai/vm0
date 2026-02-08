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

## Colors & Symbols

### Symbol Standards

The CLI uses Unicode symbols for visual feedback. **Never use ASCII alternatives.**

| Symbol | Unicode | Color | Usage |
|--------|---------|-------|-------|
| `✓` | U+2713 | `chalk.green` | Success, completion |
| `✗` | U+2717 | `chalk.red` | Error, failure |
| `⚠` | U+26A0 | `chalk.yellow` | Warning, deprecation |
| `▶` | U+25B6 | `chalk.bold` | Operation started |

```typescript
// ✅ Correct
console.log(chalk.green("✓ Created successfully"));
console.error(chalk.red("✗ Not authenticated"));
console.log(chalk.yellow("⚠ Field 'image' is deprecated"));
console.log(chalk.bold("▶ Run started"));

// ❌ Wrong — ASCII alternatives
console.error(chalk.red("x Not authenticated"));       // lowercase x
console.error(chalk.red("Error: Not authenticated"));   // "Error:" prefix
console.error(chalk.red("[ERROR] Not authenticated"));  // bracket prefix
console.error(chalk.red("FAILED: Not authenticated"));  // "FAILED:" prefix
console.log(chalk.green("Done Created item"));          // "Done" instead of ✓
console.log(chalk.green("[OK] Created item"));           // bracket prefix
console.log(chalk.yellow("Warning: deprecated"));        // "Warning:" prefix
console.log(chalk.bold("Starting run..."));              // no symbol
```

### Color Semantics

| Color | Usage | Example |
|-------|-------|---------|
| `chalk.red()` | Errors only | `✗ Authentication failed` |
| `chalk.green()` | Success only | `✓ Deployed successfully` |
| `chalk.yellow()` | Warnings, disabled status | `⚠ API key will expire soon` |
| `chalk.cyan()` | Commands, code examples | `vm0 auth login` |
| `chalk.dim()` | Secondary info, hints, timestamps, table headers | `Version: abc12345` |
| `chalk.bold()` | Section headers | `▶ Run started` |

```typescript
// ❌ Wrong — using red for non-errors
console.log(chalk.red("Important notice"));  // Use yellow for warnings

// ❌ Wrong — using green for non-success
console.log(chalk.green("Processing..."));   // Use dim for progress

// ❌ Wrong — overusing colors
console.log(chalk.blue("Name: ") + chalk.green(name) + chalk.cyan(" (active)"));

// ✅ Correct — minimal coloring
console.log(`Name: ${name} ${chalk.green("(active)")}`);
```

### Combined Patterns

```typescript
// Success with details
console.log(chalk.green(`✓ Created: ${name}`));
console.log(chalk.dim(`  Version: ${version}`));
console.log(chalk.dim(`  Size: ${formatBytes(size)}`));

// Error with suggestion
console.error(chalk.red("✗ Not authenticated"));
console.error(chalk.dim("  Run: vm0 auth login"));

// Warning with context
console.log(chalk.yellow(`⚠ Agent "${name}": 'image' field is deprecated`));
console.log(chalk.dim("  Use 'apps' instead"));

// Yellow for noteworthy-but-not-error
console.log(chalk.yellow(`Volume already initialized: ${name}`));

// Bold for section headers
console.log(chalk.bold("Scope Information:"));
console.log(chalk.bold("Processing volumes:"));

// Status indicators in tables
const status = item.enabled
  ? chalk.green("enabled")
  : chalk.yellow("disabled");
```

---

## Output Formatting

### Spacing Rules

- **Two-space indentation** for all secondary information
- **Blank lines** between logical sections
- **No trailing periods** on messages

```typescript
// ✅ Correct — consistent 2-space indent
console.log(chalk.green("✓ Success"));
console.log(chalk.dim("  Version: abc"));   // 2 spaces
console.log(chalk.dim("  Size: 1 MB"));     // 2 spaces

// ❌ Wrong — mixed indentation
console.log(chalk.dim(" Version: abc"));    // 1 space
console.log(chalk.dim("   Size: 1 MB"));    // 3 spaces
```

```typescript
// ✅ Correct — clear sections
console.log(chalk.green("✓ Created"));
console.log();  // Blank line between sections
console.log("Next steps:");
console.log(chalk.cyan("  vm0 run my-agent"));

// ❌ Wrong — cramped output
console.log(chalk.green("✓ Created"));
console.log("Next steps:");
```

```typescript
// ✅ Correct
console.log(chalk.dim("No items found"));
console.log(chalk.dim("Cancelled"));

// ❌ Wrong — trailing periods
console.log(chalk.dim("No items found."));
console.log(chalk.dim("Cancelled."));
```

### Message Patterns

```typescript
// Success — simple
console.log(chalk.green("✓ Created successfully"));

// Success — with name
console.log(chalk.green(`✓ Created: ${name}`));

// Success — with action context
console.log(chalk.green(`✓ Initialized volume: ${volumeName}`));

// Error — with suggestion
console.error(chalk.red("✗ Not authenticated"));
console.error(chalk.dim("  Run: vm0 auth login"));

// Error — with context and suggestion
console.error(chalk.red(`✗ Not found: ${name}`));
console.error(chalk.dim("  Run: vm0 agent list"));

// Error — with examples
console.error(chalk.red(`✗ Invalid format: ${value}`));
console.log();
console.log("Valid formats:");
console.log(chalk.dim("  daily, weekly, monthly, once"));

// Progress
console.log(`Uploading: ${filename}`);
console.log(chalk.dim("Getting download URL..."));
console.log(chalk.green(`✓ Downloaded ${formatBytes(size)}`));

// Next steps
console.log();
console.log("Next steps:");
console.log(`  1. Edit ${chalk.cyan("AGENTS.md")} to customize your agent`);
console.log(`  2. Run: ${chalk.cyan('vm0 cook "your prompt"')}`);

// Command examples in cyan
console.log("Run:");
console.log(chalk.cyan("  vm0 auth login"));

// YAML/code examples in cyan
console.log("Use in vm0.yaml:");
console.log(chalk.cyan("  environment:"));
console.log(chalk.cyan(`    KEY: \${{ secrets.KEY }}`));
```

### Formatting Utilities

Always import from shared utilities instead of creating local implementations:

```typescript
import { formatBytes, formatRelativeTime } from "../../lib/utils/file-utils";
import { formatDuration } from "../../lib/utils/duration-formatter";

// ✅ Correct — use shared utility
console.log(`Size: ${formatBytes(size)}`);

// ❌ Wrong — hardcoded formatting
console.log(`Size: ${(size / 1024).toFixed(2)} KB`);
```

### Version Display

SHA-256 hashes (64 chars) are shortened to 8 characters for display:

```typescript
const shortVersion = versionId.slice(0, 8);  // "abc12345"
```

### Timestamp Formatting

```typescript
// ISO format without milliseconds
const formatted = timestamp.toISOString().replace(/\.\d{3}Z$/, "Z");
// Result: "2024-01-15T10:30:00Z"
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

```typescript
// ❌ Wrong — custom readline
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("Confirm? (y/N)", (answer) => { ... });

// ❌ Wrong — direct prompts import
import prompts from "prompts";
const response = await prompts({ type: "confirm", name: "value", message: "Continue?" });

// ✅ Correct — use shared utility
import { promptConfirm } from "../../lib/utils/prompt-utils";
const confirmed = await promptConfirm("Continue?");
```

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

### Prompt Types

**Text Input:**

```typescript
const name = await promptText(
  "Enter agent name",       // Message
  defaultValue,             // Optional default
  (value) => {              // Optional validation
    if (!isValid(value)) return "Must be 3-64 characters";
    return true;
  }
);
if (name === undefined) {
  console.log(chalk.dim("Cancelled"));
  return;
}
```

**Confirmation:**

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

**Selection:**

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

**Password Input:**

```typescript
const secret = await promptPassword("Enter API key:");
if (!secret) {
  console.log(chalk.dim("Cancelled"));
  return;
}
```

### Missing Interactive Check

```typescript
// ❌ Wrong — no interactive check, fails in CI
const name = await promptText("Enter name");

// ✅ Correct — check first
if (!isInteractive()) {
  console.error(chalk.red("✗ --name required in non-interactive mode"));
  console.error(chalk.dim("  Usage: vm0 init --name <name>"));
  process.exit(1);
}
const name = await promptText("Enter name");
```

### Cancellation

All prompts return `undefined` when cancelled (Ctrl+C). Handle consistently:
- Message: `"Cancelled"` (no period, not "Aborted")
- Exit: `return` gracefully, do not `process.exit(1)`

```typescript
// ❌ Wrong — inconsistent cancellation
console.log(chalk.dim("Cancelled."));   // Period
console.log(chalk.dim("Aborted."));     // Different word

// ✅ Correct
console.log(chalk.dim("Cancelled"));
```

### Validation

**Inline validation** (in prompt callback):

```typescript
const name = await promptText("Enter name", undefined, (value) => {
  if (value.length < 3) return "Name must be at least 3 characters";
  if (!/^[a-z0-9-]+$/.test(value)) return "Name must be lowercase alphanumeric with hyphens";
  return true;
});
```

**Validation after prompt:**

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

### Non-Interactive Command Definition

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
      console.error(chalk.dim("  Check the name and try again"));
      console.error(chalk.dim("  Run: vm0 agent list"));
    } else if (error.message.includes("already exists")) {
      // Handle duplicate
    } else if (error.message.includes("reserved")) {
      // Handle reserved name
    } else {
      console.error(chalk.red(`✗ ${error.message}`));
      console.error(chalk.dim("  See: vm0 <command> --help"));
    }
  } else {
    console.error(chalk.red("✗ An unexpected error occurred"));
    console.error(chalk.dim("  Try again or check: vm0 auth status"));
  }
  process.exit(1);
}
```

### Error Message Structure

Every error message must include a remediation hint (per Guided Flow principle).

```typescript
// Error with suggestion
console.error(chalk.red("✗ Not authenticated"));
console.error(chalk.dim("  Run: vm0 auth login"));
process.exit(1);

// Error with details and suggestion
console.error(chalk.red("✗ Compose failed"));
console.error(chalk.dim(`  ${error.message}`));
console.error(chalk.dim("  Check your vm0.yaml and try again"));
process.exit(1);

// Error with examples
console.error(chalk.red(`✗ Invalid format: ${value}`));
console.log();
console.log("Valid formats:");
console.log(chalk.dim("  YYYY-MM-DD (e.g., 2024-01-15)"));
console.log(chalk.dim("  Relative (e.g., 7d, 30d)"));
process.exit(1);
```

### Common Error Types

```typescript
// Authentication
if (error.message.includes("Not authenticated")) {
  console.error(chalk.red("✗ Not authenticated. Run: vm0 auth login"));
}

// Not found
if (error.message.includes("not found")) {
  console.error(chalk.red(`✗ Agent not found: ${name}`));
  console.error(chalk.dim("  Make sure you've composed the agent first"));
  console.error(chalk.dim("  Run: vm0 agent list"));
}

// Validation
if (!isValid(value)) {
  console.error(chalk.red(`✗ Invalid value: "${value}"`));
  console.error(chalk.dim("  Must be 3-64 characters, lowercase alphanumeric with hyphens"));
  console.error(chalk.dim("  Example: my-dataset, user-data-v2"));
  process.exit(1);
}

// Configuration
if (error.message.includes("No scope configured")) {
  console.log(chalk.yellow("No scope configured"));
  console.log();
  console.log("Set your scope with:");
  console.log(chalk.cyan("  vm0 scope set <slug>"));
  console.log();
  console.log("Example:");
  console.log(chalk.dim("  vm0 scope set myusername"));
}

// File system
if (!existsSync(configPath)) {
  console.error(chalk.red(`✗ Config file not found: ${configPath}`));
  console.error(chalk.dim("  Run: vm0 init"));
  process.exit(1);
}
```

### Validate Early

Validate user input before performing operations:

```typescript
// Name format
if (!isValidStorageName(name)) {
  console.error(chalk.red(`✗ Invalid volume name: "${name}"`));
  console.error(chalk.dim("  Must be 3-64 characters, lowercase alphanumeric with hyphens"));
  console.error(chalk.dim("  Example: my-dataset, user-data-v2, training-set-2024"));
  process.exit(1);
}

// File exists
if (!existsSync(configFile)) {
  console.error(chalk.red(`✗ Config file not found: ${configFile}`));
  console.error(chalk.dim("  Create one with: vm0 init"));
  process.exit(1);
}

// UUID format
if (!isUUID(checkpointId)) {
  console.error(chalk.red(`✗ Invalid checkpoint ID format: ${checkpointId}`));
  console.error(chalk.dim("  Checkpoint ID must be a valid UUID"));
  console.error(chalk.dim("  Run: vm0 run list"));
  process.exit(1);
}
```

### Exit Codes

- `process.exit(1)` on all errors
- `return` (implicit exit 0) on success or user cancellation

**Exception**: Normal cancellation (Ctrl+C on prompts) should return without exit:

```typescript
const name = await promptText("Enter name");
if (name === undefined) {
  console.log(chalk.dim("Cancelled"));
  return;  // Don't exit with error code
}
```

### Anti-Patterns

```typescript
// ❌ Wrong — missing exit code
console.error(chalk.red("✗ Failed"));
// Code continues...

// ✅ Correct
console.error(chalk.red("✗ Failed"));
process.exit(1);
```

```typescript
// ❌ Wrong — swallowing errors
try {
  await operation();
} catch {
  // Do nothing
}

// ✅ Correct — let error propagate
await operation();
```

```typescript
// ❌ Wrong — inconsistent error formats
console.error(chalk.red("✗ Error A"));
console.error(chalk.red("Error: Error B"));  // Different format!
console.error(chalk.red("x Error C"));        // Different symbol!

// ✅ Correct — consistent format
console.error(chalk.red("✗ Error A"));
console.error(chalk.red("✗ Error B"));
console.error(chalk.red("✗ Error C"));
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

```typescript
const version = item.headVersionId
  ? item.headVersionId.slice(0, 8)
  : chalk.dim("-");
```

### Complete Example

```typescript
export async function listVolumes(): Promise<void> {
  const volumes = await getVolumes();

  if (volumes.length === 0) {
    console.log(chalk.dim("No volumes found"));
    console.log(chalk.dim("  Create one with: vm0 volume init && vm0 volume push"));
    return;
  }

  const nameWidth = Math.max(4, ...volumes.map((v) => v.name.length));
  const sizeWidth = Math.max(4, ...volumes.map((v) => formatBytes(v.size).length));

  const header = [
    "NAME".padEnd(nameWidth),
    "SIZE".padStart(sizeWidth),
    "UPDATED",
  ].join("  ");
  console.log(chalk.dim(header));

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

### Status Columns

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

### Summary Rows

```typescript
// Print separator
console.log(chalk.dim("─".repeat(totalWidth)));

// Print totals
console.log(
  `${"TOTAL".padEnd(nameWidth)}${totalCount.padStart(countWidth)}    ${totalTime}`
);
```

### Alternative List Format

For hierarchical data, use an indented list format instead of a table:

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

Standard table format is preferred for flat lists. Use this format only for hierarchical data.

### Anti-Patterns

```typescript
// ❌ Wrong — hardcoded widths
const row = `${name.padEnd(20)}  ${size.padStart(10)}`;

// ✅ Correct — dynamic widths
const nameWidth = Math.max(4, ...items.map((i) => i.name.length));
const row = `${name.padEnd(nameWidth)}  ${size.padStart(sizeWidth)}`;
```

```typescript
// ❌ Wrong — inconsistent spacing
const row = `${col1} ${col2}   ${col3}`;

// ✅ Correct — consistent two-space
const row = [col1, col2, col3].join("  ");
```

```typescript
// ❌ Wrong — missing empty state (crashes on empty array)
const nameWidth = Math.max(4, ...items.map((i) => i.name.length));

// ✅ Correct — check first and guide to creation
if (items.length === 0) {
  console.log(chalk.dim("No items found"));
  console.log(chalk.dim("  Create one with: vm0 <resource> create"));
  return;
}
```

```typescript
// ❌ Wrong — header same style as data
console.log("NAME  SIZE  UPDATED");

// ✅ Correct — header in dim
console.log(chalk.dim("NAME  SIZE  UPDATED"));
```

---

## Shared Utilities

Always import from shared utilities. Never create local implementations.

```typescript
// ❌ Wrong — local formatBytes
function formatBytes(bytes: number): string {
  // ... implementation
}

// ✅ Correct — import shared
import { formatBytes } from "../../lib/utils/file-utils";
```

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
