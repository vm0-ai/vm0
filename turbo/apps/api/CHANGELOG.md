# Changelog

Releases before September 2026 are archived by month:

- [2026-08](changelog/2026-08.md)
- [2026-07](changelog/2026-07.md)
- [2026-06](changelog/2026-06.md)
- [2026-05](changelog/2026-05.md)
- [2026-04](changelog/2026-04.md)

## [1.554.0](https://github.com/vm0-ai/vm0/compare/api-v1.553.1...api-v1.554.0) (2026-09-06)


### Features

* add voice input model preferences and honor lab overrides ([#31982](https://github.com/vm0-ai/vm0/issues/31982)) ([7b114d5](https://github.com/vm0-ai/vm0/commit/7b114d5b3b2683d2987daf09d651403f2951dc4c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.408.0
    * @okouai/core bumped to 8.625.11
    * @okouai/db bumped to 1.243.0
    * @okouai/pi-agent-runtime bumped to 1.21.3

## [1.553.1](https://github.com/vm0-ai/vm0/compare/api-v1.553.0...api-v1.553.1) (2026-09-06)


### Bug Fixes

* make pi memory citations safe across version skew ([#31976](https://github.com/vm0-ai/vm0/issues/31976)) ([63d4035](https://github.com/vm0-ai/vm0/commit/63d40353754fa03271b61b84d42ec3ee8cfe88f5))


### Refactoring

* **connectors:** remove single-account compatibility contract ([#31978](https://github.com/vm0-ai/vm0/issues/31978)) ([b0c87cb](https://github.com/vm0-ai/vm0/commit/b0c87cb69b860ef502e5722df642029ae9efd8f5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.407.1
    * @okouai/core bumped to 8.625.10
    * @okouai/db bumped to 1.242.2
    * @okouai/pi-agent-runtime bumped to 1.21.2

## [1.553.0](https://github.com/vm0-ai/vm0/compare/api-v1.552.0...api-v1.553.0) (2026-09-06)


### Features

* add cursor context and light polish to voice input ([#31968](https://github.com/vm0-ai/vm0/issues/31968)) ([12d0c92](https://github.com/vm0-ai/vm0/commit/12d0c9232684f9223ade010c40f3fad752b079df))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.407.0
    * @okouai/core bumped to 8.625.9
    * @okouai/db bumped to 1.242.1
    * @okouai/pi-agent-runtime bumped to 1.21.1

## [1.552.0](https://github.com/vm0-ai/vm0/compare/api-v1.551.9...api-v1.552.0) (2026-09-06)


### Features

* **pi-memory:** hide citation envelopes and preserve provenance ([#31965](https://github.com/vm0-ai/vm0/issues/31965)) ([5cecc7c](https://github.com/vm0-ai/vm0/commit/5cecc7cbcebb48899e4a9b251f209bbfb176f3f9))


### Performance Improvements

* avoid duplicate pinned reverse-template guide load ([#31969](https://github.com/vm0-ai/vm0/issues/31969)) ([e8843ea](https://github.com/vm0-ai/vm0/commit/e8843ea6642f706a2214569cbe4726164ae7a766))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.406.0
    * @okouai/core bumped to 8.625.8
    * @okouai/db bumped to 1.242.0
    * @okouai/pi-agent-runtime bumped to 1.21.0

## [1.551.9](https://github.com/vm0-ai/vm0/compare/api-v1.551.8...api-v1.551.9) (2026-09-06)


### Refactoring

* **db:** require explicit computer use host product identity ([#31961](https://github.com/vm0-ai/vm0/issues/31961)) ([af484c6](https://github.com/vm0-ai/vm0/commit/af484c62ebce6435e6382b9925d4a13107be877a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.625.7
    * @okouai/db bumped to 1.241.13

## [1.551.8](https://github.com/vm0-ai/vm0/compare/api-v1.551.7...api-v1.551.8) (2026-09-05)


### Bug Fixes

* settle private pi maintenance at the generic checkpoint boundary ([#31947](https://github.com/vm0-ai/vm0/issues/31947)) ([2db67fc](https://github.com/vm0-ai/vm0/commit/2db67fc8be4f1fa863c4faf8ed4905acfc65cdb5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.7
    * @okouai/core bumped to 8.625.6
    * @okouai/db bumped to 1.241.12
    * @okouai/pi-agent-runtime bumped to 1.20.6

## [1.551.7](https://github.com/vm0-ai/vm0/compare/api-v1.551.6...api-v1.551.7) (2026-09-05)


### Bug Fixes

* **api:** fail incomplete pi api-first no-tool output ([#31945](https://github.com/vm0-ai/vm0/issues/31945)) ([ea412a3](https://github.com/vm0-ai/vm0/commit/ea412a323b9c31290af23957387c9fd8b1cfebd4))

## [1.551.6](https://github.com/vm0-ai/vm0/compare/api-v1.551.5...api-v1.551.6) (2026-09-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.241.11

## [1.551.5](https://github.com/vm0-ai/vm0/compare/api-v1.551.4...api-v1.551.5) (2026-09-05)


### Bug Fixes

* finish voice input silently when no speech is detected ([#31933](https://github.com/vm0-ai/vm0/issues/31933)) ([b37822c](https://github.com/vm0-ai/vm0/commit/b37822c16ec7479dfc1fa1ecdefc85dd8ee53a6e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.6
    * @okouai/core bumped to 8.625.5
    * @okouai/db bumped to 1.241.10
    * @okouai/pi-agent-runtime bumped to 1.20.5

## [1.551.4](https://github.com/vm0-ai/vm0/compare/api-v1.551.3...api-v1.551.4) (2026-09-05)


### Bug Fixes

* **billing:** preserve managed allowance under shared debt ([#31851](https://github.com/vm0-ai/vm0/issues/31851)) ([eebda82](https://github.com/vm0-ai/vm0/commit/eebda828b10f54ee455826c3715222f6a3356d43))


### Refactoring

* **pi-memory:** publish phase 2 through sandbox checkpoints ([#31912](https://github.com/vm0-ai/vm0/issues/31912)) ([57ba1c3](https://github.com/vm0-ai/vm0/commit/57ba1c398f21dc34348bf0c6f20d12cd88283b7f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.5
    * @okouai/core bumped to 8.625.4
    * @okouai/db bumped to 1.241.9
    * @okouai/pi-agent-runtime bumped to 1.20.4

## [1.551.3](https://github.com/vm0-ai/vm0/compare/api-v1.551.2...api-v1.551.3) (2026-09-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/pi-agent-runtime bumped to 1.20.3

## [1.551.2](https://github.com/vm0-ai/vm0/compare/api-v1.551.1...api-v1.551.2) (2026-09-05)


### Bug Fixes

* **pi:** validate native session parent graphs before traversal ([#31910](https://github.com/vm0-ai/vm0/issues/31910)) ([9a84dc8](https://github.com/vm0-ai/vm0/commit/9a84dc87ccba2f12c6e8e7e16bbc6eea1d4c8501))


### Refactoring

* **platform:** rename browser globals and clerk bootstrap to okou ([#31904](https://github.com/vm0-ai/vm0/issues/31904)) ([d0e609d](https://github.com/vm0-ai/vm0/commit/d0e609d122cc970ebebad59a800836b311d4002b))
* rename module-scoped brand identifiers ([#31906](https://github.com/vm0-ai/vm0/issues/31906)) ([003db23](https://github.com/vm0-ai/vm0/commit/003db2336542de3fc504cbbc64e9ea26ec88a109))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.4
    * @okouai/connectors bumped to 3.3.6
    * @okouai/core bumped to 8.625.3
    * @okouai/db bumped to 1.241.8
    * @okouai/pi-agent-runtime bumped to 1.20.2

## [1.551.1](https://github.com/vm0-ai/vm0/compare/api-v1.551.0...api-v1.551.1) (2026-09-05)


### Bug Fixes

* **pi:** normalize native fast requests to priority ([#31895](https://github.com/vm0-ai/vm0/issues/31895)) ([0c910e8](https://github.com/vm0-ai/vm0/commit/0c910e8b80be2c91ead2bb04101b68f3b1d8647e)), closes [#31885](https://github.com/vm0-ai/vm0/issues/31885)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.625.2
    * @okouai/db bumped to 1.241.7
    * @okouai/pi-agent-runtime bumped to 1.20.1

## [1.551.0](https://github.com/vm0-ai/vm0/compare/api-v1.550.0...api-v1.551.0) (2026-09-05)


### Features

* **pi-memory:** add sandbox-local ad hoc notes ([#31878](https://github.com/vm0-ai/vm0/issues/31878)) ([1b70c02](https://github.com/vm0-ai/vm0/commit/1b70c028318063e0d90163eabb80f30868cd7dbb))


### Bug Fixes

* **api:** double connector catalog capacity ([#31882](https://github.com/vm0-ai/vm0/issues/31882)) ([647858d](https://github.com/vm0-ai/vm0/commit/647858d28bd4a8049b681305c168093fc3feca91))


### Refactoring

* unify voice input feature switches ([#31884](https://github.com/vm0-ai/vm0/issues/31884)) ([4537935](https://github.com/vm0-ai/vm0/commit/453793580a047239a98c91d92568b56898e58c25))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.3
    * @okouai/connectors bumped to 3.3.5
    * @okouai/core bumped to 8.625.1
    * @okouai/db bumped to 1.241.6
    * @okouai/pi-agent-runtime bumped to 1.20.0

## [1.550.0](https://github.com/vm0-ai/vm0/compare/api-v1.549.0...api-v1.550.0) (2026-09-05)


### Features

* **api:** route api-key Terra Fast through Pi ([#31868](https://github.com/vm0-ai/vm0/issues/31868)) ([32ee834](https://github.com/vm0-ai/vm0/commit/32ee834ce0466969e101ec75c24cda8f8068fb1f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/pi-agent-runtime bumped to 1.19.0

## [1.549.0](https://github.com/vm0-ai/vm0/compare/api-v1.548.1...api-v1.549.0) (2026-09-05)


### Features

* **api:** route subscription Terra Fast through Pi ([#31857](https://github.com/vm0-ai/vm0/issues/31857)) ([109ef62](https://github.com/vm0-ai/vm0/commit/109ef6256ba3e8c59eeb0f6754d71bd6536d75b7))


### Refactoring

* **voice:** remove draft compatibility and encoded audio fallback ([#31792](https://github.com/vm0-ai/vm0/issues/31792)) ([83979d4](https://github.com/vm0-ai/vm0/commit/83979d4a271483500bce0e63f837b5a9db279262))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.2
    * @okouai/core bumped to 8.625.0
    * @okouai/db bumped to 1.241.5
    * @okouai/pi-agent-runtime bumped to 1.18.0

## [1.548.1](https://github.com/vm0-ai/vm0/compare/api-v1.548.0...api-v1.548.1) (2026-09-05)


### Bug Fixes

* **api:** require account-explicit app bundles ([#31843](https://github.com/vm0-ai/vm0/issues/31843)) ([9ce1640](https://github.com/vm0-ai/vm0/commit/9ce1640f9357d8516fd3f4e97b1a3aea60c35f64))
* **api:** reuse sessions by runtime and model family ([#31796](https://github.com/vm0-ai/vm0/issues/31796)) ([6fd1c6f](https://github.com/vm0-ai/vm0/commit/6fd1c6ff18aa9bbeaf7d55c833bb1336d193be7a))


### Refactoring

* **api:** rename the zero dispatch telemetry action names to agent ([#31846](https://github.com/vm0-ai/vm0/issues/31846)) ([488bb99](https://github.com/vm0-ai/vm0/commit/488bb9902b1c4abace6024ad3611778f8fb59179)), closes [#31842](https://github.com/vm0-ai/vm0/issues/31842)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.1
    * @okouai/core bumped to 8.624.0
    * @okouai/db bumped to 1.241.4
    * @okouai/pi-agent-runtime bumped to 1.17.1

## [1.548.0](https://github.com/vm0-ai/vm0/compare/api-v1.547.1...api-v1.548.0) (2026-09-05)


### Features

* **pi:** add dialect-aware fast carrier compatibility ([#31839](https://github.com/vm0-ai/vm0/issues/31839)) ([444bfe5](https://github.com/vm0-ai/vm0/commit/444bfe5a6f04edb5ba3ccbc90a0895e7ca4a44d8))


### Refactoring

* **api:** rename the vm0 built-in model vocabulary to built-in ([#31834](https://github.com/vm0-ai/vm0/issues/31834)) ([1cfe7fc](https://github.com/vm0-ai/vm0/commit/1cfe7fccc9c89a46171f6aad08750cb6dab8865b)), closes [#31818](https://github.com/vm0-ai/vm0/issues/31818)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.405.0
    * @okouai/core bumped to 8.623.2
    * @okouai/db bumped to 1.241.3
    * @okouai/pi-agent-runtime bumped to 1.17.0

## [1.547.1](https://github.com/vm0-ai/vm0/compare/api-v1.547.0...api-v1.547.1) (2026-09-05)


### Bug Fixes

* **api:** honor active run credit admission in okou gates ([#31777](https://github.com/vm0-ai/vm0/issues/31777)) ([adeb43c](https://github.com/vm0-ai/vm0/commit/adeb43c245bbcdacd79d1619dc34cf6378921951))


### Refactoring

* **api:** retire the legacy zero run vocabulary ([#31811](https://github.com/vm0-ai/vm0/issues/31811)) ([45d2e0f](https://github.com/vm0-ai/vm0/commit/45d2e0fad1c557d5c05d16074322b52ddf1c508a)), closes [#26877](https://github.com/vm0-ai/vm0/issues/26877)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.404.1
    * @okouai/core bumped to 8.623.1
    * @okouai/db bumped to 1.241.2
    * @okouai/pi-agent-runtime bumped to 1.16.6

## [1.547.0](https://github.com/vm0-ai/vm0/compare/api-v1.546.0...api-v1.547.0) (2026-09-05)


### Features

* **cli:** support legacy ppt template sources ([#31755](https://github.com/vm0-ai/vm0/issues/31755)) ([6eeb085](https://github.com/vm0-ai/vm0/commit/6eeb0852534423737b6d14e0b2235cbbb3ed4ff0))


### Bug Fixes

* retire claude fable 5 from model selection ([#31790](https://github.com/vm0-ai/vm0/issues/31790)) ([86185af](https://github.com/vm0-ai/vm0/commit/86185affdd253f409dad6d217aa5b0f16ac5086c))


### Refactoring

* **chat:** remove prefixed timeout fallback ([#31778](https://github.com/vm0-ai/vm0/issues/31778)) ([3f8dad2](https://github.com/vm0-ai/vm0/commit/3f8dad2589c9eb19acd9fc3f00dffda12d20144f))
* **eslint:** rename the internal lint plugin namespace to okou ([#31806](https://github.com/vm0-ai/vm0/issues/31806)) ([314590e](https://github.com/vm0-ai/vm0/commit/314590ea8d2671714555db2a4cfeb035994eb779)), closes [#31799](https://github.com/vm0-ai/vm0/issues/31799)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.404.0
    * @okouai/connectors bumped to 3.3.4
    * @okouai/core bumped to 8.623.0
    * @okouai/db bumped to 1.241.1
    * @okouai/pi-agent-runtime bumped to 1.16.5

## [1.546.0](https://github.com/vm0-ai/vm0/compare/api-v1.545.2...api-v1.546.0) (2026-09-04)


### Features

* add intro video heygen renderer and voice services ([#31658](https://github.com/vm0-ai/vm0/issues/31658)) ([1917a5f](https://github.com/vm0-ai/vm0/commit/1917a5fa59ee61fdb44f0d1822804a256009ef88))


### Refactoring

* remove expired deployment compatibility ([#31781](https://github.com/vm0-ai/vm0/issues/31781)) ([fe72e06](https://github.com/vm0-ai/vm0/commit/fe72e065718d2caeea5b45dd71008b0ad777459e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.403.0
    * @okouai/core bumped to 8.622.0
    * @okouai/db bumped to 1.241.0
    * @okouai/pi-agent-runtime bumped to 1.16.4

## [1.545.2](https://github.com/vm0-ai/vm0/compare/api-v1.545.1...api-v1.545.2) (2026-09-04)


### Bug Fixes

* **agent:** align avatar edits with visibility permissions ([#31731](https://github.com/vm0-ai/vm0/issues/31731)) ([8cf8b09](https://github.com/vm0-ai/vm0/commit/8cf8b094a80ea861fbb366df0cc33323e1cf9846))
* **api:** preserve admitted run credit access ([#31726](https://github.com/vm0-ai/vm0/issues/31726)) ([c5f4085](https://github.com/vm0-ai/vm0/commit/c5f4085b83007baa097682f58fb47dfc647b923f))


### Refactoring

* **api:** remove legacy custom connector oauth readers ([#31751](https://github.com/vm0-ai/vm0/issues/31751)) ([3a13b3a](https://github.com/vm0-ai/vm0/commit/3a13b3ad6564d96d6a721287ed2e816c5b1a60f6))
* remove office preview response compatibility ([#31727](https://github.com/vm0-ai/vm0/issues/31727)) ([c598a28](https://github.com/vm0-ai/vm0/commit/c598a28d589959e971383a380691f80911c130e2))


### Performance Improvements

* move type checking to the typescript 7 native compiler ([#31716](https://github.com/vm0-ai/vm0/issues/31716)) ([aa41353](https://github.com/vm0-ai/vm0/commit/aa41353c983fbc0212ec1e06aa34b56a71bf2166))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.402.2
    * @okouai/connectors bumped to 3.3.3
    * @okouai/core bumped to 8.621.2
    * @okouai/db bumped to 1.240.7
    * @okouai/pi-agent-runtime bumped to 1.16.3

## [1.545.1](https://github.com/vm0-ai/vm0/compare/api-v1.545.0...api-v1.545.1) (2026-09-04)


### Refactoring

* **registry:** trim presentation download response ([#31707](https://github.com/vm0-ai/vm0/issues/31707)) ([98a36b7](https://github.com/vm0-ai/vm0/commit/98a36b7269d543f8009f8cbda307d678d391cda9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.402.1
    * @okouai/core bumped to 8.621.1
    * @okouai/db bumped to 1.240.6
    * @okouai/pi-agent-runtime bumped to 1.16.2

## [1.545.0](https://github.com/vm0-ai/vm0/compare/api-v1.544.0...api-v1.545.0) (2026-09-04)


### Features

* add gpt-6 astra support ([#31558](https://github.com/vm0-ai/vm0/issues/31558)) ([004ea48](https://github.com/vm0-ai/vm0/commit/004ea48590eba7c66af3a9b156e3daba7411793b))
* **app:** bootstrap first api responses in the app shell ([#31665](https://github.com/vm0-ai/vm0/issues/31665)) ([21e3a85](https://github.com/vm0-ai/vm0/commit/21e3a858cddd1489337cd47dc010dd93fee7cc6d))
* **pi:** activate Terra API-key routes ([#31717](https://github.com/vm0-ai/vm0/issues/31717)) ([9539c77](https://github.com/vm0-ai/vm0/commit/9539c777bf68f926cb29efc6a6e06e79f3bc1310))


### Bug Fixes

* **api:** classify Fal image generation failures ([#31690](https://github.com/vm0-ai/vm0/issues/31690)) ([0faf86b](https://github.com/vm0-ai/vm0/commit/0faf86b5bbd09d2b3480261936e8b3712d443181))
* **api:** give reasoning-enabled fast-path calls enough token budget ([#31715](https://github.com/vm0-ai/vm0/issues/31715)) ([4dbd97e](https://github.com/vm0-ai/vm0/commit/4dbd97e443a2999e13c4cbf9af31f6454b3dbac7))
* **chat:** preserve structured runner timeout recovery ([#31711](https://github.com/vm0-ai/vm0/issues/31711)) ([1a6f7d2](https://github.com/vm0-ai/vm0/commit/1a6f7d27e30421af781efa7ac3025e46e39286dd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.402.0
    * @okouai/core bumped to 8.621.0
    * @okouai/db bumped to 1.240.5
    * @okouai/pi-agent-runtime bumped to 1.16.1

## [1.544.0](https://github.com/vm0-ai/vm0/compare/api-v1.543.0...api-v1.544.0) (2026-09-04)


### Features

* add avatar composer v2 ([#31526](https://github.com/vm0-ai/vm0/issues/31526)) ([0812c8b](https://github.com/vm0-ai/vm0/commit/0812c8bfb4c4d8a8e416717573a3d5a6609347f8))
* add progressive artifact preview switch ([#31682](https://github.com/vm0-ai/vm0/issues/31682)) ([8aa24e8](https://github.com/vm0-ai/vm0/commit/8aa24e8b2decb7545ff6bc44c7575bbeac19c188))
* **core:** roll out connector accounts to all users ([#31608](https://github.com/vm0-ai/vm0/issues/31608)) ([aca7cf7](https://github.com/vm0-ai/vm0/commit/aca7cf7ea9e6a36a37cfedbfcd987394f977add5))
* **pi:** activate ChatGPT subscription Terra route ([#31586](https://github.com/vm0-ai/vm0/issues/31586)) ([722c869](https://github.com/vm0-ai/vm0/commit/722c869fe1f737b69c5197dee6aa1c005dd594d8))
* **registry:** pull current presentation templates ([#31614](https://github.com/vm0-ai/vm0/issues/31614)) ([0d9edac](https://github.com/vm0-ai/vm0/commit/0d9edacec1340f700362a7353564bab015c40cf6))


### Bug Fixes

* **api:** defer schedule automation threads ([#31601](https://github.com/vm0-ai/vm0/issues/31601)) ([21b99b0](https://github.com/vm0-ai/vm0/commit/21b99b0f115c21ab451c8f200f60c6998ef1c4d5))
* **api:** require useful recommended follow-ups ([#31611](https://github.com/vm0-ai/vm0/issues/31611)) ([753a510](https://github.com/vm0-ai/vm0/commit/753a510101be913734b267c423d4dac55431a3c9))
* **api:** retry transient clerk read failures ([#31615](https://github.com/vm0-ai/vm0/issues/31615)) ([9645a0d](https://github.com/vm0-ai/vm0/commit/9645a0d5e3242386bac9d4d2a4093818a6c155af))
* **api:** set limited-free onboarding credits to 1,000 ([#31622](https://github.com/vm0-ai/vm0/issues/31622)) ([29fd38d](https://github.com/vm0-ai/vm0/commit/29fd38d7d108fda3b27d058433c0f62f808da419))
* **ci:** repair app worker production promotion ([#31672](https://github.com/vm0-ai/vm0/issues/31672)) ([29317b9](https://github.com/vm0-ai/vm0/commit/29317b9ac9ccd4d72c2fc4da0a465e234acef032))
* **email:** use workflow display name as result subject ([#31578](https://github.com/vm0-ai/vm0/issues/31578)) ([3af69be](https://github.com/vm0-ai/vm0/commit/3af69be89f11ea6fac27cc52330f567439312bea))
* keep intro video guidance out of user prompts ([#31673](https://github.com/vm0-ai/vm0/issues/31673)) ([40a2a9d](https://github.com/vm0-ai/vm0/commit/40a2a9d5a99d27eef49fcab8547af52bd43055e0))
* localize automatic mcp oauth errors ([#31626](https://github.com/vm0-ai/vm0/issues/31626)) ([4420f93](https://github.com/vm0-ai/vm0/commit/4420f93d5ba7aba8c54ab46e0d5305674fb2588a))


### Refactoring

* **api:** consolidate openrouter fast-path callers onto the shared helper ([#31653](https://github.com/vm0-ai/vm0/issues/31653)) ([9611380](https://github.com/vm0-ai/vm0/commit/961138077f417c43ce1f23c43cc494b46c8fa3cd)), closes [#31619](https://github.com/vm0-ai/vm0/issues/31619)
* **api:** remove rollout oauth state fallbacks ([#31609](https://github.com/vm0-ai/vm0/issues/31609)) ([df9f44c](https://github.com/vm0-ai/vm0/commit/df9f44c98af3fa1e063f81bb4902642446b986df))
* **api:** switch custom oauth state discriminator ([#31547](https://github.com/vm0-ai/vm0/issues/31547)) ([f0cbf9d](https://github.com/vm0-ai/vm0/commit/f0cbf9d82d296bb6cb306c2e6b8942d014ee89af))


### Performance Improvements

* **api:** switch the fast-path llm to gemini-3.8-flash with pinned reasoning effort ([#31698](https://github.com/vm0-ai/vm0/issues/31698)) ([a849749](https://github.com/vm0-ai/vm0/commit/a849749df5c93d55c9da477359189d0e316aac97)), closes [#31694](https://github.com/vm0-ai/vm0/issues/31694)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.401.0
    * @okouai/core bumped to 8.620.0
    * @okouai/db bumped to 1.240.4
    * @okouai/pi-agent-runtime bumped to 1.16.0

## [1.543.0](https://github.com/vm0-ai/vm0/compare/api-v1.542.1...api-v1.543.0) (2026-09-04)


### Features

* **app:** enable production clerk edge sessions ([#31636](https://github.com/vm0-ai/vm0/issues/31636)) ([367559e](https://github.com/vm0-ai/vm0/commit/367559efb7c8ffeb8d1b9b7bfdd0e2d32b76095c))

## [1.542.1](https://github.com/vm0-ai/vm0/compare/api-v1.542.0...api-v1.542.1) (2026-09-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.400.1
    * @okouai/core bumped to 8.619.1
    * @okouai/db bumped to 1.240.3
    * @okouai/pi-agent-runtime bumped to 1.15.7

## [1.542.0](https://github.com/vm0-ai/vm0/compare/api-v1.541.1...api-v1.542.0) (2026-09-03)


### Features

* use chat context for voice draft cleanup ([#31517](https://github.com/vm0-ai/vm0/issues/31517)) ([c77f7ff](https://github.com/vm0-ai/vm0/commit/c77f7ff2fc4887a079700e3729bef1afcf5da863))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.400.0
    * @okouai/core bumped to 8.619.0
    * @okouai/db bumped to 1.240.2
    * @okouai/pi-agent-runtime bumped to 1.15.6

## [1.541.1](https://github.com/vm0-ai/vm0/compare/api-v1.541.0...api-v1.541.1) (2026-09-03)


### Bug Fixes

* **api:** refresh API release marker comment ([#31538](https://github.com/vm0-ai/vm0/issues/31538)) ([435603e](https://github.com/vm0-ai/vm0/commit/435603e8598dcf2e0c76c7d9fdc6ca6470826e31))


### Refactoring

* remove expired deployment compatibility ([#31524](https://github.com/vm0-ai/vm0/issues/31524)) ([2020321](https://github.com/vm0-ai/vm0/commit/202032117158dca3c445b5f6f6d5e0e2d5b660aa))


### Performance Improvements

* **api:** bound run context Axiom query by creation time ([#31509](https://github.com/vm0-ai/vm0/issues/31509)) ([18fa8fc](https://github.com/vm0-ai/vm0/commit/18fa8fcad7bd5023c11d69bd885a33fe2c4060e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.399.1
    * @okouai/core bumped to 8.618.0
    * @okouai/db bumped to 1.240.1
    * @okouai/pi-agent-runtime bumped to 1.15.5

## [1.541.0](https://github.com/vm0-ai/vm0/compare/api-v1.540.0...api-v1.541.0) (2026-09-03)


### Features

* add cloud browser preference ([#31522](https://github.com/vm0-ai/vm0/issues/31522)) ([99b4589](https://github.com/vm0-ai/vm0/commit/99b4589022738a463640e019b97f31c150e50850))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.399.0
    * @okouai/core bumped to 8.617.0
    * @okouai/db bumped to 1.240.0
    * @okouai/pi-agent-runtime bumped to 1.15.4

## [1.540.0](https://github.com/vm0-ai/vm0/compare/api-v1.539.1...api-v1.540.0) (2026-09-03)


### Features

* **api:** show okou avatar in automation emails ([#31518](https://github.com/vm0-ai/vm0/issues/31518)) ([ae9d20f](https://github.com/vm0-ai/vm0/commit/ae9d20f90604814af0d5f4f800d4e93476455f88))
* **artifacts:** add short okou artifact urls ([#31483](https://github.com/vm0-ai/vm0/issues/31483)) ([9d20d76](https://github.com/vm0-ai/vm0/commit/9d20d76b88d3097f279084fcfb452d8b86e7ef55))


### Bug Fixes

* **api:** improve recommended follow-up choices ([#31527](https://github.com/vm0-ai/vm0/issues/31527)) ([06cc869](https://github.com/vm0-ai/vm0/commit/06cc86955be1685df879da6d37d8aa419beab549))
* **pi-memory:** promote terminal lifecycle telemetry ([#31512](https://github.com/vm0-ai/vm0/issues/31512)) ([35a2e51](https://github.com/vm0-ai/vm0/commit/35a2e51eebeed869c189609f49b5b4e46b630ae6))


### Refactoring

* **pi-memory:** make piloop the single product switch ([#31496](https://github.com/vm0-ai/vm0/issues/31496)) ([709e1a2](https://github.com/vm0-ai/vm0/commit/709e1a26703eac64d7501e777d802d80af19430c))
* **pi:** add dialect-aware credential runtime contract ([#31493](https://github.com/vm0-ai/vm0/issues/31493)) ([9464fb3](https://github.com/vm0-ai/vm0/commit/9464fb3e99138707f242b1fe789cf0e375602973))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.398.2
    * @okouai/core bumped to 8.616.0
    * @okouai/db bumped to 1.239.2
    * @okouai/pi-agent-runtime bumped to 1.15.3

## [1.539.1](https://github.com/vm0-ai/vm0/compare/api-v1.539.0...api-v1.539.1) (2026-09-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.398.1
    * @okouai/core bumped to 8.615.1
    * @okouai/db bumped to 1.239.1
    * @okouai/pi-agent-runtime bumped to 1.15.2

## [1.539.0](https://github.com/vm0-ai/vm0/compare/api-v1.538.2...api-v1.539.0) (2026-09-03)


### Features

* **chat:** persist v7 run failure reasons ([#31419](https://github.com/vm0-ai/vm0/issues/31419)) ([8739601](https://github.com/vm0-ai/vm0/commit/873960155fa9fd61c1e4db80f3e4275672696ee0))
* **cli:** redesign okou social around user intents ([#31333](https://github.com/vm0-ai/vm0/issues/31333)) ([1dafc7d](https://github.com/vm0-ai/vm0/commit/1dafc7d10900a2f1a5b7c6821090cc287b150093))
* **ui:** refresh the app palette onto the sand and amber scales ([#31081](https://github.com/vm0-ai/vm0/issues/31081)) ([eff8671](https://github.com/vm0-ai/vm0/commit/eff8671a6068d00502fad87e629409417e3ddd56))


### Performance Improvements

* **api:** skip unchanged chat event catch-up reads ([#31492](https://github.com/vm0-ai/vm0/issues/31492)) ([eac0955](https://github.com/vm0-ai/vm0/commit/eac09551e159c571114c1dbfc9039ddaba11eb56))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.615.0
    * @okouai/db bumped to 1.239.0

## [1.538.2](https://github.com/vm0-ai/vm0/compare/api-v1.538.1...api-v1.538.2) (2026-09-03)


### Bug Fixes

* **agent:** lock default agent name ([#31440](https://github.com/vm0-ai/vm0/issues/31440)) ([1c40b16](https://github.com/vm0-ai/vm0/commit/1c40b16066635e282d31752e6ce654b1422f5ecb))
* **cli:** make action url handoffs loss-resistant ([#31461](https://github.com/vm0-ai/vm0/issues/31461)) ([da3fa0d](https://github.com/vm0-ai/vm0/commit/da3fa0d9df45c76e052ff9d3c6a99e3cc7ffa040))
* **social:** classify mp4 downloads by media tracks ([#31418](https://github.com/vm0-ai/vm0/issues/31418)) ([23dd595](https://github.com/vm0-ai/vm0/commit/23dd5951c24da38ea4c8e3cbfaa839a1de974e42))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.614.2
    * @okouai/db bumped to 1.238.6

## [1.538.1](https://github.com/vm0-ai/vm0/compare/api-v1.538.0...api-v1.538.1) (2026-09-03)


### Bug Fixes

* **api:** bind mcp discovery to exact run accounts ([#31459](https://github.com/vm0-ai/vm0/issues/31459)) ([b021508](https://github.com/vm0-ai/vm0/commit/b0215087ca388de4ea1713b727617f74a4f686cf))
* **core:** return morning brief to gated beta ([#31463](https://github.com/vm0-ai/vm0/issues/31463)) ([8bc5f29](https://github.com/vm0-ai/vm0/commit/8bc5f295f68bf600f1b97cf044ccad29d465b700))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.614.1
    * @okouai/db bumped to 1.238.5

## [1.538.0](https://github.com/vm0-ai/vm0/compare/api-v1.537.0...api-v1.538.0) (2026-09-03)


### Features

* **api:** optimize recommended follow-up prompts ([#31394](https://github.com/vm0-ai/vm0/issues/31394)) ([5f1b1f9](https://github.com/vm0-ai/vm0/commit/5f1b1f9de657d89315f60f2d573fe19a2084b938))
* show when the soonest codex reset credit expires ([#31412](https://github.com/vm0-ai/vm0/issues/31412)) ([127bed8](https://github.com/vm0-ai/vm0/commit/127bed8e9ab803338c93fcb3ffaf5fa478cc0c6c))


### Bug Fixes

* **api:** explain BytePlus real-person image rejection ([#31416](https://github.com/vm0-ai/vm0/issues/31416)) ([0527941](https://github.com/vm0-ai/vm0/commit/0527941b660d29fe3a312cbd32e9e34a93de9cbb))
* **api:** log morning brief onboarding outcomes ([#31396](https://github.com/vm0-ai/vm0/issues/31396)) ([c8317a3](https://github.com/vm0-ai/vm0/commit/c8317a366010f42f9c7bbb2d351b88a150618af8))
* **api:** recover artifact preview navigation timeouts ([#31432](https://github.com/vm0-ai/vm0/issues/31432)) ([02c3df0](https://github.com/vm0-ai/vm0/commit/02c3df0adeeb309eed13de53b601e83fc43f06b3))
* **guest-agent:** classify oversized codex turn inputs ([#31404](https://github.com/vm0-ai/vm0/issues/31404)) ([8cf7f4b](https://github.com/vm0-ai/vm0/commit/8cf7f4b60fde6c4c8239ff27f27a9cc24e90f124))
* **pi-memory:** reject non-adjacent path collisions ([#31357](https://github.com/vm0-ai/vm0/issues/31357)) ([0aea850](https://github.com/vm0-ai/vm0/commit/0aea850c09d88dab810fa1941b21e738a774da08))


### Refactoring

* **api:** detach custom connectors from oauth setup persistence ([#31417](https://github.com/vm0-ai/vm0/issues/31417)) ([944b829](https://github.com/vm0-ai/vm0/commit/944b829570b4c69685f68d6dae159a75bd3c07f1))
* **api:** require exact connector ids for credential loading ([#31397](https://github.com/vm0-ai/vm0/issues/31397)) ([6c076fd](https://github.com/vm0-ai/vm0/commit/6c076fdb60f64ab27b1584c1525c17fe6e11c86b))
* remove obsolete vm0 migration tombstones ([#31401](https://github.com/vm0-ai/vm0/issues/31401)) ([7c530c6](https://github.com/vm0-ai/vm0/commit/7c530c63a3afc86db32a90757e155ed97dcf2dc0))


### Performance Improvements

* **api:** overlap attachment metadata resolution ([#31366](https://github.com/vm0-ai/vm0/issues/31366)) ([2081d93](https://github.com/vm0-ai/vm0/commit/2081d933272eb571065c80e37f04df2250f94509))
* **api:** overlap request and session storage preparation ([#31363](https://github.com/vm0-ai/vm0/issues/31363)) ([9839acf](https://github.com/vm0-ai/vm0/commit/9839acf1329f77de5a419bf6939c60cfeb9dccbe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.398.0
    * @okouai/connectors bumped to 3.3.2
    * @okouai/core bumped to 8.614.0
    * @okouai/db bumped to 1.238.4
    * @okouai/pi-agent-runtime bumped to 1.15.1

## [1.537.0](https://github.com/vm0-ai/vm0/compare/api-v1.536.0...api-v1.537.0) (2026-09-03)


### Features

* **chat:** batch shared worker event catch-up ([#31261](https://github.com/vm0-ai/vm0/issues/31261)) ([127f8e8](https://github.com/vm0-ai/vm0/commit/127f8e8cfc5cc91750a5ca7a1ac90529f10d4ef9))
* **pi-memory:** compose bounded phase 2 archive worker ([#31335](https://github.com/vm0-ai/vm0/issues/31335)) ([c8662dc](https://github.com/vm0-ai/vm0/commit/c8662dccea14112a2b2038cb26f64336e22e8a1c))
* polish voice drafts before sending ([#31190](https://github.com/vm0-ai/vm0/issues/31190)) ([12b2532](https://github.com/vm0-ai/vm0/commit/12b2532a6400c7c62ba705a782e3e209f0440091))


### Bug Fixes

* **api:** avoid locking empty active-input polls ([#31329](https://github.com/vm0-ai/vm0/issues/31329)) ([38884ae](https://github.com/vm0-ai/vm0/commit/38884ae93f6fcf6ef6e00a356663f1276fa97050))
* **platform:** use selected drive account for artifact readiness ([#31316](https://github.com/vm0-ai/vm0/issues/31316)) ([65d4ac5](https://github.com/vm0-ai/vm0/commit/65d4ac58bb3df45a52c97658bde0f594f554b6ad))


### Refactoring

* **contracts:** accept forward-compatible failure reasons ([#31305](https://github.com/vm0-ai/vm0/issues/31305)) ([abf08e4](https://github.com/vm0-ai/vm0/commit/abf08e49f5d261b1197975b5fa2bc6c1e6a7fbca))


### Performance Improvements

* **api:** reuse persisted plan capabilities ([#31320](https://github.com/vm0-ai/vm0/issues/31320)) ([b0ebcef](https://github.com/vm0-ai/vm0/commit/b0ebcef5734e0f73672eb8c95780e8946fa53592))
* **api:** select goal from authoritative queue head ([#31327](https://github.com/vm0-ai/vm0/issues/31327)) ([9bd0c1a](https://github.com/vm0-ai/vm0/commit/9bd0c1a26eaecdbb995db99c14cf988517e7d10e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.397.0
    * @okouai/core bumped to 8.613.0
    * @okouai/db bumped to 1.238.3
    * @okouai/pi-agent-runtime bumped to 1.15.0

## [1.536.0](https://github.com/vm0-ai/vm0/compare/api-v1.535.1...api-v1.536.0) (2026-09-03)


### Features

* launch morning brief for future workspace creators ([#31289](https://github.com/vm0-ai/vm0/issues/31289)) ([8bf2a15](https://github.com/vm0-ai/vm0/commit/8bf2a154bdb38424d1e466280c86c123a3b89334))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.612.0
    * @okouai/db bumped to 1.238.2
    * @okouai/pi-agent-runtime bumped to 1.14.4

## [1.535.1](https://github.com/vm0-ai/vm0/compare/api-v1.535.0...api-v1.535.1) (2026-09-03)


### Bug Fixes

* **models:** remove claude fable 5 from new workspace defaults ([#31281](https://github.com/vm0-ai/vm0/issues/31281)) ([699e37f](https://github.com/vm0-ai/vm0/commit/699e37fdc9986b5ded7108d7aa46060b12cfa43f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.3
    * @okouai/core bumped to 8.611.6
    * @okouai/db bumped to 1.238.1
    * @okouai/pi-agent-runtime bumped to 1.14.3

## [1.535.0](https://github.com/vm0-ai/vm0/compare/api-v1.534.3...api-v1.535.0) (2026-09-03)


### Features

* **pi-memory:** add CAS-safe publication control plane ([#31267](https://github.com/vm0-ai/vm0/issues/31267)) ([300d105](https://github.com/vm0-ai/vm0/commit/300d105769122ccd06ad2f4e54a0bc8446f7a1f9))


### Bug Fixes

* surface paused goal context in thread runs ([#31265](https://github.com/vm0-ai/vm0/issues/31265)) ([35a1d9d](https://github.com/vm0-ai/vm0/commit/35a1d9d1e76a6b0135c4d73ea8b44a51531e1291))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.238.0

## [1.534.3](https://github.com/vm0-ai/vm0/compare/api-v1.534.2...api-v1.534.3) (2026-09-03)


### Bug Fixes

* **mail:** preserve exact reconnect account ([#31224](https://github.com/vm0-ai/vm0/issues/31224)) ([87a73d3](https://github.com/vm0-ai/vm0/commit/87a73d3f81fc8c7aa229a18d0c70c99a054bf121))
* target selected google drive account for artifact recovery ([#31227](https://github.com/vm0-ai/vm0/issues/31227)) ([90388e8](https://github.com/vm0-ai/vm0/commit/90388e854981ba1d0eca0783ca84f477422445ce))


### Refactoring

* **api:** remove model rankings statistics runtime ([#31230](https://github.com/vm0-ai/vm0/issues/31230)) ([f9e93f9](https://github.com/vm0-ai/vm0/commit/f9e93f98006afbe7038c94005ad700b9e6abe51c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.2
    * @okouai/core bumped to 8.611.5
    * @okouai/db bumped to 1.237.1
    * @okouai/pi-agent-runtime bumped to 1.14.2

## [1.534.2](https://github.com/vm0-ai/vm0/compare/api-v1.534.1...api-v1.534.2) (2026-09-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/pi-agent-runtime bumped to 1.14.1

## [1.534.1](https://github.com/vm0-ai/vm0/compare/api-v1.534.0...api-v1.534.1) (2026-09-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/pi-agent-runtime bumped to 1.14.0

## [1.534.0](https://github.com/vm0-ai/vm0/compare/api-v1.533.0...api-v1.534.0) (2026-09-02)


### Features

* **pi-memory:** add per-storage phase 2 control plane ([#31241](https://github.com/vm0-ai/vm0/issues/31241)) ([cca1c16](https://github.com/vm0-ai/vm0/commit/cca1c1660226fca72ed71bd2b02965f5aacd0167))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.1
    * @okouai/connectors bumped to 3.3.1
    * @okouai/core bumped to 8.611.4
    * @okouai/db bumped to 1.237.0

## [1.533.0](https://github.com/vm0-ai/vm0/compare/api-v1.532.0...api-v1.533.0) (2026-09-02)


### Features

* **app:** route production traffic through app worker ([#31207](https://github.com/vm0-ai/vm0/issues/31207)) ([64403f6](https://github.com/vm0-ai/vm0/commit/64403f63916b4d7efb2be46807fb8c5be7f17af9))
* **pi-memory:** add bounded stage1 worker ([#31217](https://github.com/vm0-ai/vm0/issues/31217)) ([8a2e79b](https://github.com/vm0-ai/vm0/commit/8a2e79bb7f8b82a766e39fcdffb880c2be3090d2))


### Bug Fixes

* **pi-memory:** preserve selection watermark semantics ([#31236](https://github.com/vm0-ai/vm0/issues/31236)) ([769a623](https://github.com/vm0-ai/vm0/commit/769a623f08e058881812d5b4fb11442417aea3b9))


### Refactoring

* **pi:** remove ownership transfer capability marker ([#31216](https://github.com/vm0-ai/vm0/issues/31216)) ([fb22db1](https://github.com/vm0-ai/vm0/commit/fb22db17eca15ebfcd5479388ff9a163be0ef500))


### Performance Improvements

* **api:** skip credit reads for external model admission ([#31225](https://github.com/vm0-ai/vm0/issues/31225)) ([c065434](https://github.com/vm0-ai/vm0/commit/c0654349d77038ff52def71ebb098e949969531d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.396.0
    * @okouai/core bumped to 8.611.3
    * @okouai/db bumped to 1.236.1
    * @okouai/pi-agent-runtime bumped to 1.13.0

## [1.532.0](https://github.com/vm0-ai/vm0/compare/api-v1.531.0...api-v1.532.0) (2026-09-02)


### Features

* **pi:** inject bounded memory summary recall ([#31203](https://github.com/vm0-ai/vm0/issues/31203)) ([e44155e](https://github.com/vm0-ai/vm0/commit/e44155e6786b92ca0ae13852cdab1d5817656ecd))
* **pi:** support custom responses gateways ([#31157](https://github.com/vm0-ai/vm0/issues/31157)) ([e8cd4db](https://github.com/vm0-ai/vm0/commit/e8cd4dba2e57c0258491859f2aedd66a7f5855e4))


### Bug Fixes

* **api:** preserve connector account on auth replay ([#31155](https://github.com/vm0-ai/vm0/issues/31155)) ([d645212](https://github.com/vm0-ai/vm0/commit/d6452122da2c1c3f45f5877e6de0df76d9c87f54)), closes [#31141](https://github.com/vm0-ai/vm0/issues/31141)
* **runner:** report authoritative provider failure reasons ([#31163](https://github.com/vm0-ai/vm0/issues/31163)) ([b84e233](https://github.com/vm0-ai/vm0/commit/b84e2334f9e370b59a299b00250fc037d90538dd))


### Refactoring

* **runtime:** remove retired API URL alias tombstones ([#31209](https://github.com/vm0-ai/vm0/issues/31209)) ([e57170e](https://github.com/vm0-ai/vm0/commit/e57170e30c73c68188ce035caba4176874e716c2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.395.0
    * @okouai/core bumped to 8.611.2
    * @okouai/db bumped to 1.236.0
    * @okouai/pi-agent-runtime bumped to 1.12.0

## [1.531.0](https://github.com/vm0-ai/vm0/compare/api-v1.530.0...api-v1.531.0) (2026-09-02)


### Features

* **api:** add Morning Brief default onboarding foundation ([#31183](https://github.com/vm0-ai/vm0/issues/31183)) ([2ca9dee](https://github.com/vm0-ai/vm0/commit/2ca9dee54342bc1556e1042b5a48ab8baee56923))
* **api:** resolve automatic mcp auth as none or oauth ([#31135](https://github.com/vm0-ai/vm0/issues/31135)) ([d84a7e0](https://github.com/vm0-ai/vm0/commit/d84a7e0cd556e91916858ea18cd5256efde6ed03))


### Refactoring

* **api:** rename model provider gateway runtime secret ([#31193](https://github.com/vm0-ai/vm0/issues/31193)) ([dfdbaf6](https://github.com/vm0-ai/vm0/commit/dfdbaf65f12ee9679403a6488efcf47c3e2f2729))


### Performance Improvements

* **api:** skip redundant drains for admitted goals ([#31171](https://github.com/vm0-ai/vm0/issues/31171)) ([bbb111a](https://github.com/vm0-ai/vm0/commit/bbb111ac83d53579633fc2f3826b34372b015b97))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.394.0
    * @okouai/core bumped to 8.611.1
    * @okouai/db bumped to 1.235.0
    * @okouai/pi-agent-runtime bumped to 1.11.1

## [1.530.0](https://github.com/vm0-ai/vm0/compare/api-v1.529.0...api-v1.530.0) (2026-09-02)


### Features

* **app:** add standalone worker previews ([#30987](https://github.com/vm0-ai/vm0/issues/30987)) ([7a4ce6a](https://github.com/vm0-ai/vm0/commit/7a4ce6ad45daa6c4cb823a9b7253340123dd98df))
* **memory:** materialize bounded summaries by storage version ([#31117](https://github.com/vm0-ai/vm0/issues/31117)) ([2cfd42a](https://github.com/vm0-ai/vm0/commit/2cfd42a36d3dcb947b30cea95cd05832316284a8))


### Bug Fixes

* **api:** converge connector account trigger lifecycle ([#31122](https://github.com/vm0-ai/vm0/issues/31122)) ([7a9b6ec](https://github.com/vm0-ai/vm0/commit/7a9b6ec42e36208e2837a38178123b15c278b301))
* **api:** self-heal renamed Calendar primary watches ([#31130](https://github.com/vm0-ai/vm0/issues/31130)) ([a2b06d6](https://github.com/vm0-ai/vm0/commit/a2b06d63a54309a504b8d8e60f688bab6e1b9374))
* **api:** stop logging echoed provider request input ([#31129](https://github.com/vm0-ai/vm0/issues/31129)) ([570bf61](https://github.com/vm0-ai/vm0/commit/570bf61917c79cdf2fe08b9c25fb1bccf654a4f1)), closes [#30960](https://github.com/vm0-ai/vm0/issues/30960)
* **api:** suppress repeated auth unavailability warnings ([#31128](https://github.com/vm0-ai/vm0/issues/31128)) ([03c37ce](https://github.com/vm0-ai/vm0/commit/03c37ce804316f1054202df724115d1b27d9de12))
* **github:** use branded official app callbacks ([#31109](https://github.com/vm0-ai/vm0/issues/31109)) ([bf8cdec](https://github.com/vm0-ai/vm0/commit/bf8cdec0c8016295208fae60bb63dd846c6f4f9d))
* project remaining public brand surfaces ([#31151](https://github.com/vm0-ai/vm0/issues/31151)) ([769b53e](https://github.com/vm0-ai/vm0/commit/769b53e654a275477750026201f55207dc13d839))
* **slack:** preserve dual-brand oauth domains ([#31063](https://github.com/vm0-ai/vm0/issues/31063)) ([54bce0d](https://github.com/vm0-ai/vm0/commit/54bce0db9fe56c579241c91c766ce4d428bc95de))
* **social:** file downloaded media by its actual container ([#30998](https://github.com/vm0-ai/vm0/issues/30998)) ([3752d3f](https://github.com/vm0-ai/vm0/commit/3752d3fea2e6f5dbd535693ad4346f58e943485a))


### Refactoring

* **api:** remove morning brief snapshot compatibility ([#31162](https://github.com/vm0-ai/vm0/issues/31162)) ([1f8a715](https://github.com/vm0-ai/vm0/commit/1f8a71577990f9b75bfe56760f63fb9285229ce2))
* **api:** remove terminal preview job-reference legacy reader ([#31168](https://github.com/vm0-ai/vm0/issues/31168)) ([e21b4f2](https://github.com/vm0-ai/vm0/commit/e21b4f2dd93fe797820f1ec09095db0e44487479))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.393.0
    * @okouai/core bumped to 8.611.0
    * @okouai/db bumped to 1.234.0

## [1.529.0](https://github.com/vm0-ai/vm0/compare/api-v1.528.0...api-v1.529.0) (2026-09-02)


### Features

* **api:** persist run failure reasons ([#31097](https://github.com/vm0-ai/vm0/issues/31097)) ([aa472b6](https://github.com/vm0-ai/vm0/commit/aa472b68528c7ab714f3f0bcf6c472475bfba2b0))
* **chat:** persist structured image annotations ([#31046](https://github.com/vm0-ai/vm0/issues/31046)) ([8e4b621](https://github.com/vm0-ai/vm0/commit/8e4b62131457161a5c9ceb7ec4003339a4b58eb5))
* **connectors:** route twelve ready oauth callbacks directly to okou ([#30562](https://github.com/vm0-ai/vm0/issues/30562)) ([78680f6](https://github.com/vm0-ai/vm0/commit/78680f6430bce28ec9ac1923dfcefdf551594364)), closes [#28381](https://github.com/vm0-ai/vm0/issues/28381)
* gate morning brief behind an independent switch ([#31110](https://github.com/vm0-ai/vm0/issues/31110)) ([2b69ef6](https://github.com/vm0-ai/vm0/commit/2b69ef6331471d09f88cae0548e6dd4ba15e4283))
* graduate custom connector no-auth ([#31075](https://github.com/vm0-ai/vm0/issues/31075)) ([5756edf](https://github.com/vm0-ai/vm0/commit/5756edf51498b88c6f06b0a43d02c7e632d6238c))
* **pi:** add feature-gated memory recall mount ([#31108](https://github.com/vm0-ai/vm0/issues/31108)) ([efe42ad](https://github.com/vm0-ai/vm0/commit/efe42ad75b466d70af92dc2db216435ac245c0f0))


### Bug Fixes

* **api:** deploy GitHub App slug cutover ([#31005](https://github.com/vm0-ai/vm0/issues/31005)) ([9c64bfb](https://github.com/vm0-ai/vm0/commit/9c64bfbe71a78ac16844e9f5df2e4d9462ef5c2f))
* **api:** use branded custom connector OAuth callbacks ([#31028](https://github.com/vm0-ai/vm0/issues/31028)) ([4546240](https://github.com/vm0-ai/vm0/commit/4546240924ce7db453f0fff19054da81eb09a8e0))
* **artifacts:** skip poster extraction for webm artifacts ([#30999](https://github.com/vm0-ai/vm0/issues/30999)) ([9a1348b](https://github.com/vm0-ai/vm0/commit/9a1348b56a75b3e259122df056d1894627447b0e))
* **feishu:** project oauth urls by public brand ([#31030](https://github.com/vm0-ai/vm0/issues/31030)) ([f6ce8bd](https://github.com/vm0-ai/vm0/commit/f6ce8bd0d6f8f4ab312a2340b716a035774d02ea))


### Refactoring

* **api:** drop the feishu events compatibility row ([#31069](https://github.com/vm0-ai/vm0/issues/31069)) ([dbce087](https://github.com/vm0-ai/vm0/commit/dbce0877440c3744fde0979b9af1ef9357594aed)), closes [#31068](https://github.com/vm0-ai/vm0/issues/31068)
* **api:** empty the branded compatibility table ([#31106](https://github.com/vm0-ai/vm0/issues/31106)) ([26e0aa1](https://github.com/vm0-ai/vm0/commit/26e0aa1a2872bc0fafccd0c3089466ea3653f7c5))
* **pi:** make ownership transfer v3-only ([#31045](https://github.com/vm0-ai/vm0/issues/31045)) ([1e99242](https://github.com/vm0-ai/vm0/commit/1e99242eabe418b4981216c0f6eb62e21edc015a))


### Performance Improvements

* **api:** attribute goal queue load phases ([#31077](https://github.com/vm0-ai/vm0/issues/31077)) ([24ba4ef](https://github.com/vm0-ai/vm0/commit/24ba4efc812f0da9237c461025e4aec6f0882f85))
* **api:** scope custom connector runtime sync catalog loads ([#31098](https://github.com/vm0-ai/vm0/issues/31098)) ([0de7c82](https://github.com/vm0-ai/vm0/commit/0de7c82df9b5a8cbebc494dcb7214c9c6d3da705))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.392.0
    * @okouai/connectors bumped to 3.3.0
    * @okouai/core bumped to 8.610.0
    * @okouai/db bumped to 1.233.0

## [1.528.0](https://github.com/vm0-ai/vm0/compare/api-v1.527.1...api-v1.528.0) (2026-09-02)


### Features

* add Claude Fable 5.1 support ([#30932](https://github.com/vm0-ai/vm0/issues/30932)) ([15f6717](https://github.com/vm0-ai/vm0/commit/15f6717327d927cc8bc61ff3af3cf17802aa4853))


### Bug Fixes

* **chat:** surface execution timeouts as recoverable ([#31014](https://github.com/vm0-ai/vm0/issues/31014)) ([97a794d](https://github.com/vm0-ai/vm0/commit/97a794d0dedcac24c2a7d3911a6cb85207964d16))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.391.0
    * @okouai/core bumped to 8.609.0
    * @okouai/db bumped to 1.232.0

## [1.527.1](https://github.com/vm0-ai/vm0/compare/api-v1.527.0...api-v1.527.1) (2026-09-02)


### Bug Fixes

* **api:** bind calendar triggers to thread account ([#30907](https://github.com/vm0-ai/vm0/issues/30907)) ([5fe9278](https://github.com/vm0-ai/vm0/commit/5fe92783e9dd836989628fd8c651f2c96bdce076))
* **platform:** make settings the only preferences surface ([#31039](https://github.com/vm0-ai/vm0/issues/31039)) ([1e2692c](https://github.com/vm0-ai/vm0/commit/1e2692cd5fd7173f3b691a180d4430bceab4ea6c))


### Refactoring

* remove workflow connector readiness ([#30996](https://github.com/vm0-ai/vm0/issues/30996)) ([94ec7af](https://github.com/vm0-ai/vm0/commit/94ec7afb7be4163a70f0f3fdea1d1c5579541c9b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.3
    * @okouai/core bumped to 8.608.3
    * @okouai/db bumped to 1.231.4

## [1.527.0](https://github.com/vm0-ai/vm0/compare/api-v1.526.2...api-v1.527.0) (2026-09-02)


### Features

* **pi:** align openrouter codex routes on responses api ([#31032](https://github.com/vm0-ai/vm0/issues/31032)) ([eff60e8](https://github.com/vm0-ai/vm0/commit/eff60e8be002ff2150fdd7da4281e5f5b10abe66))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.231.3
    * @okouai/pi-agent-runtime bumped to 1.11.0

## [1.526.2](https://github.com/vm0-ai/vm0/compare/api-v1.526.1...api-v1.526.2) (2026-09-02)


### Bug Fixes

* **api:** report no-auth connector accounts as connected ([#30972](https://github.com/vm0-ai/vm0/issues/30972)) ([dd4996f](https://github.com/vm0-ai/vm0/commit/dd4996f30ac06f0fa2b527a8837f78b09a944202))


### Refactoring

* remove Strapi integration feature switch ([#30965](https://github.com/vm0-ai/vm0/issues/30965)) ([603bbb7](https://github.com/vm0-ai/vm0/commit/603bbb7dafa7caa3619261d9b81047f96c763e38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.2
    * @okouai/core bumped to 8.608.2
    * @okouai/db bumped to 1.231.2

## [1.526.1](https://github.com/vm0-ai/vm0/compare/api-v1.526.0...api-v1.526.1) (2026-09-02)


### Bug Fixes

* **api:** bind google meet triggers to selected account ([#30906](https://github.com/vm0-ai/vm0/issues/30906)) ([d567690](https://github.com/vm0-ai/vm0/commit/d567690ee7612f31b86e26657d1270d6ac099196))
* **api:** bound snapshot convergence ([#30929](https://github.com/vm0-ai/vm0/issues/30929)) ([8850bca](https://github.com/vm0-ai/vm0/commit/8850bca232d7c8f65ee29fc4e424c35116a348e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.1
    * @okouai/core bumped to 8.608.1
    * @okouai/db bumped to 1.231.1

## [1.526.0](https://github.com/vm0-ai/vm0/compare/api-v1.525.6...api-v1.526.0) (2026-09-02)


### Features

* support no-auth custom connectors ([#30897](https://github.com/vm0-ai/vm0/issues/30897)) ([f6a4e7a](https://github.com/vm0-ai/vm0/commit/f6a4e7af74566f31c53c59035554aaf5f0c1076c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.390.0
    * @okouai/core bumped to 8.608.0
    * @okouai/db bumped to 1.231.0

## [1.525.6](https://github.com/vm0-ai/vm0/compare/api-v1.525.5...api-v1.525.6) (2026-09-02)


### Bug Fixes

* share attachments by their public artifacts url ([#30835](https://github.com/vm0-ai/vm0/issues/30835)) ([7aa3ac3](https://github.com/vm0-ai/vm0/commit/7aa3ac3843232909951bd81d1ee60bacf852a078))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.389.1
    * @okouai/core bumped to 8.607.1
    * @okouai/db bumped to 1.230.2

## [1.525.5](https://github.com/vm0-ai/vm0/compare/api-v1.525.4...api-v1.525.5) (2026-09-01)


### Bug Fixes

* **api:** repair direct morning brief snapshots ([#30919](https://github.com/vm0-ai/vm0/issues/30919)) ([0a202a6](https://github.com/vm0-ai/vm0/commit/0a202a6eb3f30ced777c942cbc785a3db87b7ff3))

## [1.525.4](https://github.com/vm0-ai/vm0/compare/api-v1.525.3...api-v1.525.4) (2026-09-01)


### Bug Fixes

* **api:** repair priority morning brief snapshot claims ([#30917](https://github.com/vm0-ai/vm0/issues/30917)) ([b21b3c6](https://github.com/vm0-ai/vm0/commit/b21b3c6571ca1d9a2d9b5f646257acd51da871d0))

## [1.525.3](https://github.com/vm0-ai/vm0/compare/api-v1.525.2...api-v1.525.3) (2026-09-01)


### Bug Fixes

* **api:** repair model-annotated legacy snapshots ([#30912](https://github.com/vm0-ai/vm0/issues/30912)) ([40e8aea](https://github.com/vm0-ai/vm0/commit/40e8aea0009937c60146f7caa7698cefcde95b43))

## [1.525.2](https://github.com/vm0-ai/vm0/compare/api-v1.525.1...api-v1.525.2) (2026-09-01)


### Bug Fixes

* **api:** repair retired morning brief snapshots ([#30909](https://github.com/vm0-ai/vm0/issues/30909)) ([8eb32b3](https://github.com/vm0-ai/vm0/commit/8eb32b3f050777150905808ecdde70aca45c7404))

## [1.525.1](https://github.com/vm0-ai/vm0/compare/api-v1.525.0...api-v1.525.1) (2026-09-01)


### Bug Fixes

* **api:** repair contextless legacy snapshots ([#30903](https://github.com/vm0-ai/vm0/issues/30903)) ([aa814d7](https://github.com/vm0-ai/vm0/commit/aa814d72263aa816bfdd43bce80508ea52540131))
* isolate google forms triggers by account ([#30798](https://github.com/vm0-ai/vm0/issues/30798)) ([2b74ba7](https://github.com/vm0-ai/vm0/commit/2b74ba7a6775fad0d8133165ee6e3e017d7ea770))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/db bumped to 1.230.1

## [1.525.0](https://github.com/vm0-ai/vm0/compare/api-v1.524.0...api-v1.525.0) (2026-09-01)


### Features

* **platform:** translate selected chat text ([#30818](https://github.com/vm0-ai/vm0/issues/30818)) ([37c2265](https://github.com/vm0-ai/vm0/commit/37c2265c1c600cbcc22b32224e376c5ae26cead3))
* use transparent avatar cutouts in the intro video picker ([#30873](https://github.com/vm0-ai/vm0/issues/30873)) ([b176b5b](https://github.com/vm0-ai/vm0/commit/b176b5b46f223dd26d44e976e2299ed3f5bbfa8c))


### Bug Fixes

* **api:** bind notion automations to workflow accounts ([#30854](https://github.com/vm0-ai/vm0/issues/30854)) ([93b2fb7](https://github.com/vm0-ai/vm0/commit/93b2fb776be6b6e4dedb18ee98f6bd2351ab0b4c))
* **api:** clean up unused google meet subscriptions ([#30874](https://github.com/vm0-ai/vm0/issues/30874)) ([c51ab2b](https://github.com/vm0-ai/vm0/commit/c51ab2b08ed8f2515bd6d77e93bcc98821f84b6d))
* **api:** reject reordered legacy snapshot chains ([#30895](https://github.com/vm0-ai/vm0/issues/30895)) ([5f1496c](https://github.com/vm0-ai/vm0/commit/5f1496c724382c7979070c31b9fc8624c609f178))


### Performance Improvements

* **guest-agent:** expose control-path scheduling metrics ([#30890](https://github.com/vm0-ai/vm0/issues/30890)) ([1e7a196](https://github.com/vm0-ai/vm0/commit/1e7a1966f15351fb5f8019ebd29c2ee5ad2b4f96))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.389.0
    * @okouai/core bumped to 8.607.0
    * @okouai/db bumped to 1.230.0

## [1.524.0](https://github.com/vm0-ai/vm0/compare/api-v1.523.0...api-v1.524.0) (2026-09-01)


### Features

* **connectors:** route github oauth callback directly to okou ([#30870](https://github.com/vm0-ai/vm0/issues/30870)) ([1afb5b8](https://github.com/vm0-ai/vm0/commit/1afb5b8246d5b19d6f6eb1c9aa65ee5cf81edb0d)), closes [#30867](https://github.com/vm0-ai/vm0/issues/30867)
* support automatic oauth for mcp connectors ([#30858](https://github.com/vm0-ai/vm0/issues/30858)) ([716e3b0](https://github.com/vm0-ai/vm0/commit/716e3b08c1d41a12f0686bb0363343650d194d89))


### Bug Fixes

* **api:** use workflow account for connector readiness ([#30853](https://github.com/vm0-ai/vm0/issues/30853)) ([1996ef4](https://github.com/vm0-ai/vm0/commit/1996ef4b0589eb6c7f7e3564be552348810c94f0))


### Refactoring

* **api:** remove unused connector endpoints ([#30848](https://github.com/vm0-ai/vm0/issues/30848)) ([e47044b](https://github.com/vm0-ai/vm0/commit/e47044b558f264448ed1793012e3e6ad63b8d8a8))
* remove built-in fallback rollout state ([#30876](https://github.com/vm0-ai/vm0/issues/30876)) ([ddab7f4](https://github.com/vm0-ai/vm0/commit/ddab7f4cf55cead3540347247d2ea0b0f156c01b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.388.0
    * @okouai/connectors bumped to 3.2.0
    * @okouai/core bumped to 8.606.1
    * @okouai/db bumped to 1.229.5

## [1.523.0](https://github.com/vm0-ai/vm0/compare/api-v1.522.2...api-v1.523.0) (2026-09-01)


### Features

* graduate built-in model provider fallback ([#30861](https://github.com/vm0-ai/vm0/issues/30861)) ([be446a6](https://github.com/vm0-ai/vm0/commit/be446a6678a6fe32d6df9788b2b17550ebddd8b4))


### Bug Fixes

* **api:** keep a committed delete successful when storage cleanup fails ([#30863](https://github.com/vm0-ai/vm0/issues/30863)) ([c256e81](https://github.com/vm0-ai/vm0/commit/c256e81be0509cab6a42872b5be44958cf6f0e91))
* **mail:** use thread gmail account for draft handoff ([#30846](https://github.com/vm0-ai/vm0/issues/30846)) ([99e2b42](https://github.com/vm0-ai/vm0/commit/99e2b42770617c62b57787973131d1002f0ebbbf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.387.0
    * @okouai/core bumped to 8.606.0
    * @okouai/db bumped to 1.229.4

## [1.522.2](https://github.com/vm0-ai/vm0/compare/api-v1.522.1...api-v1.522.2) (2026-09-01)


### Bug Fixes

* **official-workflows:** restore catalog schema cutovers ([#30834](https://github.com/vm0-ai/vm0/issues/30834)) ([4dc5580](https://github.com/vm0-ai/vm0/commit/4dc55802b7a9941a34515d48e81965f9975c6663))
* **social:** normalize TikTok collection semantics ([#30838](https://github.com/vm0-ai/vm0/issues/30838)) ([5720a7a](https://github.com/vm0-ai/vm0/commit/5720a7a38766172840802151fef77e73111d5d14))


### Refactoring

* **api:** drop the web and cli driven compatibility rows ([#30817](https://github.com/vm0-ai/vm0/issues/30817)) ([aa1276f](https://github.com/vm0-ai/vm0/commit/aa1276f5951bb83449286bbc83381355aa3ba692))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.386.1
    * @okouai/core bumped to 8.605.10
    * @okouai/db bumped to 1.229.3

## [1.522.1](https://github.com/vm0-ai/vm0/compare/api-v1.522.0...api-v1.522.1) (2026-09-01)


### Bug Fixes

* **api:** repair chained legacy snapshot revocations ([#30808](https://github.com/vm0-ai/vm0/issues/30808)) ([5458a54](https://github.com/vm0-ai/vm0/commit/5458a54c86bbb10b16db73cdd91d76585b6cc7ec))
* scope connector doctor to its host agent ([#30809](https://github.com/vm0-ai/vm0/issues/30809)) ([61495a2](https://github.com/vm0-ai/vm0/commit/61495a251cd71be80dc05d4438f24f85ae3bda15))


### Refactoring

* **api:** drop the computer-use and feature-switch compatibility rows ([#30814](https://github.com/vm0-ai/vm0/issues/30814)) ([07296e0](https://github.com/vm0-ai/vm0/commit/07296e0bf4bcc1d68f6695f3210440f346658df5)), closes [#30804](https://github.com/vm0-ai/vm0/issues/30804)
* **api:** drop the teams callback and slack connect compatibility rows ([#30821](https://github.com/vm0-ai/vm0/issues/30821)) ([60bad02](https://github.com/vm0-ai/vm0/commit/60bad025e87ad5fc048e3a579f13277d44a38e74)), closes [#30812](https://github.com/vm0-ai/vm0/issues/30812)

## [1.522.0](https://github.com/vm0-ai/vm0/compare/api-v1.521.0...api-v1.522.0) (2026-09-01)


### Features

* manage morning brief from preferences ([#30805](https://github.com/vm0-ai/vm0/issues/30805)) ([a95ce9e](https://github.com/vm0-ai/vm0/commit/a95ce9ec44cb77f06e05cd99c28f052ddcd6cff5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.386.0
    * @okouai/core bumped to 8.605.9
    * @okouai/db bumped to 1.229.2

## [1.521.0](https://github.com/vm0-ai/vm0/compare/api-v1.520.1...api-v1.521.0) (2026-09-01)


### Features

* **pi:** activate fast terra with exact billing ([#30781](https://github.com/vm0-ai/vm0/issues/30781)) ([f02a413](https://github.com/vm0-ai/vm0/commit/f02a4136c89233e98797f64e57455b7d3ae13bf4))

## [1.520.1](https://github.com/vm0-ai/vm0/compare/api-v1.520.0...api-v1.520.1) (2026-09-01)


### Bug Fixes

* **social:** make transcript errors truthful and provider-neutral ([#30732](https://github.com/vm0-ai/vm0/issues/30732)) ([f3c3e3d](https://github.com/vm0-ai/vm0/commit/f3c3e3daa7e4ccbb215a769fa5fb37489c325993))


### Performance Improvements

* **api:** attribute goal model-context latency ([#30773](https://github.com/vm0-ai/vm0/issues/30773)) ([d61595f](https://github.com/vm0-ai/vm0/commit/d61595f4cc014f96421f24f17b4e461bb5be1859))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.385.1
    * @okouai/core bumped to 8.605.8
    * @okouai/db bumped to 1.229.1

## [1.520.0](https://github.com/vm0-ai/vm0/compare/api-v1.519.4...api-v1.520.0) (2026-09-01)


### Features

* **api:** model automatic oauth for mcp connectors ([#30636](https://github.com/vm0-ai/vm0/issues/30636)) ([b33d6c2](https://github.com/vm0-ai/vm0/commit/b33d6c26e6df23aad23f9460124a203b11309a36))
* request connector account switches in chat ([#30602](https://github.com/vm0-ai/vm0/issues/30602)) ([4108626](https://github.com/vm0-ai/vm0/commit/4108626240e47072c6eeb3658a12fff649a57f87))


### Bug Fixes

* **api:** repair legacy snapshot revocation rows ([#30754](https://github.com/vm0-ai/vm0/issues/30754)) ([027642e](https://github.com/vm0-ai/vm0/commit/027642e96bb07f4290e8de1c2cd13b46219f6018))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.385.0
    * @okouai/core bumped to 8.605.7
    * @okouai/db bumped to 1.229.0

## [1.519.4](https://github.com/vm0-ai/vm0/compare/api-v1.519.3...api-v1.519.4) (2026-09-01)


### Refactoring

* **runtime:** require canonical platform environment ([#30728](https://github.com/vm0-ai/vm0/issues/30728)) ([aaf4999](https://github.com/vm0-ai/vm0/commit/aaf49990f7b94eca4615242555bbf131986373cb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.384.3
    * @okouai/core bumped to 8.605.6
    * @okouai/db bumped to 1.228.31
    * @okouai/pi-agent-runtime bumped to 1.10.0

## [1.519.3](https://github.com/vm0-ai/vm0/compare/api-v1.519.2...api-v1.519.3) (2026-09-01)


### Bug Fixes

* **email:** enforce Okou branding for product mail ([#30427](https://github.com/vm0-ai/vm0/issues/30427)) ([50b5a80](https://github.com/vm0-ai/vm0/commit/50b5a80ebefbb1c525ecdb12a0bdbf3bc481bfa4))
* repair stale Morning Brief chat snapshots ([#30716](https://github.com/vm0-ai/vm0/issues/30716)) ([d458669](https://github.com/vm0-ai/vm0/commit/d458669d7f3ba92c746947fe28787cc498a64100))
* **social:** report provider-limited collection pages ([#30704](https://github.com/vm0-ai/vm0/issues/30704)) ([2ad3efe](https://github.com/vm0-ai/vm0/commit/2ad3efe0a379aa42375041a971213c408c496c5b))


### Refactoring

* **api:** drop the console-driven slack compatibility rows ([#30688](https://github.com/vm0-ai/vm0/issues/30688)) ([085ed59](https://github.com/vm0-ai/vm0/commit/085ed5907f9c30867b4506cd1065e89f39000677))
* **db:** contract legacy vm0 provider compatibility ([#30708](https://github.com/vm0-ai/vm0/issues/30708)) ([7ab758f](https://github.com/vm0-ai/vm0/commit/7ab758fea24f304dd1bdd25ca7a24457e20419e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.384.2
    * @okouai/core bumped to 8.605.5
    * @okouai/db bumped to 1.228.30

## [1.519.2](https://github.com/vm0-ai/vm0/compare/api-v1.519.1...api-v1.519.2) (2026-09-01)


### Bug Fixes

* **cli:** diagnose effective visible workflows ([#30696](https://github.com/vm0-ai/vm0/issues/30696)) ([af34735](https://github.com/vm0-ai/vm0/commit/af3473581a3c7a7eed432684f2c2ac206e6f0dda))
* **email:** link official workflow result footer to automation ([#30591](https://github.com/vm0-ai/vm0/issues/30591)) ([0e556c4](https://github.com/vm0-ai/vm0/commit/0e556c4e81749a8e4718f4ccbe1a2f151068c9f5))


### Refactoring

* **api:** unify the teams oauth callback and delete the legacy zero path map ([#30673](https://github.com/vm0-ai/vm0/issues/30673)) ([97bdd0c](https://github.com/vm0-ai/vm0/commit/97bdd0c0e5d2f36549e1c40d7bf11952eb02c8ba)), closes [#30667](https://github.com/vm0-ai/vm0/issues/30667)

## [1.519.1](https://github.com/vm0-ai/vm0/compare/api-v1.519.0...api-v1.519.1) (2026-09-01)


### Bug Fixes

* **pi:** keep one eligibility snapshot ([#30658](https://github.com/vm0-ai/vm0/issues/30658)) ([81b4bb3](https://github.com/vm0-ai/vm0/commit/81b4bb379d5e55eaaca473232ab486a339d12374))
