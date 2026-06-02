# Changelog

## [0.18.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.5...sandbox-v0.18.0) (2026-06-01)


### Features

* add canonical workspace drive foundation ([#15688](https://github.com/vm0-ai/vm0/issues/15688)) ([593460a](https://github.com/vm0-ai/vm0/commit/593460ab818768ae75d1fd658a7211a2120a956b))

## [0.17.5](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.4...sandbox-v0.17.5) (2026-05-28)


### Bug Fixes

* label sandbox file operation errors ([#15303](https://github.com/vm0-ai/vm0/issues/15303)) ([dbc2ec3](https://github.com/vm0-ai/vm0/commit/dbc2ec33f982d1413f93307e933a1b48268a65a4))

## [0.17.4](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.3...sandbox-v0.17.4) (2026-05-25)


### Bug Fixes

* pass guest reseed entropy over exec stdin ([#14758](https://github.com/vm0-ai/vm0/issues/14758)) ([6f9a4aa](https://github.com/vm0-ai/vm0/commit/6f9a4aac941effcad301911f5dfec055bb758667))

## [0.17.3](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.2...sandbox-v0.17.3) (2026-05-22)


### Bug Fixes

* cancel guest process before runner cleanup ([#14537](https://github.com/vm0-ai/vm0/issues/14537)) ([55b3ab7](https://github.com/vm0-ai/vm0/commit/55b3ab78eb113e7665c6d097f5e2fdbef8b30193))

## [0.17.2](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.1...sandbox-v0.17.2) (2026-05-21)


### Refactoring

* remove legacy spawn process protocol ([#14315](https://github.com/vm0-ai/vm0/issues/14315)) ([eecb69f](https://github.com/vm0-ai/vm0/commit/eecb69fbba0b5a16b0cd804698613303655dcb7e))

## [0.17.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.17.0...sandbox-v0.17.1) (2026-05-20)


### Refactoring

* migrate sandbox runner processes to supervised exec ([#14231](https://github.com/vm0-ai/vm0/issues/14231)) ([7781715](https://github.com/vm0-ai/vm0/commit/77817154bd0b4aad08d58fc6f41dc2643f07c76c))

## [0.17.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.16.1...sandbox-v0.17.0) (2026-05-20)


### Features

* **runner:** add firecracker io limiters ([#13585](https://github.com/vm0-ai/vm0/issues/13585)) ([653b854](https://github.com/vm0-ai/vm0/commit/653b854613580861d503848a3eeffff98fe75095))

## [0.16.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.16.0...sandbox-v0.16.1) (2026-05-19)


### Refactoring

* gate process control requests ([#13845](https://github.com/vm0-ai/vm0/issues/13845)) ([9dc1d33](https://github.com/vm0-ai/vm0/commit/9dc1d33ddb9fb1e2d479c574ebf85afd61cb45b8))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.15.1...sandbox-v0.16.0) (2026-05-17)


### Features

* wire operation-bound process control to guest-agent ([#13538](https://github.com/vm0-ai/vm0/issues/13538)) ([3bc2ee1](https://github.com/vm0-ai/vm0/commit/3bc2ee1dda51d68c6825a1a71bf44edbc9692a0d))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.15.0...sandbox-v0.15.1) (2026-05-15)


### Refactoring

* rename spawn watch to spawn process ([#13369](https://github.com/vm0-ai/vm0/issues/13369)) ([e007f30](https://github.com/vm0-ai/vm0/commit/e007f30a2610056a6905e4a38bcc2d894895ffa4))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.14.4...sandbox-v0.15.0) (2026-05-15)


### Features

* gate sandbox park with ReadyForPark ([#13346](https://github.com/vm0-ai/vm0/issues/13346)) ([dd87143](https://github.com/vm0-ai/vm0/commit/dd87143a9b2955ff93820b5efa3d32d01f857f63))

## [0.14.4](https://github.com/vm0-ai/vm0/compare/sandbox-v0.14.3...sandbox-v0.14.4) (2026-05-14)


### Documentation

* document sandbox creation config ([#13290](https://github.com/vm0-ai/vm0/issues/13290)) ([89076cb](https://github.com/vm0-ai/vm0/commit/89076cbedd1cc61df4d410bf9d1f63a93a50c234))


### Refactoring

* type factory lifecycle resources ([#13293](https://github.com/vm0-ai/vm0/issues/13293)) ([0b533c7](https://github.com/vm0-ai/vm0/commit/0b533c76f86e651b09d662cb9c85a8c3a3d06ad5))

## [0.14.3](https://github.com/vm0-ai/vm0/compare/sandbox-v0.14.2...sandbox-v0.14.3) (2026-05-14)


### Bug Fixes

* **vsock:** route spawn_watch lifecycle by sequence ([#13220](https://github.com/vm0-ai/vm0/issues/13220)) ([373d2ab](https://github.com/vm0-ai/vm0/commit/373d2ab0c2312e9f888c2d9780bcef71386f42cd))

## [0.14.2](https://github.com/vm0-ai/vm0/compare/sandbox-v0.14.1...sandbox-v0.14.2) (2026-05-13)


### Refactoring

* route sandbox exec through command operations ([#13018](https://github.com/vm0-ai/vm0/issues/13018)) ([0e5f862](https://github.com/vm0-ai/vm0/commit/0e5f862ee8e2182e23a88df6187f194171004b1f))

## [0.14.1](https://github.com/vm0-ai/vm0/compare/sandbox-v0.14.0...sandbox-v0.14.1) (2026-05-10)


### Documentation

* document bounded exec preference ([#12599](https://github.com/vm0-ai/vm0/issues/12599)) ([70aa4eb](https://github.com/vm0-ai/vm0/commit/70aa4eb5444809dc49132cc003278eb2bd504a39))


### Refactoring

* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.13.0...sandbox-v0.14.0) (2026-05-09)


### Features

* add bounded exec output policies ([#12292](https://github.com/vm0-ai/vm0/issues/12292)) ([71f6ad9](https://github.com/vm0-ai/vm0/commit/71f6ad9aaadaa9bf6589a5915c51ab4c092547eb))

## [0.13.0](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.15...sandbox-v0.13.0) (2026-05-08)


### Features

* **sandbox:** wire bounded exec through host and firecracker sandbox ([#12203](https://github.com/vm0-ai/vm0/issues/12203)) ([71602f2](https://github.com/vm0-ai/vm0/commit/71602f22f27413438b63fb6f830b1653497189b1))

## [0.12.15](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.14...sandbox-v0.12.15) (2026-05-08)


### Performance Improvements

* add guest write-file helper ([#12136](https://github.com/vm0-ai/vm0/issues/12136)) ([8795398](https://github.com/vm0-ai/vm0/commit/8795398ddd54bb6f7e4cade4c1d3a67a11bebd1b))

## [0.12.14](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.13...sandbox-v0.12.14) (2026-05-07)


### Refactoring

* **runner:** split snapshot publish boundary ([#12044](https://github.com/vm0-ai/vm0/issues/12044)) ([b01e205](https://github.com/vm0-ai/vm0/commit/b01e205e530cb9a6ed5353294077d9a80b70da62))

## [0.12.13](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.12...sandbox-v0.12.13) (2026-05-07)


### Documentation

* **sandbox:** add crate-level docs ([#12011](https://github.com/vm0-ai/vm0/issues/12011)) ([cdbb13d](https://github.com/vm0-ai/vm0/commit/cdbb13d1b68b4f3f8ae5b63c6e1166e6bc0f8f65))

## [0.12.12](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.11...sandbox-v0.12.12) (2026-05-06)


### Bug Fixes

* **sandbox-fc:** require snapshot publish marker ([#11867](https://github.com/vm0-ai/vm0/issues/11867)) ([023ae4d](https://github.com/vm0-ai/vm0/commit/023ae4d86570157504a176372727cab05f5b1483))

## [0.12.11](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.10...sandbox-v0.12.11) (2026-05-05)


### Documentation

* **sandbox:** document runtime module ([#11804](https://github.com/vm0-ai/vm0/issues/11804)) ([b20407e](https://github.com/vm0-ai/vm0/commit/b20407e748feb70cb0a1fc2f7eecd1071d881bc4))

## [0.12.10](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.9...sandbox-v0.12.10) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.12.9](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.8...sandbox-v0.12.9) (2026-04-29)


### Documentation

* **sandbox-fc:** document snapshot error variants ([#11535](https://github.com/vm0-ai/vm0/issues/11535)) ([f9d5625](https://github.com/vm0-ai/vm0/commit/f9d5625227abb29245b0048e4052d9a6f7592157))

## [0.12.8](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.7...sandbox-v0.12.8) (2026-04-29)


### Bug Fixes

* **runner:** clean up outer job panic bookkeeping ([#11393](https://github.com/vm0-ai/vm0/issues/11393)) ([4ecf0b6](https://github.com/vm0-ai/vm0/commit/4ecf0b65e25c66a86eec0151a29dd4f0fa0deeb0))

## [0.12.7](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.6...sandbox-v0.12.7) (2026-04-27)


### Bug Fixes

* make guest-agent own system log writes ([#11238](https://github.com/vm0-ai/vm0/issues/11238)) ([5041a49](https://github.com/vm0-ai/vm0/commit/5041a49416701955915962bc13aed07e5618db3e))

## [0.12.6](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.5...sandbox-v0.12.6) (2026-04-27)


### Refactoring

* **sandbox:** clarify error taxonomy ([#11178](https://github.com/vm0-ai/vm0/issues/11178)) ([f766059](https://github.com/vm0-ai/vm0/commit/f7660591f6866336a78803225653fd738667c036))

## [0.12.5](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.4...sandbox-v0.12.5) (2026-04-26)


### Documentation

* **sandbox:** document runtime provider contract ([#11163](https://github.com/vm0-ai/vm0/issues/11163)) ([276de81](https://github.com/vm0-ai/vm0/commit/276de8114fa99e2cf3247a6fe5b803bdf73d5028))
* **sandbox:** document sandbox error taxonomy ([#11171](https://github.com/vm0-ai/vm0/issues/11171)) ([ebbca10](https://github.com/vm0-ai/vm0/commit/ebbca104243dc628bef3f701af6dbd1a321c4baa))

## [0.12.4](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.3...sandbox-v0.12.4) (2026-04-23)


### Documentation

* document sandbox trait surface (closes [#10774](https://github.com/vm0-ai/vm0/issues/10774)) ([#10804](https://github.com/vm0-ai/vm0/issues/10804)) ([5d3db1d](https://github.com/vm0-ai/vm0/commit/5d3db1d17be27b239f6baac1d65fed7c5cc43753))

## [0.12.3](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.2...sandbox-v0.12.3) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.12.2](https://github.com/vm0-ai/vm0/compare/sandbox-v0.12.1...sandbox-v0.12.2) (2026-04-18)


### Bug Fixes

* **sandbox-fc:** fail snapshot when destroy_keep_cow retries exhaust ([#9870](https://github.com/vm0-ai/vm0/issues/9870)) ([c0c4120](https://github.com/vm0-ai/vm0/commit/c0c41201de5362b982295b498476bcfbffe5bebc))

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
