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

test_postgresql_setup() {
  local workspace="$TEST_ROOT/postgresql-setup"
  local fake_bin="$workspace/fake-bin"
  local psql_log="$workspace/psql.log"
  local sudo_log="$workspace/sudo.log"

  copy_script "$workspace" "setup.sh"
  mkdir -p "$fake_bin" "$workspace/home" "$workspace/turbo"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\\n" "$*" >> "$SUDO_CALLS_LOG"' \
    'if [[ "$*" == *"pg_available_extensions"* ]]; then' \
    "  printf '1\\n'" \
    'fi' \
    > "$fake_bin/sudo"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\\n" "$*" >> "$PSQL_CALLS_LOG"' \
    "printf '1\\n'" \
    > "$fake_bin/psql"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'exit 0' \
    > "$fake_bin/lefthook"
  chmod +x "$fake_bin/sudo" "$fake_bin/psql" "$fake_bin/lefthook"

  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres" \
    HOME="$workspace/home" \
    PATH="$fake_bin:$PATH" \
    PSQL_CALLS_LOG="$psql_log" \
    SUDO_CALLS_LOG="$sudo_log" \
    bash "$workspace/.devcontainer/setup.sh" > /dev/null

  grep -Fxq "service postgresql start" "$sudo_log" \
    || fail "PostgreSQL service was not started"
  grep -Fq -- "-u postgres psql -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -c ALTER ROLE postgres PASSWORD 'postgres';" "$sudo_log" \
    || fail "PostgreSQL password was not configured"
  grep -Fq -- "postgresql://postgres:postgres@localhost:5432/postgres -v ON_ERROR_STOP=1 -Atqc SELECT 1" "$psql_log" \
    || fail "PostgreSQL password authentication was not verified"
  grep -Fq -- "-u postgres psql -h /var/run/postgresql -d postgres -Atqc" "$sudo_log" \
    || fail "pgvector availability probe did not use the local Unix socket"
}

test_devcontainer_postgresql_config() {
  local config="$REPO_ROOT/.devcontainer/devcontainer.json"
  local lock="$REPO_ROOT/.devcontainer/devcontainer-lock.json"

  jq -e '.features | has("ghcr.io/itsmechlark/features/postgresql:1") | not' "$config" > /dev/null \
    || fail "PostgreSQL feature should not duplicate the vm0-dev image"
  jq -e '.features | has("ghcr.io/itsmechlark/features/postgresql:1") | not' "$lock" > /dev/null \
    || fail "PostgreSQL feature lock should be removed"
  jq -e '.postStartCommand | startswith("sudo service postgresql start &&")' "$config" > /dev/null \
    || fail "PostgreSQL service should start with the container"
  jq -e '.customizations.vscode.settings."sqltools.connections"[0].password == "postgres"' "$config" > /dev/null \
    || fail "SQLTools password should match DATABASE_URL"
}

test_skill_link_file_conflict
test_skill_link_directory_conflict
test_postgresql_setup
test_devcontainer_postgresql_config

echo "Devcontainer integration tests passed"
