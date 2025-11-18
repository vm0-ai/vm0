# vm0-cli

Command-line interface for managing and running VM0 AI agents.

## Installation

This package is part of the turbo monorepo. Install dependencies from the root:

```bash
pnpm install
```

### Global Installation

To use the CLI globally:

```bash
# Build the CLI
pnpm build --filter @vm0/cli

# Link globally
cd apps/cli
pnpm link --global

# Now you can use 'vm0' command anywhere
vm0 --help
```

## Development

### Build the CLI

```bash
pnpm build
```

### Development mode (watch)

```bash
pnpm dev
```

### Running tests

```bash
pnpm test
```

### Type checking

```bash
pnpm check-types
```

### Linting

```bash
pnpm lint
```

## Configuration

Set environment variables for API access:

```bash
export VM0_API_URL="http://localhost:3000"  # API server URL
export VM0_API_KEY="your-api-key-here"      # Your API key
```

## Usage

### Create an Agent Config

Create an agent configuration from a YAML file:

```bash
vm0 create <config-file> [options]
```

**Options:**
- `--json` - Output JSON format

**Example:**

```bash
# Create agent config from YAML file
vm0 create my-agent.yaml

# Output JSON for automation
vm0 create my-agent.yaml --json
```

**Config File Format:**

```yaml
version: "1.0"
agent:
  description: "My test agent"
  image: "ubuntu:22.04"
  provider: "e2b"
  working_dir: "/workspace"
  volumes: []
```

### Run an Agent

Execute an agent with a prompt:

```bash
vm0 run <agent-config-id> <prompt> [options]
```

**Options:**
- `--dynamicVars <json>` - Dynamic variables as JSON string
- `--json` - Output JSON format
- `--verbose` - Show detailed information

**Examples:**

```bash
# Simple agent execution
vm0 run cfg-abc123 "Write a hello world program"

# With dynamic variables
vm0 run cfg-abc123 "Hello {{userName}}" --dynamicVars '{"userName":"Alice"}'

# JSON output for automation
vm0 run cfg-abc123 "test prompt" --json

# Verbose output for debugging
vm0 run cfg-abc123 "test prompt" --verbose
```

### Other Commands

- `--version` - Show CLI version
- `--help` - Show help information
- `create --help` - Show help for create command
- `run --help` - Show help for run command

## Error Handling

The CLI provides helpful error messages and hints for common issues:

- **Missing API Key**: Prompts to set `VM0_API_KEY` environment variable
- **Invalid Config**: Shows validation errors with specific field issues
- **Connection Errors**: Suggests checking `VM0_API_URL` and server status
- **404 Errors**: Indicates agent config not found, check config ID
- **401 Errors**: Suggests checking API key validity

## Architecture

The CLI is built with:

- **Commander.js** - Command-line interface framework
- **Chalk** - Terminal string styling
- **YAML** - Config file parsing
- **tsup** - TypeScript bundler for fast builds
- **@vm0/core** - Shared core functionality

### Project Structure

```
apps/cli/
├── src/
│   ├── commands/         # Command implementations
│   │   ├── create.ts    # vm0 create command
│   │   └── run.ts       # vm0 run command
│   ├── lib/             # Shared utilities
│   │   ├── api-client.ts      # API HTTP client
│   │   ├── config-loader.ts   # YAML config loader
│   │   ├── config-validator.ts # Config validation
│   │   └── output.ts          # Console output helpers
│   ├── types/           # TypeScript type definitions
│   │   └── config.ts    # Config interfaces
│   ├── __tests__/       # Unit tests
│   └── index.ts         # CLI entry point
└── package.json
```

## Testing

### Unit Tests

```bash
pnpm test
```

### E2E Tests

End-to-end tests are located in `/e2e/tests/02-commands/`. See the [E2E README](/e2e/tests/02-commands/README.md) for details.

```bash
cd ../../e2e
make test
```

## Troubleshooting

### "VM0_API_KEY environment variable is required"

Set the API key:
```bash
export VM0_API_KEY="your-api-key"
```

### "Cannot connect to VM0 API"

1. Check if the API server is running: `pnpm dev`
2. Verify `VM0_API_URL` is correct (default: `http://localhost:3000`)

### "Config file not found"

Ensure the path to your YAML config file is correct.

### "Invalid YAML format"

Check your YAML syntax. Use a YAML validator to verify the file.

## Contributing

When adding new commands:

1. Create command file in `src/commands/`
2. Add command registration in `src/index.ts`
3. Add unit tests in `src/__tests__/`
4. Add e2e tests in `/e2e/tests/02-commands/`
5. Update this README with usage examples
