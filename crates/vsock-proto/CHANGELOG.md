# Changelog

## [0.18.10](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.9...vsock-proto-v0.18.10) (2026-06-04)


### Performance Improvements

* avoid exec output payload copy ([#16081](https://github.com/vm0-ai/vm0/issues/16081)) ([3611818](https://github.com/vm0-ai/vm0/commit/3611818fcd7d15583dde5113ace28918395858cb))

## [0.18.9](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.8...vsock-proto-v0.18.9) (2026-05-28)


### Refactoring

* share exec control identity codec helpers ([#15288](https://github.com/vm0-ai/vm0/issues/15288)) ([040e4eb](https://github.com/vm0-ai/vm0/commit/040e4eb3bfc19cd289a5866aec2f2dc1ceb48dc6))

## [0.18.8](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.7...vsock-proto-v0.18.8) (2026-05-27)


### Refactoring

* centralize exec output chunk validation ([#15050](https://github.com/vm0-ai/vm0/issues/15050)) ([171d55d](https://github.com/vm0-ai/vm0/commit/171d55d3cb7752e4ae37f87473e29322acbca78e))

## [0.18.7](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.6...vsock-proto-v0.18.7) (2026-05-25)


### Documentation

* **vsock-proto:** document exec control status api ([#14861](https://github.com/vm0-ai/vm0/issues/14861)) ([23a6640](https://github.com/vm0-ai/vm0/commit/23a66404f8c7cf6fc7db18b93441984773282498))

## [0.18.6](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.5...vsock-proto-v0.18.6) (2026-05-25)


### Bug Fixes

* pass guest reseed entropy over exec stdin ([#14758](https://github.com/vm0-ai/vm0/issues/14758)) ([6f9a4aa](https://github.com/vm0-ai/vm0/commit/6f9a4aac941effcad301911f5dfec055bb758667))

## [0.18.5](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.4...vsock-proto-v0.18.5) (2026-05-21)


### Refactoring

* **vsock-proto:** compact message type ids ([#14444](https://github.com/vm0-ai/vm0/issues/14444)) ([e04d036](https://github.com/vm0-ai/vm0/commit/e04d0367080afa277b770ede370449b6f2416e0e))
* **vsock-proto:** group message type ids ([#14460](https://github.com/vm0-ai/vm0/issues/14460)) ([45906ed](https://github.com/vm0-ai/vm0/commit/45906ed1d43839558e8721455c443dc747b22501))

## [0.18.4](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.3...vsock-proto-v0.18.4) (2026-05-21)


### Refactoring

* remove legacy spawn process protocol ([#14315](https://github.com/vm0-ai/vm0/issues/14315)) ([eecb69f](https://github.com/vm0-ai/vm0/commit/eecb69fbba0b5a16b0cd804698613303655dcb7e))

## [0.18.3](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.2...vsock-proto-v0.18.3) (2026-05-19)


### Refactoring

* upgrade exec start protocol schema ([#13841](https://github.com/vm0-ai/vm0/issues/13841)) ([6790751](https://github.com/vm0-ai/vm0/commit/67907514ba9f7372a4de7e0351cf5c724b997087))

## [0.18.2](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.1...vsock-proto-v0.18.2) (2026-05-19)


### Documentation

* document vsock protocol wire constants ([#13926](https://github.com/vm0-ai/vm0/issues/13926)) ([d232c21](https://github.com/vm0-ai/vm0/commit/d232c212ceb1e897dc44db641f69b75d775e6ea3))

## [0.18.1](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.18.0...vsock-proto-v0.18.1) (2026-05-18)


### Bug Fixes

* preserve utf-8 boundaries in vsock error payloads ([#13687](https://github.com/vm0-ai/vm0/issues/13687)) ([3af6a5d](https://github.com/vm0-ai/vm0/commit/3af6a5d481b411688fbc208adea1621517f3a8f7))


### Refactoring

* align process control timeout semantics ([#13598](https://github.com/vm0-ai/vm0/issues/13598)) ([9f56eae](https://github.com/vm0-ai/vm0/commit/9f56eae01348c91ec3df805d0a3c0566aacc9dbf))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.17.0...vsock-proto-v0.18.0) (2026-05-17)


### Features

* wire operation-bound process control to guest-agent ([#13538](https://github.com/vm0-ai/vm0/issues/13538)) ([3bc2ee1](https://github.com/vm0-ai/vm0/commit/3bc2ee1dda51d68c6825a1a71bf44edbc9692a0d))

## [0.17.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.16.2...vsock-proto-v0.17.0) (2026-05-15)


### Features

* add spawn process control plane ([#13482](https://github.com/vm0-ai/vm0/issues/13482)) ([a315a3a](https://github.com/vm0-ai/vm0/commit/a315a3ac3cd61e5ed42e642eb88f44fb943631a1))

## [0.16.2](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.16.1...vsock-proto-v0.16.2) (2026-05-15)


### Refactoring

* rename vsock command operation ([#13465](https://github.com/vm0-ai/vm0/issues/13465)) ([bd1742b](https://github.com/vm0-ai/vm0/commit/bd1742b001bec3edf81cd5daf410294f722315e6))

## [0.16.1](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.16.0...vsock-proto-v0.16.1) (2026-05-15)


### Refactoring

* rename spawn watch to spawn process ([#13369](https://github.com/vm0-ai/vm0/issues/13369)) ([e007f30](https://github.com/vm0-ai/vm0/commit/e007f30a2610056a6905e4a38bcc2d894895ffa4))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.6...vsock-proto-v0.16.0) (2026-05-14)


### Features

* add vsock operation quiesce protocol ([#13343](https://github.com/vm0-ai/vm0/issues/13343)) ([d1738c7](https://github.com/vm0-ai/vm0/commit/d1738c7d9665769411c2d99f4b3c116d6e132df9))

## [0.15.6](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.5...vsock-proto-v0.15.6) (2026-05-14)


### Documentation

* update command start wire format ([#13332](https://github.com/vm0-ai/vm0/issues/13332)) ([559963b](https://github.com/vm0-ai/vm0/commit/559963bd3c394a59af5f655e80085c7d2dddcf6c))

## [0.15.5](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.4...vsock-proto-v0.15.5) (2026-05-14)


### Bug Fixes

* suppress expected command exits ([#13270](https://github.com/vm0-ai/vm0/issues/13270)) ([2132288](https://github.com/vm0-ai/vm0/commit/213228850c442d9ba480acb31810a940687e572f))
* **vsock:** route spawn_watch lifecycle by sequence ([#13220](https://github.com/vm0-ai/vm0/issues/13220)) ([373d2ab](https://github.com/vm0-ai/vm0/commit/373d2ab0c2312e9f888c2d9780bcef71386f42cd))

## [0.15.4](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.3...vsock-proto-v0.15.4) (2026-05-14)


### Refactoring

* clean up vsock proto command tests ([#13204](https://github.com/vm0-ai/vm0/issues/13204)) ([1e231b5](https://github.com/vm0-ai/vm0/commit/1e231b588f90906c58e23b418c70311be27b3d7f))

## [0.15.3](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.2...vsock-proto-v0.15.3) (2026-05-13)


### Refactoring

* split remaining vsock payload modules ([#13183](https://github.com/vm0-ai/vm0/issues/13183)) ([16910fb](https://github.com/vm0-ai/vm0/commit/16910fbe2581e5d01cbd7d176096848636ac3166))
* **vsock-proto:** split command payload module ([#13175](https://github.com/vm0-ai/vm0/issues/13175)) ([6ae69ff](https://github.com/vm0-ai/vm0/commit/6ae69ff38bba443320c3949c631607a7f02a2465))

## [0.15.2](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.1...vsock-proto-v0.15.2) (2026-05-13)


### Refactoring

* split vsock-proto frame infrastructure ([#13169](https://github.com/vm0-ai/vm0/issues/13169)) ([df3e8e3](https://github.com/vm0-ai/vm0/commit/df3e8e3a439250225073c18ba5dedebc902d1369))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.15.0...vsock-proto-v0.15.1) (2026-05-13)


### Refactoring

* compact vsock message types ([#13079](https://github.com/vm0-ai/vm0/issues/13079)) ([09ef60c](https://github.com/vm0-ai/vm0/commit/09ef60c6348d31adf94ab8e04a959a38f5b83ec9))
* remove legacy vsock exec protocol ([#13064](https://github.com/vm0-ai/vm0/issues/13064)) ([318c177](https://github.com/vm0-ai/vm0/commit/318c177b451a8f2f700fca02f6ee41f98beb751f))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/vsock-proto-v0.14.0...vsock-proto-v0.15.0) (2026-05-12)


### Features

* **vsock-host:** add command operation router ([#12782](https://github.com/vm0-ai/vm0/issues/12782)) ([e1ad973](https://github.com/vm0-ai/vm0/commit/e1ad97343e41c441d3539de961f44c91bbad9309))

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
