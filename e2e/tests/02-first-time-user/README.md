# First-Time User Flow E2E Tests

Comprehensive end-to-end tests for the CLI first-time user experience, covering authentication, config building, agent execution, and logout.

## Prerequisites

### Required Environment Variables

1. **VM0_TOKEN** (required): Valid authentication token
   - Obtain from your VM0 account settings or through CLI authentication
   - Set before running tests: `export VM0_TOKEN="your-token-here"`

2. **API_HOST** (optional): API server URL
   - Defaults to `http://localhost:3000` if not set
   - Example: `export API_HOST="https://api.vm0.dev"`

### Required Setup

- CLI must be built and linked globally:
  ```bash
  cd turbo/apps/cli
  pnpm build
  pnpm link --global
  ```

- API server should be running (if using localhost)

## Running Tests

### All tests in this suite

```bash
cd e2e
VM0_TOKEN="your-token" ./test/libs/bats/bin/bats tests/02-first-time-user/t02-first-time-user.bats
```

### With custom API host

```bash
VM0_TOKEN="your-token" API_HOST="https://api.vm0.dev" ./test/libs/bats/bin/bats tests/02-first-time-user/t02-first-time-user.bats
```

### Using the run.sh script

```bash
VM0_TOKEN="your-token" ./run.sh tests/02-first-time-user/t02-first-time-user.bats
```

## Test Coverage

The test suite includes 12 tests covering:

### Authentication (4 tests)
- Initial unauthenticated status
- Authentication via VM0_TOKEN environment variable
- Authentication via config file
- Token persistence across commands

### Build Command (3 tests)
- Successful config creation
- Usage instructions display
- Authentication requirement enforcement

### Run Command (3 tests)
- Agent execution by name
- Agent execution by configId
- Authentication requirement enforcement

### Logout (3 tests)
- Credential removal
- Status update after logout
- Config file cleanup

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Run First-Time User E2E Tests
  env:
    VM0_TOKEN: ${{ secrets.VM0_TOKEN }}
    API_HOST: ${{ secrets.API_HOST }}
  run: |
    cd e2e
    ./test/libs/bats/bin/bats tests/02-first-time-user/t02-first-time-user.bats
```

### Setting up secrets

1. Go to repository Settings > Secrets and variables > Actions
2. Add `VM0_TOKEN` secret with your authentication token
3. Optionally add `API_HOST` if using non-default API

## Test Isolation

Tests use a separate config directory (`~/.vm0-test`) to avoid interfering with your real CLI configuration. This directory is cleaned up before and after each test.

## Troubleshooting

### "VM0_TOKEN environment variable must be set"
- Ensure you've exported VM0_TOKEN before running tests
- Check that the token hasn't expired
- Verify the token is valid by running: `VM0_TOKEN="your-token" vm0 auth status`

### "API URL not configured" or connection errors
- Check that API_HOST is set correctly
- Verify the API server is running (if using localhost)
- Ensure network connectivity to the API server

### Agent execution timeouts
- E2B sandbox startup can take 30-60 seconds
- Increase test timeout if needed
- Check E2B_API_KEY and E2B_TEMPLATE_NAME are configured on the server

## Getting a Token

### Method 1: Using existing CLI authentication

If you've already authenticated the CLI:

```bash
# Find your token in the config file
cat ~/.vm0/config.json | grep token
```

### Method 2: Through automated authentication

Use the provided automation script:

```bash
cd e2e
npm install  # Install dependencies (playwright, etc.)
npx tsx cli-auth-automation.ts
# Follow the authentication flow
# Token will be saved to ~/.vm0/config.json
```

### Method 3: Direct API authentication

Contact your VM0 administrator or check your account settings for API token generation.
