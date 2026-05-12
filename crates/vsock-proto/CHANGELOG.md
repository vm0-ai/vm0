# Changelog

## [0.14.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.13.0...vsock-proto-v0.14.0) (2026-05-12)


### Features

* **vsock:** add command operation protocol surface ([#12707](https://github.com/vm0-ai/vm0/issues/12707)) ([67fff74](https://github.com/vm0-ai/vm0/commit/67fff74d52d5b2357c42a2888dcddc97c38b749d))

## [0.13.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.12.0...vsock-proto-v0.13.0) (2026-05-10)


### Features

* add host-initiated vsock control handshake ([#12543](https://github.com/vm0-ai/vm0/issues/12543)) ([de17089](https://github.com/vm0-ai/vm0/commit/de17089191b001b3ed6f33487b62a3360bf81174))


### Documentation

* document bounded exec preference ([#12599](https://github.com/vm0-ai/vm0/issues/12599)) ([70aa4eb](https://github.com/vm0-ai/vm0/commit/70aa4eb5444809dc49132cc003278eb2bd504a39))


### Refactoring

* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))

## [0.12.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.11.0...vsock-proto-v0.12.0) (2026-05-09)


### Features

* add bounded exec output policies ([#12292](https://github.com/vm0-ai/vm0/issues/12292)) ([71f6ad9](https://github.com/vm0-ai/vm0/commit/71f6ad9aaadaa9bf6589a5915c51ab4c092547eb))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.10.0...vsock-proto-v0.11.0) (2026-05-08)


### Features

* **vsock-guest:** implement bounded exec ([#12164](https://github.com/vm0-ai/vm0/issues/12164)) ([f2b85dd](https://github.com/vm0-ai/vm0/commit/f2b85dd4f73a0f4ba0032340b37e92857bd74e71))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.7...vsock-proto-v0.10.0) (2026-05-08)


### Features

* **vsock:** add bounded exec protocol messages ([#12119](https://github.com/vm0-ai/vm0/issues/12119)) ([2050fb2](https://github.com/vm0-ai/vm0/commit/2050fb27348cbccfbdd8747b26772c907b55cbc8))

## [0.9.7](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.6...vsock-proto-v0.9.7) (2026-05-05)


### Refactoring

* **vsock-proto:** dedupe output payload codec ([#11809](https://github.com/vm0-ai/vm0/issues/11809)) ([03bc395](https://github.com/vm0-ai/vm0/commit/03bc395366e299ddb481f6c548d26be350453bf0))

## [0.9.6](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.5...vsock-proto-v0.9.6) (2026-05-03)


### Refactoring

* **vsock-proto:** carry exec flags through decode ([#11712](https://github.com/vm0-ai/vm0/issues/11712)) ([0518e37](https://github.com/vm0-ai/vm0/commit/0518e37c7f8f7def316abd857be74201d5c268ed))

## [0.9.5](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.4...vsock-proto-v0.9.5) (2026-05-03)


### Documentation

* **vsock-proto:** fix decode_exec return docs ([#11694](https://github.com/vm0-ai/vm0/issues/11694)) ([5ae7202](https://github.com/vm0-ai/vm0/commit/5ae7202333860b36f5c94fc03a7eff2caf8ab490))

## [0.9.4](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.3...vsock-proto-v0.9.4) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.9.3](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.2...vsock-proto-v0.9.3) (2026-04-27)


### Bug Fixes

* make guest-agent own system log writes ([#11238](https://github.com/vm0-ai/vm0/issues/11238)) ([5041a49](https://github.com/vm0-ai/vm0/commit/5041a49416701955915962bc13aed07e5618db3e))

## [0.9.2](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.1...vsock-proto-v0.9.2) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.9.1](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.9.0...vsock-proto-v0.9.1) (2026-04-17)


### Bug Fixes

* **vsock-proto:** avoid unbounded allocation from untrusted env_count ([#9764](https://github.com/vm0-ai/vm0/issues/9764)) ([b6a16fe](https://github.com/vm0-ai/vm0/commit/b6a16fe877217b74b5f361c6e27a6445cd814519))

## [0.9.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.8.0...vsock-proto-v0.9.0) (2026-04-14)


### Features

* **vsock:** chunked write_file with append flag for large files ([#9335](https://github.com/vm0-ai/vm0/issues/9335)) ([16f128d](https://github.com/vm0-ai/vm0/commit/16f128d5e28e43c869a9e4bcc8993b1637175f93))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.7.0...vsock-proto-v0.8.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.6.0...vsock-proto-v0.7.0) (2026-03-20)


### Features

* **vsock:** add real-time stdout streaming from guest to host ([#5574](https://github.com/vm0-ai/vm0/issues/5574)) ([2afc093](https://github.com/vm0-ai/vm0/commit/2afc0930657f6bbf1e1f4947383345d33de46819))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.5.0...vsock-proto-v0.6.0) (2026-02-23)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.5.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.4.0...vsock-proto-v0.5.0) (2026-02-23)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.4.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.3.0...vsock-proto-v0.4.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.3.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.2.0...vsock-proto-v0.3.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.2.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.1.0...vsock-proto-v0.2.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)
