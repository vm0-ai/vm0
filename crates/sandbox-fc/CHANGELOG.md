# Changelog

## [0.11.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.11.3...sandbox-fc-v0.11.4) (2026-03-15)


### Performance Improvements

* **sandbox-fc:** lazy initialization and batched replenishment for overlay pool ([#4603](https://github.com/vm0-ai/vm0/issues/4603)) ([862144b](https://github.com/vm0-ai/vm0/commit/862144bef70fa6e4f61b847bf41aa52ebddbeeb2))

## [0.11.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.11.2...sandbox-fc-v0.11.3) (2026-03-12)


### Refactoring

* remove balloon_reclaim flag and enable balloon reclaim unconditionally ([#4473](https://github.com/vm0-ai/vm0/issues/4473)) ([b386091](https://github.com/vm0-ai/vm0/commit/b38609140426569f3fe0c3cc3e56bf81ee477583))

## [0.11.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.11.1...sandbox-fc-v0.11.2) (2026-03-07)


### Bug Fixes

* **sandbox-fc:** flush conntrack entries on namespace release ([#3888](https://github.com/vm0-ai/vm0/issues/3888)) ([612c491](https://github.com/vm0-ai/vm0/commit/612c49176f6335297d262486b3968605b4539428)), closes [#3645](https://github.com/vm0-ai/vm0/issues/3645)

## [0.11.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.11.0...sandbox-fc-v0.11.1) (2026-03-06)

## [0.11.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.10.0...sandbox-fc-v0.11.0) (2026-03-06)


### Features

* **sandbox-fc:** add balloon controller observability for production monitoring ([#3767](https://github.com/vm0-ai/vm0/issues/3767)) ([ecc4c4a](https://github.com/vm0-ai/vm0/commit/ecc4c4a2d9599138ee5422c470a4a1576749c9fb))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.9.0...sandbox-fc-v0.10.0) (2026-03-05)


### Features

* **runner:** balloon reclaim with per-tick inflate cap and full ci test ([#3711](https://github.com/vm0-ai/vm0/issues/3711)) ([7f7efc2](https://github.com/vm0-ai/vm0/commit/7f7efc2f845686899c62ce20cbf992cc9cc5c7df))

## [0.9.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.8.0...sandbox-fc-v0.9.0) (2026-03-05)


### Features

* **sandbox-fc:** add per-sandbox balloon memory reclaim controller ([#3700](https://github.com/vm0-ai/vm0/issues/3700)) ([10f121b](https://github.com/vm0-ai/vm0/commit/10f121bc06e87f23a48af9b4b971faacef620442)), closes [#3697](https://github.com/vm0-ai/vm0/issues/3697)


### Bug Fixes

* **ci:** limit runner test concurrency to avoid netns init timeout ([#3712](https://github.com/vm0-ai/vm0/issues/3712)) ([df4d163](https://github.com/vm0-ai/vm0/commit/df4d163bf0c3a9ae89a05e66cc976735815cfd76))
* **sandbox-fc:** fail fast when firecracker crashes during startup ([#3709](https://github.com/vm0-ai/vm0/issues/3709)) ([ad469b4](https://github.com/vm0-ai/vm0/commit/ad469b45110d59f8b5cfa210635012b9477de2a0))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.7.0...sandbox-fc-v0.8.0) (2026-03-05)


### Features

* **sandbox-fc:** enable balloon stats and add runtime balloon api ([#3694](https://github.com/vm0-ai/vm0/issues/3694)) ([b5918d6](https://github.com/vm0-ai/vm0/commit/b5918d6e7f7c82f79693b725bad2b5c547016655)), closes [#3688](https://github.com/vm0-ai/vm0/issues/3688)
* **sandbox-fc:** enable virtio-balloon with deflate_on_oom as safety net ([#3679](https://github.com/vm0-ai/vm0/issues/3679)) ([2ce2b62](https://github.com/vm0-ai/vm0/commit/2ce2b62c991a9e4bc077438630eb21267b618dc2)), closes [#3666](https://github.com/vm0-ai/vm0/issues/3666)

## [0.7.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.7...sandbox-fc-v0.7.0) (2026-03-03)


### Features

* **runner:** add exec command for live vm debugging ([#3502](https://github.com/vm0-ai/vm0/issues/3502)) ([0453c3b](https://github.com/vm0-ai/vm0/commit/0453c3bd7a32f9b9e2760ff30e4aea192a9b0836))

## [0.6.7](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.6...sandbox-fc-v0.6.7) (2026-03-02)


### Performance Improvements

* **sandbox-fc:** use full cli invocation for snapshot pre-warm ([#3395](https://github.com/vm0-ai/vm0/issues/3395)) ([318deaa](https://github.com/vm0-ai/vm0/commit/318deaa20216059e92c1702a10ef0203c98af00e))

## [0.6.6](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.5...sandbox-fc-v0.6.6) (2026-03-01)


### Performance Improvements

* **runner:** prefetch snapshot memory.bin via sequential read ([#3373](https://github.com/vm0-ai/vm0/issues/3373)) ([21289eb](https://github.com/vm0-ai/vm0/commit/21289ebcff774e6c763a350dbb57be23f1ebeed8)), closes [#3342](https://github.com/vm0-ai/vm0/issues/3342)

## [0.6.5](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.4...sandbox-fc-v0.6.5) (2026-03-01)


### Performance Improvements

* **sandbox-fc:** prefetch snapshot memory.bin on factory startup ([#3370](https://github.com/vm0-ai/vm0/issues/3370)) ([891041e](https://github.com/vm0-ai/vm0/commit/891041ee8cae18ddbd83864fb80e2c3e6f3dab2d))

## [0.6.4](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.3...sandbox-fc-v0.6.4) (2026-02-27)


### Performance Improvements

* **sandbox-fc:** pre-warm real claude execution path instead of --help ([#3272](https://github.com/vm0-ai/vm0/issues/3272)) ([5d95121](https://github.com/vm0-ai/vm0/commit/5d95121b69e9ac5dbe76cb0859cc90b4b48a3743)), closes [#3258](https://github.com/vm0-ai/vm0/issues/3258)

## [0.6.3](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.2...sandbox-fc-v0.6.3) (2026-02-27)


### Bug Fixes

* **sandbox-fc:** use deterministic mac on tap devices for snapshot arp stability ([#3269](https://github.com/vm0-ai/vm0/issues/3269)) ([4c73c27](https://github.com/vm0-ai/vm0/commit/4c73c275ae6ae6bb3fbea6b5ee93ee5b0b761418)), closes [#3268](https://github.com/vm0-ai/vm0/issues/3268)

## [0.6.2](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.1...sandbox-fc-v0.6.2) (2026-02-26)


### Bug Fixes

* **sandbox-fc:** remove double su wrapper from prewarm script ([#3265](https://github.com/vm0-ai/vm0/issues/3265)) ([3df62d1](https://github.com/vm0-ai/vm0/commit/3df62d1b9be9310e5112f3423edce504295f1775))


### Performance Improvements

* **sandbox-fc:** enable v8 compile cache for faster cli cold start ([#3267](https://github.com/vm0-ai/vm0/issues/3267)) ([6f1c8be](https://github.com/vm0-ai/vm0/commit/6f1c8be89cd5c7168326b5fa822d26eb2f9fa824))

## [0.6.1](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.6.0...sandbox-fc-v0.6.1) (2026-02-23)


### Performance Improvements

* **sandbox-fc:** pre-warm claude and codex in snapshot ([#3232](https://github.com/vm0-ai/vm0/issues/3232)) ([5534465](https://github.com/vm0-ai/vm0/commit/553446505f92aa30b1ac38b396f9238a6ff4c9ac))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.5.0...sandbox-fc-v0.6.0) (2026-02-23)


### Features

* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** add network namespace pool and command execution ([#2576](https://github.com/vm0-ai/vm0/issues/2576)) ([cb97bca](https://github.com/vm0-ai/vm0/commit/cb97bca8e0ccf02e19c7f1dfe5423cde3d1a72f8))
* **sandbox-fc:** add overlay filesystem pool for pre-warmed vm images ([#2586](https://github.com/vm0-ai/vm0/issues/2586)) ([313c74e](https://github.com/vm0-ai/vm0/commit/313c74eb4ed061161b2e9901c323ba45adde0aa3))
* **sandbox-fc:** add test binary for manual lifecycle testing ([#2642](https://github.com/vm0-ai/vm0/issues/2642)) ([c4f9e22](https://github.com/vm0-ai/vm0/commit/c4f9e227a43421a890808b8c946391faa4eafaec))
* **sandbox-fc:** add unified prerequisites check to factory init ([#2651](https://github.com/vm0-ai/vm0/issues/2651)) ([a0a4868](https://github.com/vm0-ai/vm0/commit/a0a4868a6175e1022c8eb91fda2907fbe1dd6105))
* **sandbox-fc:** auto-allocate netns pool index via flock ([#2708](https://github.com/vm0-ai/vm0/issues/2708)) ([828ed61](https://github.com/vm0-ai/vm0/commit/828ed619217245d4a87a1afa27290ba175232143)), closes [#2704](https://github.com/vm0-ai/vm0/issues/2704)
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** implement snapshot creation workflow ([#2668](https://github.com/vm0-ai/vm0/issues/2668)) ([02d4418](https://github.com/vm0-ai/vm0/commit/02d441840260d6257e9e52cca72330cb1568fb41))
* **sandbox-fc:** implement snapshot restore via firecracker http api ([#2662](https://github.com/vm0-ai/vm0/issues/2662)) ([a622c08](https://github.com/vm0-ai/vm0/commit/a622c08eb897c2c0699dc08ea62079919aa33ab3))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **sandbox-fc:** proactive crash notification for firecracker sandbox ([#3087](https://github.com/vm0-ai/vm0/issues/3087)) ([ff6a795](https://github.com/vm0-ai/vm0/commit/ff6a795b77c42f389fc2b998dda9e262b1049c46))
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **sandbox-fc:** add prerequisite checks to create_snapshot ([#2971](https://github.com/vm0-ai/vm0/issues/2971)) ([f508fa2](https://github.com/vm0-ai/vm0/commit/f508fa2cfc6a70900670377f029b041b53ac8cdd))
* **sandbox-fc:** check /dev/kvm read-write permission in prerequisites ([#2657](https://github.com/vm0-ai/vm0/issues/2657)) ([0507615](https://github.com/vm0-ai/vm0/commit/0507615b626ec4754694547fd0bda79ceac10f48))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))
* **sandbox-fc:** redesign api error as enum to distinguish fatal from retryable errors ([#2700](https://github.com/vm0-ai/vm0/issues/2700)) ([dae4042](https://github.com/vm0-ai/vm0/commit/dae40421ec934018cfef485d73dabc5cdac33672))
* **sandbox-fc:** reject sudo invocation and clean stale work dir on snapshot ([#2698](https://github.com/vm0-ai/vm0/issues/2698)) ([f298633](https://github.com/vm0-ai/vm0/commit/f2986332cdc212167e5dd4323039ddaf554859e4)), closes [#2696](https://github.com/vm0-ai/vm0/issues/2696)


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
* **sandbox-fc:** pre-warm pam cache during snapshot creation ([#3000](https://github.com/vm0-ai/vm0/issues/3000)) ([8b95fcd](https://github.com/vm0-ai/vm0/commit/8b95fcdb9e33b1ea89b68d4ff6eef210f74cf91c)), closes [#2994](https://github.com/vm0-ai/vm0/issues/2994)

## [0.5.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.4.0...sandbox-fc-v0.5.0) (2026-02-23)


### Features

* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** add network namespace pool and command execution ([#2576](https://github.com/vm0-ai/vm0/issues/2576)) ([cb97bca](https://github.com/vm0-ai/vm0/commit/cb97bca8e0ccf02e19c7f1dfe5423cde3d1a72f8))
* **sandbox-fc:** add overlay filesystem pool for pre-warmed vm images ([#2586](https://github.com/vm0-ai/vm0/issues/2586)) ([313c74e](https://github.com/vm0-ai/vm0/commit/313c74eb4ed061161b2e9901c323ba45adde0aa3))
* **sandbox-fc:** add test binary for manual lifecycle testing ([#2642](https://github.com/vm0-ai/vm0/issues/2642)) ([c4f9e22](https://github.com/vm0-ai/vm0/commit/c4f9e227a43421a890808b8c946391faa4eafaec))
* **sandbox-fc:** add unified prerequisites check to factory init ([#2651](https://github.com/vm0-ai/vm0/issues/2651)) ([a0a4868](https://github.com/vm0-ai/vm0/commit/a0a4868a6175e1022c8eb91fda2907fbe1dd6105))
* **sandbox-fc:** auto-allocate netns pool index via flock ([#2708](https://github.com/vm0-ai/vm0/issues/2708)) ([828ed61](https://github.com/vm0-ai/vm0/commit/828ed619217245d4a87a1afa27290ba175232143)), closes [#2704](https://github.com/vm0-ai/vm0/issues/2704)
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** implement snapshot creation workflow ([#2668](https://github.com/vm0-ai/vm0/issues/2668)) ([02d4418](https://github.com/vm0-ai/vm0/commit/02d441840260d6257e9e52cca72330cb1568fb41))
* **sandbox-fc:** implement snapshot restore via firecracker http api ([#2662](https://github.com/vm0-ai/vm0/issues/2662)) ([a622c08](https://github.com/vm0-ai/vm0/commit/a622c08eb897c2c0699dc08ea62079919aa33ab3))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **sandbox-fc:** proactive crash notification for firecracker sandbox ([#3087](https://github.com/vm0-ai/vm0/issues/3087)) ([ff6a795](https://github.com/vm0-ai/vm0/commit/ff6a795b77c42f389fc2b998dda9e262b1049c46))
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **sandbox-fc:** add prerequisite checks to create_snapshot ([#2971](https://github.com/vm0-ai/vm0/issues/2971)) ([f508fa2](https://github.com/vm0-ai/vm0/commit/f508fa2cfc6a70900670377f029b041b53ac8cdd))
* **sandbox-fc:** check /dev/kvm read-write permission in prerequisites ([#2657](https://github.com/vm0-ai/vm0/issues/2657)) ([0507615](https://github.com/vm0-ai/vm0/commit/0507615b626ec4754694547fd0bda79ceac10f48))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))
* **sandbox-fc:** redesign api error as enum to distinguish fatal from retryable errors ([#2700](https://github.com/vm0-ai/vm0/issues/2700)) ([dae4042](https://github.com/vm0-ai/vm0/commit/dae40421ec934018cfef485d73dabc5cdac33672))
* **sandbox-fc:** reject sudo invocation and clean stale work dir on snapshot ([#2698](https://github.com/vm0-ai/vm0/issues/2698)) ([f298633](https://github.com/vm0-ai/vm0/commit/f2986332cdc212167e5dd4323039ddaf554859e4)), closes [#2696](https://github.com/vm0-ai/vm0/issues/2696)


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
* **sandbox-fc:** pre-warm pam cache during snapshot creation ([#3000](https://github.com/vm0-ai/vm0/issues/3000)) ([8b95fcd](https://github.com/vm0-ai/vm0/commit/8b95fcdb9e33b1ea89b68d4ff6eef210f74cf91c)), closes [#2994](https://github.com/vm0-ai/vm0/issues/2994)

## [0.4.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.3.0...sandbox-fc-v0.4.0) (2026-02-22)


### Features

* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** add network namespace pool and command execution ([#2576](https://github.com/vm0-ai/vm0/issues/2576)) ([cb97bca](https://github.com/vm0-ai/vm0/commit/cb97bca8e0ccf02e19c7f1dfe5423cde3d1a72f8))
* **sandbox-fc:** add overlay filesystem pool for pre-warmed vm images ([#2586](https://github.com/vm0-ai/vm0/issues/2586)) ([313c74e](https://github.com/vm0-ai/vm0/commit/313c74eb4ed061161b2e9901c323ba45adde0aa3))
* **sandbox-fc:** add test binary for manual lifecycle testing ([#2642](https://github.com/vm0-ai/vm0/issues/2642)) ([c4f9e22](https://github.com/vm0-ai/vm0/commit/c4f9e227a43421a890808b8c946391faa4eafaec))
* **sandbox-fc:** add unified prerequisites check to factory init ([#2651](https://github.com/vm0-ai/vm0/issues/2651)) ([a0a4868](https://github.com/vm0-ai/vm0/commit/a0a4868a6175e1022c8eb91fda2907fbe1dd6105))
* **sandbox-fc:** auto-allocate netns pool index via flock ([#2708](https://github.com/vm0-ai/vm0/issues/2708)) ([828ed61](https://github.com/vm0-ai/vm0/commit/828ed619217245d4a87a1afa27290ba175232143)), closes [#2704](https://github.com/vm0-ai/vm0/issues/2704)
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** implement snapshot creation workflow ([#2668](https://github.com/vm0-ai/vm0/issues/2668)) ([02d4418](https://github.com/vm0-ai/vm0/commit/02d441840260d6257e9e52cca72330cb1568fb41))
* **sandbox-fc:** implement snapshot restore via firecracker http api ([#2662](https://github.com/vm0-ai/vm0/issues/2662)) ([a622c08](https://github.com/vm0-ai/vm0/commit/a622c08eb897c2c0699dc08ea62079919aa33ab3))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **sandbox-fc:** proactive crash notification for firecracker sandbox ([#3087](https://github.com/vm0-ai/vm0/issues/3087)) ([ff6a795](https://github.com/vm0-ai/vm0/commit/ff6a795b77c42f389fc2b998dda9e262b1049c46))
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **sandbox-fc:** add prerequisite checks to create_snapshot ([#2971](https://github.com/vm0-ai/vm0/issues/2971)) ([f508fa2](https://github.com/vm0-ai/vm0/commit/f508fa2cfc6a70900670377f029b041b53ac8cdd))
* **sandbox-fc:** check /dev/kvm read-write permission in prerequisites ([#2657](https://github.com/vm0-ai/vm0/issues/2657)) ([0507615](https://github.com/vm0-ai/vm0/commit/0507615b626ec4754694547fd0bda79ceac10f48))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))
* **sandbox-fc:** redesign api error as enum to distinguish fatal from retryable errors ([#2700](https://github.com/vm0-ai/vm0/issues/2700)) ([dae4042](https://github.com/vm0-ai/vm0/commit/dae40421ec934018cfef485d73dabc5cdac33672))
* **sandbox-fc:** reject sudo invocation and clean stale work dir on snapshot ([#2698](https://github.com/vm0-ai/vm0/issues/2698)) ([f298633](https://github.com/vm0-ai/vm0/commit/f2986332cdc212167e5dd4323039ddaf554859e4)), closes [#2696](https://github.com/vm0-ai/vm0/issues/2696)


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
* **sandbox-fc:** pre-warm pam cache during snapshot creation ([#3000](https://github.com/vm0-ai/vm0/issues/3000)) ([8b95fcd](https://github.com/vm0-ai/vm0/commit/8b95fcdb9e33b1ea89b68d4ff6eef210f74cf91c)), closes [#2994](https://github.com/vm0-ai/vm0/issues/2994)

## [0.3.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.2.0...sandbox-fc-v0.3.0) (2026-02-22)


### Features

* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** add network namespace pool and command execution ([#2576](https://github.com/vm0-ai/vm0/issues/2576)) ([cb97bca](https://github.com/vm0-ai/vm0/commit/cb97bca8e0ccf02e19c7f1dfe5423cde3d1a72f8))
* **sandbox-fc:** add overlay filesystem pool for pre-warmed vm images ([#2586](https://github.com/vm0-ai/vm0/issues/2586)) ([313c74e](https://github.com/vm0-ai/vm0/commit/313c74eb4ed061161b2e9901c323ba45adde0aa3))
* **sandbox-fc:** add test binary for manual lifecycle testing ([#2642](https://github.com/vm0-ai/vm0/issues/2642)) ([c4f9e22](https://github.com/vm0-ai/vm0/commit/c4f9e227a43421a890808b8c946391faa4eafaec))
* **sandbox-fc:** add unified prerequisites check to factory init ([#2651](https://github.com/vm0-ai/vm0/issues/2651)) ([a0a4868](https://github.com/vm0-ai/vm0/commit/a0a4868a6175e1022c8eb91fda2907fbe1dd6105))
* **sandbox-fc:** auto-allocate netns pool index via flock ([#2708](https://github.com/vm0-ai/vm0/issues/2708)) ([828ed61](https://github.com/vm0-ai/vm0/commit/828ed619217245d4a87a1afa27290ba175232143)), closes [#2704](https://github.com/vm0-ai/vm0/issues/2704)
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** implement snapshot creation workflow ([#2668](https://github.com/vm0-ai/vm0/issues/2668)) ([02d4418](https://github.com/vm0-ai/vm0/commit/02d441840260d6257e9e52cca72330cb1568fb41))
* **sandbox-fc:** implement snapshot restore via firecracker http api ([#2662](https://github.com/vm0-ai/vm0/issues/2662)) ([a622c08](https://github.com/vm0-ai/vm0/commit/a622c08eb897c2c0699dc08ea62079919aa33ab3))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **sandbox-fc:** proactive crash notification for firecracker sandbox ([#3087](https://github.com/vm0-ai/vm0/issues/3087)) ([ff6a795](https://github.com/vm0-ai/vm0/commit/ff6a795b77c42f389fc2b998dda9e262b1049c46))
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **sandbox-fc:** add prerequisite checks to create_snapshot ([#2971](https://github.com/vm0-ai/vm0/issues/2971)) ([f508fa2](https://github.com/vm0-ai/vm0/commit/f508fa2cfc6a70900670377f029b041b53ac8cdd))
* **sandbox-fc:** check /dev/kvm read-write permission in prerequisites ([#2657](https://github.com/vm0-ai/vm0/issues/2657)) ([0507615](https://github.com/vm0-ai/vm0/commit/0507615b626ec4754694547fd0bda79ceac10f48))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))
* **sandbox-fc:** redesign api error as enum to distinguish fatal from retryable errors ([#2700](https://github.com/vm0-ai/vm0/issues/2700)) ([dae4042](https://github.com/vm0-ai/vm0/commit/dae40421ec934018cfef485d73dabc5cdac33672))
* **sandbox-fc:** reject sudo invocation and clean stale work dir on snapshot ([#2698](https://github.com/vm0-ai/vm0/issues/2698)) ([f298633](https://github.com/vm0-ai/vm0/commit/f2986332cdc212167e5dd4323039ddaf554859e4)), closes [#2696](https://github.com/vm0-ai/vm0/issues/2696)


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
* **sandbox-fc:** pre-warm pam cache during snapshot creation ([#3000](https://github.com/vm0-ai/vm0/issues/3000)) ([8b95fcd](https://github.com/vm0-ai/vm0/commit/8b95fcdb9e33b1ea89b68d4ff6eef210f74cf91c)), closes [#2994](https://github.com/vm0-ai/vm0/issues/2994)

## [0.2.0](https://github.com/vm0-ai/vm0/compare/sandbox-fc-v0.1.0...sandbox-fc-v0.2.0) (2026-02-22)


### Features

* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** add network namespace pool and command execution ([#2576](https://github.com/vm0-ai/vm0/issues/2576)) ([cb97bca](https://github.com/vm0-ai/vm0/commit/cb97bca8e0ccf02e19c7f1dfe5423cde3d1a72f8))
* **sandbox-fc:** add overlay filesystem pool for pre-warmed vm images ([#2586](https://github.com/vm0-ai/vm0/issues/2586)) ([313c74e](https://github.com/vm0-ai/vm0/commit/313c74eb4ed061161b2e9901c323ba45adde0aa3))
* **sandbox-fc:** add test binary for manual lifecycle testing ([#2642](https://github.com/vm0-ai/vm0/issues/2642)) ([c4f9e22](https://github.com/vm0-ai/vm0/commit/c4f9e227a43421a890808b8c946391faa4eafaec))
* **sandbox-fc:** add unified prerequisites check to factory init ([#2651](https://github.com/vm0-ai/vm0/issues/2651)) ([a0a4868](https://github.com/vm0-ai/vm0/commit/a0a4868a6175e1022c8eb91fda2907fbe1dd6105))
* **sandbox-fc:** auto-allocate netns pool index via flock ([#2708](https://github.com/vm0-ai/vm0/issues/2708)) ([828ed61](https://github.com/vm0-ai/vm0/commit/828ed619217245d4a87a1afa27290ba175232143)), closes [#2704](https://github.com/vm0-ai/vm0/issues/2704)
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** implement snapshot creation workflow ([#2668](https://github.com/vm0-ai/vm0/issues/2668)) ([02d4418](https://github.com/vm0-ai/vm0/commit/02d441840260d6257e9e52cca72330cb1568fb41))
* **sandbox-fc:** implement snapshot restore via firecracker http api ([#2662](https://github.com/vm0-ai/vm0/issues/2662)) ([a622c08](https://github.com/vm0-ai/vm0/commit/a622c08eb897c2c0699dc08ea62079919aa33ab3))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **sandbox-fc:** proactive crash notification for firecracker sandbox ([#3087](https://github.com/vm0-ai/vm0/issues/3087)) ([ff6a795](https://github.com/vm0-ai/vm0/commit/ff6a795b77c42f389fc2b998dda9e262b1049c46))
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **sandbox-fc:** add prerequisite checks to create_snapshot ([#2971](https://github.com/vm0-ai/vm0/issues/2971)) ([f508fa2](https://github.com/vm0-ai/vm0/commit/f508fa2cfc6a70900670377f029b041b53ac8cdd))
* **sandbox-fc:** check /dev/kvm read-write permission in prerequisites ([#2657](https://github.com/vm0-ai/vm0/issues/2657)) ([0507615](https://github.com/vm0-ai/vm0/commit/0507615b626ec4754694547fd0bda79ceac10f48))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))
* **sandbox-fc:** redesign api error as enum to distinguish fatal from retryable errors ([#2700](https://github.com/vm0-ai/vm0/issues/2700)) ([dae4042](https://github.com/vm0-ai/vm0/commit/dae40421ec934018cfef485d73dabc5cdac33672))
* **sandbox-fc:** reject sudo invocation and clean stale work dir on snapshot ([#2698](https://github.com/vm0-ai/vm0/issues/2698)) ([f298633](https://github.com/vm0-ai/vm0/commit/f2986332cdc212167e5dd4323039ddaf554859e4)), closes [#2696](https://github.com/vm0-ai/vm0/issues/2696)


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
* **sandbox-fc:** pre-warm pam cache during snapshot creation ([#3000](https://github.com/vm0-ai/vm0/issues/3000)) ([8b95fcd](https://github.com/vm0-ai/vm0/commit/8b95fcdb9e33b1ea89b68d4ff6eef210f74cf91c)), closes [#2994](https://github.com/vm0-ai/vm0/issues/2994)
