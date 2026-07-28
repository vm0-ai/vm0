#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
ansible_config="$repo_root/ansible/ansible.cfg"

if ! command -v ansible-playbook >/dev/null; then
  echo "ansible-playbook is required" >&2
  exit 1
fi

for playbook in "$repo_root"/ansible/playbooks/*.yml; do
  ANSIBLE_CONFIG="$ansible_config" \
    ansible-playbook -i "localhost," --syntax-check "$playbook" >/dev/null
done

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

test_home="$tmp/github-home"
mkdir -p "$test_home/.ssh"

fake_ssh="$tmp/ssh"
cat > "$fake_ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

actual_control_path=""

for argument in "$@"; do
  if [[ "$argument" == ControlPath=* ]]; then
    actual_control_path="${argument#ControlPath=}"
    actual_control_path="${actual_control_path#\"}"
    actual_control_path="${actual_control_path%\"}"
    break
  fi
done

if [ "$actual_control_path" != "$EXPECTED_CONTROL_PATH" ]; then
  echo "expected Ansible SSH control path: ${EXPECTED_CONTROL_PATH}" >&2
  echo "actual Ansible SSH control path: ${actual_control_path:-missing}" >&2
  printf 'argument: %s\n' "$@" >&2
  exit 1
fi

if [ ! -d "$(dirname "$EXPECTED_CONTROL_PATH")" ]; then
  echo "Ansible SSH control path parent does not exist" >&2
  exit 1
fi

touch "$SSH_MARKER"
printf 'ansible ssh transport ok\n'
EOF
chmod +x "$fake_ssh"

playbook="$tmp/control-path.yml"
cat > "$playbook" <<'EOF'
---
- name: Exercise the Ansible SSH connection plugin
  hosts: all
  gather_facts: false
  tasks:
    - name: Run a command through SSH
      ansible.builtin.raw: printf 'remote command ok\n'
      changed_when: false
EOF

expected_control_path="$test_home/.ssh/vm0-ssh-%C"
ssh_marker="$tmp/ssh-ran"
HOME="$test_home" \
  ANSIBLE_CONFIG="$ansible_config" \
  ANSIBLE_NOCOLOR=1 \
  ANSIBLE_SSH_CONTROL_PATH="$test_home/.ssh/vm0-ssh-%%C" \
  EXPECTED_CONTROL_PATH="$expected_control_path" \
  SSH_MARKER="$ssh_marker" \
  ansible-playbook \
    -i "ansible-test.invalid," \
    -e "ansible_ssh_executable=$fake_ssh" \
    "$playbook" >/dev/null

if [ ! -f "$ssh_marker" ]; then
  echo "expected Ansible to complete an SSH-backed task" >&2
  exit 1
fi

echo "ansible-ssh-control-path-test: ok"
