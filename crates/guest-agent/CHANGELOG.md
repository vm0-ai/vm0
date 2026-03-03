# Changelog

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
