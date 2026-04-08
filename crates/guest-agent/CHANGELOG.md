# Changelog

## [0.19.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.4...guest-agent-v0.19.5) (2026-04-08)


### Bug Fixes

* **checkpoint:** use presigned url for session history upload ([#8445](https://github.com/vm0-ai/vm0/issues/8445)) ([4a019bb](https://github.com/vm0-ai/vm0/commit/4a019bb53dc2323e2981f74d02e78f4eaf2e185c))

## [0.19.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.3...guest-agent-v0.19.4) (2026-03-31)


### Bug Fixes

* **guest-agent:** use explicit file list for tar to match manifest ([#7311](https://github.com/vm0-ai/vm0/issues/7311)) ([448f019](https://github.com/vm0-ai/vm0/commit/448f019d2ad0f2e061d6e924e31567dc02f36bfd))

## [0.19.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.2...guest-agent-v0.19.3) (2026-03-29)


### Bug Fixes

* **crates:** update sha2/hmac usage for digest 0.11 compatibility ([#7101](https://github.com/vm0-ai/vm0/issues/7101)) ([cbded46](https://github.com/vm0-ai/vm0/commit/cbded46e78c8d3ed060e96f79f15cd38ee1cf9dc))

## [0.19.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.1...guest-agent-v0.19.2) (2026-03-23)


### Bug Fixes

* use file_type() in walk_dir to avoid following symlinks ([#6184](https://github.com/vm0-ai/vm0/issues/6184)) ([b173f34](https://github.com/vm0-ai/vm0/commit/b173f34e8ed4edaf6bc169c8e18c9462c6aaa789))

## [0.19.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.0...guest-agent-v0.19.1) (2026-03-21)


### Bug Fixes

* **guest-agent:** add -- separator to prevent variadic flags from swallowing prompt ([#5789](https://github.com/vm0-ai/vm0/issues/5789)) ([b9b2fab](https://github.com/vm0-ai/vm0/commit/b9b2fabe509046af54776cb540b71deee0653c11))

## [0.19.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.18.0...guest-agent-v0.19.0) (2026-03-20)


### Features

* support --settings flag for vm0 run ([#5663](https://github.com/vm0-ai/vm0/issues/5663)) ([#5753](https://github.com/vm0-ai/vm0/issues/5753)) ([d0aad87](https://github.com/vm0-ai/vm0/commit/d0aad87539c31ae4664d41b1cca46b556b3de66e))
* support --tools cli parameter across full pipeline ([#5752](https://github.com/vm0-ai/vm0/issues/5752)) ([b0cf364](https://github.com/vm0-ai/vm0/commit/b0cf364a8598dcd36ed1a6ffffdb8c1e03d1841c))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.17.0...guest-agent-v0.18.0) (2026-03-19)


### Features

* add storage version lineage table for artifact/memory parent tracking ([#5501](https://github.com/vm0-ai/vm0/issues/5501)) ([c2b3115](https://github.com/vm0-ai/vm0/commit/c2b311506f65889215730b27a4ad0d244c651747))
* **runner:** pass disallowed tools from execution context to claude cli ([#5577](https://github.com/vm0-ai/vm0/issues/5577)) ([cdc557a](https://github.com/vm0-ai/vm0/commit/cdc557a4ccb873b37b5df3cc3eb550d6f0849e79)), closes [#5564](https://github.com/vm0-ai/vm0/issues/5564)

## [0.17.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.4...guest-agent-v0.17.0) (2026-03-18)


### Features

* add append-system-prompt support to runner and guest-agent ([#5384](https://github.com/vm0-ai/vm0/issues/5384)) ([37aaa76](https://github.com/vm0-ai/vm0/commit/37aaa76b7acdf8c24f2928590de54317870c3a21)), closes [#5375](https://github.com/vm0-ai/vm0/issues/5375)

## [0.16.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.3...guest-agent-v0.16.4) (2026-03-17)


### Refactoring

* **rust:** replace inline crate:: paths with top-level use imports ([#5061](https://github.com/vm0-ai/vm0/issues/5061)) ([149aaa0](https://github.com/vm0-ai/vm0/commit/149aaa09ca2bf69ffb1bc35471ba813e5884e534)), closes [#5038](https://github.com/vm0-ai/vm0/issues/5038)

## [0.16.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.2...guest-agent-v0.16.3) (2026-03-15)


### Bug Fixes

* **guest-agent:** add stuck-tool watchdog for claude code network tool hang ([#4833](https://github.com/vm0-ai/vm0/issues/4833)) ([7b71fa7](https://github.com/vm0-ai/vm0/commit/7b71fa78f9d7155f08059118391416ecf785027f)), closes [#4785](https://github.com/vm0-ai/vm0/issues/4785)

## [0.16.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.1...guest-agent-v0.16.2) (2026-03-12)


### Bug Fixes

* add explicit file size limits to storage upload handlers ([#4586](https://github.com/vm0-ai/vm0/issues/4586)) ([d899fdb](https://github.com/vm0-ai/vm0/commit/d899fdbc23a30b5e586fa0755a22f0c4d6826d8b)), closes [#4576](https://github.com/vm0-ai/vm0/issues/4576)

## [0.16.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.0...guest-agent-v0.16.1) (2026-03-10)


### Bug Fixes

* skip retry on non-retriable 4xx errors in guest-agent ([#4121](https://github.com/vm0-ai/vm0/issues/4121)) ([713b5df](https://github.com/vm0-ai/vm0/commit/713b5df9ee89a7f893bae3940c7895dd3f24b4d7))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.15.1...guest-agent-v0.16.0) (2026-03-08)


### Features

* **sandbox:** symlink vm0 memory to claude code auto-memory path ([#3928](https://github.com/vm0-ai/vm0/issues/3928)) ([9aaf0e4](https://github.com/vm0-ai/vm0/commit/9aaf0e4fc8a3b530693e939307b86e9db6514fef))


### Bug Fixes

* **guest-agent:** switch cpu measurement to delta-based tracking ([#3918](https://github.com/vm0-ai/vm0/issues/3918)) ([7adfee2](https://github.com/vm0-ai/vm0/commit/7adfee2664f408fe0b3a51e41aeafcf6293d7477))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.15.0...guest-agent-v0.15.1) (2026-03-07)


### Bug Fixes

* use correct storage type in memory dedup path and propagate checkpoint errors ([#3906](https://github.com/vm0-ai/vm0/issues/3906)) ([9abe586](https://github.com/vm0-ai/vm0/commit/9abe586d92126cef4fc9f7c2fa4319c7448e86dd))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.14.1...guest-agent-v0.15.0) (2026-03-07)


### Features

* add --memory flag for agent long-term memory ([#3424](https://github.com/vm0-ai/vm0/issues/3424)) ([9e0279f](https://github.com/vm0-ai/vm0/commit/9e0279f618efe5396dda9e1aaac43a72bba70bfe))


### Bug Fixes

* **guest-agent:** decouple event sending from stdout reading loop ([#3884](https://github.com/vm0-ai/vm0/issues/3884)) ([c27e8a1](https://github.com/vm0-ai/vm0/commit/c27e8a1daf8447b317aba356d127fdc9405a84d0))

## [0.14.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.14.0...guest-agent-v0.14.1) (2026-03-07)


### Bug Fixes

* **guest-agent:** defer event sends during stdout drain to prevent drops ([#3859](https://github.com/vm0-ai/vm0/issues/3859)) ([843fda1](https://github.com/vm0-ai/vm0/commit/843fda1a212d53ea424c2d28a09e8d7b09c2a5a7))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.13.0...guest-agent-v0.14.0) (2026-03-04)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.13.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.3...guest-agent-v0.13.0) (2026-03-03)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.2...guest-agent-v0.12.3) (2026-03-02)


### Bug Fixes

* **guest-agent:** detect cli process exit to prevent hanging on orphaned pipes ([#3409](https://github.com/vm0-ai/vm0/issues/3409)) ([2381c50](https://github.com/vm0-ai/vm0/commit/2381c50ef76c889e8ab03ee37c994950fd0bd9e3))
* **guest-agent:** only set claude-specific env vars for claude-code cli ([#3416](https://github.com/vm0-ai/vm0/issues/3416)) ([df3f92c](https://github.com/vm0-ai/vm0/commit/df3f92cff9611b017b04d6adfc5a1d43d36376ee))


### Performance Improvements

* **guest-agent:** disable non-essential cli network traffic on startup ([#3407](https://github.com/vm0-ai/vm0/issues/3407)) ([4b45f77](https://github.com/vm0-ai/vm0/commit/4b45f773632adbb1d3323eeab7e7a4c95506842b))

## [0.12.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.1...guest-agent-v0.12.2) (2026-03-02)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.0...guest-agent-v0.12.1) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.11.0...guest-agent-v0.12.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.11.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.10.0...guest-agent-v0.11.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.10.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.9.0...guest-agent-v0.10.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.9.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.5...guest-agent-v0.9.0) (2026-03-01)


### Performance Improvements

* **guest-agent:** pre-warm dns cache before cli spawn ([#3298](https://github.com/vm0-ai/vm0/issues/3298)) ([b3e3fb2](https://github.com/vm0-ai/vm0/commit/b3e3fb268df1e3a3570070d81be3c6506277ed2d))

## [0.8.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.4...guest-agent-v0.8.5) (2026-02-28)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.3...guest-agent-v0.8.4) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.2...guest-agent-v0.8.3) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.1...guest-agent-v0.8.2) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.0...guest-agent-v0.8.1) (2026-02-26)


### Performance Improvements

* **sandbox-fc:** enable v8 compile cache for faster cli cold start ([#3267](https://github.com/vm0-ai/vm0/issues/3267)) ([6f1c8be](https://github.com/vm0-ai/vm0/commit/6f1c8be89cd5c7168326b5fa822d26eb2f9fa824))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.7.0...guest-agent-v0.8.0) (2026-02-25)


### Features

* add intermediate e2e telemetry metrics for cli cold-start diagnosis ([#3251](https://github.com/vm0-ai/vm0/issues/3251)) ([82121a9](https://github.com/vm0-ai/vm0/commit/82121a93edcca096cacc787283edbc7275b88f42)), closes [#3250](https://github.com/vm0-ai/vm0/issues/3250)

## [0.7.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.6.0...guest-agent-v0.7.0) (2026-02-25)


### Features

* **guest-agent:** add api_to_cli_init telemetry metric ([#3245](https://github.com/vm0-ai/vm0/issues/3245)) ([b1f78b6](https://github.com/vm0-ai/vm0/commit/b1f78b63fbf1da80dd37ee92c3602319cfd1ecdc)), closes [#3244](https://github.com/vm0-ai/vm0/issues/3244)

## [0.6.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.5.0...guest-agent-v0.6.0) (2026-02-23)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.4.0...guest-agent-v0.5.0) (2026-02-23)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.3.0...guest-agent-v0.4.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.2.0...guest-agent-v0.3.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.1.0...guest-agent-v0.2.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))
