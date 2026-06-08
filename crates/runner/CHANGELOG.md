# Changelog

## [0.108.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.18...runner-rs-v0.108.19) (2026-06-08)


### Bug Fixes

* coordinate run cancellation with idle pool transfer ([#16692](https://github.com/vm0-ai/vm0/issues/16692)) ([e4b432e](https://github.com/vm0-ai/vm0/commit/e4b432ed93981c7dd3bdf6fb6fda889dfe6158d2))

## [0.108.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.17...runner-rs-v0.108.18) (2026-06-08)


### Bug Fixes

* **runner:** harden proxy and workspace state files ([#16668](https://github.com/vm0-ai/vm0/issues/16668)) ([7bf9851](https://github.com/vm0-ai/vm0/commit/7bf985137af718d843c086fc74f8c90a3f720783))
* **runner:** serialize service unit installs ([#16539](https://github.com/vm0-ai/vm0/issues/16539)) ([453e1ef](https://github.com/vm0-ai/vm0/commit/453e1ef7ce3a2061de1536e3302e322d6651b0a3))


### Refactoring

* **runner:** split executor test support harness ([#16666](https://github.com/vm0-ai/vm0/issues/16666)) ([965d370](https://github.com/vm0-ai/vm0/commit/965d370563b2491ff9b8341e903c831509847cf1))


### Performance Improvements

* **runner:** avoid dns parser token allocation ([#16664](https://github.com/vm0-ai/vm0/issues/16664)) ([7274f04](https://github.com/vm0-ai/vm0/commit/7274f04f9ed5388bcc0b461209368f22c2326d11))

## [0.108.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.16...runner-rs-v0.108.17) (2026-06-08)


### Bug Fixes

* default redact captured header values ([#16456](https://github.com/vm0-ai/vm0/issues/16456)) ([bad2803](https://github.com/vm0-ai/vm0/commit/bad2803f0accee54b96ccdc4e430e4c2ac4d8b7d))
* harden runner private state files ([#16584](https://github.com/vm0-ai/vm0/issues/16584)) ([d399316](https://github.com/vm0-ai/vm0/commit/d399316c0333015029ccaa6b34545083dc23bbc0))
* **mitm-addon:** bound tcp message retention ([#16648](https://github.com/vm0-ai/vm0/issues/16648)) ([166f3c9](https://github.com/vm0-ai/vm0/commit/166f3c9595ab705bcca3f143248460d72a7633c9))
* serialize runner service unit updates ([#16505](https://github.com/vm0-ai/vm0/issues/16505)) ([1c6a723](https://github.com/vm0-ai/vm0/commit/1c6a723e528dd8166873be7bb5996e3c8b805df8))


### Refactoring

* share mitm authority primitives ([#16642](https://github.com/vm0-ai/vm0/issues/16642)) ([eb3a89c](https://github.com/vm0-ai/vm0/commit/eb3a89c305947d28ce1ac21401e7e07128a8635b))


### Performance Improvements

* **runner:** offload mitm jsonl log writes ([#16601](https://github.com/vm0-ai/vm0/issues/16601)) ([9028927](https://github.com/vm0-ai/vm0/commit/9028927ea210478982b5c40d774b10fcf17cdff4))

## [0.108.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.15...runner-rs-v0.108.16) (2026-06-08)


### Bug Fixes

* handle concatenated zlib bodies ([#16578](https://github.com/vm0-ai/vm0/issues/16578)) ([9c86ca8](https://github.com/vm0-ai/vm0/commit/9c86ca81217c8931abd21179f936a944ef3a7ea4))


### Refactoring

* **runner:** consolidate finalization destroy bookkeeping ([#16554](https://github.com/vm0-ai/vm0/issues/16554)) ([f5fe9e1](https://github.com/vm0-ai/vm0/commit/f5fe9e183dda646494fdce8bb4f7f6d181cb923a))

## [0.108.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.14...runner-rs-v0.108.15) (2026-06-08)


### Bug Fixes

* **runner:** clean workspace holders before unmount retry ([#16523](https://github.com/vm0-ai/vm0/issues/16523)) ([493ec5b](https://github.com/vm0-ai/vm0/commit/493ec5b00fe0771ae208cfa26be9e4a0f041b7ba))

## [0.108.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.13...runner-rs-v0.108.14) (2026-06-08)


### Bug Fixes

* **runner:** preserve systemctl service query errors ([#16508](https://github.com/vm0-ai/vm0/issues/16508)) ([230822c](https://github.com/vm0-ai/vm0/commit/230822cd5c0ef4207379b3a4ef4facc565d6dc8d))

## [0.108.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.12...runner-rs-v0.108.13) (2026-06-07)


### Bug Fixes

* surface service logs journalctl failures ([#16499](https://github.com/vm0-ai/vm0/issues/16499)) ([e564257](https://github.com/vm0-ai/vm0/commit/e56425769e08dd6fc91d385e4db49bf299d0eaed))

## [0.108.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.11...runner-rs-v0.108.12) (2026-06-07)


### Bug Fixes

* make nbd orphan detection lock-aware ([#16388](https://github.com/vm0-ai/vm0/issues/16388)) ([6def1ff](https://github.com/vm0-ai/vm0/commit/6def1ff8df4f45c7154e428d52ae97fbf9a7bf29))
* **mitm-addon:** harden x billing json parser failures ([#16426](https://github.com/vm0-ai/vm0/issues/16426)) ([80c7315](https://github.com/vm0-ai/vm0/commit/80c73157dbbf5fa32922e1241e9f23ab2be5e745))
* prevent runner kill from signaling reused pids ([#16296](https://github.com/vm0-ai/vm0/issues/16296)) ([5b6c483](https://github.com/vm0-ai/vm0/commit/5b6c48301845c9267a7437b63014fcd6d75bc331))
* restore workspace image cache staff switch ([#16410](https://github.com/vm0-ai/vm0/issues/16410)) ([e78f7ad](https://github.com/vm0-ai/vm0/commit/e78f7ad24b2469854f1fdd43cf2422d915715f58))


### Documentation

* **mitm-addon:** document flow metadata contract ([#16423](https://github.com/vm0-ai/vm0/issues/16423)) ([ad9ed9e](https://github.com/vm0-ai/vm0/commit/ad9ed9e1d95748babc06045d7fe78405d5c30701))


### Refactoring

* **runner:** split executor into focused modules ([#16458](https://github.com/vm0-ai/vm0/issues/16458)) ([8ac3405](https://github.com/vm0-ai/vm0/commit/8ac3405705b7bef8a02c59b3b1125715bcbbbd3e))

## [0.108.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.10...runner-rs-v0.108.11) (2026-06-05)


### Bug Fixes

* **mitm-addon:** reject nested encoded unsafe paths ([#16309](https://github.com/vm0-ai/vm0/issues/16309)) ([2533197](https://github.com/vm0-ai/vm0/commit/2533197d15212008784285d19e36167a1335dbd4))
* **runner:** split guest-agent bootstrap env ([#16295](https://github.com/vm0-ai/vm0/issues/16295)) ([b77e7c7](https://github.com/vm0-ai/vm0/commit/b77e7c7c2dfd54e7c97596fee8ca371654e7c7b7))

## [0.108.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.9...runner-rs-v0.108.10) (2026-06-05)

## [0.108.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.8...runner-rs-v0.108.9) (2026-06-05)


### Bug Fixes

* **mitm-addon:** handle tld updater fetch failures ([#16293](https://github.com/vm0-ai/vm0/issues/16293)) ([901cb7e](https://github.com/vm0-ai/vm0/commit/901cb7ed48660db25ec92b05a2da7226b2f5fa30))

## [0.108.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.7...runner-rs-v0.108.8) (2026-06-05)


### Bug Fixes

* move guest runtime files out of tmp ([#16263](https://github.com/vm0-ai/vm0/issues/16263)) ([dc87ac5](https://github.com/vm0-ai/vm0/commit/dc87ac5f4f11ada3306d4061a845de5f592d09b2))

## [0.108.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.6...runner-rs-v0.108.7) (2026-06-05)


### Documentation

* **mitm-addon:** document url syntax helper semantics ([#16250](https://github.com/vm0-ai/vm0/issues/16250)) ([ff6d2cb](https://github.com/vm0-ai/vm0/commit/ff6d2cb3c290b72af2ae28dd0d939775587bf67b))

## [0.108.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.5...runner-rs-v0.108.6) (2026-06-04)


### Bug Fixes

* drain usage flushes during shutdown ([#16181](https://github.com/vm0-ai/vm0/issues/16181)) ([6ba3593](https://github.com/vm0-ai/vm0/commit/6ba35934834c1d82e4ddac85f959a5e5bfdd666c))
* **runner:** document and harden mitm matcher malformed inputs ([#16164](https://github.com/vm0-ai/vm0/issues/16164)) ([b839b76](https://github.com/vm0-ai/vm0/commit/b839b76fc640b668ec5051348b2b325dd562b618))

## [0.108.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.4...runner-rs-v0.108.5) (2026-06-04)


### Performance Improvements

* avoid cloning workspace image cache list entries ([#16177](https://github.com/vm0-ai/vm0/issues/16177)) ([0d190b6](https://github.com/vm0-ai/vm0/commit/0d190b693d21ab16b3d332388d52c1e824eea64e))

## [0.108.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.3...runner-rs-v0.108.4) (2026-06-04)


### Bug Fixes

* bound model websocket retention ([#16182](https://github.com/vm0-ai/vm0/issues/16182)) ([ff822d9](https://github.com/vm0-ai/vm0/commit/ff822d9c222b4b1b7439ef37e6e59753493993a1))
* share X billing IDNA normalization ([#16162](https://github.com/vm0-ai/vm0/issues/16162)) ([16d3d59](https://github.com/vm0-ai/vm0/commit/16d3d592a396f15a7430282941ba5b861b29df46))


### Refactoring

* make firewall auth ownership explicit ([#16161](https://github.com/vm0-ai/vm0/issues/16161)) ([9832ae3](https://github.com/vm0-ai/vm0/commit/9832ae33d48503dc3e705d4c1e33b240fc3b177e))

## [0.108.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.2...runner-rs-v0.108.3) (2026-06-04)


### Bug Fixes

* **runner:** restore codex sessions with rollout filenames ([#16144](https://github.com/vm0-ai/vm0/issues/16144)) ([1adf687](https://github.com/vm0-ai/vm0/commit/1adf687fcfcf39c06a11e3b995918f8c46e8f611))

## [0.108.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.1...runner-rs-v0.108.2) (2026-06-04)


### Bug Fixes

* **mitm-addon:** guard content length response size fallback ([#16104](https://github.com/vm0-ai/vm0/issues/16104)) ([95d44d6](https://github.com/vm0-ai/vm0/commit/95d44d6801868530954bc262497525e4421e370e))
* reject invalid registry vm entries before auth ([#16108](https://github.com/vm0-ai/vm0/issues/16108)) ([238ffc2](https://github.com/vm0-ai/vm0/commit/238ffc239283aaf1bdeac808bbbdfbe9abda3f67))


### Refactoring

* clarify idle pool lifecycle state ([#16135](https://github.com/vm0-ai/vm0/issues/16135)) ([a5e63e6](https://github.com/vm0-ai/vm0/commit/a5e63e6b5e19c6ac99f49549d42d2238dcab06d6))

## [0.108.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.108.0...runner-rs-v0.108.1) (2026-06-04)


### Bug Fixes

* **mitm-addon:** bound X includes usage categories ([#16100](https://github.com/vm0-ai/vm0/issues/16100)) ([a5dcb25](https://github.com/vm0-ai/vm0/commit/a5dcb25c2ce73842e928c7b241d1e35798bb9caa))
* tolerate invalid response content length ([#16088](https://github.com/vm0-ai/vm0/issues/16088)) ([6ab7225](https://github.com/vm0-ai/vm0/commit/6ab72256f2d2dee06d31423f0db2e81ab03377af))


### Documentation

* **mitm-addon:** document anthropic json usage extractor ([#16085](https://github.com/vm0-ai/vm0/issues/16085)) ([59cb7b4](https://github.com/vm0-ai/vm0/commit/59cb7b45f0a2ccf36b78a925e5df24de7fa39bc3))

## [0.108.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.10...runner-rs-v0.108.0) (2026-06-04)


### Features

* add workspace image cache inspection ([#15941](https://github.com/vm0-ai/vm0/issues/15941)) ([7cf129c](https://github.com/vm0-ai/vm0/commit/7cf129c0193c716f2a3d20eb9b12ea1d3937be4e))


### Bug Fixes

* materialize cached artifact mount roots ([#16083](https://github.com/vm0-ai/vm0/issues/16083)) ([d6a4ed3](https://github.com/vm0-ai/vm0/commit/d6a4ed307b5c4aeac8edb400aec1f65369d5f781))
* **mitm-addon:** avoid quadratic sse line scans ([#16082](https://github.com/vm0-ai/vm0/issues/16082)) ([1230752](https://github.com/vm0-ai/vm0/commit/1230752fddb62c60f26554bcdf0a47de1ae48e20))


### Refactoring

* clarify local queue job lookup ([#16074](https://github.com/vm0-ai/vm0/issues/16074)) ([2483cd4](https://github.com/vm0-ai/vm0/commit/2483cd44526cbe74363dd054f0bc121c89966558))

## [0.107.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.9...runner-rs-v0.107.10) (2026-06-04)


### Bug Fixes

* include byok model usage in rankings ([#15979](https://github.com/vm0-ai/vm0/issues/15979)) ([09e8919](https://github.com/vm0-ai/vm0/commit/09e8919abf68a3c5d2662ff061b7892a54d29c29))

## [0.107.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.8...runner-rs-v0.107.9) (2026-06-03)


### Bug Fixes

* cache workspace images only on destroy ([#15974](https://github.com/vm0-ai/vm0/issues/15974)) ([8423fd5](https://github.com/vm0-ai/vm0/commit/8423fd583bc96329b04da13b66be6975e932de91))
* guard malformed firewall metadata in usage paths ([#16038](https://github.com/vm0-ai/vm0/issues/16038)) ([65bcc9b](https://github.com/vm0-ai/vm0/commit/65bcc9b661fd2d42d4466c1006875e5526b9bf32))
* **mitm-addon:** require original url for connector usage ([#16023](https://github.com/vm0-ai/vm0/issues/16023)) ([e99e382](https://github.com/vm0-ai/vm0/commit/e99e3820d4d3b6fd9b0418e2036350fab538876d))


### Performance Improvements

* avoid X query parsing on billable responses ([#16028](https://github.com/vm0-ai/vm0/issues/16028)) ([52a166b](https://github.com/vm0-ai/vm0/commit/52a166bf511fcc80926152458040fa07fb3ecf3a))

## [0.107.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.7...runner-rs-v0.107.8) (2026-06-03)

## [0.107.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.6...runner-rs-v0.107.7) (2026-06-03)


### Bug Fixes

* count final x ndjson stream line ([#16000](https://github.com/vm0-ai/vm0/issues/16000)) ([71c9bab](https://github.com/vm0-ai/vm0/commit/71c9bab4c6654e0133363645204236ce375f681a))
* **mitm-addon:** sanitize proxy log url fields ([#16002](https://github.com/vm0-ai/vm0/issues/16002)) ([fb046d4](https://github.com/vm0-ai/vm0/commit/fb046d436ec69dfeae9f82107433c6cb18229237))

## [0.107.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.5...runner-rs-v0.107.6) (2026-06-03)


### Bug Fixes

* preserve missing auto memory artifact checkpoints ([#15964](https://github.com/vm0-ai/vm0/issues/15964)) ([020dc4a](https://github.com/vm0-ai/vm0/commit/020dc4a62cd90237639396419ccee1ba85d7d4d0))

## [0.107.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.4...runner-rs-v0.107.5) (2026-06-03)


### Bug Fixes

* **mitm-addon:** bound usage webhook delivery queue ([#15959](https://github.com/vm0-ai/vm0/issues/15959)) ([dc36c62](https://github.com/vm0-ai/vm0/commit/dc36c62f4ad4f22354f8ec21811c97993d11408d))

## [0.107.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.3...runner-rs-v0.107.4) (2026-06-03)

## [0.107.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.2...runner-rs-v0.107.3) (2026-06-03)


### Bug Fixes

* cap firewall auth response reads ([#15942](https://github.com/vm0-ai/vm0/issues/15942)) ([1177be1](https://github.com/vm0-ai/vm0/commit/1177be1f5ad0ebc858491c0ae41f9ef7a167040c))


### Refactoring

* split runner spawn job phases ([#15943](https://github.com/vm0-ai/vm0/issues/15943)) ([a7d5290](https://github.com/vm0-ai/vm0/commit/a7d52907feb13fc1c6adf1d7981568aaedd30021))

## [0.107.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.1...runner-rs-v0.107.2) (2026-06-02)


### Refactoring

* extract local queue protocol from provider ([#15913](https://github.com/vm0-ai/vm0/issues/15913)) ([abd8a3d](https://github.com/vm0-ai/vm0/commit/abd8a3da10ab5a473ff753046b2bc8b4f9acfc15))

## [0.107.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.107.0...runner-rs-v0.107.1) (2026-06-02)


### Bug Fixes

* block private auth.base rewrite destinations ([#15889](https://github.com/vm0-ai/vm0/issues/15889)) ([efc6115](https://github.com/vm0-ai/vm0/commit/efc6115bb1501df09b299f690f6d3ecf68387ff7))


### Refactoring

* split compiled firewall matcher tests ([#15885](https://github.com/vm0-ai/vm0/issues/15885)) ([bdf3939](https://github.com/vm0-ai/vm0/commit/bdf3939956c8a378dde9b11080a5be79feb55fcd))

## [0.107.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.7...runner-rs-v0.107.0) (2026-06-02)


### Features

* add session workspace image cache rollout ([#15780](https://github.com/vm0-ai/vm0/issues/15780)) ([3fb331b](https://github.com/vm0-ai/vm0/commit/3fb331ba6457c9d3247e0eac03f2629ab5102d89))


### Documentation

* **runner:** correct storage cache hash guidance ([#15887](https://github.com/vm0-ai/vm0/issues/15887)) ([57b4b5d](https://github.com/vm0-ai/vm0/commit/57b4b5da234afaca78aec909463bfb9d28dc8b1b))

## [0.106.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.6...runner-rs-v0.106.7) (2026-06-02)


### Bug Fixes

* handle concatenated zlib stream members ([#15873](https://github.com/vm0-ai/vm0/issues/15873)) ([1d40f14](https://github.com/vm0-ai/vm0/commit/1d40f14f8bb1f10b1305ce1f3e418352cc0a671b))

## [0.106.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.5...runner-rs-v0.106.6) (2026-06-02)


### Bug Fixes

* require https for auth base rewrites ([#15858](https://github.com/vm0-ai/vm0/issues/15858)) ([22d5d41](https://github.com/vm0-ai/vm0/commit/22d5d41b26b19da9f723974a6837822df06a0fe0))

## [0.106.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.4...runner-rs-v0.106.5) (2026-06-02)


### Bug Fixes

* add guest-agent abnormal exit diagnostics ([#15829](https://github.com/vm0-ai/vm0/issues/15829)) ([6803f8f](https://github.com/vm0-ai/vm0/commit/6803f8ff73c6d845ea96a80442fb4e08f5562a5a))


### Documentation

* clarify browser ua passthrough semantics ([#15848](https://github.com/vm0-ai/vm0/issues/15848)) ([c0c6fa1](https://github.com/vm0-ai/vm0/commit/c0c6fa1b7ff581e7c9f55fd1bd6cdf5fd2232e1a))


### Refactoring

* consolidate compiled path traversal ([#15845](https://github.com/vm0-ai/vm0/issues/15845)) ([5604e93](https://github.com/vm0-ai/vm0/commit/5604e93addf767b1f475d8b921f6903ae55898e6))
* **mitm-addon:** name firewall matcher decision state ([#15847](https://github.com/vm0-ai/vm0/issues/15847)) ([b8c8982](https://github.com/vm0-ai/vm0/commit/b8c8982680725267f640a539773d4fdd6051d2e8))

## [0.106.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.3...runner-rs-v0.106.4) (2026-06-02)


### Bug Fixes

* bound streaming usage decompression output ([#15831](https://github.com/vm0-ai/vm0/issues/15831)) ([25128d0](https://github.com/vm0-ai/vm0/commit/25128d05e9407c782ffe727f30d0dd97f1586aa1))

## [0.106.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.2...runner-rs-v0.106.3) (2026-06-02)


### Refactoring

* **runner:** centralize pre-claim admission rollback ([#15821](https://github.com/vm0-ai/vm0/issues/15821)) ([8a6936f](https://github.com/vm0-ai/vm0/commit/8a6936f7207a7d55d5263332ca2ac3af610ec020))

## [0.106.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.1...runner-rs-v0.106.2) (2026-06-02)

## [0.106.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.106.0...runner-rs-v0.106.1) (2026-06-02)


### Bug Fixes

* **runner:** preserve streamed system logs separately ([#15797](https://github.com/vm0-ai/vm0/issues/15797)) ([dd3ce60](https://github.com/vm0-ai/vm0/commit/dd3ce6077557911e505825954858e2b48ed31567))

## [0.106.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.15...runner-rs-v0.106.0) (2026-06-01)


### Features

* add canonical workspace drive foundation ([#15688](https://github.com/vm0-ai/vm0/issues/15688)) ([593460a](https://github.com/vm0-ai/vm0/commit/593460ab818768ae75d1fd658a7211a2120a956b))


### Bug Fixes

* block encoded backslash firewall paths ([#15738](https://github.com/vm0-ai/vm0/issues/15738)) ([957e298](https://github.com/vm0-ai/vm0/commit/957e29807717b6e40215e3f1aab191ca67a3b42a))
* classify x dm deep links as with-url posts ([#15757](https://github.com/vm0-ai/vm0/issues/15757)) ([d5f85f1](https://github.com/vm0-ai/vm0/commit/d5f85f1e03944f4e3a139d3f10ae3441d9cb5aea))
* **mitm-addon:** bill x counts from total tweet count ([#15756](https://github.com/vm0-ai/vm0/issues/15756)) ([ae3b32d](https://github.com/vm0-ai/vm0/commit/ae3b32dbcdad2afa23f701c1c7965b6e9afec308))
* **mitm-addon:** bound request capture decoding ([#15729](https://github.com/vm0-ai/vm0/issues/15729)) ([13392a0](https://github.com/vm0-ai/vm0/commit/13392a0858b0208a5081d5560afe2b0858137eb9))
* **mitm-addon:** bound x billing request body decoding ([#15731](https://github.com/vm0-ai/vm0/issues/15731)) ([ac1b5b9](https://github.com/vm0-ai/vm0/commit/ac1b5b9581318ba4b4ab411af726fba3991d981b))
* **mitm-addon:** keep websocket usage flows tracked ([#15722](https://github.com/vm0-ai/vm0/issues/15722)) ([9605293](https://github.com/vm0-ai/vm0/commit/9605293c0e0f32961ec40a42ed916039a4777c10))
* **mitm-addon:** stop logging webhook payload bodies ([#15717](https://github.com/vm0-ai/vm0/issues/15717)) ([75b73a6](https://github.com/vm0-ai/vm0/commit/75b73a617f07c8c905c34dc0cd689127b3061c2d))
* **runner:** skip unclaimed jobs during soft drain ([#15745](https://github.com/vm0-ai/vm0/issues/15745)) ([b12aea2](https://github.com/vm0-ai/vm0/commit/b12aea21c7ca019089c03609ae44236552023dc1))
* sanitize captured network log headers ([#15758](https://github.com/vm0-ai/vm0/issues/15758)) ([da717a5](https://github.com/vm0-ai/vm0/commit/da717a582e20826834fd9169cf2fcd627c6cb4a0))


### Documentation

* document mitm usage flush lifecycle ([#15744](https://github.com/vm0-ai/vm0/issues/15744)) ([f0fdc84](https://github.com/vm0-ai/vm0/commit/f0fdc842bcc8673578f2bbc4b98c64b765b6efbc))
* **mitm-addon:** document event-less sse capture ([#15733](https://github.com/vm0-ai/vm0/issues/15733)) ([8e56540](https://github.com/vm0-ai/vm0/commit/8e56540281db516a2e170d1eec44d00564235ff9))


### Refactoring

* **mitm-addon:** centralize x body refinement buckets ([#15706](https://github.com/vm0-ai/vm0/issues/15706)) ([44a45b7](https://github.com/vm0-ai/vm0/commit/44a45b7a1dbc2c6bfdf3594b5d0a9873afdd286e))
* **mitm-addon:** unify firewall auth cache payload shape ([#15725](https://github.com/vm0-ai/vm0/issues/15725)) ([0d40dc4](https://github.com/vm0-ai/vm0/commit/0d40dc44230517678cd4308e0d2f0a95c4e63a01))

## [0.105.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.14...runner-rs-v0.105.15) (2026-06-01)


### Bug Fixes

* **mitm-addon:** require keyword auth options ([#15694](https://github.com/vm0-ai/vm0/issues/15694)) ([d97034d](https://github.com/vm0-ai/vm0/commit/d97034d35bc870c84cc22815dc87bde27ec6b88e))
* **mitm-addon:** scope registry cache state by path ([#15683](https://github.com/vm0-ai/vm0/issues/15683)) ([157164b](https://github.com/vm0-ai/vm0/commit/157164b7c65e68d7de28fa368c3d03bfc277f8c6))
* **mitm-addon:** validate firewall auth success responses ([#15695](https://github.com/vm0-ai/vm0/issues/15695)) ([0584be6](https://github.com/vm0-ai/vm0/commit/0584be6eb1f7b21efef75005c5341a76819b85fb))

## [0.105.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.13...runner-rs-v0.105.14) (2026-06-01)


### Bug Fixes

* **mitm-addon:** validate platform api urls ([#15630](https://github.com/vm0-ai/vm0/issues/15630)) ([5161d39](https://github.com/vm0-ai/vm0/commit/5161d399a919e2071149e6d05b7314716367c1e5))


### Refactoring

* deduplicate mitm matcher segments ([#15622](https://github.com/vm0-ai/vm0/issues/15622)) ([5d78a1b](https://github.com/vm0-ai/vm0/commit/5d78a1b941f704ebced670640ceeb3943a51ffc6))
* hardcode runner working directory ([#15606](https://github.com/vm0-ai/vm0/issues/15606)) ([132296d](https://github.com/vm0-ai/vm0/commit/132296da082953e4cdeb796c8a4432e07cd38c20))
* retire legacy firewall matcher ([#15291](https://github.com/vm0-ai/vm0/issues/15291)) ([a288950](https://github.com/vm0-ai/vm0/commit/a2889506f42f55331238d928a64e0c85b69e9ff0))

## [0.105.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.12...runner-rs-v0.105.13) (2026-06-01)


### Bug Fixes

* skip firewall auth mutation for browser requests ([#15593](https://github.com/vm0-ai/vm0/issues/15593)) ([529f593](https://github.com/vm0-ai/vm0/commit/529f5934d40adb5ebb2b591504f2237dd8320594))


### Performance Improvements

* skip no-op json observation clears ([#15584](https://github.com/vm0-ai/vm0/issues/15584)) ([79578d2](https://github.com/vm0-ai/vm0/commit/79578d25d32391b0c92f62abf23365666e024d08))

## [0.105.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.11...runner-rs-v0.105.12) (2026-05-31)


### Refactoring

* clarify x parser internals ([#15580](https://github.com/vm0-ai/vm0/issues/15580)) ([8514cef](https://github.com/vm0-ai/vm0/commit/8514cef79680410406c207ced7ec83fe8aac536e))


### Performance Improvements

* **mitm-addon:** avoid json loads for string decoding ([#15581](https://github.com/vm0-ai/vm0/issues/15581)) ([f69794a](https://github.com/vm0-ai/vm0/commit/f69794a6dbaf857103fdea5aaf47b55f56cc3faa))

## [0.105.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.10...runner-rs-v0.105.11) (2026-05-31)


### Bug Fixes

* **mitm-addon:** distinguish log failure diagnostics ([#15572](https://github.com/vm0-ai/vm0/issues/15572)) ([75bbdf0](https://github.com/vm0-ai/vm0/commit/75bbdf0f5fe5292af4c68aa1c9eada089fb9725b))
* **mitm-addon:** normalize firewall metadata logs ([#15566](https://github.com/vm0-ai/vm0/issues/15566)) ([df40acb](https://github.com/vm0-ai/vm0/commit/df40acba0a49f2d8db42ca343810536671b12577))


### Refactoring

* deduplicate x response field extraction ([#15573](https://github.com/vm0-ai/vm0/issues/15573)) ([3bcedac](https://github.com/vm0-ai/vm0/commit/3bcedacee5f18292d9cf3feb3f5f0920c55fb18a))

## [0.105.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.9...runner-rs-v0.105.10) (2026-05-31)


### Bug Fixes

* block unsafe firewall dot-segment paths ([#15550](https://github.com/vm0-ai/vm0/issues/15550)) ([d19c076](https://github.com/vm0-ai/vm0/commit/d19c076ef187e86a067492d15c09fb54957be572))
* redact query strings from mitm logs ([#15549](https://github.com/vm0-ai/vm0/issues/15549)) ([22a5a69](https://github.com/vm0-ai/vm0/commit/22a5a69aca62082b10b705e61c34336db5e8c1f4))
* skip non-billable connector response parsers ([#15543](https://github.com/vm0-ai/vm0/issues/15543)) ([daa2732](https://github.com/vm0-ai/vm0/commit/daa2732c913bccf630e1a80ec2eaa5212fedc076))


### Refactoring

* **mitm-addon:** store HTTP timing on flows ([#15547](https://github.com/vm0-ai/vm0/issues/15547)) ([3bf5cb0](https://github.com/vm0-ai/vm0/commit/3bf5cb00a42f959b454ef9724fac6d31f3a6794c))

## [0.105.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.8...runner-rs-v0.105.9) (2026-05-31)


### Bug Fixes

* add firewall auth failure reason ([#15386](https://github.com/vm0-ai/vm0/issues/15386)) ([6c7e09c](https://github.com/vm0-ai/vm0/commit/6c7e09c76e9a184478fddbcb1a9ceefdc94bb3f2))

## [0.105.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.7...runner-rs-v0.105.8) (2026-05-30)


### Documentation

* document connector response parser lifecycle ([#15444](https://github.com/vm0-ai/vm0/issues/15444)) ([49a9cfe](https://github.com/vm0-ai/vm0/commit/49a9cfe723bbf54ece885c0dbaa7d3ca24a2b337))

## [0.105.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.6...runner-rs-v0.105.7) (2026-05-29)


### Bug Fixes

* clarify mitm body capture invariant error ([#15429](https://github.com/vm0-ai/vm0/issues/15429)) ([c563be6](https://github.com/vm0-ai/vm0/commit/c563be6669217266490bbf1008a89ba6b3364fe0))


### Documentation

* document mitm registry cache fallback ([#15428](https://github.com/vm0-ai/vm0/issues/15428)) ([04c23a9](https://github.com/vm0-ai/vm0/commit/04c23a9c6cfa02f5d379eaebc4c62e0e6588d2bf))


### Refactoring

* move connector response parser dispatch ([#15431](https://github.com/vm0-ai/vm0/issues/15431)) ([f0411d6](https://github.com/vm0-ai/vm0/commit/f0411d65034678e8acc6e8db22d16dba1d1df55f))

## [0.105.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.5...runner-rs-v0.105.6) (2026-05-29)


### Refactoring

* resolve connector access from selected auth method ([#15355](https://github.com/vm0-ai/vm0/issues/15355)) ([1c24b75](https://github.com/vm0-ai/vm0/commit/1c24b7553c4f86cbd70082ed454efb4853ac7cb2))

## [0.105.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.4...runner-rs-v0.105.5) (2026-05-29)

## [0.105.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.3...runner-rs-v0.105.4) (2026-05-29)


### Documentation

* document mitm pending helper counts ([#15349](https://github.com/vm0-ai/vm0/issues/15349)) ([b63c75f](https://github.com/vm0-ai/vm0/commit/b63c75fa8272523fa62db7702d581730c2ee5beb))


### Refactoring

* group runner start state by lifecycle ([#15362](https://github.com/vm0-ai/vm0/issues/15362)) ([b327825](https://github.com/vm0-ai/vm0/commit/b3278258f35bc74115bde10a249280bfbdd2ba03))
* **runner:** centralize per-run log patterns ([#15363](https://github.com/vm0-ai/vm0/issues/15363)) ([609f08a](https://github.com/vm0-ai/vm0/commit/609f08a487b2807f9aa5b2a4643debb67d973ac5))


### Performance Improvements

* **mitm-addon:** transfer usage webhook payload ownership ([#15351](https://github.com/vm0-ai/vm0/issues/15351)) ([d5738ee](https://github.com/vm0-ai/vm0/commit/d5738ee93df402482287171dda7377276cfb5714))

## [0.105.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.2...runner-rs-v0.105.3) (2026-05-28)

## [0.105.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.1...runner-rs-v0.105.2) (2026-05-28)

## [0.105.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.105.0...runner-rs-v0.105.1) (2026-05-28)


### Refactoring

* make runner http client config explicit ([#15299](https://github.com/vm0-ai/vm0/issues/15299)) ([28c9d4f](https://github.com/vm0-ai/vm0/commit/28c9d4f7a3ee8be6e23291ec8d4abc28545b4036))

## [0.105.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.17...runner-rs-v0.105.0) (2026-05-28)


### Features

* add generation-aware runner session affinity ([#15246](https://github.com/vm0-ai/vm0/issues/15246)) ([141473b](https://github.com/vm0-ai/vm0/commit/141473b3e36af6392d0fd8fc6734ee223e6729e4))


### Bug Fixes

* log malformed data-only anthropic sse events ([#15287](https://github.com/vm0-ai/vm0/issues/15287)) ([3960fd4](https://github.com/vm0-ai/vm0/commit/3960fd4495636b06c503e41d947b2fa3843beea0))


### Refactoring

* remove orphan active run count duplication ([#15259](https://github.com/vm0-ai/vm0/issues/15259)) ([4908240](https://github.com/vm0-ai/vm0/commit/4908240c5edb406b90c69305d3229942f2f73ee7))

## [0.104.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.16...runner-rs-v0.104.17) (2026-05-28)


### Bug Fixes

* prefer specific firewall path matches ([#15223](https://github.com/vm0-ai/vm0/issues/15223)) ([24c6d2e](https://github.com/vm0-ai/vm0/commit/24c6d2ed4ddcfab5f6bfd4e41329d672e45699d7))

## [0.104.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.15...runner-rs-v0.104.16) (2026-05-28)

## [0.104.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.14...runner-rs-v0.104.15) (2026-05-27)


### Refactoring

* centralize mitm flow metadata keys ([#15171](https://github.com/vm0-ai/vm0/issues/15171)) ([b378ac8](https://github.com/vm0-ai/vm0/commit/b378ac800ecd70a09fc7d8d27cd2b0c1fee1cc6f))
* unify mitm network log target handling ([#15174](https://github.com/vm0-ai/vm0/issues/15174)) ([2316d5d](https://github.com/vm0-ai/vm0/commit/2316d5ddbb4ec46e8fbd07df85e3b472266c416e))

## [0.104.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.13...runner-rs-v0.104.14) (2026-05-27)

## [0.104.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.12...runner-rs-v0.104.13) (2026-05-27)

## [0.104.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.11...runner-rs-v0.104.12) (2026-05-27)


### Bug Fixes

* validate claude tool list entries ([#15092](https://github.com/vm0-ai/vm0/issues/15092)) ([7f48d58](https://github.com/vm0-ai/vm0/commit/7f48d5836cd891200f3b0a4159aad9d0ad59726f))

## [0.104.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.10...runner-rs-v0.104.11) (2026-05-27)


### Bug Fixes

* classify invalid billable auth expiry ([#15088](https://github.com/vm0-ai/vm0/issues/15088)) ([f08b100](https://github.com/vm0-ai/vm0/commit/f08b100859047b8cb5670fd97e12924fd9c42302))
* harden runner claim lifecycle ([#15091](https://github.com/vm0-ai/vm0/issues/15091)) ([6de4d34](https://github.com/vm0-ai/vm0/commit/6de4d340fd951702c7e4dc2b8149f61c66ad27a6))

## [0.104.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.9...runner-rs-v0.104.10) (2026-05-27)


### Bug Fixes

* **mitm-addon:** bound auth base forwarded responses ([#15074](https://github.com/vm0-ai/vm0/issues/15074)) ([a97163e](https://github.com/vm0-ai/vm0/commit/a97163e40262d65820a2183f86fd0aa0e8a5b8ae))

## [0.104.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.8...runner-rs-v0.104.9) (2026-05-27)


### Documentation

* **mitm-addon:** explain usage zero-clobber guard ([#15067](https://github.com/vm0-ai/vm0/issues/15067)) ([6acacff](https://github.com/vm0-ai/vm0/commit/6acacff24db92eea0a2d356e69bca7f8f54bc78f))


### Refactoring

* remove sse usage parser wrapper ([#15056](https://github.com/vm0-ai/vm0/issues/15056)) ([b1fde4a](https://github.com/vm0-ai/vm0/commit/b1fde4ad5bb942576ef71061ccc9df542368dc36))
* split mitm request handler tests ([#15068](https://github.com/vm0-ai/vm0/issues/15068)) ([f428c91](https://github.com/vm0-ai/vm0/commit/f428c910a6d918c3fbc2c8914291ccb22fcbe4bb))

## [0.104.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.7...runner-rs-v0.104.8) (2026-05-27)


### Documentation

* **mitm-addon:** document model provider usage gates ([#15054](https://github.com/vm0-ai/vm0/issues/15054)) ([aebc623](https://github.com/vm0-ai/vm0/commit/aebc62312ce714c5923515697e63af66ceb57c89))

## [0.104.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.6...runner-rs-v0.104.7) (2026-05-26)


### Bug Fixes

* validate model provider env placeholders in runner ([#15002](https://github.com/vm0-ai/vm0/issues/15002)) ([44177d8](https://github.com/vm0-ai/vm0/commit/44177d8d154bfa727ee9500a9dc1d221ff21da29))

## [0.104.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.5...runner-rs-v0.104.6) (2026-05-26)


### Refactoring

* **runner:** model local submit queue entry ([#14988](https://github.com/vm0-ai/vm0/issues/14988)) ([37b90e6](https://github.com/vm0-ai/vm0/commit/37b90e60b63352cb3a13ca7dedc5ec2a841c928a))

## [0.104.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.4...runner-rs-v0.104.5) (2026-05-26)


### Refactoring

* **mitm-addon:** centralize usage idempotency helpers ([#14968](https://github.com/vm0-ai/vm0/issues/14968)) ([f804857](https://github.com/vm0-ai/vm0/commit/f80485717a148d6ee3bd462d2f02013f9d832cb0))

## [0.104.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.3...runner-rs-v0.104.4) (2026-05-26)


### Documentation

* **mitm-addon:** document usage buffer contract ([#14956](https://github.com/vm0-ai/vm0/issues/14956)) ([c4b3a27](https://github.com/vm0-ai/vm0/commit/c4b3a27a3bcd23119be444cf0c20020e9d150bbf))

## [0.104.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.2...runner-rs-v0.104.3) (2026-05-26)


### Refactoring

* **runner:** deduplicate completion retry call ([#14946](https://github.com/vm0-ai/vm0/issues/14946)) ([cdb3989](https://github.com/vm0-ai/vm0/commit/cdb398987be187a306161acdf39868ff96dd658a))
* **runner:** split local submit flow ([#14940](https://github.com/vm0-ai/vm0/issues/14940)) ([9d973ba](https://github.com/vm0-ai/vm0/commit/9d973baa76c8a03545a8eb86ddf883846e773b5e))

## [0.104.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.1...runner-rs-v0.104.2) (2026-05-26)


### Bug Fixes

* improve usage buffer flush shutdown ([#14918](https://github.com/vm0-ai/vm0/issues/14918)) ([5bed24f](https://github.com/vm0-ai/vm0/commit/5bed24f62322eeb37282b97478d2e16cf0062f91))

## [0.104.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.104.0...runner-rs-v0.104.1) (2026-05-26)


### Performance Improvements

* **runner:** snapshot usage pending on flush request ([#14896](https://github.com/vm0-ai/vm0/issues/14896)) ([13044ce](https://github.com/vm0-ai/vm0/commit/13044ced03ccf4819932f09092d3efaa86387b25))

## [0.104.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.22...runner-rs-v0.104.0) (2026-05-25)


### Features

* buffer usage-event webhook uploads ([#14855](https://github.com/vm0-ai/vm0/issues/14855)) ([4fa3981](https://github.com/vm0-ai/vm0/commit/4fa3981fd4e138f4ff321cb414181569c36d43cc))


### Bug Fixes

* move guest exec exit warnings to callers ([#14889](https://github.com/vm0-ai/vm0/issues/14889)) ([c58dc82](https://github.com/vm0-ai/vm0/commit/c58dc827e11a9a5d6dc70c8e2d07a588983da9d7))

## [0.103.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.21...runner-rs-v0.103.22) (2026-05-25)

## [0.103.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.20...runner-rs-v0.103.21) (2026-05-25)

## [0.103.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.19...runner-rs-v0.103.20) (2026-05-25)

## [0.103.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.18...runner-rs-v0.103.19) (2026-05-25)

## [0.103.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.17...runner-rs-v0.103.18) (2026-05-25)


### Refactoring

* **mitm-addon:** centralize authority validation error context ([#14751](https://github.com/vm0-ai/vm0/issues/14751)) ([63e8d3c](https://github.com/vm0-ai/vm0/commit/63e8d3c0636eb6bc5d156f838d2276f9c2d1a727))
* share executor sandbox run finalization ([#14787](https://github.com/vm0-ai/vm0/issues/14787)) ([f63d971](https://github.com/vm0-ai/vm0/commit/f63d971ff6957de3db3e7695f6e51036b5d4c6a0))

## [0.103.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.16...runner-rs-v0.103.17) (2026-05-25)


### Bug Fixes

* **mitm-addon:** use streamed byte count for response size ([#14752](https://github.com/vm0-ai/vm0/issues/14752)) ([5e02546](https://github.com/vm0-ai/vm0/commit/5e025467b59de2e6ef4f2ff7b07e31f3cdea4e13))


### Refactoring

* **mitm-addon:** structure firewall allow results ([#14772](https://github.com/vm0-ai/vm0/issues/14772)) ([4edcabc](https://github.com/vm0-ai/vm0/commit/4edcabc3d6d124ef627143ea8a767cf444a4f825))

## [0.103.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.15...runner-rs-v0.103.16) (2026-05-24)

## [0.103.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.14...runner-rs-v0.103.15) (2026-05-24)


### Bug Fixes

* guard mitm addon firewall auth error envelope ([#14657](https://github.com/vm0-ai/vm0/issues/14657)) ([df6964e](https://github.com/vm0-ai/vm0/commit/df6964e5fe99c68d69c7d5f8615693b7ee936dbe))

## [0.103.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.13...runner-rs-v0.103.14) (2026-05-24)


### Bug Fixes

* **mitm-addon:** filter empty x fallback id segments ([#14658](https://github.com/vm0-ai/vm0/issues/14658)) ([db9cbee](https://github.com/vm0-ai/vm0/commit/db9cbee1fb8e97b4e6a587291564aeeb33acf3ff))

## [0.103.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.12...runner-rs-v0.103.13) (2026-05-24)


### Bug Fixes

* **mitm-addon:** capture terminal OpenAI Responses usage ([#14598](https://github.com/vm0-ai/vm0/issues/14598)) ([d1939ea](https://github.com/vm0-ai/vm0/commit/d1939ea546adc4bb2ee6d98c01adec5925f93cce))

## [0.103.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.11...runner-rs-v0.103.12) (2026-05-24)

## [0.103.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.10...runner-rs-v0.103.11) (2026-05-23)


### Refactoring

* **mitm-addon:** extract auth base forwarder test helper ([#14603](https://github.com/vm0-ai/vm0/issues/14603)) ([337d456](https://github.com/vm0-ai/vm0/commit/337d4566d366bc05e0a5bcf46b45f1b8698b7f57))
* **mitm-addon:** split handler tests by subsystem ([#14597](https://github.com/vm0-ai/vm0/issues/14597)) ([ae64e4c](https://github.com/vm0-ai/vm0/commit/ae64e4c4aae2ce5001aa398503fb797c74f13c0c))

## [0.103.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.9...runner-rs-v0.103.10) (2026-05-23)

## [0.103.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.8...runner-rs-v0.103.9) (2026-05-23)


### Bug Fixes

* **mitm-addon:** preserve auth base request headers ([#14508](https://github.com/vm0-ai/vm0/issues/14508)) ([c251138](https://github.com/vm0-ai/vm0/commit/c2511386377c75d252bbb6cf62bb3968433fad22))
* preserve openai websocket usage across frames ([#14554](https://github.com/vm0-ai/vm0/issues/14554)) ([784465b](https://github.com/vm0-ai/vm0/commit/784465b75fce7c37e541d8b05cdcb79cb05f84b4))


### Refactoring

* **mitm-addon:** consolidate firewall failure responses ([#14563](https://github.com/vm0-ai/vm0/issues/14563)) ([4eabba6](https://github.com/vm0-ai/vm0/commit/4eabba60e61fe7ed3b19f4bdd256a517a4aa08fe))
* **mitm-addon:** simplify response parser state ([#14559](https://github.com/vm0-ai/vm0/issues/14559)) ([9b70539](https://github.com/vm0-ai/vm0/commit/9b70539d8f503ade2919ba79b86124a53147148c))

## [0.103.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.7...runner-rs-v0.103.8) (2026-05-22)


### Bug Fixes

* cancel guest process before runner cleanup ([#14537](https://github.com/vm0-ai/vm0/issues/14537)) ([55b3ab7](https://github.com/vm0-ai/vm0/commit/55b3ab78eb113e7665c6d097f5e2fdbef8b30193))
* **mitm-addon:** prevent rewrite query shadowing ([#14544](https://github.com/vm0-ai/vm0/issues/14544)) ([fb1cae4](https://github.com/vm0-ai/vm0/commit/fb1cae4c9a77e7df38cd7759ee7a8d9e59aaad53))


### Documentation

* **mitm-addon:** fix firewall fixture reference ([#14549](https://github.com/vm0-ai/vm0/issues/14549)) ([9edd0cd](https://github.com/vm0-ai/vm0/commit/9edd0cd55918a172f05fa88ee3c9bf985e6ddf13))


### Refactoring

* make runner completion auth lifecycle explicit ([#14522](https://github.com/vm0-ai/vm0/issues/14522)) ([cd2a0dd](https://github.com/vm0-ai/vm0/commit/cd2a0dd0608ceb21f0ad3c2df7f269bbb23040ee))

## [0.103.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.6...runner-rs-v0.103.7) (2026-05-22)


### Bug Fixes

* **mitm-addon:** emit utc log timestamps ([#14498](https://github.com/vm0-ai/vm0/issues/14498)) ([b2ba913](https://github.com/vm0-ai/vm0/commit/b2ba9136ebf2568332d6d8493992e094abfb76a5))
* **mitm-addon:** preserve rewritten response headers ([#14491](https://github.com/vm0-ai/vm0/issues/14491)) ([b724e48](https://github.com/vm0-ai/vm0/commit/b724e48961b94c3fa3d29a1888e46d8f355bb44f))


### Refactoring

* rename mitm usage counter helpers ([#14493](https://github.com/vm0-ai/vm0/issues/14493)) ([ba45a51](https://github.com/vm0-ai/vm0/commit/ba45a51b8310ed65d144d95e9bd771c801f66c19))

## [0.103.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.5...runner-rs-v0.103.6) (2026-05-21)

## [0.103.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.4...runner-rs-v0.103.5) (2026-05-21)

## [0.103.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.3...runner-rs-v0.103.4) (2026-05-21)


### Bug Fixes

* **mitm-addon:** filter malformed registry vm entries ([#14434](https://github.com/vm0-ai/vm0/issues/14434)) ([1123ceb](https://github.com/vm0-ai/vm0/commit/1123cebe80005c0435f24a6ff219ce0017aadd8d))
* **mitm-addon:** reject spoofed host authority ([#14432](https://github.com/vm0-ai/vm0/issues/14432)) ([1ec6e5c](https://github.com/vm0-ai/vm0/commit/1ec6e5c894b757d29a4a044a87207ae69fd178c1))
* **mitm-addon:** skip empty decoded request body capture ([#14421](https://github.com/vm0-ai/vm0/issues/14421)) ([fa3faf6](https://github.com/vm0-ai/vm0/commit/fa3faf67034fe0248de77d505db77da9213faf81))
* reject json trailing commas in mitm parser ([#14411](https://github.com/vm0-ai/vm0/issues/14411)) ([c863b19](https://github.com/vm0-ai/vm0/commit/c863b1976cf4a61a5242d84c2126434cb8474661))


### Documentation

* **mitm-addon:** document openai responses usage entry points ([#14417](https://github.com/vm0-ai/vm0/issues/14417)) ([d95d180](https://github.com/vm0-ai/vm0/commit/d95d18027a6a3cd86fbef78f105bbabe1f768c41))


### Refactoring

* centralize runner log filename patterns ([#14400](https://github.com/vm0-ai/vm0/issues/14400)) ([b24ebce](https://github.com/vm0-ai/vm0/commit/b24ebce2edeb1a978c1a840d6a6a3a00db4ff6ce))


### Performance Improvements

* **mitm-addon:** adapt brotli decompression chunk size ([#14418](https://github.com/vm0-ai/vm0/issues/14418)) ([ba9151e](https://github.com/vm0-ai/vm0/commit/ba9151ee894e617ab312047de12cae7a944cf12c))

## [0.103.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.2...runner-rs-v0.103.3) (2026-05-21)


### Bug Fixes

* avoid stale firewall auth cache writes ([#14336](https://github.com/vm0-ai/vm0/issues/14336)) ([f69c8ce](https://github.com/vm0-ai/vm0/commit/f69c8ceef246ff11747129cff1100a67aebc34e3))
* **mitm-addon:** expose firewall block reasons ([#14379](https://github.com/vm0-ai/vm0/issues/14379)) ([21eb63c](https://github.com/vm0-ai/vm0/commit/21eb63ceded10532642a9ba23c4a3b263439b6bc))
* **mitm-addon:** harden logging writes ([#14388](https://github.com/vm0-ai/vm0/issues/14388)) ([a0958d5](https://github.com/vm0-ai/vm0/commit/a0958d57a43c5564c7bcb368942547c2804a2f67))
* prevent webhook log payload collisions ([#14378](https://github.com/vm0-ai/vm0/issues/14378)) ([6a84ac8](https://github.com/vm0-ai/vm0/commit/6a84ac8f800dc371b800af4b4db59f270a37bc8f))
* show runner stdout stream loss in system log ([#14384](https://github.com/vm0-ai/vm0/issues/14384)) ([bf52cbc](https://github.com/vm0-ai/vm0/commit/bf52cbc10bd7de14a09d32d099b53df64d03fc28))


### Refactoring

* **mitm-addon:** split openai response input tokens directly ([#14376](https://github.com/vm0-ai/vm0/issues/14376)) ([9243f08](https://github.com/vm0-ai/vm0/commit/9243f08abb17f4288a16bae260e75b9cf2ace203)), closes [#14367](https://github.com/vm0-ai/vm0/issues/14367)

## [0.103.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.1...runner-rs-v0.103.2) (2026-05-20)


### Documentation

* document json selective extractor contract ([#14311](https://github.com/vm0-ai/vm0/issues/14311)) ([89c8588](https://github.com/vm0-ai/vm0/commit/89c8588f23be33263c606e4c0b11fb45a43a4d80))


### Refactoring

* consolidate mitm auth state ([#14303](https://github.com/vm0-ai/vm0/issues/14303)) ([35a122a](https://github.com/vm0-ai/vm0/commit/35a122ab580b09a524b2c9586bfaa682db0be287))
* deduplicate storage cache entry handling ([#14261](https://github.com/vm0-ai/vm0/issues/14261)) ([86ceff4](https://github.com/vm0-ai/vm0/commit/86ceff473517c20f5b8dd509eabec1b4f546da78))
* migrate sandbox runner processes to supervised exec ([#14231](https://github.com/vm0-ai/vm0/issues/14231)) ([7781715](https://github.com/vm0-ai/vm0/commit/77817154bd0b4aad08d58fc6f41dc2643f07c76c))
* unify guest binary chmod finalization ([#14269](https://github.com/vm0-ai/vm0/issues/14269)) ([c86c879](https://github.com/vm0-ai/vm0/commit/c86c879111835f6f7a9fbe432a678ff95c78e44a))
* use template cache policy for remote resolution ([#14267](https://github.com/vm0-ai/vm0/issues/14267)) ([6142bb5](https://github.com/vm0-ai/vm0/commit/6142bb53f1f7eab538af77fe9150029e315bc9cb))


### Performance Improvements

* **mitm-addon:** compile firewall matcher artifacts ([#14305](https://github.com/vm0-ai/vm0/issues/14305)) ([0e53812](https://github.com/vm0-ai/vm0/commit/0e53812a9ec6acd180e6e798e1fb9135e7d86b4f))

## [0.103.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.103.0...runner-rs-v0.103.1) (2026-05-20)


### Bug Fixes

* preserve Claude failure diagnostics ([#14174](https://github.com/vm0-ai/vm0/issues/14174)) ([7cd9971](https://github.com/vm0-ai/vm0/commit/7cd99711b6ded65520acbfbe74f12d90a0f391c6))

## [0.103.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.5...runner-rs-v0.103.0) (2026-05-20)


### Features

* **runner:** add firecracker io limiters ([#13585](https://github.com/vm0-ai/vm0/issues/13585)) ([653b854](https://github.com/vm0-ai/vm0/commit/653b854613580861d503848a3eeffff98fe75095))


### Bug Fixes

* install pnpm in sandbox image ([#14099](https://github.com/vm0-ai/vm0/issues/14099)) ([75ac682](https://github.com/vm0-ai/vm0/commit/75ac68262f75cbfbae57a1a107cd346f429d45d9))

## [0.102.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.4...runner-rs-v0.102.5) (2026-05-19)

## [0.102.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.3...runner-rs-v0.102.4) (2026-05-19)


### Bug Fixes

* enforce api start time milliseconds ([#13963](https://github.com/vm0-ai/vm0/issues/13963)) ([847d7a2](https://github.com/vm0-ai/vm0/commit/847d7a2054778457d0c65da5e75439b71b78d965))
* reject malformed firecracker netns names ([#13964](https://github.com/vm0-ai/vm0/issues/13964)) ([637aa3f](https://github.com/vm0-ai/vm0/commit/637aa3ff0b2f6e059d26445c6a6eec4e3858d695))

## [0.102.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.2...runner-rs-v0.102.3) (2026-05-19)

## [0.102.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.1...runner-rs-v0.102.2) (2026-05-19)


### Bug Fixes

* add runner failure diagnostics ([#13880](https://github.com/vm0-ai/vm0/issues/13880)) ([3fc6515](https://github.com/vm0-ai/vm0/commit/3fc6515e53564de4668ae551ce4caaebcb943d74))

## [0.102.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.102.0...runner-rs-v0.102.1) (2026-05-18)


### Bug Fixes

* manage runner memory prefetch lifecycle ([#13719](https://github.com/vm0-ai/vm0/issues/13719)) ([462dda5](https://github.com/vm0-ai/vm0/commit/462dda5e4af14a62569a2b84add4e899aa879c94))
* preserve codex jsonl failure diagnostics ([#13713](https://github.com/vm0-ai/vm0/issues/13713)) ([7fe2ece](https://github.com/vm0-ai/vm0/commit/7fe2ece7cb75ee6606e4cfb522cc28a19117acf3))

## [0.102.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.6...runner-rs-v0.102.0) (2026-05-17)


### Features

* wire operation-bound process control to guest-agent ([#13538](https://github.com/vm0-ai/vm0/issues/13538)) ([3bc2ee1](https://github.com/vm0-ai/vm0/commit/3bc2ee1dda51d68c6825a1a71bf44edbc9692a0d))

## [0.101.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.5...runner-rs-v0.101.6) (2026-05-16)


### Performance Improvements

* **runner:** chunk network log uploads ([#13549](https://github.com/vm0-ai/vm0/issues/13549)) ([ae90576](https://github.com/vm0-ai/vm0/commit/ae90576082ef03efa78d5438af17afa0ce08b1b8))

## [0.101.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.4...runner-rs-v0.101.5) (2026-05-16)

## [0.101.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.3...runner-rs-v0.101.4) (2026-05-15)

## [0.101.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.2...runner-rs-v0.101.3) (2026-05-15)

## [0.101.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.1...runner-rs-v0.101.2) (2026-05-15)

## [0.101.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.101.0...runner-rs-v0.101.1) (2026-05-15)


### Refactoring

* **mitm-addon:** centralize firewall billing state ([#13463](https://github.com/vm0-ai/vm0/issues/13463)) ([4681a45](https://github.com/vm0-ai/vm0/commit/4681a4553ffa30a2091b72a3071f170f53796383))

## [0.101.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.45...runner-rs-v0.101.0) (2026-05-15)


### Features

* gate billable firewall auth on credits ([#13433](https://github.com/vm0-ai/vm0/issues/13433)) ([235587d](https://github.com/vm0-ai/vm0/commit/235587df8efd5539d87e3fddda72c9726e231a9e))


### Bug Fixes

* **runner:** supervise signal handler lifecycle ([#13390](https://github.com/vm0-ai/vm0/issues/13390)) ([1237dc6](https://github.com/vm0-ai/vm0/commit/1237dc6ab8e28f09ec283b45c33ecb96c3eeb5fb))


### Refactoring

* **runner:** encode idle park ownership state ([#13415](https://github.com/vm0-ai/vm0/issues/13415)) ([9613924](https://github.com/vm0-ai/vm0/commit/9613924249bd8f98536635cb3c04197a1c6886e6))

## [0.100.45](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.44...runner-rs-v0.100.45) (2026-05-15)


### Refactoring

* rename spawn watch to spawn process ([#13369](https://github.com/vm0-ai/vm0/issues/13369)) ([e007f30](https://github.com/vm0-ai/vm0/commit/e007f30a2610056a6905e4a38bcc2d894895ffa4))

## [0.100.44](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.43...runner-rs-v0.100.44) (2026-05-15)

## [0.100.43](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.42...runner-rs-v0.100.43) (2026-05-14)

## [0.100.42](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.41...runner-rs-v0.100.42) (2026-05-14)


### Bug Fixes

* **runner:** close network log source before upload flush ([#13336](https://github.com/vm0-ai/vm0/issues/13336)) ([c8440eb](https://github.com/vm0-ai/vm0/commit/c8440eb2ab1b05175cd30e0200a5d11687b5226f))

## [0.100.41](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.40...runner-rs-v0.100.41) (2026-05-14)


### Bug Fixes

* **runner:** copy guest sandbox ops logs ([#13309](https://github.com/vm0-ai/vm0/issues/13309)) ([39ce8f9](https://github.com/vm0-ai/vm0/commit/39ce8f98d2f5780bd8fd66b1aa10160b67691138))


### Refactoring

* type factory lifecycle resources ([#13293](https://github.com/vm0-ai/vm0/issues/13293)) ([0b533c7](https://github.com/vm0-ai/vm0/commit/0b533c76f86e651b09d662cb9c85a8c3a3d06ad5))

## [0.100.40](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.39...runner-rs-v0.100.40) (2026-05-14)


### Bug Fixes

* handle claude zero-turn no-history runs ([#13246](https://github.com/vm0-ai/vm0/issues/13246)) ([41db91a](https://github.com/vm0-ai/vm0/commit/41db91ac41352fd0e7c2f8c5a77563d4dffd35d7))


### Refactoring

* dedupe job spawn panic cleanup tests ([#13272](https://github.com/vm0-ai/vm0/issues/13272)) ([b7f600a](https://github.com/vm0-ai/vm0/commit/b7f600a142963e2b0bc237acef3a9aa1a1e9c916))
* **runner:** dedupe finalization test setup ([#13271](https://github.com/vm0-ai/vm0/issues/13271)) ([e309a7b](https://github.com/vm0-ai/vm0/commit/e309a7b41601a26f1ced4be93ab6619762f1be18))

## [0.100.39](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.38...runner-rs-v0.100.39) (2026-05-14)


### Bug Fixes

* **runner:** keep local cancel watcher live ([#13218](https://github.com/vm0-ai/vm0/issues/13218)) ([f0dad8c](https://github.com/vm0-ai/vm0/commit/f0dad8cd435f25d95efc35518f9bb1dcaf224940))

## [0.100.38](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.37...runner-rs-v0.100.38) (2026-05-14)

## [0.100.37](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.36...runner-rs-v0.100.37) (2026-05-13)


### Bug Fixes

* enable built-in openai codex billing ([#13193](https://github.com/vm0-ai/vm0/issues/13193)) ([616ad30](https://github.com/vm0-ai/vm0/commit/616ad30f79a0e046ece9a62ea8b195d1bfe6b407))

## [0.100.36](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.35...runner-rs-v0.100.36) (2026-05-13)

## [0.100.35](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.34...runner-rs-v0.100.35) (2026-05-13)


### Bug Fixes

* **runner:** partition local queue by profile ([#13143](https://github.com/vm0-ai/vm0/issues/13143)) ([c0f8835](https://github.com/vm0-ai/vm0/commit/c0f8835ba5779664d58ce7ab06e0fe8d4ec18ba7))

## [0.100.34](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.33...runner-rs-v0.100.34) (2026-05-13)


### Bug Fixes

* normalize instructions filename by runtime framework ([#12245](https://github.com/vm0-ai/vm0/issues/12245)) ([55b4846](https://github.com/vm0-ai/vm0/commit/55b484668ed1b559e2bf16f74ad3fcc4b4559c1f))
* **runner:** validate setup artifacts before reporting installed ([#13075](https://github.com/vm0-ai/vm0/issues/13075)) ([cd68236](https://github.com/vm0-ai/vm0/commit/cd68236acea7bf7002be282cabe68b96c533fe10))


### Documentation

* clarify status run replacement semantics ([#12287](https://github.com/vm0-ai/vm0/issues/12287)) ([09c4eb2](https://github.com/vm0-ai/vm0/commit/09c4eb255c566fcd03f14c79c3328eeeae95a2a4))
* document runner path layout ([#12289](https://github.com/vm0-ai/vm0/issues/12289)) ([e37c3b9](https://github.com/vm0-ai/vm0/commit/e37c3b908114949c320ab72c379c80ee15909624))
* **runner:** document network log drain producers ([#13058](https://github.com/vm0-ai/vm0/issues/13058)) ([9325b1a](https://github.com/vm0-ai/vm0/commit/9325b1ac1988c78fc4018e39d3620873dab48adb))


### Refactoring

* route sandbox exec through command operations ([#13018](https://github.com/vm0-ai/vm0/issues/13018)) ([0e5f862](https://github.com/vm0-ai/vm0/commit/0e5f862ee8e2182e23a88df6187f194171004b1f))
* **runner:** include bounded exec diagnostics ([#12368](https://github.com/vm0-ai/vm0/issues/12368)) ([41d5d12](https://github.com/vm0-ai/vm0/commit/41d5d12ced60e34731d78bea2ef172eed5fbdc77))
* **runner:** migrate internal execs to bounded exec ([#12322](https://github.com/vm0-ai/vm0/issues/12322)) ([f0b84b4](https://github.com/vm0-ai/vm0/commit/f0b84b4f09bad9abc16074af3f0190944bba3d04))
* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))
* split start test support modules ([#13078](https://github.com/vm0-ai/vm0/issues/13078)) ([53c010a](https://github.com/vm0-ai/vm0/commit/53c010aa730b8ad4d5c3f285b18e81c30f317b6f))


### Performance Improvements

* avoid downloading warmed runner templates ([#12731](https://github.com/vm0-ai/vm0/issues/12731)) ([eb5df7a](https://github.com/vm0-ai/vm0/commit/eb5df7aa28493373ce5ec734924e80d34fd372b4))
* preserve axiom batch capacity ([#13094](https://github.com/vm0-ai/vm0/issues/13094)) ([72bb92e](https://github.com/vm0-ai/vm0/commit/72bb92ebb56c365907c536fb289e1c3873a1b680))
* **runner:** stream guest log copies ([#12418](https://github.com/vm0-ai/vm0/issues/12418)) ([a842925](https://github.com/vm0-ai/vm0/commit/a8429251f3554335ace57e1a78c105cf881c193b))

## [0.100.33](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.32...runner-rs-v0.100.33) (2026-05-13)

## [0.100.32](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.31...runner-rs-v0.100.32) (2026-05-13)


### Performance Improvements

* preserve axiom batch capacity ([#13094](https://github.com/vm0-ai/vm0/issues/13094)) ([72bb92e](https://github.com/vm0-ai/vm0/commit/72bb92ebb56c365907c536fb289e1c3873a1b680))

## [0.100.31](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.30...runner-rs-v0.100.31) (2026-05-13)


### Bug Fixes

* **runner:** validate setup artifacts before reporting installed ([#13075](https://github.com/vm0-ai/vm0/issues/13075)) ([cd68236](https://github.com/vm0-ai/vm0/commit/cd68236acea7bf7002be282cabe68b96c533fe10))


### Documentation

* **runner:** document network log drain producers ([#13058](https://github.com/vm0-ai/vm0/issues/13058)) ([9325b1a](https://github.com/vm0-ai/vm0/commit/9325b1ac1988c78fc4018e39d3620873dab48adb))


### Refactoring

* route sandbox exec through command operations ([#13018](https://github.com/vm0-ai/vm0/issues/13018)) ([0e5f862](https://github.com/vm0-ai/vm0/commit/0e5f862ee8e2182e23a88df6187f194171004b1f))
* split start test support modules ([#13078](https://github.com/vm0-ai/vm0/issues/13078)) ([53c010a](https://github.com/vm0-ai/vm0/commit/53c010aa730b8ad4d5c3f285b18e81c30f317b6f))

## [0.100.30](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.29...runner-rs-v0.100.30) (2026-05-12)

## [0.100.29](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.28...runner-rs-v0.100.29) (2026-05-12)

## [0.100.28](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.27...runner-rs-v0.100.28) (2026-05-12)

## [0.100.27](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.26...runner-rs-v0.100.27) (2026-05-12)


### Performance Improvements

* avoid downloading warmed runner templates ([#12731](https://github.com/vm0-ai/vm0/issues/12731)) ([eb5df7a](https://github.com/vm0-ai/vm0/commit/eb5df7aa28493373ce5ec734924e80d34fd372b4))

## [0.100.26](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.25...runner-rs-v0.100.26) (2026-05-11)

## [0.100.25](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.24...runner-rs-v0.100.25) (2026-05-10)


### Refactoring

* **runner:** stream exec over bounded exec ([#12518](https://github.com/vm0-ai/vm0/issues/12518)) ([ee551da](https://github.com/vm0-ai/vm0/commit/ee551dabe2c464564a576580a9d8811453ffd08d))

## [0.100.24](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.23...runner-rs-v0.100.24) (2026-05-10)


### Performance Improvements

* **runner:** stream guest log copies ([#12418](https://github.com/vm0-ai/vm0/issues/12418)) ([a842925](https://github.com/vm0-ai/vm0/commit/a8429251f3554335ace57e1a78c105cf881c193b))

## [0.100.23](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.22...runner-rs-v0.100.23) (2026-05-09)


### Refactoring

* **runner:** include bounded exec diagnostics ([#12368](https://github.com/vm0-ai/vm0/issues/12368)) ([41d5d12](https://github.com/vm0-ai/vm0/commit/41d5d12ced60e34731d78bea2ef172eed5fbdc77))

## [0.100.22](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.21...runner-rs-v0.100.22) (2026-05-09)


### Refactoring

* **runner:** migrate internal execs to bounded exec ([#12322](https://github.com/vm0-ai/vm0/issues/12322)) ([f0b84b4](https://github.com/vm0-ai/vm0/commit/f0b84b4f09bad9abc16074af3f0190944bba3d04))

## [0.100.21](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.20...runner-rs-v0.100.21) (2026-05-09)

## [0.100.20](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.19...runner-rs-v0.100.20) (2026-05-09)

## [0.100.19](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.18...runner-rs-v0.100.19) (2026-05-09)


### Documentation

* clarify status run replacement semantics ([#12287](https://github.com/vm0-ai/vm0/issues/12287)) ([09c4eb2](https://github.com/vm0-ai/vm0/commit/09c4eb255c566fcd03f14c79c3328eeeae95a2a4))
* document runner path layout ([#12289](https://github.com/vm0-ai/vm0/issues/12289)) ([e37c3b9](https://github.com/vm0-ai/vm0/commit/e37c3b908114949c320ab72c379c80ee15909624))

## [0.100.18](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.17...runner-rs-v0.100.18) (2026-05-09)

## [0.100.17](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.16...runner-rs-v0.100.17) (2026-05-09)

## [0.100.16](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.15...runner-rs-v0.100.16) (2026-05-09)

## [0.100.15](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.14...runner-rs-v0.100.15) (2026-05-09)


### Bug Fixes

* normalize instructions filename by runtime framework ([#12245](https://github.com/vm0-ai/vm0/issues/12245)) ([55b4846](https://github.com/vm0-ai/vm0/commit/55b484668ed1b559e2bf16f74ad3fcc4b4559c1f))

## [0.100.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.13...runner-rs-v0.100.14) (2026-05-08)

## [0.100.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.12...runner-rs-v0.100.13) (2026-05-08)


### Documentation

* **runner:** document http client constructor ([#12171](https://github.com/vm0-ai/vm0/issues/12171)) ([a31e828](https://github.com/vm0-ai/vm0/commit/a31e8282936e2378397deb81326b78c777424ee3))


### Performance Improvements

* add guest write-file helper ([#12136](https://github.com/vm0-ai/vm0/issues/12136)) ([8795398](https://github.com/vm0-ai/vm0/commit/8795398ddd54bb6f7e4cade4c1d3a67a11bebd1b))

## [0.100.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.11...runner-rs-v0.100.12) (2026-05-08)

## [0.100.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.10...runner-rs-v0.100.11) (2026-05-08)


### Bug Fixes

* restore codex sessions as jsonl ([#12137](https://github.com/vm0-ai/vm0/issues/12137)) ([ab3dc5b](https://github.com/vm0-ai/vm0/commit/ab3dc5b5f35105709cc22d7caf9e571c59ec5a39))

## [0.100.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.9...runner-rs-v0.100.10) (2026-05-08)


### Bug Fixes

* refresh personal codex oauth providers ([#12120](https://github.com/vm0-ai/vm0/issues/12120)) ([b4e727d](https://github.com/vm0-ai/vm0/commit/b4e727da0dc4a1fbb0df6d8ef3aececa9460b5a7))

## [0.100.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.8...runner-rs-v0.100.9) (2026-05-07)


### Refactoring

* **runner:** clarify r2 template materialization ([#12104](https://github.com/vm0-ai/vm0/issues/12104)) ([6649d63](https://github.com/vm0-ai/vm0/commit/6649d63b2f58ab29ee7c150e1d055529e0888de5))
* **runner:** shield snapshot publish cancellation ([#12101](https://github.com/vm0-ai/vm0/issues/12101)) ([ecc38a4](https://github.com/vm0-ai/vm0/commit/ecc38a414a24c72d654d049f6eb38906ce24b734))

## [0.100.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.7...runner-rs-v0.100.8) (2026-05-07)


### Refactoring

* **runner:** split snapshot publish boundary ([#12044](https://github.com/vm0-ai/vm0/issues/12044)) ([b01e205](https://github.com/vm0-ai/vm0/commit/b01e205e530cb9a6ed5353294077d9a80b70da62))

## [0.100.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.6...runner-rs-v0.100.7) (2026-05-07)

## [0.100.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.5...runner-rs-v0.100.6) (2026-05-07)


### Refactoring

* **runner:** dedupe network log drain warnings ([#12065](https://github.com/vm0-ai/vm0/issues/12065)) ([902113f](https://github.com/vm0-ai/vm0/commit/902113f2af2265322c71d3e435818ffbfc0e0cd5))

## [0.100.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.4...runner-rs-v0.100.5) (2026-05-07)


### Refactoring

* **runner:** centralize ownership transitions ([#12034](https://github.com/vm0-ai/vm0/issues/12034)) ([03cd98f](https://github.com/vm0-ai/vm0/commit/03cd98f32d2a42fd02d6fa1cdb1c34e4bea70ca0))

## [0.100.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.3...runner-rs-v0.100.4) (2026-05-07)


### Bug Fixes

* **runner:** select usage parser from cli agent type ([#12030](https://github.com/vm0-ai/vm0/issues/12030)) ([6cdd8ef](https://github.com/vm0-ai/vm0/commit/6cdd8ef2e777139fdef56d8e36c589a38be64e58))

## [0.100.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.2...runner-rs-v0.100.3) (2026-05-07)


### Documentation

* **runner:** document local command entrypoints ([#12010](https://github.com/vm0-ai/vm0/issues/12010)) ([26851da](https://github.com/vm0-ai/vm0/commit/26851daf16b347ae75491aa5907f186868ca8cb8))

## [0.100.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.1...runner-rs-v0.100.2) (2026-05-06)


### Bug Fixes

* **runner:** disable r2 response checksum warnings ([#11975](https://github.com/vm0-ai/vm0/issues/11975)) ([18a5ffd](https://github.com/vm0-ai/vm0/commit/18a5ffd955372b33f5af6db6deecaef964fe194c))

## [0.100.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.100.0...runner-rs-v0.100.1) (2026-05-06)


### Refactoring

* **runner:** share bounded sse usage scanner ([#11961](https://github.com/vm0-ai/vm0/issues/11961)) ([cfbd94d](https://github.com/vm0-ai/vm0/commit/cfbd94dc757b340dd5aa04f94e8b6e980c10eb40))

## [0.100.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.14...runner-rs-v0.100.0) (2026-05-06)


### Features

* **runner:** add OpenAI Responses usage billing ([#11950](https://github.com/vm0-ai/vm0/issues/11950)) ([467cdc8](https://github.com/vm0-ai/vm0/commit/467cdc8fc88897c16b0b21365c70a1786e5fda3e))

## [0.99.14](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.13...runner-rs-v0.99.14) (2026-05-06)

## [0.99.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.12...runner-rs-v0.99.13) (2026-05-06)


### Bug Fixes

* **sandbox-fc:** require snapshot publish marker ([#11867](https://github.com/vm0-ai/vm0/issues/11867)) ([023ae4d](https://github.com/vm0-ai/vm0/commit/023ae4d86570157504a176372727cab05f5b1483))


### Documentation

* **runner:** restore start loop comments ([#11896](https://github.com/vm0-ai/vm0/issues/11896)) ([ebb0521](https://github.com/vm0-ai/vm0/commit/ebb0521fd38c8ff09f8fee296cc5de0e458bc9eb))


### Refactoring

* **runner:** split start test harness ([#11870](https://github.com/vm0-ai/vm0/issues/11870)) ([085d91f](https://github.com/vm0-ai/vm0/commit/085d91fd68f2569aae8703dc8e781a65cce4cf32))

## [0.99.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.11...runner-rs-v0.99.12) (2026-05-05)


### Refactoring

* **runner:** split ably control plane from discovery ([#11856](https://github.com/vm0-ai/vm0/issues/11856)) ([b1468f1](https://github.com/vm0-ai/vm0/commit/b1468f1ae6085e13ebb34e4a53bc33270471bb58))
* **runner:** split start job discovery ([#11859](https://github.com/vm0-ai/vm0/issues/11859)) ([6139fc4](https://github.com/vm0-ai/vm0/commit/6139fc4e74e28ead4aac2784e582ca49290a8758))
* **runner:** split start job spawn ([#11862](https://github.com/vm0-ai/vm0/issues/11862)) ([89e78e8](https://github.com/vm0-ai/vm0/commit/89e78e89f39949ab25cb5237431881439d0d0acc))
* **runner:** split start sandbox finalization ([#11854](https://github.com/vm0-ai/vm0/issues/11854)) ([afd5117](https://github.com/vm0-ai/vm0/commit/afd51176d3d6d92cf0daa65999ad1140d88de9a4))
* **sandbox-fc:** add snapshot cleanup Drop finalizer ([#11843](https://github.com/vm0-ai/vm0/issues/11843)) ([8c3bfdd](https://github.com/vm0-ai/vm0/commit/8c3bfdd257b592737d39eecf5c6eacb1ca2ee861))

## [0.99.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.10...runner-rs-v0.99.11) (2026-05-05)


### Bug Fixes

* mark truncated decompressed network bodies ([#11793](https://github.com/vm0-ai/vm0/issues/11793)) ([bd2efd7](https://github.com/vm0-ai/vm0/commit/bd2efd759baf04a8bb789b224f8f9dca84864bc2))
* **runner:** escalate prolonged ably disconnects ([#11839](https://github.com/vm0-ai/vm0/issues/11839)) ([40b7d97](https://github.com/vm0-ai/vm0/commit/40b7d979c02f820a85950f0cb449fddc47461af7))


### Documentation

* document runner exec entry points ([#11812](https://github.com/vm0-ai/vm0/issues/11812)) ([2f8d87f](https://github.com/vm0-ai/vm0/commit/2f8d87faf2c9019f1fd14c675288dda8f73d0393))
* **runner:** document setup command ([#11810](https://github.com/vm0-ai/vm0/issues/11810)) ([35b5f2e](https://github.com/vm0-ai/vm0/commit/35b5f2ecf275b7a4a8feb32d634414ce32ad0f23))


### Refactoring

* **runner:** split start factory lifecycle ([#11828](https://github.com/vm0-ai/vm0/issues/11828)) ([e8e88c0](https://github.com/vm0-ai/vm0/commit/e8e88c0296b50f8ee4cc2d6c0b1b7144ebacb9de))
* **runner:** split start heartbeat module ([#11801](https://github.com/vm0-ai/vm0/issues/11801)) ([19ad6d4](https://github.com/vm0-ai/vm0/commit/19ad6d4d7af13fe45f50fe568dac279ee210c8bb))
* **runner:** split start idle lifecycle ([#11835](https://github.com/vm0-ai/vm0/issues/11835)) ([4e99ccb](https://github.com/vm0-ai/vm0/commit/4e99ccbec568b4b9186b32ab0c37bf9d1078d0e7))
* **runner:** split start orphan reaper ([#11820](https://github.com/vm0-ai/vm0/issues/11820)) ([71a4bec](https://github.com/vm0-ai/vm0/commit/71a4bec7963be662c15a90868373808dd4951302))


### Performance Improvements

* bound brotli body capture decompression ([#11799](https://github.com/vm0-ai/vm0/issues/11799)) ([92af5b4](https://github.com/vm0-ai/vm0/commit/92af5b4d73095bef1b5b40c3af8b1e0ff8e49b1b))

## [0.99.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.9...runner-rs-v0.99.10) (2026-05-03)


### Bug Fixes

* stabilize teardown timer tracing test ([#11767](https://github.com/vm0-ai/vm0/issues/11767)) ([ae279fc](https://github.com/vm0-ai/vm0/commit/ae279fc2786df436f6a41019610e162f6b6334d8))

## [0.99.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.8...runner-rs-v0.99.9) (2026-05-03)


### Bug Fixes

* **nbd-cow:** lock NBD claims across runners ([#11732](https://github.com/vm0-ai/vm0/issues/11732)) ([16d716e](https://github.com/vm0-ai/vm0/commit/16d716e1f07a77c0d93649f52d077953dd62ff16))

## [0.99.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.7...runner-rs-v0.99.8) (2026-05-03)


### Bug Fixes

* suppress runner debug logs ([#11727](https://github.com/vm0-ai/vm0/issues/11727)) ([2c47f5c](https://github.com/vm0-ai/vm0/commit/2c47f5cc1cd1b4906984adb3f0615f7edb622979))


### Refactoring

* dedupe guest download manifest conversion ([#11731](https://github.com/vm0-ai/vm0/issues/11731)) ([e1f5cb4](https://github.com/vm0-ai/vm0/commit/e1f5cb464bb4d9fdb6352ff9d3de20896536b471))
* **runner:** share api client response handling ([#11725](https://github.com/vm0-ai/vm0/issues/11725)) ([006e356](https://github.com/vm0-ai/vm0/commit/006e356bdf484bb9321a47330abac7dd168943c2))

## [0.99.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.6...runner-rs-v0.99.7) (2026-05-03)


### Documentation

* **runner:** document doctor entry points ([#11699](https://github.com/vm0-ai/vm0/issues/11699)) ([e431dc0](https://github.com/vm0-ai/vm0/commit/e431dc02d3d5f2b27ee3ad676f1d1d524f5c6b93))


### Performance Improvements

* **runner:** cache rootfs templates in r2 ([#11597](https://github.com/vm0-ai/vm0/issues/11597)) ([136382c](https://github.com/vm0-ai/vm0/commit/136382cbfa2fc1ed8230145edf13ec72f712e770))

## [0.99.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.5...runner-rs-v0.99.6) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.99.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.4...runner-rs-v0.99.5) (2026-05-01)


### Bug Fixes

* harden ably disconnect handling ([#11656](https://github.com/vm0-ai/vm0/issues/11656)) ([c0c50d8](https://github.com/vm0-ai/vm0/commit/c0c50d88154f7ad74af791fc2df9e5a8db609418))

## [0.99.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.3...runner-rs-v0.99.4) (2026-05-01)


### Documentation

* document runner executor module ([#11608](https://github.com/vm0-ai/vm0/issues/11608)) ([9838b83](https://github.com/vm0-ai/vm0/commit/9838b8395a9dddd523fb37e366210c64ee2b1cfe))

## [0.99.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.2...runner-rs-v0.99.3) (2026-04-30)


### Refactoring

* **runner:** clarify build orchestration ([#11580](https://github.com/vm0-ai/vm0/issues/11580)) ([60926e3](https://github.com/vm0-ai/vm0/commit/60926e366abaf11c4430e08eac6903262038152c))

## [0.99.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.1...runner-rs-v0.99.2) (2026-04-29)


### Bug Fixes

* **runner:** drain network logs before source release ([#11552](https://github.com/vm0-ai/vm0/issues/11552)) ([b297e3c](https://github.com/vm0-ai/vm0/commit/b297e3c20afb94c2796311111fd60ed732c9d1e9))

## [0.99.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.99.0...runner-rs-v0.99.1) (2026-04-29)


### Bug Fixes

* bound runner storage cache cardinality ([#11554](https://github.com/vm0-ai/vm0/issues/11554)) ([1950c8b](https://github.com/vm0-ai/vm0/commit/1950c8b97ae9deacd61a971af90b2c84ba16fd69))

## [0.99.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.7...runner-rs-v0.99.0) (2026-04-29)


### Features

* **runner:** log teardown phase timings ([#11548](https://github.com/vm0-ai/vm0/issues/11548)) ([0cc9974](https://github.com/vm0-ai/vm0/commit/0cc9974742bf745c53476c662dc8f663943a4a6b))

## [0.98.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.6...runner-rs-v0.98.7) (2026-04-29)


### Bug Fixes

* **runner:** compare axiom timeouts precisely ([#11536](https://github.com/vm0-ai/vm0/issues/11536)) ([6c751d4](https://github.com/vm0-ai/vm0/commit/6c751d47dc24fe7277beafbd475cb229001d74b9))

## [0.98.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.5...runner-rs-v0.98.6) (2026-04-29)

## [0.98.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.4...runner-rs-v0.98.5) (2026-04-29)


### Documentation

* **runner:** document resource budget accessors ([#11505](https://github.com/vm0-ai/vm0/issues/11505)) ([7d7ded9](https://github.com/vm0-ai/vm0/commit/7d7ded9f5b3268bc8d4a221381d58120ba890e7e))

## [0.98.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.3...runner-rs-v0.98.4) (2026-04-29)


### Refactoring

* extract mitm registry cache ([#11492](https://github.com/vm0-ai/vm0/issues/11492)) ([a184fff](https://github.com/vm0-ai/vm0/commit/a184fff36e741d2c16cb7f28cc9ad13425da6a42))

## [0.98.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.2...runner-rs-v0.98.3) (2026-04-29)


### Refactoring

* extract mitm response streaming state ([#11488](https://github.com/vm0-ai/vm0/issues/11488)) ([3e6a471](https://github.com/vm0-ai/vm0/commit/3e6a471ff4ce1c802b36e610e6e51a6a91ff8fe5))
* split runner storage manifest boundaries ([#11487](https://github.com/vm0-ai/vm0/issues/11487)) ([7bfc3f8](https://github.com/vm0-ai/vm0/commit/7bfc3f86717495cf2ed8d72c796fb1e3b6a98f30))

## [0.98.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.1...runner-rs-v0.98.2) (2026-04-29)

## [0.98.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.98.0...runner-rs-v0.98.1) (2026-04-29)


### Bug Fixes

* **runner:** clean up outer job panic bookkeeping ([#11393](https://github.com/vm0-ai/vm0/issues/11393)) ([4ecf0b6](https://github.com/vm0-ai/vm0/commit/4ecf0b65e25c66a86eec0151a29dd4f0fa0deeb0))

## [0.98.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.97.3...runner-rs-v0.98.0) (2026-04-28)


### Features

* **rootfs:** install codex cli binary in sandbox image ([#11425](https://github.com/vm0-ai/vm0/issues/11425)) ([00914b9](https://github.com/vm0-ai/vm0/commit/00914b9c1d98027f8ca2901df58ce4e0653cfba6)), closes [#11416](https://github.com/vm0-ai/vm0/issues/11416)
* **runner:** framework-aware restore_session for codex ([#11429](https://github.com/vm0-ai/vm0/issues/11429)) ([6e10fcd](https://github.com/vm0-ai/vm0/commit/6e10fcdee3ab50f02f3771cd32aacc7d59dd184b))

## [0.97.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.97.2...runner-rs-v0.97.3) (2026-04-28)

## [0.97.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.97.1...runner-rs-v0.97.2) (2026-04-28)

## [0.97.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.97.0...runner-rs-v0.97.1) (2026-04-28)


### Refactoring

* **runner:** model spawn job lifecycle ownership ([#11354](https://github.com/vm0-ai/vm0/issues/11354)) ([3d6c156](https://github.com/vm0-ai/vm0/commit/3d6c156304b24e7967137e8411f38baaafa52ef7))

## [0.97.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.6...runner-rs-v0.97.0) (2026-04-28)


### Features

* **runner:** record dns query results in network logs ([#11351](https://github.com/vm0-ai/vm0/issues/11351)) ([96755e6](https://github.com/vm0-ai/vm0/commit/96755e69c58de5e0ca2b13a6be3693b6276cee7a))

## [0.96.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.5...runner-rs-v0.96.6) (2026-04-28)


### Bug Fixes

* align telegram typing and markdown responses ([#11312](https://github.com/vm0-ai/vm0/issues/11312)) ([eb4b88e](https://github.com/vm0-ai/vm0/commit/eb4b88eca4db66fedd20eead881a1691408688f4))

## [0.96.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.4...runner-rs-v0.96.5) (2026-04-28)


### Bug Fixes

* **runner:** isolate axiom tracing filter ([#11300](https://github.com/vm0-ai/vm0/issues/11300)) ([d999241](https://github.com/vm0-ai/vm0/commit/d9992419e3c93628ee6ed15aefa60c889ee40f0c))


### Refactoring

* **runner:** require leases for budget reservations ([#11301](https://github.com/vm0-ai/vm0/issues/11301)) ([d48d3d3](https://github.com/vm0-ai/vm0/commit/d48d3d3e4106f97531b41049fe30956289bb8738))

## [0.96.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.3...runner-rs-v0.96.4) (2026-04-28)


### Bug Fixes

* **runner:** cap storage cache downloads ([#11254](https://github.com/vm0-ai/vm0/issues/11254)) ([8c0764f](https://github.com/vm0-ai/vm0/commit/8c0764f7454d22f4afd891854833e6ee15735840))
* **runner:** gate parking during soft drain transitions ([#11272](https://github.com/vm0-ai/vm0/issues/11272)) ([ccfe41b](https://github.com/vm0-ai/vm0/commit/ccfe41b4c9aa7334623119b679807592588cd703))

## [0.96.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.2...runner-rs-v0.96.3) (2026-04-27)


### Refactoring

* centralize guest system log path ([#11246](https://github.com/vm0-ai/vm0/issues/11246)) ([b93fc42](https://github.com/vm0-ai/vm0/commit/b93fc42833815fd843f073044b4e872505812025))

## [0.96.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.1...runner-rs-v0.96.2) (2026-04-27)

## [0.96.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.96.0...runner-rs-v0.96.1) (2026-04-27)


### Bug Fixes

* **mitm-addon:** harden static firewall host matching ([#11231](https://github.com/vm0-ai/vm0/issues/11231)) ([36eb7d1](https://github.com/vm0-ai/vm0/commit/36eb7d14959328ec8beca105a12685290b6e4f63))


### Documentation

* **runner:** clarify benchmark profile lookup ([#11237](https://github.com/vm0-ai/vm0/issues/11237)) ([c159474](https://github.com/vm0-ai/vm0/commit/c159474be7cddaa47f19f9300d571f890fbf9d2a))

## [0.96.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.5...runner-rs-v0.96.0) (2026-04-27)


### Features

* support batched usage event webhooks ([#11204](https://github.com/vm0-ai/vm0/issues/11204)) ([cc46707](https://github.com/vm0-ai/vm0/commit/cc467077cc79126df30c6b101543780e7bd49bc8))


### Bug Fixes

* **runner:** add active cleanup panic context ([#11212](https://github.com/vm0-ai/vm0/issues/11212)) ([d0f2804](https://github.com/vm0-ai/vm0/commit/d0f2804cc481ffc1e8164d04c23b856e3d2d6ec0)), closes [#11194](https://github.com/vm0-ai/vm0/issues/11194)
* **runner:** make idle vm budget release panic-safe ([#11191](https://github.com/vm0-ai/vm0/issues/11191)) ([52e085f](https://github.com/vm0-ai/vm0/commit/52e085fb6e53623b5920fbfee58ccc71d8d760ae))


### Refactoring

* **mitm-addon:** validate x tweet urls with iana tlds ([#11186](https://github.com/vm0-ai/vm0/issues/11186)) ([bd13484](https://github.com/vm0-ai/vm0/commit/bd13484d5ceaa8fc9fc28cbe2efd22bc10d6d76b))
* **sandbox:** clarify error taxonomy ([#11178](https://github.com/vm0-ai/vm0/issues/11178)) ([f766059](https://github.com/vm0-ai/vm0/commit/f7660591f6866336a78803225653fd738667c036))

## [0.95.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.4...runner-rs-v0.95.5) (2026-04-26)


### Bug Fixes

* **mitm-addon:** detect x tweet urls conservatively ([#11176](https://github.com/vm0-ai/vm0/issues/11176)) ([cf8fb08](https://github.com/vm0-ai/vm0/commit/cf8fb08a270e1f887f78272dd8bb5b34f6adfe5e))
* **runner:** reap completed jobs while running ([#11167](https://github.com/vm0-ai/vm0/issues/11167)) ([1355c20](https://github.com/vm0-ai/vm0/commit/1355c206bc638b7e5c65764992f57df9990b6a36))
* **runner:** reclaim expired idle VMs under pressure ([#11172](https://github.com/vm0-ai/vm0/issues/11172)) ([28855b9](https://github.com/vm0-ai/vm0/commit/28855b980d66b77d869ba5b37d6055b29676ca43))


### Refactoring

* **runner:** consolidate flock acquisition ([#11155](https://github.com/vm0-ai/vm0/issues/11155)) ([cd013fc](https://github.com/vm0-ai/vm0/commit/cd013fcc037efd50001c0525c9c11202e5c959f1))
* **runner:** consolidate gc read dir handling ([#11153](https://github.com/vm0-ai/vm0/issues/11153)) ([c07593c](https://github.com/vm0-ai/vm0/commit/c07593ce164289f102ec050594a2ba62570d9b60))
* **runner:** split start leaf modules ([#11136](https://github.com/vm0-ai/vm0/issues/11136)) ([9bc7995](https://github.com/vm0-ai/vm0/commit/9bc7995a0ef28c05e7eea326d0233325221d2016))
* **runner:** unify start loop reactor ([#11159](https://github.com/vm0-ai/vm0/issues/11159)) ([aa85eb6](https://github.com/vm0-ai/vm0/commit/aa85eb61e06c82f36a594c4852c4f0dbcd5b84e5))

## [0.95.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.3...runner-rs-v0.95.4) (2026-04-26)


### Refactoring

* extract connectors package ([#11132](https://github.com/vm0-ai/vm0/issues/11132)) ([15bf0fa](https://github.com/vm0-ai/vm0/commit/15bf0faa80ccd294fcfd0a1ce51fac9ea6285449))

## [0.95.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.2...runner-rs-v0.95.3) (2026-04-25)


### Bug Fixes

* **runner:** unify error log for claimed-but-failed job ([#11093](https://github.com/vm0-ai/vm0/issues/11093)) ([30138c5](https://github.com/vm0-ai/vm0/commit/30138c5d231fe122cfd7180e98ed1d53a1fae76a))


### Refactoring

* split db and api contracts packages ([#11092](https://github.com/vm0-ai/vm0/issues/11092)) ([f4767d9](https://github.com/vm0-ai/vm0/commit/f4767d987af373d17d93d5ca8fb00864c18bc15b))

## [0.95.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.1...runner-rs-v0.95.2) (2026-04-25)

## [0.95.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.95.0...runner-rs-v0.95.1) (2026-04-25)

## [0.95.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.94.2...runner-rs-v0.95.0) (2026-04-24)


### Features

* **runner:** log axiom telemetry enabled/disabled at startup ([#11040](https://github.com/vm0-ai/vm0/issues/11040)) ([7528e66](https://github.com/vm0-ai/vm0/commit/7528e66045d690c2372ad1b0ef41bd33d3c5afe2))


### Bug Fixes

* **runner:** treat claim 404 as race-lost, not api error (closes [#11041](https://github.com/vm0-ai/vm0/issues/11041)) ([#11045](https://github.com/vm0-ai/vm0/issues/11045)) ([83815d2](https://github.com/vm0-ai/vm0/commit/83815d22670be1553082c6a9398c78cdcfa8547d))

## [0.94.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.94.1...runner-rs-v0.94.2) (2026-04-24)


### Bug Fixes

* **runner:** make rootfs assembly atomic via staging + rename ([#11013](https://github.com/vm0-ai/vm0/issues/11013)) ([ab3c249](https://github.com/vm0-ai/vm0/commit/ab3c249f5c4a4684d7aa3cf0dc736fe8e5f6eac3))


### Performance Improvements

* **guest-agent:** skip vas snapshot for unchanged artifacts (part 2 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10989](https://github.com/vm0-ai/vm0/issues/10989)) ([4d4b18e](https://github.com/vm0-ai/vm0/commit/4d4b18ede0f7f13c767cb8d50726d9ea1e69c780))

## [0.94.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.94.0...runner-rs-v0.94.1) (2026-04-24)


### Bug Fixes

* **mitm-addon:** retarget seed-consistency test at usage_pricing + trigger on dev-seed.ts ([#11000](https://github.com/vm0-ai/vm0/issues/11000)) ([a436db1](https://github.com/vm0-ai/vm0/commit/a436db14325c0292b5038d83eaad5cab9fedfc98))

## [0.94.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.9...runner-rs-v0.94.0) (2026-04-24)


### Features

* thread storage id from web to guest-agent (part 1 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10978](https://github.com/vm0-ai/vm0/issues/10978)) ([85f2193](https://github.com/vm0-ai/vm0/commit/85f219383d3cf7b81ca6f41358276d5388acb8c0))

## [0.93.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.8...runner-rs-v0.93.9) (2026-04-24)


### Bug Fixes

* **mitm-addon:** guard flow.request.content against bad content-encoding ([#10968](https://github.com/vm0-ai/vm0/issues/10968)) ([a90e863](https://github.com/vm0-ai/vm0/commit/a90e86331ccf4455ef14f288430962583f7d54cf))

## [0.93.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.7...runner-rs-v0.93.8) (2026-04-24)

## [0.93.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.6...runner-rs-v0.93.7) (2026-04-23)


### Refactoring

* **runner:** dedupe early-return timing blocks in benchmark ([#10901](https://github.com/vm0-ai/vm0/issues/10901)) ([8c81ec7](https://github.com/vm0-ai/vm0/commit/8c81ec7ce58ce01bfd312d4539f7b3779f5524ea))

## [0.93.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.5...runner-rs-v0.93.6) (2026-04-23)


### Performance Improvements

* **runner:** parallelize idle pool drain ([#10864](https://github.com/vm0-ai/vm0/issues/10864)) ([4db1306](https://github.com/vm0-ai/vm0/commit/4db1306de073f588a1b5d57aa642b5104d8f8550))
* **runner:** post /complete from guest-agent after checkpoint lands ([#10787](https://github.com/vm0-ai/vm0/issues/10787)) ([69e00f0](https://github.com/vm0-ai/vm0/commit/69e00f0540348aaab547b13c7533bd97af88ad23))

## [0.93.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.4...runner-rs-v0.93.5) (2026-04-23)


### Bug Fixes

* **runner:** probe storage archive size via get range instead of head ([#10850](https://github.com/vm0-ai/vm0/issues/10850)) ([5456d37](https://github.com/vm0-ai/vm0/commit/5456d376d3adf9a471f649fdd9c853c238df413c))


### Refactoring

* **runner:** move statustracker port setters into constructor (closes [#10651](https://github.com/vm0-ai/vm0/issues/10651)) ([#10836](https://github.com/vm0-ai/vm0/issues/10836)) ([898710c](https://github.com/vm0-ai/vm0/commit/898710ccf51047685b4312eaae3ef7500f67b572))

## [0.93.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.3...runner-rs-v0.93.4) (2026-04-23)


### Documentation

* document public statustracker methods (closes [#10635](https://github.com/vm0-ai/vm0/issues/10635)) ([#10811](https://github.com/vm0-ai/vm0/issues/10811)) ([559b65b](https://github.com/vm0-ai/vm0/commit/559b65b8f78d2754888315108b40498d42f15f13))

## [0.93.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.2...runner-rs-v0.93.3) (2026-04-23)


### Bug Fixes

* **voice-chat-candidate:** adaptive echo cancellation and server-side session config ([#10795](https://github.com/vm0-ai/vm0/issues/10795)) ([2782e42](https://github.com/vm0-ai/vm0/commit/2782e42e8a562a4c20ecebbd5630de0f6ae21cf3))


### Documentation

* document runner config schema (closes [#10775](https://github.com/vm0-ai/vm0/issues/10775)) ([#10801](https://github.com/vm0-ai/vm0/issues/10801)) ([70808d4](https://github.com/vm0-ai/vm0/commit/70808d4625fc21433b711d580610004ee6c07f0b))

## [0.93.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.1...runner-rs-v0.93.2) (2026-04-23)


### Documentation

* **runner:** fix misleading comments in resolve_ambiguous test ([#10791](https://github.com/vm0-ai/vm0/issues/10791)) ([2da48bb](https://github.com/vm0-ai/vm0/commit/2da48bbbeb2ca824789551e4980656c560b31350))

## [0.93.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.93.0...runner-rs-v0.93.1) (2026-04-23)


### Bug Fixes

* **runner:** reject benchmark --env values without '=' ([#10712](https://github.com/vm0-ai/vm0/issues/10712)) ([cf57891](https://github.com/vm0-ai/vm0/commit/cf57891b34f276e4f2a6a7027bbc5f392bd8d201))

## [0.93.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.92.0...runner-rs-v0.93.0) (2026-04-22)


### Features

* **billing:** unify connector_billing into usage_event table ([#10704](https://github.com/vm0-ai/vm0/issues/10704)) ([6f9c462](https://github.com/vm0-ai/vm0/commit/6f9c4622a47619404b31adb3c980e80546094528))


### Refactoring

* drop residual memory plumbing, legacy snapshot columns, and vm0 memory cli ([#10707](https://github.com/vm0-ai/vm0/issues/10707)) ([08f3ce8](https://github.com/vm0-ai/vm0/commit/08f3ce81273faf8ea7e2e4df67b69e774bcb963e))
* emit memory as artifacts[] entry and delete guest-agent symlink bootstrap ([#10700](https://github.com/vm0-ai/vm0/issues/10700)) ([e3f0120](https://github.com/vm0-ai/vm0/commit/e3f0120fbd90d9b9fb750e13440a9f21ea809d3a))
* **runner:** collapse duplicated wire/info struct pairs in doctor.rs ([#10711](https://github.com/vm0-ai/vm0/issues/10711)) ([05628c2](https://github.com/vm0-ai/vm0/commit/05628c29b574caea5992bee6170e5533cf258182)), closes [#10654](https://github.com/vm0-ai/vm0/issues/10654)
* **runner:** simplify extract_field to single-line iterator chain ([#10682](https://github.com/vm0-ai/vm0/issues/10682)) ([89fcbdd](https://github.com/vm0-ai/vm0/commit/89fcbdd609c7803f8f0e7eaf52b7a63ef6039f32)), closes [#10656](https://github.com/vm0-ai/vm0/issues/10656)

## [0.92.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.91.1...runner-rs-v0.92.0) (2026-04-22)


### Features

* multi-mount artifact backend + checkpoint schema ([#10629](https://github.com/vm0-ai/vm0/issues/10629)) ([0f8af96](https://github.com/vm0-ai/vm0/commit/0f8af96cd55dedd89534ff430765cc34661a55fc))

## [0.91.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.91.0...runner-rs-v0.91.1) (2026-04-22)


### Refactoring

* **firewall:** remove graphql-specific rule support ([#10622](https://github.com/vm0-ai/vm0/issues/10622)) ([7654336](https://github.com/vm0-ai/vm0/commit/7654336d644fe7bdae7e9fcc49777c0f9aa4216b))

## [0.91.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.90.0...runner-rs-v0.91.0) (2026-04-22)


### Features

* **runner:** ship error logs to axiom via tracing layer ([#10576](https://github.com/vm0-ai/vm0/issues/10576)) ([4abb780](https://github.com/vm0-ai/vm0/commit/4abb780656c2423cd66791423128885aa9e7f053))


### Bug Fixes

* **mitm-addon:** stop load_registry log spam on sustained failure ([#10572](https://github.com/vm0-ai/vm0/issues/10572)) ([1d946a1](https://github.com/vm0-ai/vm0/commit/1d946a1b9074ac8e1116463c94191470ad065621))

## [0.90.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.89.3...runner-rs-v0.90.0) (2026-04-22)


### Features

* **mitm-addon:** vendor ijson pure-python backend ([#10533](https://github.com/vm0-ai/vm0/issues/10533)) ([fec03b3](https://github.com/vm0-ai/vm0/commit/fec03b31ec0766baff9d4e4b200d1d37f03a80a7))


### Documentation

* **mitm-addon:** clarify firewall_action vs firewall_error semantics ([#10540](https://github.com/vm0-ai/vm0/issues/10540)) ([c48046d](https://github.com/vm0-ai/vm0/commit/c48046d52203593a6e4f5e432a55a79660c74062))


### Refactoring

* **mitm-addon:** surface one-shot warnings for best-effort failures ([#10525](https://github.com/vm0-ai/vm0/issues/10525)) ([136cf1f](https://github.com/vm0-ai/vm0/commit/136cf1fa0ac2d9e4079015a26bc9103c3f3e7b49))
* **mitm-addon:** unify urllib cleanup on `with` blocks ([#10543](https://github.com/vm0-ai/vm0/issues/10543)) ([f319b55](https://github.com/vm0-ai/vm0/commit/f319b55a470d2460395e84042859063685b964dd)), closes [#10491](https://github.com/vm0-ai/vm0/issues/10491)

## [0.89.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.89.2...runner-rs-v0.89.3) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.89.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.89.1...runner-rs-v0.89.2) (2026-04-22)


### Bug Fixes

* **runner:** close urllib response in firewall auth fetch ([#10489](https://github.com/vm0-ai/vm0/issues/10489)) ([30a80ca](https://github.com/vm0-ai/vm0/commit/30a80caf4b598eb84dc39547b11378c56c6b5412))

## [0.89.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.89.0...runner-rs-v0.89.1) (2026-04-22)


### Bug Fixes

* **mitm-addon:** close urllib response and error in _forward_request_sync ([#10490](https://github.com/vm0-ai/vm0/issues/10490)) ([f65241b](https://github.com/vm0-ai/vm0/commit/f65241bb88d0dc333327685b25cc3b243db64406)), closes [#10476](https://github.com/vm0-ai/vm0/issues/10476)


### Refactoring

* **mitm-addon:** split usage.py into package with per-connector dispatch ([#10478](https://github.com/vm0-ai/vm0/issues/10478)) ([a9d9f14](https://github.com/vm0-ai/vm0/commit/a9d9f14b47de14a3c255b76e1d59e91cf4b2fe37))
* **runner:** make image gc top-n global across rootfs ([#10480](https://github.com/vm0-ai/vm0/issues/10480)) ([3ab0924](https://github.com/vm0-ai/vm0/commit/3ab09242f143ddbc62ad32ebbb2517ee3f0c5f9d))

## [0.89.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.6...runner-rs-v0.89.0) (2026-04-21)


### Features

* **runner:** emit vm_reuse telemetry for every reuse decision ([#10441](https://github.com/vm0-ai/vm0/issues/10441)) ([ac947c3](https://github.com/vm0-ai/vm0/commit/ac947c30e57b90312dfba90a2f8fd95a66e91ebe))


### Refactoring

* **billing:** unify connector billing gate on firewall_billable ([#10446](https://github.com/vm0-ai/vm0/issues/10446)) ([d8e23b9](https://github.com/vm0-ai/vm0/commit/d8e23b9b110b3979322ba44869a7cffe6cf289cf))

## [0.88.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.5...runner-rs-v0.88.6) (2026-04-21)

## [0.88.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.4...runner-rs-v0.88.5) (2026-04-21)


### Bug Fixes

* **billing:** gate model-provider proxy usage to vm0 meta-provider only ([#10406](https://github.com/vm0-ai/vm0/issues/10406)) ([8370578](https://github.com/vm0-ai/vm0/commit/8370578496b91bbaf3a79c0ae6f4c824aabf887c))

## [0.88.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.3...runner-rs-v0.88.4) (2026-04-21)


### Bug Fixes

* **runner:** pre-register signal handlers before slow startup ([#10419](https://github.com/vm0-ai/vm0/issues/10419)) ([9c3ec4d](https://github.com/vm0-ai/vm0/commit/9c3ec4daea8fc3f0843655a6b4bfd72519da8629)), closes [#10416](https://github.com/vm0-ai/vm0/issues/10416)

## [0.88.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.2...runner-rs-v0.88.3) (2026-04-21)


### Refactoring

* **firewalls:** drop redundant ref field, use name everywhere ([#10353](https://github.com/vm0-ai/vm0/issues/10353)) ([87cd67e](https://github.com/vm0-ai/vm0/commit/87cd67e6a1c47a0bf69f388907f317f4cdf52246))

## [0.88.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.1...runner-rs-v0.88.2) (2026-04-20)


### Bug Fixes

* **mitm-addon:** return after url rewrite forward failure ([#10351](https://github.com/vm0-ai/vm0/issues/10351)) ([143baf2](https://github.com/vm0-ai/vm0/commit/143baf210c2a255f9633fbe86411596a5d8a7a68)), closes [#10341](https://github.com/vm0-ai/vm0/issues/10341)

## [0.88.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.88.0...runner-rs-v0.88.1) (2026-04-20)


### Bug Fixes

* **firewall:** force-refresh oauth token when provider returns 401 ([#9860](https://github.com/vm0-ai/vm0/issues/9860)) ([#10294](https://github.com/vm0-ai/vm0/issues/10294)) ([96fcb01](https://github.com/vm0-ai/vm0/commit/96fcb01248e71bf5ce2ed24d7b6bfafd3ba1394f))

## [0.88.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.87.2...runner-rs-v0.88.0) (2026-04-20)


### Features

* **runner:** emit sandbox id and reuse result in completion payload ([#10303](https://github.com/vm0-ai/vm0/issues/10303)) ([a5699ac](https://github.com/vm0-ai/vm0/commit/a5699ac69c35971f6c419f21799a30caf9017893))


### Bug Fixes

* **runner:** tolerate runner-exit race in service drain/resume ([#10302](https://github.com/vm0-ai/vm0/issues/10302)) ([4e0be4c](https://github.com/vm0-ai/vm0/commit/4e0be4c01218fc143f01845f2370b1d40945537c))

## [0.87.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.87.1...runner-rs-v0.87.2) (2026-04-20)


### Bug Fixes

* **mitm-addon:** return decompressed bytes for empty-body frames ([#10293](https://github.com/vm0-ai/vm0/issues/10293)) ([d68f78f](https://github.com/vm0-ai/vm0/commit/d68f78f4b1973bd9d40d9725477b63801bc73582))
* **runner:** clean up stale .tmp file when systemd unit rename fails ([#10295](https://github.com/vm0-ai/vm0/issues/10295)) ([0bf5dcf](https://github.com/vm0-ai/vm0/commit/0bf5dcfb91e5778857a81deafca7a1e942ce8343))

## [0.87.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.87.0...runner-rs-v0.87.1) (2026-04-20)


### Bug Fixes

* **runner:** clarify stderr tracing init doc comment ([#10280](https://github.com/vm0-ai/vm0/issues/10280)) ([3e4f553](https://github.com/vm0-ai/vm0/commit/3e4f5531716430384f15910bfe55fbda43d1e283))

## [0.87.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.86.4...runner-rs-v0.87.0) (2026-04-20)


### Features

* **observability:** add startup and wrap-up latency telemetry ([#10257](https://github.com/vm0-ai/vm0/issues/10257)) ([33028a1](https://github.com/vm0-ai/vm0/commit/33028a10e8ad6218d0255ed69c9af8ba88f41f1a)), closes [#9936](https://github.com/vm0-ai/vm0/issues/9936)


### Bug Fixes

* **mitm-addon:** narrow webhook retry catch to retryable errors ([#10228](https://github.com/vm0-ai/vm0/issues/10228)) ([03ee3c8](https://github.com/vm0-ai/vm0/commit/03ee3c8be82672a545aae9cab9266df51715f9f4))
* **runner:** count dry-run bytes in gc_nested_images ([#10232](https://github.com/vm0-ai/vm0/issues/10232)) ([79910d7](https://github.com/vm0-ai/vm0/commit/79910d7272e954b04532fc6573276839c91f2f0b))
* **runner:** delay first interval tick to avoid racing discover_fut ([#10219](https://github.com/vm0-ai/vm0/issues/10219)) ([a7a3006](https://github.com/vm0-ai/vm0/commit/a7a30068caa0265e4572f0c81ade09465cfeaae1))

## [0.86.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.86.3...runner-rs-v0.86.4) (2026-04-20)

## [0.86.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.86.2...runner-rs-v0.86.3) (2026-04-20)


### Bug Fixes

* **mitm-addon:** use flow.request.scheme for original url ([#10180](https://github.com/vm0-ai/vm0/issues/10180)) ([4d01162](https://github.com/vm0-ai/vm0/commit/4d01162b0b8b00c644c52f99f1825d8e39a23859))


### Refactoring

* **mitm-addon:** tighten original_url invariant in response/error ([#10189](https://github.com/vm0-ai/vm0/issues/10189)) ([bf230ad](https://github.com/vm0-ai/vm0/commit/bf230add14c1d3b59ee96eb628c31c9822c123a9))

## [0.86.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.86.1...runner-rs-v0.86.2) (2026-04-19)


### Bug Fixes

* **mitm-addon:** enforce decompress_body memory cap for zstd ([#10144](https://github.com/vm0-ai/vm0/issues/10144)) ([8f77ac8](https://github.com/vm0-ai/vm0/commit/8f77ac8bd0420a95672485a862393c41db38df86))
* **mitm-addon:** log and short-circuit broken stream decompressors ([#10132](https://github.com/vm0-ai/vm0/issues/10132)) ([c82afd2](https://github.com/vm0-ai/vm0/commit/c82afd2b1ffdb9b09cdf62635995372476f680a2))

## [0.86.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.86.0...runner-rs-v0.86.1) (2026-04-19)


### Refactoring

* **mitm-addon:** remove remaining private-entry test sites ([#10101](https://github.com/vm0-ai/vm0/issues/10101)) ([#10112](https://github.com/vm0-ai/vm0/issues/10112)) ([9aadbed](https://github.com/vm0-ai/vm0/commit/9aadbedff1f8a7435a8bf2cb4addf03efe376f30))

## [0.86.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.85.4...runner-rs-v0.86.0) (2026-04-19)


### Features

* **firewall:** accept mixed {param}{literal} segments in url patterns ([#10081](https://github.com/vm0-ai/vm0/issues/10081)) ([2b58902](https://github.com/vm0-ai/vm0/commit/2b589020d004ed7a99b461ee32609534d02cda18))


### Refactoring

* **mitm-addon:** push usage tests from internal stubs to _opener ([#9991](https://github.com/vm0-ai/vm0/issues/9991)) ([#10097](https://github.com/vm0-ai/vm0/issues/10097)) ([c4f0f6a](https://github.com/vm0-ai/vm0/commit/c4f0f6ae88d859938946ad6ad0f48be8075f6da5))

## [0.85.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.85.3...runner-rs-v0.85.4) (2026-04-19)


### Refactoring

* **mitm-addon:** delete redundant tests and annotate kept assertions ([#9991](https://github.com/vm0-ai/vm0/issues/9991)) ([#10079](https://github.com/vm0-ai/vm0/issues/10079)) ([beaba54](https://github.com/vm0-ai/vm0/commit/beaba5468a40d64d7af2b8f7af8e6a637a926784))
* **mitm-addon:** promote shared fixtures and drop test-local flow mocks ([#10011](https://github.com/vm0-ai/vm0/issues/10011)) ([0eef5d9](https://github.com/vm0-ai/vm0/commit/0eef5d978d8cd39b06154f2618b62cda51b2a0a6))
* **mitm-addon:** rewrite dispatcher and usage-report tests with outcome assertions ([#9991](https://github.com/vm0-ai/vm0/issues/9991)) ([#10080](https://github.com/vm0-ai/vm0/issues/10080)) ([3015a32](https://github.com/vm0-ai/vm0/commit/3015a32fbf6e182c579ae068942b982a06d19d46))

## [0.85.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.85.2...runner-rs-v0.85.3) (2026-04-18)


### Bug Fixes

* **mitm-addon:** warn on log_proxy_entry write failure ([#10009](https://github.com/vm0-ai/vm0/issues/10009)) ([1ed578f](https://github.com/vm0-ai/vm0/commit/1ed578fc209a03eec76bd46ad53030fd74399eaf)), closes [#9932](https://github.com/vm0-ai/vm0/issues/9932)

## [0.85.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.85.1...runner-rs-v0.85.2) (2026-04-18)


### Bug Fixes

* **runner:** tighten ca file and directory permissions ([#9994](https://github.com/vm0-ai/vm0/issues/9994)) ([26f493a](https://github.com/vm0-ai/vm0/commit/26f493ab7ca585d18c46d160b61a8caf5e2a4ff0))


### Refactoring

* **mitm-addon:** use real mitmproxy fixtures in test_body_capture ([#9987](https://github.com/vm0-ai/vm0/issues/9987)) ([5389082](https://github.com/vm0-ai/vm0/commit/5389082069ab4443d0bcde85b40aa33797525a08))

## [0.85.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.85.0...runner-rs-v0.85.1) (2026-04-18)

## [0.85.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.84.0...runner-rs-v0.85.0) (2026-04-18)


### Features

* add test-oauth connector for end-to-end oauth testing ([#9878](https://github.com/vm0-ai/vm0/issues/9878)) ([e8be957](https://github.com/vm0-ai/vm0/commit/e8be957b65578f32d6ca87a6f1eb248ee5737726))


### Refactoring

* **ansible:** split deploy-runner.yml into build and promote ([#9890](https://github.com/vm0-ai/vm0/issues/9890)) ([5239678](https://github.com/vm0-ai/vm0/commit/5239678391428f9107436d40bbff8c5bb12af8c7))


### Performance Improvements

* **runner:** defer best-effort telemetry past provider.complete ([#9828](https://github.com/vm0-ai/vm0/issues/9828)) ([14fd7ae](https://github.com/vm0-ai/vm0/commit/14fd7ae194e6672535f3076527ed5f4ed0ba7aa8))

## [0.84.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.83.0...runner-rs-v0.84.0) (2026-04-17)


### Features

* **runner:** split drain and stop with stopping state and service resume ([#9817](https://github.com/vm0-ai/vm0/issues/9817)) ([148d5ea](https://github.com/vm0-ai/vm0/commit/148d5ea463e973494a1fb9a95659b70744c7569a))

## [0.83.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.82.4...runner-rs-v0.83.0) (2026-04-17)


### Features

* add auth.query support to firewall schema for query-parameter authentication ([#9583](https://github.com/vm0-ai/vm0/issues/9583)) ([c39727a](https://github.com/vm0-ai/vm0/commit/c39727abd12ddd86271294324cf352fe86f96658))
* add feature flag to control sandbox reuse logic ([#8987](https://github.com/vm0-ai/vm0/issues/8987)) ([e77a8a0](https://github.com/vm0-ai/vm0/commit/e77a8a0c2974d91786f11d7119d87ba8fe07a6dd))
* **runner:** inflate sandbox balloon when parked in idle pool ([#9118](https://github.com/vm0-ai/vm0/issues/9118)) ([628032d](https://github.com/vm0-ai/vm0/commit/628032dbf3543d3387b6559263c31ee273f24986))
* **runner:** observe per-call x api connector usage in mitmproxy addon ([#9511](https://github.com/vm0-ai/vm0/issues/9511)) ([1cf4a59](https://github.com/vm0-ai/vm0/commit/1cf4a595a8789b86d9ed5c2f29cba433a99f7dde))
* **runner:** parse x ndjson streams incrementally and bound buffer ([#9551](https://github.com/vm0-ai/vm0/issues/9551)) ([f82b20d](https://github.com/vm0-ai/vm0/commit/f82b20d50575ba3ea45651fcdde5732348a8bada))
* **runner:** per-job mitmproxy proxy log files ([#9239](https://github.com/vm0-ai/vm0/issues/9239)) ([1ea7fa4](https://github.com/vm0-ai/vm0/commit/1ea7fa4d2efc1418dc3ac3e6364793f35b8d0ff6)), closes [#9227](https://github.com/vm0-ai/vm0/issues/9227)
* **runner:** require --force for service stop/uninstall with active jobs ([#9093](https://github.com/vm0-ai/vm0/issues/9093)) ([399164e](https://github.com/vm0-ai/vm0/commit/399164e015d366fec791f1df7542387bb4c7c703))
* store connector billing in database via webhook ([#9678](https://github.com/vm0-ai/vm0/issues/9678)) ([105724f](https://github.com/vm0-ai/vm0/commit/105724f670637fdc16022907a97d0ab57b0b607c))


### Bug Fixes

* **billing:** trust parsed response counts for x connector billing ([#9644](https://github.com/vm0-ai/vm0/issues/9644)) ([321cbf0](https://github.com/vm0-ai/vm0/commit/321cbf0adeb46fa0943be991a0b4652fcf399e77)), closes [#9620](https://github.com/vm0-ai/vm0/issues/9620)
* **chat:** regenerate chat_messages migration and add eslint exceptions ([a5ee0da](https://github.com/vm0-ai/vm0/commit/a5ee0da96c7588faa573bbe7466b1d5ec516f4af))
* inject firewall for enabled connectors regardless of secret availability ([#9656](https://github.com/vm0-ai/vm0/issues/9656)) ([3f10868](https://github.com/vm0-ai/vm0/commit/3f108689ff2a595498d27c388726253085270bc6))
* kill child process on error paths to prevent orphans ([#9267](https://github.com/vm0-ai/vm0/issues/9267)) ([16b1686](https://github.com/vm0-ai/vm0/commit/16b1686449c1913184dba9c93195baff74d107b8))
* log directory iteration errors in gc instead of silently swallowing ([#9036](https://github.com/vm0-ai/vm0/issues/9036)) ([da6af3c](https://github.com/vm0-ai/vm0/commit/da6af3c67e7beaf4e9fdef5d28958f09cba62e56))
* log directory iteration errors instead of silently swallowing ([#9333](https://github.com/vm0-ai/vm0/issues/9333)) ([a48fdde](https://github.com/vm0-ai/vm0/commit/a48fdde6bfd523dd1593e23870eb8ea82f40d6b0)), closes [#9037](https://github.com/vm0-ai/vm0/issues/9037)
* **proxy:** add structured logging for model provider usage report lifecycle ([#9666](https://github.com/vm0-ai/vm0/issues/9666)) ([196d85a](https://github.com/vm0-ai/vm0/commit/196d85a0f1a31f0324ccded23593c8e2b66293ac))
* rely on keytool rpath for libjli.so in chroot invocations ([#9533](https://github.com/vm0-ai/vm0/issues/9533)) ([3b950af](https://github.com/vm0-ai/vm0/commit/3b950af12bd9dfd98d22123d57a4dc0affef9289)), closes [#9483](https://github.com/vm0-ai/vm0/issues/9483)
* **runner:** abort stdout drain task on wait_exit timeout or crash ([#9021](https://github.com/vm0-ai/vm0/issues/9021)) ([d6b021e](https://github.com/vm0-ai/vm0/commit/d6b021e5f97b432006e969efd45f3b29debb4909)), closes [#8970](https://github.com/vm0-ai/vm0/issues/8970)
* **runner:** add --protect-version flag to prevent gc from deleting deployed version ([#9260](https://github.com/vm0-ai/vm0/issues/9260)) ([40de60a](https://github.com/vm0-ai/vm0/commit/40de60afd78b0806d08650f80a5b2269b86df661))
* **runner:** add cached field to storage manifest for correct cleanup preservation ([#8993](https://github.com/vm0-ai/vm0/issues/8993)) ([d9db456](https://github.com/vm0-ai/vm0/commit/d9db4569ef6f86fdf46063d65a9aad34ca7a6b2a)), closes [#8982](https://github.com/vm0-ai/vm0/issues/8982)
* **runner:** add drop impl to kmsg handle to prevent task leak on early return ([#8958](https://github.com/vm0-ai/vm0/issues/8958)) ([64c26e6](https://github.com/vm0-ai/vm0/commit/64c26e6adf0785f74ff9217bfde1267a721d3b83))
* **runner:** add missing doc comment on init_tracing_stderr ([#9553](https://github.com/vm0-ai/vm0/issues/9553)) ([ba44fd4](https://github.com/vm0-ai/vm0/commit/ba44fd497e8d2bb51f721ea7fdbd69a6863e874a))
* **runner:** add upper-bound validation for profile resource limits ([#9015](https://github.com/vm0-ai/vm0/issues/9015)) ([d774aca](https://github.com/vm0-ai/vm0/commit/d774aca8bb1fa71635fdb15692378e634edc2d10)), closes [#9009](https://github.com/vm0-ai/vm0/issues/9009)
* **runner:** escape % in systemd values to prevent specifier expansion ([#9499](https://github.com/vm0-ai/vm0/issues/9499)) ([5eb4e12](https://github.com/vm0-ai/vm0/commit/5eb4e12fbe3fb652a0969c163357875ac1c25766))
* **runner:** escape quotes and backslashes in systemd env values ([#9467](https://github.com/vm0-ai/vm0/issues/9467)) ([b7b5f51](https://github.com/vm0-ai/vm0/commit/b7b5f5155e0e4dfadb16dfc74358d94c4dac9ff1))
* **runner:** handle quoted paths with spaces in parse_unit_config_path ([#9242](https://github.com/vm0-ai/vm0/issues/9242)) ([53cd507](https://github.com/vm0-ai/vm0/commit/53cd5070285654944ccb661f5f2d916a0cb6cf5e))
* **runner:** harden mitmproxy usage report flush during shutdown ([#9234](https://github.com/vm0-ai/vm0/issues/9234)) ([08e65c7](https://github.com/vm0-ai/vm0/commit/08e65c76b45358b387a48078320ceb5f19c19e32)), closes [#9228](https://github.com/vm0-ai/vm0/issues/9228)
* **runner:** include host kernel version in image hash ([#9305](https://github.com/vm0-ai/vm0/issues/9305)) ([b30bc7d](https://github.com/vm0-ai/vm0/commit/b30bc7d447bc88c5753f9d8c30b90c873ccb993d))
* **runner:** invalidate image cache and skip remote cache on deploy ([#9300](https://github.com/vm0-ai/vm0/issues/9300)) ([67ce548](https://github.com/vm0-ai/vm0/commit/67ce548f3f7a5feff97ba7f882562f5bfef200c6))
* **runner:** make build-rootfs.sh cleanup safe against umount failure ([#9528](https://github.com/vm0-ai/vm0/issues/9528)) ([7bf8952](https://github.com/vm0-ai/vm0/commit/7bf89529febd1cded732e7c388af1cfd5af17f66))
* **runner:** narrow is_lock_free error handling to avoid false-positive orphan warnings ([#9268](https://github.com/vm0-ai/vm0/issues/9268)) ([6806c8b](https://github.com/vm0-ai/vm0/commit/6806c8b30d83662636d695b51b259a28626120b6))
* **runner:** only count successfully removed locks in gc_orphaned_locks ([#9645](https://github.com/vm0-ai/vm0/issues/9645)) ([e364fa0](https://github.com/vm0-ai/vm0/commit/e364fa0150e38926c7a63d2f227f529c3fae1e99)), closes [#9585](https://github.com/vm0-ai/vm0/issues/9585)
* **runner:** remove claim file when job read or parse fails ([#9740](https://github.com/vm0-ai/vm0/issues/9740)) ([c5df0f6](https://github.com/vm0-ai/vm0/commit/c5df0f6c36b168f823b2fb2af4c708695731dabc)), closes [#9689](https://github.com/vm0-ai/vm0/issues/9689)
* **runner:** retry dnsmasq startup on port conflict ([#9257](https://github.com/vm0-ai/vm0/issues/9257)) ([3db33df](https://github.com/vm0-ai/vm0/commit/3db33df21828764734f5f0b2b30dbc6ee5303745)), closes [#9250](https://github.com/vm0-ai/vm0/issues/9250)
* **runner:** shell-quote exec arguments before joining ([#9052](https://github.com/vm0-ai/vm0/issues/9052)) ([44e0d4d](https://github.com/vm0-ai/vm0/commit/44e0d4d0c29146259acce856c3d6642a90441f6c))
* **runner:** stop poison job loop and unblock submitter on invalid job json ([#9748](https://github.com/vm0-ai/vm0/issues/9748)) ([4d4de58](https://github.com/vm0-ai/vm0/commit/4d4de5897dfc715b0b555c2c4e49a5f6c999b1d1))
* **runner:** switch log timestamps from elapsed-since-startup to wall-clock utc ([#9232](https://github.com/vm0-ai/vm0/issues/9232)) ([216f251](https://github.com/vm0-ai/vm0/commit/216f251989445c06e0b0b9e3335370bd2622cbd5))
* **runner:** use continue instead of break on /proc entry read error ([#9661](https://github.com/vm0-ai/vm0/issues/9661)) ([96fa8b5](https://github.com/vm0-ai/vm0/commit/96fa8b53199fa50ecc962cf9cbd8ac7d8574d1dd)), closes [#9657](https://github.com/vm0-ai/vm0/issues/9657)
* **runner:** use proper url parsing for .test tld check in doctor ([#9237](https://github.com/vm0-ai/vm0/issues/9237)) ([6f5dd87](https://github.com/vm0-ai/vm0/commit/6f5dd8707f850a4d1b0766ce3bd9b0ab83b0ca78))
* **runner:** validate --concurrency-factor in run_config before writing config ([#9653](https://github.com/vm0-ai/vm0/issues/9653)) ([4b5d0bb](https://github.com/vm0-ai/vm0/commit/4b5d0bbaf78219feceb2d55b492611825af76769)), closes [#9650](https://github.com/vm0-ai/vm0/issues/9650)
* **runner:** validate --group name to prevent path traversal ([#9104](https://github.com/vm0-ai/vm0/issues/9104)) ([b7e75dc](https://github.com/vm0-ai/vm0/commit/b7e75dc2f74419c441c6e62eda3db1bd3cf93f87)), closes [#9099](https://github.com/vm0-ai/vm0/issues/9099)
* **runner:** validate --runner-dirname to prevent path traversal ([#9134](https://github.com/vm0-ai/vm0/issues/9134)) ([b511508](https://github.com/vm0-ai/vm0/commit/b51150884503ecc81e3180737ea11ca12b46f127))
* **runner:** validate image_hash to prevent path traversal ([#9178](https://github.com/vm0-ai/vm0/issues/9178)) ([2e4d3e2](https://github.com/vm0-ai/vm0/commit/2e4d3e2adce1076161346f244ad00b8f8d308353))
* **runner:** verify ca landed in system bundle after inject-ca ([#9530](https://github.com/vm0-ai/vm0/issues/9530)) ([951aa87](https://github.com/vm0-ai/vm0/commit/951aa87ff5862db4e8df710677b6d61e9257bcec))
* **runner:** wait for proxy usage reports to flush before stopping mitmdump ([#9687](https://github.com/vm0-ai/vm0/issues/9687)) ([3518dcd](https://github.com/vm0-ai/vm0/commit/3518dcdfaf3f69fe16a618fa2b9069f9dfeabcab))
* **runner:** write systemd unit file atomically via tmp + rename ([#9503](https://github.com/vm0-ai/vm0/issues/9503)) ([c113be1](https://github.com/vm0-ai/vm0/commit/c113be117bce16402574be59a5073f3d2c650f50)), closes [#9471](https://github.com/vm0-ai/vm0/issues/9471)
* **security:** scope anthropic firewall to /v1/messages path prefix ([#9566](https://github.com/vm0-ai/vm0/issues/9566)) ([8e94112](https://github.com/vm0-ai/vm0/commit/8e9411224f069fa690edf6fb899e0679359d907a)), closes [#9560](https://github.com/vm0-ai/vm0/issues/9560)
* split r2 image cache to rootfs only with local snapshot creation ([#9461](https://github.com/vm0-ai/vm0/issues/9461)) ([417b864](https://github.com/vm0-ai/vm0/commit/417b864287b05d84295c5f6e28ce3f75e6289469))
* upgrade debug-level log to warn in gc read_to_string failure ([#9345](https://github.com/vm0-ai/vm0/issues/9345)) ([8a0813e](https://github.com/vm0-ai/vm0/commit/8a0813eb79ec673c22c0881bfec66e75986869c3)), closes [#9334](https://github.com/vm0-ai/vm0/issues/9334)


### Refactoring

* **chat:** decouple chat threads from runs with dedicated chat_messages table ([#9296](https://github.com/vm0-ai/vm0/issues/9296)) ([a5ee0da](https://github.com/vm0-ai/vm0/commit/a5ee0da96c7588faa573bbe7466b1d5ec516f4af))
* **firewalls:** make auth.headers optional in firewall schema ([#9617](https://github.com/vm0-ai/vm0/issues/9617)) ([657b74f](https://github.com/vm0-ai/vm0/commit/657b74fcb19080e58a61ec7d1005eec89a617627))
* **proxy:** return connector types instead of missing secret names in 424 response ([#9676](https://github.com/vm0-ai/vm0/issues/9676)) ([1de69bb](https://github.com/vm0-ai/vm0/commit/1de69bbc9648daf8447bb99027ffbf4b264b720f))
* **runner:** deduplicate guest state restore in executor ([#9289](https://github.com/vm0-ai/vm0/issues/9289)) ([fea8ef2](https://github.com/vm0-ai/vm0/commit/fea8ef2055cec702bd72bf488f711c4bafc20754))
* **runner:** make sandbox_id a first-class identity distinct from run_id ([#9555](https://github.com/vm0-ai/vm0/issues/9555)) ([9cfd2a8](https://github.com/vm0-ai/vm0/commit/9cfd2a8d239f1c54c3c8e25c9adb2759d9b12efa))
* **runner:** split image hash into rootfs_hash and snapshot_hash ([#9622](https://github.com/vm0-ai/vm0/issues/9622)) ([bbeaa44](https://github.com/vm0-ai/vm0/commit/bbeaa44f59d3066caa78348c45f98617fda18b02))
* **runner:** split mitm_addon.py into usage.py and body_utils.py ([#9478](https://github.com/vm0-ai/vm0/issues/9478)) ([7be4518](https://github.com/vm0-ai/vm0/commit/7be4518db26eeccad810c4d18b13f1b81c109975))
* **runner:** surface r2 gc pagination invariant violations as errors ([#9200](https://github.com/vm0-ai/vm0/issues/9200)) ([186405a](https://github.com/vm0-ai/vm0/commit/186405af8df8ceeba22cee0295e7cc6657d7d652))
* **runner:** unify runner-dirname and service-name validators ([#9319](https://github.com/vm0-ai/vm0/issues/9319)) ([4ffa81f](https://github.com/vm0-ai/vm0/commit/4ffa81f15546b49735cb58fd1aa55c9a862351a2)), closes [#9145](https://github.com/vm0-ai/vm0/issues/9145)
* use proxy-reported usage as billing source of truth ([#9064](https://github.com/vm0-ai/vm0/issues/9064)) ([b655964](https://github.com/vm0-ai/vm0/commit/b65596423f8655117ebd67c38731eb5f35c332b7))


### Performance Improvements

* **runner:** cache built images on r2 ([#9120](https://github.com/vm0-ai/vm0/issues/9120)) ([bf2f2cd](https://github.com/vm0-ai/vm0/commit/bf2f2cdeb2956cee5fc5f7466e147d1c4351d3d0))
* **runner:** offload dns and kmsg_log file i/o to blocking pool ([#9741](https://github.com/vm0-ai/vm0/issues/9741)) ([4858807](https://github.com/vm0-ai/vm0/commit/48588070b96a00256857abb90d790c5f43fdaa75))

## [0.82.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.82.3...runner-rs-v0.82.4) (2026-04-17)

## [0.82.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.82.2...runner-rs-v0.82.3) (2026-04-17)

## [0.82.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.82.1...runner-rs-v0.82.2) (2026-04-17)


### Bug Fixes

* **runner:** stop poison job loop and unblock submitter on invalid job json ([#9748](https://github.com/vm0-ai/vm0/issues/9748)) ([4d4de58](https://github.com/vm0-ai/vm0/commit/4d4de5897dfc715b0b555c2c4e49a5f6c999b1d1))

## [0.82.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.82.0...runner-rs-v0.82.1) (2026-04-17)


### Bug Fixes

* **runner:** remove claim file when job read or parse fails ([#9740](https://github.com/vm0-ai/vm0/issues/9740)) ([c5df0f6](https://github.com/vm0-ai/vm0/commit/c5df0f6c36b168f823b2fb2af4c708695731dabc)), closes [#9689](https://github.com/vm0-ai/vm0/issues/9689)


### Performance Improvements

* **runner:** offload dns and kmsg_log file i/o to blocking pool ([#9741](https://github.com/vm0-ai/vm0/issues/9741)) ([4858807](https://github.com/vm0-ai/vm0/commit/48588070b96a00256857abb90d790c5f43fdaa75))

## [0.82.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.81.4...runner-rs-v0.82.0) (2026-04-16)


### Features

* store connector billing in database via webhook ([#9678](https://github.com/vm0-ai/vm0/issues/9678)) ([105724f](https://github.com/vm0-ai/vm0/commit/105724f670637fdc16022907a97d0ab57b0b607c))


### Bug Fixes

* inject firewall for enabled connectors regardless of secret availability ([#9656](https://github.com/vm0-ai/vm0/issues/9656)) ([3f10868](https://github.com/vm0-ai/vm0/commit/3f108689ff2a595498d27c388726253085270bc6))
* **runner:** wait for proxy usage reports to flush before stopping mitmdump ([#9687](https://github.com/vm0-ai/vm0/issues/9687)) ([3518dcd](https://github.com/vm0-ai/vm0/commit/3518dcdfaf3f69fe16a618fa2b9069f9dfeabcab))


### Refactoring

* **proxy:** return connector types instead of missing secret names in 424 response ([#9676](https://github.com/vm0-ai/vm0/issues/9676)) ([1de69bb](https://github.com/vm0-ai/vm0/commit/1de69bbc9648daf8447bb99027ffbf4b264b720f))

## [0.81.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.81.3...runner-rs-v0.81.4) (2026-04-16)


### Bug Fixes

* **runner:** use continue instead of break on /proc entry read error ([#9661](https://github.com/vm0-ai/vm0/issues/9661)) ([96fa8b5](https://github.com/vm0-ai/vm0/commit/96fa8b53199fa50ecc962cf9cbd8ac7d8574d1dd)), closes [#9657](https://github.com/vm0-ai/vm0/issues/9657)
* **runner:** validate --concurrency-factor in run_config before writing config ([#9653](https://github.com/vm0-ai/vm0/issues/9653)) ([4b5d0bb](https://github.com/vm0-ai/vm0/commit/4b5d0bbaf78219feceb2d55b492611825af76769)), closes [#9650](https://github.com/vm0-ai/vm0/issues/9650)

## [0.81.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.81.2...runner-rs-v0.81.3) (2026-04-16)


### Bug Fixes

* **billing:** trust parsed response counts for x connector billing ([#9644](https://github.com/vm0-ai/vm0/issues/9644)) ([321cbf0](https://github.com/vm0-ai/vm0/commit/321cbf0adeb46fa0943be991a0b4652fcf399e77)), closes [#9620](https://github.com/vm0-ai/vm0/issues/9620)
* **runner:** only count successfully removed locks in gc_orphaned_locks ([#9645](https://github.com/vm0-ai/vm0/issues/9645)) ([e364fa0](https://github.com/vm0-ai/vm0/commit/e364fa0150e38926c7a63d2f227f529c3fae1e99)), closes [#9585](https://github.com/vm0-ai/vm0/issues/9585)

## [0.81.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.81.1...runner-rs-v0.81.2) (2026-04-16)


### Refactoring

* **firewalls:** make auth.headers optional in firewall schema ([#9617](https://github.com/vm0-ai/vm0/issues/9617)) ([657b74f](https://github.com/vm0-ai/vm0/commit/657b74fcb19080e58a61ec7d1005eec89a617627))
* **runner:** split image hash into rootfs_hash and snapshot_hash ([#9622](https://github.com/vm0-ai/vm0/issues/9622)) ([bbeaa44](https://github.com/vm0-ai/vm0/commit/bbeaa44f59d3066caa78348c45f98617fda18b02))

## [0.81.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.81.0...runner-rs-v0.81.1) (2026-04-16)


### Refactoring

* **runner:** make sandbox_id a first-class identity distinct from run_id ([#9555](https://github.com/vm0-ai/vm0/issues/9555)) ([9cfd2a8](https://github.com/vm0-ai/vm0/commit/9cfd2a8d239f1c54c3c8e25c9adb2759d9b12efa))

## [0.81.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.80.1...runner-rs-v0.81.0) (2026-04-16)


### Features

* add auth.query support to firewall schema for query-parameter authentication ([#9583](https://github.com/vm0-ai/vm0/issues/9583)) ([c39727a](https://github.com/vm0-ai/vm0/commit/c39727abd12ddd86271294324cf352fe86f96658))

## [0.80.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.80.0...runner-rs-v0.80.1) (2026-04-16)


### Bug Fixes

* **security:** scope anthropic firewall to /v1/messages path prefix ([#9566](https://github.com/vm0-ai/vm0/issues/9566)) ([8e94112](https://github.com/vm0-ai/vm0/commit/8e9411224f069fa690edf6fb899e0679359d907a)), closes [#9560](https://github.com/vm0-ai/vm0/issues/9560)

## [0.80.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.13...runner-rs-v0.80.0) (2026-04-16)


### Features

* **runner:** parse x ndjson streams incrementally and bound buffer ([#9551](https://github.com/vm0-ai/vm0/issues/9551)) ([f82b20d](https://github.com/vm0-ai/vm0/commit/f82b20d50575ba3ea45651fcdde5732348a8bada))

## [0.79.13](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.12...runner-rs-v0.79.13) (2026-04-15)


### Bug Fixes

* **runner:** add missing doc comment on init_tracing_stderr ([#9553](https://github.com/vm0-ai/vm0/issues/9553)) ([ba44fd4](https://github.com/vm0-ai/vm0/commit/ba44fd497e8d2bb51f721ea7fdbd69a6863e874a))

## [0.79.12](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.11...runner-rs-v0.79.12) (2026-04-15)


### Bug Fixes

* rely on keytool rpath for libjli.so in chroot invocations ([#9533](https://github.com/vm0-ai/vm0/issues/9533)) ([3b950af](https://github.com/vm0-ai/vm0/commit/3b950af12bd9dfd98d22123d57a4dc0affef9289)), closes [#9483](https://github.com/vm0-ai/vm0/issues/9483)
* **runner:** make build-rootfs.sh cleanup safe against umount failure ([#9528](https://github.com/vm0-ai/vm0/issues/9528)) ([7bf8952](https://github.com/vm0-ai/vm0/commit/7bf89529febd1cded732e7c388af1cfd5af17f66))

## [0.79.11](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.10...runner-rs-v0.79.11) (2026-04-15)


### Bug Fixes

* **runner:** verify ca landed in system bundle after inject-ca ([#9530](https://github.com/vm0-ai/vm0/issues/9530)) ([951aa87](https://github.com/vm0-ai/vm0/commit/951aa87ff5862db4e8df710677b6d61e9257bcec))

## [0.79.10](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.9...runner-rs-v0.79.10) (2026-04-15)


### Bug Fixes

* **runner:** escape % in systemd values to prevent specifier expansion ([#9499](https://github.com/vm0-ai/vm0/issues/9499)) ([5eb4e12](https://github.com/vm0-ai/vm0/commit/5eb4e12fbe3fb652a0969c163357875ac1c25766))

## [0.79.9](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.8...runner-rs-v0.79.9) (2026-04-15)


### Refactoring

* **runner:** split mitm_addon.py into usage.py and body_utils.py ([#9478](https://github.com/vm0-ai/vm0/issues/9478)) ([7be4518](https://github.com/vm0-ai/vm0/commit/7be4518db26eeccad810c4d18b13f1b81c109975))

## [0.79.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.7...runner-rs-v0.79.8) (2026-04-15)


### Bug Fixes

* **runner:** escape quotes and backslashes in systemd env values ([#9467](https://github.com/vm0-ai/vm0/issues/9467)) ([b7b5f51](https://github.com/vm0-ai/vm0/commit/b7b5f5155e0e4dfadb16dfc74358d94c4dac9ff1))
* split r2 image cache to rootfs only with local snapshot creation ([#9461](https://github.com/vm0-ai/vm0/issues/9461)) ([417b864](https://github.com/vm0-ai/vm0/commit/417b864287b05d84295c5f6e28ce3f75e6289469))

## [0.79.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.6...runner-rs-v0.79.7) (2026-04-14)


### Bug Fixes

* log directory iteration errors instead of silently swallowing ([#9333](https://github.com/vm0-ai/vm0/issues/9333)) ([a48fdde](https://github.com/vm0-ai/vm0/commit/a48fdde6bfd523dd1593e23870eb8ea82f40d6b0)), closes [#9037](https://github.com/vm0-ai/vm0/issues/9037)
* **runner:** include host kernel version in image hash ([#9305](https://github.com/vm0-ai/vm0/issues/9305)) ([b30bc7d](https://github.com/vm0-ai/vm0/commit/b30bc7d447bc88c5753f9d8c30b90c873ccb993d))
* upgrade debug-level log to warn in gc read_to_string failure ([#9345](https://github.com/vm0-ai/vm0/issues/9345)) ([8a0813e](https://github.com/vm0-ai/vm0/commit/8a0813eb79ec673c22c0881bfec66e75986869c3)), closes [#9334](https://github.com/vm0-ai/vm0/issues/9334)

## [0.79.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.5...runner-rs-v0.79.6) (2026-04-14)

## [0.79.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.4...runner-rs-v0.79.5) (2026-04-14)

## [0.79.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.3...runner-rs-v0.79.4) (2026-04-14)


### Bug Fixes

* kill child process on error paths to prevent orphans ([#9267](https://github.com/vm0-ai/vm0/issues/9267)) ([16b1686](https://github.com/vm0-ai/vm0/commit/16b1686449c1913184dba9c93195baff74d107b8))
* **runner:** invalidate image cache and skip remote cache on deploy ([#9300](https://github.com/vm0-ai/vm0/issues/9300)) ([67ce548](https://github.com/vm0-ai/vm0/commit/67ce548f3f7a5feff97ba7f882562f5bfef200c6))


### Refactoring

* **runner:** deduplicate guest state restore in executor ([#9289](https://github.com/vm0-ai/vm0/issues/9289)) ([fea8ef2](https://github.com/vm0-ai/vm0/commit/fea8ef2055cec702bd72bf488f711c4bafc20754))

## [0.79.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.2...runner-rs-v0.79.3) (2026-04-14)

## [0.79.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.1...runner-rs-v0.79.2) (2026-04-14)


### Bug Fixes

* **runner:** add --protect-version flag to prevent gc from deleting deployed version ([#9260](https://github.com/vm0-ai/vm0/issues/9260)) ([40de60a](https://github.com/vm0-ai/vm0/commit/40de60afd78b0806d08650f80a5b2269b86df661))

## [0.79.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.0...runner-rs-v0.79.1) (2026-04-14)


### Bug Fixes

* **runner:** retry dnsmasq startup on port conflict ([#9257](https://github.com/vm0-ai/vm0/issues/9257)) ([3db33df](https://github.com/vm0-ai/vm0/commit/3db33df21828764734f5f0b2b30dbc6ee5303745)), closes [#9250](https://github.com/vm0-ai/vm0/issues/9250)

## [0.79.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.3...runner-rs-v0.79.0) (2026-04-14)


### Features

* **runner:** per-job mitmproxy proxy log files ([#9239](https://github.com/vm0-ai/vm0/issues/9239)) ([1ea7fa4](https://github.com/vm0-ai/vm0/commit/1ea7fa4d2efc1418dc3ac3e6364793f35b8d0ff6)), closes [#9227](https://github.com/vm0-ai/vm0/issues/9227)


### Bug Fixes

* **runner:** harden mitmproxy usage report flush during shutdown ([#9234](https://github.com/vm0-ai/vm0/issues/9234)) ([08e65c7](https://github.com/vm0-ai/vm0/commit/08e65c76b45358b387a48078320ceb5f19c19e32)), closes [#9228](https://github.com/vm0-ai/vm0/issues/9228)

## [0.78.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.2...runner-rs-v0.78.3) (2026-04-14)


### Bug Fixes

* **runner:** switch log timestamps from elapsed-since-startup to wall-clock utc ([#9232](https://github.com/vm0-ai/vm0/issues/9232)) ([216f251](https://github.com/vm0-ai/vm0/commit/216f251989445c06e0b0b9e3335370bd2622cbd5))
* **runner:** use proper url parsing for .test tld check in doctor ([#9237](https://github.com/vm0-ai/vm0/issues/9237)) ([6f5dd87](https://github.com/vm0-ai/vm0/commit/6f5dd8707f850a4d1b0766ce3bd9b0ab83b0ca78))

## [0.78.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.1...runner-rs-v0.78.2) (2026-04-13)


### Refactoring

* **runner:** surface r2 gc pagination invariant violations as errors ([#9200](https://github.com/vm0-ai/vm0/issues/9200)) ([186405a](https://github.com/vm0-ai/vm0/commit/186405af8df8ceeba22cee0295e7cc6657d7d652))

## [0.78.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.0...runner-rs-v0.78.1) (2026-04-13)


### Bug Fixes

* **runner:** validate image_hash to prevent path traversal ([#9178](https://github.com/vm0-ai/vm0/issues/9178)) ([2e4d3e2](https://github.com/vm0-ai/vm0/commit/2e4d3e2adce1076161346f244ad00b8f8d308353))

## [0.78.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.77.1...runner-rs-v0.78.0) (2026-04-13)


### Features

* **runner:** inflate sandbox balloon when parked in idle pool ([#9118](https://github.com/vm0-ai/vm0/issues/9118)) ([628032d](https://github.com/vm0-ai/vm0/commit/628032dbf3543d3387b6559263c31ee273f24986))


### Bug Fixes

* **runner:** validate --runner-dirname to prevent path traversal ([#9134](https://github.com/vm0-ai/vm0/issues/9134)) ([b511508](https://github.com/vm0-ai/vm0/commit/b51150884503ecc81e3180737ea11ca12b46f127))


### Performance Improvements

* **runner:** cache built images on r2 ([#9120](https://github.com/vm0-ai/vm0/issues/9120)) ([bf2f2cd](https://github.com/vm0-ai/vm0/commit/bf2f2cdeb2956cee5fc5f7466e147d1c4351d3d0))

## [0.77.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.77.0...runner-rs-v0.77.1) (2026-04-13)


### Bug Fixes

* **runner:** validate --group name to prevent path traversal ([#9104](https://github.com/vm0-ai/vm0/issues/9104)) ([b7e75dc](https://github.com/vm0-ai/vm0/commit/b7e75dc2f74419c441c6e62eda3db1bd3cf93f87)), closes [#9099](https://github.com/vm0-ai/vm0/issues/9099)

## [0.77.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.4...runner-rs-v0.77.0) (2026-04-13)


### Features

* **runner:** require --force for service stop/uninstall with active jobs ([#9093](https://github.com/vm0-ai/vm0/issues/9093)) ([399164e](https://github.com/vm0-ai/vm0/commit/399164e015d366fec791f1df7542387bb4c7c703))

## [0.76.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.3...runner-rs-v0.76.4) (2026-04-13)


### Bug Fixes

* **runner:** shell-quote exec arguments before joining ([#9052](https://github.com/vm0-ai/vm0/issues/9052)) ([44e0d4d](https://github.com/vm0-ai/vm0/commit/44e0d4d0c29146259acce856c3d6642a90441f6c))


### Refactoring

* use proxy-reported usage as billing source of truth ([#9064](https://github.com/vm0-ai/vm0/issues/9064)) ([b655964](https://github.com/vm0-ai/vm0/commit/b65596423f8655117ebd67c38731eb5f35c332b7))

## [0.76.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.2...runner-rs-v0.76.3) (2026-04-13)

## [0.76.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.1...runner-rs-v0.76.2) (2026-04-12)


### Bug Fixes

* log directory iteration errors in gc instead of silently swallowing ([#9036](https://github.com/vm0-ai/vm0/issues/9036)) ([da6af3c](https://github.com/vm0-ai/vm0/commit/da6af3c67e7beaf4e9fdef5d28958f09cba62e56))

## [0.76.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.0...runner-rs-v0.76.1) (2026-04-12)


### Bug Fixes

* **runner:** abort stdout drain task on wait_exit timeout or crash ([#9021](https://github.com/vm0-ai/vm0/issues/9021)) ([d6b021e](https://github.com/vm0-ai/vm0/commit/d6b021e5f97b432006e969efd45f3b29debb4909)), closes [#8970](https://github.com/vm0-ai/vm0/issues/8970)

## [0.76.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.75.2...runner-rs-v0.76.0) (2026-04-12)


### Features

* add feature flag to control sandbox reuse logic ([#8987](https://github.com/vm0-ai/vm0/issues/8987)) ([e77a8a0](https://github.com/vm0-ai/vm0/commit/e77a8a0c2974d91786f11d7119d87ba8fe07a6dd))


### Bug Fixes

* **runner:** add cached field to storage manifest for correct cleanup preservation ([#8993](https://github.com/vm0-ai/vm0/issues/8993)) ([d9db456](https://github.com/vm0-ai/vm0/commit/d9db4569ef6f86fdf46063d65a9aad34ca7a6b2a)), closes [#8982](https://github.com/vm0-ai/vm0/issues/8982)
* **runner:** add upper-bound validation for profile resource limits ([#9015](https://github.com/vm0-ai/vm0/issues/9015)) ([d774aca](https://github.com/vm0-ai/vm0/commit/d774aca8bb1fa71635fdb15692378e634edc2d10)), closes [#9009](https://github.com/vm0-ai/vm0/issues/9009)

## [0.75.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.75.1...runner-rs-v0.75.2) (2026-04-11)


### Bug Fixes

* **runner:** add drop impl to kmsg handle to prevent task leak on early return ([#8958](https://github.com/vm0-ai/vm0/issues/8958)) ([64c26e6](https://github.com/vm0-ai/vm0/commit/64c26e6adf0785f74ff9217bfde1267a721d3b83))

## [0.75.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.75.0...runner-rs-v0.75.1) (2026-04-11)


### Bug Fixes

* align mitmproxy permission matching with frontend contract ([#8943](https://github.com/vm0-ai/vm0/issues/8943)) ([e4273a0](https://github.com/vm0-ai/vm0/commit/e4273a0fa8b7a06ffd1ef208ed15bd164e15bf31))

## [0.75.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.74.2...runner-rs-v0.75.0) (2026-04-10)


### Features

* **credit:** record anthropic message id in proxy_credit_usage ([#8919](https://github.com/vm0-ai/vm0/issues/8919)) ([7bfe376](https://github.com/vm0-ai/vm0/commit/7bfe376274a4702cb116c90c9fa816307fee6f02)), closes [#8909](https://github.com/vm0-ai/vm0/issues/8909)


### Refactoring

* **mitm-addon:** extract shared api request builder for platform calls ([#8913](https://github.com/vm0-ai/vm0/issues/8913)) ([dd9a683](https://github.com/vm0-ai/vm0/commit/dd9a68382a4f012ab532838e4bdce931fab13cb8)), closes [#8885](https://github.com/vm0-ai/vm0/issues/8885)
* **runner:** unify rootfs and snapshot into single image artifact ([#8821](https://github.com/vm0-ai/vm0/issues/8821)) ([a549299](https://github.com/vm0-ai/vm0/commit/a549299c1c10179b49783288e869f82739b58033))

## [0.74.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.74.1...runner-rs-v0.74.2) (2026-04-10)


### Bug Fixes

* **mitm-addon:** decompress sse stream before usage extraction ([#8903](https://github.com/vm0-ai/vm0/issues/8903)) ([28fd00c](https://github.com/vm0-ai/vm0/commit/28fd00ce66339d0b50854628dd4b5049a5b02ce5))
* **mitm-addon:** replace --quiet with flow_detail=0 + termlog_verbosity=warn ([#8896](https://github.com/vm0-ai/vm0/issues/8896)) ([7d95d9c](https://github.com/vm0-ai/vm0/commit/7d95d9cb6672d579b7b76710b899c0a79a53607a)), closes [#8882](https://github.com/vm0-ai/vm0/issues/8882)
* **runner:** drop discover future before shutdown to prevent mutex deadlock ([#8898](https://github.com/vm0-ai/vm0/issues/8898)) ([54460c1](https://github.com/vm0-ai/vm0/commit/54460c11249d009b06e50ced82ce45b5086932c5))

## [0.74.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.74.0...runner-rs-v0.74.1) (2026-04-10)


### Refactoring

* **firewalls:** cache graphql field coverage check per api entry ([#8839](https://github.com/vm0-ai/vm0/issues/8839)) ([f716aef](https://github.com/vm0-ai/vm0/commit/f716aefcfd219856adf314b1fa836771760624f5)), closes [#8816](https://github.com/vm0-ai/vm0/issues/8816)

## [0.74.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.73.0...runner-rs-v0.74.0) (2026-04-10)


### Features

* **firewalls:** include denied permission names in firewall block response ([#8815](https://github.com/vm0-ai/vm0/issues/8815)) ([b276ebf](https://github.com/vm0-ai/vm0/commit/b276ebfc0b06bf816d6b3ba250e400ba574182b0))

## [0.73.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.72.1...runner-rs-v0.73.0) (2026-04-10)


### Features

* **runner:** clean stale files on vm reuse before downloading storages ([#8800](https://github.com/vm0-ai/vm0/issues/8800)) ([4725751](https://github.com/vm0-ai/vm0/commit/4725751f5ff9b6f4b7b1c1294b6efbc48bc005b1)), closes [#8757](https://github.com/vm0-ai/vm0/issues/8757)
* **runner:** pass feature switch states through execution context ([#8778](https://github.com/vm0-ai/vm0/issues/8778)) ([edbe85c](https://github.com/vm0-ai/vm0/commit/edbe85ca3f0fb81821aeeb609a0a700fcbd137e8))


### Bug Fixes

* **runner:** pin discover future to prevent heartbeat cancellation ([#8747](https://github.com/vm0-ai/vm0/issues/8747)) ([#8783](https://github.com/vm0-ai/vm0/issues/8783)) ([31603cd](https://github.com/vm0-ai/vm0/commit/31603cd3db27475a94d2cdd2f4272e8cc5ed403b))
* **runner:** prevent message_delta from overwriting proxy usage with zeros ([#8805](https://github.com/vm0-ai/vm0/issues/8805)) ([3e143a4](https://github.com/vm0-ai/vm0/commit/3e143a476b31ae972fb3079316a3c28855ac79e5)), closes [#8796](https://github.com/vm0-ai/vm0/issues/8796)
* **runner:** prevent proxy billing data loss from error flows and shutdown ([#8772](https://github.com/vm0-ai/vm0/issues/8772)) ([4fd963d](https://github.com/vm0-ai/vm0/commit/4fd963d88add04850674522f635e2540dbad3953))

## [0.72.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.72.0...runner-rs-v0.72.1) (2026-04-10)

## [0.72.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.71.0...runner-rs-v0.72.0) (2026-04-09)


### Features

* **firewalls:** add deny and ask lists to granted permissions schema ([#8719](https://github.com/vm0-ai/vm0/issues/8719)) ([5a02f38](https://github.com/vm0-ai/vm0/commit/5a02f389160a6cbf961656798fe353ca029c2ece))
* **runner:** read guest session id for first-run vm parking ([#8731](https://github.com/vm0-ai/vm0/issues/8731)) ([9bdcda9](https://github.com/vm0-ai/vm0/commit/9bdcda9c5e2bb5af853696c19661862ab0f000b6))


### Refactoring

* **firewalls:** change allow-unknown from boolean to policy value ([#8733](https://github.com/vm0-ai/vm0/issues/8733)) ([4e2bea3](https://github.com/vm0-ai/vm0/commit/4e2bea3758707b157bf28162ee815da2129c5f32))
* **firewalls:** rename granted-permissions to network-policies ([#8740](https://github.com/vm0-ai/vm0/issues/8740)) ([2ad2c5c](https://github.com/vm0-ai/vm0/commit/2ad2c5ce175d98304adcb5a43770df3d9d5ee9d2)), closes [#8738](https://github.com/vm0-ai/vm0/issues/8738)


### Performance Improvements

* **runner:** skip storage re-download when artifact version unchanged ([#8743](https://github.com/vm0-ai/vm0/issues/8743)) ([8b8175c](https://github.com/vm0-ai/vm0/commit/8b8175c72da3b5e71911fe072aa5c70bba0e0e46))

## [0.71.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.70.2...runner-rs-v0.71.0) (2026-04-09)


### Features

* **firewalls:** add granted permissions for three-level matching ([#8621](https://github.com/vm0-ai/vm0/issues/8621)) ([534ec85](https://github.com/vm0-ai/vm0/commit/534ec85c209f52c7388bd9819b72017bb8be6cd9))

## [0.70.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.70.1...runner-rs-v0.70.2) (2026-04-09)

## [0.70.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.70.0...runner-rs-v0.70.1) (2026-04-09)


### Bug Fixes

* **firewalls:** skip __typename in graphql field coverage check ([#8642](https://github.com/vm0-ai/vm0/issues/8642)) ([306f85b](https://github.com/vm0-ai/vm0/commit/306f85b60edec8b2dec1823c67f85b4554956369))
* **runner:** clean up residual transient systemd units before service start ([#8645](https://github.com/vm0-ai/vm0/issues/8645)) ([a14b1db](https://github.com/vm0-ai/vm0/commit/a14b1db39b56657b0108475f6da95827345f0152)), closes [#8640](https://github.com/vm0-ai/vm0/issues/8640)

## [0.70.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.69.0...runner-rs-v0.70.0) (2026-04-09)


### Features

* **billing:** add proxy-side usage extraction for billing verification ([#8581](https://github.com/vm0-ai/vm0/issues/8581)) ([87f5049](https://github.com/vm0-ai/vm0/commit/87f5049ab3eb8e4aaa26537f412b628d0f687bc6))
* **firewalls:** support comma-separated field values in graphql rules ([#8549](https://github.com/vm0-ai/vm0/issues/8549)) ([e9cda88](https://github.com/vm0-ai/vm0/commit/e9cda88fbb87f4df7a47922e2e63b2c55f7e2de2))


### Bug Fixes

* **firewalls:** require all graphql fields to be covered by permissions ([#8599](https://github.com/vm0-ai/vm0/issues/8599)) ([7f8c21b](https://github.com/vm0-ai/vm0/commit/7f8c21b4a0d77a19e05fe18175f9b77fd4949ce6))
* **runner:** send immediate heartbeat after vm park and exclude idle vms from running count ([#8626](https://github.com/vm0-ai/vm0/issues/8626)) ([71d340d](https://github.com/vm0-ai/vm0/commit/71d340d540f546ef008671830aca970eaf00158d))

## [0.69.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.68.0...runner-rs-v0.69.0) (2026-04-08)


### Features

* **firewall:** add graphql field path parser with nested selection support ([#8520](https://github.com/vm0-ai/vm0/issues/8520)) ([7665bee](https://github.com/vm0-ai/vm0/commit/7665bee9864a351c1298e42066a2fe7019c0bcec))


### Refactoring

* **proxy:** replace blind streaming with buffered stream callback ([#8514](https://github.com/vm0-ai/vm0/issues/8514)) ([552cd0c](https://github.com/vm0-ai/vm0/commit/552cd0ceb3de240f97c0ffa5013e7da32b80857b))

## [0.68.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.67.1...runner-rs-v0.68.0) (2026-04-08)


### Features

* **firewalls:** add graphql field modifier for rule matching ([#8476](https://github.com/vm0-ai/vm0/issues/8476)) ([82b2049](https://github.com/vm0-ai/vm0/commit/82b20493e48325cbc75ecc431a74e8254096e46a))
* **platform:** capture response headers and mark binary bodies in network logs ([#8481](https://github.com/vm0-ai/vm0/issues/8481)) ([6a778f8](https://github.com/vm0-ai/vm0/commit/6a778f8ebbd88e2bd95a4d79a5e4ed1e4c3f4f26))
* **runner:** add smart dispatch with session affinity and targeted ably push ([#8474](https://github.com/vm0-ai/vm0/issues/8474)) ([65dbe3a](https://github.com/vm0-ai/vm0/commit/65dbe3af2795aa2730a3df28e84e3572fc8a46cc)), closes [#8368](https://github.com/vm0-ai/vm0/issues/8368)


### Bug Fixes

* **proxy:** remove firewall terminology from error responses ([#8486](https://github.com/vm0-ai/vm0/issues/8486)) ([a8292d5](https://github.com/vm0-ai/vm0/commit/a8292d585528abecfb03d7bfa15ca33e31b319cb)), closes [#8483](https://github.com/vm0-ai/vm0/issues/8483)
* **slack:** skip channel context fetch for dm conversations ([#8475](https://github.com/vm0-ai/vm0/issues/8475)) ([07a3321](https://github.com/vm0-ai/vm0/commit/07a33216d0a47047b341a0784324cb71b596a7f4))

## [0.67.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.67.0...runner-rs-v0.67.1) (2026-04-08)

## [0.67.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.66.0...runner-rs-v0.67.0) (2026-04-07)


### Features

* **runner:** add runner state reporting via heartbeat ([#8367](https://github.com/vm0-ai/vm0/issues/8367)) ([#8380](https://github.com/vm0-ai/vm0/issues/8380)) ([2dea967](https://github.com/vm0-ai/vm0/commit/2dea96701d28d963e74816908517519d1b55c939))

## [0.66.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.65.1...runner-rs-v0.66.0) (2026-04-07)


### Features

* **proxy:** add opt-in http body capture to mitmproxy addon ([#8349](https://github.com/vm0-ai/vm0/issues/8349)) ([95709fb](https://github.com/vm0-ai/vm0/commit/95709fb721befedd489025c39124b3663226d3f9))

## [0.65.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.65.0...runner-rs-v0.65.1) (2026-04-07)


### Bug Fixes

* **runner:** clean up stale guest log files on keep-alive vm reuse ([#8308](https://github.com/vm0-ai/vm0/issues/8308)) ([#8333](https://github.com/vm0-ai/vm0/issues/8333)) ([775f09b](https://github.com/vm0-ai/vm0/commit/775f09b0577fe17d1cbc39e58ba93d45277be60a))

## [0.65.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.64.0...runner-rs-v0.65.0) (2026-04-07)


### Features

* **runner:** keep-alive sandbox across conversation turns ([#8314](https://github.com/vm0-ai/vm0/issues/8314)) ([867a830](https://github.com/vm0-ai/vm0/commit/867a83056cd893988780aed3d8d6d49836e12e29))

## [0.64.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.63.1...runner-rs-v0.64.0) (2026-04-07)


### Features

* **gc:** add orphaned workspace cleanup to runner gc ([#8272](https://github.com/vm0-ai/vm0/issues/8272)) ([5614af3](https://github.com/vm0-ai/vm0/commit/5614af3febcd7a49a0f84aa8023c9a56046346bd))

## [0.63.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.63.0...runner-rs-v0.63.1) (2026-04-06)


### Refactoring

* **nbd:** deduplicate nbds_max, add concurrent test and bitmap assertion ([#8228](https://github.com/vm0-ai/vm0/issues/8228)) ([c0b98df](https://github.com/vm0-ai/vm0/commit/c0b98df3eb69ec81b26373d23d093a9526839752))

## [0.63.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.62.2...runner-rs-v0.63.0) (2026-04-06)


### Features

* **crates:** add guest-reseed for post-snapshot entropy injection ([#8215](https://github.com/vm0-ai/vm0/issues/8215)) ([c9a9005](https://github.com/vm0-ai/vm0/commit/c9a9005a05398f787d7e9dbe2f591b51b44bbab9))

## [0.62.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.62.1...runner-rs-v0.62.2) (2026-04-06)


### Bug Fixes

* **runner:** flush tokio file in drain_stdout_to_file to prevent data loss ([#8216](https://github.com/vm0-ai/vm0/issues/8216)) ([b19f692](https://github.com/vm0-ai/vm0/commit/b19f692c39046a3c0614e0c1c23de82b5af9a8b7))

## [0.62.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.62.0...runner-rs-v0.62.1) (2026-04-04)


### Bug Fixes

* add dnsmasq to system dependency check and doctor diagnostics ([#8065](https://github.com/vm0-ai/vm0/issues/8065)) ([6a7a0f8](https://github.com/vm0-ai/vm0/commit/6a7a0f8fa8939671d7b4d678df4aea49dd7fcbbe))


### Performance Improvements

* **runner:** replace docker build with debootstrap for rootfs creation ([#8042](https://github.com/vm0-ai/vm0/issues/8042)) ([41e932a](https://github.com/vm0-ai/vm0/commit/41e932aacb06a8a10234b1eb5219f90e84135917))

## [0.62.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.4...runner-rs-v0.62.0) (2026-04-03)


### Features

* add dns proxy for sandbox vms using dnsmasq ([#8020](https://github.com/vm0-ai/vm0/issues/8020)) ([5699f8d](https://github.com/vm0-ai/vm0/commit/5699f8dbb9008422dfe1753a2b127a6f9c100f59))


### Bug Fixes

* inject /etc/hosts and fix postgresql socket dir in sandbox rootfs ([#8012](https://github.com/vm0-ai/vm0/issues/8012)) ([6ba0f2f](https://github.com/vm0-ai/vm0/commit/6ba0f2fff333c57c85c90d1a7dad57dcc65f338b))

## [0.61.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.3...runner-rs-v0.61.4) (2026-04-03)


### Bug Fixes

* ensure python, java, and rust trust proxy ca in sandbox rootfs ([#7890](https://github.com/vm0-ai/vm0/issues/7890)) ([c697dca](https://github.com/vm0-ai/vm0/commit/c697dca25e38610ff83629c326170b110bfa678f))

## [0.61.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.2...runner-rs-v0.61.3) (2026-04-03)


### Performance Improvements

* **runner:** consolidate dockerfile apt-get update calls ([#7858](https://github.com/vm0-ai/vm0/issues/7858)) ([ab41e8e](https://github.com/vm0-ai/vm0/commit/ab41e8ecf8c21b45f701ffbe8260ec6fcf2af5cc))

## [0.61.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.1...runner-rs-v0.61.2) (2026-04-03)


### Refactoring

* centralize /etc/environment in build-rootfs.sh ([#7825](https://github.com/vm0-ai/vm0/issues/7825)) ([fbe263b](https://github.com/vm0-ai/vm0/commit/fbe263bcdbb5eac69be6583711589be82830af32))

## [0.61.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.0...runner-rs-v0.61.1) (2026-04-03)


### Bug Fixes

* **runner:** warn instead of failing when gc cannot remove snapshot ([#7808](https://github.com/vm0-ai/vm0/issues/7808)) ([c349213](https://github.com/vm0-ai/vm0/commit/c349213828a6ebe80a116e5a75b265dca4168f18))

## [0.61.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.60.0...runner-rs-v0.61.0) (2026-04-03)


### Features

* upgrade sandbox rootfs to ubuntu 24.04 with expanded runtime support ([#7741](https://github.com/vm0-ai/vm0/issues/7741)) ([8f8eba2](https://github.com/vm0-ai/vm0/commit/8f8eba24ef811741525b4040f6955e23d0fa99b3))


### Bug Fixes

* **runner:** also write tz to /etc/environment for system-wide inheritance ([#7762](https://github.com/vm0-ai/vm0/issues/7762)) ([70fb861](https://github.com/vm0-ai/vm0/commit/70fb861daef84cd7085ccd7259d3386cf15371b4)), closes [#7744](https://github.com/vm0-ai/vm0/issues/7744)

## [0.60.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.59.1...runner-rs-v0.60.0) (2026-04-02)


### Features

* **runner:** log rootfs logical and disk size after build ([#7784](https://github.com/vm0-ai/vm0/issues/7784)) ([225cca9](https://github.com/vm0-ai/vm0/commit/225cca9aba32163c13e866ca8bc4c77d53b25506))
* support graphql operation-level firewall rules ([#7719](https://github.com/vm0-ai/vm0/issues/7719)) ([ff23d7f](https://github.com/vm0-ai/vm0/commit/ff23d7f8717ee7fcb39546a1c8e20d8a091f9df4))

## [0.59.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.59.0...runner-rs-v0.59.1) (2026-04-02)

## [0.59.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.58.0...runner-rs-v0.59.0) (2026-04-02)


### Features

* **runner:** sync system timezone files in guest before agent start ([#7716](https://github.com/vm0-ai/vm0/issues/7716)) ([64e2484](https://github.com/vm0-ai/vm0/commit/64e2484503a0061955335dbe3a77b4caa3e98638))

## [0.58.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.57.0...runner-rs-v0.58.0) (2026-04-02)


### Features

* **runner:** increase default vm resources and add configurable disk size ([#7691](https://github.com/vm0-ai/vm0/issues/7691)) ([b928eb1](https://github.com/vm0-ai/vm0/commit/b928eb1a51e7759ba87c52577f323e0004bd4c8f))


### Refactoring

* split mitm_addon.py into focused modules with build.rs auto-scan ([#7688](https://github.com/vm0-ai/vm0/issues/7688)) ([aed758d](https://github.com/vm0-ai/vm0/commit/aed758dc817024a874531fbc2d99b2a58ffdded2)), closes [#7671](https://github.com/vm0-ai/vm0/issues/7671)

## [0.57.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.3...runner-rs-v0.57.0) (2026-04-02)


### Features

* add auth.base url rewriting for webhook-url firewall connectors ([#7618](https://github.com/vm0-ai/vm0/issues/7618)) ([55585ac](https://github.com/vm0-ai/vm0/commit/55585ac37db6938508ca957f83725389157c55da))

## [0.56.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.2...runner-rs-v0.56.3) (2026-04-02)

## [0.56.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.1...runner-rs-v0.56.2) (2026-04-01)


### Bug Fixes

* **nbd-cow:** guard disconnect against device index recycling by other runners ([#7581](https://github.com/vm0-ai/vm0/issues/7581)) ([ed9e572](https://github.com/vm0-ai/vm0/commit/ed9e572a80514236aada53eb68b2e9ad069ec7d2))

## [0.56.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.0...runner-rs-v0.56.1) (2026-04-01)


### Bug Fixes

* **nbd-cow:** advertise flush/trim flags and harden i/o paths ([#7539](https://github.com/vm0-ai/vm0/issues/7539)) ([6410e3e](https://github.com/vm0-ai/vm0/commit/6410e3ebc7652ba6f2da8edf14928346e70b7fb2))


### Refactoring

* rename experimental firewalls to firewalls ([#7553](https://github.com/vm0-ai/vm0/issues/7553)) ([e3c35a9](https://github.com/vm0-ai/vm0/commit/e3c35a95bd0dbfd1d68aef910db6089e38d6a0bb))

## [0.56.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.55.0...runner-rs-v0.56.0) (2026-04-01)


### Features

* **sandbox-fc:** replace dm-snapshot with nbd-cow ([#7406](https://github.com/vm0-ai/vm0/issues/7406)) ([bc60c4b](https://github.com/vm0-ai/vm0/commit/bc60c4b01eaac368f7434d367784855b0b50479b))

## [0.55.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.54.0...runner-rs-v0.55.0) (2026-04-01)


### Features

* **runner:** run runner as root, remove all sudo wrappers ([#7443](https://github.com/vm0-ai/vm0/issues/7443)) ([66e9af9](https://github.com/vm0-ai/vm0/commit/66e9af9846cfdc044ec4203b04e784bbc5ea305d))

## [0.54.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.53.0...runner-rs-v0.54.0) (2026-04-01)


### Features

* **firewalls:** support vars templates in firewall auth headers ([#7445](https://github.com/vm0-ai/vm0/issues/7445)) ([c06b9a0](https://github.com/vm0-ai/vm0/commit/c06b9a027bf1ae757b2f09393fee658d891bcf5f))

## [0.53.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.52.2...runner-rs-v0.53.0) (2026-03-31)


### Features

* **runner:** add xurl cli to rootfs ([#7397](https://github.com/vm0-ai/vm0/issues/7397)) ([1474ef3](https://github.com/vm0-ai/vm0/commit/1474ef34cb060a96d5af47e3aae7d626a4b5e319)), closes [#7124](https://github.com/vm0-ai/vm0/issues/7124)

## [0.52.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.52.1...runner-rs-v0.52.2) (2026-03-31)


### Bug Fixes

* **firewalls:** replace placeholder tokens with realistic fill pattern ([#7332](https://github.com/vm0-ai/vm0/issues/7332)) ([237916e](https://github.com/vm0-ai/vm0/commit/237916e4d424b924ed8ac603d20da4813b969b40))

## [0.52.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.52.0...runner-rs-v0.52.1) (2026-03-31)

## [0.52.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.51.1...runner-rs-v0.52.0) (2026-03-31)


### Features

* **firewalls:** support path and host parameter matching in base urls ([#7256](https://github.com/vm0-ai/vm0/issues/7256)) ([d9d3a15](https://github.com/vm0-ai/vm0/commit/d9d3a15fc91c5db88a18730b5d8d8aea67238c95))


### Bug Fixes

* **mitm:** add network logging to error() hook for connection failures ([#7300](https://github.com/vm0-ai/vm0/issues/7300)) ([6fec94a](https://github.com/vm0-ai/vm0/commit/6fec94a9f4fef7994477fdd53f87f82147d5be03))
* **mitm:** add per-key lock to coalesce concurrent firewall header fetches ([#7264](https://github.com/vm0-ai/vm0/issues/7264)) ([ab4787c](https://github.com/vm0-ai/vm0/commit/ab4787cb659b362592d4f8b5bd2f5aeb053d219b))

## [0.51.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.51.0...runner-rs-v0.51.1) (2026-03-30)

## [0.51.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.50.2...runner-rs-v0.51.0) (2026-03-30)


### Features

* **sandbox:** add sandbox-mock crate for testing ([#7177](https://github.com/vm0-ai/vm0/issues/7177)) ([d643020](https://github.com/vm0-ai/vm0/commit/d643020b2ac0059996ebeaef128b79945d9e072c))

## [0.50.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.50.1...runner-rs-v0.50.2) (2026-03-30)


### Refactoring

* **sandbox:** introduce runtime provider trait and consolidate sandbox-fc construction ([#7173](https://github.com/vm0-ai/vm0/issues/7173)) ([6cb7c3c](https://github.com/vm0-ai/vm0/commit/6cb7c3c8ed57b4d7eb949986046d68226dc0672a)), closes [#7119](https://github.com/vm0-ai/vm0/issues/7119)

## [0.50.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.50.0...runner-rs-v0.50.1) (2026-03-30)


### Refactoring

* **sandbox:** introduce sandbox control trait and decouple exec/kill from sandbox-fc ([#7150](https://github.com/vm0-ai/vm0/issues/7150)) ([4615d15](https://github.com/vm0-ai/vm0/commit/4615d1571c6dbc2ba249070654112d390e83a395)), closes [#7122](https://github.com/vm0-ai/vm0/issues/7122)
* **sandbox:** introduce sandbox runtime trait and internalize shared resources ([#7125](https://github.com/vm0-ai/vm0/issues/7125)) ([43a2ba0](https://github.com/vm0-ai/vm0/commit/43a2ba0d6ee9df1022e6238913597dd4d1c11e2a))
* **sandbox:** introduce snapshot provider trait and decouple snapshot operations ([#7142](https://github.com/vm0-ai/vm0/issues/7142)) ([9a864bf](https://github.com/vm0-ai/vm0/commit/9a864bfd4ec551ead8115f4fdb30df7c5570b5fe))

## [0.50.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.49.0...runner-rs-v0.50.0) (2026-03-29)


### Features

* **sandbox-fc:** add cow pool to pre-warm dm-snapshot resources ([#7116](https://github.com/vm0-ai/vm0/issues/7116)) ([c841e61](https://github.com/vm0-ai/vm0/commit/c841e61bfc653d143cd6a022f03ca638b2bf5a42))

## [0.49.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.48.2...runner-rs-v0.49.0) (2026-03-29)


### Features

* **guest-init:** use kernel root= boot arg instead of pivot_root ([#7106](https://github.com/vm0-ai/vm0/issues/7106)) ([b373849](https://github.com/vm0-ai/vm0/commit/b373849cb331296ae7665704edd400548d67c2a5))
* **runner:** detect orphan firecracker processes with --name filter ([#7113](https://github.com/vm0-ai/vm0/issues/7113)) ([8fcfc79](https://github.com/vm0-ai/vm0/commit/8fcfc79a812f273fd2ea2b2b9febffe3ab34b858))
* **runner:** detect orphaned dm-snapshot and loop devices in doctor ([#7107](https://github.com/vm0-ai/vm0/issues/7107)) ([c76a18f](https://github.com/vm0-ai/vm0/commit/c76a18f60a4538d410ac4976329c97f7b5d52448))
* **sandbox-fc:** replace guest-side overlayfs with host-side dm-snapshot cow ([#6521](https://github.com/vm0-ai/vm0/issues/6521)) ([8f6a118](https://github.com/vm0-ai/vm0/commit/8f6a1185bfd6dd4604687662f3d03be6076ea71f))


### Bug Fixes

* **crates:** update sha2/hmac usage for digest 0.11 compatibility ([#7101](https://github.com/vm0-ai/vm0/issues/7101)) ([cbded46](https://github.com/vm0-ai/vm0/commit/cbded46e78c8d3ed060e96f79f15cd38ee1cf9dc))

## [0.48.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.48.1...runner-rs-v0.48.2) (2026-03-26)

## [0.48.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.48.0...runner-rs-v0.48.1) (2026-03-26)


### Bug Fixes

* redact sandbox token in logs via secret values list ([#6838](https://github.com/vm0-ai/vm0/issues/6838)) ([56e0c1f](https://github.com/vm0-ai/vm0/commit/56e0c1f319c391dabac9088e7bccc3ff467ec33f))

## [0.48.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.47.0...runner-rs-v0.48.0) (2026-03-25)


### Features

* install @googleworkspace/cli in docker image ([#6751](https://github.com/vm0-ai/vm0/issues/6751)) ([32a45c3](https://github.com/vm0-ai/vm0/commit/32a45c3f2c56a587f001b55d545e02c2823c80ab))

## [0.47.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.46.0...runner-rs-v0.47.0) (2026-03-25)


### Features

* **runner:** add cache version seeds to rootfs and snapshot hash computation ([#6769](https://github.com/vm0-ai/vm0/issues/6769)) ([59b4ce5](https://github.com/vm0-ai/vm0/commit/59b4ce5fbf80f027e89374239e6e36ce4997a656))


### Bug Fixes

* **runner:** add rerun-if-changed for embedded files in build.rs ([#6758](https://github.com/vm0-ai/vm0/issues/6758)) ([814d66c](https://github.com/vm0-ai/vm0/commit/814d66cc1d9601ea1a92342fc9697ec7694e4569))

## [0.46.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.8...runner-rs-v0.46.0) (2026-03-25)


### Features

* **runner:** detect host-side cgroup oom kill of firecracker process ([#6630](https://github.com/vm0-ai/vm0/issues/6630)) ([34fa116](https://github.com/vm0-ai/vm0/commit/34fa11698b8e1c83f2cb93d82e281c099d114a49))

## [0.45.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.7...runner-rs-v0.45.8) (2026-03-25)


### Bug Fixes

* remove hardcoded memorymax=2g from runner systemd service ([#6632](https://github.com/vm0-ai/vm0/issues/6632)) ([c091eb7](https://github.com/vm0-ai/vm0/commit/c091eb7f6e71098a05dc5da0aadde69ebceace83)), closes [#6631](https://github.com/vm0-ai/vm0/issues/6631)

## [0.45.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.6...runner-rs-v0.45.7) (2026-03-25)


### Refactoring

* remove experimental_capabilities and make vm0_token injection unconditional ([#6573](https://github.com/vm0-ai/vm0/issues/6573)) ([#6579](https://github.com/vm0-ai/vm0/issues/6579)) ([1fb7df0](https://github.com/vm0-ai/vm0/commit/1fb7df0201d70223d486c91b536cad93a78c23a3))

## [0.45.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.5...runner-rs-v0.45.6) (2026-03-24)


### Refactoring

* unify agent identity fields across all zero api endpoints ([#6302](https://github.com/vm0-ai/vm0/issues/6302)) ([83a0e5d](https://github.com/vm0-ai/vm0/commit/83a0e5d5b5981b709b1dd8e8e318946b6330d2c7))

## [0.45.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.4...runner-rs-v0.45.5) (2026-03-23)


### Bug Fixes

* **runner:** skip proxy warning for stopped/draining runners in doctor ([#6233](https://github.com/vm0-ai/vm0/issues/6233)) ([7da7c00](https://github.com/vm0-ai/vm0/commit/7da7c00e5271e751dd37f8d3ee6d7da9a76407b8)), closes [#6198](https://github.com/vm0-ai/vm0/issues/6198)
* **runner:** stop kmsg monitor on shutdown to prevent process hang ([#6206](https://github.com/vm0-ai/vm0/issues/6206)) ([f871fb1](https://github.com/vm0-ai/vm0/commit/f871fb1cda90e45773226896926f92911a123975)), closes [#6197](https://github.com/vm0-ai/vm0/issues/6197)

## [0.45.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.3...runner-rs-v0.45.4) (2026-03-23)

## [0.45.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.2...runner-rs-v0.45.3) (2026-03-23)

## [0.45.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.1...runner-rs-v0.45.2) (2026-03-23)


### Refactoring

* **runner:** remove stale dead_code allows from execution context ([#6148](https://github.com/vm0-ai/vm0/issues/6148)) ([c053ce6](https://github.com/vm0-ai/vm0/commit/c053ce6e7594d901fa511d4f4341ce8709ad88e8))

## [0.45.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.0...runner-rs-v0.45.1) (2026-03-23)


### Bug Fixes

* add missing libc dependency to runner crate ([#6092](https://github.com/vm0-ai/vm0/issues/6092)) ([5ba363c](https://github.com/vm0-ai/vm0/commit/5ba363c94e1fb094c339fc4982f93880f52b6503))
* unify pr and mq job-ref and add job-level concurrency groups ([#6086](https://github.com/vm0-ai/vm0/issues/6086)) ([e25f45a](https://github.com/vm0-ai/vm0/commit/e25f45aa5cbcde73a3cf850b67df550a8626885c))

## [0.45.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.44.1...runner-rs-v0.45.0) (2026-03-23)


### Features

* **runner:** add cancel support to local provider via .cancel files ([#6048](https://github.com/vm0-ai/vm0/issues/6048)) ([d065887](https://github.com/vm0-ai/vm0/commit/d065887510d08b06d138a8d3dba30984e5aa4da9))

## [0.44.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.44.0...runner-rs-v0.44.1) (2026-03-23)


### Refactoring

* **runner:** move `runner submit` under `runner local` subcommand ([#5990](https://github.com/vm0-ai/vm0/issues/5990)) ([568fb4c](https://github.com/vm0-ai/vm0/commit/568fb4ce73fa05f6dd0eee05c47c76ffe21e5c5e))

## [0.44.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.43.0...runner-rs-v0.44.0) (2026-03-22)


### Features

* **runner:** add job cancellation via ably real-time notifications ([#5949](https://github.com/vm0-ai/vm0/issues/5949)) ([e157f92](https://github.com/vm0-ai/vm0/commit/e157f925312c50ff8de62e986d7bc7afac0a3d53)), closes [#5762](https://github.com/vm0-ai/vm0/issues/5762)

## [0.43.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.42.1...runner-rs-v0.43.0) (2026-03-21)


### Features

* add tcp connection logging and network log type field ([#5786](https://github.com/vm0-ai/vm0/issues/5786)) ([12d6ddb](https://github.com/vm0-ai/vm0/commit/12d6ddbefa61a83e7e50e6ae4e5fc904b6965678)), closes [#5592](https://github.com/vm0-ai/vm0/issues/5592)

## [0.42.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.42.0...runner-rs-v0.42.1) (2026-03-21)

## [0.42.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.41.0...runner-rs-v0.42.0) (2026-03-20)


### Features

* **runner:** add sentry panic reporting for crash observability ([#5747](https://github.com/vm0-ai/vm0/issues/5747)) ([0e28602](https://github.com/vm0-ai/vm0/commit/0e28602620d8e6e87e5801a587d48829910becd5)), closes [#5680](https://github.com/vm0-ai/vm0/issues/5680)
* support --settings flag for vm0 run ([#5663](https://github.com/vm0-ai/vm0/issues/5663)) ([#5753](https://github.com/vm0-ai/vm0/issues/5753)) ([d0aad87](https://github.com/vm0-ai/vm0/commit/d0aad87539c31ae4664d41b1cca46b556b3de66e))
* support --tools cli parameter across full pipeline ([#5752](https://github.com/vm0-ai/vm0/issues/5752)) ([b0cf364](https://github.com/vm0-ai/vm0/commit/b0cf364a8598dcd36ed1a6ffffdb8c1e03d1841c))


### Refactoring

* separate auth error from firewall action in network logs ([#5756](https://github.com/vm0-ai/vm0/issues/5756)) ([7b56aed](https://github.com/vm0-ai/vm0/commit/7b56aedb93ba323a4076af6ca19fb43a520aa6e1)), closes [#5754](https://github.com/vm0-ai/vm0/issues/5754)

## [0.41.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.40.0...runner-rs-v0.41.0) (2026-03-20)


### Features

* add firewall fields to network logs and improve action handling ([#5745](https://github.com/vm0-ai/vm0/issues/5745)) ([ff2d271](https://github.com/vm0-ai/vm0/commit/ff2d271d7040f6367dd19a7f0e6f21fdd35a19c1))

## [0.40.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.39.0...runner-rs-v0.40.0) (2026-03-20)


### Features

* **vsock:** add real-time stdout streaming from guest to host ([#5574](https://github.com/vm0-ai/vm0/issues/5574)) ([2afc093](https://github.com/vm0-ai/vm0/commit/2afc0930657f6bbf1e1f4947383345d33de46819))


### Performance Improvements

* **mitm-addon:** use asyncio.to_thread for blocking firewall auth requests ([#5638](https://github.com/vm0-ai/vm0/issues/5638)) ([e7a29b9](https://github.com/vm0-ai/vm0/commit/e7a29b9f94692400fd9ac592cefd30640b116199)), closes [#5635](https://github.com/vm0-ai/vm0/issues/5635)

## [0.39.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.38.1...runner-rs-v0.39.0) (2026-03-19)


### Features

* add disallowed_tools to vm0.yaml schema and server pipeline ([#5576](https://github.com/vm0-ai/vm0/issues/5576)) ([6ac49d7](https://github.com/vm0-ai/vm0/commit/6ac49d7434b456e01df4d3fa6bf918923b07b2f5))
* add zero agents rest api and remove compose jobs ([#5594](https://github.com/vm0-ai/vm0/issues/5594)) ([8e428bb](https://github.com/vm0-ai/vm0/commit/8e428bb40c663b50bb481928f708e004601ee1af))
* **runner:** pass disallowed tools from execution context to claude cli ([#5577](https://github.com/vm0-ai/vm0/issues/5577)) ([cdc557a](https://github.com/vm0-ai/vm0/commit/cdc557a4ccb873b37b5df3cc3eb550d6f0849e79)), closes [#5564](https://github.com/vm0-ai/vm0/issues/5564)


### Bug Fixes

* override mitmproxy bundled certificate store with system ca bundle ([#5529](https://github.com/vm0-ai/vm0/issues/5529)) ([b4e665f](https://github.com/vm0-ai/vm0/commit/b4e665f1f34e2d51c9dc9bbc45e8df3ffba3a603)), closes [#5524](https://github.com/vm0-ai/vm0/issues/5524)
* register vm in proxy before sandbox start to prevent missing network logs ([#5537](https://github.com/vm0-ai/vm0/issues/5537)) ([ebe67ba](https://github.com/vm0-ai/vm0/commit/ebe67ba9c895cd11915511c4c7d120916c78f5a7)), closes [#5535](https://github.com/vm0-ai/vm0/issues/5535)
* **runner:** add user-agent to mitmproxy firewall auth requests ([#5632](https://github.com/vm0-ai/vm0/issues/5632)) ([a9d25c9](https://github.com/vm0-ai/vm0/commit/a9d25c9ea81d9a61a167f3210c8d83e926a8859a)), closes [#5630](https://github.com/vm0-ai/vm0/issues/5630)
* **runner:** include runner log files in gc cleanup ([#5559](https://github.com/vm0-ai/vm0/issues/5559)) ([19f2985](https://github.com/vm0-ai/vm0/commit/19f29853615887101bb8dd0d8e5dff6da679fb0c)), closes [#5555](https://github.com/vm0-ai/vm0/issues/5555)
* **runner:** remove duplicate disallowed_tools field in execution context ([#5608](https://github.com/vm0-ai/vm0/issues/5608)) ([efed47a](https://github.com/vm0-ai/vm0/commit/efed47aaff3d010763a3af1120de8326cb37e2b8))


### Refactoring

* merge browser profile into default, install chromium in base rootfs ([#5568](https://github.com/vm0-ai/vm0/issues/5568)) ([e014dd1](https://github.com/vm0-ai/vm0/commit/e014dd1d9778d739b66844f2d67871ba61af9107)), closes [#5554](https://github.com/vm0-ai/vm0/issues/5554)

## [0.38.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.38.0...runner-rs-v0.38.1) (2026-03-19)


### Refactoring

* **sandbox:** remove dead use_proxy field from sandbox config ([#5483](https://github.com/vm0-ai/vm0/issues/5483)) ([97c8db8](https://github.com/vm0-ai/vm0/commit/97c8db89235175ba41f45817413b671c3d39fe3e)), closes [#5481](https://github.com/vm0-ai/vm0/issues/5481)

## [0.38.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.37.0...runner-rs-v0.38.0) (2026-03-19)


### Features

* **runner:** always register vms in proxy for network logging ([#5465](https://github.com/vm0-ai/vm0/issues/5465)) ([5508b23](https://github.com/vm0-ai/vm0/commit/5508b2326891cd4294a12ed392dc7e296611462d))

## [0.37.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.36.0...runner-rs-v0.37.0) (2026-03-19)


### Features

* inject agent identity env vars and add whoami command ([#5461](https://github.com/vm0-ai/vm0/issues/5461)) ([76ceb92](https://github.com/vm0-ai/vm0/commit/76ceb92d5559ed2987abbacc24fcf422ebad2753))

## [0.36.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.35.0...runner-rs-v0.36.0) (2026-03-19)


### Features

* **runner:** add vm0/browser profile with dockerfile and ci integration ([#5311](https://github.com/vm0-ai/vm0/issues/5311)) ([a6b6077](https://github.com/vm0-ai/vm0/commit/a6b6077eb2e8a83f48bed456e4ee7d5e3323c192))


### Bug Fixes

* **sandbox-fc:** use per-profile overlay directories to prevent cross-deletion ([#5413](https://github.com/vm0-ai/vm0/issues/5413)) ([a5c1a56](https://github.com/vm0-ai/vm0/commit/a5c1a56e0cbbf7ce305bf34414981ef3a08f2841)), closes [#5405](https://github.com/vm0-ai/vm0/issues/5405)

## [0.35.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.34.0...runner-rs-v0.35.0) (2026-03-18)


### Features

* add append-system-prompt support to runner and guest-agent ([#5384](https://github.com/vm0-ai/vm0/issues/5384)) ([37aaa76](https://github.com/vm0-ai/vm0/commit/37aaa76b7acdf8c24f2928590de54317870c3a21)), closes [#5375](https://github.com/vm0-ai/vm0/issues/5375)

## [0.34.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.33.0...runner-rs-v0.34.0) (2026-03-18)


### Features

* **runner:** add minimum age protection to runner gc ([#5347](https://github.com/vm0-ai/vm0/issues/5347)) ([e7cc167](https://github.com/vm0-ai/vm0/commit/e7cc167f44b64dc3b866c8de78b7e36fae1e503b)), closes [#5345](https://github.com/vm0-ai/vm0/issues/5345)

## [0.33.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.32.0...runner-rs-v0.33.0) (2026-03-18)


### Features

* **runner:** add profile support to local provider and submit command ([#5234](https://github.com/vm0-ai/vm0/issues/5234)) ([296dc94](https://github.com/vm0-ai/vm0/commit/296dc94707b5de7ca8113893b48c445765d69e37))

## [0.32.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.3...runner-rs-v0.32.0) (2026-03-17)


### Features

* **runner:** profile-aware discovery, budget reservation, and per-profile factory ([#5224](https://github.com/vm0-ai/vm0/issues/5224)) ([05e3803](https://github.com/vm0-ai/vm0/commit/05e3803c7566ec70be92c1e313fa1c58d2b6c779))

## [0.31.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.2...runner-rs-v0.31.3) (2026-03-17)


### Refactoring

* **sandbox-fc:** replace target-size pool pre-warming with fixed buffer ([#5191](https://github.com/vm0-ai/vm0/issues/5191)) ([4ce60ac](https://github.com/vm0-ai/vm0/commit/4ce60ac8c1c5b0f60dae8169d71135b11ee3b968))

## [0.31.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.1...runner-rs-v0.31.2) (2026-03-17)

## [0.31.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.0...runner-rs-v0.31.1) (2026-03-17)

## [0.31.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.30.0...runner-rs-v0.31.0) (2026-03-17)


### Features

* **runner:** add experimental profile passthrough from compose to runner ([#5100](https://github.com/vm0-ai/vm0/issues/5100)) ([5eb8dd4](https://github.com/vm0-ai/vm0/commit/5eb8dd44baaa24ea40baf2804ec022a3d006528a)), closes [#5037](https://github.com/vm0-ai/vm0/issues/5037)

## [0.30.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.3...runner-rs-v0.30.0) (2026-03-17)


### Features

* support {param*} wildcard for zero-or-more path segments ([#5114](https://github.com/vm0-ai/vm0/issues/5114)) ([408c637](https://github.com/vm0-ai/vm0/commit/408c637b37ed74ce20c9ac48b778f1a363dbe842))

## [0.29.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.2...runner-rs-v0.29.3) (2026-03-17)


### Bug Fixes

* {param+} path matching should require one or more segments ([#5106](https://github.com/vm0-ai/vm0/issues/5106)) ([b05ecd5](https://github.com/vm0-ai/vm0/commit/b05ecd5599e6c9a09232cdcef097f53d8d15161e))

## [0.29.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.1...runner-rs-v0.29.2) (2026-03-17)


### Refactoring

* **rust:** replace inline crate:: paths with top-level use imports ([#5061](https://github.com/vm0-ai/vm0/issues/5061)) ([149aaa0](https://github.com/vm0-ai/vm0/commit/149aaa09ca2bf69ffb1bc35471ba813e5884e534)), closes [#5038](https://github.com/vm0-ai/vm0/issues/5038)

## [0.29.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.0...runner-rs-v0.29.1) (2026-03-16)


### Bug Fixes

* return detailed json error on firewall 403 responses ([#5053](https://github.com/vm0-ai/vm0/issues/5053)) ([285cc4c](https://github.com/vm0-ai/vm0/commit/285cc4c6b79366fe6aedaeaeff4291a3fc584f1e))


### Refactoring

* align experimental_capabilities with resource model ([#5063](https://github.com/vm0-ai/vm0/issues/5063)) ([9d025ce](https://github.com/vm0-ai/vm0/commit/9d025ce6e43570242af0604181adb3047fe81370))
* rename firewall array fields to plural form ([#5034](https://github.com/vm0-ai/vm0/issues/5034)) ([79bd167](https://github.com/vm0-ai/vm0/commit/79bd1675288e6a5a92acb6ef9c199099b9dd11bf))

## [0.29.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.28.2...runner-rs-v0.29.0) (2026-03-16)


### Features

* **runner:** add profile definitions and multi-profile build pipeline ([#4952](https://github.com/vm0-ai/vm0/issues/4952)) ([0263ddd](https://github.com/vm0-ai/vm0/commit/0263ddd26ff25bf3c3e82ca66242b5bfa73e2466)), closes [#4941](https://github.com/vm0-ai/vm0/issues/4941)

## [0.28.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.28.1...runner-rs-v0.28.2) (2026-03-16)


### Refactoring

* **runner:** decouple ca generation from rootfs build ([#4968](https://github.com/vm0-ai/vm0/issues/4968)) ([0ef9a58](https://github.com/vm0-ai/vm0/commit/0ef9a5895005b46fa3ce209e1155a2b9703d2893)), closes [#4962](https://github.com/vm0-ai/vm0/issues/4962)

## [0.28.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.28.0...runner-rs-v0.28.1) (2026-03-16)


### Refactoring

* merge volume/artifact/memory capabilities into storage:read and storage:write ([#4959](https://github.com/vm0-ai/vm0/issues/4959)) ([cc0c3b4](https://github.com/vm0-ai/vm0/commit/cc0c3b40c3c6a5a8a6167a46531fb1db16191341)), closes [#4956](https://github.com/vm0-ai/vm0/issues/4956)

## [0.28.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.27.0...runner-rs-v0.28.0) (2026-03-16)


### Features

* **runner:** replace semaphore with resource-budget concurrency control ([#4928](https://github.com/vm0-ai/vm0/issues/4928)) ([48f674f](https://github.com/vm0-ai/vm0/commit/48f674fad4a567d9d8158b0e3fde65535366a71b))

## [0.27.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.26.2...runner-rs-v0.27.0) (2026-03-16)


### Features

* conditionally inject cli env vars in sandbox when capabilities present ([#4902](https://github.com/vm0-ai/vm0/issues/4902)) ([4b89998](https://github.com/vm0-ai/vm0/commit/4b899988768c0edc9781fb1ffefedec90de044e5)), closes [#4899](https://github.com/vm0-ai/vm0/issues/4899)


### Refactoring

* rename service to firewall across entire codebase ([#4877](https://github.com/vm0-ai/vm0/issues/4877)) ([#4895](https://github.com/vm0-ai/vm0/issues/4895)) ([d40192b](https://github.com/vm0-ai/vm0/commit/d40192b6df5672d525dd39b9215a167ba42a3722))

## [0.26.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.26.1...runner-rs-v0.26.2) (2026-03-16)


### Refactoring

* **services:** unify secret template syntax to ${{ }} ([#4862](https://github.com/vm0-ai/vm0/issues/4862)) ([607e8e9](https://github.com/vm0-ai/vm0/commit/607e8e9be8eb83b60895898686ca94f711f6debb)), closes [#4806](https://github.com/vm0-ai/vm0/issues/4806)

## [0.26.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.26.0...runner-rs-v0.26.1) (2026-03-15)

## [0.26.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.25.0...runner-rs-v0.26.0) (2026-03-15)


### Features

* **services:** add oauth token refresh and ttl caching to auth endpoint ([#4802](https://github.com/vm0-ai/vm0/issues/4802)) ([eab1747](https://github.com/vm0-ai/vm0/commit/eab17475db94fbbc8e5a4d8317851fb09fef28a9))

## [0.25.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.24.1...runner-rs-v0.25.0) (2026-03-14)


### Features

* **runner:** plumb secret-connector map from build to proxy addon ([#4764](https://github.com/vm0-ai/vm0/issues/4764)) ([dcde11d](https://github.com/vm0-ai/vm0/commit/dcde11dd12a1484e4050370848e51f8bd4a14946))

## [0.24.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.24.0...runner-rs-v0.24.1) (2026-03-14)


### Bug Fixes

* **services:** allow same permission name across different api_entries ([#4754](https://github.com/vm0-ai/vm0/issues/4754)) ([2b84536](https://github.com/vm0-ai/vm0/commit/2b845369ead0589dfc6e26dded933b75f94f2ab0))

## [0.24.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.23.0...runner-rs-v0.24.0) (2026-03-13)


### Features

* **services:** permission-based request matching in mitm_addon ([#4721](https://github.com/vm0-ai/vm0/issues/4721)) ([98267dd](https://github.com/vm0-ai/vm0/commit/98267ddeb6d01e7b9b1c4599ead7a9c173b67130))


### Refactoring

* change experimental services from flat apis to nested service entries ([#4711](https://github.com/vm0-ai/vm0/issues/4711)) ([a7dbfc8](https://github.com/vm0-ai/vm0/commit/a7dbfc8a18e65350ef701628f1b3e6ed6837d282))
* eliminate remaining scope references ([#4703](https://github.com/vm0-ai/vm0/issues/4703)) ([fd85a3b](https://github.com/vm0-ai/vm0/commit/fd85a3b6b4f4fe10eb0ff36a1f5140888d9a57f1))
* rename remaining scope references to org in contracts ([#4695](https://github.com/vm0-ai/vm0/issues/4695)) ([9d4a05e](https://github.com/vm0-ai/vm0/commit/9d4a05e89cd28a98f3496149bdaf5f19e93207eb)), closes [#4688](https://github.com/vm0-ai/vm0/issues/4688)

## [0.23.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.8...runner-rs-v0.23.0) (2026-03-13)


### Features

* **services:** add permission type definitions ([#4659](https://github.com/vm0-ai/vm0/issues/4659)) ([5c7e96a](https://github.com/vm0-ai/vm0/commit/5c7e96ab41040602ca40a55fd966e2ba2b5dab7d))

## [0.22.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.7...runner-rs-v0.22.8) (2026-03-12)


### Refactoring

* reorder mitm-addon request handling to enforce firewall before services ([#4625](https://github.com/vm0-ai/vm0/issues/4625)) ([28ea3a5](https://github.com/vm0-ai/vm0/commit/28ea3a50e5598c293cb920cbe67ded089829d653)), closes [#4624](https://github.com/vm0-ai/vm0/issues/4624)
* **services:** addon encrypted-secrets passthrough and auth endpoint rewrite ([#4613](https://github.com/vm0-ai/vm0/issues/4613)) ([3f19c4c](https://github.com/vm0-ai/vm0/commit/3f19c4c87102a69aeb75ed2f3102904c9479d7e9))

## [0.22.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.6...runner-rs-v0.22.7) (2026-03-12)


### Refactoring

* **services:** forward encryptedSecrets through proxy registry ([#4604](https://github.com/vm0-ai/vm0/issues/4604)) ([21ca7a1](https://github.com/vm0-ai/vm0/commit/21ca7a138f7633c2204ae38a82ce6b1a9c9c1193))

## [0.22.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.5...runner-rs-v0.22.6) (2026-03-12)


### Refactoring

* remove experimental_mitm and always enable mitm when proxy is active ([#4568](https://github.com/vm0-ai/vm0/issues/4568)) ([34e1257](https://github.com/vm0-ai/vm0/commit/34e1257a96ceb70a50c07fa258a442c940b5ef95))
* remove sni mode dead code from network logging ([#4592](https://github.com/vm0-ai/vm0/issues/4592)) ([20a55a8](https://github.com/vm0-ai/vm0/commit/20a55a8cc7cfd5284b072ec945c23185a58d1d8f))
* **runner:** rename secrets variable to match field name ([#4588](https://github.com/vm0-ai/vm0/issues/4588)) ([5a1413d](https://github.com/vm0-ai/vm0/commit/5a1413dabecf8a3c5966c7c860cb6a93f9f21ad6))
* **services:** pass encrypted-secrets blob in claim response to runner ([#4599](https://github.com/vm0-ai/vm0/issues/4599)) ([ffdfe6e](https://github.com/vm0-ai/vm0/commit/ffdfe6e617cceb1823e700f3754aa55dde3d5def))

## [0.22.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.4...runner-rs-v0.22.5) (2026-03-12)


### Refactoring

* remove proxy rewrite endpoint and seal secrets ([#4539](https://github.com/vm0-ai/vm0/issues/4539)) ([f7af830](https://github.com/vm0-ai/vm0/commit/f7af8301f67b87f4615dad8e9b8a00adb449aeba))

## [0.22.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.3...runner-rs-v0.22.4) (2026-03-12)


### Refactoring

* remove balloon_reclaim flag and enable balloon reclaim unconditionally ([#4473](https://github.com/vm0-ai/vm0/issues/4473)) ([b386091](https://github.com/vm0-ai/vm0/commit/b38609140426569f3fe0c3cc3e56bf81ee477583))
* remove secret names from execution context ([#4489](https://github.com/vm0-ai/vm0/issues/4489)) ([bc70477](https://github.com/vm0-ai/vm0/commit/bc704775200d97dac742f730cb93350609636006))
* **runner:** stop injecting vars directly as environment variables ([#4482](https://github.com/vm0-ai/vm0/issues/4482)) ([c47674a](https://github.com/vm0-ai/vm0/commit/c47674acb4d22d929b7d98c237947192e89b1f61))

## [0.22.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.2...runner-rs-v0.22.3) (2026-03-11)


### Bug Fixes

* **runner:** log response headers in network logs for zlib error debugging ([#4400](https://github.com/vm0-ai/vm0/issues/4400)) ([47207fa](https://github.com/vm0-ai/vm0/commit/47207fa18c72b204219a9171418ed5dc21f19e8e))


### Refactoring

* decouple service proxy config from connector concept ([#4388](https://github.com/vm0-ai/vm0/issues/4388)) ([b970b33](https://github.com/vm0-ai/vm0/commit/b970b33d97fc4f1cf825215e4b94ed182110c31f))

## [0.22.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.1...runner-rs-v0.22.2) (2026-03-11)


### Bug Fixes

* **mitm-addon:** stream all responses to prevent zlib error ([#4350](https://github.com/vm0-ai/vm0/issues/4350)) ([fd72f46](https://github.com/vm0-ai/vm0/commit/fd72f46af290c13cba9f655995265eb6269776ac))

## [0.22.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.0...runner-rs-v0.22.1) (2026-03-11)


### Bug Fixes

* enable selective streaming in mitm proxy to avoid zliberror ([#4223](https://github.com/vm0-ai/vm0/issues/4223)) ([9d89bd3](https://github.com/vm0-ai/vm0/commit/9d89bd3c3a3f39f54a319bd81b040bd4081206aa))

## [0.22.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.21.1...runner-rs-v0.22.0) (2026-03-10)


### Features

* **connectors:** implement proxy-side auth header injection for experimental connectors ([#4072](https://github.com/vm0-ai/vm0/issues/4072)) ([dabc986](https://github.com/vm0-ai/vm0/commit/dabc986158c0d98068a06599724da3307a4904f7))


### Bug Fixes

* remove overly broad "killed process" pattern from oom detection ([#4127](https://github.com/vm0-ai/vm0/issues/4127)) ([42b8acf](https://github.com/vm0-ai/vm0/commit/42b8acf959b9d29909e7944f0048320f3215843a))
* remove overly broad killed process pattern from oom detection ([#4147](https://github.com/vm0-ai/vm0/issues/4147)) ([8766dd9](https://github.com/vm0-ai/vm0/commit/8766dd98ba36113be183d666ec661e99177406b5))

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
