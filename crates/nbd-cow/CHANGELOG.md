# Changelog

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
