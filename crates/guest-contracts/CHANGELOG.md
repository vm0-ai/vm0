# Changelog

## [0.3.17](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.16...guest-contracts-v0.3.17) (2026-07-21)


### Performance Improvements

* align session-history sidecar capacity with resume limit ([#22392](https://github.com/vm0-ai/vm0/issues/22392)) ([6eee854](https://github.com/vm0-ai/vm0/commit/6eee8548718c69c4d46afe9b1ddcd8c7babcca59))

## [0.3.16](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.15...guest-contracts-v0.3.16) (2026-07-19)


### Bug Fixes

* **guest-agent:** bound ordinary cli stdout ingestion ([#22095](https://github.com/vm0-ai/vm0/issues/22095)) ([4641dd5](https://github.com/vm0-ai/vm0/commit/4641dd5e1340bb204866e0433eb4adbe5eb955f2))

## [0.3.15](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.14...guest-contracts-v0.3.15) (2026-07-17)


### Bug Fixes

* **vsock:** replace descendant process-group cleanup with exec cgroups ([#22013](https://github.com/vm0-ai/vm0/issues/22013)) ([302bf21](https://github.com/vm0-ai/vm0/commit/302bf216fac511a8fd6bf9c0c778cf8643f2374b))


### Performance Improvements

* **guest-agent:** bound cli event delivery buffering ([#22015](https://github.com/vm0-ai/vm0/issues/22015)) ([0bde876](https://github.com/vm0-ai/vm0/commit/0bde876b83ef7781a24deb495f68ebec5e78e1cf))

## [0.3.14](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.13...guest-contracts-v0.3.14) (2026-07-17)


### Documentation

* **rust:** clarify stack-dependent execve budget ([#21974](https://github.com/vm0-ai/vm0/issues/21974)) ([fb75eff](https://github.com/vm0-ai/vm0/commit/fb75eff67f38b2778427efbf9e501708b0ed616e))

## [0.3.13](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.12...guest-contracts-v0.3.13) (2026-07-16)


### Bug Fixes

* **runner:** classify oversized sidecars as unavailable ([#21877](https://github.com/vm0-ai/vm0/issues/21877)) ([d9fde61](https://github.com/vm0-ai/vm0/commit/d9fde61a0cce1579c4cf841e3e721aaf016eb537))

## [0.3.12](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.11...guest-contracts-v0.3.12) (2026-07-16)


### Bug Fixes

* **runner:** contain supervised run descendants ([#21780](https://github.com/vm0-ai/vm0/issues/21780)) ([23e961c](https://github.com/vm0-ai/vm0/commit/23e961ce1b30f45ec9786e30289d870f5f436762))

## [0.3.11](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.10...guest-contracts-v0.3.11) (2026-07-16)


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))

## [0.3.10](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.9...guest-contracts-v0.3.10) (2026-07-15)


### Bug Fixes

* **runner:** qualify guest rootfs before idle reuse ([#21563](https://github.com/vm0-ai/vm0/issues/21563)) ([b9230c3](https://github.com/vm0-ai/vm0/commit/b9230c3bd213fb95777e0b5f84b17bbbbc3dd2e8))

## [0.3.9](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.8...guest-contracts-v0.3.9) (2026-07-13)


### Refactoring

* remove vm0 api url env ([#21215](https://github.com/vm0-ai/vm0/issues/21215)) ([6f0d6a9](https://github.com/vm0-ai/vm0/commit/6f0d6a9bdf80c0437d3ef529fd06eacd62a0c412))

## [0.3.8](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.7...guest-contracts-v0.3.8) (2026-07-10)


### Refactoring

* **runner:** introduce explicit storage plan and guest wire contract ([#20912](https://github.com/vm0-ai/vm0/issues/20912)) ([07f275c](https://github.com/vm0-ai/vm0/commit/07f275c8e04a9dcd6148f7d3075258b683e4ba2e))

## [0.3.7](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.6...guest-contracts-v0.3.7) (2026-07-09)


### Performance Improvements

* cache session history with workspace images ([#20733](https://github.com/vm0-ai/vm0/issues/20733)) ([d588e5a](https://github.com/vm0-ai/vm0/commit/d588e5a9aa6e67ca18199cd74cadfa7dd4d66418))

## [0.3.6](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.5...guest-contracts-v0.3.6) (2026-07-08)


### Bug Fixes

* add runner exit signal diagnostics ([#20674](https://github.com/vm0-ai/vm0/issues/20674)) ([bf46c07](https://github.com/vm0-ai/vm0/commit/bf46c07f8a9954576040760dfcfb3bb81ee2d1ea))


### Refactoring

* centralize guest private runtime file handling ([#20671](https://github.com/vm0-ai/vm0/issues/20671)) ([24ca30c](https://github.com/vm0-ai/vm0/commit/24ca30c56b4c9b657a3aad8da2affac5a49e5b4b))

## [0.3.5](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.4...guest-contracts-v0.3.5) (2026-07-08)


### Bug Fixes

* configure minimax codex runtime provider ([#20588](https://github.com/vm0-ai/vm0/issues/20588)) ([a5ae66b](https://github.com/vm0-ai/vm0/commit/a5ae66be4034b2b018175593b02b57d00a90615e))

## [0.3.4](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.3...guest-contracts-v0.3.4) (2026-07-05)


### Refactoring

* centralize run payload field validation ([#20225](https://github.com/vm0-ai/vm0/issues/20225)) ([8a293a7](https://github.com/vm0-ai/vm0/commit/8a293a762a48b4828780e8e99ca59e48ca915415))

## [0.3.3](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.2...guest-contracts-v0.3.3) (2026-07-03)


### Bug Fixes

* move runner bootstrap payloads out of env ([#19989](https://github.com/vm0-ai/vm0/issues/19989)) ([847d8d2](https://github.com/vm0-ai/vm0/commit/847d8d24372d84568133007db87c44a0ebd72b95))

## [0.3.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.1...guest-contracts-v0.3.2) (2026-07-01)


### Bug Fixes

* classify codex context window failures ([#19607](https://github.com/vm0-ai/vm0/issues/19607)) ([34ed0ac](https://github.com/vm0-ai/vm0/commit/34ed0ac9d29d81ffda52c5ccd6bf69915d5cc80c))

## [0.3.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.3.0...guest-contracts-v0.3.1) (2026-07-01)


### Bug Fixes

* align session history verification cap ([#19561](https://github.com/vm0-ai/vm0/issues/19561)) ([657cc42](https://github.com/vm0-ai/vm0/commit/657cc422cfe1e929e921a82e7bbd7ceec0d7861d))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.10...guest-contracts-v0.3.0) (2026-06-30)


### Features

* enable codex local active input ([#19463](https://github.com/vm0-ai/vm0/issues/19463)) ([5a34420](https://github.com/vm0-ai/vm0/commit/5a34420314311d9a290c195f33539d8359303660))

## [0.2.10](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.9...guest-contracts-v0.2.10) (2026-06-30)


### Performance Improvements

* verify large session histories in guest ([#19386](https://github.com/vm0-ai/vm0/issues/19386)) ([a3f62a1](https://github.com/vm0-ai/vm0/commit/a3f62a1bd2b649e6d5dfe0a694894d020d196925))

## [0.2.9](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.8...guest-contracts-v0.2.9) (2026-06-29)


### Refactoring

* merge agent diagnostics into guest contracts ([#19317](https://github.com/vm0-ai/vm0/issues/19317)) ([e36a711](https://github.com/vm0-ai/vm0/commit/e36a71168939a1b692a1ab80005d984697a77fe4))

## [0.2.8](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.7...guest-contracts-v0.2.8) (2026-06-29)


### Bug Fixes

* declare guest-contracts serde dependencies ([#19291](https://github.com/vm0-ai/vm0/issues/19291)) ([8e739bc](https://github.com/vm0-ai/vm0/commit/8e739bc813a2eaa5dbeabbf24616a5ff0a3a34c9))

## [0.2.7](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.6...guest-contracts-v0.2.7) (2026-06-29)


### Performance Improvements

* park checkpointed session history identity ([#19270](https://github.com/vm0-ai/vm0/issues/19270)) ([e21745b](https://github.com/vm0-ai/vm0/commit/e21745be11c34b09052a27182971d4c48ab881c1))

## [0.2.6](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.5...guest-contracts-v0.2.6) (2026-06-27)


### Bug Fixes

* guard post-result cleanup deadlines ([#19179](https://github.com/vm0-ai/vm0/issues/19179)) ([e1d2779](https://github.com/vm0-ai/vm0/commit/e1d2779ab9b32e0d195e1d5bf4d3ae7745022b5d))

## [0.2.5](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.4...guest-contracts-v0.2.5) (2026-06-26)


### Documentation

* document guest contracts public api ([#19064](https://github.com/vm0-ai/vm0/issues/19064)) ([f3ba3d1](https://github.com/vm0-ai/vm0/commit/f3ba3d1dc215502eb38276246334d5260ac853ee))

## [0.2.4](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.3...guest-contracts-v0.2.4) (2026-06-25)


### Bug Fixes

* harden guest runtime private file writes ([#18797](https://github.com/vm0-ai/vm0/issues/18797)) ([f334139](https://github.com/vm0-ai/vm0/commit/f334139eec67ff4bb64d2a47c3028505bd068cdd))

## [0.2.3](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.2...guest-contracts-v0.2.3) (2026-06-22)


### Bug Fixes

* separate Claude post-result cleanup lifecycle ([#18524](https://github.com/vm0-ai/vm0/issues/18524)) ([6dcad82](https://github.com/vm0-ai/vm0/commit/6dcad82ea6241cc2197e577867ba8bee00e13525))


### Refactoring

* centralize codex thread id contract ([#18499](https://github.com/vm0-ai/vm0/issues/18499)) ([9cecc84](https://github.com/vm0-ai/vm0/commit/9cecc8421f4073ce32b6529fff89049779a7c13e))

## [0.2.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.1...guest-contracts-v0.2.2) (2026-06-19)


### Documentation

* document guest environment contract ([#18331](https://github.com/vm0-ai/vm0/issues/18331)) ([816b22f](https://github.com/vm0-ai/vm0/commit/816b22fe19ce042754266633c64b6e8d30824413))

## [0.2.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.2.0...guest-contracts-v0.2.1) (2026-06-17)


### Refactoring

* remove stale feature switches and dead code ([#18090](https://github.com/vm0-ai/vm0/issues/18090)) ([9406838](https://github.com/vm0-ai/vm0/commit/940683865a2256f83b2d92d36cf102e0fb06e131))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.1.2...guest-contracts-v0.2.0) (2026-06-17)


### Features

* **runner:** add local submit env overrides ([#17930](https://github.com/vm0-ai/vm0/issues/17930)) ([5c2c63c](https://github.com/vm0-ai/vm0/commit/5c2c63cdde42a7951e3af80dad7c892cdeca4de9))

## [0.1.2](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.1.1...guest-contracts-v0.1.2) (2026-06-17)


### Bug Fixes

* **runner:** validate benchmark env keys before startup ([#17999](https://github.com/vm0-ai/vm0/issues/17999)) ([4e6b823](https://github.com/vm0-ai/vm0/commit/4e6b823eba479c95cc7dbc8e377621f99b7ea5bf))

## [0.1.1](https://github.com/vm0-ai/vm0/compare/guest-contracts-v0.1.0...guest-contracts-v0.1.1) (2026-06-15)


### Refactoring

* centralize guest env key names ([#17626](https://github.com/vm0-ai/vm0/issues/17626)) ([476546d](https://github.com/vm0-ai/vm0/commit/476546de9d385733c481558b422511b30b1cc45a))
