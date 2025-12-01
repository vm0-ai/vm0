# Changelog

## [3.0.0](https://github.com/vm0-ai/vm0/compare/web-v2.8.2...web-v3.0.0) (2025-12-01)


### ⚠ BREAKING CHANGES

* CLI and API now use tar.gz format exclusively. Clients must be updated to send/receive tar.gz instead of zip.

### Code Refactoring

* unify compression stack to tar.gz ([#331](https://github.com/vm0-ai/vm0/issues/331)) ([0745967](https://github.com/vm0-ai/vm0/commit/07459676b1385d30223ec63d16b2190857b70a2b))

## [2.8.2](https://github.com/vm0-ai/vm0/compare/web-v2.8.1...web-v2.8.2) (2025-12-01)


### Bug Fixes

* handle empty artifact pull without TAR_BAD_ARCHIVE error ([#328](https://github.com/vm0-ai/vm0/issues/328)) ([3f23505](https://github.com/vm0-ai/vm0/commit/3f23505af3cbbb87926fd6baa255429ee52c29b8))

## [2.8.1](https://github.com/vm0-ai/vm0/compare/web-v2.8.0...web-v2.8.1) (2025-12-01)


### Bug Fixes

* implement conversation restoration for direct --conversation flag ([#326](https://github.com/vm0-ai/vm0/issues/326)) ([faa5c0a](https://github.com/vm0-ai/vm0/commit/faa5c0adcb1f7c7125b35911d31275604cdd1bf8))

## [2.8.0](https://github.com/vm0-ai/vm0/compare/web-v2.7.0...web-v2.8.0) (2025-11-30)


### Features

* **cli:** add --force flag to volume push command ([#321](https://github.com/vm0-ai/vm0/issues/321)) ([9e42c86](https://github.com/vm0-ai/vm0/commit/9e42c86fd6eec99062911b0e367bf27de89eabcb))

## [2.7.0](https://github.com/vm0-ai/vm0/compare/web-v2.6.2...web-v2.7.0) (2025-11-30)


### Features

* implement incremental upload for sandbox checkpoint ([#320](https://github.com/vm0-ai/vm0/issues/320)) ([2f4f1ef](https://github.com/vm0-ai/vm0/commit/2f4f1efef12bcbefc3faf4371634320005ba4ab5))
* tar.gz streaming with content-addressable blob storage ([#311](https://github.com/vm0-ai/vm0/issues/311)) ([d271acb](https://github.com/vm0-ai/vm0/commit/d271acb1ce5b641dda20e64199f9c26b3e013bff))

## [2.6.2](https://github.com/vm0-ai/vm0/compare/web-v2.6.1...web-v2.6.2) (2025-11-29)


### Bug Fixes

* handle empty artifact/volume in storage operations ([#312](https://github.com/vm0-ai/vm0/issues/312)) ([053b658](https://github.com/vm0-ai/vm0/commit/053b658412e12b8a5f91072d781d8f3eaaa24193))

## [2.6.1](https://github.com/vm0-ai/vm0/compare/web-v2.6.0...web-v2.6.1) (2025-11-29)


### Bug Fixes

* handle empty zip uploads in storage webhook ([#306](https://github.com/vm0-ai/vm0/issues/306)) ([cad45a8](https://github.com/vm0-ai/vm0/commit/cad45a874ab6006db3106b3aca8d36dde7f57804))

## [2.6.0](https://github.com/vm0-ai/vm0/compare/web-v2.5.0...web-v2.6.0) (2025-11-29)


### Features

* enforce promise await with eslint rules ([#303](https://github.com/vm0-ai/vm0/issues/303)) ([1989958](https://github.com/vm0-ai/vm0/commit/19899587084d866c462bf552b4e78f352163e5e0))

## [2.5.0](https://github.com/vm0-ai/vm0/compare/web-v2.4.1...web-v2.5.0) (2025-11-29)


### Features

* add direct S3 download to sandbox for faster storage preparation ([#299](https://github.com/vm0-ai/vm0/issues/299)) ([297d508](https://github.com/vm0-ai/vm0/commit/297d508674d009d059d7dc7bad60cb297bc5bc93))
* support empty artifact and volume push ([#296](https://github.com/vm0-ai/vm0/issues/296)) ([d1449e9](https://github.com/vm0-ai/vm0/commit/d1449e9cc691d28cc9a69f622d9bf5fe5076ec3d))


### Bug Fixes

* use waituntil to ensure background execution completes ([#302](https://github.com/vm0-ai/vm0/issues/302)) ([f95f1aa](https://github.com/vm0-ai/vm0/commit/f95f1aab327308a8097b065050eebf2078a46361))


### Performance Improvements

* parallelize storage operations for faster agent startup ([#298](https://github.com/vm0-ai/vm0/issues/298)) ([7a643c2](https://github.com/vm0-ai/vm0/commit/7a643c2b72df679566e1d7276c81b1b2844c87d9))

## [2.4.1](https://github.com/vm0-ai/vm0/compare/web-v2.4.0...web-v2.4.1) (2025-11-29)


### Bug Fixes

* display volumes in vm0_start event ([#293](https://github.com/vm0-ai/vm0/issues/293)) ([2249f03](https://github.com/vm0-ai/vm0/commit/2249f0349a7088130ff0bd6fc17664a930ccc53e))

## [2.4.0](https://github.com/vm0-ai/vm0/compare/web-v2.3.0...web-v2.4.0) (2025-11-28)


### Features

* use content-based sha-256 hash for storage version ids ([#289](https://github.com/vm0-ai/vm0/issues/289)) ([69eb252](https://github.com/vm0-ai/vm0/commit/69eb252d85883f4cb9943613142f6feafbe947b6))

## [2.3.0](https://github.com/vm0-ai/vm0/compare/web-v2.2.0...web-v2.3.0) (2025-11-28)


### Features

* enhance vm0 run output with complete execution context ([#283](https://github.com/vm0-ai/vm0/issues/283)) ([5f4eeb6](https://github.com/vm0-ai/vm0/commit/5f4eeb624522f109f4afb916b374cf005528d5cc))
* **web:** add structured logging system ([#277](https://github.com/vm0-ai/vm0/issues/277)) ([c2788b4](https://github.com/vm0-ai/vm0/commit/c2788b4ceb3bd140656efb890d4a55e686df4f0c))


### Bug Fixes

* extract stderr from E2B CommandExitError for better error reporting ([#287](https://github.com/vm0-ai/vm0/issues/287)) ([80df946](https://github.com/vm0-ai/vm0/commit/80df9464df9512ecf0281c29e6c3b4bca0b9b106))
* improve sandbox script error handling with retry and unified logging ([#273](https://github.com/vm0-ai/vm0/issues/273)) ([5201591](https://github.com/vm0-ai/vm0/commit/5201591864b327579050d94112734cc13a08adbd))

## [2.2.0](https://github.com/vm0-ai/vm0/compare/web-v2.1.1...web-v2.2.0) (2025-11-28)


### Features

* unify agent run API with volume version override support ([#258](https://github.com/vm0-ai/vm0/issues/258)) ([7a5260e](https://github.com/vm0-ai/vm0/commit/7a5260e573dbd42ef084e30d739d7a7773ec65c5))

## [2.1.1](https://github.com/vm0-ai/vm0/compare/web-v2.1.0...web-v2.1.1) (2025-11-28)


### Bug Fixes

* **web:** make landing page cube respond to window-wide mouse movement ([#252](https://github.com/vm0-ai/vm0/issues/252)) ([ea50d7f](https://github.com/vm0-ai/vm0/commit/ea50d7f19356b5b741910d4ddd42938a00fb1c73))

## [2.1.0](https://github.com/vm0-ai/vm0/compare/web-v2.0.0...web-v2.1.0) (2025-11-27)


### Features

* introduce Agent Session concept and refactor vm0 run CLI ([#243](https://github.com/vm0-ai/vm0/issues/243)) ([2211c97](https://github.com/vm0-ai/vm0/commit/2211c972d5ee295a9f84780dd938c27ebec40ff7))

## [2.0.0](https://github.com/vm0-ai/vm0/compare/web-v1.6.1...web-v2.0.0) (2025-11-27)


### ⚠ BREAKING CHANGES

* Checkpoint schema changed, requires database migration

### Features

* **cli:** add version selection support for volume and artifact pull ([#223](https://github.com/vm0-ai/vm0/issues/223)) ([7981119](https://github.com/vm0-ai/vm0/commit/7981119217f138b912773808a98e85725c7f4752))
* **config:** restructure agent.yaml format and artifact handling ([#224](https://github.com/vm0-ai/vm0/issues/224)) ([b60d92e](https://github.com/vm0-ai/vm0/commit/b60d92ef1e97aef54fc9a39b6c13e09aa593b928))
* remove git driver and rename vm0 to VAS ([#230](https://github.com/vm0-ai/vm0/issues/230)) ([0c5bdad](https://github.com/vm0-ai/vm0/commit/0c5bdadf09a0d281d42a90951e5e89bc5e47550b))
* **web:** add github repository link to navbar ([#245](https://github.com/vm0-ai/vm0/issues/245)) ([f13cbbb](https://github.com/vm0-ai/vm0/commit/f13cbbba4203bbfdaf11f8b45885a914ebe837b7))


### Code Refactoring

* restructure checkpoint schema with conversations table ([#231](https://github.com/vm0-ai/vm0/issues/231)) ([#239](https://github.com/vm0-ai/vm0/issues/239)) ([8f05f0b](https://github.com/vm0-ai/vm0/commit/8f05f0b7a38dbd7ac9c24da2f442517de8c70a29))

## [1.6.1](https://github.com/vm0-ai/vm0/compare/web-v1.6.0...web-v1.6.1) (2025-11-26)


### Bug Fixes

* fail fast when vm0 artifact configured but no artifact key provided ([#214](https://github.com/vm0-ai/vm0/issues/214)) ([bebcedc](https://github.com/vm0-ai/vm0/commit/bebcedcf21111611607c9b8dc352a539dc2ed473))
* make s3 bucket name configurable via environment variable ([#212](https://github.com/vm0-ai/vm0/issues/212)) ([6f61cc5](https://github.com/vm0-ai/vm0/commit/6f61cc50ae59a4e3554e428c465ce7e7085b1768))

## [1.6.0](https://github.com/vm0-ai/vm0/compare/web-v1.5.0...web-v1.6.0) (2025-11-26)


### Features

* add mock-claude for faster e2e testing ([#207](https://github.com/vm0-ai/vm0/issues/207)) ([745ba86](https://github.com/vm0-ai/vm0/commit/745ba86306c71af8b8c2f45b63819f8283dbeb70))
* replace dynamic_volumes with artifact concept ([#210](https://github.com/vm0-ai/vm0/issues/210)) ([5cc831c](https://github.com/vm0-ai/vm0/commit/5cc831c81041ae8f80c425d68b9491354eaafa2b))

## [1.5.0](https://github.com/vm0-ai/vm0/compare/web-v1.4.0...web-v1.5.0) (2025-11-25)


### Features

* add contact us and website tracking ([#205](https://github.com/vm0-ai/vm0/issues/205)) ([c3b93a9](https://github.com/vm0-ai/vm0/commit/c3b93a9375efd71c887be86a84ad2749a63d76fa))

## [1.4.0](https://github.com/vm0-ai/vm0/compare/web-v1.3.3...web-v1.4.0) (2025-11-25)


### Features

* add vm0 driver support for dynamic_volumes with checkpoint versioning ([#190](https://github.com/vm0-ai/vm0/issues/190)) ([a8e10b8](https://github.com/vm0-ai/vm0/commit/a8e10b848d41055686775197d4c650e70d6fe3f9))

## [1.3.3](https://github.com/vm0-ai/vm0/compare/web-v1.3.2...web-v1.3.3) (2025-11-25)


### Bug Fixes

* push git branch to remote in sandbox script even without changes ([#197](https://github.com/vm0-ai/vm0/issues/197)) ([4213bfe](https://github.com/vm0-ai/vm0/commit/4213bfe6deca858095077d1c7317bc677e77dfe1))

## [1.3.2](https://github.com/vm0-ai/vm0/compare/web-v1.3.1...web-v1.3.2) (2025-11-25)


### Bug Fixes

* push git branch to remote even when no changes to commit ([#193](https://github.com/vm0-ai/vm0/issues/193)) ([687a71d](https://github.com/vm0-ai/vm0/commit/687a71de1eb7f3869c9beab3fefb9dbe9d0d5151))

## [1.3.1](https://github.com/vm0-ai/vm0/compare/web-v1.3.0...web-v1.3.1) (2025-11-25)


### Bug Fixes

* fail agent run when vm0 volume preparation fails ([#188](https://github.com/vm0-ai/vm0/issues/188)) ([406a5ed](https://github.com/vm0-ai/vm0/commit/406a5ed6733077696c97f734be2e8405d19e9782))

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
