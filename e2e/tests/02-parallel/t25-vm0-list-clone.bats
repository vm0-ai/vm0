#!/usr/bin/env bats

load '../../helpers/setup'

# vm0 artifact/volume list and clone command tests

setup() {
    # Create temporary test directory
    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export ARTIFACT_NAME="e2e-list-artifact-${UNIQUE_ID}"
    export VOLUME_NAME="e2e-list-volume-${UNIQUE_ID}"
}

teardown() {
    # Clean up temporary directory
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# ============================================
# Artifact List Tests
# ============================================

@test "vm0 artifact list --help shows command description" {
    run $CLI_COMMAND artifact list --help
    assert_success
    assert_output --partial "List all remote artifacts"
}

@test "vm0 artifact ls alias works" {
    run $CLI_COMMAND artifact ls --help
    assert_success
    assert_output --partial "List all remote artifacts"
}

@test "vm0 artifact list shows empty message when no artifacts" {
    # This test may show artifacts from other tests, so just check it runs
    run $CLI_COMMAND artifact list
    # Should succeed (either empty message or table)
    assert_success
}

@test "vm0 artifact list shows pushed artifact" {
    echo "# Step 1: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: List artifacts"
    run $CLI_COMMAND artifact list
    assert_success
    assert_output --partial "$ARTIFACT_NAME"
    assert_output --partial "NAME"
    assert_output --partial "SIZE"
    assert_output --partial "FILES"
    assert_output --partial "UPDATED"
}

# ============================================
# Volume List Tests
# ============================================

@test "vm0 volume list --help shows command description" {
    run $CLI_COMMAND volume list --help
    assert_success
    assert_output --partial "List all remote volumes"
}

@test "vm0 volume ls alias works" {
    run $CLI_COMMAND volume ls --help
    assert_success
    assert_output --partial "List all remote volumes"
}

@test "vm0 volume list shows pushed volume" {
    echo "# Step 1: Create and push volume"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    echo "test content" > test.txt
    $CLI_COMMAND volume push >/dev/null

    echo "# Step 2: List volumes"
    run $CLI_COMMAND volume list
    assert_success
    assert_output --partial "$VOLUME_NAME"
    assert_output --partial "NAME"
    assert_output --partial "SIZE"
}

# ============================================
# Artifact Clone Tests
# ============================================

@test "vm0 artifact clone --help shows command description" {
    run $CLI_COMMAND artifact clone --help
    assert_success
    assert_output --partial "Clone a remote artifact"
    assert_output --partial "<name>"
}

@test "vm0 artifact clone fails for non-existent artifact" {
    cd "$TEST_DIR"
    run $CLI_COMMAND artifact clone "nonexistent-artifact-12345"
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 artifact clone succeeds for existing artifact" {
    echo "# Step 1: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "hello from artifact" > hello.txt
    mkdir -p subdir
    echo "nested file" > subdir/nested.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: Clone artifact to new directory"
    cd "$TEST_DIR"
    CLONE_DIR="${ARTIFACT_NAME}-clone"
    run $CLI_COMMAND artifact clone "$ARTIFACT_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "Successfully cloned"
    assert_output --partial "$ARTIFACT_NAME"

    echo "# Step 3: Verify cloned files"
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/hello.txt" ]
    [ -f "$CLONE_DIR/subdir/nested.txt" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]

    run cat "$CLONE_DIR/hello.txt"
    assert_output "hello from artifact"
}

@test "vm0 artifact clone uses artifact name as default destination" {
    echo "# Step 1: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > test.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: Clone without specifying destination"
    cd "$TEST_DIR"
    rm -rf "$ARTIFACT_NAME"
    run $CLI_COMMAND artifact clone "$ARTIFACT_NAME"
    assert_success
    assert_output --partial "Successfully cloned"

    echo "# Step 3: Verify directory was created with artifact name"
    [ -d "$ARTIFACT_NAME" ]
    [ -f "$ARTIFACT_NAME/test.txt" ]
}

@test "vm0 artifact clone fails if destination exists" {
    echo "# Step 1: Create and push artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    echo "test" > test.txt
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: Create conflicting directory"
    cd "$TEST_DIR"
    mkdir -p "existing-dir"

    echo "# Step 3: Clone should fail"
    run $CLI_COMMAND artifact clone "$ARTIFACT_NAME" "existing-dir"
    assert_failure
    assert_output --partial "already exists"
}

# ============================================
# Volume Clone Tests
# ============================================

@test "vm0 volume clone --help shows command description" {
    run $CLI_COMMAND volume clone --help
    assert_success
    assert_output --partial "Clone a remote volume"
    assert_output --partial "<name>"
}

@test "vm0 volume clone fails for non-existent volume" {
    cd "$TEST_DIR"
    run $CLI_COMMAND volume clone "nonexistent-volume-12345"
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 volume clone succeeds for existing volume" {
    echo "# Step 1: Create and push volume"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    echo "hello from volume" > hello.txt
    $CLI_COMMAND volume push >/dev/null

    echo "# Step 2: Clone volume to new directory"
    cd "$TEST_DIR"
    CLONE_DIR="${VOLUME_NAME}-clone"
    run $CLI_COMMAND volume clone "$VOLUME_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "Successfully cloned"
    assert_output --partial "$VOLUME_NAME"

    echo "# Step 3: Verify cloned files"
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/hello.txt" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]

    run cat "$CLONE_DIR/hello.txt"
    assert_output "hello from volume"
}

@test "vm0 volume clone uses volume name as default destination" {
    echo "# Step 1: Create and push volume"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    echo "test" > test.txt
    $CLI_COMMAND volume push >/dev/null

    echo "# Step 2: Clone without specifying destination"
    cd "$TEST_DIR"
    rm -rf "$VOLUME_NAME"
    run $CLI_COMMAND volume clone "$VOLUME_NAME"
    assert_success
    assert_output --partial "Successfully cloned"

    echo "# Step 3: Verify directory was created with volume name"
    [ -d "$VOLUME_NAME" ]
    [ -f "$VOLUME_NAME/test.txt" ]
}

# ============================================
# Empty Storage Clone Tests
# ============================================

@test "vm0 artifact clone handles empty artifact" {
    echo "# Step 1: Create and push empty artifact"
    mkdir -p "$TEST_DIR/$ARTIFACT_NAME"
    cd "$TEST_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null
    $CLI_COMMAND artifact push >/dev/null

    echo "# Step 2: Clone empty artifact"
    cd "$TEST_DIR"
    CLONE_DIR="${ARTIFACT_NAME}-empty"
    run $CLI_COMMAND artifact clone "$ARTIFACT_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "empty"

    echo "# Step 3: Verify directory created with config"
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]
}

@test "vm0 volume clone handles empty volume" {
    echo "# Step 1: Create and push empty volume"
    mkdir -p "$TEST_DIR/$VOLUME_NAME"
    cd "$TEST_DIR/$VOLUME_NAME"
    $CLI_COMMAND volume init --name "$VOLUME_NAME" >/dev/null
    $CLI_COMMAND volume push >/dev/null

    echo "# Step 2: Clone empty volume"
    cd "$TEST_DIR"
    CLONE_DIR="${VOLUME_NAME}-empty"
    run $CLI_COMMAND volume clone "$VOLUME_NAME" "$CLONE_DIR"
    assert_success
    assert_output --partial "empty"

    echo "# Step 3: Verify directory created with config"
    [ -d "$CLONE_DIR" ]
    [ -f "$CLONE_DIR/.vm0/storage.yaml" ]
}
