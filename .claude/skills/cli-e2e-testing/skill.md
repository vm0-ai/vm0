---
name: cli-e2e-testing
description: CLI E2E testing patterns with BATS - parallelization, state sharing, and timeout management
context: fork
---

# CLI E2E Testing Skill

## When to Use This Skill

Use this skill when:
- Writing new CLI E2E tests in `e2e/tests/`
- Reviewing E2E test code
- Debugging slow or timing out E2E tests
- Restructuring tests for better parallelization

---

## Core Principles

### 1. Happy Path Only

E2E tests verify the system works end-to-end. Error cases belong in unit tests.

```bash
# ✅ E2E: Test that the feature works
@test "vm0 run executes agent successfully" {
    run vm0 run "$AGENT" "echo hello"
    assert_success
}

# ❌ Don't test error cases in E2E - use unit tests instead
@test "vm0 run fails with invalid agent" { ... }  # Move to unit test
```

### 2. `vm0 run` is Expensive (~15s)

Each `vm0 run` call takes ~15 seconds due to:
- API call to platform
- E2B sandbox creation
- Volume/artifact mounting
- Mock Claude execution
- Checkpoint creation

**Minimize unnecessary `vm0 run` calls.**

### 3. Parallelization Model

```
Files run in PARALLEL (up to -j 10)
├── file-a.bats ──► case1 → case2 → case3  (SERIAL within file)
├── file-b.bats ──► case1 → case2          (SERIAL within file)
└── file-c.bats ──► case1                  (SERIAL within file)
```

- **Between files**: PARALLEL
- **Within file**: SERIAL
- **`$BATS_FILE_TMPDIR`**: Isolated per file (safe for parallel)

### 4. State Sharing Strategy

| Scenario | Strategy |
|----------|----------|
| Tests share state (session ID, checkpoint ID) | Same file, separate cases |
| Tests are independent | Separate files (parallel) |

### 5. Timeout Management

Each test case has a timeout: **30s for serial**, **60s for parallel/runner tests**.

**Don't stack multiple `vm0 run` in one case - will timeout!**

```bash
# ❌ BAD: 2 vm0 runs = 30s+ (timeout risk)
@test "session test" {
    run vm0 run "$AGENT" ...           # ~15s
    run vm0 run continue "$SESSION_ID" # ~15s
    # Total: ~30s+ in one case
}

# ✅ GOOD: Split into separate cases
@test "step 1: create session" {
    run vm0 run "$AGENT" ...           # ~15s
    echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]+' > "$BATS_FILE_TMPDIR/session_id"
}

@test "step 2: continue from session" {
    SESSION_ID=$(cat "$BATS_FILE_TMPDIR/session_id")
    run vm0 run continue "$SESSION_ID" # ~15s
}
```

---

## File Organization

### Directory Structure

```
e2e/tests/
├── 01-serial/              # Tests that MUST run serially (scope setup)
├── 02-parallel/            # Tests that CAN run in parallel
│   ├── t03-*.bats          # Independent tests (fast)
│   ├── t06-session.bats    # State-sharing tests (slow, serial within)
│   └── t07-checkpoint.bats # State-sharing tests (slow, serial within)
└── 03-experimental-runner/ # Runner-specific tests
```

### When to Create Separate Files

| Condition | Action |
|-----------|--------|
| Tests share state | Same file |
| Tests are independent | Separate files |
| Test is slow (>15s) but independent | Own file |

---

## State Sharing with `$BATS_FILE_TMPDIR`

`$BATS_FILE_TMPDIR` is a temporary directory:
- **Shared** by all tests within the same file
- **Isolated** between different files (parallel-safe)
- **Automatically cleaned** after file completes

### Pattern: Pass State Between Cases

```bash
setup_file() {
    # One-time setup: compose agent (runs once per file)
    export AGENT_NAME="e2e-session-$(date +%s%3N)"
    vm0 compose "$CONFIG"
}

@test "step 1: create session" {
    run vm0 run "$AGENT_NAME" --artifact-name "$ARTIFACT" "echo test"
    assert_success

    # Save state for next test
    echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]+' > "$BATS_FILE_TMPDIR/session_id"
}

@test "step 2: continue from session" {
    # Load state from previous test
    SESSION_ID=$(cat "$BATS_FILE_TMPDIR/session_id")

    run vm0 run continue "$SESSION_ID" "echo continue"
    assert_success
}

teardown_file() {
    # One-time cleanup (runs once per file)
}
```

### Pattern: Share Multiple Values

```bash
@test "step 1: create resources" {
    # ... create session and checkpoint

    # Save multiple values
    cat > "$BATS_FILE_TMPDIR/state.env" <<EOF
SESSION_ID=$session_id
CHECKPOINT_ID=$checkpoint_id
ARTIFACT_VERSION=$version
EOF
}

@test "step 2: use resources" {
    # Load all values
    source "$BATS_FILE_TMPDIR/state.env"

    run vm0 run continue "$SESSION_ID" ...
}
```

---

## Test Structure Template

