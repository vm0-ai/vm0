# VM0 CLI Commands E2E Tests

End-to-end tests for `vm0 create` and `vm0 run` commands.

## Test Files

- `t0200-create.bats`: Tests for `vm0 create` command
- `t0201-run.bats`: Tests for `vm0 run` command
- `t0202-integration.bats`: Full workflow integration tests

## Running Tests

### Prerequisites

1. Build the CLI:
   ```bash
   cd turbo
   pnpm build --filter @vm0/cli
   ```

2. Link the CLI globally:
   ```bash
   cd apps/cli
   pnpm link --global
   ```

3. Set up environment variables:
   ```bash
   export VM0_API_URL="http://localhost:3000"
   export VM0_TOKEN="your-bearer-token-here"
   ```

4. Ensure the API server is running:
   ```bash
   cd turbo
   pnpm dev
   ```

### Run Tests

```bash
# From the e2e directory
cd /workspaces/vm0-2/e2e

# Run all command tests
make test

# Or use the run.sh script
./run.sh tests/02-commands/*.bats

# Run specific test file
./run.sh tests/02-commands/t0200-create.bats
```

## Test Coverage

### `t0200-create.bats` - Create Command Tests

1. **Error Handling**:
   - Missing bearer token
   - Non-existent config file
   - Invalid YAML format
   - Missing required fields

2. **Success Cases**:
   - Valid config file creates agent config
   - JSON output mode

3. **Help**:
   - `--help` flag displays usage

### `t0201-run.bats` - Run Command Tests

1. **Error Handling**:
   - Missing bearer token
   - Invalid agent config ID (404)
   - Invalid dynamic vars JSON

2. **Success Cases**:
   - Valid agent execution
   - Dynamic vars substitution
   - JSON output mode
   - Verbose output mode

3. **Help**:
   - `--help` flag displays usage

### `t0202-integration.bats` - Integration Tests

1. **Full Workflows**:
   - Create config → Run agent
   - Create config → Run with dynamic vars
   - Create config → Run with JSON output

2. **Error Scenarios**:
   - Run with non-existent config
   - Create with invalid config

3. **Stress Tests**:
   - Multiple sequential creations

## Test Patterns

### Skipping Tests

Many tests are marked with `skip` because they require:
- Running API server
- Database connection
- E2B API access

To enable these tests, ensure all prerequisites are met and remove the `skip` lines.

### Environment Setup

Tests check for environment variables and skip automatically if not set:
```bash
if [ -z "$VM0_API_URL" ] || [ -z "$VM0_TOKEN" ]; then
    skip "VM0_API_URL or VM0_TOKEN not set"
fi
```

## Fixtures

Test fixtures are located in `/e2e/fixtures/configs/`:
- `test-agent.yaml`: Basic test agent configuration

## Adding New Tests

1. Follow the naming convention: `tXXXX-description.bats`
2. Use the setup function to check for required environment
3. Use `skip` for tests requiring external services
4. Load the setup helper: `load '../../helpers/setup'`
5. Use BATS assertions from bats-assert library

## CI Integration

These tests can be run in CI with:
```bash
cd e2e
make test-tap  # TAP output for CI
```

For CI, you'll need to:
1. Start the API server in the background
2. Set environment variables
3. Build and link the CLI
4. Run the tests with appropriate timeouts
