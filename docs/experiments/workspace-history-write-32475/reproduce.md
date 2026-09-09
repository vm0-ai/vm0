# Reproduce the source-pinned experiment

These are privileged, **manual local-host experiments**, not deployment or CI
instructions. Use an explicitly authorized development host with KVM, the
normal Runner host dependencies and enough memory/disk. Do not run against
user histories, a production Runner service, or a different source revision.

## Analyze the committed evidence without a host

From the repository root, with Python 3.12+:

```bash
python3 docs/experiments/workspace-history-write-32475/test_profile.py
python3 docs/experiments/workspace-history-write-32475/profile.py analyze \
  docs/experiments/workspace-history-write-32475/serial.jsonl
python3 docs/experiments/workspace-history-write-32475/profile.py analyze \
  docs/experiments/workspace-history-write-32475/concurrent.jsonl
python3 docs/experiments/workspace-history-write-32475/profile.py analyze \
  docs/experiments/workspace-history-write-32475/concurrent-long.jsonl
```

The compact JSONL files contain one process record per line, including all
invocation outcomes and already-derived monotonic timing components. Full raw
console logs and sequence-level JSON are retained on local-11 under
`/var/lib/vm0-runner/bench-32475-vm4/{smoke-1,serial-1,concurrent-1,concurrent-long-1}`.
Each `.json` has a same-stem `.log`. Local copies were also retained under
`codex-work/research/issue-32475-workspace-history-write/evidence/` in the
original workspace. These host/workspace locations are retained experiment
evidence, not a guarantee of permanent storage; committed records suffice to
recompute the published quantiles without them.

To reparse one raw process log or compact a completed raw cohort:

```bash
python3 docs/experiments/workspace-history-write-32475/profile.py parse /path/to/process.log
python3 docs/experiments/workspace-history-write-32475/profile.py export /path/to/completed-cohort
```

Do not analyze a directory while collection is still writing its records.
`export` prints compact JSONL; `analyze` accepts that file or the original
directory. Keep separate cohorts separate. Failed records and missing samples
stay in the process/sample denominator; do not select only successful logs.

## Build both arms

Use a fresh, detached worktree at the recorded source. The patches are
deliberately not maintained as a public CLI or applied to current main.
Use rustc/Cargo 1.98.0 and the normal musl cross-toolchain for the target;
run Cargo **from `crates/`** so its linker configuration is loaded.

Example in Bash from the repository root, after checking these new paths are
unused and inside this workspace:

```bash
REPO=$(git rev-parse --show-toplevel)
ASSETS="$REPO/docs/experiments/workspace-history-write-32475"
REPRO="$REPO/codex-work/research/issue-32475-reproduction/source"
ARTIFACTS="$REPO/codex-work/research/issue-32475-reproduction/artifacts"
git worktree add --detach "$REPRO" cede9cbfb62872ddabb705de852dc6fd81a3cc6d
install -m 644 "$ASSETS/Cargo.lock.txt" "$REPRO/crates/Cargo.lock"
cd "$REPRO"
git apply --check "$ASSETS/harness.patch"
git apply "$ASSETS/harness.patch"
cd crates
source ../.github/scripts/runner-guest-binaries.sh
runner_guest_binaries_load
history_guest_args=()
for history_package in "${RUNNER_GUEST_PACKAGES[@]}"; do
  history_guest_args+=(-p "$history_package")
done
for history_arm in baseline observed; do
  if [[ "$history_arm" == observed ]]; then
    git -C "$REPRO" apply --check "$ASSETS/probes.patch"
    git -C "$REPRO" apply "$ASSETS/probes.patch"
  fi
  cargo build --locked --profile ci --target x86_64-unknown-linux-musl \
    -j4 "${history_guest_args[@]}"
  cargo build --locked --profile ci --target x86_64-unknown-linux-musl -j4 -p runner
  mkdir -p "$ARTIFACTS/$history_arm"
  for history_binary in "${RUNNER_GUEST_BINARIES[@]}" runner; do
    install -m 755 "target/x86_64-unknown-linux-musl/ci/$history_binary" \
      "$ARTIFACTS/$history_arm/$history_binary"
  done
done
```

Do not merge the Guest and Runner build commands into one Cargo invocation:
dependency feature unification can otherwise differ between arms. Keep the
lockfile identical. Do not set `BUNDLED_*` artifact environment overrides from
another build. Record all binary digests; a reproduction is a new measured
cohort and may have different digests/images, even with the same source.

The instrumented source was checked with these commands, one heavy check at a
time from `crates/`:

```bash
cargo fmt --all --check
cargo clippy --profile local -p runner -p guest-control-client \
  -p guest-control-server -p guest-write-file -p guest-control-tests \
  --all-targets --all-features -j4
RUSTDOCFLAGS='-D warnings' cargo doc --profile local -p runner \
  -p guest-control-client -p guest-control-server -p guest-write-file \
  -p guest-control-tests --no-deps --all-features -j4
cargo test --profile local -p guest-control-client -p guest-control-server \
  -p guest-write-file -p guest-control-tests -j4 -- --test-threads=1
cargo test --profile local -p runner --bin runner session_restore -j4 -- --test-threads=1
cargo test --profile local -p runner --bin runner cmd::start::tests::idle_reuse \
  -j4 -- --test-threads=1
cargo test --profile local -p runner --bin runner cmd::benchmark::tests \
  -j4 -- --test-threads=1
```

