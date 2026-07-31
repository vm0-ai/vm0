#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
ansible_config="$repo_root/ansible/ansible.cfg"
inventory="$script_dir/fixtures/runner-promotion-local.ini"
promote_playbook="$repo_root/ansible/playbooks/promote-runner.yml"
rollback_playbook="$repo_root/ansible/playbooks/rollback-runner.yml"
gc_task="$repo_root/ansible/tasks/garbage-collect-runner.yml"

if ! command -v ansible-playbook >/dev/null; then
  echo "ansible-playbook is required" >&2
  exit 1
fi

assert_contains() {
  local file=$1
  local expected=$2
  if ! grep -Fq -- "$expected" "$file"; then
    echo "expected ${file} to contain: ${expected}" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_line_count() {
  local file=$1
  local expected=$2
  local pattern=$3
  local actual
  actual=$(grep -Fxc -- "$pattern" "$file" || true)
  if [ "$actual" -ne "$expected" ]; then
    echo "expected ${file} to contain ${expected} exact line(s): ${pattern}; got ${actual}" >&2
    cat "$file" >&2
    exit 1
  fi
}

case "$(uname -m)" in
  x86_64)
    runner_target=x86_64-unknown-linux-musl
    ;;
  aarch64)
    runner_target=aarch64-unknown-linux-musl
    ;;
  *)
    echo "unsupported test architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

test_home="$tmp/home"
data_dir="$tmp/vm0-runner"
runner_name=v999.0.0
runner_dir="$data_dir/bin/$runner_name"
invocation_log="$data_dir/runner-invocations"
mkdir -p "$test_home" "$data_dir/locks" "$data_dir/runners/$runner_name" "$runner_dir"

fake_runner="$runner_dir/runner"
cat > "$fake_runner" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

data_dir="$(cd "$(dirname "$0")/../.." && pwd)"
invocation_log="$data_dir/runner-invocations"
printf '%s\n' "$*" >> "$invocation_log"

case "${1:-}" in
  service)
    case "${2:-}" in
      install|wait-running|drain)
        exit 0
        ;;
    esac
    ;;
  doctor)
    exit 0
    ;;
  gc)
    if [ "$*" != "gc --keep-latest 6 --protect-version v999.0.0" ]; then
      echo "unexpected gc arguments: $*" >&2
      exit 1
    fi

    active_dir="$data_dir/gc-active"
    if ! mkdir "$active_dir"; then
      echo "runner gc invocations overlapped" >&2
      exit 1
    fi
    trap 'rmdir "$active_dir"' EXIT
    sleep 1
    exit 0
    ;;
esac

echo "unexpected runner invocation: $*" >&2
exit 1
EOF
chmod +x "$fake_runner"

for playbook in "$promote_playbook" "$rollback_playbook"; do
  HOME="$test_home" \
    ANSIBLE_CONFIG="$ansible_config" \
    ANSIBLE_NOCOLOR=1 \
    ansible-playbook -i "$inventory" --syntax-check "$playbook" >/dev/null
done

assert_contains "$promote_playbook" "include_tasks: ../tasks/garbage-collect-runner.yml"
assert_contains "$rollback_playbook" "include_tasks: ../tasks/garbage-collect-runner.yml"
assert_contains "$gc_task" "{{ data_dir }}/locks/deployment-gc.lock"

if ! HOME="$test_home" \
  ANSIBLE_CONFIG="$ansible_config" \
  ANSIBLE_NOCOLOR=1 \
  ansible-playbook \
    -i "$inventory" \
    --forks 2 \
    -e "data_dir=$data_dir" \
    -e "runner_version=999.0.0" \
    -e "runner_target=$runner_target" \
    "$promote_playbook" >"$tmp/promote-output" 2>&1; then
  cat "$tmp/promote-output" >&2
  exit 1
fi

assert_line_count "$invocation_log" 2 \
  "gc --keep-latest 6 --protect-version $runner_name"
assert_line_count "$invocation_log" 4 "doctor --name $runner_name"
assert_line_count "$invocation_log" 2 \
  "service wait-running --name $runner_name --timeout-secs 120"

echo "runner-promotion-ansible-test: ok"
