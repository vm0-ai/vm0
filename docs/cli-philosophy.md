# CLI Philosophy: Agent First, Human Friendly

VM0 CLI is designed with a clear priority: **AI agents are the primary user, humans are the secondary user**.

This does not mean the CLI is hostile to humans. It means that when an AI agent can use the CLI effectively, humans benefit too. Atomic commands are easier for everyone to understand. Non-interactive flags make both agent automation and CI/CD work. Actionable output helps everyone know what to do next.

Every CLI design decision should be evaluated through this lens: **Can an AI agent use this command effectively?**

## The Three Pillars

### 1. Atomic Command

Each command performs exactly one operation.

When commands are atomic, agents can freely compose them to fulfill their own intent. An agent calling `vm0 secret set` knows it is setting exactly one secret — no hidden side effects, no implicit operations, no surprises.

Complex workflows are not built into single commands. Instead, they emerge from agents orchestrating atomic commands in whatever order and combination serves their goal.

**Guidelines:**
- One command, one operation
- Do not combine unrelated operations into a single command
- If a command internally does A, B, and C, consider whether those should be three separate commands
- Wizard-style commands (like `onboard`) may exist as human convenience, but the underlying atomic commands must always be available

### 2. TTY & Non-TTY

Every command must work in both TTY (interactive terminal) and non-TTY (programmatic) modes.

AI agents like Claude Code operate in non-TTY mode — they spawn CLI processes, pass arguments, and read output. They cannot respond to interactive prompts. If a command only works interactively, agents cannot use it.

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
