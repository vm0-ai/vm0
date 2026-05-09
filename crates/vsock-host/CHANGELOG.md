# Changelog

## [0.11.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.11.0...vsock-host-v0.11.1) (2026-05-09)


### Refactoring

* **runner:** migrate internal execs to bounded exec ([#12322](https://github.com/vm0-ai/vm0/issues/12322)) ([f0b84b4](https://github.com/vm0-ai/vm0/commit/f0b84b4f09bad9abc16074af3f0190944bba3d04))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.10.2...vsock-host-v0.11.0) (2026-05-09)


### Features

* add bounded exec output policies ([#12292](https://github.com/vm0-ai/vm0/issues/12292)) ([71f6ad9](https://github.com/vm0-ai/vm0/commit/71f6ad9aaadaa9bf6589a5915c51ab4c092547eb))

## [0.10.2](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.10.1...vsock-host-v0.10.2) (2026-05-09)


### Performance Improvements

* **vsock-host:** cap bounded exec stream forwarding ([#12267](https://github.com/vm0-ai/vm0/issues/12267)) ([9a8063a](https://github.com/vm0-ai/vm0/commit/9a8063af272ea95005ce8f2d5c37eba2d64105e5))

## [0.10.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.10.0...vsock-host-v0.10.1) (2026-05-09)


### Bug Fixes

* **vsock-host:** poison interrupted frame writes ([#12247](https://github.com/vm0-ai/vm0/issues/12247)) ([1860100](https://github.com/vm0-ai/vm0/commit/1860100ba26eecb7db2cd10fa2d63974e2016a76))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.12...vsock-host-v0.10.0) (2026-05-08)


### Features

* **sandbox:** wire bounded exec through host and firecracker sandbox ([#12203](https://github.com/vm0-ai/vm0/issues/12203)) ([71602f2](https://github.com/vm0-ai/vm0/commit/71602f22f27413438b63fb6f830b1653497189b1))

## [0.9.12](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.11...vsock-host-v0.9.12) (2026-05-08)


### Performance Improvements

* add guest write-file helper ([#12136](https://github.com/vm0-ai/vm0/issues/12136)) ([8795398](https://github.com/vm0-ai/vm0/commit/8795398ddd54bb6f7e4cade4c1d3a67a11bebd1b))

## [0.9.11](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.10...vsock-host-v0.9.11) (2026-05-08)

## [0.9.10](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.9...vsock-host-v0.9.10) (2026-05-05)

## [0.9.9](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.8...vsock-host-v0.9.9) (2026-05-03)

## [0.9.8](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.7...vsock-host-v0.9.8) (2026-05-03)

## [0.9.7](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.6...vsock-host-v0.9.7) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.9.6](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.5...vsock-host-v0.9.6) (2026-04-27)


### Bug Fixes

* make guest-agent own system log writes ([#11238](https://github.com/vm0-ai/vm0/issues/11238)) ([5041a49](https://github.com/vm0-ai/vm0/commit/5041a49416701955915962bc13aed07e5618db3e))

## [0.9.5](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.4...vsock-host-v0.9.5) (2026-04-27)


### Bug Fixes

* **sandbox-fc:** persist backend crash state ([#11192](https://github.com/vm0-ai/vm0/issues/11192)) ([57c4222](https://github.com/vm0-ai/vm0/commit/57c4222d68327eac25a3a96f8256c8cc2275fc24))

## [0.9.4](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.3...vsock-host-v0.9.4) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.9.3](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.2...vsock-host-v0.9.3) (2026-04-20)


### Bug Fixes

* **vsock-host:** encode connection state in type to prevent close races ([#10199](https://github.com/vm0-ai/vm0/issues/10199)) ([f3b62ce](https://github.com/vm0-ai/vm0/commit/f3b62ce6a692e56fd54ccd68804419ddfebac0a6))

## [0.9.2](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.1...vsock-host-v0.9.2) (2026-04-17)


### Bug Fixes

* **vsock:** handle exec timeout_ms=0 across host and guest ([#9793](https://github.com/vm0-ai/vm0/issues/9793)) ([03a37b0](https://github.com/vm0-ai/vm0/commit/03a37b0ae1566f76ce0dbc97b5bb3e0bd1947f4b))

## [0.9.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.0...vsock-host-v0.9.1) (2026-04-17)

## [0.9.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.8.0...vsock-host-v0.9.0) (2026-04-14)


### Features

* **vsock:** chunked write_file with append flag for large files ([#9335](https://github.com/vm0-ai/vm0/issues/9335)) ([16f128d](https://github.com/vm0-ai/vm0/commit/16f128d5e28e43c869a9e4bcc8993b1637175f93))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.7.0...vsock-host-v0.8.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.6.1...vsock-host-v0.7.0) (2026-03-20)


### Features

* **vsock:** add real-time stdout streaming from guest to host ([#5574](https://github.com/vm0-ai/vm0/issues/5574)) ([2afc093](https://github.com/vm0-ai/vm0/commit/2afc0930657f6bbf1e1f4947383345d33de46819))

## [0.6.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.6.0...vsock-host-v0.6.1) (2026-03-06)


### Refactoring

* **vsock-host:** enable concurrent operations via background reader task ([#3460](https://github.com/vm0-ai/vm0/issues/3460)) ([9a93aa3](https://github.com/vm0-ai/vm0/commit/9a93aa3a73afc0f38fe675cb73b4853c1e07fecf))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.5.0...vsock-host-v0.6.0) (2026-02-23)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.5.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.4.0...vsock-host-v0.5.0) (2026-02-23)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.4.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.3.0...vsock-host-v0.4.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.3.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.2.0...vsock-host-v0.3.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.2.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.1.0...vsock-host-v0.2.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)
