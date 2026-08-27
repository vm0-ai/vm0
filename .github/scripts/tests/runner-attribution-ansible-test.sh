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
  if [ ! -f "$file" ]; then
    echo "expected file to exist: $file" >&2
    exit 1
  fi
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

prepare_fake_runners() {
  local hostname
  for hostname in runner-promotion-a runner-promotion-b; do
    local bin_dir="$tmp/$hostname/bin/$runner_name"
    mkdir -p "$bin_dir"
    cp "$tmp/fake-runner" "$bin_dir/runner"
  done
}

verify_configs() {
  local hostname
  for hostname in runner-promotion-a runner-promotion-b; do
    local config="$tmp/$hostname/runners/$runner_name/runner.yaml"
    assert_line_count "$config" 1 "hostname: \"$hostname\""
    if grep -Eq '^name:' "$config"; then
      echo "generated config retained removed top-level name: $config" >&2
      sed -n '1,40p' "$config" >&2
      exit 1
    fi
  done
}

run_config_tasks() {
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
      -e "default_rootfs_hash=rootfs" \
      -e "default_snapshot_hash=snapshot" \
      -e "api_url=https://www.vm0.ai" \
      -e "official_runner_secret=test" \
      "$playbook" >"$tmp/ansible-output" 2>&1
}

cat >"$tmp/fake-runner" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" != "config" ]; then
  echo "expected runner config, got: $*" >&2
  exit 1
fi
shift

hostname=
runner_dirname=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hostname)
      hostname=$2
      shift 2
      ;;
    --runner-dirname)
      runner_dirname=$2
      shift 2
      ;;
    --name)
      echo "config generation retained removed --name: $*" >&2
      exit 1
      ;;
    --profile|--rootfs-hash|--snapshot-hash|--group|--api-url|--token)
      shift 2
      ;;
    *)
      echo "unexpected runner config argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$hostname" ] || [ -z "$runner_dirname" ]; then
  echo "runner config requires hostname and runner dirname" >&2
  exit 1
fi

data_dir="$(cd "$(dirname "$0")/../.." && pwd)"
runner_dir="$data_dir/runners/$runner_dirname"
mkdir -p "$runner_dir"
printf 'hostname: "%s"\n' "$hostname" >"$runner_dir/runner.yaml"
EOF
chmod +x "$tmp/fake-runner"

prepare_fake_runners

for playbook in "$build_playbook" "$rollback_playbook"; do
  HOME="$test_home" \
    ANSIBLE_CONFIG="$ansible_config" \
    ANSIBLE_NOCOLOR=1 \
    ansible-playbook -i "$inventory" --syntax-check "$playbook" >/dev/null

  if ! run_config_tasks "$playbook"; then
    sed -n '1,200p' "$tmp/ansible-output" >&2
    exit 1
  fi
  verify_configs

  if ! run_config_tasks "$playbook"; then
    sed -n '1,200p' "$tmp/ansible-output" >&2
    exit 1
  fi
  verify_configs
done

echo "runner-attribution-ansible-test: ok"
