# Zero CLI surface inventory

`zero-cli-surface.v1.json` is the committed, implementation-independent
inventory of the TypeScript Zero CLI Commander surface. Its schema is
`zero-cli-surface.schema.v1.json`; both the filename and `schemaVersion` change
when a breaking inventory-schema revision is introduced.

Regenerate the inventory from `turbo/`:

```bash
pnpm --filter @vm0/cli generate:surface
```

Verify that the committed inventory is current:

```bash
pnpm --filter @vm0/cli check:surface
```

The extractor loads every lazy top-level definition before walking the full
Commander graph. Command records are sorted by canonical path, options and
aliases are sorted lexicographically, and positional arguments retain Commander
registration order. Rendered help uses a fixed width of 100 columns. The
recorded extraction context has `ZERO_TOKEN`, `ZERO_CHAT_THREAD_ID`, and
`ZERO_AGENT_ID` unset, while every top-level command remains present in the
catalog with its separate visibility rule.

## Visibility schema

`hidden` records Commander help visibility for a command or option in the
documented extraction context. Each top-level command also has `visibility`:

- `capabilityGate.mode = "always"`: visible for a valid Zero token without a
  capability requirement.
- `capabilityGate.mode = "anyOf"`: visible when the token has at least one
  listed capability.
- `capabilityGate.mode = "hidden"`: hidden whenever a valid Zero token is
  active because the command has no capability mapping.
- `featureSwitch`: the core feature-switch key evaluated before capability
  visibility, or `null` when there is no feature gate.
- `runOnly`: hidden when no valid Zero token is present.

## Mapping to #24878 parity dimensions

| Parity dimension                            | Inventory fields                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stdout                                      | `helpText`, command/argument/option `description`, `listingDescription`, `summary`, and `usage` freeze the help-output contract. Runtime success output is outside this surface inventory. |
| stderr                                      | `path`, arguments, options, choices, and requiredness identify parser inputs; rendered runtime errors are outside this inventory.                                                          |
| exit code                                   | Required/optional, variadic, mandatory, choices, and default fields freeze parser acceptance inputs; runtime exit outcomes are outside this inventory.                                     |
| HTTP method, path, query, body, and headers | Canonical command `path`, aliases, arguments, and options provide the stable scenario selector. HTTP behavior is outside this inventory.                                                   |
| Filesystem side effects                     | Canonical command `path`, arguments, and options provide the stable scenario selector. Filesystem effects are outside this inventory.                                                      |
| Permissions                                 | Top-level `visibility.capabilityGate`, `featureSwitch`, and `runOnly` record CLI availability rules. Connector/API permission behavior is outside this inventory.                          |
| Retries and timeouts                        | User-facing retry or timeout options and defaults are recorded when present. Internal policies are outside this inventory.                                                                 |
| Telemetry classification                    | Canonical command `path` provides the stable command identity. Emitted telemetry is outside this inventory.                                                                                |
