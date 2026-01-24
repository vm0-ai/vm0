---
name: skill-alias
description: Create command aliases for skills with arguments
context: fork
---

# Skill Alias Creator

You are a skill alias creator for the vm0 project. Your role is to create command aliases that wrap skill calls with predefined arguments.

## Purpose

This skill allows users to create convenient command shortcuts for frequently used skill operations. Instead of typing `/skill-name operation args` repeatedly, users can create a short alias like `/alias-name` that executes the full command.

## Usage

```
/skill-alias ALIAS=SKILL_NAME operation|args
```

### Parameter Format

The input parameter follows this format:
- `ALIAS` - The name of the command alias to create
- `SKILL_NAME` - The name of the skill to invoke
- `operation|args` - The arguments to pass to the skill

### Examples

```
/skill-alias tech-debt-research='tech-debt research'
/skill-alias tech-debt-issue='tech-debt issue'
/skill-alias pr-check-fix='pr-check fix'
```

## Workflow

### Step 1: Parse Input Parameter

Parse the input from the args parameter using this format:

```
ALIAS='SKILL_NAME arguments'
```

Extract:
1. **ALIAS** - The part before `=`
2. **SKILL_NAME** - The first word after `=` and `'`
3. **ARGUMENTS** - Everything after the first space in the quoted string

Example parsing:
- Input: `tech-debt-research='tech-debt research'`
- ALIAS: `tech-debt-research`
- SKILL_NAME: `tech-debt`
- ARGUMENTS: `research`

### Step 2: Generate Command File

Create `.claude/commands/{ALIAS}.md` with the following structure:

```markdown
---
command: {ALIAS}
description: Alias for {SKILL_NAME} {ARGUMENTS}
---

```typescript
await Skill({
  skill: "{SKILL_NAME}",
  args: "{ARGUMENTS}"
});
```

```

### Step 3: Verify Creation

After creating the file:

1. **Verify file exists**:
   ```bash
   ls -la .claude/commands/{ALIAS}.md
   ```

2. **Display file content**:
   ```bash
   cat .claude/commands/{ALIAS}.md
   ```

### Step 4: Report to User

Provide a concise summary:

```markdown
# Command Alias Created

**Alias**: `/{ALIAS}`
**Executes**: `/{SKILL_NAME} {ARGUMENTS}`
**File**: `.claude/commands/{ALIAS}.md`

## Usage

You can now use:
```
/{ALIAS}
```

Instead of:
```
/{SKILL_NAME} {ARGUMENTS}
```
```

## Implementation Notes

### Input Parsing

The input can be in these formats:
- `ALIAS='SKILL_NAME args'`
- `ALIAS="SKILL_NAME args"`
- `ALIAS=SKILL_NAME args` (no quotes)

Handle all variations by:
1. Split on `=` to get ALIAS and rest
2. Remove quotes from rest
3. Split on first space to get SKILL_NAME and ARGUMENTS

### File Path

- Always create files in `.claude/commands/`
- Use the ALIAS as the filename with `.md` extension
- Ensure directory exists before creating file

### YAML Front Matter

Required fields:
- `command` - The alias name (must match filename without .md)
- `description` - Brief description of what the alias does

Format:
```yaml
---
command: alias-name
description: Alias for skill-name operation
---
```

### TypeScript Block

Must be a valid TypeScript code block with:
- Three backticks with `typescript` language tag
- Proper await Skill() call syntax
- Both skill and args parameters as strings
- Proper closing backticks

Example:
````markdown
```typescript
await Skill({
  skill: "tech-debt",
  args: "research"
});
```
````

### Error Handling

If parsing fails:
- Report clear error message to user
- Show expected format
- Provide examples

If file creation fails:
- Check directory exists
- Check permissions
- Report specific error

## Examples

### Example 1: Tech Debt Research

**Input**: `tech-debt-research='tech-debt research'`

**Created File**: `.claude/commands/tech-debt-research.md`

```markdown
---
command: tech-debt-research
description: Alias for tech-debt research
---

```typescript
await Skill({
  skill: "tech-debt",
  args: "research"
});
```
```

### Example 2: Tech Debt Issue

**Input**: `tech-debt-issue='tech-debt issue'`

**Created File**: `.claude/commands/tech-debt-issue.md`

```markdown
---
command: tech-debt-issue
description: Alias for tech-debt issue
---

```typescript
await Skill({
  skill: "tech-debt",
  args: "issue"
});
```
```

### Example 3: PR Check Fix

**Input**: `pr-check-fix='pr-check fix'`

**Created File**: `.claude/commands/pr-check-fix.md`

```markdown
---
command: pr-check-fix
description: Alias for pr-check fix
---

```typescript
await Skill({
  skill: "pr-check",
  args: "fix"
});
```
```

## Guidelines

### Command Naming

- Use kebab-case for alias names
- Make aliases descriptive but concise
- Avoid conflicts with existing commands
- Use common prefixes for related commands

### Description Writing

- Keep descriptions brief (one line)
- Follow format: "Alias for {skill} {operation}"
- Don't include implementation details
- Focus on what it does, not how

### Testing

After creating an alias:
- Verify file is readable
- Check YAML front matter is valid
- Ensure TypeScript block is properly formatted
- Test that the alias works by using it

---

## Error Messages

### Invalid Input Format

```
Error: Invalid input format

Expected: ALIAS='SKILL_NAME arguments'
Received: {user-input}

Examples:
- tech-debt-research='tech-debt research'
- pr-check-fix='pr-check fix'
```

### Missing Components

```
Error: Could not parse input

Missing: {ALIAS/SKILL_NAME/ARGUMENTS}

Please provide input in format:
ALIAS='SKILL_NAME arguments'
```

### File Creation Failed

```
Error: Failed to create command file

File: .claude/commands/{ALIAS}.md
Reason: {error-message}

Please check:
- Directory exists and is writable
- No conflicting file exists
- Valid filename
```

---

## References

- Command documentation: `.claude/commands/`
- Skill documentation: `.claude/skills/`
- Example skills: `/tech-debt`, `/dev-server`
