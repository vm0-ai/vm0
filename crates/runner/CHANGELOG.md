# Changelog

## [0.21.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.21.0...runner-rs-v0.21.1) (2026-03-10)

## [0.21.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.4...runner-rs-v0.21.0) (2026-03-09)


### Features

* **connectors:** add experimental connectors data pipeline ([#4048](https://github.com/vm0-ai/vm0/issues/4048)) ([f3ad976](https://github.com/vm0-ai/vm0/commit/f3ad976c82d86300636b545aa8b5b23c6ebfc744))

## [0.20.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.3...runner-rs-v0.20.4) (2026-03-09)


### Bug Fixes

* ensure system env vars take precedence over user-provided variables ([#3921](https://github.com/vm0-ai/vm0/issues/3921)) ([fcfa1f2](https://github.com/vm0-ai/vm0/commit/fcfa1f2ac77f31648dd655c61cc3030518400df1))

## [0.20.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.2...runner-rs-v0.20.3) (2026-03-09)


### Bug Fixes

* **storage:** unify memory storage auto-creation with artifact pattern ([#3944](https://github.com/vm0-ai/vm0/issues/3944)) ([e2af883](https://github.com/vm0-ai/vm0/commit/e2af88330c3bf305c1586ffd4315dff19a4e7504))


### Refactoring

* **runner:** make runner doctor tolerant of transient states ([#3943](https://github.com/vm0-ai/vm0/issues/3943)) ([f0c0dbf](https://github.com/vm0-ai/vm0/commit/f0c0dbfbcc3581ba8f1e157b871358dfe5632fab))

## [0.20.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.1...runner-rs-v0.20.2) (2026-03-08)

## [0.20.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.0...runner-rs-v0.20.1) (2026-03-07)


### Bug Fixes

* **runner:** use proper shell escaping in executor guest commands ([#3902](https://github.com/vm0-ai/vm0/issues/3902)) ([f5b5031](https://github.com/vm0-ai/vm0/commit/f5b5031be43a8fe814da676c472d586fb25ce29e))
* use correct storage type in memory dedup path and propagate checkpoint errors ([#3906](https://github.com/vm0-ai/vm0/issues/3906)) ([9abe586](https://github.com/vm0-ai/vm0/commit/9abe586d92126cef4fc9f7c2fa4319c7448e86dd))

## [0.20.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.4...runner-rs-v0.20.0) (2026-03-07)


### Features

* add --memory flag for agent long-term memory ([#3424](https://github.com/vm0-ai/vm0/issues/3424)) ([9e0279f](https://github.com/vm0-ai/vm0/commit/9e0279f618efe5396dda9e1aaac43a72bba70bfe))


### Bug Fixes

* **guest-init:** set correct env vars for sudo and user sessions ([#3892](https://github.com/vm0-ai/vm0/issues/3892)) ([a1f46e3](https://github.com/vm0-ai/vm0/commit/a1f46e3204f6f897f793118f97a3731d2b370bb3))

## [0.19.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.3...runner-rs-v0.19.4) (2026-03-07)

## [0.19.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.2...runner-rs-v0.19.3) (2026-03-06)

## [0.19.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.1...runner-rs-v0.19.2) (2026-03-06)

## [0.19.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.0...runner-rs-v0.19.1) (2026-03-06)

## [0.19.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.18.0...runner-rs-v0.19.0) (2026-03-05)


### Features

* **runner:** balloon reclaim with per-tick inflate cap and full ci test ([#3711](https://github.com/vm0-ai/vm0/issues/3711)) ([7f7efc2](https://github.com/vm0-ai/vm0/commit/7f7efc2f845686899c62ce20cbf992cc9cc5c7df))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.17.0...runner-rs-v0.18.0) (2026-03-05)


### Features

* **sandbox-fc:** add per-sandbox balloon memory reclaim controller ([#3700](https://github.com/vm0-ai/vm0/issues/3700)) ([10f121b](https://github.com/vm0-ai/vm0/commit/10f121bc06e87f23a48af9b4b971faacef620442)), closes [#3697](https://github.com/vm0-ai/vm0/issues/3697)


### Bug Fixes

* set api start time inside create-run for e2e telemetry ([#3707](https://github.com/vm0-ai/vm0/issues/3707)) ([e902696](https://github.com/vm0-ai/vm0/commit/e902696adb72414e5b248552379ee59c9cbbabd0)), closes [#3706](https://github.com/vm0-ai/vm0/issues/3706)

## [0.17.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.16.0...runner-rs-v0.17.0) (2026-03-05)


### Features

* **sandbox-fc:** enable balloon stats and add runtime balloon api ([#3694](https://github.com/vm0-ai/vm0/issues/3694)) ([b5918d6](https://github.com/vm0-ai/vm0/commit/b5918d6e7f7c82f79693b725bad2b5c547016655)), closes [#3688](https://github.com/vm0-ai/vm0/issues/3688)
* **sandbox-fc:** enable virtio-balloon with deflate_on_oom as safety net ([#3679](https://github.com/vm0-ai/vm0/issues/3679)) ([2ce2b62](https://github.com/vm0-ai/vm0/commit/2ce2b62c991a9e4bc077438630eb21267b618dc2)), closes [#3666](https://github.com/vm0-ai/vm0/issues/3666)

## [0.16.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.15.1...runner-rs-v0.16.0) (2026-03-05)


### Features

* **runner:** add concurrency-factor parameter for cpu overcommit ([#3669](https://github.com/vm0-ai/vm0/issues/3669)) ([528afa4](https://github.com/vm0-ai/vm0/commit/528afa4c9d6670abcfef0ce412ba12568e196295))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.15.0...runner-rs-v0.15.1) (2026-03-04)


### Bug Fixes

* **runner:** remove trigger comment and bump for release ([#3654](https://github.com/vm0-ai/vm0/issues/3654)) ([fadb62c](https://github.com/vm0-ai/vm0/commit/fadb62c3b89cd978c280fe046b23b708cdad4db4))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.14.0...runner-rs-v0.15.0) (2026-03-04)


### Features

* **runner:** add --name filter to runner doctor ([#3615](https://github.com/vm0-ai/vm0/issues/3615)) ([4e8597c](https://github.com/vm0-ai/vm0/commit/4e8597cf8f0f1f6339841abcb066590768bef84a))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.13.0...runner-rs-v0.14.0) (2026-03-04)


### Features

* **runner:** auto-calculate max_concurrent from host resources ([#3528](https://github.com/vm0-ai/vm0/issues/3528)) ([eee7ead](https://github.com/vm0-ai/vm0/commit/eee7ead8925bfdfd51269b116041a745df0564a6))

## [0.13.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.3...runner-rs-v0.13.0) (2026-03-03)


### Features

* **runner:** add exec command for live vm debugging ([#3502](https://github.com/vm0-ai/vm0/issues/3502)) ([0453c3b](https://github.com/vm0-ai/vm0/commit/0453c3bd7a32f9b9e2760ff30e4aea192a9b0836))

## [0.12.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.2...runner-rs-v0.12.3) (2026-03-02)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.12.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.1...runner-rs-v0.12.2) (2026-03-02)


### Performance Improvements

* **sandbox-fc:** use full cli invocation for snapshot pre-warm ([#3395](https://github.com/vm0-ai/vm0/issues/3395)) ([318deaa](https://github.com/vm0-ai/vm0/commit/318deaa20216059e92c1702a10ef0203c98af00e))

## [0.12.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.0...runner-rs-v0.12.1) (2026-03-01)


### Performance Improvements

* **runner:** prefetch snapshot memory.bin via sequential read ([#3373](https://github.com/vm0-ai/vm0/issues/3373)) ([21289eb](https://github.com/vm0-ai/vm0/commit/21289ebcff774e6c763a350dbb57be23f1ebeed8)), closes [#3342](https://github.com/vm0-ai/vm0/issues/3342)

## [0.12.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.11.0...runner-rs-v0.12.0) (2026-03-01)


### Features

* **runner:** add --env flag to benchmark command ([#3335](https://github.com/vm0-ai/vm0/issues/3335)) ([25683a5](https://github.com/vm0-ai/vm0/commit/25683a5049ae80a3644a065d4f401f8ca1887052))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.10.0...runner-rs-v0.11.0) (2026-03-01)


### Features

* **runner:** copy guest system log to host after job ([#3329](https://github.com/vm0-ai/vm0/issues/3329)) ([e1fc90b](https://github.com/vm0-ai/vm0/commit/e1fc90ba7f5f8b555a93028e05086ffac6c3c003))
* **runner:** redirect guest-download output to system log file ([#3328](https://github.com/vm0-ai/vm0/issues/3328)) ([68ba78d](https://github.com/vm0-ai/vm0/commit/68ba78dcb0e931aae14c74d1cd809b4f6d5924d1))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.9.0...runner-rs-v0.10.0) (2026-03-01)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.9.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.5...runner-rs-v0.9.0) (2026-03-01)


### Features

* **runner:** embed guest binaries via build.rs ([#3319](https://github.com/vm0-ai/vm0/issues/3319)) ([acacb39](https://github.com/vm0-ai/vm0/commit/acacb39e6861d04853f148be090367f6de0e8f8a))

## [0.8.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.4...runner-rs-v0.8.5) (2026-02-28)


### Bug Fixes

* **runner:** deterministic active_run_ids order in status.json ([#3290](https://github.com/vm0-ai/vm0/issues/3290)) ([b87e8a2](https://github.com/vm0-ai/vm0/commit/b87e8a28d6bd1e8adf1d7ce9dfc133c2aa8f9893))

## [0.8.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.3...runner-rs-v0.8.4) (2026-02-27)


### Performance Improvements

* **rootfs:** install claude code as standalone binary for faster cold-start ([#3278](https://github.com/vm0-ai/vm0/issues/3278)) ([e8cbefa](https://github.com/vm0-ai/vm0/commit/e8cbefad6e5d3f6ea91d0eefd07baac743db8ab1))

## [0.8.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.2...runner-rs-v0.8.3) (2026-02-27)


### Performance Improvements

* **sandbox-fc:** pre-warm real claude execution path instead of --help ([#3272](https://github.com/vm0-ai/vm0/issues/3272)) ([5d95121](https://github.com/vm0-ai/vm0/commit/5d95121b69e9ac5dbe76cb0859cc90b4b48a3743)), closes [#3258](https://github.com/vm0-ai/vm0/issues/3258)

## [0.8.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.1...runner-rs-v0.8.2) (2026-02-27)


### Bug Fixes

* **sandbox-fc:** use deterministic mac on tap devices for snapshot arp stability ([#3269](https://github.com/vm0-ai/vm0/issues/3269)) ([4c73c27](https://github.com/vm0-ai/vm0/commit/4c73c275ae6ae6bb3fbea6b5ee93ee5b0b761418)), closes [#3268](https://github.com/vm0-ai/vm0/issues/3268)

## [0.8.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.0...runner-rs-v0.8.1) (2026-02-26)


### Bug Fixes

* **sandbox-fc:** remove double su wrapper from prewarm script ([#3265](https://github.com/vm0-ai/vm0/issues/3265)) ([3df62d1](https://github.com/vm0-ai/vm0/commit/3df62d1b9be9310e5112f3423edce504295f1775))


### Performance Improvements

* **sandbox-fc:** enable v8 compile cache for faster cli cold start ([#3267](https://github.com/vm0-ai/vm0/issues/3267)) ([6f1c8be](https://github.com/vm0-ai/vm0/commit/6f1c8be89cd5c7168326b5fa822d26eb2f9fa824))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.7.0...runner-rs-v0.8.0) (2026-02-25)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.7.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.4...runner-rs-v0.7.0) (2026-02-25)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.3.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.3...runner-rs-v0.3.4) (2026-02-23)


### Performance Improvements

* **sandbox-fc:** pre-warm claude and codex in snapshot ([#3232](https://github.com/vm0-ai/vm0/issues/3232)) ([5534465](https://github.com/vm0-ai/vm0/commit/553446505f92aa30b1ac38b396f9238a6ff4c9ac))

## [0.3.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.2...runner-rs-v0.3.3) (2026-02-23)

## [0.3.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.1...runner-rs-v0.3.2) (2026-02-23)

## [0.3.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.0...runner-rs-v0.3.1) (2026-02-22)

## [0.3.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.2.0...runner-rs-v0.3.0) (2026-02-22)


### Features

* **runner:** extend gc to clean up old deployment versions ([#3201](https://github.com/vm0-ai/vm0/issues/3201)) ([09f2d1c](https://github.com/vm0-ai/vm0/commit/09f2d1cabac6089daf4bb2365abb88d95e1065c4))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.1.0...runner-rs-v0.2.0) (2026-02-22)


### Features

* allow users to set timezone preference for sandbox and scheduling ([#2866](https://github.com/vm0-ai/vm0/issues/2866)) ([89437c7](https://github.com/vm0-ai/vm0/commit/89437c733b4e34eee46009b20c99f455c5963289))
* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **runner:** add --dry-run flag to rootfs, snapshot, and build commands ([#3169](https://github.com/vm0-ai/vm0/issues/3169)) ([62b62e3](https://github.com/vm0-ai/vm0/commit/62b62e3cf2931ae14a67ed8d481f702131a4e323)), closes [#3168](https://github.com/vm0-ai/vm0/issues/3168)
* **runner:** add --env flag to runner service start/install ([#3112](https://github.com/vm0-ai/vm0/issues/3112)) ([d2f8ec8](https://github.com/vm0-ai/vm0/commit/d2f8ec85ca4591ac4f4aa12ffebc073bd1f6ed9f))
* **runner:** add `runner doctor` command for runtime health diagnostics ([#3138](https://github.com/vm0-ai/vm0/issues/3138)) ([e075414](https://github.com/vm0-ai/vm0/commit/e075414291d0aa313af2f903f2f46d75ab0f92b8))
* **runner:** add `runner gc` command to clean up unused rootfs and snapshots ([#3128](https://github.com/vm0-ai/vm0/issues/3128)) ([d4e6235](https://github.com/vm0-ai/vm0/commit/d4e6235c40a63d4f1411ce982ab1800d905d6fe7))
* **runner:** add `setup` command to download firecracker and kernel ([#2825](https://github.com/vm0-ai/vm0/issues/2825)) ([f5ba977](https://github.com/vm0-ai/vm0/commit/f5ba9773e0c4ed54c56cad26d30abc3dafa1bfda))
* **runner:** add ably realtime subscription to start command ([#3048](https://github.com/vm0-ai/vm0/issues/3048)) ([553ba2d](https://github.com/vm0-ai/vm0/commit/553ba2d1727466fd30683a4dd690036df995d7e9))
* **runner:** add benchmark subcommand for single-shot vm execution ([#2982](https://github.com/vm0-ai/vm0/issues/2982)) ([a4ee02a](https://github.com/vm0-ai/vm0/commit/a4ee02ad56e2c86b6a4bbbc9f03fa6ebe99c474c))
* **runner:** add build command combining rootfs + snapshot ([#2914](https://github.com/vm0-ai/vm0/issues/2914)) ([305c038](https://github.com/vm0-ai/vm0/commit/305c03867368a44f30d2421e9f23490ec91e960f))
* **runner:** add build-rootfs command to replace bash script ([#2858](https://github.com/vm0-ai/vm0/issues/2858)) ([3a298f6](https://github.com/vm0-ai/vm0/commit/3a298f6a29941e14e062cfb4301ea112c69ccad4))
* **runner:** add execution telemetry for sandbox operations ([#3068](https://github.com/vm0-ai/vm0/issues/3068)) ([4e7fbb3](https://github.com/vm0-ai/vm0/commit/4e7fbb3545f1d548a8e6345d120b560a0a3439a2))
* **runner:** add firewall rules and seal secrets to proxy registry ([#3028](https://github.com/vm0-ai/vm0/issues/3028)) ([752f9b5](https://github.com/vm0-ai/vm0/commit/752f9b549447dde65c23bd81bcc9e805796d441d))
* **runner:** add kill command to terminate running sandboxes ([#3153](https://github.com/vm0-ai/vm0/issues/3153)) ([26d4e7d](https://github.com/vm0-ai/vm0/commit/26d4e7d1763eaa55166e243ecc96052ceba15c7c))
* **runner:** add local job provider and submit command ([#3158](https://github.com/vm0-ai/vm0/issues/3158)) ([4d300cb](https://github.com/vm0-ai/vm0/commit/4d300cb95baa0713866d7332a050e4b5b32c6ac1))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add proxy support to start command ([#3045](https://github.com/vm0-ai/vm0/issues/3045)) ([5a7016f](https://github.com/vm0-ai/vm0/commit/5a7016f20e698c616728d42bca481c8c87338623))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add service subcommand for systemd lifecycle management ([#3098](https://github.com/vm0-ai/vm0/issues/3098)) ([9686c65](https://github.com/vm0-ai/vm0/commit/9686c659797f53c58333903968a4b3b62d3523ef))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** add version flag to cli ([#3038](https://github.com/vm0-ai/vm0/issues/3038)) ([0afc49a](https://github.com/vm0-ai/vm0/commit/0afc49a163e76d6f999fb9c94ff3067109f0ff8e))
* **runner:** auto-restart mitmproxy on crash ([#3083](https://github.com/vm0-ai/vm0/issues/3083)) ([2261025](https://github.com/vm0-ai/vm0/commit/2261025f85537333b76299903748be96c5c9dfb5))
* **runner:** detect oom kills and return clear error message ([#3093](https://github.com/vm0-ai/vm0/issues/3093)) ([38718c9](https://github.com/vm0-ai/vm0/commit/38718c9a00485e33a623954778e41cdfda89ec0f))
* **runner:** download and install mitmdump in setup command ([#2838](https://github.com/vm0-ai/vm0/issues/2838)) ([d171672](https://github.com/vm0-ai/vm0/commit/d171672409b0cdd1b850dc3db07d1ecbc5592364))
* **runner:** gc stale network log files older than 7 days ([#3137](https://github.com/vm0-ai/vm0/issues/3137)) ([43bb9c1](https://github.com/vm0-ai/vm0/commit/43bb9c1ec457b208005333bcdd570c2860fbc429))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **runner:** log snapshot file sizes (logical and disk) ([#2997](https://github.com/vm0-ai/vm0/issues/2997)) ([671cbad](https://github.com/vm0-ai/vm0/commit/671cbad4d55594dbc5df4858fa6acbfffcbee57b))
* **runner:** replace socket-based local provider with file queue ([#3166](https://github.com/vm0-ai/vm0/issues/3166)) ([658c007](https://github.com/vm0-ai/vm0/commit/658c007f30a633934d4d691791b46361ddf236fc))
* **runner:** upload mitmproxy network logs to telemetry endpoint ([#3071](https://github.com/vm0-ai/vm0/issues/3071)) ([80023b0](https://github.com/vm0-ai/vm0/commit/80023b0f627d6b3b57bd1aa9a46cd4244118710e))
* **runner:** use service install/drain in ci upgrade test ([#3167](https://github.com/vm0-ai/vm0/issues/3167)) ([4ebb1d7](https://github.com/vm0-ai/vm0/commit/4ebb1d73afd5405cdbe21d0c4aa88280606f386b))
* **runner:** write logs to file in addition to stderr ([#3101](https://github.com/vm0-ai/vm0/issues/3101)) ([fa4000b](https://github.com/vm0-ai/vm0/commit/fa4000bec7db04abcc040076121c43caecbf3354))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))
* **runner:** add exclusive lock on base_dir to prevent silent data corruption ([#3126](https://github.com/vm0-ai/vm0/issues/3126)) ([61ac8b7](https://github.com/vm0-ai/vm0/commit/61ac8b7e9121465d934f77c9dd8fb47acbc883ab)), closes [#3125](https://github.com/vm0-ai/vm0/issues/3125)
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** add path validation and ci hash guards ([#3161](https://github.com/vm0-ai/vm0/issues/3161)) ([c5313ff](https://github.com/vm0-ai/vm0/commit/c5313ffdaee030c5fb3d48b950c8d7b6e36e90ae))
* **runner:** clean up request_start_times on flow error in mitm-addon ([#3076](https://github.com/vm0-ai/vm0/issues/3076)) ([a6e8cb1](https://github.com/vm0-ai/vm0/commit/a6e8cb1d9b9dece53f66aea35b8c32627bf4270e)), closes [#3073](https://github.com/vm0-ai/vm0/issues/3073)
* **runner:** exclude network log upload from cleanup telemetry metric ([#3075](https://github.com/vm0-ai/vm0/issues/3075)) ([5b1beb1](https://github.com/vm0-ai/vm0/commit/5b1beb1a06cf19ebc67ba435a03ada529ef47f22)), closes [#3072](https://github.com/vm0-ai/vm0/issues/3072)
* **runner:** forward mock-claude env var to guest ([#3089](https://github.com/vm0-ai/vm0/issues/3089)) ([2978851](https://github.com/vm0-ai/vm0/commit/297885167fb36a2fcd1b3a5566a4c00bf4a571cb)), closes [#3088](https://github.com/vm0-ai/vm0/issues/3088)
* **runner:** gc removes unused lock files with safe inode recheck ([#3132](https://github.com/vm0-ai/vm0/issues/3132)) ([1e9d234](https://github.com/vm0-ai/vm0/commit/1e9d2345cb3209ade7b8f17f221f3621e9915172)), closes [#3131](https://github.com/vm0-ai/vm0/issues/3131)
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **runner:** re-establish ably subscription after fatal error ([#3077](https://github.com/vm0-ai/vm0/issues/3077)) ([be681ca](https://github.com/vm0-ai/vm0/commit/be681cada26167aa8ebe1809edb326621902085b)), closes [#3074](https://github.com/vm0-ai/vm0/issues/3074)
* **runner:** sanitize runner name used in log file prefix ([#3103](https://github.com/vm0-ai/vm0/issues/3103)) ([b028b89](https://github.com/vm0-ai/vm0/commit/b028b89440019c077c0a0fc8cfced3178f74d797))
* **runner:** set node ca certs env var for mitm mode ([#3091](https://github.com/vm0-ai/vm0/issues/3091)) ([8626d58](https://github.com/vm0-ai/vm0/commit/8626d58b203a6fdbabea21aa21cb228ddc9cff78))
* **runner:** sort gc artifacts by last-used time instead of creation time ([#3130](https://github.com/vm0-ai/vm0/issues/3130)) ([42efcb2](https://github.com/vm0-ai/vm0/commit/42efcb29da6ef4d96fe6fb640953354f12bda516))
* **runner:** use run_id as sandbox_id instead of random uuid ([#3151](https://github.com/vm0-ai/vm0/issues/3151)) ([3e13c72](https://github.com/vm0-ai/vm0/commit/3e13c727b7a972c76b0f96c56e59ef2e65eca864))
* **runner:** walk ppid chain for orphan detection instead of checking immediate parent ([#3154](https://github.com/vm0-ai/vm0/issues/3154)) ([c377a54](https://github.com/vm0-ai/vm0/commit/c377a544643cd1908b32e505d533448ed73bc98c))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
