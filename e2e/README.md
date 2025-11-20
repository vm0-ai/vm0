# E2E Test Suite

End-to-end tests using BATS (Bash Automated Testing System).

## Structure

```
e2e/
├── .bats/                # BATS installation (git-ignored)
├── fixtures/             # Test data and expected outputs
│   ├── configs/         # Agent configuration files for testing
│   ├── inputs/          # Input data files
│   └── expected/        # Expected output snapshots
├── helpers/             # Shared test helpers
│   └── setup.bash       # Common setup/teardown functions
├── tests/               # Test suites
│   ├── 01-smoke/       # Smoke tests (hello, help, info)
│   ├── 02-commands/    # Command-specific tests (build, run)
│   ├── 03-pipes/       # Pipe and stdin tests
│   ├── 04-errors/      # Error handling tests
│   └── 05-integration/ # Integration tests
├── Makefile            # Test runner with make targets
└── run.sh              # Direct test runner script
```

## Setup

### Environment Configuration

Use the centralized script to sync environment variables:

```bash
# From project root
./scripts/sync-env.sh
```

This will inject secrets from 1Password into `.env.local` files for both e2e and web app.

Required environment variables:
- `CLERK_PUBLISHABLE_KEY` - From 1Password vault
- `CLERK_SECRET_KEY` - From 1Password vault

**Prerequisites:**
- 1Password CLI installed: `brew install --cask 1password-cli`
- Authenticated with 1Password: `op signin`
- Access to `Development/vm0-env-local` vault

**Note:** For local testing, set `VM0_API_URL` environment variable:
```bash
VM0_API_URL=http://localhost:3000 npm run auth
```
By default, the CLI uses production API at `https://www.vm0.ai`.

### CLI Authentication Automation

The `cli-auth-automation.ts` script automates the device flow authentication for testing:

```bash
# Install dependencies first
npm install

# Run authentication
npm run auth
```

This script will:
1. Start the CLI `vm0 auth login` command
2. Parse the device code from CLI output
3. Use Playwright to automate browser login
4. Sign in with Clerk test account
5. Enter the device code automatically
6. Wait for authentication success

**Prerequisites:**
- CLI must be built and globally installed: `cd turbo/apps/cli && pnpm link --global`
- Playwright browsers installed: `npx playwright install chromium`
- Clerk test account created: `e2e+clerk_test@vm0.ai`
- Environment variables configured in `.env`

## Quick Start

### Using Make (Recommended)

```bash
# Run all tests
make test

# Run specific test suites
make test-basic     # Basic functionality
make test-errors    # Error handling
make test-pipes     # Pipe/stdin tests

# Run with verbose output
make test-verbose

# Run with TAP output (for CI)
make test-tap
```

### Using run.sh

```bash
# Run all tests
./run.sh

# Run specific test file
./run.sh tests/01-basic/t0100-help.bats

# Run tests matching pattern
./run.sh tests/01-basic/*.bats
```

### Direct BATS Usage

```bash
# After installation
.bats/bats-core/bin/bats tests/**/*.bats
```

## Writing Tests

### Basic Test Structure

```bash
#!/usr/bin/env bats

load '../../helpers/setup'

@test "description of test" {
    run $CLI_COMMAND command args
    assert_success
    assert_output --partial "expected output"
}
```

### Available Assertions

From `bats-assert`:
- `assert_success` / `assert_failure [status]`
- `assert_output [--partial] "text"`
- `refute_output [--partial] "text"`
- `assert_line [--index N] "text"`
- `refute_line [--index N] "text"`

### Test Naming Convention

Following Git's convention:
- `t0100-t0199`: Basic functionality (help, version, etc.)
- `t0200-t0299`: Command tests
- `t0300-t0399`: Input/output tests
- `t0400-t0499`: Error handling
- `t0500-t0599`: Integration tests

## CI Integration

The test suite is integrated with GitHub Actions. Tests run on:
- Ubuntu (latest)
- macOS (latest)
- Windows (with Git Bash)

TAP output is used for CI reporting:

```yaml
- name: Run E2E Tests
  run: |
    cd e2e
    make test-tap
```

## Dependencies

- BATS Core
- bats-support
- bats-assert
- Built CLI (`pnpm build --filter vm0-cli`)

## Troubleshooting

### Tests Failing to Find CLI Command

Ensure the CLI is built and linked:
```bash
cd turbo
pnpm build --filter vm0-cli
cd packages/cli
pnpm link --global
```

### Permission Denied

Make scripts executable:
```bash
chmod +x run.sh
chmod +x tests/**/*.bats
```

## Test Suites

### 01-smoke
Basic smoke tests that verify CLI availability and core functionality:
- `t01-smoke.bats`: Tests for `vm0 hello`, `vm0 --help`, and `vm0 info` commands

### 02-commands
Command-specific end-to-end tests:
- `t02-run.bats`: Tests for `vm0 run` command with agent execution
  - Builds test agent configuration from fixtures
  - Executes simple math task ("1+1=?")
  - Validates successful completion with `[result]` event
  - Verifies error-free execution

**Agent Configuration Fixtures:**
- `fixtures/configs/vm0-test-math.yaml`: Test agent config for math tasks
  - Uses `vm0-claude-code:test` image
  - Provider: `claude-code`
  - Working directory: `/home/user/workspace`

## Contributing

1. Add tests for new features in appropriate category
2. Use descriptive test names
3. Include both success and failure cases
4. Test edge cases and error conditions
5. Keep tests isolated and independent
6. Place test fixtures in `fixtures/configs/` for agent configurations