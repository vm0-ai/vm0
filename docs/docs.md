# Engineering Documentation Index

Use this index to locate the repository's authoritative engineering guidance
before implementation or review. Read the documents relevant to the changed
surface; the index does not replace their detailed rules.

## Code Review

- [Bad code smells](./bad-smell.md): production-code quality rules.
- [Fallbacks to avoid](./fallback.md): fallback slop, negative tests against
  removed code, feature-switched features that need no compatibility, and the
  narrow cases where a time-boxed fallback is required.
- [Event sourcing and optimistic events](./event-sourcing.md): authoritative
  persistent events, optimistic projections, reconciliation, and failure
  semantics.
- [React effects and ccstate commands](./effect.md): choosing between computed
  values, semantic commands, route setup, DOM lifecycles, and React effects.
- [React and ccstate cache and lifecycle practices](./cache.md): render purity,
  state ownership, cache retention, refs, and resource teardown.
- [Testing](./testing.md): testing strategy, patterns, and anti-patterns.
- [Deployment compatibility](./deployment-compatibility.md): compatibility
  requirements for independently deployed components and persisted state.
- [Connector-account workflow automations](./connector-account-workflow-automation.md):
  workflow-thread account authority, exact provider ingress, lifecycle
  convergence, and persisted compatibility for account-backed triggers.
- [Externally managed references](./externally-managed-references.md): how to
  resolve identifiers whose entities are owned by another authority without
  conflating missing entities, invalid input, dependency failures, and local
  invariant violations.

## Specialized Guidance

- [React commit analysis](./react-commit.md): measuring and attributing React
  work without confusing executions, scheduler events, or DOM mutations with
  commits.
- [Chat cards](./chat-cards.md): recognizing links in chat messages, creating
  thread-scoped card signals, and rendering rich interactive cards.
- [Runner host configuration](./runner-host-configuration.md): configure and
  verify host-local concurrency and I/O capacity overrides.
- [Runner multi-architecture rollout](./runner-multi-architecture.md): build,
  deploy, and validate runner artifacts for supported host architectures.
- [Residual platform brand names](./residual-platform-brand-names.md): which
  `zero-*` names in the platform and UI packages are safe to rename, which are
  published asset keys or client-persisted identities, and which are the English
  word.
- [Testing catalog](./testing/anti-patterns.md): detailed testing anti-patterns.
