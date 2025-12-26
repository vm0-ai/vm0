#!/usr/bin/env bats

# Test VM0 image versioning
# Tests the CLI for building multiple image versions and version management
#
# This test covers issue #641: Image versioning with tag support

load '../../helpers/setup'

# Note: Scope is already set by 01-serial/ser-t02-vm0-scope.bats (teardown_file sets "e2e-stable")

setup() {
    export TEST_DOCKERFILE="${TEST_ROOT}/fixtures/dockerfiles/Dockerfile.simple"
    export TEST_TMP_DIR="$(mktemp -d)"
    # Use unique image name for versioning tests
    export TEST_IMAGE_NAME="e2e-version-test"
}

teardown() {
    if [ -n "$TEST_TMP_DIR" ] && [ -d "$TEST_TMP_DIR" ]; then
        rm -rf "$TEST_TMP_DIR"
    fi
}

# ============================================
# Version Display in Build Output
# ============================================

@test "vm0 image build shows version ID in output" {
    # Build a new image
    run $CLI_COMMAND image build --file "$TEST_DOCKERFILE" --name "$TEST_IMAGE_NAME" --delete-existing

    assert_success
    # Should show the scope/name:version format
    assert_output --partial "/"
    assert_output --partial ":"
    # Should show success message
    assert_output --partial "Image built:"
}

# ============================================
# Version Listing
# ============================================

@test "vm0 image list shows versions with latest marker" {
    # First build an image to ensure we have at least one
    run $CLI_COMMAND image build --file "$TEST_DOCKERFILE" --name "$TEST_IMAGE_NAME" --delete-existing
    assert_success

    # List images should show version information
    run $CLI_COMMAND image list
    assert_success
    # Should show the image name
    assert_output --partial "$TEST_IMAGE_NAME"
    # Ready images should have latest marker (cyan colored, no parentheses)
    assert_output --partial "latest"
}

@test "vm0 image versions lists versions for specific image" {
    # Build to ensure image exists
    run $CLI_COMMAND image build --file "$TEST_DOCKERFILE" --name "$TEST_IMAGE_NAME" --delete-existing
    assert_success

    # Get versions for the image
    run $CLI_COMMAND image versions "$TEST_IMAGE_NAME"
    assert_success
    # Should show the image name
    assert_output --partial "$TEST_IMAGE_NAME"
    # Should show latest marker (cyan colored, no parentheses)
    assert_output --partial "latest"
    # Should show usage hints
    assert_output --partial "pin to specific version"
}

@test "vm0 image versions fails for non-existent image" {
    run $CLI_COMMAND image versions "nonexistent-image-xyz"
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 image versions --help shows usage" {
    run $CLI_COMMAND image versions --help
    assert_success
    assert_output --partial "List all versions"
    assert_output --partial "<name>"
}

# ============================================
# Multiple Version Builds
# ============================================

@test "vm0 image build creates multiple versions" {
    # Use unique image name for this test to avoid conflicts with parallel tests
    local MULTI_VER_IMAGE="e2e-multi-ver-test"

    # Clean up first (ignore errors if nothing to delete)
    $CLI_COMMAND image delete "$MULTI_VER_IMAGE" --all --force 2>/dev/null || true

    # Create two different Dockerfiles (SHA256 versioning is content-based)
    local DOCKERFILE1="${TEST_TMP_DIR}/Dockerfile.v1"
    local DOCKERFILE2="${TEST_TMP_DIR}/Dockerfile.v2"
    echo 'FROM e2bdev/code-interpreter:latest
RUN echo "version-1" > /tmp/version.txt' > "$DOCKERFILE1"
    echo 'FROM e2bdev/code-interpreter:latest
RUN echo "version-2" > /tmp/version.txt' > "$DOCKERFILE2"

    # Build first version
    run $CLI_COMMAND image build --file "$DOCKERFILE1" --name "$MULTI_VER_IMAGE"
    assert_success

    # Extract version ID from output (SHA256 hex, first 8 chars displayed)
    VERSION1=$(echo "$output" | grep -oP ':\K[a-f0-9]{8}' | head -1)

    # Build second version with different content
    run $CLI_COMMAND image build --file "$DOCKERFILE2" --name "$MULTI_VER_IMAGE"
    assert_success

    # Extract second version ID
    VERSION2=$(echo "$output" | grep -oP ':\K[a-f0-9]{8}' | head -1)

    # Versions should be different (different Dockerfile content)
    [ "$VERSION1" != "$VERSION2" ]

    # List versions should show both
    run $CLI_COMMAND image versions "$MULTI_VER_IMAGE"
    assert_success
    assert_output --partial "$VERSION1"
    assert_output --partial "$VERSION2"

    # Clean up - delete all versions (best effort, don't fail test on cleanup)
    $CLI_COMMAND image delete "$MULTI_VER_IMAGE" --all --force 2>/dev/null || true
}

# ============================================
# Delete Command Help and Aliases
# ============================================

@test "vm0 image delete --help shows options" {
    run $CLI_COMMAND image delete --help
    assert_success
    assert_output --partial "Delete a custom image"
    assert_output --partial "--force"
    assert_output --partial "--all"
    assert_output --partial "name:version"
}

