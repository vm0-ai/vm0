# Changelog

## [0.277.0](https://github.com/vm0-ai/vm0/compare/app-v0.276.0...app-v0.277.0) (2026-04-22)


### Features

* remove Vm0GlmModel feature flag, fully enable GLM-5.1 ([#10497](https://github.com/vm0-ai/vm0/issues/10497)) ([cff31ff](https://github.com/vm0-ai/vm0/commit/cff31ffbc2f68e27d56742efafaf0832d7e5362f))
* **voice-chat-candidate:** three-column layout with live task event stream ([#10452](https://github.com/vm0-ai/vm0/issues/10452)) ([df2a3d5](https://github.com/vm0-ai/vm0/commit/df2a3d5a8e72186508e7b40fbc739db91ebb133e))


### Bug Fixes

* **platform:** add hidden class to collapsed sidebar to prevent mobile display ([#10481](https://github.com/vm0-ai/vm0/issues/10481)) ([e53baba](https://github.com/vm0-ai/vm0/commit/e53baba369f781ae40a09f18f871b16900c941bd))
* skip chat composer auto-focus on iOS ([#10498](https://github.com/vm0-ai/vm0/issues/10498)) ([a2bc7a0](https://github.com/vm0-ai/vm0/commit/a2bc7a04d2432223e16d123c4a8c3818278c2cea))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.221.0

## [0.276.0](https://github.com/vm0-ai/vm0/compare/app-v0.275.2...app-v0.276.0) (2026-04-21)


### Features

* custom api keys management page with org context support ([#10469](https://github.com/vm0-ai/vm0/issues/10469)) ([aa14355](https://github.com/vm0-ai/vm0/commit/aa14355b8b6ed0a961f50c04a29376fcb965194e))


### Performance Improvements

* **eslint:** replace type-checker with ast-only analysis in computed-const-args-package-scope ([#10449](https://github.com/vm0-ai/vm0/issues/10449)) ([6de4f6d](https://github.com/vm0-ai/vm0/commit/6de4f6d77fe47e255e263111914e710642800676))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.220.0

## [0.275.2](https://github.com/vm0-ai/vm0/compare/app-v0.275.1...app-v0.275.2) (2026-04-21)


### Bug Fixes

* **platform:** align custom connector ui with platform conventions ([#10395](https://github.com/vm0-ai/vm0/issues/10395)) ([5c58db3](https://github.com/vm0-ai/vm0/commit/5c58db3e04c843a5c1963fac0ff20df7b988dbed))

## [0.275.1](https://github.com/vm0-ai/vm0/compare/app-v0.275.0...app-v0.275.1) (2026-04-21)


### Performance Improvements

* **platform:** reduce activity log poll interval from 10s to 3s ([#10440](https://github.com/vm0-ai/vm0/issues/10440)) ([0284532](https://github.com/vm0-ai/vm0/commit/0284532eb41ceb1089480964846f12d03d4d6b5c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.219.1

## [0.275.0](https://github.com/vm0-ai/vm0/compare/app-v0.274.1...app-v0.275.0) (2026-04-21)


### Features

* **platform:** fall back to agent default model in chat composer ([#10431](https://github.com/vm0-ai/vm0/issues/10431)) ([f0f96ab](https://github.com/vm0-ai/vm0/commit/f0f96ab26e8139b56a69c8937aef4126374db4a7))


### Refactoring

* **platform:** split voice-chat-candidate-session.ts large commands ([#10432](https://github.com/vm0-ai/vm0/issues/10432)) ([36aa24a](https://github.com/vm0-ai/vm0/commit/36aa24ab3521ac8301dd1ec68468d13ba1a46917))


### Performance Improvements

* **eslint:** reduce type-checking overhead in @vm0/app ccstate rules ([#10418](https://github.com/vm0-ai/vm0/issues/10418)) ([46facd2](https://github.com/vm0-ai/vm0/commit/46facd209c29cd6c0a922edb1e4f76f044aac9fe))

## [0.274.1](https://github.com/vm0-ai/vm0/compare/app-v0.274.0...app-v0.274.1) (2026-04-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.219.0

## [0.274.0](https://github.com/vm0-ai/vm0/compare/app-v0.273.0...app-v0.274.0) (2026-04-21)


### Features

* move thinking indicator inline under latest message ([#10246](https://github.com/vm0-ai/vm0/issues/10246)) ([eb0aa92](https://github.com/vm0-ai/vm0/commit/eb0aa92fbfa49a8f18806dde8669b8bbd17acaaf))


### Bug Fixes

* **web:** ts-rest api error triage and observability ([#10402](https://github.com/vm0-ai/vm0/issues/10402)) ([67d7ceb](https://github.com/vm0-ai/vm0/commit/67d7ceb879f70d3428ac895831201ca4124ded97))

## [0.273.0](https://github.com/vm0-ai/vm0/compare/app-v0.272.0...app-v0.273.0) (2026-04-21)


### Features

* add ts-rest contract for file uploads and use accept() ([#10396](https://github.com/vm0-ai/vm0/issues/10396)) ([675ac69](https://github.com/vm0-ai/vm0/commit/675ac6976d56e6d9e33cd6d5328f65e1c8c330b8))


### Bug Fixes

* **platform:** remove avatar fallback to default preset ([#9363](https://github.com/vm0-ai/vm0/issues/9363)) ([#10393](https://github.com/vm0-ai/vm0/issues/10393)) ([b62cde6](https://github.com/vm0-ai/vm0/commit/b62cde686cefa6c8cb3af7614591d7d6beabc1c9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.218.0

## [0.272.0](https://github.com/vm0-ai/vm0/compare/app-v0.271.0...app-v0.272.0) (2026-04-21)


### Features

* **activity:** add runner tab with sandbox reuse result ([#10385](https://github.com/vm0-ai/vm0/issues/10385)) ([6d00d40](https://github.com/vm0-ai/vm0/commit/6d00d40ec5e0910f30d1287d7af07ad9a6fb222d))
* **ui:** auto-focus input on /agents/:id/chat page ([#10384](https://github.com/vm0-ai/vm0/issues/10384)) ([a253373](https://github.com/vm0-ai/vm0/commit/a2533737261c53466eb9a14a025cc40c8499c573))


### Bug Fixes

* use threadData for document title and make it reactive ([#10391](https://github.com/vm0-ai/vm0/issues/10391)) ([f6b3bca](https://github.com/vm0-ai/vm0/commit/f6b3bcabf0ebd2c26567aec070f0217d63617ea2)), closes [#9810](https://github.com/vm0-ai/vm0/issues/9810)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.217.0

## [0.271.0](https://github.com/vm0-ai/vm0/compare/app-v0.270.0...app-v0.271.0) (2026-04-21)


### Features

* add Kimi K2.6 model support ([#10356](https://github.com/vm0-ai/vm0/issues/10356)) ([bac75d0](https://github.com/vm0-ai/vm0/commit/bac75d0dd28fe73328af6a44963dd01774795518))


### Refactoring

* **firewalls:** drop redundant ref field, use name everywhere ([#10353](https://github.com/vm0-ai/vm0/issues/10353)) ([87cd67e](https://github.com/vm0-ai/vm0/commit/87cd67e6a1c47a0bf69f388907f317f4cdf52246))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.216.0

## [0.270.0](https://github.com/vm0-ai/vm0/compare/app-v0.269.1...app-v0.270.0) (2026-04-20)


### Features

* **credits:** add internal redemption codes page (mint + redeem) ([#10241](https://github.com/vm0-ai/vm0/issues/10241)) ([d012b77](https://github.com/vm0-ai/vm0/commit/d012b775da1a9d42c446ecf072e731c1cc4a8fc7))
* **platform:** add voice-chat-candidate views and signals (physically separate) ([#10332](https://github.com/vm0-ai/vm0/issues/10332)) ([678e3cc](https://github.com/vm0-ai/vm0/commit/678e3ccc30eb67cc2d41c699157d18d9702a5d42))
* **platform:** register voice-chat-candidate route + bootstrap + sidebar ([#10348](https://github.com/vm0-ai/vm0/issues/10348)) ([09c7afb](https://github.com/vm0-ai/vm0/commit/09c7afbe38a43c989296df97dae5f98778b63279)), closes [#10315](https://github.com/vm0-ai/vm0/issues/10315)


### Bug Fixes

* **platform:** align chat composer model picker display with send body ([#10343](https://github.com/vm0-ai/vm0/issues/10343)) ([7c0c36d](https://github.com/vm0-ai/vm0/commit/7c0c36de49a8f7b333a77beea8f5568934c6d9d6))
* **platform:** show only toggled-on connectors in trigger icons ([#10336](https://github.com/vm0-ai/vm0/issues/10336)) ([fede821](https://github.com/vm0-ai/vm0/commit/fede8215e25ea5fb6b7b636b43e95c4ad1af6473))


### Refactoring

* **platform:** drop client-only override layer from feature switches ([#10316](https://github.com/vm0-ai/vm0/issues/10316)) ([e42e0db](https://github.com/vm0-ai/vm0/commit/e42e0db5162412ac5296415c95cb941101ab27f3))


### Performance Improvements

* **platform:** conditionally render collapsed sidebar ([#10331](https://github.com/vm0-ai/vm0/issues/10331)) ([813fd4e](https://github.com/vm0-ai/vm0/commit/813fd4e5a9bfaec18fedbff9e4b56be91affaffd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.215.0

## [0.269.1](https://github.com/vm0-ai/vm0/compare/app-v0.269.0...app-v0.269.1) (2026-04-20)


### Bug Fixes

* **platform:** prevent chat message grid overflow on long content ([#10320](https://github.com/vm0-ai/vm0/issues/10320)) ([260371e](https://github.com/vm0-ai/vm0/commit/260371e3db21bd311ff10840e70be6ea065ceed9))

## [0.269.0](https://github.com/vm0-ai/vm0/compare/app-v0.268.0...app-v0.269.0) (2026-04-20)


### Features

* **platform:** add unifyChatThreads feature switch ([#10162](https://github.com/vm0-ai/vm0/issues/10162)) ([#10276](https://github.com/vm0-ai/vm0/issues/10276)) ([03a1c0a](https://github.com/vm0-ai/vm0/commit/03a1c0a3ac15f305e8fea907f52208750bdb4f1d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.214.0

## [0.268.0](https://github.com/vm0-ai/vm0/compare/app-v0.267.0...app-v0.268.0) (2026-04-20)


### Features

* **api:** add v1 chat-threads endpoints gated by clerk api keys ([#10225](https://github.com/vm0-ai/vm0/issues/10225)) ([bd6d7a3](https://github.com/vm0-ai/vm0/commit/bd6d7a3322cd6c064d8184826d00d0e0d7dd96e1))
* **platform:** add totals bar and tabbed detail sections to usage insight ([#10271](https://github.com/vm0-ai/vm0/issues/10271)) ([4ebe470](https://github.com/vm0-ai/vm0/commit/4ebe470a3c1cecf64bfc23901bd404acc0b5ea01))


### Refactoring

* **platform:** replace queue polling with realtime signals ([#10277](https://github.com/vm0-ai/vm0/issues/10277)) ([f4cc455](https://github.com/vm0-ai/vm0/commit/f4cc455fde74f079358cb0a2e6f0596ed2216e0c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.213.0

## [0.267.0](https://github.com/vm0-ai/vm0/compare/app-v0.266.0...app-v0.267.0) (2026-04-20)


### Features

* **connector:** add nano-banana platform-managed connector skeleton ([#9889](https://github.com/vm0-ai/vm0/issues/9889)) ([3bec579](https://github.com/vm0-ai/vm0/commit/3bec5793f167abcbc635987c606461552f95d38c))


### Bug Fixes

* **chat:** restore structured attach-files flow for web chat uploads ([#10264](https://github.com/vm0-ai/vm0/issues/10264)) ([1962608](https://github.com/vm0-ai/vm0/commit/196260877aaaec02d0403232d19b132f28107ccc))
* **platform:** clear just-connected flag on connector disconnect ([#10274](https://github.com/vm0-ai/vm0/issues/10274)) ([dfa0588](https://github.com/vm0-ai/vm0/commit/dfa05889ae909947fea88174788a2dd9e2f6b10e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.212.0

## [0.266.0](https://github.com/vm0-ai/vm0/compare/app-v0.265.1...app-v0.266.0) (2026-04-20)


### Features

* **platform:** render image and video links inline in chat ([#10254](https://github.com/vm0-ai/vm0/issues/10254)) ([6e775f1](https://github.com/vm0-ai/vm0/commit/6e775f1e0051b61c6fb30efe161a63b08566ea55))
* **voice-io:** gate audio input by org tier with free-tier quota ([#10258](https://github.com/vm0-ai/vm0/issues/10258)) ([2df8bb8](https://github.com/vm0-ai/vm0/commit/2df8bb8bf4baf7fbc744e20a621bd9a1107ba552))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.211.0

## [0.265.1](https://github.com/vm0-ai/vm0/compare/app-v0.265.0...app-v0.265.1) (2026-04-20)


### Refactoring

* **connectors:** remove org custom connectors feature switch ([#10229](https://github.com/vm0-ai/vm0/issues/10229)) ([a5e1b60](https://github.com/vm0-ai/vm0/commit/a5e1b601bcef3f4d0eaa20e959c28b04cffa9131))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.210.1

## [0.265.0](https://github.com/vm0-ai/vm0/compare/app-v0.264.0...app-v0.265.0) (2026-04-20)


### Features

* **slack:** add Powered by model footer to agent messages ([#10156](https://github.com/vm0-ai/vm0/issues/10156)) ([b7d399d](https://github.com/vm0-ai/vm0/commit/b7d399d06f542cf38d1e217961f75e4b5be87192))


### Bug Fixes

* **platform:** silence expected 404 agent-not-found errors in sentry ([#10208](https://github.com/vm0-ai/vm0/issues/10208)) ([854f608](https://github.com/vm0-ai/vm0/commit/854f608d8d68f3176399197dd51deaf886f50c60)), closes [#10167](https://github.com/vm0-ai/vm0/issues/10167)


### Refactoring

* **core:** split audio i/o feature switch into input and output flags ([#10209](https://github.com/vm0-ai/vm0/issues/10209)) ([f6670cd](https://github.com/vm0-ai/vm0/commit/f6670cd9b1bfc7d6bb21cd66b505749d60c968b2)), closes [#10207](https://github.com/vm0-ai/vm0/issues/10207)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.210.0

## [0.264.0](https://github.com/vm0-ai/vm0/compare/app-v0.263.0...app-v0.264.0) (2026-04-20)


### Features

* **platform:** update thread list indicator behavior ([#10155](https://github.com/vm0-ai/vm0/issues/10155)) ([9e5296f](https://github.com/vm0-ai/vm0/commit/9e5296faf44f94e0d20bfb32c2b6ec6b7ecc0ea2))


### Bug Fixes

* **platform:** filter empty model values in ModelSelector to avoid radix crash ([#10186](https://github.com/vm0-ai/vm0/issues/10186)) ([cba2efd](https://github.com/vm0-ai/vm0/commit/cba2efdef57ecf931b32c1040d95a157a15ecb75))
* **platform:** refetch ably token on every auth callback invocation ([#10185](https://github.com/vm0-ai/vm0/issues/10185)) ([28d8b1f](https://github.com/vm0-ai/vm0/commit/28d8b1f1ebd161853bd5941ec8d166d45d3777b7))
* **platform:** skip connector add when already enabled ([#10195](https://github.com/vm0-ai/vm0/issues/10195)) ([7df69e5](https://github.com/vm0-ai/vm0/commit/7df69e5184178f6e57a2e4b88ae20376a0e120b7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.209.1

## [0.263.0](https://github.com/vm0-ai/vm0/compare/app-v0.262.0...app-v0.263.0) (2026-04-20)


### Features

* **platform:** make mod+b shortcut toggle desktop sidebar globally ([#10187](https://github.com/vm0-ai/vm0/issues/10187)) ([dbcc700](https://github.com/vm0-ai/vm0/commit/dbcc70070b620433c79bdf057a2c00b7a14e43ec))
* **usage:** add per-user usage insight view behind usageAnalytics switch ([#10191](https://github.com/vm0-ai/vm0/issues/10191)) ([b749762](https://github.com/vm0-ai/vm0/commit/b74976215cd7b46d051d2e58d444ed88681a964e))


### Refactoring

* **platform:** clean up residual http.* overrides missed by phase 3 umbrella ([#10178](https://github.com/vm0-ai/vm0/issues/10178)) ([04df37a](https://github.com/vm0-ai/vm0/commit/04df37aa881bf578ea21eda561c3489801349c03)), closes [#10177](https://github.com/vm0-ai/vm0/issues/10177)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.209.0

## [0.262.0](https://github.com/vm0-ai/vm0/compare/app-v0.261.0...app-v0.262.0) (2026-04-19)


### Features

* add exa connector ([#10107](https://github.com/vm0-ai/vm0/issues/10107)) ([4232702](https://github.com/vm0-ai/vm0/commit/4232702d7ed283395b05825d84c37d450284c96a))
* add together connector ([#10108](https://github.com/vm0-ai/vm0/issues/10108)) ([a0e4b0d](https://github.com/vm0-ai/vm0/commit/a0e4b0dbbd84cbc3099fd66d5b2d78ada62623cd))
* **composer:** add per-run model picker next to send ([#10149](https://github.com/vm0-ai/vm0/issues/10149)) ([9079fbd](https://github.com/vm0-ai/vm0/commit/9079fbdb1f22e5669e2109856a3e9e68d183fd8f))


### Refactoring

* **platform:** migrate agents-domain server.use() overrides to mockApi (Phase 3) ([#10094](https://github.com/vm0-ai/vm0/issues/10094)) ([e9bb9de](https://github.com/vm0-ai/vm0/commit/e9bb9deb4779f6b52a20655523d4a2a22018e445))
* **platform:** migrate chat/threads/runs/logs/logs server.use() overrides to mockApi (Phase 3) ([#10105](https://github.com/vm0-ai/vm0/issues/10105)) ([acbc1c0](https://github.com/vm0-ai/vm0/commit/acbc1c08b40f21b3e4ac4028b39d8d8175f75b74))
* **platform:** migrate schedules/tasks/onboarding/phone/secrets/prefs to mockApi (Phase 3) ([#10119](https://github.com/vm0-ai/vm0/issues/10119)) ([b57db5f](https://github.com/vm0-ai/vm0/commit/b57db5f430a5c92aececac87ae15d99bfdd8479f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.208.0

## [0.261.0](https://github.com/vm0-ai/vm0/compare/app-v0.260.0...app-v0.261.0) (2026-04-19)


### Features

* ship full UX for org custom connectors (admin CRUD, per-agent auth, UI) ([#10118](https://github.com/vm0-ai/vm0/issues/10118)) ([8c9f382](https://github.com/vm0-ai/vm0/commit/8c9f3829c92dcac8feab6d259828424efdfed1b9)), closes [#10099](https://github.com/vm0-ai/vm0/issues/10099)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.207.0

## [0.260.0](https://github.com/vm0-ai/vm0/compare/app-v0.259.0...app-v0.260.0) (2026-04-19)


### Features

* add kimi/glm/minimax models to vm0 managed provider ([#10106](https://github.com/vm0-ai/vm0/issues/10106)) ([1619955](https://github.com/vm0-ai/vm0/commit/1619955f3a949352a20282c490776b0bc74df1b1))


### Bug Fixes

* **platform:** avoid empty select item value in model provider picker ([#10123](https://github.com/vm0-ai/vm0/issues/10123)) ([879ee88](https://github.com/vm0-ai/vm0/commit/879ee88558f177327228156bade1d90167666111))


### Refactoring

* **platform:** migrate voice-chat/voice-io/uploads server.use() overrides to mockApi (Phase 3 / [#10083](https://github.com/vm0-ai/vm0/issues/10083)) ([#10104](https://github.com/vm0-ai/vm0/issues/10104)) ([798c0e7](https://github.com/vm0-ai/vm0/commit/798c0e74943b6468eb5c4f9ff3dbcaf164ff80eb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.206.0

## [0.259.0](https://github.com/vm0-ai/vm0/compare/app-v0.258.0...app-v0.259.0) (2026-04-19)


### Features

* add running indicator to sidebar chat threads ([#10090](https://github.com/vm0-ai/vm0/issues/10090)) ([e60fda6](https://github.com/vm0-ai/vm0/commit/e60fda61a8503af6face1cf7ceff34c366d5932e))


### Bug Fixes

* **chat:** anchor initial thread load at the latest messages ([#10098](https://github.com/vm0-ai/vm0/issues/10098)) ([19d5fb5](https://github.com/vm0-ai/vm0/commit/19d5fb54deed6d1b7116eb44c2b3a9dcdaf7660b))


### Refactoring

* **platform:** migrate org/billing/members server.use() overrides to mockApi (Phase 3 / [#10083](https://github.com/vm0-ai/vm0/issues/10083)) ([#10095](https://github.com/vm0-ai/vm0/issues/10095)) ([8766cd3](https://github.com/vm0-ai/vm0/commit/8766cd3a3c107f806ec695d2bb5e56cca8a68f10))
* **platform:** migrate server.use() overrides to mockApi (phase 3 / [#10083](https://github.com/vm0-ai/vm0/issues/10083)) ([#10096](https://github.com/vm0-ai/vm0/issues/10096)) ([8dc26d0](https://github.com/vm0-ai/vm0/commit/8dc26d052e0d2719cd04bd64ff3f769b580c74ac))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.205.0

## [0.258.0](https://github.com/vm0-ai/vm0/compare/app-v0.257.0...app-v0.258.0) (2026-04-19)


### Features

* add amplitude connector ([#10027](https://github.com/vm0-ai/vm0/issues/10027)) ([b925f1a](https://github.com/vm0-ai/vm0/commit/b925f1a8955d7e6d97656d41d3a56afc8210fbe0))
* add attio connector ([#10026](https://github.com/vm0-ai/vm0/issues/10026)) ([7bc16d0](https://github.com/vm0-ai/vm0/commit/7bc16d0f77f7670f584ccdd97e94fb2edd46aa78))
* add freshdesk connector ([#10028](https://github.com/vm0-ai/vm0/issues/10028)) ([d133137](https://github.com/vm0-ai/vm0/commit/d1331377db59915bf75506472ab8a8982f25ad6e))


### Bug Fixes

* add trailing newline to freshdesk.svg ([d133137](https://github.com/vm0-ai/vm0/commit/d1331377db59915bf75506472ab8a8982f25ad6e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.204.0

## [0.257.0](https://github.com/vm0-ai/vm0/compare/app-v0.256.0...app-v0.257.0) (2026-04-19)


### Features

* add buffer connector ([#10024](https://github.com/vm0-ai/vm0/issues/10024)) ([631cce7](https://github.com/vm0-ai/vm0/commit/631cce7e4ac7bb3284ef8be3039336b53847185a))
* add coda connector ([#10020](https://github.com/vm0-ai/vm0/issues/10020)) ([36f0bdf](https://github.com/vm0-ai/vm0/commit/36f0bdf8025ab498a0eb5fc81a0691e8d75de241))
* add dropbox-sign connector ([#10022](https://github.com/vm0-ai/vm0/issues/10022)) ([35eef8a](https://github.com/vm0-ai/vm0/commit/35eef8ab2dda16fc5f38c56db6a89e9e6c3e7075))
* add greenhouse connector ([#10021](https://github.com/vm0-ai/vm0/issues/10021)) ([d8661de](https://github.com/vm0-ai/vm0/commit/d8661ded0a2c73479c5ed19b15bef41aaf5037b3))
* add miro connector ([#10019](https://github.com/vm0-ai/vm0/issues/10019)) ([1913dac](https://github.com/vm0-ai/vm0/commit/1913dac818876f6d62ff0aebff6f3af058061187))
* add pandadoc connector ([#10023](https://github.com/vm0-ai/vm0/issues/10023)) ([6ed9884](https://github.com/vm0-ai/vm0/commit/6ed9884e2241d4a002310efd252baa4b6f9e0f6c))
* add zoom connector ([#10018](https://github.com/vm0-ai/vm0/issues/10018)) ([3ef5838](https://github.com/vm0-ai/vm0/commit/3ef5838b90bdcb2ac76ce7945afdf18c7c92058e))
* **chat:** add thread read indicator with slack-style watermark ([#10054](https://github.com/vm0-ai/vm0/issues/10054)) ([57682ff](https://github.com/vm0-ai/vm0/commit/57682ff7c7b98a5f62b90c41ee6a08d65b5e6ca7))
* **chat:** escape first thread to agent chat page via mod+shift+up ([#10050](https://github.com/vm0-ai/vm0/issues/10050)) ([2ae20ad](https://github.com/vm0-ai/vm0/commit/2ae20ad1137c32d111e63642af0e00bb86f04b46))


### Bug Fixes

* **chat:** avoid default-avatar flicker in chat header during load ([#10052](https://github.com/vm0-ai/vm0/issues/10052)) ([612b89c](https://github.com/vm0-ai/vm0/commit/612b89c28a3d490fd43a3f41c679d9524f208af1))


### Refactoring

* drop new-chat dedup, use useLoadableSet to gate the new button ([#10047](https://github.com/vm0-ai/vm0/issues/10047)) ([cf22963](https://github.com/vm0-ai/vm0/commit/cf22963dbd5b64bbe3237e66e276ce0a56cf4086))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.203.0

## [0.256.0](https://github.com/vm0-ai/vm0/compare/app-v0.255.0...app-v0.256.0) (2026-04-19)


### Features

* add duffel connector ([#10016](https://github.com/vm0-ai/vm0/issues/10016)) ([34b2d35](https://github.com/vm0-ai/vm0/commit/34b2d3584b6d1659baeb36b941973094e04d0aaf))
* add klaviyo connector ([#10014](https://github.com/vm0-ai/vm0/issues/10014)) ([0fc1ad4](https://github.com/vm0-ai/vm0/commit/0fc1ad4d1c8b1114578ff2632f1d6a318b2fa813))
* add typeform connector ([#10015](https://github.com/vm0-ai/vm0/issues/10015)) ([c823646](https://github.com/vm0-ai/vm0/commit/c82364633a268ee090707c3a9192ce95616ad583))
* **platform:** add chat page keyboard shortcuts ([#10008](https://github.com/vm0-ai/vm0/issues/10008)) ([82bd6c1](https://github.com/vm0-ai/vm0/commit/82bd6c14569c7c5fa00a060e7f1c61b0bfa526fe))
* **shopify:** add shopify connector ([#10012](https://github.com/vm0-ai/vm0/issues/10012)) ([427d0d7](https://github.com/vm0-ai/vm0/commit/427d0d7ab5d17e53027e1ed4228202dac14ecb7a))


### Refactoring

* **platform:** extract chat-test-helpers ably triggers into mock-helpers module ([#9707](https://github.com/vm0-ai/vm0/issues/9707) phase 2) ([#10017](https://github.com/vm0-ai/vm0/issues/10017)) ([651f7c8](https://github.com/vm0-ai/vm0/commit/651f7c89fa52d0e2d8f98729dcfa920894744653))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.202.0

## [0.255.0](https://github.com/vm0-ai/vm0/compare/app-v0.254.0...app-v0.255.0) (2026-04-18)


### Features

* **platform:** persist sidebar pinned/manage/sessionList collapse state in localStorage ([#10002](https://github.com/vm0-ai/vm0/issues/10002)) ([27fb174](https://github.com/vm0-ai/vm0/commit/27fb174a4e06a49c127c9bdc6746a9936a02778a))


### Bug Fixes

* **platform:** hide chat working indicator until displayName and allFinished resolve ([#10007](https://github.com/vm0-ai/vm0/issues/10007)) ([1205f1e](https://github.com/vm0-ai/vm0/commit/1205f1ea19c4a75e6c11969d187619c0702e7865))
* **platform:** scroll chat to bottom before hiding skeleton ([#9995](https://github.com/vm0-ai/vm0/issues/9995)) ([f027529](https://github.com/vm0-ai/vm0/commit/f027529c909beb6317aa0ff6905a05a15c7524b9))


### Refactoring

* **platform:** migrate api-integrations-telegram.ts to mockapi helper ([#10006](https://github.com/vm0-ai/vm0/issues/10006)) ([1681580](https://github.com/vm0-ai/vm0/commit/1681580d9c0745306e9df4bf11315e24a26a63ba))


### Performance Improvements

* **lint:** migrate type-aware rules from typescript-eslint to oxlint-tsgolint ([#10000](https://github.com/vm0-ai/vm0/issues/10000)) ([6d95566](https://github.com/vm0-ai/vm0/commit/6d95566836bc2b993090249c0c5c5f37b047ac2d))
* **zero-schedule-page:** reduce re-renders from async subscriptions ([#10001](https://github.com/vm0-ai/vm0/issues/10001)) ([e8ed7ef](https://github.com/vm0-ai/vm0/commit/e8ed7ef196efd265e2ae343852c533627ec189b6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.201.1

## [0.254.0](https://github.com/vm0-ai/vm0/compare/app-v0.253.0...app-v0.254.0) (2026-04-18)


### Features

* **chat-threads:** track read/archive state on messages and hide archived threads ([#9976](https://github.com/vm0-ai/vm0/issues/9976)) ([56b2af5](https://github.com/vm0-ai/vm0/commit/56b2af51ec5fe9026a2860b095f69e2cf68cbd7f))


### Bug Fixes

* **composer:** mic transcription appends to draft instead of sending ([#9984](https://github.com/vm0-ai/vm0/issues/9984)) ([4948388](https://github.com/vm0-ai/vm0/commit/49483883e145b13acaf0f219118aa7ad9cd256dc))
* **platform:** restore chat scroll position at container bind time ([#9993](https://github.com/vm0-ai/vm0/issues/9993)) ([c98890e](https://github.com/vm0-ai/vm0/commit/c98890e390b3d83d533b3f8fcf70055f1dda27e3))


### Refactoring

* **platform:** migrate api-agents.ts to mock-api helper ([#9942](https://github.com/vm0-ai/vm0/issues/9942)) ([#9996](https://github.com/vm0-ai/vm0/issues/9996)) ([5638b99](https://github.com/vm0-ai/vm0/commit/5638b997637b54e43c33b70fc41c15fac5f6fad9))
* **platform:** migrate api-billing.ts to mock-api helper ([#9992](https://github.com/vm0-ai/vm0/issues/9992)) ([516fb59](https://github.com/vm0-ai/vm0/commit/516fb5946b0d183aaba95fac58ad9ffba62f9ae0))
* **platform:** migrate api-feature-switches.ts to mockapi helper ([#9998](https://github.com/vm0-ai/vm0/issues/9998)) ([0839e5c](https://github.com/vm0-ai/vm0/commit/0839e5c9bdc786d3b0897643a7a87918bcf94bcb))
* **platform:** migrate api-integrations-slack-connect.ts to mockapi helper ([#9955](https://github.com/vm0-ai/vm0/issues/9955)) ([32d8457](https://github.com/vm0-ai/vm0/commit/32d84573cbb103a9d23efea1b612b798329ee539))
* **platform:** migrate v1-runs.ts (logs) to mockApi helper ([#9986](https://github.com/vm0-ai/vm0/issues/9986)) ([e142c7b](https://github.com/vm0-ai/vm0/commit/e142c7b71bac2d463baeb919aada1dd42dd49969))


### Performance Improvements

* **platform:** push async subscriptions down into leaf components ([#9985](https://github.com/vm0-ai/vm0/issues/9985)) ([639d3bb](https://github.com/vm0-ai/vm0/commit/639d3bbf6223939554d8f4591fdfd6ff7f40466b))
* **platform:** reduce re-renders in billing dialog and auto-recharge section ([#9979](https://github.com/vm0-ai/vm0/issues/9979)) ([93976ad](https://github.com/vm0-ai/vm0/commit/93976ad9f823e6bdef9eb7d94e28a0a92fe8adca))
* **platform:** reduce re-renders in zero-schedule-detail-page ([#9997](https://github.com/vm0-ai/vm0/issues/9997)) ([7f8c3ca](https://github.com/vm0-ai/vm0/commit/7f8c3ca04bcab484a8436a7e6fd1a9a40cb68640)), closes [#9957](https://github.com/vm0-ai/vm0/issues/9957)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.201.0

## [0.253.0](https://github.com/vm0-ai/vm0/compare/app-v0.252.0...app-v0.253.0) (2026-04-18)


### Features

* persist chat scroll position across thread switches ([#9972](https://github.com/vm0-ai/vm0/issues/9972)) ([12bb1ea](https://github.com/vm0-ai/vm0/commit/12bb1ead32d511a007a4b78e78654733e1f7e2d0))
* **platform:** swap streaming cursor spinner for dot-trail pulse ([#9978](https://github.com/vm0-ai/vm0/issues/9978)) ([eca20a6](https://github.com/vm0-ai/vm0/commit/eca20a6c350553ab4646822b193b05dd0b0b850f))


### Bug Fixes

* address p0/p1 issues found in pr [#9927](https://github.com/vm0-ai/vm0/issues/9927) review ([#9971](https://github.com/vm0-ai/vm0/issues/9971)) ([0f1a87c](https://github.com/vm0-ai/vm0/commit/0f1a87c903fb08a8b51c6c5a5fdb7dbd70d5f6b5))


### Refactoring

* **platform:** migrate api-integrations-slack-org.ts to mockapi helper ([#9977](https://github.com/vm0-ai/vm0/issues/9977)) ([c8676f6](https://github.com/vm0-ai/vm0/commit/c8676f6746188f8958e9a4e6bc05c052bbbc0f37))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.200.1

## [0.252.0](https://github.com/vm0-ai/vm0/compare/app-v0.251.0...app-v0.252.0) (2026-04-18)


### Features

* add chatHeaderNewButton switch to swap invite with new chat ([#9963](https://github.com/vm0-ai/vm0/issues/9963)) ([c4bfa6f](https://github.com/vm0-ai/vm0/commit/c4bfa6f011f168096f6f1540cba220de9b0c5451))
* **platform:** open mobile sidebar via left-edge swipe in PWA mode ([#9965](https://github.com/vm0-ai/vm0/issues/9965)) ([1dacf8b](https://github.com/vm0-ai/vm0/commit/1dacf8b116c99c136fd0b43313b7f23ccf65f10c))


### Bug Fixes

* **platform:** only show auto-read toggle on chat routes ([#9962](https://github.com/vm0-ai/vm0/issues/9962)) ([2de2b56](https://github.com/vm0-ai/vm0/commit/2de2b560fa650a71014086f7ddf80ba77c287b34))


### Refactoring

* **platform:** extend mockApi with typed body/query/params ([#9707](https://github.com/vm0-ai/vm0/issues/9707) Phase 0) ([#9937](https://github.com/vm0-ai/vm0/issues/9937)) ([792bef3](https://github.com/vm0-ai/vm0/commit/792bef33a6da12f15b3a60fda873d84bf897149d))
* **platform:** migrate api-onboarding.ts to mock api helper ([#9968](https://github.com/vm0-ai/vm0/issues/9968)) ([b5d4b62](https://github.com/vm0-ai/vm0/commit/b5d4b6292a7a1b53067329e40f4aa91e8b84e6b7))
* **platform:** migrate api-org.ts to mockapi helper ([#9961](https://github.com/vm0-ai/vm0/issues/9961)) ([88fd284](https://github.com/vm0-ai/vm0/commit/88fd2847ef3f84f512b0fad5dd91f0cd0acd07ad))
* **platform:** migrate api-user-preferences.ts to mockapi helper ([#9966](https://github.com/vm0-ai/vm0/issues/9966)) ([0b42d25](https://github.com/vm0-ai/vm0/commit/0b42d253bf9ab3887d0b862a4e1b44e9cabdfa52))


### Performance Improvements

* react render profiling, sidebar optimization, and schedule dialog refactor ([#9927](https://github.com/vm0-ai/vm0/issues/9927)) ([4ebe2fd](https://github.com/vm0-ai/vm0/commit/4ebe2fd87b12a1467da38ff08f1fa0de6abb3a17))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.200.0

## [0.251.0](https://github.com/vm0-ai/vm0/compare/app-v0.250.1...app-v0.251.0) (2026-04-18)


### Features

* **platform:** add pwa install banner and rebrand to zero ([#9925](https://github.com/vm0-ai/vm0/issues/9925)) ([d2a786d](https://github.com/vm0-ai/vm0/commit/d2a786d959f79c446fd03dcbeb4cec8341421868))


### Bug Fixes

* **zero:** resync realtime loop when tab becomes visible again ([#9938](https://github.com/vm0-ai/vm0/issues/9938)) ([3e20e86](https://github.com/vm0-ai/vm0/commit/3e20e861ef04a48f6600c2f36fda6c69bc4e7a8c))


### Refactoring

* **platform:** remove schedule save dialog banner ([#9875](https://github.com/vm0-ai/vm0/issues/9875)) ([#9929](https://github.com/vm0-ai/vm0/issues/9929)) ([8f6e1a8](https://github.com/vm0-ai/vm0/commit/8f6e1a83b8adb18cbb2ae01925ac60a78e362d0e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.199.0

## [0.250.1](https://github.com/vm0-ai/vm0/compare/app-v0.250.0...app-v0.250.1) (2026-04-18)


### Bug Fixes

* **zero:** prevent chat scroll jump to top on new message arrival ([#9930](https://github.com/vm0-ai/vm0/issues/9930)) ([0d08cb7](https://github.com/vm0-ai/vm0/commit/0d08cb77d51a4fa62419990ccd67f38f969b324e))


### Refactoring

* drop thread/run-updated/tasks realtime signals, poll in non-chat views ([#9920](https://github.com/vm0-ai/vm0/issues/9920)) ([#9935](https://github.com/vm0-ai/vm0/issues/9935)) ([312eefb](https://github.com/vm0-ai/vm0/commit/312eefb33f74d1cd3619fd44a3c716c30c87f3b0))
* **platform:** add contract-driven mockApi helper (pilot for [#9707](https://github.com/vm0-ai/vm0/issues/9707)) ([#9928](https://github.com/vm0-ai/vm0/issues/9928)) ([451b832](https://github.com/vm0-ai/vm0/commit/451b8324a208646b87a77b43139b4fcb26990fb0))

## [0.250.0](https://github.com/vm0-ai/vm0/compare/app-v0.249.1...app-v0.250.0) (2026-04-18)


### Features

* **platform:** show voice chat status badge inline with title ([#9915](https://github.com/vm0-ai/vm0/issues/9915)) ([acd03cd](https://github.com/vm0-ai/vm0/commit/acd03cd79e3a863dca2b3f47a3227f8a6b5be9ed))

## [0.249.1](https://github.com/vm0-ai/vm0/compare/app-v0.249.0...app-v0.249.1) (2026-04-18)


### Bug Fixes

* show pin button on touch devices in Talk to and Manage pinned dialogs ([#9902](https://github.com/vm0-ai/vm0/issues/9902)) ([6c293f0](https://github.com/vm0-ai/vm0/commit/6c293f07bb18907af28733130b11cb0871301db5))
* **zero:** apollo connector icon invisible in dark mode ([#9907](https://github.com/vm0-ai/vm0/issues/9907)) ([70a04b6](https://github.com/vm0-ai/vm0/commit/70a04b6380307672bdb126b7c4f880e22c5755c3)), closes [#9906](https://github.com/vm0-ai/vm0/issues/9906)

## [0.249.0](https://github.com/vm0-ai/vm0/compare/app-v0.248.0...app-v0.249.0) (2026-04-18)


### Features

* add test-oauth connector for end-to-end oauth testing ([#9878](https://github.com/vm0-ai/vm0/issues/9878)) ([e8be957](https://github.com/vm0-ai/vm0/commit/e8be957b65578f32d6ca87a6f1eb248ee5737726))
* **platform:** scroll chat to bottom on send and message created ([#9900](https://github.com/vm0-ai/vm0/issues/9900)) ([7020b36](https://github.com/vm0-ai/vm0/commit/7020b363422c4814d919b2dfa89d6563575471cb))


### Refactoring

* **platform:** move voice chat status to header and fix flex layout ([#9888](https://github.com/vm0-ai/vm0/issues/9888)) ([d7e61df](https://github.com/vm0-ai/vm0/commit/d7e61dfa8ca88af1973bf5299978eb1c038dac64))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.198.0

## [0.248.0](https://github.com/vm0-ai/vm0/compare/app-v0.247.0...app-v0.248.0) (2026-04-17)


### Features

* add db9 connector ([#9849](https://github.com/vm0-ai/vm0/issues/9849)) ([ee2c5de](https://github.com/vm0-ai/vm0/commit/ee2c5dea3b5adcdb8641d26eb154fb18e6b72f32))
* add drive9 connector ([#9850](https://github.com/vm0-ai/vm0/issues/9850)) ([ea5bddb](https://github.com/vm0-ai/vm0/commit/ea5bddbec99a0e6845c773fedea613877d6d603d))


### Refactoring

* **platform:** drive chat messages from async computed, remove paged flat list ([#9872](https://github.com/vm0-ai/vm0/issues/9872)) ([5e72e26](https://github.com/vm0-ai/vm0/commit/5e72e26419f9beed10716df7034302ad9adb816d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.197.0

## [0.247.0](https://github.com/vm0-ai/vm0/compare/app-v0.246.2...app-v0.247.0) (2026-04-17)


### Features

* add msg9 connector ([#9848](https://github.com/vm0-ai/vm0/issues/9848)) ([675abd9](https://github.com/vm0-ai/vm0/commit/675abd93366c0c1c9a027cf60690d895af377fa8))


### Bug Fixes

* **platform+web:** stabilize chat thinking indicator and publish cancel signals ([#9866](https://github.com/vm0-ai/vm0/issues/9866)) ([51c7152](https://github.com/vm0-ai/vm0/commit/51c7152f8822d451452b8c6aa6426cdb534e2557))
* **platform:** only show thinking indicator when awaiting reply to user ([#9858](https://github.com/vm0-ai/vm0/issues/9858)) ([c09c03d](https://github.com/vm0-ai/vm0/commit/c09c03dff373e0abe400e9903925746e9f71b9a1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.196.0

## [0.246.2](https://github.com/vm0-ai/vm0/compare/app-v0.246.1...app-v0.246.2) (2026-04-17)


### Refactoring

* **platform:** switch chat to paged messages and remove RunLoop ([#9618](https://github.com/vm0-ai/vm0/issues/9618)) ([484e020](https://github.com/vm0-ai/vm0/commit/484e0208633127538570823d84aa2d5b7209c515))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.195.1

## [0.246.1](https://github.com/vm0-ai/vm0/compare/app-v0.246.0...app-v0.246.1) (2026-04-17)


### Bug Fixes

* **platform:** silence expected 401 auth errors in sentry ([#9838](https://github.com/vm0-ai/vm0/issues/9838)) ([08bf920](https://github.com/vm0-ai/vm0/commit/08bf920628122d4544c2e2842d540953ffea1394)), closes [#9716](https://github.com/vm0-ai/vm0/issues/9716)
* **platform:** swallow service worker registration rejection ([#9837](https://github.com/vm0-ai/vm0/issues/9837)) ([ade25b1](https://github.com/vm0-ai/vm0/commit/ade25b12299ff7ce4c525adad2e87348d0bb08d3)), closes [#9717](https://github.com/vm0-ai/vm0/issues/9717)
* **platform:** wait for updatedAt change when reconnecting a connector ([#9818](https://github.com/vm0-ai/vm0/issues/9818)) ([cad2d89](https://github.com/vm0-ai/vm0/commit/cad2d89924f9ac39f0251efcb8a25b5c94dc8674)), closes [#9812](https://github.com/vm0-ai/vm0/issues/9812)
* **voice-chat:** collapse stacked mobile headers into one ([#9835](https://github.com/vm0-ai/vm0/issues/9835)) ([e861ff0](https://github.com/vm0-ai/vm0/commit/e861ff027cbbd996f703293868b74d2913e1e13f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.195.0

## [0.246.0](https://github.com/vm0-ai/vm0/compare/app-v0.245.2...app-v0.246.0) (2026-04-17)


### Features

* **chat:** support video attachments in web chat ([#9662](https://github.com/vm0-ai/vm0/issues/9662)) ([c46edd2](https://github.com/vm0-ai/vm0/commit/c46edd2a31265d5aa2594a5adefd42fd8296afdc))


### Refactoring

* **voice-chat:** migrate voice-chat-session to zero client ([#9789](https://github.com/vm0-ai/vm0/issues/9789)) ([916d8b4](https://github.com/vm0-ai/vm0/commit/916d8b417f2124396b9f4f22b4f781858fcd3ad6))

## [0.245.2](https://github.com/vm0-ai/vm0/compare/app-v0.245.1...app-v0.245.2) (2026-04-17)


### Bug Fixes

* add display name for claude-opus-4-7 ([#9770](https://github.com/vm0-ai/vm0/issues/9770)) ([05f51e2](https://github.com/vm0-ai/vm0/commit/05f51e222c8ae30fbc30536892950ff3835be9b5))
* **slack:** use official Slack Mark SVG per brand guidelines ([#9780](https://github.com/vm0-ai/vm0/issues/9780)) ([c1bb52b](https://github.com/vm0-ai/vm0/commit/c1bb52ba4677dc159667a105ea16b7b30bfca1be))


### Refactoring

* **voice-chat:** migrate panel signals to typed zero client ([#9786](https://github.com/vm0-ai/vm0/issues/9786)) ([c1b68b1](https://github.com/vm0-ai/vm0/commit/c1b68b1d507fb90b79a3c504e30e2a2dd238da52))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.194.0

## [0.245.1](https://github.com/vm0-ai/vm0/compare/app-v0.245.0...app-v0.245.1) (2026-04-17)


### Bug Fixes

* truncate task description on mobile when steps badge present ([#9680](https://github.com/vm0-ai/vm0/issues/9680)) ([05f7daa](https://github.com/vm0-ai/vm0/commit/05f7daa39c46bc001c6a80ab90f06de64e96a2e1))

## [0.245.0](https://github.com/vm0-ai/vm0/compare/app-v0.244.1...app-v0.245.0) (2026-04-17)


### Features

* add human-readable display names for model IDs in provider selector ([#9711](https://github.com/vm0-ai/vm0/issues/9711)) ([41a6a64](https://github.com/vm0-ai/vm0/commit/41a6a64f10cb778c369a2fba3b1dcd254949b83a))

## [0.244.1](https://github.com/vm0-ai/vm0/compare/app-v0.244.0...app-v0.244.1) (2026-04-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.193.0

## [0.244.0](https://github.com/vm0-ai/vm0/compare/app-v0.243.1...app-v0.244.0) (2026-04-16)


### Features

* add voice chat mic button to chat homepage ([#9685](https://github.com/vm0-ai/vm0/issues/9685)) ([745e68d](https://github.com/vm0-ai/vm0/commit/745e68d3840c3dc7333f4bc4c14146c01d326a5f))
* **platform:** show google oauth verification notice before connecting ([#9619](https://github.com/vm0-ai/vm0/issues/9619)) ([203fb10](https://github.com/vm0-ai/vm0/commit/203fb1039031651b90d6ff87684beb5c1dd6fabb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.192.0

## [0.243.1](https://github.com/vm0-ai/vm0/compare/app-v0.243.0...app-v0.243.1) (2026-04-16)


### Bug Fixes

* **voice-chat:** make slow-brain indicator content collapsible instead of truncated ([#9652](https://github.com/vm0-ai/vm0/issues/9652)) ([7fe7d11](https://github.com/vm0-ai/vm0/commit/7fe7d11050edf21798ee0d0b047423de291401b0))


### Refactoring

* **platform:** detect setloop infinite loops and remove invitation polling ([#9647](https://github.com/vm0-ai/vm0/issues/9647)) ([29015dc](https://github.com/vm0-ai/vm0/commit/29015dc81ec05db864ba67ddaa329494b50e7182))
* **web:** simplify credit balance and support cmd+click on upgrade buttons ([#9648](https://github.com/vm0-ai/vm0/issues/9648)) ([267aace](https://github.com/vm0-ai/vm0/commit/267aace238c8a44b498f3d360c592725e7644437))

## [0.243.0](https://github.com/vm0-ai/vm0/compare/app-v0.242.6...app-v0.243.0) (2026-04-16)


### Features

* **web:** add zero web download-file command for web-uploaded files ([#9584](https://github.com/vm0-ai/vm0/issues/9584)) ([bf35045](https://github.com/vm0-ai/vm0/commit/bf350455cc2a7bddcd8ffe5e3305f224ed82f679))


### Refactoring

* **voice-chat:** unify preparing and connected states into single continuous view ([#9634](https://github.com/vm0-ai/vm0/issues/9634)) ([69b3e4e](https://github.com/vm0-ai/vm0/commit/69b3e4e02a9423ef93d4eaeac63867cfe4741549))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.191.0

## [0.242.6](https://github.com/vm0-ai/vm0/compare/app-v0.242.5...app-v0.242.6) (2026-04-16)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.190.1

## [0.242.5](https://github.com/vm0-ai/vm0/compare/app-v0.242.4...app-v0.242.5) (2026-04-16)


### Bug Fixes

* **platform:** suppress permission dialog after connector connect during onboarding ([#9601](https://github.com/vm0-ai/vm0/issues/9601)) ([a209adb](https://github.com/vm0-ai/vm0/commit/a209adba532f2be0c664a964a0dcae276c23558d))
* show agent display name on connector authorize/connect pages ([#9597](https://github.com/vm0-ai/vm0/issues/9597)) ([5afdfe9](https://github.com/vm0-ai/vm0/commit/5afdfe97bafbc29eabfc417ed0bbd6704ba93400))

## [0.242.4](https://github.com/vm0-ai/vm0/compare/app-v0.242.3...app-v0.242.4) (2026-04-16)


### Refactoring

* **platform:** remove thinking indicator and run activity line from chat ([#9564](https://github.com/vm0-ai/vm0/issues/9564)) ([37bd298](https://github.com/vm0-ai/vm0/commit/37bd2983198d5c8a319834c3e3396ee215d51dc6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.190.0

## [0.242.3](https://github.com/vm0-ai/vm0/compare/app-v0.242.2...app-v0.242.3) (2026-04-16)


### Refactoring

* **slack:** replace r2 pre-upload with on-demand download-file cli ([#9541](https://github.com/vm0-ai/vm0/issues/9541)) ([2cd0263](https://github.com/vm0-ai/vm0/commit/2cd02637302d63e7ca561fe13a9a25532465f763))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.189.1

## [0.242.2](https://github.com/vm0-ai/vm0/compare/app-v0.242.1...app-v0.242.2) (2026-04-16)


### Refactoring

* **platform:** convert ably notify to ccstate command pattern ([#9554](https://github.com/vm0-ai/vm0/issues/9554)) ([129dc85](https://github.com/vm0-ai/vm0/commit/129dc85207207600dc383620b6bc92ebb006d1d5))

## [0.242.1](https://github.com/vm0-ai/vm0/compare/app-v0.242.0...app-v0.242.1) (2026-04-15)


### Bug Fixes

* add robots.txt to platform app to block all crawlers ([#9548](https://github.com/vm0-ai/vm0/issues/9548)) ([67c896b](https://github.com/vm0-ai/vm0/commit/67c896b1851585600a7107b01f779f53a210229b)), closes [#9547](https://github.com/vm0-ai/vm0/issues/9547)

## [0.242.0](https://github.com/vm0-ai/vm0/compare/app-v0.241.0...app-v0.242.0) (2026-04-15)


### Features

* replace setloop polling with ably realtime push ([#9455](https://github.com/vm0-ai/vm0/issues/9455)) ([07329b8](https://github.com/vm0-ai/vm0/commit/07329b8cf1f9cdfe8cedbceedad9f8aea6586f29))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.189.0

## [0.241.0](https://github.com/vm0-ai/vm0/compare/app-v0.240.0...app-v0.241.0) (2026-04-15)


### Features

* **platform:** add active panel tracking and global keyboard shortcuts ([#9529](https://github.com/vm0-ai/vm0/issues/9529)) ([cebbb50](https://github.com/vm0-ai/vm0/commit/cebbb502458018b6d4493ae86a7b1c8b716f84bb))


### Bug Fixes

* **platform:** scroll to bottom immediately after sending chat message ([#9500](https://github.com/vm0-ai/vm0/issues/9500)) ([cda94c1](https://github.com/vm0-ai/vm0/commit/cda94c138bf95d2af35fae005ee909ec383b12cb))


### Refactoring

* **voice-chat:** use shared createScrollSignals factory for auto-scroll ([#9522](https://github.com/vm0-ai/vm0/issues/9522)) ([0500ad4](https://github.com/vm0-ai/vm0/commit/0500ad482fb3c62841ed8ac5f2e7ab160faf6ecb))

## [0.240.0](https://github.com/vm0-ai/vm0/compare/app-v0.239.0...app-v0.240.0) (2026-04-15)


### Features

* add imessage integration for zero agents ([#9463](https://github.com/vm0-ai/vm0/issues/9463)) ([f0a8e7a](https://github.com/vm0-ai/vm0/commit/f0a8e7a7326f1a71a4742c2fa229fa193b14e6e2))


### Bug Fixes

* prevent credit usage numbers from wrapping ([#9515](https://github.com/vm0-ai/vm0/issues/9515)) ([#9517](https://github.com/vm0-ai/vm0/issues/9517)) ([fa05e39](https://github.com/vm0-ai/vm0/commit/fa05e397a756ad9e43e7e99285278e7071fb359f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.188.0

## [0.239.0](https://github.com/vm0-ai/vm0/compare/app-v0.238.5...app-v0.239.0) (2026-04-15)


### Features

* **mission-control:** add voice chat panel for voice_chat tasks ([#9442](https://github.com/vm0-ai/vm0/issues/9442)) ([db92144](https://github.com/vm0-ai/vm0/commit/db9214426c95035206ca73102f5f5b0fb92636fc))

## [0.238.5](https://github.com/vm0-ai/vm0/compare/app-v0.238.4...app-v0.238.5) (2026-04-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.187.1

## [0.238.4](https://github.com/vm0-ai/vm0/compare/app-v0.238.3...app-v0.238.4) (2026-04-15)


### Bug Fixes

* **platform:** defer auto-scroll until after optimistic message is flushed ([#9479](https://github.com/vm0-ai/vm0/issues/9479)) ([679772c](https://github.com/vm0-ai/vm0/commit/679772cce595ff42315ae8da0620f59f190e4aa5))
* **platform:** track tts playback by run id instead of message id ([#9490](https://github.com/vm0-ai/vm0/issues/9490)) ([fbf0adf](https://github.com/vm0-ai/vm0/commit/fbf0adfefdb443efdbeb420d2fe709721872d4c1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.187.0

## [0.238.3](https://github.com/vm0-ai/vm0/compare/app-v0.238.2...app-v0.238.3) (2026-04-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.186.1

## [0.238.2](https://github.com/vm0-ai/vm0/compare/app-v0.238.1...app-v0.238.2) (2026-04-15)


### Bug Fixes

* **platform:** auto-scroll to bottom on container resize ([#9462](https://github.com/vm0-ai/vm0/issues/9462)) ([4ea8503](https://github.com/vm0-ai/vm0/commit/4ea8503476fbc352b78b75f12c348daf087a0b9c))

## [0.238.1](https://github.com/vm0-ai/vm0/compare/app-v0.238.0...app-v0.238.1) (2026-04-15)


### Bug Fixes

* **platform:** scroll to bottom after initial messages render on chat open ([#9436](https://github.com/vm0-ai/vm0/issues/9436)) ([f08d1b8](https://github.com/vm0-ai/vm0/commit/f08d1b85889074bd31701ee8410b6e3ea30841e5))

## [0.238.0](https://github.com/vm0-ai/vm0/compare/app-v0.237.1...app-v0.238.0) (2026-04-15)


### Features

* update pro plan pricing to $20/month and free credits to 100k ([#9422](https://github.com/vm0-ai/vm0/issues/9422)) ([b9e6989](https://github.com/vm0-ai/vm0/commit/b9e6989dafb2ae9e117febc6b8b9547074afd640))
* **zero:** add run id to run context response ([#9433](https://github.com/vm0-ai/vm0/issues/9433)) ([410899f](https://github.com/vm0-ai/vm0/commit/410899f4dcb33b2f7b1cc8863f6343f9d91ddeb3))


### Bug Fixes

* **connectors:** add workflow scope to GitHub OAuth connector ([#9403](https://github.com/vm0-ai/vm0/issues/9403)) ([9785d10](https://github.com/vm0-ai/vm0/commit/9785d104a20867b4d4e423f5b9fe636f02222049))
* **platform:** wrap tts cleanup fn in updater to prevent immediate execution ([#9439](https://github.com/vm0-ai/vm0/issues/9439)) ([130d7f5](https://github.com/vm0-ai/vm0/commit/130d7f53c0554fdbc94b899b6a04e8b51d16f73d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.186.0

## [0.237.1](https://github.com/vm0-ai/vm0/compare/app-v0.237.0...app-v0.237.1) (2026-04-15)


### Refactoring

* **platform:** extract shared auto-scroll factory and improve scroll behavior ([#9388](https://github.com/vm0-ai/vm0/issues/9388)) ([91f6d67](https://github.com/vm0-ai/vm0/commit/91f6d67760b5a485c3b9c0d72b20876c94cb3b95))

## [0.237.0](https://github.com/vm0-ai/vm0/compare/app-v0.236.0...app-v0.237.0) (2026-04-15)


### Features

* **connectors:** add Anthropic Managed Agents connector ([#9386](https://github.com/vm0-ai/vm0/issues/9386)) ([d4f7447](https://github.com/vm0-ai/vm0/commit/d4f7447083ed6dc406ff29c4a284b1badbd0c144))
* **voice-chat:** change default model to gpt-realtime-mini ([ff02915](https://github.com/vm0-ai/vm0/commit/ff029158615ac91dc5f75618b07695ef940bdb2d))
* **voice-chat:** change default model to gpt-realtime-mini ([#9387](https://github.com/vm0-ai/vm0/issues/9387)) ([1b09311](https://github.com/vm0-ai/vm0/commit/1b093117a9f7b54b6582ff6dfb3e9ecfa4721035))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.185.0

## [0.236.0](https://github.com/vm0-ai/vm0/compare/app-v0.235.5...app-v0.236.0) (2026-04-14)


### Features

* **connector:** add google meet oauth connector ([#9330](https://github.com/vm0-ai/vm0/issues/9330)) ([15e1a5b](https://github.com/vm0-ai/vm0/commit/15e1a5baaf6fc4e460233a804065193e13027520))
* **mission-control:** refresh activity panel when latest run changes ([#9325](https://github.com/vm0-ai/vm0/issues/9325)) ([159a82b](https://github.com/vm0-ai/vm0/commit/159a82bfd70d1eaaf3a9a7cfcce0201f31aa8380))


### Refactoring

* **mission-control:** fix p1 issues from pr review ([#9337](https://github.com/vm0-ai/vm0/issues/9337)) ([f3d5cd6](https://github.com/vm0-ai/vm0/commit/f3d5cd6174ab41c5e6e01ddf9ad968f1d0745ce2))
* **platform:** migrate dom ref setters to use onref pattern ([#9301](https://github.com/vm0-ai/vm0/issues/9301)) ([4012d49](https://github.com/vm0-ai/vm0/commit/4012d49f369800ae2a9bbd40757f9e2501297042))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.184.0

## [0.235.5](https://github.com/vm0-ai/vm0/compare/app-v0.235.4...app-v0.235.5) (2026-04-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.183.0

## [0.235.4](https://github.com/vm0-ai/vm0/compare/app-v0.235.3...app-v0.235.4) (2026-04-14)


### Bug Fixes

* **platform:** refresh pinned agents after onboarding completion ([#9312](https://github.com/vm0-ai/vm0/issues/9312)) ([0a1a050](https://github.com/vm0-ai/vm0/commit/0a1a0508ad979f65cd1cf8a00cc02cee1cd93620)), closes [#9308](https://github.com/vm0-ai/vm0/issues/9308)
* **platform:** reset tts playback state on signal abort ([#9303](https://github.com/vm0-ai/vm0/issues/9303)) ([fd04820](https://github.com/vm0-ai/vm0/commit/fd0482007cf60a83e1a8e253a80f4e76b64f2797))


### Refactoring

* **platform:** remove runs tab from usage page ([#9310](https://github.com/vm0-ai/vm0/issues/9310)) ([b4c8f68](https://github.com/vm0-ai/vm0/commit/b4c8f68e195c4261233b05a0677101616ec67eaf))

## [0.235.3](https://github.com/vm0-ai/vm0/compare/app-v0.235.2...app-v0.235.3) (2026-04-14)


### Bug Fixes

* **voice-chat:** change default model back to gpt-realtime ([#9292](https://github.com/vm0-ai/vm0/issues/9292)) ([80f531a](https://github.com/vm0-ai/vm0/commit/80f531a9a2ab83ed2332ed28342ee08ecd28d34f))

## [0.235.2](https://github.com/vm0-ai/vm0/compare/app-v0.235.1...app-v0.235.2) (2026-04-14)


### Refactoring

* **platform:** clean up chat thread signals and move composer out of scroll container ([#9277](https://github.com/vm0-ai/vm0/issues/9277)) ([42f47c1](https://github.com/vm0-ai/vm0/commit/42f47c140479410d94403e58e1594479866e82ce))

## [0.235.1](https://github.com/vm0-ai/vm0/compare/app-v0.235.0...app-v0.235.1) (2026-04-14)


### Bug Fixes

* **voice-io:** move audio context creation before async fetch for gesture activation ([#9272](https://github.com/vm0-ai/vm0/issues/9272)) ([42ab356](https://github.com/vm0-ai/vm0/commit/42ab35694d2a68f96f13dc8570f11e3056c5fd7d)), closes [#9252](https://github.com/vm0-ai/vm0/issues/9252)

## [0.235.0](https://github.com/vm0-ai/vm0/compare/app-v0.234.0...app-v0.235.0) (2026-04-14)


### Features

* **voice-chat:** show prepared meetings list on voice chat page ([#9253](https://github.com/vm0-ai/vm0/issues/9253)) ([4b87a4f](https://github.com/vm0-ai/vm0/commit/4b87a4faebff29642789e2085b694477a398df42))


### Refactoring

* **platform:** move auto-read tts logic from react hooks to signal commands ([#9258](https://github.com/vm0-ai/vm0/issues/9258)) ([f36ecce](https://github.com/vm0-ai/vm0/commit/f36ecceb8fdc7933886d3c02bcdf7b5349f1c050))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.182.0

## [0.234.0](https://github.com/vm0-ai/vm0/compare/app-v0.233.0...app-v0.234.0) (2026-04-14)


### Features

* **voice-chat:** change push-to-talk from hold to toggle mode ([#9249](https://github.com/vm0-ai/vm0/issues/9249)) ([8d57c45](https://github.com/vm0-ai/vm0/commit/8d57c45b6f74c97d4d1291116a23c2128502be98)), closes [#9245](https://github.com/vm0-ai/vm0/issues/9245)


### Bug Fixes

* harden voice-chat preparation with enum status and failed early exit ([#9170](https://github.com/vm0-ai/vm0/issues/9170)) ([#9173](https://github.com/vm0-ai/vm0/issues/9173)) ([9a2b34f](https://github.com/vm0-ai/vm0/commit/9a2b34f3883d0d96c4c1014b2413c0adb3517ec1))


### Refactoring

* **platform:** improve voice-io stt signals and add mic button tests ([#9115](https://github.com/vm0-ai/vm0/issues/9115)) ([45e6090](https://github.com/vm0-ai/vm0/commit/45e6090607901acce5e226144f4b6fc566bfeb15))
* **platform:** redirect to web choose-organization instead of /select-org ([#9235](https://github.com/vm0-ai/vm0/issues/9235)) ([d9b9647](https://github.com/vm0-ai/vm0/commit/d9b9647b22d67bc041e5378176bf26d9f23e7ccd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.181.1

## [0.233.0](https://github.com/vm0-ai/vm0/compare/app-v0.232.2...app-v0.233.0) (2026-04-14)


### Features

* persist chat thread drafts to database with local-first sync ([#9202](https://github.com/vm0-ai/vm0/issues/9202)) ([a5a0c1d](https://github.com/vm0-ai/vm0/commit/a5a0c1dfb7deff0632f57cdd84f2a1a4dad1a700))


### Bug Fixes

* **voice-io:** show tts controls on mobile touch devices ([#9226](https://github.com/vm0-ai/vm0/issues/9226)) ([#9229](https://github.com/vm0-ai/vm0/issues/9229)) ([f65ef35](https://github.com/vm0-ai/vm0/commit/f65ef35a93bad5aa63abcf7c10cea2c4a0f2c586))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.181.0

## [0.232.2](https://github.com/vm0-ai/vm0/compare/app-v0.232.1...app-v0.232.2) (2026-04-13)


### Bug Fixes

* **voice-chat:** re-acquire wake lock after system release ([#9211](https://github.com/vm0-ai/vm0/issues/9211)) ([d317030](https://github.com/vm0-ai/vm0/commit/d3170302e9621ee68004cf3ed2fda73dbccc190d))

## [0.232.1](https://github.com/vm0-ai/vm0/compare/app-v0.232.0...app-v0.232.1) (2026-04-13)


### Bug Fixes

* **voice-chat:** pre-fetch cached preparation events before webrtc connection ([#9210](https://github.com/vm0-ai/vm0/issues/9210)) ([5d71c76](https://github.com/vm0-ai/vm0/commit/5d71c76b949b8f3f785c3227b4e7230cd515a639))

## [0.232.0](https://github.com/vm0-ai/vm0/compare/app-v0.231.0...app-v0.232.0) (2026-04-13)


### Features

* **platform:** add optimistic archive for mission control task cards ([#9171](https://github.com/vm0-ai/vm0/issues/9171)) ([22c41d5](https://github.com/vm0-ai/vm0/commit/22c41d5b820a88f46b3bdd4751e0f6e050b17784))
* **platform:** integrate preparation cache into chat mode session start ([#9188](https://github.com/vm0-ai/vm0/issues/9188)) ([b4b6e04](https://github.com/vm0-ai/vm0/commit/b4b6e04f2b39da1fedf3a88c2076763e06091efe))


### Bug Fixes

* **voice-chat:** always use org default agent for Voice On ([#9198](https://github.com/vm0-ai/vm0/issues/9198)) ([ea642f8](https://github.com/vm0-ai/vm0/commit/ea642f87177322725ccbfab200a06d7fb0d05bc3))
* **voice-chat:** preserve ready preparation state across page navigation ([#9195](https://github.com/vm0-ai/vm0/issues/9195)) ([2568bac](https://github.com/vm0-ai/vm0/commit/2568bacc6c9f40cab29b0f4ce4f5f984dd68ebe8))
* **voice-io:** use pcm + web audio api for tts playback ([#9196](https://github.com/vm0-ai/vm0/issues/9196)) ([1b78598](https://github.com/vm0-ai/vm0/commit/1b78598dc60af1a467ead6a45b3c5229b4b5833c)), closes [#9191](https://github.com/vm0-ai/vm0/issues/9191)


### Refactoring

* rename voice-io feature switch to audio-io ([#9190](https://github.com/vm0-ai/vm0/issues/9190)) ([d45b1bb](https://github.com/vm0-ai/vm0/commit/d45b1bbdcda2b66f03ae21a5d1f2f3bc263dbc06))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.180.2

## [0.231.0](https://github.com/vm0-ai/vm0/compare/app-v0.230.0...app-v0.231.0) (2026-04-13)


### Features

* **platform:** add unread tracking for mission control tasks ([#9166](https://github.com/vm0-ai/vm0/issues/9166)) ([543d94e](https://github.com/vm0-ai/vm0/commit/543d94eba0b92a390477f8e4fc9171f8ede96541))
* **web:** reorder voice chat model tabs to put default first ([#9179](https://github.com/vm0-ai/vm0/issues/9179)) ([f72be97](https://github.com/vm0-ai/vm0/commit/f72be970efa55447dde3bfad71a4e475efc7c2a0))


### Bug Fixes

* **platform:** center voice-chat footer controls on desktop ([#9180](https://github.com/vm0-ai/vm0/issues/9180)) ([c152fa6](https://github.com/vm0-ai/vm0/commit/c152fa6dc27c067d725bfc3d56c29fe1facdc3b2))

## [0.230.0](https://github.com/vm0-ai/vm0/compare/app-v0.229.0...app-v0.230.0) (2026-04-13)


### Features

* upgrade stt model from whisper-1 to gpt-4o-mini-transcribe ([#9167](https://github.com/vm0-ai/vm0/issues/9167)) ([18a84b1](https://github.com/vm0-ai/vm0/commit/18a84b120760ab8c21eb56cc9c3c8b14ca0b52df)), closes [#9164](https://github.com/vm0-ai/vm0/issues/9164)


### Refactoring

* **platform:** remove usage tab from sidebar and its feature switch ([#9160](https://github.com/vm0-ai/vm0/issues/9160)) ([08d922d](https://github.com/vm0-ai/vm0/commit/08d922d28c76f83633ed6d9884ac2591ad188521))


### Performance Improvements

* **voice-io:** stream tts audio for faster time-to-first-sound ([#9161](https://github.com/vm0-ai/vm0/issues/9161)) ([812b4d5](https://github.com/vm0-ai/vm0/commit/812b4d5f7abe9cc78cba4723730cfb22ea01c755)), closes [#9154](https://github.com/vm0-ai/vm0/issues/9154)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.180.1

## [0.229.0](https://github.com/vm0-ai/vm0/compare/app-v0.228.0...app-v0.229.0) (2026-04-13)


### Features

* **insights:** abbreviate credit numbers with k/m suffix ([#9149](https://github.com/vm0-ai/vm0/issues/9149)) ([3b34b36](https://github.com/vm0-ai/vm0/commit/3b34b36bf5508e8d4d034915bc92961b923a1a40))
* **platform:** redesign activity panel with chat-like layout for non-chat tasks ([#9139](https://github.com/vm0-ai/vm0/issues/9139)) ([bc73545](https://github.com/vm0-ai/vm0/commit/bc735456aa5b5d2512be5e96ee9a9b5503b8e1f6))
* **voice-chat:** add meeting preparation frontend ([#9151](https://github.com/vm0-ai/vm0/issues/9151)) ([0f32dd5](https://github.com/vm0-ai/vm0/commit/0f32dd5d9f5b15ff3847e7f6f8fc313f4976e73a)), closes [#9087](https://github.com/vm0-ai/vm0/issues/9087)


### Refactoring

* unify member and admin onboarding connector flow ([#9129](https://github.com/vm0-ai/vm0/issues/9129)) ([#9140](https://github.com/vm0-ai/vm0/issues/9140)) ([fa03f61](https://github.com/vm0-ai/vm0/commit/fa03f61411c81522e2dd695d3bcbe08f6c952740))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.180.0

## [0.228.0](https://github.com/vm0-ai/vm0/compare/app-v0.227.0...app-v0.228.0) (2026-04-13)


### Features

* **voice-chat:** change default realtime model to gpt-realtime-mini ([#9124](https://github.com/vm0-ai/vm0/issues/9124)) ([b45eefe](https://github.com/vm0-ai/vm0/commit/b45eefeec61327ab7b22bd1afde9018204feb801)), closes [#9119](https://github.com/vm0-ai/vm0/issues/9119)


### Bug Fixes

* **voice-io:** wire abort signals and improve cleanup edge cases ([#9121](https://github.com/vm0-ai/vm0/issues/9121)) ([#9126](https://github.com/vm0-ai/vm0/issues/9126)) ([6f78c7b](https://github.com/vm0-ai/vm0/commit/6f78c7b1a8161c8fc7e1905a10ed91da2735ff9d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.179.0

## [0.227.0](https://github.com/vm0-ai/vm0/compare/app-v0.226.0...app-v0.227.0) (2026-04-13)


### Features

* **mission-control:** optimistic task signal for instant chat thread visibility ([#9095](https://github.com/vm0-ai/vm0/issues/9095)) ([bd6ec8d](https://github.com/vm0-ai/vm0/commit/bd6ec8d1496a69d41c4bc78189494208cdc78fa2))
* **platform:** add tts read-aloud button and auto-read toggle ([#9105](https://github.com/vm0-ai/vm0/issues/9105)) ([faa2c12](https://github.com/vm0-ai/vm0/commit/faa2c12a089887a5736265e8851adf328fd2f72e)), closes [#9080](https://github.com/vm0-ai/vm0/issues/9080)
* **voice-chat:** integrate preparation cache into session creation ([#9112](https://github.com/vm0-ai/vm0/issues/9112)) ([856c342](https://github.com/vm0-ai/vm0/commit/856c3421897a2a3019d496b67ef7506760e33baa)), closes [#9086](https://github.com/vm0-ai/vm0/issues/9086)
* **voice-io:** add microphone button to chat composer for voice input ([#9108](https://github.com/vm0-ai/vm0/issues/9108)) ([01dce7e](https://github.com/vm0-ai/vm0/commit/01dce7e1e61a38f00b945ff8865263e9f78115ab)), closes [#9081](https://github.com/vm0-ai/vm0/issues/9081)


### Bug Fixes

* **web:** refresh token and retry once before redirecting on 401 ([#9096](https://github.com/vm0-ai/vm0/issues/9096)) ([127e744](https://github.com/vm0-ai/vm0/commit/127e7443d7a66b08f6ed623876d1e4fc858ad451))

## [0.226.0](https://github.com/vm0-ai/vm0/compare/app-v0.225.0...app-v0.226.0) (2026-04-13)


### Features

* **usage:** add daily credits chart and per-run records ([#9047](https://github.com/vm0-ai/vm0/issues/9047)) ([589df8c](https://github.com/vm0-ai/vm0/commit/589df8cbf8b8d5ee495279a3f6e51aed47305daa))
* **voice-chat:** add realtime model selector ([#9082](https://github.com/vm0-ai/vm0/issues/9082)) ([b296034](https://github.com/vm0-ai/vm0/commit/b29603432ca146738da80d3f346bf714eb53ad2b)), closes [#9074](https://github.com/vm0-ai/vm0/issues/9074)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.178.0

## [0.225.0](https://github.com/vm0-ai/vm0/compare/app-v0.224.0...app-v0.225.0) (2026-04-13)


### Features

* add archive status to mission control task list ([#9063](https://github.com/vm0-ai/vm0/issues/9063)) ([ca4d008](https://github.com/vm0-ai/vm0/commit/ca4d00838afb45f957c5a8d5fbc4dcde58265382))
* **web:** group feature-gated sidebar footer items into more menu ([#9055](https://github.com/vm0-ai/vm0/issues/9055)) ([bfecba3](https://github.com/vm0-ai/vm0/commit/bfecba3b2c56267e129e8b645ed43b541568b1fd))


### Bug Fixes

* render schedule list items as real anchor links ([#8690](https://github.com/vm0-ai/vm0/issues/8690)) ([#9072](https://github.com/vm0-ai/vm0/issues/9072)) ([5dea27d](https://github.com/vm0-ai/vm0/commit/5dea27d5cc27223a1699f915f5dd3c51c697544d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.177.0

## [0.224.0](https://github.com/vm0-ai/vm0/compare/app-v0.223.0...app-v0.224.0) (2026-04-13)


### Features

* Mission Control c shortcut opens new chat dialog (no navigation) ([#9041](https://github.com/vm0-ai/vm0/issues/9041)) ([fb2f799](https://github.com/vm0-ai/vm0/commit/fb2f7991d4a1a313bc50e54aef75959572388b23))
* **web:** add no-duplicate-route-param lint rule and rename activity route param ([#8843](https://github.com/vm0-ai/vm0/issues/8843)) ([815090a](https://github.com/vm0-ai/vm0/commit/815090a2e82252dcea3b26bfda8c47cf4b53aa62))


### Bug Fixes

* **platform:** gate create workspace button on clerk user permission ([#8835](https://github.com/vm0-ai/vm0/issues/8835)) ([8098613](https://github.com/vm0-ai/vm0/commit/80986134b3bcd4ad84716d2770f6f9d2dba84754))
* sidebar collapse button closes mobile overlay ([#8978](https://github.com/vm0-ai/vm0/issues/8978)) ([ee3d653](https://github.com/vm0-ai/vm0/commit/ee3d6539fcc58d3fcddfa848b3b78f5938155d86))


### Refactoring

* extract navigation out of sendNewThreadMessage$ ([#9040](https://github.com/vm0-ai/vm0/issues/9040)) ([054ff0c](https://github.com/vm0-ai/vm0/commit/054ff0c04115cd445ca12660e784bae13fb328d9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.176.0

## [0.223.0](https://github.com/vm0-ai/vm0/compare/app-v0.222.0...app-v0.223.0) (2026-04-12)


### Features

* **mission-control:** add voice chat task to mission control ([#9031](https://github.com/vm0-ai/vm0/issues/9031)) ([366c655](https://github.com/vm0-ai/vm0/commit/366c655e8f1836b2f9fee778490fef0d7bb68f61))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.175.0

## [0.222.0](https://github.com/vm0-ai/vm0/compare/app-v0.221.0...app-v0.222.0) (2026-04-12)


### Features

* add Mission Control sidebar entry behind feature flag ([#9029](https://github.com/vm0-ai/vm0/issues/9029)) ([c98fd7c](https://github.com/vm0-ai/vm0/commit/c98fd7caef80f5ed9a3625900203f24ef01ae4b0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.174.0

## [0.221.0](https://github.com/vm0-ai/vm0/compare/app-v0.220.0...app-v0.221.0) (2026-04-12)


### Features

* add mission_control voice chat mode ([#9026](https://github.com/vm0-ai/vm0/issues/9026)) ([261147b](https://github.com/vm0-ai/vm0/commit/261147b9b38f4017ae33a4136045244c055ae1c9))


### Refactoring

* **chat:** extract navigation from create new chat thread command ([#9024](https://github.com/vm0-ai/vm0/issues/9024)) ([8b9982f](https://github.com/vm0-ai/vm0/commit/8b9982fe52ae9c44e67b22ded25e47751d467382))

## [0.220.0](https://github.com/vm0-ai/vm0/compare/app-v0.219.0...app-v0.220.0) (2026-04-12)


### Features

* add cross-platform keyboard shortcut system ([#8966](https://github.com/vm0-ai/vm0/issues/8966)) ([7d5698c](https://github.com/vm0-ai/vm0/commit/7d5698cd86ff0b498ce5d40c2ba0f1ccac380c3d))
* **mission-control:** replace selected task state with dom focus navigation ([#9022](https://github.com/vm0-ai/vm0/issues/9022)) ([4f68649](https://github.com/vm0-ai/vm0/commit/4f686490e888049940cbd3160ed3af77138dc7b1))


### Bug Fixes

* **platform:** log detached promise rejections instead of rethrowing ([#8991](https://github.com/vm0-ai/vm0/issues/8991)) ([57d5470](https://github.com/vm0-ai/vm0/commit/57d5470f398849337d2f60b31c2500a4bb216c6e)), closes [#8984](https://github.com/vm0-ai/vm0/issues/8984)
* **web:** filter axios errors from termly resource-blocker in sentry ([#8988](https://github.com/vm0-ai/vm0/issues/8988)) ([af94389](https://github.com/vm0-ai/vm0/commit/af94389088df0e7cf26ef6007e190be9cce49f13)), closes [#8983](https://github.com/vm0-ai/vm0/issues/8983)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.173.0

## [0.219.0](https://github.com/vm0-ai/vm0/compare/app-v0.218.0...app-v0.219.0) (2026-04-11)


### Features

* mission control resizable panels with enriched panel titles ([#8964](https://github.com/vm0-ai/vm0/issues/8964)) ([0d5dbee](https://github.com/vm0-ai/vm0/commit/0d5dbee5332cd3afedde025accba4103038d3f7e))

## [0.218.0](https://github.com/vm0-ai/vm0/compare/app-v0.217.0...app-v0.218.0) (2026-04-11)


### Features

* redesign mission control panels from thread-centric to task-centric ([#8948](https://github.com/vm0-ai/vm0/issues/8948)) ([7fbd704](https://github.com/vm0-ai/vm0/commit/7fbd7041e549e8944f21ec1ed6c38f7c39eb36b6))


### Bug Fixes

* **platform:** use useLastResolved for thread avatar/name signals to prevent flicker ([#8954](https://github.com/vm0-ai/vm0/issues/8954)) ([d2d0f1e](https://github.com/vm0-ai/vm0/commit/d2d0f1e55bf39f633ddac05e94f3fc6acfb98961))


### Refactoring

* split mission-control-page into task-card, task-list, and thread-panel modules ([#8945](https://github.com/vm0-ai/vm0/issues/8945)) ([f3d806e](https://github.com/vm0-ai/vm0/commit/f3d806eccc74bf4a3c7fc5cf28fcf3497bebf587))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.172.2

## [0.217.0](https://github.com/vm0-ai/vm0/compare/app-v0.216.0...app-v0.217.0) (2026-04-11)


### Features

* Mission Control multi-thread panel ([#8944](https://github.com/vm0-ai/vm0/issues/8944)) ([965bbb2](https://github.com/vm0-ai/vm0/commit/965bbb27afd8a526a87eab419a12048fd66dc3ce))


### Refactoring

* extract chat thread signal factory for multi-instance support ([#8938](https://github.com/vm0-ai/vm0/issues/8938)) ([ad67e05](https://github.com/vm0-ai/vm0/commit/ad67e05f54d76dbfa99917c0702507d03bc87236))

## [0.216.0](https://github.com/vm0-ai/vm0/compare/app-v0.215.1...app-v0.216.0) (2026-04-11)


### Features

* acquire screen wake lock during voice chat sessions ([#8936](https://github.com/vm0-ai/vm0/issues/8936)) ([5d64f98](https://github.com/vm0-ai/vm0/commit/5d64f98d26b40d976c8e068fa1307826f6a7f642))


### Refactoring

* **phone:** migrate phone-signals to typed zeroClient$ contracts ([#8863](https://github.com/vm0-ai/vm0/issues/8863)) ([53375cd](https://github.com/vm0-ai/vm0/commit/53375cda524b7e025cc566aa6b027805cb805510))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.172.1

## [0.215.1](https://github.com/vm0-ai/vm0/compare/app-v0.215.0...app-v0.215.1) (2026-04-11)


### Bug Fixes

* **voice-chat:** add echo cancellation for hands-free speaker mode ([#8932](https://github.com/vm0-ai/vm0/issues/8932)) ([cbaf14e](https://github.com/vm0-ai/vm0/commit/cbaf14e92602a03afb5ad8765698303a7850c60b))
* **voice-chat:** mobile-friendly footer layout for voice chat controls ([#8933](https://github.com/vm0-ai/vm0/issues/8933)) ([110f808](https://github.com/vm0-ai/vm0/commit/110f808810ab41965ac9d24aaffb73b88b904fde))
* **voice-chat:** skip response.create for slow-brain thinking events ([#8921](https://github.com/vm0-ai/vm0/issues/8921)) ([c5c2b0c](https://github.com/vm0-ai/vm0/commit/c5c2b0ca407b63ecd9caaf61ce9969c45bd43313)), closes [#8920](https://github.com/vm0-ai/vm0/issues/8920)

## [0.215.0](https://github.com/vm0-ai/vm0/compare/app-v0.214.1...app-v0.215.0) (2026-04-10)


### Features

* add ai-generated run summaries to mission control ([#8902](https://github.com/vm0-ai/vm0/issues/8902)) ([b12fe2d](https://github.com/vm0-ai/vm0/commit/b12fe2d55a362c0470d62f4191a7b1ddff9424e5))
* **voice-chat:** split idle page into quick chat and voice meeting sections ([#8918](https://github.com/vm0-ai/vm0/issues/8918)) ([c0ecbd6](https://github.com/vm0-ai/vm0/commit/c0ecbd6d7a671f65bed06b37bba9ec3e4f422648))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.172.0

## [0.214.1](https://github.com/vm0-ai/vm0/compare/app-v0.214.0...app-v0.214.1) (2026-04-10)


### Bug Fixes

* **voice-chat:** send response.create after ptt commit to trigger agent response ([#8905](https://github.com/vm0-ai/vm0/issues/8905)) ([6d4323b](https://github.com/vm0-ai/vm0/commit/6d4323b2983580b940f54b76cbfba2cf217a8a87)), closes [#8904](https://github.com/vm0-ai/vm0/issues/8904)

## [0.214.0](https://github.com/vm0-ai/vm0/compare/app-v0.213.0...app-v0.214.0) (2026-04-10)


### Features

* add description infrastructure to feature switch system ([#8874](https://github.com/vm0-ai/vm0/issues/8874)) ([af2170e](https://github.com/vm0-ai/vm0/commit/af2170e63e9655b71b4b4523621ea24a857d9a04))
* **platform:** add compliance trust badges to onboarding ([#8824](https://github.com/vm0-ai/vm0/issues/8824)) ([6d57b08](https://github.com/vm0-ai/vm0/commit/6d57b0804bfaa675aafbe26452efca90e126dbfa))


### Bug Fixes

* **platform:** redesign avatar and create-agent dialogs ([#8806](https://github.com/vm0-ai/vm0/issues/8806)) ([5009fde](https://github.com/vm0-ai/vm0/commit/5009fde6284b09052c770d9ef23ce756337755c5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.171.0

## [0.213.0](https://github.com/vm0-ai/vm0/compare/app-v0.212.0...app-v0.213.0) (2026-04-10)


### Features

* **mission-control:** implement tasks list with keyboard navigation ([#8866](https://github.com/vm0-ai/vm0/issues/8866)) ([d5906b2](https://github.com/vm0-ai/vm0/commit/d5906b228a9505d1115ff1dac66e0df76110423f))
* **voice-chat:** add preparation timeout with auto-cancel and elapsed time ([#8862](https://github.com/vm0-ai/vm0/issues/8862)) ([f7ecffa](https://github.com/vm0-ai/vm0/commit/f7ecffa00c570e4ff05e6db007c6c1d8c60f73fa)), closes [#8848](https://github.com/vm0-ai/vm0/issues/8848)
* **voice-chat:** add webrtc disconnect recovery with auto-reconnect ([#8861](https://github.com/vm0-ai/vm0/issues/8861)) ([d93cfc7](https://github.com/vm0-ai/vm0/commit/d93cfc7e4168467a15b835391fe1979340a6dfe2))


### Bug Fixes

* **voice-chat:** move prep event injection into dc open handler ([#8868](https://github.com/vm0-ai/vm0/issues/8868)) ([90a655c](https://github.com/vm0-ai/vm0/commit/90a655c89b2876cb773dfbdbfe95e089dd661bdb)), closes [#8867](https://github.com/vm0-ai/vm0/issues/8867)
* **voice-chat:** wrap end-session in transaction and surface polling errors ([#8860](https://github.com/vm0-ai/vm0/issues/8860)) ([cd28f27](https://github.com/vm0-ai/vm0/commit/cd28f276104f0174b3c53fedbbe3f53605d73590))

## [0.212.0](https://github.com/vm0-ai/vm0/compare/app-v0.211.1...app-v0.212.0) (2026-04-10)


### Features

* replace mandatory SMS consent text with optional checkbox on phone page ([#8852](https://github.com/vm0-ai/vm0/issues/8852)) ([961a0ca](https://github.com/vm0-ai/vm0/commit/961a0cad3f14c236a29915344e9d021327063d20))


### Bug Fixes

* increase voice VAD threshold to reduce false triggers ([#8858](https://github.com/vm0-ai/vm0/issues/8858)) ([53b5e22](https://github.com/vm0-ai/vm0/commit/53b5e22945b016dd2d0558697fca4f1f2dbc7bbd))
* **voice-chat:** inject preparation events into fast brain after webrtc connects ([#8855](https://github.com/vm0-ai/vm0/issues/8855)) ([a90de33](https://github.com/vm0-ai/vm0/commit/a90de334345f09311474267b899b449b5befa0b4)), closes [#8851](https://github.com/vm0-ai/vm0/issues/8851)

## [0.211.1](https://github.com/vm0-ai/vm0/compare/app-v0.211.0...app-v0.211.1) (2026-04-10)


### Bug Fixes

* use defaultAgent displayName for footer nav labels ([#8795](https://github.com/vm0-ai/vm0/issues/8795)) ([8d3b1db](https://github.com/vm0-ai/vm0/commit/8d3b1dbd57782a322a9594b9b9fecf44585c2269))

## [0.211.0](https://github.com/vm0-ai/vm0/compare/app-v0.210.0...app-v0.211.0) (2026-04-10)


### Features

* add strapi connector with variable base url ([#8765](https://github.com/vm0-ai/vm0/issues/8765)) ([818b050](https://github.com/vm0-ai/vm0/commit/818b050be41e84c34f4bda89e32294f2de01c75f))
* **platform:** add early access indicator to Google connectors ([#8789](https://github.com/vm0-ai/vm0/issues/8789)) ([3dc866b](https://github.com/vm0-ai/vm0/commit/3dc866b370d1c7080dade48a53410cbd0e1e03b6))
* **voice-chat:** add auto-scroll to transcript and events panels ([#8836](https://github.com/vm0-ai/vm0/issues/8836)) ([a6bd8b1](https://github.com/vm0-ai/vm0/commit/a6bd8b1b5c4427886939e425190be024fbd330b0)), closes [#8832](https://github.com/vm0-ai/vm0/issues/8832)
* **voice-chat:** add quick preparation phase to voice chat mode ([#8831](https://github.com/vm0-ai/vm0/issues/8831)) ([b016f19](https://github.com/vm0-ai/vm0/commit/b016f19d2c7692fca7e74ffbdc6baad2b843e552))
* **voice-chat:** add voice meeting frontend ui and signals ([#8822](https://github.com/vm0-ai/vm0/issues/8822)) ([ceca9a4](https://github.com/vm0-ai/vm0/commit/ceca9a4c0f252b095e5cdb10be5d8e3545d79ca8)), closes [#8793](https://github.com/vm0-ai/vm0/issues/8793)


### Bug Fixes

* **ui:** improve dark mode contrast and layer hierarchy ([#8798](https://github.com/vm0-ai/vm0/issues/8798)) ([56e0bee](https://github.com/vm0-ai/vm0/commit/56e0beec7d02be00472c49c327a794245e0234eb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.170.0

## [0.210.0](https://github.com/vm0-ai/vm0/compare/app-v0.209.2...app-v0.210.0) (2026-04-10)


### Features

* add unified tasks endpoint for mission control ([#8769](https://github.com/vm0-ai/vm0/issues/8769)) ([ed14070](https://github.com/vm0-ai/vm0/commit/ed14070c5c7bb8510d23a2f1c603cf4db2e2ef91))
* **runner:** pass feature switch states through execution context ([#8778](https://github.com/vm0-ai/vm0/issues/8778)) ([edbe85c](https://github.com/vm0-ai/vm0/commit/edbe85ca3f0fb81821aeeb609a0a700fcbd137e8))


### Bug Fixes

* **insights:** fix summary card text color in dark mode and remove connector underlines ([#8774](https://github.com/vm0-ai/vm0/issues/8774)) ([1032823](https://github.com/vm0-ai/vm0/commit/10328238f353aeff6b95679adafbc3d4a0796a34))
* **platform:** align permissions dialog unknown endpoints section ([#8786](https://github.com/vm0-ai/vm0/issues/8786)) ([17d1250](https://github.com/vm0-ai/vm0/commit/17d125015c0c47cb936a3044197e1ec4508efbce))
* **runner:** address feature switch review findings ([#8801](https://github.com/vm0-ai/vm0/issues/8801)) ([ae7eaba](https://github.com/vm0-ai/vm0/commit/ae7eabad66b72d38d16a4a01b97437bd5d962b3b))


### Refactoring

* normalize network policies schema from nullable optional to nullable ([#8808](https://github.com/vm0-ai/vm0/issues/8808)) ([3252b28](https://github.com/vm0-ai/vm0/commit/3252b282e66b6fd82bfbc767397a5e4d9359ae89))
* **voice-chat:** unify shared context naming to slow-brain/fast-brain ([#8784](https://github.com/vm0-ai/vm0/issues/8784)) ([c6c7fc2](https://github.com/vm0-ai/vm0/commit/c6c7fc2612a44b6cc52728d25838960168b27cb4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.169.0

## [0.209.2](https://github.com/vm0-ai/vm0/compare/app-v0.209.1...app-v0.209.2) (2026-04-10)


### Bug Fixes

* **platform:** hide create workspace when user already owns an org ([#8717](https://github.com/vm0-ai/vm0/issues/8717)) ([e697645](https://github.com/vm0-ai/vm0/commit/e69764522f9e3dbd4397fe7c16ea712bb429d0b5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.168.1

## [0.209.1](https://github.com/vm0-ai/vm0/compare/app-v0.209.0...app-v0.209.1) (2026-04-10)


### Bug Fixes

* **platform:** pass explicit locale to all date formatting calls ([#8754](https://github.com/vm0-ai/vm0/issues/8754)) ([781908c](https://github.com/vm0-ai/vm0/commit/781908cf5445b1fb304a1dec7c4cb0e3e2b76df1)), closes [#8751](https://github.com/vm0-ai/vm0/issues/8751)


### Refactoring

* render avatar as single inline svg instead of 3 img requests ([#8718](https://github.com/vm0-ai/vm0/issues/8718)) ([f3bb8e6](https://github.com/vm0-ai/vm0/commit/f3bb8e621807fdeefeee0ff24dd4b856c2c32029))

## [0.209.0](https://github.com/vm0-ai/vm0/compare/app-v0.208.0...app-v0.209.0) (2026-04-09)


### Features

* add plain connector ([#8728](https://github.com/vm0-ai/vm0/issues/8728)) ([04e4083](https://github.com/vm0-ai/vm0/commit/04e4083e55c5cbfebd2c8c2dc2a69d975f6b0ea1))
* update SMS consent disclosure to meet carrier requirements ([#8727](https://github.com/vm0-ai/vm0/issues/8727)) ([1874efb](https://github.com/vm0-ai/vm0/commit/1874efb9303ad98d52d1b9f03ea8c09f5d0ee3ab))
* **voice-chat:** add proactive injection of slow-brain events into realtime data channel ([#8746](https://github.com/vm0-ai/vm0/issues/8746)) ([d427116](https://github.com/vm0-ai/vm0/commit/d427116d7340db40924e83b3fb70e5d2821f866b)), closes [#8744](https://github.com/vm0-ai/vm0/issues/8744)
* **voice-chat:** replace read_shared_context with request_slow_brain tool ([#8748](https://github.com/vm0-ai/vm0/issues/8748)) ([4bd848d](https://github.com/vm0-ai/vm0/commit/4bd848dd18398b3083652547c1a4cb77586a5726)), closes [#8745](https://github.com/vm0-ai/vm0/issues/8745)


### Bug Fixes

* **platform:** fix user invitations polling loop exiting after one iteration ([#8686](https://github.com/vm0-ai/vm0/issues/8686)) ([5a6e014](https://github.com/vm0-ai/vm0/commit/5a6e01485d4580983e4548959ece5db71799fbf3))
* **platform:** move global polling from per-page setup to bootstrap ([#8734](https://github.com/vm0-ai/vm0/issues/8734)) ([7091bc3](https://github.com/vm0-ai/vm0/commit/7091bc31e75cc394ab24c2d1dd7b22d761f74756))
* reload agents list after onboarding completes ([#8723](https://github.com/vm0-ai/vm0/issues/8723)) ([e8869e4](https://github.com/vm0-ai/vm0/commit/e8869e4823b8659361c21394a0181e9f0319260f))


### Refactoring

* **firewalls:** change allow-unknown from boolean to policy value ([#8733](https://github.com/vm0-ai/vm0/issues/8733)) ([4e2bea3](https://github.com/vm0-ai/vm0/commit/4e2bea3758707b157bf28162ee815da2129c5f32))
* **firewalls:** rename granted-permissions to network-policies ([#8740](https://github.com/vm0-ai/vm0/issues/8740)) ([2ad2c5c](https://github.com/vm0-ai/vm0/commit/2ad2c5ce175d98304adcb5a43770df3d9d5ee9d2)), closes [#8738](https://github.com/vm0-ai/vm0/issues/8738)
* **firewalls:** unify firewall policies to include allow-unknown ([#8721](https://github.com/vm0-ai/vm0/issues/8721)) ([8905fbe](https://github.com/vm0-ai/vm0/commit/8905fbe85efdc0968f265e6b943cd9a65944923b))
* **web:** eliminate internal imports in telegram tests (ap-12 batch c) ([#8730](https://github.com/vm0-ai/vm0/issues/8730)) ([44151b1](https://github.com/vm0-ai/vm0/commit/44151b165a691a3aeb96d813b6ddc2f108119dc4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.168.0

## [0.208.0](https://github.com/vm0-ai/vm0/compare/app-v0.207.0...app-v0.208.0) (2026-04-09)


### Features

* **firewalls:** add granted permissions for three-level matching ([#8621](https://github.com/vm0-ai/vm0/issues/8621)) ([534ec85](https://github.com/vm0-ai/vm0/commit/534ec85c209f52c7388bd9819b72017bb8be6cd9))


### Bug Fixes

* **firewalls:** merge default policies with stored instead of skipping ([#8697](https://github.com/vm0-ai/vm0/issues/8697)) ([593cead](https://github.com/vm0-ai/vm0/commit/593cead62b099a5cad171ee37baa15a657f1b40f))
* **platform:** hide profile/instructions tabs for non-owner non-admin users ([#8699](https://github.com/vm0-ai/vm0/issues/8699)) ([f2ff7ae](https://github.com/vm0-ai/vm0/commit/f2ff7ae48e8d5d36b410ccdb104479a807d16dd7))
* **platform:** hide response body until task run completes ([#8681](https://github.com/vm0-ai/vm0/issues/8681)) ([1411633](https://github.com/vm0-ai/vm0/commit/141163353f65e95f2c1d66380b73b8573d73cb8f))
* **platform:** reset avatar saving state on confirm error ([#8704](https://github.com/vm0-ai/vm0/issues/8704)) ([9981d82](https://github.com/vm0-ai/vm0/commit/9981d82ef0056bc2488cf09cb838fbc198a2b99d))
* **voice-chat:** show full content in shared context events panel ([#8711](https://github.com/vm0-ai/vm0/issues/8711)) ([3032de4](https://github.com/vm0-ai/vm0/commit/3032de4d7572907979cc1d8f54d43d5010199bde)), closes [#8709](https://github.com/vm0-ai/vm0/issues/8709)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.167.0

## [0.207.0](https://github.com/vm0-ai/vm0/compare/app-v0.206.0...app-v0.207.0) (2026-04-09)


### Features

* add error report page and api for failed runs ([#8619](https://github.com/vm0-ai/vm0/issues/8619)) ([0b8c420](https://github.com/vm0-ai/vm0/commit/0b8c4200df1228b7fa3c16ab575bb547bba6a1f8))
* **platform:** add avatar maker component with svg layer stacking ([#8618](https://github.com/vm0-ai/vm0/issues/8618)) ([01ac30b](https://github.com/vm0-ai/vm0/commit/01ac30b0b0b92a82e3962eb9ec75d9ea30976c56))
* **voice-chat:** auto-log conversation to shared context ([#8674](https://github.com/vm0-ai/vm0/issues/8674)) ([f172c26](https://github.com/vm0-ai/vm0/commit/f172c2680c29ebe12631e7d2aec9d03ba391a3ed)), closes [#8669](https://github.com/vm0-ai/vm0/issues/8669)
* **voice-chat:** rewrite fast brain instructions for system 1 role ([#8684](https://github.com/vm0-ai/vm0/issues/8684)) ([b597399](https://github.com/vm0-ai/vm0/commit/b597399508dd57a7cbaad5488706d93050af5cdd)), closes [#8670](https://github.com/vm0-ai/vm0/issues/8670)
* **voice-chat:** use agent display name instead of hardcoded assistant label ([#8675](https://github.com/vm0-ai/vm0/issues/8675)) ([56a935e](https://github.com/vm0-ai/vm0/commit/56a935e6777619a3882f16e4634490c53235e296)), closes [#8672](https://github.com/vm0-ai/vm0/issues/8672)


### Bug Fixes

* **platform:** ignore credit errors in sentry + backfill starter credits for legacy orgs ([#8660](https://github.com/vm0-ai/vm0/issues/8660)) ([c1c6b32](https://github.com/vm0-ai/vm0/commit/c1c6b323f00d8fc5c7c918c8ccf9544441abdaf4))
* **platform:** make connector card body clickable ([#8643](https://github.com/vm0-ai/vm0/issues/8643)) ([766fe1b](https://github.com/vm0-ai/vm0/commit/766fe1baaaaa7d8c0adac7f6530ab08cfc10745a))
* **platform:** prevent tooltip auto-show on pricing page back button ([#8659](https://github.com/vm0-ai/vm0/issues/8659)) ([577756c](https://github.com/vm0-ai/vm0/commit/577756c5b25ad277e87ad5f526ac3d42cc1a11ec))
* **platform:** remove stray dialog description in connector permission modal ([#8592](https://github.com/vm0-ai/vm0/issues/8592)) ([4e20fd7](https://github.com/vm0-ai/vm0/commit/4e20fd75d4c7a6e94caae04a0326bfac1c7046c1)), closes [#8591](https://github.com/vm0-ai/vm0/issues/8591)


### Refactoring

* **platform:** remove unnecessary try/catch in voice chat polling ([#8607](https://github.com/vm0-ai/vm0/issues/8607)) ([1545670](https://github.com/vm0-ai/vm0/commit/1545670daaf909d943de4e956517b4b2aa742757))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.166.0

## [0.206.0](https://github.com/vm0-ai/vm0/compare/app-v0.205.0...app-v0.206.0) (2026-04-09)


### Features

* **zero:** inject base user info context and schedule integration for all runs ([#8630](https://github.com/vm0-ai/vm0/issues/8630)) ([2a1fe3b](https://github.com/vm0-ai/vm0/commit/2a1fe3b7cbefb31b19a3650e661c281c03694036))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.165.0

## [0.205.0](https://github.com/vm0-ai/vm0/compare/app-v0.204.2...app-v0.205.0) (2026-04-09)


### Features

* **runs:** add session id to run context snapshot and ui ([#8577](https://github.com/vm0-ai/vm0/issues/8577)) ([96c6616](https://github.com/vm0-ai/vm0/commit/96c6616ac27410f3801352c44d23c75514b65672))
* **voice-chat:** add talker instructions for realtime session ([#8605](https://github.com/vm0-ai/vm0/issues/8605)) ([9063262](https://github.com/vm0-ai/vm0/commit/9063262775569077de7242491ab46a850fabfc4a)), closes [#8598](https://github.com/vm0-ai/vm0/issues/8598)
* **voice-chat:** upgrade realtime model to gpt-realtime-1.5 and use onyx voice ([#8596](https://github.com/vm0-ai/vm0/issues/8596)) ([ed4bcf5](https://github.com/vm0-ai/vm0/commit/ed4bcf5f2cd1855bb79c58586ab1b2bc9a7f41a6)), closes [#8588](https://github.com/vm0-ai/vm0/issues/8588)


### Bug Fixes

* make terms and privacy pages accessible without login on locale-prefixed urls ([#8586](https://github.com/vm0-ai/vm0/issues/8586)) ([f7a32d8](https://github.com/vm0-ai/vm0/commit/f7a32d87f719579e9f7e1294b6a908f79fe81868))
* **platform:** call end session api when stopping voice chat ([#8584](https://github.com/vm0-ai/vm0/issues/8584)) ([01ddbac](https://github.com/vm0-ai/vm0/commit/01ddbac46ab72a624ba3d59e6aadfee2c5eed7a4))
* **platform:** prevent horizontal scrollbar on long chat content ([#8629](https://github.com/vm0-ai/vm0/issues/8629)) ([2d9e11b](https://github.com/vm0-ai/vm0/commit/2d9e11b1334954ac11f18a52c92e59a8cd04442e))
* **platform:** prevent infinite hang in computed without abort signal ([#8589](https://github.com/vm0-ai/vm0/issues/8589)) ([22f6189](https://github.com/vm0-ai/vm0/commit/22f61896202bae577e216c979d215fc242c4b634))
* **platform:** remove blanket max-lines-per-function override for tsx files ([#8623](https://github.com/vm0-ai/vm0/issues/8623)) ([7effc11](https://github.com/vm0-ai/vm0/commit/7effc11ef13554beae4dd8e8fc37b6c6961df2df)), closes [#8609](https://github.com/vm0-ai/vm0/issues/8609)
* revert contact email changes except developer-support route ([#8627](https://github.com/vm0-ai/vm0/issues/8627)) ([ea70ebf](https://github.com/vm0-ai/vm0/commit/ea70ebfcd248dc87cf42587a112f8207a5e0c5ee))
* **voice-chat:** prevent auto-sending on startup and fix transcript ordering ([#8590](https://github.com/vm0-ai/vm0/issues/8590)) ([48c5b79](https://github.com/vm0-ai/vm0/commit/48c5b79fa2c1a2f02fdea0c23e5fc525dabf8701)), closes [#8587](https://github.com/vm0-ai/vm0/issues/8587)


### Refactoring

* **platform:** move org polling from dom ref to page setup lifecycle ([#8600](https://github.com/vm0-ai/vm0/issues/8600)) ([b16e881](https://github.com/vm0-ai/vm0/commit/b16e88175c8b070607bfaa6d525389f2fed4e43f))
* replace contact@vm0.ai with support@vm0.ai ([#8617](https://github.com/vm0-ai/vm0/issues/8617)) ([c8d67df](https://github.com/vm0-ai/vm0/commit/c8d67df2cab759b0845be81f4ef2d0f97fb4fe64)), closes [#8615](https://github.com/vm0-ai/vm0/issues/8615)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.164.0

## [0.204.2](https://github.com/vm0-ai/vm0/compare/app-v0.204.1...app-v0.204.2) (2026-04-09)


### Refactoring

* **platform:** move voice chat button from chat page to sidebar ([#8576](https://github.com/vm0-ai/vm0/issues/8576)) ([372204b](https://github.com/vm0-ai/vm0/commit/372204b0d832987baa9ddda37e72a62e0869e2ff))

## [0.204.1](https://github.com/vm0-ai/vm0/compare/app-v0.204.0...app-v0.204.1) (2026-04-09)


### Bug Fixes

* disable chat input auto-focus on touch/mobile devices ([#8570](https://github.com/vm0-ai/vm0/issues/8570)) ([b0950ae](https://github.com/vm0-ai/vm0/commit/b0950aeb275e4d76a36a01eb8f32fc2805101c6f))
* **platform:** center skeleton loading text and add message cycling ([#8471](https://github.com/vm0-ai/vm0/issues/8471)) ([0d6f411](https://github.com/vm0-ai/vm0/commit/0d6f411e07d29fea87f854b88e9f794da9a4dd34))

## [0.204.0](https://github.com/vm0-ai/vm0/compare/app-v0.203.1...app-v0.204.0) (2026-04-09)


### Features

* add phone channel powered by agentphone ([#8496](https://github.com/vm0-ai/vm0/issues/8496)) ([43779b3](https://github.com/vm0-ai/vm0/commit/43779b320bdfd8bf85786561dfef612f84060023))


### Refactoring

* **platform:** remove all TODO(no-try) eslint-disable comments ([#8557](https://github.com/vm0-ai/vm0/issues/8557)) ([e607102](https://github.com/vm0-ai/vm0/commit/e6071028ea3d8028edc0641158f4672ad0e74ad7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.163.0

## [0.203.1](https://github.com/vm0-ai/vm0/compare/app-v0.203.0...app-v0.203.1) (2026-04-08)


### Bug Fixes

* **platform:** remove incorrect clerk satellite configuration ([#8564](https://github.com/vm0-ai/vm0/issues/8564)) ([c426631](https://github.com/vm0-ai/vm0/commit/c426631979095db7ed6d5953d41ddcc44c387fdf))

## [0.203.0](https://github.com/vm0-ai/vm0/compare/app-v0.202.1...app-v0.203.0) (2026-04-08)


### Features

* add web push notifications for pwa on chat completion ([#8501](https://github.com/vm0-ai/vm0/issues/8501)) ([a89b898](https://github.com/vm0-ai/vm0/commit/a89b89890c6b6ff66cc761fca39bc6195f8485bb))
* **core:** add voice-chat types and feature flag ([#8529](https://github.com/vm0-ai/vm0/issues/8529)) ([#8539](https://github.com/vm0-ai/vm0/issues/8539)) ([ee7ee22](https://github.com/vm0-ai/vm0/commit/ee7ee222ae733f47f7cb323d871f2a9577adc41c))
* **platform:** add voice-chat page route and entry point ([#8535](https://github.com/vm0-ai/vm0/issues/8535)) ([#8546](https://github.com/vm0-ai/vm0/issues/8546)) ([62d86c0](https://github.com/vm0-ai/vm0/commit/62d86c0d0535b1fb7c8581bde8640ddcbf93cb75))
* **voice-chat:** add webrtc frontend with live transcript and context panels ([#8556](https://github.com/vm0-ai/vm0/issues/8556)) ([ded50f2](https://github.com/vm0-ai/vm0/commit/ded50f20faf57860f14a8aee6a11a2dbb0cb4d3d))


### Bug Fixes

* **platform:** filter null header values from network logs ([#8522](https://github.com/vm0-ai/vm0/issues/8522)) ([b72f329](https://github.com/vm0-ai/vm0/commit/b72f3298418ab018bdf892936425e885343defe1))


### Refactoring

* decompose chat thread page into smaller components ([#8555](https://github.com/vm0-ai/vm0/issues/8555)) ([99997c6](https://github.com/vm0-ai/vm0/commit/99997c6461e8d643f30c1a52fb9e9cc47e281ac8))
* **platform:** decompose chat thread page into signal-driven components ([#8508](https://github.com/vm0-ai/vm0/issues/8508)) ([90819d7](https://github.com/vm0-ai/vm0/commit/90819d7e0b005a3ced51046579b3525eb12a9dc0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.162.0

## [0.202.1](https://github.com/vm0-ai/vm0/compare/app-v0.202.0...app-v0.202.1) (2026-04-08)


### Bug Fixes

* **model-providers:** use hyphenated model ids to match anthropic api format ([#8511](https://github.com/vm0-ai/vm0/issues/8511)) ([1bcd1e6](https://github.com/vm0-ai/vm0/commit/1bcd1e67f54105831b71182482488f21871ee25d))


### Refactoring

* **platform:** job detail page cleanup ([#8418](https://github.com/vm0-ai/vm0/issues/8418)) ([4ddf0ae](https://github.com/vm0-ai/vm0/commit/4ddf0ae451163d64cc1e49062df9521ce977be88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.161.1

## [0.202.0](https://github.com/vm0-ai/vm0/compare/app-v0.201.0...app-v0.202.0) (2026-04-08)


### Features

* **model-providers:** add model selection for anthropic-api-key and claude-code-oauth-token ([#8491](https://github.com/vm0-ai/vm0/issues/8491)) ([ad96e27](https://github.com/vm0-ai/vm0/commit/ad96e27561f8bcdb69bf8d3268e4d168d98b9662))
* **platform:** capture response headers and mark binary bodies in network logs ([#8481](https://github.com/vm0-ai/vm0/issues/8481)) ([6a778f8](https://github.com/vm0-ai/vm0/commit/6a778f8ebbd88e2bd95a4d79a5e4ed1e4c3f4f26))


### Bug Fixes

* **slack:** skip channel context fetch for dm conversations ([#8475](https://github.com/vm0-ai/vm0/issues/8475)) ([07a3321](https://github.com/vm0-ai/vm0/commit/07a33216d0a47047b341a0784324cb71b596a7f4))
* **ui:** remove optimistic pin state to eliminate agent list dialog button blink ([#8469](https://github.com/vm0-ai/vm0/issues/8469)) ([07b9035](https://github.com/vm0-ai/vm0/commit/07b903507c60e53f94015bec34df25465841873c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.161.0

## [0.201.0](https://github.com/vm0-ai/vm0/compare/app-v0.200.0...app-v0.201.0) (2026-04-08)


### Features

* display last updated timestamp and refetch insights on navigation ([#8443](https://github.com/vm0-ai/vm0/issues/8443)) ([11e5743](https://github.com/vm0-ai/vm0/commit/11e5743855d534c60ccbc7470e73f47f8cc9797b))
* **platform:** display captured request headers and bodies in network logs ([#8438](https://github.com/vm0-ai/vm0/issues/8438)) ([121befe](https://github.com/vm0-ai/vm0/commit/121befef4bb9eef59653aa97aeac20c7c6dbef28))
* refetch insights data when navigating to insights page ([#8433](https://github.com/vm0-ai/vm0/issues/8433)) ([ee0c5e7](https://github.com/vm0-ai/vm0/commit/ee0c5e73d2153f50c9d5bde17fb31f7afb30b693))


### Bug Fixes

* **firewalls:** default-deny gmail send and split compose to draft-only ([#8450](https://github.com/vm0-ai/vm0/issues/8450)) ([cc62cbf](https://github.com/vm0-ai/vm0/commit/cc62cbfb5db47c1d8b0e49465bad68a03f572d52))
* **platform:** auto-scroll chat to bottom on page entry ([#8458](https://github.com/vm0-ai/vm0/issues/8458)) ([a8e9406](https://github.com/vm0-ai/vm0/commit/a8e9406b0939173690c88a2d60c3f8e50522fed3)), closes [#8337](https://github.com/vm0-ai/vm0/issues/8337)
* remove premature talk draft clear that dropped attachments on send ([#8466](https://github.com/vm0-ai/vm0/issues/8466)) ([a124b35](https://github.com/vm0-ai/vm0/commit/a124b356e6caec637e70169b4082d9cf9d160bc5)), closes [#8462](https://github.com/vm0-ai/vm0/issues/8462)


### Refactoring

* **firewalls:** remove fine-grained permissions from github firewall ([#8432](https://github.com/vm0-ai/vm0/issues/8432)) ([2471dfd](https://github.com/vm0-ai/vm0/commit/2471dfdd2da6bf4407f5d0a5e565d334f750cfe9))
* **platform:** remove onboarding init, rename firewall to permission ([#8417](https://github.com/vm0-ai/vm0/issues/8417)) ([43432ea](https://github.com/vm0-ai/vm0/commit/43432ea2309f61bdac69a8673c3cf20fc3936f42))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.160.0

## [0.200.0](https://github.com/vm0-ai/vm0/compare/app-v0.199.0...app-v0.200.0) (2026-04-07)


### Features

* add per-user capture-network-bodies quota in preferences ([#8402](https://github.com/vm0-ai/vm0/issues/8402)) ([7029364](https://github.com/vm0-ai/vm0/commit/70293646c5aa630f3f4d8b2217bcc93043bcf3ea))
* **platform:** paginate network logs with incremental loading ([#8405](https://github.com/vm0-ai/vm0/issues/8405)) ([9c91025](https://github.com/vm0-ai/vm0/commit/9c9102584970a9923f9e0f9402fc32b8ed444780))


### Refactoring

* **platform:** remove eager onboarding init and prefetch agent avatar ([#8409](https://github.com/vm0-ai/vm0/issues/8409)) ([badae48](https://github.com/vm0-ai/vm0/commit/badae48a219d71fca30ad75629fcb352561955cd))
* **platform:** replace if-else chain with route map in nav select ([#8407](https://github.com/vm0-ai/vm0/issues/8407)) ([1bc4123](https://github.com/vm0-ai/vm0/commit/1bc412319e84b9d41d402ab16ba5e940d752ab8d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.159.0

## [0.199.0](https://github.com/vm0-ai/vm0/compare/app-v0.198.0...app-v0.199.0) (2026-04-07)


### Features

* **doctor:** include agent id in missing-token connect url and auto-authorize after connect ([#8399](https://github.com/vm0-ai/vm0/issues/8399)) ([99e7710](https://github.com/vm0-ai/vm0/commit/99e7710a1b05eb8f37a73e8cc520cbc4bcd0797a)), closes [#8396](https://github.com/vm0-ai/vm0/issues/8396)
* **platform:** use proper connector labels in network insights page ([#8395](https://github.com/vm0-ai/vm0/issues/8395)) ([0c057c7](https://github.com/vm0-ai/vm0/commit/0c057c70fabf31c8643a7b3b2d55deb5dad8abe7))


### Bug Fixes

* **platform:** use onclick instead of onpointerdown in sidebar ([#8403](https://github.com/vm0-ai/vm0/issues/8403)) ([11fac5a](https://github.com/vm0-ai/vm0/commit/11fac5a2a9680edac814b0bb79023120b3c9e13c))


### Refactoring

* consolidate agent signals and make sidebar zero-prop ([#8324](https://github.com/vm0-ai/vm0/issues/8324)) ([3b32aab](https://github.com/vm0-ai/vm0/commit/3b32aab6ea8e67ecdbd11a2dcb7a11a06c3b383f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.158.0

## [0.198.0](https://github.com/vm0-ai/vm0/compare/app-v0.197.1...app-v0.198.0) (2026-04-07)


### Features

* add insights dashboard with cron pre-aggregation pipeline ([#8387](https://github.com/vm0-ai/vm0/issues/8387)) ([4ba9dbe](https://github.com/vm0-ai/vm0/commit/4ba9dbe12ca1a3102646d358076010981a06da07))


### Bug Fixes

* **a11y:** add sheet descriptions to queue drawer and firewall permissions sheet ([#8389](https://github.com/vm0-ai/vm0/issues/8389)) ([1462679](https://github.com/vm0-ai/vm0/commit/1462679e25e254a16218021b5ff3f1652a033eb4))


### Refactoring

* **platform:** add loading states to fire-and-forget mutations ([#8383](https://github.com/vm0-ai/vm0/issues/8383)) ([ec8497a](https://github.com/vm0-ai/vm0/commit/ec8497a2095ac41544c10dbb27cf2e44b78445b7))
* **test:** centralize restore mocks and console.error override in vitest setup ([#8379](https://github.com/vm0-ai/vm0/issues/8379)) ([b60ab7e](https://github.com/vm0-ai/vm0/commit/b60ab7e30c763739f004d03c57247d7eb5b8e4c1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.157.0

## [0.197.1](https://github.com/vm0-ai/vm0/compare/app-v0.197.0...app-v0.197.1) (2026-04-07)


### Bug Fixes

* align skeleton avatar with text placeholder in chat thread ([#8377](https://github.com/vm0-ai/vm0/issues/8377)) ([3790dce](https://github.com/vm0-ai/vm0/commit/3790dceab5f0c828234941324d24fd9cebb24a5c)), closes [#7520](https://github.com/vm0-ai/vm0/issues/7520)
* dismiss app skeleton on directed authorize page ([#8372](https://github.com/vm0-ai/vm0/issues/8372)) ([f1bd83d](https://github.com/vm0-ai/vm0/commit/f1bd83db4ff96ddf6ed271aaa6d3792a34026342))
* **platform:** center loading spinner in toggle switch ([#8353](https://github.com/vm0-ai/vm0/issues/8353)) ([e3d39a1](https://github.com/vm0-ai/vm0/commit/e3d39a1c2a6cf0a2f74c7610539767bd60ed76e6))
* **platform:** rename disapprove change button to deny change ([#8369](https://github.com/vm0-ai/vm0/issues/8369)) ([0b828f6](https://github.com/vm0-ai/vm0/commit/0b828f69e6ee6e3dab26c447929a056d8c2061b9))

## [0.197.0](https://github.com/vm0-ai/vm0/compare/app-v0.196.2...app-v0.197.0) (2026-04-07)


### Features

* **firewall:** add slack notifications and doctor --reason pre-fill ([#8339](https://github.com/vm0-ai/vm0/issues/8339)) ([7819955](https://github.com/vm0-ai/vm0/commit/78199554e4a233b19e7f633e150abfb5691f0413))

## [0.196.2](https://github.com/vm0-ai/vm0/compare/app-v0.196.1...app-v0.196.2) (2026-04-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.156.1

## [0.196.1](https://github.com/vm0-ai/vm0/compare/app-v0.196.0...app-v0.196.1) (2026-04-07)


### Bug Fixes

* reserve scrollbar gutter in chat thread to prevent layout shift ([#8322](https://github.com/vm0-ai/vm0/issues/8322)) ([ea8b642](https://github.com/vm0-ai/vm0/commit/ea8b642c996a0783db1c3f81797b3901836775f2))


### Refactoring

* **platform:** replace fetch-slack-org imperative command with reactive computed ([#8332](https://github.com/vm0-ai/vm0/issues/8332)) ([575f5dd](https://github.com/vm0-ai/vm0/commit/575f5dd9276c8ca145b46f7caf7a1f144437e899))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.156.0

## [0.196.0](https://github.com/vm0-ai/vm0/compare/app-v0.195.0...app-v0.196.0) (2026-04-07)


### Features

* render markdown tables as definition list on mobile ([#8292](https://github.com/vm0-ai/vm0/issues/8292)) ([ac2d3ad](https://github.com/vm0-ai/vm0/commit/ac2d3adafa9b246f357ba87f10416d91eae728f0))


### Bug Fixes

* handle oauth popup blocking in ios pwa standalone mode ([#8284](https://github.com/vm0-ai/vm0/issues/8284)) ([3ee86d8](https://github.com/vm0-ai/vm0/commit/3ee86d89ecacc019dffdc32f2ad97a8bf3cdc9bb))


### Refactoring

* redesign firewall allow focused views as approval cards ([#7712](https://github.com/vm0-ai/vm0/issues/7712)) ([3a34350](https://github.com/vm0-ai/vm0/commit/3a3435054b8affe16ca1a0329d6ffaf1f28012ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.155.1

## [0.195.0](https://github.com/vm0-ai/vm0/compare/app-v0.194.0...app-v0.195.0) (2026-04-07)


### Features

* add resilient polling loop with fibonacci backoff for mobile background recovery ([#8295](https://github.com/vm0-ai/vm0/issues/8295)) ([d2f9dac](https://github.com/vm0-ai/vm0/commit/d2f9dac17041479a54e6d7ef3bb627f1103eca51))
* **platform:** replace queue page with upsell side drawer ([#8242](https://github.com/vm0-ai/vm0/issues/8242)) ([b8a5039](https://github.com/vm0-ai/vm0/commit/b8a50391d3be510b0f30fa7e1d5a2ebceb08a233))


### Bug Fixes

* prevent enter key from sending message on mobile devices ([#8301](https://github.com/vm0-ai/vm0/issues/8301)) ([b501047](https://github.com/vm0-ai/vm0/commit/b501047260abb6bd06b232262761088330456eeb))

## [0.194.0](https://github.com/vm0-ai/vm0/compare/app-v0.193.2...app-v0.194.0) (2026-04-07)


### Features

* add directed authorize page for missing user-connector flow ([#7893](https://github.com/vm0-ai/vm0/issues/7893)) ([e271f4c](https://github.com/vm0-ai/vm0/commit/e271f4c85bb5c6e92c50d68fea0eb1b023a1cfba))
* **platform:** add lab page for feature switch management ([#8288](https://github.com/vm0-ai/vm0/issues/8288)) ([b87f833](https://github.com/vm0-ai/vm0/commit/b87f83385dffa46c4a5b60c736d32ed51cdd4bab))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.155.0

## [0.193.2](https://github.com/vm0-ai/vm0/compare/app-v0.193.1...app-v0.193.2) (2026-04-07)


### Bug Fixes

* handle clipboard write rejection on mobile safari with fallback ([#8264](https://github.com/vm0-ai/vm0/issues/8264)) ([2d71cc6](https://github.com/vm0-ai/vm0/commit/2d71cc6834c40541de81d64e030792ea9431d557))

## [0.193.1](https://github.com/vm0-ai/vm0/compare/app-v0.193.0...app-v0.193.1) (2026-04-07)


### Bug Fixes

* handle 401 response in ts-rest api client ([#8265](https://github.com/vm0-ai/vm0/issues/8265)) ([a86dda2](https://github.com/vm0-ai/vm0/commit/a86dda24fe34e45ec7509511d2b616219e276676))
* **onboarding:** prevent double-click and handle 409 conflict ([#8262](https://github.com/vm0-ai/vm0/issues/8262)) ([6613990](https://github.com/vm0-ai/vm0/commit/6613990bf91184c2aa051294acd6deae49f46b38))
* preserve schedule timezone when saving instruction edits ([#8266](https://github.com/vm0-ai/vm0/issues/8266)) ([069a385](https://github.com/vm0-ai/vm0/commit/069a385102204dc3636783f6d0531ada8b63834e)), closes [#8160](https://github.com/vm0-ai/vm0/issues/8160)


### Refactoring

* split zero-sidebar.tsx into focused sub-components ([#8261](https://github.com/vm0-ai/vm0/issues/8261)) ([7207bfa](https://github.com/vm0-ai/vm0/commit/7207bfad16fe9814b801238ff419af2cfdf1d191)), closes [#7834](https://github.com/vm0-ai/vm0/issues/7834)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.154.1

## [0.193.0](https://github.com/vm0-ai/vm0/compare/app-v0.192.0...app-v0.193.0) (2026-04-07)


### Features

* **chat:** gate mobile chat list page navigation behind feature switch ([#8251](https://github.com/vm0-ai/vm0/issues/8251)) ([5ad7565](https://github.com/vm0-ai/vm0/commit/5ad756579cf7a54784681357f85096b0920be198))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.154.0

## [0.192.0](https://github.com/vm0-ai/vm0/compare/app-v0.191.4...app-v0.192.0) (2026-04-06)


### Features

* **chat:** add /chats page for mobile chat list navigation ([#8243](https://github.com/vm0-ai/vm0/issues/8243)) ([2e87f7d](https://github.com/vm0-ai/vm0/commit/2e87f7d5a5bcbb8033f7148feeccc0e8fc4c7333))

## [0.191.4](https://github.com/vm0-ai/vm0/compare/app-v0.191.3...app-v0.191.4) (2026-04-06)


### Bug Fixes

* **platform:** remove schedule/agents icons and fix avatar-text alignment ([#8110](https://github.com/vm0-ai/vm0/issues/8110)) ([086d881](https://github.com/vm0-ai/vm0/commit/086d8818ae50d2ad6d911183a02ec13fa7abe4cd))


### Refactoring

* **platform:** ban useeffect and move side effects to signals layer ([#8235](https://github.com/vm0-ai/vm0/issues/8235)) ([61cd0d7](https://github.com/vm0-ai/vm0/commit/61cd0d7c066169fc7b0a139eecce442419598284))
* **sidebar:** replace js viewport detection with css-only responsive ([#8240](https://github.com/vm0-ai/vm0/issues/8240)) ([9e94399](https://github.com/vm0-ai/vm0/commit/9e9439954f4de5eaf812d3c425426d089f2ec21a))

## [0.191.3](https://github.com/vm0-ai/vm0/compare/app-v0.191.2...app-v0.191.3) (2026-04-06)


### Bug Fixes

* **chat:** replace scroll anchor with dual-anchor scroll strategy ([#8234](https://github.com/vm0-ai/vm0/issues/8234)) ([8e697d4](https://github.com/vm0-ai/vm0/commit/8e697d479580ac1bd2c640feb3d6ff8ead089259))

## [0.191.2](https://github.com/vm0-ai/vm0/compare/app-v0.191.1...app-v0.191.2) (2026-04-06)


### Bug Fixes

* update agentphone icon to official brand logo ([#8229](https://github.com/vm0-ai/vm0/issues/8229)) ([cee4c56](https://github.com/vm0-ai/vm0/commit/cee4c56ccaf3f3958f645b97f49110e64ae7f67d))

## [0.191.1](https://github.com/vm0-ai/vm0/compare/app-v0.191.0...app-v0.191.1) (2026-04-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.153.1

## [0.191.0](https://github.com/vm0-ai/vm0/compare/app-v0.190.0...app-v0.191.0) (2026-04-06)


### Features

* add Pika connector ([#8218](https://github.com/vm0-ai/vm0/issues/8218)) ([9a1bacb](https://github.com/vm0-ai/vm0/commit/9a1bacb8e18ab800c6f57951192b3a3675670066))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.153.0

## [0.190.0](https://github.com/vm0-ai/vm0/compare/app-v0.189.0...app-v0.190.0) (2026-04-05)


### Features

* add AgentPhone API token connector ([#8203](https://github.com/vm0-ai/vm0/issues/8203)) ([e11b420](https://github.com/vm0-ai/vm0/commit/e11b420fcd8caf7601cc141ebcc442b61c1d17f7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.152.0

## [0.189.0](https://github.com/vm0-ai/vm0/compare/app-v0.188.1...app-v0.189.0) (2026-04-05)


### Features

* add PWA manifest and iOS meta tags to platform ([#8200](https://github.com/vm0-ai/vm0/issues/8200)) ([1adc236](https://github.com/vm0-ai/vm0/commit/1adc236dad5fd66d4b72a36b7117c4864f18925e))

## [0.188.1](https://github.com/vm0-ai/vm0/compare/app-v0.188.0...app-v0.188.1) (2026-04-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.151.0

## [0.188.0](https://github.com/vm0-ai/vm0/compare/app-v0.187.5...app-v0.188.0) (2026-04-05)


### Features

* **lint:** add no-onclick rule — enforce onPointerDown for mobile-safe events ([#8188](https://github.com/vm0-ai/vm0/issues/8188)) ([5cecc06](https://github.com/vm0-ai/vm0/commit/5cecc06b503e2b1a4bad2702f2dd6e370979b9a3))

## [0.187.5](https://github.com/vm0-ai/vm0/compare/app-v0.187.4...app-v0.187.5) (2026-04-04)


### Performance Improvements

* **platform:** add fill() test helper and enforce no-user-clear-tab lint rule ([#8168](https://github.com/vm0-ai/vm0/issues/8168)) ([c936530](https://github.com/vm0-ai/vm0/commit/c93653020efc65707362b33a8f5a5434e7d22317))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.150.2

## [0.187.4](https://github.com/vm0-ai/vm0/compare/app-v0.187.3...app-v0.187.4) (2026-04-04)


### Bug Fixes

* stabilize flaky chat tagline test (CHAT-D-002) ([#8150](https://github.com/vm0-ai/vm0/issues/8150)) ([2fbded2](https://github.com/vm0-ai/vm0/commit/2fbded2a2569cb9dcc7178c768d8d1d49b3f7c8e))
* **test/platform:** replace css class selector with data-testid in sidebar-d-046 ([#8164](https://github.com/vm0-ai/vm0/issues/8164)) ([f773e9a](https://github.com/vm0-ai/vm0/commit/f773e9a34b6bf37077208c5b3214216c626a56da))


### Performance Improvements

* replace sha1 with fnv1a in feature switch for synchronous hashing ([#8162](https://github.com/vm0-ai/vm0/issues/8162)) ([7c41de5](https://github.com/vm0-ai/vm0/commit/7c41de5371ec0dc440b72f06b1fc99d825680f20))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.150.1

## [0.187.3](https://github.com/vm0-ai/vm0/compare/app-v0.187.2...app-v0.187.3) (2026-04-04)


### Bug Fixes

* **test:** wrap openspy in try/finally to prevent spy leak on assertion failure ([#8142](https://github.com/vm0-ai/vm0/issues/8142)) ([88c39bd](https://github.com/vm0-ai/vm0/commit/88c39bdd9555a187778e4bd3d6ef6c38d12c9ee6))

## [0.187.2](https://github.com/vm0-ai/vm0/compare/app-v0.187.1...app-v0.187.2) (2026-04-04)


### Performance Improvements

* **test:** replace slow by-role name queries in 54 test files ([#8126](https://github.com/vm0-ai/vm0/issues/8126)) ([d8220ea](https://github.com/vm0-ai/vm0/commit/d8220ea3b63eeaa910287fd5258ed67f603a7876))

## [0.187.1](https://github.com/vm0-ai/vm0/compare/app-v0.187.0...app-v0.187.1) (2026-04-04)


### Bug Fixes

* **test:** improve scope assertions and type cast in connector-permission-scope tests ([#8115](https://github.com/vm0-ai/vm0/issues/8115)) ([8f22a5d](https://github.com/vm0-ai/vm0/commit/8f22a5db449b8430ebd086f8b5e198e9171f6b24))

## [0.187.0](https://github.com/vm0-ai/vm0/compare/app-v0.186.3...app-v0.187.0) (2026-04-03)


### Features

* add dns proxy for sandbox vms using dnsmasq ([#8020](https://github.com/vm0-ai/vm0/issues/8020)) ([5699f8d](https://github.com/vm0-ai/vm0/commit/5699f8dbb9008422dfe1753a2b127a6f9c100f59))
* **onboarding:** hide preferences in account menu during onboarding ([#7701](https://github.com/vm0-ai/vm0/issues/7701)) ([03d75ff](https://github.com/vm0-ai/vm0/commit/03d75ff9756f49cccaa22afdc9601b68ba4aef58))
* **platform:** add collapsible manage section in sidebar ([#8028](https://github.com/vm0-ai/vm0/issues/8028)) ([66a9271](https://github.com/vm0-ai/vm0/commit/66a92715329a1e399a136ffd998fc2e06f85a347))


### Bug Fixes

* **platform:** remove test-only data-tagline attribute from production html ([c82f045](https://github.com/vm0-ai/vm0/commit/c82f045fb8937fc2e6b5e73a9062aaba80e40b4f))


### Refactoring

* **platform:** migrate billing & usage signals to accept pattern ([#8018](https://github.com/vm0-ai/vm0/issues/8018)) ([532e42d](https://github.com/vm0-ai/vm0/commit/532e42d34c252890db49cfa5519d242e364038a6))
* **platform:** redesign agents page layout with grid/list view toggle ([#8025](https://github.com/vm0-ai/vm0/issues/8025)) ([689c9dd](https://github.com/vm0-ai/vm0/commit/689c9dd67936a1828c695f24bd1a64cd9fb908b6))


### Performance Improvements

* **onboarding:** consolidate into single server api call ([#8041](https://github.com/vm0-ai/vm0/issues/8041)) ([6bf4e9d](https://github.com/vm0-ai/vm0/commit/6bf4e9dc17d20fcb2d7947e6a636e2bb15f35929))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.150.0

## [0.186.3](https://github.com/vm0-ai/vm0/compare/app-v0.186.2...app-v0.186.3) (2026-04-03)


### Refactoring

* clean up detach reason usage in signals layer ([#7838](https://github.com/vm0-ai/vm0/issues/7838)) ([e61a5de](https://github.com/vm0-ai/vm0/commit/e61a5de987a835cf811717dc3d648d6d9681e8e5))
* migrate activity & firewall signals to accept pattern ([#8004](https://github.com/vm0-ai/vm0/issues/8004)) ([88870f7](https://github.com/vm0-ai/vm0/commit/88870f7a3957bfc5b8eecc835a66c38c56be0b79)), closes [#7881](https://github.com/vm0-ai/vm0/issues/7881)
* **platform:** migrate settings & org management signals to accept pattern ([#8000](https://github.com/vm0-ai/vm0/issues/8000)) ([8bda1ae](https://github.com/vm0-ai/vm0/commit/8bda1aea196857afa38a651573b0da7e75c90ab0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.149.1

## [0.186.2](https://github.com/vm0-ai/vm0/compare/app-v0.186.1...app-v0.186.2) (2026-04-03)


### Refactoring

* **platform:** migrate schedules & agents signals to accept pattern ([#7996](https://github.com/vm0-ai/vm0/issues/7996)) ([26e44c1](https://github.com/vm0-ai/vm0/commit/26e44c1603585edd070fb59b16704f12079c5182))
* **signals:** migrate chat & polling signals to accept pattern ([#7994](https://github.com/vm0-ai/vm0/issues/7994)) ([90633d2](https://github.com/vm0-ai/vm0/commit/90633d2f5054049a3c889c1294da750dfee3053c))

## [0.186.1](https://github.com/vm0-ai/vm0/compare/app-v0.186.0...app-v0.186.1) (2026-04-03)


### Bug Fixes

* **platform:** show skeleton overlay during onboarding-to-chat transition ([#7984](https://github.com/vm0-ai/vm0/issues/7984)) ([8017431](https://github.com/vm0-ai/vm0/commit/801743146e3468a78f87f51f8166be37787b3dda))


### Refactoring

* migrate external & infrastructure signals to accept pattern ([#7992](https://github.com/vm0-ai/vm0/issues/7992)) ([6bcd421](https://github.com/vm0-ai/vm0/commit/6bcd4216ee1634ccdce0a760a922e351476d5154)), closes [#7882](https://github.com/vm0-ai/vm0/issues/7882)
* **platform:** migrate Slack & Integrations signals to accept pattern ([#7990](https://github.com/vm0-ai/vm0/issues/7990)) ([45dd9a2](https://github.com/vm0-ai/vm0/commit/45dd9a2c59795cbd06e72b0991c3a261999a89d9))

## [0.186.0](https://github.com/vm0-ai/vm0/compare/app-v0.185.0...app-v0.186.0) (2026-04-03)


### Features

* **platform:** add ccstate/require-accept eslint rule for zeroClient$ calls ([#7907](https://github.com/vm0-ai/vm0/issues/7907)) ([19706c6](https://github.com/vm0-ai/vm0/commit/19706c6cb4cb2bf1ec4a31d715c53615186e9bc1))


### Bug Fixes

* **platform:** use spy to override console.error in test setup and fix unsafe type cast ([d792894](https://github.com/vm0-ai/vm0/commit/d7928949223fa8bff648cd4c45224a7ce67c4154))
* suppress act warnings and fix duplicate react keys in chat timeline ([#7894](https://github.com/vm0-ai/vm0/issues/7894)) ([32c94d2](https://github.com/vm0-ai/vm0/commit/32c94d2020df771ff18da4a7ded736c587eb6924))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.149.0

## [0.185.0](https://github.com/vm0-ai/vm0/compare/app-v0.184.0...app-v0.185.0) (2026-04-03)


### Features

* add accept function and api error class for unified http error handling ([#7892](https://github.com/vm0-ai/vm0/issues/7892)) ([38c20d8](https://github.com/vm0-ai/vm0/commit/38c20d80b0336088ec8cb4c073b745f041b12511)), closes [#7873](https://github.com/vm0-ai/vm0/issues/7873)


### Refactoring

* **platform:** clean up tech debt in tests and lint config ([#7896](https://github.com/vm0-ai/vm0/issues/7896)) ([7558244](https://github.com/vm0-ai/vm0/commit/7558244140b9039cc04160d69cce4edc26b05fb2))
* **platform:** replace direct dom manipulation with react patterns ([#7901](https://github.com/vm0-ai/vm0/issues/7901)) ([e48041c](https://github.com/vm0-ai/vm0/commit/e48041ccef55a56ad67cfb637068affd83d7e8a0))
* **test:** remove ineffective vi.mock in zero-chat-page test ([#7887](https://github.com/vm0-ai/vm0/issues/7887)) ([b85523a](https://github.com/vm0-ai/vm0/commit/b85523aa80594987ec921f94a82de52fcd28b37f)), closes [#7831](https://github.com/vm0-ai/vm0/issues/7831)

## [0.184.0](https://github.com/vm0-ai/vm0/compare/app-v0.183.0...app-v0.184.0) (2026-04-03)


### Features

* **platform:** add no-direct-fetch eslint rule ([#7868](https://github.com/vm0-ai/vm0/issues/7868)) ([4290783](https://github.com/vm0-ai/vm0/commit/42907830a3d4dfa02ffce1918686ba86fc64539a))


### Bug Fixes

* eliminate blank flash between skeleton and content on initial load ([#7864](https://github.com/vm0-ai/vm0/issues/7864)) ([80cefea](https://github.com/vm0-ai/vm0/commit/80cefea2e405a949f702d01dd637cf770b2ed9ba))


### Refactoring

* replace manual delays in tests with deferred promises ([#7866](https://github.com/vm0-ai/vm0/issues/7866)) ([b6afd2a](https://github.com/vm0-ai/vm0/commit/b6afd2a2f985bf6052b22f2a721ab17157435a55))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.148.0

## [0.183.0](https://github.com/vm0-ai/vm0/compare/app-v0.182.0...app-v0.183.0) (2026-04-03)


### Features

* add connector permission dialog after successful connection ([#7813](https://github.com/vm0-ai/vm0/issues/7813)) ([73d5713](https://github.com/vm0-ai/vm0/commit/73d57137b7e315a7e644d6980110d77888bcd6a0))
* add no-detach-in-signals eslint rule ([#7844](https://github.com/vm0-ai/vm0/issues/7844)) ([af92242](https://github.com/vm0-ai/vm0/commit/af9224200b188ffe49c39b9f99e82919b157222f))


### Bug Fixes

* prevent schedule instructions panel from prompting save without changes ([#7837](https://github.com/vm0-ai/vm0/issues/7837)) ([ccca3a8](https://github.com/vm0-ai/vm0/commit/ccca3a8dcccef23e76e627f8db1d5c9e15c5f9c5))
* remove stale no-invalid-fetch-options allow rule from platform oxlint config ([#7845](https://github.com/vm0-ai/vm0/issues/7845)) ([c956d83](https://github.com/vm0-ai/vm0/commit/c956d8333dddb523a602517ba8934f8eca2664ea)), closes [#7841](https://github.com/vm0-ai/vm0/issues/7841)


### Refactoring

* replace dynamic import with static import in connector logos setup ([#7855](https://github.com/vm0-ai/vm0/issues/7855)) ([253d726](https://github.com/vm0-ai/vm0/commit/253d726386919048e89464ba193438cf63b4ceab))

## [0.182.0](https://github.com/vm0-ai/vm0/compare/app-v0.181.2...app-v0.182.0) (2026-04-03)


### Features

* add directed connect page for missing connector flow ([#7708](https://github.com/vm0-ai/vm0/issues/7708)) ([62a2ef3](https://github.com/vm0-ai/vm0/commit/62a2ef3cc72d1d70b4a5e23c80f3a1e328bfb297))


### Bug Fixes

* respect redirect_url query parameter after sign-in and sign-up ([#7814](https://github.com/vm0-ai/vm0/issues/7814)) ([ce0a58b](https://github.com/vm0-ai/vm0/commit/ce0a58b4ffd585fd8d3628b55acca5db291f0f2e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.147.0

## [0.181.2](https://github.com/vm0-ai/vm0/compare/app-v0.181.1...app-v0.181.2) (2026-04-03)


### Refactoring

* replace manual loading booleans with loadable hooks ([#7802](https://github.com/vm0-ai/vm0/issues/7802)) ([3074b16](https://github.com/vm0-ai/vm0/commit/3074b16f296e0de8046af87ef63d2708ab3e2d03)), closes [#7781](https://github.com/vm0-ai/vm0/issues/7781)
* replace manual loading booleans with loadable set hook in zero-jobs-page ([#7803](https://github.com/vm0-ai/vm0/issues/7803)) ([476b3f9](https://github.com/vm0-ai/vm0/commit/476b3f9ddb75acb2904aa58cee0d0d8ee3846135))

## [0.181.1](https://github.com/vm0-ai/vm0/compare/app-v0.181.0...app-v0.181.1) (2026-04-02)


### Refactoring

* convert job-detail fetch commands to reactive async computed ([#7787](https://github.com/vm0-ai/vm0/issues/7787)) ([f7bded7](https://github.com/vm0-ai/vm0/commit/f7bded72e7682ccbd2f229b4c3084d2505d44448)), closes [#7778](https://github.com/vm0-ai/vm0/issues/7778)
* replace manual loading booleans with loadable-set pattern in job-detail ([#7798](https://github.com/vm0-ai/vm0/issues/7798)) ([b05ea2a](https://github.com/vm0-ai/vm0/commit/b05ea2a1cac8c7f57de8c57cb5fe9c1648a0690a)), closes [#7779](https://github.com/vm0-ai/vm0/issues/7779)
* split zero-job-detail.ts into domain modules ([#7783](https://github.com/vm0-ai/vm0/issues/7783)) ([a5fbd9e](https://github.com/vm0-ai/vm0/commit/a5fbd9efc2cb44ef3d2081f50a0755b797d276cb)), closes [#7776](https://github.com/vm0-ai/vm0/issues/7776)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.146.0

## [0.181.0](https://github.com/vm0-ai/vm0/compare/app-v0.180.1...app-v0.181.0) (2026-04-02)


### Features

* add apollo.io api token connector ([#7753](https://github.com/vm0-ai/vm0/issues/7753)) ([16cdf0c](https://github.com/vm0-ai/vm0/commit/16cdf0c8c4500d667ce7ff1ba9b992ddb29b3799))


### Bug Fixes

* reset sidebar thread skeleton when switching agents ([#7768](https://github.com/vm0-ai/vm0/issues/7768)) ([8cc0af5](https://github.com/vm0-ai/vm0/commit/8cc0af5cbb9bee8ded3f5ba79076f2b8387fc7bd))
* restore onboarding slack preview image to original png ([43c993f](https://github.com/vm0-ai/vm0/commit/43c993f256103b729d74091f5e21b58ffc3c09f5))
* restore onboarding slack preview image to original png ([93b5905](https://github.com/vm0-ai/vm0/commit/93b590516ae39d19aa76e66450900346eb974284))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.145.0

## [0.180.1](https://github.com/vm0-ai/vm0/compare/app-v0.180.0...app-v0.180.1) (2026-04-02)


### Refactoring

* upgrade ccstate to 5.2.3 and use useLoadableSet in onboarding ([#7718](https://github.com/vm0-ai/vm0/issues/7718)) ([0ec928f](https://github.com/vm0-ai/vm0/commit/0ec928f11c40f4f94863ad4d65d56e7506f080c9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.144.0

## [0.180.0](https://github.com/vm0-ai/vm0/compare/app-v0.179.1...app-v0.180.0) (2026-04-02)


### Features

* add csv upload inspect route for activity log viewer ([#7630](https://github.com/vm0-ai/vm0/issues/7630)) ([91659d0](https://github.com/vm0-ai/vm0/commit/91659d077cb2a35b560290c91cc78dbd5872a5ac))


### Bug Fixes

* use page signal instead of standalone abort controller in onboarding ([#7692](https://github.com/vm0-ai/vm0/issues/7692)) ([b9b6de9](https://github.com/vm0-ai/vm0/commit/b9b6de9053194f54d7ad8723584ae006e1944138))


### Refactoring

* migrate eslint rules to native oxlint config ([#7690](https://github.com/vm0-ai/vm0/issues/7690)) ([aef6426](https://github.com/vm0-ai/vm0/commit/aef6426bd9ace376e22e16fa56843500d643fc86))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.143.0

## [0.179.1](https://github.com/vm0-ai/vm0/compare/app-v0.179.0...app-v0.179.1) (2026-04-02)


### Refactoring

* remove model provider selector from chat composer ([#7687](https://github.com/vm0-ai/vm0/issues/7687)) ([afc30c3](https://github.com/vm0-ai/vm0/commit/afc30c31f53a7e8b54a25174ba9c006dae950ce8)), closes [#7525](https://github.com/vm0-ai/vm0/issues/7525)
* simplify zero onboarding with shared completion command ([#7681](https://github.com/vm0-ai/vm0/issues/7681)) ([4b66405](https://github.com/vm0-ai/vm0/commit/4b6640537242d696b3565635028ceac3e6acff27))

## [0.179.0](https://github.com/vm0-ai/vm0/compare/app-v0.178.3...app-v0.179.0) (2026-04-02)


### Features

* add auth.base url rewriting for webhook-url firewall connectors ([#7618](https://github.com/vm0-ai/vm0/issues/7618)) ([55585ac](https://github.com/vm0-ai/vm0/commit/55585ac37db6938508ca957f83725389157c55da))


### Bug Fixes

* do not highlight agents tab on chat routes ([#7669](https://github.com/vm0-ai/vm0/issues/7669)) ([5314708](https://github.com/vm0-ai/vm0/commit/5314708d46b286820a67375e458d2a6fc2e9df68))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.142.0

## [0.178.3](https://github.com/vm0-ai/vm0/compare/app-v0.178.2...app-v0.178.3) (2026-04-02)


### Refactoring

* hoist sidebar layout to setup commands for react reconciliation ([#7655](https://github.com/vm0-ai/vm0/issues/7655)) ([0d56707](https://github.com/vm0-ai/vm0/commit/0d567073fe2ea7134cb657088db47c3bb8777155))

## [0.178.2](https://github.com/vm0-ai/vm0/compare/app-v0.178.1...app-v0.178.2) (2026-04-02)


### Bug Fixes

* read correct route param name in schedule detail page ([#7652](https://github.com/vm0-ai/vm0/issues/7652)) ([a036671](https://github.com/vm0-ai/vm0/commit/a0366716b85c0ba2e850a9960a9567e8c3a9c498)), closes [#7646](https://github.com/vm0-ai/vm0/issues/7646)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.141.0

## [0.178.1](https://github.com/vm0-ai/vm0/compare/app-v0.178.0...app-v0.178.1) (2026-04-02)


### Bug Fixes

* update sidebar highlight early on pinned agent switch ([#7645](https://github.com/vm0-ai/vm0/issues/7645)) ([9e416f7](https://github.com/vm0-ai/vm0/commit/9e416f74d6756a83ddf591860fc1d7e67540fd36))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.140.1

## [0.178.0](https://github.com/vm0-ai/vm0/compare/app-v0.177.2...app-v0.178.0) (2026-04-02)


### Features

* add no-direct-local-storage eslint rule ([#7622](https://github.com/vm0-ai/vm0/issues/7622)) ([8efec89](https://github.com/vm0-ai/vm0/commit/8efec891501e7fee11846377229f260adf82b917))
* unify agent permission model with admin-or-owner guard ([#7586](https://github.com/vm0-ai/vm0/issues/7586)) ([e0d6247](https://github.com/vm0-ai/vm0/commit/e0d6247f9d427eacfe616ec2c8e6e2cd33f873e9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.140.0

## [0.177.2](https://github.com/vm0-ai/vm0/compare/app-v0.177.1...app-v0.177.2) (2026-04-02)


### Bug Fixes

* prevent schedule list flash when toggling status ([#7579](https://github.com/vm0-ai/vm0/issues/7579)) ([967e59b](https://github.com/vm0-ai/vm0/commit/967e59ba48e63f478b711891cb73663c36fb7cb3))


### Refactoring

* unify frontend url routing scheme with plural nouns ([#7601](https://github.com/vm0-ai/vm0/issues/7601)) ([723b49d](https://github.com/vm0-ai/vm0/commit/723b49ddd78a0fe99dd22434e967139de4a0588f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.139.0

## [0.177.1](https://github.com/vm0-ai/vm0/compare/app-v0.177.0...app-v0.177.1) (2026-04-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.138.0

## [0.177.0](https://github.com/vm0-ai/vm0/compare/app-v0.176.0...app-v0.177.0) (2026-04-01)


### Features

* **platform:** replace clerk org switcher with zero-native component ([#7561](https://github.com/vm0-ai/vm0/issues/7561)) ([f799b19](https://github.com/vm0-ai/vm0/commit/f799b1973332c14aae140097c2770ab68ea5c7f5))

## [0.176.0](https://github.com/vm0-ai/vm0/compare/app-v0.175.1...app-v0.176.0) (2026-04-01)


### Features

* **org:** add role selection to member invite flow ([#7555](https://github.com/vm0-ai/vm0/issues/7555)) ([891fc35](https://github.com/vm0-ai/vm0/commit/891fc35eaeba4c73c741accc5bc810df46d17962))
* **platform:** add placeholder assistant message for immediate chat feedback ([#7549](https://github.com/vm0-ai/vm0/issues/7549)) ([38f926f](https://github.com/vm0-ai/vm0/commit/38f926f3e12414136655684db2a2dc006eb37ed0))


### Bug Fixes

* reset chat thread page on thread switch to show skeleton ([#7571](https://github.com/vm0-ai/vm0/issues/7571)) ([1d8eb6c](https://github.com/vm0-ai/vm0/commit/1d8eb6cd8d10fa13d0c74e30008cbffa2cfdf9dd))


### Performance Improvements

* convert zero-page images from png to webp for smaller bundle size ([#7572](https://github.com/vm0-ai/vm0/issues/7572)) ([3e43dd5](https://github.com/vm0-ai/vm0/commit/3e43dd564ccf440f5998f64ca3e0a109cde98037))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.137.0

## [0.175.1](https://github.com/vm0-ai/vm0/compare/app-v0.175.0...app-v0.175.1) (2026-04-01)


### Bug Fixes

* **platform:** hide empty fields in network log detail view ([#7529](https://github.com/vm0-ai/vm0/issues/7529)) ([1cc1505](https://github.com/vm0-ai/vm0/commit/1cc15054c23e1aa8990985e43435d1c3f1461995))


### Refactoring

* remove schedule notification system ([#7509](https://github.com/vm0-ai/vm0/issues/7509)) ([85ece06](https://github.com/vm0-ai/vm0/commit/85ece067e994b4d48dab3d3b2e47b8fc19951455))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.136.0

## [0.175.0](https://github.com/vm0-ai/vm0/compare/app-v0.174.1...app-v0.175.0) (2026-04-01)


### Features

* add collapsible permission groups in firewall dialog ([#7507](https://github.com/vm0-ai/vm0/issues/7507)) ([e3fef9c](https://github.com/vm0-ai/vm0/commit/e3fef9cc4f452fa62a41a8541ed7c5d8ea986386))


### Bug Fixes

* **web:** reuse existing empty chat thread instead of creating duplicates ([#7368](https://github.com/vm0-ai/vm0/issues/7368)) ([#7510](https://github.com/vm0-ai/vm0/issues/7510)) ([3bd5b19](https://github.com/vm0-ai/vm0/commit/3bd5b1927b5a6e3c42cd74743562954e872f983f))


### Refactoring

* **platform:** onboarding components read signals directly ([#7501](https://github.com/vm0-ai/vm0/issues/7501)) ([c65edb5](https://github.com/vm0-ai/vm0/commit/c65edb50775eccce4ef9db87dae27a0758810af4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.135.0

## [0.174.1](https://github.com/vm0-ai/vm0/compare/app-v0.174.0...app-v0.174.1) (2026-04-01)


### Bug Fixes

* **platform:** preserve chronological order of cancelled chat messages ([#7494](https://github.com/vm0-ai/vm0/issues/7494)) ([1130617](https://github.com/vm0-ai/vm0/commit/11306178ef777823b3ec7c79ed7afa005be616f1))
* **platform:** show activity line above content during streaming ([#7493](https://github.com/vm0-ai/vm0/issues/7493)) ([5d96943](https://github.com/vm0-ai/vm0/commit/5d9694304819c1e137be42e4d0d7984b584d5f43))
* use instant scroll behavior for chat auto-scroll ([#7496](https://github.com/vm0-ai/vm0/issues/7496)) ([9c4dedd](https://github.com/vm0-ai/vm0/commit/9c4dedd64462f0b4ee018716749ef7f31c6570cb))


### Refactoring

* migrate connector oauth routes to zero namespace ([#7473](https://github.com/vm0-ai/vm0/issues/7473)) ([eae5501](https://github.com/vm0-ai/vm0/commit/eae55012401322f975897a68097cab008a78b650))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.134.0

## [0.174.0](https://github.com/vm0-ai/vm0/compare/app-v0.173.0...app-v0.174.0) (2026-04-01)


### Features

* group connector permissions by category (admin/read/write) ([#7476](https://github.com/vm0-ai/vm0/issues/7476)) ([9ffa468](https://github.com/vm0-ai/vm0/commit/9ffa468cd4029c0ec62e54347d086b3a4335cb77))
* **platform:** add network logs page to activity detail ([#7461](https://github.com/vm0-ai/vm0/issues/7461)) ([c321d03](https://github.com/vm0-ai/vm0/commit/c321d038744fd4034a63f77d8f0c0631a06361aa))


### Refactoring

* **platform:** extract onboarding completion logic into ccstate signals ([#7472](https://github.com/vm0-ai/vm0/issues/7472)) ([fd13eaf](https://github.com/vm0-ai/vm0/commit/fd13eaf204e196c4f72abb062dc2ec82fa89deea))
* remove org slug from logs api response and related types ([#7457](https://github.com/vm0-ai/vm0/issues/7457)) ([79f4591](https://github.com/vm0-ai/vm0/commit/79f45915dca93e17eb345ee41d309dde2fb5872b))
* remove org slug from schedule response and contract ([#7436](https://github.com/vm0-ai/vm0/issues/7436)) ([#7456](https://github.com/vm0-ai/vm0/issues/7456)) ([7001594](https://github.com/vm0-ai/vm0/commit/7001594afafabf8e715aa57edc53094a854e03c1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.133.0

## [0.173.0](https://github.com/vm0-ai/vm0/compare/app-v0.172.1...app-v0.173.0) (2026-04-01)


### Features

* improve connector draft scoping and add connectors dialog ([#7364](https://github.com/vm0-ai/vm0/issues/7364)) ([a0b81a3](https://github.com/vm0-ai/vm0/commit/a0b81a391ced6d6540a519ab8ff09bfccc61d869))


### Bug Fixes

* **platform:** clear building state before content update in instructions editor ([#7455](https://github.com/vm0-ai/vm0/issues/7455)) ([a2565ff](https://github.com/vm0-ai/vm0/commit/a2565ffd628644a88e772fc349be21bc6a7b867c))
* **platform:** improve mobile responsive layout for onboarding and dialogs ([#7393](https://github.com/vm0-ai/vm0/issues/7393)) ([1e4c7fd](https://github.com/vm0-ai/vm0/commit/1e4c7fdce4f87d471b968eaa7f33f59bb982a38c))


### Refactoring

* ban test timeout parameters via eslint no-restricted-syntax ([#7449](https://github.com/vm0-ai/vm0/issues/7449)) ([d30f85b](https://github.com/vm0-ai/vm0/commit/d30f85bf9495e1ce92a9a8dd9fbfd1ce48935b5e)), closes [#7444](https://github.com/vm0-ai/vm0/issues/7444)
* **platform:** remove defensive try-catch patterns from zero-chat signals ([#7440](https://github.com/vm0-ai/vm0/issues/7440)) ([8a3075a](https://github.com/vm0-ai/vm0/commit/8a3075a85db69d7f12d8db918d33210c0479dc96))
* **platform:** simplify zero-chat send command interfaces ([#7452](https://github.com/vm0-ai/vm0/issues/7452)) ([814e57f](https://github.com/vm0-ai/vm0/commit/814e57fdac48da3c13479d257afac3dc6a176399))

## [0.172.1](https://github.com/vm0-ai/vm0/compare/app-v0.172.0...app-v0.172.1) (2026-04-01)


### Refactoring

* **platform:** clean up zero-chat signal naming and remove defensive patterns ([#7405](https://github.com/vm0-ai/vm0/issues/7405)) ([bb01422](https://github.com/vm0-ai/vm0/commit/bb0142215b1aa73b2341669b066c3f45a553bcea))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.132.1

## [0.172.0](https://github.com/vm0-ai/vm0/compare/app-v0.171.2...app-v0.172.0) (2026-03-31)


### Features

* add activity log list feature switch to gate sidebar and breadcrumb visibility ([#7425](https://github.com/vm0-ai/vm0/issues/7425)) ([623b220](https://github.com/vm0-ai/vm0/commit/623b2203641bad18b4e91b28931564668466d62a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.132.0

## [0.171.2](https://github.com/vm0-ai/vm0/compare/app-v0.171.1...app-v0.171.2) (2026-03-31)


### Refactoring

* **platform:** migrate tests from fire-event to user-event ([#7416](https://github.com/vm0-ai/vm0/issues/7416)) ([2e98272](https://github.com/vm0-ai/vm0/commit/2e98272b85a5561e4493ee9b78d77a44814443f2))
* remove redundant preview field from chat thread list items ([#7418](https://github.com/vm0-ai/vm0/issues/7418)) ([1b3bbee](https://github.com/vm0-ai/vm0/commit/1b3bbeec9aa0d7ff8ae18d446f63e4966108ee9e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.131.2

## [0.171.1](https://github.com/vm0-ai/vm0/compare/app-v0.171.0...app-v0.171.1) (2026-03-31)


### Refactoring

* inline ZeroTalkPage wrapper into ZeroChatPage ([#7413](https://github.com/vm0-ai/vm0/issues/7413)) ([55c67e6](https://github.com/vm0-ai/vm0/commit/55c67e684dae2b35597dfa2214d9dc81aa887ae1)), closes [#7411](https://github.com/vm0-ai/vm0/issues/7411)
* remove redundant ?org=slug query param from all routes ([#7301](https://github.com/vm0-ai/vm0/issues/7301)) ([96d6b6c](https://github.com/vm0-ai/vm0/commit/96d6b6ced9bb5770bce51301ceabea226bcc22f4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.131.1

## [0.171.0](https://github.com/vm0-ai/vm0/compare/app-v0.170.0...app-v0.171.0) (2026-03-31)


### Features

* add chat thread deletion ([#7372](https://github.com/vm0-ai/vm0/issues/7372)) ([c3f8932](https://github.com/vm0-ai/vm0/commit/c3f8932847f40a3de1c5f4279b225e10fe64a73a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.131.0

## [0.170.0](https://github.com/vm0-ai/vm0/compare/app-v0.169.0...app-v0.170.0) (2026-03-31)


### Features

* add chat button on agent profile page ([#7376](https://github.com/vm0-ai/vm0/issues/7376)) ([4ad0862](https://github.com/vm0-ai/vm0/commit/4ad0862e86a0b36ed550018640d64e78b727b005))
* **platform:** add account dropdown to onboarding page ([#7383](https://github.com/vm0-ai/vm0/issues/7383)) ([6dc8237](https://github.com/vm0-ai/vm0/commit/6dc8237f54ae9a0df638a49d02f3c67c426b2309))


### Bug Fixes

* set instruction card background to bg-card instead of bg-transparent ([#7378](https://github.com/vm0-ai/vm0/issues/7378)) ([e2a2a3f](https://github.com/vm0-ai/vm0/commit/e2a2a3fe819a6acab8a0170acabfd4d6071a8d4c))


### Refactoring

* move chat title generation from webhook completion to message creation ([#7357](https://github.com/vm0-ai/vm0/issues/7357)) ([915b066](https://github.com/vm0-ai/vm0/commit/915b0662ebaa2fb22362799f5fb68b2fdf876ac8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.130.2

## [0.169.0](https://github.com/vm0-ai/vm0/compare/app-v0.168.0...app-v0.169.0) (2026-03-31)


### Features

* **platform:** add error state handling for activity page ([#7363](https://github.com/vm0-ai/vm0/issues/7363)) ([306a2ae](https://github.com/vm0-ai/vm0/commit/306a2ae0b0733ec4a3e2d2006c56e72254821b00))


### Bug Fixes

* **platform:** deduplicate local messages against server-persisted messages ([#7366](https://github.com/vm0-ai/vm0/issues/7366)) ([19f0269](https://github.com/vm0-ai/vm0/commit/19f02696b44d14b6e63ce157a6752fb8cabb9f82))
* **platform:** improve timezone selector with auto-detect and GMT offset labels ([#7298](https://github.com/vm0-ai/vm0/issues/7298)) ([ccf3563](https://github.com/vm0-ai/vm0/commit/ccf3563860877e51503f3a93a015463b908b9dff))
* **platform:** prevent stale empty events from skipping activity skeleton ([#7358](https://github.com/vm0-ai/vm0/issues/7358)) ([c79581a](https://github.com/vm0-ai/vm0/commit/c79581ab88b40f133e267811fae65dce4b4b741a))
* prevent sidebar session list flicker during refresh ([#7375](https://github.com/vm0-ai/vm0/issues/7375)) ([62199eb](https://github.com/vm0-ai/vm0/commit/62199eb7210c294253346a0072cdcbc3e01bb11f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.130.1

## [0.168.0](https://github.com/vm0-ai/vm0/compare/app-v0.167.0...app-v0.168.0) (2026-03-31)


### Features

* add run execution context page for debugging ([#7325](https://github.com/vm0-ai/vm0/issues/7325)) ([e3e56e8](https://github.com/vm0-ai/vm0/commit/e3e56e8dfd685badc10fcbdd144f952afe74fca4))
* add selected model tooltip to activity log detail ([#7319](https://github.com/vm0-ai/vm0/issues/7319)) ([4ec0f43](https://github.com/vm0-ai/vm0/commit/4ec0f43759c01bf8a41c3225189192698d031d31))
* show parent agent display name for delegated runs in activity log ([#7184](https://github.com/vm0-ai/vm0/issues/7184)) ([100ce19](https://github.com/vm0-ai/vm0/commit/100ce19543169be0a1a420217d26fcff67f97a38))


### Bug Fixes

* **connector:** notify parent window on oauth completion via broadcast channel ([#7279](https://github.com/vm0-ai/vm0/issues/7279)) ([4924ffd](https://github.com/vm0-ai/vm0/commit/4924ffd76fee36160833cbb917a9ef745ed211d5))


### Refactoring

* **platform:** extract per-thread chat draft state ([#7326](https://github.com/vm0-ai/vm0/issues/7326)) ([599476c](https://github.com/vm0-ai/vm0/commit/599476c100dfbb4a5082910ae5a7e70bdc0a018a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.130.0

## [0.167.0](https://github.com/vm0-ai/vm0/compare/app-v0.166.0...app-v0.167.0) (2026-03-31)


### Features

* **connectors:** introduce per-user connector permission system ([#7174](https://github.com/vm0-ai/vm0/issues/7174)) ([121f1c7](https://github.com/vm0-ai/vm0/commit/121f1c7012fe37277597d40062e808265f022eec))


### Bug Fixes

* **platform:** prevent avatar flicker on page load ([#7287](https://github.com/vm0-ai/vm0/issues/7287)) ([cc28edb](https://github.com/vm0-ai/vm0/commit/cc28edb373e1015af92ae4a5d2a89abd15c0c546))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.129.0

## [0.166.0](https://github.com/vm0-ai/vm0/compare/app-v0.165.2...app-v0.166.0) (2026-03-31)


### Features

* add custom skills foundation for zero agents ([#7198](https://github.com/vm0-ai/vm0/issues/7198)) ([b9985bc](https://github.com/vm0-ai/vm0/commit/b9985bc5e1f689d8888c95e4ead33418a4018478))
* **platform:** add no-new-abort-controller eslint rule ([#7272](https://github.com/vm0-ai/vm0/issues/7272)) ([ea1c48d](https://github.com/vm0-ai/vm0/commit/ea1c48d3ed42ded313fbd3a2a5170b3664dd76d5))
* **platform:** enable ts-rest response validation in tests ([#7205](https://github.com/vm0-ai/vm0/issues/7205)) ([84bbc67](https://github.com/vm0-ai/vm0/commit/84bbc672e9424b25b31c53fa361bbd20d7a63baf))


### Bug Fixes

* **platform:** add consistent padding to schedule calendar view ([#7232](https://github.com/vm0-ai/vm0/issues/7232)) ([ae41ee3](https://github.com/vm0-ai/vm0/commit/ae41ee39128092ab1bd8f076983fabc0b7de374e))
* **platform:** dismiss loading toast when schedule run is aborted ([#7282](https://github.com/vm0-ai/vm0/issues/7282)) ([8ce81a9](https://github.com/vm0-ai/vm0/commit/8ce81a91b23becc6c8c743adc7383d76e7b7d6a3))
* **platform:** fix activity log copy icon alignment ([#7235](https://github.com/vm0-ai/vm0/issues/7235)) ([32b77bc](https://github.com/vm0-ai/vm0/commit/32b77bc9e71f3a4789a9fc3e072788dc6d103381))
* **platform:** fix model provider card overflow and add zero-app class to org dialog ([#7229](https://github.com/vm0-ai/vm0/issues/7229)) ([ec954a4](https://github.com/vm0-ai/vm0/commit/ec954a4c9a99321e823e5a8c1d57327721cb1b99))
* show skeleton loading rows in thread list when switching agents ([#7269](https://github.com/vm0-ai/vm0/issues/7269)) ([5ee5c50](https://github.com/vm0-ai/vm0/commit/5ee5c500303a821053259e02cfa55c0a9b99e38c))


### Refactoring

* make assistant message content reactive via result$ computed ([#7299](https://github.com/vm0-ai/vm0/issues/7299)) ([bf66efb](https://github.com/vm0-ai/vm0/commit/bf66efb757a98290835af3b1fac207312e5d1fe9))
* remove dead session switch signals and related deprecated exports ([#7270](https://github.com/vm0-ai/vm0/issues/7270)) ([2ff7992](https://github.com/vm0-ai/vm0/commit/2ff7992d79e0cf4b6903be608fc63e900b16e8c6))
* remove unused chat-threads runs endpoint ([#7263](https://github.com/vm0-ai/vm0/issues/7263)) ([15850f2](https://github.com/vm0-ai/vm0/commit/15850f27e2d2219a7f89041d0702ba2a08009871)), closes [#7258](https://github.com/vm0-ai/vm0/issues/7258)
* split sendZeroChatMessage$ into new-thread and existing-thread commands ([#7290](https://github.com/vm0-ai/vm0/issues/7290)) ([8901ebe](https://github.com/vm0-ai/vm0/commit/8901ebe1581b1d4e5a6f2b6a74f76a396bf3bcd5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.128.0

## [0.165.2](https://github.com/vm0-ai/vm0/compare/app-v0.165.1...app-v0.165.2) (2026-03-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.127.0

## [0.165.1](https://github.com/vm0-ai/vm0/compare/app-v0.165.0...app-v0.165.1) (2026-03-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.126.0

## [0.165.0](https://github.com/vm0-ai/vm0/compare/app-v0.164.0...app-v0.165.0) (2026-03-30)


### Features

* add unified chat messages endpoint ([#7222](https://github.com/vm0-ai/vm0/issues/7222)) ([1a7bb9e](https://github.com/vm0-ai/vm0/commit/1a7bb9ee48d52b416924083e32c1af6230e24bd3))


### Bug Fixes

* **platform:** replace button role queries with text queries in onboarding tests ([#7210](https://github.com/vm0-ai/vm0/issues/7210)) ([5d46970](https://github.com/vm0-ai/vm0/commit/5d46970e87a3d7654cfcd3281915807be7a133fe))
* **platform:** use dynamic poll interval for session list refresh ([#7189](https://github.com/vm0-ai/vm0/issues/7189)) ([bd3c2f7](https://github.com/vm0-ai/vm0/commit/bd3c2f7c76e555b9f3ad6d5f620dc4045e151675))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.125.0

## [0.164.0](https://github.com/vm0-ai/vm0/compare/app-v0.163.0...app-v0.164.0) (2026-03-30)


### Features

* **core:** add default firewall permission policies for connectors ([#7170](https://github.com/vm0-ai/vm0/issues/7170)) ([97beaa1](https://github.com/vm0-ai/vm0/commit/97beaa162835d25243a8535df8b76a4bc6992da4))


### Refactoring

* replace upload abort controllers map with signals object factory ([#7165](https://github.com/vm0-ai/vm0/issues/7165)) ([ec9a462](https://github.com/vm0-ai/vm0/commit/ec9a462deb9aca1ed90b0e3ff3c9fec9742f175b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.124.0

## [0.163.0](https://github.com/vm0-ai/vm0/compare/app-v0.162.2...app-v0.163.0) (2026-03-30)


### Features

* emit warn-level log for local storage config overrides ([#7147](https://github.com/vm0-ai/vm0/issues/7147)) ([24b62e5](https://github.com/vm0-ai/vm0/commit/24b62e51793184019e3ce935eee1464290365f4c)), closes [#7144](https://github.com/vm0-ai/vm0/issues/7144)
* **platform:** use link for agent avatar and speed up agent switching ([#7064](https://github.com/vm0-ai/vm0/issues/7064)) ([1bf52d3](https://github.com/vm0-ai/vm0/commit/1bf52d3fa7ec38c77e435428660b102cf8de85f2))
* **platform:** use preferred timezone as default in schedule dialog ([#7058](https://github.com/vm0-ai/vm0/issues/7058)) ([4958a31](https://github.com/vm0-ai/vm0/commit/4958a3138784de6013f12e9a7c720c7831e2cd35))
* **slack:** prompt admin to reinstall when oauth bot scopes change ([#7057](https://github.com/vm0-ai/vm0/issues/7057)) ([34a1045](https://github.com/vm0-ai/vm0/commit/34a104570cf0b6e75be7917dc558b6ce6ab81589))


### Bug Fixes

* **platform:** add missing org management clerk features ([#7054](https://github.com/vm0-ai/vm0/issues/7054)) ([0c84dfb](https://github.com/vm0-ai/vm0/commit/0c84dfb78a5e21357616ef19e9a352a4fb0b3884))
* **platform:** replace native scrollbar with overlay indicator in sidebar ([#7145](https://github.com/vm0-ai/vm0/issues/7145)) ([4360941](https://github.com/vm0-ai/vm0/commit/4360941ec8c51003f05a5abe4f08e28ec8fe165a))


### Refactoring

* **platform:** convert chat agent identity from command+state to async computed ([#7156](https://github.com/vm0-ai/vm0/issues/7156)) ([1b4d3ea](https://github.com/vm0-ai/vm0/commit/1b4d3ea8e9b3a1a0a37a0b452929953ab581efea))
* replace manual boolean loading state with async computed ([#7163](https://github.com/vm0-ai/vm0/issues/7163)) ([e74b412](https://github.com/vm0-ai/vm0/commit/e74b41288272285b0fc93bb9e22f65fde682be21)), closes [#7157](https://github.com/vm0-ai/vm0/issues/7157)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.123.0

## [0.162.2](https://github.com/vm0-ai/vm0/compare/app-v0.162.1...app-v0.162.2) (2026-03-30)


### Refactoring

* decompose chatSessionSnapshot$ and unify polling via createRunLoop ([#7033](https://github.com/vm0-ai/vm0/issues/7033)) ([d6dd572](https://github.com/vm0-ai/vm0/commit/d6dd5728e4668ea7f260c9bcb72dd073c7e70371))
* **platform:** move horizontal padding into table components for consistent alignment ([#7089](https://github.com/vm0-ai/vm0/issues/7089)) ([fc266ff](https://github.com/vm0-ai/vm0/commit/fc266ff08e40f5c7e049419d20c84d915780e8e7))
* **platform:** unify design system styles across UI components ([#7082](https://github.com/vm0-ai/vm0/issues/7082)) ([f947e95](https://github.com/vm0-ai/vm0/commit/f947e954561fc77256d5b3e63bc35ca4ba30ffda))

## [0.162.1](https://github.com/vm0-ai/vm0/compare/app-v0.162.0...app-v0.162.1) (2026-03-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.122.0

## [0.162.0](https://github.com/vm0-ai/vm0/compare/app-v0.161.1...app-v0.162.0) (2026-03-29)


### Features

* **platform:** add collapsible sidebar sections and fix scrolling area ([#7086](https://github.com/vm0-ai/vm0/issues/7086)) ([2528e3b](https://github.com/vm0-ai/vm0/commit/2528e3baab4d86326739572e684f65315be77d44))
* **web:** add invite people button to zero chat landing page ([#7109](https://github.com/vm0-ai/vm0/issues/7109)) ([16e6b2b](https://github.com/vm0-ai/vm0/commit/16e6b2b969c47281341e962ea5ab344d88c82c23))
* **web:** redesign model provider settings with default selection ([#6949](https://github.com/vm0-ai/vm0/issues/6949)) ([c58e497](https://github.com/vm0-ai/vm0/commit/c58e4976e595294ee73fe17be560e5623bde7148))


### Bug Fixes

* **platform:** remove white background from illustration assets and use theme color ([#7087](https://github.com/vm0-ai/vm0/issues/7087)) ([436ebf7](https://github.com/vm0-ai/vm0/commit/436ebf7a966da3bf812934350d8d47da0b986707))


### Documentation

* **cli:** add after-help examples and notes to all zero commands ([#7079](https://github.com/vm0-ai/vm0/issues/7079)) ([e4e756f](https://github.com/vm0-ai/vm0/commit/e4e756f8c4b96b9cb508878ee64a52c8dca9a5c5))


### Refactoring

* **platform:** replace slack org state with async computed and reload trigger ([#7074](https://github.com/vm0-ai/vm0/issues/7074)) ([6b59cdb](https://github.com/vm0-ai/vm0/commit/6b59cdbd2f7d931961daa7660adb49f6f27c457f))
* **platform:** unify card shadows and polish background color ([#7108](https://github.com/vm0-ai/vm0/issues/7108)) ([29b557b](https://github.com/vm0-ai/vm0/commit/29b557b7cb15de3a555ba398658bdafba8b4cddb))

## [0.161.1](https://github.com/vm0-ai/vm0/compare/app-v0.161.0...app-v0.161.1) (2026-03-27)


### Bug Fixes

* **platform:** retain active agent when navigating between pages ([#7071](https://github.com/vm0-ai/vm0/issues/7071)) ([8c542da](https://github.com/vm0-ai/vm0/commit/8c542da87181a373e5a19f0e163d32578dc932ad))

## [0.161.0](https://github.com/vm0-ai/vm0/compare/app-v0.160.0...app-v0.161.0) (2026-03-27)


### Features

* add credit expiry records with first-expiring-first-out deduction ([#7049](https://github.com/vm0-ai/vm0/issues/7049)) ([f9bbfb1](https://github.com/vm0-ai/vm0/commit/f9bbfb170c42867c2aa64573ccf7f12c1e19ec74))


### Bug Fixes

* resolve auto-recharge toggle deadlock when no prior config exists ([#7076](https://github.com/vm0-ai/vm0/issues/7076)) ([fe554fb](https://github.com/vm0-ai/vm0/commit/fe554fb963f67c34a8fab6450874375f975b61c8))


### Refactoring

* **platform:** remove unused exports and clean up knip ignore patterns ([#7069](https://github.com/vm0-ai/vm0/issues/7069)) ([2b0707f](https://github.com/vm0-ai/vm0/commit/2b0707fea9079ef1435c5e00a4f11aaaf5d8825f))
* **platform:** remove update-pathname signal and add test-only helper ([#7062](https://github.com/vm0-ai/vm0/issues/7062)) ([3a0eca4](https://github.com/vm0-ai/vm0/commit/3a0eca4c621ddf6d8930150a0e8c71f3bb7b2351))
* **platform:** rename route path params to be more descriptive ([#7061](https://github.com/vm0-ai/vm0/issues/7061)) ([498b52e](https://github.com/vm0-ai/vm0/commit/498b52ef05930ddbe0c07b6d83d7dd6df9c98f14))
* remove queued message logic from zero-chat ([#7073](https://github.com/vm0-ai/vm0/issues/7073)) ([af1cd8a](https://github.com/vm0-ai/vm0/commit/af1cd8a16140e9d77febc740101b4366a64d96b8))
* simplify credit breakdown popover to show only expiry records ([#7078](https://github.com/vm0-ai/vm0/issues/7078)) ([9d58113](https://github.com/vm0-ai/vm0/commit/9d581137317edd7949fea5bdea7956b4d6abb644)), closes [#7072](https://github.com/vm0-ai/vm0/issues/7072)
* **zero-onboarding:** derive onboarding step reactively instead of imperatively ([#7075](https://github.com/vm0-ai/vm0/issues/7075)) ([f873010](https://github.com/vm0-ai/vm0/commit/f8730102ec2fccd0562e888a2beec67812d46033))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.121.0

## [0.160.0](https://github.com/vm0-ai/vm0/compare/app-v0.159.0...app-v0.160.0) (2026-03-27)


### Features

* add persistent agent avatar with picker ui ([#7035](https://github.com/vm0-ai/vm0/issues/7035)) ([91e09d2](https://github.com/vm0-ai/vm0/commit/91e09d2310d978964c8b7f51b07f65d5700dc072))
* **platform:** sort connected connectors before unconnected ones ([#7039](https://github.com/vm0-ai/vm0/issues/7039)) ([a5d2a4b](https://github.com/vm0-ai/vm0/commit/a5d2a4b10a6755453e6bc466d93a40a2d715db95))
* **platform:** support ?prompt= query param to pre-fill chat input ([#7040](https://github.com/vm0-ai/vm0/issues/7040)) ([4c5c9da](https://github.com/vm0-ai/vm0/commit/4c5c9da74b152f239fe0c9fcd60f6c071d50310a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.120.0

## [0.159.0](https://github.com/vm0-ai/vm0/compare/app-v0.158.1...app-v0.159.0) (2026-03-27)


### Features

* preserve agent context when navigating from ideas to chat ([#6969](https://github.com/vm0-ai/vm0/issues/6969)) ([acf8d32](https://github.com/vm0-ai/vm0/commit/acf8d325dfe6a2bedf566a1ea208ad3cc5abc4b5))


### Bug Fixes

* display cancelled subscription status in billing settings ([#7045](https://github.com/vm0-ai/vm0/issues/7045)) ([c946bec](https://github.com/vm0-ai/vm0/commit/c946beca8d8498fe971bc750e3a5aaba40dd8953)), closes [#7038](https://github.com/vm0-ai/vm0/issues/7038)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.119.2

## [0.158.1](https://github.com/vm0-ai/vm0/compare/app-v0.158.0...app-v0.158.1) (2026-03-27)


### Bug Fixes

* add schedule quick link in activity log ([#6974](https://github.com/vm0-ai/vm0/issues/6974)) ([839cab3](https://github.com/vm0-ai/vm0/commit/839cab31b58acc22affe39e70ba748eec3c1ee52))


### Refactoring

* **platform:** remove guest navbar from sidebar layout ([#6965](https://github.com/vm0-ai/vm0/issues/6965)) ([a59f17f](https://github.com/vm0-ai/vm0/commit/a59f17f3fe53cd33b1f348caf25178536e21a994))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.119.1

## [0.158.0](https://github.com/vm0-ai/vm0/compare/app-v0.157.0...app-v0.158.0) (2026-03-27)


### Features

* add agent trigger source, sessionId inference, and agent tools prompt for zero run ([#6991](https://github.com/vm0-ai/vm0/issues/6991)) ([514c71b](https://github.com/vm0-ai/vm0/commit/514c71b3feb53a18d02e0b46f989f0a4e2bf8151))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.119.0

## [0.157.0](https://github.com/vm0-ai/vm0/compare/app-v0.156.1...app-v0.157.0) (2026-03-26)


### Features

* **web:** add use cases for public connectors missing from gallery ([#6987](https://github.com/vm0-ai/vm0/issues/6987)) ([afec884](https://github.com/vm0-ai/vm0/commit/afec8840a1b14fd1b2baf066ac999bdde7c7e9fe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.118.3

## [0.156.1](https://github.com/vm0-ai/vm0/compare/app-v0.156.0...app-v0.156.1) (2026-03-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.118.2

## [0.156.0](https://github.com/vm0-ai/vm0/compare/app-v0.155.2...app-v0.156.0) (2026-03-26)


### Features

* add e2e browser test for onboarding-to-chat flow ([#7001](https://github.com/vm0-ai/vm0/issues/7001)) ([f55b15c](https://github.com/vm0-ai/vm0/commit/f55b15c2be966fc41a3b1372bece2e80f197d46a))
* **web:** redesign global loading screen with avatar and typewriter text ([#6972](https://github.com/vm0-ai/vm0/issues/6972)) ([01cadce](https://github.com/vm0-ai/vm0/commit/01cadce939c467e4c1293d665f7fabd7600812ba))


### Bug Fixes

* **web:** align schedule page spacing with logs and fix sidebar x button color ([#6989](https://github.com/vm0-ai/vm0/issues/6989)) ([bd6373d](https://github.com/vm0-ai/vm0/commit/bd6373d166c1e52d39e6b1ab593dc6b032a2a185))
* **web:** remove red dot indicator from connector trigger icons ([#6975](https://github.com/vm0-ai/vm0/issues/6975)) ([9adcb03](https://github.com/vm0-ai/vm0/commit/9adcb030c70386ffee058371208f5df9321a2f64))


### Refactoring

* **web:** remove use cases referencing experimental connectors ([#6980](https://github.com/vm0-ai/vm0/issues/6980)) ([73bb0df](https://github.com/vm0-ai/vm0/commit/73bb0df7ebd8b8414dba8db43682f022b2d50acf))

## [0.155.2](https://github.com/vm0-ai/vm0/compare/app-v0.155.1...app-v0.155.2) (2026-03-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.118.1

## [0.155.1](https://github.com/vm0-ai/vm0/compare/app-v0.155.0...app-v0.155.1) (2026-03-26)


### Refactoring

* simplify chat tests with configurable poll interval ([#6861](https://github.com/vm0-ai/vm0/issues/6861)) ([12f2d04](https://github.com/vm0-ai/vm0/commit/12f2d0418c211c9d3813e6e6b0927b5d9fa41f77))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.118.0

## [0.155.0](https://github.com/vm0-ai/vm0/compare/app-v0.154.0...app-v0.155.0) (2026-03-26)


### Features

* add spotify oauth connector with firewall rules ([#6947](https://github.com/vm0-ai/vm0/issues/6947)) ([353f1eb](https://github.com/vm0-ai/vm0/commit/353f1eba5771ecb559bce41b718cf651a5f07611))
* redesign onboarding as full-page split layout with 4-step flow ([#6683](https://github.com/vm0-ai/vm0/issues/6683)) ([e50ec07](https://github.com/vm0-ai/vm0/commit/e50ec079bbc9489407502a8f207c0a29635e3083))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.117.0

## [0.154.0](https://github.com/vm0-ai/vm0/compare/app-v0.153.1...app-v0.154.0) (2026-03-26)


### Features

* add gamma api connector and firewall ([#6882](https://github.com/vm0-ai/vm0/issues/6882)) ([9e349b6](https://github.com/vm0-ai/vm0/commit/9e349b67014f7600a5bc116d12a1e29fe4a54322))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.116.0

## [0.153.1](https://github.com/vm0-ai/vm0/compare/app-v0.153.0...app-v0.153.1) (2026-03-26)


### Bug Fixes

* **platform:** always redirect to org selection when no active org ([#6880](https://github.com/vm0-ai/vm0/issues/6880)) ([d817f51](https://github.com/vm0-ai/vm0/commit/d817f51ba98b123926e7144a470b25ce557f8c04))

## [0.153.0](https://github.com/vm0-ai/vm0/compare/app-v0.152.4...app-v0.153.0) (2026-03-26)


### Features

* **platform:** add dedicated /ideas route for ideas & use cases page ([#6829](https://github.com/vm0-ai/vm0/issues/6829)) ([32e85e2](https://github.com/vm0-ai/vm0/commit/32e85e2862e434017446994f038efa64a1db62f8))
* **slack:** add schedule attribution footer to slack notifications ([#6865](https://github.com/vm0-ai/vm0/issues/6865)) ([bafe721](https://github.com/vm0-ai/vm0/commit/bafe721ce2c28b79c3169db212339755830cd460))


### Bug Fixes

* persist chat summaries with structured metadata for consistent display ([#6845](https://github.com/vm0-ai/vm0/issues/6845)) ([958b9f2](https://github.com/vm0-ai/vm0/commit/958b9f228420beb3a9576785b42ae45f3bac121e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.115.2

## [0.152.4](https://github.com/vm0-ai/vm0/compare/app-v0.152.3...app-v0.152.4) (2026-03-26)


### Bug Fixes

* **platform:** use stable signal for onboarding intro message ([#6864](https://github.com/vm0-ai/vm0/issues/6864)) ([a44dfd5](https://github.com/vm0-ai/vm0/commit/a44dfd51f04b3dc5bb62de294dfdd95c082bc055))
* preserve child content when rendering unknown html-like tags in markdown ([#6831](https://github.com/vm0-ai/vm0/issues/6831)) ([7399957](https://github.com/vm0-ai/vm0/commit/7399957b4410d515c706de63140519f967cc0296))


### Refactoring

* introduce firewall connector type and simplify firewall api ([#6863](https://github.com/vm0-ai/vm0/issues/6863)) ([cef659e](https://github.com/vm0-ai/vm0/commit/cef659ec12d0c6fb54d7a42a3a90a2f67dadb74a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.115.1

## [0.152.3](https://github.com/vm0-ai/vm0/compare/app-v0.152.2...app-v0.152.3) (2026-03-26)


### Bug Fixes

* add z-index to sticky chat composer to prevent content overlap ([#6823](https://github.com/vm0-ai/vm0/issues/6823)) ([e9efe07](https://github.com/vm0-ai/vm0/commit/e9efe07b1f39ce5ef386f1beb3d77ceb8f8047af)), closes [#6219](https://github.com/vm0-ai/vm0/issues/6219)


### Refactoring

* merge jira and confluence firewalls into single atlassian firewall ([#6854](https://github.com/vm0-ai/vm0/issues/6854)) ([8752fe8](https://github.com/vm0-ai/vm0/commit/8752fe86fd5d5f59ab16b38373513b021a242b7e))
* **platform:** resolve schedule agent label from server-side display name ([#6835](https://github.com/vm0-ai/vm0/issues/6835)) ([5b53481](https://github.com/vm0-ai/vm0/commit/5b534813d87103fe423ad9aef43cf32b84536f2e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.115.0

## [0.152.2](https://github.com/vm0-ai/vm0/compare/app-v0.152.1...app-v0.152.2) (2026-03-26)


### Refactoring

* **billing:** derive auto-recharge form state from server data ([#6809](https://github.com/vm0-ai/vm0/issues/6809)) ([419a39d](https://github.com/vm0-ai/vm0/commit/419a39d4b9e99a97515ecf515cb02dcd6e1fdc14))

## [0.152.1](https://github.com/vm0-ai/vm0/compare/app-v0.152.0...app-v0.152.1) (2026-03-25)


### Refactoring

* enable command-async-signal and no-getter-setter-params eslint rules ([#6727](https://github.com/vm0-ai/vm0/issues/6727)) ([2ae2123](https://github.com/vm0-ai/vm0/commit/2ae212386efd858002c6e0949c99b73b6f42c6d5))

## [0.152.0](https://github.com/vm0-ai/vm0/compare/app-v0.151.0...app-v0.152.0) (2026-03-25)


### Features

* **billing:** redesign workspace settings, remove pricing gate, integrate PR [#6551](https://github.com/vm0-ai/vm0/issues/6551) ([#6760](https://github.com/vm0-ai/vm0/issues/6760)) ([e89a9f0](https://github.com/vm0-ai/vm0/commit/e89a9f0a05e4ef02e6e40dfd77c795e6b1fe7c61))


### Bug Fixes

* **billing:** add error toast to inline cap input, replace type assertions with narrowing ([#6790](https://github.com/vm0-ai/vm0/issues/6790)) ([438c602](https://github.com/vm0-ai/vm0/commit/438c602a3a8694e4c0d0d4e6f0900a1460dcde1e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.114.0

## [0.151.0](https://github.com/vm0-ai/vm0/compare/app-v0.150.1...app-v0.151.0) (2026-03-25)


### Features

* make agent list items clickable to chat and fix unpinned agent opacity ([#6768](https://github.com/vm0-ai/vm0/issues/6768)) ([16b71a3](https://github.com/vm0-ai/vm0/commit/16b71a30c6a61c745d03b7692f2707cf0d48acb6))


### Bug Fixes

* **platform:** initialize sentry synchronously to capture bootstrap errors ([#6779](https://github.com/vm0-ai/vm0/issues/6779)) ([42b4f0f](https://github.com/vm0-ai/vm0/commit/42b4f0f39a5c201a30b1bd65a49550265499b038))
* **platform:** use flex layout for org dialog and fix logo load for non-admin members ([#6771](https://github.com/vm0-ai/vm0/issues/6771)) ([85e32a5](https://github.com/vm0-ai/vm0/commit/85e32a5755f087eab851a32704908849ffb17fe0))


### Refactoring

* **platform:** align agents list with team compose item type ([#6780](https://github.com/vm0-ai/vm0/issues/6780)) ([cd08650](https://github.com/vm0-ai/vm0/commit/cd086508d1a5c7782f2355454e9ed4f489be7f66))

## [0.150.1](https://github.com/vm0-ai/vm0/compare/app-v0.150.0...app-v0.150.1) (2026-03-25)


### Refactoring

* disambiguate agent name semantics across frontend and backend ([#6743](https://github.com/vm0-ai/vm0/issues/6743)) ([7998f02](https://github.com/vm0-ai/vm0/commit/7998f020c40dee64c6ebf2f67eacbfe77f4121fb)), closes [#6733](https://github.com/vm0-ai/vm0/issues/6733)

## [0.150.0](https://github.com/vm0-ai/vm0/compare/app-v0.149.0...app-v0.150.0) (2026-03-25)


### Features

* add create teammate card in team empty state ([#6736](https://github.com/vm0-ai/vm0/issues/6736)) ([c64f2b8](https://github.com/vm0-ai/vm0/commit/c64f2b88474d2e516334b510d1ef3f8a2a16921e))
* add loading states and save indicators to org billing tabs ([#6729](https://github.com/vm0-ai/vm0/issues/6729)) ([6be932f](https://github.com/vm0-ai/vm0/commit/6be932f64a0527f968578476f61ae1eed243b05d))
* **schedule:** simplify create dialog, navigate to detail, add run history tab ([#6715](https://github.com/vm0-ai/vm0/issues/6715)) ([2275f60](https://github.com/vm0-ai/vm0/commit/2275f6042e99ea04f8ffdb9d376153a0c993e603))


### Bug Fixes

* **platform:** hide add/remove connector actions for members on default agent ([#6753](https://github.com/vm0-ai/vm0/issues/6753)) ([ffff043](https://github.com/vm0-ai/vm0/commit/ffff04346f26467f233bcd89b68914ca828bad86))


### Refactoring

* migrate platform signals from raw fetch to typed zero client ([#6677](https://github.com/vm0-ai/vm0/issues/6677)) ([68d7cda](https://github.com/vm0-ai/vm0/commit/68d7cda17f9276412e7121af1ed3bf9a9aef89d5))
* **web:** return flat array from team api endpoint ([#6730](https://github.com/vm0-ai/vm0/issues/6730)) ([2b6ccae](https://github.com/vm0-ai/vm0/commit/2b6ccae92de330f25e0612ecdffc66ccc85b2689))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.113.0

## [0.149.0](https://github.com/vm0-ai/vm0/compare/app-v0.148.1...app-v0.149.0) (2026-03-25)


### Features

* connect org management dialog billing tabs to real data ([#6692](https://github.com/vm0-ai/vm0/issues/6692)) ([00f8209](https://github.com/vm0-ai/vm0/commit/00f82091196d280878c632f895acc37457c6493c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.112.0

## [0.148.1](https://github.com/vm0-ai/vm0/compare/app-v0.148.0...app-v0.148.1) (2026-03-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.111.1

## [0.148.0](https://github.com/vm0-ai/vm0/compare/app-v0.147.0...app-v0.148.0) (2026-03-25)


### Features

* replace agent avatars with new illustrations and ui polish ([#6606](https://github.com/vm0-ai/vm0/issues/6606)) ([ccf26ac](https://github.com/vm0-ai/vm0/commit/ccf26ac0d9b9045d247121f62b6211a36a826040))


### Refactoring

* remove global notification preferences ([#6548](https://github.com/vm0-ai/vm0/issues/6548)) ([1d500cd](https://github.com/vm0-ai/vm0/commit/1d500cdf0d0571c8a92d22b5cd8fdf27f44c649e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.111.0

## [0.147.0](https://github.com/vm0-ai/vm0/compare/app-v0.146.4...app-v0.147.0) (2026-03-25)


### Features

* add slug editing to org settings dialog ([#6617](https://github.com/vm0-ai/vm0/issues/6617)) ([daf8229](https://github.com/vm0-ai/vm0/commit/daf82295869ddd7fffcfab337a832052e900698f))
* **platform:** zero schedule detail route and schedule list UX ([#6155](https://github.com/vm0-ai/vm0/issues/6155)) ([3a1a466](https://github.com/vm0-ai/vm0/commit/3a1a466d4619865a99ad0144608e88bcb50a121f))


### Refactoring

* rename "Zero's team" to "Agents" in sidebar and team pages ([#6622](https://github.com/vm0-ai/vm0/issues/6622)) ([36e7869](https://github.com/vm0-ai/vm0/commit/36e7869e7fa2a13ad1368ea39e329a21c966d6ae))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.110.0

## [0.146.4](https://github.com/vm0-ai/vm0/compare/app-v0.146.3...app-v0.146.4) (2026-03-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.109.0

## [0.146.3](https://github.com/vm0-ai/vm0/compare/app-v0.146.2...app-v0.146.3) (2026-03-24)


### Performance Improvements

* add inline skeleton shell to index.html for faster fcp ([#6526](https://github.com/vm0-ai/vm0/issues/6526)) ([02e4539](https://github.com/vm0-ai/vm0/commit/02e453969851516145dd8621ec99423ccb8652e2)), closes [#6484](https://github.com/vm0-ai/vm0/issues/6484)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.108.0

## [0.146.2](https://github.com/vm0-ai/vm0/compare/app-v0.146.1...app-v0.146.2) (2026-03-24)


### Refactoring

* delete stale msw mock handlers for /api/secrets and /api/variables ([#6518](https://github.com/vm0-ai/vm0/issues/6518)) ([386566f](https://github.com/vm0-ai/vm0/commit/386566f4f91064409f68d3817fa905d636cd30e9)), closes [#6515](https://github.com/vm0-ai/vm0/issues/6515)
* unify agent identity fields across all zero api endpoints ([#6302](https://github.com/vm0-ai/vm0/issues/6302)) ([83a0e5d](https://github.com/vm0-ai/vm0/commit/83a0e5d5b5981b709b1dd8e8e318946b6330d2c7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.107.0

## [0.146.1](https://github.com/vm0-ai/vm0/compare/app-v0.146.0...app-v0.146.1) (2026-03-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.106.0

## [0.146.0](https://github.com/vm0-ai/vm0/compare/app-v0.145.1...app-v0.146.0) (2026-03-24)


### Features

* add slack channel selection for schedule notifications ([#6156](https://github.com/vm0-ai/vm0/issues/6156)) ([059f723](https://github.com/vm0-ai/vm0/commit/059f72309f67fe99bb1259ded54c56c2da33df2d))


### Bug Fixes

* confirm dialogs close only after async operation completes ([#6305](https://github.com/vm0-ai/vm0/issues/6305)) ([dd7cbf9](https://github.com/vm0-ai/vm0/commit/dd7cbf9bdceaab1dc7489e88f8c05bbc0d5af0ac))


### Refactoring

* move unused ref callbacks into signal layer ([#6450](https://github.com/vm0-ai/vm0/issues/6450)) ([50661d9](https://github.com/vm0-ai/vm0/commit/50661d9022b3a4e18fca376afb7967f010a05a84))
* redesign chat send/poll flow with promise-signal architecture ([#6466](https://github.com/vm0-ai/vm0/issues/6466)) ([30ff5c3](https://github.com/vm0-ai/vm0/commit/30ff5c3d5cf815c9d57a06a6f566d8c2eca36a6d)), closes [#6432](https://github.com/vm0-ai/vm0/issues/6432)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.105.0

## [0.145.1](https://github.com/vm0-ai/vm0/compare/app-v0.145.0...app-v0.145.1) (2026-03-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.104.0

## [0.145.0](https://github.com/vm0-ai/vm0/compare/app-v0.144.0...app-v0.145.0) (2026-03-24)


### Features

* add static skeleton background behind onboarding modal ([#6261](https://github.com/vm0-ai/vm0/issues/6261)) ([755aa23](https://github.com/vm0-ai/vm0/commit/755aa234b46997154197c76f8d7a73586e2f6287)), closes [#6245](https://github.com/vm0-ai/vm0/issues/6245)


### Bug Fixes

* **platform:** preserve schedule timezone when editing ([#6188](https://github.com/vm0-ai/vm0/issues/6188)) ([809292c](https://github.com/vm0-ai/vm0/commit/809292ce6db0a9a443a28d76b01f7ecbc7f83fb2))


### Refactoring

* **db:** rename zeroAgentId to agentId across codebase ([#6272](https://github.com/vm0-ai/vm0/issues/6272)) ([4d3b01d](https://github.com/vm0-ai/vm0/commit/4d3b01de976b2a200117f3b0deed8bb841f24a62))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.103.0

## [0.144.0](https://github.com/vm0-ai/vm0/compare/app-v0.143.1...app-v0.144.0) (2026-03-24)


### Features

* confirm before closing schedule dialog with unsaved edits ([#6154](https://github.com/vm0-ai/vm0/issues/6154)) ([4fdd25b](https://github.com/vm0-ai/vm0/commit/4fdd25bd1f8759db89dc137e01016475958e6318))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.102.0

## [0.143.1](https://github.com/vm0-ai/vm0/compare/app-v0.143.0...app-v0.143.1) (2026-03-24)


### Refactoring

* extract duplicated onboard guard into shared command ([#6284](https://github.com/vm0-ai/vm0/issues/6284)) ([b57b367](https://github.com/vm0-ai/vm0/commit/b57b3671dddab3d01afea9b3f36f9933d2f56403))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.101.0

## [0.143.0](https://github.com/vm0-ai/vm0/compare/app-v0.142.1...app-v0.143.0) (2026-03-24)


### Features

* **platform:** firewall permissions drawer with persistent policies ([#5467](https://github.com/vm0-ai/vm0/issues/5467)) ([829485f](https://github.com/vm0-ai/vm0/commit/829485f8222f732217e68daae10fe0d56567cc81))
* remove feature switches from all google connectors for general availability ([#6253](https://github.com/vm0-ai/vm0/issues/6253)) ([666766c](https://github.com/vm0-ai/vm0/commit/666766cd2360f0a6ff84e6c39fb179ac2194496d))


### Bug Fixes

* migrate platform schedule frontend from composeId to zeroAgentId ([#6262](https://github.com/vm0-ai/vm0/issues/6262)) ([73bc132](https://github.com/vm0-ai/vm0/commit/73bc13232badb4dc347f3167bcf461c61953451b))
* new chat button should create session and navigate to thread page ([#6263](https://github.com/vm0-ai/vm0/issues/6263)) ([06a3332](https://github.com/vm0-ai/vm0/commit/06a3332e112f5c2c2672007661c30c3441407d53))
* pass schedule description through agent detail data flow ([#6258](https://github.com/vm0-ai/vm0/issues/6258)) ([7cb4ceb](https://github.com/vm0-ai/vm0/commit/7cb4cebcab3ec6a9b28968277c4e90638093ad65))
* **platform:** simplify job detail skeleton condition to avoid stale loading state ([#6193](https://github.com/vm0-ai/vm0/issues/6193)) ([5d3f2ac](https://github.com/vm0-ai/vm0/commit/5d3f2ac73e6d05fdcf7caafe299252e176fd0348))
* use cell-scoped popover ids to prevent duplicate schedule entry conflicts ([#6194](https://github.com/vm0-ai/vm0/issues/6194)) ([365aaa5](https://github.com/vm0-ai/vm0/commit/365aaa5742e4a181b27b33588ac178214571d2c2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.100.0

## [0.142.1](https://github.com/vm0-ai/vm0/compare/app-v0.142.0...app-v0.142.1) (2026-03-24)


### Bug Fixes

* navigate to chat session from /talk route after sending message ([#6223](https://github.com/vm0-ai/vm0/issues/6223)) ([aece5d2](https://github.com/vm0-ai/vm0/commit/aece5d2ee9c73692991cd43f07df78293f63eeb1))

## [0.142.0](https://github.com/vm0-ai/vm0/compare/app-v0.141.1...app-v0.142.0) (2026-03-23)


### Features

* **platform:** polish zero sidebar and talk-to dialog ([#6222](https://github.com/vm0-ai/vm0/issues/6222)) ([d74347f](https://github.com/vm0-ai/vm0/commit/d74347f6444259f782a4a39d209a437489b7e8c0))
* replace reddit brand monitor example with x (twitter) ([#6221](https://github.com/vm0-ai/vm0/issues/6221)) ([08df896](https://github.com/vm0-ai/vm0/commit/08df896ed1a9b0bb4c517fbe070fec6b6fdca33d)), closes [#6214](https://github.com/vm0-ai/vm0/issues/6214)
* **zero:** merge connector icon dark mode and sizing to main ([#6224](https://github.com/vm0-ai/vm0/issues/6224)) ([056ff0c](https://github.com/vm0-ai/vm0/commit/056ff0c40d001fe07eb71c1fef6bde6a7aa72ebc))


### Bug Fixes

* **platform:** remove skills$ from composer, use CONNECTOR_TYPES labels only ([#6230](https://github.com/vm0-ai/vm0/issues/6230)) ([173e366](https://github.com/vm0-ai/vm0/commit/173e366a65f1026ee216ea9613a809ba06fe4d64))


### Refactoring

* eliminate zero app shell, add /onboarding route ([#6237](https://github.com/vm0-ai/vm0/issues/6237)) ([d4b965e](https://github.com/vm0-ai/vm0/commit/d4b965eefdde3716efa06f6e89d2b17089e4c3be))


### Performance Improvements

* convert no-permission-illustration to webp and add lazy loading ([#6225](https://github.com/vm0-ai/vm0/issues/6225)) ([a6dc0c1](https://github.com/vm0-ai/vm0/commit/a6dc0c19547535b58b83d64a0e92ecc491546c93)), closes [#6089](https://github.com/vm0-ai/vm0/issues/6089)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.99.0

## [0.141.1](https://github.com/vm0-ai/vm0/compare/app-v0.141.0...app-v0.141.1) (2026-03-23)


### Refactoring

* **platform:** eliminate broken pathname-only navigation ([#6185](https://github.com/vm0-ai/vm0/issues/6185)) ([487f35e](https://github.com/vm0-ai/vm0/commit/487f35efef71c5d40f7a7cd6357452bb343da1a8))
* separate connectors from seed skills in zero agent API ([#6204](https://github.com/vm0-ai/vm0/issues/6204)) ([c7fd608](https://github.com/vm0-ai/vm0/commit/c7fd608cc73b9ae95725bc4828440b38d700f67c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.98.1

## [0.141.0](https://github.com/vm0-ai/vm0/compare/app-v0.140.0...app-v0.141.0) (2026-03-23)


### Features

* add stripe webhook forwarding to dev environment ([#6161](https://github.com/vm0-ai/vm0/issues/6161)) ([8bb7223](https://github.com/vm0-ai/vm0/commit/8bb7223b420b7ebb946054e7f714d09d45233a27))
* **platform:** set document.title for every route ([#6164](https://github.com/vm0-ai/vm0/issues/6164)) ([a64f6ec](https://github.com/vm0-ai/vm0/commit/a64f6ec4b2ee155d7ceb15dcc052882d631c56e9))


### CI

* upgrade deploy-web job to ubuntu-8core runner ([#6122](https://github.com/vm0-ai/vm0/issues/6122)) ([eba7167](https://github.com/vm0-ai/vm0/commit/eba7167567cbce76db7b0878d863e89784fe3191))


### Refactoring

* downgrade zerochat thread-loading logs from info to debug ([#6179](https://github.com/vm0-ai/vm0/issues/6179)) ([bd63c88](https://github.com/vm0-ai/vm0/commit/bd63c8861a52a7520a267bece88df4cb67b5bfcf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.98.0

## [0.140.0](https://github.com/vm0-ai/vm0/compare/app-v0.139.0...app-v0.140.0) (2026-03-23)


### Features

* **platform:** add delete confirmation dialog for schedules ([#6130](https://github.com/vm0-ai/vm0/issues/6130)) ([4f76e6f](https://github.com/vm0-ai/vm0/commit/4f76e6f1ae36fd22916650e076f8e2d7530da4de))


### Bug Fixes

* **platform:** refresh activity list and show skeleton on navigation ([#6142](https://github.com/vm0-ai/vm0/issues/6142)) ([0ddc2ff](https://github.com/vm0-ai/vm0/commit/0ddc2ffc4c3b9a4ea41c453d9c95285db6924183))


### Refactoring

* migrate remaining non-zero api calls to /api/zero/ and add lint rule ([#6116](https://github.com/vm0-ai/vm0/issues/6116)) ([853e76a](https://github.com/vm0-ai/vm0/commit/853e76ac623682e91e31b5a9e87338fb3875cc0c))


### Performance Improvements

* add skeleton ui during bootstrap to fix fcp and cls ([#6088](https://github.com/vm0-ai/vm0/issues/6088)) ([#6145](https://github.com/vm0-ai/vm0/issues/6145)) ([02fbcf1](https://github.com/vm0-ai/vm0/commit/02fbcf18e6df12c1d44b4fc9a4cd7b199ea1d896))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.97.0


## [0.139.0](https://github.com/vm0-ai/vm0/compare/app-v0.138.0...app-v0.139.0) (2026-03-23)


### Features

* add description field to schedule with auto-generation fallback ([#6113](https://github.com/vm0-ai/vm0/issues/6113)) ([699c2ac](https://github.com/vm0-ai/vm0/commit/699c2acc587f3a118c49d3c2943090c1c923eab7))
* **platform:** unify zero access-denied states with lock illustration ([#5962](https://github.com/vm0-ai/vm0/issues/5962)) ([a039707](https://github.com/vm0-ai/vm0/commit/a0397071dbb25bf1ec721d59d43ad810882335f3))
* **platform:** zero chat ux improvements ([#6067](https://github.com/vm0-ai/vm0/issues/6067)) ([8f1b188](https://github.com/vm0-ai/vm0/commit/8f1b188ffb795440858dc16b6f45a23d4ae55c40))


### Performance Improvements

* **platform:** convert zero-page images from png to webp ([#6105](https://github.com/vm0-ai/vm0/issues/6105)) ([d7d93af](https://github.com/vm0-ai/vm0/commit/d7d93af32b1a544630c144ed069e7b8efeb3ff03))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.96.0

## [0.138.0](https://github.com/vm0-ai/vm0/compare/app-v0.137.0...app-v0.138.0) (2026-03-23)


### Features

* add trigger source filter to activity page ([#6091](https://github.com/vm0-ai/vm0/issues/6091)) ([89013bb](https://github.com/vm0-ai/vm0/commit/89013bb68137e74f355f7f6330cc17c394990c26))
* update plan credits and pricing (free 10k, pro $40/20k, team $200/120k) ([#6075](https://github.com/vm0-ai/vm0/issues/6075)) ([7898caa](https://github.com/vm0-ai/vm0/commit/7898caa94a65ea855375fb9c6aae07207906429b))


### Performance Improvements

* dynamically import @clerk/clerk-js to reduce initial bundle ([#6102](https://github.com/vm0-ai/vm0/issues/6102)) ([a91c1f0](https://github.com/vm0-ai/vm0/commit/a91c1f0e9b96a64ec864c3676624469647cf717a)), closes [#6087](https://github.com/vm0-ai/vm0/issues/6087)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.95.0

## [0.137.0](https://github.com/vm0-ai/vm0/compare/app-v0.136.0...app-v0.137.0) (2026-03-23)


### Features

* auto-generate chat thread titles via lightweight model ([#6063](https://github.com/vm0-ai/vm0/issues/6063)) ([86f3bfb](https://github.com/vm0-ai/vm0/commit/86f3bfb82258ebe9cc8740e58755e03bf6d6eebb))


### Refactoring

* generalize slack file handling to support all file types ([#6093](https://github.com/vm0-ai/vm0/issues/6093)) ([a44492d](https://github.com/vm0-ai/vm0/commit/a44492dd0364d902e7b47ad7b2600d39dc463139))
* remove settings menu item and /settings route ([#6095](https://github.com/vm0-ai/vm0/issues/6095)) ([b65e940](https://github.com/vm0-ai/vm0/commit/b65e9405c30aafd9698483d82caa9c41a6674444))
* remove wildcard routes and migrate / to dedicated setup ([#6069](https://github.com/vm0-ai/vm0/issues/6069)) ([81a31fb](https://github.com/vm0-ai/vm0/commit/81a31fb5bbd3008f91d411141f1db240f8111dbf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.94.0

## [0.136.0](https://github.com/vm0-ai/vm0/compare/app-v0.135.0...app-v0.136.0) (2026-03-23)


### Features

* add usage page showing per-member token consumption in billing period ([#6019](https://github.com/vm0-ai/vm0/issues/6019)) ([b88b6b3](https://github.com/vm0-ai/vm0/commit/b88b6b33276c7551203f6ef91318439fb94cfcb5))
* allow canceling attachment upload before it completes ([#6062](https://github.com/vm0-ai/vm0/issues/6062)) ([ff07c2c](https://github.com/vm0-ai/vm0/commit/ff07c2cbade3030f8d481449814991afe172a39e))
* create zero-run-service to unify all zero trigger paths ([#6028](https://github.com/vm0-ai/vm0/issues/6028)) ([97f1854](https://github.com/vm0-ai/vm0/commit/97f1854c2b3458642022cb6430cf33b4db953b07))
* handle no-model-provider error with dedicated deep link ([#6030](https://github.com/vm0-ai/vm0/issues/6030)) ([0707acd](https://github.com/vm0-ai/vm0/commit/0707acd4a384e0864aa947d432589b32123eef83))
* improve chat input ux when agent is processing ([#6011](https://github.com/vm0-ai/vm0/issues/6011)) ([eff88d3](https://github.com/vm0-ai/vm0/commit/eff88d39d68de352e3908b7e32e73e1893755933))
* increase default starter credits from 2000 to 10000 ([#6055](https://github.com/vm0-ai/vm0/issues/6055)) ([c16b93e](https://github.com/vm0-ai/vm0/commit/c16b93e63937b899234f6b38d7591fe85e3d2a28)), closes [#6049](https://github.com/vm0-ai/vm0/issues/6049)
* **platform:** add ideation page with categorized use case gallery ([#5960](https://github.com/vm0-ai/vm0/issues/5960)) ([baa34a4](https://github.com/vm0-ai/vm0/commit/baa34a4083c58dcdf7ccfed30f323c460891b4d1))


### Bug Fixes

* prevent send mode settings flash by moving optimistic state to signals layer ([#6015](https://github.com/vm0-ai/vm0/issues/6015)) ([b22faa2](https://github.com/vm0-ai/vm0/commit/b22faa2c33aa8fc4caef21b7f304519c4a065f17))
* show skeleton instead of send-message flash on chat page refresh ([#6018](https://github.com/vm0-ai/vm0/issues/6018)) ([0a61e05](https://github.com/vm0-ai/vm0/commit/0a61e05aba038d06379844df1f5582372df9053e))


### Refactoring

* migrate / (chat root) route to dedicated setup function ([#6058](https://github.com/vm0-ai/vm0/issues/6058)) ([ecee98d](https://github.com/vm0-ai/vm0/commit/ecee98d785ae1372ac4faa9dc4a8ab910cf9d43c))
* migrate chat session route to dedicated setup function ([#6009](https://github.com/vm0-ai/vm0/issues/6009)) ([2cfd876](https://github.com/vm0-ai/vm0/commit/2cfd8762dd00bb2e3b24208d0f3f5bd1e38fc724))
* remove ccstate-react/experimental from zero-chat-page.tsx ([#6038](https://github.com/vm0-ai/vm0/issues/6038)) ([0b5a9d1](https://github.com/vm0-ai/vm0/commit/0b5a9d11760aa8c76ee18e51ff518393b9639cff)), closes [#5797](https://github.com/vm0-ai/vm0/issues/5797)
* remove ccstate-react/experimental from zero-schedule-card ([#6041](https://github.com/vm0-ai/vm0/issues/6041)) ([739b04b](https://github.com/vm0-ai/vm0/commit/739b04bcd61f45ff0ce2bcaf7796b1fbab6fd179)), closes [#5812](https://github.com/vm0-ai/vm0/issues/5812)
* remove ccstate-react/experimental from zero-schedule-page ([#6039](https://github.com/vm0-ai/vm0/issues/6039)) ([ef82674](https://github.com/vm0-ai/vm0/commit/ef82674aa4f8b2a61de0b6ac75f13be5ff991a33)), closes [#5810](https://github.com/vm0-ai/vm0/issues/5810)
* remove ccstate-react/experimental from zero-session-chat-page ([#6040](https://github.com/vm0-ai/vm0/issues/6040)) ([4bace52](https://github.com/vm0-ai/vm0/commit/4bace52fab384234c64db3c621f35c08f439111f))
* remove ccstate-react/experimental from zero-settings-tab ([#6035](https://github.com/vm0-ai/vm0/issues/6035)) ([2ceb506](https://github.com/vm0-ai/vm0/commit/2ceb506abe285de54683e19f52fff8a2e2a775ae))
* remove vm0 model provider feature switch and auto-init during onboarding ([#6042](https://github.com/vm0-ai/vm0/issues/6042)) ([37dfd70](https://github.com/vm0-ai/vm0/commit/37dfd707b1c92def0237641293ee782843fc8bd8)), closes [#6033](https://github.com/vm0-ai/vm0/issues/6033)
* rename organization tier 'max' to 'team' ([#6043](https://github.com/vm0-ai/vm0/issues/6043)) ([9727f5a](https://github.com/vm0-ai/vm0/commit/9727f5aee40559e7a2cc65db91c10c7f96e22556))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.93.0

## [0.135.0](https://github.com/vm0-ai/vm0/compare/app-v0.134.2...app-v0.135.0) (2026-03-23)


### Features

* **platform:** add org management dialog with billing, members, and invoices tabs ([#5605](https://github.com/vm0-ai/vm0/issues/5605)) ([a7b3e28](https://github.com/vm0-ai/vm0/commit/a7b3e28c9bd1dbc61d79ee0d8d1155faea14915c))


### Bug Fixes

* **platform:** onboarding chat redirect and disable duplicate clicks ([#6005](https://github.com/vm0-ai/vm0/issues/6005)) ([5b800a5](https://github.com/vm0-ai/vm0/commit/5b800a518261754b10cb494fc2441ed8038c8d19))
* prevent stale activity detail from flashing during navigation ([#6008](https://github.com/vm0-ai/vm0/issues/6008)) ([a639b8d](https://github.com/vm0-ai/vm0/commit/a639b8de402e6765f3afd4fae88e5fc85c44afd8))


### Refactoring

* migrate /talk/:name route to dedicated setup function ([#6007](https://github.com/vm0-ai/vm0/issues/6007)) ([5710366](https://github.com/vm0-ai/vm0/commit/5710366a15bbcb1d11dc00f218aeda97d9781269))
* remove ccstate-react/experimental from scope-review-modal ([#6021](https://github.com/vm0-ai/vm0/issues/6021)) ([e623d25](https://github.com/vm0-ai/vm0/commit/e623d25d7a3c311f5b2f8722027c2e70ec067c9e)), closes [#5804](https://github.com/vm0-ai/vm0/issues/5804)
* standardize project artifacts to english ([#6000](https://github.com/vm0-ai/vm0/issues/6000)) ([eccdaec](https://github.com/vm0-ai/vm0/commit/eccdaece6826b5e6edae7575b74771eda25643cd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.92.0

## [0.134.2](https://github.com/vm0-ai/vm0/compare/app-v0.134.1...app-v0.134.2) (2026-03-22)


### Refactoring

* rename skill to connector in platform ui ([#5995](https://github.com/vm0-ai/vm0/issues/5995)) ([e9a0f40](https://github.com/vm0-ai/vm0/commit/e9a0f40c98726c7b0df5bcf7a6781d9cf454717d)), closes [#5991](https://github.com/vm0-ai/vm0/issues/5991)

## [0.134.1](https://github.com/vm0-ai/vm0/compare/app-v0.134.0...app-v0.134.1) (2026-03-22)


### Refactoring

* make plausible analytics config environment-driven ([#5985](https://github.com/vm0-ai/vm0/issues/5985)) ([7ec3011](https://github.com/vm0-ai/vm0/commit/7ec3011f04eb0ae66e328012fdd2a28af8ebe01d))

## [0.134.0](https://github.com/vm0-ai/vm0/compare/app-v0.133.3...app-v0.134.0) (2026-03-22)


### Features

* structured error codes for pre-run checks with client-side guidance ([#5936](https://github.com/vm0-ai/vm0/issues/5936)) ([c6c0dda](https://github.com/vm0-ai/vm0/commit/c6c0ddaebfc7b0b2fc188a537e16d45fa7a65c02))


### Bug Fixes

* add works path to route type union for type safety ([#5950](https://github.com/vm0-ai/vm0/issues/5950)) ([3f5d4e8](https://github.com/vm0-ai/vm0/commit/3f5d4e8bca637e1c7cde95fd5ed8710bae1b8489))


### Refactoring

* cleanup stale references after activity/team route migration ([#5922](https://github.com/vm0-ai/vm0/issues/5922)) ([4c0894f](https://github.com/vm0-ai/vm0/commit/4c0894f17692085d47a6cb8464f8f9382a9ab110)), closes [#5921](https://github.com/vm0-ai/vm0/issues/5921)
* extract lightbox state from view components into shared signal ([#5928](https://github.com/vm0-ai/vm0/issues/5928)) ([eebc5d3](https://github.com/vm0-ai/vm0/commit/eebc5d3b8c0a6995fbd62491ffb122c5f9b83b73))
* migrate /preferences route to dedicated setup function ([#5946](https://github.com/vm0-ai/vm0/issues/5946)) ([2e380e7](https://github.com/vm0-ai/vm0/commit/2e380e71095cc17fae56a585013ebc434e8f1229)), closes [#5843](https://github.com/vm0-ai/vm0/issues/5843)
* migrate /schedule route to dedicated setup function ([#5951](https://github.com/vm0-ai/vm0/issues/5951)) ([180b0b8](https://github.com/vm0-ai/vm0/commit/180b0b8d0ad06204308ac70ffd80bb6e18bc45bf)), closes [#5841](https://github.com/vm0-ai/vm0/issues/5841)
* migrate /settings route to dedicated setup function ([#5842](https://github.com/vm0-ai/vm0/issues/5842)) ([#5952](https://github.com/vm0-ai/vm0/issues/5952)) ([dada26b](https://github.com/vm0-ai/vm0/commit/dada26ba26f79012680f708b1b839164ecd2eed5))
* migrate /works route to dedicated setup function ([#5948](https://github.com/vm0-ai/vm0/issues/5948)) ([01d3f61](https://github.com/vm0-ai/vm0/commit/01d3f61e2432f2e288af7980c8ea3957fe448b4d)), closes [#5844](https://github.com/vm0-ai/vm0/issues/5844)
* move scope review type state from view to signals layer ([#5941](https://github.com/vm0-ai/vm0/issues/5941)) ([a28042c](https://github.com/vm0-ai/vm0/commit/a28042cfd39e408c78ef635867c618ebb04abb34)), closes [#5815](https://github.com/vm0-ai/vm0/issues/5815)
* remove ccstate-react/experimental from add-connection-dialog ([#5943](https://github.com/vm0-ai/vm0/issues/5943)) ([2c16bc4](https://github.com/vm0-ai/vm0/commit/2c16bc460bc40e8e7cb6610e2b64efd32500dfdc)), closes [#5821](https://github.com/vm0-ai/vm0/issues/5821)
* remove ccstate-react/experimental from notification-settings ([#5938](https://github.com/vm0-ai/vm0/issues/5938)) ([4bb7d35](https://github.com/vm0-ai/vm0/commit/4bb7d35b2bb15eeb6e86b572bce8d743afc49f0c)), closes [#5819](https://github.com/vm0-ai/vm0/issues/5819)
* remove ccstate-react/experimental from timezone-settings ([#5945](https://github.com/vm0-ai/vm0/issues/5945)) ([39d63a6](https://github.com/vm0-ai/vm0/commit/39d63a6bdeed07bcbde6cd60dda907fc7da4d147))
* remove ccstate-react/experimental from use-file-upload-handlers ([#5923](https://github.com/vm0-ai/vm0/issues/5923)) ([bee3eb1](https://github.com/vm0-ai/vm0/commit/bee3eb1722e52012283b687b872a4a1e3faaa0a5)), closes [#5818](https://github.com/vm0-ai/vm0/issues/5818)
* remove ccstate-react/experimental from zero-account-page ([#5933](https://github.com/vm0-ai/vm0/issues/5933)) ([702a13d](https://github.com/vm0-ai/vm0/commit/702a13d7b64842a4a7488c9e1f352558d72e56e2)), closes [#5814](https://github.com/vm0-ai/vm0/issues/5814)
* remove ccstate-react/experimental from zero-chat-composer.tsx ([#5927](https://github.com/vm0-ai/vm0/issues/5927)) ([862b98e](https://github.com/vm0-ai/vm0/commit/862b98e3a711e718883e6313da2be43c32627198))
* remove ccstate-react/experimental from zero-job-detail-page ([#5944](https://github.com/vm0-ai/vm0/issues/5944)) ([8f5d1a3](https://github.com/vm0-ai/vm0/commit/8f5d1a3f2072231860d7862ef91176c66afdf256)), closes [#5813](https://github.com/vm0-ai/vm0/issues/5813)
* remove ccstate-react/experimental from zero-model-preference ([#5942](https://github.com/vm0-ai/vm0/issues/5942)) ([b27854c](https://github.com/vm0-ai/vm0/commit/b27854c47dad66b1b8f9bbed139d1a555d47828d))
* remove ccstate-react/experimental from zero-onboarding.tsx ([#5924](https://github.com/vm0-ai/vm0/issues/5924)) ([dbc99ed](https://github.com/vm0-ai/vm0/commit/dbc99ed46266aee83e9b5efd7e7a71f90680e67f)), closes [#5808](https://github.com/vm0-ai/vm0/issues/5808)
* remove ccstate-react/experimental from zero-schedule-tab.tsx ([#5934](https://github.com/vm0-ai/vm0/issues/5934)) ([ec37c57](https://github.com/vm0-ai/vm0/commit/ec37c5777821cbf0817656be78bf6cfbd74793fa)), closes [#5811](https://github.com/vm0-ai/vm0/issues/5811)
* remove ccstate-react/experimental from zero-send-key.ts ([#5937](https://github.com/vm0-ai/vm0/issues/5937)) ([88e6901](https://github.com/vm0-ai/vm0/commit/88e6901c11cf82089220bd583d67386846a758c0))
* remove ccstate-react/experimental from zero-sidebar.tsx ([#5806](https://github.com/vm0-ai/vm0/issues/5806)) ([#5939](https://github.com/vm0-ai/vm0/issues/5939)) ([3fa250d](https://github.com/vm0-ai/vm0/commit/3fa250d13dcf14fdea0be9a5ed581fd1b7b5e6d5))
* remove ccstate-react/experimental from zero-slack-connect-page ([#5803](https://github.com/vm0-ai/vm0/issues/5803)) ([#5935](https://github.com/vm0-ai/vm0/issues/5935)) ([0a6d043](https://github.com/vm0-ai/vm0/commit/0a6d0433924dce3b860adf55733e712e483071bb))
* remove ccstate-react/experimental from zero-works-page.tsx ([#5931](https://github.com/vm0-ai/vm0/issues/5931)) ([69dc26e](https://github.com/vm0-ai/vm0/commit/69dc26e7f26fe64bfcaaba37379a9eb8bfed44b5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.91.0

## [0.133.3](https://github.com/vm0-ai/vm0/compare/app-v0.133.2...app-v0.133.3) (2026-03-21)


### Bug Fixes

* resolve activity page overflow and add internal connector logos page ([#5912](https://github.com/vm0-ai/vm0/issues/5912)) ([bd9e1fd](https://github.com/vm0-ai/vm0/commit/bd9e1fdcc41f2d39ddd740bf319e3f692f99eb34))
* resolve sidebar chat navigation failing from /team page ([#5918](https://github.com/vm0-ai/vm0/issues/5918)) ([25763e7](https://github.com/vm0-ai/vm0/commit/25763e7ce577d42c40bb626edbce624832e4b249))

## [0.133.2](https://github.com/vm0-ai/vm0/compare/app-v0.133.1...app-v0.133.2) (2026-03-21)


### Refactoring

* unify onboarding connector selection to use connector data instead of skill data ([#5909](https://github.com/vm0-ai/vm0/issues/5909)) ([eccf2cf](https://github.com/vm0-ai/vm0/commit/eccf2cf37566457139289e5143094cf5da1d3180)), closes [#5907](https://github.com/vm0-ai/vm0/issues/5907)

## [0.133.1](https://github.com/vm0-ai/vm0/compare/app-v0.133.0...app-v0.133.1) (2026-03-21)


### Bug Fixes

* **platform:** add accessible name to connectors button in chat composer ([#5891](https://github.com/vm0-ai/vm0/issues/5891)) ([29b9db1](https://github.com/vm0-ai/vm0/commit/29b9db14e68fbd3c1111b7139f25f268b9442106)), closes [#5873](https://github.com/vm0-ai/vm0/issues/5873)
* **platform:** show 404 page for unknown routes instead of falling back to chat ([#5886](https://github.com/vm0-ai/vm0/issues/5886)) ([e40b76c](https://github.com/vm0-ai/vm0/commit/e40b76cf6e51efe71d4948dfafc49435bcfdbdec)), closes [#5869](https://github.com/vm0-ai/vm0/issues/5869)


### Refactoring

* extract activity list and detail pages into dedicated routes ([#5901](https://github.com/vm0-ai/vm0/issues/5901)) ([8a3b1d0](https://github.com/vm0-ai/vm0/commit/8a3b1d04844d536ee3ed385b8c9ff2cc259a6c13)), closes [#5895](https://github.com/vm0-ai/vm0/issues/5895) [#5857](https://github.com/vm0-ai/vm0/issues/5857) [#5847](https://github.com/vm0-ai/vm0/issues/5847)
* extract activity pages into dedicated routes ([#5900](https://github.com/vm0-ai/vm0/issues/5900)) ([b490ae2](https://github.com/vm0-ai/vm0/commit/b490ae25a368c05218e86ab59334c5489d70d4b2)), closes [#5895](https://github.com/vm0-ai/vm0/issues/5895) [#5857](https://github.com/vm0-ai/vm0/issues/5857) [#5847](https://github.com/vm0-ai/vm0/issues/5847)
* extract team list and detail pages into dedicated routes ([#5902](https://github.com/vm0-ai/vm0/issues/5902)) ([3721d09](https://github.com/vm0-ai/vm0/commit/3721d0921f0981436b28b3fcdba8ff5a6beb77a4))
* extract team pages from zero page into dedicated routes ([#5903](https://github.com/vm0-ai/vm0/issues/5903)) ([9790169](https://github.com/vm0-ai/vm0/commit/9790169e0c514263ae003041b09d213475f250bd)), closes [#5897](https://github.com/vm0-ai/vm0/issues/5897)

## [0.133.0](https://github.com/vm0-ai/vm0/compare/app-v0.132.3...app-v0.133.0) (2026-03-21)


### Features

* add pay-as-you-go auto-recharge for org credits ([#5834](https://github.com/vm0-ai/vm0/issues/5834)) ([66228b7](https://github.com/vm0-ai/vm0/commit/66228b7494af85d25a3dbe54210149de7964fb43))

## [0.132.3](https://github.com/vm0-ai/vm0/compare/app-v0.132.2...app-v0.132.3) (2026-03-21)


### Refactoring

* extract dedicated queue page setup signal ([#5835](https://github.com/vm0-ai/vm0/issues/5835)) ([f5ce515](https://github.com/vm0-ai/vm0/commit/f5ce51558a19e5887fad0219d147b2cf900d1cb8))

## [0.132.2](https://github.com/vm0-ai/vm0/compare/app-v0.132.1...app-v0.132.2) (2026-03-21)


### Refactoring

* remove ccstate-react/experimental from activity views ([#5824](https://github.com/vm0-ai/vm0/issues/5824)) ([7b30b37](https://github.com/vm0-ai/vm0/commit/7b30b37ed68032afd8ee55b550caf5b968875b00)), closes [#5805](https://github.com/vm0-ai/vm0/issues/5805)
* remove ccstate-react/experimental from zero-app-shell.tsx ([#5827](https://github.com/vm0-ai/vm0/issues/5827)) ([214b238](https://github.com/vm0-ai/vm0/commit/214b2382c95be21f7956c99f72b81d7fe7a803a8))

## [0.132.1](https://github.com/vm0-ai/vm0/compare/app-v0.132.0...app-v0.132.1) (2026-03-21)


### Bug Fixes

* activity detail page stuck on skeleton when accessed directly ([#5793](https://github.com/vm0-ai/vm0/issues/5793)) ([1778254](https://github.com/vm0-ai/vm0/commit/17782547c0ce9a928195e27f846505f7e4e24d6e))


### Refactoring

* broaden eslint rule to ban all ccstate-react/experimental imports ([#5794](https://github.com/vm0-ai/vm0/issues/5794)) ([210a178](https://github.com/vm0-ai/vm0/commit/210a178e1b6f4440c80f2904307eca77c99af7d2))

## [0.132.0](https://github.com/vm0-ai/vm0/compare/app-v0.131.2...app-v0.132.0) (2026-03-20)


### Features

* add billing dialog and rename stripe price env vars ([#5782](https://github.com/vm0-ai/vm0/issues/5782)) ([f6ea54d](https://github.com/vm0-ai/vm0/commit/f6ea54d138d6f65e7a1cf03262e6e71372a7fd82))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.90.0

## [0.131.2](https://github.com/vm0-ai/vm0/compare/app-v0.131.1...app-v0.131.2) (2026-03-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.89.0

## [0.131.1](https://github.com/vm0-ai/vm0/compare/app-v0.131.0...app-v0.131.1) (2026-03-20)


### Refactoring

* api layer separation phase 5 — application-layer endpoint migration ([#5721](https://github.com/vm0-ai/vm0/issues/5721)) ([3ec2080](https://github.com/vm0-ai/vm0/commit/3ec2080b722dc02d1dc07caeabbd780b4f87c93f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.88.0

## [0.131.0](https://github.com/vm0-ai/vm0/compare/app-v0.130.0...app-v0.131.0) (2026-03-20)


### Features

* add brevo api-token connector ([#5734](https://github.com/vm0-ai/vm0/issues/5734)) ([dd1cb42](https://github.com/vm0-ai/vm0/commit/dd1cb4262e948fad5a585ea474f9583d59800499)), closes [#5712](https://github.com/vm0-ai/vm0/issues/5712)
* add cal-com api-token connector ([#5729](https://github.com/vm0-ai/vm0/issues/5729)) ([9a8165a](https://github.com/vm0-ai/vm0/commit/9a8165ad65920f19271769f9ae06f4f8d66b335c)), closes [#5713](https://github.com/vm0-ai/vm0/issues/5713)
* add loops api-token connector ([#5744](https://github.com/vm0-ai/vm0/issues/5744)) ([62895ea](https://github.com/vm0-ai/vm0/commit/62895eaa443aa23910181d15255dff2a3c2ea6d9)), closes [#5717](https://github.com/vm0-ai/vm0/issues/5717)
* add salesforce api-token connector ([#5735](https://github.com/vm0-ai/vm0/issues/5735)) ([2b5866f](https://github.com/vm0-ai/vm0/commit/2b5866f1e43d29fa966edddf6eabb90c2e66d5ee))


### Bug Fixes

* update v0 connector icon with correct logo ([#5738](https://github.com/vm0-ai/vm0/issues/5738)) ([1c2c030](https://github.com/vm0-ai/vm0/commit/1c2c030d23be6b5facd9ce7bf8f850384b3ba67e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.87.0

## [0.130.0](https://github.com/vm0-ai/vm0/compare/app-v0.129.0...app-v0.130.0) (2026-03-20)


### Features

* add calendly api-token connector ([#5727](https://github.com/vm0-ai/vm0/issues/5727)) ([b11325d](https://github.com/vm0-ai/vm0/commit/b11325d7696d67f823b2b5c48509b674eab017df)), closes [#5714](https://github.com/vm0-ai/vm0/issues/5714)
* add cloudinary api-token connector ([#5724](https://github.com/vm0-ai/vm0/issues/5724)) ([d1734d1](https://github.com/vm0-ai/vm0/commit/d1734d19408bc5e3c5eddfd9b44e2bfbff8b354e))
* add customer-io api-token connector ([#5730](https://github.com/vm0-ai/vm0/issues/5730)) ([04e85a7](https://github.com/vm0-ai/vm0/commit/04e85a7d01da9472a9f4f11e742fa5a0db10a9e7))
* add v0 api-token connector ([#5725](https://github.com/vm0-ai/vm0/issues/5725)) ([ce9481f](https://github.com/vm0-ai/vm0/commit/ce9481fd0fcfdd3e089c36773572ef680c07384b)), closes [#5710](https://github.com/vm0-ai/vm0/issues/5710)
* **platform:** add no-side-effect-in-render eslint rule and fix violations ([#5691](https://github.com/vm0-ai/vm0/issues/5691)) ([77fd903](https://github.com/vm0-ai/vm0/commit/77fd90313991a16f37dcb19fd8577c48d3e1645c))


### Refactoring

* api layer separation phase 3 — core domain proxies ([#5694](https://github.com/vm0-ai/vm0/issues/5694)) ([9e94027](https://github.com/vm0-ai/vm0/commit/9e940274deab747aa8bf72de1c55a5c918f25e12))
* eliminate connector icon duplication with import.meta.glob ([#5698](https://github.com/vm0-ai/vm0/issues/5698)) ([1d57b41](https://github.com/vm0-ai/vm0/commit/1d57b41e5adde0ce5d4508f1ca072b8506084f5b))
* unify inconsistent api paths for model-providers, user-preferences, secrets ([#5689](https://github.com/vm0-ai/vm0/issues/5689)) ([cb986be](https://github.com/vm0-ai/vm0/commit/cb986beb3a9d103f51c967cb200b85c50507c0ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.86.0

## [0.129.0](https://github.com/vm0-ai/vm0/compare/app-v0.128.0...app-v0.129.0) (2026-03-20)


### Features

* add no-secret provider shape for vm0 managed provider ([#5655](https://github.com/vm0-ai/vm0/issues/5655)) ([14b0d75](https://github.com/vm0-ai/vm0/commit/14b0d75a5cf5d6bb421d7ac0bf5659bb114f50ec))
* add trigger_source column to agent_runs for fine-grained run origin tracking ([#5602](https://github.com/vm0-ai/vm0/issues/5602)) ([55fd4bf](https://github.com/vm0-ai/vm0/commit/55fd4bf4209ff92ca7ad8142e07dce7a91b67a4e))


### Bug Fixes

* bundle skill icons as local assets instead of external URLs ([#5660](https://github.com/vm0-ai/vm0/issues/5660)) ([ca7aefa](https://github.com/vm0-ai/vm0/commit/ca7aefa471d6690e1ece5131b8d5b16f9af127c3))
* **docker:** grant non-root users access to chromium and sync lockfile ([#5636](https://github.com/vm0-ai/vm0/issues/5636)) ([d645321](https://github.com/vm0-ai/vm0/commit/d645321fc62a30cabb275e52524845d33835816d))
* **platform:** refresh activity data on each tab re-entry instead of once globally ([#5669](https://github.com/vm0-ai/vm0/issues/5669)) ([9f1a4ed](https://github.com/vm0-ai/vm0/commit/9f1a4edd58d0bc3f4cc59a9ef7ab6e59287ff444))
* **platform:** show error in chat for timeout and cancelled runs ([#5627](https://github.com/vm0-ai/vm0/issues/5627)) ([87b7a07](https://github.com/vm0-ai/vm0/commit/87b7a0738411190691bb2bc365e15ef09b730f58))


### Refactoring

* api layer separation phase 1 — foundation (infra-client + platform ts-rest) ([#5681](https://github.com/vm0-ai/vm0/issues/5681)) ([54d938f](https://github.com/vm0-ai/vm0/commit/54d938facc8df6d5f2486d18a2d8d25f45ef90f0))
* api layer separation phase 2 — simple proxy domains (connectors, org) ([#5686](https://github.com/vm0-ai/vm0/issues/5686)) ([8534f59](https://github.com/vm0-ai/vm0/commit/8534f5957817e3576845971c1a536c2a117457ab))
* **slack:** use structured sender block in context formatting ([#5639](https://github.com/vm0-ai/vm0/issues/5639)) ([dfca766](https://github.com/vm0-ai/vm0/commit/dfca76616ac7e4b4e1904f105f2225d05e1fe0fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.85.0

## [0.128.0](https://github.com/vm0-ai/vm0/compare/app-v0.127.0...app-v0.128.0) (2026-03-19)


### Features

* add email-based feature switch targeting ([#5588](https://github.com/vm0-ai/vm0/issues/5588)) ([096c5e4](https://github.com/vm0-ai/vm0/commit/096c5e4c8452b01f901d21c3e94b440bee432be4))
* add zero agents rest api and remove compose jobs ([#5594](https://github.com/vm0-ai/vm0/issues/5594)) ([8e428bb](https://github.com/vm0-ai/vm0/commit/8e428bb40c663b50bb481928f708e004601ee1af))
* **connectors:** add bitrix, brave-search, cronlytic connectors ([#5528](https://github.com/vm0-ai/vm0/issues/5528)) ([21821cd](https://github.com/vm0-ai/vm0/commit/21821cd973e36e7906aa7ef97329e9c751cee491))
* **connectors:** add discord, discord-webhook, gitlab connectors ([#5542](https://github.com/vm0-ai/vm0/issues/5542)) ([99fb554](https://github.com/vm0-ai/vm0/commit/99fb5543059f62aa37625e3bb1ef3b405f787978)), closes [#5519](https://github.com/vm0-ai/vm0/issues/5519)
* **connectors:** add htmlcsstoimage, imgur, instagram api token connectors ([#5538](https://github.com/vm0-ai/vm0/issues/5538)) ([7c75fce](https://github.com/vm0-ai/vm0/commit/7c75fce26c15ad1f6781c71bea15ef108ed067f6)), closes [#5520](https://github.com/vm0-ai/vm0/issues/5520)
* **connectors:** add instantly, jira, and kommo API token connectors ([#5561](https://github.com/vm0-ai/vm0/issues/5561)) ([257b637](https://github.com/vm0-ai/vm0/commit/257b6377eb77b15db23dbdfd7ee66b129d082dc8))
* **connectors:** add lark, mailsac, minio api token connectors ([#5543](https://github.com/vm0-ai/vm0/issues/5543)) ([bb81ced](https://github.com/vm0-ai/vm0/commit/bb81ced1c3c53ea78e428b0a737ce62b0f59b086))
* **connectors:** add pdforge, slack-webhook, wix api token connectors ([#5545](https://github.com/vm0-ai/vm0/issues/5545)) ([5471a13](https://github.com/vm0-ai/vm0/commit/5471a1348897a4d045bbbdaa8cc8e5a4f8ed04e1)), closes [#5523](https://github.com/vm0-ai/vm0/issues/5523)
* hide aws-bedrock and azure-foundry from model provider selection ([#5601](https://github.com/vm0-ai/vm0/issues/5601)) ([f3ffb11](https://github.com/vm0-ai/vm0/commit/f3ffb11cf2962f665e1aa4e2e14267ffc5542c97)), closes [#5599](https://github.com/vm0-ai/vm0/issues/5599)
* implement vm0 managed model provider with meta-provider resolution ([#5623](https://github.com/vm0-ai/vm0/issues/5623)) ([b20b330](https://github.com/vm0-ai/vm0/commit/b20b330d5f83d3cef4591866eaec460c9ebedef0))
* integrate the-seed default instructions and skills into zero onboarding ([#5506](https://github.com/vm0-ai/vm0/issues/5506)) ([09e14a3](https://github.com/vm0-ai/vm0/commit/09e14a3b3b841f8450cd9cd9bda58dc0689cb83a))
* **platform:** add cancel button to queue page ([#5604](https://github.com/vm0-ai/vm0/issues/5604)) ([6644a67](https://github.com/vm0-ai/vm0/commit/6644a6766af36cd2dd06dbd4a7b31da2196daab7))
* **platform:** auto-pin on chat, remove pin limit, fix team nav ([#5536](https://github.com/vm0-ai/vm0/issues/5536)) ([f210650](https://github.com/vm0-ai/vm0/commit/f210650bc393fce2fb2d43156caab6c0a985a478))
* **platform:** improve mobile responsiveness across platform pages ([#5571](https://github.com/vm0-ai/vm0/issues/5571)) ([8f0e0a4](https://github.com/vm0-ai/vm0/commit/8f0e0a473b852bbb1f9aa54ed56a3dd05aa30754)), closes [#5567](https://github.com/vm0-ai/vm0/issues/5567)
* **platform:** replace textarea with tiptap visual editor for instructions ([#5487](https://github.com/vm0-ai/vm0/issues/5487)) ([ece552b](https://github.com/vm0-ai/vm0/commit/ece552b7279c1f3e75f7397e8fd50ca30c218cbe))


### Bug Fixes

* always include seed skills and add chat avatar navigation ([#5572](https://github.com/vm0-ai/vm0/issues/5572)) ([f01df34](https://github.com/vm0-ai/vm0/commit/f01df342a8c42ac34782f49ea041c9b0e49afb1a))
* **platform:** adjust activity detail page spacing for mobile layout ([#5558](https://github.com/vm0-ai/vm0/issues/5558)) ([1878aaa](https://github.com/vm0-ai/vm0/commit/1878aaa60fb64a8575db35baa8b166a24a9b95fe))
* surface api error message on agent run creation failure ([#5590](https://github.com/vm0-ai/vm0/issues/5590)) ([297664c](https://github.com/vm0-ai/vm0/commit/297664cd8a009161028daa627aa440fa690bde39)), closes [#5565](https://github.com/vm0-ai/vm0/issues/5565)


### Refactoring

* remove metadata field from compose pipeline ([#5549](https://github.com/vm0-ai/vm0/issues/5549)) ([#5566](https://github.com/vm0-ai/vm0/issues/5566)) ([aeaf504](https://github.com/vm0-ai/vm0/commit/aeaf504dc6b84dd32f09f9278c58fed417d4ecbf))
* **slack:** move integration context from userPrompt to systemPrompt ([#5569](https://github.com/vm0-ai/vm0/issues/5569)) ([7e9469b](https://github.com/vm0-ai/vm0/commit/7e9469bef3da52a352900f58d02776c4b187ea7f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.84.0

## [0.127.0](https://github.com/vm0-ai/vm0/compare/app-v0.126.3...app-v0.127.0) (2026-03-19)


### Features

* add friendly frontend error for provider incompatibility ([#5459](https://github.com/vm0-ai/vm0/issues/5459)) ([11c6b1d](https://github.com/vm0-ai/vm0/commit/11c6b1d66881823da9205abdb2e32f5e72bee473)), closes [#5450](https://github.com/vm0-ai/vm0/issues/5450)


### Refactoring

* **platform:** simplify settings update to use metadata api ([#5491](https://github.com/vm0-ai/vm0/issues/5491)) ([3950652](https://github.com/vm0-ai/vm0/commit/395065288d99fa3b9b3a8ec0317bcff64757ff74))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.83.0

## [0.126.3](https://github.com/vm0-ai/vm0/compare/app-v0.126.2...app-v0.126.3) (2026-03-19)


### Bug Fixes

* **platform:** enlarge image previews and add click-to-zoom in composer ([#5470](https://github.com/vm0-ai/vm0/issues/5470)) ([a03a230](https://github.com/vm0-ai/vm0/commit/a03a23092bce1d61436763b974443157b4966467))

## [0.126.2](https://github.com/vm0-ai/vm0/compare/app-v0.126.1...app-v0.126.2) (2026-03-19)


### Refactoring

* **web:** unify run output extraction into shared service ([#5395](https://github.com/vm0-ai/vm0/issues/5395)) ([1b93611](https://github.com/vm0-ai/vm0/commit/1b9361161299bf766c61e822959a575e319edf2d))

## [0.126.1](https://github.com/vm0-ai/vm0/compare/app-v0.126.0...app-v0.126.1) (2026-03-19)


### Bug Fixes

* improve line break test assertions to check dom structure directly ([#5456](https://github.com/vm0-ai/vm0/issues/5456)) ([4abf336](https://github.com/vm0-ai/vm0/commit/4abf336c3cf95d9cefcf3e6bbc5ff77361d7e0eb))


### Refactoring

* migrate agent metadata to zero_agents table ([#5393](https://github.com/vm0-ai/vm0/issues/5393)) ([a6bc58d](https://github.com/vm0-ai/vm0/commit/a6bc58db3a554ff76a37554c553fe180c9d1a9c8))
* remove instructions metadata injection system ([#5445](https://github.com/vm0-ai/vm0/issues/5445)) ([d9d11ca](https://github.com/vm0-ai/vm0/commit/d9d11cabce49d1dea783a12c86f59328af336ab0)), closes [#5380](https://github.com/vm0-ai/vm0/issues/5380)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.82.0

## [0.126.0](https://github.com/vm0-ai/vm0/compare/app-v0.125.1...app-v0.126.0) (2026-03-19)


### Features

* **platform:** add delete agent button to profile tab ([#5400](https://github.com/vm0-ai/vm0/issues/5400)) ([3757fee](https://github.com/vm0-ai/vm0/commit/3757fee1ed4fbbe726d80c8bca0a01763c468f4f))
* **platform:** optimize zero chat connector popover and schedule dialogs ([#5429](https://github.com/vm0-ai/vm0/issues/5429)) ([00a0fe7](https://github.com/vm0-ai/vm0/commit/00a0fe7b71838a57290795276c5fb5e93a1b30d2))


### Bug Fixes

* add scroll constraint to connector popover for long lists ([#5387](https://github.com/vm0-ai/vm0/issues/5387)) ([9ae73bc](https://github.com/vm0-ai/vm0/commit/9ae73bc4ef5b9af715adcc133bffa18ac5c383c9))
* **platform:** navigate to /talk/:name from agent detail chat button ([#5419](https://github.com/vm0-ai/vm0/issues/5419)) ([c220b03](https://github.com/vm0-ai/vm0/commit/c220b03d888d8ed9dbcdd9419d503b4f8d5e88b5)), closes [#5418](https://github.com/vm0-ai/vm0/issues/5418)
* **platform:** pass memory name when creating agent runs from zero chat ([#5411](https://github.com/vm0-ai/vm0/issues/5411)) ([92c48d6](https://github.com/vm0-ai/vm0/commit/92c48d68fd76bd27d900f59cdda063f1970ef196))
* **platform:** sync composer connectors after job detail save and limit popover height ([#5404](https://github.com/vm0-ai/vm0/issues/5404)) ([b20eef8](https://github.com/vm0-ai/vm0/commit/b20eef8558b92aefa916bedfbda2a268227984a8))
* remove environment-variables-setup url from compose output ([#5401](https://github.com/vm0-ai/vm0/issues/5401)) ([8041030](https://github.com/vm0-ai/vm0/commit/80410309155ddfa23bcded39a92e58f52dbb78c5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.81.0

## [0.125.1](https://github.com/vm0-ai/vm0/compare/app-v0.125.0...app-v0.125.1) (2026-03-18)


### Bug Fixes

* **platform:** remove leftover /zero prefix from activity log link ([#5394](https://github.com/vm0-ai/vm0/issues/5394)) ([07a4894](https://github.com/vm0-ai/vm0/commit/07a489451e5126cea709e962b0ef02a58db1f4d0)), closes [#5391](https://github.com/vm0-ai/vm0/issues/5391)
* **platform:** unify connector status text and simplify dropdown actions ([#5388](https://github.com/vm0-ai/vm0/issues/5388)) ([b3caa66](https://github.com/vm0-ai/vm0/commit/b3caa6623c796ce1cf3149f0eec7ab3f69a25c2d))


### Refactoring

* **platform:** remove experimental capabilities tab from agent detail page ([#5381](https://github.com/vm0-ai/vm0/issues/5381)) ([69b2158](https://github.com/vm0-ai/vm0/commit/69b215855079759155bfa92a6e1af534fbb0a482)), closes [#5374](https://github.com/vm0-ai/vm0/issues/5374)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.80.0

## [0.125.0](https://github.com/vm0-ai/vm0/compare/app-v0.124.0...app-v0.125.0) (2026-03-18)


### Features

* change schedule minute picker to 5-minute step intervals ([#5358](https://github.com/vm0-ai/vm0/issues/5358)) ([4f7a9b5](https://github.com/vm0-ai/vm0/commit/4f7a9b5dd15a34eb396a673f7c783d2891013085)), closes [#5355](https://github.com/vm0-ai/vm0/issues/5355)


### Bug Fixes

* add image paste and drag-and-drop upload to chat input ([#5337](https://github.com/vm0-ai/vm0/issues/5337)) ([802ca42](https://github.com/vm0-ai/vm0/commit/802ca428693e9eed6c7dfabe5ed4494a61a65c7a))
* drop residual zero prefix from queue session link and stale comment ([#5362](https://github.com/vm0-ai/vm0/issues/5362)) ([4b4ca17](https://github.com/vm0-ai/vm0/commit/4b4ca1737b32ae5477e947bd608f1d608bbe9a7e)), closes [#5356](https://github.com/vm0-ai/vm0/issues/5356)
* use browser history.back() for chat session back navigation ([#5339](https://github.com/vm0-ai/vm0/issues/5339)) ([715f6c8](https://github.com/vm0-ai/vm0/commit/715f6c8bcfa881b13e2d26830c152dd9742b0e0a))


### Refactoring

* **platform:** derive capability groups from valid capabilities constant ([#5367](https://github.com/vm0-ai/vm0/issues/5367)) ([90cc985](https://github.com/vm0-ai/vm0/commit/90cc985f5d7345e88dc17ca6c402406c22a37120)), closes [#5364](https://github.com/vm0-ai/vm0/issues/5364)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.79.2

## [0.124.0](https://github.com/vm0-ai/vm0/compare/app-v0.123.1...app-v0.124.0) (2026-03-18)


### Features

* auto-disconnect existing connector in /authorize endpoint ([#5351](https://github.com/vm0-ai/vm0/issues/5351)) ([e65f0d1](https://github.com/vm0-ai/vm0/commit/e65f0d1b1a6ddea1e1f5af826e471bc1f7367297)), closes [#5343](https://github.com/vm0-ai/vm0/issues/5343)
* **platform:** add schedule creation dialog and improve pinned agents ux ([#5202](https://github.com/vm0-ai/vm0/issues/5202)) ([02ec4de](https://github.com/vm0-ai/vm0/commit/02ec4dec2af723095780d1a4c948f068b1246db2))


### Bug Fixes

* preserve user line breaks in chat messages ([#5334](https://github.com/vm0-ai/vm0/issues/5334)) ([771697b](https://github.com/vm0-ai/vm0/commit/771697ba9c8c038e2d50087b07647e35d23b5e64))


### Refactoring

* remove model provider step from member onboarding flow ([#5326](https://github.com/vm0-ai/vm0/issues/5326)) ([8dc83b4](https://github.com/vm0-ai/vm0/commit/8dc83b48159cb36994734c752d1b46dfd24ce188))
* remove platform naming remnants from codebase ([#5336](https://github.com/vm0-ai/vm0/issues/5336)) ([a846586](https://github.com/vm0-ai/vm0/commit/a84658654b6b9ae11801aa0c8ac0dd30a3d8fa9f)), closes [#5327](https://github.com/vm0-ai/vm0/issues/5327)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.79.1

## [0.123.1](https://github.com/vm0-ai/vm0/compare/app-v0.123.0...app-v0.123.1) (2026-03-18)


### Bug Fixes

* use active chat agent compose for skills in zero-meet ([#5317](https://github.com/vm0-ai/vm0/issues/5317)) ([f36048a](https://github.com/vm0-ai/vm0/commit/f36048ae97c73feb81c447e8ed4926141ba57b0d))

## [0.123.0](https://github.com/vm0-ai/vm0/compare/app-v0.122.0...app-v0.123.0) (2026-03-18)


### Features

* add organization-wide run queue web interface ([#4988](https://github.com/vm0-ai/vm0/issues/4988)) ([2da3dfd](https://github.com/vm0-ai/vm0/commit/2da3dfd5f6e8b0eced19135ad86333c8146d9f7e))
* prompt users to review and approve oauth scope changes ([#5312](https://github.com/vm0-ai/vm0/issues/5312)) ([6cd80bf](https://github.com/vm0-ai/vm0/commit/6cd80bfeee99e0e13935222cb1081837ac31ed05))


### Refactoring

* remove user-level model provider ui ([#5299](https://github.com/vm0-ai/vm0/issues/5299)) ([47ca97e](https://github.com/vm0-ai/vm0/commit/47ca97ed680ddfeefa2ebe980b1cc3ac51059694)), closes [#5293](https://github.com/vm0-ai/vm0/issues/5293)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.79.0

## [0.122.0](https://github.com/vm0-ai/vm0/compare/app-v0.121.1...app-v0.122.0) (2026-03-18)


### Features

* add chat threads for instant sidebar and stable url routing ([#5102](https://github.com/vm0-ai/vm0/issues/5102)) ([c902c8c](https://github.com/vm0-ai/vm0/commit/c902c8c892f93e3496c94a5fda0e835b1957086d))
* add explorium api-token connector ([#4404](https://github.com/vm0-ai/vm0/issues/4404)) ([27113d0](https://github.com/vm0-ai/vm0/commit/27113d0908d2c2d2608307e06b7d69d8a9e1853c))
* add fireflies api-token connector ([#4378](https://github.com/vm0-ai/vm0/issues/4378)) ([c3f0156](https://github.com/vm0-ai/vm0/commit/c3f01564303aea49597df043e8582ee466a249a8))
* add granola api-token connector ([#4413](https://github.com/vm0-ai/vm0/issues/4413)) ([28b8605](https://github.com/vm0-ai/vm0/commit/28b8605983b604539f05877634eb06f29b365fda))
* add hume api-token connector ([#4366](https://github.com/vm0-ai/vm0/issues/4366)) ([23d14f1](https://github.com/vm0-ai/vm0/commit/23d14f1f7446cd2b9a0f4a6a5c07fc5b65cfcd61))
* add jam api-token connector ([#4421](https://github.com/vm0-ai/vm0/issues/4421)) ([73b8a98](https://github.com/vm0-ai/vm0/commit/73b8a98912ca3c7ce65c698d4d1a928f8fc600a0))
* add jotform api-token connector ([#4387](https://github.com/vm0-ai/vm0/issues/4387)) ([72407b5](https://github.com/vm0-ai/vm0/commit/72407b562785cdaa238c23feed05e0235ea5f619))
* add metabase api-token connector ([#4399](https://github.com/vm0-ai/vm0/issues/4399)) ([29061c6](https://github.com/vm0-ai/vm0/commit/29061c676f0816b1322fe386250878f74787ebe4))
* add model provider tracking and org-scoped logs/schedules ([#4909](https://github.com/vm0-ai/vm0/issues/4909)) ([dc0de67](https://github.com/vm0-ai/vm0/commit/dc0de673b2e78eec803a3051148f1947dc292945))
* add needs-reconnect flag for connector token refresh failures ([#5128](https://github.com/vm0-ai/vm0/issues/5128)) ([5da9c4e](https://github.com/vm0-ai/vm0/commit/5da9c4e15385589a41a49007dfc2b0009f58bbe8))
* add org/personal tabs for model provider settings ([#5214](https://github.com/vm0-ai/vm0/issues/5214)) ([d035f1d](https://github.com/vm0-ai/vm0/commit/d035f1d7b372f07c6054e27fd71b2ac437f8bb26))
* add per-schedule notification control ([#4885](https://github.com/vm0-ai/vm0/issues/4885)) ([904cdfb](https://github.com/vm0-ai/vm0/commit/904cdfb0fd6f8ce241420b288cc43860ba1c55f0))
* add prisma-postgres api-token connector ([#4375](https://github.com/vm0-ai/vm0/issues/4375)) ([86fd6e6](https://github.com/vm0-ai/vm0/commit/86fd6e6d2b7dc63a99f1bdcbad17bc79c8335900))
* add revenuecat api-token connector ([#4368](https://github.com/vm0-ai/vm0/issues/4368)) ([8eddaa5](https://github.com/vm0-ai/vm0/commit/8eddaa5678095b03896c42d750049fe882fc207c))
* add scope field to merged model provider list endpoint ([#5182](https://github.com/vm0-ai/vm0/issues/5182)) ([2b3d4ef](https://github.com/vm0-ai/vm0/commit/2b3d4ef87af7ba9831ffb34ba2a207d1114decc6))
* add tldv api-token connector ([#4383](https://github.com/vm0-ai/vm0/issues/4383)) ([fb67e47](https://github.com/vm0-ai/vm0/commit/fb67e475455dfdb2527bbaaba945b031920980bb))
* add user settings ui for gdpr data export ([#5152](https://github.com/vm0-ai/vm0/issues/5152)) ([46c8c96](https://github.com/vm0-ai/vm0/commit/46c8c960ad1ab6969ba04b11fa61d1f914ea12d5))
* add vercel ai gateway as staff-only model provider ([#5032](https://github.com/vm0-ai/vm0/issues/5032)) ([53b5845](https://github.com/vm0-ai/vm0/commit/53b5845a8903721ea0d6dbafcd2815641552f254)), closes [#5029](https://github.com/vm0-ai/vm0/issues/5029)
* add zapier api-token connector ([#4401](https://github.com/vm0-ai/vm0/issues/4401)) ([b1a7f52](https://github.com/vm0-ai/vm0/commit/b1a7f52da40763510e4b64014fd6f21025608387))
* configurable send mode preference (enter vs cmd+enter) ([#4953](https://github.com/vm0-ai/vm0/issues/4953)) ([d8a43b8](https://github.com/vm0-ai/vm0/commit/d8a43b846595cf4beec259e50400e3d3ccd04a62))
* enable multi-account switching in production ([#4868](https://github.com/vm0-ai/vm0/issues/4868)) ([4ee375d](https://github.com/vm0-ai/vm0/commit/4ee375d3f6f5ac66385154a6bf1cc2c2ea8d234c))
* fix agent connections page to handle api-token connectors and unify layout ([#4480](https://github.com/vm0-ai/vm0/issues/4480)) ([9b55546](https://github.com/vm0-ai/vm0/commit/9b55546c85671b811130010c5cb32b7bc878cf3b))
* improve zero page with markdown theming, avatar overrides, and navigation ([#5065](https://github.com/vm0-ai/vm0/issues/5065)) ([5ca5a04](https://github.com/vm0-ai/vm0/commit/5ca5a0441b1019516b7a64baa8ca695863581686))
* inject agent metadata into instructions as frontmatter during compose ([#4382](https://github.com/vm0-ai/vm0/issues/4382)) ([c9e4c02](https://github.com/vm0-ai/vm0/commit/c9e4c02ce0bea2182f14269856f21222a5b0d94f))
* integrate lighthouse ci audits for web and platform homepages ([#5139](https://github.com/vm0-ai/vm0/issues/5139)) ([dd9f570](https://github.com/vm0-ai/vm0/commit/dd9f570eafda6b8a740c51a95db3fa9ecf7ab077))
* **platform:** add agent metadata and improve meet settings ([#4351](https://github.com/vm0-ai/vm0/issues/4351)) ([8e6a34c](https://github.com/vm0-ai/vm0/commit/8e6a34cbf5efecf52b94a4f495a174f2aa5f27ac))
* **platform:** add member onboarding flow and welcome animation ([#5060](https://github.com/vm0-ai/vm0/issues/5060)) ([de6b1e1](https://github.com/vm0-ai/vm0/commit/de6b1e1cf9467bf1171fd67b5ebbc560373322a2))
* **platform:** add talk route for url-driven agent chat selection ([#5098](https://github.com/vm0-ai/vm0/issues/5098)) ([34b6800](https://github.com/vm0-ai/vm0/commit/34b68005429fcfbede85fed2d55e8f54fd7a9ae1))
* **platform:** improve zero activity, schedule, and meet pages ([#4616](https://github.com/vm0-ai/vm0/issues/4616)) ([90da3a5](https://github.com/vm0-ai/vm0/commit/90da3a5cdd8661e2b8359e965cdb84161ab20b51))
* **platform:** refactor preferences into standalone zero route with loading states ([#4651](https://github.com/vm0-ai/vm0/issues/4651)) ([55b851b](https://github.com/vm0-ai/vm0/commit/55b851b944587887e9453906313b46ba8c025e14))
* **platform:** unify border styling and refine ui consistency across zero app ([#4863](https://github.com/vm0-ai/vm0/issues/4863)) ([f232a8b](https://github.com/vm0-ai/vm0/commit/f232a8bad9e20f1ebb02217d7db325f8476e39ab))
* **platform:** upgrade vite from v6 to v7 ([#4728](https://github.com/vm0-ai/vm0/issues/4728)) ([9dd617e](https://github.com/vm0-ai/vm0/commit/9dd617e27990ea52a93c5502b8ed9e946941e3e9)), closes [#4716](https://github.com/vm0-ai/vm0/issues/4716)
* **platform:** wire zero schedule page to real api calls ([#4589](https://github.com/vm0-ai/vm0/issues/4589)) ([b1cb54c](https://github.com/vm0-ai/vm0/commit/b1cb54c765b6d2c8ebde756e89608615555e0785))
* **platform:** zero app v4 ui overhaul ([#4820](https://github.com/vm0-ai/vm0/issues/4820)) ([f219ec6](https://github.com/vm0-ai/vm0/commit/f219ec6d4a664ffef660e060647d1e577bd5212a))
* **platform:** zero app v4 ui polish and refinements ([#4995](https://github.com/vm0-ai/vm0/issues/4995)) ([a8cd2dc](https://github.com/vm0-ai/vm0/commit/a8cd2dcec8678d25090df5b155446f612e4a3868))
* **platform:** zero ui polish and sidebar improvements ([#5082](https://github.com/vm0-ai/vm0/issues/5082)) ([d9d464a](https://github.com/vm0-ai/vm0/commit/d9d464a7a36e75516303bffee933044475fa6413))
* redirect to login page on 401 response ([#5025](https://github.com/vm0-ai/vm0/issues/5025)) ([6dbe891](https://github.com/vm0-ai/vm0/commit/6dbe891501690b73f99f136a9c84ee30912f535a))
* **slack:** add platform ui for org-aware slack integration ([#4715](https://github.com/vm0-ai/vm0/issues/4715)) ([deb9179](https://github.com/vm0-ai/vm0/commit/deb9179480bd318d4b91e8b7a87354ffbaa89564))
* support app subdomain alongside platform subdomain ([#5267](https://github.com/vm0-ai/vm0/issues/5267)) ([dacd3b2](https://github.com/vm0-ai/vm0/commit/dacd3b2bd9be68cb34ee4f539d54fcb349f3ba59)), closes [#5266](https://github.com/vm0-ai/vm0/issues/5266)
* **zero:** add pinned agents, agent switching, and per-agent sessions ([#4727](https://github.com/vm0-ai/vm0/issues/4727)) ([d3ee3af](https://github.com/vm0-ai/vm0/commit/d3ee3af19e34c583efc8f9b6b4da1bf48de9f0fb))
* **zero:** add recent chat sidebar, file attachments, and session switching ([#4582](https://github.com/vm0-ai/vm0/issues/4582)) ([d460861](https://github.com/vm0-ai/vm0/commit/d4608610fa4eda2ffa8ff53663187f430987283c))
* **zero:** add settings page, deferred skill saving, and onboarding improvements ([#4511](https://github.com/vm0-ai/vm0/issues/4511)) ([7452cd8](https://github.com/vm0-ai/vm0/commit/7452cd8e6c99f66765e6346eface7305a25b6b5f))
* **zero:** enhance schedule management with toggle, calendar, and multi-day support ([#4374](https://github.com/vm0-ai/vm0/issues/4374)) ([75b1539](https://github.com/vm0-ai/vm0/commit/75b1539e929a2d83b858d88e77f7cf05df97c197))
* **zero:** implement chat with real agent run pipeline ([#4384](https://github.com/vm0-ai/vm0/issues/4384)) ([d832baf](https://github.com/vm0-ai/vm0/commit/d832baf5e6b54dc7855d45a157050fde71837cb2))
* **zero:** implement team page with real subagent list and detail navigation ([#4310](https://github.com/vm0-ai/vm0/issues/4310)) ([c48f45e](https://github.com/vm0-ai/vm0/commit/c48f45ed92a8f8dc6677cf220570e52be89f5651))
* **zero:** wire activities page with real logs api ([#4358](https://github.com/vm0-ai/vm0/issues/4358)) ([cbeec6b](https://github.com/vm0-ai/vm0/commit/cbeec6b48ea91832c1af8f2c8f98484765a9a7b1))


### Bug Fixes

* abort in-flight polling when switching or starting new zero session ([#5087](https://github.com/vm0-ai/vm0/issues/5087)) ([286df7f](https://github.com/vm0-ai/vm0/commit/286df7f6f73770d01e7eb8a18ac8a2245d4b6807))
* activity detail auth alignment and platform team endpoint ([#4933](https://github.com/vm0-ai/vm0/issues/4933)) ([fbfdb1d](https://github.com/vm0-ai/vm0/commit/fbfdb1dff690271bdfb6927d4deca852439cf624))
* add cache and security headers to platform vercel.json ([#5218](https://github.com/vm0-ai/vm0/issues/5218)) ([6aae552](https://github.com/vm0-ai/vm0/commit/6aae55282c1a8e797f25d7b2a3d6a04f3230f0b2)), closes [#5208](https://github.com/vm0-ai/vm0/issues/5208)
* address semgrep sast findings for casa tier 2 compliance ([#4487](https://github.com/vm0-ai/vm0/issues/4487)) ([e900299](https://github.com/vm0-ai/vm0/commit/e9002997cf58e7424344f6c494cac25faee07641)), closes [#4422](https://github.com/vm0-ai/vm0/issues/4422)
* **app:** resolve web origin correctly for preview environment hostnames ([#5296](https://github.com/vm0-ai/vm0/issues/5296)) ([913581f](https://github.com/vm0-ai/vm0/commit/913581f14d374706509e19f1680c3b165cb96d43))
* compare with zeroChatThreadId$ and add loading guard. ([c902c8c](https://github.com/vm0-ai/vm0/commit/c902c8c892f93e3496c94a5fda0e835b1957086d))
* hide connector-managed secrets from custom api section ([#4367](https://github.com/vm0-ai/vm0/issues/4367)) ([147c144](https://github.com/vm0-ai/vm0/commit/147c1449c3ec459f20ddd7bdb278a7f4e34b5920))
* hide credit and invite buttons from chat page ([#4954](https://github.com/vm0-ai/vm0/issues/4954)) ([459eeb7](https://github.com/vm0-ai/vm0/commit/459eeb789bd648120e584768faa21a6a377384d9))
* improve slack connect flow with loading state, install DM, and org check ([#5153](https://github.com/vm0-ai/vm0/issues/5153)) ([6f4f1f5](https://github.com/vm0-ai/vm0/commit/6f4f1f57214216477ebdb4b53d01de4cca0c924c))
* model provider auto-default, onboarding, profile save, and slack install flow ([#4967](https://github.com/vm0-ai/vm0/issues/4967)) ([5d6c132](https://github.com/vm0-ai/vm0/commit/5d6c1327f8f4f41fa44bf5753030db67867d0a75))
* **platform:** increase compose job polling timeout and handle onboarding errors ([#4655](https://github.com/vm0-ai/vm0/issues/4655)) ([215bfe1](https://github.com/vm0-ai/vm0/commit/215bfe19a82d001f897239a4af959782f0f9dcc5)), closes [#4654](https://github.com/vm0-ai/vm0/issues/4654)
* **platform:** make activity logs icon a proper link for middle-click support ([#5103](https://github.com/vm0-ai/vm0/issues/5103)) ([cadb761](https://github.com/vm0-ai/vm0/commit/cadb76143495730a6ab41a2b66311f5daf6c15b1))
* **platform:** navigate to /zero on org switch instead of reloading ([#5090](https://github.com/vm0-ai/vm0/issues/5090)) ([f85fbbb](https://github.com/vm0-ai/vm0/commit/f85fbbb008aac047eb9d663afe6629615bc81f65))
* revert merged provider list to return only user providers ([#5261](https://github.com/vm0-ai/vm0/issues/5261)) ([a5783c7](https://github.com/vm0-ai/vm0/commit/a5783c7376dc7b6584c189d55a31269ccaf5aabd)), closes [#5259](https://github.com/vm0-ai/vm0/issues/5259)
* update platform to send ?org= and clean up remaining scope references ([#4690](https://github.com/vm0-ai/vm0/issues/4690)) ([3788240](https://github.com/vm0-ai/vm0/commit/37882409b710bea326429c5bf3cf5f2d944abfd2))
* use last-loadable pattern, filter orphan connectors, and flex run result schema ([#4943](https://github.com/vm0-ai/vm0/issues/4943)) ([f5c6234](https://github.com/vm0-ai/vm0/commit/f5c623434401b0265912b325ebb44afc25d92027))


### Refactoring

* add extract-and-group-variables convenience function ([#4517](https://github.com/vm0-ai/vm0/issues/4517)) ([fe13128](https://github.com/vm0-ai/vm0/commit/fe13128c1a0b0e619c9a585867c3d3f5f81e2f9b))
* eliminate remaining scope references ([#4703](https://github.com/vm0-ai/vm0/issues/4703)) ([fd85a3b](https://github.com/vm0-ai/vm0/commit/fd85a3b6b4f4fe10eb0ff36a1f5140888d9a57f1))
* eliminate scope references in web, platform, and tests ([#4700](https://github.com/vm0-ai/vm0/issues/4700)) ([7451fc6](https://github.com/vm0-ai/vm0/commit/7451fc6bcb062d1163179667fff656cc55c182e9)), closes [#4693](https://github.com/vm0-ai/vm0/issues/4693)
* improve zero onboarding post-completion navigation ([#4908](https://github.com/vm0-ai/vm0/issues/4908)) ([c3d95b8](https://github.com/vm0-ai/vm0/commit/c3d95b884fcece0a3a73d8128469e6f81a7cc650))
* move platform public assets to colocated imports and remove unused files ([#5225](https://github.com/vm0-ai/vm0/issues/5225)) ([07ade10](https://github.com/vm0-ai/vm0/commit/07ade10d4beab290e3c3d9985f2fbfdba2d3554f)), closes [#5223](https://github.com/vm0-ai/vm0/issues/5223)
* platform to app comprehensive rename (phase 2) ([#5275](https://github.com/vm0-ai/vm0/issues/5275)) ([73e8a5f](https://github.com/vm0-ai/vm0/commit/73e8a5f0edfac2a0b73a9f4d86812fd747de98db))
* **platform:** remove /zero prefix from all platform routes ([#5155](https://github.com/vm0-ai/vm0/issues/5155)) ([228b4dd](https://github.com/vm0-ai/vm0/commit/228b4dd81efe36be51606f695057bf20c4aba034))
* **platform:** rename internal scope variables and signals to org ([#4644](https://github.com/vm0-ai/vm0/issues/4644)) ([f8abd64](https://github.com/vm0-ai/vm0/commit/f8abd64f563dab3f36f63e09a7b361ca0c1e2d9e))
* remove all non-zero platform pages and feature flag ([#5095](https://github.com/vm0-ai/vm0/issues/5095)) ([fa7f011](https://github.com/vm0-ai/vm0/commit/fa7f01187b84d7046b150f46f217c191d5ad5670))
* remove dead org creation and slug generation code ([#4653](https://github.com/vm0-ai/vm0/issues/4653)) ([2361d6c](https://github.com/vm0-ai/vm0/commit/2361d6c8c322bee6f08602d4f93a437036e2c1a1))
* remove leftover "shared agent" terminology from tests and comments ([#4950](https://github.com/vm0-ai/vm0/issues/4950)) ([f9a01ff](https://github.com/vm0-ai/vm0/commit/f9a01ffcfda2dc5edec86733e7a3db4ca5a070a3))
* remove server-side acl permission system and shared agent ui ([#4881](https://github.com/vm0-ai/vm0/issues/4881)) ([123c1cf](https://github.com/vm0-ai/vm0/commit/123c1cf5dd28cb7e9b5980ad1dfc97d052b4ce8f))
* rename scope to org in platform frontend signals and mocks ([#4618](https://github.com/vm0-ai/vm0/issues/4618)) ([f84f3c7](https://github.com/vm0-ai/vm0/commit/f84f3c73b4319593ac9a2bf83a98823c8e9bf5c9))
* rename scope wire format to org across all packages ([#4656](https://github.com/vm0-ai/vm0/issues/4656)) ([43ac1f3](https://github.com/vm0-ai/vm0/commit/43ac1f30220a0d285b639f35cacaac842bccd5ff))
* return display name from logs api instead of frontend mapping ([#5150](https://github.com/vm0-ai/vm0/issues/5150)) ([92d7877](https://github.com/vm0-ai/vm0/commit/92d787709fabc58b557a807749cf9d261bac707b))
* reuse grouped message components in zero activity detail ([#4525](https://github.com/vm0-ai/vm0/issues/4525)) ([a6b4f1e](https://github.com/vm0-ai/vm0/commit/a6b4f1ec48f38b2156900d869cab3b5b24a42b39))
* route connector deep links to /zero/team/:name instead of /zero/meet ([#5023](https://github.com/vm0-ai/vm0/issues/5023)) ([42f5c63](https://github.com/vm0-ai/vm0/commit/42f5c63f7402081c7821597acb802820f4abb98b))
* standardize connector secret names to use token convention ([#4385](https://github.com/vm0-ai/vm0/issues/4385)) ([470101f](https://github.com/vm0-ai/vm0/commit/470101f7612e95e8826653b33df819cf0de49b26))
* use link components instead of buttons in zero pages ([#5062](https://github.com/vm0-ai/vm0/issues/5062)) ([cf093ad](https://github.com/vm0-ai/vm0/commit/cf093adcaf66844fb9a5f1926c43e9d6fc8478c0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.78.0

## [0.121.1](https://github.com/vm0-ai/vm0/compare/platform-v0.121.0...platform-v0.121.1) (2026-03-17)


### Bug Fixes

* revert merged provider list to return only user providers ([#5261](https://github.com/vm0-ai/vm0/issues/5261)) ([a5783c7](https://github.com/vm0-ai/vm0/commit/a5783c7376dc7b6584c189d55a31269ccaf5aabd)), closes [#5259](https://github.com/vm0-ai/vm0/issues/5259)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.77.1

## [0.121.0](https://github.com/vm0-ai/vm0/compare/platform-v0.120.0...platform-v0.121.0) (2026-03-17)


### Features

* add org/personal tabs for model provider settings ([#5214](https://github.com/vm0-ai/vm0/issues/5214)) ([d035f1d](https://github.com/vm0-ai/vm0/commit/d035f1d7b372f07c6054e27fd71b2ac437f8bb26))


### Bug Fixes

* add cache and security headers to platform vercel.json ([#5218](https://github.com/vm0-ai/vm0/issues/5218)) ([6aae552](https://github.com/vm0-ai/vm0/commit/6aae55282c1a8e797f25d7b2a3d6a04f3230f0b2)), closes [#5208](https://github.com/vm0-ai/vm0/issues/5208)


### Refactoring

* move platform public assets to colocated imports and remove unused files ([#5225](https://github.com/vm0-ai/vm0/issues/5225)) ([07ade10](https://github.com/vm0-ai/vm0/commit/07ade10d4beab290e3c3d9985f2fbfdba2d3554f)), closes [#5223](https://github.com/vm0-ai/vm0/issues/5223)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.77.0

## [0.120.0](https://github.com/vm0-ai/vm0/compare/platform-v0.119.0...platform-v0.120.0) (2026-03-17)


### Features

* add scope field to merged model provider list endpoint ([#5182](https://github.com/vm0-ai/vm0/issues/5182)) ([2b3d4ef](https://github.com/vm0-ai/vm0/commit/2b3d4ef87af7ba9831ffb34ba2a207d1114decc6))


### Bug Fixes

* improve slack connect flow with loading state, install DM, and org check ([#5153](https://github.com/vm0-ai/vm0/issues/5153)) ([6f4f1f5](https://github.com/vm0-ai/vm0/commit/6f4f1f57214216477ebdb4b53d01de4cca0c924c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.76.0

## [0.119.0](https://github.com/vm0-ai/vm0/compare/platform-v0.118.1...platform-v0.119.0) (2026-03-17)


### Features

* integrate lighthouse ci audits for web and platform homepages ([#5139](https://github.com/vm0-ai/vm0/issues/5139)) ([dd9f570](https://github.com/vm0-ai/vm0/commit/dd9f570eafda6b8a740c51a95db3fa9ecf7ab077))

## [0.118.1](https://github.com/vm0-ai/vm0/compare/platform-v0.118.0...platform-v0.118.1) (2026-03-17)


### Refactoring

* **platform:** remove /zero prefix from all platform routes ([#5155](https://github.com/vm0-ai/vm0/issues/5155)) ([228b4dd](https://github.com/vm0-ai/vm0/commit/228b4dd81efe36be51606f695057bf20c4aba034))

## [0.118.0](https://github.com/vm0-ai/vm0/compare/platform-v0.117.0...platform-v0.118.0) (2026-03-17)


### Features

* add user settings ui for gdpr data export ([#5152](https://github.com/vm0-ai/vm0/issues/5152)) ([46c8c96](https://github.com/vm0-ai/vm0/commit/46c8c960ad1ab6969ba04b11fa61d1f914ea12d5))
* **platform:** add talk route for url-driven agent chat selection ([#5098](https://github.com/vm0-ai/vm0/issues/5098)) ([34b6800](https://github.com/vm0-ai/vm0/commit/34b68005429fcfbede85fed2d55e8f54fd7a9ae1))


### Refactoring

* return display name from logs api instead of frontend mapping ([#5150](https://github.com/vm0-ai/vm0/issues/5150)) ([92d7877](https://github.com/vm0-ai/vm0/commit/92d787709fabc58b557a807749cf9d261bac707b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.75.0

## [0.117.0](https://github.com/vm0-ai/vm0/compare/platform-v0.116.3...platform-v0.117.0) (2026-03-17)


### Features

* add chat threads for instant sidebar and stable url routing ([#5102](https://github.com/vm0-ai/vm0/issues/5102)) ([c902c8c](https://github.com/vm0-ai/vm0/commit/c902c8c892f93e3496c94a5fda0e835b1957086d))
* add needs-reconnect flag for connector token refresh failures ([#5128](https://github.com/vm0-ai/vm0/issues/5128)) ([5da9c4e](https://github.com/vm0-ai/vm0/commit/5da9c4e15385589a41a49007dfc2b0009f58bbe8))


### Bug Fixes

* compare with zeroChatThreadId$ and add loading guard. ([c902c8c](https://github.com/vm0-ai/vm0/commit/c902c8c892f93e3496c94a5fda0e835b1957086d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.74.0

## [0.116.3](https://github.com/vm0-ai/vm0/compare/platform-v0.116.2...platform-v0.116.3) (2026-03-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.73.0

## [0.116.2](https://github.com/vm0-ai/vm0/compare/platform-v0.116.1...platform-v0.116.2) (2026-03-17)


### Bug Fixes

* abort in-flight polling when switching or starting new zero session ([#5087](https://github.com/vm0-ai/vm0/issues/5087)) ([286df7f](https://github.com/vm0-ai/vm0/commit/286df7f6f73770d01e7eb8a18ac8a2245d4b6807))
* **platform:** navigate to /zero on org switch instead of reloading ([#5090](https://github.com/vm0-ai/vm0/issues/5090)) ([f85fbbb](https://github.com/vm0-ai/vm0/commit/f85fbbb008aac047eb9d663afe6629615bc81f65))


### Refactoring

* remove all non-zero platform pages and feature flag ([#5095](https://github.com/vm0-ai/vm0/issues/5095)) ([fa7f011](https://github.com/vm0-ai/vm0/commit/fa7f01187b84d7046b150f46f217c191d5ad5670))
* route connector deep links to /zero/team/:name instead of /zero/meet ([#5023](https://github.com/vm0-ai/vm0/issues/5023)) ([42f5c63](https://github.com/vm0-ai/vm0/commit/42f5c63f7402081c7821597acb802820f4abb98b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.72.2

## [0.116.1](https://github.com/vm0-ai/vm0/compare/platform-v0.116.0...platform-v0.116.1) (2026-03-17)


### Refactoring

* use link components instead of buttons in zero pages ([#5062](https://github.com/vm0-ai/vm0/issues/5062)) ([cf093ad](https://github.com/vm0-ai/vm0/commit/cf093adcaf66844fb9a5f1926c43e9d6fc8478c0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.72.1

## [0.116.0](https://github.com/vm0-ai/vm0/compare/platform-v0.115.0...platform-v0.116.0) (2026-03-16)


### Features

* improve zero page with markdown theming, avatar overrides, and navigation ([#5065](https://github.com/vm0-ai/vm0/issues/5065)) ([5ca5a04](https://github.com/vm0-ai/vm0/commit/5ca5a0441b1019516b7a64baa8ca695863581686))

## [0.115.0](https://github.com/vm0-ai/vm0/compare/platform-v0.114.3...platform-v0.115.0) (2026-03-16)


### Features

* add vercel ai gateway as staff-only model provider ([#5032](https://github.com/vm0-ai/vm0/issues/5032)) ([53b5845](https://github.com/vm0-ai/vm0/commit/53b5845a8903721ea0d6dbafcd2815641552f254)), closes [#5029](https://github.com/vm0-ai/vm0/issues/5029)
* **platform:** zero app v4 ui polish and refinements ([#4995](https://github.com/vm0-ai/vm0/issues/4995)) ([a8cd2dc](https://github.com/vm0-ai/vm0/commit/a8cd2dcec8678d25090df5b155446f612e4a3868))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.72.0

## [0.114.3](https://github.com/vm0-ai/vm0/compare/platform-v0.114.2...platform-v0.114.3) (2026-03-16)


### Bug Fixes

* model provider auto-default, onboarding, profile save, and slack install flow ([#4967](https://github.com/vm0-ai/vm0/issues/4967)) ([5d6c132](https://github.com/vm0-ai/vm0/commit/5d6c1327f8f4f41fa44bf5753030db67867d0a75))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.71.3

## [0.114.2](https://github.com/vm0-ai/vm0/compare/platform-v0.114.1...platform-v0.114.2) (2026-03-16)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.71.2

## [0.114.1](https://github.com/vm0-ai/vm0/compare/platform-v0.114.0...platform-v0.114.1) (2026-03-16)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.71.1

## [0.114.0](https://github.com/vm0-ai/vm0/compare/platform-v0.113.2...platform-v0.114.0) (2026-03-16)


### Features

* configurable send mode preference (enter vs cmd+enter) ([#4953](https://github.com/vm0-ai/vm0/issues/4953)) ([d8a43b8](https://github.com/vm0-ai/vm0/commit/d8a43b846595cf4beec259e50400e3d3ccd04a62))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.71.0

## [0.113.2](https://github.com/vm0-ai/vm0/compare/platform-v0.113.1...platform-v0.113.2) (2026-03-16)


### Bug Fixes

* hide credit and invite buttons from chat page ([#4954](https://github.com/vm0-ai/vm0/issues/4954)) ([459eeb7](https://github.com/vm0-ai/vm0/commit/459eeb789bd648120e584768faa21a6a377384d9))
* use last-loadable pattern, filter orphan connectors, and flex run result schema ([#4943](https://github.com/vm0-ai/vm0/issues/4943)) ([f5c6234](https://github.com/vm0-ai/vm0/commit/f5c623434401b0265912b325ebb44afc25d92027))


### Refactoring

* remove leftover "shared agent" terminology from tests and comments ([#4950](https://github.com/vm0-ai/vm0/issues/4950)) ([f9a01ff](https://github.com/vm0-ai/vm0/commit/f9a01ffcfda2dc5edec86733e7a3db4ca5a070a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.70.0

## [0.113.1](https://github.com/vm0-ai/vm0/compare/platform-v0.113.0...platform-v0.113.1) (2026-03-16)


### Bug Fixes

* activity detail auth alignment and platform team endpoint ([#4933](https://github.com/vm0-ai/vm0/issues/4933)) ([fbfdb1d](https://github.com/vm0-ai/vm0/commit/fbfdb1dff690271bdfb6927d4deca852439cf624))


### Refactoring

* remove server-side acl permission system and shared agent ui ([#4881](https://github.com/vm0-ai/vm0/issues/4881)) ([123c1cf](https://github.com/vm0-ai/vm0/commit/123c1cf5dd28cb7e9b5980ad1dfc97d052b4ce8f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.69.1

## [0.113.0](https://github.com/vm0-ai/vm0/compare/platform-v0.112.0...platform-v0.113.0) (2026-03-16)


### Features

* add per-schedule notification control ([#4885](https://github.com/vm0-ai/vm0/issues/4885)) ([904cdfb](https://github.com/vm0-ai/vm0/commit/904cdfb0fd6f8ce241420b288cc43860ba1c55f0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.69.0

## [0.112.0](https://github.com/vm0-ai/vm0/compare/platform-v0.111.0...platform-v0.112.0) (2026-03-16)


### Features

* add model provider tracking and org-scoped logs/schedules ([#4909](https://github.com/vm0-ai/vm0/issues/4909)) ([dc0de67](https://github.com/vm0-ai/vm0/commit/dc0de673b2e78eec803a3051148f1947dc292945))
* **platform:** unify border styling and refine ui consistency across zero app ([#4863](https://github.com/vm0-ai/vm0/issues/4863)) ([f232a8b](https://github.com/vm0-ai/vm0/commit/f232a8bad9e20f1ebb02217d7db325f8476e39ab))


### Refactoring

* improve zero onboarding post-completion navigation ([#4908](https://github.com/vm0-ai/vm0/issues/4908)) ([c3d95b8](https://github.com/vm0-ai/vm0/commit/c3d95b884fcece0a3a73d8128469e6f81a7cc650))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.68.0

## [0.111.0](https://github.com/vm0-ai/vm0/compare/platform-v0.110.1...platform-v0.111.0) (2026-03-16)


### Features

* enable multi-account switching in production ([#4868](https://github.com/vm0-ai/vm0/issues/4868)) ([4ee375d](https://github.com/vm0-ai/vm0/commit/4ee375d3f6f5ac66385154a6bf1cc2c2ea8d234c))
* **slack:** add platform ui for org-aware slack integration ([#4715](https://github.com/vm0-ai/vm0/issues/4715)) ([deb9179](https://github.com/vm0-ai/vm0/commit/deb9179480bd318d4b91e8b7a87354ffbaa89564))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.67.0

## [0.110.1](https://github.com/vm0-ai/vm0/compare/platform-v0.110.0...platform-v0.110.1) (2026-03-16)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.66.1

## [0.110.0](https://github.com/vm0-ai/vm0/compare/platform-v0.109.5...platform-v0.110.0) (2026-03-16)


### Features

* **platform:** zero app v4 ui overhaul ([#4820](https://github.com/vm0-ai/vm0/issues/4820)) ([f219ec6](https://github.com/vm0-ai/vm0/commit/f219ec6d4a664ffef660e060647d1e577bd5212a))

## [0.109.5](https://github.com/vm0-ai/vm0/compare/platform-v0.109.4...platform-v0.109.5) (2026-03-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.66.0

## [0.109.4](https://github.com/vm0-ai/vm0/compare/platform-v0.109.3...platform-v0.109.4) (2026-03-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.65.1

## [0.109.3](https://github.com/vm0-ai/vm0/compare/platform-v0.109.2...platform-v0.109.3) (2026-03-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.65.0

## [0.109.2](https://github.com/vm0-ai/vm0/compare/platform-v0.109.1...platform-v0.109.2) (2026-03-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.64.0

## [0.109.1](https://github.com/vm0-ai/vm0/compare/platform-v0.109.0...platform-v0.109.1) (2026-03-13)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.63.0

## [0.109.0](https://github.com/vm0-ai/vm0/compare/platform-v0.108.0...platform-v0.109.0) (2026-03-13)


### Features

* **zero:** add pinned agents, agent switching, and per-agent sessions ([#4727](https://github.com/vm0-ai/vm0/issues/4727)) ([d3ee3af](https://github.com/vm0-ai/vm0/commit/d3ee3af19e34c583efc8f9b6b4da1bf48de9f0fb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.62.0

## [0.108.0](https://github.com/vm0-ai/vm0/compare/platform-v0.107.4...platform-v0.108.0) (2026-03-13)


### Features

* **platform:** upgrade vite from v6 to v7 ([#4728](https://github.com/vm0-ai/vm0/issues/4728)) ([9dd617e](https://github.com/vm0-ai/vm0/commit/9dd617e27990ea52a93c5502b8ed9e946941e3e9)), closes [#4716](https://github.com/vm0-ai/vm0/issues/4716)


### Bug Fixes

* update platform to send ?org= and clean up remaining scope references ([#4690](https://github.com/vm0-ai/vm0/issues/4690)) ([3788240](https://github.com/vm0-ai/vm0/commit/37882409b710bea326429c5bf3cf5f2d944abfd2))


### Refactoring

* eliminate remaining scope references ([#4703](https://github.com/vm0-ai/vm0/issues/4703)) ([fd85a3b](https://github.com/vm0-ai/vm0/commit/fd85a3b6b4f4fe10eb0ff36a1f5140888d9a57f1))
* eliminate scope references in web, platform, and tests ([#4700](https://github.com/vm0-ai/vm0/issues/4700)) ([7451fc6](https://github.com/vm0-ai/vm0/commit/7451fc6bcb062d1163179667fff656cc55c182e9)), closes [#4693](https://github.com/vm0-ai/vm0/issues/4693)
* rename scope wire format to org across all packages ([#4656](https://github.com/vm0-ai/vm0/issues/4656)) ([43ac1f3](https://github.com/vm0-ai/vm0/commit/43ac1f30220a0d285b639f35cacaac842bccd5ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.61.0

## [0.107.4](https://github.com/vm0-ai/vm0/compare/platform-v0.107.3...platform-v0.107.4) (2026-03-13)


### Bug Fixes

* **platform:** increase compose job polling timeout and handle onboarding errors ([#4655](https://github.com/vm0-ai/vm0/issues/4655)) ([215bfe1](https://github.com/vm0-ai/vm0/commit/215bfe19a82d001f897239a4af959782f0f9dcc5)), closes [#4654](https://github.com/vm0-ai/vm0/issues/4654)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.60.0

## [0.107.3](https://github.com/vm0-ai/vm0/compare/platform-v0.107.2...platform-v0.107.3) (2026-03-13)


### Refactoring

* **platform:** rename internal scope variables and signals to org ([#4644](https://github.com/vm0-ai/vm0/issues/4644)) ([f8abd64](https://github.com/vm0-ai/vm0/commit/f8abd64f563dab3f36f63e09a7b361ca0c1e2d9e))

## [0.107.2](https://github.com/vm0-ai/vm0/compare/platform-v0.107.1...platform-v0.107.2) (2026-03-12)


### Refactoring

* rename scope to org in platform frontend signals and mocks ([#4618](https://github.com/vm0-ai/vm0/issues/4618)) ([f84f3c7](https://github.com/vm0-ai/vm0/commit/f84f3c73b4319593ac9a2bf83a98823c8e9bf5c9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.59.2

## [0.107.1](https://github.com/vm0-ai/vm0/compare/platform-v0.107.0...platform-v0.107.1) (2026-03-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.59.1

## [0.107.0](https://github.com/vm0-ai/vm0/compare/platform-v0.106.1...platform-v0.107.0) (2026-03-12)


### Features

* **platform:** wire zero schedule page to real api calls ([#4589](https://github.com/vm0-ai/vm0/issues/4589)) ([b1cb54c](https://github.com/vm0-ai/vm0/commit/b1cb54c765b6d2c8ebde756e89608615555e0785))
* **zero:** add recent chat sidebar, file attachments, and session switching ([#4582](https://github.com/vm0-ai/vm0/issues/4582)) ([d460861](https://github.com/vm0-ai/vm0/commit/d4608610fa4eda2ffa8ff53663187f430987283c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.59.0

## [0.106.1](https://github.com/vm0-ai/vm0/compare/platform-v0.106.0...platform-v0.106.1) (2026-03-12)


### Refactoring

* reuse grouped message components in zero activity detail ([#4525](https://github.com/vm0-ai/vm0/issues/4525)) ([a6b4f1e](https://github.com/vm0-ai/vm0/commit/a6b4f1ec48f38b2156900d869cab3b5b24a42b39))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.58.3

## [0.106.0](https://github.com/vm0-ai/vm0/compare/platform-v0.105.1...platform-v0.106.0) (2026-03-12)


### Features

* **zero:** add settings page, deferred skill saving, and onboarding improvements ([#4511](https://github.com/vm0-ai/vm0/issues/4511)) ([7452cd8](https://github.com/vm0-ai/vm0/commit/7452cd8e6c99f66765e6346eface7305a25b6b5f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.58.2

## [0.105.1](https://github.com/vm0-ai/vm0/compare/platform-v0.105.0...platform-v0.105.1) (2026-03-12)


### Refactoring

* add extract-and-group-variables convenience function ([#4517](https://github.com/vm0-ai/vm0/issues/4517)) ([fe13128](https://github.com/vm0-ai/vm0/commit/fe13128c1a0b0e619c9a585867c3d3f5f81e2f9b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.58.1

## [0.105.0](https://github.com/vm0-ai/vm0/compare/platform-v0.104.0...platform-v0.105.0) (2026-03-12)


### Features

* fix agent connections page to handle api-token connectors and unify layout ([#4480](https://github.com/vm0-ai/vm0/issues/4480)) ([9b55546](https://github.com/vm0-ai/vm0/commit/9b55546c85671b811130010c5cb32b7bc878cf3b))
* **zero:** enhance schedule management with toggle, calendar, and multi-day support ([#4374](https://github.com/vm0-ai/vm0/issues/4374)) ([75b1539](https://github.com/vm0-ai/vm0/commit/75b1539e929a2d83b858d88e77f7cf05df97c197))
* **zero:** implement chat with real agent run pipeline ([#4384](https://github.com/vm0-ai/vm0/issues/4384)) ([d832baf](https://github.com/vm0-ai/vm0/commit/d832baf5e6b54dc7855d45a157050fde71837cb2))


### Bug Fixes

* address semgrep sast findings for casa tier 2 compliance ([#4487](https://github.com/vm0-ai/vm0/issues/4487)) ([e900299](https://github.com/vm0-ai/vm0/commit/e9002997cf58e7424344f6c494cac25faee07641)), closes [#4422](https://github.com/vm0-ai/vm0/issues/4422)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.58.0

## [0.104.0](https://github.com/vm0-ai/vm0/compare/platform-v0.103.0...platform-v0.104.0) (2026-03-11)


### Features

* add explorium api-token connector ([#4404](https://github.com/vm0-ai/vm0/issues/4404)) ([27113d0](https://github.com/vm0-ai/vm0/commit/27113d0908d2c2d2608307e06b7d69d8a9e1853c))
* add fireflies api-token connector ([#4378](https://github.com/vm0-ai/vm0/issues/4378)) ([c3f0156](https://github.com/vm0-ai/vm0/commit/c3f01564303aea49597df043e8582ee466a249a8))
* add granola api-token connector ([#4413](https://github.com/vm0-ai/vm0/issues/4413)) ([28b8605](https://github.com/vm0-ai/vm0/commit/28b8605983b604539f05877634eb06f29b365fda))
* add jam api-token connector ([#4421](https://github.com/vm0-ai/vm0/issues/4421)) ([73b8a98](https://github.com/vm0-ai/vm0/commit/73b8a98912ca3c7ce65c698d4d1a928f8fc600a0))
* add jotform api-token connector ([#4387](https://github.com/vm0-ai/vm0/issues/4387)) ([72407b5](https://github.com/vm0-ai/vm0/commit/72407b562785cdaa238c23feed05e0235ea5f619))
* add metabase api-token connector ([#4399](https://github.com/vm0-ai/vm0/issues/4399)) ([29061c6](https://github.com/vm0-ai/vm0/commit/29061c676f0816b1322fe386250878f74787ebe4))
* add prisma-postgres api-token connector ([#4375](https://github.com/vm0-ai/vm0/issues/4375)) ([86fd6e6](https://github.com/vm0-ai/vm0/commit/86fd6e6d2b7dc63a99f1bdcbad17bc79c8335900))
* add revenuecat api-token connector ([#4368](https://github.com/vm0-ai/vm0/issues/4368)) ([8eddaa5](https://github.com/vm0-ai/vm0/commit/8eddaa5678095b03896c42d750049fe882fc207c))
* add tldv api-token connector ([#4383](https://github.com/vm0-ai/vm0/issues/4383)) ([fb67e47](https://github.com/vm0-ai/vm0/commit/fb67e475455dfdb2527bbaaba945b031920980bb))
* add zapier api-token connector ([#4401](https://github.com/vm0-ai/vm0/issues/4401)) ([b1a7f52](https://github.com/vm0-ai/vm0/commit/b1a7f52da40763510e4b64014fd6f21025608387))
* inject agent metadata into instructions as frontmatter during compose ([#4382](https://github.com/vm0-ai/vm0/issues/4382)) ([c9e4c02](https://github.com/vm0-ai/vm0/commit/c9e4c02ce0bea2182f14269856f21222a5b0d94f))
* **platform:** add agent metadata and improve meet settings ([#4351](https://github.com/vm0-ai/vm0/issues/4351)) ([8e6a34c](https://github.com/vm0-ai/vm0/commit/8e6a34cbf5efecf52b94a4f495a174f2aa5f27ac))
* **zero:** wire activities page with real logs api ([#4358](https://github.com/vm0-ai/vm0/issues/4358)) ([cbeec6b](https://github.com/vm0-ai/vm0/commit/cbeec6b48ea91832c1af8f2c8f98484765a9a7b1))


### Bug Fixes

* hide connector-managed secrets from custom api section ([#4367](https://github.com/vm0-ai/vm0/issues/4367)) ([147c144](https://github.com/vm0-ai/vm0/commit/147c1449c3ec459f20ddd7bdb278a7f4e34b5920))


### Refactoring

* standardize connector secret names to use token convention ([#4385](https://github.com/vm0-ai/vm0/issues/4385)) ([470101f](https://github.com/vm0-ai/vm0/commit/470101f7612e95e8826653b33df819cf0de49b26))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.57.0

## [0.103.0](https://github.com/vm0-ai/vm0/compare/platform-v0.102.0...platform-v0.103.0) (2026-03-11)


### Features

* add atlassian api-token connector ([#4326](https://github.com/vm0-ai/vm0/issues/4326)) ([8bc6ee2](https://github.com/vm0-ai/vm0/commit/8bc6ee27d66094c1ac18dacf82b2b721b8d49b4f))
* add clickup api-token connector ([#4322](https://github.com/vm0-ai/vm0/issues/4322)) ([583127c](https://github.com/vm0-ai/vm0/commit/583127cd041eecb0aabba535aeba0e2af08e6778))
* add clickup skill to platform, web, and docs ([#4364](https://github.com/vm0-ai/vm0/issues/4364)) ([6410f37](https://github.com/vm0-ai/vm0/commit/6410f37478b130e54ddfd6cc7397ea9ea6555e81))
* add cloudflare api-token connector ([#4324](https://github.com/vm0-ai/vm0/issues/4324)) ([614123b](https://github.com/vm0-ai/vm0/commit/614123badce9868ffce2e83c22452314a401e2c6))
* add heygen api-token connector ([#4346](https://github.com/vm0-ai/vm0/issues/4346)) ([230d6f5](https://github.com/vm0-ai/vm0/commit/230d6f5331b04931f55f893d87aee095d2c4e345))
* add hugging-face api-token connector ([#4362](https://github.com/vm0-ai/vm0/issues/4362)) ([d1e9a14](https://github.com/vm0-ai/vm0/commit/d1e9a14e38997f4522ba00519618241945d02632))
* add intercom api-token connector ([#4332](https://github.com/vm0-ai/vm0/issues/4332)) ([a29e8dd](https://github.com/vm0-ai/vm0/commit/a29e8ddb957bf1a49e927a372ecb13eff3d4863c))
* add line api-token connector ([#4325](https://github.com/vm0-ai/vm0/issues/4325)) ([b5d65e6](https://github.com/vm0-ai/vm0/commit/b5d65e652552ee33115fd51a8e5ca4b2e384d2e6))
* add make api-token connector ([#4329](https://github.com/vm0-ai/vm0/issues/4329)) ([2d619dc](https://github.com/vm0-ai/vm0/commit/2d619dce7b7afc11620a876c4fb84cf442597d80))
* add wrike api-token connector ([#4340](https://github.com/vm0-ai/vm0/issues/4340)) ([ddd3785](https://github.com/vm0-ai/vm0/commit/ddd3785fc219ce6711ac246597b7880d3558f61d))
* **platform:** wire zero meet settings tab to real api ([#4192](https://github.com/vm0-ai/vm0/issues/4192)) ([b5f8525](https://github.com/vm0-ai/vm0/commit/b5f8525c560b692967359ee7f66c2490e4362e61))
* **zero:** wire meet page instructions tab to real api ([#4197](https://github.com/vm0-ai/vm0/issues/4197)) ([1e2816e](https://github.com/vm0-ai/vm0/commit/1e2816edffced4603abaa30bef170ac093a98626))
* **zero:** wire meet page schedule tab to real API ([#4196](https://github.com/vm0-ai/vm0/issues/4196)) ([82f2b2d](https://github.com/vm0-ai/vm0/commit/82f2b2ddffbd9910e72c3f4bb7fc1654d50d01b5))


### Bug Fixes

* prevent zero meet skills list flash and spurious auth reloads ([#4338](https://github.com/vm0-ai/vm0/issues/4338)) ([f18942b](https://github.com/vm0-ai/vm0/commit/f18942b08853dc455ee57fe0a4fe8dbc18f33b76))


### Refactoring

* remove legacy credential concept entirely ([#4345](https://github.com/vm0-ai/vm0/issues/4345)) ([13919fe](https://github.com/vm0-ai/vm0/commit/13919fe66518807d6598a202033af74a562fbf0b))
* rename skill references from dev.to/fal.ai to devto/fal ([#4347](https://github.com/vm0-ai/vm0/issues/4347)) ([0b86ca4](https://github.com/vm0-ai/vm0/commit/0b86ca4e3a8aa9ec153c4c15f495450cab027be1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.56.0

## [0.102.0](https://github.com/vm0-ai/vm0/compare/platform-v0.101.1...platform-v0.102.0) (2026-03-11)


### Features

* add 8 api-token connectors in batch ([#4315](https://github.com/vm0-ai/vm0/issues/4315)) ([f97b48a](https://github.com/vm0-ai/vm0/commit/f97b48a8f870f496ed13015d3e28fa7bbab9f463))
* add chatwoot connector with api token authentication ([#4254](https://github.com/vm0-ai/vm0/issues/4254)) ([e421500](https://github.com/vm0-ai/vm0/commit/e421500d107ff5e1852f100b88ed103e40a9a12d))
* add deepseek connector with api key authentication ([#4246](https://github.com/vm0-ai/vm0/issues/4246)) ([a6486ce](https://github.com/vm0-ai/vm0/commit/a6486ced94ae2da8735fc74970e8bf0e9305485e))
* add dev.to api-token connector ([#4257](https://github.com/vm0-ai/vm0/issues/4257)) ([327703f](https://github.com/vm0-ai/vm0/commit/327703f7ae7e1e83abb1cfb95f8eebe94d738450))
* add dify api-token connector ([#4320](https://github.com/vm0-ai/vm0/issues/4320)) ([fca1b95](https://github.com/vm0-ai/vm0/commit/fca1b95939a7327da9ef37667da53f108f0ccd65))
* add elevenlabs api-token connector ([#4250](https://github.com/vm0-ai/vm0/issues/4250)) ([09f4258](https://github.com/vm0-ai/vm0/commit/09f425850da50466ddf7c95cb0c5fedb9daf114b))
* add fal.ai connector for ai model execution ([#4247](https://github.com/vm0-ai/vm0/issues/4247)) ([9a90bdb](https://github.com/vm0-ai/vm0/commit/9a90bdbecc7f67f7924ef8ec2513eb611c42b51d))
* add minimax connector ([#4248](https://github.com/vm0-ai/vm0/issues/4248)) ([f388dfc](https://github.com/vm0-ai/vm0/commit/f388dfc36fa3b27aeac8801adf7d57a13aea0a93))
* add openai connector with api key authentication ([#4251](https://github.com/vm0-ai/vm0/issues/4251)) ([c2c6b16](https://github.com/vm0-ai/vm0/commit/c2c6b16105c812a97db9700561716dfccd50b62e))
* add organization selection page after sign-in/sign-up ([#4161](https://github.com/vm0-ai/vm0/issues/4161)) ([d360bea](https://github.com/vm0-ai/vm0/commit/d360bea6e4c01cd5aef71271099bc3b56999f29b))
* add pdf4me connector with api token authentication ([#4260](https://github.com/vm0-ai/vm0/issues/4260)) ([8995cf4](https://github.com/vm0-ai/vm0/commit/8995cf4c352f5fa315f028a56e8e9b0f18f09670))
* add pdfco connector with api key authentication ([#4259](https://github.com/vm0-ai/vm0/issues/4259)) ([e98abf5](https://github.com/vm0-ai/vm0/commit/e98abf53d9c64ea9b04eea38840674328d6af11f))
* add perplexity connector with api key authentication ([#4249](https://github.com/vm0-ai/vm0/issues/4249)) ([1b55c46](https://github.com/vm0-ai/vm0/commit/1b55c46798f7ae99ec63995bff5b3b5b918a4677))
* add podchaser connector with api token authentication ([#4261](https://github.com/vm0-ai/vm0/issues/4261)) ([b20c28a](https://github.com/vm0-ai/vm0/commit/b20c28a37fbc62b9c1cb622e1f1c4fa41963c820))
* add pushinator api-token connector ([#4278](https://github.com/vm0-ai/vm0/issues/4278)) ([d905bf1](https://github.com/vm0-ai/vm0/commit/d905bf10aae155a9d1d7e59f887ffcd8bc0dd9ce)), closes [#4262](https://github.com/vm0-ai/vm0/issues/4262)
* add qdrant api-token connector ([#4300](https://github.com/vm0-ai/vm0/issues/4300)) ([72c0cab](https://github.com/vm0-ai/vm0/commit/72c0cab8812b5841a3f21d1235729007346ff20a)), closes [#4263](https://github.com/vm0-ai/vm0/issues/4263)
* add qiita api-token connector ([#4301](https://github.com/vm0-ai/vm0/issues/4301)) ([93ce728](https://github.com/vm0-ai/vm0/commit/93ce72858d43d332b7c65a970266176b9e086576)), closes [#4264](https://github.com/vm0-ai/vm0/issues/4264)
* add reportei api-token connector ([#4303](https://github.com/vm0-ai/vm0/issues/4303)) ([44717e3](https://github.com/vm0-ai/vm0/commit/44717e33a0c1b2138efe28ce4a5e5270d00f214c))
* add serpapi api-token connector ([#4305](https://github.com/vm0-ai/vm0/issues/4305)) ([4adade6](https://github.com/vm0-ai/vm0/commit/4adade60428328ef0caa53ddda1a7a87c94c24e7))
* add web scraping and browser automation connectors ([#4258](https://github.com/vm0-ai/vm0/issues/4258)) ([d168594](https://github.com/vm0-ai/vm0/commit/d1685943f8c7ee979d2a06f5995d5ad1b2de8b77))
* add zendesk api-token connector ([#4319](https://github.com/vm0-ai/vm0/issues/4319)) ([e442fed](https://github.com/vm0-ai/vm0/commit/e442fed3f9d2a1bf8e081a6de719b38019c9cb6a))
* add zeptomail connector ([#4255](https://github.com/vm0-ai/vm0/issues/4255)) ([55fe174](https://github.com/vm0-ai/vm0/commit/55fe17453dfc912f34e0d3d3444dc77650d1d0d3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.55.0

## [0.101.1](https://github.com/vm0-ai/vm0/compare/platform-v0.101.0...platform-v0.101.1) (2026-03-10)


### Bug Fixes

* preserve line breaks in connection dialog help text ([#4205](https://github.com/vm0-ai/vm0/issues/4205)) ([9f08620](https://github.com/vm0-ai/vm0/commit/9f086209a40fd7d1297fb40673463f0eb9dd05e6))
* resolve circular type reference in connector types ([#4207](https://github.com/vm0-ai/vm0/issues/4207)) ([37594f9](https://github.com/vm0-ai/vm0/commit/37594f901bf3fb26782d87427035b75149a1737c))


### Refactoring

* inline connector feature flags into connector types config ([#4203](https://github.com/vm0-ai/vm0/issues/4203)) ([99168e3](https://github.com/vm0-ai/vm0/commit/99168e3f8e253c3488112f822111c2e66af152dd))
* update connector token submission to use secrets api ([#4201](https://github.com/vm0-ai/vm0/issues/4201)) ([a431829](https://github.com/vm0-ai/vm0/commit/a4318296f433c98aae9eccb063bdd6e01275eb13))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.54.1

## [0.101.0](https://github.com/vm0-ai/vm0/compare/platform-v0.100.0...platform-v0.101.0) (2026-03-10)


### Features

* add agentmail connector (api-token only) ([#4181](https://github.com/vm0-ai/vm0/issues/4181)) ([72eb5b1](https://github.com/vm0-ai/vm0/commit/72eb5b1952fc7ef0119bcfe01edc047e0791676b))
* add axiom connector with api token auth ([#4182](https://github.com/vm0-ai/vm0/issues/4182)) ([d7586c4](https://github.com/vm0-ai/vm0/commit/d7586c4579e0d84fe618c4559c1b4c4621dc7a15))
* add experimental label to connectors with feature flag but no api-token auth ([#4177](https://github.com/vm0-ai/vm0/issues/4177)) ([3be4a4e](https://github.com/vm0-ai/vm0/commit/3be4a4e5f2e79d32e819ebc288bc66e10acf3d4f))
* add plausible analytics connector ([#4178](https://github.com/vm0-ai/vm0/issues/4178)) ([da9b451](https://github.com/vm0-ai/vm0/commit/da9b4517edc58c3db5f200958db760680971e049))
* add productlane connector with api-token auth ([#4183](https://github.com/vm0-ai/vm0/issues/4183)) ([ea7f8db](https://github.com/vm0-ai/vm0/commit/ea7f8db0dd3fae77091c97155d9524d587ccdb5c))
* add resend connector with api key authentication ([#4191](https://github.com/vm0-ai/vm0/issues/4191)) ([dc32ab8](https://github.com/vm0-ai/vm0/commit/dc32ab88eeb0c4f052458b5f3ab094bb7bf46b53))
* **platform:** add real connector integration to zero meet page connections tab ([#4179](https://github.com/vm0-ai/vm0/issues/4179)) ([55a0421](https://github.com/vm0-ai/vm0/commit/55a04216771362e6e5e87fa047eb2039d3cc6e24))
* wire zero onboarding to real api calls ([#4128](https://github.com/vm0-ai/vm0/issues/4128)) ([b756f8a](https://github.com/vm0-ai/vm0/commit/b756f8aab13d8b5ebf5e8383e96538fd0d980d61))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.54.0

## [0.100.0](https://github.com/vm0-ai/vm0/compare/platform-v0.99.0...platform-v0.100.0) (2026-03-10)


### Features

* **platform:** add account switching and org switcher to zero sidebar ([#4139](https://github.com/vm0-ai/vm0/issues/4139)) ([17ecf9d](https://github.com/vm0-ai/vm0/commit/17ecf9d7cb154bb05bf065fa2489bab959196257))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.53.0

## [0.99.0](https://github.com/vm0-ai/vm0/compare/platform-v0.98.0...platform-v0.99.0) (2026-03-10)


### Features

* add ahrefs connector with api-token and oauth auth methods ([#4113](https://github.com/vm0-ai/vm0/issues/4113)) ([5c282b8](https://github.com/vm0-ai/vm0/commit/5c282b80719758dc0734f9c59d525934b03a366f))
* add mailchimp connector with oauth and api key auth ([#4116](https://github.com/vm0-ai/vm0/issues/4116)) ([eb72755](https://github.com/vm0-ai/vm0/commit/eb72755110adfe18e7f90ac07ecd59cc6038fe9f))
* add similarweb connector with api key authentication ([#4106](https://github.com/vm0-ai/vm0/issues/4106)) ([ae97fdb](https://github.com/vm0-ai/vm0/commit/ae97fdb399f28100780ca232e3023ff2f31a61b9))
* enable asana connector for all users ([#4111](https://github.com/vm0-ai/vm0/issues/4111)) ([a961c9b](https://github.com/vm0-ai/vm0/commit/a961c9b7688153599afda2da79231f2d310397ac))


### Refactoring

* **platform:** enforce no-package-variable lint rule for zero pages ([#4110](https://github.com/vm0-ai/vm0/issues/4110)) ([671eec4](https://github.com/vm0-ai/vm0/commit/671eec470c9ef918ead1fd0f9b857a5f8e6147ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.52.0

## [0.98.0](https://github.com/vm0-ai/vm0/compare/platform-v0.97.0...platform-v0.98.0) (2026-03-10)


### Features

* **platform:** add organization switching to zero page sidebar ([#4064](https://github.com/vm0-ai/vm0/issues/4064)) ([03fc6af](https://github.com/vm0-ai/vm0/commit/03fc6aff684efc65235dc74fe2ec689776bb8b05))


### Bug Fixes

* **platform:** hide about/pricing/sign-in card when user is logged in ([#4062](https://github.com/vm0-ai/vm0/issues/4062)) ([3a3ee35](https://github.com/vm0-ai/vm0/commit/3a3ee357a67fdd09f36c3152ce3f5c9d6755befd))


### Refactoring

* align remaining scope terminology with resource model ([#4094](https://github.com/vm0-ai/vm0/issues/4094)) ([e4df6c9](https://github.com/vm0-ai/vm0/commit/e4df6c96f84ef0e0e1393215a08122bf83a73a21))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.51.0

## [0.97.0](https://github.com/vm0-ai/vm0/compare/platform-v0.96.0...platform-v0.97.0) (2026-03-09)


### Features

* add close crm connector integration ([#4056](https://github.com/vm0-ai/vm0/issues/4056)) ([08134ea](https://github.com/vm0-ai/vm0/commit/08134ea6a8e90139eb55ed776e75b0ce3d97869f))
* add multi-auth method support for connectors ([#4053](https://github.com/vm0-ai/vm0/issues/4053)) ([b89cbdc](https://github.com/vm0-ai/vm0/commit/b89cbdcac841824b20feb93c50afdfb216a1d9ff))
* add outlook calendar connector with microsoft oauth ([#4059](https://github.com/vm0-ai/vm0/issues/4059)) ([5a6572d](https://github.com/vm0-ai/vm0/commit/5a6572d01028177e22215646eb9c32ab28464343))


### Refactoring

* remove self-hosting feature and restore saas-only mode ([#4051](https://github.com/vm0-ai/vm0/issues/4051)) ([5dcac9d](https://github.com/vm0-ai/vm0/commit/5dcac9d3374e78eb263d180faef9ee2909e34dcb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.50.0

## [0.96.0](https://github.com/vm0-ai/vm0/compare/platform-v0.95.0...platform-v0.96.0) (2026-03-09)


### Features

* add asana oauth connector integration ([#4066](https://github.com/vm0-ai/vm0/issues/4066)) ([488c35d](https://github.com/vm0-ai/vm0/commit/488c35d1bf8ff0fdf60730f5989c39c8433d1ba2))
* add meta ads oauth connector integration ([#4058](https://github.com/vm0-ai/vm0/issues/4058)) ([f887225](https://github.com/vm0-ai/vm0/commit/f88722560ef6cc5a06259a783f3cad7cc3b65861))
* add stripe oauth connector integration ([#4054](https://github.com/vm0-ai/vm0/issues/4054)) ([c9927fc](https://github.com/vm0-ai/vm0/commit/c9927fc1ec08bd4a46f3a10770610ed4979caf2d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.49.0

## [0.95.0](https://github.com/vm0-ai/vm0/compare/platform-v0.94.1...platform-v0.95.0) (2026-03-09)


### Features

* **platform:** zero app about page, floating nav card, and UI tweaks ([#4050](https://github.com/vm0-ai/vm0/issues/4050)) ([298d772](https://github.com/vm0-ai/vm0/commit/298d7725022513564d1a9efe4d4fc2ec887e36b1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.48.0

## [0.94.1](https://github.com/vm0-ai/vm0/compare/platform-v0.94.0...platform-v0.94.1) (2026-03-09)


### Bug Fixes

* auto-create scope for new web users and consolidate scope init logic ([#4005](https://github.com/vm0-ai/vm0/issues/4005)) ([9ae59f5](https://github.com/vm0-ai/vm0/commit/9ae59f501d31f15bcb89c4f405061d83e3166ac7))
* **platform:** strip heading anchor links with escaped svg text in markdown ([#4018](https://github.com/vm0-ai/vm0/issues/4018)) ([330de10](https://github.com/vm0-ai/vm0/commit/330de1088933579260cd52ceec4a17e8d2d0edc1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.47.0

## [0.94.0](https://github.com/vm0-ai/vm0/compare/platform-v0.93.2...platform-v0.94.0) (2026-03-09)


### Features

* **platform:** zero app onboarding, Slack config dialog, and UI polish ([#3993](https://github.com/vm0-ai/vm0/issues/3993)) ([a4262f3](https://github.com/vm0-ai/vm0/commit/a4262f399bdfa21b1fd5121ac7883314a38a0ac3))


### Bug Fixes

* prevent horizontal scrollbar on logs page mobile ([#3979](https://github.com/vm0-ai/vm0/issues/3979)) ([d030ba9](https://github.com/vm0-ai/vm0/commit/d030ba9afd78c199051e56ffadd9f139394e3786))

## [0.93.2](https://github.com/vm0-ai/vm0/compare/platform-v0.93.1...platform-v0.93.2) (2026-03-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.46.0

## [0.93.1](https://github.com/vm0-ai/vm0/compare/platform-v0.93.0...platform-v0.93.1) (2026-03-07)


### Bug Fixes

* use correct storage type in memory dedup path and propagate checkpoint errors ([#3906](https://github.com/vm0-ai/vm0/issues/3906)) ([9abe586](https://github.com/vm0-ai/vm0/commit/9abe586d92126cef4fc9f7c2fa4319c7448e86dd))

## [0.93.0](https://github.com/vm0-ai/vm0/compare/platform-v0.92.1...platform-v0.93.0) (2026-03-07)


### Features

* add webflow oauth connector ([#3883](https://github.com/vm0-ai/vm0/issues/3883)) ([2024d3e](https://github.com/vm0-ai/vm0/commit/2024d3e0f570980a48685851dc1f20e93dada88c))
* remove airtable connector feature switch ([#3886](https://github.com/vm0-ai/vm0/issues/3886)) ([98dafdc](https://github.com/vm0-ai/vm0/commit/98dafdcc1057633e33973b92152ace10401c46ef))


### Bug Fixes

* **platform:** deduplicate events by sequence number to prevent unknown blocks in log detail ([#3890](https://github.com/vm0-ai/vm0/issues/3890)) ([9359771](https://github.com/vm0-ai/vm0/commit/93597717ebb0608827cd98fd90c97e53e7863a40))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.45.0

## [0.92.1](https://github.com/vm0-ai/vm0/compare/platform-v0.92.0...platform-v0.92.1) (2026-03-07)


### Bug Fixes

* use server-computed connector-provided secret names in compose warning ([#3843](https://github.com/vm0-ai/vm0/issues/3843)) ([b66c877](https://github.com/vm0-ai/vm0/commit/b66c87774aa6fd21c73878026f3d0f2e7420928b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.44.1

## [0.92.0](https://github.com/vm0-ai/vm0/compare/platform-v0.91.0...platform-v0.92.0) (2026-03-07)


### Features

* **connectors:** gate airtable connector behind internal feature switch ([#3864](https://github.com/vm0-ai/vm0/issues/3864)) ([5250661](https://github.com/vm0-ai/vm0/commit/5250661e5a48673b9f843a9d03385f7e825a163d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.44.0

## [0.91.0](https://github.com/vm0-ai/vm0/compare/platform-v0.90.0...platform-v0.91.0) (2026-03-07)


### Features

* **connector:** make airtable connector public ([#3856](https://github.com/vm0-ai/vm0/issues/3856)) ([7484935](https://github.com/vm0-ai/vm0/commit/7484935441e18ce10661f47b37eafc7d6bfc9b85))
* **connectors:** add canva oauth connector ([#3837](https://github.com/vm0-ai/vm0/issues/3837)) ([522fe59](https://github.com/vm0-ai/vm0/commit/522fe59a0dc16478ee97907c8f143e98579635c4))
* **connectors:** add hubspot oauth connector ([#3835](https://github.com/vm0-ai/vm0/issues/3835)) ([1cc3e37](https://github.com/vm0-ai/vm0/commit/1cc3e3795879b7a3988ec999ef16bca0cecd5ee9))
* **connectors:** add supabase oauth connector ([#3836](https://github.com/vm0-ai/vm0/issues/3836)) ([b7c2d2e](https://github.com/vm0-ai/vm0/commit/b7c2d2e5146de7c429113c07291886afbd1ec7b5))
* **connectors:** add todoist oauth connector ([#3850](https://github.com/vm0-ai/vm0/issues/3850)) ([7cce2b8](https://github.com/vm0-ai/vm0/commit/7cce2b89cfd5dc051d9fb0001be329ab5e17a46d))
* **connectors:** add wix oauth connector ([#3851](https://github.com/vm0-ai/vm0/issues/3851)) ([faa337d](https://github.com/vm0-ai/vm0/commit/faa337d1e4513851024cb57c3e2d1f0de09cd11a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.43.0

## [0.90.0](https://github.com/vm0-ai/vm0/compare/platform-v0.89.0...platform-v0.90.0) (2026-03-06)


### Features

* add airtable oauth connector with pkce support ([#3833](https://github.com/vm0-ai/vm0/issues/3833)) ([2e64f13](https://github.com/vm0-ai/vm0/commit/2e64f1363058e9d258073c140f9a669047321438))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.42.0

## [0.89.0](https://github.com/vm0-ai/vm0/compare/platform-v0.88.2...platform-v0.89.0) (2026-03-06)


### Features

* **platform:** add zero app with shell, schedule, and polish ([#3825](https://github.com/vm0-ai/vm0/issues/3825)) ([456337d](https://github.com/vm0-ai/vm0/commit/456337def2a40bea8dcd2b86f3a662389c968389))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.41.0

## [0.88.2](https://github.com/vm0-ai/vm0/compare/platform-v0.88.1...platform-v0.88.2) (2026-03-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.40.0

## [0.88.1](https://github.com/vm0-ai/vm0/compare/platform-v0.88.0...platform-v0.88.1) (2026-03-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.39.0

## [0.88.0](https://github.com/vm0-ai/vm0/compare/platform-v0.87.0...platform-v0.88.0) (2026-03-06)


### Features

* **platform:** add loop schedule support to run dialog ([#3724](https://github.com/vm0-ai/vm0/issues/3724)) ([f1aeb4c](https://github.com/vm0-ai/vm0/commit/f1aeb4c27897dbb2b1c461172a8a739deb8e6a25))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.38.1

## [0.87.0](https://github.com/vm0-ai/vm0/compare/platform-v0.86.0...platform-v0.87.0) (2026-03-05)


### Features

* **monday:** add monday.com oauth connector ([#3753](https://github.com/vm0-ai/vm0/issues/3753)) ([8bdf5fb](https://github.com/vm0-ai/vm0/commit/8bdf5fb29edb1f309d692ee6f5d5fe0c74634ca5))


### Bug Fixes

* replace non-english characters with english in source code ([#3757](https://github.com/vm0-ai/vm0/issues/3757)) ([b5d6b38](https://github.com/vm0-ai/vm0/commit/b5d6b38fe2cdba0cbd34df85f612cf2267a27734))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.38.0

## [0.86.0](https://github.com/vm0-ai/vm0/compare/platform-v0.85.0...platform-v0.86.0) (2026-03-05)


### Features

* add oauth scope mismatch detection in connector settings ([#3704](https://github.com/vm0-ai/vm0/issues/3704)) ([77e2fcf](https://github.com/vm0-ai/vm0/commit/77e2fcfd80359e0310a1b0ccc6b2a9ad440a6dff)), closes [#3648](https://github.com/vm0-ai/vm0/issues/3648)
* **telegram:** streamline re-link flow after /disconnect ([#3701](https://github.com/vm0-ai/vm0/issues/3701)) ([8dd4db4](https://github.com/vm0-ai/vm0/commit/8dd4db4a9fc255bc34ad6928861a9cb077cd83c2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.37.0

## [0.85.0](https://github.com/vm0-ai/vm0/compare/platform-v0.84.2...platform-v0.85.0) (2026-03-05)


### Features

* **platform:** add zero app with shell, pages and polish ([#3685](https://github.com/vm0-ai/vm0/issues/3685)) ([e9fb699](https://github.com/vm0-ai/vm0/commit/e9fb6993961727e3b7f0c1b01f24045c26589df4))
* **telegram:** improve UX with bot commands and deep links ([#3695](https://github.com/vm0-ai/vm0/issues/3695)) ([9e15219](https://github.com/vm0-ai/vm0/commit/9e15219abbb0fe3f6e7a78a5b975a82e7fb94912))


### Bug Fixes

* **platform:** add user- prefix to default scope slug generation ([#3693](https://github.com/vm0-ai/vm0/issues/3693)) ([8d529bc](https://github.com/vm0-ai/vm0/commit/8d529bcb75218e4d6c8165d7157f597488ac8e6c)), closes [#3691](https://github.com/vm0-ai/vm0/issues/3691)

## [0.84.2](https://github.com/vm0-ai/vm0/compare/platform-v0.84.1...platform-v0.84.2) (2026-03-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.36.0

## [0.84.1](https://github.com/vm0-ai/vm0/compare/platform-v0.84.0...platform-v0.84.1) (2026-03-05)


### Bug Fixes

* **github:** detect existing app installations before redirecting ([#3642](https://github.com/vm0-ai/vm0/issues/3642)) ([7b094f4](https://github.com/vm0-ai/vm0/commit/7b094f490c88887420b076faa9e2186acdabf009))

## [0.84.0](https://github.com/vm0-ai/vm0/compare/platform-v0.83.0...platform-v0.84.0) (2026-03-05)


### Features

* **telegram:** auto-link admin on bot install ([#3644](https://github.com/vm0-ai/vm0/issues/3644)) ([cc1089b](https://github.com/vm0-ai/vm0/commit/cc1089bc9a9891de7de57fcd00b542cace1da212))

## [0.83.0](https://github.com/vm0-ai/vm0/compare/platform-v0.82.0...platform-v0.83.0) (2026-03-05)


### Features

* unify scope types with scope_members table (Phase 1+2) ([#3592](https://github.com/vm0-ai/vm0/issues/3592)) ([60bb170](https://github.com/vm0-ai/vm0/commit/60bb1709832dfe7337ffa419702ce524c06441ed))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.35.0

## [0.82.0](https://github.com/vm0-ai/vm0/compare/platform-v0.81.0...platform-v0.82.0) (2026-03-04)


### Features

* add intervals.icu oauth connector ([#3608](https://github.com/vm0-ai/vm0/issues/3608)) ([6bae2a2](https://github.com/vm0-ai/vm0/commit/6bae2a24c261527f4c1d1467f52b7611501ad5b5)), closes [#3606](https://github.com/vm0-ai/vm0/issues/3606)
* add xero oauth connector ([#3601](https://github.com/vm0-ai/vm0/issues/3601)) ([40e51d4](https://github.com/vm0-ai/vm0/commit/40e51d4a0246d1c419a554d62f5112ef5ff980b6)), closes [#3598](https://github.com/vm0-ai/vm0/issues/3598)
* **compose:** migrate platform compose to e2b sandbox execution ([#3593](https://github.com/vm0-ai/vm0/issues/3593)) ([cbed13c](https://github.com/vm0-ai/vm0/commit/cbed13c2901ac87b38e3c1041b43f431b670d2c6))
* **connectors:** add neon oauth connector ([#3591](https://github.com/vm0-ai/vm0/issues/3591)) ([5024986](https://github.com/vm0-ai/vm0/commit/5024986a1f4d2440b503f1b5dbf9bda7267c55f3))
* **github:** add pending approval flow for org installations ([#3599](https://github.com/vm0-ai/vm0/issues/3599)) ([c83100a](https://github.com/vm0-ai/vm0/commit/c83100a4b401fb0c87cd4cc14ce92102594c99cf))
* **platform:** add timezone selector to schedule dialogs ([#3607](https://github.com/vm0-ai/vm0/issues/3607)) ([4ca2dfe](https://github.com/vm0-ai/vm0/commit/4ca2dfe04c9faca817a9391546d0845084f65855))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.34.0

## [0.81.0](https://github.com/vm0-ai/vm0/compare/platform-v0.80.0...platform-v0.81.0) (2026-03-04)


### Features

* add sentry oauth connector ([#3582](https://github.com/vm0-ai/vm0/issues/3582)) ([b80aa49](https://github.com/vm0-ai/vm0/commit/b80aa49255a0aa493cc217885ed80fad17c5a801))
* add vercel oauth connector ([#3590](https://github.com/vm0-ai/vm0/issues/3590)) ([b5d8898](https://github.com/vm0-ai/vm0/commit/b5d8898bcca548e1300cc1f14b7ebdfa1a1c57c3)), closes [#3586](https://github.com/vm0-ai/vm0/issues/3586)
* **platform:** merge connectors and connections tab, unify add flow and settings ([#3519](https://github.com/vm0-ai/vm0/issues/3519)) ([19b0b2e](https://github.com/vm0-ai/vm0/commit/19b0b2e14423d17abc30af0212fe1cbedec15927))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.33.0

## [0.80.0](https://github.com/vm0-ai/vm0/compare/platform-v0.79.1...platform-v0.80.0) (2026-03-04)


### Features

* **github:** add GitHub integration configuration UI ([#3538](https://github.com/vm0-ai/vm0/issues/3538)) ([df1d682](https://github.com/vm0-ai/vm0/commit/df1d68212aae2059a2d8f270eac84be64d2ddc1a))

## [0.79.1](https://github.com/vm0-ai/vm0/compare/platform-v0.79.0...platform-v0.79.1) (2026-03-04)


### Bug Fixes

* **platform:** remove agent rename to fix storage reference bug ([#3545](https://github.com/vm0-ai/vm0/issues/3545)) ([c8c5156](https://github.com/vm0-ai/vm0/commit/c8c5156160cafe54b1049585df32eed7b440d94f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.32.1

## [0.79.0](https://github.com/vm0-ai/vm0/compare/platform-v0.78.0...platform-v0.79.0) (2026-03-04)


### Features

* add reddit oauth connector ([#3532](https://github.com/vm0-ai/vm0/issues/3532)) ([ecc31b4](https://github.com/vm0-ai/vm0/commit/ecc31b45276946812962d6877ff5072e1e4d55e9))
* add x (twitter) read-only connector ([#3554](https://github.com/vm0-ai/vm0/issues/3554)) ([05dca8a](https://github.com/vm0-ai/vm0/commit/05dca8ab0f6fd9c535b534bcf54cf15eced72afb))
* **platform:** add chat session history and message persistence ([#3520](https://github.com/vm0-ai/vm0/issues/3520)) ([f02f228](https://github.com/vm0-ai/vm0/commit/f02f228c78e2e53ce64bc2b36f08b937e42f2ec2))
* **schedules:** add loop execution mode for recurring agent runs ([#3423](https://github.com/vm0-ai/vm0/issues/3423)) ([00d8876](https://github.com/vm0-ai/vm0/commit/00d8876ada1144fee2d40e2e6e4eb60ab893c4fd))


### Bug Fixes

* update google calendar icon with higher quality version ([#3555](https://github.com/vm0-ai/vm0/issues/3555)) ([b04185e](https://github.com/vm0-ai/vm0/commit/b04185e90dfc68d1ab98922d0c474cdba76a1319))
* use uppercase 1password field refs in env templates ([#3566](https://github.com/vm0-ai/vm0/issues/3566)) ([233e6cc](https://github.com/vm0-ai/vm0/commit/233e6cc071f666be4985ebbccc5629a8b8fab934))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.32.0

## [0.78.0](https://github.com/vm0-ai/vm0/compare/platform-v0.77.0...platform-v0.78.0) (2026-03-03)


### Features

* **connectors:** add google calendar connector ([#3522](https://github.com/vm0-ai/vm0/issues/3522)) ([878ef7d](https://github.com/vm0-ai/vm0/commit/878ef7d3979ac161fdf822d7c674bad51c5000a3))
* **platform:** add one-time schedule option to agent run dialog ([#3507](https://github.com/vm0-ai/vm0/issues/3507)) ([3c23118](https://github.com/vm0-ai/vm0/commit/3c2311828af86446a409a6a193ac2d6f65b6fd66))
* **platform:** forward logger errors to sentry ([#3506](https://github.com/vm0-ai/vm0/issues/3506)) ([dc94a6a](https://github.com/vm0-ai/vm0/commit/dc94a6a9dafcf6c598ff3017ddc154e8e96aca70))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.31.0

## [0.77.0](https://github.com/vm0-ai/vm0/compare/platform-v0.76.0...platform-v0.77.0) (2026-03-03)


### Features

* **github:** add oauth installation flow for github app ([#3466](https://github.com/vm0-ai/vm0/issues/3466)) ([5e07a31](https://github.com/vm0-ai/vm0/commit/5e07a3154da03b64d6e5553ee0cecc05ebc43a7a))
* **platform:** add chat panel for direct agent conversations ([#3208](https://github.com/vm0-ai/vm0/issues/3208)) ([36fc521](https://github.com/vm0-ai/vm0/commit/36fc521f2f2474f5bab2912deb2ff88fb987e891))
* **platform:** add notification preferences tab to settings page ([#3497](https://github.com/vm0-ai/vm0/issues/3497)) ([322eca3](https://github.com/vm0-ai/vm0/commit/322eca3965a0683097cb2f578c7ec82a7613e38d)), closes [#3474](https://github.com/vm0-ai/vm0/issues/3474)
* **platform:** support cmd+click to open in new tab for all navigation ([#3476](https://github.com/vm0-ai/vm0/issues/3476)) ([148e1be](https://github.com/vm0-ai/vm0/commit/148e1bee4d3828e92261f978c51226d2f007a82a)), closes [#3471](https://github.com/vm0-ai/vm0/issues/3471)


### Bug Fixes

* **platform:** rename integration connect buttons to install ([#3504](https://github.com/vm0-ai/vm0/issues/3504)) ([678697a](https://github.com/vm0-ai/vm0/commit/678697a67e51f0a6651cde2d1a771822c9431ad3))


### Performance Improvements

* **platform:** parallelize bootstrap setup operations ([#3485](https://github.com/vm0-ai/vm0/issues/3485)) ([1af5790](https://github.com/vm0-ai/vm0/commit/1af5790155b5e4a4fed95725b4fe5620848173fa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.30.0

## [0.76.0](https://github.com/vm0-ai/vm0/compare/platform-v0.75.1...platform-v0.76.0) (2026-03-03)


### Features

* **connectors:** filter connector types by configured oauth credentials ([#3477](https://github.com/vm0-ai/vm0/issues/3477)) ([09319ec](https://github.com/vm0-ai/vm0/commit/09319ec9081e38d476b6f0e4b9c1e106ba0df8cb))
* **core:** add user-targeted feature switch with enabled user ids ([#3451](https://github.com/vm0-ai/vm0/issues/3451)) ([9e1c37a](https://github.com/vm0-ai/vm0/commit/9e1c37ac3a66882f29db39d0d1b11f165bc12f42))
* **web:** update connector oauth scopes and add deel pkce support ([#3459](https://github.com/vm0-ai/vm0/issues/3459)) ([3c9926a](https://github.com/vm0-ai/vm0/commit/3c9926ac223b3458c9ffc38600e0c19cc552b044))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.29.0

## [0.75.1](https://github.com/vm0-ai/vm0/compare/platform-v0.75.0...platform-v0.75.1) (2026-03-02)


### Bug Fixes

* **platform:** add bg-card to agent instructions container ([#3454](https://github.com/vm0-ai/vm0/issues/3454)) ([5319877](https://github.com/vm0-ai/vm0/commit/5319877e6071c47e779f4c8141be8c950f1a8014))

## [0.75.0](https://github.com/vm0-ai/vm0/compare/platform-v0.74.0...platform-v0.75.0) (2026-03-02)


### Features

* **connector:** add deel oauth2 connector ([#3401](https://github.com/vm0-ai/vm0/issues/3401)) ([8128da7](https://github.com/vm0-ai/vm0/commit/8128da7cb693bdb51b006edc7ed8cc1aae14b9c2))
* **connector:** add docusign oauth2 connector ([#3402](https://github.com/vm0-ai/vm0/issues/3402)) ([2273b1c](https://github.com/vm0-ai/vm0/commit/2273b1c3db937c8c2e5794c0348f2d5a063c724e))
* **connector:** add google sheets, docs, and drive oauth2 connectors ([#3403](https://github.com/vm0-ai/vm0/issues/3403)) ([97cca63](https://github.com/vm0-ai/vm0/commit/97cca638861824b887feaa3d97372028e8affdba))
* **connector:** add mercury oauth2 connector ([#3397](https://github.com/vm0-ai/vm0/issues/3397)) ([a5f4e79](https://github.com/vm0-ai/vm0/commit/a5f4e794fe12e6250d770fef1d8ec444a5cdcec3))
* **connector:** add strava and garmin connect oauth2 connectors ([#3399](https://github.com/vm0-ai/vm0/issues/3399)) ([2aa431a](https://github.com/vm0-ai/vm0/commit/2aa431ae1142234ee0d2add1438249540dc91ad8))
* **platform:** add agent log detail as nested sub-route ([#3418](https://github.com/vm0-ai/vm0/issues/3418)) ([f4bac30](https://github.com/vm0-ai/vm0/commit/f4bac30730979d345f0bc2d9dfbc36caf9b2459f))


### Bug Fixes

* **platform:** resolve empty logs page for scoped agents ([#3392](https://github.com/vm0-ai/vm0/issues/3392)) ([d611bd0](https://github.com/vm0-ai/vm0/commit/d611bd026a6f74a27707c3877c1c4f9cb19acb65))
* **platform:** use existing schedule name when editing and fix error parsing ([#3421](https://github.com/vm0-ai/vm0/issues/3421)) ([810345b](https://github.com/vm0-ai/vm0/commit/810345b073a40712624cfd714010e13e615af688))
* resolve double scrollbar on mobile safari in agent detail page ([#3386](https://github.com/vm0-ai/vm0/issues/3386)) ([2e75a81](https://github.com/vm0-ai/vm0/commit/2e75a818b1985ea607c64dd453512d0fbfe9c50a)), closes [#3229](https://github.com/vm0-ai/vm0/issues/3229)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.28.0

## [0.74.0](https://github.com/vm0-ai/vm0/compare/platform-v0.73.0...platform-v0.74.0) (2026-03-02)


### Features

* **connectors:** remove linear connector feature flag ([#3394](https://github.com/vm0-ai/vm0/issues/3394)) ([bcb0266](https://github.com/vm0-ai/vm0/commit/bcb02665109aeda6e5c6052dcdaa8ebe261545e3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.27.0

## [0.73.0](https://github.com/vm0-ai/vm0/compare/platform-v0.72.2...platform-v0.73.0) (2026-03-02)


### Features

* **connector:** add gmail connector feature flag ([#3381](https://github.com/vm0-ai/vm0/issues/3381)) ([50b45eb](https://github.com/vm0-ai/vm0/commit/50b45eb00469afce5b433e03e590fa0070c77458))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.26.0

## [0.72.2](https://github.com/vm0-ai/vm0/compare/platform-v0.72.1...platform-v0.72.2) (2026-03-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.25.0

## [0.72.1](https://github.com/vm0-ai/vm0/compare/platform-v0.72.0...platform-v0.72.1) (2026-03-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.24.0

## [0.72.0](https://github.com/vm0-ai/vm0/compare/platform-v0.71.0...platform-v0.72.0) (2026-03-01)


### Features

* **connectors:** add dropbox oauth connector ([#3368](https://github.com/vm0-ai/vm0/issues/3368)) ([1dc5d4c](https://github.com/vm0-ai/vm0/commit/1dc5d4c151f986ded68c169b19bd7c9c6a07f4b6))
* **connectors:** add feature flag for linear connector visibility ([#3372](https://github.com/vm0-ai/vm0/issues/3372)) ([f6da04e](https://github.com/vm0-ai/vm0/commit/f6da04e4653c62103975cb43f44d7c70067e4dc1))
* **connectors:** add figma oauth connector ([#3369](https://github.com/vm0-ai/vm0/issues/3369)) ([4d93f59](https://github.com/vm0-ai/vm0/commit/4d93f59827c3567ba83ef115d90decc4ca7fa294))
* **connectors:** add linear oauth connector ([#3366](https://github.com/vm0-ai/vm0/issues/3366)) ([f943498](https://github.com/vm0-ai/vm0/commit/f94349842e5501fe487d078fa7138a3010d65635))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.23.0

## [0.71.0](https://github.com/vm0-ai/vm0/compare/platform-v0.70.1...platform-v0.71.0) (2026-03-01)


### Features

* **connectors:** add gmail oauth connector ([#3332](https://github.com/vm0-ai/vm0/issues/3332)) ([ca303b7](https://github.com/vm0-ai/vm0/commit/ca303b71916095e799c22b975f71216ea89df021))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.22.0

## [0.70.1](https://github.com/vm0-ai/vm0/compare/platform-v0.70.0...platform-v0.70.1) (2026-03-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.21.0

## [0.70.0](https://github.com/vm0-ai/vm0/compare/platform-v0.69.1...platform-v0.70.0) (2026-02-28)


### Features

* **connectors:** add self-hosted slack connector ([#3281](https://github.com/vm0-ai/vm0/issues/3281)) ([13e92fd](https://github.com/vm0-ai/vm0/commit/13e92fde8468324ca7502fa8ded5eb60179eba05)), closes [#3279](https://github.com/vm0-ai/vm0/issues/3279)
* **connectors:** add self-hosted slack connector ([#3286](https://github.com/vm0-ai/vm0/issues/3286)) ([6089289](https://github.com/vm0-ai/vm0/commit/608928923103497eadee7c832c9103d9545aa826))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.20.0

## [0.69.1](https://github.com/vm0-ai/vm0/compare/platform-v0.69.0...platform-v0.69.1) (2026-02-23)


### Bug Fixes

* **slack:** preserve scope prefix in agent navigation and selection ([#3223](https://github.com/vm0-ai/vm0/issues/3223)) ([61bd643](https://github.com/vm0-ai/vm0/commit/61bd643a4e6b0f2977dddf881fd7f5718382e6a6))

## [0.69.0](https://github.com/vm0-ai/vm0/compare/platform-v0.68.5...platform-v0.69.0) (2026-02-23)


### Features

* **platform:** add editable agent name and skills multi-select to config dialog ([#3216](https://github.com/vm0-ai/vm0/issues/3216)) ([50fc6f3](https://github.com/vm0-ai/vm0/commit/50fc6f3fc03d6595b9ee326df2dd88a1697eb837))
* **platform:** add schedule management dialog and enhanced cron options ([#3211](https://github.com/vm0-ai/vm0/issues/3211)) ([d1f30aa](https://github.com/vm0-ai/vm0/commit/d1f30aa17651a80964296e3c1a677049586b9caa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.19.0

## [0.68.5](https://github.com/vm0-ai/vm0/compare/platform-v0.68.4...platform-v0.68.5) (2026-02-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.18.1

## [0.68.4](https://github.com/vm0-ai/vm0/compare/platform-v0.68.3...platform-v0.68.4) (2026-02-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.18.0

## [0.68.3](https://github.com/vm0-ai/vm0/compare/platform-v0.68.2...platform-v0.68.3) (2026-02-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.17.0

## [0.68.2](https://github.com/vm0-ai/vm0/compare/platform-v0.68.1...platform-v0.68.2) (2026-02-17)


### Bug Fixes

* hide connect button while polling ([#3107](https://github.com/vm0-ai/vm0/issues/3107)) ([be3af5d](https://github.com/vm0-ai/vm0/commit/be3af5da3a372d5f110410279e10db860dfabf75))

## [0.68.1](https://github.com/vm0-ai/vm0/compare/platform-v0.68.0...platform-v0.68.1) (2026-02-17)


### Bug Fixes

* remove nango integration and simplify oauth flow ([#3105](https://github.com/vm0-ai/vm0/issues/3105)) ([a1c601e](https://github.com/vm0-ai/vm0/commit/a1c601e2217456d16b1e34de0a41fe61a0026e7a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.16.1

## [0.68.0](https://github.com/vm0-ai/vm0/compare/platform-v0.67.0...platform-v0.68.0) (2026-02-16)


### Features

* add gmail connector with nango platform integration ([#3065](https://github.com/vm0-ai/vm0/issues/3065)) ([d43dfe1](https://github.com/vm0-ai/vm0/commit/d43dfe1a5a868c8413ffd2b8a250d48dafc791cb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.16.0

## [0.67.0](https://github.com/vm0-ai/vm0/compare/platform-v0.66.0...platform-v0.67.0) (2026-02-15)


### Features

* **platform:** add agent logs and connections pages ([#3017](https://github.com/vm0-ai/vm0/issues/3017)) ([cf943b2](https://github.com/vm0-ai/vm0/commit/cf943b224b55438152ee67d339c60894709133a8))
* **platform:** add config dialog and run dialog for agent detail page ([#3016](https://github.com/vm0-ai/vm0/issues/3016)) ([7811f00](https://github.com/vm0-ai/vm0/commit/7811f0045c022856d283174722cfacf6ced72b7f))

## [0.66.0](https://github.com/vm0-ai/vm0/compare/platform-v0.65.0...platform-v0.66.0) (2026-02-13)


### Features

* owner inline editing for agent instructions ([#3015](https://github.com/vm0-ai/vm0/issues/3015)) ([e7022c8](https://github.com/vm0-ai/vm0/commit/e7022c848b7b247ee6f2475c204bfb656588c5ad))

## [0.65.0](https://github.com/vm0-ai/vm0/compare/platform-v0.64.0...platform-v0.65.0) (2026-02-13)


### Features

* **platform:** add agent detail page with feature flag gating ([#2998](https://github.com/vm0-ai/vm0/issues/2998)) ([5386de0](https://github.com/vm0-ai/vm0/commit/5386de0662eb2a85e69040788e2ca08e7f976cba))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.15.0

## [0.64.0](https://github.com/vm0-ai/vm0/compare/platform-v0.63.0...platform-v0.64.0) (2026-02-13)


### Features

* add markdown preview for prompts, slack image hints, and platform tests ([#2991](https://github.com/vm0-ai/vm0/issues/2991)) ([35da51b](https://github.com/vm0-ai/vm0/commit/35da51b563330c45444e1cb16b3de566519d2c07))
* **settings:** improve ui consistency and add success notifications ([#2976](https://github.com/vm0-ai/vm0/issues/2976)) ([6418997](https://github.com/vm0-ai/vm0/commit/6418997a206901e7739c6398c9129474449c0e66))

## [0.63.0](https://github.com/vm0-ai/vm0/compare/platform-v0.62.0...platform-v0.63.0) (2026-02-13)


### Features

* **platform:** add agent detail routes and shared signals ([#2989](https://github.com/vm0-ai/vm0/issues/2989)) ([ddf6fca](https://github.com/vm0-ai/vm0/commit/ddf6fca91c2737231a75b77beca2efb3d9bdc8f4))

## [0.62.0](https://github.com/vm0-ai/vm0/compare/platform-v0.61.0...platform-v0.62.0) (2026-02-13)


### Features

* **api:** add backend support for agent detail page ([#2979](https://github.com/vm0-ai/vm0/issues/2979)) ([4103d8f](https://github.com/vm0-ai/vm0/commit/4103d8f66ccc9546bccc67454d139b8d1de04599))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.14.0

## [0.61.0](https://github.com/vm0-ai/vm0/compare/platform-v0.60.3...platform-v0.61.0) (2026-02-12)


### Features

* add computer connector api for authenticated local tunneling via ngrok ([#2937](https://github.com/vm0-ai/vm0/issues/2937)) ([4f3fc4e](https://github.com/vm0-ai/vm0/commit/4f3fc4ebf137409a30b85b5882634a6bb8846836))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.13.0

## [0.60.3](https://github.com/vm0-ai/vm0/compare/platform-v0.60.2...platform-v0.60.3) (2026-02-12)


### Bug Fixes

* **platform:** fix agents page missing vars, connector suggestions, and stale state ([#2946](https://github.com/vm0-ai/vm0/issues/2946)) ([b20addf](https://github.com/vm0-ai/vm0/commit/b20addf0266a0326ee5f263d54ba299f7e71546e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.12.0

## [0.60.2](https://github.com/vm0-ai/vm0/compare/platform-v0.60.1...platform-v0.60.2) (2026-02-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.11.0

## [0.60.1](https://github.com/vm0-ai/vm0/compare/platform-v0.60.0...platform-v0.60.1) (2026-02-12)


### Bug Fixes

* **platform:** improve environment-variables-setup connector UI ([#2932](https://github.com/vm0-ai/vm0/issues/2932)) ([fbc02b1](https://github.com/vm0-ai/vm0/commit/fbc02b16f832ee35fe914210f5cd1224737bf973))
* **platform:** persist model selection for providers with predefined models ([#2925](https://github.com/vm0-ai/vm0/issues/2925)) ([cf014c0](https://github.com/vm0-ai/vm0/commit/cf014c0a6c4a439748251023937b97f5d60dcf6c)), closes [#2923](https://github.com/vm0-ai/vm0/issues/2923)

## [0.60.0](https://github.com/vm0-ai/vm0/compare/platform-v0.59.1...platform-v0.60.0) (2026-02-12)


### Features

* **slack:** redirect to provider setup after connect ([#2854](https://github.com/vm0-ai/vm0/issues/2854)) ([3701bf6](https://github.com/vm0-ai/vm0/commit/3701bf66ad61c8d2ed525e2f97547cfa4bca8d82))


### Bug Fixes

* **platform:** fix bash error overflow and markdown table light mode ([#2891](https://github.com/vm0-ai/vm0/issues/2891)) ([98c89fd](https://github.com/vm0-ai/vm0/commit/98c89fd53acfe601bc818b1b48b5d67e30676374))
* sanitize mock data and rename platform env var ([#2912](https://github.com/vm0-ai/vm0/issues/2912)) ([b56b513](https://github.com/vm0-ai/vm0/commit/b56b513076eddc3d25b4e106e005b2ab9bc4f518))

## [0.59.1](https://github.com/vm0-ai/vm0/compare/platform-v0.59.0...platform-v0.59.1) (2026-02-12)


### Bug Fixes

* **platform:** connector setup improvements and trailing ? fix ([#2857](https://github.com/vm0-ai/vm0/issues/2857)) ([5f65661](https://github.com/vm0-ai/vm0/commit/5f656610669ccc9999d709f0b8f06f6f15f4ef49))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.10.0

## [0.59.0](https://github.com/vm0-ai/vm0/compare/platform-v0.58.0...platform-v0.59.0) (2026-02-11)


### Features

* **platform:** add incremental polling for log detail auto-refresh ([#2716](https://github.com/vm0-ai/vm0/issues/2716)) ([aad0134](https://github.com/vm0-ai/vm0/commit/aad0134608f0d8af1f55bbe6cda6bcac8972d451))

## [0.58.0](https://github.com/vm0-ai/vm0/compare/platform-v0.57.0...platform-v0.58.0) (2026-02-11)


### Features

* **platform:** add connector management to settings page ([#2769](https://github.com/vm0-ai/vm0/issues/2769)) ([418bc1e](https://github.com/vm0-ai/vm0/commit/418bc1e2dd6afb94b3caca84abf260bf542359c8)), closes [#2766](https://github.com/vm0-ai/vm0/issues/2766)
* **platform:** add connector-based environment variable setup ([#2847](https://github.com/vm0-ai/vm0/issues/2847)) ([7a0004f](https://github.com/vm0-ai/vm0/commit/7a0004f3c0436e53d591f1308b7ec5b59d56f226))
* **slack:** move settings to platform integrations page ([#2797](https://github.com/vm0-ai/vm0/issues/2797)) ([030e41f](https://github.com/vm0-ai/vm0/commit/030e41fa55e7f7eeebb811f6619ad84c954de173))


### Bug Fixes

* **platform:** show skeleton loading state instead of flashing empty state in secrets/vars lists ([#2840](https://github.com/vm0-ai/vm0/issues/2840)) ([cab7682](https://github.com/vm0-ai/vm0/commit/cab7682483252324f0d4e14dfa07b67fceb5ac0a)), closes [#2658](https://github.com/vm0-ai/vm0/issues/2658)

## [0.57.0](https://github.com/vm0-ai/vm0/compare/platform-v0.56.5...platform-v0.57.0) (2026-02-11)


### Features

* **deploy:** add self-hosted deployment support with docker and local auth ([#2718](https://github.com/vm0-ai/vm0/issues/2718)) ([498da5e](https://github.com/vm0-ai/vm0/commit/498da5e0a411a034df83c18c00fc287143dc0259))

## [0.56.5](https://github.com/vm0-ai/vm0/compare/platform-v0.56.4...platform-v0.56.5) (2026-02-11)


### Performance Improvements

* **platform:** skip rendering in signal-only tests ([#2798](https://github.com/vm0-ai/vm0/issues/2798)) ([e438809](https://github.com/vm0-ai/vm0/commit/e4388091362b0e7812ea859c9a085061a99a6acf))

## [0.56.4](https://github.com/vm0-ai/vm0/compare/platform-v0.56.3...platform-v0.56.4) (2026-02-11)


### Bug Fixes

* **platform:** enforce MSW onUnhandledRequest error mode ([#2791](https://github.com/vm0-ai/vm0/issues/2791)) ([ce092a5](https://github.com/vm0-ai/vm0/commit/ce092a514d198fef5cb90b0ae72818c874c2a383))

## [0.56.3](https://github.com/vm0-ai/vm0/compare/platform-v0.56.2...platform-v0.56.3) (2026-02-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.9.0

## [0.56.2](https://github.com/vm0-ai/vm0/compare/platform-v0.56.1...platform-v0.56.2) (2026-02-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.8.0

## [0.56.1](https://github.com/vm0-ai/vm0/compare/platform-v0.56.0...platform-v0.56.1) (2026-02-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.7.1

## [0.56.0](https://github.com/vm0-ai/vm0/compare/platform-v0.55.1...platform-v0.56.0) (2026-02-10)


### Features

* **platform:** add environment variables setup page ([#2737](https://github.com/vm0-ai/vm0/issues/2737)) ([d33842a](https://github.com/vm0-ai/vm0/commit/d33842a2e5e72eb5bfebe66cd442135b49f35a51))

## [0.55.1](https://github.com/vm0-ai/vm0/compare/platform-v0.55.0...platform-v0.55.1) (2026-02-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.7.0

## [0.55.0](https://github.com/vm0-ai/vm0/compare/platform-v0.54.3...platform-v0.55.0) (2026-02-10)


### Features

* **platform:** detect and display missing secrets for agents ([#2664](https://github.com/vm0-ai/vm0/issues/2664)) ([e43fb63](https://github.com/vm0-ai/vm0/commit/e43fb63d574f3f614254e702c76270b59381fedf))

## [0.54.3](https://github.com/vm0-ai/vm0/compare/platform-v0.54.2...platform-v0.54.3) (2026-02-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.6.1

## [0.54.2](https://github.com/vm0-ai/vm0/compare/platform-v0.54.1...platform-v0.54.2) (2026-02-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.6.0

## [0.54.1](https://github.com/vm0-ai/vm0/compare/platform-v0.54.0...platform-v0.54.1) (2026-02-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.5.1

## [0.54.0](https://github.com/vm0-ai/vm0/compare/platform-v0.53.1...platform-v0.54.0) (2026-02-09)


### Features

* **platform:** add secret/variable settings page with tabs and url deep-linking ([#2624](https://github.com/vm0-ai/vm0/issues/2624)) ([dac5bad](https://github.com/vm0-ai/vm0/commit/dac5badf4773b7602ceca837a224eb58220f4b5e))

## [0.53.1](https://github.com/vm0-ai/vm0/compare/platform-v0.53.0...platform-v0.53.1) (2026-02-09)


### Bug Fixes

* **platform:** use simple box icon for collapsed sidebar logo ([#2623](https://github.com/vm0-ai/vm0/issues/2623)) ([1b26059](https://github.com/vm0-ai/vm0/commit/1b26059ce80ceec9ce1b282249334d30b9554c9a))

## [0.53.0](https://github.com/vm0-ai/vm0/compare/platform-v0.52.1...platform-v0.53.0) (2026-02-09)


### Features

* **platform:** optimize logs page navigation for instant feedback ([#2577](https://github.com/vm0-ai/vm0/issues/2577)) ([f874e37](https://github.com/vm0-ai/vm0/commit/f874e375b8091c9fe006c021d307021a5d161995))
* **web:** handle agent timeout with user notification in Slack threads ([#2563](https://github.com/vm0-ai/vm0/issues/2563)) ([00456d8](https://github.com/vm0-ai/vm0/commit/00456d841dde7fed7e848cbab41bb6236c34ffe7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.5.0

## [0.52.1](https://github.com/vm0-ai/vm0/compare/platform-v0.52.0...platform-v0.52.1) (2026-02-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.4.2

## [0.52.0](https://github.com/vm0-ai/vm0/compare/platform-v0.51.2...platform-v0.52.0) (2026-02-07)


### Features

* **platform:** collapse consecutive same-type tool calls in log detail ([#2560](https://github.com/vm0-ai/vm0/issues/2560)) ([71091bc](https://github.com/vm0-ai/vm0/commit/71091bc1599fcfde7b1894563731ade9dbd9a680))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.4.1

## [0.51.2](https://github.com/vm0-ai/vm0/compare/platform-v0.51.1...platform-v0.51.2) (2026-02-07)


### Bug Fixes

* **platform:** sort events by sequenceNumber before grouping to fix unknown tool results ([#2556](https://github.com/vm0-ai/vm0/issues/2556)) ([430ddcb](https://github.com/vm0-ai/vm0/commit/430ddcbb99daf813617e68b4c38d821454cb62d8)), closes [#2549](https://github.com/vm0-ai/vm0/issues/2549)

## [0.51.1](https://github.com/vm0-ai/vm0/compare/platform-v0.51.0...platform-v0.51.1) (2026-02-07)


### Bug Fixes

* **platform:** improve onboarding modal layout and scrolling ([#2521](https://github.com/vm0-ai/vm0/issues/2521)) ([bbfe6aa](https://github.com/vm0-ai/vm0/commit/bbfe6aac1a10d3c7bee54a28fb9d6028a0d52985))

## [0.51.0](https://github.com/vm0-ai/vm0/compare/platform-v0.50.3...platform-v0.51.0) (2026-02-07)


### Features

* **platform:** display user prompt in log detail page ([#2535](https://github.com/vm0-ai/vm0/issues/2535)) ([80d1d37](https://github.com/vm0-ai/vm0/commit/80d1d37c6beefbf436ccacf0543e561981defee4))

## [0.50.3](https://github.com/vm0-ai/vm0/compare/platform-v0.50.2...platform-v0.50.3) (2026-02-07)


### Bug Fixes

* **platform:** display actual model provider name in agents table ([#2524](https://github.com/vm0-ai/vm0/issues/2524)) ([99e3791](https://github.com/vm0-ai/vm0/commit/99e379185ea2ea0caf6d727c8ad065a232fd1ce6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.4.0

## [0.50.2](https://github.com/vm0-ai/vm0/compare/platform-v0.50.1...platform-v0.50.2) (2026-02-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.3.0

## [0.50.1](https://github.com/vm0-ai/vm0/compare/platform-v0.50.0...platform-v0.50.1) (2026-02-06)


### Bug Fixes

* **ci:** update platform deployment to use unified clerk env var ([#2502](https://github.com/vm0-ai/vm0/issues/2502)) ([f63ae57](https://github.com/vm0-ai/vm0/commit/f63ae575aff0b7d4549abdf141af5ebe05086a7d))

## [0.50.0](https://github.com/vm0-ai/vm0/compare/platform-v0.49.0...platform-v0.50.0) (2026-02-06)


### Features

* add dual-mode data provider to sync-env.sh ([#2496](https://github.com/vm0-ai/vm0/issues/2496)) ([1ccff32](https://github.com/vm0-ai/vm0/commit/1ccff32ad5cb7feca4d6b16b8ec548c1283295bd))
* improve model provider descriptions and ui ([#2500](https://github.com/vm0-ai/vm0/issues/2500)) ([435ac6c](https://github.com/vm0-ai/vm0/commit/435ac6c4b9091578463a55d614dc81975a9924ad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.2.2

## [0.49.0](https://github.com/vm0-ai/vm0/compare/platform-v0.48.0...platform-v0.49.0) (2026-02-06)


### Features

* **platform:** model provider settings page with full CRUD management ([#2469](https://github.com/vm0-ai/vm0/issues/2469)) ([0f9fd01](https://github.com/vm0-ai/vm0/commit/0f9fd01a574011c940c1b4d1653fa76161a2c7f3))

## [0.48.0](https://github.com/vm0-ai/vm0/compare/platform-v0.47.1...platform-v0.48.0) (2026-02-06)


### Features

* **platform:** make agents table rows fully clickable ([#2438](https://github.com/vm0-ai/vm0/issues/2438)) ([5771131](https://github.com/vm0-ai/vm0/commit/5771131b92ddde046e28b06e4e403b48ae047a0c))
* **platform:** polish logs page ui with skeletons and refined copy ([#2428](https://github.com/vm0-ai/vm0/issues/2428)) ([0050775](https://github.com/vm0-ai/vm0/commit/005077591a8bdc9891f2b9e7745553514f74a29c))


### Bug Fixes

* **platform:** wrap error messages to prevent horizontal scroll ([#2454](https://github.com/vm0-ai/vm0/issues/2454)) ([2391be6](https://github.com/vm0-ai/vm0/commit/2391be6cd22ecca8e9c6cdeba04df72b971cf667)), closes [#2450](https://github.com/vm0-ai/vm0/issues/2450)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.2.1

## [0.47.1](https://github.com/vm0-ai/vm0/compare/platform-v0.47.0...platform-v0.47.1) (2026-02-05)


### Bug Fixes

* **platform:** prevent layout overlap in logs detail page on mobile ([#2418](https://github.com/vm0-ai/vm0/issues/2418)) ([5c732bb](https://github.com/vm0-ai/vm0/commit/5c732bb3ec23cf31caaefd1c4ac65f149332bc95))

## [0.47.0](https://github.com/vm0-ai/vm0/compare/platform-v0.46.0...platform-v0.47.0) (2026-02-05)


### Features

* **platform:** integrate sentry error tracking ([#2404](https://github.com/vm0-ai/vm0/issues/2404)) ([db73124](https://github.com/vm0-ai/vm0/commit/db73124163225ed25c8616a045b652800c10d7aa))

## [0.46.0](https://github.com/vm0-ai/vm0/compare/platform-v0.45.4...platform-v0.46.0) (2026-02-05)


### Features

* **platform:** polish logs page ui with refined styling and interactions ([#2391](https://github.com/vm0-ai/vm0/issues/2391)) ([98c8118](https://github.com/vm0-ai/vm0/commit/98c81188738fec04cf6e0543ef8028e515d784f9))

## [0.45.4](https://github.com/vm0-ai/vm0/compare/platform-v0.45.3...platform-v0.45.4) (2026-02-05)


### Bug Fixes

* **platform:** improve logs page navigation behavior ([#2380](https://github.com/vm0-ai/vm0/issues/2380)) ([4347d33](https://github.com/vm0-ai/vm0/commit/4347d33220af9248addb8829032601d26d1af9ce))

## [0.45.3](https://github.com/vm0-ai/vm0/compare/platform-v0.45.2...platform-v0.45.3) (2026-02-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.2.0

## [0.45.2](https://github.com/vm0-ai/vm0/compare/platform-v0.45.1...platform-v0.45.2) (2026-02-04)


### Bug Fixes

* **platform:** ensure tool result content is always a string ([#2354](https://github.com/vm0-ai/vm0/issues/2354)) ([4676574](https://github.com/vm0-ai/vm0/commit/46765749d0f3ac28d66255ddbd802548ded67b29))

## [0.45.1](https://github.com/vm0-ai/vm0/compare/platform-v0.45.0...platform-v0.45.1) (2026-02-04)


### Bug Fixes

* **site,web,platform:** replace favicon with vm0 logo ([#2347](https://github.com/vm0-ai/vm0/issues/2347)) ([b380a1e](https://github.com/vm0-ai/vm0/commit/b380a1edb42e485d6392e9861a62064761fcbede))

## [0.45.0](https://github.com/vm0-ai/vm0/compare/platform-v0.44.3...platform-v0.45.0) (2026-02-04)


### Features

* **platform:** add two documentation cards for developers and vibe coders ([#2267](https://github.com/vm0-ai/vm0/issues/2267)) ([5cd55da](https://github.com/vm0-ai/vm0/commit/5cd55daf8d0cec0ef25e86f4ffdb9d612ff4395d))
* **platform:** enhance agents page with schedule status and management dialog ([#2314](https://github.com/vm0-ai/vm0/issues/2314)) ([338809d](https://github.com/vm0-ai/vm0/commit/338809d834a20d006341ddb788995d2124692edd))
* **slack:** integrate user secrets with agent modals ([#2328](https://github.com/vm0-ai/vm0/issues/2328)) ([8657063](https://github.com/vm0-ai/vm0/commit/865706306fe3be3254ef0699fdf5c5479a9f9262))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.1.0

## [0.44.3](https://github.com/vm0-ai/vm0/compare/platform-v0.44.2...platform-v0.44.3) (2026-02-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.0.0

## [0.44.2](https://github.com/vm0-ai/vm0/compare/platform-v0.44.1...platform-v0.44.2) (2026-02-04)


### Bug Fixes

* **platform:** only override feature switches when value is explicitly set in localStorage ([#2297](https://github.com/vm0-ai/vm0/issues/2297)) ([a7e97de](https://github.com/vm0-ai/vm0/commit/a7e97de6e8379a6a3d9557264b491b6d13e32809)), closes [#2289](https://github.com/vm0-ai/vm0/issues/2289)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.15.0

## [0.44.1](https://github.com/vm0-ai/vm0/compare/platform-v0.44.0...platform-v0.44.1) (2026-02-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.14.0

## [0.44.0](https://github.com/vm0-ai/vm0/compare/platform-v0.43.1...platform-v0.44.0) (2026-02-03)


### Features

* **platform:** simplify agents page to focus on Claude Code setup ([#2259](https://github.com/vm0-ai/vm0/issues/2259)) ([25f3e45](https://github.com/vm0-ai/vm0/commit/25f3e4597b0ae4b786b0051da5c76eafd1400d88))

## [0.43.1](https://github.com/vm0-ai/vm0/compare/platform-v0.43.0...platform-v0.43.1) (2026-02-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.13.0

## [0.43.0](https://github.com/vm0-ai/vm0/compare/platform-v0.42.0...platform-v0.43.0) (2026-02-03)


### Features

* **platform:** add agent and schedule cli reference navigation ([#2244](https://github.com/vm0-ai/vm0/issues/2244)) ([164d46b](https://github.com/vm0-ai/vm0/commit/164d46b0511ddd4e12827eb032c815073035437e))

## [0.42.0](https://github.com/vm0-ai/vm0/compare/platform-v0.41.1...platform-v0.42.0) (2026-02-03)


### Features

* **model-provider:** add aws bedrock support with multi-auth provider architecture ([#2214](https://github.com/vm0-ai/vm0/issues/2214)) ([8009acf](https://github.com/vm0-ai/vm0/commit/8009acf84785e70aaf63f47e23358184d6058c22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.12.0

## [0.41.1](https://github.com/vm0-ai/vm0/compare/platform-v0.41.0...platform-v0.41.1) (2026-02-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.11.0

## [0.41.0](https://github.com/vm0-ai/vm0/compare/platform-v0.40.0...platform-v0.41.0) (2026-02-03)


### Features

* **platform:** add session id and framework fields to logs list response ([#2208](https://github.com/vm0-ai/vm0/issues/2208)) ([8a55eca](https://github.com/vm0-ai/vm0/commit/8a55eca92e46080d248160cbba8eebdf40769750))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.10.0

## [0.40.0](https://github.com/vm0-ai/vm0/compare/platform-v0.39.0...platform-v0.40.0) (2026-02-03)


### Features

* enhance design system with improved components ([#2190](https://github.com/vm0-ai/vm0/issues/2190)) ([b6fc9c4](https://github.com/vm0-ai/vm0/commit/b6fc9c4131b223be1f45e5d17951e5c3243ffb6d))

## [0.39.0](https://github.com/vm0-ai/vm0/compare/platform-v0.38.1...platform-v0.39.0) (2026-02-03)


### Features

* **platform:** add infinite scroll pagination for agent events ([#2171](https://github.com/vm0-ai/vm0/issues/2171)) ([7c965ae](https://github.com/vm0-ai/vm0/commit/7c965ae49fd206ed6a6f6b90b02ba87d02ef9645))


### Performance Improvements

* **platform:** include basic log info in logs list API response ([#2165](https://github.com/vm0-ai/vm0/issues/2165)) ([1a4d4c5](https://github.com/vm0-ai/vm0/commit/1a4d4c51171bf1f08df6d305dd9dce488d8c652f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.9.0

## [0.38.1](https://github.com/vm0-ai/vm0/compare/platform-v0.38.0...platform-v0.38.1) (2026-02-02)


### Bug Fixes

* **platform:** address log detail viewer issues ([#2158](https://github.com/vm0-ai/vm0/issues/2158)) ([f77222e](https://github.com/vm0-ai/vm0/commit/f77222e14009ce4163d1406de3c8fea9cd818616))

## [0.38.0](https://github.com/vm0-ai/vm0/compare/platform-v0.37.0...platform-v0.38.0) (2026-02-02)


### Features

* **platform:** add plausible analytics integration ([#2150](https://github.com/vm0-ai/vm0/issues/2150)) ([10dae9b](https://github.com/vm0-ai/vm0/commit/10dae9bc2b3e7ec9e8d0544c3b87b05092768920))

## [0.37.0](https://github.com/vm0-ai/vm0/compare/platform-v0.36.3...platform-v0.37.0) (2026-02-02)


### Features

* add moonshot-api-key provider with credential mapping and model selection ([#2110](https://github.com/vm0-ai/vm0/issues/2110)) ([88f8f9d](https://github.com/vm0-ai/vm0/commit/88f8f9d369529752eac68eec426153d8b82ab5fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.8.0

## [0.36.3](https://github.com/vm0-ai/vm0/compare/platform-v0.36.2...platform-v0.36.3) (2026-02-02)


### Bug Fixes

* **platform:** polish responsive design for logs page ([#2108](https://github.com/vm0-ai/vm0/issues/2108)) ([fcdbcd2](https://github.com/vm0-ai/vm0/commit/fcdbcd2b355fbba44454897b8287325ba634d470))

## [0.36.2](https://github.com/vm0-ai/vm0/compare/platform-v0.36.1...platform-v0.36.2) (2026-02-02)


### Bug Fixes

* **platform:** improve responsive layout for logs page and sidebar ([#2094](https://github.com/vm0-ai/vm0/issues/2094)) ([3ffc218](https://github.com/vm0-ai/vm0/commit/3ffc218dc21dbb7f9c9a0ab9895a89367767884e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.7.0

## [0.36.1](https://github.com/vm0-ai/vm0/compare/platform-v0.36.0...platform-v0.36.1) (2026-02-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.6.1

## [0.36.0](https://github.com/vm0-ai/vm0/compare/platform-v0.35.0...platform-v0.36.0) (2026-02-01)


### Features

* **cli:** release onboard banner update ([#2084](https://github.com/vm0-ai/vm0/issues/2084)) ([402820c](https://github.com/vm0-ai/vm0/commit/402820cbeabed134c3a757d4c8400037fce4c427))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.6.0

## [0.35.0](https://github.com/vm0-ai/vm0/compare/platform-v0.34.1...platform-v0.35.0) (2026-01-31)


### Features

* **platform:** redesign event cards with minimalist style ([#2057](https://github.com/vm0-ai/vm0/issues/2057)) ([d2b120f](https://github.com/vm0-ai/vm0/commit/d2b120ff340d2510dc9109b0692c8d5aa5558a9f))

## [0.34.1](https://github.com/vm0-ai/vm0/compare/platform-v0.34.0...platform-v0.34.1) (2026-01-31)


### Bug Fixes

* **platform:** correct step 1 description on homepage ([#2046](https://github.com/vm0-ai/vm0/issues/2046)) ([8b49b47](https://github.com/vm0-ai/vm0/commit/8b49b470d00a01cb55bcdf1a7a395285ed2b23fa))

## [0.34.0](https://github.com/vm0-ai/vm0/compare/platform-v0.33.0...platform-v0.34.0) (2026-01-31)


### Features

* **platform:** add dark mode support to onboarding modal ([#2030](https://github.com/vm0-ai/vm0/issues/2030)) ([5e941f6](https://github.com/vm0-ai/vm0/commit/5e941f612e3e4d08f388f5a1acb47b96145e88c6))
* **platform:** add interactive json viewer and sticky copy button in log detail ([#2033](https://github.com/vm0-ai/vm0/issues/2033)) ([0dd358e](https://github.com/vm0-ai/vm0/commit/0dd358e7957a5517ba18fdc5b9bad4a452fa55b4))

## [0.33.0](https://github.com/vm0-ai/vm0/compare/platform-v0.32.0...platform-v0.33.0) (2026-01-31)


### Features

* enable observation logs and redirect logged-in users to platform ([#2027](https://github.com/vm0-ai/vm0/issues/2027)) ([eb51f47](https://github.com/vm0-ai/vm0/commit/eb51f47cfea75abaf1aee0a0a288bf1497675a15))
* **platform:** implement sidebar toggle with icons-only collapsed mode ([#2022](https://github.com/vm0-ai/vm0/issues/2022)) ([922641f](https://github.com/vm0-ai/vm0/commit/922641f6c683e8654bc6d59a38bcd0de057cb93e)), closes [#2019](https://github.com/vm0-ai/vm0/issues/2019)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.5.0

## [0.32.0](https://github.com/vm0-ai/vm0/compare/platform-v0.31.2...platform-v0.32.0) (2026-01-31)


### Features

* **platform:** add favicon and icon to platform app ([#2009](https://github.com/vm0-ai/vm0/issues/2009)) ([24a2bf1](https://github.com/vm0-ai/vm0/commit/24a2bf1390957d13909a1d1c11a50fdc81e1b331))
* **platform:** improve log detail with message grouping and compact header ([#1984](https://github.com/vm0-ai/vm0/issues/1984)) ([4894373](https://github.com/vm0-ai/vm0/commit/4894373604579718eaca4175531213693f28fff8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.4.2

## [0.31.2](https://github.com/vm0-ai/vm0/compare/platform-v0.31.1...platform-v0.31.2) (2026-01-31)


### Bug Fixes

* **platform:** prevent horizontal overflow in event card code blocks ([#1968](https://github.com/vm0-ai/vm0/issues/1968)) ([a9e26f1](https://github.com/vm0-ai/vm0/commit/a9e26f17593bbc5771c74667e8ef7960f923792b))

## [0.31.1](https://github.com/vm0-ai/vm0/compare/platform-v0.31.0...platform-v0.31.1) (2026-01-30)


### Bug Fixes

* **platform:** align result card layout with other event cards ([#1950](https://github.com/vm0-ai/vm0/issues/1950)) ([46930c1](https://github.com/vm0-ai/vm0/commit/46930c117e637e3c1cd35b26bb8dc2ca1b585e12))
* **platform:** search only matches visible text in formatted view ([#1951](https://github.com/vm0-ai/vm0/issues/1951)) ([b198423](https://github.com/vm0-ai/vm0/commit/b198423042aa503f71e48b9e7f75f7d9aa73302f))

## [0.31.0](https://github.com/vm0-ai/vm0/compare/platform-v0.30.0...platform-v0.31.0) (2026-01-30)


### Features

* **platform:** add copy buttons and update event card styling ([#1946](https://github.com/vm0-ai/vm0/issues/1946)) ([4e416b8](https://github.com/vm0-ai/vm0/commit/4e416b8134d0bb6a42088582d79b8c60732aeef5))
* **platform:** improve log detail page ui ([#1940](https://github.com/vm0-ai/vm0/issues/1940)) ([e6e521a](https://github.com/vm0-ai/vm0/commit/e6e521aac59ff301a4375ab83689f49c227648bc))
* **platform:** show raw events view for codex framework ([#1942](https://github.com/vm0-ai/vm0/issues/1942)) ([95f6e3c](https://github.com/vm0-ai/vm0/commit/95f6e3cf131808f09e7a4ed0a898a55906edfd1d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.4.1

## [0.30.0](https://github.com/vm0-ai/vm0/compare/platform-v0.29.0...platform-v0.30.0) (2026-01-30)


### Features

* **ui:** enhance design system and improve onboarding and settings ui ([#1894](https://github.com/vm0-ai/vm0/issues/1894)) ([6a11166](https://github.com/vm0-ai/vm0/commit/6a1116694544c01c69ea20dbf80a986ee8294f30))

## [0.29.0](https://github.com/vm0-ai/vm0/compare/platform-v0.28.0...platform-v0.29.0) (2026-01-30)


### Features

* **platform:** update log detail page ui to match figma design ([#1872](https://github.com/vm0-ai/vm0/issues/1872)) ([60943bc](https://github.com/vm0-ai/vm0/commit/60943bcc15a5f9264a4c7d28e6bb05765f50553e))

## [0.28.0](https://github.com/vm0-ai/vm0/compare/platform-v0.27.0...platform-v0.28.0) (2026-01-29)


### Features

* **platform:** add full search navigation to agent events log viewer ([#1806](https://github.com/vm0-ai/vm0/issues/1806)) ([f24dd8b](https://github.com/vm0-ai/vm0/commit/f24dd8bc75c5e09add6bdc6968485192a732f3da))


### Bug Fixes

* **web:** wrap async assertion in vi.waitfor for home page test ([#1864](https://github.com/vm0-ai/vm0/issues/1864)) ([4ea52a5](https://github.com/vm0-ai/vm0/commit/4ea52a53f58338ee61a3df727477ee61b14cf8bf))

## [0.27.0](https://github.com/vm0-ai/vm0/compare/platform-v0.26.1...platform-v0.27.0) (2026-01-29)


### Features

* **platform:** display TodoWrite todos as checklist in log detail ([#1803](https://github.com/vm0-ai/vm0/issues/1803)) ([e98d22a](https://github.com/vm0-ai/vm0/commit/e98d22a3f5360e2d162c5c33a98131e39c4d5280))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.4.0

## [0.26.1](https://github.com/vm0-ai/vm0/compare/platform-v0.26.0...platform-v0.26.1) (2026-01-28)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.3.0

## [0.26.0](https://github.com/vm0-ai/vm0/compare/platform-v0.25.1...platform-v0.26.0) (2026-01-28)


### Features

* **platform:** enhance log viewer with formatted cards and semantic colors ([#1790](https://github.com/vm0-ai/vm0/issues/1790)) ([0df2be9](https://github.com/vm0-ai/vm0/commit/0df2be99400f3074e637d083f6beff926fe3725c))

## [0.25.1](https://github.com/vm0-ai/vm0/compare/platform-v0.25.0...platform-v0.25.1) (2026-01-28)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.2.0

## [0.25.0](https://github.com/vm0-ai/vm0/compare/platform-v0.24.0...platform-v0.25.0) (2026-01-28)


### Features

* **platform:** add log detail page with agent events and artifact download ([#1738](https://github.com/vm0-ai/vm0/issues/1738)) ([ef8b01d](https://github.com/vm0-ai/vm0/commit/ef8b01d3ef809ed8c6c3e2ce2061b4f65c0fc69e))
* **platform:** add pagination and search to logs page ([#1751](https://github.com/vm0-ai/vm0/issues/1751)) ([e6b4b1b](https://github.com/vm0-ai/vm0/commit/e6b4b1bdc1f9c10ddab6d67fbc77bef7b294f4c7))
* **platform:** improve logs page ui styling and layout ([#1759](https://github.com/vm0-ai/vm0/issues/1759)) ([e0f7568](https://github.com/vm0-ai/vm0/commit/e0f7568fa001e44c41d7191b370ddea4f3aceb0b))
* **platform:** persist logs pagination state in url ([#1752](https://github.com/vm0-ai/vm0/issues/1752)) ([a1cfc6f](https://github.com/vm0-ai/vm0/commit/a1cfc6f1df59feab754f92de78e86977e68dc4ac))


### Bug Fixes

* **platform:** correct artifact extraction and rename provider to framework ([#1745](https://github.com/vm0-ai/vm0/issues/1745)) ([f53f75a](https://github.com/vm0-ai/vm0/commit/f53f75a81a920fcf4eca12c84e098b7432287161))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.1.0

## [0.24.0](https://github.com/vm0-ai/vm0/compare/platform-v0.23.1...platform-v0.24.0) (2026-01-27)


### Features

* **platform:** add logs page ui with table display ([#1735](https://github.com/vm0-ai/vm0/issues/1735)) ([4805755](https://github.com/vm0-ai/vm0/commit/4805755e8cc7f82d56f90317a6e7587c3a205e31))
* **platform:** improve UI styling and dark mode support ([#1725](https://github.com/vm0-ai/vm0/issues/1725)) ([5657fcf](https://github.com/vm0-ai/vm0/commit/5657fcf0c6ad5246c2eb7057241be988a9287b25))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.0.0

## [0.23.1](https://github.com/vm0-ai/vm0/compare/platform-v0.23.0...platform-v0.23.1) (2026-01-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.3.0

## [0.23.0](https://github.com/vm0-ai/vm0/compare/platform-v0.22.1...platform-v0.23.0) (2026-01-27)


### Features

* **docs:** trigger release for documentation updates ([#1697](https://github.com/vm0-ai/vm0/issues/1697)) ([c078287](https://github.com/vm0-ai/vm0/commit/c078287de06336abd3157fcaa056bdedcb47838d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.2.0

## [0.22.1](https://github.com/vm0-ai/vm0/compare/platform-v0.22.0...platform-v0.22.1) (2026-01-27)


### Bug Fixes

* **platform:** improve test stability with act() and suppress console noise ([#1678](https://github.com/vm0-ai/vm0/issues/1678)) ([01f9181](https://github.com/vm0-ai/vm0/commit/01f9181a1212fbe2871a9b16fd266b6c871bbda0))

## [0.22.0](https://github.com/vm0-ai/vm0/compare/platform-v0.21.2...platform-v0.22.0) (2026-01-26)


### Features

* **platform:** add settings page with model provider management ([#1652](https://github.com/vm0-ai/vm0/issues/1652)) ([6eab110](https://github.com/vm0-ai/vm0/commit/6eab1104ea3680966da77f9cc25a444f65ff375a))
* **platform:** redesign homepage and add settings page ([#1639](https://github.com/vm0-ai/vm0/issues/1639)) ([b0515d5](https://github.com/vm0-ai/vm0/commit/b0515d5e75149dd92a11f14f6b80c6661f76afa5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.1.0

## [0.21.2](https://github.com/vm0-ai/vm0/compare/platform-v0.21.1...platform-v0.21.2) (2026-01-26)


### Bug Fixes

* **platform:** wait for async operations in home page test ([#1624](https://github.com/vm0-ai/vm0/issues/1624)) ([a5d89aa](https://github.com/vm0-ai/vm0/commit/a5d89aa569a85b5a08761454ad623feb605cd6d7))

## [0.21.1](https://github.com/vm0-ai/vm0/compare/platform-v0.21.0...platform-v0.21.1) (2026-01-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.0.1

## [0.21.0](https://github.com/vm0-ai/vm0/compare/platform-v0.20.0...platform-v0.21.0) (2026-01-24)


### Features

* **platform:** add oauth token configuration to onboarding modal ([#1598](https://github.com/vm0-ai/vm0/issues/1598)) ([ead50d2](https://github.com/vm0-ai/vm0/commit/ead50d25b3db8843fed8ae8202297e37914a8de1))
* **platform:** add save button validation to onboarding modal ([#1604](https://github.com/vm0-ai/vm0/issues/1604)) ([107379f](https://github.com/vm0-ai/vm0/commit/107379f0c8187ef6365ef365adf8b0106ca12a35))
* **platform:** show onboarding modal when no oauth token exists ([#1609](https://github.com/vm0-ai/vm0/issues/1609)) ([43fb460](https://github.com/vm0-ai/vm0/commit/43fb460382926f201f399175cf69d100108c15cf)), closes [#1607](https://github.com/vm0-ai/vm0/issues/1607)

## [0.20.0](https://github.com/vm0-ai/vm0/compare/platform-v0.19.0...platform-v0.20.0) (2026-01-24)


### Features

* **cli:** rename experimental-credential to credential ([#1582](https://github.com/vm0-ai/vm0/issues/1582)) ([499e605](https://github.com/vm0-ai/vm0/commit/499e605c046f7f048c96f3ca6d8b257189aca40c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.0.0

## [0.19.0](https://github.com/vm0-ai/vm0/compare/platform-v0.18.0...platform-v0.19.0) (2026-01-23)


### Features

* **platform:** add onboarding ui and model providers signal ([#1575](https://github.com/vm0-ai/vm0/issues/1575)) ([4e2c017](https://github.com/vm0-ai/vm0/commit/4e2c0173a258779e971dc4b7834746f0be63e1c5))


### Bug Fixes

* unify terminology from llm to model provider ([#1580](https://github.com/vm0-ai/vm0/issues/1580)) ([dfe6a2c](https://github.com/vm0-ai/vm0/commit/dfe6a2c99f9b8a0de02cb3afc902ae2eb57cefd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.5.0

## [0.18.0](https://github.com/vm0-ai/vm0/compare/platform-v0.17.0...platform-v0.18.0) (2026-01-23)


### Features

* **cli:** improve vm0 init onboarding with model-provider setup ([#1571](https://github.com/vm0-ai/vm0/issues/1571)) ([e4e4c23](https://github.com/vm0-ai/vm0/commit/e4e4c23c7d5681965f573e1795b360b5cc3d07b1))
* **platform:** add feature switches for sidebar navigation sections ([#1556](https://github.com/vm0-ai/vm0/issues/1556)) ([993375f](https://github.com/vm0-ai/vm0/commit/993375f342b4f11d6e8b050ac9c8b6dfdc27c410))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.4.0

## [0.17.0](https://github.com/vm0-ai/vm0/compare/platform-v0.16.0...platform-v0.17.0) (2026-01-23)


### Features

* **platform:** add onboarding flow with automatic scope creation ([#1514](https://github.com/vm0-ai/vm0/issues/1514)) ([a6c34b4](https://github.com/vm0-ai/vm0/commit/a6c34b4069c94a4d7d3bb6426aa05549424b4f85))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.3.1

## [0.16.0](https://github.com/vm0-ai/vm0/compare/platform-v0.15.1...platform-v0.16.0) (2026-01-22)


### Features

* add cyclomatic complexity checking to eslint ([#1502](https://github.com/vm0-ai/vm0/issues/1502)) ([d3b2859](https://github.com/vm0-ai/vm0/commit/d3b2859ca7374964c78fc5a4f0a76566c01551e3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.3.0

## [0.15.1](https://github.com/vm0-ai/vm0/compare/platform-v0.15.0...platform-v0.15.1) (2026-01-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.2.0

## [0.15.0](https://github.com/vm0-ai/vm0/compare/platform-v0.14.1...platform-v0.15.0) (2026-01-21)


### Features

* **ui:** enhance design system with color tokens and improve navigation icons and clerk styling ([#1466](https://github.com/vm0-ai/vm0/issues/1466)) ([be12e83](https://github.com/vm0-ai/vm0/commit/be12e83029093b9beab0afc5307926ccecb30571))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.1.0

## [0.14.1](https://github.com/vm0-ai/vm0/compare/platform-v0.14.0...platform-v0.14.1) (2026-01-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.0.0

## [0.14.0](https://github.com/vm0-ai/vm0/compare/platform-v0.13.0...platform-v0.14.0) (2026-01-21)


### Features

* implement logs page signal architecture (Phase 1 & 2) ([#1373](https://github.com/vm0-ai/vm0/issues/1373)) ([5488e1b](https://github.com/vm0-ai/vm0/commit/5488e1b114a561f17d3532d21471f8e5100c9cda))
* implement logs page view components (Phase 3) ([#1394](https://github.com/vm0-ai/vm0/issues/1394)) ([4e54930](https://github.com/vm0-ai/vm0/commit/4e549306af27c645c50ad82f831b8fbcbed9464d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.9.0

## [0.13.0](https://github.com/vm0-ai/vm0/compare/platform-v0.12.0...platform-v0.13.0) (2026-01-20)


### Features

* **core:** implement feature flag system across all packages ([#1334](https://github.com/vm0-ai/vm0/issues/1334)) ([b90205e](https://github.com/vm0-ai/vm0/commit/b90205ebcc0f7de5bcb0af12a957420873eb3253)), closes [#1333](https://github.com/vm0-ai/vm0/issues/1333)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.8.0

## [0.12.0](https://github.com/vm0-ai/vm0/compare/platform-v0.11.0...platform-v0.12.0) (2026-01-19)


### Features

* **billing:** integrate clerk billing mvp ([#1308](https://github.com/vm0-ai/vm0/issues/1308)) ([836a295](https://github.com/vm0-ai/vm0/commit/836a2953fe5eaae70450b544d0a155f8b30e0742))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/platform-v0.10.2...platform-v0.11.0) (2026-01-19)


### Features

* **web:** add instatus status widget to landing page ([#1313](https://github.com/vm0-ai/vm0/issues/1313)) ([be54222](https://github.com/vm0-ai/vm0/commit/be54222b5f11951e1d370da1b63940548867ca58))

## [0.10.2](https://github.com/vm0-ai/vm0/compare/platform-v0.10.1...platform-v0.10.2) (2026-01-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.5.0

## [0.10.1](https://github.com/vm0-ai/vm0/compare/platform-v0.10.0...platform-v0.10.1) (2026-01-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.4.0

## [0.10.0](https://github.com/vm0-ai/vm0/compare/platform-v0.9.1...platform-v0.10.0) (2026-01-13)


### Features

* **auth:** update Clerk SDK and improve authentication page handling ([#1152](https://github.com/vm0-ai/vm0/issues/1152)) ([f096220](https://github.com/vm0-ai/vm0/commit/f0962202035241d006520f9bc9e1508414edcb7e))


### Bug Fixes

* **docs:** trigger production deployment for cli reference updates ([#1173](https://github.com/vm0-ai/vm0/issues/1173)) ([57baf42](https://github.com/vm0-ai/vm0/commit/57baf42d83a19652c9db2881e48f50fd1a0054e6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.3.0

## [0.9.1](https://github.com/vm0-ai/vm0/compare/platform-v0.9.0...platform-v0.9.1) (2026-01-13)


### Bug Fixes

* **docs:** trigger production deployment for quick start updates ([#1142](https://github.com/vm0-ai/vm0/issues/1142)) ([f8fb029](https://github.com/vm0-ai/vm0/commit/f8fb029227bfc5151a5af30154a0cfb4bc28b480)), closes [#1118](https://github.com/vm0-ai/vm0/issues/1118)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.2.1

## [0.9.0](https://github.com/vm0-ai/vm0/compare/platform-v0.8.0...platform-v0.9.0) (2026-01-12)


### Features

* **platform:** add environment variable sync and require vite_api_url ([#1119](https://github.com/vm0-ai/vm0/issues/1119)) ([9e9b025](https://github.com/vm0-ai/vm0/commit/9e9b0254c46bfe3b1bfcb6a12f8079e127008f41))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/platform-v0.7.5...platform-v0.8.0) (2026-01-12)


### Features

* **platform:** implement dashboard layout system with sidebar and navbar ([#1097](https://github.com/vm0-ai/vm0/issues/1097)) ([b0b8061](https://github.com/vm0-ai/vm0/commit/b0b806158e1f040e4f45f658512651764ad74c2a))
* **platform:** require authentication for home page ([#1112](https://github.com/vm0-ai/vm0/issues/1112)) ([8d3b669](https://github.com/vm0-ai/vm0/commit/8d3b6699d8680a88a230da6f43560baffbb0d5b6))


### Bug Fixes

* **platform:** reduce eslint warnings from 42 to 21 ([#1110](https://github.com/vm0-ai/vm0/issues/1110)) ([dd48461](https://github.com/vm0-ai/vm0/commit/dd48461b8250a419d84fc53e0427f501cbef92a4))

## [0.7.5](https://github.com/vm0-ai/vm0/compare/platform-v0.7.4...platform-v0.7.5) (2026-01-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.2.0

## [0.7.4](https://github.com/vm0-ai/vm0/compare/platform-v0.7.3...platform-v0.7.4) (2026-01-11)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.1.1

## [0.7.3](https://github.com/vm0-ai/vm0/compare/platform-v0.7.2...platform-v0.7.3) (2026-01-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.1.0

## [0.7.2](https://github.com/vm0-ai/vm0/compare/platform-v0.7.1...platform-v0.7.2) (2026-01-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.0.0

## [0.7.1](https://github.com/vm0-ai/vm0/compare/platform-v0.7.0...platform-v0.7.1) (2026-01-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.4.0

## [0.7.0](https://github.com/vm0-ai/vm0/compare/platform-v0.6.0...platform-v0.7.0) (2026-01-09)


### Features

* **platform:** migrate phase 2 infrastructure from uspark workspace ([#1033](https://github.com/vm0-ai/vm0/issues/1033)) ([f494d34](https://github.com/vm0-ai/vm0/commit/f494d34f9ae7018eff735f873066a21cf128f3c2))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/platform-v0.5.0...platform-v0.6.0) (2026-01-09)


### Features

* **platform:** migrate infrastructure components from uspark workspace ([#1014](https://github.com/vm0-ai/vm0/issues/1014)) ([29c3309](https://github.com/vm0-ai/vm0/commit/29c33097d81e027ce455f7ad51b9660a2ff40d39))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.3.0

## [0.5.0](https://github.com/vm0-ai/vm0/compare/platform-v0.4.1...platform-v0.5.0) (2026-01-09)


### Features

* **app:** update homepage to welcome message with description ([#1009](https://github.com/vm0-ai/vm0/issues/1009)) ([8e9b67e](https://github.com/vm0-ai/vm0/commit/8e9b67e98249961e3aa79473fbb6873f9aa18441))
* **docs:** trigger release for product philosophy page ([#884](https://github.com/vm0-ai/vm0/issues/884)) ([45ec3a2](https://github.com/vm0-ai/vm0/commit/45ec3a296b4d4ac01b4ac1f0536692d1626c7551))


### Bug Fixes

* **cli:** revert system_prompt and system_skills feature ([#540](https://github.com/vm0-ai/vm0/issues/540)) ([b2254fe](https://github.com/vm0-ai/vm0/commit/b2254fec128a641106aa1db67faac938e39e3b3b))
* **docs:** trigger release for documentation updates ([#993](https://github.com/vm0-ai/vm0/issues/993)) ([1f3e2be](https://github.com/vm0-ai/vm0/commit/1f3e2be18c74219b2954c0d98a6456bf35b055ca))

## [0.4.1](https://github.com/vm0-ai/vm0/compare/app-v0.4.0...app-v0.4.1) (2026-01-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.2.0

## [0.4.0](https://github.com/vm0-ai/vm0/compare/app-v0.3.0...app-v0.4.0) (2026-01-09)


### Features

* **app:** update homepage to display hello world ([#995](https://github.com/vm0-ai/vm0/issues/995)) ([c02b1b6](https://github.com/vm0-ai/vm0/commit/c02b1b6dc179659026c0d10f3b8d7ab59b16f8a8))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/app-v0.2.0...app-v0.3.0) (2026-01-09)


### Features

* **app:** add custom eslint rules for ccstate patterns ([#990](https://github.com/vm0-ai/vm0/issues/990)) ([a4df947](https://github.com/vm0-ai/vm0/commit/a4df947959891de24425e2f7dbc134fcf8d663f7))
* **app:** add msw for api mocking in tests and development ([#992](https://github.com/vm0-ai/vm0/issues/992)) ([0d2b2ad](https://github.com/vm0-ai/vm0/commit/0d2b2ad2cd80bc80c3b37d15dae304be26b8c5c1))
* **app:** add type-safe environment configuration ([#987](https://github.com/vm0-ai/vm0/issues/987)) ([99ecb46](https://github.com/vm0-ai/vm0/commit/99ecb4659d2fb4222c1a6e176eb559fc3c49f1a7))


### Bug Fixes

* **docs:** trigger release for documentation updates ([#993](https://github.com/vm0-ai/vm0/issues/993)) ([1f3e2be](https://github.com/vm0-ai/vm0/commit/1f3e2be18c74219b2954c0d98a6456bf35b055ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.1.1

## [0.2.0](https://github.com/vm0-ai/vm0/compare/app-v0.1.0...app-v0.2.0) (2026-01-08)


### Features

* **app:** initialize app subproject with Vite SPA and ccstate ([#967](https://github.com/vm0-ai/vm0/issues/967)) ([b3227d3](https://github.com/vm0-ai/vm0/commit/b3227d341e53ba33e3a43321e863d8760cbb7eee))
* **ci:** add ci/cd integration for app subproject ([#981](https://github.com/vm0-ai/vm0/issues/981)) ([9b5a83a](https://github.com/vm0-ai/vm0/commit/9b5a83aeb5a497ce4fb6373b2207fd2c0969354c))
* **docs:** trigger release for product philosophy page ([#884](https://github.com/vm0-ai/vm0/issues/884)) ([45ec3a2](https://github.com/vm0-ai/vm0/commit/45ec3a296b4d4ac01b4ac1f0536692d1626c7551))
* **proxy:** add platform.vm7.ai reverse proxy for app ([#980](https://github.com/vm0-ai/vm0/issues/980)) ([1db0a18](https://github.com/vm0-ai/vm0/commit/1db0a183840e2312c6de3b8d3585554a14546688))


### Bug Fixes

* **cli:** revert system_prompt and system_skills feature ([#540](https://github.com/vm0-ai/vm0/issues/540)) ([b2254fe](https://github.com/vm0-ai/vm0/commit/b2254fec128a641106aa1db67faac938e39e3b3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.1.0
