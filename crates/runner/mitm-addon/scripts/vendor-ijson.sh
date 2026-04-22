#!/usr/bin/env bash
# Vendor ijson's pure-Python backend into mitm-addon/src/ijson/.
#
# WHY: mitmdump ships as a self-contained binary with its own embedded Python;
# we cannot pip-install into it at runtime. Addon code is baked into the runner
# binary via include_str! — so any Python dep must be part of the source tree.
# ijson's pure-Python backend is small (~1 KLoC across the minimal fileset) and
# BSD-3/ISC licensed, making vendoring the right fit.
#
# WHY ``src/ijson/`` (not ``src/vendor/ijson/``): mitmdump loads the addon with
# ``src/`` on ``sys.path``, and ijson's internal imports use absolute form
# (``from ijson import compat``). Installing at ``src/ijson/`` makes those
# imports resolve natively — no rewriting of upstream source. The vendor
# status is marked by VENDOR.md + LICENSE.txt *inside* the package, not by
# directory placement.
#
# USAGE: run from anywhere; idempotent. To upgrade, bump IJSON_VERSION, clear
# IJSON_SHA256 (the script will print the new SHA and exit so you can pin it),
# then re-run.
#
#   ./vendor-ijson.sh         # install pinned version
#   ./vendor-ijson.sh --check # verify vendored tree matches the pinned version
#                             # without touching the filesystem (for CI)

set -euo pipefail

IJSON_VERSION="3.5.0"
# SHA256 of the GitHub source tarball (v${IJSON_VERSION}.tar.gz).
# Leave empty on first run / upgrade — the script will compute and print it.
IJSON_SHA256="75b7936a6dd81bdf9207aab23e9d0b70cf1bff751b120502da0181da8fad18ec"

ADDON_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Sanity: refuse to proceed if the resolved root doesn't look like the
# mitm-addon tree.  Otherwise a mis-invocation (empty $0, exotic sourcing)
# could cause `rm -rf "$VENDOR_DIR"` below to wipe something unrelated.
if [[ ! -d "$ADDON_ROOT/src" || ! -f "$ADDON_ROOT/pyproject.toml" ]]; then
  echo "!!! Refusing to run: $ADDON_ROOT does not look like the mitm-addon root" >&2
  echo "    (expected \$ADDON_ROOT/src/ and \$ADDON_ROOT/pyproject.toml)" >&2
  exit 10
fi
VENDOR_DIR="$ADDON_ROOT/src/ijson"

TARBALL_URL="https://github.com/ICRAR/ijson/archive/refs/tags/v${IJSON_VERSION}.tar.gz"

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo ">>> Downloading ijson ${IJSON_VERSION} from ${TARBALL_URL}"
tarball="$tmp_dir/ijson.tar.gz"
curl -fsSL "$TARBALL_URL" -o "$tarball"

actual_sha="$(sha256sum "$tarball" | awk '{print $1}')"
if [[ -z "$IJSON_SHA256" ]]; then
  echo ""
  echo "!!! IJSON_SHA256 is empty in $0. Pin it to:"
  echo ""
  echo "    IJSON_SHA256=\"$actual_sha\""
  echo ""
  echo "then re-run."
  exit 1
fi
if [[ "$actual_sha" != "$IJSON_SHA256" ]]; then
  echo "SHA256 mismatch:"
  echo "  expected: $IJSON_SHA256"
  echo "  actual:   $actual_sha"
  echo "If intentional (version upgrade), update IJSON_SHA256 in $0."
  exit 2
fi
echo ">>> SHA256 verified: $actual_sha"

tar -xzf "$tarball" -C "$tmp_dir"
src_root="$tmp_dir/ijson-${IJSON_VERSION}"

# Minimal fileset: everything the pure-Python backend transitively imports.
# If a future ijson version grows a new import, tests/test_vendored_ijson.py
# will fail with ModuleNotFoundError — add the missing file here and re-pin.
root_files=(
  __init__.py
  adapters.py
  common.py
  compat.py
  utils.py
  utils35.py
  version.py
)
backend_files=(
  __init__.py
  python.py
)

stage_dir="$tmp_dir/stage"
mkdir -p "$stage_dir/backends"
for f in "${root_files[@]}"; do
  cp "$src_root/src/ijson/$f" "$stage_dir/$f"
done
for f in "${backend_files[@]}"; do
  cp "$src_root/src/ijson/backends/$f" "$stage_dir/backends/$f"
done
cp "$src_root/LICENSE.txt" "$stage_dir/LICENSE.txt"

# No source modifications. Every .py file here is byte-for-byte identical
# to the pinned upstream tarball — ``sha256sum $VENDOR_DIR/*.py`` can be
# matched directly against the tarball contents for audit.

cat > "$stage_dir/VENDOR.md" <<EOF
# Vendored: ijson

- Upstream: https://github.com/ICRAR/ijson
- Version:  ${IJSON_VERSION}
- SHA256:   ${IJSON_SHA256}
- License:  see LICENSE.txt. The top section (ijson, BSD-3-Clause) covers
            every file shipped here. The bottom section (yajl, ISC) is
            retained verbatim from upstream but applies only to the YAJL
            C bindings, which we deliberately did not vendor.

Only the pure-Python backend is vendored. The YAJL (C / CFFI / ctypes) backends
would fail to import inside mitmdump's bundled Python and are omitted on
purpose.

## No local modifications

Every .py file here is byte-for-byte identical to the pinned upstream tarball.
Audit by comparing \`sha256sum\` of individual files against the contents of
\`v${IJSON_VERSION}.tar.gz\` from the upstream URL above. Only this VENDOR.md
is generated locally.

The package installs at \`src/ijson/\` (not \`src/vendor/ijson/\`) precisely so
that ijson's own absolute imports (\`from ijson import compat\` etc.) resolve
natively without rewriting — mitmdump loads the addon with \`src/\` on
\`sys.path\`, making \`ijson\` a top-level package.

Do NOT hand-edit. Regenerate with:

    crates/runner/mitm-addon/scripts/vendor-ijson.sh

To upgrade: bump IJSON_VERSION, clear IJSON_SHA256, re-run.
EOF

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  # -x __pycache__: pytest / any local Python run populates bytecode caches
  # under the installed tree; they're never committed and should not count
  # as drift.  build.rs also skips __pycache__ when embedding the addon.
  if ! diff -qr -x __pycache__ "$stage_dir" "$VENDOR_DIR" >/dev/null 2>&1; then
    echo "!!! Vendored tree at $VENDOR_DIR differs from pinned ${IJSON_VERSION}."
    diff -r -x __pycache__ "$stage_dir" "$VENDOR_DIR" || true
    exit 3
  fi
  echo ">>> Vendored tree matches pinned ${IJSON_VERSION}. OK."
  exit 0
fi

echo ">>> Installing to $VENDOR_DIR"
rm -rf "$VENDOR_DIR"
mkdir -p "$(dirname "$VENDOR_DIR")"
cp -a "$stage_dir" "$VENDOR_DIR"

echo ">>> Done. Run tests/test_vendored_ijson.py to verify the drop-in works."
find "$VENDOR_DIR" -type f | sort | sed "s|$ADDON_ROOT/||"
