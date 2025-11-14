# YAGNI (You Aren't Gonna Need It)

**This is a CORE PRINCIPLE for this project.** We follow the YAGNI principle strictly to keep the codebase simple and maintainable.

## What is YAGNI?

YAGNI stands for "You Aren't Gonna Need It" - a principle that states you should not add functionality until it is actually needed, not just when you foresee that you might need it.

## Core Philosophy

**Start with the simplest solution that works, then evolve as actual needs arise.**

The enemy of good code is not bad code - it's unnecessary code. Every line of code you write:
- Must be tested
- Must be maintained
- Increases complexity
- Can introduce bugs

Therefore, only write code that solves **current, real problems**.

## The Four Rules

### 1. Don't Add Functionality Until It's Actually Needed

❌ **Bad:**
```typescript
// Adding configuration options "just in case"
interface UserServiceConfig {
  timeout?: number;
  retries?: number;
  cacheTTL?: number;
  enableMetrics?: boolean;
  fallbackStrategy?: 'retry' | 'skip' | 'default';
}

class UserService {
  constructor(config?: UserServiceConfig) {
    // We only use timeout right now...
  }
}
```

✅ **Good:**
```typescript
// Only add what you need NOW
class UserService {
  constructor(private timeout: number) {}
}

// Add more config options later when they're actually needed
```

### 2. Start with the Simplest Solution That Works

❌ **Bad:**
```typescript
// Over-engineered abstraction for simple use case
interface DataStore<T> {
  get(id: string): Promise<T>;
  set(id: string, value: T): Promise<void>;
  delete(id: string): Promise<void>;
  bulkGet(ids: string[]): Promise<T[]>;
  query(predicate: (item: T) => boolean): Promise<T[]>;
}

class InMemoryDataStore<T> implements DataStore<T> {
  // Complex implementation with query support...
}

class RedisDataStore<T> implements DataStore<T> {
  // We don't even use Redis yet...
}

// Only using it to store one user object:
const userStore = new InMemoryDataStore<User>();
await userStore.set('current', user);
```

✅ **Good:**
```typescript
// Simple solution for current need
let currentUser: User | null = null;

// Add abstraction later if you need multiple storage backends
```

### 3. Avoid Premature Abstractions

❌ **Bad:**
```typescript
// Creating abstract factory pattern for 2 similar functions
abstract class Validator {
  abstract validate(value: string): boolean;
}

class EmailValidator extends Validator {
  validate(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
}

class PhoneValidator extends Validator {
  validate(phone: string): boolean {
    return /^\d{10}$/.test(phone);
  }
}

class ValidatorFactory {
  static create(type: 'email' | 'phone'): Validator {
    // Factory logic...
  }
}
```

✅ **Good:**
```typescript
// Simple functions - add abstraction only if you need it
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone: string): boolean {
  return /^\d{10}$/.test(phone);
}
```

### 4. Delete Unused Code Aggressively

❌ **Bad:**
```typescript
// Keeping "just in case" code
function calculateDiscount(price: number, code?: string) {
  // This feature was removed but we kept the code
  // if (code === 'SPECIAL') {
  //   return price * 0.5;
  // }

  return price;
}

// Unused utility function "might be useful someday"
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}
```

✅ **Good:**
```typescript
// Delete unused code - git history preserves it if you need it
function calculateDiscount(price: number) {
  return price;
}

// deepClone function deleted - add it back if/when needed
```

## Project-Specific Examples

### Test Helpers

❌ **Bad:**
```typescript
// test-utils.ts with many unused helpers
export const createMockUser = () => ({ ... });
export const createMockPost = () => ({ ... });
export const createMockComment = () => ({ ... });
export const waitForAsync = () => ({ ... });
export const setupTestDB = () => ({ ... });
export const mockAPICall = () => ({ ... });

// Only createMockUser is actually used in tests
```

✅ **Good:**
```typescript
// test-utils.ts with only actively used helpers
export const createMockUser = () => ({ ... });

// Add other helpers only when tests actually need them
```

### Configuration Files

❌ **Bad:**
```typescript
// config.ts with extensive configuration
export const config = {
  api: {
    timeout: 5000,
    retries: 3,
    baseURL: process.env.API_URL,
    headers: {},
    interceptors: [],
    rateLimitPerMinute: 100,
    enableCompression: true,
    enableCaching: false,
    cacheStrategy: 'memory',
  },
  features: {
    darkMode: false,
    betaFeatures: false,
    analytics: true,
    // 20 more feature flags we don't use...
  }
};

// We only use timeout and baseURL
```

