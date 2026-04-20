# Zero Tolerance for Lint Violations

**All code must pass linting without exceptions. Maintain code quality standards consistently.**

## Core Principle

In this project, lint rules are **non-negotiable**. They exist to maintain code quality, consistency, and prevent bugs.

**If the linter complains, fix the code - don't silence the linter.**

## The Four Rules

### 1. Never Add eslint-disable Comments

❌ **Never do this:**
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data: any = fetchData();

/* eslint-disable */
function messyFunction() {
  // ... problematic code
}
/* eslint-enable */

// eslint-disable-next-line no-console
console.log("Debug info");
```

**Why this is bad:**
- Disabling linting means accepting poor code quality
- Creates technical debt
- The warning exists for a reason
- Future developers will copy this pattern

✅ **Do this instead:**
```typescript
// Fix the underlying issue
interface Data {
  users: User[];
}

const data: Data = fetchData();

// Refactor the function to comply with lint rules
function cleanFunction() {
  // ... well-structured code
}

// Use proper logging, not console.log
logger.debug("Debug info");
```

### 2. Never Add @ts-ignore or @ts-nocheck

❌ **Never do this:**
```typescript
// @ts-ignore
const user = data.user;

// @ts-expect-error
function broken() {
  return nonExistent.value;
}

// @ts-nocheck
// ... entire file without type checking
```

**Why this is bad:**
- Defeats the purpose of TypeScript
- Hides real type errors
- Makes code unsafe
- Prevents refactoring

✅ **Do this instead:**
```typescript
// Fix the types
interface Data {
  user: User;
}

const data: Data = getData();
const user = data.user;

// Or use type narrowing
if ('user' in data) {
  const user = data.user;
}
```

### 3. Fix the Underlying Issue

Don't suppress warnings - address the root cause.

❌ **Bad - Suppressing the symptom:**
```typescript
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const unusedVariable = computeValue();

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
data.process();
```

✅ **Good - Fixing the cause:**
```typescript
// Remove unused variable
computeValue(); // If side effect is needed

// Or don't call it at all if not needed

// Fix type issues
interface Data {
  process: () => void;
}

const data: Data = getData();
data.process();
```

### 4. Respect All Lint Rules

Every lint rule serves a purpose. Don't disable rules in config files.

❌ **Bad:**
```json
// .eslintrc.json
{
  "rules": {
    "@typescript-eslint/no-explicit-any": "off",
    "no-console": "off",
    "@typescript-eslint/no-unused-vars": "warn"
  }
}
```

✅ **Good:**
```json
// .eslintrc.json
{
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "no-console": "error",
    "@typescript-eslint/no-unused-vars": "error"
  }
}
```

## Common Lint Issues and Solutions

### Unused Variables

❌ **Bad:**
```typescript
function processUser(user: User, role: string) {
  // Only using user, role is unused
  return user.name;
}
```

✅ **Good - Remove it:**
```typescript
function processUser(user: User) {
  return user.name;
}
```

✅ **Good - Use prefix if needed for interface compliance:**
```typescript
function processUser(user: User, _role: string) {
  // _role indicates intentionally unused parameter
  return user.name;
}
```

### Console.log

❌ **Bad:**
```typescript
function fetchData() {
  console.log("Fetching data...");
  const data = getData();
  console.log("Data:", data);
  return data;
}
```

✅ **Good:**
```typescript
// Remove debug logs before committing
function fetchData() {
  return getData();
}

// Or use proper logging
import { logger } from './logger';

function fetchData() {
  logger.debug("Fetching data");
  const data = getData();
  logger.debug("Data retrieved", { data });
  return data;
}
```

### No-explicit-any

❌ **Bad:**
```typescript
function process(data: any) {
  return data.map((item: any) => item.value);
}
```

✅ **Good:**
```typescript
interface Item {
  value: string;
}

function process(data: Item[]) {
  return data.map(item => item.value);
}
```

### Prefer-const

❌ **Bad:**
```typescript
let user = getUser();
let count = 0;

// user and count never reassigned
console.log(user.name);
return count + 1;
```

✅ **Good:**
```typescript
const user = getUser();
const count = 0;

console.log(user.name);
return count + 1;
```

### No-var

❌ **Bad:**
```typescript
var user = getUser();
var total = 0;

for (var i = 0; i < items.length; i++) {
  total += items[i].price;
}
```

✅ **Good:**
```typescript
const user = getUser();
let total = 0;

for (let i = 0; i < items.length; i++) {
  total += items[i].price;
}

// Or better: use array methods
const total = items.reduce((sum, item) => sum + item.price, 0);
```

### No-empty

❌ **Bad:**
```typescript
try {
  riskyOperation();
} catch (error) {
  // Empty catch block
}

if (condition) {
  // Empty if block
}
```

✅ **Good:**
```typescript
// Either handle the error or remove try/catch
riskyOperation();

// Or handle it properly
try {
  riskyOperation();
} catch (error) {
  logger.error("Operation failed", { error });
  throw error;
}

// Remove empty if blocks
if (condition) {
  handleCondition();
}
```

### Eqeqeq (Strict Equality)

❌ **Bad:**
```typescript
if (value == null) {  // Loose equality
  return;
}

