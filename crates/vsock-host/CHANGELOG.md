# Changelog

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
