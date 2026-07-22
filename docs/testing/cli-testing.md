# Zero CLI Testing

## Principle

The CLI package publishes one binary: `zero`. Command tests are integration
tests that enter through Commander with `command.parseAsync()`.

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

Product CLI requests use `ZERO_TOKEN` as their only authentication source.
Tests should set it explicitly together with the API URL:

```typescript
beforeEach(() => {
  vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
});

afterEach(() => {
  vi.unstubAllEnvs();
});
```

Do not create `~/.vm0/config.json`, set `VM0_TOKEN`, or mock the config module.
Tests for missing authentication should leave `ZERO_TOKEN` unset and assert the
resulting guidance.

## Command integration pattern

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { zeroLogsCommand } from "../index";

describe("zero logs", () => {
  beforeEach(() => {
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders returned agent events", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/zero/runs/:id/telemetry/agent",
        () => {
          return HttpResponse.json({
            events: [],
            hasMore: false,
            nextCursor: null,
            framework: "claude-code",
          });
        },
      ),
    );

    await zeroLogsCommand.parseAsync([
      "node",
      "zero",
      "00000000-0000-4000-8000-000000000000",
      "--all",
    ]);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("No agent events"),
    );
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
const tempDir = mkdtempSync(path.join(os.tmpdir(), "zero-cli-test-"));
const previousCwd = process.cwd();
process.chdir(tempDir);

try {
  await command.parseAsync(["node", "zero", "..."]);
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
the `ZERO_TOKEN` setup guidance; present-but-rejected token tests should verify
the invalid-or-expired guidance.

## What belongs elsewhere

- API route behavior belongs in API integration tests.
- Multi-service lifecycle behavior belongs in runner E2E tests.
- Pure internal unit tests are reserved for security-critical logic,
  algorithmically complex parsers, or state-transition matrices.

See [CLI E2E Testing](./cli-e2e-testing.md) for the E2E-only credential and
fixture boundary.