if (count == 0) {
  return;
}
```

✅ **Good:**
```typescript
if (value === null || value === undefined) {
  return;
}

// Or
if (value == null) {  // This is actually fine for null check
  return;
}

if (count === 0) {
  return;
}
```

### No-shadow

❌ **Bad:**
```typescript
const user = getUser();

function processUser() {
  const user = getCurrentUser();  // Shadows outer user
  return user.name;
}
```

✅ **Good:**
```typescript
const user = getUser();

function processUser() {
  const currentUser = getCurrentUser();
  return currentUser.name;
}
```

## Project-Specific Lint Rules

### Import Order

Keep imports organized:

✅ **Good:**
```typescript
// 1. External libraries
import { useState } from 'react';
import { NextRequest } from 'next/server';

// 2. Internal modules
import { db } from '@/lib/db';
import { User } from '@/types';

// 3. Relative imports
import { Button } from './button';
import styles from './styles.module.css';
```

### Unused Imports

❌ **Bad:**
```typescript
import { User, Post, Comment } from './types';
import { formatDate } from './utils';

// Only using User
function getUser(): User {
  return db.query.users.findFirst();
}
```

✅ **Good:**
```typescript
import { User } from './types';

function getUser(): User {
  return db.query.users.findFirst();
}
```

### React Hooks Rules

❌ **Bad:**
```typescript
function MyComponent({ condition }: Props) {
  if (condition) {
    const [value, setValue] = useState(0);  // Conditional hook
  }

  const handleClick = () => {
    const [count, setCount] = useState(0);  // Hook in callback
  };
}
```

✅ **Good:**
```typescript
function MyComponent({ condition }: Props) {
  const [value, setValue] = useState(0);

  const handleClick = () => {
    setValue(value + 1);
  };
}
```

## Handling Lint Errors

### Step 1: Read the Error Message

Lint errors tell you what's wrong:

```
error: Unexpected console statement (no-console)
error: 'user' is assigned a value but never used (@typescript-eslint/no-unused-vars)
error: Missing return type on function (@typescript-eslint/explicit-function-return-type)
```

### Step 2: Understand Why the Rule Exists

Before fixing, understand the purpose:
- `no-console`: Prevent debug code in production
- `no-unused-vars`: Clean up dead code
- `explicit-function-return-type`: Improve type safety

### Step 3: Fix the Root Cause

Don't just silence the warning - fix the underlying issue:

```typescript
// Error: no-console
console.log("User data:", user);

// ❌ Bad fix
// eslint-disable-next-line no-console
console.log("User data:", user);

// ✅ Good fix
logger.debug("User data", { user });

// Or remove it entirely if it's just debug code
```

### Step 4: Run Linter Again

Verify the fix:

```bash
cd turbo && pnpm turbo run lint
```

## Pre-Commit Workflow

### Always lint before committing:

```bash
cd turbo
pnpm turbo run lint
pnpm check-types
pnpm format
pnpm vitest
```

All must pass before committing.

## Auto-Fix Where Possible

Some lint errors can be auto-fixed:

```bash
# Auto-fix formatting
pnpm format

# Auto-fix some lint issues
pnpm turbo run lint --fix
```

**But verify the fixes!** Don't blindly accept auto-fixes.

## When You Think a Rule is Wrong

If you believe a lint rule is incorrect:

1. **First, assume the rule is right** - It probably is
2. **Understand the rule's purpose** - Read the documentation
3. **Try to fix the code** - There's usually a better way
4. **Discuss with team** - Don't just disable it

**In this project, we maintain zero tolerance.** Don't disable rules.

## Benefits of Zero Lint Tolerance

### Consistent Code Quality
- All code follows same standards
- No exceptions create inconsistency
- Easy to understand codebase

### Catch Bugs Early
- Unused variables might indicate logic errors
- Type errors caught before runtime
- Best practices enforced

### Better Collaboration
- No arguments about code style
- Automated enforcement
- Clear expectations

### Easier Maintenance
- Find dead code easily
- Refactor with confidence
- No technical debt accumulation

## Common Justifications (and Why They're Wrong)

### "It's just a quick fix"
❌ Quick fixes become permanent
✅ Do it right the first time

### "I'll clean it up later"
❌ Later never comes
✅ Clean code now

### "The linter is being too strict"
❌ Strict rules prevent bugs
✅ Fix the code, not the linter

### "This is a special case"
❌ Every case becomes special
✅ No exceptions

## Tools and Commands

### Check for lint errors:
```bash
cd turbo
pnpm turbo run lint
```

### Auto-fix fixable issues:
```bash
pnpm turbo run lint --fix
```

### Check types:
```bash
pnpm check-types
```

### Format code:
```bash
pnpm format
```

### Run all checks:
```bash
pnpm turbo run lint
pnpm check-types
pnpm format
pnpm vitest
```

## Remember

**Lint rules exist to help you write better code.**

- Never disable linting
- Fix the root cause
- Respect all rules
- Zero tolerance means zero tolerance

**"If the linter complains, the code is wrong - not the linter."**
