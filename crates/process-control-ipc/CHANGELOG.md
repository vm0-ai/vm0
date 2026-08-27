# Changelog

## [0.3.7](https://github.com/vm0-ai/vm0/compare/process-control-ipc-v0.3.6...process-control-ipc-v0.3.7) (2026-08-27)


### Refactoring

* **runner:** establish guest agent readiness ([#29748](https://github.com/vm0-ai/vm0/issues/29748)) ([8eaafa1](https://github.com/vm0-ai/vm0/commit/8eaafa13bc280f08033fded17e7c3fd5c9822804))

## [0.3.6](https://github.com/vm0-ai/vm0/compare/process-control-ipc-v0.3.5...process-control-ipc-v0.3.6) (2026-08-24)


### Refactoring

* **runtime:** dual-read process-control environment aliases ([#29071](https://github.com/vm0-ai/vm0/issues/29071)) ([c9cde49](https://github.com/vm0-ai/vm0/commit/c9cde495a4ba6f43c409476a68733bdade8cb99c))

## [0.3.5](https://github.com/vm0-ai/vm0/compare/process-control-ipc-v0.3.4...process-control-ipc-v0.3.5) (2026-08-21)


### Bug Fixes

* **runner:** isolate shell tool oom cleanup ([#28391](https://github.com/vm0-ai/vm0/issues/28391)) ([ffb0332](https://github.com/vm0-ai/vm0/commit/ffb03327e60854d4e5e541b34a2f3423cfcee6f2))

## [0.3.4](https://github.com/vm0-ai/vm0/compare/process-control-ipc-v0.3.3...process-control-ipc-v0.3.4) (2026-08-13)


### Bug Fixes

* **runner:** preserve guest control headroom under workload pressure ([#26683](https://github.com/vm0-ai/vm0/issues/26683)) ([789adcd](https://github.com/vm0-ai/vm0/commit/789adcd9e7a35dc545ae660f4b5a55d802ea854f))

## [0.3.3](https://github.com/vm0-ai/vm0/compare/process-control-ipc-v0.3.2...process-control-ipc-v0.3.3) (2026-07-16)


### Bug Fixes

* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))

## [0.3.2](https://github.com/vm0-ai/vm0/compare/process-control-ipc-v0.3.1...process-control-ipc-v0.3.2) (2026-07-04)


### Performance Improvements

* reduce process-control endpoint allocations ([#20164](https://github.com/vm0-ai/vm0/issues/20164)) ([52ed366](https://github.com/vm0-ai/vm0/commit/52ed366f856a2e2c5e535aa12ef49196652b8dbe))

## [0.3.1](https://github.com/vm0-ai/vm0/compare/process-control-ipc-v0.3.0...process-control-ipc-v0.3.1) (2026-06-23)


### Performance Improvements

* reduce process-control ipc payload copies ([#18670](https://github.com/vm0-ai/vm0/issues/18670)) ([95e9670](https://github.com/vm0-ai/vm0/commit/95e9670ada6b3138e20c585cb78e57188b497440))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/process-control-ipc-v0.2.2...process-control-ipc-v0.3.0) (2026-06-19)


### Features

* add runner local active input forwarding ([#18286](https://github.com/vm0-ai/vm0/issues/18286)) ([a798b1a](https://github.com/vm0-ai/vm0/commit/a798b1abc04cfaa960d63bee7ce8d52b8300737a))

## [0.2.2](https://github.com/vm0-ai/vm0/compare/process-control-ipc-v0.2.1...process-control-ipc-v0.2.2) (2026-06-15)


### Refactoring

* split process-control ipc modules ([#17742](https://github.com/vm0-ai/vm0/issues/17742)) ([83cdf5b](https://github.com/vm0-ai/vm0/commit/83cdf5b87c79408f24957e7315a2a4aa37f86fa3))

## [0.2.1](https://github.com/vm0-ai/vm0/compare/process-control-ipc-v0.2.0...process-control-ipc-v0.2.1) (2026-05-20)


### Documentation

* document process-control-ipc protocol ([#14263](https://github.com/vm0-ai/vm0/issues/14263)) ([18321c1](https://github.com/vm0-ai/vm0/commit/18321c1307b99737a7e787f214f7141e71710330))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/process-control-ipc-v0.1.0...process-control-ipc-v0.2.0) (2026-05-17)


### Features

* wire operation-bound process control to guest-agent ([#13538](https://github.com/vm0-ai/vm0/issues/13538)) ([3bc2ee1](https://github.com/vm0-ai/vm0/commit/3bc2ee1dda51d68c6825a1a71bf44edbc9692a0d))
