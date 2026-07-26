#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER}@${HOST}"

echo "=== Generating config ==="
# shellcheck disable=SC2029
ssh "$REMOTE" "sudo ${BIN_DIR}/runner config \
  --profile vm0/default \
  --rootfs-hash ${DEFAULT_ROOTFS_HASH} \
  --snapshot-hash ${DEFAULT_SNAPSHOT_HASH} \
  --name ${JOB_REF}-exec \
  --group vm0/exec-${JOB_REF} \
  --runner-dirname ${JOB_REF}-exec \
  --max-concurrent 2 \
  --api-url https://not-a-real-server.test \
  --token vm0_official_${OFFICIAL_RUNNER_SECRET}"

echo "=== Running exec test ==="
ssh "$REMOTE" bash -s -- "${BIN_DIR}" "${JOB_REF}" <<'REMOTE_SCRIPT'
BIN_DIR=$1; JOB_REF=$2
RUNNER_DIR="/var/lib/vm0-runner/runners/${JOB_REF}-exec"
SVC="${JOB_REF}-exec"
UNIT="vm0-runner-${SVC}.service"
GROUP="vm0/exec-${JOB_REF}"
# Keep this distinct from startup readiness so NAT observes a new conntrack flow.
BEHAVIOR_DNS_DESTINATION="198.51.100.1"
STARTUP_TIMEOUT_SECS=120
STARTUP_LOG_LINES=300
STARTUP_CURSOR=""
STARTUP_ACTIVE_STATE=""
STARTUP_DIAGNOSTIC_LOGS=""
SUBMIT_PID=""
DNS_ISOLATION_NS=""
DNS_ISOLATION_HOST_IF=""
DNS_ISOLATION_LOCK_FD=""
SPOOF_NS=""
SPOOF_IP=""
POOL_LOCK_GUARD_DIR=""
POOL_LOCK_HOLDER_PID=""
POOL_LOCK_RELEASE_FD=""
POOL_LOCK_ERROR=""

fail() { echo "FAIL: $1"; exit 1; }

report_startup_diagnostics() {
  local readiness_status=$1 readiness_output=$2
  local unit_state invocation_id invocation_logs unit_logs

  echo "--- Runner readiness command ---"
  echo "Exit status: $readiness_status"
  printf '%s\n' "$readiness_output"

  if unit_state=$(sudo "$BIN_DIR/runner" service unit-state \
    --name "$SVC" 2>&1); then
    STARTUP_ACTIVE_STATE=$(printf '%s\n' "$unit_state" \
      | jq -r '.services[0].activeState // empty' 2>/dev/null) || true
  else
    unit_state="unit-state query failed: $unit_state"
  fi
  echo "--- Runner unit state ---"
  printf '%s\n' "$unit_state"

  if invocation_id=$(sudo systemctl show "$UNIT" \
    --property=InvocationID --value 2>&1); then
    if [ -n "$invocation_id" ]; then
      if ! invocation_logs=$(sudo journalctl --no-pager \
        --lines "$STARTUP_LOG_LINES" \
        "_SYSTEMD_INVOCATION_ID=$invocation_id" 2>&1); then
        invocation_logs="current invocation journal query failed: $invocation_logs"
      fi
    else
      invocation_logs="current invocation ID is empty"
    fi
  else
    invocation_logs="current invocation ID query failed: $invocation_id"
    invocation_id="unknown"
  fi
  echo "--- Current runner invocation: $invocation_id ---"
  printf '%s\n' "$invocation_logs"

  if ! unit_logs=$(sudo journalctl --no-pager \
    --lines "$STARTUP_LOG_LINES" --after-cursor="$STARTUP_CURSOR" \
    --unit "$UNIT" 2>&1); then
    unit_logs="post-start unit journal query failed: $unit_logs"
  fi
  echo "--- Runner unit journal after service start ---"
  printf '%s\n' "$unit_logs"

  STARTUP_DIAGNOSTIC_LOGS="${invocation_logs}
${unit_logs}"
}

cleanup_submit_pid() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup_spoof_address() {
  if [ -n "$SPOOF_NS" ] && [ -n "$SPOOF_IP" ]; then
    sudo ip -n "$SPOOF_NS" address delete "${SPOOF_IP}/32" \
      dev veth0 2>/dev/null || true
  fi
  SPOOF_NS=""
  SPOOF_IP=""
}

cleanup_pool_lock_guard() {
  if [ -n "$POOL_LOCK_RELEASE_FD" ]; then
    exec {POOL_LOCK_RELEASE_FD}>&-
    POOL_LOCK_RELEASE_FD=""
  fi
  if [ -n "$POOL_LOCK_HOLDER_PID" ]; then
    kill "$POOL_LOCK_HOLDER_PID" 2>/dev/null || true
    wait "$POOL_LOCK_HOLDER_PID" 2>/dev/null || true
    POOL_LOCK_HOLDER_PID=""
  fi
  if [ -n "$POOL_LOCK_GUARD_DIR" ]; then
    rm -rf "$POOL_LOCK_GUARD_DIR"
    POOL_LOCK_GUARD_DIR=""
  fi
}

rule_values() {
  local option=$1
  awk -v option="$option" '
    {
      for (i = 1; i < NF; i++) {
        if ($i == option) {
          value = $(i + 1)
          gsub(/^"|"$/, "", value)
          print value
        }
      }
    }
  '
}

rule_value() {
  local rule=$1 option=$2
  printf '%s\n' "$rule" | rule_values "$option" | head -n 1
}

rule_packet_count() {
  local rule=$1
  printf '%s\n' "$rule" | awk '
    $1 ~ /^\[[0-9]+:[0-9]+\]$/ {
      gsub(/^\[/, "", $1)
      split($1, counter, ":")
      print counter[1]
      exit
    }
  '
}

link_identity_fields() {
  local expected_ifname=$1
  jq -er --arg expected_ifname "$expected_ifname" '
    if type == "array"
      and length == 1
      and .[0].ifname == $expected_ifname
    then
      [
        .[0].ifindex,
        .[0].link_index
      ] | @tsv
    else
      error("expected exactly one link named \($expected_ifname)")
    end
  '
}

send_udp_dns_query() {
  local namespace=$1 source_ip=$2 destination_ip=$3
  sudo ip netns exec "$namespace" python3 - "$source_ip" "$destination_ip" <<'PY'
import socket
import sys

query = bytes.fromhex(
    "123401000001000000000000"
    "0c736f757263652d6775617264"
    "07696e76616c69640000010001"
)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind((sys.argv[1], 0))
sock.sendto(query, (sys.argv[2], 53))
sock.close()
PY
}

cleanup() {
  echo "--- Cleanup ---"
  cleanup_spoof_address
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
  cleanup_pool_lock_guard
  cleanup_submit_pid "$SUBMIT_PID"
  if [ -n "$DNS_ISOLATION_NS" ]; then
    sudo ip netns delete "$DNS_ISOLATION_NS" 2>/dev/null || true
  fi
  if [ -n "$DNS_ISOLATION_HOST_IF" ]; then
    sudo ip link delete "$DNS_ISOLATION_HOST_IF" 2>/dev/null || true
  fi
  if [ -n "$DNS_ISOLATION_LOCK_FD" ]; then
    exec {DNS_ISOLATION_LOCK_FD}>&-
  fi
}
trap cleanup EXIT

# Clean up any residual transient unit from a previous CI run.
# stop() returns Ok when no service exists, so no need for || true.
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force

# Start transient runner service
echo "--- Starting runner ---"
STARTUP_CURSOR=$(sudo journalctl --no-pager --lines=1 --show-cursor \
  | sed -n 's/^-- cursor: //p') \
  || fail "failed to capture journal cursor before runner start"
[ -n "$STARTUP_CURSOR" ] \
  || fail "journal cursor missing before runner start"
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

# The runner publishes fresh mode=running only after namespace DNS activation.
# Keep the journal assertion below as independent functional-probe coverage.
if READINESS_OUTPUT=$(sudo "$BIN_DIR/runner" service wait-running \
  --name "$SVC" --timeout-secs "$STARTUP_TIMEOUT_SECS" 2>&1); then
  :
else
  READINESS_STATUS=$?
  report_startup_diagnostics "$READINESS_STATUS" "$READINESS_OUTPUT"
  if printf '%s\n' "$STARTUP_DIAGNOSTIC_LOGS" \
    | grep -E 'namespace DNS readiness probe failed|sandbox runtime DNS readiness' \
      >/dev/null; then
    fail "runner namespace DNS readiness failed during startup"
  fi
  case "$STARTUP_ACTIVE_STATE" in
    active | activating | reloading | refreshing)
      SERVICE_RUNNABLE=true
      ;;
    "")
      SERVICE_RUNNABLE=unknown
      ;;
    *)
      SERVICE_RUNNABLE=false
      ;;
  esac
  if [ "$SERVICE_RUNNABLE" = false ] \
    || printf '%s\n' "$READINESS_OUTPUT" \
      | grep -F "is not active while waiting for running" >/dev/null; then
    fail "runner service became non-runnable before reaching running (activeState=$STARTUP_ACTIVE_STATE)"
  fi
  if [ "$SERVICE_RUNNABLE" = true ] \
    && printf '%s\n' "$READINESS_OUTPUT" \
      | grep -F "timed out waiting ${STARTUP_TIMEOUT_SECS}s" >/dev/null; then
    fail "runner remained active past the ${STARTUP_TIMEOUT_SECS}s readiness deadline"
  fi
  fail "runner readiness check failed before reaching running"
