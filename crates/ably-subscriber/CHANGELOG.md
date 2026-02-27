# Changelog

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
