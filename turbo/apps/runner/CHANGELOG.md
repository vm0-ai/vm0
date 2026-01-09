# Changelog

## [2.3.1](https://github.com/vm0-ai/vm0/compare/runner-v2.3.0...runner-v2.3.1) (2026-01-09)


### Bug Fixes

* **runner:** set NODE_EXTRA_CA_CERTS for network security mode ([#1005](https://github.com/vm0-ai/vm0/issues/1005)) ([8a6690c](https://github.com/vm0-ai/vm0/commit/8a6690c0f9abee6153efd3c41ee9ce9e7848b4b2))

## [2.3.0](https://github.com/vm0-ai/vm0/compare/runner-v2.2.2...runner-v2.3.0) (2026-01-09)


### Features

* **runner:** move network security proxy to runner host level ([#964](https://github.com/vm0-ai/vm0/issues/964)) ([6a77a51](https://github.com/vm0-ai/vm0/commit/6a77a51f8bec551b3ff8dec278456a2a53cd3aac))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.2.0

## [2.2.2](https://github.com/vm0-ai/vm0/compare/runner-v2.2.1...runner-v2.2.2) (2026-01-09)


### Bug Fixes

* **docs:** trigger release for documentation updates ([#993](https://github.com/vm0-ai/vm0/issues/993)) ([1f3e2be](https://github.com/vm0-ai/vm0/commit/1f3e2be18c74219b2954c0d98a6456bf35b055ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.1.1

## [2.2.1](https://github.com/vm0-ai/vm0/compare/runner-v2.2.0...runner-v2.2.1) (2026-01-08)


### Bug Fixes

* **ci:** use per-pr rootfs to prevent cross-pr interference ([#973](https://github.com/vm0-ai/vm0/issues/973)) ([d6bd661](https://github.com/vm0-ai/vm0/commit/d6bd661fae1352ee578844a79d34d2eefe8cf429))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.1.0

## [2.2.0](https://github.com/vm0-ai/vm0/compare/runner-v2.1.6...runner-v2.2.0) (2026-01-07)


### Features

* **runner:** add API connectivity health check ([#956](https://github.com/vm0-ai/vm0/issues/956)) ([9ddd6ff](https://github.com/vm0-ai/vm0/commit/9ddd6ff99fca79001b3c2b149a0ff82dfa017162))

## [2.1.6](https://github.com/vm0-ai/vm0/compare/runner-v2.1.5...runner-v2.1.6) (2026-01-07)


### Bug Fixes

* **runner:** handle pretty-printed JSON in drain script ([#954](https://github.com/vm0-ai/vm0/issues/954)) ([bc7784a](https://github.com/vm0-ai/vm0/commit/bc7784ae152d913d09c05b5524dc6d029f2a7b4b))

## [2.1.5](https://github.com/vm0-ai/vm0/compare/runner-v2.1.4...runner-v2.1.5) (2026-01-07)


### Bug Fixes

* **runner:** configure SSH keep-alive for long-running drain operations ([#952](https://github.com/vm0-ai/vm0/issues/952)) ([ed99196](https://github.com/vm0-ai/vm0/commit/ed9919632aea23afb5eb6538489bfe182a6a0ade))

## [2.1.4](https://github.com/vm0-ai/vm0/compare/runner-v2.1.3...runner-v2.1.4) (2026-01-07)


### Bug Fixes

* **runner:** use correct production API URL for runner deployment ([#950](https://github.com/vm0-ai/vm0/issues/950)) ([9624eed](https://github.com/vm0-ai/vm0/commit/9624eedcb5b15118ad9d11852055a65f9470585d))

## [2.1.3](https://github.com/vm0-ai/vm0/compare/runner-v2.1.2...runner-v2.1.3) (2026-01-07)


### Bug Fixes

* **runner:** use pm2 jlist for reliable PID detection ([#946](https://github.com/vm0-ai/vm0/issues/946)) ([1eb915b](https://github.com/vm0-ai/vm0/commit/1eb915bccf92412e235d0ed43e192b06f60a66c5))

## [2.1.2](https://github.com/vm0-ai/vm0/compare/runner-v2.1.1...runner-v2.1.2) (2026-01-07)


### Bug Fixes

* **runner:** standardize file header comment ([#944](https://github.com/vm0-ai/vm0/issues/944)) ([5e98888](https://github.com/vm0-ai/vm0/commit/5e98888527f6c7bdda9c5fa7bcdf94b5351336a9))

## [2.1.1](https://github.com/vm0-ai/vm0/compare/runner-v2.1.0...runner-v2.1.1) (2026-01-07)


### Bug Fixes

* **runner:** capitalize comment for consistency ([#941](https://github.com/vm0-ai/vm0/issues/941)) ([de2a5b7](https://github.com/vm0-ai/vm0/commit/de2a5b7ad501819a539fefcccc409f9a38ae2d23))

## [2.1.0](https://github.com/vm0-ai/vm0/compare/runner-v2.0.4...runner-v2.1.0) (2026-01-07)


### Features

* **runner:** add production deployment with Ansible rolling updates ([#935](https://github.com/vm0-ai/vm0/issues/935)) ([9e8fce6](https://github.com/vm0-ai/vm0/commit/9e8fce6480e754135dd61df146d961e14a2e9f7d))

## [2.0.4](https://github.com/vm0-ai/vm0/compare/runner-v2.0.3...runner-v2.0.4) (2026-01-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.0.2

## [2.0.3](https://github.com/vm0-ai/vm0/compare/runner-v2.0.2...runner-v2.0.3) (2026-01-06)


### Bug Fixes

* **runner:** connect as user instead of root via ssh ([#923](https://github.com/vm0-ai/vm0/issues/923)) ([80f999d](https://github.com/vm0-ai/vm0/commit/80f999d41e6f3e3fc54319bab31aae21623f1081))

## [2.0.2](https://github.com/vm0-ai/vm0/compare/runner-v2.0.1...runner-v2.0.2) (2026-01-05)


### Bug Fixes

* **runner:** use config server url instead of claim response ([#921](https://github.com/vm0-ai/vm0/issues/921)) ([f7b2b54](https://github.com/vm0-ai/vm0/commit/f7b2b54e61e2dafed797be155c5ed8200f5789eb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.0.1

## [2.0.1](https://github.com/vm0-ai/vm0/compare/runner-v2.0.0...runner-v2.0.1) (2026-01-05)


### Bug Fixes

* **runner:** use nohup for background agent execution ([#919](https://github.com/vm0-ai/vm0/issues/919)) ([52dc960](https://github.com/vm0-ai/vm0/commit/52dc9607f53e400aff1bf6bc003783af387103b8))

## [2.0.0](https://github.com/vm0-ai/vm0/compare/runner-v1.2.0...runner-v2.0.0) (2026-01-05)


### ⚠ BREAKING CHANGES

* **runner:** stub_mode config option removed

### Features

* **runner:** implement @vm0/runner MVP with firecracker execution ([#851](https://github.com/vm0-ai/vm0/issues/851)) ([d2437a2](https://github.com/vm0-ai/vm0/commit/d2437a2cdc7b9df240b26b5cbcb00bf17334b509))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.0.0

## [1.2.0](https://github.com/vm0-ai/vm0/compare/runner-v1.1.0...runner-v1.2.0) (2026-01-04)


### Features

* **docs:** trigger release for product philosophy page ([#884](https://github.com/vm0-ai/vm0/issues/884)) ([45ec3a2](https://github.com/vm0-ai/vm0/commit/45ec3a296b4d4ac01b4ac1f0536692d1626c7551))

## [1.1.0](https://github.com/vm0-ai/vm0/compare/runner-v1.0.0...runner-v1.1.0) (2025-12-31)


### Features

* **runner:** add package scaffolding and cli commands ([#843](https://github.com/vm0-ai/vm0/issues/843)) ([a9ea124](https://github.com/vm0-ai/vm0/commit/a9ea124067b62f3be6416bdff81c1920a438919c))


### Bug Fixes

* **cli:** revert system_prompt and system_skills feature ([#540](https://github.com/vm0-ai/vm0/issues/540)) ([b2254fe](https://github.com/vm0-ai/vm0/commit/b2254fec128a641106aa1db67faac938e39e3b3b))
* **runner:** add postbuild script for npm publish ([#852](https://github.com/vm0-ai/vm0/issues/852)) ([3318efe](https://github.com/vm0-ai/vm0/commit/3318efe26a6899542d2b79ba81910feab014789a))
* **runner:** sync version with npm registry ([#855](https://github.com/vm0-ai/vm0/issues/855)) ([5abd339](https://github.com/vm0-ai/vm0/commit/5abd33941ff091977c88317ba7f6a8cffc0564c5))

## [0.2.1](https://github.com/vm0-ai/vm0/compare/runner-v0.2.0...runner-v0.2.1) (2025-12-31)


### Bug Fixes

* **runner:** add postbuild script for npm publish ([#852](https://github.com/vm0-ai/vm0/issues/852)) ([3318efe](https://github.com/vm0-ai/vm0/commit/3318efe26a6899542d2b79ba81910feab014789a))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/runner-v0.1.0...runner-v0.2.0) (2025-12-31)


### Features

* **runner:** add package scaffolding and cli commands ([#843](https://github.com/vm0-ai/vm0/issues/843)) ([a9ea124](https://github.com/vm0-ai/vm0/commit/a9ea124067b62f3be6416bdff81c1920a438919c))


### Bug Fixes

* **cli:** revert system_prompt and system_skills feature ([#540](https://github.com/vm0-ai/vm0/issues/540)) ([b2254fe](https://github.com/vm0-ai/vm0/commit/b2254fec128a641106aa1db67faac938e39e3b3b))
