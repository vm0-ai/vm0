# Changelog

## [1.3.0](https://github.com/vm0-ai/vm0/compare/web-v1.2.1...web-v1.3.0) (2025-11-25)


### Features

* add version management to vm0 volumes ([#182](https://github.com/vm0-ai/vm0/issues/182)) ([96677de](https://github.com/vm0-ai/vm0/commit/96677de998ca22f7e441c4b38d44c1dd47bac64c))

## [1.2.1](https://github.com/vm0-ai/vm0/compare/web-v1.2.0...web-v1.2.1) (2025-11-24)


### Bug Fixes

* improve checkpoint resume debugging for git volumes ([#176](https://github.com/vm0-ai/vm0/issues/176)) ([#178](https://github.com/vm0-ai/vm0/issues/178)) ([228bab2](https://github.com/vm0-ai/vm0/commit/228bab2bb0fea624ee31ee99267d3179154ba2d0))

## [1.2.0](https://github.com/vm0-ai/vm0/compare/web-v1.1.0...web-v1.2.0) (2025-11-24)


### Features

* implement vm0 managed volumes (simple MVP - full upload/download) ([#172](https://github.com/vm0-ai/vm0/issues/172)) ([ce2f717](https://github.com/vm0-ai/vm0/commit/ce2f717ae1c05c806a9a2f5cd1febd57ad7be1ce))


### Bug Fixes

* remove all eslint suppression comments and use vi.stubEnv for tests ([#171](https://github.com/vm0-ai/vm0/issues/171)) ([e210c7c](https://github.com/vm0-ai/vm0/commit/e210c7c0df82e045b3e9103b0bd6dabc28567c12))

## [1.1.0](https://github.com/vm0-ai/vm0/compare/web-v1.0.0...web-v1.1.0) (2025-11-23)


### Features

* add validation for environment and template variables before execution ([#164](https://github.com/vm0-ai/vm0/issues/164)) ([a197eba](https://github.com/vm0-ai/vm0/commit/a197eba8ee189e37317e80fd720d1a8df64a863a))


### Bug Fixes

* remove duplicate result event emission in agent execution ([#162](https://github.com/vm0-ai/vm0/issues/162)) ([3d7b336](https://github.com/vm0-ai/vm0/commit/3d7b3364fba12ff2519e2176e8ef42305cb8d08d))

## [1.0.0](https://github.com/vm0-ai/vm0/compare/web-v0.7.0...web-v1.0.0) (2025-11-22)


### ⚠ BREAKING CHANGES

* rename 'dynamic-volumes' to 'dynamic_volumes' in config files

### Features

* add checkpoint api endpoint for saving agent run state ([#152](https://github.com/vm0-ai/vm0/issues/152)) ([098adc6](https://github.com/vm0-ai/vm0/commit/098adc6368b9c7bb4f9c6584bc988dd3ab0aa311))
* add git volume driver support for repository mounting ([#150](https://github.com/vm0-ai/vm0/issues/150)) ([6f3d79c](https://github.com/vm0-ai/vm0/commit/6f3d79cdfb785107beab09c9fb5b7fdb737b7bb3))
* enable runtime script transfer for dynamic agent execution ([#139](https://github.com/vm0-ai/vm0/issues/139)) ([77383f0](https://github.com/vm0-ai/vm0/commit/77383f077bc38fc64b7cb566275c6c2e23f21481))
* implement checkpoint resume functionality ([#156](https://github.com/vm0-ai/vm0/issues/156)) ([304f672](https://github.com/vm0-ai/vm0/commit/304f672dd800a5d9d2b18001438ff67260019efe))
* implement VM0 system events for run lifecycle management ([#154](https://github.com/vm0-ai/vm0/issues/154)) ([8e2ff1d](https://github.com/vm0-ai/vm0/commit/8e2ff1d6f8370225b3e6085a56e3bb8eb680a755))
* standardize config naming to snake_case for reserved keywords ([#135](https://github.com/vm0-ai/vm0/issues/135)) ([126fcfd](https://github.com/vm0-ai/vm0/commit/126fcfde1b1101fc7d10de1b4886ac11c0da156d))


### Bug Fixes

* correct typos in landing page CLI section ([#158](https://github.com/vm0-ai/vm0/issues/158)) ([eccd66b](https://github.com/vm0-ai/vm0/commit/eccd66bce473b3fa62ab652350e935671335c1da))


### Performance Improvements

* optimize landing page background images ([#141](https://github.com/vm0-ai/vm0/issues/141)) ([6d160ab](https://github.com/vm0-ai/vm0/commit/6d160ab3540e063856144dfbec80578920eaefda))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/web-v0.6.0...web-v0.7.0) (2025-11-21)


### Features

* migrate landing page to apps/web ([#136](https://github.com/vm0-ai/vm0/issues/136)) ([a11e26e](https://github.com/vm0-ai/vm0/commit/a11e26ebbc0a8787792918882c6243180a1603f4))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/web-v0.5.1...web-v0.6.0) (2025-11-21)


### Features

* use agent.image for E2B template selection ([#125](https://github.com/vm0-ai/vm0/issues/125)) ([6d73ddb](https://github.com/vm0-ai/vm0/commit/6d73ddbfe1d9589f96b9956cbe4f5284409d4478))

## [0.5.1](https://github.com/vm0-ai/vm0/compare/web-v0.5.0...web-v0.5.1) (2025-11-20)


### Bug Fixes

* set explicit 1-hour timeout for e2b sandbox lifecycle ([#117](https://github.com/vm0-ai/vm0/issues/117)) ([b1594b8](https://github.com/vm0-ai/vm0/commit/b1594b8b59600341d5ea3bde3623da4e7cec4b8d))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/web-v0.4.1...web-v0.5.0) (2025-11-20)


### Features

* add working_dir support for agent execution ([#113](https://github.com/vm0-ai/vm0/issues/113)) ([a96f487](https://github.com/vm0-ai/vm0/commit/a96f487d8536041b86ef49cd05621dfa5476d5dc))
* implement volume mounting for S3-backed agent workspaces ([#103](https://github.com/vm0-ai/vm0/issues/103)) ([85f7b8e](https://github.com/vm0-ai/vm0/commit/85f7b8e758a6b4d2d5ae6b899be2c4b247959302))


### Bug Fixes

* remove timeout limitation for e2b sandbox command execution ([#114](https://github.com/vm0-ai/vm0/issues/114)) ([e4c5c86](https://github.com/vm0-ai/vm0/commit/e4c5c869aa4af6433f871b38a199f13895e94704))
* require authentication for cli device authorization page ([#104](https://github.com/vm0-ai/vm0/issues/104)) ([39428a4](https://github.com/vm0-ai/vm0/commit/39428a4c209403e15a48eea8d468860a50ec716b))

## [0.4.1](https://github.com/vm0-ai/vm0/compare/web-v0.4.0...web-v0.4.1) (2025-11-20)


### Bug Fixes

* use production url for e2b webhook callbacks ([#100](https://github.com/vm0-ai/vm0/issues/100)) ([ead881d](https://github.com/vm0-ai/vm0/commit/ead881d89efbe33d0a2f656b230aa0aac2ba51e3))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/web-v0.3.0...web-v0.4.0) (2025-11-20)


### Features

* **ci:** add environment variables injection for e2b and minimax ([#97](https://github.com/vm0-ai/vm0/issues/97)) ([584ebcc](https://github.com/vm0-ai/vm0/commit/584ebcc92f9ef888921319d2944fa6106175c223))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/web-v0.2.0...web-v0.3.0) (2025-11-20)


### Features

* add CLI e2e device flow automation and production API fallback ([#73](https://github.com/vm0-ai/vm0/issues/73)) ([8eb2d21](https://github.com/vm0-ai/vm0/commit/8eb2d21e6a2f363f93575f85bde5081a2ff218a7))
* add device flow authentication for cli ([#39](https://github.com/vm0-ai/vm0/issues/39)) ([b6ae61c](https://github.com/vm0-ai/vm0/commit/b6ae61c4244b318e9a6d3969d1ab57bd3d47c873))
* add e2b api key configuration ([#41](https://github.com/vm0-ai/vm0/issues/41)) ([e4fd5ed](https://github.com/vm0-ai/vm0/commit/e4fd5edd85a30225f6efac9e26677d9a4ec59f77))
* add support for agent names in vm0 run command ([#71](https://github.com/vm0-ai/vm0/issues/71)) ([4842d80](https://github.com/vm0-ai/vm0/commit/4842d80f0ce24aec3683ff0e364fc9e22eb24177))
* implement CLI build and run commands ([#65](https://github.com/vm0-ai/vm0/issues/65)) ([c0b8d11](https://github.com/vm0-ai/vm0/commit/c0b8d114a8c6910bfce7c2e4e10a82509889a28f))
* implement event streaming for vm0 run command ([#92](https://github.com/vm0-ai/vm0/issues/92)) ([a551950](https://github.com/vm0-ai/vm0/commit/a5519501aa6e7b3b739e05a965d58868498dbdca))
* implement phase 1 database schema and api framework for agent configs ([#37](https://github.com/vm0-ai/vm0/issues/37)) ([f8a9b08](https://github.com/vm0-ai/vm0/commit/f8a9b0815c8b3c4b5063d8f1d84cea522006f79c))
* implement phase 1 database schema and api framework with integration tests ([#44](https://github.com/vm0-ai/vm0/issues/44)) ([d89e686](https://github.com/vm0-ai/vm0/commit/d89e686282b409149187c684371077387b91b31a))
* implement Phase 1.5 E2B Service Layer with Hello World ([#46](https://github.com/vm0-ai/vm0/issues/46)) ([7e5b639](https://github.com/vm0-ai/vm0/commit/7e5b6397c21222843de07ee5895e9f7c9c844038))
* implement webhook API for agent events ([#54](https://github.com/vm0-ai/vm0/issues/54)) ([ea55437](https://github.com/vm0-ai/vm0/commit/ea554376a3b0f2188d8ea53a15f02883fbd84f01))
* integrate Claude Code execution in E2B sandbox ([#58](https://github.com/vm0-ai/vm0/issues/58)) ([a8434d9](https://github.com/vm0-ai/vm0/commit/a8434d9fbf7d00b4854040227477d8d66a609266))
* integrate database storage with agent runtime API ([#49](https://github.com/vm0-ai/vm0/issues/49)) ([d743837](https://github.com/vm0-ai/vm0/commit/d743837224cc639791bae78c28cbe1c6cf742328))
* migrate authentication from api keys to bearer tokens ([#59](https://github.com/vm0-ai/vm0/issues/59)) ([87c887c](https://github.com/vm0-ai/vm0/commit/87c887cdf900010f8b71bf900b910abf8af60a69))


### Bug Fixes

* change agent_runtime_events.sequenceNumber from varchar to integer ([#55](https://github.com/vm0-ai/vm0/issues/55)) ([0b860e1](https://github.com/vm0-ai/vm0/commit/0b860e1a43ab0a1a7eb62223f8c787b2270ed05c))
* resolve E2B script loading error by pre-installing run-agent.sh in template ([#68](https://github.com/vm0-ai/vm0/issues/68)) ([0cc2bd3](https://github.com/vm0-ai/vm0/commit/0cc2bd3875bce658f3055290c1f1643b732ac24c))
* update webhook sequence numbers to use integer type ([#57](https://github.com/vm0-ai/vm0/issues/57)) ([d67380a](https://github.com/vm0-ai/vm0/commit/d67380afea6aed7e09e92bef9ff71fa41efec58e))
* use correct env var and auth header for webhook authentication ([#80](https://github.com/vm0-ai/vm0/issues/80)) ([b821df4](https://github.com/vm0-ai/vm0/commit/b821df4d412da54aa880dbd98d1b57567cf1b4e0))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/web-v0.1.0...web-v0.2.0) (2025-11-15)

### Features

- integrate clerk authentication for web app ([#15](https://github.com/vm0-ai/vm0/issues/15)) ([c855703](https://github.com/vm0-ai/vm0/commit/c8557031027ccc03d147f164bd03821962a71daa))

## [0.1.0](https://github.com/vm0-ai/vm0/compare/web-v0.0.1...web-v0.1.0) (2025-11-15)

### Features

- initial project setup from makita template ([e9c330a](https://github.com/vm0-ai/vm0/commit/e9c330a5952526d657f245e8db9522de553018b3))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @vm0/core bumped to 0.1.0

## [0.1.0](https://github.com/e7h4n/vm0/compare/web-v0.0.1...web-v0.1.0) (2025-08-30)

### Features

- add database migration support with postgres driver ([#24](https://github.com/e7h4n/vm0/issues/24)) ([3760efa](https://github.com/e7h4n/vm0/commit/3760efae5a3cb47a6dfa56e13507dcddb58b92b6))
- add t3-env for type-safe environment variable validation ([#5](https://github.com/e7h4n/vm0/issues/5)) ([10ac6ab](https://github.com/e7h4n/vm0/commit/10ac6ab67e654b6fa8aeef8e6c63649f003f5656))
- implement centralized API contract system ([#13](https://github.com/e7h4n/vm0/issues/13)) ([77bbbd9](https://github.com/e7h4n/vm0/commit/77bbbd913b52341a7720e9bb711d889253d9681a))
- implement lightweight service container for dependency management ([#18](https://github.com/e7h4n/vm0/issues/18)) ([ce6efe9](https://github.com/e7h4n/vm0/commit/ce6efe9df914c0e2bc8de3ccc7a0af114a2b4037))
- initial commit - app template with turborepo monorepo structure ([4123914](https://github.com/e7h4n/vm0/commit/41239143cdaea284f55a02c89fde348c2e3b53ff))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @vm0/core bumped to 0.1.0