@test "vm0 image rm alias works" {
    # rm is alias for delete
    run $CLI_COMMAND image rm --help
    assert_success
    assert_output --partial "Delete a custom image"
}

# ============================================
# Version-Specific Delete
# ============================================

@test "vm0 image delete with version syntax deletes specific version" {
    # Clean up first
    run $CLI_COMMAND image delete "$TEST_IMAGE_NAME" --all --force 2>/dev/null || true

    # Create two different Dockerfiles (SHA256 versioning is content-based)
    local DOCKERFILE1="${TEST_TMP_DIR}/Dockerfile.del1"
    local DOCKERFILE2="${TEST_TMP_DIR}/Dockerfile.del2"
    echo 'FROM e2bdev/code-interpreter:latest
RUN echo "delete-test-v1" > /tmp/version.txt' > "$DOCKERFILE1"
    echo 'FROM e2bdev/code-interpreter:latest
RUN echo "delete-test-v2" > /tmp/version.txt' > "$DOCKERFILE2"

    # Build two different versions
    run $CLI_COMMAND image build --file "$DOCKERFILE1" --name "$TEST_IMAGE_NAME"
    assert_success
    VERSION1=$(echo "$output" | grep -oP ':\K[a-f0-9]{8}' | head -1)

    run $CLI_COMMAND image build --file "$DOCKERFILE2" --name "$TEST_IMAGE_NAME"
    assert_success
    VERSION2=$(echo "$output" | grep -oP ':\K[a-f0-9]{8}' | head -1)

    # Delete specific version
    run $CLI_COMMAND image delete "${TEST_IMAGE_NAME}:${VERSION1}" --force
    assert_success

    # VERSION2 should still exist
    run $CLI_COMMAND image versions "$TEST_IMAGE_NAME"
    assert_success
    assert_output --partial "$VERSION2"
    # VERSION1 should be gone
    refute_output --partial "$VERSION1"

    # Clean up
    run $CLI_COMMAND image delete "$TEST_IMAGE_NAME" --all --force
}

@test "vm0 image delete --all removes all versions" {
    # Build two versions
    run $CLI_COMMAND image build --file "$TEST_DOCKERFILE" --name "$TEST_IMAGE_NAME"
    assert_success

    run $CLI_COMMAND image build --file "$TEST_DOCKERFILE" --name "$TEST_IMAGE_NAME"
    assert_success

    # Delete all versions
    run $CLI_COMMAND image delete "$TEST_IMAGE_NAME" --all --force
    assert_success

    # Image should no longer exist
    run $CLI_COMMAND image versions "$TEST_IMAGE_NAME"
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 image delete without --all deletes latest version only" {
    # Clean up first
    run $CLI_COMMAND image delete "$TEST_IMAGE_NAME" --all --force 2>/dev/null || true

    # Create two different Dockerfiles (SHA256 versioning is content-based)
    local DOCKERFILE1="${TEST_TMP_DIR}/Dockerfile.latest1"
    local DOCKERFILE2="${TEST_TMP_DIR}/Dockerfile.latest2"
    echo 'FROM e2bdev/code-interpreter:latest
RUN echo "latest-test-v1" > /tmp/version.txt' > "$DOCKERFILE1"
    echo 'FROM e2bdev/code-interpreter:latest
RUN echo "latest-test-v2" > /tmp/version.txt' > "$DOCKERFILE2"

    # Build two different versions
    run $CLI_COMMAND image build --file "$DOCKERFILE1" --name "$TEST_IMAGE_NAME"
    assert_success
    VERSION1=$(echo "$output" | grep -oP ':\K[a-f0-9]{8}' | head -1)

    run $CLI_COMMAND image build --file "$DOCKERFILE2" --name "$TEST_IMAGE_NAME"
    assert_success
    VERSION2=$(echo "$output" | grep -oP ':\K[a-f0-9]{8}' | head -1)

    # Delete without --all should delete latest (VERSION2)
    run $CLI_COMMAND image delete "$TEST_IMAGE_NAME" --force
    assert_success

    # VERSION1 should still exist
    run $CLI_COMMAND image versions "$TEST_IMAGE_NAME"
    assert_success
    assert_output --partial "$VERSION1"
    # VERSION2 (latest) should be gone
    refute_output --partial "$VERSION2"

    # Clean up
    run $CLI_COMMAND image delete "$TEST_IMAGE_NAME" --all --force
}

@test "vm0 image delete non-existent version fails" {
    run $CLI_COMMAND image delete "${TEST_IMAGE_NAME}:nonexistent123" --force
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 image delete non-existent image fails" {
    run $CLI_COMMAND image delete "nonexistent-image-xyz" --force
    assert_failure
    assert_output --partial "not found"
}

# ============================================
# Tag Resolution (e2e with compose)
# ============================================

@test "vm0 run resolves image:tag to specific version" {
    skip "Tag resolution in compose requires full run integration"
    # This test would verify that specifying image: "my-image:abc123"
    # in vm0.yaml correctly resolves to that specific version
}
