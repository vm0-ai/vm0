# Changelog

## [0.4.24](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.23...nbd-cow-v0.4.24) (2026-05-25)


### Performance Improvements

* **nbd-cow:** avoid try_clone fcntl syscall in flush() ([#14841](https://github.com/vm0-ai/vm0/issues/14841)) ([0ba1623](https://github.com/vm0-ai/vm0/commit/0ba16239e16bf3d402205675473812ad3d21a71b))

## [0.4.23](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.22...nbd-cow-v0.4.23) (2026-05-24)


### Refactoring

* **nbd-cow:** deduplicate destroy retry loop ([#14670](https://github.com/vm0-ai/vm0/issues/14670)) ([229a05c](https://github.com/vm0-ai/vm0/commit/229a05cc2c219fe8c688afdc23e5b8bf9957c064))

## [0.4.22](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.21...nbd-cow-v0.4.22) (2026-05-16)


### Refactoring

* deduplicate nbd-cow nla builders ([#13547](https://github.com/vm0-ai/vm0/issues/13547)) ([71ea676](https://github.com/vm0-ai/vm0/commit/71ea6762f139009f6fae4433dd6c1d75dc74db1c))

## [0.4.21](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.20...nbd-cow-v0.4.21) (2026-05-14)


### Performance Improvements

* **nbd-cow:** avoid flush buffer allocation ([#13308](https://github.com/vm0-ai/vm0/issues/13308)) ([8c9e685](https://github.com/vm0-ai/vm0/commit/8c9e6854454b6a791c146056e88066a8ebd084ee))

## [0.4.20](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.19...nbd-cow-v0.4.20) (2026-05-12)


### Bug Fixes

* report workload fio metrics in nbd-cow bench ([#12947](https://github.com/vm0-ai/vm0/issues/12947)) ([e3d34d2](https://github.com/vm0-ai/vm0/commit/e3d34d2bb2510ef11f6d0ed2af5ff2a13ab8cc19))

## [0.4.19](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.18...nbd-cow-v0.4.19) (2026-05-12)


### Bug Fixes

* **nbd-cow:** clean up ambiguous connect failures ([#12753](https://github.com/vm0-ai/vm0/issues/12753)) ([b0b342f](https://github.com/vm0-ai/vm0/commit/b0b342fc01460575c13705fb60d2c3b61299cb69))

## [0.4.18](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.17...nbd-cow-v0.4.18) (2026-05-09)


### Bug Fixes

* match nbd netlink completions by sequence ([#12298](https://github.com/vm0-ai/vm0/issues/12298)) ([a225c28](https://github.com/vm0-ai/vm0/commit/a225c28aa1b2171ea4f77f1feaed9e3920ef6030))

## [0.4.17](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.16...nbd-cow-v0.4.17) (2026-05-07)


### Documentation

* document nbd-cow error types ([#12062](https://github.com/vm0-ai/vm0/issues/12062)) ([d54e524](https://github.com/vm0-ai/vm0/commit/d54e5241ba64eff1c596d6e61b3015d25c59cdef))

## [0.4.16](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.15...nbd-cow-v0.4.16) (2026-05-07)


### Refactoring

* **nbd-cow:** collapse device pool actor select ([#12015](https://github.com/vm0-ai/vm0/issues/12015)) ([c6e2552](https://github.com/vm0-ai/vm0/commit/c6e2552ed723b4ae537637a99ead8d49ce504f8f))

## [0.4.15](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.14...nbd-cow-v0.4.15) (2026-05-06)


### Refactoring

* **nbd-cow:** deduplicate lease return commands ([#11914](https://github.com/vm0-ai/vm0/issues/11914)) ([4350a70](https://github.com/vm0-ai/vm0/commit/4350a70475fb519268608bbcefefffc441a1bedd))

## [0.4.14](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.13...nbd-cow-v0.4.14) (2026-05-06)


### Refactoring

* **nbd-cow:** dedupe success replies ([#11902](https://github.com/vm0-ai/vm0/issues/11902)) ([9f31d0d](https://github.com/vm0-ai/vm0/commit/9f31d0dcb2f83b4b5bfd794d7541a3d07187f56f))

## [0.4.13](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.12...nbd-cow-v0.4.13) (2026-05-05)


### Documentation

* **nbd-cow:** clarify device lease authority ([#11864](https://github.com/vm0-ai/vm0/issues/11864)) ([56c40a8](https://github.com/vm0-ai/vm0/commit/56c40a85cbfeb026b485426f464dbdeecc9a44ff))

## [0.4.12](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.11...nbd-cow-v0.4.12) (2026-05-03)


### Bug Fixes

* **nbd-cow:** lock NBD claims across runners ([#11732](https://github.com/vm0-ai/vm0/issues/11732)) ([16d716e](https://github.com/vm0-ai/vm0/commit/16d716e1f07a77c0d93649f52d077953dd62ff16))

## [0.4.11](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.10...nbd-cow-v0.4.11) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.4.10](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.9...nbd-cow-v0.4.10) (2026-04-29)


### Refactoring

* **nbd-cow:** tie device pool leases to COW lifecycle ([#11480](https://github.com/vm0-ai/vm0/issues/11480)) ([b99a732](https://github.com/vm0-ai/vm0/commit/b99a732e7732af47b5837dc3937eeb3acdf71b2e))

## [0.4.9](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.8...nbd-cow-v0.4.9) (2026-04-27)


### Bug Fixes

* **runner:** make idle vm budget release panic-safe ([#11191](https://github.com/vm0-ai/vm0/issues/11191)) ([52e085f](https://github.com/vm0-ai/vm0/commit/52e085fb6e53623b5920fbfee58ccc71d8d760ae))

## [0.4.8](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.7...nbd-cow-v0.4.8) (2026-04-26)


### Documentation

* **nbd-cow:** add crate module documentation ([#11164](https://github.com/vm0-ai/vm0/issues/11164)) ([845c276](https://github.com/vm0-ai/vm0/commit/845c276217fb4e76e289f98f48af1a4340759e06))

## [0.4.7](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.6...nbd-cow-v0.4.7) (2026-04-23)


### Documentation

* document nbd request and reply fields (closes [#10645](https://github.com/vm0-ai/vm0/issues/10645)) ([#10810](https://github.com/vm0-ai/vm0/issues/10810)) ([c0f87a5](https://github.com/vm0-ai/vm0/commit/c0f87a543fef33ef6d96a12a6cf12b67636623c3))

## [0.4.6](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.5...nbd-cow-v0.4.6) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.4.5](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.4...nbd-cow-v0.4.5) (2026-04-18)


### Bug Fixes

* **sandbox-fc:** fail snapshot when destroy_keep_cow retries exhaust ([#9870](https://github.com/vm0-ai/vm0/issues/9870)) ([c0c4120](https://github.com/vm0-ai/vm0/commit/c0c41201de5362b982295b498476bcfbffe5bebc))

## [0.4.4](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.3...nbd-cow-v0.4.4) (2026-04-17)


### Bug Fixes

* **nbd-cow:** fsync parent directory after bitmap rename ([#9827](https://github.com/vm0-ai/vm0/issues/9827)) ([b04f40b](https://github.com/vm0-ai/vm0/commit/b04f40bd39b0a92a776f79205b86e8ef78aca857))
* **nbd-cow:** track in-flight device indices to prevent duplicate allocation ([#9033](https://github.com/vm0-ai/vm0/issues/9033)) ([4f43ab5](https://github.com/vm0-ai/vm0/commit/4f43ab5b5647d1c1ad61a37c3517b9419270259c)), closes [#9016](https://github.com/vm0-ai/vm0/issues/9016)


### Performance Improvements

* **nbd-cow:** drop lock guard before sending error replies ([#9742](https://github.com/vm0-ai/vm0/issues/9742)) ([ea3568c](https://github.com/vm0-ai/vm0/commit/ea3568c567db437b37b3bd9a7b6251f37d5205b2))

## [0.4.3](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.2...nbd-cow-v0.4.3) (2026-04-17)


### Bug Fixes

* **nbd-cow:** fsync parent directory after bitmap rename ([#9827](https://github.com/vm0-ai/vm0/issues/9827)) ([b04f40b](https://github.com/vm0-ai/vm0/commit/b04f40bd39b0a92a776f79205b86e8ef78aca857))

## [0.4.2](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.1...nbd-cow-v0.4.2) (2026-04-17)


### Performance Improvements

* **nbd-cow:** drop lock guard before sending error replies ([#9742](https://github.com/vm0-ai/vm0/issues/9742)) ([ea3568c](https://github.com/vm0-ai/vm0/commit/ea3568c567db437b37b3bd9a7b6251f37d5205b2))

## [0.4.1](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.4.0...nbd-cow-v0.4.1) (2026-04-12)


### Bug Fixes

* **nbd-cow:** track in-flight device indices to prevent duplicate allocation ([#9033](https://github.com/vm0-ai/vm0/issues/9033)) ([4f43ab5](https://github.com/vm0-ai/vm0/commit/4f43ab5b5647d1c1ad61a37c3517b9419270259c)), closes [#9016](https://github.com/vm0-ai/vm0/issues/9016)

## [0.4.0](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.4...nbd-cow-v0.4.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.3.4](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.3...nbd-cow-v0.3.4) (2026-04-06)


### Refactoring

* **nbd:** deduplicate nbds_max, add concurrent test and bitmap assertion ([#8228](https://github.com/vm0-ai/vm0/issues/8228)) ([c0b98df](https://github.com/vm0-ai/vm0/commit/c0b98df3eb69ec81b26373d23d093a9526839752))

## [0.3.3](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.2...nbd-cow-v0.3.3) (2026-04-03)


### Bug Fixes

* **nbd-cow:** fix device leak when connecting worker thread exits ([#8064](https://github.com/vm0-ai/vm0/issues/8064)) ([25ed885](https://github.com/vm0-ai/vm0/commit/25ed885f1e646b6c1742e6b8d00cf0ca8a4ccf03))

## [0.3.2](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.1...nbd-cow-v0.3.2) (2026-04-03)


### Bug Fixes

* **nbd:** set disconnected flag only after successful disconnect ([#7870](https://github.com/vm0-ai/vm0/issues/7870)) ([6ffe3d4](https://github.com/vm0-ai/vm0/commit/6ffe3d483f1bdd70327b2e1303c541d600d127fe))

## [0.3.1](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.3.0...nbd-cow-v0.3.1) (2026-04-02)


### Bug Fixes

* use is_our_thread in bench cleanup and merge snapshot pool locks ([#7763](https://github.com/vm0-ai/vm0/issues/7763)) ([654d086](https://github.com/vm0-ai/vm0/commit/654d08604135e98a247b056413bf0c7e7d5065e0))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.3...nbd-cow-v0.3.0) (2026-04-02)


### Features

* add device pool for pre-validated nbd device index management ([#7695](https://github.com/vm0-ai/vm0/issues/7695)) ([aae067f](https://github.com/vm0-ai/vm0/commit/aae067febb127343ce4424ae78c3c312057479c9))

## [0.2.3](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.2...nbd-cow-v0.2.3) (2026-04-02)


### Bug Fixes

* **nbd-cow:** address review findings and randomize device scan ([#7603](https://github.com/vm0-ai/vm0/issues/7603)) ([8475b9e](https://github.com/vm0-ai/vm0/commit/8475b9eb110300393da0dffa482778a9bda5422d))

## [0.2.2](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.1...nbd-cow-v0.2.2) (2026-04-01)


### Bug Fixes

* **nbd-cow:** guard disconnect against device index recycling by other runners ([#7581](https://github.com/vm0-ai/vm0/issues/7581)) ([ed9e572](https://github.com/vm0-ai/vm0/commit/ed9e572a80514236aada53eb68b2e9ad069ec7d2))

## [0.2.1](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.2.0...nbd-cow-v0.2.1) (2026-04-01)


### Bug Fixes

* **nbd-cow:** advertise flush/trim flags and harden i/o paths ([#7539](https://github.com/vm0-ai/vm0/issues/7539)) ([6410e3e](https://github.com/vm0-ai/vm0/commit/6410e3ebc7652ba6f2da8edf14928346e70b7fb2))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/nbd-cow-v0.1.0...nbd-cow-v0.2.0) (2026-04-01)


### Features

* **nbd-cow:** add api surface for sandbox-fc integration ([#7307](https://github.com/vm0-ai/vm0/issues/7307)) ([042a3f6](https://github.com/vm0-ai/vm0/commit/042a3f6f3a21944565158ee87ae079185d5a89ec))
* **nbd-cow:** add minimal nbd server prototype with cow write buffer ([#7251](https://github.com/vm0-ai/vm0/issues/7251)) ([15498b7](https://github.com/vm0-ai/vm0/commit/15498b79a378b5661e5fd2ac05eaae64d81683c1))
* **sandbox-fc:** replace dm-snapshot with nbd-cow ([#7406](https://github.com/vm0-ai/vm0/issues/7406)) ([bc60c4b](https://github.com/vm0-ai/vm0/commit/bc60c4b01eaac368f7434d367784855b0b50479b))
