# Changelog

## [1.5.0](https://github.com/vm0-ai/vm0/compare/cli-v1.4.0...cli-v1.5.0) (2025-11-26)


### Features

* replace dynamic_volumes with artifact concept ([#210](https://github.com/vm0-ai/vm0/issues/210)) ([5cc831c](https://github.com/vm0-ai/vm0/commit/5cc831c81041ae8f80c425d68b9491354eaafa2b))

## [1.4.0](https://github.com/vm0-ai/vm0/compare/cli-v1.3.1...cli-v1.4.0) (2025-11-25)


### Features

* add version management to vm0 volumes ([#182](https://github.com/vm0-ai/vm0/issues/182)) ([96677de](https://github.com/vm0-ai/vm0/commit/96677de998ca22f7e441c4b38d44c1dd47bac64c))

## [1.3.1](https://github.com/vm0-ai/vm0/compare/cli-v1.3.0...cli-v1.3.1) (2025-11-24)


### Bug Fixes

* improve checkpoint resume debugging for git volumes ([#176](https://github.com/vm0-ai/vm0/issues/176)) ([#178](https://github.com/vm0-ai/vm0/issues/178)) ([228bab2](https://github.com/vm0-ai/vm0/commit/228bab2bb0fea624ee31ee99267d3179154ba2d0))

## [1.3.0](https://github.com/vm0-ai/vm0/compare/cli-v1.2.0...cli-v1.3.0) (2025-11-24)


### Features

* implement vm0 managed volumes (simple MVP - full upload/download) ([#172](https://github.com/vm0-ai/vm0/issues/172)) ([ce2f717](https://github.com/vm0-ai/vm0/commit/ce2f717ae1c05c806a9a2f5cd1febd57ad7be1ce))


### Bug Fixes

* remove all eslint suppression comments and use vi.stubEnv for tests ([#171](https://github.com/vm0-ai/vm0/issues/171)) ([e210c7c](https://github.com/vm0-ai/vm0/commit/e210c7c0df82e045b3e9103b0bd6dabc28567c12))

## [1.2.0](https://github.com/vm0-ai/vm0/compare/cli-v1.1.0...cli-v1.2.0) (2025-11-23)


### Features

* add validation for environment and template variables before execution ([#164](https://github.com/vm0-ai/vm0/issues/164)) ([a197eba](https://github.com/vm0-ai/vm0/commit/a197eba8ee189e37317e80fd720d1a8df64a863a))

## [1.1.0](https://github.com/vm0-ai/vm0/compare/cli-v1.0.0...cli-v1.1.0) (2025-11-22)


### Features

* enable runtime script transfer for dynamic agent execution ([#139](https://github.com/vm0-ai/vm0/issues/139)) ([77383f0](https://github.com/vm0-ai/vm0/commit/77383f077bc38fc64b7cb566275c6c2e23f21481))
* implement checkpoint resume functionality ([#156](https://github.com/vm0-ai/vm0/issues/156)) ([304f672](https://github.com/vm0-ai/vm0/commit/304f672dd800a5d9d2b18001438ff67260019efe))
* implement VM0 system events for run lifecycle management ([#154](https://github.com/vm0-ai/vm0/issues/154)) ([8e2ff1d](https://github.com/vm0-ai/vm0/commit/8e2ff1d6f8370225b3e6085a56e3bb8eb680a755))

## [1.0.0](https://github.com/vm0-ai/vm0/compare/cli-v0.3.0...cli-v1.0.0) (2025-11-20)


### ⚠ BREAKING CHANGES

* CLI no longer recognizes API_HOST environment variable. Users must update to use VM0_API_URL instead.

### Features

* standardize api url environment variable to vm0_api_url ([#110](https://github.com/vm0-ai/vm0/issues/110)) ([f4b9fab](https://github.com/vm0-ai/vm0/commit/f4b9fabeeeb44cb27960335e38bcd7180f18ed84))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/cli-v0.2.0...cli-v0.3.0) (2025-11-20)


### Features

* add CLI e2e device flow automation and production API fallback ([#73](https://github.com/vm0-ai/vm0/issues/73)) ([8eb2d21](https://github.com/vm0-ai/vm0/commit/8eb2d21e6a2f363f93575f85bde5081a2ff218a7))
* add device flow authentication for cli ([#39](https://github.com/vm0-ai/vm0/issues/39)) ([b6ae61c](https://github.com/vm0-ai/vm0/commit/b6ae61c4244b318e9a6d3969d1ab57bd3d47c873))
* add support for agent names in vm0 run command ([#71](https://github.com/vm0-ai/vm0/issues/71)) ([4842d80](https://github.com/vm0-ai/vm0/commit/4842d80f0ce24aec3683ff0e364fc9e22eb24177))
* implement CLI build and run commands ([#65](https://github.com/vm0-ai/vm0/issues/65)) ([c0b8d11](https://github.com/vm0-ai/vm0/commit/c0b8d114a8c6910bfce7c2e4e10a82509889a28f))
* implement event streaming for vm0 run command ([#92](https://github.com/vm0-ai/vm0/issues/92)) ([a551950](https://github.com/vm0-ai/vm0/commit/a5519501aa6e7b3b739e05a965d58868498dbdca))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/cli-v0.1.0...cli-v0.2.0) (2025-11-17)


### Features

* add cli ci/cd pipeline with npm oidc publishing ([#29](https://github.com/vm0-ai/vm0/issues/29)) ([a46585a](https://github.com/vm0-ai/vm0/commit/a46585a73c26ece8a0cac4b50fdb7816b047382c))
* initial project setup from makita template ([e9c330a](https://github.com/vm0-ai/vm0/commit/e9c330a5952526d657f245e8db9522de553018b3))


### Bug Fixes

* replace remaining makita references in eslint configs and e2e tests ([70489e4](https://github.com/vm0-ai/vm0/commit/70489e495b9f9e12000722eeaf416355f699823c))

## [0.1.0](https://github.com/vm0-ai/vm0/compare/vm0-cli-v0.0.1...vm0-cli-v0.1.0) (2025-11-15)


### Features

* initial project setup from makita template ([e9c330a](https://github.com/vm0-ai/vm0/commit/e9c330a5952526d657f245e8db9522de553018b3))


### Bug Fixes

* replace remaining makita references in eslint configs and e2e tests ([70489e4](https://github.com/vm0-ai/vm0/commit/70489e495b9f9e12000722eeaf416355f699823c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.1.0

## [0.1.0](https://github.com/e7h4n/vm0/compare/vm0-cli-v0.0.1...vm0-cli-v0.1.0) (2025-08-30)


### Features

* initial commit - app template with turborepo monorepo structure ([4123914](https://github.com/e7h4n/vm0/commit/41239143cdaea284f55a02c89fde348c2e3b53ff))


### Bug Fixes

* cli e2e ([78276d7](https://github.com/e7h4n/vm0/commit/78276d78308b5a8aec85cb9ce4d137299ff0587d))
* cli package ([4ab79ab](https://github.com/e7h4n/vm0/commit/4ab79ab22e35966956080f2652f29692392bb041))
* update remaining @vm0/cli references to vm0-cli ([bd8a106](https://github.com/e7h4n/vm0/commit/bd8a106f36b95d8dcf1369e8831071f63f3ec80c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.1.0

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
