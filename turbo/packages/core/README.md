# @okouai/core

Core utilities package for the Turbo monorepo.

## Installation

This package is meant to be used within the monorepo. Install all dependencies from `turbo/`:

```bash
pnpm install
```

## Development

### Running tests

```bash
pnpm test
```

### Watch mode for tests

```bash
pnpm test:watch
```

### Type checking

```bash
pnpm check-types
```

## Exports

Use the subpath exports declared in [package.json](package.json). Feature switch
keys are exported from `@okouai/core/feature-switch-key`; consult the current
[enum](src/feature-switch-key.ts) rather than copying a rollout key from a README.