fi

INVOCATION_ID=$(sudo systemctl show "$UNIT" \
  --property=InvocationID --value 2>/dev/null) \
  || fail "failed to read current runner invocation ID"
[ -n "$INVOCATION_ID" ] || fail "current runner invocation ID is empty"
STARTUP_LOGS=$(sudo journalctl --no-pager --lines "$STARTUP_LOG_LINES" \
  "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1) \
  || fail "failed to read current runner startup logs"
if ! printf '%s\n' "$STARTUP_LOGS" \
  | grep -F "namespace DNS readiness probe succeeded" >/dev/null; then
  report_startup_diagnostics 0 \
    "runner reached running but the current invocation lacks the DNS readiness success marker"
  fail "current runner invocation did not log namespace DNS readiness success"
fi

# Inspect the rules while the prewarmed namespace pool is fully idle. Matching
# by this runner's unique proxy and DNS ports avoids parallel CI runners on the
# host, and running before local submit avoids holding a Firecracker VM during
# the source-identity probe.
STATUS_PORTS=$(sudo jq -er '
  [.proxy_port, .dns_port]
  | select(all(.[]; type == "number"))
  | @tsv
' "$RUNNER_DIR/status.json") \
  || fail "proxy or DNS port missing from runner status"
read -r PROXY_PORT DNS_PORT <<< "$STATUS_PORTS"
[ -n "$PROXY_PORT" ] || fail "proxy port missing from runner status"
[ -n "$DNS_PORT" ] || fail "DNS port missing from runner status"

DNS_LISTENERS=$(sudo ss -H -luntp \
  | grep -E ":${DNS_PORT}[[:space:]]" || true)
DNS_LISTENER_COUNT=$(printf '%s\n' "$DNS_LISTENERS" \
  | grep -c . || true)
[ "$DNS_LISTENER_COUNT" -ge 2 ] \
  || fail "expected UDP/TCP dnsmasq wildcard listeners, found $DNS_LISTENER_COUNT"
[ "$DNS_LISTENER_COUNT" -le 4 ] \
  || fail "dnsmasq created per-address listeners: $DNS_LISTENERS"
if printf '%s\n' "$DNS_LISTENERS" \
  | grep -E '10\.200\.|%vm0-ve-' >/dev/null; then
  fail "dnsmasq listener set contains VM interface addresses: $DNS_LISTENERS"
fi

NAT_RULES=$(sudo iptables-save -t nat) || fail "failed to read nat rules"
FILTER_RULES=$(sudo iptables-save -t filter) || fail "failed to read filter rules"
IPV6_FILTER_RULES=$(sudo ip6tables-save -t filter) \
  || fail "failed to read IPv6 filter rules"
RAW_RULES=$(sudo iptables-save -t raw) || fail "failed to read raw rules"

PROXY_RULES=$(printf '%s\n' "$NAT_RULES" \
  | grep -E -- "--to-ports? ${PROXY_PORT}([[:space:]]|$)" || true)
[ -n "$PROXY_RULES" ] || fail "generic TCP proxy rules not found"
if printf '%s\n' "$PROXY_RULES" \
  | grep -Fv -- "-m multiport ! --dports 53,853" >/dev/null; then
  fail "generic TCP proxy rule does not exclude ports 53 and 853"
fi

DNS_TCP_RULES=$(printf '%s\n' "$NAT_RULES" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | grep -F -- "-p tcp" \
  | grep -F -- "--dport 53" || true)
[ -n "$DNS_TCP_RULES" ] || fail "TCP/53 dnsmasq redirect rule not found"

printf '%s\n' "$FILTER_RULES" \
  | grep -E -- "-A FORWARD .* -p tcp .*--dport 53 .* -j DROP" >/dev/null \
  || fail "TCP/53 FORWARD drop rule not found"
printf '%s\n' "$FILTER_RULES" \
  | grep -E -- "-A FORWARD .* -p tcp .*--dport 853 .* -j DROP" >/dev/null \
  || fail "TCP/853 FORWARD drop rule not found"

# Verify that source IP is an identity only after the packet arrives on its
# owning host veth. Then inject one namespace's peer IP through another veth
# and prove the raw guard rejects it before the victim DNS rule can attribute it.
mapfile -t RUNNER_NAMESPACES < <(
  printf '%s\n' "$PROXY_RULES" \
    | rule_values --comment \
    | sort -u
)
RUNNER_NAMESPACE_COUNT=${#RUNNER_NAMESPACES[@]}
[ "$RUNNER_NAMESPACE_COUNT" -ge 2 ] \
  || fail "expected at least two runner namespaces, found $RUNNER_NAMESPACE_COUNT"

ATTACKER_NS=${RUNNER_NAMESPACES[0]}
VICTIM_NS=${RUNNER_NAMESPACES[1]}
for namespace in "$ATTACKER_NS" "$VICTIM_NS"; do
  NAMESPACE_PIDS=$(sudo ip netns pids "$namespace") \
    || fail "failed to inspect namespace processes: $namespace"
  [ -z "$NAMESPACE_PIDS" ] \
    || fail "pre-submit namespace unexpectedly active: $namespace"
done
RUNNER_POOL_PREFIX="${ATTACKER_NS%-*}-"
RUNNER_VETH_PREFIX=${RUNNER_POOL_PREFIX/vm0-ns-/vm0-ve-}
ATTACKER_IF=${ATTACKER_NS/vm0-ns-/vm0-ve-}
VICTIM_IF=${VICTIM_NS/vm0-ns-/vm0-ve-}

ATTACKER_PROXY_RULE=$(printf '%s\n' "$PROXY_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | head -n 1 || true)
VICTIM_PROXY_RULE=$(printf '%s\n' "$PROXY_RULES" \
  | grep -F -- "$VICTIM_NS" \
  | head -n 1 || true)
[ -n "$ATTACKER_PROXY_RULE" ] || fail "attacker proxy rule not found"
[ -n "$VICTIM_PROXY_RULE" ] || fail "victim proxy rule not found"

ATTACKER_CIDR=$(rule_value "$ATTACKER_PROXY_RULE" -s)
VICTIM_CIDR=$(rule_value "$VICTIM_PROXY_RULE" -s)
[ "${ATTACKER_CIDR#*/}" = 32 ] \
  || fail "attacker proxy source is not an exact /32: $ATTACKER_CIDR"
[ "${VICTIM_CIDR#*/}" = 32 ] \
  || fail "victim proxy source is not an exact /32: $VICTIM_CIDR"
[ "$(rule_value "$ATTACKER_PROXY_RULE" -i)" = "$ATTACKER_IF" ] \
  || fail "attacker proxy rule is not bound to $ATTACKER_IF"
[ "$(rule_value "$VICTIM_PROXY_RULE" -i)" = "$VICTIM_IF" ] \
  || fail "victim proxy rule is not bound to $VICTIM_IF"
ATTACKER_PEER=${ATTACKER_CIDR%/32}
VICTIM_PEER=${VICTIM_CIDR%/32}

ATTACKER_GUARD_RULE=$(printf '%s\n' "$RAW_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A PREROUTING" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
VICTIM_GUARD_RULE=$(printf '%s\n' "$RAW_RULES" \
  | grep -F -- "$VICTIM_NS" \
  | grep -F -- "-A PREROUTING" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
[ -n "$ATTACKER_GUARD_RULE" ] || fail "attacker source guard not found"
[ -n "$VICTIM_GUARD_RULE" ] || fail "victim source guard not found"
[ "$(rule_value "$ATTACKER_GUARD_RULE" -i)" = "$ATTACKER_IF" ] \
  || fail "attacker source guard is not bound to $ATTACKER_IF"
[ "$(rule_value "$VICTIM_GUARD_RULE" -i)" = "$VICTIM_IF" ] \
  || fail "victim source guard is not bound to $VICTIM_IF"
printf '%s\n' "$ATTACKER_GUARD_RULE" \
  | grep -F -- "! -s ${ATTACKER_CIDR}" >/dev/null \
  || fail "attacker source guard does not reject non-peer sources"
printf '%s\n' "$VICTIM_GUARD_RULE" \
  | grep -F -- "! -s ${VICTIM_CIDR}" >/dev/null \
  || fail "victim source guard does not reject non-peer sources"

ATTACKER_MASQUERADE_RULE=$(printf '%s\n' "$NAT_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A POSTROUTING" \
  | grep -F -- "-j MASQUERADE" \
  | head -n 1 || true)
[ "$(rule_value "$ATTACKER_MASQUERADE_RULE" -s)" = "$ATTACKER_CIDR" ] \
  || fail "host masquerade rule does not use the exact attacker peer"

ATTACKER_OUTBOUND_RULE=$(printf '%s\n' "$FILTER_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A FORWARD" \
  | grep -F -- "-i ${ATTACKER_IF}" \
  | grep -F -- "-j ACCEPT" \
  | head -n 1 || true)
[ "$(rule_value "$ATTACKER_OUTBOUND_RULE" -s)" = "$ATTACKER_CIDR" ] \
  || fail "outbound forwarding rule does not use the exact attacker peer"

ATTACKER_RETURN_RULE=$(printf '%s\n' "$FILTER_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A FORWARD" \
  | grep -F -- "-o ${ATTACKER_IF}" \
  | grep -F -- "-j ACCEPT" \
  | head -n 1 || true)
[ "$(rule_value "$ATTACKER_RETURN_RULE" -d)" = "$ATTACKER_CIDR" ] \
  || fail "return forwarding rule does not use the exact attacker peer"

ATTACKER_LOG_RULE=$(printf '%s\n' "$FILTER_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "VM0:${ATTACKER_PEER}:" \
  | grep -F -- "-j LOG" \
  | head -n 1 || true)
[ "$(rule_value "$ATTACKER_LOG_RULE" -i)" = "$ATTACKER_IF" ] \
  || fail "non-TCP log rule is not bound to $ATTACKER_IF"
[ "$(rule_value "$ATTACKER_LOG_RULE" -s)" = "$ATTACKER_CIDR" ] \
  || fail "non-TCP log rule does not use the exact attacker peer"

ATTACKER_DNS_DROP_RULE=$(printf '%s\n' "$FILTER_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
[ "$(rule_value "$ATTACKER_DNS_DROP_RULE" -i)" = "$ATTACKER_IF" ] \
  || fail "DNS drop rule is not bound to $ATTACKER_IF"
[ "$(rule_value "$ATTACKER_DNS_DROP_RULE" -s)" = "$ATTACKER_CIDR" ] \
  || fail "DNS drop rule does not use the exact attacker peer"

ATTACKER_DNS_RULE=$(printf '%s\n' "$NAT_RULES" \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | head -n 1 || true)
[ -n "$ATTACKER_DNS_RULE" ] || fail "attacker DNS redirect not found"
[ "$(rule_value "$ATTACKER_DNS_RULE" -i)" = "$ATTACKER_IF" ] \
  || fail "attacker DNS redirect is not bound to $ATTACKER_IF"
[ "$(rule_value "$ATTACKER_DNS_RULE" -s)" = "$ATTACKER_CIDR" ] \
  || fail "attacker DNS redirect does not use the exact peer"

VICTIM_DNS_RULE=$(printf '%s\n' "$NAT_RULES" \
  | grep -F -- "$VICTIM_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | head -n 1 || true)
[ -n "$VICTIM_DNS_RULE" ] || fail "victim DNS redirect not found"
[ "$(rule_value "$VICTIM_DNS_RULE" -i)" = "$VICTIM_IF" ] \
  || fail "victim DNS redirect is not bound to $VICTIM_IF"
[ "$(rule_value "$VICTIM_DNS_RULE" -s)" = "$VICTIM_CIDR" ] \
  || fail "victim DNS redirect does not use the exact peer"

ATTACKER_GUARD_COUNTED=$(sudo iptables-save -c -t raw \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A PREROUTING" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
ATTACKER_GUARD_BEFORE=$(rule_packet_count "$ATTACKER_GUARD_COUNTED")
[ -n "$ATTACKER_GUARD_BEFORE" ] || fail "source guard counter missing"

ATTACKER_DNS_COUNTED=$(sudo iptables-save -c -t nat \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | head -n 1 || true)
ATTACKER_DNS_BEFORE=$(rule_packet_count "$ATTACKER_DNS_COUNTED")
[ -n "$ATTACKER_DNS_BEFORE" ] || fail "attacker DNS redirect counter missing"

ATTACKER_NS_LINK_BEFORE=$(sudo ip -n "$ATTACKER_NS" -j \
  link show dev veth0)
ATTACKER_ROOT_LINK_BEFORE=$(sudo ip -j link show dev "$ATTACKER_IF")
IFS=$'\t' read -r \
  ATTACKER_NS_IFINDEX_BEFORE ATTACKER_NS_LINK_INDEX_BEFORE \
  <<< "$(printf '%s\n' "$ATTACKER_NS_LINK_BEFORE" \
    | link_identity_fields veth0)"
IFS=$'\t' read -r \
  ATTACKER_ROOT_IFINDEX_BEFORE ATTACKER_ROOT_LINK_INDEX_BEFORE \
  <<< "$(printf '%s\n' "$ATTACKER_ROOT_LINK_BEFORE" \
    | link_identity_fields "$ATTACKER_IF")"
[ "$ATTACKER_NS_IFINDEX_BEFORE" -eq "$ATTACKER_ROOT_LINK_INDEX_BEFORE" ] \
  && [ "$ATTACKER_NS_LINK_INDEX_BEFORE" -eq "$ATTACKER_ROOT_IFINDEX_BEFORE" ] \
  || fail "attacker veth peers do not have reciprocal identities"

send_udp_dns_query \
  "$ATTACKER_NS" "$ATTACKER_PEER" "$BEHAVIOR_DNS_DESTINATION"

ATTACKER_DNS_AFTER=""
for _ in $(seq 1 20); do
  ATTACKER_DNS_COUNTED=$(sudo iptables-save -c -t nat \
    | grep -F -- "$ATTACKER_NS" \
    | grep -F -- "-p udp" \
    | grep -F -- "--dport 53" \
    | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
    | head -n 1 || true)
  ATTACKER_DNS_AFTER=$(rule_packet_count "$ATTACKER_DNS_COUNTED")
  if [ -n "$ATTACKER_DNS_AFTER" ] \
    && [ "$ATTACKER_DNS_AFTER" -gt "$ATTACKER_DNS_BEFORE" ]; then
    break
  fi
  sleep 0.05
done

ATTACKER_GUARD_COUNTED=$(sudo iptables-save -c -t raw \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A PREROUTING" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
ATTACKER_GUARD_AFTER_CONTROL=$(rule_packet_count "$ATTACKER_GUARD_COUNTED")

ATTACKER_NS_LINK_AFTER=$(sudo ip -n "$ATTACKER_NS" -j \
  link show dev veth0)
ATTACKER_ROOT_LINK_AFTER=$(sudo ip -j link show dev "$ATTACKER_IF")
IFS=$'\t' read -r \
  ATTACKER_NS_IFINDEX_AFTER ATTACKER_NS_LINK_INDEX_AFTER \
  <<< "$(printf '%s\n' "$ATTACKER_NS_LINK_AFTER" \
    | link_identity_fields veth0)"
IFS=$'\t' read -r \
  ATTACKER_ROOT_IFINDEX_AFTER ATTACKER_ROOT_LINK_INDEX_AFTER \
  <<< "$(printf '%s\n' "$ATTACKER_ROOT_LINK_AFTER" \
    | link_identity_fields "$ATTACKER_IF")"
[ "$ATTACKER_NS_IFINDEX_AFTER" -eq "$ATTACKER_NS_IFINDEX_BEFORE" ] \
  && [ "$ATTACKER_NS_LINK_INDEX_AFTER" -eq "$ATTACKER_NS_LINK_INDEX_BEFORE" ] \
  && [ "$ATTACKER_ROOT_IFINDEX_AFTER" -eq "$ATTACKER_ROOT_IFINDEX_BEFORE" ] \
  && [ "$ATTACKER_ROOT_LINK_INDEX_AFTER" -eq "$ATTACKER_ROOT_LINK_INDEX_BEFORE" ] \
  || fail "attacker veth identity changed during the control query"
[ "$ATTACKER_NS_IFINDEX_AFTER" -eq "$ATTACKER_ROOT_LINK_INDEX_AFTER" ] \
  && [ "$ATTACKER_NS_LINK_INDEX_AFTER" -eq "$ATTACKER_ROOT_IFINDEX_AFTER" ] \
  || fail "attacker veth peers lost reciprocal identities"

[ -n "$ATTACKER_GUARD_AFTER_CONTROL" ] \
  || fail "source guard counter missing after control query"
[ "$ATTACKER_GUARD_AFTER_CONTROL" -eq "$ATTACKER_GUARD_BEFORE" ] \
  || fail "source guard rejected the namespace's assigned peer"
[ -n "$ATTACKER_DNS_AFTER" ] \
  || fail "attacker DNS redirect counter missing after control query"
[ "$ATTACKER_DNS_AFTER" -gt "$ATTACKER_DNS_BEFORE" ] \
  || fail "control query did not reach the attacker DNS redirect: before=$ATTACKER_DNS_BEFORE after=$ATTACKER_DNS_AFTER"

VICTIM_DNS_COUNTED=$(sudo iptables-save -c -t nat \
  | grep -F -- "$VICTIM_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | head -n 1 || true)
VICTIM_DNS_BEFORE=$(rule_packet_count "$VICTIM_DNS_COUNTED")
[ -n "$VICTIM_DNS_BEFORE" ] || fail "victim DNS redirect counter missing"

SPOOF_NS=$ATTACKER_NS
SPOOF_IP=$VICTIM_PEER
sudo ip -n "$SPOOF_NS" address add "${SPOOF_IP}/32" dev veth0 \
  || fail "failed to add forged victim source to attacker namespace"
send_udp_dns_query \
  "$SPOOF_NS" "$SPOOF_IP" "$BEHAVIOR_DNS_DESTINATION"

ATTACKER_GUARD_COUNTED=$(sudo iptables-save -c -t raw \
  | grep -F -- "$ATTACKER_NS" \
  | grep -F -- "-A PREROUTING" \
  | grep -F -- "-j DROP" \
  | head -n 1 || true)
ATTACKER_GUARD_AFTER_SPOOF=$(rule_packet_count "$ATTACKER_GUARD_COUNTED")
VICTIM_DNS_COUNTED=$(sudo iptables-save -c -t nat \
  | grep -F -- "$VICTIM_NS" \
  | grep -F -- "-p udp" \
  | grep -F -- "--dport 53" \
  | grep -E -- "--to-ports? ${DNS_PORT}([[:space:]]|$)" \
  | head -n 1 || true)
VICTIM_DNS_AFTER=$(rule_packet_count "$VICTIM_DNS_COUNTED")
cleanup_spoof_address

[ -n "$ATTACKER_GUARD_AFTER_SPOOF" ] \
  || fail "source guard counter missing after forged query"
[ -n "$VICTIM_DNS_AFTER" ] \
  || fail "victim DNS redirect counter missing after forged query"
[ "$ATTACKER_GUARD_AFTER_SPOOF" -gt "$ATTACKER_GUARD_AFTER_CONTROL" ] \
  || fail "source guard did not reject the forged victim source"
[ "$VICTIM_DNS_AFTER" -eq "$VICTIM_DNS_BEFORE" ] \
  || fail "forged source reached the victim DNS attribution rule"
echo "PASS: source identity guard"

DNS_FILTER_COMMENT=$(printf '%s\n' "$FILTER_RULES" \
  | grep -E -- "-A INPUT .*--dport ${DNS_PORT} .*--comment vm0-ns-[0-9a-f]{2}-dns.*-j REJECT" \
  | sed -nE 's/.*--comment "?([^ " ]+)"?.*/\1/p' \
  | head -n 1)
[ -n "$DNS_FILTER_COMMENT" ] || fail "DNS INPUT filter comment missing"
DNS_FILTER_POOL=${DNS_FILTER_COMMENT#vm0-ns-}
DNS_FILTER_POOL=${DNS_FILTER_POOL%-dns}
[ "$RUNNER_POOL_PREFIX" = "vm0-ns-${DNS_FILTER_POOL}-" ] \
  || fail "DNS filter and namespace pool identities differ"
RUNNER_POOL_INDEX=$((16#$DNS_FILTER_POOL))
DNS_FILTER_INTERFACE="vm0-ve-${DNS_FILTER_POOL}-+"

assert_dns_input_filter_family() {
  local family=$1 rules=$2 comment_rules targetless reject protocol
  comment_rules=$(printf '%s\n' "$rules" \
    | grep -F -- "--comment ${DNS_FILTER_COMMENT}" || true)
  [ "$(printf '%s\n' "$comment_rules" | grep -c . || true)" -eq 4 ] \
    || fail "$family DNS INPUT filter expected four rules: $comment_rules"
  [ "$(printf '%s\n' "$comment_rules" \
    | grep -F -c -- "--dport ${DNS_PORT}" || true)" -eq 4 ] \
    || fail "$family DNS INPUT filter does not consistently use port ${DNS_PORT}"
  targetless=$(printf '%s\n' "$comment_rules" | grep -Fv -- " -j " || true)
  reject=$(printf '%s\n' "$comment_rules" | grep -F -- "-j REJECT" || true)
  [ "$(printf '%s\n' "$targetless" | grep -c . || true)" -eq 2 ] \
    || fail "$family DNS INPUT filter expected two targetless rules: $comment_rules"
  [ "$(printf '%s\n' "$reject" | grep -c . || true)" -eq 2 ] \
    || fail "$family DNS INPUT filter expected two REJECT rules: $comment_rules"
  if printf '%s\n' "$targetless" | grep -F -- "! -i" >/dev/null; then
    fail "$family targetless DNS INPUT rule inverted its interface: $targetless"
  fi
  [ "$(printf '%s\n' "$targetless" \
    | grep -F -c -- "-i ${DNS_FILTER_INTERFACE}" || true)" -eq 2 ] \
    || fail "$family targetless DNS INPUT rules do not all match ${DNS_FILTER_INTERFACE}"
  [ "$(printf '%s\n' "$reject" \
    | grep -F -c -- "! -i ${DNS_FILTER_INTERFACE}" || true)" -eq 2 ] \
    || fail "$family DNS INPUT REJECT rules do not all invert ${DNS_FILTER_INTERFACE}"
  for protocol in udp tcp; do
    [ "$(printf '%s\n' "$targetless" | grep -F -c -- "-p ${protocol}" || true)" -eq 1 ] \
      || fail "$family targetless DNS INPUT ${protocol} rule missing or duplicated"
    [ "$(printf '%s\n' "$reject" | grep -F -c -- "-p ${protocol}" || true)" -eq 1 ] \
      || fail "$family DNS INPUT ${protocol} REJECT rule missing or duplicated"
  done
}

assert_dns_input_filter_family IPv4 "$FILTER_RULES"
assert_dns_input_filter_family IPv6 "$IPV6_FILTER_RULES"

DNS_INPUT_UDP_RULE=$(sudo iptables-save -c -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" \
  | grep -F -- "-i ${DNS_FILTER_INTERFACE}" \
  | grep -F -- "-p udp" \
  | grep -Fv -- " -j " \
  | head -n 1 || true)
DNS_INPUT_TCP_RULE=$(sudo iptables-save -c -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" \
  | grep -F -- "-i ${DNS_FILTER_INTERFACE}" \
  | grep -F -- "-p tcp" \
  | grep -Fv -- " -j " \
  | head -n 1 || true)
DNS_INPUT_UDP_BEFORE=$(rule_packet_count "$DNS_INPUT_UDP_RULE")
DNS_INPUT_TCP_BEFORE=$(rule_packet_count "$DNS_INPUT_TCP_RULE")
[ -n "$DNS_INPUT_UDP_BEFORE" ] || fail "IPv4 UDP DNS INPUT counter missing"
[ -n "$DNS_INPUT_TCP_BEFORE" ] || fail "IPv4 TCP DNS INPUT counter missing"

# Submit a long-running job in background (keeps sandbox alive during tests)
echo "--- Submitting long-running job ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" --prompt 'sleep 120 && echo done' &
SUBMIT_PID=$!

# Wait for OUR runner's sandbox to have a control socket.
# Read the sandbox_id from our runner's status.json (not from
# /run/vm0/sock/) to avoid matching sandboxes from parallel CI
# jobs (benchmark, upgrade). `runner exec` / socket paths are
# keyed by sandbox_id (#9552), which differs from run_id.
echo "--- Waiting for sandbox control socket ---"
for i in $(seq 1 60); do
  SANDBOX_ID=$(sudo jq -r '.active_runs[0].sandbox_id // empty' \
    "$RUNNER_DIR/status.json" 2>/dev/null)
  [ -n "$SANDBOX_ID" ] && [ -S "/run/vm0/sock/$SANDBOX_ID/control.sock" ] && break
  SANDBOX_ID=""
  sleep 1
done
[ -z "$SANDBOX_ID" ] && fail "control socket not found after 60s"
echo "Found sandbox: $SANDBOX_ID"

# Test 1: privilege boundary
echo "--- Test: privilege boundary ---"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- id -u) || \
  fail "ordinary exec failed"
[ "$OUTPUT" = "1000" ] || fail "ordinary exec expected UID 1000, got: $OUTPUT"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" --sudo -- id -u) || \
  fail "privileged exec failed"
[ "$OUTPUT" = "0" ] || fail "privileged exec expected UID 0, got: $OUTPUT"
echo "PASS: privilege boundary"

# Test 2: basic exec
echo "--- Test: basic exec ---"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo hello-from-exec)
echo "$OUTPUT" | grep -q "hello-from-exec" || fail "expected 'hello-from-exec', got: $OUTPUT"
echo "PASS: basic exec"

# Test 3: one-shot exec owns detached descendants, including through the
# production non-sudo `su` boundary. The long-running job above can own another
# valid leaf concurrently, so record and verify this exec's exact leaf.
echo "--- Test: one-shot process containment ---"
ONE_SHOT_COMMAND=$(cat <<'SCRIPT'
set -eu
identity=/tmp/vm0-one-shot-containment.identity
group_file=/tmp/vm0-one-shot-containment.group
rm -f "$identity" "$group_file"
relative=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
own_group=${relative##*/}
case "$own_group" in
  exec-*) ;;
  *) echo "unexpected one-shot cgroup: $relative" >&2; exit 1 ;;
esac
printf '%s\n' "$own_group" > "$group_file"
setsid python3 -c 'import os, pathlib, signal, time; p=pathlib.Path("/tmp/vm0-one-shot-containment.identity"); fields=pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split(); signal.signal(signal.SIGTERM, signal.SIG_IGN); p.write_text(f"{os.getpid()} {fields[19]}\n"); time.sleep(300)' </dev/null >/dev/null 2>&1 &
for _ in $(seq 1 100); do
  [ -s "$identity" ] && break
  sleep 0.01
done
test -s "$identity"
SCRIPT
)
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c "$ONE_SHOT_COMMAND" \
  || fail "one-shot descendant setup failed"
VERIFY_ONE_SHOT_COMMAND=$(cat <<'SCRIPT'
set -eu
identity=/tmp/vm0-one-shot-containment.identity
group_file=/tmp/vm0-one-shot-containment.group
read -r pid start_time < "$identity"
if current_identity=$(awk '{sub(/^.*\) /, ""); print $1, $20}' "/proc/$pid/stat" 2>/dev/null); then
  current_state=${current_identity%% *}
  current_start=${current_identity#* }
  case "$current_state" in
    Z|X|x) ;;
    *)
      [ "$current_start" != "$start_time" ] || {
        echo "one-shot descendant is still running: pid=$pid" >&2
        exit 1
      }
      ;;
  esac
fi
base=/sys/fs/cgroup/vm0-exec
relative=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
own_group=${relative##*/}
test -n "$own_group"
test -d "$base/$own_group"
old_group=$(cat "$group_file")
case "$old_group" in
  exec-*) ;;
  *) echo "unexpected recorded one-shot cgroup: $old_group" >&2; exit 1 ;;
esac
[ "$old_group" != "$own_group" ] || {
  echo "one-shot cgroup was reused: $old_group" >&2
  exit 1
}
[ ! -e "$base/$old_group" ] || {
  echo "one-shot cgroup leaf survived cleanup: $old_group" >&2
  exit 1
}
SCRIPT
)
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c "$VERIFY_ONE_SHOT_COMMAND" \
  || fail "one-shot descendant or cgroup leaf survived cleanup"
echo "PASS: one-shot process containment"

# Test 4: exit code propagation
echo "--- Test: exit code propagation ---"
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- false && fail "expected non-zero exit"
echo "PASS: exit code propagation"

# Test 5: prefix matching
echo "--- Test: prefix matching ---"
PREFIX=$(echo "$SANDBOX_ID" | cut -c1-8)
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$PREFIX" -- hostname)
[ -n "$OUTPUT" ] || fail "prefix match returned empty output"
echo "PASS: prefix matching"

# Test 6: argv boundary preservation — regression guard for #9019.
# NOTE: each assertion relies on the surrounding bash (this
# heredoc, running on the metal runner) to tokenise quoted
# arguments and pass them to runner as separate argv entries.
# For example `echo "hello world"` reaches runner as
# ["echo", "hello world"] (two tokens); runner then shell-quotes
# each before sending to the guest sh.
echo "--- Test: argv boundary preservation ---"
# Space in an argument is preserved as one token
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo "hello world")
[ "$OUTPUT" = "hello world" ] || fail "space in arg: got '$OUTPUT'"
# Single quote in an argument is escaped correctly
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo "it's working")
[ "$OUTPUT" = "it's working" ] || fail "single quote in arg: got '$OUTPUT'"
# Shell metachars must NOT be expanded by the guest shell
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo '$HOME')
[ "$OUTPUT" = '$HOME' ] || fail "variable expanded: got '$OUTPUT'"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo '*.nonexistent')
[ "$OUTPUT" = '*.nonexistent' ] || fail "glob expanded: got '$OUTPUT'"
# Backtick command substitution must NOT be executed (injection guard)
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo '`date`')
[ "$OUTPUT" = '`date`' ] || fail "backtick expanded: got '$OUTPUT'"
# Double quote inside an argument survives the round-trip
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo 'say "hi"')
[ "$OUTPUT" = 'say "hi"' ] || fail "double quote in arg: got '$OUTPUT'"
# Non-ASCII UTF-8 in an argument
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- echo "你好")
[ "$OUTPUT" = "你好" ] || fail "utf-8 arg: got '$OUTPUT'"
# Explicit shell: pipes and redirects work through `sh -c`
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c 'printf abc | wc -c')
[ "$(echo "$OUTPUT" | tr -d ' ')" = '3' ] || fail "sh -c pipe: got '$OUTPUT'"
# env VAR=val PROG: env (not shell) sets the variable for PROG
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- env FOO=bar printenv FOO)
[ "$OUTPUT" = 'bar' ] || fail "env VAR=val: got '$OUTPUT'"
# Path containing a space — the original issue case
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c 'echo content > "/tmp/spaced file.txt"'
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- cat "/tmp/spaced file.txt")
[ "$OUTPUT" = 'content' ] || fail "space in path: got '$OUTPUT'"
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- rm "/tmp/spaced file.txt"
# --sudo flag must not bypass argv quoting
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" --sudo -- echo "root with space")
[ "$OUTPUT" = "root with space" ] || fail "--sudo quoting: got '$OUTPUT'"
echo "PASS: argv boundary preservation"

# Test 7: verify pre-installed language runtimes and databases
echo "--- Test: runtime availability ---"
for cmd in \
  "node --version" \
  "npm --version" \
  "python3 --version" \
  "pip3 --version" \
  "ruby --version" \
  "bundler --version" \
  "php --version" \
  "composer --version" \
  "javac -version" \
  "mvn --version" \
  "gradle --version" \
  "go version" \
  "rustc --version" \
  "cargo --version" \
  "gcc --version" \
  "g++ --version" \
  "clang --version" \
  "make --version" \
  "cmake --version" \
  "psql --version" \
  "redis-server --version"; do
  OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- $cmd 2>&1) \
    || fail "command failed: $cmd"
  echo "  $cmd -> $(echo "$OUTPUT" | head -1)"
done
# Verify PostgreSQL can actually start (not just psql --version).
# Test with TCP on localhost — users will connect via localhost:5432.
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c '
  set -e
  pg_bin=$(
    for initdb in /usr/lib/postgresql/*/bin/initdb; do
      [ -x "$initdb" ] && printf "%s\n" "${initdb%/initdb}"
    done | sort -V | tail -n 1
  )
  if [ -z "$pg_bin" ]; then
    echo "initdb not found under /usr/lib/postgresql/*/bin" >&2
    ls -la /usr/lib/postgresql /usr/lib/postgresql/* /usr/lib/postgresql/*/bin 2>&1 || true
    exit 1
  fi
  rm -rf /tmp/pgdata
  mkdir -p /tmp/pgdata
  "$pg_bin/initdb" -D /tmp/pgdata -A trust
  pg_started=0
  stop_pg() {
    if [ "$pg_started" = "1" ]; then
      "$pg_bin/pg_ctl" -D /tmp/pgdata -m fast stop >/dev/null 2>&1 || true
    fi
  }
  trap stop_pg EXIT
  pg_started=1
  "$pg_bin/pg_ctl" -D /tmp/pgdata -l /tmp/pgdata/log -o "-c listen_addresses=localhost" -w -t 30 start
  pg_isready -h localhost
  [ "$(psql -h localhost -d postgres -Atc "select 1")" = "1" ]
  psql -h localhost -d postgres -v ON_ERROR_STOP=1 -c "CREATE EXTENSION vector"
  "$pg_bin/pg_ctl" -D /tmp/pgdata stop
  pg_started=0
' \
  || { sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- cat /tmp/pgdata/log 2>&1 || true; fail "PostgreSQL/pgvector smoke test"; }
echo "  PostgreSQL/pgvector smoke test: ok"
echo "PASS: runtime availability"

# Test 8: verify the installed Claude accepts and appends to a native compact
# generation without changing its session ID. The loopback terminator prevents
# any external model request.
echo "--- Test: Claude compact-generation compatibility ---"
CLAUDE_COMPACT_SMOKE=$(cat <<'PY'
import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
boundary_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
summary_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
requests = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        self.rfile.read(length)
        requests.append(self.path)
        body = json.dumps(
            {
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "message": "loopback compatibility probe",
                },
            }
        ).encode()
        self.send_response(400)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        pass


with tempfile.TemporaryDirectory(prefix="claude-compact-smoke-") as root:
    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        port = server.server_port
        env = os.environ.copy()
        env.update(
            {
                "HOME": root,
                "CLAUDE_CONFIG_DIR": f"{root}/.claude",
                "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}",
                "ANTHROPIC_API_KEY": "test-token",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "DISABLE_AUTOUPDATER": "1",
                "NO_PROXY": "127.0.0.1,localhost",
                "no_proxy": "127.0.0.1,localhost",
            }
        )

        def run_claude(*args):
            return subprocess.run(
                [
                    "/usr/local/bin/claude",
                    *args,
                    "--output-format",
                    "stream-json",
                    "--verbose",
                ],
                cwd="/home/user/workspace",
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )

        # Let Claude create its isolated config metadata, then replace only the
        # session JSONL with the compact generation under test.
        run_claude(
            "--session-id",
            session_id,
            "--print",
            "seed compatibility metadata",
        )
        project_dir = Path(root) / ".claude/projects/-home-user-workspace"
        history_file = project_dir / f"{session_id}.jsonl"
        assert history_file.is_file(), (
            "Claude metadata seed did not create session history"
        )
        version = subprocess.check_output(
            ["/usr/local/bin/claude", "--version"],
            text=True,
        ).split()[0]
        records = [
            {
                "parentUuid": None,
                "isSidechain": False,
                "userType": "external",
                "cwd": "/home/user/workspace",
                "sessionId": session_id,
                "version": version,
                "gitBranch": "",
                "type": "system",
                "subtype": "compact_boundary",
                "content": "Conversation compacted",
                "isMeta": False,
                "uuid": boundary_id,
                "timestamp": "2026-01-01T00:00:00.000Z",
                "logicalParentUuid": (
                    "11111111-1111-4111-8111-111111111111"
                ),
                "compactMetadata": {"trigger": "auto", "preTokens": 100},
            },
            {
                "parentUuid": boundary_id,
                "isSidechain": False,
                "userType": "external",
                "cwd": "/home/user/workspace",
                "sessionId": session_id,
                "version": version,
                "gitBranch": "",
                "type": "user",
                "message": {
                    "role": "user",
                    "content": "Synthetic compacted conversation summary.",
                },
                "isMeta": False,
                "uuid": summary_id,
                "timestamp": "2026-01-01T00:00:00.001Z",
                "isCompactSummary": True,
            },
        ]
        history_file.write_text(
            "".join(
                json.dumps(record, separators=(",", ":")) + "\n"
                for record in records
            )
        )

        requests.clear()
        resumed = run_claude(
            "--resume",
            session_id,
            "--print",
            "append compatibility turn",
        )
        output = resumed.stdout + resumed.stderr
        assert "No conversation found with session ID" not in output, output
        assert any(
            path.startswith("/v1/messages") for path in requests
        ), f"Claude did not reach messages endpoint:\n{output}"

        retained = [
            json.loads(line)
            for line in history_file.read_text().splitlines()
        ]
        appended = retained[2:]
        assert appended, "Claude did not append to the compact generation"
        assert any(
            record.get("sessionId") == session_id
            for record in appended
        ), "Claude appended no record for the resumed session"
        assert all(
            record.get("sessionId", session_id) == session_id
            for record in retained
        ), "Claude changed the session ID while appending"

        server.shutdown()
        server_thread.join()
PY
)
sudo "$BIN_DIR/runner" exec --timeout 75 \
  --sandbox "$SANDBOX_ID" -- python3 -c "$CLAUDE_COMPACT_SMOKE" \
  || fail "Claude compact-generation compatibility"
echo "PASS: Claude compact-generation compatibility"

# Test 9: verify /etc/environment is loaded for both user and root
# [sync:etc-environment] Keep in sync with: crates/runner/scripts/customize-rootfs.sh
echo "--- Test: environment variables ---"
EXPECTED_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
declare -A EXPECTED_ENV=(
  [LANG]="C.UTF-8"
  [NPM_CONFIG_UPDATE_NOTIFIER]="false"
  [NODE_EXTRA_CA_CERTS]="/usr/local/share/ca-certificates/vm0-proxy-ca.crt"
  [SSL_CERT_FILE]="/etc/ssl/certs/ca-certificates.crt"
  [REQUESTS_CA_BUNDLE]="/etc/ssl/certs/ca-certificates.crt"
  [CARGO_HTTP_CAINFO]="/etc/ssl/certs/ca-certificates.crt"
)
check_env() {
  local label=$1 sudo_flag=$2
  for var in "${!EXPECTED_ENV[@]}"; do
    val=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" $sudo_flag -- printenv "$var") \
      || fail "$label: $var not set"
    [ "$val" = "${EXPECTED_ENV[$var]}" ] \
      || fail "$label: $var='$val', expected '${EXPECTED_ENV[$var]}'"
    echo "  $label $var=$val"
  done
  val=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" $sudo_flag -- printenv PATH) \
    || fail "$label: PATH not set"
  echo "$val" | grep -qF "$EXPECTED_PATH" \
    || fail "$label: PATH missing '$EXPECTED_PATH' in: $val"
  echo "  $label PATH=$val"
}
check_env "user" ""
check_env "root" "--sudo"
echo "PASS: environment variables"

# Test 10: verify HTTPS works through proxy for each runtime
# All traffic goes through mitmproxy, so TLS must trust the proxy CA.
echo "--- Test: HTTPS through proxy ---"
TLS_URL="https://www.google.com"
tls_check() {
  local label=$1 cmd=$2 t=${3:-15}
  local output status

  # Let the guest timeout finish its TERM/KILL cycle and return stderr before
  # runner exec's timeout can replace the result with a synthetic Timeout.
  if output=$(sudo "$BIN_DIR/runner" exec --timeout "$((t + 10))" \
    --sandbox "$SANDBOX_ID" -- sh -c "timeout --kill-after=5s $t $cmd" 2>&1); then
    echo "  HTTPS $label: ok"
  else
    status=$?
    fail "HTTPS $label failed with exit code $status: ${output:-no output}"
  fi
}
tls_check "curl"      "curl -sf --max-time 10 $TLS_URL"
tls_check "wget"      "wget -qO /dev/null --timeout=10 $TLS_URL"
tls_check "git"       "git ls-remote --exit-code https://github.com/anthropics/anthropic-sdk-python.git HEAD"
tls_check "python"    "python3 -c \"import urllib.request; urllib.request.urlopen('$TLS_URL')\""
tls_check "node"      "node -e \"require('https').get('$TLS_URL',r=>{r.resume();r.on('end',()=>process.exit(0))}).on('error',e=>{console.error(e);process.exit(1)})\""
tls_check "ruby"      "ruby -e \"require 'net/http'; Net::HTTP.get(URI('$TLS_URL'))\""
tls_check "php"       "php -r \"file_get_contents('$TLS_URL');\""
tls_check "cargo"     "env CARGO_HOME=/tmp/cargo-test cargo search --limit 1 serde" 30
tls_check "chromium"  "chromium --headless --disable-gpu --no-sandbox --dump-dom $TLS_URL >/dev/null" 30

# Java and Go need multi-line scripts — write temp files then run
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c "printf '%s\n' 'import java.net.*;import java.net.http.*;' 'var c=HttpClient.newHttpClient();' 'var r=HttpRequest.newBuilder(URI.create(\"$TLS_URL\")).build();' 'c.send(r,HttpResponse.BodyHandlers.discarding());' '/exit' | timeout 30 jshell -" \
  || fail "HTTPS java"
echo "  HTTPS java: ok"

sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c "cd /tmp && printf '%s\n' 'package main' 'import (' '\"net/http\"' '\"os\"' ')' 'func main(){r,e:=http.Get(os.Args[1]);if e!=nil{panic(e)};r.Body.Close()}' > tls.go && timeout 30 go run tls.go $TLS_URL" \
  || fail "HTTPS go"
echo "  HTTPS go: ok"
echo "PASS: HTTPS through proxy"

# Test 11: verify DNS resolution works inside sandbox
# Uses getent (libc-bin, always available) instead of nslookup (requires dnsutils).
echo "--- Test: DNS resolution ---"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- getent hosts localhost 2>&1) \
  || fail "localhost resolution failed: $OUTPUT"