✅ **Good:**
```typescript
// config.ts starting minimal
export const config = {
  apiTimeout: 5000,
  apiBaseURL: process.env.API_URL || 'https://api.example.com',
};

// Grow configuration as features are added
```

### Utility Functions

❌ **Bad:**
```typescript
// utils.ts with single-use "utility" functions
export function capitalizeFirstLetter(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Only used once in entire codebase
// Just inline it: user.name.charAt(0).toUpperCase() + user.name.slice(1)
```

✅ **Good:**
```typescript
// No utils.ts - only create utilities when:
// 1. Used in 3+ places, AND
// 2. Complex enough to warrant extraction

// For single use, inline the code
```

### "Just in Case" Parameters

❌ **Bad:**
```typescript
// Adding optional parameters we don't use yet
function fetchUsers(
  page?: number,
  limit?: number,
  sortBy?: string,
  sortOrder?: 'asc' | 'desc',
  filters?: Record<string, unknown>,
  includeDeleted?: boolean
) {
  // Currently only using basic fetch with no params
  return db.select().from(users);
}
```

✅ **Good:**
```typescript
// Start simple
function fetchUsers() {
  return db.select().from(users);
}

// Add parameters when pagination/filtering is actually needed
```

## When to Add Complexity

Only add complexity when:

### ✅ The Need is Current and Real
```typescript
// Bad: Adding caching "just in case performance becomes an issue"
// Good: Adding caching because load testing showed it's needed
```

### ✅ You Have 3+ Use Cases
```typescript
// Bad: Abstracting after first use
// Good: Abstracting after third similar usage
```

### ✅ Complexity is Less Than Duplication
```typescript
// Bad: Creating complex abstraction to avoid 3 lines of duplication
// Good: Creating abstraction when duplication causes real maintenance burden
```

## Common Violations

### Over-Engineering

❌ **Creating elaborate abstractions for simple problems:**
```typescript
// Implementing full repository pattern for single database query
interface Repository<T> {
  find(id: string): Promise<T>;
  findAll(): Promise<T[]>;
  save(entity: T): Promise<void>;
  delete(id: string): Promise<void>;
}

class UserRepository implements Repository<User> {
  // Elaborate implementation...
}

// Only need one query: SELECT * FROM users WHERE id = ?
```

### Feature Speculation

❌ **Adding features because "we might need them":**
```typescript
// Adding multi-language support "for future internationalization"
// when all users speak English and there's no i18n requirement
const messages = {
  en: { welcome: "Welcome" },
  es: { welcome: "Bienvenido" },
  fr: { welcome: "Bienvenue" },
};
```

### Generic Solutions

❌ **Building generic solutions for specific problems:**
```typescript
// Creating generic form builder when you only have 2 forms
class FormBuilder {
  // 500 lines of generic form generation logic
}

// Better: Just write the 2 forms directly
```

## Mental Framework

Before adding any code, ask:

1. **Do we need this RIGHT NOW?**
   - Not "might we need it later"
   - Not "it would be nice to have"
   - RIGHT NOW

2. **What is the simplest solution?**
   - Not "what's the most elegant"
   - Not "what's the most flexible"
   - The SIMPLEST

3. **Can we delete something instead?**
   - Maybe this feature isn't needed at all
   - Maybe existing code can be simplified

## Benefits of YAGNI

### Reduced Complexity
- Easier to understand codebase
- Fewer bugs
- Faster development

### Lower Maintenance Burden
- Less code to test
- Less code to document
- Less code to update

### Better Focus
- Solve real problems, not imaginary ones
- Deliver features faster
- Respond to actual user needs

## YAGNI vs Future-Proofing

**YAGNI doesn't mean:**
- Writing bad code
- Ignoring design principles
- Making changes impossible

**YAGNI means:**
- Don't predict the future
- Solve today's problems today
- Trust that you can refactor when needs change

## The Rule of Three

A good heuristic:

- **First time:** Write code inline
- **Second time:** Copy and paste (with awareness)
- **Third time:** Abstract into reusable function/component

Don't abstract before the third use.

## Practical Checklist

Before committing code, ask yourself:

- [ ] Is every function/parameter actually being used?
- [ ] Could this be simpler?
- [ ] Am I building for current needs or imagined future needs?
- [ ] Can I delete any code?
- [ ] Would this code still be needed if requirements change?

If you're building for imagined future needs → STOP and simplify.

## Remember

**The best code is no code at all.**

Every line of code is a liability. Write the minimum necessary to solve the current problem well.

**"Premature optimization is the root of all evil" - Donald Knuth**

This applies to features too:
**"Premature abstraction is the root of all evil."**
