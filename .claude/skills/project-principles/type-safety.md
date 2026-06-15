# Strict Type Checking

**Maintain type safety throughout the codebase. Never compromise on type checking.**

## Core Principle

In this project, we treat TypeScript as a **strict, type-safe language** - not as "JavaScript with optional types."

**Type safety is non-negotiable.**

## The Four Rules

### 1. Absolutely NO Use of `any` Type

The `any` type defeats the entire purpose of TypeScript. It disables type checking and makes code unsafe.

❌ **Never do this:**
```typescript
function processData(data: any) {
  return data.map((item: any) => item.value);
}

const config: any = loadConfig();
const result: any = await fetchData();
```

✅ **Always do this:**
```typescript
interface DataItem {
  value: string;
}

function processData(data: DataItem[]) {
  return data.map(item => item.value);
}

interface Config {
  apiUrl: string;
  timeout: number;
}

const config: Config = loadConfig();

interface APIResponse {
  users: User[];
  total: number;
}

const result: APIResponse = await fetchData();
```

**If you truly don't know the type, use `unknown` instead:**

```typescript
// For external data that needs runtime validation
function parseExternalData(data: unknown): User {
  // Validate and narrow the type
  if (!isValidUser(data)) {
    throw new Error("Invalid user data");
  }
  return data;
}
```

### 2. Always Provide Explicit Types

Don't rely on inference when the type isn't obvious. Make types explicit.

❌ **Avoid implicit types in public APIs:**
```typescript
// What does this return? Have to read implementation to know
export function getUser(id) {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}

// What should options contain? Unclear
export function createReport(options) {
  // ...
}
```

✅ **Make types explicit:**
```typescript
export function getUser(id: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}

interface ReportOptions {
  startDate: Date;
  endDate: Date;
  format: 'pdf' | 'csv';
}

export function createReport(options: ReportOptions): Promise<Report> {
  // ...
}
```

**Function parameters must ALWAYS have explicit types:**

```typescript
// ❌ Bad
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

// ✅ Good
function calculateTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
```

### 3. Use Proper Type Narrowing

Don't use type assertions (`as`) to force types. Use type narrowing instead.

❌ **Bad - Type assertions:**
```typescript
function processUser(data: unknown) {
  const user = data as User;  // Dangerous! No runtime check
  return user.email.toLowerCase();
}

const element = document.getElementById('my-input') as HTMLInputElement;
element.value = 'hello';  // Could be null!
```

✅ **Good - Type narrowing:**
```typescript
function isUser(data: unknown): data is User {
  return (
    typeof data === 'object' &&
    data !== null &&
    'email' in data &&
    typeof data.email === 'string'
  );
}

function processUser(data: unknown): string {
  if (!isUser(data)) {
    throw new Error("Invalid user data");
  }
  return data.email.toLowerCase();
}

const element = document.getElementById('my-input');
if (element instanceof HTMLInputElement) {
  element.value = 'hello';
}
```

**Type assertions are only acceptable when:**

1. You know more than TypeScript (rare)
2. Working with DOM elements that TypeScript can't infer

```typescript
// Acceptable: TypeScript can't know the element type
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

// Acceptable: You know this will be User[] after validation
const users = validatedData as User[];
```

### 4. Define Interfaces and Types for All Data Structures

Every data structure in the codebase should have a defined type.

❌ **Bad - Inline types:**
```typescript
function createUser(user: {
  name: string;
  email: string;
  age?: number
}) {
  return db.insert(users).values(user);
}

function updateUser(id: string, updates: {
  name?: string;
  email?: string;
  age?: number;
}) {
  return db.update(users).set(updates).where(eq(users.id, id));
}

// Type is duplicated and can drift
```

✅ **Good - Defined interfaces:**
```typescript
interface User {
  id: string;
  name: string;
  email: string;
  age?: number;
}

type NewUser = Omit<User, 'id'>;
type UserUpdate = Partial<NewUser>;

function createUser(user: NewUser) {
  return db.insert(users).values(user);
}

function updateUser(id: string, updates: UserUpdate) {
  return db.update(users).set(updates).where(eq(users.id, id));
}
```

## Common Scenarios

### API Responses

❌ **Bad:**
```typescript
async function fetchUsers() {
  const response = await fetch('/api/users');
  const data = await response.json();  // Type: any
  return data;
}
```

✅ **Good:**
```typescript
interface User {
  id: string;
  name: string;
  email: string;
}

interface UsersResponse {
  users: User[];
  total: number;
  page: number;
}

async function fetchUsers(): Promise<UsersResponse> {
  const response = await fetch('/api/users');
  const data: UsersResponse = await response.json();
  return data;
}

// Even better: validate runtime data
async function fetchUsers(): Promise<UsersResponse> {
  const response = await fetch('/api/users');
  const data: unknown = await response.json();

  if (!isUsersResponse(data)) {
    throw new Error("Invalid API response");
  }

  return data;
}
```

### Event Handlers

❌ **Bad:**
```typescript
function handleClick(e) {
  e.preventDefault();
  console.log(e.target.value);
}

<button onClick={handleClick}>Click</button>
```

✅ **Good:**
```typescript
function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
  e.preventDefault();
  // TypeScript knows e.target is HTMLButtonElement
}

<button onClick={handleClick}>Click</button>
```

### Form Data

❌ **Bad:**
```typescript
function handleSubmit(e) {
  e.preventDefault();
  const formData = new FormData(e.target);
  const data = Object.fromEntries(formData);  // Type: any
  submitData(data);
}
```