echo "  localhost: $OUTPUT"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- getent hosts github.com 2>&1) \
  || fail "user DNS resolution failed: $OUTPUT"
echo "  user: $OUTPUT"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" --sudo -- getent hosts example.com 2>&1) \
  || fail "root DNS resolution failed: $OUTPUT"
echo "  root: $OUTPUT"

# Force DNS over TCP to a TEST-NET destination with no resolver. A
# valid response proves PREROUTING redirected the connection to the
# runner-managed dnsmasq instead of mitmproxy raw TCP passthrough.
TCP_DNS_SCRIPT="import socket,struct; q=bytes.fromhex('123401000001000000000000077463702d646e7307696e76616c69640000010001'); s=socket.create_connection(('192.0.2.1',53),5); s.sendall(struct.pack('!H',len(q))+q); f=s.makefile('rb'); h=f.read(2); assert len(h)==2; n=struct.unpack('!H',h)[0]; r=f.read(n); assert len(r)==n and r[:2]==q[:2] and r[2]&128; print('TCP_DNS_OK=true')"
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- python3 -c "$TCP_DNS_SCRIPT") \
  || fail "TCP DNS resolution failed: $OUTPUT"
[ "$OUTPUT" = "TCP_DNS_OK=true" ] || fail "unexpected TCP DNS output: $OUTPUT"
echo "  tcp: $OUTPUT"

