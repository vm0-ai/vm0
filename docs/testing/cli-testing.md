# CLI Testing Patterns

## Principle

In the CLI app (`turbo/apps/cli`), only write **CLI Command Integration Tests**. Test commands via `command.parseAsync()` with MSW mocking the Web API.

**Integration boundary:**
- **Entry point**: Commander.js command action (`command.parseAsync()`)
- **Mock (external)**: Web API via MSW, third-party packages (`ably`)
- **Real (internal)**: All CLI code, filesystem, config, validators, domain logic

---

## File Location

Test files should be placed in `__tests__/` directories next to the command files. **Each subcommand should have its own test file with the same name as the command file.**

```
src/commands/
├── artifact/
│   ├── __tests__/
│   │   ├── init.test.ts      # Tests for init.ts
│   │   ├── push.test.ts      # Tests for push.ts
│   │   ├── pull.test.ts      # Tests for pull.ts
│   │   ├── status.test.ts    # Tests for status.ts
│   │   ├── list.test.ts      # Tests for list.ts
│   │   └── clone.test.ts     # Tests for clone.ts
│   ├── index.ts              # Main command (artifactCommand)
│   ├── init.ts
│   ├── push.ts
│   ├── pull.ts
│   ├── status.ts
│   ├── list.ts
│   └── clone.ts
├── compose/
│   ├── __tests__/
│   │   └── index.test.ts     # Single file command
│   └── index.ts
```

**Naming Convention:**
- Test file name = Command file name (e.g., `init.ts` → `init.test.ts`)
- For single-file commands, use `index.test.ts`
- Each test file focuses on one subcommand's complete behavior

---

## Test File Structure

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { composeCommand } from "../compose";
import { mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";

describe("compose command", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup environment
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Setup temp directory
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-compose-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("should create compose successfully", async () => {
    // Setup MSW handler
    server.use(
      http.post("http://localhost:3000/api/agent/composes", () => {
        return HttpResponse.json({
          composeId: "cmp-123",
          name: "test-agent",
          action: "created",
        });
      }),
    );

    // Create test file
    await fs.writeFile(
      path.join(tempDir, "vm0.yaml"),
      'version: "1.0"\nagents:\n  test:\n    framework: claude-code',
    );

    // Execute command
    await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

    // Assert on console output (CLI behavior)
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Compose created"),
    );
  });
});
```

---

## Environment Setup

Use `vi.stubEnv()` to configure environment variables. Do NOT mock the config module.

**Bad Case**

```typescript
// Mocking internal config module
vi.mock("../../lib/api/config", () => ({
  getApiUrl: vi.fn().mockResolvedValue("http://localhost:3000"),
  getToken: vi.fn().mockResolvedValue("test-token"),
}));
```

**Good Case**

```typescript
beforeEach(() => {
  vi.stubEnv("VM0_API_URL", "http://localhost:3000");
  vi.stubEnv("VM0_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});
```

---

## Mock

Only mock external services. The Web API is external to CLI.

**Bad Case**

```typescript
// Mocking internal modules
vi.mock("../../lib/domain/yaml-validator");
vi.mock("../../lib/storage/storage-utils");
vi.mock("../../lib/api/config");
```

**Good Case**

```typescript
// MSW for Web API (external)
import { server } from "../../mocks/server";
import { http, HttpResponse } from "msw";

server.use(
  http.post("http://localhost:3000/api/agent/composes", () => {
    return HttpResponse.json({ composeId: "cmp-123" });
  }),
);

// Third-party packages (external)
vi.mock("ably");
```

---

## Filesystem

CLI uses filesystem as state storage. Use real filesystem with temp directories.

**Setup Pattern**

```typescript
let tempDir: string;
let originalCwd: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "test-"));
  originalCwd = process.cwd();
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});
```

**Creating Test Files**

```typescript
// Create vm0.yaml for compose tests
await fs.writeFile(
  path.join(tempDir, "vm0.yaml"),
  'version: "1.0"\nagents:\n  test:\n    framework: claude-code',
);

