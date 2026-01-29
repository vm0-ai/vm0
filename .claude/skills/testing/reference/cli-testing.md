# CLI Testing Patterns

## Principle

In the CLI app (`turbo/apps/cli`), only write command-level integration tests. Test commands via `command.parseAsync()` with MSW mocking the Web API.

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

Only test non-interactive mode. Do not mock prompt libraries.

**Rationale**: When `isInteractive()` returns `false` (default in test environment), prompts return `undefined` automatically. Tests should verify non-interactive behavior.

```typescript
// Test that command works in non-interactive mode
it("should require --name flag in non-interactive mode", async () => {
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

---

## Test Targets

Only test at command level. Do not write separate unit tests for internal modules.

**Bad Case**

```typescript
// Separate unit test files for internal modules
// yaml-validator.test.ts
// storage-utils.test.ts
// cook-state.test.ts
```

**Good Case**

```typescript
// Command-level tests that exercise internal modules
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

## Comparison: Web vs CLI Testing

| Aspect | Web | CLI |
|--------|-----|-----|
| **Entry Point** | API route handler | `command.parseAsync()` |
| **External (Mock)** | Clerk, AWS, E2B | Web API (MSW), Ably |
| **Internal (Real)** | Database, services | Filesystem, config, validators |
| **State Storage** | Database | Filesystem (temp dirs) |
| **User Interface** | HTTP response | Console output + exit codes |
| **Auth Setup** | Mock Clerk | `vi.stubEnv("VM0_TOKEN", ...)` |