DNS_INPUT_UDP_RULE=$(sudo iptables-save -c -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" \
  | grep -F -- "-i ${DNS_FILTER_INTERFACE}" \
  | grep -F -- "-p udp" \
  | grep -Fv -- " -j " \
  | head -n 1 || true)
DNS_INPUT_TCP_RULE=$(sudo iptables-save -c -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" \
  | grep -F -- "-i ${DNS_FILTER_INTERFACE}" \
  | grep -F -- "-p tcp" \
  | grep -Fv -- " -j " \
  | head -n 1 || true)
DNS_INPUT_UDP_AFTER=$(rule_packet_count "$DNS_INPUT_UDP_RULE")
DNS_INPUT_TCP_AFTER=$(rule_packet_count "$DNS_INPUT_TCP_RULE")
[ "$DNS_INPUT_UDP_AFTER" -gt "$DNS_INPUT_UDP_BEFORE" ] \
  || fail "IPv4 UDP DNS INPUT counter did not increase"
[ "$DNS_INPUT_TCP_AFTER" -gt "$DNS_INPUT_TCP_BEFORE" ] \
  || fail "IPv4 TCP DNS INPUT counter did not increase"


# Default dnsmasq wildcard sockets must still reject requests that
# arrive through a non-runner interface before a TCP handshake or
# DNS response reaches the process. Exercise IPv4/IPv6 and UDP/TCP
# through a temporary, deliberately non-matching veth.
exec {DNS_ISOLATION_LOCK_FD}<>/tmp/vm0-runner-exec-dns-isolation.lock \
  || fail "failed to open DNS isolation lock"
flock -w 30 "$DNS_ISOLATION_LOCK_FD" \
  || fail "timed out waiting for DNS isolation lock"
DNS_ISOLATION_NS="dns-isolation-$$"
DNS_ISOLATION_HOST_IF="vmdh$$"
DNS_ISOLATION_PEER_IF="vmdp$$"
DNS_ISOLATION_HASH=$(printf '%s' "$SVC" | cksum | awk '{print $1}')
DNS_ISOLATION_SECOND=$((18 + DNS_ISOLATION_HASH % 2))
DNS_ISOLATION_THIRD=$(((DNS_ISOLATION_HASH / 2) % 256))
DNS_ISOLATION_BASE=$((((DNS_ISOLATION_HASH / 512) % 64) * 4))
DNS_ISOLATION_HOST_IP="198.${DNS_ISOLATION_SECOND}.${DNS_ISOLATION_THIRD}.$((DNS_ISOLATION_BASE + 1))"
DNS_ISOLATION_PEER_IP="198.${DNS_ISOLATION_SECOND}.${DNS_ISOLATION_THIRD}.$((DNS_ISOLATION_BASE + 2))"
DNS_ISOLATION_IPV6_HEXTET=$(printf '%x' "$((DNS_ISOLATION_HASH % 65535 + 1))")
DNS_ISOLATION_HOST_IPV6="fd00:198:18:${DNS_ISOLATION_IPV6_HEXTET}::1"
DNS_ISOLATION_PEER_IPV6="fd00:198:18:${DNS_ISOLATION_IPV6_HEXTET}::2"

sudo ip netns add "$DNS_ISOLATION_NS" \
  || fail "failed to create DNS isolation namespace"
sudo ip link add "$DNS_ISOLATION_HOST_IF" type veth \
  peer name "$DNS_ISOLATION_PEER_IF" \
  || fail "failed to create DNS isolation veth"
sudo ip link set "$DNS_ISOLATION_PEER_IF" netns "$DNS_ISOLATION_NS"
sudo ip address add "${DNS_ISOLATION_HOST_IP}/30" \
  dev "$DNS_ISOLATION_HOST_IF"
sudo ip -6 address add "${DNS_ISOLATION_HOST_IPV6}/64" \
  dev "$DNS_ISOLATION_HOST_IF" nodad
sudo ip link set "$DNS_ISOLATION_HOST_IF" up
sudo ip -n "$DNS_ISOLATION_NS" address add \
  "${DNS_ISOLATION_PEER_IP}/30" dev "$DNS_ISOLATION_PEER_IF"
sudo ip -n "$DNS_ISOLATION_NS" -6 address add \
  "${DNS_ISOLATION_PEER_IPV6}/64" dev "$DNS_ISOLATION_PEER_IF" nodad
sudo ip -n "$DNS_ISOLATION_NS" link set lo up
sudo ip -n "$DNS_ISOLATION_NS" link set "$DNS_ISOLATION_PEER_IF" up
sudo ip netns exec "$DNS_ISOLATION_NS" \
  ping -c 1 -W 1 "$DNS_ISOLATION_HOST_IP" >/dev/null \
  || fail "temporary non-runner veth cannot reach its host peer"
sudo ip netns exec "$DNS_ISOLATION_NS" \
  ping -6 -c 1 -W 1 "$DNS_ISOLATION_HOST_IPV6" >/dev/null \
  || fail "temporary non-runner veth cannot reach its IPv6 host peer"

if ! sudo ip netns exec "$DNS_ISOLATION_NS" \
  python3 - "$DNS_ISOLATION_HOST_IP" "$DNS_ISOLATION_HOST_IPV6" "$DNS_PORT" <<'PY'
import socket
import sys

hosts = sys.argv[1:3]
port = int(sys.argv[3])
query = bytes.fromhex(
    "123401000001000000000000"
    "0d766d302d72656164696e657373"
    "07696e76616c69640000010001"
)

for host in hosts:
    address = (host, port)
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    udp = socket.socket(family, socket.SOCK_DGRAM)
    udp.settimeout(1)
    udp.sendto(query, address)
    try:
        response, _ = udp.recvfrom(4096)
    except (ConnectionError, TimeoutError):
        pass
    else:
        if response:
            raise SystemExit(
                f"dnsmasq answered UDP on non-runner address {host}"
            )
    finally:
        udp.close()

    try:
        tcp = socket.create_connection(address, timeout=1)
    except OSError:
        pass
    else:
        tcp.close()
        raise SystemExit(
            f"dnsmasq TCP port reachable on non-runner address {host}"
        )
PY
then
  fail "dnsmasq accepted a query from a non-runner interface"
fi

sudo ip netns delete "$DNS_ISOLATION_NS" \
  || fail "failed to remove DNS isolation namespace"
sudo ip link delete "$DNS_ISOLATION_HOST_IF" 2>/dev/null || true
DNS_ISOLATION_NS=""
DNS_ISOLATION_HOST_IF=""
exec {DNS_ISOLATION_LOCK_FD}>&-
DNS_ISOLATION_LOCK_FD=""
echo "PASS: DNS resolution"

# Retain the runner's existing pool flock across stop and cleanup assertions.
# The owned Rust guard releases by final close, so pidfd_getfd can preserve the
# same open file description without a handoff window.
RUNNER_MAIN_PID=$(sudo systemctl show "$UNIT" \
  --property=MainPID --value 2>/dev/null) \
  || fail "failed to read runner MainPID before stop"
case "$RUNNER_MAIN_PID" in
  "" | 0 | *[!0-9]*)
    fail "invalid runner MainPID before stop: ${RUNNER_MAIN_PID:-missing}"
    ;;
esac

POOL_LOCK_GUARD_DIR=$(mktemp -d "/tmp/vm0-${SVC}-pool-lock.XXXXXX") \
  || fail "failed to create pool-lock guard directory"
POOL_LOCK_READY="$POOL_LOCK_GUARD_DIR/ready"
POOL_LOCK_RELEASE_FIFO="$POOL_LOCK_GUARD_DIR/release"
POOL_LOCK_ERROR="$POOL_LOCK_GUARD_DIR/error"
POOL_LOCK_TARGET="$POOL_LOCK_GUARD_DIR/target"
mkfifo "$POOL_LOCK_RELEASE_FIFO" \
  || fail "failed to create pool-lock release FIFO"
exec {POOL_LOCK_RELEASE_FD}<>"$POOL_LOCK_RELEASE_FIFO" \
  || fail "failed to open pool-lock release FIFO"

sudo python3 - \
  "$RUNNER_MAIN_PID" \
  "$RUNNER_POOL_INDEX" \
  "$POOL_LOCK_READY" \
  "$POOL_LOCK_RELEASE_FIFO" \
  "$POOL_LOCK_TARGET" \
  {POOL_LOCK_RELEASE_FD}>&- >"$POOL_LOCK_ERROR" 2>&1 <<'PY' &
import ctypes
import errno
import os
import platform
from pathlib import Path
import signal
import sys

runner_pid = int(sys.argv[1])
pool_index = int(sys.argv[2])
ready_path = Path(sys.argv[3])
release_fifo = Path(sys.argv[4])
target_path = Path(sys.argv[5])
lock_name = f"vm0-netns-pool-{pool_index}.lock"


def handle_timeout(_signum, _frame):
    raise TimeoutError("timed out retaining the runner pool lock")


signal.signal(signal.SIGALRM, handle_timeout)
signal.alarm(360)

machine = platform.machine()
if machine not in {"aarch64", "x86_64"}:
    raise RuntimeError(f"unsupported pidfd_getfd architecture: {machine}")

matches = []
for entry in Path(f"/proc/{runner_pid}/fd").iterdir():
    try:
        target = os.readlink(entry)
    except FileNotFoundError:
        continue
    if Path(target).name == lock_name:
        matches.append((int(entry.name), target))

if len(matches) != 1:
    raise RuntimeError(
        f"expected one {lock_name} descriptor on pid {runner_pid}, "
        f"found {len(matches)}"
    )

target_fd, target = matches[0]
pidfd = os.pidfd_open(runner_pid)
try:
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    duplicated_fd = libc.syscall(438, pidfd, target_fd, 0)
    if duplicated_fd < 0:
        error = ctypes.get_errno()
        raise OSError(error, errno.errorcode.get(error, os.strerror(error)))
finally:
    os.close(pidfd)

try:
    if Path(os.readlink(f"/proc/self/fd/{duplicated_fd}")).name != lock_name:
        raise RuntimeError(
            f"duplicated descriptor target changed from {target}"
        )
    release_fd = os.open(release_fifo, os.O_RDONLY)
    try:
        target_path.write_text(target)
        ready_path.touch()
        while os.read(release_fd, 1):
            pass
    finally:
        os.close(release_fd)
finally:
    os.close(duplicated_fd)

signal.alarm(0)
PY
POOL_LOCK_HOLDER_PID=$!

for _ in $(seq 1 200); do
  [ -e "$POOL_LOCK_READY" ] && break
  kill -0 "$POOL_LOCK_HOLDER_PID" 2>/dev/null \
    || break
  sleep 0.05
done
if [ ! -e "$POOL_LOCK_READY" ]; then
  [ ! -s "$POOL_LOCK_ERROR" ] || cat "$POOL_LOCK_ERROR"
  fail "failed to retain runner pool lock before stop"
fi
POOL_LOCK_PATH=$(cat "$POOL_LOCK_TARGET") \
  || fail "failed to read retained pool lock path"
[ -n "$POOL_LOCK_PATH" ] || fail "retained pool lock path is empty"

# Stop transient service (kills sandbox, submit terminates naturally).
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
if sudo flock -n "$POOL_LOCK_PATH" true; then
  fail "pool lock released before cleanup assertions"
else
  POOL_LOCK_PROBE_STATUS=$?
fi
[ "$POOL_LOCK_PROBE_STATUS" -eq 1 ] \
  || fail "failed to probe retained pool lock: status $POOL_LOCK_PROBE_STATUS"
if sudo iptables-save -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" >/dev/null; then
  fail "IPv4 DNS INPUT filter leaked after runner stop"
fi
if sudo ip6tables-save -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" >/dev/null; then
  fail "IPv6 DNS INPUT filter leaked after runner stop"
fi
RAW_RULES_AFTER_STOP=$(sudo iptables-save -t raw) \
  || fail "failed to read raw rules after runner stop"
LEAKED_SOURCE_GUARDS=$(printf '%s\n' "$RAW_RULES_AFTER_STOP" \
  | grep -F -- "$RUNNER_POOL_PREFIX" || true)
[ -z "$LEAKED_SOURCE_GUARDS" ] \
  || fail "IPv4 source guards leaked after runner stop: $LEAKED_SOURCE_GUARDS"
NAMESPACES_AFTER_STOP=$(sudo ip netns list) \
  || fail "failed to read network namespaces after runner stop"
LEAKED_NAMESPACES=$(printf '%s\n' "$NAMESPACES_AFTER_STOP" \
  | awk -v prefix="$RUNNER_POOL_PREFIX" 'index($1, prefix) == 1') \
  || fail "failed to inspect network namespaces after runner stop"
[ -z "$LEAKED_NAMESPACES" ] \
  || fail "network namespaces leaked after runner stop: $LEAKED_NAMESPACES"
LINKS_AFTER_STOP=$(sudo ip -o link show) \
  || fail "failed to read network links after runner stop"
LEAKED_HOST_VETHS=$(printf '%s\n' "$LINKS_AFTER_STOP" \
  | awk -F ': ' -v prefix="$RUNNER_VETH_PREFIX" '
      {
        name = $2
        sub(/@.*/, "", name)
        if (index(name, prefix) == 1) print name
      }
    ') || fail "failed to inspect network links after runner stop"
[ -z "$LEAKED_HOST_VETHS" ] \
  || fail "host veth devices leaked after runner stop: $LEAKED_HOST_VETHS"

exec {POOL_LOCK_RELEASE_FD}>&-
POOL_LOCK_RELEASE_FD=""
if wait "$POOL_LOCK_HOLDER_PID"; then
  :
else
  POOL_LOCK_HOLDER_STATUS=$?
  POOL_LOCK_HOLDER_PID=""
  [ ! -s "$POOL_LOCK_ERROR" ] || cat "$POOL_LOCK_ERROR"
  fail "pool-lock holder exited with status $POOL_LOCK_HOLDER_STATUS"
fi
POOL_LOCK_HOLDER_PID=""
rm -rf "$POOL_LOCK_GUARD_DIR"
POOL_LOCK_GUARD_DIR=""
POOL_LOCK_ERROR=""

cleanup_submit_pid "$SUBMIT_PID"
SUBMIT_PID=""
trap - EXIT

echo "=== Exec test passed ==="
REMOTE_SCRIPT
