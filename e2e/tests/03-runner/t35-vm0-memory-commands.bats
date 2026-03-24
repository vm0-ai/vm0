#!/usr/bin/env bats

load '../../helpers/setup'

# vm0 memory CLI command tests (init, push, list, status, clone)
#
# Happy path E2E tests that verify:
# - init creates config, push uploads, list shows it, status checks it, clone downloads it
# - File content roundtrips correctly through push + clone

setup() {
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export MEMORY_NAME="e2e-mem-cmd-${UNIQUE_ID}"
}

teardown() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

@test "vm0 memory init + push + list + status + clone" {
    echo "# Step 1: Init memory"
    mkdir -p "$TEST_DIR/$MEMORY_NAME"
    cd "$TEST_DIR/$MEMORY_NAME"
    run $VM0_CLI memory init --name "$MEMORY_NAME"
    assert_success
    assert_output --partial "Initialized memory"
    assert_output --partial "$MEMORY_NAME"
    [ -f ".vm0/storage.yaml" ]

    echo "# Step 2: Add files and push"
    echo "hello from memory" > hello.txt
    mkdir -p subdir
    echo "nested content" > subdir/nested.txt
    run $VM0_CLI memory push
    assert_success
    assert_output --partial "Pushing memory"
    assert_output --partial "Version:"

    echo "# Step 3: List memories"
    run $VM0_CLI memory list
    assert_success
    assert_output --partial "$MEMORY_NAME"
    assert_output --partial "NAME"

    echo "# Step 4: Check status"
    run $VM0_CLI memory status
    assert_success
    assert_output --partial "Found"
    assert_output --partial "Version:"

    echo "# Step 5: Clone to new directory"
    cd "$TEST_DIR"
    CLONE_DIR="${MEMORY_NAME}-clone"
    run $VM0_CLI memory clone "$MEMORY_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "Successfully cloned"

    echo "# Step 6: Verify cloned files"
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/hello.txt" ]
    [ -f "$CLONE_DIR/subdir/nested.txt" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]

    run cat "$CLONE_DIR/hello.txt"
    assert_output "hello from memory"

    run cat "$CLONE_DIR/subdir/nested.txt"
    assert_output "nested content"
}

@test "vm0 memory clone handles empty memory" {
    echo "# Step 1: Create and push empty memory"
    mkdir -p "$TEST_DIR/$MEMORY_NAME"
    cd "$TEST_DIR/$MEMORY_NAME"
    $VM0_CLI memory init --name "$MEMORY_NAME" >/dev/null
    $VM0_CLI memory push >/dev/null

    echo "# Step 2: Clone empty memory"
    cd "$TEST_DIR"
    CLONE_DIR="${MEMORY_NAME}-empty"
    run $VM0_CLI memory clone "$MEMORY_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "empty"

    echo "# Step 3: Verify directory created with config"
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]
}
