# Changelog

## [0.6.14](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.13...guest-mock-codex-v0.6.14) (2026-07-28)


### Bug Fixes

* **runner:** classify codex safety policy refusals ([#23391](https://github.com/vm0-ai/vm0/issues/23391)) ([a1d9986](https://github.com/vm0-ai/vm0/commit/a1d9986f1183067249dc168ba3643acdf05f79ca))

## [0.6.13](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.12...guest-mock-codex-v0.6.13) (2026-07-25)


### Performance Improvements

* add first-output coverage and codex lifecycle timings ([#22946](https://github.com/vm0-ai/vm0/issues/22946)) ([12e1316](https://github.com/vm0-ai/vm0/commit/12e13160392117b0fbe950b51fb0edc986059b90))

## [0.6.12](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.11...guest-mock-codex-v0.6.12) (2026-07-23)


### Bug Fixes

* **rust:** keep child ownership through test timeouts ([#22725](https://github.com/vm0-ai/vm0/issues/22725)) ([6e4de93](https://github.com/vm0-ai/vm0/commit/6e4de931a86ee553aad08e6c305ff32da8125da8))

## [0.6.11](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.10...guest-mock-codex-v0.6.11) (2026-07-21)


### Documentation

* **guest-mock-codex:** document app server contract ([#22424](https://github.com/vm0-ai/vm0/issues/22424)) ([723a76d](https://github.com/vm0-ai/vm0/commit/723a76dfe5331b786e5fc9d3ef40a6239c57a83f))

## [0.6.10](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.9...guest-mock-codex-v0.6.10) (2026-07-21)


### Bug Fixes

* **guest-agent:** raise cli event delivery queue to 512 ([#22265](https://github.com/vm0-ai/vm0/issues/22265)) ([30b0657](https://github.com/vm0-ai/vm0/commit/30b06579b766b6f1966c94688c9b84cc3e7066a5))

## [0.6.9](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.8...guest-mock-codex-v0.6.9) (2026-07-17)


### Performance Improvements

* **guest-agent:** bound cli event delivery buffering ([#22015](https://github.com/vm0-ai/vm0/issues/22015)) ([0bde876](https://github.com/vm0-ai/vm0/commit/0bde876b83ef7781a24deb495f68ebec5e78e1cf))

## [0.6.8](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.7...guest-mock-codex-v0.6.8) (2026-07-16)


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))

## [0.6.7](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.6...guest-mock-codex-v0.6.7) (2026-07-15)


### Bug Fixes

* **guest-agent:** pass codex prompts through stdin ([#21548](https://github.com/vm0-ai/vm0/issues/21548)) ([3c5e277](https://github.com/vm0-ai/vm0/commit/3c5e2779872cf7e93de88f6b10be646e2ad06ba6))

## [0.6.6](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.5...guest-mock-codex-v0.6.6) (2026-07-13)


### Refactoring

* remove vm0 api url env ([#21215](https://github.com/vm0-ai/vm0/issues/21215)) ([6f0d6a9](https://github.com/vm0-ai/vm0/commit/6f0d6a9bdf80c0437d3ef529fd06eacd62a0c412))

## [0.6.5](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.4...guest-mock-codex-v0.6.5) (2026-07-13)


### Performance Improvements

* **guest-agent:** move parsed app-server payloads ([#21198](https://github.com/vm0-ai/vm0/issues/21198)) ([d89b5ec](https://github.com/vm0-ai/vm0/commit/d89b5ec872f58efd31c99ae6c9986b3b1662ee21))

## [0.6.4](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.3...guest-mock-codex-v0.6.4) (2026-07-11)


### Refactoring

* **guest-mock-codex:** split integration tests ([#21053](https://github.com/vm0-ai/vm0/issues/21053)) ([3b85669](https://github.com/vm0-ai/vm0/commit/3b856694441630772f1c27999ad4e6f7283db626))

## [0.6.3](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.2...guest-mock-codex-v0.6.3) (2026-07-08)


### Refactoring

* **guest-mock-codex:** split app-server handlers ([#20683](https://github.com/vm0-ai/vm0/issues/20683)) ([b512da3](https://github.com/vm0-ai/vm0/commit/b512da3cdc16fc41b29253a6f312ba5a51f339fd))

## [0.6.2](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.1...guest-mock-codex-v0.6.2) (2026-07-08)


### Bug Fixes

* configure minimax codex runtime provider ([#20588](https://github.com/vm0-ai/vm0/issues/20588)) ([a5ae66b](https://github.com/vm0-ai/vm0/commit/a5ae66be4034b2b018175593b02b57d00a90615e))

## [0.6.1](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.6.0...guest-mock-codex-v0.6.1) (2026-07-01)


### Refactoring

* migrate guest-agent CLI runtime inputs ([#19514](https://github.com/vm0-ai/vm0/issues/19514)) ([bee67d0](https://github.com/vm0-ai/vm0/commit/bee67d0bc1b5d2d90b7fe0e664dc0a6579c7e16f))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.5.0...guest-mock-codex-v0.6.0) (2026-06-30)


### Features

* enable codex local active input ([#19463](https://github.com/vm0-ai/vm0/issues/19463)) ([5a34420](https://github.com/vm0-ai/vm0/commit/5a34420314311d9a290c195f33539d8359303660))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.4.0...guest-mock-codex-v0.5.0) (2026-06-30)


### Features

* add Codex app-server active input steering ([#19361](https://github.com/vm0-ai/vm0/issues/19361)) ([7a231a7](https://github.com/vm0-ai/vm0/commit/7a231a7e9069c817b314aeea7408859b496c60d2))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.3.2...guest-mock-codex-v0.4.0) (2026-06-29)


### Features

* add disabled codex app-server backend ([#19207](https://github.com/vm0-ai/vm0/issues/19207)) ([6a3a6e2](https://github.com/vm0-ai/vm0/commit/6a3a6e2aeb8820029b7388869600d849f629fcbb))

## [0.3.2](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.3.1...guest-mock-codex-v0.3.2) (2026-06-29)


### Bug Fixes

* bound codex session cleanup traversal ([#19265](https://github.com/vm0-ai/vm0/issues/19265)) ([0ad8dd7](https://github.com/vm0-ai/vm0/commit/0ad8dd7cc4a2ba0e4d1f0e3732b7cc2596b5b38f))

## [0.3.1](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.3.0...guest-mock-codex-v0.3.1) (2026-06-25)


### Refactoring

* consolidate mock codex session candidates ([#18956](https://github.com/vm0-ai/vm0/issues/18956)) ([0386f78](https://github.com/vm0-ai/vm0/commit/0386f78645102397aeed6a8e079b60374d57bb21))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.2.5...guest-mock-codex-v0.3.0) (2026-06-22)


### Features

* add Codex app-server JSON-RPC client ([#18428](https://github.com/vm0-ai/vm0/issues/18428)) ([8c49a61](https://github.com/vm0-ai/vm0/commit/8c49a6119ad8a6fe483d518ea7f4436114b18082))

## [0.2.5](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.2.4...guest-mock-codex-v0.2.5) (2026-06-11)


### Performance Improvements

* avoid cloning mock codex prompt parts ([#17210](https://github.com/vm0-ai/vm0/issues/17210)) ([3251264](https://github.com/vm0-ai/vm0/commit/3251264313c7a0562285cbf1d4b2f291d5bfe997))

## [0.2.4](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.2.3...guest-mock-codex-v0.2.4) (2026-06-10)


### Bug Fixes

* harden mock codex session persistence ([#16940](https://github.com/vm0-ai/vm0/issues/16940)) ([39374df](https://github.com/vm0-ai/vm0/commit/39374df46e1f7e42e51cc00cab388c10d39107c4))

## [0.2.3](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.2.2...guest-mock-codex-v0.2.3) (2026-06-09)


### Refactoring

* move guest mock codex contract to library ([#16864](https://github.com/vm0-ai/vm0/issues/16864)) ([1f046d9](https://github.com/vm0-ai/vm0/commit/1f046d9ec6f5d30e51ec6a4a5b8fe938578d7c38)), closes [#16782](https://github.com/vm0-ai/vm0/issues/16782)

## [0.2.2](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.2.1...guest-mock-codex-v0.2.2) (2026-06-02)


### Bug Fixes

* validate mock codex resume thread ids ([#15883](https://github.com/vm0-ai/vm0/issues/15883)) ([f38debe](https://github.com/vm0-ai/vm0/commit/f38debe8e6f6319795ce14cffd00a94dee792e2f))

## [0.2.1](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.2.0...guest-mock-codex-v0.2.1) (2026-05-25)


### Bug Fixes

* downgrade expected runner job failures ([#14845](https://github.com/vm0-ai/vm0/issues/14845)) ([01e7044](https://github.com/vm0-ai/vm0/commit/01e7044031f4d998bce986e724b3329aba72ecf2))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.1.2...guest-mock-codex-v0.2.0) (2026-05-11)


### Features

* enable Codex memory mounting ([#12651](https://github.com/vm0-ai/vm0/issues/12651)) ([3646b72](https://github.com/vm0-ai/vm0/commit/3646b72ccafa675ff53895f797a99a1e754fd82e))

## [0.1.2](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.1.1...guest-mock-codex-v0.1.2) (2026-05-08)


### Bug Fixes

* restore codex sessions as jsonl ([#12137](https://github.com/vm0-ai/vm0/issues/12137)) ([ab3dc5b](https://github.com/vm0-ai/vm0/commit/ab3dc5b5f35105709cc22d7caf9e571c59ec5a39))

## [0.1.1](https://github.com/vm0-ai/vm0/compare/guest-mock-codex-v0.1.0...guest-mock-codex-v0.1.1) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## 0.1.0 (2026-04-28)


### Features

* **crates:** add guest-mock-codex crate for codex protocol mocking ([#11426](https://github.com/vm0-ai/vm0/issues/11426)) ([33dfe9e](https://github.com/vm0-ai/vm0/commit/33dfe9ee0b6f8d641d3cf35060be6e568f44050f)), closes [#11417](https://github.com/vm0-ai/vm0/issues/11417)
