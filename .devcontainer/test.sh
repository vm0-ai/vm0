#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

copy_script() {
  local workspace="$1"
  local script="$2"

  mkdir -p "$workspace/.devcontainer"
  cp "$REPO_ROOT/.devcontainer/$script" "$workspace/.devcontainer/$script"
}

test_skill_link_file_conflict() {
  local workspace="$TEST_ROOT/link-file-conflict"
  local output

  copy_script "$workspace" "link-agent-skills.sh"
  mkdir -p "$workspace/.claude/skills" "$workspace/.agents"
  printf 'keep me\n' > "$workspace/.agents/skills"

  output="$(HOME="$workspace/home" bash "$workspace/.devcontainer/link-agent-skills.sh")"

  grep -Fq "Skipping .agents/skills link because a non-directory entry already exists" <<< "$output" \
    || fail "non-directory conflict did not report that linking was skipped"
  grep -Fxq "keep me" "$workspace/.agents/skills" \
    || fail "non-directory conflict was modified"
}

test_skill_link_directory_conflict() {
  local workspace="$TEST_ROOT/link-directory-conflict"
  local skills_dir="$workspace/.agents/skills"
  local output

  copy_script "$workspace" "link-agent-skills.sh"
  mkdir -p "$workspace/.claude/skills" "$skills_dir"
  mkdir "$skills_dir"/entry-{00001..10000}

  output="$(HOME="$workspace/home" bash "$workspace/.devcontainer/link-agent-skills.sh")"

  grep -Fq "Skipping .agents/skills link because it contains non-symlink entries" <<< "$output" \
    || fail "directory conflict did not report that linking was skipped"
  test -d "$skills_dir/entry-10000" \
    || fail "directory conflict was modified"
}

test_pgvector_probe_uses_unix_socket() {
  local workspace="$TEST_ROOT/pgvector-probe"
  local fake_bin="$workspace/fake-bin"
  local sudo_log="$workspace/sudo.log"

  copy_script "$workspace" "setup.sh"
  mkdir -p "$fake_bin" "$workspace/home" "$workspace/turbo"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\\n" "$*" >> "$SUDO_CALLS_LOG"' \
    'if [[ "$*" == "-u postgres psql "* ]]; then' \
    "  printf '1\\n'" \
    'fi' \
    > "$fake_bin/sudo"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'exit 0' \
    > "$fake_bin/lefthook"
  chmod +x "$fake_bin/sudo" "$fake_bin/lefthook"

  HOME="$workspace/home" \
    PATH="$fake_bin:$PATH" \
    SUDO_CALLS_LOG="$sudo_log" \
    bash "$workspace/.devcontainer/setup.sh" > /dev/null

  grep -Fq -- "-u postgres psql -h /var/run/postgresql -d postgres -Atqc" "$sudo_log" \
    || fail "pgvector availability probe did not use the local Unix socket"
}

test_skill_link_file_conflict
test_skill_link_directory_conflict
test_pgvector_probe_uses_unix_socket

echo "Devcontainer integration tests passed"
