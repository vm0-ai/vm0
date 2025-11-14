---
name: Project Principles
description: Core architectural and code quality principles that guide all development decisions in the uspark project
---

# Project Principles Skill

This skill defines the fundamental design principles and coding standards for the uspark project. These principles are MANDATORY for all code written in this project and should guide every development decision.

## The Four Core Principles

### 1. YAGNI (You Aren't Gonna Need It) ⭐ CORE PRINCIPLE

**Don't add functionality until it's actually needed.**

Quick rules:
- Start with the simplest solution that works
- Avoid premature abstractions
- Delete unused code aggressively
- No "just in case" features

**When coding:** Ask "Do we need this NOW?" If not, don't add it.

→ For detailed guidelines and examples, read `yagni.md`

### 2. Avoid Defensive Programming

**Let exceptions propagate naturally. Don't wrap everything in try/catch.**

Quick rules:
- Only catch exceptions when you can meaningfully handle them
- Let errors bubble up to where they can be properly addressed
- Avoid defensive try/catch blocks that just log and re-throw
- Trust the runtime and framework error handling

**When coding:** Only use try/catch when you have specific error recovery logic.

→ For detailed guidelines and examples, read `no-defensive.md`

### 3. Strict Type Checking

**Maintain type safety throughout the codebase. Never compromise on type checking.**

Quick rules:
- Absolutely NO use of `any` type
- Always provide explicit types where TypeScript can't infer
- Use proper type narrowing instead of type assertions
- Define interfaces and types for all data structures

**When coding:** If you see `any`, fix it. If types are missing, add them.

→ For detailed guidelines and examples, read `type-safety.md`

### 4. Zero Tolerance for Lint Violations

**All code must pass linting without exceptions.**

Quick rules:
- Never add eslint-disable comments
- Never add @ts-ignore or @ts-nocheck
- Fix the underlying issue, don't suppress the warning
- All lint rules are there for a reason - respect them

**When coding:** If lint fails, fix the code, not the linter.

→ For detailed guidelines and examples, read `zero-lint.md`

## Quick Reference: Code Quality Checklist

Before writing any code, verify:
- ✅ Is this feature needed NOW? (YAGNI)
- ✅ Am I avoiding unnecessary try/catch? (No Defensive)
- ✅ Are all types explicit and correct? (Type Safety)
- ✅ Will this pass linting? (Zero Lint)

## When to Load Additional Context

- **Starting a new feature?** → Read `yagni.md` first
- **Handling errors?** → Read `no-defensive.md`
- **Working with TypeScript?** → Read `type-safety.md`
- **Getting lint errors?** → Read `zero-lint.md`

## Integration with Workflow

These principles should be applied:
1. **Before writing code** - Plan with YAGNI in mind
2. **While writing code** - Follow type safety and avoid defensive programming
3. **Before committing** - Ensure zero lint violations
4. **During code review** - Verify adherence to all principles

## Philosophy

These principles exist to:
- Keep the codebase simple and maintainable
- Prevent technical debt accumulation
- Ensure high code quality
- Make the project easy to understand and modify

They may feel restrictive at first, but they lead to cleaner, more maintainable code.

## Conflict Resolution

If principles seem to conflict:
1. YAGNI takes precedence - simplicity wins
2. Type safety is non-negotiable
3. When in doubt, choose the simpler solution
