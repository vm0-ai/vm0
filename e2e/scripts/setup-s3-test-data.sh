#!/bin/bash
set -e

# Setup S3 test data for volume mounting E2E tests
# This script is run in CI environment before E2E tests

BUCKET="vm0-s3-ci-test"
REGION="${AWS_REGION:-us-west-2}"

echo "Setting up S3 test data in bucket: $BUCKET"

# Test 1: Static volume - Simple text file
echo "Creating static volume test data..."
echo "Hello from S3 volume!" | aws s3 cp - "s3://${BUCKET}/e2e-tests/static-volume/message.txt"

# Test 2: Dynamic volume with template variable - User-specific data
echo "Creating dynamic volume test data..."
echo "Hello from test-user-123!" | aws s3 cp - "s3://${BUCKET}/e2e-tests/users/test-user-123/message.txt"

echo "S3 test data setup complete!"
echo "Bucket contents:"
aws s3 ls "s3://${BUCKET}/e2e-tests/" --recursive
