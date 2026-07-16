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
GROUP="vm0/exec-${JOB_REF}"
SUBMIT_PID=""
DNS_ISOLATION_NS=""
DNS_ISOLATION_HOST_IF=""
DNS_ISOLATION_LOCK_FD=""

fail() { echo "FAIL: $1"; exit 1; }

cleanup_submit_pid() {
  local pid=$1
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  echo "--- Cleanup ---"
  sudo "$BIN_DIR/runner" service stop --name "$SVC" --force || true
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
sudo "$BIN_DIR/runner" service start --name "$SVC" \
  --config "$RUNNER_DIR/runner.yaml" --local --env USE_MOCK_CLAUDE=true --env USE_MOCK_CODEX=true

DNS_READINESS_LOGGED=false
for _ in $(seq 1 30); do
  INVOCATION_ID=$(sudo systemctl show "vm0-runner-${SVC}.service" \
    --property=InvocationID --value 2>/dev/null) || true
  if [ -n "$INVOCATION_ID" ]; then
    STARTUP_LOGS=$(sudo journalctl --no-pager --lines 300 \
      "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" 2>&1) \
      || fail "failed to read runner startup logs"
    if printf '%s\n' "$STARTUP_LOGS" \
      | grep -F "namespace DNS readiness probe succeeded" >/dev/null; then
      DNS_READINESS_LOGGED=true
      break
    fi
  fi
  sleep 1
done
[ "$DNS_READINESS_LOGGED" = true ] \
  || fail "runner did not activate namespace DNS readiness"

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

# Test 3: exit code propagation
echo "--- Test: exit code propagation ---"
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- false && fail "expected non-zero exit"
echo "PASS: exit code propagation"

# Test 4: prefix matching
echo "--- Test: prefix matching ---"
PREFIX=$(echo "$SANDBOX_ID" | cut -c1-8)
OUTPUT=$(sudo "$BIN_DIR/runner" exec --sandbox "$PREFIX" -- hostname)
[ -n "$OUTPUT" ] || fail "prefix match returned empty output"
echo "PASS: prefix matching"

# Test 5: argv boundary preservation — regression guard for #9019.
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

# Test 6: verify pre-installed language runtimes and databases
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
  "$pg_bin/pg_ctl" -D /tmp/pgdata stop
  pg_started=0
' \
  || { sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- cat /tmp/pgdata/log 2>&1 || true; fail "PostgreSQL start"; }
echo "  PostgreSQL start/stop: ok"
echo "PASS: runtime availability"

# Test 7: verify /etc/environment is loaded for both user and root
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

# Test 8: verify HTTPS works through proxy for each runtime
# All traffic goes through mitmproxy, so TLS must trust the proxy CA.
echo "--- Test: HTTPS through proxy ---"
TLS_URL="https://www.vm0.ai"
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

# Test 9: verify DNS resolution works inside sandbox
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

# Inspect the actual rules installed for this runner. Matching by its
# unique proxy and DNS ports avoids parallel CI runners on the host.
PROXY_PORT=$(sudo jq -r '.proxy_port // empty' "$RUNNER_DIR/status.json")
DNS_PORT=$(sudo jq -r '.dns_port // empty' "$RUNNER_DIR/status.json")
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

DNS_FILTER_COMMENT=$(printf '%s\n' "$FILTER_RULES" \
  | grep -E -- "-A INPUT .*--dport ${DNS_PORT} .*--comment vm0-ns-[0-9a-f]{2}-dns.*-j REJECT" \
  | sed -nE 's/.*--comment "?([^ " ]+)"?.*/\1/p' \
  | head -n 1)
[ -n "$DNS_FILTER_COMMENT" ] || fail "DNS INPUT filter comment missing"

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

# Stop transient service (kills sandbox, submit terminates naturally)
sudo "$BIN_DIR/runner" service stop --name "$SVC" --force
if sudo iptables-save -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" >/dev/null; then
  fail "IPv4 DNS INPUT filter leaked after runner stop"
fi
if sudo ip6tables-save -t filter \
  | grep -F -- "--comment ${DNS_FILTER_COMMENT}" >/dev/null; then
  fail "IPv6 DNS INPUT filter leaked after runner stop"
fi
cleanup_submit_pid "$SUBMIT_PID"
SUBMIT_PID=""
trap - EXIT

echo "=== Exec test passed ==="
REMOTE_SCRIPT
