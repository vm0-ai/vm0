# Changelog

## [0.5.0](https://github.com/vm0-ai/vm0/compare/block-cow-v0.4.1...block-cow-v0.5.0) (2026-04-01)


### Features

* **runner:** run runner as root, remove all sudo wrappers ([#7443](https://github.com/vm0-ai/vm0/issues/7443)) ([66e9af9](https://github.com/vm0-ai/vm0/commit/66e9af9846cfdc044ec4203b04e784bbc5ea305d))

## [0.4.1](https://github.com/vm0-ai/vm0/compare/block-cow-v0.4.0...block-cow-v0.4.1) (2026-03-30)


### Bug Fixes

* **block-cow:** sync writes before dm teardown in restore test ([#7209](https://github.com/vm0-ai/vm0/issues/7209)) ([02887ea](https://github.com/vm0-ai/vm0/commit/02887ea738eec45285b568a72adc3f5c7948cdb6))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/block-cow-v0.3.0...block-cow-v0.4.0) (2026-03-29)


### Features

* **sandbox-fc:** add cow pool to pre-warm dm-snapshot resources ([#7116](https://github.com/vm0-ai/vm0/issues/7116)) ([c841e61](https://github.com/vm0-ai/vm0/commit/c841e61bfc653d143cd6a022f03ca638b2bf5a42))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/block-cow-v0.2.0...block-cow-v0.3.0) (2026-03-29)


### Features

* **sandbox-fc:** replace guest-side overlayfs with host-side dm-snapshot cow ([#6521](https://github.com/vm0-ai/vm0/issues/6521)) ([8f6a118](https://github.com/vm0-ai/vm0/commit/8f6a1185bfd6dd4604687662f3d03be6076ea71f))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/block-cow-v0.1.0...block-cow-v0.2.0) (2026-03-24)


### Features

* **runner:** add block-cow crate for host-side copy-on-write via dm-snapshot ([#6268](https://github.com/vm0-ai/vm0/issues/6268)) ([09f2728](https://github.com/vm0-ai/vm0/commit/09f27284f331a1ee986b310a728749065d9478be))
