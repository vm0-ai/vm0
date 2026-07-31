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
test_bin="$tmp/bin"
runner_name=v999.0.0
runner_dir="$data_dir/bin/$runner_name"
invocation_log="$data_dir/runner-invocations"
gc_arrivals="$data_dir/gc-arrivals"
mkdir -p \
  "$test_home" \
  "$test_bin" \
  "$data_dir/locks" \
  "$data_dir/runners/$runner_name" \
  "$gc_arrivals" \
  "$runner_dir"

ln -s "$(command -v flock)" "$test_bin/real-flock"
cat > "$test_bin/flock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" != "--exclusive" ] || [ -z "${2:-}" ]; then
  echo "unexpected flock invocation: $*" >&2
  exit 1
fi

data_dir="$(cd "$(dirname "$2")/.." && pwd)"
touch "$data_dir/gc-arrivals/$BASHPID"
exec "$(dirname "$0")/real-flock" "$@"
EOF
chmod +x "$test_bin/flock"

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

    arrivals_ready=false
    for ((attempt = 0; attempt < 1000; attempt++)); do
      arrival_count=$(
        find "$data_dir/gc-arrivals" -mindepth 1 -maxdepth 1 -type f -print |
          wc -l
      )
      if [ "$arrival_count" -ge 2 ]; then
        arrivals_ready=true
        break
      fi
      /bin/sleep 0.01
    done
    if [ "$arrivals_ready" != "true" ]; then
      echo "timed out waiting for both gc lock contenders" >&2
      exit 1
    fi
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

if ! PATH="$test_bin:$PATH" \
  HOME="$test_home" \
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
