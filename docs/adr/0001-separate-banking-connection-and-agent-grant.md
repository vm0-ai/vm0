# Separate banking connections from agent grants

Status: Accepted — 2026-08-24

## Context

Mastercard Data Connect records a user's consent for Mastercard Open Finance to access a financial institution. That consent does not identify which vm0 Agent may use the resulting data, for what purpose, or for how long.

## Decision

vm0 models the two permissions independently:

- A banking connection belongs to one user within one workspace and may be reused across that user's Agents. Bank credentials, MFA, and provider consent remain on Mastercard's hosted surface.
- Each Agent receives a separate grant containing an explicit purpose, selected accounts, the fixed read-only banking operations, and an expiration. Automation access remains disabled.
- Revoking an Agent grant does not disconnect the Mastercard connection. Repair runs per institution through Mastercard Data Connect Fix.

## Consequences

Users complete an additional confirmation in Chat before an Agent can read data, but a connection never grants implicit access to every Agent in a workspace. vm0 persists connection and account metadata only; balances and transactions remain live provider reads. Full provider disconnection and customer deletion remain separate decisions pending the retention and compliance work tracked in #15390.
