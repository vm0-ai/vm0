# Changelog

## [0.17.6](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.17.5...guest-mock-claude-v0.17.6) (2026-05-12)


### Bug Fixes

* **guest-agent:** bound cli stderr diagnostics ([#12937](https://github.com/vm0-ai/vm0/issues/12937)) ([f640407](https://github.com/vm0-ai/vm0/commit/f64040738b75cc29b141bfa18960200fb30727f3))

## [0.17.5](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.17.4...guest-mock-claude-v0.17.5) (2026-05-03)


### Bug Fixes

* **guest-agent:** escalate forced CLI termination ([#11698](https://github.com/vm0-ai/vm0/issues/11698)) ([ad07a39](https://github.com/vm0-ai/vm0/commit/ad07a39afca3122eb73bd9092a48cbdd07d33766))


### Refactoring

* **guest-mock-claude:** reuse post-result helper for orphan pipe ([#11692](https://github.com/vm0-ai/vm0/issues/11692)) ([bf98aa2](https://github.com/vm0-ai/vm0/commit/bf98aa26ad215dbecddfbd568e7343d9fd35728c))

## [0.17.4](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.17.3...guest-mock-claude-v0.17.4) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.17.3](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.17.2...guest-mock-claude-v0.17.3) (2026-04-23)


### Bug Fixes

* **guest-agent:** reap cli process group after type=result ([#10879](https://github.com/vm0-ai/vm0/issues/10879)) ([#10897](https://github.com/vm0-ai/vm0/issues/10897)) ([1ac27f9](https://github.com/vm0-ai/vm0/commit/1ac27f9884d00d01ef072bef59c4b5389c053d1a))

## [0.17.2](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.17.1...guest-mock-claude-v0.17.2) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.17.1](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.17.0...guest-mock-claude-v0.17.1) (2026-04-12)


### Bug Fixes

* **guest-agent:** add stdout drain deadline to prevent hanging on orphaned pipes ([#8980](https://github.com/vm0-ai/vm0/issues/8980)) ([8c7b8f1](https://github.com/vm0-ai/vm0/commit/8c7b8f15ea74fd95542568f15f6f0d0f7a9a0812))

## [0.17.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.16.1...guest-mock-claude-v0.17.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.16.1](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.16.0...guest-mock-claude-v0.16.1) (2026-03-21)


### Bug Fixes

* **guest-agent:** add -- separator to prevent variadic flags from swallowing prompt ([#5789](https://github.com/vm0-ai/vm0/issues/5789)) ([b9b2fab](https://github.com/vm0-ai/vm0/commit/b9b2fabe509046af54776cb540b71deee0653c11))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.15.0...guest-mock-claude-v0.16.0) (2026-03-20)


### Features

* support --settings flag for vm0 run ([#5663](https://github.com/vm0-ai/vm0/issues/5663)) ([#5753](https://github.com/vm0-ai/vm0/issues/5753)) ([d0aad87](https://github.com/vm0-ai/vm0/commit/d0aad87539c31ae4664d41b1cca46b556b3de66e))


### Bug Fixes

* **mock-claude:** add --tools flag to parse_args match arm ([#5773](https://github.com/vm0-ai/vm0/issues/5773)) ([3602c51](https://github.com/vm0-ai/vm0/commit/3602c5100822774b71956c41c210e1794dcdd7c9))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.14.3...guest-mock-claude-v0.15.0) (2026-03-19)


### Features

* **runner:** pass disallowed tools from execution context to claude cli ([#5577](https://github.com/vm0-ai/vm0/issues/5577)) ([cdc557a](https://github.com/vm0-ai/vm0/commit/cdc557a4ccb873b37b5df3cc3eb550d6f0849e79)), closes [#5564](https://github.com/vm0-ai/vm0/issues/5564)

## [0.14.3](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.14.2...guest-mock-claude-v0.14.3) (2026-03-17)


### Bug Fixes

* **guest-agent:** add stuck-tool watchdog for claude code network tool hang ([#4833](https://github.com/vm0-ai/vm0/issues/4833)) ([7b71fa7](https://github.com/vm0-ai/vm0/commit/7b71fa78f9d7155f08059118391416ecf785027f)), closes [#4785](https://github.com/vm0-ai/vm0/issues/4785)

## [0.14.2](https://github.com/vm0-ai/vm0/compare/v0.14.1...v0.14.2) (2026-03-17)


### Bug Fixes

* **guest-agent:** add stuck-tool watchdog for claude code network tool hang ([#4833](https://github.com/vm0-ai/vm0/issues/4833)) ([7b71fa7](https://github.com/vm0-ai/vm0/commit/7b71fa78f9d7155f08059118391416ecf785027f)), closes [#4785](https://github.com/vm0-ai/vm0/issues/4785)

## [0.14.1](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.14.0...guest-mock-claude-v0.14.1) (2026-03-15)


### Bug Fixes

* **guest-agent:** add stuck-tool watchdog for claude code network tool hang ([#4833](https://github.com/vm0-ai/vm0/issues/4833)) ([7b71fa7](https://github.com/vm0-ai/vm0/commit/7b71fa78f9d7155f08059118391416ecf785027f)), closes [#4785](https://github.com/vm0-ai/vm0/issues/4785)

## [0.14.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.13.0...guest-mock-claude-v0.14.0) (2026-03-04)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.13.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.12.3...guest-mock-claude-v0.13.0) (2026-03-03)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.12.3](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.12.2...guest-mock-claude-v0.12.3) (2026-03-02)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.12.2](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.12.1...guest-mock-claude-v0.12.2) (2026-03-02)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.12.1](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.12.0...guest-mock-claude-v0.12.1) (2026-03-01)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.12.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.11.0...guest-mock-claude-v0.12.0) (2026-03-01)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.11.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.10.0...guest-mock-claude-v0.11.0) (2026-03-01)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.10.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.9.0...guest-mock-claude-v0.10.0) (2026-03-01)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.9.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.8.5...guest-mock-claude-v0.9.0) (2026-03-01)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.8.5](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.8.4...guest-mock-claude-v0.8.5) (2026-02-28)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.8.4](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.8.3...guest-mock-claude-v0.8.4) (2026-02-27)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.8.3](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.8.2...guest-mock-claude-v0.8.3) (2026-02-27)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.8.2](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.8.1...guest-mock-claude-v0.8.2) (2026-02-27)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.8.1](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.8.0...guest-mock-claude-v0.8.1) (2026-02-26)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.8.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.7.0...guest-mock-claude-v0.8.0) (2026-02-25)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.7.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.6.0...guest-mock-claude-v0.7.0) (2026-02-25)


### Miscellaneous Chores

* **guest-mock-claude:** Synchronize runner-guest versions

## [0.6.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.5.0...guest-mock-claude-v0.6.0) (2026-02-23)


### Features

* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.4.0...guest-mock-claude-v0.5.0) (2026-02-23)


### Features

* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.3.0...guest-mock-claude-v0.4.0) (2026-02-22)


### Features

* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.2.0...guest-mock-claude-v0.3.0) (2026-02-22)


### Features

* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/guest-mock-claude-v0.1.0...guest-mock-claude-v0.2.0) (2026-02-22)


### Features

* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))
