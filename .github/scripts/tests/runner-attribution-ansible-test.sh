#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
ansible_config="$repo_root/ansible/ansible.cfg"
inventory="$script_dir/fixtures/runner-promotion-local.ini"
build_playbook="$repo_root/ansible/playbooks/build-runner.yml"
rollback_playbook="$repo_root/ansible/playbooks/rollback-runner.yml"
runner_name=v999.0.0

if ! command -v ansible-playbook >/dev/null; then
  echo "ansible-playbook is required" >&2
  exit 1
fi

assert_line_count() {
  local file=$1
  local expected=$2
  local pattern=$3
  local actual
  actual=$(grep -Fxc -- "$pattern" "$file" || true)
  if [ "$actual" -ne "$expected" ]; then
    echo "expected ${file} to contain ${expected} exact line(s): ${pattern}; got ${actual}" >&2
    sed -n '1,40p' "$file" >&2
    exit 1
  fi
}

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

test_home="$tmp/home"
mkdir -p "$test_home"

prepare_configs() {
  local hostname
  for hostname in runner-promotion-a runner-promotion-b; do
    local runner_dir="$tmp/$hostname/runners/$runner_name"
    mkdir -p "$runner_dir"
    printf 'name: %s\nhostname: "stale-host"\n' "$runner_name" \
      >"$runner_dir/runner.yaml"
  done
}

verify_configs() {
  local hostname
  for hostname in runner-promotion-a runner-promotion-b; do
    local config="$tmp/$hostname/runners/$runner_name/runner.yaml"
    assert_line_count "$config" 1 "name: $runner_name"
    assert_line_count "$config" 1 "hostname: \"$hostname\""
  done
}

run_attribution_tasks() {
  local playbook=$1
  HOME="$test_home" \
    ANSIBLE_CONFIG="$ansible_config" \
    ANSIBLE_NOCOLOR=1 \
    ansible-playbook \
      -i "$inventory" \
      --forks 2 \
      --tags runner-config-attribution \
      -e "data_dir=$tmp/{{ inventory_hostname }}" \
      -e "runner_version=999.0.0" \
      "$playbook" >"$tmp/ansible-output" 2>&1
}

for playbook in "$build_playbook" "$rollback_playbook"; do
  HOME="$test_home" \
    ANSIBLE_CONFIG="$ansible_config" \
    ANSIBLE_NOCOLOR=1 \
    ansible-playbook -i "$inventory" --syntax-check "$playbook" >/dev/null

  prepare_configs
  if ! run_attribution_tasks "$playbook"; then
    sed -n '1,200p' "$tmp/ansible-output" >&2
    exit 1
  fi
  verify_configs

  # A repeated deploy must replace the same key rather than append another.
  if ! run_attribution_tasks "$playbook"; then
    sed -n '1,200p' "$tmp/ansible-output" >&2
    exit 1
  fi
  verify_configs
done

if grep -Fq -- "--hostname" "$rollback_playbook"; then
  echo "rollback must not pass a new hostname flag to retained binaries" >&2
  exit 1
fi

echo "runner-attribution-ansible-test: ok"
