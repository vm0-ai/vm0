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
src/commands/
└── search/
    ├── index.ts
    └── __tests__/
        └── index.test.ts
```

## Authentication and routing

Product CLI requests read `OKOU_TOKEN` and nothing else. `getToken()` in
`src/lib/api/config.ts` delegates to `getOkouToken()` in `src/lib/okou-env.ts`,
which reads only `OKOU_TOKEN`. The retired `ZERO_TOKEN` and `VM0_TOKEN` names
are not honored, and there is no fallback to them when `OKOU_TOKEN` is unset or
empty. Routing reads only `OKOU_API_BACKEND_URL`; when it is unset or empty,
the CLI defaults to `https://api.okou.ai`. A configured host without a protocol
receives `https://`, while an explicit protocol and trailing slash are
preserved.

Set the canonical token explicitly together with the API URL:

```typescript
beforeEach(() => {
  vi.stubEnv("OKOU_TOKEN", "test-okou-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
});

afterEach(() => {
  vi.unstubAllEnvs();
});
```

Do not create `~/.vm0/config.json`, set `VM0_TOKEN`, or mock the config module.
Tests for missing authentication should leave every token name unset and assert
the resulting guidance.

Do not write a test that asserts a legacy token name still reaches the Okou
path. No such fallback exists, so the test fails.

Token acceptance is a fail-closed credential boundary, so rejecting a legacy
token name is the product behavior and negative assertions belong here. This is
the narrow exception in [Fallbacks to Avoid](../fallback.md) §1; do not
generalize it. Everywhere else, a test that only asserts removed behavior stays
removed is a tombstone and should not be written.
`src/lib/api/__tests__/config.test.ts` holds the pattern for this boundary:

```typescript
it("ignores ZERO_TOKEN when OKOU_TOKEN is present", async () => {
  vi.stubEnv("OKOU_TOKEN", "okou-token-value");
  vi.stubEnv("ZERO_TOKEN", "zero-token-value");

  await expect(getToken()).resolves.toBe("okou-token-value");
  await expect(getActiveToken()).resolves.toBe("okou-token-value");
});

it("does not fall back to ZERO_TOKEN when OKOU_TOKEN is empty", async () => {
  vi.stubEnv("OKOU_TOKEN", "");
  vi.stubEnv("ZERO_TOKEN", "zero-token-value");

  await expect(getToken()).resolves.toBeUndefined();
  await expect(getActiveToken()).resolves.toBeUndefined();
});

it("does not fall back to VM0_TOKEN", async () => {
  vi.stubEnv("VM0_TOKEN", "legacy-token-value");

  await expect(getToken()).resolves.toBeUndefined();
  await expect(getActiveToken()).resolves.toBeUndefined();
});
```

## Command integration pattern

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchCommand } from "../index";

describe("okou search --source agent-session", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    searchCommand.setOptionValue("source", []);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
  });

  it("prints both local agent session locations", async () => {
    await searchCommand.parseAsync([
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
