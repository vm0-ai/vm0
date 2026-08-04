# Zero CLI differential parity harness

Run the complete local suite from the repository root:

```bash
crates/zero-cli/tests/parity/run.sh
```

The command builds the public TypeScript package artifact, builds the
runner-bundled `zero-cli`, runs the harness self-tests, and then executes every
case under `v1/cases/` against both executables.

The checked-in help cases exercise both `pipe` and `pty`. A focused harness
self-test also verifies that PTY stdin, stdout, and stderr independently report
TTY status while preserving separate output capture.

## Execution boundary

Each implementation runs as a child process with the same fixture-defined
arguments, environment, stdin, relative working directory, timeout, and
terminal mode. `pipe` uses ordinary non-TTY streams. `pty` gives stdin, stdout,
and stderr separate fixed-size pseudoterminals so both streams remain
independently observable while reporting TTY status.

Every implementation receives its own temporary root containing:

- an independently materialized workspace;
- isolated home, temporary, and cache directories;
- a fresh mock HTTP server bound to loopback; and
- an `npx` shim that preserves the Rust proxy's public process boundary while
  executing the same built TypeScript package artifact without a registry
  download.

The harness does not import TypeScript functions or Rust implementation
modules. `--typescript`, `--rust`, and `--cases` accept alternate executable and
case paths, so generated inventory cases can use the same boundary later.

## Version 1 case schema

`v1/schema.json` is the authoritative JSON Schema. A case declares:

- `argv`, `environment`, `stdin`, `workingDirectory`, `terminalMode`, and
  `timeoutMs`;
- ordered mock HTTP exchanges, including the exact expected method, raw path,
  raw query, and request body plus the response to return;
- the request headers to capture for differential comparison;
- real filesystem seed entries (file, directory, or symlink) and Unix modes;
  and
- any narrowly scoped normalizations.

The complete workspace tree is snapshotted after each execution. Snapshots
compare relative paths, entry type, Unix permission bits, file bytes, and
symlink targets. Filesystem timestamps and temporary-root names are never part
of the observation.

## Compared parity dimensions

Comparison is exact by default across:

- stdout and stderr bytes;
- exit code and terminating signal;
- ordered HTTP method, path, raw query, body bytes, and selected headers; and
- the post-execution filesystem snapshot.

Mock exchanges are also checked against their expected request shape before
the TypeScript-versus-Rust comparison, so two equally incorrect requests do not
silently pass a fixture.

Mismatch output names the case and dimension, reports the first differing byte
with bounded context, and lists per-request and per-path differences. Values of
the `authorization` header are compared but redacted from diagnostics.
Fixtures must use synthetic credentials and payload data; never place a real
token or secret in a case.

## Narrow normalization

Schema v1 supports only two explicit normalization forms:

- `runtime-value` replaces one harness-generated value (workspace, mock URL,
  home, or temporary path) in named text-bearing dimensions. A declaration
  fails if it does not match anything.
- `uuid-http-header` validates UUID-valued captured headers and replaces them
  with stable identity-preserving placeholders. A declaration fails if the
  header is absent or not a UUID.

There is no general regular-expression, whitespace, ANSI, ordering, or JSON
normalization. Add a normalizer only when a case demonstrates an unavoidable
nondeterministic value.
