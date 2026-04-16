# Changelog

## [0.12.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.0...sandbox-v0.12.1) (2026-04-16)


### Refactoring

* **runner:** make sandbox_id a first-class identity distinct from run_id ([#9555](https://github.com/vm0-ai/vm0/issues/9555)) ([9cfd2a8](https://github.com/vm0-ai/vm0/commit/9cfd2a8d239f1c54c3c8e25c9adb2759d9b12efa))

## [0.12.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.11.0...sandbox-v0.12.0) (2026-04-14)


### Features

* **sandbox-fc:** pause vcpus while sandbox is parked in idle pool ([#9306](https://github.com/vm0-ai/vm0/issues/9306)) ([b7f322e](https://github.com/vm0-ai/vm0/commit/b7f322e247cddb12a061c8639f64efa0fb81f619))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.10.0...sandbox-v0.11.0) (2026-04-13)


### Features

* **runner:** inflate sandbox balloon when parked in idle pool ([#9118](https://github.com/vm0-ai/vm0/issues/9118)) ([628032d](https://github.com/vm0-ai/vm0/commit/628032dbf3543d3387b6559263c31ee273f24986))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.9.0...sandbox-v0.10.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.9.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.8.2...sandbox-v0.9.0) (2026-04-03)


### Features

* add dns proxy for sandbox vms using dnsmasq ([#8020](https://github.com/vm0-ai/vm0/issues/8020)) ([5699f8d](https://github.com/vm0-ai/vm0/commit/5699f8dbb9008422dfe1753a2b127a6f9c100f59))

## [0.8.2](https://github.com/vm0-ai/vm0/compare/sandbox-v0.8.1...sandbox-v0.8.2) (2026-03-30)


### Refactoring

* **sandbox:** introduce runtime provider trait and consolidate sandbox-fc construction ([#7173](https://github.com/vm0-ai/vm0/issues/7173)) ([6cb7c3c](https://github.com/vm0-ai/vm0/commit/6cb7c3c8ed57b4d7eb949986046d68226dc0672a)), closes [#7119](https://github.com/vm0-ai/vm0/issues/7119)

## [0.8.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.8.0...sandbox-v0.8.1) (2026-03-30)


### Refactoring

* **sandbox:** introduce sandbox control trait and decouple exec/kill from sandbox-fc ([#7150](https://github.com/vm0-ai/vm0/issues/7150)) ([4615d15](https://github.com/vm0-ai/vm0/commit/4615d1571c6dbc2ba249070654112d390e83a395)), closes [#7122](https://github.com/vm0-ai/vm0/issues/7122)
* **sandbox:** introduce sandbox runtime trait and internalize shared resources ([#7125](https://github.com/vm0-ai/vm0/issues/7125)) ([43a2ba0](https://github.com/vm0-ai/vm0/commit/43a2ba0d6ee9df1022e6238913597dd4d1c11e2a))
* **sandbox:** introduce snapshot provider trait and decouple snapshot operations ([#7142](https://github.com/vm0-ai/vm0/issues/7142)) ([9a864bf](https://github.com/vm0-ai/vm0/commit/9a864bfd4ec551ead8115f4fdb30df7c5570b5fe))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.7.0...sandbox-v0.8.0) (2026-03-25)


### Features

* **runner:** detect host-side cgroup oom kill of firecracker process ([#6630](https://github.com/vm0-ai/vm0/issues/6630)) ([34fa116](https://github.com/vm0-ai/vm0/commit/34fa11698b8e1c83f2cb93d82e281c099d114a49))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.6.1...sandbox-v0.7.0) (2026-03-20)


### Features

* **vsock:** add real-time stdout streaming from guest to host ([#5574](https://github.com/vm0-ai/vm0/issues/5574)) ([2afc093](https://github.com/vm0-ai/vm0/commit/2afc0930657f6bbf1e1f4947383345d33de46819))

## [0.6.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.6.0...sandbox-v0.6.1) (2026-03-19)


### Refactoring

* **sandbox:** remove dead use_proxy field from sandbox config ([#5483](https://github.com/vm0-ai/vm0/issues/5483)) ([97c8db8](https://github.com/vm0-ai/vm0/commit/97c8db89235175ba41f45817413b671c3d39fe3e)), closes [#5481](https://github.com/vm0-ai/vm0/issues/5481)

## [0.6.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.5.0...sandbox-v0.6.0) (2026-02-23)


### Features

* **crates:** add sandbox crate with core traits and types ([#2527](https://github.com/vm0-ai/vm0/issues/2527)) ([a7571b4](https://github.com/vm0-ai/vm0/commit/a7571b4ae61b41825eee3b73a59cc2d4f1f6ecb0))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.4.0...sandbox-v0.5.0) (2026-02-23)


### Features

* **crates:** add sandbox crate with core traits and types ([#2527](https://github.com/vm0-ai/vm0/issues/2527)) ([a7571b4](https://github.com/vm0-ai/vm0/commit/a7571b4ae61b41825eee3b73a59cc2d4f1f6ecb0))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.3.0...sandbox-v0.4.0) (2026-02-22)


### Features

* **crates:** add sandbox crate with core traits and types ([#2527](https://github.com/vm0-ai/vm0/issues/2527)) ([a7571b4](https://github.com/vm0-ai/vm0/commit/a7571b4ae61b41825eee3b73a59cc2d4f1f6ecb0))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.2.0...sandbox-v0.3.0) (2026-02-22)


### Features

* **crates:** add sandbox crate with core traits and types ([#2527](https://github.com/vm0-ai/vm0/issues/2527)) ([a7571b4](https://github.com/vm0-ai/vm0/commit/a7571b4ae61b41825eee3b73a59cc2d4f1f6ecb0))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.1.0...sandbox-v0.2.0) (2026-02-22)


### Features

* **crates:** add sandbox crate with core traits and types ([#2527](https://github.com/vm0-ai/vm0/issues/2527)) ([a7571b4](https://github.com/vm0-ai/vm0/commit/a7571b4ae61b41825eee3b73a59cc2d4f1f6ecb0))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **sandbox-fc:** implement sandbox lifecycle with state machine and resource management ([#2625](https://github.com/vm0-ai/vm0/issues/2625)) ([fa3a92d](https://github.com/vm0-ai/vm0/commit/fa3a92dbbb256ae0d9a378a87665927813fffa8c))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
