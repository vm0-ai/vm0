# Changelog

## [0.7.5](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.4...ably-subscriber-v0.7.5) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.7.4](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.3...ably-subscriber-v0.7.4) (2026-05-01)


### Bug Fixes

* harden ably disconnect handling ([#11656](https://github.com/vm0-ai/vm0/issues/11656)) ([c0c50d8](https://github.com/vm0-ai/vm0/commit/c0c50d88154f7ad74af791fc2df9e5a8db609418))

## [0.7.3](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.2...ably-subscriber-v0.7.3) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.7.2](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.1...ably-subscriber-v0.7.2) (2026-04-16)


### Bug Fixes

* **ably-subscriber:** reset last_reattach_at after successful reconnect ([#9660](https://github.com/vm0-ai/vm0/issues/9660)) ([57a18fd](https://github.com/vm0-ai/vm0/commit/57a18fd25cec4179c85f6666b40b7b1593709792)), closes [#9654](https://github.com/vm0-ai/vm0/issues/9654)

## [0.7.1](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.7.0...ably-subscriber-v0.7.1) (2026-04-13)

## [0.7.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.5...ably-subscriber-v0.7.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.6.5](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.4...ably-subscriber-v0.6.5) (2026-03-29)


### Bug Fixes

* **crates:** update sha2/hmac usage for digest 0.11 compatibility ([#7101](https://github.com/vm0-ai/vm0/issues/7101)) ([cbded46](https://github.com/vm0-ai/vm0/commit/cbded46e78c8d3ed060e96f79f15cd38ee1cf9dc))

## [0.6.4](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.3...ably-subscriber-v0.6.4) (2026-03-17)


### Refactoring

* **rust:** replace inline crate:: paths with top-level use imports ([#5061](https://github.com/vm0-ai/vm0/issues/5061)) ([149aaa0](https://github.com/vm0-ai/vm0/commit/149aaa09ca2bf69ffb1bc35471ba813e5884e534)), closes [#5038](https://github.com/vm0-ai/vm0/issues/5038)

## [0.6.3](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.2...ably-subscriber-v0.6.3) (2026-02-27)


### Bug Fixes

* **ably-subscriber:** align protocol handling with ably-js sdk ([#3275](https://github.com/vm0-ai/vm0/issues/3275)) ([7b01abf](https://github.com/vm0-ai/vm0/commit/7b01abf76b978416aaf7f6c7ccc3ee6efb94e1c3)), closes [#3274](https://github.com/vm0-ai/vm0/issues/3274)

## [0.6.2](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.1...ably-subscriber-v0.6.2) (2026-02-27)


### Bug Fixes

* **ably-subscriber:** always re-attach channel after reconnect to prevent zombie subscriptions ([#3271](https://github.com/vm0-ai/vm0/issues/3271)) ([0e449cb](https://github.com/vm0-ai/vm0/commit/0e449cb1ef1cb2e54fc05675f6634a0659923497))

## [0.6.1](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.6.0...ably-subscriber-v0.6.1) (2026-02-26)


### Bug Fixes

* **ably-subscriber:** handle close frames and skip backoff on clean disconnect ([#3263](https://github.com/vm0-ai/vm0/issues/3263)) ([caddb21](https://github.com/vm0-ai/vm0/commit/caddb213b4df4dada54f8d368083ada6a6d9a287)), closes [#3262](https://github.com/vm0-ai/vm0/issues/3262)

## [0.6.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.5.0...ably-subscriber-v0.6.0) (2026-02-23)


### Features

* **ably-subscriber:** add dropped message counter for backpressure observability ([#2913](https://github.com/vm0-ai/vm0/issues/2913)) ([94325b9](https://github.com/vm0-ai/vm0/commit/94325b9481f84026e046b04a96ca7878702c8080)), closes [#2909](https://github.com/vm0-ai/vm0/issues/2909)
* **ably-subscriber:** add rust ably realtime subscribe-only sdk ([#2790](https://github.com/vm0-ai/vm0/issues/2790)) ([d1f630c](https://github.com/vm0-ai/vm0/commit/d1f630cb2d30aab52e46a7aba20f9495da00d2cd))
* **ably-subscriber:** extract timing constants into configurable struct ([#2938](https://github.com/vm0-ai/vm0/issues/2938)) ([0ac4072](https://github.com/vm0-ai/vm0/commit/0ac407272ac166f134d2ca61874f58214a966849))


### Bug Fixes

* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.4.0...ably-subscriber-v0.5.0) (2026-02-23)


### Features

* **ably-subscriber:** add dropped message counter for backpressure observability ([#2913](https://github.com/vm0-ai/vm0/issues/2913)) ([94325b9](https://github.com/vm0-ai/vm0/commit/94325b9481f84026e046b04a96ca7878702c8080)), closes [#2909](https://github.com/vm0-ai/vm0/issues/2909)
* **ably-subscriber:** add rust ably realtime subscribe-only sdk ([#2790](https://github.com/vm0-ai/vm0/issues/2790)) ([d1f630c](https://github.com/vm0-ai/vm0/commit/d1f630cb2d30aab52e46a7aba20f9495da00d2cd))
* **ably-subscriber:** extract timing constants into configurable struct ([#2938](https://github.com/vm0-ai/vm0/issues/2938)) ([0ac4072](https://github.com/vm0-ai/vm0/commit/0ac407272ac166f134d2ca61874f58214a966849))


### Bug Fixes

* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.3.0...ably-subscriber-v0.4.0) (2026-02-22)


### Features

* **ably-subscriber:** add dropped message counter for backpressure observability ([#2913](https://github.com/vm0-ai/vm0/issues/2913)) ([94325b9](https://github.com/vm0-ai/vm0/commit/94325b9481f84026e046b04a96ca7878702c8080)), closes [#2909](https://github.com/vm0-ai/vm0/issues/2909)
* **ably-subscriber:** add rust ably realtime subscribe-only sdk ([#2790](https://github.com/vm0-ai/vm0/issues/2790)) ([d1f630c](https://github.com/vm0-ai/vm0/commit/d1f630cb2d30aab52e46a7aba20f9495da00d2cd))
* **ably-subscriber:** extract timing constants into configurable struct ([#2938](https://github.com/vm0-ai/vm0/issues/2938)) ([0ac4072](https://github.com/vm0-ai/vm0/commit/0ac407272ac166f134d2ca61874f58214a966849))


### Bug Fixes

* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.2.0...ably-subscriber-v0.3.0) (2026-02-22)


### Features

* **ably-subscriber:** add dropped message counter for backpressure observability ([#2913](https://github.com/vm0-ai/vm0/issues/2913)) ([94325b9](https://github.com/vm0-ai/vm0/commit/94325b9481f84026e046b04a96ca7878702c8080)), closes [#2909](https://github.com/vm0-ai/vm0/issues/2909)
* **ably-subscriber:** add rust ably realtime subscribe-only sdk ([#2790](https://github.com/vm0-ai/vm0/issues/2790)) ([d1f630c](https://github.com/vm0-ai/vm0/commit/d1f630cb2d30aab52e46a7aba20f9495da00d2cd))
* **ably-subscriber:** extract timing constants into configurable struct ([#2938](https://github.com/vm0-ai/vm0/issues/2938)) ([0ac4072](https://github.com/vm0-ai/vm0/commit/0ac407272ac166f134d2ca61874f58214a966849))


### Bug Fixes

* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v0.1.0...ably-subscriber-v0.2.0) (2026-02-22)


### Features

* **ably-subscriber:** add dropped message counter for backpressure observability ([#2913](https://github.com/vm0-ai/vm0/issues/2913)) ([94325b9](https://github.com/vm0-ai/vm0/commit/94325b9481f84026e046b04a96ca7878702c8080)), closes [#2909](https://github.com/vm0-ai/vm0/issues/2909)
* **ably-subscriber:** add rust ably realtime subscribe-only sdk ([#2790](https://github.com/vm0-ai/vm0/issues/2790)) ([d1f630c](https://github.com/vm0-ai/vm0/commit/d1f630cb2d30aab52e46a7aba20f9495da00d2cd))
* **ably-subscriber:** extract timing constants into configurable struct ([#2938](https://github.com/vm0-ai/vm0/issues/2938)) ([0ac4072](https://github.com/vm0-ai/vm0/commit/0ac407272ac166f134d2ca61874f58214a966849))


### Bug Fixes

* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))
