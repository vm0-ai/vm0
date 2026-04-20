# Avoid Defensive Programming

**Let exceptions propagate naturally. Don't wrap everything in try/catch blocks.**

## What is Defensive Programming?

Defensive programming is the practice of adding excessive error handling, validation, and safety checks to "defend" against errors - even when those errors should naturally propagate or can't be meaningfully handled.

**In this project, we AVOID defensive programming.**

## Core Philosophy

**Only catch exceptions when you can meaningfully handle them.**

The runtime and framework already handle errors well. Trust them. Don't add unnecessary try/catch blocks that just log and re-throw - this adds noise without adding value.

## The Three Rules

### 1. Only Catch When You Can Meaningfully Handle

❌ **Bad - Defensive programming:**
```typescript
export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    const body = await request.json();
    const result = await db.select().from(table);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error:", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
```

**Problems:**
- Catches all errors indiscriminately
- Loses error details by returning generic message
- Console.error doesn't help in production
- Can't distinguish between auth errors, validation errors, db errors

✅ **Good - Let errors propagate:**
```typescript
export async function POST(request: NextRequest) {
  const { userId } = await auth();
  const body = await request.json();
  const result = await db.select().from(table);
  return NextResponse.json(result);
}
```

**Why good:**
- Framework handles errors appropriately
- Error details preserved for debugging
- Different errors get different HTTP status codes
- Simpler and more maintainable

### 2. Let Errors Bubble Up

❌ **Bad - Catching too early:**
```typescript
async function getUserData(userId: string) {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId)
    });
    return user;
  } catch (error) {
    console.error("Database error:", error);
    throw error; // Just re-throwing anyway!
  }
}
```

**Problems:**
- Try/catch adds no value
- Just logging and re-throwing
- Better to let error propagate to where it can be handled

✅ **Good - Let it propagate:**
```typescript
async function getUserData(userId: string) {
  return db.query.users.findFirst({
    where: eq(users.id, userId)
  });
}
```

**Why good:**
- Error propagates to route handler or caller
- Caller can decide how to handle
- Less code to maintain

### 3. Trust the Runtime

❌ **Bad - Over-defensive validation:**
```typescript
function calculateTotal(items: CartItem[]) {
  try {
    if (!items) {
      throw new Error("Items is null or undefined");
    }
    if (!Array.isArray(items)) {
      throw new Error("Items must be an array");
    }
    if (items.length === 0) {
      return 0;
    }

    let total = 0;
    for (const item of items) {
      if (!item) {
        throw new Error("Item is null or undefined");
      }
      if (typeof item.price !== 'number') {
        throw new Error("Price must be a number");
      }
      if (item.price < 0) {
        throw new Error("Price cannot be negative");
      }
      total += item.price * (item.quantity || 1);
    }
    return total;
  } catch (error) {
    console.error("Error calculating total:", error);
    return 0;
  }
}
```

**Problems:**
- Overly defensive validation
- TypeScript already ensures types
- Catching errors just to return 0 masks real issues
- Caller doesn't know something went wrong

✅ **Good - Trust types:**
```typescript
function calculateTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
```

**Why good:**
- TypeScript ensures items is an array of CartItem
- CartItem type ensures price and quantity exist
- If types are wrong, error should surface, not be hidden

## When to Use Try/Catch

### ✅ When You Have Specific Error Recovery Logic

```typescript
const handleSubmit = async () => {
  try {
    const response = await fetch("/api/endpoint");
    if (!response.ok) throw new Error("Request failed");
    setSuccess(true);
  } catch (err) {
    // Meaningful handling: show user-friendly error in UI
    setError(err instanceof Error ? err.message : "An error occurred");
  }
};
```

**Why good:**
- Catches error to update UI state
- User needs to see the error
- Specific recovery action (setError)

### ✅ When You Need to Transform the Error

```typescript
async function fetchUserProfile(userId: string) {
  try {
    return await externalAPI.getUser(userId);
  } catch (error) {
    // Transform external error to our domain error
    throw new UserNotFoundError(`User ${userId} not found`, { cause: error });
  }
}
```

**Why good:**
- Wraps external error in domain-specific error
- Adds context (userId)
- Maintains error chain with cause

### ✅ When You Need Cleanup Logic

```typescript
async function processFile(filePath: string) {
  const file = await fs.open(filePath);
  try {
    return await file.readFile();
  } finally {
    // Always close file, even if read fails
    await file.close();
  }
}
```

**Why good:**
- Finally block ensures cleanup
- Not catching just to log
- Specific need for resource management

## Project-Specific Guidelines

### Database Operations

❌ **Bad:**
```typescript
async function createUser(data: NewUser) {
  try {
    const user = await db.insert(users).values(data).returning();
    return user;
  } catch (error) {
    console.error("Failed to create user:", error);
    throw new Error("User creation failed");
  }
}
```

✅ **Good:**
```typescript
async function createUser(data: NewUser) {
  return db.insert(users).values(data).returning();
}
```

**Why:** Database should fail fast. Let the error propagate with full details.

### API Routes

❌ **Bad:**
```typescript
export async function GET(request: NextRequest) {
  try {
    const data = await fetchData();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
```

✅ **Good:**
```typescript
export async function GET(request: NextRequest) {
  const data = await fetchData();
  return NextResponse.json(data);
}
```