✅ **Good:**
```typescript
interface FormValues {
  email: string;
  password: string;
}

function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
  e.preventDefault();
  const formData = new FormData(e.currentTarget);

  const data: FormValues = {
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  };

  // Or better: validate
  const email = formData.get('email');
  const password = formData.get('password');

  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new Error("Invalid form data");
  }

  const data: FormValues = { email, password };
  submitData(data);
}
```

### Database Queries

❌ **Bad:**
```typescript
const users = await db.select().from(users);  // Type is inferred, might be wrong

function getUser(id) {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}
```

✅ **Good:**
```typescript
import { User } from './schema';

const users: User[] = await db.select().from(usersTable);

function getUser(id: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: eq(usersTable.id, id) });
}
```

### State Management

❌ **Bad:**
```typescript
const [data, setData] = useState();  // Type: any
const [user, setUser] = useState(null);  // Type: null
```

✅ **Good:**
```typescript
const [data, setData] = useState<Data | null>(null);
const [user, setUser] = useState<User | null>(null);
const [items, setItems] = useState<Item[]>([]);

// Or with initial value
const [count, setCount] = useState(0);  // Type inferred as number
```

## Advanced Type Patterns

### Union Types

Use union types for values that can be one of several types:

```typescript
type Status = 'pending' | 'approved' | 'rejected';

interface Order {
  id: string;
  status: Status;
}

function updateStatus(orderId: string, status: Status) {
  // TypeScript ensures status is one of the allowed values
}

// ✅ Valid
updateStatus('123', 'approved');

// ❌ TypeScript error
updateStatus('123', 'invalid');
```

### Discriminated Unions

Use discriminated unions for complex types:

```typescript
interface SuccessResult {
  success: true;
  data: User;
}

interface ErrorResult {
  success: false;
  error: string;
}

type Result = SuccessResult | ErrorResult;

function handleResult(result: Result) {
  if (result.success) {
    // TypeScript knows result.data exists
    console.log(result.data.email);
  } else {
    // TypeScript knows result.error exists
    console.log(result.error);
  }
}
```

### Generic Types

Use generics for reusable type-safe functions:

```typescript
function first<T>(items: T[]): T | undefined {
  return items[0];
}

const firstUser = first<User>(users);  // Type: User | undefined
const firstNumber = first([1, 2, 3]);  // Type: number | undefined
```

### Utility Types

Use TypeScript utility types:

```typescript
interface User {
  id: string;
  name: string;
  email: string;
  password: string;
}

// Omit password from public user
type PublicUser = Omit<User, 'password'>;

// All fields optional for updates
type UserUpdate = Partial<User>;

// Make all fields required
type RequiredUser = Required<User>;

// Pick specific fields
type UserCredentials = Pick<User, 'email' | 'password'>;

// Make fields readonly
type ReadonlyUser = Readonly<User>;
```

## Type Guards

Create type guards for runtime validation:

```typescript
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'name' in value &&
    'email' in value &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.email === 'string'
  );
}

function processValue(value: unknown) {
  if (isString(value)) {
    // TypeScript knows value is string
    return value.toUpperCase();
  }

  if (isUser(value)) {
    // TypeScript knows value is User
    return value.email;
  }

  throw new Error("Invalid value");
}
```

## Configuration

Ensure `tsconfig.json` has strict mode enabled:

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "alwaysStrict": true
  }
}
```

## Common Mistakes

### Mistake 1: Using `any` for "Quick Fix"

❌ **Bad:**
```typescript
// "I'll fix the types later"
const data: any = await fetchData();
```

✅ **Good:**
```typescript
// Define types properly from the start
interface APIData {
  users: User[];
}

const data: APIData = await fetchData();
```

### Mistake 2: Type Assertion Instead of Validation

❌ **Bad:**
```typescript
const user = JSON.parse(jsonString) as User;
```

✅ **Good:**
```typescript
const parsed: unknown = JSON.parse(jsonString);

if (!isUser(parsed)) {
  throw new Error("Invalid user data");
}

const user: User = parsed;
```

### Mistake 3: Implicit `any` in Callbacks

❌ **Bad:**
```typescript
items.forEach(item => {  // item: any
  console.log(item.name);
});
```

✅ **Good:**
```typescript
items.forEach((item: Item) => {
  console.log(item.name);
});

// Or better: let TypeScript infer from array type
const items: Item[] = getItems();
items.forEach(item => {  // item: Item (inferred)
  console.log(item.name);
});
```

## When Types Get Complex

If types become very complex, you might be violating YAGNI. Ask:

1. **Do I really need this complexity?**
2. **Can I simplify the data structure?**
3. **Am I over-engineering?**

Example of over-engineering:

```typescript
// ❌ Too complex for simple needs
type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

type NestedUpdate<T> = {
  [K in keyof T]?: T[K] extends object
    ? NestedUpdate<T[K]>
    : T[K];
};

// ✅ Simple and sufficient
type UserUpdate = Partial<User>;
```

## Benefits of Strict Type Checking

### Catch Errors at Compile Time
- Find bugs before runtime
- Prevent null/undefined errors
- Ensure API contracts are met

### Better IDE Support
- Accurate autocomplete
- Inline documentation
- Refactoring support

### Self-Documenting Code
- Types serve as documentation
- Clear function contracts
- Easier to understand code

### Safer Refactoring
- TypeScript catches breaking changes
- Confidence when modifying code
- Find all usages automatically

## Remember

**Types are not overhead - they're safety guarantees.**

- No `any` - ever
- Explicit types for public APIs
- Type narrowing over type assertions
- Define all data structures

**If TypeScript complains, fix the code - don't silence TypeScript.**