### For State-Sharing Tests (Multiple `vm0 run`)

```bash
#!/usr/bin/env bats

load '../../helpers/setup'

# File-level constants
AGENT_NAME="e2e-feature-$(date +%s%3N)"

setup_file() {
    # Create config and compose agent ONCE
    export TEST_DIR="$(mktemp -d)"
    export TEST_CONFIG="$TEST_DIR/vm0.yaml"

    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "Test agent"
    framework: claude-code
    image: "vm0/claude-code:dev"
EOF

    vm0 compose "$TEST_CONFIG"
}

setup() {
    # Per-test setup: unique resources
    export ARTIFACT_NAME="art-$(date +%s%3N)-$RANDOM"
}

teardown() {
    # Per-test cleanup (if needed)
}

teardown_file() {
    # File cleanup
    rm -rf "$TEST_DIR"
}

@test "step 1: create session with vm0 run" {
    # Create artifact
    mkdir -p "/tmp/$ARTIFACT_NAME"
    cd "/tmp/$ARTIFACT_NAME"
    vm0 artifact init --name "$ARTIFACT_NAME"
    vm0 artifact push

    # Run agent (~15s)
    run vm0 run "$AGENT_NAME" --artifact-name "$ARTIFACT_NAME" "echo hello"
    assert_success

    # Save session ID for next test
    echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]+' > "$BATS_FILE_TMPDIR/session_id"
}

@test "step 2: continue from session" {
    SESSION_ID=$(cat "$BATS_FILE_TMPDIR/session_id")

    # Continue session (~15s)
    run vm0 run continue "$SESSION_ID" "echo world"
    assert_success
}
```

### For Independent Tests (Single `vm0 run` or no run)

```bash
#!/usr/bin/env bats

load '../../helpers/setup'

setup() {
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
}

@test "vm0 artifact push creates new version" {
    # Independent test - can be in separate file for parallelization
    mkdir -p "/tmp/art-$UNIQUE_ID"
    cd "/tmp/art-$UNIQUE_ID"

    vm0 artifact init --name "test-$UNIQUE_ID"
    echo "content" > file.txt

    run vm0 artifact push
    assert_success
    assert_output --partial "Version:"
}
```

---

## Anti-Patterns

### AP-1: Multiple `vm0 run` in One Case

```bash
# ❌ BAD: Will likely timeout (30s+)
@test "full session workflow" {
    run vm0 run "$AGENT" "create file"     # ~15s
    run vm0 run continue "$SESSION" "read" # ~15s
}

# ✅ GOOD: Split into cases
@test "step 1: create session" { ... }
@test "step 2: continue session" { ... }
```

### AP-2: Independent Tests in Same File

```bash
# ❌ BAD: These run serially but don't need to
# file: t10-mixed.bats
@test "artifact push works" { ... }      # Independent
@test "volume push works" { ... }        # Independent
@test "compose validates config" { ... } # Independent

# ✅ GOOD: Separate files for parallelization
# file: t10a-artifact.bats
@test "artifact push works" { ... }

# file: t10b-volume.bats
@test "volume push works" { ... }
```

### AP-3: Not Using `setup_file()` for Expensive Setup

```bash
# ❌ BAD: Composes agent for EVERY test
setup() {
    vm0 compose "$CONFIG"  # Runs before each test!
}

# ✅ GOOD: Compose once per file
setup_file() {
    vm0 compose "$CONFIG"  # Runs once before all tests
}
```

### AP-4: Testing Error Cases in E2E

```bash
# ❌ BAD: Error cases belong in unit tests
@test "vm0 run fails with missing artifact" {
    run vm0 run "$AGENT" --artifact-name "nonexistent"
    assert_failure
}

# ✅ GOOD: E2E tests happy paths only
@test "vm0 run succeeds with valid artifact" {
    run vm0 run "$AGENT" --artifact-name "$VALID_ARTIFACT"
    assert_success
}
```

### AP-5: Hardcoded Resource Names

```bash
# ❌ BAD: Will conflict in parallel runs
ARTIFACT_NAME="test-artifact"

# ✅ GOOD: Unique names with timestamp + random
ARTIFACT_NAME="test-artifact-$(date +%s%3N)-$RANDOM"
```

---

## Quick Checklist

Before committing E2E tests:

- [ ] Happy path only (error cases → unit tests)
- [ ] Max ONE `vm0 run` per test case (timeout safety)
- [ ] State-sharing tests in same file, independent tests in separate files
- [ ] Use `setup_file()` for expensive one-time setup (compose)
- [ ] Use `$BATS_FILE_TMPDIR` for state between cases
- [ ] Unique resource names (timestamp + random)
- [ ] Cleanup in `teardown()` or `teardown_file()`

---

## Reference

- BATS documentation: https://bats-core.readthedocs.io/en/stable/writing-tests.html
- Test timeout: `BATS_TEST_TIMEOUT=30` (serial) / `BATS_TEST_TIMEOUT=60` (parallel/runner)
- Parallelization: `-j 10 --no-parallelize-within-files`
