#!/bin/bash

# Universal CI Check Script
# Works with: lefthook, Claude Code, manual execution

set -e

# Get the project root directory (parent of scripts directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "🔍 Running CI checks..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Function to run a check with error handling
run_check() {
    local name="$1"
    local command="$2"
    local emoji="$3"

    echo ""
    echo "$emoji $name..."

    if (eval "$command") > /tmp/ci-output.log 2>&1; then
        echo "✅ $name passed"
        return 0
    else
        echo "❌ $name failed!"
        echo ""
        echo "Error details:"
        tail -20 /tmp/ci-output.log
        echo ""
        echo "💡 Fix the issues and try again"
        return 1
    fi
}

# Run checks sequentially, stop on first failure
run_check "Lint" "cd '$PROJECT_ROOT/turbo' && pnpm turbo run lint" "📝" || exit 1
run_check "Format" "cd '$PROJECT_ROOT/turbo' && pnpm format" "✨" || exit 1

# Optional checks (skip if environment not ready)
if [ -n "$SKIP_DB_CHECK" ]; then
    echo "⏭️  Skipping database migration check (SKIP_DB_CHECK set)"
else
    run_check "Database Migration" "cd '$PROJECT_ROOT/turbo' && pnpm -F web db:migrate" "🗄️" || {
        echo "💡 Tip: Set SKIP_DB_CHECK=1 to skip DB checks in dev environment"
        exit 1
    }
fi

run_check "Build" "cd '$PROJECT_ROOT/turbo' && pnpm turbo run build" "🔨" || exit 1

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All CI checks passed!"
