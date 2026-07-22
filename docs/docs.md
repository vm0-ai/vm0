# Engineering Documentation Index

Use this index to locate the repository's authoritative engineering guidance
before implementation or review. Read the documents relevant to the changed
surface; the index does not replace their detailed rules.

## Code Review

- [Bad code smells](./bad-smell.md): production-code quality rules.
- [React effects and ccstate commands](./effect.md): choosing between computed
  values, semantic commands, route setup, DOM lifecycles, and React effects.
- [React and ccstate cache and lifecycle practices](./cache.md): render purity,
  state ownership, cache retention, refs, and resource teardown.
- [Testing](./testing.md): testing strategy, patterns, and anti-patterns.
- [Deployment compatibility](./deployment-compatibility.md): compatibility
  requirements for independently deployed components and persisted state.

## Specialized Guidance

- [React commit analysis](./react-commit.md): measuring and attributing React
  work without confusing executions, scheduler events, or DOM mutations with
  commits.
- [Chat cards](./chat-cards.md): recognizing links in chat messages, creating
  thread-scoped card signals, and rendering rich interactive cards.
- [Signed model usage pricing protocol](./model-usage-pricing-protocol.md):
  producer/runner header, signature, validation, fallback, and rollout contract.
- [Testing catalog](./testing/anti-patterns.md): detailed testing anti-patterns.
