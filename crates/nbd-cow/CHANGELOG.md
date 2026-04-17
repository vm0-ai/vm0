# Changelog

## [0.4.2](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.1...nbd-cow-v0.4.2) (2026-04-17)


### Performance Improvements

* **nbd-cow:** drop lock guard before sending error replies ([#9742](https://github.com/vm0-ai/vm0/issues/9742)) ([ea3568c](https://github.com/vm0-ai/vm0/commit/ea3568c567db437b37b3bd9a7b6251f37d5205b2))

## [0.4.1](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.0...nbd-cow-v0.4.1) (2026-04-12)


### Bug Fixes

* **nbd-cow:** track in-flight device indices to prevent duplicate allocation ([#9033](https://github.com/vm0-ai/vm0/issues/9033)) ([4f43ab5](https://github.com/vm0-ai/vm0/commit/4f43ab5b5647d1c1ad61a37c3517b9419270259c)), closes [#9016](https://github.com/vm0-ai/vm0/issues/9016)

## [0.4.0](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.4...nbd-cow-v0.4.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.3.4](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.3...nbd-cow-v0.3.4) (2026-04-06)


### Refactoring

* **nbd:** deduplicate nbds_max, add concurrent test and bitmap assertion ([#8228](https://github.com/vm0-ai/vm0/issues/8228)) ([c0b98df](https://github.com/vm0-ai/vm0/commit/c0b98df3eb69ec81b26373d23d093a9526839752))

## [0.3.3](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.2...nbd-cow-v0.3.3) (2026-04-03)


### Bug Fixes

* **nbd-cow:** fix device leak when connecting worker thread exits ([#8064](https://github.com/vm0-ai/vm0/issues/8064)) ([25ed885](https://github.com/vm0-ai/vm0/commit/25ed885f1e646b6c1742e6b8d00cf0ca8a4ccf03))

## [0.3.2](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.1...nbd-cow-v0.3.2) (2026-04-03)


### Bug Fixes

* **nbd:** set disconnected flag only after successful disconnect ([#7870](https://github.com/vm0-ai/vm0/issues/7870)) ([6ffe3d4](https://github.com/vm0-ai/vm0/commit/6ffe3d483f1bdd70327b2e1303c541d600d127fe))

## [0.3.1](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.0...nbd-cow-v0.3.1) (2026-04-02)


### Bug Fixes

* use is_our_thread in bench cleanup and merge snapshot pool locks ([#7763](https://github.com/vm0-ai/vm0/issues/7763)) ([654d086](https://github.com/vm0-ai/vm0/commit/654d08604135e98a247b056413bf0c7e7d5065e0))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.3...nbd-cow-v0.3.0) (2026-04-02)


### Features

* add device pool for pre-validated nbd device index management ([#7695](https://github.com/vm0-ai/vm0/issues/7695)) ([aae067f](https://github.com/vm0-ai/vm0/commit/aae067febb127343ce4424ae78c3c312057479c9))

## [0.2.3](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.2...nbd-cow-v0.2.3) (2026-04-02)


### Bug Fixes

* **nbd-cow:** address review findings and randomize device scan ([#7603](https://github.com/vm0-ai/vm0/issues/7603)) ([8475b9e](https://github.com/vm0-ai/vm0/commit/8475b9eb110300393da0dffa482778a9bda5422d))

## [0.2.2](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.1...nbd-cow-v0.2.2) (2026-04-01)


### Bug Fixes

* **nbd-cow:** guard disconnect against device index recycling by other runners ([#7581](https://github.com/vm0-ai/vm0/issues/7581)) ([ed9e572](https://github.com/vm0-ai/vm0/commit/ed9e572a80514236aada53eb68b2e9ad069ec7d2))

## [0.2.1](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.0...nbd-cow-v0.2.1) (2026-04-01)


### Bug Fixes

* **nbd-cow:** advertise flush/trim flags and harden i/o paths ([#7539](https://github.com/vm0-ai/vm0/issues/7539)) ([6410e3e](https://github.com/vm0-ai/vm0/commit/6410e3ebc7652ba6f2da8edf14928346e70b7fb2))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.1.0...nbd-cow-v0.2.0) (2026-04-01)


### Features

* **nbd-cow:** add api surface for sandbox-fc integration ([#7307](https://github.com/vm0-ai/vm0/issues/7307)) ([042a3f6](https://github.com/vm0-ai/vm0/commit/042a3f6f3a21944565158ee87ae079185d5a89ec))
* **nbd-cow:** add minimal nbd server prototype with cow write buffer ([#7251](https://github.com/vm0-ai/vm0/issues/7251)) ([15498b7](https://github.com/vm0-ai/vm0/commit/15498b79a378b5661e5fd2ac05eaae64d81683c1))
* **sandbox-fc:** replace dm-snapshot with nbd-cow ([#7406](https://github.com/vm0-ai/vm0/issues/7406)) ([bc60c4b](https://github.com/vm0-ai/vm0/commit/bc60c4b01eaac368f7434d367784855b0b50479b))
