# Changelog

## [0.15.1](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.15.0...vsock-guest-v0.15.1) (2026-05-13)

## [0.15.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.14.2...vsock-guest-v0.15.0) (2026-05-13)


### Features

* add bounded exec output policies ([#12292](https://github.com/vm0-ai/vm0/issues/12292)) ([71f6ad9](https://github.com/vm0-ai/vm0/commit/71f6ad9aaadaa9bf6589a5915c51ab4c092547eb))
* **vsock-guest:** add command operation worker ([#12738](https://github.com/vm0-ai/vm0/issues/12738)) ([80accba](https://github.com/vm0-ai/vm0/commit/80accba2f1767f1cce0964ce76608155d7375158))
* **vsock-host:** add command operation router ([#12782](https://github.com/vm0-ai/vm0/issues/12782)) ([e1ad973](https://github.com/vm0-ai/vm0/commit/e1ad97343e41c441d3539de961f44c91bbad9309))


### Documentation

* document bounded exec preference ([#12599](https://github.com/vm0-ai/vm0/issues/12599)) ([70aa4eb](https://github.com/vm0-ai/vm0/commit/70aa4eb5444809dc49132cc003278eb2bd504a39))


### Refactoring

* compact vsock message types ([#13079](https://github.com/vm0-ai/vm0/issues/13079)) ([09ef60c](https://github.com/vm0-ai/vm0/commit/09ef60c6348d31adf94ab8e04a959a38f5b83ec9))
* remove legacy vsock exec protocol ([#13064](https://github.com/vm0-ai/vm0/issues/13064)) ([318c177](https://github.com/vm0-ai/vm0/commit/318c177b451a8f2f700fca02f6ee41f98beb751f))
* remove redundant monitor spawner wrappers ([#12291](https://github.com/vm0-ai/vm0/issues/12291)) ([961f9c7](https://github.com/vm0-ai/vm0/commit/961f9c72eb0503bd847cfe21bfeb8c6735310fef))
* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))
* **vsock-guest:** consolidate sandbox user lookup ([#13136](https://github.com/vm0-ai/vm0/issues/13136)) ([79359f9](https://github.com/vm0-ai/vm0/commit/79359f94601fb71d73276712326c345083ca2ad9))

## [0.14.2](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.14.1...vsock-guest-v0.14.2) (2026-05-13)


### Refactoring

* **vsock-guest:** consolidate sandbox user lookup ([#13136](https://github.com/vm0-ai/vm0/issues/13136)) ([79359f9](https://github.com/vm0-ai/vm0/commit/79359f94601fb71d73276712326c345083ca2ad9))

## [0.14.1](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.14.0...vsock-guest-v0.14.1) (2026-05-13)


### Refactoring

* compact vsock message types ([#13079](https://github.com/vm0-ai/vm0/issues/13079)) ([09ef60c](https://github.com/vm0-ai/vm0/commit/09ef60c6348d31adf94ab8e04a959a38f5b83ec9))
* remove legacy vsock exec protocol ([#13064](https://github.com/vm0-ai/vm0/issues/13064)) ([318c177](https://github.com/vm0-ai/vm0/commit/318c177b451a8f2f700fca02f6ee41f98beb751f))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.13.0...vsock-guest-v0.14.0) (2026-05-12)


### Features

* **vsock-host:** add command operation router ([#12782](https://github.com/vm0-ai/vm0/issues/12782)) ([e1ad973](https://github.com/vm0-ai/vm0/commit/e1ad97343e41c441d3539de961f44c91bbad9309))

## [0.13.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.12.1...vsock-guest-v0.13.0) (2026-05-12)


### Features

* **vsock-guest:** add command operation worker ([#12738](https://github.com/vm0-ai/vm0/issues/12738)) ([80accba](https://github.com/vm0-ai/vm0/commit/80accba2f1767f1cce0964ce76608155d7375158))

## [0.12.1](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.12.0...vsock-guest-v0.12.1) (2026-05-10)


### Documentation

* document bounded exec preference ([#12599](https://github.com/vm0-ai/vm0/issues/12599)) ([70aa4eb](https://github.com/vm0-ai/vm0/commit/70aa4eb5444809dc49132cc003278eb2bd504a39))


### Refactoring

* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))

## [0.12.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.11.1...vsock-guest-v0.12.0) (2026-05-09)


### Features

* add bounded exec output policies ([#12292](https://github.com/vm0-ai/vm0/issues/12292)) ([71f6ad9](https://github.com/vm0-ai/vm0/commit/71f6ad9aaadaa9bf6589a5915c51ab4c092547eb))

## [0.11.1](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.11.0...vsock-guest-v0.11.1) (2026-05-09)


### Refactoring

* remove redundant monitor spawner wrappers ([#12291](https://github.com/vm0-ai/vm0/issues/12291)) ([961f9c7](https://github.com/vm0-ai/vm0/commit/961f9c72eb0503bd847cfe21bfeb8c6735310fef))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.15...vsock-guest-v0.11.0) (2026-05-08)


### Features

* **vsock-guest:** implement bounded exec ([#12164](https://github.com/vm0-ai/vm0/issues/12164)) ([f2b85dd](https://github.com/vm0-ai/vm0/commit/f2b85dd4f73a0f4ba0032340b37e92857bd74e71))


### Performance Improvements

* add guest write-file helper ([#12136](https://github.com/vm0-ai/vm0/issues/12136)) ([8795398](https://github.com/vm0-ai/vm0/commit/8795398ddd54bb6f7e4cade4c1d3a67a11bebd1b))

## [0.10.15](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.14...vsock-guest-v0.10.15) (2026-05-08)


### Bug Fixes

* **vsock-guest:** avoid env argv blowup ([#12127](https://github.com/vm0-ai/vm0/issues/12127)) ([4e41b39](https://github.com/vm0-ai/vm0/commit/4e41b39210f18119595869b6aee0a7b67eb75a09))

## [0.10.14](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.13...vsock-guest-v0.10.14) (2026-05-08)

## [0.10.13](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.12...vsock-guest-v0.10.13) (2026-05-07)


### Refactoring

* **vsock-guest:** handle thread spawn failures ([#12100](https://github.com/vm0-ai/vm0/issues/12100)) ([521365a](https://github.com/vm0-ai/vm0/commit/521365a5dd128f3e55a6d7f00bc42b7e9b248045))

## [0.10.12](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.11...vsock-guest-v0.10.12) (2026-05-07)


### Bug Fixes

* remove vsock wait polling from fast exits ([#12088](https://github.com/vm0-ai/vm0/issues/12088)) ([062bee8](https://github.com/vm0-ai/vm0/commit/062bee8c932f550da0dd6e2a715fe3bed096db2d))

## [0.10.11](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.10...vsock-guest-v0.10.11) (2026-05-05)


### Bug Fixes

* **vsock-guest:** cancel background work on disconnect ([#11796](https://github.com/vm0-ai/vm0/issues/11796)) ([f96303b](https://github.com/vm0-ai/vm0/commit/f96303b5ccf210391373390302720eaad0adc3bc))
* **vsock-guest:** keep drain cancellation bounded ([#11777](https://github.com/vm0-ai/vm0/issues/11777)) ([c14f457](https://github.com/vm0-ai/vm0/commit/c14f457aee90a4d03a474bfdd87cff64a4e0d2e3))
* **vsock-guest:** run write file command in process group ([#11803](https://github.com/vm0-ai/vm0/issues/11803)) ([ff6560a](https://github.com/vm0-ai/vm0/commit/ff6560a96ecce4e20c56445495b7afec3508bdbe))


### Documentation

* expand vsock guest log docs ([#11808](https://github.com/vm0-ai/vm0/issues/11808)) ([2d59f01](https://github.com/vm0-ai/vm0/commit/2d59f015afa141c8d5873f3e320dc1e09d798710))

## [0.10.10](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.9...vsock-guest-v0.10.10) (2026-05-03)


### Bug Fixes

* stop vsock reconnect after shutdown ([#11762](https://github.com/vm0-ai/vm0/issues/11762)) ([36ee68a](https://github.com/vm0-ai/vm0/commit/36ee68a72715d3e39a76ce77c7fda8346ea76488))
* **vsock-guest:** bound guest frame writes ([#11764](https://github.com/vm0-ai/vm0/issues/11764)) ([c63a08e](https://github.com/vm0-ai/vm0/commit/c63a08e454225c7a4701b1684bf1f7324cfa9ca4))
* **vsock-guest:** define timeout wait outcome semantics ([#11766](https://github.com/vm0-ai/vm0/issues/11766)) ([f540059](https://github.com/vm0-ai/vm0/commit/f540059e48c13ec6824e2412120ef8ca6fbbb27b))


### Refactoring

* **vsock-guest:** deduplicate concurrency helpers ([#11763](https://github.com/vm0-ai/vm0/issues/11763)) ([2e123b6](https://github.com/vm0-ai/vm0/commit/2e123b60264332114616ecc33abd3c54e270d025))
* **vsock-guest:** split lib into focused modules ([#11744](https://github.com/vm0-ai/vm0/issues/11744)) ([e4ba7f2](https://github.com/vm0-ai/vm0/commit/e4ba7f255b82d82f4f917c87ba4c8f3477980b01))

## [0.10.9](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.8...vsock-guest-v0.10.9) (2026-05-03)

## [0.10.8](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.7...vsock-guest-v0.10.8) (2026-05-03)


### Performance Improvements

* **runner:** cache rootfs templates in r2 ([#11597](https://github.com/vm0-ai/vm0/issues/11597)) ([136382c](https://github.com/vm0-ai/vm0/commit/136382cbfa2fc1ed8230145edf13ec72f712e770))

## [0.10.7](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.6...vsock-guest-v0.10.7) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.10.6](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.5...vsock-guest-v0.10.6) (2026-04-27)


### Bug Fixes

* make guest-agent own system log writes ([#11238](https://github.com/vm0-ai/vm0/issues/11238)) ([5041a49](https://github.com/vm0-ai/vm0/commit/5041a49416701955915962bc13aed07e5618db3e))

## [0.10.5](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.4...vsock-guest-v0.10.5) (2026-04-25)


### Documentation

* **vsock-guest:** fix stale 'sleep 30' reference in slow_exec test ([#11090](https://github.com/vm0-ai/vm0/issues/11090)) ([5b94af0](https://github.com/vm0-ai/vm0/commit/5b94af041c87b56829b6665c3e0b32967f569090)), closes [#11067](https://github.com/vm0-ai/vm0/issues/11067)

## [0.10.4](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.3...vsock-guest-v0.10.4) (2026-04-25)


### Bug Fixes

* **vsock-guest:** unblock exec and buffered spawn_watch on orphan stdout ([#11085](https://github.com/vm0-ai/vm0/issues/11085)) ([f659911](https://github.com/vm0-ai/vm0/commit/f65991104b0532ee80faf0885b075d41db7f3913))

## [0.10.3](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.2...vsock-guest-v0.10.3) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.10.2](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.1...vsock-guest-v0.10.2) (2026-04-17)


### Bug Fixes

* **vsock:** handle exec timeout_ms=0 across host and guest ([#9793](https://github.com/vm0-ai/vm0/issues/9793)) ([03a37b0](https://github.com/vm0-ai/vm0/commit/03a37b0ae1566f76ce0dbc97b5bb3e0bd1947f4b))

## [0.10.1](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.10.0...vsock-guest-v0.10.1) (2026-04-17)

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
