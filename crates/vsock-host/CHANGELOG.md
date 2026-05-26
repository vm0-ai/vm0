# Changelog

## [0.17.15](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.14...vsock-host-v0.17.15) (2026-05-26)


### Bug Fixes

* demote expected exec cancel terminal logs ([#14990](https://github.com/vm0-ai/vm0/issues/14990)) ([26428c4](https://github.com/vm0-ai/vm0/commit/26428c4ae737dd11412237118d83bca9841e0b74))

## [0.17.14](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.13...vsock-host-v0.17.14) (2026-05-25)


### Bug Fixes

* move guest exec exit warnings to callers ([#14889](https://github.com/vm0-ai/vm0/issues/14889)) ([c58dc82](https://github.com/vm0-ai/vm0/commit/c58dc827e11a9a5d6dc70c8e2d07a588983da9d7))

## [0.17.13](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.12...vsock-host-v0.17.13) (2026-05-25)

## [0.17.12](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.11...vsock-host-v0.17.12) (2026-05-25)


### Bug Fixes

* pass guest reseed entropy over exec stdin ([#14758](https://github.com/vm0-ai/vm0/issues/14758)) ([6f9a4aa](https://github.com/vm0-ai/vm0/commit/6f9a4aac941effcad301911f5dfec055bb758667))

## [0.17.11](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.10...vsock-host-v0.17.11) (2026-05-23)


### Bug Fixes

* **vsock-host:** demote clean supervised terminal logs ([#14564](https://github.com/vm0-ai/vm0/issues/14564)) ([65165dd](https://github.com/vm0-ai/vm0/commit/65165ddf38dc66174de8af1236f1d56d41f98efd))

## [0.17.10](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.9...vsock-host-v0.17.10) (2026-05-22)


### Bug Fixes

* cancel guest process before runner cleanup ([#14537](https://github.com/vm0-ai/vm0/issues/14537)) ([55b3ab7](https://github.com/vm0-ai/vm0/commit/55b3ab78eb113e7665c6d097f5e2fdbef8b30193))

## [0.17.9](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.8...vsock-host-v0.17.9) (2026-05-21)

## [0.17.8](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.7...vsock-host-v0.17.8) (2026-05-21)


### Refactoring

* centralize vsock-host exec dispatch ([#14440](https://github.com/vm0-ai/vm0/issues/14440)) ([f161112](https://github.com/vm0-ai/vm0/commit/f161112789c7441da1d6408e50c22a8281a60e34))
* centralize vsock-host request lifecycle ([#14419](https://github.com/vm0-ai/vm0/issues/14419)) ([b2832f0](https://github.com/vm0-ai/vm0/commit/b2832f04a37c349df6ca4b0779a5fed3faf9a867))

## [0.17.7](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.6...vsock-host-v0.17.7) (2026-05-21)


### Refactoring

* remove legacy spawn process protocol ([#14315](https://github.com/vm0-ai/vm0/issues/14315)) ([eecb69f](https://github.com/vm0-ai/vm0/commit/eecb69fbba0b5a16b0cd804698613303655dcb7e))

## [0.17.6](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.5...vsock-host-v0.17.6) (2026-05-20)


### Refactoring

* implement supervised exec guest path ([#14075](https://github.com/vm0-ai/vm0/issues/14075)) ([61a73f3](https://github.com/vm0-ai/vm0/commit/61a73f357701276bf60c448cbf0f9f70d9ebbcc5))

## [0.17.5](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.4...vsock-host-v0.17.5) (2026-05-19)


### Refactoring

* add supervised exec host path ([#13999](https://github.com/vm0-ai/vm0/issues/13999)) ([3aab243](https://github.com/vm0-ai/vm0/commit/3aab243060e127601e411ca293d45f2d22b6069d))

## [0.17.4](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.3...vsock-host-v0.17.4) (2026-05-19)


### Refactoring

* remove sandbox-fc operation lease mirror ([#13961](https://github.com/vm0-ai/vm0/issues/13961)) ([c175dc4](https://github.com/vm0-ai/vm0/commit/c175dc4d9ac88556deecbdc5193837ce28b2b0e5))
* upgrade exec start protocol schema ([#13841](https://github.com/vm0-ai/vm0/issues/13841)) ([6790751](https://github.com/vm0-ai/vm0/commit/67907514ba9f7372a4de7e0351cf5c724b997087))

## [0.17.3](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.2...vsock-host-v0.17.3) (2026-05-19)


### Refactoring

* fence normal operations during sandbox park ([#13898](https://github.com/vm0-ai/vm0/issues/13898)) ([00358eb](https://github.com/vm0-ai/vm0/commit/00358ebbe2bce58f5081cb4b98c5e57958f947c3))

## [0.17.2](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.1...vsock-host-v0.17.2) (2026-05-19)


### Refactoring

* gate process control requests ([#13845](https://github.com/vm0-ai/vm0/issues/13845)) ([9dc1d33](https://github.com/vm0-ai/vm0/commit/9dc1d33ddb9fb1e2d479c574ebf85afd61cb45b8))

## [0.17.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.17.0...vsock-host-v0.17.1) (2026-05-18)


### Bug Fixes

* make vsock-host request writes cancel-safe ([#13716](https://github.com/vm0-ai/vm0/issues/13716)) ([c93fb73](https://github.com/vm0-ai/vm0/commit/c93fb73692f3ff6338a9a43c237c472a8772d7a5))


### Refactoring

* align process control timeout semantics ([#13598](https://github.com/vm0-ai/vm0/issues/13598)) ([9f56eae](https://github.com/vm0-ai/vm0/commit/9f56eae01348c91ec3df805d0a3c0566aacc9dbf))
* track composite vsock file operations ([#13593](https://github.com/vm0-ai/vm0/issues/13593)) ([c0e7ea1](https://github.com/vm0-ai/vm0/commit/c0e7ea197a8ff23f793020848f9152c227c59231))
* track spawn process lifetime in vsock-host ([#13659](https://github.com/vm0-ai/vm0/issues/13659)) ([142aa7e](https://github.com/vm0-ai/vm0/commit/142aa7e51f8514d41a31e695c493c6dfb4ea7894))

## [0.17.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.16.1...vsock-host-v0.17.0) (2026-05-17)


### Features

* wire operation-bound process control to guest-agent ([#13538](https://github.com/vm0-ai/vm0/issues/13538)) ([3bc2ee1](https://github.com/vm0-ai/vm0/commit/3bc2ee1dda51d68c6825a1a71bf44edbc9692a0d))

## [0.16.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.16.0...vsock-host-v0.16.1) (2026-05-16)


### Refactoring

* **vsock-host:** track bounded normal operations ([#13484](https://github.com/vm0-ai/vm0/issues/13484)) ([6f8b45d](https://github.com/vm0-ai/vm0/commit/6f8b45dab63700a536b4f39e2812907f2abeea02))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.15.3...vsock-host-v0.16.0) (2026-05-15)


### Features

* add spawn process control plane ([#13482](https://github.com/vm0-ai/vm0/issues/13482)) ([a315a3a](https://github.com/vm0-ai/vm0/commit/a315a3ac3cd61e5ed42e642eb88f44fb943631a1))

## [0.15.3](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.15.2...vsock-host-v0.15.3) (2026-05-15)


### Refactoring

* **vsock-host:** add normal operation tracker ([#13464](https://github.com/vm0-ai/vm0/issues/13464)) ([f4754b1](https://github.com/vm0-ai/vm0/commit/f4754b15b6134cc13c424adaaf5ad5372aec5798))

## [0.15.2](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.15.1...vsock-host-v0.15.2) (2026-05-15)


### Refactoring

* rename vsock command operation ([#13465](https://github.com/vm0-ai/vm0/issues/13465)) ([bd1742b](https://github.com/vm0-ai/vm0/commit/bd1742b001bec3edf81cd5daf410294f722315e6))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.15.0...vsock-host-v0.15.1) (2026-05-15)


### Refactoring

* rename spawn watch to spawn process ([#13369](https://github.com/vm0-ai/vm0/issues/13369)) ([e007f30](https://github.com/vm0-ai/vm0/commit/e007f30a2610056a6905e4a38bcc2d894895ffa4))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.14.5...vsock-host-v0.15.0) (2026-05-14)


### Features

* add vsock operation quiesce protocol ([#13343](https://github.com/vm0-ai/vm0/issues/13343)) ([d1738c7](https://github.com/vm0-ai/vm0/commit/d1738c7d9665769411c2d99f4b3c116d6e132df9))

## [0.14.5](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.14.4...vsock-host-v0.14.5) (2026-05-14)

## [0.14.4](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.14.3...vsock-host-v0.14.4) (2026-05-14)


### Refactoring

* **vsock-host:** split command tests ([#13320](https://github.com/vm0-ai/vm0/issues/13320)) ([51718be](https://github.com/vm0-ai/vm0/commit/51718bef2883cff06274c89e6ea67e019fb6d8f6))

## [0.14.3](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.14.2...vsock-host-v0.14.3) (2026-05-14)


### Bug Fixes

* suppress expected command exits ([#13270](https://github.com/vm0-ai/vm0/issues/13270)) ([2132288](https://github.com/vm0-ai/vm0/commit/213228850c442d9ba480acb31810a940687e572f))
* **vsock:** route spawn_watch lifecycle by sequence ([#13220](https://github.com/vm0-ai/vm0/issues/13220)) ([373d2ab](https://github.com/vm0-ai/vm0/commit/373d2ab0c2312e9f888c2d9780bcef71386f42cd))

## [0.14.2](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.14.1...vsock-host-v0.14.2) (2026-05-14)

## [0.14.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.14.0...vsock-host-v0.14.1) (2026-05-13)

## [0.14.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.13.3...vsock-host-v0.14.0) (2026-05-13)


### Features

* add bounded exec output policies ([#12292](https://github.com/vm0-ai/vm0/issues/12292)) ([71f6ad9](https://github.com/vm0-ai/vm0/commit/71f6ad9aaadaa9bf6589a5915c51ab4c092547eb))
* add host-initiated vsock control handshake ([#12543](https://github.com/vm0-ai/vm0/issues/12543)) ([de17089](https://github.com/vm0-ai/vm0/commit/de17089191b001b3ed6f33487b62a3360bf81174))
* **vsock-host:** add command operation router ([#12782](https://github.com/vm0-ai/vm0/issues/12782)) ([e1ad973](https://github.com/vm0-ai/vm0/commit/e1ad97343e41c441d3539de961f44c91bbad9309))


### Bug Fixes

* **vsock-host:** poison interrupted frame writes ([#12247](https://github.com/vm0-ai/vm0/issues/12247)) ([1860100](https://github.com/vm0-ai/vm0/commit/1860100ba26eecb7db2cd10fa2d63974e2016a76))


### Documentation

* document bounded exec preference ([#12599](https://github.com/vm0-ai/vm0/issues/12599)) ([70aa4eb](https://github.com/vm0-ai/vm0/commit/70aa4eb5444809dc49132cc003278eb2bd504a39))


### Refactoring

* extract vsock host command core ([#13106](https://github.com/vm0-ai/vm0/issues/13106)) ([5890b1a](https://github.com/vm0-ai/vm0/commit/5890b1a45ce9e972ea5841b2d6a77c5c8666533d))
* route sandbox exec through command operations ([#13018](https://github.com/vm0-ai/vm0/issues/13018)) ([0e5f862](https://github.com/vm0-ai/vm0/commit/0e5f862ee8e2182e23a88df6187f194171004b1f))
* **runner:** migrate internal execs to bounded exec ([#12322](https://github.com/vm0-ai/vm0/issues/12322)) ([f0b84b4](https://github.com/vm0-ai/vm0/commit/f0b84b4f09bad9abc16074af3f0190944bba3d04))
* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))
* split vsock host file helpers ([#13122](https://github.com/vm0-ai/vm0/issues/13122)) ([587863c](https://github.com/vm0-ai/vm0/commit/587863cbc41e623b074fb7b1952c649c526cb0fa))
* split vsock host process helpers ([#13146](https://github.com/vm0-ai/vm0/issues/13146)) ([bc1ef7c](https://github.com/vm0-ai/vm0/commit/bc1ef7cb2e3c7740b4cc05c9509066c802ee3456))


### Performance Improvements

* **vsock-host:** cap bounded exec stream forwarding ([#12267](https://github.com/vm0-ai/vm0/issues/12267)) ([9a8063a](https://github.com/vm0-ai/vm0/commit/9a8063af272ea95005ce8f2d5c37eba2d64105e5))

## [0.13.3](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.13.2...vsock-host-v0.13.3) (2026-05-13)


### Refactoring

* split vsock host process helpers ([#13146](https://github.com/vm0-ai/vm0/issues/13146)) ([bc1ef7c](https://github.com/vm0-ai/vm0/commit/bc1ef7cb2e3c7740b4cc05c9509066c802ee3456))

## [0.13.2](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.13.1...vsock-host-v0.13.2) (2026-05-13)


### Refactoring

* extract vsock host command core ([#13106](https://github.com/vm0-ai/vm0/issues/13106)) ([5890b1a](https://github.com/vm0-ai/vm0/commit/5890b1a45ce9e972ea5841b2d6a77c5c8666533d))

## [0.13.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.13.0...vsock-host-v0.13.1) (2026-05-13)


### Refactoring

* route sandbox exec through command operations ([#13018](https://github.com/vm0-ai/vm0/issues/13018)) ([0e5f862](https://github.com/vm0-ai/vm0/commit/0e5f862ee8e2182e23a88df6187f194171004b1f))

## [0.13.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.12.1...vsock-host-v0.13.0) (2026-05-12)


### Features

* **vsock-host:** add command operation router ([#12782](https://github.com/vm0-ai/vm0/issues/12782)) ([e1ad973](https://github.com/vm0-ai/vm0/commit/e1ad97343e41c441d3539de961f44c91bbad9309))

## [0.12.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.12.0...vsock-host-v0.12.1) (2026-05-12)

## [0.12.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.11.1...vsock-host-v0.12.0) (2026-05-10)


### Features

* add host-initiated vsock control handshake ([#12543](https://github.com/vm0-ai/vm0/issues/12543)) ([de17089](https://github.com/vm0-ai/vm0/commit/de17089191b001b3ed6f33487b62a3360bf81174))


### Documentation

* document bounded exec preference ([#12599](https://github.com/vm0-ai/vm0/issues/12599)) ([70aa4eb](https://github.com/vm0-ai/vm0/commit/70aa4eb5444809dc49132cc003278eb2bd504a39))


### Refactoring

* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))

## [0.11.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.11.0...vsock-host-v0.11.1) (2026-05-09)


### Refactoring

* **runner:** migrate internal execs to bounded exec ([#12322](https://github.com/vm0-ai/vm0/issues/12322)) ([f0b84b4](https://github.com/vm0-ai/vm0/commit/f0b84b4f09bad9abc16074af3f0190944bba3d04))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.10.2...vsock-host-v0.11.0) (2026-05-09)


### Features

* add bounded exec output policies ([#12292](https://github.com/vm0-ai/vm0/issues/12292)) ([71f6ad9](https://github.com/vm0-ai/vm0/commit/71f6ad9aaadaa9bf6589a5915c51ab4c092547eb))

## [0.10.2](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.10.1...vsock-host-v0.10.2) (2026-05-09)


### Performance Improvements

* **vsock-host:** cap bounded exec stream forwarding ([#12267](https://github.com/vm0-ai/vm0/issues/12267)) ([9a8063a](https://github.com/vm0-ai/vm0/commit/9a8063af272ea95005ce8f2d5c37eba2d64105e5))

## [0.10.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.10.0...vsock-host-v0.10.1) (2026-05-09)


### Bug Fixes

* **vsock-host:** poison interrupted frame writes ([#12247](https://github.com/vm0-ai/vm0/issues/12247)) ([1860100](https://github.com/vm0-ai/vm0/commit/1860100ba26eecb7db2cd10fa2d63974e2016a76))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.12...vsock-host-v0.10.0) (2026-05-08)


### Features

* **sandbox:** wire bounded exec through host and firecracker sandbox ([#12203](https://github.com/vm0-ai/vm0/issues/12203)) ([71602f2](https://github.com/vm0-ai/vm0/commit/71602f22f27413438b63fb6f830b1653497189b1))

## [0.9.12](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.11...vsock-host-v0.9.12) (2026-05-08)


### Performance Improvements

* add guest write-file helper ([#12136](https://github.com/vm0-ai/vm0/issues/12136)) ([8795398](https://github.com/vm0-ai/vm0/commit/8795398ddd54bb6f7e4cade4c1d3a67a11bebd1b))

## [0.9.11](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.10...vsock-host-v0.9.11) (2026-05-08)

## [0.9.10](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.9...vsock-host-v0.9.10) (2026-05-05)

## [0.9.9](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.8...vsock-host-v0.9.9) (2026-05-03)

## [0.9.8](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.7...vsock-host-v0.9.8) (2026-05-03)

## [0.9.7](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.6...vsock-host-v0.9.7) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.9.6](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.5...vsock-host-v0.9.6) (2026-04-27)


### Bug Fixes

* make guest-agent own system log writes ([#11238](https://github.com/vm0-ai/vm0/issues/11238)) ([5041a49](https://github.com/vm0-ai/vm0/commit/5041a49416701955915962bc13aed07e5618db3e))

## [0.9.5](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.4...vsock-host-v0.9.5) (2026-04-27)


### Bug Fixes

* **sandbox-fc:** persist backend crash state ([#11192](https://github.com/vm0-ai/vm0/issues/11192)) ([57c4222](https://github.com/vm0-ai/vm0/commit/57c4222d68327eac25a3a96f8256c8cc2275fc24))

## [0.9.4](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.3...vsock-host-v0.9.4) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.9.3](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.2...vsock-host-v0.9.3) (2026-04-20)


### Bug Fixes

* **vsock-host:** encode connection state in type to prevent close races ([#10199](https://github.com/vm0-ai/vm0/issues/10199)) ([f3b62ce](https://github.com/vm0-ai/vm0/commit/f3b62ce6a692e56fd54ccd68804419ddfebac0a6))

## [0.9.2](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.1...vsock-host-v0.9.2) (2026-04-17)


### Bug Fixes

* **vsock:** handle exec timeout_ms=0 across host and guest ([#9793](https://github.com/vm0-ai/vm0/issues/9793)) ([03a37b0](https://github.com/vm0-ai/vm0/commit/03a37b0ae1566f76ce0dbc97b5bb3e0bd1947f4b))

## [0.9.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.9.0...vsock-host-v0.9.1) (2026-04-17)

## [0.9.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.8.0...vsock-host-v0.9.0) (2026-04-14)


### Features

* **vsock:** chunked write_file with append flag for large files ([#9335](https://github.com/vm0-ai/vm0/issues/9335)) ([16f128d](https://github.com/vm0-ai/vm0/commit/16f128d5e28e43c869a9e4bcc8993b1637175f93))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.7.0...vsock-host-v0.8.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.6.1...vsock-host-v0.7.0) (2026-03-20)


### Features

* **vsock:** add real-time stdout streaming from guest to host ([#5574](https://github.com/vm0-ai/vm0/issues/5574)) ([2afc093](https://github.com/vm0-ai/vm0/commit/2afc0930657f6bbf1e1f4947383345d33de46819))

## [0.6.1](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.6.0...vsock-host-v0.6.1) (2026-03-06)


### Refactoring

* **vsock-host:** enable concurrent operations via background reader task ([#3460](https://github.com/vm0-ai/vm0/issues/3460)) ([9a93aa3](https://github.com/vm0-ai/vm0/commit/9a93aa3a73afc0f38fe675cb73b4853c1e07fecf))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.5.0...vsock-host-v0.6.0) (2026-02-23)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.5.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.4.0...vsock-host-v0.5.0) (2026-02-23)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.4.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.3.0...vsock-host-v0.4.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.3.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.2.0...vsock-host-v0.3.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)

## [0.2.0](https://github.com/vm0-ai/vm0/compare/vsock-host-v0.1.0...vsock-host-v0.2.0) (2026-02-22)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)