// Create storage config for volume/artifact tests
await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
await fs.writeFile(
  path.join(tempDir, ".vm0", "storage.yaml"),
  "name: test-volume\ntype: volume",
);
```

---

## CLI-Specific Assertions

These patterns are valid for CLI testing because they test user-visible behavior.

### Console Output

Console output IS the CLI user interface. Asserting on it is testing behavior.

```typescript
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});

// After command execution
expect(mockConsoleLog).toHaveBeenCalledWith(
  expect.stringContaining("Compose created: user/my-agent"),
);
expect(mockConsoleError).toHaveBeenCalledWith(
  expect.stringContaining("Config file not found"),
);
```

### Exit Codes

Exit codes are how CLI communicates success/failure to the shell.

```typescript
const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit called");
}) as never);

// Test error case
await expect(async () => {
  await command.parseAsync(["node", "cli", "invalid-arg"]);
}).rejects.toThrow("process.exit called");

expect(mockExit).toHaveBeenCalledWith(1);
```

---

## Interactive Prompts

Test both interactive and non-interactive modes. Use `prompts.inject()` for interactive mode testing.

### Non-Interactive Mode

When `isInteractive()` returns `false` (non-TTY environment), prompts return `undefined` automatically. Test that commands handle this gracefully.

```typescript
// Test that command requires flags in non-interactive mode
it("should require --name flag in non-interactive mode", async () => {
  // Non-TTY by default in test environment
  await expect(async () => {
    await initCommand.parseAsync(["node", "cli"]);
  }).rejects.toThrow("process.exit called");

  expect(mockConsoleError).toHaveBeenCalledWith(
    expect.stringContaining("--name flag is required"),
  );
});

// Test with flag (works in both modes)
it("should create files with --name flag", async () => {
  await initCommand.parseAsync(["node", "cli", "--name", "my-agent"]);

  expect(existsSync(path.join(tempDir, "vm0.yaml"))).toBe(true);
});
```

### Interactive Mode

Use `prompts.inject()` - the library's native testing feature - to simulate user responses. This is NOT mocking; it's using the official testing API provided by the `prompts` library.

**Prerequisites**:
1. Import prompts at top of file: `import prompts from "prompts"`
2. Enable TTY mode (usually done in test file's `beforeEach`)
3. Inject ALL prompt responses in the order they will be asked

**Example**: Testing that onboard shows `vm0 init` when user skips plugin installation.

```typescript
import prompts from "prompts";

