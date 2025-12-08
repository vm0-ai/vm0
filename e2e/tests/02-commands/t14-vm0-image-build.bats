#!/usr/bin/env bats

# Test VM0 image build command
# Tests the CLI for building custom images from Dockerfiles
#
# This test covers issue #406: vm0 image build command

load '../../helpers/setup'

setup() {
    export TEST_DOCKERFILE="${TEST_ROOT}/fixtures/dockerfiles/Dockerfile.simple"
    export TEST_TMP_DIR="$(mktemp -d)"
    # Use fixed name with --delete-existing to test the delete functionality
    # See: https://github.com/vm0-ai/vm0/issues/428
    export TEST_IMAGE_NAME="e2e-image-test"
}

teardown() {
    if [ -n "$TEST_TMP_DIR" ] && [ -d "$TEST_TMP_DIR" ]; then
        rm -rf "$TEST_TMP_DIR"
    fi
}

# ============================================
# CLI Validation Tests (fast, no network)
# ============================================

@test "vm0 image build rejects missing Dockerfile" {
    run $CLI_COMMAND image build --file /nonexistent/Dockerfile --name test-image
    assert_failure
    assert_output --partial "not found"
}

@test "vm0 image build rejects name that is too short" {
    # Create a temporary Dockerfile
    echo "FROM alpine" > "$TEST_TMP_DIR/Dockerfile"

    run $CLI_COMMAND image build --file "$TEST_TMP_DIR/Dockerfile" --name "ab"
    assert_failure
    assert_output --partial "Invalid name format"
}

@test "vm0 image build rejects name with invalid characters" {
    echo "FROM alpine" > "$TEST_TMP_DIR/Dockerfile"

    run $CLI_COMMAND image build --file "$TEST_TMP_DIR/Dockerfile" --name "test_image"
    assert_failure
    assert_output --partial "Invalid name format"
}

@test "vm0 image build rejects reserved vm0- prefix" {
    echo "FROM alpine" > "$TEST_TMP_DIR/Dockerfile"

    run $CLI_COMMAND image build --file "$TEST_TMP_DIR/Dockerfile" --name "vm0-custom"
    assert_failure
    assert_output --partial "vm0-"
}

@test "vm0 image build rejects name starting with hyphen" {
    echo "FROM alpine" > "$TEST_TMP_DIR/Dockerfile"

    run $CLI_COMMAND image build --file "$TEST_TMP_DIR/Dockerfile" --name "-invalid"
    assert_failure
    assert_output --partial "Invalid name format"
}

# ============================================
# Build Submission Tests (requires network)
# ============================================

@test "vm0 image build submits build request successfully" {
    # Submit build request with --delete-existing to test delete functionality
    run $CLI_COMMAND image build --file "$TEST_DOCKERFILE" --name "$TEST_IMAGE_NAME" --delete-existing

    # Build should start successfully
    assert_success
    assert_output --partial "Building image"
    assert_output --partial "Build ID"
}
