# Firewalls Generator

Generates firewall configs for connector integrations. Each generator produces a `.generated.ts` file in `packages/core/src/firewalls/`.

## Usage

```bash
# Generate all
cd turbo && pnpm -F @vm0/firewalls-generator generate

# Generate one
cd turbo && pnpm -F @vm0/firewalls-generator generate:github
```

## Placeholder Tokens

Each firewall config includes a `placeholders` field with fake token values. These are injected into the sandbox environment so the MITM proxy can intercept and replace them with real credentials at runtime.

### Requirements

- **Format-correct**: must match the real token's prefix, length, and character set
- **Not obviously fake**: must NOT contain words like `placeholder`, `fake`, `dummy`, `test`, `example` — LLMs pattern-match on these and refuse to use the token
- **Internally recognizable**: use the word vocabulary below so the team can identify placeholders at a glance

### Word Vocabulary

Three words, adapted to the token's character set:

| Word   | Hex `[0-9a-f]` | Base62 `[A-Za-z0-9]` |
| ------ | -------------- | -------------------- |
| coffee | `c0ffee`       | `Coffee`             |
| safe   | `5afe`         | `Safe`               |
| local  | `10ca1`        | `Local`              |

### Fill Pattern

Repeat `c0ffee5afe10ca1` and truncate to the required length:

```
# Hex (32 chars)
c0ffee5afe10ca1c0ffee5afe10ca1c0

# Base62 (32 chars)
Coffee5afe10ca1Coffee5afe10ca1Co
```

### Examples

```
# Hex with prefix
gho_c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5a

# Base62 with prefix
ya29.A0Coffee5afe10ca1Coffee5afe10ca1Coffee...

# Short token
c0ffee5afe10ca1

# UUID-shaped
c0ffee5a-fe10-ca1c-0ffe-e5afe10ca1c0
```
