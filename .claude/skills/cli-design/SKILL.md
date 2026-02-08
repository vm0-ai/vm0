---
name: CLI Design
description: Design patterns and conventions for the vm0 CLI user experience
context: fork
---

# CLI Design Skill

Use this skill when writing new CLI commands, reviewing CLI code, or fixing inconsistencies.

## Documentation

Read the CLI design guideline: [docs/cli-design-guideline.md](../../../docs/cli-design-guideline.md)

## Key Principles

1. **Atomic Command** — each command does one operation, agents compose them freely
2. **TTY & Non-TTY** — every command works in both interactive and programmatic modes
3. **Guided Flow** — output always guides to the next action (success → next step, error → remediation, empty → creation)
