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

# Create a JSON file with test data
cat > /tmp/test-config.json <<EOF
{
  "test": "volume-mounting",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "ready"
}
EOF
aws s3 cp /tmp/test-config.json "s3://${BUCKET}/e2e-tests/static-volume/config.json"
rm /tmp/test-config.json

# Test 2: Dynamic volume with template variable - User-specific data
echo "Creating dynamic volume test data..."
mkdir -p /tmp/test-user-data

# Create user profile for test-user-123
cat > /tmp/test-user-data/profile.json <<EOF
{
  "userId": "test-user-123",
  "name": "Test User",
  "role": "tester"
}
EOF
aws s3 cp /tmp/test-user-data/profile.json "s3://${BUCKET}/e2e-tests/users/test-user-123/profile.json"

# Create a workspace file
echo "# User Workspace\nThis is test-user-123's workspace." > /tmp/test-user-data/README.md
aws s3 cp /tmp/test-user-data/README.md "s3://${BUCKET}/e2e-tests/users/test-user-123/README.md"

rm -rf /tmp/test-user-data

echo "S3 test data setup complete!"
echo "Bucket contents:"
aws s3 ls "s3://${BUCKET}/e2e-tests/" --recursive
