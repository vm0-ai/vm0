---
name: CLI E2E Testing
description: Guidelines for writing robust CLI end-to-end tests using BATS
---

# CLI E2E Testing

Tests use BATS (Bash Automated Testing System) located in `e2e/`.

## Quick Start

```bash
# Run all tests
./e2e/run.sh

# Run specific test file
./e2e/test/libs/bats/bin/bats e2e/tests/02-parallel/t03-volumes.bats
```

## Test File Template

```bash
#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    # Use unique names with timestamp to avoid conflicts
    export TEST_DIR="$(mktemp -d)"
    export RESOURCE_NAME="e2e-test-$(date +%s)"
}

teardown() {
    # Always clean up temp directories
    [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

@test "descriptive test name" {
    run $CLI_COMMAND subcommand args
    assert_success
    assert_output --partial "expected text"
}
```

## Assertions

```bash
# Exit status
assert_success                    # exit code 0
assert_failure                    # exit code != 0

# Output matching
assert_output --partial "text"    # output contains text
refute_output --partial "text"    # output does NOT contain text
assert_output --regexp "pattern"  # output matches regex

# Line matching
assert_line --index 0 "first line"
```

## Key Patterns

### 1. Unique Resource Names

```bash
# Always use timestamp to prevent test conflicts
export VOLUME_NAME="e2e-volume-$(date +%s)"
export ARTIFACT_NAME="e2e-artifact-$(date +%s)"
```

### 2. Inline Config Files (Important!)

**Always create config files inline within tests** instead of using shared fixture files. This avoids conflicts when multiple test suites run in parallel (each test suite may compose the same config simultaneously).

```bash
@test "vm0 compose with custom config" {
    echo "# Create config inline"
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"

agents:
  $AGENT_NAME:
    provider: claude-code
    description: "Test agent"
EOF

    run $CLI_COMMAND compose "$TEST_DIR/vm0.yaml"
    assert_success
}
```

**Why inline configs:**
- Each test file gets its own isolated `$TEST_DIR` (created in `setup()`)
- Parallel test execution won't conflict on shared config files
- Test is self-contained and easier to understand

### 3. Debug Output with Echo Comments

```bash
@test "multi-step test" {
    echo "# Step 1: Setup..."
    # ... setup code ...

    echo "# Step 2: Execute..."
    run $CLI_COMMAND ...

    echo "# Step 3: Verify..."
    assert_success
}
```

### 4. Extract IDs from Output

```bash
# Extract UUID patterns
CHECKPOINT_ID=$(echo "$output" | grep -oP 'Checkpoint:\s*\K[a-f0-9-]{36}' | head -1)
SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)

# Verify extraction succeeded
[ -n "$CHECKPOINT_ID" ] || {
    echo "# Failed to extract checkpoint ID"
    echo "$output"
    return 1
}
```

### 5. Test Both Success and Failure

```bash
@test "valid input succeeds" {
    run $CLI_COMMAND volume init
    assert_success
}

@test "invalid input fails with error" {
    run $CLI_COMMAND volume pull "nonexistent"
    assert_failure
    assert_output --partial "not found"
}
```

### 6. Suppress Output for Setup Commands

```bash
# Use >/dev/null for setup commands that must succeed
$CLI_COMMAND artifact init >/dev/null
$CLI_COMMAND artifact push >/dev/null

# Only use `run` when you need to check output/status
run $CLI_COMMAND artifact push
assert_success
```

## File Organization

```
e2e/
├── tests/
│   ├── 01-serial/         # Tests that must run sequentially (before parallel tests)
│   │   ├── ser-t01-smoke.bats
│   │   └── ser-t02-vm0-scope.bats
│   └── 02-parallel/       # Feature-specific tests (run in parallel with -j 10)
│       ├── t01-validation.bats
│       ├── t03-volumes.bats
│       └── t04-vm0-artifact-checkpoint.bats
└── helpers/
    └── setup.bash         # Shared setup (loads bats-assert)
```

### Serial vs Parallel Tests

**Default:** Place tests in `02-parallel/`. Tests run in parallel with `-j 10`.

**Use `01-serial/` when:**
- Test modifies shared user state (e.g., `scope set --force`)
- Test sets up state that parallel tests depend on
- Race conditions could occur with parallel execution

**Serial test naming:** Use `ser-tXX-name.bats` prefix for files in `01-serial/`.

**Note:** Config files should be created inline within each test (see "Inline Config Files" pattern above), not stored in a shared fixtures directory.

## Naming Convention

- Serial test files: `ser-tXX-feature-name.bats` (in `01-serial/`)
- Parallel test files: `tXX-feature-name.bats` (in `02-parallel/`)
- Test resources: `e2e-{type}-$(date +%s)`

## CI Integration

Tests run in two steps:
```bash
# Step 1: Run serial tests sequentially (establishes shared state like scope)
bats ./e2e/tests/01-serial/*.bats

# Step 2: Run parallel tests with -j 10
bats -j 10 --no-parallelize-within-files ./e2e/tests/02-parallel/*.bats
```

- Serial tests run first to establish stable shared state
- `-j 10`: Run up to 10 test files in parallel
- `--no-parallelize-within-files`: Tests within a file run sequentially

## Checklist

Before submitting:

- [ ] Uses unique resource names with timestamp
- [ ] Creates config files inline (not in shared fixtures)
- [ ] Has `setup()` and `teardown()` for cleanup
- [ ] Tests both success and failure cases
- [ ] Includes debug echo comments for multi-step tests
- [ ] Placed in correct directory (01-serial for shared state, 02-parallel for most tests)
- [ ] Runs successfully: `./e2e/run.sh tests/02-parallel/your-test.bats`