## Build images on the authorized host

For this run, SSH used `scripts/cf-ssh.sh` with user `ubuntu`, certificate
`.certs/vm0-metal-local.pem`, and host `local-11.gcp.vm3.ai`. The script handles
Cloudflare access; do not print credentials or copy production environment
files. Transfer both artifact directories plus `profile.py` and
`test_profile.py` into an issue-owned directory. This experiment used
`/var/lib/vm0-runner/bench-32475-vm4`, which is **already occupied** by its
retained evidence.

The collector uses the fixed four Runner directory names
`issue-32475-vm4-{baseline,observed}-{0,1}`. They are experiment-owned, not
services. On a fresh reproduction reserve these names on the chosen local
host, or change the script's fixed prefix/hostname after checking ownership.
Never overwrite another person's config. Changing the output directory alone
does not change those Runner names.

Build each image with **all ten explicit Guest paths**; never mix arms. With
the uploaded artifacts as the working directory:

```bash
for history_arm in baseline observed; do
  sudo -n "./$history_arm/runner" build --profile vm0/default \
    --guest-init "./$history_arm/guest-init" \
    --guest-agent "./$history_arm/guest-agent" \
    --guest-storage-apply "./$history_arm/guest-storage-apply" \
    --guest-state-restore "./$history_arm/guest-state-restore" \
    --guest-write-file "./$history_arm/guest-write-file" \
    --guest-workspace-mount "./$history_arm/guest-workspace-mount" \
    --guest-tool-exec "./$history_arm/guest-tool-exec" \
    --runner-rpc-client "./$history_arm/runner-rpc-client" \
    --claude-mock "./$history_arm/claude-mock" \
    --codex-mock "./$history_arm/codex-mock"
done
```

Do not pass R2 credentials; verify each build reports R2 disabled. The native
builder uses standard image/namespace locks and isolated rootfs construction.
It may download dependencies and Guest OS packages, but must not replace
existing Runner services or run global GC. Keep the resulting concrete images
and record the printed `rootfs_hash`/`snapshot_hash` in a **new** `images.json`
with the same structure as this directory's file. The checked-in hashes refer
only to the original tested artifacts, not arbitrary rebuilt binaries.

## Collect bounded synthetic samples

The host needs Python 3.12+, `zstd`, `/usr/bin/time`, and the normal Runner
benchmark dependencies. Run the collector as root only for its owned VM
resources. Its config has a synthetic token and loopback URL; no API service
or model calls are required.

From the issue-owned remote directory:

```bash
python3 profile.py fixtures .
python3 test_profile.py
sudo -n python3 profile.py matrix . images.json --output smoke-new \
  --cases small above codex pi native-zstd native-zstd-large \
  --blocks 1 --samples 1 --repeats 2
sudo -n python3 profile.py matrix . images.json --output serial-new \
  --blocks 2 --samples 2 --repeats 5
sudo -n python3 profile.py matrix . images.json --output concurrent-new \
  --cases small above large --blocks 2 --samples 2 --repeats 5 --concurrency 2
sudo -n python3 profile.py matrix . images.json --output concurrent-long-new \
  --cases above large --blocks 2 --samples 1 --repeats 20 --concurrency 2
```

Each output name must be fresh. Inspect smoke byte verification and correlated
phase completeness before the larger matrix. Preserve fixture sizes and
digests; zstd output may vary with compressor versions. First and repeat
invocations must be reported separately. Concurrent **processes** do not imply
that every timed write overlaps: startup is staggered. Use the long cohort to
cover sustained large writes and do not infer same-connection gate contention
from two independent VMs.

The collector stops on failure. On a 240-second process deadline it terminates
only that owned process group, escalates after 30 seconds, retains output and
records the failure. This is not proof that kernel/VM resources were reclaimed:
inspect the exact failed benchmark's owned resources before another run. Never
kill unrelated processes or delete a shared namespace/image by a guessed name.

## Ownership and cleanup

Successful benchmarks stop their VM/proxy, close the live-instance registration,
and release their NBD and namespace resources. Verify no issue-owned Runner or
Firecracker process/live instance remains after collection. Preserve unrelated
services; do not run `systemctl restart vm0-runner*` or global image/cache GC.

Keep raw evidence, synthetic fixtures and the exact artifacts until the report
is reviewed. The original experiment retains its four configs and immutable
images for reproduction; these consume disk and intentionally keep artifact
references. They are not long-running services. Remove retained artifacts only
as a separately scoped, ownership-checked operation using normal Runner image
ownership rules. Do not recursively delete the shared Runner root.
