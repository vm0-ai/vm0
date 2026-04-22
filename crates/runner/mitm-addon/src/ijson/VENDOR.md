# Vendored: ijson

- Upstream: https://github.com/ICRAR/ijson
- Version:  3.5.0
- SHA256:   75b7936a6dd81bdf9207aab23e9d0b70cf1bff751b120502da0181da8fad18ec
- License:  see LICENSE.txt. The top section (ijson, BSD-3-Clause) covers
            every file shipped here. The bottom section (yajl, ISC) is
            retained verbatim from upstream but applies only to the YAJL
            C bindings, which we deliberately did not vendor.

Only the pure-Python backend is vendored. The YAJL (C / CFFI / ctypes) backends
would fail to import inside mitmdump's bundled Python and are omitted on
purpose.

## No local modifications

Every .py file here is byte-for-byte identical to the pinned upstream tarball.
Audit by comparing `sha256sum` of individual files against the contents of
`v3.5.0.tar.gz` from the upstream URL above. Only this VENDOR.md
is generated locally.

The package installs at `src/ijson/` (not `src/vendor/ijson/`) precisely so
that ijson's own absolute imports (`from ijson import compat` etc.) resolve
natively without rewriting — mitmdump loads the addon with `src/` on
`sys.path`, making `ijson` a top-level package.

Do NOT hand-edit. Regenerate with:

    crates/runner/mitm-addon/scripts/vendor-ijson.sh

To upgrade: bump IJSON_VERSION, clear IJSON_SHA256, re-run.