**Why:** Next.js error handling will catch and format the error appropriately.

### File Operations

❌ **Bad:**
```typescript
async function readConfig() {
  try {
    const content = await fs.readFile('config.json', 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error("Config read error:", error);
    return {}; // Returning empty object masks the problem
  }
}
```

✅ **Good:**
```typescript
async function readConfig() {
  const content = await fs.readFile('config.json', 'utf-8');
  return JSON.parse(content);
}
```

**Why:** If config file is missing or invalid, that's a fatal error. Don't mask it.

## Exceptions to the Rule

### Client-Side UI Error Handling

In React components, you often need try/catch to update UI state:

✅ **Acceptable:**
```typescript
const handleLogin = async (credentials: LoginCredentials) => {
  setLoading(true);
  setError(null);

  try {
    const user = await login(credentials);
    setUser(user);
    navigate('/dashboard');
  } catch (err) {
    // Show error to user
    setError(err instanceof Error ? err.message : 'Login failed');
  } finally {
    setLoading(false);
  }
};
```

**Why acceptable:** UI needs to react to errors. This is meaningful error handling.

### External API Integration

When calling unreliable external APIs:

✅ **Acceptable:**
```typescript
async function fetchExternalData(id: string) {
  try {
    return await unstableExternalAPI.getData(id);
  } catch (error) {
    // Fallback to cached data
    return getCachedData(id);
  }
}
```

**Why acceptable:** Specific fallback strategy. Not just logging and re-throwing.

## Real-World Examples

### Example 1: Form Submission

❌ **Defensive:**
```typescript
async function submitForm(data: FormData) {
  try {
    if (!data) {
      throw new Error("No data provided");
    }

    try {
      const validated = validateFormData(data);
      try {
        const result = await saveToDatabase(validated);
        return { success: true, data: result };
      } catch (dbError) {
        console.error("Database error:", dbError);
        throw new Error("Failed to save");
      }
    } catch (validationError) {
      console.error("Validation error:", validationError);
      throw new Error("Invalid data");
    }
  } catch (error) {
    console.error("Form submission error:", error);
    return { success: false, error: "Submission failed" };
  }
}
```

✅ **Correct:**
```typescript
async function submitForm(data: FormData) {
  const validated = validateFormData(data);
  return saveToDatabase(validated);
}

// In the UI component:
const handleSubmit = async (data: FormData) => {
  try {
    await submitForm(data);
    setSuccess(true);
  } catch (error) {
    setError(error instanceof Error ? error.message : "Submission failed");
  }
};
```

### Example 2: Data Transformation

❌ **Defensive:**
```typescript
function transformUserData(user: User) {
  try {
    if (!user) {
      throw new Error("User is null");
    }

    try {
      return {
        id: user.id || "",
        name: user.name || "Unknown",
        email: user.email || "",
      };
    } catch (error) {
      console.error("Transformation error:", error);
      return null;
    }
  } catch (error) {
    console.error("User data error:", error);
    return null;
  }
}
```

✅ **Correct:**
```typescript
function transformUserData(user: User): TransformedUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
  };
}
```

**Why:** Types ensure user has all required fields. If not, it should fail.

## Mental Framework

Before adding try/catch, ask:

### 1. Can I Meaningfully Handle This Error?

- ❌ "Log and re-throw" → Not meaningful
- ❌ "Return null/empty" → Masks problem
- ✅ "Show user feedback" → Meaningful
- ✅ "Use fallback data" → Meaningful
- ✅ "Cleanup resources" → Meaningful

### 2. Where Should This Error Be Handled?

- ❌ In utility function → Too early
- ❌ In data layer → Too early
- ✅ In route handler → Right place
- ✅ In UI component → Right place

### 3. Does TypeScript Already Prevent This?

- ❌ Checking if array is null when type is `Array<T>` → Unnecessary
- ❌ Checking if number is NaN when type is `number` → Unnecessary
- ✅ Runtime checks for external data → Necessary

## Common Anti-Patterns

### Anti-Pattern 1: Log and Re-throw

❌ **Never do this:**
```typescript
try {
  await doSomething();
} catch (error) {
  console.error(error);
  throw error;
}
```

**Why bad:** Try/catch adds no value. Just remove it.

### Anti-Pattern 2: Catch and Return Default

❌ **Avoid this:**
```typescript
try {
  return await fetchData();
} catch (error) {
  return [];
}
```

**Why bad:** Masks real errors. Caller doesn't know something failed.

### Anti-Pattern 3: Generic Error Messages

❌ **Avoid this:**
```typescript
try {
  // ... complex logic
} catch (error) {
  throw new Error("Something went wrong");
}
```

**Why bad:** Loses error details. Makes debugging impossible.

## Benefits of Avoiding Defensive Programming

### Cleaner Code
- Less boilerplate
- Easier to read
- Clearer logic flow

### Better Debugging
- Errors surface with full stack traces
- No masked failures
- Easier to identify root cause

### Faster Development
- Less code to write
- Less code to test
- Fewer edge cases to consider

## Remember

**Trust the framework. Trust TypeScript. Let errors surface naturally.**

Only add error handling when you have a specific, meaningful way to handle the error.

**"The best error handling is the error handling you don't write."**