it("should show vm0 init when plugin installation is skipped", async () => {
  // Inject responses in order:
  // 1. "my-vm0-agent" for agent name prompt
  // 2. false for "Install VM0 Claude Plugin?" confirmation
  prompts.inject(["my-vm0-agent", false]);

  await onboardCommand.parseAsync(["node", "cli"]);

  const logCalls = vi.mocked(console.log).mock.calls.flat().join("\n");
  expect(logCalls).toContain("cd my-vm0-agent && vm0 init");
  expect(logCalls).not.toContain("/vm0-agent");
});
```

**TTY Setup** (if not already in beforeEach):

```typescript
beforeEach(() => {
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    writable: true,
    configurable: true,
  });
});
```

**Key Points**:
- Use static import: `import prompts from "prompts"`
- Inject ALL responses in prompt order - missing values will cause prompts to hang or return undefined
- `prompts.inject([new Error()])` - Simulate user cancellation (Ctrl+C)

---

## Test Targets

Only test at command integration level. Do not write separate unit tests for internal modules.

**Bad Case**

```typescript
// Separate unit test files for internal modules
// yaml-validator.test.ts
// storage-utils.test.ts
// cook-state.test.ts
```

**Good Case**

```typescript
// CLI Command Integration Tests that exercise internal modules
describe("compose command", () => {
  it("should reject invalid YAML", async () => {
    await fs.writeFile(path.join(tempDir, "vm0.yaml"), "invalid: yaml: content:");

    await expect(async () => {
      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Invalid YAML"),
    );
  });
});
```

---

## MSW Server Setup

The global test setup starts MSW server. Use `server.use()` to add handlers per test.

**Global Setup** (`src/test/setup.ts`)

```typescript
import { server } from "../mocks/server";
import { beforeAll, afterEach, afterAll, vi } from "vitest";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  vi.stubEnv("VM0_API_URL", undefined);
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
```

**Per-Test Handlers**

```typescript
import { server } from "../../mocks/server";
import { http, HttpResponse } from "msw";

it("should handle API error", async () => {
  server.use(
    http.post("http://localhost:3000/api/agent/composes", () => {
      return HttpResponse.json(
        { error: { message: "Invalid compose", code: "INVALID" } },
        { status: 400 },
      );
    }),
  );

  await expect(async () => {
    await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
  }).rejects.toThrow("process.exit called");

  expect(mockConsoleError).toHaveBeenCalledWith(
    expect.stringContaining("Invalid compose"),
  );
});
```

---

## MSW Handler Organization

When testing commands that call multiple API endpoints, organize handlers in dedicated files.

### Directory Structure

```
src/mocks/
├── server.ts           # MSW server setup
├── handlers/
│   ├── index.ts        # Exports all handler arrays
│   ├── api-handlers.ts # General API handlers
│   ├── schedule-handlers.ts  # Schedule-specific handlers
│   └── npm-registry-handlers.ts
```

### Creating Reusable Handlers

```typescript
// src/mocks/handlers/schedule-handlers.ts
import { http, HttpResponse } from "msw";

/**
 * Default MSW handlers for schedule API endpoints.
 * Individual tests can override using server.use().
 */
export const scheduleHandlers = [
  // GET /api/agent/schedules
  http.get("http://localhost:3000/api/agent/schedules", () => {
    return HttpResponse.json({ schedules: [] });
  }),

  // POST /api/agent/schedules
  http.post("http://localhost:3000/api/agent/schedules", () => {
    return HttpResponse.json({
      created: true,
      schedule: { id: "schedule-123", name: "test-schedule" },
    }, { status: 201 });
  }),

  // DELETE /api/agent/schedules/:name
  http.delete("http://localhost:3000/api/agent/schedules/:name", () => {
    return new HttpResponse(null, { status: 204 });
  }),
];
```

### Registering Handlers

```typescript
// src/mocks/handlers/index.ts
import { apiHandlers } from "./api-handlers";
import { scheduleHandlers } from "./schedule-handlers";

export const handlers = [...apiHandlers, ...scheduleHandlers];
```

### Overriding in Tests

Default handlers provide baseline responses. Override for specific test scenarios:

```typescript
// Test-specific override
it("should handle schedule not found", async () => {
  server.use(
    http.get("http://localhost:3000/api/agent/schedules", () => {
      return HttpResponse.json({ schedules: [] }); // Empty list
    }),
  );
  // ... test assertions
});
```

### Helper Functions for Tests

Create helper functions to generate consistent mock data:

```typescript
// In test file
function createMockSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: "schedule-1",
    composeName: "test-agent",
    name: "test-agent-schedule",
    cronExpression: "0 9 * * *",
    enabled: true,
    ...overrides,
  };
}

it("should display schedule details", async () => {
  const schedule = createMockSchedule({ timezone: "America/New_York" });

  server.use(
    http.get("http://localhost:3000/api/agent/schedules", () => {
      return HttpResponse.json({ schedules: [schedule] });
    }),
  );
  // ...
});
```

---

## Comparison: Web vs CLI Testing

| Aspect | Web | CLI |
|--------|-----|-----|
| **Entry Point** | API route handler | `command.parseAsync()` |
| **External (Mock)** | Clerk, AWS, E2B | Web API (MSW), Ably |
| **Internal (Real)** | Database, services | Filesystem, config, validators |
| **State Storage** | Database | Filesystem (temp dirs) |
| **User Interface** | HTTP response | Console output + exit codes |
| **Auth Setup** | Mock Clerk | `vi.stubEnv("VM0_TOKEN", ...)` |
