#!/usr/bin/env bash
#
# Pre-commit hook to check file sizes
# Usage: check-file-size.sh [files...]
#
set -euo pipefail

# Configuration
LIMIT_BYTES=${FILE_SIZE_LIMIT:-1048576}  # Default 1MB
LIMIT_MB=$((LIMIT_BYTES / 1048576))

# Allow override via environment variable
if [ "${ALLOW_LARGE_FILES:-}" = "1" ]; then
  echo "ALLOW_LARGE_FILES=1: Skipping file size check"
  exit 0
fi

# Check if any files provided
if [ $# -eq 0 ]; then
  exit 0
fi

failed=0
checked=0

for file in "$@"; do
  # Skip if file doesn't exist (deleted files)
  if [ ! -f "$file" ]; then
    continue
  fi

  # Get file size (portable across Linux/macOS)
  size=$(wc -c < "$file" | tr -d ' ')
  checked=$((checked + 1))

  if [ "$size" -gt "$LIMIT_BYTES" ]; then
    size_mb=$(awk "BEGIN {printf \"%.2f\", $size / 1048576}")
    echo "ERROR: $file is ${size_mb}MB (limit: ${LIMIT_MB}MB)"
    failed=1
  fi
done

if [ "$failed" -eq 1 ]; then
  echo ""
  echo "Suggestions:"
  echo "  - Compress images: pngquant, jpegoptim, svgo"
  echo "  - Use Git LFS for large binary files"
  echo "  - Override: ALLOW_LARGE_FILES=1 git commit -m '...'"
  exit 1
fi

exit 0
