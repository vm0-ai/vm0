# Changelog

## [0.10.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.9.5...vsock-guest-v0.10.0) (2026-04-14)


### Features

* **vsock:** chunked write_file with append flag for large files ([#9335](https://github.com/vm0-ai/vm0/issues/9335)) ([16f128d](https://github.com/vm0-ai/vm0/commit/16f128d5e28e43c869a9e4bcc8993b1637175f93))

## [0.9.5](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.9.4...vsock-guest-v0.9.5) (2026-04-14)


### Refactoring

* **vsock-guest:** remove unnecessary libc::sync() from shutdown handler ([#9317](https://github.com/vm0-ai/vm0/issues/9317)) ([8fdd6db](https://github.com/vm0-ai/vm0/commit/8fdd6dbeffa64b5d11f55706c205dab066b81e36)), closes [#9295](https://github.com/vm0-ai/vm0/issues/9295)

## [0.9.4](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.9.3...vsock-guest-v0.9.4) (2026-04-14)


### Bug Fixes

* **vsock-guest:** eliminate timeout kill race with thread join ([#9281](https://github.com/vm0-ai/vm0/issues/9281)) ([63807f2](https://github.com/vm0-ai/vm0/commit/63807f2dad96e0bead71aba716d3c42ac5e2c379)), closes [#9271](https://github.com/vm0-ai/vm0/issues/9271)

## [0.9.3](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.9.2...vsock-guest-v0.9.3) (2026-04-13)


### Bug Fixes

* **vsock-guest:** kill su child process group on timeout ([#9039](https://github.com/vm0-ai/vm0/issues/9039)) ([04013cb](https://github.com/vm0-ai/vm0/commit/04013cb76d4dabcc6328c563d60ede75719b77fd)), closes [#8973](https://github.com/vm0-ai/vm0/issues/8973)

## [0.9.2](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.9.1...vsock-guest-v0.9.2) (2026-04-12)


### Bug Fixes

* **vsock-guest:** check kill() return value in timeout killer threads ([#9034](https://github.com/vm0-ai/vm0/issues/9034)) ([1574329](https://github.com/vm0-ai/vm0/commit/15743299bb6fb69c27377f2709cff59cce5805b4)), closes [#8971](https://github.com/vm0-ai/vm0/issues/8971)

## [0.9.1](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.9.0...vsock-guest-v0.9.1) (2026-04-12)


### Bug Fixes

* **vsock-guest:** race stdout reading against child exit with drain deadline ([#9014](https://github.com/vm0-ai/vm0/issues/9014)) ([5454140](https://github.com/vm0-ai/vm0/commit/5454140d4617defd741fb2bd536a63d1987c9c3e))

## [0.9.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.8.1...vsock-guest-v0.9.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.8.1](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.8.0...vsock-guest-v0.8.1) (2026-04-04)


### Performance Improvements

* **runner:** replace docker build with debootstrap for rootfs creation ([#8042](https://github.com/vm0-ai/vm0/issues/8042)) ([41e932a](https://github.com/vm0-ai/vm0/commit/41e932aacb06a8a10234b1eb5219f90e84135917))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.7.0...vsock-guest-v0.8.0) (2026-03-20)


### Features

* **vsock:** add real-time stdout streaming from guest to host ([#5574](https://github.com/vm0-ai/vm0/issues/5574)) ([2afc093](https://github.com/vm0-ai/vm0/commit/2afc0930657f6bbf1e1f4947383345d33de46819))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.6.3...vsock-guest-v0.7.0) (2026-03-19)


### Features

* **runner:** add vm0/browser profile with dockerfile and ci integration ([#5311](https://github.com/vm0-ai/vm0/issues/5311)) ([a6b6077](https://github.com/vm0-ai/vm0/commit/a6b6077eb2e8a83f48bed456e4ee7d5e3323c192))

## [0.6.3](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.6.2...vsock-guest-v0.6.3) (2026-03-07)


### Bug Fixes

* **guest:** close inherited fds in child processes to prevent cli hangs ([#3881](https://github.com/vm0-ai/vm0/issues/3881)) ([bd5b49b](https://github.com/vm0-ai/vm0/commit/bd5b49b718f853569029d29e6c8b2323a90b2f91))

## [0.6.2](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.6.1...vsock-guest-v0.6.2) (2026-03-06)


### Bug Fixes

* **vsock-guest:** prevent secret leakage in exec/spawn_watch logs ([#3787](https://github.com/vm0-ai/vm0/issues/3787)) ([b3f4237](https://github.com/vm0-ai/vm0/commit/b3f42373fd30d092c0f1604d2df7ddc557150681))

## [0.6.1](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.6.0...vsock-guest-v0.6.1) (2026-03-04)


### Bug Fixes

* **vsock-guest:** run exec in background thread to avoid blocking event loop ([#3584](https://github.com/vm0-ai/vm0/issues/3584)) ([437df50](https://github.com/vm0-ai/vm0/commit/437df503fdb58016273f84134899db3a9b24ad65))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.5.0...vsock-guest-v0.6.0) (2026-02-23)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **vsock-guest:** handle echild race with pid 1 zombie reaper ([#3118](https://github.com/vm0-ai/vm0/issues/3118)) ([985f349](https://github.com/vm0-ai/vm0/commit/985f349134b981d6123fe26ee79f991ec56ceb59))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.4.0...vsock-guest-v0.5.0) (2026-02-23)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **vsock-guest:** handle echild race with pid 1 zombie reaper ([#3118](https://github.com/vm0-ai/vm0/issues/3118)) ([985f349](https://github.com/vm0-ai/vm0/commit/985f349134b981d6123fe26ee79f991ec56ceb59))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.3.0...vsock-guest-v0.4.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **vsock-guest:** handle echild race with pid 1 zombie reaper ([#3118](https://github.com/vm0-ai/vm0/issues/3118)) ([985f349](https://github.com/vm0-ai/vm0/commit/985f349134b981d6123fe26ee79f991ec56ceb59))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.2.0...vsock-guest-v0.3.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **vsock-guest:** handle echild race with pid 1 zombie reaper ([#3118](https://github.com/vm0-ai/vm0/issues/3118)) ([985f349](https://github.com/vm0-ai/vm0/commit/985f349134b981d6123fe26ee79f991ec56ceb59))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.1.0...vsock-guest-v0.2.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **vsock-guest:** handle echild race with pid 1 zombie reaper ([#3118](https://github.com/vm0-ai/vm0/issues/3118)) ([985f349](https://github.com/vm0-ai/vm0/commit/985f349134b981d6123fe26ee79f991ec56ceb59))
