# Okou CLI Testing

## Principle

The private CLI package exposes only the canonical `okou` entry point. Command
tests are integration tests that enter through Commander with
`command.parseAsync()`.

- Mock the Web API with MSW.
- Keep command parsing, validation, formatting, and filesystem behavior real.
- Use temporary directories for filesystem state.
- Do not mock internal CLI modules.

The retired `vm0` binary and its commands are not compatibility surfaces and
must not be recreated in tests.

## Test location

Place command tests in a neighboring `__tests__/` directory. A command file and
its test should have matching names:

```text
src/commands/zero/
├── logs/
│   ├── index.ts
│   └── __tests__/
│       └── view.test.ts
└── whoami.ts
```

## Authentication and routing

Product CLI requests prefer `OKOU_TOKEN` and retain `ZERO_TOKEN` as a
protocol fallback. Tests should set the canonical token explicitly together
with the API URL unless they are covering that fallback:

```typescript
beforeEach(() => {
  vi.stubEnv("OKOU_TOKEN", "test-okou-token");
  vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
});

afterEach(() => {
  vi.unstubAllEnvs();
});
```

Do not create `~/.vm0/config.json`, set `VM0_TOKEN`, or mock the config module.
Tests for missing authentication should leave both token names unset and assert
the resulting guidance. Keep focused protocol coverage that sets only
`ZERO_TOKEN` and proves the fallback still reaches the canonical Okou path.

## Command integration pattern

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroSearchCommand } from "../index";

describe("okou search --source agent-session", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    zeroSearchCommand.setOptionValue("source", []);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
  });

  it("prints both local agent session locations", async () => {
    await zeroSearchCommand.parseAsync([
      "node",
      "okou",
      "find the failed tool call",
      "--source",
      "agent-session",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("/home/user/.claude/projects/");
    expect(output).toContain("/home/user/.codex/sessions/");
  });
});
```

## External boundaries

Mock only dependencies outside the CLI process:

- HTTP calls through MSW
- third-party SDKs that perform external I/O
- process exit and console output when required to observe command behavior

Avoid mocking validators, domain functions, API configuration, serializers, or
other internal modules. Enter through the command and observe output, exit code,
HTTP request, and filesystem changes.

## Filesystem behavior

Use the real filesystem under a temporary directory:

```typescript
const tempDir = mkdtempSync(path.join(os.tmpdir(), "okou-cli-test-"));
const previousCwd = process.cwd();
process.chdir(tempDir);

try {
  await command.parseAsync(["node", "okou", "..."]);
} finally {
  process.chdir(previousCwd);
  rmSync(tempDir, { recursive: true, force: true });
}
```

## Interactive commands

Use `prompts.inject()` to supply responses in order. This exercises the real
prompt integration while keeping the test deterministic. Always restore TTY
properties and injected state during teardown.

## Error behavior

API failures should be represented with MSW responses and asserted through the
command's user-visible error and exit code. Missing-token tests should verify
the `OKOU_TOKEN` setup guidance; present-but-rejected token tests should verify
the invalid-or-expired guidance.

## What belongs elsewhere

- API route behavior belongs in API integration tests.
- Multi-service lifecycle behavior belongs in product-surface E2E tests.
- Pure internal unit tests are reserved for security-critical logic,
  algorithmically complex parsers, or state-transition matrices.

See [CLI and Runner E2E Testing](./cli-e2e-testing.md) for the deployed-test
boundary.
