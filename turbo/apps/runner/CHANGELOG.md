# Changelog

## [2.8.0](https://github.com/vm0-ai/vm0/compare/runner-v2.7.1...runner-v2.8.0) (2026-01-14)


### Features

* **runner:** add codex and github cli to universal rootfs image ([#1187](https://github.com/vm0-ai/vm0/issues/1187)) ([a997751](https://github.com/vm0-ai/vm0/commit/a997751f33ff3caa06666301b6649f869cac3c83))

## [2.7.1](https://github.com/vm0-ai/vm0/compare/runner-v2.7.0...runner-v2.7.1) (2026-01-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.4.0

## [2.7.0](https://github.com/vm0-ai/vm0/compare/runner-v2.6.1...runner-v2.7.0) (2026-01-13)


### Features

* **runner:** add benchmark command for VM performance testing ([#1171](https://github.com/vm0-ai/vm0/issues/1171)) ([b7ab24f](https://github.com/vm0-ai/vm0/commit/b7ab24f1fa24bef883e662f1610fa69c5ee9d838))
* **runner:** add RED metrics infrastructure for runner operations ([#1168](https://github.com/vm0-ai/vm0/issues/1168)) ([0c46ee2](https://github.com/vm0-ai/vm0/commit/0c46ee224ac17a579aae53515588416987aa133e))
* **runner:** implement OverlayFS for rootfs to improve VM startup performance ([#1169](https://github.com/vm0-ai/vm0/issues/1169)) ([dca575b](https://github.com/vm0-ai/vm0/commit/dca575b43195656721126ddd378f478d5d986676))


### Bug Fixes

* **ci:** add shell: bash to cleanup runner step ([#1157](https://github.com/vm0-ai/vm0/issues/1157)) ([08d6c3e](https://github.com/vm0-ai/vm0/commit/08d6c3e8300196ead87bb40f97e37689637fd80a))
* **ci:** fix SSH key handling in cleanup.yml ([#1153](https://github.com/vm0-ai/vm0/issues/1153)) ([407cac9](https://github.com/vm0-ai/vm0/commit/407cac9ce4d0ebec9157654ed9260c1d01ef5f7d))
* **docs:** trigger production deployment for cli reference updates ([#1173](https://github.com/vm0-ai/vm0/issues/1173)) ([57baf42](https://github.com/vm0-ai/vm0/commit/57baf42d83a19652c9db2881e48f50fd1a0054e6))
* **metrics:** require AXIOM_DATASET_SUFFIX environment variable ([#1176](https://github.com/vm0-ai/vm0/issues/1176)) ([8ffe664](https://github.com/vm0-ai/vm0/commit/8ffe6647b239d357dadd59cf693269d19f3ab78c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.3.0

## [2.6.1](https://github.com/vm0-ai/vm0/compare/runner-v2.6.0...runner-v2.6.1) (2026-01-13)


### Bug Fixes

* **docs:** trigger production deployment for quick start updates ([#1142](https://github.com/vm0-ai/vm0/issues/1142)) ([f8fb029](https://github.com/vm0-ai/vm0/commit/f8fb029227bfc5151a5af30154a0cfb4bc28b480)), closes [#1118](https://github.com/vm0-ai/vm0/issues/1118)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.2.1

## [2.6.0](https://github.com/vm0-ai/vm0/compare/runner-v2.5.2...runner-v2.6.0) (2026-01-12)


### Features

* **lifecycle:** add postCreateCommand hook and hardcode working_dir ([#1077](https://github.com/vm0-ai/vm0/issues/1077)) ([86f7077](https://github.com/vm0-ai/vm0/commit/86f70777701d2d8715edec620e804c9ceeea0bad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.2.0

## [2.5.2](https://github.com/vm0-ai/vm0/compare/runner-v2.5.1...runner-v2.5.2) (2026-01-11)


### Bug Fixes

* **runner:** support SNI-only mode network logs in experimental_firewall ([#1088](https://github.com/vm0-ai/vm0/issues/1088)) ([c8308ef](https://github.com/vm0-ai/vm0/commit/c8308ef3490b03069b2a65253ab2209c9ba30eac)), closes [#1063](https://github.com/vm0-ai/vm0/issues/1063)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.1.1

## [2.5.1](https://github.com/vm0-ai/vm0/compare/runner-v2.5.0...runner-v2.5.1) (2026-01-11)


### Bug Fixes

* **ansible:** kill pm2 daemon after adding user to kvm group ([#1082](https://github.com/vm0-ai/vm0/issues/1082)) ([7d0b723](https://github.com/vm0-ai/vm0/commit/7d0b72308ae776b1f635d9e6c9fc7f94d90518c1))

## [2.5.0](https://github.com/vm0-ai/vm0/compare/runner-v2.4.2...runner-v2.5.0) (2026-01-10)


### Features

* **ci:** add multi-metal ci deployment with availability-based selection ([#1054](https://github.com/vm0-ai/vm0/issues/1054)) ([867b8f8](https://github.com/vm0-ai/vm0/commit/867b8f85b2c71868b05c87fb62f689c4714bc284))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.1.0

## [2.4.2](https://github.com/vm0-ai/vm0/compare/runner-v2.4.1...runner-v2.4.2) (2026-01-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.0.0

## [2.4.1](https://github.com/vm0-ai/vm0/compare/runner-v2.4.0...runner-v2.4.1) (2026-01-10)


### Bug Fixes

* disable DTS generation in watch mode to prevent memory crashes ([#1048](https://github.com/vm0-ai/vm0/issues/1048)) ([a26bc34](https://github.com/vm0-ai/vm0/commit/a26bc34ace19fc6d6dec5d3300f5551a6ddf4b60)), closes [#1041](https://github.com/vm0-ai/vm0/issues/1041)

## [2.4.0](https://github.com/vm0-ai/vm0/compare/runner-v2.3.2...runner-v2.4.0) (2026-01-10)


### Features

* **runner:** add experimental_firewall configuration with domain/IP rules ([#1027](https://github.com/vm0-ai/vm0/issues/1027)) ([18be77e](https://github.com/vm0-ai/vm0/commit/18be77e69f437e1f4cc536f7caf438bdf3321948))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.4.0

## [2.3.2](https://github.com/vm0-ai/vm0/compare/runner-v2.3.1...runner-v2.3.2) (2026-01-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.3.0

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
