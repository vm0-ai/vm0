# Changelog

## [12.300.2](https://github.com/vm0-ai/vm0/compare/web-v12.300.1...web-v12.300.2) (2026-04-25)


### Bug Fixes

* **chat:** switch to new threads optimistically ([#11050](https://github.com/vm0-ai/vm0/issues/11050)) ([4897e71](https://github.com/vm0-ai/vm0/commit/4897e716fbfdcdfa4b3edac3f928f50f75cc57a2))
* re-add AudioOutput feature switch guards on UI and TTS route ([#11049](https://github.com/vm0-ai/vm0/issues/11049)) ([7f2e59b](https://github.com/vm0-ai/vm0/commit/7f2e59bac342ad624fea0ba7d4af336d12b92691))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.235.0

## [12.300.1](https://github.com/vm0-ai/vm0/compare/web-v12.300.0...web-v12.300.1) (2026-04-24)


### Performance Improvements

* **chat:** avoid redundant startup requests ([#11039](https://github.com/vm0-ai/vm0/issues/11039)) ([549f656](https://github.com/vm0-ai/vm0/commit/549f656df8a35fc90b962d71ca1764e12d44975e))
* **chat:** defer user message insert into after() to speed 201 response ([#11037](https://github.com/vm0-ai/vm0/issues/11037)) ([8fcf43b](https://github.com/vm0-ai/vm0/commit/8fcf43bc24c3ae5df879595705300ff9bb8829e9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.234.1

## [12.300.0](https://github.com/vm0-ai/vm0/compare/web-v12.299.0...web-v12.300.0) (2026-04-24)


### Features

* **eslint:** add no-global-assignment rule banning new globals ([#11005](https://github.com/vm0-ai/vm0/issues/11005)) ([2dec8c9](https://github.com/vm0-ai/vm0/commit/2dec8c9ddd2cff2b1985806373dc3059b33e4c05))
* remove deprecated deepseek-chat/reasoner, add v4 credit multipliers ([#11014](https://github.com/vm0-ai/vm0/issues/11014)) ([7f4eb57](https://github.com/vm0-ai/vm0/commit/7f4eb57fcf8f8d3a4040787ec854fac5fac51ec0))
* **web:** make use-case try-it button prominent ([#10994](https://github.com/vm0-ai/vm0/issues/10994)) ([e4af2a5](https://github.com/vm0-ai/vm0/commit/e4af2a54e90dffa8a75816d068214caacc13d356))


### Bug Fixes

* fall back to agent default model in createZeroRunRecord ([#11016](https://github.com/vm0-ai/vm0/issues/11016)) ([c8e31b3](https://github.com/vm0-ai/vm0/commit/c8e31b3f18f79cf980d368951c2256e8f6d2cdfd))
* **pricing:** render structured data server-side ([#10991](https://github.com/vm0-ai/vm0/issues/10991)) ([1b57854](https://github.com/vm0-ai/vm0/commit/1b57854488bfe90b6c3d4a708c2c50d2326c8707))
* **zero:** seed memory artifact into agent_sessions.artifacts on new runs ([#11032](https://github.com/vm0-ai/vm0/issues/11032)) ([d4aa838](https://github.com/vm0-ai/vm0/commit/d4aa8389229ce94f3acefb589afb5489a148ac91))


### Refactoring

* remove chat thread list item agentId ([#10998](https://github.com/vm0-ai/vm0/issues/10998)) ([2d62c16](https://github.com/vm0-ai/vm0/commit/2d62c168caa019b7e65e26d6f2bf713b798608a8))


### Performance Improvements

* **guest-agent:** skip vas snapshot for unchanged artifacts (part 2 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10989](https://github.com/vm0-ai/vm0/issues/10989)) ([4d4b18e](https://github.com/vm0-ai/vm0/commit/4d4b18ede0f7f13c767cb8d50726d9ea1e69c780))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.234.0

## [12.299.0](https://github.com/vm0-ai/vm0/compare/web-v12.298.0...web-v12.299.0) (2026-04-24)


### Features

* **telemetry:** add enqueue/dequeue spans to zero-run queue ([#10988](https://github.com/vm0-ai/vm0/issues/10988)) ([6e0a522](https://github.com/vm0-ai/vm0/commit/6e0a5229d59633ad8419e04ba2efca6dd2d79827))


### Bug Fixes

* adjust chat run error messaging ([#10983](https://github.com/vm0-ai/vm0/issues/10983)) ([79c9251](https://github.com/vm0-ai/vm0/commit/79c9251a1bf9fd3663e2cf415b3ba4da94ba5549))


### Refactoring

* **zero-run-policy:** decouple credit check from model-provider selection ([#10995](https://github.com/vm0-ai/vm0/issues/10995)) ([93bbe71](https://github.com/vm0-ai/vm0/commit/93bbe71197615aa827b8ad1c2c3d5261e33a5557))

## [12.298.0](https://github.com/vm0-ai/vm0/compare/web-v12.297.0...web-v12.298.0) (2026-04-24)


### Features

* add deepseek v4 models ([#10956](https://github.com/vm0-ai/vm0/issues/10956)) ([292ed24](https://github.com/vm0-ai/vm0/commit/292ed2401576ed7451962e7c3e391ea61a6b9e3b))
* add promo-video-from-recordings use case ([#10691](https://github.com/vm0-ai/vm0/issues/10691)) ([303abec](https://github.com/vm0-ai/vm0/commit/303abec703e642dd9f4910ec7dd13af5a119c95b))


### Refactoring

* **generate-image:** migrate to usage_event billing + tests + production gate ([#10979](https://github.com/vm0-ai/vm0/issues/10979)) ([72ea577](https://github.com/vm0-ai/vm0/commit/72ea577bce1b150076ea7d5e6cea155ef7e2dddf))
* **telegram:** pivot installation PK to telegram_bot_id and add owner+org columns ([#10250](https://github.com/vm0-ai/vm0/issues/10250)) ([5fdd5b6](https://github.com/vm0-ai/vm0/commit/5fdd5b6c8d0a6f32a3a916af419d0a378e3a3de1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.233.0

## [12.297.0](https://github.com/vm0-ai/vm0/compare/web-v12.296.0...web-v12.297.0) (2026-04-24)


### Features

* thread storage id from web to guest-agent (part 1 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10978](https://github.com/vm0-ai/vm0/issues/10978)) ([85f2193](https://github.com/vm0-ai/vm0/commit/85f219383d3cf7b81ca6f41358276d5388acb8c0))

## [12.296.0](https://github.com/vm0-ai/vm0/compare/web-v12.295.0...web-v12.296.0) (2026-04-24)


### Features

* **slack:** graduate agent switching ([#10964](https://github.com/vm0-ai/vm0/issues/10964)) ([cf070f8](https://github.com/vm0-ai/vm0/commit/cf070f857f4ded9f16f5a6d932ba091b3d022ec5))


### Bug Fixes

* add missing pricing FAQ i18n keys for upgradeCredits ([#10925](https://github.com/vm0-ai/vm0/issues/10925)) ([c256c67](https://github.com/vm0-ai/vm0/commit/c256c67c05d921af193752eac44b1efa55d9202c))
* redirect missing agent routes to default agent ([#10942](https://github.com/vm0-ai/vm0/issues/10942)) ([9442bf0](https://github.com/vm0-ai/vm0/commit/9442bf08d0ae97a05ab5be4221f3277a7decdfe9))


### Performance Improvements

* **db:** switch production db driver from neon websocket to pg tcp pool under fluid ([#10959](https://github.com/vm0-ai/vm0/issues/10959)) ([151c602](https://github.com/vm0-ai/vm0/commit/151c6024deac793212a68f8078cc8015c3a86937)), closes [#10953](https://github.com/vm0-ai/vm0/issues/10953)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.232.0

## [12.295.0](https://github.com/vm0-ai/vm0/compare/web-v12.294.0...web-v12.295.0) (2026-04-24)


### Features

* add browser-use connector ([#10922](https://github.com/vm0-ai/vm0/issues/10922)) ([9a4edc4](https://github.com/vm0-ai/vm0/commit/9a4edc45e87e7863d5d2bfa79d522938b4703aa8))
* integrate Gemini 2.5 Flash Image via Vertex AI + Vercel OIDC ([#10611](https://github.com/vm0-ai/vm0/issues/10611)) ([93b8ddd](https://github.com/vm0-ai/vm0/commit/93b8ddd9cc498787968d8e911195a1d46333c4df))
* **platform:** improve chat document previews ([#10940](https://github.com/vm0-ai/vm0/issues/10940)) ([fe836c8](https://github.com/vm0-ai/vm0/commit/fe836c852bafc7325eb2fd2b094371d766d97271))


### Bug Fixes

* **web:** notify runners on org/user deletion cancel path ([#10946](https://github.com/vm0-ai/vm0/issues/10946)) ([6d8c3e4](https://github.com/vm0-ai/vm0/commit/6d8c3e4f20938a8b88c8afa6a32c2d73bb4018fb))


### Performance Improvements

* **chat-messages:** short-circuit round3 capture arm when quota is zero ([#10950](https://github.com/vm0-ai/vm0/issues/10950)) ([2f10594](https://github.com/vm0-ai/vm0/commit/2f10594218a09d57876bc7933edb0e7cf17c2379))
* **chat:** fuse round2 user_prefs + feature_sw into single cte ([#10949](https://github.com/vm0-ai/vm0/issues/10949)) ([7e5f020](https://github.com/vm0-ai/vm0/commit/7e5f020e7cb45389fb9cb8b0a136248e5a88d818)), closes [#10943](https://github.com/vm0-ai/vm0/issues/10943)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.231.0

## [12.294.0](https://github.com/vm0-ai/vm0/compare/web-v12.293.0...web-v12.294.0) (2026-04-23)


### Features

* **billing:** add usage_event processor cron ([#10713](https://github.com/vm0-ai/vm0/issues/10713)) ([b52552b](https://github.com/vm0-ai/vm0/commit/b52552b448230c9c49075c15647d66144cde5049))
* **compose:** support mount_path on artifact entries ([#10908](https://github.com/vm0-ai/vm0/issues/10908)) ([#10914](https://github.com/vm0-ai/vm0/issues/10914)) ([c907fd5](https://github.com/vm0-ai/vm0/commit/c907fd5196df2160c999db1a3a39340c0d9342e0))


### Bug Fixes

* disable reasoner task backfill in voice chat ([#10889](https://github.com/vm0-ai/vm0/issues/10889)) ([174da7b](https://github.com/vm0-ai/vm0/commit/174da7b8cba74e8bedcf95533e278bb443f2342d))
* remove starter credit grant from campaign checkout path ([#10896](https://github.com/vm0-ai/vm0/issues/10896)) ([1cc59a2](https://github.com/vm0-ai/vm0/commit/1cc59a2d89586fc39014074f57b8b3a73e3555fc))
* **slack:** show reply-to footer when &gt;1 user mentions Zero in thread ([#10904](https://github.com/vm0-ai/vm0/issues/10904)) ([f2c73a3](https://github.com/vm0-ai/vm0/commit/f2c73a3d12a05354eb7303a32fb864aa962c1cbe))
* **voice-chat:** recover mic on track ended event for iOS notification center and screen auto-dim ([#10888](https://github.com/vm0-ai/vm0/issues/10888)) ([70bcbfc](https://github.com/vm0-ai/vm0/commit/70bcbfce26bce0c50aa396ddceaddf1a0cc7902f))
* **web:** dispatch cancel side effects for voice-chat mismatch path ([#10916](https://github.com/vm0-ai/vm0/issues/10916)) ([1a46ebb](https://github.com/vm0-ai/vm0/commit/1a46ebbfcf18284383095bef57ce424985ebe5f4))
* **zero:** skip memory injection on checkpoint/session resume paths ([#10910](https://github.com/vm0-ai/vm0/issues/10910)) ([#10920](https://github.com/vm0-ai/vm0/issues/10920)) ([8b20975](https://github.com/vm0-ai/vm0/commit/8b20975e7be4ecc83861d30e988ece6aa56c5a31))


### Refactoring

* **checkpoint:** tolerate array-shape artifact snapshots end-to-end ([#10919](https://github.com/vm0-ai/vm0/issues/10919)) ([0a12bc6](https://github.com/vm0-ai/vm0/commit/0a12bc68a8efb87d07f65fb56aac19708addda56))
* drop voice-chat-candidate prefix in platform signals and rename ably topic ([#10885](https://github.com/vm0-ai/vm0/issues/10885)) ([391b756](https://github.com/vm0-ai/vm0/commit/391b7561cd40b50e1d542ef278333724e21e88a7))
* **infra:** flatten artifact scalars to record map (closes [#10861](https://github.com/vm0-ai/vm0/issues/10861)) ([#10876](https://github.com/vm0-ai/vm0/issues/10876)) ([fce4760](https://github.com/vm0-ai/vm0/commit/fce4760ddad775fcb33dce2c0a78baf61609c343))
* **infra:** unify artifact model with tolerant resolvers ([#10915](https://github.com/vm0-ai/vm0/issues/10915)) ([b43e572](https://github.com/vm0-ai/vm0/commit/b43e572c5c7367b35506df4f33ecbea88ed78c7a))
* **web:** rename backend voice-chat-candidate dirs, service exports, and event-consumer registry ([#10886](https://github.com/vm0-ai/vm0/issues/10886)) ([39315bd](https://github.com/vm0-ai/vm0/commit/39315bd8a7f6d1b0044954992b757259fe6a276f))


### Performance Improvements

* **chat-messages:** fold compose content into round 1 to drop round 2 load arm ([#10881](https://github.com/vm0-ai/vm0/issues/10881)) ([b37c664](https://github.com/vm0-ai/vm0/commit/b37c6648e253de2da9fb96d47cee304caf35f012))
* **chat:** fuse org credit-check queries into a single cte ([#10882](https://github.com/vm0-ai/vm0/issues/10882)) ([4d60d3e](https://github.com/vm0-ai/vm0/commit/4d60d3e7cdf919aa4d721d14f4059a5063ad7661)), closes [#10874](https://github.com/vm0-ai/vm0/issues/10874) [#10796](https://github.com/vm0-ai/vm0/issues/10796)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.230.0

## [12.293.0](https://github.com/vm0-ai/vm0/compare/web-v12.292.0...web-v12.293.0) (2026-04-23)


### Features

* **db:** rename feature_candidate_voice_chat_* tables and schema to voice_chat_* ([#10860](https://github.com/vm0-ai/vm0/issues/10860)) ([ce7ca21](https://github.com/vm0-ai/vm0/commit/ce7ca21fc22c936febeb6c1cfeb5a3a00cfd7d6f)), closes [#10854](https://github.com/vm0-ai/vm0/issues/10854)


### Refactoring

* remove turbo core root imports ([#10820](https://github.com/vm0-ai/vm0/issues/10820)) ([ec85609](https://github.com/vm0-ai/vm0/commit/ec8560930db70e5c1f853961ff51606e601da875))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.229.4

## [12.292.0](https://github.com/vm0-ai/vm0/compare/web-v12.291.1...web-v12.292.0) (2026-04-23)


### Features

* **pricing:** add voice input across website and in-app Compare plans ([#10813](https://github.com/vm0-ai/vm0/issues/10813)) ([c38e057](https://github.com/vm0-ai/vm0/commit/c38e057579af77832f56d3975ef8fb181f2e8e85))


### Bug Fixes

* harden speakerphone barge-in in voice chat candidate ([#10845](https://github.com/vm0-ai/vm0/issues/10845)) ([fca73af](https://github.com/vm0-ai/vm0/commit/fca73af116b1f57a2487edd2c7aff47e408c0b33))

## [12.291.1](https://github.com/vm0-ai/vm0/compare/web-v12.291.0...web-v12.291.1) (2026-04-23)


### Bug Fixes

* validate redirect URLs in checkout and portal billing routes ([#10693](https://github.com/vm0-ai/vm0/issues/10693)) ([5264769](https://github.com/vm0-ai/vm0/commit/52647691ec0e63d91479d139ae9242d38fc5744e))

## [12.291.0](https://github.com/vm0-ai/vm0/compare/web-v12.290.1...web-v12.291.0) (2026-04-23)


### Features

* add cold outreach pipeline use case (Apollo + Instantly) ([#10689](https://github.com/vm0-ai/vm0/issues/10689)) ([3e781e8](https://github.com/vm0-ai/vm0/commit/3e781e85eb3a591a46b8e110e2e8bd4b395fd63c))


### Bug Fixes

* add auto-recharge threshold/amount bounds and loop prevention ([#10695](https://github.com/vm0-ai/vm0/issues/10695)) ([9e2e011](https://github.com/vm0-ai/vm0/commit/9e2e011d6404f6641a6cccfa1ca7dd324f5939f4))
* **auth:** stop password toggle flicker on sign-in page ([#10817](https://github.com/vm0-ai/vm0/issues/10817)) ([91b0566](https://github.com/vm0-ai/vm0/commit/91b0566425fe4f61bda742b93003efbe0b432354)), closes [#10462](https://github.com/vm0-ai/vm0/issues/10462)
* don't let sessions.expire failure permanently block campaign redemption ([#10694](https://github.com/vm0-ai/vm0/issues/10694)) ([68dc4bf](https://github.com/vm0-ai/vm0/commit/68dc4bf9de08b9b68b50fb4522730304a9772e17))
* open queue drawer via URL param and remove /queue route ([#10684](https://github.com/vm0-ai/vm0/issues/10684)) ([f547217](https://github.com/vm0-ai/vm0/commit/f547217cf19e0a66463e93d6db57f918968b8a41))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.229.3

## [12.290.1](https://github.com/vm0-ai/vm0/compare/web-v12.290.0...web-v12.290.1) (2026-04-23)


### Bug Fixes

* **voice-chat-candidate:** adaptive echo cancellation and server-side session config ([#10795](https://github.com/vm0-ai/vm0/issues/10795)) ([2782e42](https://github.com/vm0-ai/vm0/commit/2782e42e8a562a4c20ecebbd5630de0f6ae21cf3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.229.2

## [12.290.0](https://github.com/vm0-ai/vm0/compare/web-v12.289.0...web-v12.290.0) (2026-04-23)


### Features

* **db:** add billing_error column to usage_event ([#10786](https://github.com/vm0-ai/vm0/issues/10786)) ([1d9b465](https://github.com/vm0-ai/vm0/commit/1d9b465d698822054647200ca930d1349194a423))
* let reasoner auto-create tasks the talker promised but never dispatched ([#10719](https://github.com/vm0-ai/vm0/issues/10719)) ([63504b2](https://github.com/vm0-ai/vm0/commit/63504b2a16e4f4393e150296c79eca10cfab3e76))


### Bug Fixes

* **webhooks:** 404 instead of 500 when run deleted mid-webhook ([#10785](https://github.com/vm0-ai/vm0/issues/10785)) ([258a07e](https://github.com/vm0-ai/vm0/commit/258a07eb43a867e33ed12f7683a47f78ac8ebd51))


### Refactoring

* **webhooks:** tighten fk-race error helper and test its contract ([#10790](https://github.com/vm0-ai/vm0/issues/10790)) ([0b2fe2b](https://github.com/vm0-ai/vm0/commit/0b2fe2b978645ca013cbc7e4cdbed773835f9107))

## [12.289.0](https://github.com/vm0-ai/vm0/compare/web-v12.288.0...web-v12.289.0) (2026-04-23)


### Features

* **auth:** carry org id in sandbox jwt ([#10770](https://github.com/vm0-ai/vm0/issues/10770)) ([b10bee0](https://github.com/vm0-ai/vm0/commit/b10bee0b4c4490b97ae8cc899b3c75eae74ae7c9)), closes [#10767](https://github.com/vm0-ai/vm0/issues/10767)


### Bug Fixes

* block vm0 run when org_metadata row is missing ([#10683](https://github.com/vm0-ai/vm0/issues/10683)) ([e2a5c56](https://github.com/vm0-ai/vm0/commit/e2a5c56bd480f4204c83426b8d65280c1b7e4c2c))


### Refactoring

* remove ArtifactSnapshot singleton type and checkpoint legacy branch ([#10747](https://github.com/vm0-ai/vm0/issues/10747)) ([ed4d601](https://github.com/vm0-ai/vm0/commit/ed4d601348a1f92e6f6bd7bf75623a5301f788ad))
* remove http legacy run body shim and deprecated contract fields ([#10751](https://github.com/vm0-ai/vm0/issues/10751)) ([4c23933](https://github.com/vm0-ai/vm0/commit/4c23933d1e51caae00eadf0cb98ba6d55888e222))


### Performance Improvements

* **chat:** add partial index on zero_runs.chat_thread_id ([#10765](https://github.com/vm0-ai/vm0/issues/10765)) ([40515e7](https://github.com/vm0-ai/vm0/commit/40515e7a459dc20d2701720a563d2cbea9f0180b)), closes [#10757](https://github.com/vm0-ai/vm0/issues/10757)
* **chat:** move thread-history fetch off the chat-send critical path ([#10766](https://github.com/vm0-ai/vm0/issues/10766)) ([5c82e10](https://github.com/vm0-ai/vm0/commit/5c82e101512f69b4b2357f09a5a79e72e10c501b))
* **chat:** skip user cache lookup when session claims carry identity ([#10758](https://github.com/vm0-ai/vm0/issues/10758)) ([262d976](https://github.com/vm0-ai/vm0/commit/262d97683ac7f90c5e5591b99b95c4995358d55e)), closes [#10746](https://github.com/vm0-ai/vm0/issues/10746)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.229.1

## [12.288.0](https://github.com/vm0-ai/vm0/compare/web-v12.287.1...web-v12.288.0) (2026-04-23)


### Features

* update pricing FAQ to reflect credit logic ([#10664](https://github.com/vm0-ai/vm0/issues/10664)) ([122dbf9](https://github.com/vm0-ai/vm0/commit/122dbf9b65d17a36408e4d4ea9318917d26d8d97))

## [12.287.1](https://github.com/vm0-ai/vm0/compare/web-v12.287.0...web-v12.287.1) (2026-04-23)


### Bug Fixes

* flaky tests caused by midnight edge case and missing abort signal ([#10721](https://github.com/vm0-ai/vm0/issues/10721)) ([17ea31e](https://github.com/vm0-ai/vm0/commit/17ea31e7a8fc793f9ce5c6466bcedc81fac0102a))

## [12.287.0](https://github.com/vm0-ai/vm0/compare/web-v12.286.0...web-v12.287.0) (2026-04-22)


### Features

* add onyx connector ([#10703](https://github.com/vm0-ai/vm0/issues/10703)) ([4e84b4f](https://github.com/vm0-ai/vm0/commit/4e84b4f208fe448966794cb7bb3caa8b9dacd160))
* **billing:** unify connector_billing into usage_event table ([#10704](https://github.com/vm0-ai/vm0/issues/10704)) ([6f9c462](https://github.com/vm0-ai/vm0/commit/6f9c4622a47619404b31adb3c980e80546094528))
* **db:** add usage_pricing table for per-category billing rates ([#10705](https://github.com/vm0-ai/vm0/issues/10705)) ([8aee508](https://github.com/vm0-ai/vm0/commit/8aee50841d55f93f21d938a4d3816fd8aec84026))
* **seed:** add x connector pricing to usage_pricing ([#10709](https://github.com/vm0-ai/vm0/issues/10709)) ([dfd3763](https://github.com/vm0-ai/vm0/commit/dfd3763e504c3717125f2d42300964d89b10f864))
* **usage:** add today/yesterday ranges, replace 24h, fix 7d/28d window ([#10697](https://github.com/vm0-ai/vm0/issues/10697)) ([ccd9569](https://github.com/vm0-ai/vm0/commit/ccd95696da7ddaea0549a30792da336a0027962a))
* **voice-chat-candidate:** trinity voice-mode embed + stateless sessions ([#10699](https://github.com/vm0-ai/vm0/issues/10699)) ([02177db](https://github.com/vm0-ai/vm0/commit/02177db00bcd759d0b4c29d36aa1d064726058e8))


### Refactoring

* drop residual memory plumbing, legacy snapshot columns, and vm0 memory cli ([#10707](https://github.com/vm0-ai/vm0/issues/10707)) ([08f3ce8](https://github.com/vm0-ai/vm0/commit/08f3ce81273faf8ea7e2e4df67b69e774bcb963e))
* emit memory as artifacts[] entry and delete guest-agent symlink bootstrap ([#10700](https://github.com/vm0-ai/vm0/issues/10700)) ([e3f0120](https://github.com/vm0-ai/vm0/commit/e3f0120fbd90d9b9fb750e13440a9f21ea809d3a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.229.0

## [12.286.0](https://github.com/vm0-ai/vm0/compare/web-v12.285.0...web-v12.286.0) (2026-04-22)


### Features

* **billing:** add credit balance breakdown with stacked bar chart ([#10585](https://github.com/vm0-ai/vm0/issues/10585)) ([8b9c6d6](https://github.com/vm0-ai/vm0/commit/8b9c6d6314d7cdf0fdae1e2291cd5406bba4fca6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.228.0

## [12.285.0](https://github.com/vm0-ai/vm0/compare/web-v12.284.0...web-v12.285.0) (2026-04-22)


### Features

* **voice-chat-candidate:** add reasoner timing, task compaction, dev cron scheduler ([#10578](https://github.com/vm0-ai/vm0/issues/10578)) ([87d63eb](https://github.com/vm0-ai/vm0/commit/87d63eb187d75db495743d25292a79ce154c56e7))
* **voice-chat:** inject system task events into fast-brain ([#10676](https://github.com/vm0-ai/vm0/issues/10676)) ([7830a36](https://github.com/vm0-ai/vm0/commit/7830a361c9abfdae2c626cce9e7a0228adf50756))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.227.0

## [12.284.0](https://github.com/vm0-ai/vm0/compare/web-v12.283.1...web-v12.284.0) (2026-04-22)


### Features

* multi-mount artifact backend + checkpoint schema ([#10629](https://github.com/vm0-ai/vm0/issues/10629)) ([0f8af96](https://github.com/vm0-ai/vm0/commit/0f8af96cd55dedd89534ff430765cc34661a55fc))
* **voice-chat:** restore slow-brain tasker dispatch guidance ([#10672](https://github.com/vm0-ai/vm0/issues/10672)) ([32800c0](https://github.com/vm0-ai/vm0/commit/32800c09e9aac8650b6d4552d4e73533906e0f78))
* **zero:** dual-read memory storage (artifact→memory fallback) ([#10677](https://github.com/vm0-ai/vm0/issues/10677)) ([dff842b](https://github.com/vm0-ai/vm0/commit/dff842b869cf5d786b9b7ca3f6aff9bc846ff52e)), closes [#10600](https://github.com/vm0-ai/vm0/issues/10600)


### Bug Fixes

* **billing:** gate webhook credit grants on credit_expires_record insert ([#10668](https://github.com/vm0-ai/vm0/issues/10668)) ([26e8e31](https://github.com/vm0-ai/vm0/commit/26e8e315db51ffc7f79af0c0d2bf0a56ac7c48dd))


### Refactoring

* **web:** consolidate api-error factories and document sentry filter chain ([#10673](https://github.com/vm0-ai/vm0/issues/10673)) ([fa010ff](https://github.com/vm0-ai/vm0/commit/fa010ff1800f36dfdfc736fa6194ec2ef4840874)), closes [#10666](https://github.com/vm0-ai/vm0/issues/10666)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.226.0

## [12.283.1](https://github.com/vm0-ai/vm0/compare/web-v12.283.0...web-v12.283.1) (2026-04-22)


### Refactoring

* migrate /redeem/{campaign} flow from web to platform ([#10612](https://github.com/vm0-ai/vm0/issues/10612)) ([276f710](https://github.com/vm0-ai/vm0/commit/276f710ad2ab12f550175520a21960d2c9fc41b9))


### Performance Improvements

* **chat:** dedupe zero_agents and org_metadata reads on message post ([#10617](https://github.com/vm0-ai/vm0/issues/10617)) ([b83b480](https://github.com/vm0-ai/vm0/commit/b83b480388a5e76b6fafb6766c835d075d2f1e3e)), closes [#10594](https://github.com/vm0-ai/vm0/issues/10594)
* **chat:** parallelize thread resolution and bound message scans ([#10615](https://github.com/vm0-ai/vm0/issues/10615)) ([56b281f](https://github.com/vm0-ai/vm0/commit/56b281f4d58f18ca5ee86901bcebc4edac01aaa4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.225.1

## [12.283.0](https://github.com/vm0-ai/vm0/compare/web-v12.282.0...web-v12.283.0) (2026-04-22)


### Features

* add openai platform auth skeleton behind PlatformConnectors flag ([#10580](https://github.com/vm0-ai/vm0/issues/10580)) ([6f7614d](https://github.com/vm0-ai/vm0/commit/6f7614d0a8bf0f5119f6c8f3f8c110c3ab1a478d))
* **uploads:** serve permanent /f file redirect via public api host ([#10526](https://github.com/vm0-ai/vm0/issues/10526)) ([a5003fc](https://github.com/vm0-ai/vm0/commit/a5003fcc41e76139fcaea8be8a59058386998ce8))


### Bug Fixes

* **auth:** hide clerk create-organization buttons in sign-in ui ([#10581](https://github.com/vm0-ai/vm0/issues/10581)) ([4dd4b9a](https://github.com/vm0-ai/vm0/commit/4dd4b9a2c91c7e8e571e8717c83d213ef46c9485))
* **voice-chat:** resolve preparation timeout from task dispatch pollution ([#10582](https://github.com/vm0-ai/vm0/issues/10582)) ([6138f35](https://github.com/vm0-ai/vm0/commit/6138f353fe84dbbba286332035208712c57035a7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.225.0

## [12.282.0](https://github.com/vm0-ai/vm0/compare/web-v12.281.0...web-v12.282.0) (2026-04-22)


### Features

* **platform:** re-land chat thread model lock from [#10442](https://github.com/vm0-ai/vm0/issues/10442) ([#10571](https://github.com/vm0-ai/vm0/issues/10571)) ([ee11b28](https://github.com/vm0-ai/vm0/commit/ee11b28128fd1a9d5049214d3a94d87bcb71c433))
* **voice-chat:** add tasker backend service and routes ([#10561](https://github.com/vm0-ai/vm0/issues/10561)) ([402280f](https://github.com/vm0-ai/vm0/commit/402280f8c9484dab67972f5d8f8ce2cb22aa6897))
* **voice-chat:** enable tasker dispatch via slow-brain prompt ([#10570](https://github.com/vm0-ai/vm0/issues/10570)) ([5ca3824](https://github.com/vm0-ai/vm0/commit/5ca38248a95ee69548090363b7a852597e526965))


### Bug Fixes

* **credits:** admission gate subtracts unsettled expired credits ([#10567](https://github.com/vm0-ai/vm0/issues/10567)) ([2561567](https://github.com/vm0-ai/vm0/commit/2561567936c741a6ccd1246713ce95cf6fca2b1a))
* **uploads:** allow image/avif in zero upload allow-list ([#10568](https://github.com/vm0-ai/vm0/issues/10568)) ([752c22f](https://github.com/vm0-ai/vm0/commit/752c22ff38cbd5c72dd8d7ba791bb3c5ab9172c2)), closes [#10511](https://github.com/vm0-ai/vm0/issues/10511)

## [12.281.0](https://github.com/vm0-ai/vm0/compare/web-v12.280.0...web-v12.281.0) (2026-04-22)


### Features

* **db:** add voice_chat_tasks schema and contracts ([#10550](https://github.com/vm0-ai/vm0/issues/10550)) ([2ff102a](https://github.com/vm0-ai/vm0/commit/2ff102a9e8a510f533346ec25d0c0ad26bc61d1e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.224.0

## [12.280.0](https://github.com/vm0-ai/vm0/compare/web-v12.279.0...web-v12.280.0) (2026-04-22)


### Features

* add /buy/[productId] route for one-time promo credit purchases ([#10451](https://github.com/vm0-ai/vm0/issues/10451)) ([04e2b83](https://github.com/vm0-ai/vm0/commit/04e2b836f60c688f85963cace824a602c74e469e))
* add deepseek-reasoner to vm0 managed models ([#10532](https://github.com/vm0-ai/vm0/issues/10532)) ([c113802](https://github.com/vm0-ai/vm0/commit/c11380229af6afbfad202cbeaf234c90dcfda568))


### Bug Fixes

* **voice-chat:** auto-end stale session on double-start and unstick preparing UI ([#10536](https://github.com/vm0-ai/vm0/issues/10536)) ([2bb9fd9](https://github.com/vm0-ai/vm0/commit/2bb9fd95e5326a07e5aa8304fac9d924ed363263))
* **web:** enable Ably queryTime to prevent clock skew auth failures ([#10537](https://github.com/vm0-ai/vm0/issues/10537)) ([43142b2](https://github.com/vm0-ai/vm0/commit/43142b2c89ab0b3d9b7d022086ec3a644789f2b4)), closes [#10520](https://github.com/vm0-ai/vm0/issues/10520)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.223.0

## [12.279.0](https://github.com/vm0-ai/vm0/compare/web-v12.278.0...web-v12.279.0) (2026-04-22)


### Features

* add deepseek-chat to vm0 managed models with feature flag ([#10501](https://github.com/vm0-ai/vm0/issues/10501)) ([6d13890](https://github.com/vm0-ai/vm0/commit/6d13890d1c73f94372810b251241609579a16ce2))


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.222.0

## [12.278.0](https://github.com/vm0-ai/vm0/compare/web-v12.277.0...web-v12.278.0) (2026-04-22)


### Features

* **voice-chat-candidate:** three-column layout with live task event stream ([#10452](https://github.com/vm0-ai/vm0/issues/10452)) ([df2a3d5](https://github.com/vm0-ai/vm0/commit/df2a3d5a8e72186508e7b40fbc739db91ebb133e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.221.0

## [12.277.0](https://github.com/vm0-ai/vm0/compare/web-v12.276.6...web-v12.277.0) (2026-04-21)


### Features

* custom api keys management page with org context support ([#10469](https://github.com/vm0-ai/vm0/issues/10469)) ([aa14355](https://github.com/vm0-ai/vm0/commit/aa14355b8b6ed0a961f50c04a29376fcb965194e))
* **uploads:** serve permanent /f file redirect for attachments ([#10460](https://github.com/vm0-ai/vm0/issues/10460)) ([85fd3d4](https://github.com/vm0-ai/vm0/commit/85fd3d4338e18db10fdfc0f62b1f8c0b1adf9f6f))
* **voice-chat:** slow-brain graceful self-exit + session continue across (org, user) ([#10434](https://github.com/vm0-ai/vm0/issues/10434)) ([1c7d57d](https://github.com/vm0-ai/vm0/commit/1c7d57d344bf3998d9fb231ebcd325594c08dfa2))


### Bug Fixes

* **zero/billing:** return 4xx for downgrade preconditions instead of 500 ([#10465](https://github.com/vm0-ai/vm0/issues/10465)) ([7309a21](https://github.com/vm0-ai/vm0/commit/7309a213afbc54ce2f11548376d8f486e15653fc))


### Refactoring

* **billing:** unify connector billing gate on firewall_billable ([#10446](https://github.com/vm0-ai/vm0/issues/10446)) ([d8e23b9](https://github.com/vm0-ai/vm0/commit/d8e23b9b110b3979322ba44869a7cffe6cf289cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.220.0

## [12.276.6](https://github.com/vm0-ai/vm0/compare/web-v12.276.5...web-v12.276.6) (2026-04-21)


### Bug Fixes

* **db:** delete agent_runs whose compose was cascade-deleted (a2b bucket) ([#10456](https://github.com/vm0-ai/vm0/issues/10456)) ([b574303](https://github.com/vm0-ai/vm0/commit/b57430371f8e99dc0725583386c1bb75c231f7f7)), closes [#10447](https://github.com/vm0-ai/vm0/issues/10447)
* **web:** guard [locale] page against asset-like paths before auth() ([#10458](https://github.com/vm0-ai/vm0/issues/10458)) ([0df30e7](https://github.com/vm0-ai/vm0/commit/0df30e72fb63ea4507ba7266cfef7b4c7fb4fbe4))

## [12.276.5](https://github.com/vm0-ai/vm0/compare/web-v12.276.4...web-v12.276.5) (2026-04-21)


### Bug Fixes

* **zero:** gate firewall injection on credential presence again ([#10437](https://github.com/vm0-ai/vm0/issues/10437)) ([1f4abad](https://github.com/vm0-ai/vm0/commit/1f4abadcf6b6f3bcc74dc4a203ad8662bf0645ee))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.219.1

## [12.276.4](https://github.com/vm0-ai/vm0/compare/web-v12.276.3...web-v12.276.4) (2026-04-21)


### Bug Fixes

* **db:** delete 310 dangling agent_runs with missing sessions ([#10428](https://github.com/vm0-ai/vm0/issues/10428)) ([61de5bf](https://github.com/vm0-ai/vm0/commit/61de5bf42d0c677875097295edbe6832f5994181))


### Refactoring

* **activity:** tighten runner-tab types at api + seeder boundaries ([#10403](https://github.com/vm0-ai/vm0/issues/10403)) ([b5451e2](https://github.com/vm0-ai/vm0/commit/b5451e26aaf49f6f6f17e62d8e5b19ce5318da02))

## [12.276.3](https://github.com/vm0-ai/vm0/compare/web-v12.276.2...web-v12.276.3) (2026-04-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.219.0

## [12.276.2](https://github.com/vm0-ai/vm0/compare/web-v12.276.1...web-v12.276.2) (2026-04-21)


### Bug Fixes

* **web:** ts-rest api error triage and observability ([#10402](https://github.com/vm0-ai/vm0/issues/10402)) ([67d7ceb](https://github.com/vm0-ai/vm0/commit/67d7ceb879f70d3428ac895831201ca4124ded97))
* **zero:** disallow schedulewakeup tool for zero agent runs ([#10412](https://github.com/vm0-ai/vm0/issues/10412)) ([10eb97b](https://github.com/vm0-ai/vm0/commit/10eb97bba71a891c60fc6e38bedf013f896a1263))

## [12.276.1](https://github.com/vm0-ai/vm0/compare/web-v12.276.0...web-v12.276.1) (2026-04-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.218.0

## [12.276.0](https://github.com/vm0-ai/vm0/compare/web-v12.275.0...web-v12.276.0) (2026-04-21)


### Features

* **activity:** add runner tab with sandbox reuse result ([#10385](https://github.com/vm0-ai/vm0/issues/10385)) ([6d00d40](https://github.com/vm0-ai/vm0/commit/6d00d40ec5e0910f30d1287d7af07ad9a6fb222d))


### Bug Fixes

* **credits:** enforce credit expiration for non-subscription orgs ([#10304](https://github.com/vm0-ai/vm0/issues/10304)) ([786a8bc](https://github.com/vm0-ai/vm0/commit/786a8bcf78901b8fc791caeac44ea4068dad93f6)), closes [#10299](https://github.com/vm0-ai/vm0/issues/10299)
* **db:** keep agent_runs.session_id nullable to unblock production ([#10394](https://github.com/vm0-ai/vm0/issues/10394)) ([8a354fc](https://github.com/vm0-ai/vm0/commit/8a354fcfbc79d5b7b98ab022d7985eee3be0667f))


### Refactoring

* **queue:** prune dead non-zero branch in queued run dispatcher ([#10383](https://github.com/vm0-ai/vm0/issues/10383)) ([cae4fae](https://github.com/vm0-ai/vm0/commit/cae4fae507e019e1ead7ff4e12bada65be570455)), closes [#10382](https://github.com/vm0-ai/vm0/issues/10382)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.217.0

## [12.275.0](https://github.com/vm0-ai/vm0/compare/web-v12.274.0...web-v12.275.0) (2026-04-21)


### Features

* add Kimi K2.6 model support ([#10356](https://github.com/vm0-ai/vm0/issues/10356)) ([bac75d0](https://github.com/vm0-ai/vm0/commit/bac75d0dd28fe73328af6a44963dd01774795518))


### Refactoring

* **firewalls:** drop redundant ref field, use name everywhere ([#10353](https://github.com/vm0-ai/vm0/issues/10353)) ([87cd67e](https://github.com/vm0-ai/vm0/commit/87cd67e6a1c47a0bf69f388907f317f4cdf52246))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.216.0

## [12.274.0](https://github.com/vm0-ai/vm0/compare/web-v12.273.0...web-v12.274.0) (2026-04-20)


### Features

* **credits:** add internal redemption codes page (mint + redeem) ([#10241](https://github.com/vm0-ai/vm0/issues/10241)) ([d012b77](https://github.com/vm0-ai/vm0/commit/d012b775da1a9d42c446ecf072e731c1cc4a8fc7))
* **web:** add /api/zero/voice-chat-candidate route handlers ([#10346](https://github.com/vm0-ai/vm0/issues/10346)) ([cebe14d](https://github.com/vm0-ai/vm0/commit/cebe14d8be3ef6dd9e82641a593b804f5a7585fc))
* **web:** add voice-chat-candidate reasoner and trigger-reasoning tick ([#10338](https://github.com/vm0-ai/vm0/issues/10338)) ([28b881d](https://github.com/vm0-ai/vm0/commit/28b881d0285ffbb876c8c517d8df1ec8185e2f7a))
* **web:** add voice-chat-candidate server services ([#10333](https://github.com/vm0-ai/vm0/issues/10333)) ([95043b6](https://github.com/vm0-ai/vm0/commit/95043b6efa4583b57b493cbb4f2797e0940b7fa2))
* **web:** add voice-chat-candidate task-run callback and trigger adapter ([#10344](https://github.com/vm0-ai/vm0/issues/10344)) ([2d61d22](https://github.com/vm0-ai/vm0/commit/2d61d2221505cfbc533213b26fda8d064359094e))
* **web:** extend voice-chat-cleanup cron for candidate sessions ([#10345](https://github.com/vm0-ai/vm0/issues/10345)) ([9eb5729](https://github.com/vm0-ai/vm0/commit/9eb57291bb5bea2a87a4447fb8a56d1f71bd6b63)), closes [#10297](https://github.com/vm0-ai/vm0/issues/10297) [#10312](https://github.com/vm0-ai/vm0/issues/10312)


### Bug Fixes

* **core:** route glm-5.1 through openrouter with upstream model override ([#10321](https://github.com/vm0-ai/vm0/issues/10321)) ([c72a464](https://github.com/vm0-ai/vm0/commit/c72a464bf288513e28461bc75366443c5b086902))
* **web:** re-read session after cas lock acquisition to prevent stale snapshot ([#10347](https://github.com/vm0-ai/vm0/issues/10347)) ([f3d7f01](https://github.com/vm0-ai/vm0/commit/f3d7f01f731484e5e9d081f87f27ad85f6b327f3))


### Refactoring

* **platform:** drop client-only override layer from feature switches ([#10316](https://github.com/vm0-ai/vm0/issues/10316)) ([e42e0db](https://github.com/vm0-ai/vm0/commit/e42e0db5162412ac5296415c95cb941101ab27f3))
* **runs:** remove legacy session-creation fallback and require session id ([#10337](https://github.com/vm0-ai/vm0/issues/10337)) ([9133cef](https://github.com/vm0-ai/vm0/commit/9133cef3439ade00456cc778d94e5ef237d64465))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.215.0

## [12.273.0](https://github.com/vm0-ai/vm0/compare/web-v12.272.0...web-v12.273.0) (2026-04-20)


### Features

* **db:** add feature_candidate_voice_chat_* tables + migration ([#10319](https://github.com/vm0-ai/vm0/issues/10319)) ([ea9e88d](https://github.com/vm0-ai/vm0/commit/ea9e88d17af821cff1a5b40db7e268990d634308)), closes [#10305](https://github.com/vm0-ai/vm0/issues/10305)


### Bug Fixes

* **firewall:** force-refresh oauth token when provider returns 401 ([#9860](https://github.com/vm0-ai/vm0/issues/9860)) ([#10294](https://github.com/vm0-ai/vm0/issues/10294)) ([96fcb01](https://github.com/vm0-ai/vm0/commit/96fcb01248e71bf5ce2ed24d7b6bfafd3ba1394f))

## [12.272.0](https://github.com/vm0-ai/vm0/compare/web-v12.271.0...web-v12.272.0) (2026-04-20)


### Features

* **platform:** add unifyChatThreads feature switch ([#10162](https://github.com/vm0-ai/vm0/issues/10162)) ([#10276](https://github.com/vm0-ai/vm0/issues/10276)) ([03a1c0a](https://github.com/vm0-ai/vm0/commit/03a1c0a3ac15f305e8fea907f52208750bdb4f1d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.214.0

## [12.271.0](https://github.com/vm0-ai/vm0/compare/web-v12.270.0...web-v12.271.0) (2026-04-20)


### Features

* **api:** add v1 chat-threads endpoints gated by clerk api keys ([#10225](https://github.com/vm0-ai/vm0/issues/10225)) ([bd6d7a3](https://github.com/vm0-ai/vm0/commit/bd6d7a3322cd6c064d8184826d00d0e0d7dd96e1))
* **runs:** eagerly create agent session at run insertion ([#10290](https://github.com/vm0-ai/vm0/issues/10290)) ([345b309](https://github.com/vm0-ai/vm0/commit/345b309d9dad267f6ca343caebac0e7928ece0be)), closes [#10249](https://github.com/vm0-ai/vm0/issues/10249)
* **web:** persist sandbox reuse result on agent runs ([#10291](https://github.com/vm0-ai/vm0/issues/10291)) ([6a42ee9](https://github.com/vm0-ai/vm0/commit/6a42ee9b1fdd2670ae101bddf48da3a1e470a62c)), closes [#10233](https://github.com/vm0-ai/vm0/issues/10233)


### Refactoring

* **platform:** replace queue polling with realtime signals ([#10277](https://github.com/vm0-ai/vm0/issues/10277)) ([f4cc455](https://github.com/vm0-ai/vm0/commit/f4cc455fde74f079358cb0a2e6f0596ed2216e0c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.213.0

## [12.270.0](https://github.com/vm0-ai/vm0/compare/web-v12.269.0...web-v12.270.0) (2026-04-20)


### Features

* **connector:** add nano-banana platform-managed connector skeleton ([#9889](https://github.com/vm0-ai/vm0/issues/9889)) ([3bec579](https://github.com/vm0-ai/vm0/commit/3bec5793f167abcbc635987c606461552f95d38c))


### Bug Fixes

* **chat:** restore structured attach-files flow for web chat uploads ([#10264](https://github.com/vm0-ai/vm0/issues/10264)) ([1962608](https://github.com/vm0-ai/vm0/commit/196260877aaaec02d0403232d19b132f28107ccc))
* **seo:** make / return 200 by rewriting in middleware instead of skipping it ([#10281](https://github.com/vm0-ai/vm0/issues/10281)) ([f23d0f7](https://github.com/vm0-ai/vm0/commit/f23d0f71285b4c19d630f94000fcdffc71005f20))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.212.0

## [12.269.0](https://github.com/vm0-ai/vm0/compare/web-v12.268.0...web-v12.269.0) (2026-04-20)


### Features

* add zero web upload-file and file:read/file:write caps ([#10256](https://github.com/vm0-ai/vm0/issues/10256)) ([497dc17](https://github.com/vm0-ai/vm0/commit/497dc17f454d584e1427b10a6ae3e28a63c7c726))
* **cli:** scaffold zero search command and chat-message:read capability ([#10251](https://github.com/vm0-ai/vm0/issues/10251)) ([bc6cb51](https://github.com/vm0-ai/vm0/commit/bc6cb51312022317278d86896e360cca6ef777f4))
* **observability:** add startup and wrap-up latency telemetry ([#10257](https://github.com/vm0-ai/vm0/issues/10257)) ([33028a1](https://github.com/vm0-ai/vm0/commit/33028a10e8ad6218d0255ed69c9af8ba88f41f1a)), closes [#9936](https://github.com/vm0-ai/vm0/issues/9936)
* **voice-io:** gate audio input by org tier with free-tier quota ([#10258](https://github.com/vm0-ai/vm0/issues/10258)) ([2df8bb8](https://github.com/vm0-ai/vm0/commit/2df8bb8bf4baf7fbc744e20a621bd9a1107ba552))


### Bug Fixes

* **api:** make run cancel idempotent for already-cancelled runs ([#10267](https://github.com/vm0-ai/vm0/issues/10267)) ([6c8cf17](https://github.com/vm0-ai/vm0/commit/6c8cf17438e34699207cd38bfafe294a1e3478a1)), closes [#10168](https://github.com/vm0-ai/vm0/issues/10168)


### Refactoring

* **slack:** unify agent response footer and move model into outbound footer ([#10255](https://github.com/vm0-ai/vm0/issues/10255)) ([d957ea1](https://github.com/vm0-ai/vm0/commit/d957ea13661ddef52c53572fbbb9132ea3ebac3a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.211.0

## [12.268.0](https://github.com/vm0-ai/vm0/compare/web-v12.267.0...web-v12.268.0) (2026-04-20)


### Features

* **web:** add user_behavior_count table and service ([#10226](https://github.com/vm0-ai/vm0/issues/10226)) ([3dac320](https://github.com/vm0-ai/vm0/commit/3dac3202637f20e1203de84634a6f1621440fb6c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.210.1

## [12.267.0](https://github.com/vm0-ai/vm0/compare/web-v12.266.0...web-v12.267.0) (2026-04-20)


### Features

* **slack:** add Powered by model footer to agent messages ([#10156](https://github.com/vm0-ai/vm0/issues/10156)) ([b7d399d](https://github.com/vm0-ai/vm0/commit/b7d399d06f542cf38d1e217961f75e4b5be87192))


### Bug Fixes

* **web:** strip self-signed token on non-api paths to keep clerk running ([#10214](https://github.com/vm0-ai/vm0/issues/10214)) ([9493c0e](https://github.com/vm0-ai/vm0/commit/9493c0e9932d646019195e61ba107ab882419738)), closes [#10164](https://github.com/vm0-ai/vm0/issues/10164)


### Refactoring

* **core:** split audio i/o feature switch into input and output flags ([#10209](https://github.com/vm0-ai/vm0/issues/10209)) ([f6670cd](https://github.com/vm0-ai/vm0/commit/f6670cd9b1bfc7d6bb21cd66b505749d60c968b2)), closes [#10207](https://github.com/vm0-ai/vm0/issues/10207)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.210.0

## [12.266.0](https://github.com/vm0-ai/vm0/compare/web-v12.265.0...web-v12.266.0) (2026-04-20)


### Features

* **web:** add 6 new use case pages ([#10196](https://github.com/vm0-ai/vm0/issues/10196)) ([58b9952](https://github.com/vm0-ai/vm0/commit/58b9952dc803bbf14a1c8c8ab387fd4633d12718))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.209.1

## [12.265.0](https://github.com/vm0-ai/vm0/compare/web-v12.264.0...web-v12.265.0) (2026-04-20)


### Features

* **observability:** thread route-entry timestamp from handler to runner ([#10181](https://github.com/vm0-ai/vm0/issues/10181)) ([93c0676](https://github.com/vm0-ai/vm0/commit/93c06768f1731c0951195c4b57a8bae324eac00f))
* **usage:** add per-user usage insight view behind usageAnalytics switch ([#10191](https://github.com/vm0-ai/vm0/issues/10191)) ([b749762](https://github.com/vm0-ai/vm0/commit/b74976215cd7b46d051d2e58d444ed88681a964e))


### Bug Fixes

* **connectors:** point docusign oauth at demo environment ([#10150](https://github.com/vm0-ai/vm0/issues/10150)) ([e606295](https://github.com/vm0-ai/vm0/commit/e606295c98068fc0b2d6178bfe4f5e2ed7f6ff00))
* **seo:** convert next-intl locale redirects from 307 to 301 ([#10176](https://github.com/vm0-ai/vm0/issues/10176)) ([d4abc21](https://github.com/vm0-ai/vm0/commit/d4abc211acee1619f565f0a9e94ee6519385f10b))
* **usage:** use relative billing period date in tests to avoid date-bomb ([#10175](https://github.com/vm0-ai/vm0/issues/10175)) ([a8eca1f](https://github.com/vm0-ai/vm0/commit/a8eca1ffd8ef1328b76f5a36e90ddc62fd2bf222))
* **voice-io:** capture openai stt error body and file metadata in logs ([#10179](https://github.com/vm0-ai/vm0/issues/10179)) ([acf1514](https://github.com/vm0-ai/vm0/commit/acf151472c5fe9f3a0f36510acfc072bc680db54)), closes [#10058](https://github.com/vm0-ai/vm0/issues/10058)
* **web:** add apple-touch-icon.png to stop clerk auth error ([#10192](https://github.com/vm0-ai/vm0/issues/10192)) ([0a40901](https://github.com/vm0-ai/vm0/commit/0a409018600ebee56683b018c1af1a62514ecf80)), closes [#9909](https://github.com/vm0-ai/vm0/issues/9909)


### Refactoring

* **observability:** group voice-chat start timestamp into options ([#10183](https://github.com/vm0-ai/vm0/issues/10183)) ([6ebbb6e](https://github.com/vm0-ai/vm0/commit/6ebbb6e39ee41242b54279a21d6d9b294e1e745c))
* **voice-chat:** drop redundant mode type cast ([#10188](https://github.com/vm0-ai/vm0/issues/10188)) ([03012bd](https://github.com/vm0-ai/vm0/commit/03012bdad1174ec5bde882c49e783ed1b2d0e047))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.209.0

## [12.264.0](https://github.com/vm0-ai/vm0/compare/web-v12.263.0...web-v12.264.0) (2026-04-19)


### Features

* add exa connector ([#10107](https://github.com/vm0-ai/vm0/issues/10107)) ([4232702](https://github.com/vm0-ai/vm0/commit/4232702d7ed283395b05825d84c37d450284c96a))
* add together connector ([#10108](https://github.com/vm0-ai/vm0/issues/10108)) ([a0e4b0d](https://github.com/vm0-ai/vm0/commit/a0e4b0dbbd84cbc3099fd66d5b2d78ada62623cd))
* **composer:** add per-run model picker next to send ([#10149](https://github.com/vm0-ai/vm0/issues/10149)) ([9079fbd](https://github.com/vm0-ai/vm0/commit/9079fbdb1f22e5669e2109856a3e9e68d183fd8f))
* **zero:** configure model provider and model via cli ([#10142](https://github.com/vm0-ai/vm0/issues/10142)) ([5647c99](https://github.com/vm0-ai/vm0/commit/5647c99d5111bc160cbb013a742f44de37b28f72))


### Bug Fixes

* **api:** dedupe user-connectors payload to restore put idempotency ([#10145](https://github.com/vm0-ai/vm0/issues/10145)) ([e722f7c](https://github.com/vm0-ai/vm0/commit/e722f7c833418bec92e5bd107c6c872c96143d39))
* **seo:** remove 3 duplicate use-case slugs from sitemap ([#10136](https://github.com/vm0-ai/vm0/issues/10136)) ([40bbc60](https://github.com/vm0-ai/vm0/commit/40bbc60bf1a947284fa58155b41eabb5a2d0a50b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.208.0

## [12.263.0](https://github.com/vm0-ai/vm0/compare/web-v12.262.0...web-v12.263.0) (2026-04-19)


### Features

* ship full UX for org custom connectors (admin CRUD, per-agent auth, UI) ([#10118](https://github.com/vm0-ai/vm0/issues/10118)) ([8c9f382](https://github.com/vm0-ai/vm0/commit/8c9f3829c92dcac8feab6d259828424efdfed1b9)), closes [#10099](https://github.com/vm0-ai/vm0/issues/10099)


### Bug Fixes

* **firewalls/github:** cover git, raw, codeload, gist, packages, ghcr ([#10073](https://github.com/vm0-ai/vm0/issues/10073)) ([fb8d068](https://github.com/vm0-ai/vm0/commit/fb8d0685f6a6caa0dbd3e644f6b12a3037280e63))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.207.0

## [12.262.0](https://github.com/vm0-ai/vm0/compare/web-v12.261.0...web-v12.262.0) (2026-04-19)


### Features

* add kimi/glm/minimax models to vm0 managed provider ([#10106](https://github.com/vm0-ai/vm0/issues/10106)) ([1619955](https://github.com/vm0-ai/vm0/commit/1619955f3a949352a20282c490776b0bc74df1b1))


### Bug Fixes

* **seo:** remove x-default hreflang duplicate + fix root 307→301 ([#10121](https://github.com/vm0-ai/vm0/issues/10121)) ([bc4d50b](https://github.com/vm0-ai/vm0/commit/bc4d50b9014880449a174aab8588f6e498324ef0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.206.0

## [12.261.0](https://github.com/vm0-ai/vm0/compare/web-v12.260.0...web-v12.261.0) (2026-04-19)


### Features

* add running indicator to sidebar chat threads ([#10090](https://github.com/vm0-ai/vm0/issues/10090)) ([e60fda6](https://github.com/vm0-ai/vm0/commit/e60fda61a8503af6face1cf7ceff34c366d5932e))


### Bug Fixes

* **chat:** anchor initial thread load at the latest messages ([#10098](https://github.com/vm0-ai/vm0/issues/10098)) ([19d5fb5](https://github.com/vm0-ai/vm0/commit/19d5fb54deed6d1b7116eb44c2b3a9dcdaf7660b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.205.0

## [12.260.0](https://github.com/vm0-ai/vm0/compare/web-v12.259.0...web-v12.260.0) (2026-04-19)


### Features

* add amplitude connector ([#10027](https://github.com/vm0-ai/vm0/issues/10027)) ([b925f1a](https://github.com/vm0-ai/vm0/commit/b925f1a8955d7e6d97656d41d3a56afc8210fbe0))
* add attio connector ([#10026](https://github.com/vm0-ai/vm0/issues/10026)) ([7bc16d0](https://github.com/vm0-ai/vm0/commit/7bc16d0f77f7670f584ccdd97e94fb2edd46aa78))
* add freshdesk connector ([#10028](https://github.com/vm0-ai/vm0/issues/10028)) ([d133137](https://github.com/vm0-ai/vm0/commit/d1331377db59915bf75506472ab8a8982f25ad6e))
* add org custom connector gallery (v1) ([#10072](https://github.com/vm0-ai/vm0/issues/10072)) ([79c45e9](https://github.com/vm0-ai/vm0/commit/79c45e9f4fa13dcc62d4d2eabce162bc61085559))


### Bug Fixes

* add trailing newline to freshdesk.svg ([d133137](https://github.com/vm0-ai/vm0/commit/d1331377db59915bf75506472ab8a8982f25ad6e))
* **credit:** remove 'client usage missing' alert from proxy-usage-comparison ([#10075](https://github.com/vm0-ai/vm0/issues/10075)) ([d24ce3a](https://github.com/vm0-ai/vm0/commit/d24ce3a0fc6eb07a9beac785ee8c600765c20c77))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.204.0

## [12.259.0](https://github.com/vm0-ai/vm0/compare/web-v12.258.0...web-v12.259.0) (2026-04-19)


### Features

* add buffer connector ([#10024](https://github.com/vm0-ai/vm0/issues/10024)) ([631cce7](https://github.com/vm0-ai/vm0/commit/631cce7e4ac7bb3284ef8be3039336b53847185a))
* add coda connector ([#10020](https://github.com/vm0-ai/vm0/issues/10020)) ([36f0bdf](https://github.com/vm0-ai/vm0/commit/36f0bdf8025ab498a0eb5fc81a0691e8d75de241))
* add dropbox-sign connector ([#10022](https://github.com/vm0-ai/vm0/issues/10022)) ([35eef8a](https://github.com/vm0-ai/vm0/commit/35eef8ab2dda16fc5f38c56db6a89e9e6c3e7075))
* add greenhouse connector ([#10021](https://github.com/vm0-ai/vm0/issues/10021)) ([d8661de](https://github.com/vm0-ai/vm0/commit/d8661ded0a2c73479c5ed19b15bef41aaf5037b3))
* add miro connector ([#10019](https://github.com/vm0-ai/vm0/issues/10019)) ([1913dac](https://github.com/vm0-ai/vm0/commit/1913dac818876f6d62ff0aebff6f3af058061187))
* add pandadoc connector ([#10023](https://github.com/vm0-ai/vm0/issues/10023)) ([6ed9884](https://github.com/vm0-ai/vm0/commit/6ed9884e2241d4a002310efd252baa4b6f9e0f6c))
* add zoom connector ([#10018](https://github.com/vm0-ai/vm0/issues/10018)) ([3ef5838](https://github.com/vm0-ai/vm0/commit/3ef5838b90bdcb2ac76ce7945afdf18c7c92058e))
* **chat:** add thread read indicator with slack-style watermark ([#10054](https://github.com/vm0-ai/vm0/issues/10054)) ([57682ff](https://github.com/vm0-ai/vm0/commit/57682ff7c7b98a5f62b90c41ee6a08d65b5e6ca7))
* close staff-org defaults except sandbox reuse ([#10053](https://github.com/vm0-ai/vm0/issues/10053)) ([dbbc51b](https://github.com/vm0-ai/vm0/commit/dbbc51b6b0e5c1a27de1327aa149aa5acc1faa68))


### Bug Fixes

* **logger:** serialize Error objects; name report-error errorHandler ([#10041](https://github.com/vm0-ai/vm0/issues/10041)) ([5da6659](https://github.com/vm0-ai/vm0/commit/5da66590142fdf65908aaaa064894fdd8b1cad26))
* **ts-rest-handler:** report unhandled 5xx to Sentry ([#10043](https://github.com/vm0-ai/vm0/issues/10043)) ([e8097a9](https://github.com/vm0-ai/vm0/commit/e8097a9e041d2bbe1fd6577669fa01963edb867f))
* **web:** restore trigger condition for agent self-update prompt ([#10066](https://github.com/vm0-ai/vm0/issues/10066)) ([f3d91ac](https://github.com/vm0-ai/vm0/commit/f3d91ac5cee3f6fc915e0aa6c3a691905b4d781a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.203.0

## [12.258.0](https://github.com/vm0-ai/vm0/compare/web-v12.257.0...web-v12.258.0) (2026-04-19)


### Features

* add duffel connector ([#10016](https://github.com/vm0-ai/vm0/issues/10016)) ([34b2d35](https://github.com/vm0-ai/vm0/commit/34b2d3584b6d1659baeb36b941973094e04d0aaf))
* add klaviyo connector ([#10014](https://github.com/vm0-ai/vm0/issues/10014)) ([0fc1ad4](https://github.com/vm0-ai/vm0/commit/0fc1ad4d1c8b1114578ff2632f1d6a318b2fa813))
* add typeform connector ([#10015](https://github.com/vm0-ai/vm0/issues/10015)) ([c823646](https://github.com/vm0-ai/vm0/commit/c82364633a268ee090707c3a9192ce95616ad583))
* **chat:** use last 5 rounds for thread title generation ([#10004](https://github.com/vm0-ai/vm0/issues/10004)) ([9c899df](https://github.com/vm0-ai/vm0/commit/9c899df763a5a71633c11c9711b1557ed6501eec))
* **shopify:** add shopify connector ([#10012](https://github.com/vm0-ai/vm0/issues/10012)) ([427d0d7](https://github.com/vm0-ai/vm0/commit/427d0d7ab5d17e53027e1ed4228202dac14ecb7a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.202.0

## [12.257.0](https://github.com/vm0-ai/vm0/compare/web-v12.256.0...web-v12.257.0) (2026-04-18)


### Features

* **web:** sort chat threads by latest message time ([#10003](https://github.com/vm0-ai/vm0/issues/10003)) ([f7440c7](https://github.com/vm0-ai/vm0/commit/f7440c74252be88532bbfbcdded3a472b6a07c21))


### Performance Improvements

* **lint:** migrate type-aware rules from typescript-eslint to oxlint-tsgolint ([#10000](https://github.com/vm0-ai/vm0/issues/10000)) ([6d95566](https://github.com/vm0-ai/vm0/commit/6d95566836bc2b993090249c0c5c5f37b047ac2d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.201.1

## [12.256.0](https://github.com/vm0-ai/vm0/compare/web-v12.255.6...web-v12.256.0) (2026-04-18)


### Features

* **chat-threads:** track read/archive state on messages and hide archived threads ([#9976](https://github.com/vm0-ai/vm0/issues/9976)) ([56b2af5](https://github.com/vm0-ai/vm0/commit/56b2af51ec5fe9026a2860b095f69e2cf68cbd7f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.201.0

## [12.255.6](https://github.com/vm0-ai/vm0/compare/web-v12.255.5...web-v12.255.6) (2026-04-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.200.1

## [12.255.5](https://github.com/vm0-ai/vm0/compare/web-v12.255.4...web-v12.255.5) (2026-04-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.200.0

## [12.255.4](https://github.com/vm0-ai/vm0/compare/web-v12.255.3...web-v12.255.4) (2026-04-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.199.0

## [12.255.3](https://github.com/vm0-ai/vm0/compare/web-v12.255.2...web-v12.255.3) (2026-04-18)


### Bug Fixes

* **zero:** notify chat thread on run cancel and failure ([#9926](https://github.com/vm0-ai/vm0/issues/9926)) ([f67c064](https://github.com/vm0-ai/vm0/commit/f67c0644bec9f418d2710f039350e98291bc8cab))


### Refactoring

* drop thread/run-updated/tasks realtime signals, poll in non-chat views ([#9920](https://github.com/vm0-ai/vm0/issues/9920)) ([#9935](https://github.com/vm0-ai/vm0/issues/9935)) ([312eefb](https://github.com/vm0-ai/vm0/commit/312eefb33f74d1cd3619fd44a3c716c30c87f3b0))

## [12.255.2](https://github.com/vm0-ai/vm0/compare/web-v12.255.1...web-v12.255.2) (2026-04-18)


### Bug Fixes

* **developer-support:** isolate per-run failures in activity log assembly ([#9851](https://github.com/vm0-ai/vm0/issues/9851)) ([2c9d52d](https://github.com/vm0-ai/vm0/commit/2c9d52d5372b2ec9142368069838dba466467241))

## [12.255.1](https://github.com/vm0-ai/vm0/compare/web-v12.255.0...web-v12.255.1) (2026-04-18)


### Bug Fixes

* **web:** fix strapi use case content and remove duplicate hreflang ([#9903](https://github.com/vm0-ai/vm0/issues/9903)) ([4d8bf1c](https://github.com/vm0-ai/vm0/commit/4d8bf1c1c067eb6d14d395c61f837fdf8763e7f4))

## [12.255.0](https://github.com/vm0-ai/vm0/compare/web-v12.254.0...web-v12.255.0) (2026-04-18)


### Features

* add test-oauth connector for end-to-end oauth testing ([#9878](https://github.com/vm0-ai/vm0/issues/9878)) ([e8be957](https://github.com/vm0-ai/vm0/commit/e8be957b65578f32d6ca87a6f1eb248ee5737726))


### Bug Fixes

* **github:** use after() callback form in webhook route ([#9886](https://github.com/vm0-ai/vm0/issues/9886)) ([0ed2140](https://github.com/vm0-ai/vm0/commit/0ed2140e157524a9ff889e4298d935f10ace38c7)), closes [#9880](https://github.com/vm0-ai/vm0/issues/9880) [#9882](https://github.com/vm0-ai/vm0/issues/9882)
* **phone:** use after() callback form in webhook route ([#9885](https://github.com/vm0-ai/vm0/issues/9885)) ([83f4b64](https://github.com/vm0-ai/vm0/commit/83f4b641763e752d0a029c589ac2be8396426482))
* **schedule:** preserve next-run time when update omits enabled for loop ([#9881](https://github.com/vm0-ai/vm0/issues/9881)) ([1427209](https://github.com/vm0-ai/vm0/commit/1427209bcd6f383d2d5c15570767e2642ded0b28))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.198.0

## [12.254.0](https://github.com/vm0-ai/vm0/compare/web-v12.253.0...web-v12.254.0) (2026-04-17)


### Features

* add db9 connector ([#9849](https://github.com/vm0-ai/vm0/issues/9849)) ([ee2c5de](https://github.com/vm0-ai/vm0/commit/ee2c5dea3b5adcdb8641d26eb154fb18e6b72f32))
* add drive9 connector ([#9850](https://github.com/vm0-ai/vm0/issues/9850)) ([ea5bddb](https://github.com/vm0-ai/vm0/commit/ea5bddbec99a0e6845c773fedea613877d6d603d))
* **use-cases:** add auto-merge-releases ([#9856](https://github.com/vm0-ai/vm0/issues/9856)) ([3824819](https://github.com/vm0-ai/vm0/commit/3824819c50f31b35967fa19028d2fe4219224940))
* **web:** add 14 new use cases to use-cases page ([#9706](https://github.com/vm0-ai/vm0/issues/9706)) ([fecbaa5](https://github.com/vm0-ai/vm0/commit/fecbaa57571f223c3c71f4997bedd765d495f5cc))


### Bug Fixes

* **runner:** forward secretconnectormap in claim response ([#9869](https://github.com/vm0-ai/vm0/issues/9869)) ([1597ff8](https://github.com/vm0-ai/vm0/commit/1597ff851f0d660852f1dffd3dc568b218489fab))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.197.0

## [12.253.0](https://github.com/vm0-ai/vm0/compare/web-v12.252.0...web-v12.253.0) (2026-04-17)


### Features

* add competitor-pricing-monitor use case ([#9385](https://github.com/vm0-ai/vm0/issues/9385)) ([7bf56c6](https://github.com/vm0-ai/vm0/commit/7bf56c63a2dedf9f1cbe086675d9933b19247c76))
* add msg9 connector ([#9848](https://github.com/vm0-ai/vm0/issues/9848)) ([675abd9](https://github.com/vm0-ai/vm0/commit/675abd93366c0c1c9a027cf60690d895af377fa8))
* **web:** add cross-tool context query, customer 360, trending topic radar, and content performance report use cases ([#9392](https://github.com/vm0-ai/vm0/issues/9392)) ([73e116d](https://github.com/vm0-ai/vm0/commit/73e116db1b37b51f19df164a3ba9536ea5ab421d))


### Bug Fixes

* **blog:** fill card covers edge-to-edge ([#9863](https://github.com/vm0-ai/vm0/issues/9863)) ([fba4cd0](https://github.com/vm0-ai/vm0/commit/fba4cd057f669a5ebd9319d4b36f141fd70b40d7))
* **platform+web:** stabilize chat thinking indicator and publish cancel signals ([#9866](https://github.com/vm0-ai/vm0/issues/9866)) ([51c7152](https://github.com/vm0-ai/vm0/commit/51c7152f8822d451452b8c6aa6426cdb534e2557))
* **zero-runs:** restore oauth pre-refresh before dispatching run ([#9865](https://github.com/vm0-ai/vm0/issues/9865)) ([da8c753](https://github.com/vm0-ai/vm0/commit/da8c7533c21f85b69575bd8d44a129f9c82b9033))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.196.0

## [12.252.0](https://github.com/vm0-ai/vm0/compare/web-v12.251.1...web-v12.252.0) (2026-04-17)


### Features

* **web:** add daily-engineering-brief use case ([#9384](https://github.com/vm0-ai/vm0/issues/9384)) ([c58dc87](https://github.com/vm0-ai/vm0/commit/c58dc8718eb857417b17eafa8fd9bc6ebf7cdd18))


### Bug Fixes

* **web:** allow 'Why Zero' heading to wrap on mobile ([#9855](https://github.com/vm0-ai/vm0/issues/9855)) ([0a8c268](https://github.com/vm0-ai/vm0/commit/0a8c2681a6e3032a9397860ba8abe5ca6f1df3af))


### Refactoring

* **platform:** switch chat to paged messages and remove RunLoop ([#9618](https://github.com/vm0-ai/vm0/issues/9618)) ([484e020](https://github.com/vm0-ai/vm0/commit/484e0208633127538570823d84aa2d5b7209c515))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.195.1

## [12.251.1](https://github.com/vm0-ai/vm0/compare/web-v12.251.0...web-v12.251.1) (2026-04-17)


### Bug Fixes

* self-heal oauth connectors with null token expiry ([#9842](https://github.com/vm0-ai/vm0/issues/9842)) ([b73bd81](https://github.com/vm0-ai/vm0/commit/b73bd818a0e4433c8fdf81075df4ffc94e18e2d2))
* **web:** align blog cards and scale cover illustrations ([#9845](https://github.com/vm0-ai/vm0/issues/9845)) ([bc2f276](https://github.com/vm0-ai/vm0/commit/bc2f2760f51fcc25e391134f2e604fba241f5436))

## [12.251.0](https://github.com/vm0-ai/vm0/compare/web-v12.250.0...web-v12.251.0) (2026-04-17)


### Features

* **slack:** add /zero switch for per-user agent selection ([#9795](https://github.com/vm0-ai/vm0/issues/9795)) ([5367c54](https://github.com/vm0-ai/vm0/commit/5367c549bad7755ce43f4159c9d4aa461280dbf6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.195.0

## [12.250.0](https://github.com/vm0-ai/vm0/compare/web-v12.249.0...web-v12.250.0) (2026-04-17)


### Features

* **web:** add connector discovery guidance to agent system prompt ([#9806](https://github.com/vm0-ai/vm0/issues/9806)) ([1e1d059](https://github.com/vm0-ai/vm0/commit/1e1d0598fd38f64974cfe7d44596430273fd5cea))


### Bug Fixes

* **web:** scale slack icon on use-cases pages to match intended size ([#9802](https://github.com/vm0-ai/vm0/issues/9802)) ([2ab0efc](https://github.com/vm0-ai/vm0/commit/2ab0efca312cf2893a9b5dc04d5748cb54311422))

## [12.249.0](https://github.com/vm0-ai/vm0/compare/web-v12.248.2...web-v12.249.0) (2026-04-17)


### Features

* **chat:** support video attachments in web chat ([#9662](https://github.com/vm0-ai/vm0/issues/9662)) ([c46edd2](https://github.com/vm0-ai/vm0/commit/c46edd2a31265d5aa2594a5adefd42fd8296afdc))
* **web:** add marketing-emails use case with resend connector ([#9767](https://github.com/vm0-ai/vm0/issues/9767)) ([a287909](https://github.com/vm0-ai/vm0/commit/a287909f2020875c072b821b5cf97a521386dbcb))
* **web:** add visible "Add to Slack" button on landing page ([#9792](https://github.com/vm0-ai/vm0/issues/9792)) ([8ae8b69](https://github.com/vm0-ai/vm0/commit/8ae8b6958c5383c1e0bc0b163709c6ee7a37fb2f))


### Bug Fixes

* **billing:** clear stale current_period_end via sql migration ([#9799](https://github.com/vm0-ai/vm0/issues/9799)) ([790ff8c](https://github.com/vm0-ai/vm0/commit/790ff8c5fc252812a5279f29f8d4c20bac04e1f0))
* **billing:** persist subscription period end instead of invoice accrual period ([#9790](https://github.com/vm0-ai/vm0/issues/9790)) ([c5a279f](https://github.com/vm0-ai/vm0/commit/c5a279fc89507897bf60c3ba2b7d127654e38074))
* **slack:** use after() callback form so nested dispatch runs ([#9796](https://github.com/vm0-ai/vm0/issues/9796)) ([bd80c31](https://github.com/vm0-ai/vm0/commit/bd80c31eab69d2055fd1b82336a6b1fcec1f0ea7))

## [12.248.2](https://github.com/vm0-ai/vm0/compare/web-v12.248.1...web-v12.248.2) (2026-04-17)


### Bug Fixes

* **slack:** use official Slack Mark SVG per brand guidelines ([#9780](https://github.com/vm0-ai/vm0/issues/9780)) ([c1bb52b](https://github.com/vm0-ai/vm0/commit/c1bb52ba4677dc159667a105ea16b7b30bfca1be))


### Refactoring

* **api:** delete /api/skills/resolve and deprecate skills in contracts ([#9765](https://github.com/vm0-ai/vm0/issues/9765)) ([4883702](https://github.com/vm0-ai/vm0/commit/48837029f50864910896f2f5670eae903f845a07))
* extract pure adapter for schedule cron trigger ([#9784](https://github.com/vm0-ai/vm0/issues/9784)) ([9ca254c](https://github.com/vm0-ai/vm0/commit/9ca254c740531b8db0e1b0f43fc1a8e16742f91f))
* extract voice chat trigger adapters as pure functions ([#9781](https://github.com/vm0-ai/vm0/issues/9781)) ([e0bdab8](https://github.com/vm0-ai/vm0/commit/e0bdab886776a11e37110de738281e8e888f94e5))
* **infra:** replace agent-skills prefix check with explicit system flag ([#9768](https://github.com/vm0-ai/vm0/issues/9768)) ([4f6f675](https://github.com/vm0-ai/vm0/commit/4f6f675ca42b478303882d5758066cb58bf8061a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.194.0

## [12.248.1](https://github.com/vm0-ai/vm0/compare/web-v12.248.0...web-v12.248.1) (2026-04-17)


### Refactoring

* **api:** stop auto-injecting custom skills on /api/agent/runs ([#9766](https://github.com/vm0-ai/vm0/issues/9766)) ([26e5cdd](https://github.com/vm0-ai/vm0/commit/26e5cdd32da81e7e3ce16473e4a2762bbf4c03ed))
* extract pure adapter for telegram trigger handler ([#9761](https://github.com/vm0-ai/vm0/issues/9761)) ([e5e97c5](https://github.com/vm0-ai/vm0/commit/e5e97c55729aabcef746c3ce609c710296075658)), closes [#9727](https://github.com/vm0-ai/vm0/issues/9727)
* extract pure adapters for email inbound-reply and inbound-trigger ([#9756](https://github.com/vm0-ai/vm0/issues/9756)) ([d3b0e9d](https://github.com/vm0-ai/vm0/commit/d3b0e9d0f670a6044312f04fb330a267a17320ca)), closes [#9729](https://github.com/vm0-ai/vm0/issues/9729)
* extract pure adapters for phone and imessage trigger handlers ([#9775](https://github.com/vm0-ai/vm0/issues/9775)) ([a4497e7](https://github.com/vm0-ai/vm0/commit/a4497e781fde613ae23c48070b24f4d37137f4ee))
* hide after() inside createZeroRun and collapse optimized routes ([#9739](https://github.com/vm0-ai/vm0/issues/9739)) ([2252e51](https://github.com/vm0-ai/vm0/commit/2252e5194fe054378c24b2baa39571d7902da29f))
* **slack-org:** extract slack trigger adapter as pure function ([#9726](https://github.com/vm0-ai/vm0/issues/9726)) ([#9763](https://github.com/vm0-ai/vm0/issues/9763)) ([1f9867a](https://github.com/vm0-ai/vm0/commit/1f9867ab440970b5020445daaecc9f0d3ad3c66c))
* **zero-runs:** extract pure adapter for github issue-event handler ([#9774](https://github.com/vm0-ai/vm0/issues/9774)) ([b3e2c08](https://github.com/vm0-ai/vm0/commit/b3e2c08af5a3720ce975ef98ac6f9aad9437c7e1))

## [12.248.0](https://github.com/vm0-ai/vm0/compare/web-v12.247.0...web-v12.248.0) (2026-04-17)


### Features

* add claude-opus-4-7 to vm0 managed model provider ([#9709](https://github.com/vm0-ai/vm0/issues/9709)) ([9906c32](https://github.com/vm0-ai/vm0/commit/9906c32b58966c988c7c479e76e5349dc35cb6d8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.193.0

## [12.247.0](https://github.com/vm0-ai/vm0/compare/web-v12.246.1...web-v12.247.0) (2026-04-16)


### Features

* store connector billing in database via webhook ([#9678](https://github.com/vm0-ai/vm0/issues/9678)) ([105724f](https://github.com/vm0-ai/vm0/commit/105724f670637fdc16022907a97d0ab57b0b607c))


### Bug Fixes

* improve auth input border contrast in dark mode ([#9664](https://github.com/vm0-ai/vm0/issues/9664)) ([b2773ef](https://github.com/vm0-ai/vm0/commit/b2773ef7fece123022791d3421d780d01e6c2b25))
* inject firewall for enabled connectors regardless of secret availability ([#9656](https://github.com/vm0-ai/vm0/issues/9656)) ([3f10868](https://github.com/vm0-ai/vm0/commit/3f108689ff2a595498d27c388726253085270bc6))


### Refactoring

* **infra:** generalize skill-upload to volume-upload and relocate system skill hash ([#9673](https://github.com/vm0-ai/vm0/issues/9673)) ([d09570a](https://github.com/vm0-ai/vm0/commit/d09570a5aca1119d9fdcce619af17b14f9e7ef61)), closes [#9672](https://github.com/vm0-ai/vm0/issues/9672)
* **proxy:** return connector types instead of missing secret names in 424 response ([#9676](https://github.com/vm0-ai/vm0/issues/9676)) ([1de69bb](https://github.com/vm0-ai/vm0/commit/1de69bbc9648daf8447bb99027ffbf4b264b720f))
* **zero:** remove skills from compose pipeline and server-side-compose ([#9675](https://github.com/vm0-ai/vm0/issues/9675)) ([28d10ef](https://github.com/vm0-ai/vm0/commit/28d10ef17d58f6fcbfb2b184869f627fe6d7b6f9)), closes [#9671](https://github.com/vm0-ai/vm0/issues/9671)


### Performance Improvements

* parallelize phase 1 db operations and eliminate cross-phase duplicates ([#9698](https://github.com/vm0-ai/vm0/issues/9698)) ([f522ad6](https://github.com/vm0-ai/vm0/commit/f522ad634fb65e6dce4f06a8a6e35e0d62c62497)), closes [#9692](https://github.com/vm0-ai/vm0/issues/9692)
* **storage:** batch storage manifest version resolution ([#9697](https://github.com/vm0-ai/vm0/issues/9697)) ([b1222a4](https://github.com/vm0-ai/vm0/commit/b1222a4e6f6c9de8db632655486a858cfb60214a)), closes [#9691](https://github.com/vm0-ai/vm0/issues/9691)
* **zero-runs:** defer dispatch with after() and remove redundant oauth pre-refresh ([#9694](https://github.com/vm0-ai/vm0/issues/9694)) ([57b09da](https://github.com/vm0-ai/vm0/commit/57b09dad2ef32e8436e84b5005c9c0f35b60949e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.192.0

## [12.246.1](https://github.com/vm0-ai/vm0/compare/web-v12.246.0...web-v12.246.1) (2026-04-16)


### Bug Fixes

* **web:** invert dark connector logos in use-cases for dark mode ([#8837](https://github.com/vm0-ai/vm0/issues/8837)) ([05ac420](https://github.com/vm0-ai/vm0/commit/05ac420cfb523c6b4ed896bcfa9352f59652f37b))
* **web:** resolve hreflang, canonical, and crawler seo issues ([#9658](https://github.com/vm0-ai/vm0/issues/9658)) ([3840eed](https://github.com/vm0-ai/vm0/commit/3840eedc090585a5a72deaf298f8f7c9773f9d8e))

## [12.246.0](https://github.com/vm0-ai/vm0/compare/web-v12.245.0...web-v12.246.0) (2026-04-16)


### Features

* **platform:** add chat message send command to agent tools prompt ([#9623](https://github.com/vm0-ai/vm0/issues/9623)) ([a27488d](https://github.com/vm0-ai/vm0/commit/a27488ddface8dc57941d0de0df2e80faa942292))

## [12.245.0](https://github.com/vm0-ai/vm0/compare/web-v12.244.1...web-v12.245.0) (2026-04-16)


### Features

* **web:** add zero web download-file command for web-uploaded files ([#9584](https://github.com/vm0-ai/vm0/issues/9584)) ([bf35045](https://github.com/vm0-ai/vm0/commit/bf350455cc2a7bddcd8ffe5e3305f224ed82f679))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.191.0

## [12.244.1](https://github.com/vm0-ai/vm0/compare/web-v12.244.0...web-v12.244.1) (2026-04-16)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.190.1

## [12.244.0](https://github.com/vm0-ai/vm0/compare/web-v12.243.0...web-v12.244.0) (2026-04-16)


### Features

* add auth.query support to firewall schema for query-parameter authentication ([#9583](https://github.com/vm0-ai/vm0/issues/9583)) ([c39727a](https://github.com/vm0-ai/vm0/commit/c39727abd12ddd86271294324cf352fe86f96658))
* add GET /api/zero/chat-threads/:id/messages with sinceId cursor pagination ([#9561](https://github.com/vm0-ai/vm0/issues/9561)) ([dcc04b4](https://github.com/vm0-ai/vm0/commit/dcc04b4feb23d25c75220b4ad983b91c0dd56fee))
* add granular realtime signals for run and chat thread updates ([#9575](https://github.com/vm0-ai/vm0/issues/9575)) ([12c3e62](https://github.com/vm0-ai/vm0/commit/12c3e62e4e2769dd9e1e869f249bdf0933a52c66))
* add zero chat message send command with chat-message:write capability ([#9580](https://github.com/vm0-ai/vm0/issues/9580)) ([93692d7](https://github.com/vm0-ai/vm0/commit/93692d7cff357a7d9d015e194dd134f475dd9ccb))


### Bug Fixes

* **zero:** inject custom skill volumes in zero run path ([#9582](https://github.com/vm0-ai/vm0/issues/9582)) ([0a11a98](https://github.com/vm0-ai/vm0/commit/0a11a98afbe1ed43c3d46e063d21c4b08e41e6b9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.190.0

## [12.243.0](https://github.com/vm0-ai/vm0/compare/web-v12.242.0...web-v12.243.0) (2026-04-16)


### Features

* **web:** replace use-case cards with role-based showcase and comparison section ([#9545](https://github.com/vm0-ai/vm0/issues/9545)) ([a30e66f](https://github.com/vm0-ai/vm0/commit/a30e66f19ec2e25f7d5cdd17e53bdbb80fac9bbd))


### Refactoring

* **slack:** replace r2 pre-upload with on-demand download-file cli ([#9541](https://github.com/vm0-ai/vm0/issues/9541)) ([2cd0263](https://github.com/vm0-ai/vm0/commit/2cd02637302d63e7ca561fe13a9a25532465f763))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.189.1

## [12.242.0](https://github.com/vm0-ai/vm0/compare/web-v12.241.0...web-v12.242.0) (2026-04-16)


### Features

* add run_event_id to chat_messages for Anthropic message traceability ([#9559](https://github.com/vm0-ai/vm0/issues/9559)) ([7cbbec6](https://github.com/vm0-ai/vm0/commit/7cbbec653e7e1e39f4b13f24ebadd65e42b7969b))

## [12.241.0](https://github.com/vm0-ai/vm0/compare/web-v12.240.0...web-v12.241.0) (2026-04-15)


### Features

* replace setloop polling with ably realtime push ([#9455](https://github.com/vm0-ai/vm0/issues/9455)) ([07329b8](https://github.com/vm0-ai/vm0/commit/07329b8cf1f9cdfe8cedbceedad9f8aea6586f29))


### Bug Fixes

* **phone:** align imessage integration with agentphone api ([#9538](https://github.com/vm0-ai/vm0/issues/9538)) ([077fd0f](https://github.com/vm0-ai/vm0/commit/077fd0f317c49ed73792e74c20f1641ce6f806c1))
* **web:** add non-localized blog routes to public route matcher ([#9066](https://github.com/vm0-ai/vm0/issues/9066)) ([9707f76](https://github.com/vm0-ai/vm0/commit/9707f76467825441a0dc58e03805c1227bf55b32))
* **web:** update homepage share meta descriptions to match Zero's positioning ([#9535](https://github.com/vm0-ai/vm0/issues/9535)) ([e2e6741](https://github.com/vm0-ai/vm0/commit/e2e67419ba13338326feaaf60ccc195144814c00))


### Refactoring

* **web:** remove compose rebuild on skill deletion ([#9537](https://github.com/vm0-ai/vm0/issues/9537)) ([79f867c](https://github.com/vm0-ai/vm0/commit/79f867c566e99a2160e578e27bfeb46d5a6dfdfb)), closes [#9527](https://github.com/vm0-ai/vm0/issues/9527)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.189.0

## [12.240.0](https://github.com/vm0-ai/vm0/compare/web-v12.239.0...web-v12.240.0) (2026-04-15)


### Features

* **web:** inject custom skills as additional volumes at run creation ([#9532](https://github.com/vm0-ai/vm0/issues/9532)) ([d08f529](https://github.com/vm0-ai/vm0/commit/d08f5291e9748a0a17a43b0196d98020962254d3))


### Bug Fixes

* restore og:image and twitter:card on homepage ([#9509](https://github.com/vm0-ai/vm0/issues/9509)) ([689c747](https://github.com/vm0-ai/vm0/commit/689c747ee85fe5bd9b98ab27d424acbf70b727b5))

## [12.239.0](https://github.com/vm0-ai/vm0/compare/web-v12.238.1...web-v12.239.0) (2026-04-15)


### Features

* add imessage integration for zero agents ([#9463](https://github.com/vm0-ai/vm0/issues/9463)) ([f0a8e7a](https://github.com/vm0-ai/vm0/commit/f0a8e7a7326f1a71a4742c2fa229fa193b14e6e2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.188.0

## [12.238.1](https://github.com/vm0-ai/vm0/compare/web-v12.238.0...web-v12.238.1) (2026-04-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.187.1

## [12.238.0](https://github.com/vm0-ai/vm0/compare/web-v12.237.1...web-v12.238.0) (2026-04-15)


### Features

* add server-side additional volumes support in storage manifest ([#9485](https://github.com/vm0-ai/vm0/issues/9485)) ([c39a991](https://github.com/vm0-ai/vm0/commit/c39a9913c627e2a5a7003eaf401119377e2058bc))
* **phone:** add fire-and-forget mode for outbound calls ([#9465](https://github.com/vm0-ai/vm0/issues/9465)) ([86196f2](https://github.com/vm0-ai/vm0/commit/86196f26596e9eb74b4635c120487a9deeb270ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.187.0

## [12.237.1](https://github.com/vm0-ai/vm0/compare/web-v12.237.0...web-v12.237.1) (2026-04-15)


### Bug Fixes

* **web:** add missing use-case translations for es/ja/de locales ([#9430](https://github.com/vm0-ai/vm0/issues/9430)) ([6508e4f](https://github.com/vm0-ai/vm0/commit/6508e4fe9f8004d76ed7e8c5072786d3cdf9a731)), closes [#9418](https://github.com/vm0-ai/vm0/issues/9418)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.186.1

## [12.237.0](https://github.com/vm0-ai/vm0/compare/web-v12.236.0...web-v12.237.0) (2026-04-15)


### Features

* **cli:** replace missing-token with check-connector doctor command ([#9451](https://github.com/vm0-ai/vm0/issues/9451)) ([c45953f](https://github.com/vm0-ai/vm0/commit/c45953f7b1cff9eb02710d90fb8b1b5181732a49))


### Bug Fixes

* **zero:** left-align agent reply email container ([#9453](https://github.com/vm0-ai/vm0/issues/9453)) ([62e304b](https://github.com/vm0-ai/vm0/commit/62e304b75d74fd75db5db128c03171addf8a6404))

## [12.236.0](https://github.com/vm0-ai/vm0/compare/web-v12.235.1...web-v12.236.0) (2026-04-15)


### Features

* update pro plan pricing to $20/month and free credits to 100k ([#9422](https://github.com/vm0-ai/vm0/issues/9422)) ([b9e6989](https://github.com/vm0-ai/vm0/commit/b9e6989dafb2ae9e117febc6b8b9547074afd640))
* **zero:** add run id to run context response ([#9433](https://github.com/vm0-ai/vm0/issues/9433)) ([410899f](https://github.com/vm0-ai/vm0/commit/410899f4dcb33b2f7b1cc8863f6343f9d91ddeb3))


### Refactoring

* **test:** migrate credit-check to route integration test ([#9423](https://github.com/vm0-ai/vm0/issues/9423)) ([#9431](https://github.com/vm0-ai/vm0/issues/9431)) ([4773a39](https://github.com/vm0-ai/vm0/commit/4773a393204451ddffdbb639fa13c64b7c721d08))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.186.0

## [12.235.1](https://github.com/vm0-ai/vm0/compare/web-v12.235.0...web-v12.235.1) (2026-04-15)


### Bug Fixes

* include activity logs for all session runs in diagnostic bundle ([#9420](https://github.com/vm0-ai/vm0/issues/9420)) ([b5a8b3b](https://github.com/vm0-ai/vm0/commit/b5a8b3be876e03fb7f05b0d51ef018094191b915))
* **security:** strengthen Slack download URL validation against SSRF ([#9389](https://github.com/vm0-ai/vm0/issues/9389)) ([b92110b](https://github.com/vm0-ai/vm0/commit/b92110b8f68abf1d199dfa64d5ea0bad146ae418))


### Refactoring

* **test:** document run-status.test.ts as service-level exception ([#9426](https://github.com/vm0-ai/vm0/issues/9426)) ([#9428](https://github.com/vm0-ai/vm0/issues/9428)) ([db64156](https://github.com/vm0-ai/vm0/commit/db6415653e68c64e2804c6ccc7d3df5f560eae68))
* **test:** migrate connect-service tests to route integration test ([#9414](https://github.com/vm0-ai/vm0/issues/9414)) ([#9429](https://github.com/vm0-ai/vm0/issues/9429)) ([3afcd10](https://github.com/vm0-ai/vm0/commit/3afcd107c595c34aaf8899d8112341abf8af4f41))
* **test:** migrate create-run.test.ts to route integration test ([#9415](https://github.com/vm0-ai/vm0/issues/9415)) ([#9427](https://github.com/vm0-ai/vm0/issues/9427)) ([41ba32d](https://github.com/vm0-ai/vm0/commit/41ba32dd2f3570d9c1dfe10d877429485d37ea56))
* **test:** migrate org-model-provider tests to route integration test ([#9406](https://github.com/vm0-ai/vm0/issues/9406)) ([#9412](https://github.com/vm0-ai/vm0/issues/9412)) ([43a5a78](https://github.com/vm0-ai/vm0/commit/43a5a7846021ec7f2c32998a50cc7d15d4640a16))
* **test:** migrate proxy-usage-comparison tests to route integration test ([#9407](https://github.com/vm0-ai/vm0/issues/9407)) ([#9411](https://github.com/vm0-ai/vm0/issues/9411)) ([47b9816](https://github.com/vm0-ai/vm0/commit/47b98162e52cc3a97f5fb4f58af52df900654445))
* **test:** migrate resolve-org to route integration test ([#9409](https://github.com/vm0-ai/vm0/issues/9409)) ([#9421](https://github.com/vm0-ai/vm0/issues/9421)) ([f5e40f5](https://github.com/vm0-ai/vm0/commit/f5e40f5d7747c6b50fae36a75477238bb303160e))
* **test:** migrate schedule helpers from service calls to route calls ([#9398](https://github.com/vm0-ai/vm0/issues/9398)) ([#9413](https://github.com/vm0-ai/vm0/issues/9413)) ([69ae318](https://github.com/vm0-ai/vm0/commit/69ae3183f584f9ec8edf5350b66d6087a97c0048))
* **test:** migrate zero-run-service tests to route integration test ([#9416](https://github.com/vm0-ai/vm0/issues/9416)) ([#9425](https://github.com/vm0-ai/vm0/issues/9425)) ([83ae021](https://github.com/vm0-ai/vm0/commit/83ae0218b2929320ac654f3011930b2b89822584))

## [12.235.0](https://github.com/vm0-ai/vm0/compare/web-v12.234.0...web-v12.235.0) (2026-04-15)


### Features

* **connectors:** add Anthropic Managed Agents connector ([#9386](https://github.com/vm0-ai/vm0/issues/9386)) ([d4f7447](https://github.com/vm0-ai/vm0/commit/d4f7447083ed6dc406ff29c4a284b1badbd0c144))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.185.0

## [12.234.0](https://github.com/vm0-ai/vm0/compare/web-v12.233.0...web-v12.234.0) (2026-04-14)


### Features

* **connector:** add google meet oauth connector ([#9330](https://github.com/vm0-ai/vm0/issues/9330)) ([15e1a5b](https://github.com/vm0-ai/vm0/commit/15e1a5baaf6fc4e460233a804065193e13027520))
* **web:** render agent reply email body as markdown ([#9323](https://github.com/vm0-ai/vm0/issues/9323)) ([95eb5e4](https://github.com/vm0-ai/vm0/commit/95eb5e4154336b4ea6c61bfab8bebe2f24c16050))


### Bug Fixes

* **onboarding:** treat orphan compose as no default agent in status check ([#9320](https://github.com/vm0-ai/vm0/issues/9320)) ([ead34d2](https://github.com/vm0-ai/vm0/commit/ead34d2c9c62f57c9c145c36325fc6e6aded1bff))


### Refactoring

* migrate user record helpers to three-tier test architecture ([#9346](https://github.com/vm0-ai/vm0/issues/9346)) ([07f2def](https://github.com/vm0-ai/vm0/commit/07f2def0449dcdd67ec40f40b68b312c45540530)), closes [#9344](https://github.com/vm0-ai/vm0/issues/9344)
* move org test infrastructure from api-test-helpers to proper modules ([#9342](https://github.com/vm0-ai/vm0/issues/9342)) ([b56d85f](https://github.com/vm0-ai/vm0/commit/b56d85f79ece9fa733938d9851735b454e9a2b6d)), closes [#9338](https://github.com/vm0-ai/vm0/issues/9338)
* **test:** migrate agents.ts session/conversation helpers to three-tier architecture ([#9377](https://github.com/vm0-ai/vm0/issues/9377)) ([000aa3c](https://github.com/vm0-ai/vm0/commit/000aa3cf98b29ee4eb85c0f597e4253d3d8a8b86)), closes [#9374](https://github.com/vm0-ai/vm0/issues/9374)
* **test:** migrate auth.ts helpers to three-tier test architecture ([#9365](https://github.com/vm0-ai/vm0/issues/9365)) ([de1c843](https://github.com/vm0-ai/vm0/commit/de1c843b31133e106e1726cd56fb89cc439e9d7f)), closes [#9358](https://github.com/vm0-ai/vm0/issues/9358)
* **test:** migrate compose helpers to three-tier structure ([#9347](https://github.com/vm0-ai/vm0/issues/9347)) ([6d98ae6](https://github.com/vm0-ai/vm0/commit/6d98ae6e1620b2313c67bbbd1666642d31ccca89)), closes [#9340](https://github.com/vm0-ai/vm0/issues/9340)
* **test:** migrate email and phone helpers to three-tier architecture ([#9366](https://github.com/vm0-ai/vm0/issues/9366)) ([1fe213e](https://github.com/vm0-ai/vm0/commit/1fe213e0304b7c69da532f008720a38bb51d7680)), closes [#9360](https://github.com/vm0-ai/vm0/issues/9360)
* **test:** migrate org.ts helpers to three-tier test architecture ([#9373](https://github.com/vm0-ai/vm0/issues/9373)) ([#9380](https://github.com/vm0-ai/vm0/issues/9380)) ([c6b6f96](https://github.com/vm0-ai/vm0/commit/c6b6f960d1d2d42aeea79487b9bd84d615b8ff69))
* **test:** migrate run creation helpers to db-test-seeders ([#9349](https://github.com/vm0-ai/vm0/issues/9349)) ([07efe2e](https://github.com/vm0-ai/vm0/commit/07efe2e67a5544fcb29e49beb7954111891c32f4))
* **test:** migrate runner and export helpers to three-tier architecture ([#9371](https://github.com/vm0-ai/vm0/issues/9371)) ([8d10405](https://github.com/vm0-ai/vm0/commit/8d10405b5ad789bfa3908bb25dc2272dfcd89d6a)), closes [#9367](https://github.com/vm0-ai/vm0/issues/9367)
* **test:** migrate runs.ts mutation/query helpers to three-tier architecture ([#9378](https://github.com/vm0-ai/vm0/issues/9378)) ([7be45e8](https://github.com/vm0-ai/vm0/commit/7be45e8920305621e153d8c1c2bc35455b090425)), closes [#9375](https://github.com/vm0-ai/vm0/issues/9375)
* **test:** migrate schedules and secrets helpers to three-tier architecture ([#9372](https://github.com/vm0-ai/vm0/issues/9372)) ([ae670bd](https://github.com/vm0-ai/vm0/commit/ae670bdaefcc9754aac7ccb38959ab0ada205cd9)), closes [#9369](https://github.com/vm0-ai/vm0/issues/9369)
* **test:** migrate skills.ts helpers to three-tier test architecture ([#9368](https://github.com/vm0-ai/vm0/issues/9368)) ([42c1837](https://github.com/vm0-ai/vm0/commit/42c18374cfd6c430bd3c2131c0b497265276ac6c))
* **test:** migrate slack.ts helpers to three-tier structure ([#9356](https://github.com/vm0-ai/vm0/issues/9356)) ([9b97828](https://github.com/vm0-ai/vm0/commit/9b97828adf62426737f37f3aa29228e2585b795e))
* **test:** migrate storage helpers to three-tier test architecture ([#9362](https://github.com/vm0-ai/vm0/issues/9362)) ([0b09f54](https://github.com/vm0-ai/vm0/commit/0b09f540e71773da9c6fdde7f3da1ef7e9b0a395))
* **test:** migrate telegram.ts helpers to three-tier test architecture ([#9357](https://github.com/vm0-ai/vm0/issues/9357)) ([4286177](https://github.com/vm0-ai/vm0/commit/4286177435bc3c0a847ddee629ce2df84681d8ea)), closes [#9352](https://github.com/vm0-ai/vm0/issues/9352)
* **test:** migrate users.ts voice chat helpers to three-tier architecture ([#9379](https://github.com/vm0-ai/vm0/issues/9379)) ([fa1824b](https://github.com/vm0-ai/vm0/commit/fa1824bb9020ab2181363e91cbfa62a803b59014)), closes [#9376](https://github.com/vm0-ai/vm0/issues/9376)
* **test:** move billing helpers to db-test-seeders and db-test-assertions ([#9343](https://github.com/vm0-ai/vm0/issues/9343)) ([1539049](https://github.com/vm0-ai/vm0/commit/1539049cf505b2921f53dc44e8fe8ee1705bc0e1)), closes [#9341](https://github.com/vm0-ai/vm0/issues/9341)
* **test:** move connector helpers to db-test-seeders and db-test-assertions ([#9364](https://github.com/vm0-ai/vm0/issues/9364)) ([b3de646](https://github.com/vm0-ai/vm0/commit/b3de646dfedfd3e33330a51724d9e2c5b12d2fcb)), closes [#9359](https://github.com/vm0-ai/vm0/issues/9359)
* **test:** move github helpers to db-test-seeders and db-test-assertions ([#9355](https://github.com/vm0-ai/vm0/issues/9355)) ([8f6c8a0](https://github.com/vm0-ai/vm0/commit/8f6c8a0dd1368f8c623f755f0225d45e0106989d))
* **test:** move usage and insights helpers to db-test-seeders and db-test-assertions ([#9350](https://github.com/vm0-ai/vm0/issues/9350)) ([8a54121](https://github.com/vm0-ai/vm0/commit/8a541219842618e9a9e3eab9a31744bc2a5f3fbe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.184.0

## [12.233.0](https://github.com/vm0-ai/vm0/compare/web-v12.232.1...web-v12.233.0) (2026-04-14)


### Features

* **core:** split agent:delete capability from agent:write and exclude from agent tokens ([#9314](https://github.com/vm0-ai/vm0/issues/9314)) ([f52bd48](https://github.com/vm0-ai/vm0/commit/f52bd4811728e788cd6ac5d0beeda46b3cf21e59))
* **www:** add try-it CTA on use case cards and detail page ([#9138](https://github.com/vm0-ai/vm0/issues/9138)) ([c9f5b3e](https://github.com/vm0-ai/vm0/commit/c9f5b3e498759d143cf42ac3fd3cf055b3d8ab64))


### Bug Fixes

* **credit:** skip proxy usage alert when client data is all zeros ([#9316](https://github.com/vm0-ai/vm0/issues/9316)) ([491ecbb](https://github.com/vm0-ai/vm0/commit/491ecbb871fcf0cf6b270530471effb597f44597))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.183.0

## [12.232.1](https://github.com/vm0-ai/vm0/compare/web-v12.232.0...web-v12.232.1) (2026-04-14)


### Bug Fixes

* use database interval instead of stale callback payload value ([#9307](https://github.com/vm0-ai/vm0/issues/9307)) ([1c22fd7](https://github.com/vm0-ai/vm0/commit/1c22fd7d60eeca979081dd77114e528d48eb4ed4)), closes [#9304](https://github.com/vm0-ai/vm0/issues/9304)

## [12.232.0](https://github.com/vm0-ai/vm0/compare/web-v12.231.0...web-v12.232.0) (2026-04-14)


### Features

* **auth:** remove agent-run:write capability from agent tokens ([#9290](https://github.com/vm0-ai/vm0/issues/9290)) ([932a33e](https://github.com/vm0-ai/vm0/commit/932a33e3dcb73429e3b283574e4dd0c00d100caf))


### Bug Fixes

* **web:** filter out non-actionable tasks from mission control list ([#9218](https://github.com/vm0-ai/vm0/issues/9218)) ([a2e69e5](https://github.com/vm0-ai/vm0/commit/a2e69e58fb8b18efdcb9e6f4000d02c43fd779c3))

## [12.231.0](https://github.com/vm0-ai/vm0/compare/web-v12.230.0...web-v12.231.0) (2026-04-14)


### Features

* add 6 new use cases (batch 2) ([#9261](https://github.com/vm0-ai/vm0/issues/9261)) ([aba2af0](https://github.com/vm0-ai/vm0/commit/aba2af08068d5c80c00081d07b386ec0e330466e))


### Bug Fixes

* **web:** resolve SEO crawl errors for hreflang, html lang, and missing translations ([#9274](https://github.com/vm0-ai/vm0/issues/9274)) ([55f6d2b](https://github.com/vm0-ai/vm0/commit/55f6d2b5c809357e06a16460bc425dd215c5b429))

## [12.230.0](https://github.com/vm0-ai/vm0/compare/web-v12.229.1...web-v12.230.0) (2026-04-14)


### Features

* **voice-chat:** show prepared meetings list on voice chat page ([#9253](https://github.com/vm0-ai/vm0/issues/9253)) ([4b87a4f](https://github.com/vm0-ai/vm0/commit/4b87a4faebff29642789e2085b694477a398df42))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.182.0

## [12.229.1](https://github.com/vm0-ai/vm0/compare/web-v12.229.0...web-v12.229.1) (2026-04-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.181.1

## [12.229.0](https://github.com/vm0-ai/vm0/compare/web-v12.228.3...web-v12.229.0) (2026-04-14)


### Features

* persist chat thread drafts to database with local-first sync ([#9202](https://github.com/vm0-ai/vm0/issues/9202)) ([a5a0c1d](https://github.com/vm0-ai/vm0/commit/a5a0c1dfb7deff0632f57cdd84f2a1a4dad1a700))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.181.0

## [12.228.3](https://github.com/vm0-ai/vm0/compare/web-v12.228.2...web-v12.228.3) (2026-04-14)


### Bug Fixes

* **web:** resolve hreflang, html lang, sitemap and title seo issues ([#9206](https://github.com/vm0-ai/vm0/issues/9206)) ([98698a0](https://github.com/vm0-ai/vm0/commit/98698a0c7e4b27ef72384b4ffb1f0b10ea5f4f5e))

## [12.228.2](https://github.com/vm0-ai/vm0/compare/web-v12.228.1...web-v12.228.2) (2026-04-13)


### Bug Fixes

* **web:** validate custom skill names against org skills and connectors ([#9207](https://github.com/vm0-ai/vm0/issues/9207)) ([635b27a](https://github.com/vm0-ai/vm0/commit/635b27a1b9841f8f307235d2d21f27e96a36ba64)), closes [#9205](https://github.com/vm0-ai/vm0/issues/9205)

## [12.228.1](https://github.com/vm0-ai/vm0/compare/web-v12.228.0...web-v12.228.1) (2026-04-13)


### Bug Fixes

* **voice-io:** use pcm + web audio api for tts playback ([#9196](https://github.com/vm0-ai/vm0/issues/9196)) ([1b78598](https://github.com/vm0-ai/vm0/commit/1b78598dc60af1a467ead6a45b3c5229b4b5833c)), closes [#9191](https://github.com/vm0-ai/vm0/issues/9191)


### Refactoring

* rename voice-io feature switch to audio-io ([#9190](https://github.com/vm0-ai/vm0/issues/9190)) ([d45b1bb](https://github.com/vm0-ai/vm0/commit/d45b1bbdcda2b66f03ae21a5d1f2f3bc263dbc06))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.180.2

## [12.228.0](https://github.com/vm0-ai/vm0/compare/web-v12.227.0...web-v12.228.0) (2026-04-13)


### Features

* **web:** complete i18n coverage for marketing site ([#9148](https://github.com/vm0-ai/vm0/issues/9148)) ([572ceb9](https://github.com/vm0-ai/vm0/commit/572ceb9131b51e01a432a1f43bfd8f0e200de430))

## [12.227.0](https://github.com/vm0-ai/vm0/compare/web-v12.226.1...web-v12.227.0) (2026-04-13)


### Features

* upgrade stt model from whisper-1 to gpt-4o-mini-transcribe ([#9167](https://github.com/vm0-ai/vm0/issues/9167)) ([18a84b1](https://github.com/vm0-ai/vm0/commit/18a84b120760ab8c21eb56cc9c3c8b14ca0b52df)), closes [#9164](https://github.com/vm0-ai/vm0/issues/9164)


### Performance Improvements

* **voice-io:** stream tts audio for faster time-to-first-sound ([#9161](https://github.com/vm0-ai/vm0/issues/9161)) ([812b4d5](https://github.com/vm0-ai/vm0/commit/812b4d5f7abe9cc78cba4723730cfb22ea01c755)), closes [#9154](https://github.com/vm0-ai/vm0/issues/9154)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.180.1

## [12.226.1](https://github.com/vm0-ai/vm0/compare/web-v12.226.0...web-v12.226.1) (2026-04-13)


### Bug Fixes

* **web:** use schedule prompt as fallback summary and filter tasks without runs ([#9142](https://github.com/vm0-ai/vm0/issues/9142)) ([97127ea](https://github.com/vm0-ai/vm0/commit/97127ea77027aad15c06fda156206da55962a9e2))


### Refactoring

* unify member and admin onboarding connector flow ([#9129](https://github.com/vm0-ai/vm0/issues/9129)) ([#9140](https://github.com/vm0-ai/vm0/issues/9140)) ([fa03f61](https://github.com/vm0-ai/vm0/commit/fa03f61411c81522e2dd695d3bcbe08f6c952740))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.180.0

## [12.226.0](https://github.com/vm0-ai/vm0/compare/web-v12.225.0...web-v12.226.0) (2026-04-13)


### Features

* sort mission control task list with active tasks before done tasks ([#9116](https://github.com/vm0-ai/vm0/issues/9116)) ([a7132d2](https://github.com/vm0-ai/vm0/commit/a7132d2e3751e2dfabaa6a46d9db577192084514))
* **voice-chat:** add prepare pipeline, dispatch, and callback ([#9132](https://github.com/vm0-ai/vm0/issues/9132)) ([24fd18b](https://github.com/vm0-ai/vm0/commit/24fd18b851bab975120678713d0bdc82d31a7969)), closes [#9085](https://github.com/vm0-ai/vm0/issues/9085)
* **voice-chat:** change default realtime model to gpt-realtime-mini ([#9124](https://github.com/vm0-ai/vm0/issues/9124)) ([b45eefe](https://github.com/vm0-ai/vm0/commit/b45eefeec61327ab7b22bd1afde9018204feb801)), closes [#9119](https://github.com/vm0-ai/vm0/issues/9119)


### Bug Fixes

* add missing route files for task archive/unarchive (404 on y key) ([#9113](https://github.com/vm0-ai/vm0/issues/9113)) ([df8b944](https://github.com/vm0-ai/vm0/commit/df8b944a484c11e557a4dbf0ccc8646dcd943e65))
* **web:** render navbar auth state on the server to avoid refresh flicker ([#9117](https://github.com/vm0-ai/vm0/issues/9117)) ([a1dc115](https://github.com/vm0-ai/vm0/commit/a1dc115736d28c6695c1dada7f6573f572ca1f2b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.179.0

## [12.225.0](https://github.com/vm0-ai/vm0/compare/web-v12.224.0...web-v12.225.0) (2026-04-13)


### Features

* add voice_chat_preparations table and preparation service ([#9092](https://github.com/vm0-ai/vm0/issues/9092)) ([a171c51](https://github.com/vm0-ai/vm0/commit/a171c51031a1718aa1d64a4161a17e12839d8639))
* **voice-chat:** integrate preparation cache into session creation ([#9112](https://github.com/vm0-ai/vm0/issues/9112)) ([856c342](https://github.com/vm0-ai/vm0/commit/856c3421897a2a3019d496b67ef7506760e33baa)), closes [#9086](https://github.com/vm0-ai/vm0/issues/9086)

## [12.224.0](https://github.com/vm0-ai/vm0/compare/web-v12.223.0...web-v12.224.0) (2026-04-13)


### Features

* add voice-io feature switch and tts backend endpoint ([#9088](https://github.com/vm0-ai/vm0/issues/9088)) ([c5e700a](https://github.com/vm0-ai/vm0/commit/c5e700ad22b92886495e030daf9e9dfd50ff2320)), closes [#9078](https://github.com/vm0-ai/vm0/issues/9078)
* **usage:** add daily credits chart and per-run records ([#9047](https://github.com/vm0-ai/vm0/issues/9047)) ([589df8c](https://github.com/vm0-ai/vm0/commit/589df8cbf8b8d5ee495279a3f6e51aed47305daa))
* **voice-chat:** add realtime model selector ([#9082](https://github.com/vm0-ai/vm0/issues/9082)) ([b296034](https://github.com/vm0-ai/vm0/commit/b29603432ca146738da80d3f346bf714eb53ad2b)), closes [#9074](https://github.com/vm0-ai/vm0/issues/9074)
* **web:** add integration description for web chat runs ([#9090](https://github.com/vm0-ai/vm0/issues/9090)) ([7c0a09b](https://github.com/vm0-ai/vm0/commit/7c0a09bcf4e8c1066adef002e8ff3e877d1233cd))


### Refactoring

* drop proxy_credit_usage table now that billing uses credit_usage ([#9071](https://github.com/vm0-ai/vm0/issues/9071)) ([4920dc2](https://github.com/vm0-ai/vm0/commit/4920dc28d0913ed6238d94265b0725f2f12a4546))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.178.0

## [12.223.0](https://github.com/vm0-ai/vm0/compare/web-v12.222.1...web-v12.223.0) (2026-04-13)


### Features

* add archive status to mission control task list ([#9063](https://github.com/vm0-ai/vm0/issues/9063)) ([ca4d008](https://github.com/vm0-ai/vm0/commit/ca4d00838afb45f957c5a8d5fbc4dcde58265382))


### Refactoring

* use proxy-reported usage as billing source of truth ([#9064](https://github.com/vm0-ai/vm0/issues/9064)) ([b655964](https://github.com/vm0-ai/vm0/commit/b65596423f8655117ebd67c38731eb5f35c332b7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.177.0

## [12.222.1](https://github.com/vm0-ai/vm0/compare/web-v12.222.0...web-v12.222.1) (2026-04-13)


### Bug Fixes

* **web:** fall back to truncated prompt when task summary is missing ([#9058](https://github.com/vm0-ai/vm0/issues/9058)) ([3fff644](https://github.com/vm0-ai/vm0/commit/3fff644d1d36aba31af4d299c33b9d22d2abcf66))
* **web:** persist zero_runs metadata before dispatch to fix activity source race ([#9045](https://github.com/vm0-ai/vm0/issues/9045)) ([bade6ac](https://github.com/vm0-ai/vm0/commit/bade6acb7a0b0759b1d28a460a622ee1c1ece381))

## [12.222.0](https://github.com/vm0-ai/vm0/compare/web-v12.221.0...web-v12.222.0) (2026-04-13)


### Features

* **web:** revise landing page messaging for clearer value delivery ([#9006](https://github.com/vm0-ai/vm0/issues/9006)) ([101ac46](https://github.com/vm0-ai/vm0/commit/101ac46a533c280baf161f7d804299207abf570b))


### Bug Fixes

* ignore Slack retry deliveries to prevent duplicate agent runs ([#8889](https://github.com/vm0-ai/vm0/issues/8889)) ([05d5853](https://github.com/vm0-ai/vm0/commit/05d5853150720f008e15771eeca0bb33b0bda645))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.176.0

## [12.221.0](https://github.com/vm0-ai/vm0/compare/web-v12.220.1...web-v12.221.0) (2026-04-12)


### Features

* **mission-control:** add voice chat task to mission control ([#9031](https://github.com/vm0-ai/vm0/issues/9031)) ([366c655](https://github.com/vm0-ai/vm0/commit/366c655e8f1836b2f9fee778490fef0d7bb68f61))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.175.0

## [12.220.1](https://github.com/vm0-ai/vm0/compare/web-v12.220.0...web-v12.220.1) (2026-04-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.174.0

## [12.220.0](https://github.com/vm0-ai/vm0/compare/web-v12.219.0...web-v12.220.0) (2026-04-12)


### Features

* add mission_control voice chat mode ([#9026](https://github.com/vm0-ai/vm0/issues/9026)) ([261147b](https://github.com/vm0-ai/vm0/commit/261147b9b38f4017ae33a4136045244c055ae1c9))


### Bug Fixes

* **tasks:** show email tasks in Mission Control during execution ([#9025](https://github.com/vm0-ai/vm0/issues/9025)) ([9dd123b](https://github.com/vm0-ai/vm0/commit/9dd123bb553ac4a5335e3172b73cce4020162654))

## [12.219.0](https://github.com/vm0-ai/vm0/compare/web-v12.218.0...web-v12.219.0) (2026-04-12)


### Features

* **mission-control:** replace selected task state with dom focus navigation ([#9022](https://github.com/vm0-ai/vm0/issues/9022)) ([4f68649](https://github.com/vm0-ai/vm0/commit/4f686490e888049940cbd3160ed3af77138dc7b1))
* **web:** add use-case page — turn a Slack idea into an interactive prototype with v0 ([#8965](https://github.com/vm0-ai/vm0/issues/8965)) ([742459e](https://github.com/vm0-ai/vm0/commit/742459e0134432c6393e4dac195a5866ea87cdb4))


### Bug Fixes

* focus run summary generation on results rather than user input ([#8972](https://github.com/vm0-ai/vm0/issues/8972)) ([60744b6](https://github.com/vm0-ai/vm0/commit/60744b6152e65c9349aaf317a9fd784e1e8fbc31))
* remove 'Platform' text from auth page logo ([#8912](https://github.com/vm0-ai/vm0/issues/8912)) ([2de3a0e](https://github.com/vm0-ai/vm0/commit/2de3a0e93149bafec515238193ed9fe793aa9e88))
* **web:** filter axios errors from termly resource-blocker in sentry ([#8988](https://github.com/vm0-ai/vm0/issues/8988)) ([af94389](https://github.com/vm0-ai/vm0/commit/af94389088df0e7cf26ef6007e190be9cce49f13)), closes [#8983](https://github.com/vm0-ai/vm0/issues/8983)
* **web:** handle non-slug-conflict clerk 422 in onboarding setup ([#8990](https://github.com/vm0-ai/vm0/issues/8990)) ([2cb2392](https://github.com/vm0-ai/vm0/commit/2cb2392cfbbea09f6b01d9fa3c1f1083bef1a024)), closes [#8986](https://github.com/vm0-ai/vm0/issues/8986)
* **web:** handle strapi errors gracefully in blog data-source ([#8989](https://github.com/vm0-ai/vm0/issues/8989)) ([5cc96d8](https://github.com/vm0-ai/vm0/commit/5cc96d8a099f14bdc716b664e718f3a077c407d6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.173.0

## [12.218.0](https://github.com/vm0-ai/vm0/compare/web-v12.217.2...web-v12.218.0) (2026-04-11)


### Features

* redesign mission control panels from thread-centric to task-centric ([#8948](https://github.com/vm0-ai/vm0/issues/8948)) ([7fbd704](https://github.com/vm0-ai/vm0/commit/7fbd7041e549e8944f21ec1ed6c38f7c39eb36b6))


### Refactoring

* remove unrestricted permission from model-provider firewalls ([#8950](https://github.com/vm0-ai/vm0/issues/8950)) ([2a585cc](https://github.com/vm0-ai/vm0/commit/2a585cce5e0051985743ee69037d39366dbcb3c6)), closes [#8925](https://github.com/vm0-ai/vm0/issues/8925)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.172.2

## [12.217.2](https://github.com/vm0-ai/vm0/compare/web-v12.217.1...web-v12.217.2) (2026-04-11)


### Refactoring

* remove support@vm0.ai email fallback ([#8886](https://github.com/vm0-ai/vm0/issues/8886)) ([3de68d1](https://github.com/vm0-ai/vm0/commit/3de68d1c31a9d8e2ca2495ea431b34584e2700a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.172.1

## [12.217.1](https://github.com/vm0-ai/vm0/compare/web-v12.217.0...web-v12.217.1) (2026-04-11)


### Bug Fixes

* **voice-chat:** add echo cancellation for hands-free speaker mode ([#8932](https://github.com/vm0-ai/vm0/issues/8932)) ([cbaf14e](https://github.com/vm0-ai/vm0/commit/cbaf14e92602a03afb5ad8765698303a7850c60b))
* **voice-chat:** mobile-friendly footer layout for voice chat controls ([#8933](https://github.com/vm0-ai/vm0/issues/8933)) ([110f808](https://github.com/vm0-ai/vm0/commit/110f808810ab41965ac9d24aaffb73b88b904fde))
* **zero:** load user feature switch overrides for auto-skill check ([#8928](https://github.com/vm0-ai/vm0/issues/8928)) ([08a6ca1](https://github.com/vm0-ai/vm0/commit/08a6ca19eb82dada7874255a0ea128101d41dc17))

## [12.217.0](https://github.com/vm0-ai/vm0/compare/web-v12.216.0...web-v12.217.0) (2026-04-10)


### Features

* add ai-generated run summaries to mission control ([#8902](https://github.com/vm0-ai/vm0/issues/8902)) ([b12fe2d](https://github.com/vm0-ai/vm0/commit/b12fe2d55a362c0470d62f4191a7b1ddff9424e5))
* **credit:** record anthropic message id in proxy_credit_usage ([#8919](https://github.com/vm0-ai/vm0/issues/8919)) ([7bfe376](https://github.com/vm0-ai/vm0/commit/7bfe376274a4702cb116c90c9fa816307fee6f02)), closes [#8909](https://github.com/vm0-ai/vm0/issues/8909)


### Bug Fixes

* **credit:** only flag proxy usage undercount, not overcount ([#8906](https://github.com/vm0-ai/vm0/issues/8906)) ([cfcfb50](https://github.com/vm0-ai/vm0/commit/cfcfb50654695191cf697011863f87354f5b7747))
* **web:** upgrade next.js to 16.2.3 for dos vulnerability ([#8917](https://github.com/vm0-ai/vm0/issues/8917)) ([1ae3c4e](https://github.com/vm0-ai/vm0/commit/1ae3c4e660b6b76cc1eaf39ee781e9783063fb92))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.172.0

## [12.216.0](https://github.com/vm0-ai/vm0/compare/web-v12.215.2...web-v12.216.0) (2026-04-10)


### Features

* **web:** add youtube video previews to use case detail pages ([#8895](https://github.com/vm0-ai/vm0/issues/8895)) ([572a154](https://github.com/vm0-ai/vm0/commit/572a154d5ae2a462a21fe315513e299238c98d5b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.171.0

## [12.215.2](https://github.com/vm0-ai/vm0/compare/web-v12.215.1...web-v12.215.2) (2026-04-10)


### Bug Fixes

* **credit:** decouple proxy usage comparison from credit processing ([#8838](https://github.com/vm0-ai/vm0/issues/8838)) ([e86e4a7](https://github.com/vm0-ai/vm0/commit/e86e4a7c4140d7a0c0a18f8993b0638d693c8003))
* **voice-chat:** wrap end-session in transaction and surface polling errors ([#8860](https://github.com/vm0-ai/vm0/issues/8860)) ([cd28f27](https://github.com/vm0-ai/vm0/commit/cd28f276104f0174b3c53fedbbe3f53605d73590))
* **web:** remove benefit icons and fix blurry permission svg on mobile ([#8834](https://github.com/vm0-ai/vm0/issues/8834)) ([38b75b4](https://github.com/vm0-ai/vm0/commit/38b75b47f065c00d9686f985ee2fc908785cfbee))

## [12.215.1](https://github.com/vm0-ai/vm0/compare/web-v12.215.0...web-v12.215.1) (2026-04-10)


### Refactoring

* inject db feature switch overrides into backend call sites ([#8842](https://github.com/vm0-ai/vm0/issues/8842)) ([f27a863](https://github.com/vm0-ai/vm0/commit/f27a8630db18aa0da76526ed4107f8f7ddff8b82)), closes [#8820](https://github.com/vm0-ai/vm0/issues/8820)

## [12.215.0](https://github.com/vm0-ai/vm0/compare/web-v12.214.0...web-v12.215.0) (2026-04-10)


### Features

* add auto-skill feature switch and guidance injection ([#8833](https://github.com/vm0-ai/vm0/issues/8833)) ([43d3f8e](https://github.com/vm0-ai/vm0/commit/43d3f8e4b4c9f872ea743fe9cee6d04e1a40ea5e))
* add strapi connector with variable base url ([#8765](https://github.com/vm0-ai/vm0/issues/8765)) ([818b050](https://github.com/vm0-ai/vm0/commit/818b050be41e84c34f4bda89e32294f2de01c75f))
* add user feature switches table, endpoint, and core override support ([#8830](https://github.com/vm0-ai/vm0/issues/8830)) ([eadae9f](https://github.com/vm0-ai/vm0/commit/eadae9ffdba53718449c46f513abaf54989144c8))
* **voice-chat:** add quick preparation phase to voice chat mode ([#8831](https://github.com/vm0-ai/vm0/issues/8831)) ([b016f19](https://github.com/vm0-ai/vm0/commit/b016f19d2c7692fca7e74ffbdc6baad2b843e552))


### Bug Fixes

* **web:** add navbar/footer and dark mode support to terms and privacy pages ([#8785](https://github.com/vm0-ai/vm0/issues/8785)) ([3d747f8](https://github.com/vm0-ai/vm0/commit/3d747f8bed114ca04bc759e4d61dbb8e64b65fb2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.170.0

## [12.214.0](https://github.com/vm0-ai/vm0/compare/web-v12.213.0...web-v12.214.0) (2026-04-10)


### Features

* add unified tasks endpoint for mission control ([#8769](https://github.com/vm0-ai/vm0/issues/8769)) ([ed14070](https://github.com/vm0-ai/vm0/commit/ed14070c5c7bb8510d23a2f1c603cf4db2e2ef91))
* **runner:** pass feature switch states through execution context ([#8778](https://github.com/vm0-ai/vm0/issues/8778)) ([edbe85c](https://github.com/vm0-ai/vm0/commit/edbe85ca3f0fb81821aeeb609a0a700fcbd137e8))
* **voice-chat:** add meeting mode backend support ([#8802](https://github.com/vm0-ai/vm0/issues/8802)) ([20f17fb](https://github.com/vm0-ai/vm0/commit/20f17fbd58d5f49ad7f077c266ac8544a6bb6186))
* **voice-chat:** add slow brain meeting preparation prompt ([#8810](https://github.com/vm0-ai/vm0/issues/8810)) ([74db76a](https://github.com/vm0-ai/vm0/commit/74db76a1f1c7c5f5c2fd9eebf1752a6093c00ea6)), closes [#8792](https://github.com/vm0-ai/vm0/issues/8792)
* **web:** enrich diagnostic bundle with system log and full network log ([#8804](https://github.com/vm0-ai/vm0/issues/8804)) ([846d008](https://github.com/vm0-ai/vm0/commit/846d0082f4ac4fdef16d78ce04f1f2d26af8199c))


### Bug Fixes

* **auth:** correct dark mode text colors on login interface ([#8650](https://github.com/vm0-ai/vm0/issues/8650)) ([544929e](https://github.com/vm0-ai/vm0/commit/544929eee6cd4ad5f57c9413549157a7f074a6bd))
* **billing:** log error when result event lacks uuid for deduplication ([#8781](https://github.com/vm0-ai/vm0/issues/8781)) ([db72b9a](https://github.com/vm0-ai/vm0/commit/db72b9ab67a4acc11ed8356cc493ec1cdf62d821)), closes [#8771](https://github.com/vm0-ai/vm0/issues/8771)
* **runner:** address feature switch review findings ([#8801](https://github.com/vm0-ai/vm0/issues/8801)) ([ae7eaba](https://github.com/vm0-ai/vm0/commit/ae7eabad66b72d38d16a4a01b97437bd5d962b3b))
* **slack:** always send full thread context in continuous sessions ([#8782](https://github.com/vm0-ai/vm0/issues/8782)) ([44829b8](https://github.com/vm0-ai/vm0/commit/44829b841915f8589723ce6284d0ba3ac6bda1b1))
* **slack:** deduplicate events by event_id to prevent duplicate agent runs ([#8776](https://github.com/vm0-ai/vm0/issues/8776)) ([57179c5](https://github.com/vm0-ai/vm0/commit/57179c55210a1f10345ba80033d68ed902f3e212)), closes [#8773](https://github.com/vm0-ai/vm0/issues/8773)
* **web:** improve SEO with homepage metadata, sitemap images, pricing schema, and breadcrumbs ([#8667](https://github.com/vm0-ai/vm0/issues/8667)) ([5b47815](https://github.com/vm0-ai/vm0/commit/5b478154aa8e207f28039c8e067c3b9ff6d0f631))
* **web:** pass report-error link to callbacks on run failure ([#8788](https://github.com/vm0-ai/vm0/issues/8788)) ([f2d03dc](https://github.com/vm0-ai/vm0/commit/f2d03dc971fa39e2b59cd1c0b3cf189bb16d950c))
* **web:** use primary color for legal consent links in dark mode ([#8790](https://github.com/vm0-ai/vm0/issues/8790)) ([32153b8](https://github.com/vm0-ai/vm0/commit/32153b848acce78d464431802c6dd3bb0f1fa9f4))


### Refactoring

* normalize network policies schema from nullable optional to nullable ([#8808](https://github.com/vm0-ai/vm0/issues/8808)) ([3252b28](https://github.com/vm0-ai/vm0/commit/3252b282e66b6fd82bfbc767397a5e4d9359ae89))
* **voice-chat:** unify shared context naming to slow-brain/fast-brain ([#8784](https://github.com/vm0-ai/vm0/issues/8784)) ([c6c7fc2](https://github.com/vm0-ai/vm0/commit/c6c7fc2612a44b6cc52728d25838960168b27cb4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.169.0

## [12.213.0](https://github.com/vm0-ai/vm0/compare/web-v12.212.1...web-v12.213.0) (2026-04-10)


### Features

* **web:** add use cases gallery and detail pages ([#8761](https://github.com/vm0-ai/vm0/issues/8761)) ([86c6260](https://github.com/vm0-ai/vm0/commit/86c6260e1333ef0156dea48e96bf80fa20056799))


### Bug Fixes

* **platform:** hide create workspace when user already owns an org ([#8717](https://github.com/vm0-ai/vm0/issues/8717)) ([e697645](https://github.com/vm0-ai/vm0/commit/e69764522f9e3dbd4397fe7c16ea712bb429d0b5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.168.1

## [12.212.1](https://github.com/vm0-ai/vm0/compare/web-v12.212.0...web-v12.212.1) (2026-04-10)


### Bug Fixes

* **ci:** pass plain api key in ci workflows and env template ([#8749](https://github.com/vm0-ai/vm0/issues/8749)) ([5ed5cc6](https://github.com/vm0-ai/vm0/commit/5ed5cc6b2372cc088196f715022315431749ab48))
* **insights:** backfill user id in old team usage data ([#8753](https://github.com/vm0-ai/vm0/issues/8753)) ([03124d3](https://github.com/vm0-ai/vm0/commit/03124d324a301b56fe16e592bf9d8b8b2d8180ee))
* **web:** always include error-report url in failed run error message ([#8756](https://github.com/vm0-ai/vm0/issues/8756)) ([28e4999](https://github.com/vm0-ai/vm0/commit/28e49999dc44cb1f5afd044e5e6af7e2fc2f077f))

## [12.212.0](https://github.com/vm0-ai/vm0/compare/web-v12.211.0...web-v12.212.0) (2026-04-09)


### Features

* add plain connector ([#8728](https://github.com/vm0-ai/vm0/issues/8728)) ([04e4083](https://github.com/vm0-ai/vm0/commit/04e4083e55c5cbfebd2c8c2dc2a69d975f6b0ea1))
* **core:** add schedule:delete capability and exclude from agent run tokens ([#8705](https://github.com/vm0-ai/vm0/issues/8705)) ([9573bbf](https://github.com/vm0-ai/vm0/commit/9573bbf4a74d75b066f7c420c74eb21f78361636))
* **firewalls:** add deny and ask lists to granted permissions schema ([#8719](https://github.com/vm0-ai/vm0/issues/8719)) ([5a02f38](https://github.com/vm0-ai/vm0/commit/5a02f389160a6cbf961656798fe353ca029c2ece))
* route developer support tickets to Plain.com ([#8735](https://github.com/vm0-ai/vm0/issues/8735)) ([44bb3de](https://github.com/vm0-ai/vm0/commit/44bb3de0dc9e6761ce6b5d0d540f39589f923e81))
* **voice-chat:** replace read_shared_context with request_slow_brain tool ([#8748](https://github.com/vm0-ai/vm0/issues/8748)) ([4bd848d](https://github.com/vm0-ai/vm0/commit/4bd848dd18398b3083652547c1a4cb77586a5726)), closes [#8745](https://github.com/vm0-ai/vm0/issues/8745)


### Refactoring

* AP-12 batch A — eliminate internal imports in callback HMAC tests (9 files) ([#8714](https://github.com/vm0-ai/vm0/issues/8714)) ([c9eb9b6](https://github.com/vm0-ai/vm0/commit/c9eb9b69cfcf2a51c929d7335dd3a4093800f41e))
* AP-12 batch D+E — eliminate internal imports in email, agent, session, and utility tests ([#8732](https://github.com/vm0-ai/vm0/issues/8732)) ([7da93b6](https://github.com/vm0-ai/vm0/commit/7da93b64c94191440674baab9af7c035a71e8303))
* **firewalls:** change allow-unknown from boolean to policy value ([#8733](https://github.com/vm0-ai/vm0/issues/8733)) ([4e2bea3](https://github.com/vm0-ai/vm0/commit/4e2bea3758707b157bf28162ee815da2129c5f32))
* **firewalls:** rename granted-permissions to network-policies ([#8740](https://github.com/vm0-ai/vm0/issues/8740)) ([2ad2c5c](https://github.com/vm0-ai/vm0/commit/2ad2c5ce175d98304adcb5a43770df3d9d5ee9d2)), closes [#8738](https://github.com/vm0-ai/vm0/issues/8738)
* **firewalls:** unify firewall policies to include allow-unknown ([#8721](https://github.com/vm0-ai/vm0/issues/8721)) ([8905fbe](https://github.com/vm0-ai/vm0/commit/8905fbe85efdc0968f265e6b943cd9a65944923b))
* **tests:** AP-12 batch G — eliminate vi.spyOn on internal modules (7 files) ([#8739](https://github.com/vm0-ai/vm0/issues/8739)) ([1eff827](https://github.com/vm0-ai/vm0/commit/1eff8275388c04e128a8a5e937d10967f2a0b147))
* **web:** eliminate internal imports in telegram tests (ap-12 batch c) ([#8730](https://github.com/vm0-ai/vm0/issues/8730)) ([44151b1](https://github.com/vm0-ai/vm0/commit/44151b165a691a3aeb96d813b6ddc2f108119dc4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.168.0

## [12.211.0](https://github.com/vm0-ai/vm0/compare/web-v12.210.0...web-v12.211.0) (2026-04-09)


### Features

* **firewalls:** add granted permissions for three-level matching ([#8621](https://github.com/vm0-ai/vm0/issues/8621)) ([534ec85](https://github.com/vm0-ai/vm0/commit/534ec85c209f52c7388bd9819b72017bb8be6cd9))


### Bug Fixes

* **firewalls:** merge default policies with stored instead of skipping ([#8697](https://github.com/vm0-ai/vm0/issues/8697)) ([593cead](https://github.com/vm0-ai/vm0/commit/593cead62b099a5cad171ee37baa15a657f1b40f))
* **web:** ignore progress callbacks in schedule cron/loop endpoints ([#8694](https://github.com/vm0-ai/vm0/issues/8694)) ([fcd2ed4](https://github.com/vm0-ai/vm0/commit/fcd2ed4ae062dc23a9099cb81a14ca35adf255b1))
* **web:** migrate landing page and avatar customizer from img to next/image ([#8692](https://github.com/vm0-ai/vm0/issues/8692)) ([8fcd163](https://github.com/vm0-ai/vm0/commit/8fcd163f605e5da64191a7ad021513bddc64e310))


### Refactoring

* consolidate integration prompts into per-integration builders ([#8702](https://github.com/vm0-ai/vm0/issues/8702)) ([ff409cb](https://github.com/vm0-ai/vm0/commit/ff409cb8160eb73bc37179827543c990570260bb)), closes [#8696](https://github.com/vm0-ai/vm0/issues/8696)
* eliminate internal imports in slack and webhook-complete tests ([#8712](https://github.com/vm0-ai/vm0/issues/8712)) ([104a8c0](https://github.com/vm0-ai/vm0/commit/104a8c0dc4834b2b573b1394219910f7777945ab))
* **platform:** eliminate internal imports in callback hmac tests ([#8687](https://github.com/vm0-ai/vm0/issues/8687)) ([658a0d7](https://github.com/vm0-ai/vm0/commit/658a0d70d8006af02789a0d019761221b2fca703))
* remove ask-user-question feature ([#8691](https://github.com/vm0-ai/vm0/issues/8691)) ([bf49b10](https://github.com/vm0-ai/vm0/commit/bf49b103e42d5d45d11f8c74312754bd654ed775))
* **web:** eliminate internal imports in phone tests (ap-12 batch b) ([#8707](https://github.com/vm0-ai/vm0/issues/8707)) ([f2e37be](https://github.com/vm0-ai/vm0/commit/f2e37bea417a787dafba96c82fb7b77c000d435b)), closes [#8633](https://github.com/vm0-ai/vm0/issues/8633)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.167.0

## [12.210.0](https://github.com/vm0-ai/vm0/compare/web-v12.209.0...web-v12.210.0) (2026-04-09)


### Features

* add error report page and api for failed runs ([#8619](https://github.com/vm0-ai/vm0/issues/8619)) ([0b8c420](https://github.com/vm0-ai/vm0/commit/0b8c4200df1228b7fa3c16ab575bb547bba6a1f8))
* **cli:** add --mode flag to phone call command with onhold and fire-and-forget modes ([#8677](https://github.com/vm0-ai/vm0/issues/8677)) ([b0041d1](https://github.com/vm0-ai/vm0/commit/b0041d19616ef3d5fd6ddfaf0a18668bbd85534d))


### Bug Fixes

* **platform:** ignore credit errors in sentry + backfill starter credits for legacy orgs ([#8660](https://github.com/vm0-ai/vm0/issues/8660)) ([c1c6b32](https://github.com/vm0-ai/vm0/commit/c1c6b323f00d8fc5c7c918c8ccf9544441abdaf4))
* **runner:** use resume session id for runner job queue and notifications ([#8683](https://github.com/vm0-ai/vm0/issues/8683)) ([a06b4ed](https://github.com/vm0-ai/vm0/commit/a06b4edcd4deebaff495b263154951b1010a3d92)), closes [#8657](https://github.com/vm0-ai/vm0/issues/8657)


### Refactoring

* **web:** split api-test-helpers.ts into domain sub-modules ([#8649](https://github.com/vm0-ai/vm0/issues/8649)) ([c92f273](https://github.com/vm0-ai/vm0/commit/c92f27326eb3a37aaf3e262e1d78c261ab412ad6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.166.0

## [12.209.0](https://github.com/vm0-ai/vm0/compare/web-v12.208.0...web-v12.209.0) (2026-04-09)


### Features

* **zero:** inject base user info context and schedule integration for all runs ([#8630](https://github.com/vm0-ai/vm0/issues/8630)) ([2a1fe3b](https://github.com/vm0-ai/vm0/commit/2a1fe3b7cbefb31b19a3650e661c281c03694036))


### Bug Fixes

* **slack:** fix queued run ephemeral visibility and missing callback registration ([#8641](https://github.com/vm0-ai/vm0/issues/8641)) ([cd9e098](https://github.com/vm0-ai/vm0/commit/cd9e09822f096707b464534e84349aeee6832fd1))
* **voice-chat:** use valid realtime api voice parameter ([#8644](https://github.com/vm0-ai/vm0/issues/8644)) ([cd722ea](https://github.com/vm0-ai/vm0/commit/cd722eaad2b021fba4e4e8d1621b8ba452217090))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.165.0

## [12.208.0](https://github.com/vm0-ai/vm0/compare/web-v12.207.0...web-v12.208.0) (2026-04-09)


### Features

* **billing:** add proxy-side usage extraction for billing verification ([#8581](https://github.com/vm0-ai/vm0/issues/8581)) ([87f5049](https://github.com/vm0-ai/vm0/commit/87f5049ab3eb8e4aaa26537f412b628d0f687bc6))
* **phone:** improve receptionist prompt and add file input flags to CLI ([#8580](https://github.com/vm0-ai/vm0/issues/8580)) ([cbdd656](https://github.com/vm0-ai/vm0/commit/cbdd656f75a1ac9fd58b6c6041ca1d34db38a84b))
* **runs:** add session id to run context snapshot and ui ([#8577](https://github.com/vm0-ai/vm0/issues/8577)) ([96c6616](https://github.com/vm0-ai/vm0/commit/96c6616ac27410f3801352c44d23c75514b65672))
* **slack:** include triggering user in slack message footers ([#8579](https://github.com/vm0-ai/vm0/issues/8579)) ([b8d5cd0](https://github.com/vm0-ai/vm0/commit/b8d5cd0458db147114c0f94332c14b099bf678af)), closes [#8575](https://github.com/vm0-ai/vm0/issues/8575)
* **voice-chat:** upgrade realtime model to gpt-realtime-1.5 and use onyx voice ([#8596](https://github.com/vm0-ai/vm0/issues/8596)) ([ed4bcf5](https://github.com/vm0-ai/vm0/commit/ed4bcf5f2cd1855bb79c58586ab1b2bc9a7f41a6)), closes [#8588](https://github.com/vm0-ai/vm0/issues/8588)


### Bug Fixes

* make terms and privacy pages accessible without login on locale-prefixed urls ([#8586](https://github.com/vm0-ai/vm0/issues/8586)) ([f7a32d8](https://github.com/vm0-ai/vm0/commit/f7a32d87f719579e9f7e1294b6a908f79fe81868))
* revert contact email changes except developer-support route ([#8627](https://github.com/vm0-ai/vm0/issues/8627)) ([ea70ebf](https://github.com/vm0-ai/vm0/commit/ea70ebfcd248dc87cf42587a112f8207a5e0c5ee))
* **runner:** treat max_concurrent=0 as unlimited in session affinity routing ([#8616](https://github.com/vm0-ai/vm0/issues/8616)) ([2f8127b](https://github.com/vm0-ai/vm0/commit/2f8127b4d3e77d414c0479ad9aeefbf028384bf0))


### Refactoring

* replace contact@vm0.ai with support@vm0.ai ([#8617](https://github.com/vm0-ai/vm0/issues/8617)) ([c8d67df](https://github.com/vm0-ai/vm0/commit/c8d67df2cab759b0845be81f4ef2d0f97fb4fe64)), closes [#8615](https://github.com/vm0-ai/vm0/issues/8615)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.164.0

## [12.207.0](https://github.com/vm0-ai/vm0/compare/web-v12.206.0...web-v12.207.0) (2026-04-09)


### Features

* **web:** redesign landing page with new layouts, assets, and avatar customizer ([#8545](https://github.com/vm0-ai/vm0/issues/8545)) ([e4a9d11](https://github.com/vm0-ai/vm0/commit/e4a9d1148643bd5b8af23886cfd615ad7d40aca2))

## [12.206.0](https://github.com/vm0-ai/vm0/compare/web-v12.205.0...web-v12.206.0) (2026-04-09)


### Features

* add phone channel powered by agentphone ([#8496](https://github.com/vm0-ai/vm0/issues/8496)) ([43779b3](https://github.com/vm0-ai/vm0/commit/43779b320bdfd8bf85786561dfef612f84060023))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.163.0

## [12.205.0](https://github.com/vm0-ai/vm0/compare/web-v12.204.1...web-v12.205.0) (2026-04-08)


### Features

* add voice-chat db schema and migration ([#8542](https://github.com/vm0-ai/vm0/issues/8542)) ([016f427](https://github.com/vm0-ai/vm0/commit/016f42747c7e4a5adaad1ae251691e55c7cf40ea))
* add web push notifications for pwa on chat completion ([#8501](https://github.com/vm0-ai/vm0/issues/8501)) ([a89b898](https://github.com/vm0-ai/vm0/commit/a89b89890c6b6ff66cc761fca39bc6195f8485bb))
* **core:** add voice-chat types and feature flag ([#8529](https://github.com/vm0-ai/vm0/issues/8529)) ([#8539](https://github.com/vm0-ai/vm0/issues/8539)) ([ee7ee22](https://github.com/vm0-ai/vm0/commit/ee7ee222ae733f47f7cb323d871f2a9577adc41c))
* **voice-chat:** add webrtc frontend with live transcript and context panels ([#8556](https://github.com/vm0-ai/vm0/issues/8556)) ([ded50f2](https://github.com/vm0-ai/vm0/commit/ded50f20faf57860f14a8aee6a11a2dbb0cb4d3d))
* **web:** add voice-chat shared context api ([#8531](https://github.com/vm0-ai/vm0/issues/8531)) ([#8551](https://github.com/vm0-ai/vm0/issues/8551)) ([9459f53](https://github.com/vm0-ai/vm0/commit/9459f5323d8dfb78d6bee09d114b3d63c9dd3d82))
* **web:** add voice-chat token endpoint and cleanup cron ([#8553](https://github.com/vm0-ai/vm0/issues/8553)) ([b97cca3](https://github.com/vm0-ai/vm0/commit/b97cca37554bed8f68806cf0fbcb4d5f393aa4d0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.162.0

## [12.204.1](https://github.com/vm0-ai/vm0/compare/web-v12.204.0...web-v12.204.1) (2026-04-08)


### Bug Fixes

* **model-providers:** use hyphenated model ids to match anthropic api format ([#8511](https://github.com/vm0-ai/vm0/issues/8511)) ([1bcd1e6](https://github.com/vm0-ai/vm0/commit/1bcd1e67f54105831b71182482488f21871ee25d))
* split permission-change into its own line in agent prompt ([#8503](https://github.com/vm0-ai/vm0/issues/8503)) ([9734723](https://github.com/vm0-ai/vm0/commit/973472310708c6db3915e8085a0ba7308671d109))


### Refactoring

* **auth:** rename verify-membership-cached to get-member-role ([#8497](https://github.com/vm0-ai/vm0/issues/8497)) ([#8500](https://github.com/vm0-ai/vm0/issues/8500)) ([877fef9](https://github.com/vm0-ai/vm0/commit/877fef923c48aa6e6eeaf99a5bf0bc6523f9bd69))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.161.1

## [12.204.0](https://github.com/vm0-ai/vm0/compare/web-v12.203.0...web-v12.204.0) (2026-04-08)


### Features

* **model-providers:** add model selection for anthropic-api-key and claude-code-oauth-token ([#8491](https://github.com/vm0-ai/vm0/issues/8491)) ([ad96e27](https://github.com/vm0-ai/vm0/commit/ad96e27561f8bcdb69bf8d3268e4d168d98b9662))
* **platform:** capture response headers and mark binary bodies in network logs ([#8481](https://github.com/vm0-ai/vm0/issues/8481)) ([6a778f8](https://github.com/vm0-ai/vm0/commit/6a778f8ebbd88e2bd95a4d79a5e4ed1e4c3f4f26))
* **runner:** add smart dispatch with session affinity and targeted ably push ([#8474](https://github.com/vm0-ai/vm0/issues/8474)) ([65dbe3a](https://github.com/vm0-ai/vm0/commit/65dbe3af2795aa2730a3df28e84e3572fc8a46cc)), closes [#8368](https://github.com/vm0-ai/vm0/issues/8368)


### Bug Fixes

* **slack:** skip channel context fetch for dm conversations ([#8475](https://github.com/vm0-ai/vm0/issues/8475)) ([07a3321](https://github.com/vm0-ai/vm0/commit/07a33216d0a47047b341a0784324cb71b596a7f4))


### Refactoring

* **org:** replace bundled org data accessors with explicit functions ([#8487](https://github.com/vm0-ai/vm0/issues/8487)) ([1d2e1bc](https://github.com/vm0-ai/vm0/commit/1d2e1bc6fff592146be61b09b1860a42e99a25e5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.161.0

## [12.203.0](https://github.com/vm0-ai/vm0/compare/web-v12.202.0...web-v12.203.0) (2026-04-08)


### Features

* display last updated timestamp and refetch insights on navigation ([#8443](https://github.com/vm0-ai/vm0/issues/8443)) ([11e5743](https://github.com/vm0-ai/vm0/commit/11e5743855d534c60ccbc7470e73f47f8cc9797b))
* **schedule:** add consecutive failure tracking and auto-disable for cron schedules ([#8430](https://github.com/vm0-ai/vm0/issues/8430)) ([22bd168](https://github.com/vm0-ai/vm0/commit/22bd168e85247530d6c5c516c0929a423255b634))
* **slack:** add ffmpeg frame extraction hint for video attachments ([#8459](https://github.com/vm0-ai/vm0/issues/8459)) ([d5a4085](https://github.com/vm0-ai/vm0/commit/d5a40856aa7496ebe6a06f275c5240470878987a))


### Bug Fixes

* **checkpoint:** extract blob pre-registration into session-history service ([#8457](https://github.com/vm0-ai/vm0/issues/8457)) ([94f38d7](https://github.com/vm0-ai/vm0/commit/94f38d7ca4d5c96acd2387de2827d030d16cfc8a)), closes [#8454](https://github.com/vm0-ai/vm0/issues/8454)
* **checkpoint:** use presigned url for session history upload ([#8445](https://github.com/vm0-ai/vm0/issues/8445)) ([4a019bb](https://github.com/vm0-ai/vm0/commit/4a019bb53dc2323e2981f74d02e78f4eaf2e185c))
* **deps:** upgrade drizzle-orm to patch sql injection vulnerability ([#8424](https://github.com/vm0-ai/vm0/issues/8424)) ([c3ea03f](https://github.com/vm0-ai/vm0/commit/c3ea03f428975d983a9ada2a9c52823ac9ad202b))
* **developer-support:** include user prompts in download bundle ([#8465](https://github.com/vm0-ai/vm0/issues/8465)) ([03e29d0](https://github.com/vm0-ai/vm0/commit/03e29d04e0b4a90d00b90a645927e2ddedf59737))
* **onboarding:** handle clerk 422 errors and unhandled promise rejection ([#8444](https://github.com/vm0-ai/vm0/issues/8444)) ([b67a216](https://github.com/vm0-ai/vm0/commit/b67a216987194280c4b0c0d38ad8718ebe950f9c)), closes [#8439](https://github.com/vm0-ai/vm0/issues/8439)
* **schedule:** handle pre-run failures to prevent stuck schedules ([#8463](https://github.com/vm0-ai/vm0/issues/8463)) ([6d52f12](https://github.com/vm0-ai/vm0/commit/6d52f12a652bff0fd5d5555ddfd58375496a7805)), closes [#8106](https://github.com/vm0-ai/vm0/issues/8106)
* **schedule:** prevent duplicate execution via atomic claim ([#8451](https://github.com/vm0-ai/vm0/issues/8451)) ([d7c7c61](https://github.com/vm0-ai/vm0/commit/d7c7c61c2083d8854540519b45eaefe0881164d7)), closes [#8446](https://github.com/vm0-ai/vm0/issues/8446)


### Refactoring

* **firewalls:** remove fine-grained permissions from github firewall ([#8432](https://github.com/vm0-ai/vm0/issues/8432)) ([2471dfd](https://github.com/vm0-ai/vm0/commit/2471dfdd2da6bf4407f5d0a5e565d334f750cfe9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.160.0

## [12.202.0](https://github.com/vm0-ai/vm0/compare/web-v12.201.0...web-v12.202.0) (2026-04-07)


### Features

* add per-user capture-network-bodies quota in preferences ([#8402](https://github.com/vm0-ai/vm0/issues/8402)) ([7029364](https://github.com/vm0-ai/vm0/commit/70293646c5aa630f3f4d8b2217bcc93043bcf3ea))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.159.0

## [12.201.0](https://github.com/vm0-ai/vm0/compare/web-v12.200.0...web-v12.201.0) (2026-04-07)


### Features

* add --user flag to zero slack message send for direct messages ([#8397](https://github.com/vm0-ai/vm0/issues/8397)) ([3792b80](https://github.com/vm0-ai/vm0/commit/3792b8035969edbe24db33ddf059829b7b9f7d9a)), closes [#8394](https://github.com/vm0-ai/vm0/issues/8394)
* **platform:** use proper connector labels in network insights page ([#8395](https://github.com/vm0-ai/vm0/issues/8395)) ([0c057c7](https://github.com/vm0-ai/vm0/commit/0c057c70fabf31c8643a7b3b2d55deb5dad8abe7))
* **runner:** add runner state reporting via heartbeat ([#8367](https://github.com/vm0-ai/vm0/issues/8367)) ([#8380](https://github.com/vm0-ai/vm0/issues/8380)) ([2dea967](https://github.com/vm0-ai/vm0/commit/2dea96701d28d963e74816908517519d1b55c939))


### Bug Fixes

* use pagination instead of cel filter for cloud endpoint lookup ([#8392](https://github.com/vm0-ai/vm0/issues/8392)) ([30d4d14](https://github.com/vm0-ai/vm0/commit/30d4d14d29f3f3a594afd42a6d8e5217f24b22e1))


### Refactoring

* move cli run business logic from infra to api route ([#8393](https://github.com/vm0-ai/vm0/issues/8393)) ([139abb3](https://github.com/vm0-ai/vm0/commit/139abb3b519c8013b9dca07fb17766a607ff5025))
* throw not-found for missing org metadata rows ([#8390](https://github.com/vm0-ai/vm0/issues/8390)) ([b70247c](https://github.com/vm0-ai/vm0/commit/b70247c622859133bc10635c2d3fff8673e730b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.158.0

## [12.200.0](https://github.com/vm0-ai/vm0/compare/web-v12.199.1...web-v12.200.0) (2026-04-07)


### Features

* add insights dashboard with cron pre-aggregation pipeline ([#8387](https://github.com/vm0-ai/vm0/issues/8387)) ([4ba9dbe](https://github.com/vm0-ai/vm0/commit/4ba9dbe12ca1a3102646d358076010981a06da07))
* add user email and org name to developer-support email ([#8376](https://github.com/vm0-ai/vm0/issues/8376)) ([942e444](https://github.com/vm0-ai/vm0/commit/942e444bd7f740ce8e79bce4066f7c5f6357405c))
* gate capture-network-bodies to internal accounts in production ([#8386](https://github.com/vm0-ai/vm0/issues/8386)) ([eb65214](https://github.com/vm0-ai/vm0/commit/eb65214bd174607de6414bb435f362d0cf0ec189))
* **proxy:** add opt-in http body capture to mitmproxy addon ([#8349](https://github.com/vm0-ai/vm0/issues/8349)) ([95709fb](https://github.com/vm0-ai/vm0/commit/95709fb721befedd489025c39124b3663226d3f9))


### Refactoring

* restructure run record creation — zero owns transaction ([#8378](https://github.com/vm0-ai/vm0/issues/8378)) ([d75a349](https://github.com/vm0-ai/vm0/commit/d75a3490ed0e0eb1fbc89eac2b3afdb7bcb4e1a5)), closes [#8366](https://github.com/vm0-ai/vm0/issues/8366)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.157.0

## [12.199.1](https://github.com/vm0-ai/vm0/compare/web-v12.199.0...web-v12.199.1) (2026-04-07)


### Bug Fixes

* **billing:** address pr review issues in stale billing period fix ([#8297](https://github.com/vm0-ai/vm0/issues/8297)) ([73a6ecf](https://github.com/vm0-ai/vm0/commit/73a6ecf60c1c1fa17edf78a9ce3a6f57b698728e))
* **firewall:** include all permissions when no policies are configured ([#8352](https://github.com/vm0-ai/vm0/issues/8352)) ([abfbd17](https://github.com/vm0-ai/vm0/commit/abfbd17a958c9abecea2996434543eed25722394))


### Refactoring

* extract concurrency control and business policy from infra to zero ([#8373](https://github.com/vm0-ai/vm0/issues/8373)) ([4a1a77d](https://github.com/vm0-ai/vm0/commit/4a1a77dc78ba80cd50895ca643679c0df50fe83a)), closes [#8363](https://github.com/vm0-ai/vm0/issues/8363)
* move cancel-run from infra to zero layer ([#8365](https://github.com/vm0-ai/vm0/issues/8365)) ([#8371](https://github.com/vm0-ai/vm0/issues/8371)) ([4a8a118](https://github.com/vm0-ai/vm0/commit/4a8a1180d9c8fa73ce6bcb4541c17f6ef4e6599a))
* remove 3-step existence check from resolve-org ([#8348](https://github.com/vm0-ai/vm0/issues/8348)) ([60a196c](https://github.com/vm0-ai/vm0/commit/60a196cc3c095d1365584d821923685498c60faf))

## [12.199.0](https://github.com/vm0-ai/vm0/compare/web-v12.198.1...web-v12.199.0) (2026-04-07)


### Features

* **firewall:** add slack notifications and doctor --reason pre-fill ([#8339](https://github.com/vm0-ai/vm0/issues/8339)) ([7819955](https://github.com/vm0-ai/vm0/commit/78199554e4a233b19e7f633e150abfb5691f0413))

## [12.198.1](https://github.com/vm0-ai/vm0/compare/web-v12.198.0...web-v12.198.1) (2026-04-07)


### Bug Fixes

* use 403 instead of 401 for authorization errors ([#8335](https://github.com/vm0-ai/vm0/issues/8335)) ([fc09ed3](https://github.com/vm0-ai/vm0/commit/fc09ed3a32f50e350fe271568942dc28632baadf))


### Refactoring

* remove cross-org resolve-org calls from slack connect routes ([#8344](https://github.com/vm0-ai/vm0/issues/8344)) ([5a6762c](https://github.com/vm0-ai/vm0/commit/5a6762c8eeae9d22089bf12573d7506b0e167e6d)), closes [#8341](https://github.com/vm0-ai/vm0/issues/8341)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.156.1

## [12.198.0](https://github.com/vm0-ai/vm0/compare/web-v12.197.1...web-v12.198.0) (2026-04-07)


### Features

* add audit link feature switch to control audit link in slack messages ([#8328](https://github.com/vm0-ai/vm0/issues/8328)) ([9551e35](https://github.com/vm0-ai/vm0/commit/9551e3517c607cc49d909eedba1c93092a5fac40))


### Refactoring

* remove unnecessary org data lookup from storages/commit webhook ([#8321](https://github.com/vm0-ai/vm0/issues/8321)) ([2d96f27](https://github.com/vm0-ai/vm0/commit/2d96f27d7c7dab67b8baf465ae3516b39434de28)), closes [#8313](https://github.com/vm0-ai/vm0/issues/8313)
* remove unnecessary org data lookup from storages/prepare webhook ([#8319](https://github.com/vm0-ai/vm0/issues/8319)) ([0d4549c](https://github.com/vm0-ai/vm0/commit/0d4549c02dbf590355182365ecdc0ee8e449ae70)), closes [#8312](https://github.com/vm0-ai/vm0/issues/8312)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.156.0

## [12.197.1](https://github.com/vm0-ai/vm0/compare/web-v12.197.0...web-v12.197.1) (2026-04-07)


### Bug Fixes

* use in-operator for ngrok domain lookup with known suffixes ([#8300](https://github.com/vm0-ai/vm0/issues/8300)) ([965e778](https://github.com/vm0-ai/vm0/commit/965e7782a885262e2167c1f21b7a4c57cbfa8fac))


### Refactoring

* extract shared axiom network event type from duplicate route definitions ([#8299](https://github.com/vm0-ai/vm0/issues/8299)) ([dc8a3c2](https://github.com/vm0-ai/vm0/commit/dc8a3c26d4b01c70f11f127be2bc9d2110c8a1e5)), closes [#7656](https://github.com/vm0-ai/vm0/issues/7656)
* redesign firewall allow focused views as approval cards ([#7712](https://github.com/vm0-ai/vm0/issues/7712)) ([3a34350](https://github.com/vm0-ai/vm0/commit/3a3435054b8affe16ca1a0329d6ffaf1f28012ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.155.1

## [12.197.0](https://github.com/vm0-ai/vm0/compare/web-v12.196.3...web-v12.197.0) (2026-04-07)


### Features

* **platform:** add lab page for feature switch management ([#8288](https://github.com/vm0-ai/vm0/issues/8288)) ([b87f833](https://github.com/vm0-ai/vm0/commit/b87f83385dffa46c4a5b60c736d32ed51cdd4bab))


### Bug Fixes

* **billing:** refresh stale billing period from stripe when cached date expires ([#8277](https://github.com/vm0-ai/vm0/issues/8277)) ([59f5580](https://github.com/vm0-ai/vm0/commit/59f5580177744a8307e24203e8e3be513caed52b))
* restore org slug update in onboarding setup ([#8291](https://github.com/vm0-ai/vm0/issues/8291)) ([00bdfb3](https://github.com/vm0-ai/vm0/commit/00bdfb367bc5508e6b85a2c10c1352c94b0f58dd))


### Refactoring

* **zero:** unify pre-flight checks between zero-run-service and zero-run-queue-service ([#8294](https://github.com/vm0-ai/vm0/issues/8294)) ([cc3cc68](https://github.com/vm0-ai/vm0/commit/cc3cc6826c1ba9e87bd7189ca576cd20df81ed76)), closes [#8281](https://github.com/vm0-ai/vm0/issues/8281)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.155.0

## [12.196.3](https://github.com/vm0-ai/vm0/compare/web-v12.196.2...web-v12.196.3) (2026-04-07)


### Bug Fixes

* add validation error logging and client-side skill name checks ([#8109](https://github.com/vm0-ai/vm0/issues/8109)) ([#8283](https://github.com/vm0-ai/vm0/issues/8283)) ([51d259a](https://github.com/vm0-ai/vm0/commit/51d259a9de2d7e1f8932fb85fb6759b4e2085c07))
* **api:** return correct status codes for application errors ([#8279](https://github.com/vm0-ai/vm0/issues/8279)) ([1f5daf1](https://github.com/vm0-ai/vm0/commit/1f5daf1ba77266e5e715a7c8def979e797bdf73a))
* use prefix match for ngrok domain lookup instead of hardcoded suffix ([#8285](https://github.com/vm0-ai/vm0/issues/8285)) ([417fd18](https://github.com/vm0-ai/vm0/commit/417fd18108679f667ef926051970c9ca5e7bcdcd)), closes [#8267](https://github.com/vm0-ai/vm0/issues/8267)


### Performance Improvements

* remove workspace name step and clerk calls from onboarding setup ([#8275](https://github.com/vm0-ai/vm0/issues/8275)) ([a0b2bcd](https://github.com/vm0-ai/vm0/commit/a0b2bcd9fb01f74e85251a0cc9041dd79327f884))

## [12.196.2](https://github.com/vm0-ai/vm0/compare/web-v12.196.1...web-v12.196.2) (2026-04-07)


### Refactoring

* adopt ngrok find-or-update pattern for cloud endpoints and reserved domains ([#8269](https://github.com/vm0-ai/vm0/issues/8269)) ([1a2e5f5](https://github.com/vm0-ai/vm0/commit/1a2e5f563717a8df134a7593706b91cee3fbf08d)), closes [#8267](https://github.com/vm0-ai/vm0/issues/8267)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.154.1

## [12.196.1](https://github.com/vm0-ai/vm0/compare/web-v12.196.0...web-v12.196.1) (2026-04-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.154.0

## [12.196.0](https://github.com/vm0-ai/vm0/compare/web-v12.195.1...web-v12.196.0) (2026-04-06)


### Features

* **web:** fix critical seo issues for vm0.ai ([#8239](https://github.com/vm0-ai/vm0/issues/8239)) ([44e66f6](https://github.com/vm0-ai/vm0/commit/44e66f628cd701b096c7855e591b4cf730a3e28b))

## [12.195.1](https://github.com/vm0-ai/vm0/compare/web-v12.195.0...web-v12.195.1) (2026-04-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.153.1

## [12.195.0](https://github.com/vm0-ai/vm0/compare/web-v12.194.0...web-v12.195.0) (2026-04-06)


### Features

* add Pika connector ([#8218](https://github.com/vm0-ai/vm0/issues/8218)) ([9a1bacb](https://github.com/vm0-ai/vm0/commit/9a1bacb8e18ab800c6f57951192b3a3675670066))


### Bug Fixes

* prevent ngrok resource leaks in computer-use and connector services ([#8206](https://github.com/vm0-ai/vm0/issues/8206)) ([0a81e01](https://github.com/vm0-ai/vm0/commit/0a81e01b200800af3d13348b8bbc58d02c5d3b93))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.153.0

## [12.194.0](https://github.com/vm0-ai/vm0/compare/web-v12.193.0...web-v12.194.0) (2026-04-05)


### Features

* add AgentPhone API token connector ([#8203](https://github.com/vm0-ai/vm0/issues/8203)) ([e11b420](https://github.com/vm0-ai/vm0/commit/e11b420fcd8caf7601cc141ebcc442b61c1d17f7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.152.0

## [12.193.0](https://github.com/vm0-ai/vm0/compare/web-v12.192.8...web-v12.193.0) (2026-04-05)


### Features

* add Doppler and Infisical secret manager connectors ([#8198](https://github.com/vm0-ai/vm0/issues/8198)) ([a951ae6](https://github.com/vm0-ai/vm0/commit/a951ae612e5ae9e92b8d8e37afb28745b4a6b362))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.151.0

## [12.192.8](https://github.com/vm0-ai/vm0/compare/web-v12.192.7...web-v12.192.8) (2026-04-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.150.2

## [12.192.7](https://github.com/vm0-ai/vm0/compare/web-v12.192.6...web-v12.192.7) (2026-04-04)


### Performance Improvements

* replace sha1 with fnv1a in feature switch for synchronous hashing ([#8162](https://github.com/vm0-ai/vm0/issues/8162)) ([7c41de5](https://github.com/vm0-ai/vm0/commit/7c41de5371ec0dc440b72f06b1fc99d825680f20))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.150.1

## [12.192.6](https://github.com/vm0-ai/vm0/compare/web-v12.192.5...web-v12.192.6) (2026-04-04)


### Bug Fixes

* handle ngrok domain already reserved on computer-use registration ([#8149](https://github.com/vm0-ai/vm0/issues/8149)) ([6984663](https://github.com/vm0-ai/vm0/commit/69846636a4b84c9a02065eaabe1458dc4525a732))

## [12.192.5](https://github.com/vm0-ai/vm0/compare/web-v12.192.4...web-v12.192.5) (2026-04-04)


### Bug Fixes

* resolve computer-use re-registration endpoint conflict ([#8145](https://github.com/vm0-ai/vm0/issues/8145)) ([746abef](https://github.com/vm0-ai/vm0/commit/746abef75df4af8e54650f41b2e6a6223721f258))

## [12.192.4](https://github.com/vm0-ai/vm0/compare/web-v12.192.3...web-v12.192.4) (2026-04-04)


### Refactoring

* make computer-use host registration idempotent ([#8137](https://github.com/vm0-ai/vm0/issues/8137)) ([a5dd154](https://github.com/vm0-ai/vm0/commit/a5dd154577a767c09872639eae6dca495708957e))

## [12.192.3](https://github.com/vm0-ai/vm0/compare/web-v12.192.2...web-v12.192.3) (2026-04-04)


### Refactoring

* use hash-based slug for ngrok domain names ([#8117](https://github.com/vm0-ai/vm0/issues/8117)) ([a448dfc](https://github.com/vm0-ai/vm0/commit/a448dfc9053bd31147544d7d323aae0939714775))

## [12.192.2](https://github.com/vm0-ai/vm0/compare/web-v12.192.1...web-v12.192.2) (2026-04-04)


### Bug Fixes

* sanitize underscores in full org id for all ngrok domain names ([#8111](https://github.com/vm0-ai/vm0/issues/8111)) ([83abffc](https://github.com/vm0-ai/vm0/commit/83abffcc4f61ca0615e2010ed959e146265a98b7))

## [12.192.1](https://github.com/vm0-ai/vm0/compare/web-v12.192.0...web-v12.192.1) (2026-04-04)


### Bug Fixes

* replace underscores in org id for ngrok subdomain names ([#8096](https://github.com/vm0-ai/vm0/issues/8096)) ([3ecd2d1](https://github.com/vm0-ai/vm0/commit/3ecd2d1496858e3ec09ab402c51b1401c38152ab))

## [12.192.0](https://github.com/vm0-ai/vm0/compare/web-v12.191.1...web-v12.192.0) (2026-04-03)


### Features

* **platform:** add computer-use server api, contracts, and access control ([#8069](https://github.com/vm0-ai/vm0/issues/8069)) ([042127e](https://github.com/vm0-ai/vm0/commit/042127ec5539871d0b1fd7a206dab8ed12dd007f))


### Bug Fixes

* **developer-support:** collect agent events from axiom instead of empty chat messages ([#8035](https://github.com/vm0-ai/vm0/issues/8035)) ([0546641](https://github.com/vm0-ai/vm0/commit/054664136476184e3bdd2c3d0083a00260b93579))


### Performance Improvements

* **onboarding:** consolidate into single server api call ([#8041](https://github.com/vm0-ai/vm0/issues/8041)) ([6bf4e9d](https://github.com/vm0-ai/vm0/commit/6bf4e9dc17d20fcb2d7947e6a636e2bb15f35929))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.150.0

## [12.191.1](https://github.com/vm0-ai/vm0/compare/web-v12.191.0...web-v12.191.1) (2026-04-03)


### Bug Fixes

* use session id instead of run id for developer-support consent code ([#8016](https://github.com/vm0-ai/vm0/issues/8016)) ([de33b0d](https://github.com/vm0-ai/vm0/commit/de33b0de0ee780188d80984801f4ec50ed9e7df3)), closes [#8013](https://github.com/vm0-ai/vm0/issues/8013)


### Refactoring

* remove unused developer-support:write capability ([#8017](https://github.com/vm0-ai/vm0/issues/8017)) ([6ab03d5](https://github.com/vm0-ai/vm0/commit/6ab03d54396902a1c0d7c6612ba45874122c0f78))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.149.1

## [12.191.0](https://github.com/vm0-ai/vm0/compare/web-v12.190.0...web-v12.191.0) (2026-04-03)


### Features

* add developer-support server endpoint with consent code and zip bundle ([#7980](https://github.com/vm0-ai/vm0/issues/7980)) ([ec27476](https://github.com/vm0-ai/vm0/commit/ec2747693b605d90b1b47656bb88680c6a8a6cc4))


### Refactoring

* **web:** move clerk-config to shared directory ([#7983](https://github.com/vm0-ai/vm0/issues/7983)) ([538284c](https://github.com/vm0-ai/vm0/commit/538284cbf8aad04e85ce08bfad9d005d50baacb3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.149.0

## [12.190.0](https://github.com/vm0-ai/vm0/compare/web-v12.189.2...web-v12.190.0) (2026-04-03)


### Features

* **zero:** add `zero whoami` to agent system prompt ([#7891](https://github.com/vm0-ai/vm0/issues/7891)) ([1ba94f5](https://github.com/vm0-ai/vm0/commit/1ba94f5be0614ff63d0e6437ff437982b4562e92)), closes [#7640](https://github.com/vm0-ai/vm0/issues/7640)


### Refactoring

* **web:** move ai from shared to zero ([#7898](https://github.com/vm0-ai/vm0/issues/7898)) ([db96e71](https://github.com/vm0-ai/vm0/commit/db96e7174925cebfd0920adfe90fc304e4a4af0b))
* **web:** move framework config from shared to infra ([#7886](https://github.com/vm0-ai/vm0/issues/7886)) ([3b41039](https://github.com/vm0-ai/vm0/commit/3b41039acd4bd3e2ee8260b359a6df521c673497))
* **web:** move metrics from shared to infra ([#7888](https://github.com/vm0-ai/vm0/issues/7888)) ([1a3ee3f](https://github.com/vm0-ai/vm0/commit/1a3ee3fdbd4e9e98beed43c980ee0d2483e8526a))
* **web:** move realtime from shared to infra ([#7889](https://github.com/vm0-ai/vm0/issues/7889)) ([8264e2a](https://github.com/vm0-ai/vm0/commit/8264e2a5e9afcbc15f80e07bf5b4ea4ad9108bca))

## [12.189.2](https://github.com/vm0-ai/vm0/compare/web-v12.189.1...web-v12.189.2) (2026-04-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.148.0

## [12.189.1](https://github.com/vm0-ai/vm0/compare/web-v12.189.0...web-v12.189.1) (2026-04-03)


### Bug Fixes

* clean up runs on agent deletion, preserve billing records ([#7846](https://github.com/vm0-ai/vm0/issues/7846)) ([0d676a7](https://github.com/vm0-ai/vm0/commit/0d676a7d5b20573c7ef45b3f6681f5065fdaa0f7))


### Refactoring

* decompose build-zero-context.ts into focused modules under zero/context/ ([#7856](https://github.com/vm0-ai/vm0/issues/7856)) ([c1e8b0f](https://github.com/vm0-ai/vm0/commit/c1e8b0ff49a4b27091ef40772478c8a2595971ff)), closes [#7848](https://github.com/vm0-ai/vm0/issues/7848)

## [12.189.0](https://github.com/vm0-ai/vm0/compare/web-v12.188.4...web-v12.189.0) (2026-04-03)


### Features

* add connector read capability and gate connector api endpoints ([#7819](https://github.com/vm0-ai/vm0/issues/7819)) ([9117bf1](https://github.com/vm0-ai/vm0/commit/9117bf144a7b317d021807d5a06ccd031023994f))


### Bug Fixes

* respect redirect_url query parameter after sign-in and sign-up ([#7814](https://github.com/vm0-ai/vm0/issues/7814)) ([ce0a58b](https://github.com/vm0-ai/vm0/commit/ce0a58b4ffd585fd8d3628b55acca5db291f0f2e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.147.0

## [12.188.4](https://github.com/vm0-ai/vm0/compare/web-v12.188.3...web-v12.188.4) (2026-04-03)


### Refactoring

* move loose lib/ files into proper architecture layers ([#7805](https://github.com/vm0-ai/vm0/issues/7805)) ([#7807](https://github.com/vm0-ai/vm0/issues/7807)) ([8853803](https://github.com/vm0-ai/vm0/commit/8853803e8fa8f6f1bc7dc868972d1fa07f31a5a0))

## [12.188.3](https://github.com/vm0-ai/vm0/compare/web-v12.188.2...web-v12.188.3) (2026-04-02)


### Refactoring

* move org to lib/zero/ ([#7759](https://github.com/vm0-ai/vm0/issues/7759)) ([6977ece](https://github.com/vm0-ai/vm0/commit/6977eced816aa453abda1e4d47a4a77bc23fcdec))
* move org-membership-cache to auth layer ([#7794](https://github.com/vm0-ai/vm0/issues/7794)) ([5537297](https://github.com/vm0-ai/vm0/commit/5537297117a1556ba000256479951151068079cd)), closes [#7790](https://github.com/vm0-ai/vm0/issues/7790)
* move runner group check from zero/org to infra/run ([#7795](https://github.com/vm0-ai/vm0/issues/7795)) ([be28f1f](https://github.com/vm0-ai/vm0/commit/be28f1fef8a835aac7230d1eed16e202595ed27a)), closes [#7789](https://github.com/vm0-ai/vm0/issues/7789)
* split org-cache-service into auth and metadata modules ([#7796](https://github.com/vm0-ai/vm0/issues/7796)) ([bfebfb9](https://github.com/vm0-ai/vm0/commit/bfebfb905e648987beeb046d7219fe2b5682ddf5)), closes [#7791](https://github.com/vm0-ai/vm0/issues/7791)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.146.0

## [12.188.2](https://github.com/vm0-ai/vm0/compare/web-v12.188.1...web-v12.188.2) (2026-04-02)


### Refactoring

* move email to lib/zero/ ([#7761](https://github.com/vm0-ai/vm0/issues/7761)) ([6de25ec](https://github.com/vm0-ai/vm0/commit/6de25ecd5e74200645187e9f96cd41599b3ef0a5)), closes [#7737](https://github.com/vm0-ai/vm0/issues/7737)
* move slack and slack-org to lib/zero/ ([#7760](https://github.com/vm0-ai/vm0/issues/7760)) ([8596c28](https://github.com/vm0-ai/vm0/commit/8596c28278f53ad3c424ea5e65cb29051129e776)), closes [#7734](https://github.com/vm0-ai/vm0/issues/7734)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.145.0

## [12.188.1](https://github.com/vm0-ai/vm0/compare/web-v12.188.0...web-v12.188.1) (2026-04-02)


### Refactoring

* move connector module to lib/zero/connector/ ([#7765](https://github.com/vm0-ai/vm0/issues/7765)) ([f8b1190](https://github.com/vm0-ai/vm0/commit/f8b1190271caabcaa41696081bc5407dd381149a)), closes [#7739](https://github.com/vm0-ai/vm0/issues/7739)
* move small infra modules to lib/infra/ ([#7720](https://github.com/vm0-ai/vm0/issues/7720)) ([#7746](https://github.com/vm0-ai/vm0/issues/7746)) ([18891c3](https://github.com/vm0-ai/vm0/commit/18891c32d4818ec516112266a965df68cba4c2f9))

## [12.188.0](https://github.com/vm0-ai/vm0/compare/web-v12.187.0...web-v12.188.0) (2026-04-02)


### Features

* **cli:** add --since filter to zero logs list command ([#7710](https://github.com/vm0-ai/vm0/issues/7710)) ([696968e](https://github.com/vm0-ai/vm0/commit/696968e730ccb91cfa2ea3d9d25874c91d35e989)), closes [#7707](https://github.com/vm0-ai/vm0/issues/7707)


### Refactoring

* migrate resolve-org from clerk api to db-only org metadata ([#7711](https://github.com/vm0-ai/vm0/issues/7711)) ([b17c7ad](https://github.com/vm0-ai/vm0/commit/b17c7adcab6cafe2e673cd58947278ca82f627cb))
* move agent-compose to lib/infra/ ([#7755](https://github.com/vm0-ai/vm0/issues/7755)) ([a620c09](https://github.com/vm0-ai/vm0/commit/a620c09e8438ab406a1495cb7a8e8b3cf009e29f)), closes [#7721](https://github.com/vm0-ai/vm0/issues/7721)
* move billing and credit to lib/zero/ ([#7749](https://github.com/vm0-ai/vm0/issues/7749)) ([378d801](https://github.com/vm0-ai/vm0/commit/378d80136c50fa77af6231308862ffb9d670936a)), closes [#7730](https://github.com/vm0-ai/vm0/issues/7730)
* move chat-thread to lib/zero/ ([#7748](https://github.com/vm0-ai/vm0/issues/7748)) ([6c31dcb](https://github.com/vm0-ai/vm0/commit/6c31dcb9cb61fb5befc5cf58460b508d25c2c9bb)), closes [#7729](https://github.com/vm0-ai/vm0/issues/7729)
* move run to lib/infra/ ([#7747](https://github.com/vm0-ai/vm0/issues/7747)) ([df8da3c](https://github.com/vm0-ai/vm0/commit/df8da3c753843614cd96025180f2a9370b914dfd)), closes [#7726](https://github.com/vm0-ai/vm0/issues/7726)
* move skills to lib/zero/ ([#7750](https://github.com/vm0-ai/vm0/issues/7750)) ([e895d08](https://github.com/vm0-ai/vm0/commit/e895d084d8d3304afec970315662fc6672fd2072)), closes [#7731](https://github.com/vm0-ai/vm0/issues/7731)
* move small zero modules to lib/zero/ ([#7751](https://github.com/vm0-ai/vm0/issues/7751)) ([c451e93](https://github.com/vm0-ai/vm0/commit/c451e93dfdd1b9b3cb47749a7879feb474c5c35f)), closes [#7728](https://github.com/vm0-ai/vm0/issues/7728)
* move storage to lib/infra/ ([#7742](https://github.com/vm0-ai/vm0/issues/7742)) ([7fb157d](https://github.com/vm0-ai/vm0/commit/7fb157d0b223532c166ce1eaa62d24b0d60460f4)), closes [#7725](https://github.com/vm0-ai/vm0/issues/7725)
* move user module to lib/zero/user/ ([#7743](https://github.com/vm0-ai/vm0/issues/7743)) ([3c0c0cf](https://github.com/vm0-ai/vm0/commit/3c0c0cfb2322912c362b8274ee85a812595dce67)), closes [#7732](https://github.com/vm0-ai/vm0/issues/7732)
* move utility modules to lib/shared/ ([#7745](https://github.com/vm0-ai/vm0/issues/7745)) ([943dfb2](https://github.com/vm0-ai/vm0/commit/943dfb29d61fd35e199b7e2370e7ffc34b157a26)), closes [#7727](https://github.com/vm0-ai/vm0/issues/7727)
* **web:** remove defensive try-catch block in execute-schedules cron ([#7662](https://github.com/vm0-ai/vm0/issues/7662)) ([464e549](https://github.com/vm0-ai/vm0/commit/464e54964c451b72ae1dde1e3c870ae72f94c112))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.144.0

## [12.187.0](https://github.com/vm0-ai/vm0/compare/web-v12.186.2...web-v12.187.0) (2026-04-02)


### Features

* add csv upload inspect route for activity log viewer ([#7630](https://github.com/vm0-ai/vm0/issues/7630)) ([91659d0](https://github.com/vm0-ai/vm0/commit/91659d077cb2a35b560290c91cc78dbd5872a5ac))


### Refactoring

* add get-org-metadata and remove clerk api from run creation ([#7703](https://github.com/vm0-ai/vm0/issues/7703)) ([eede35e](https://github.com/vm0-ai/vm0/commit/eede35ef6d31f2acd35d3377a022659c9f33e219)), closes [#7698](https://github.com/vm0-ai/vm0/issues/7698)
* migrate eslint rules to native oxlint config ([#7690](https://github.com/vm0-ai/vm0/issues/7690)) ([aef6426](https://github.com/vm0-ai/vm0/commit/aef6426bd9ace376e22e16fa56843500d643fc86))


### Performance Improvements

* skip redundant db query in zero run creation path ([#7704](https://github.com/vm0-ai/vm0/issues/7704)) ([d322be1](https://github.com/vm0-ai/vm0/commit/d322be11d04090b4b1998119aa9ba7c598c0e362)), closes [#7699](https://github.com/vm0-ai/vm0/issues/7699)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.143.0

## [12.186.2](https://github.com/vm0-ai/vm0/compare/web-v12.186.1...web-v12.186.2) (2026-04-02)


### Refactoring

* create zero-session-service and extract zero session ops from agent-session-service ([#7684](https://github.com/vm0-ai/vm0/issues/7684)) ([3325a5d](https://github.com/vm0-ai/vm0/commit/3325a5d6dcb9af220bbbe79801b1dc749c0a4ae2)), closes [#7679](https://github.com/vm0-ai/vm0/issues/7679)

## [12.186.1](https://github.com/vm0-ai/vm0/compare/web-v12.186.0...web-v12.186.1) (2026-04-02)


### Refactoring

* extract zero-agents ops into zero-compose-service ([#7682](https://github.com/vm0-ai/vm0/issues/7682)) ([6e34500](https://github.com/vm0-ai/vm0/commit/6e345001fc18094f95065dae81abce74693bdc8d)), closes [#7678](https://github.com/vm0-ai/vm0/issues/7678)


### Performance Improvements

* **web:** defer dispatch pipeline in chat messages route via after() ([#7677](https://github.com/vm0-ai/vm0/issues/7677)) ([de5cbbd](https://github.com/vm0-ai/vm0/commit/de5cbbdd7e3a34985bd394db0c2f4fd7e86ddadf))

## [12.186.0](https://github.com/vm0-ai/vm0/compare/web-v12.185.0...web-v12.186.0) (2026-04-02)


### Features

* add auth.base url rewriting for webhook-url firewall connectors ([#7618](https://github.com/vm0-ai/vm0/issues/7618)) ([55585ac](https://github.com/vm0-ai/vm0/commit/55585ac37db6938508ca957f83725389157c55da))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.142.0

## [12.185.0](https://github.com/vm0-ai/vm0/compare/web-v12.184.2...web-v12.185.0) (2026-04-02)


### Features

* enable zero token auth for org endpoint ([#7658](https://github.com/vm0-ai/vm0/issues/7658)) ([d645589](https://github.com/vm0-ai/vm0/commit/d6455890c723be3d3bd652b8c80ea178367b2b6e))


### Refactoring

* move run-queue-service into zero layer as zero-run-queue-service ([#7657](https://github.com/vm0-ai/vm0/issues/7657)) ([4899f50](https://github.com/vm0-ai/vm0/commit/4899f507d90831c873ab7e70d978973e2b62607e)), closes [#7654](https://github.com/vm0-ai/vm0/issues/7654)

## [12.184.2](https://github.com/vm0-ai/vm0/compare/web-v12.184.1...web-v12.184.2) (2026-04-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.141.0

## [12.184.1](https://github.com/vm0-ai/vm0/compare/web-v12.184.0...web-v12.184.1) (2026-04-02)


### Refactoring

* extract log search service and update logs contracts ([#7641](https://github.com/vm0-ai/vm0/issues/7641)) ([c3faede](https://github.com/vm0-ai/vm0/commit/c3faede7963676b32d0f0a28596991e5830352e6)), closes [#7634](https://github.com/vm0-ai/vm0/issues/7634)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.140.1

## [12.184.0](https://github.com/vm0-ai/vm0/compare/web-v12.183.3...web-v12.184.0) (2026-04-02)


### Features

* unify agent permission model with admin-or-owner guard ([#7586](https://github.com/vm0-ai/vm0/issues/7586)) ([e0d6247](https://github.com/vm0-ai/vm0/commit/e0d6247f9d427eacfe616ec2c8e6e2cd33f873e9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.140.0

## [12.183.3](https://github.com/vm0-ai/vm0/compare/web-v12.183.2...web-v12.183.3) (2026-04-02)


### Bug Fixes

* clean up stale org slug references in docs and tests ([#7623](https://github.com/vm0-ai/vm0/issues/7623)) ([7c98abb](https://github.com/vm0-ai/vm0/commit/7c98abb680a9da5e83842f85159379005326eb63))


### Refactoring

* move org tier resolution and credit processing out of infra layer ([#7610](https://github.com/vm0-ai/vm0/issues/7610)) ([9d5e0d1](https://github.com/vm0-ai/vm0/commit/9d5e0d177e2b111f22ae403fd941071a7ff4cba3))
* remove org-slug parsing from default agent resolution ([#7596](https://github.com/vm0-ai/vm0/issues/7596)) ([4408295](https://github.com/vm0-ai/vm0/commit/4408295b88dc8d0f5818c2917a47d45679bd4f53)), closes [#7592](https://github.com/vm0-ai/vm0/issues/7592)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.139.0

## [12.183.2](https://github.com/vm0-ai/vm0/compare/web-v12.183.1...web-v12.183.2) (2026-04-02)


### Refactoring

* decouple infra run path from zero layer ([#7597](https://github.com/vm0-ai/vm0/issues/7597)) ([787738e](https://github.com/vm0-ai/vm0/commit/787738ea295d9ba8256994725afef7d4a0d941e3))
* delete queued-run infra dispatcher and remove zero imports ([#7607](https://github.com/vm0-ai/vm0/issues/7607)) ([8dcbdce](https://github.com/vm0-ai/vm0/commit/8dcbdce8e3633fae3e5d9d7e07b14edfa363aacd)), closes [#7590](https://github.com/vm0-ai/vm0/issues/7590)
* remove use-zero-context flag, move cli resolution to route layer ([#7608](https://github.com/vm0-ai/vm0/issues/7608)) ([dfeb41a](https://github.com/vm0-ai/vm0/commit/dfeb41a980d9905070d7fc8da83b17f134f936e8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.138.0

## [12.183.1](https://github.com/vm0-ai/vm0/compare/web-v12.183.0...web-v12.183.1) (2026-04-01)


### Refactoring

* move model provider resolution from infra to zero layer ([#7594](https://github.com/vm0-ai/vm0/issues/7594)) ([c0137b8](https://github.com/vm0-ai/vm0/commit/c0137b80238161c7504199aac4e5c400b390175b)), closes [#7591](https://github.com/vm0-ai/vm0/issues/7591)
* remove redundant ?org= query param from firewall-access-requests and skills routes ([#7587](https://github.com/vm0-ai/vm0/issues/7587)) ([d2a61d2](https://github.com/vm0-ai/vm0/commit/d2a61d220db70779941fede8e1258dbc5e083405)), closes [#7585](https://github.com/vm0-ai/vm0/issues/7585)

## [12.183.0](https://github.com/vm0-ai/vm0/compare/web-v12.182.0...web-v12.183.0) (2026-04-01)


### Features

* **org:** add role selection to member invite flow ([#7555](https://github.com/vm0-ai/vm0/issues/7555)) ([891fc35](https://github.com/vm0-ai/vm0/commit/891fc35eaeba4c73c741accc5bc810df46d17962))
* support full directory upload for custom skills ([#7550](https://github.com/vm0-ai/vm0/issues/7550)) ([044ee9e](https://github.com/vm0-ai/vm0/commit/044ee9e928c9921f7f618d74a20a5453e37e4e3a))
* **web:** comprehensive seo improvements ([#7536](https://github.com/vm0-ai/vm0/issues/7536)) ([657a25c](https://github.com/vm0-ai/vm0/commit/657a25ce9be6b3c3415def9298d7d80377efb418))


### Bug Fixes

* **web:** replace 'join the beta' cta with 'get started' ([#7535](https://github.com/vm0-ai/vm0/issues/7535)) ([7eadd82](https://github.com/vm0-ai/vm0/commit/7eadd822ecbe99e6b6e68c35497975f33770f121))


### Refactoring

* remove --model-provider and --check-env from vm0 run commands ([#7543](https://github.com/vm0-ai/vm0/issues/7543)) ([34c7233](https://github.com/vm0-ai/vm0/commit/34c7233e3ce75252f73ac8972b5a1bf130ccab5b))
* rename experimental firewalls to firewalls ([#7553](https://github.com/vm0-ai/vm0/issues/7553)) ([e3c35a9](https://github.com/vm0-ai/vm0/commit/e3c35a95bd0dbfd1d68aef910db6089e38d6a0bb))
* replace org_slug with org_id in device codes and auth responses ([#7475](https://github.com/vm0-ai/vm0/issues/7475)) ([#7559](https://github.com/vm0-ai/vm0/issues/7559)) ([03719b9](https://github.com/vm0-ai/vm0/commit/03719b93a72b6c3f71fec18e2bd9e6af6a3068cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.137.0

## [12.182.0](https://github.com/vm0-ai/vm0/compare/web-v12.181.0...web-v12.182.0) (2026-04-01)


### Features

* **cli:** add slack upload-file command ([#7504](https://github.com/vm0-ai/vm0/issues/7504)) ([abc90d8](https://github.com/vm0-ai/vm0/commit/abc90d82a61c399acb2ba4bc7ca59dcca0de6ebc))
* **web:** improve landing page dark mode and mobile layout ([#7515](https://github.com/vm0-ai/vm0/issues/7515)) ([9cccece](https://github.com/vm0-ai/vm0/commit/9cccece970e7a03cdc1bdc94e7a501f5489cb0da))


### Bug Fixes

* remove append-system-prompt option from zero run commands ([#7532](https://github.com/vm0-ai/vm0/issues/7532)) ([907d6d6](https://github.com/vm0-ai/vm0/commit/907d6d6d1175988f90e3be96fad5431426592e1e)), closes [#7530](https://github.com/vm0-ai/vm0/issues/7530)
* **slack:** append schedule context to cli message footer ([#7526](https://github.com/vm0-ai/vm0/issues/7526)) ([cfab440](https://github.com/vm0-ai/vm0/commit/cfab440591627dd2ad124668d3cc6ee1c7c6e9fe)), closes [#7513](https://github.com/vm0-ai/vm0/issues/7513)


### Refactoring

* remove schedule notification system ([#7509](https://github.com/vm0-ai/vm0/issues/7509)) ([85ece06](https://github.com/vm0-ai/vm0/commit/85ece067e994b4d48dab3d3b2e47b8fc19951455))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.136.0

## [12.181.0](https://github.com/vm0-ai/vm0/compare/web-v12.180.0...web-v12.181.0) (2026-04-01)


### Features

* add backfill migration for vm0 managed model provider ([#7497](https://github.com/vm0-ai/vm0/issues/7497)) ([1e9f3ed](https://github.com/vm0-ai/vm0/commit/1e9f3edaefd8a3350cc0c9dc55c85da77b0ef990))


### Bug Fixes

* **web:** treat firewalls without permissions as unrestricted ([#7516](https://github.com/vm0-ai/vm0/issues/7516)) ([c2b9bba](https://github.com/vm0-ai/vm0/commit/c2b9bba2ab376978c47c66ae5a5e2e9c4d8420a2))


### Refactoring

* remove queue-dispatcher param from build-and-dispatch pipeline ([#7499](https://github.com/vm0-ai/vm0/issues/7499)) ([2d7d36c](https://github.com/vm0-ai/vm0/commit/2d7d36c482d717bb2f93044799a21e799e34fd91)), closes [#7490](https://github.com/vm0-ai/vm0/issues/7490)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.135.0

## [12.180.0](https://github.com/vm0-ai/vm0/compare/web-v12.179.0...web-v12.180.0) (2026-04-01)


### Features

* **firewalls:** add basic auth template support and streak firewall config ([#7480](https://github.com/vm0-ai/vm0/issues/7480)) ([d234372](https://github.com/vm0-ai/vm0/commit/d234372fc4ccd30cb298b0770e4256cd8a0cd989))


### Bug Fixes

* **platform:** preserve chronological order of cancelled chat messages ([#7494](https://github.com/vm0-ai/vm0/issues/7494)) ([1130617](https://github.com/vm0-ai/vm0/commit/11306178ef777823b3ec7c79ed7afa005be616f1))
* **web:** include feature-flagged connectors with api-token in compose ([#7481](https://github.com/vm0-ai/vm0/issues/7481)) ([130b1d3](https://github.com/vm0-ai/vm0/commit/130b1d36b807925c67680f00b9ad02cea39285eb))


### Refactoring

* migrate connector oauth routes to zero namespace ([#7473](https://github.com/vm0-ai/vm0/issues/7473)) ([eae5501](https://github.com/vm0-ai/vm0/commit/eae55012401322f975897a68097cab008a78b650))
* move org id into execution context and remove from dispatch opts ([#7489](https://github.com/vm0-ai/vm0/issues/7489)) ([4b0622a](https://github.com/vm0-ai/vm0/commit/4b0622a1a0bf94adb923276e1e6cb77e96ac04c4)), closes [#7487](https://github.com/vm0-ai/vm0/issues/7487)
* remove unused batch org data function ([#7492](https://github.com/vm0-ai/vm0/issues/7492)) ([#7495](https://github.com/vm0-ai/vm0/issues/7495)) ([a6c207f](https://github.com/vm0-ai/vm0/commit/a6c207f11c05081d2fe0f189a7e068e133879f94))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.134.0

## [12.179.0](https://github.com/vm0-ai/vm0/compare/web-v12.178.0...web-v12.179.0) (2026-04-01)


### Features

* **platform:** add network logs page to activity detail ([#7461](https://github.com/vm0-ai/vm0/issues/7461)) ([c321d03](https://github.com/vm0-ai/vm0/commit/c321d038744fd4034a63f77d8f0c0631a06361aa))


### Bug Fixes

* preserve custom skill volumes in instructions update ([#7471](https://github.com/vm0-ai/vm0/issues/7471)) ([2516fba](https://github.com/vm0-ai/vm0/commit/2516fbae39c1618d99da6472981d88ffe063af21)), closes [#7467](https://github.com/vm0-ai/vm0/issues/7467)
* **web:** keep connector firewall entry when all permissions are denied ([#7465](https://github.com/vm0-ai/vm0/issues/7465)) ([e21bb41](https://github.com/vm0-ai/vm0/commit/e21bb417c8050705a418b44ff90df9c3d79c8b79))


### Refactoring

* consolidate timing parameters in build-and-dispatch-run ([#7447](https://github.com/vm0-ai/vm0/issues/7447)) ([b1b3465](https://github.com/vm0-ai/vm0/commit/b1b34654dc706d1e6856f5d17a1e6fe03c6b5caf))
* migrate model_provider and selected_model from agent_runs to zero_runs ([#7450](https://github.com/vm0-ai/vm0/issues/7450)) ([391a281](https://github.com/vm0-ai/vm0/commit/391a2813f974dba3e11917c78fea31258bf68357))
* remove org slug from billing service stripe metadata ([#7482](https://github.com/vm0-ai/vm0/issues/7482)) ([b289a5b](https://github.com/vm0-ai/vm0/commit/b289a5b439c86ad5c312699e11c6043095986491)), closes [#7477](https://github.com/vm0-ai/vm0/issues/7477)
* remove org slug from logs api response and related types ([#7457](https://github.com/vm0-ai/vm0/issues/7457)) ([79f4591](https://github.com/vm0-ai/vm0/commit/79f45915dca93e17eb345ee41d309dde2fb5872b))
* remove org slug from schedule response and contract ([#7436](https://github.com/vm0-ai/vm0/issues/7436)) ([#7456](https://github.com/vm0-ai/vm0/issues/7456)) ([7001594](https://github.com/vm0-ai/vm0/commit/7001594afafabf8e715aa57edc53094a854e03c1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.133.0

## [12.178.0](https://github.com/vm0-ai/vm0/compare/web-v12.177.5...web-v12.178.0) (2026-04-01)


### Features

* add sent-via footer to slack messages from cli and agent runs ([#7442](https://github.com/vm0-ai/vm0/issues/7442)) ([c07e658](https://github.com/vm0-ai/vm0/commit/c07e6583fcca08ad7d4d78fb34ae884348a1f27d))
* **firewalls:** support vars templates in firewall auth headers ([#7445](https://github.com/vm0-ai/vm0/issues/7445)) ([c06b9a0](https://github.com/vm0-ai/vm0/commit/c06b9a027bf1ae757b2f09393fee658d891bcf5f))


### Documentation

* add skill references to cli help text and agent tools prompt ([#7448](https://github.com/vm0-ai/vm0/issues/7448)) ([1e54353](https://github.com/vm0-ai/vm0/commit/1e54353ed6ffc6bdfed00057f6a6570e687f5709))


### Refactoring

* remove dead params and runtime org from dispatch pipeline ([#7434](https://github.com/vm0-ai/vm0/issues/7434)) ([0443526](https://github.com/vm0-ai/vm0/commit/044352642dc33e3b280af5398ce5f837abef57e7)), closes [#7427](https://github.com/vm0-ai/vm0/issues/7427)

## [12.177.5](https://github.com/vm0-ai/vm0/compare/web-v12.177.4...web-v12.177.5) (2026-04-01)


### Refactoring

* **web:** rename oauth connector result field for clarity ([#7431](https://github.com/vm0-ai/vm0/issues/7431)) ([ce34cec](https://github.com/vm0-ai/vm0/commit/ce34ceca9ae481fb9e1adfaf9c8fa739ad6e69ce))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.132.1

## [12.177.4](https://github.com/vm0-ai/vm0/compare/web-v12.177.3...web-v12.177.4) (2026-03-31)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.132.0

## [12.177.3](https://github.com/vm0-ai/vm0/compare/web-v12.177.2...web-v12.177.3) (2026-03-31)


### Bug Fixes

* **web:** exclude raw oauth connector secrets from build context ([#7417](https://github.com/vm0-ai/vm0/issues/7417)) ([f72b5b5](https://github.com/vm0-ai/vm0/commit/f72b5b5ad76f92e75dec83fa0ed9ca6ca38ff9b6)), closes [#7365](https://github.com/vm0-ai/vm0/issues/7365)

## [12.177.2](https://github.com/vm0-ai/vm0/compare/web-v12.177.1...web-v12.177.2) (2026-03-31)


### Refactoring

* remove redundant preview field from chat thread list items ([#7418](https://github.com/vm0-ai/vm0/issues/7418)) ([1b3bbee](https://github.com/vm0-ai/vm0/commit/1b3bbeec9aa0d7ff8ae18d446f63e4966108ee9e))
* **run:** move build-execution-context and business logic from infra to zero layer ([#7408](https://github.com/vm0-ai/vm0/issues/7408)) ([5bf0335](https://github.com/vm0-ai/vm0/commit/5bf033540a9db1bf10eb95ec831487cfffe6141d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.131.2

## [12.177.1](https://github.com/vm0-ai/vm0/compare/web-v12.177.0...web-v12.177.1) (2026-03-31)


### Refactoring

* remove redundant ?org=slug query param from all routes ([#7301](https://github.com/vm0-ai/vm0/issues/7301)) ([96d6b6c](https://github.com/vm0-ai/vm0/commit/96d6b6ced9bb5770bce51301ceabea226bcc22f4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.131.1

## [12.177.0](https://github.com/vm0-ai/vm0/compare/web-v12.176.0...web-v12.177.0) (2026-03-31)


### Features

* add chat thread deletion ([#7372](https://github.com/vm0-ai/vm0/issues/7372)) ([c3f8932](https://github.com/vm0-ai/vm0/commit/c3f8932847f40a3de1c5f4279b225e10fe64a73a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.131.0

## [12.176.0](https://github.com/vm0-ai/vm0/compare/web-v12.175.0...web-v12.176.0) (2026-03-31)


### Features

* add system prompt context for firewall deny doctor ([#7382](https://github.com/vm0-ai/vm0/issues/7382)) ([30d8d0c](https://github.com/vm0-ai/vm0/commit/30d8d0cf3ea1da0ff703c0a2771c267000c8ac35)), closes [#7317](https://github.com/vm0-ai/vm0/issues/7317)


### Bug Fixes

* **firewalls:** replace placeholder tokens with realistic fill pattern ([#7332](https://github.com/vm0-ai/vm0/issues/7332)) ([237916e](https://github.com/vm0-ai/vm0/commit/237916e4d424b924ed8ac603d20da4813b969b40))


### Refactoring

* move chat title generation from webhook completion to message creation ([#7357](https://github.com/vm0-ai/vm0/issues/7357)) ([915b066](https://github.com/vm0-ai/vm0/commit/915b0662ebaa2fb22362799f5fb68b2fdf876ac8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.130.2

## [12.175.0](https://github.com/vm0-ai/vm0/compare/web-v12.174.0...web-v12.175.0) (2026-03-31)


### Features

* support zero-token auth with agent:read on connector GET endpoint ([#7359](https://github.com/vm0-ai/vm0/issues/7359)) ([2c4abce](https://github.com/vm0-ai/vm0/commit/2c4abced0e05f8eb67c423569a0cbf138ff9c733))


### Bug Fixes

* add zero skills schema to db exports ([#7367](https://github.com/vm0-ai/vm0/issues/7367)) ([045ebcb](https://github.com/vm0-ai/vm0/commit/045ebcba4054c6c16586e58d4d7ee5c9396a05b3))


### Refactoring

* **core:** unify connector environment mapping to single top-level field ([#7349](https://github.com/vm0-ai/vm0/issues/7349)) ([2f82753](https://github.com/vm0-ai/vm0/commit/2f82753fae318b2cf166d323eff8d656c49fcb4e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.130.1

## [12.174.0](https://github.com/vm0-ai/vm0/compare/web-v12.173.0...web-v12.174.0) (2026-03-31)


### Features

* add custom skills binding to agent create and edit flow ([#7324](https://github.com/vm0-ai/vm0/issues/7324)) ([b3882df](https://github.com/vm0-ai/vm0/commit/b3882dfeea8a48fb1dea669f889207aa8bf32fa6))
* add firewall_access_requests database table ([#7321](https://github.com/vm0-ai/vm0/issues/7321)) ([a455ff1](https://github.com/vm0-ai/vm0/commit/a455ff15e175af343f65c40ea86445806f04a2a6))
* add run execution context page for debugging ([#7325](https://github.com/vm0-ai/vm0/issues/7325)) ([e3e56e8](https://github.com/vm0-ai/vm0/commit/e3e56e8dfd685badc10fcbdd144f952afe74fca4))
* add selected model tooltip to activity log detail ([#7319](https://github.com/vm0-ai/vm0/issues/7319)) ([4ec0f43](https://github.com/vm0-ai/vm0/commit/4ec0f43759c01bf8a41c3225189192698d031d31))
* show parent agent display name for delegated runs in activity log ([#7184](https://github.com/vm0-ai/vm0/issues/7184)) ([100ce19](https://github.com/vm0-ai/vm0/commit/100ce19543169be0a1a420217d26fcff67f97a38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.130.0

## [12.173.0](https://github.com/vm0-ai/vm0/compare/web-v12.172.0...web-v12.173.0) (2026-03-31)


### Features

* **connectors:** introduce per-user connector permission system ([#7174](https://github.com/vm0-ai/vm0/issues/7174)) ([121f1c7](https://github.com/vm0-ai/vm0/commit/121f1c7012fe37277597d40062e808265f022eec))


### Bug Fixes

* **web:** clarify agent traffic scope in pricing page copy ([#7289](https://github.com/vm0-ai/vm0/issues/7289)) ([60d103a](https://github.com/vm0-ai/vm0/commit/60d103abb76a7e7149cd6667ab6afc0e5daa7e58)), closes [#6886](https://github.com/vm0-ai/vm0/issues/6886)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.129.0

## [12.172.0](https://github.com/vm0-ai/vm0/compare/web-v12.171.0...web-v12.172.0) (2026-03-31)


### Features

* add custom skills crud api for zero agents ([#7295](https://github.com/vm0-ai/vm0/issues/7295)) ([48ed8fe](https://github.com/vm0-ai/vm0/commit/48ed8fe7c66214c12fd6979de5a99958c6c02909))
* add custom skills foundation for zero agents ([#7198](https://github.com/vm0-ai/vm0/issues/7198)) ([b9985bc](https://github.com/vm0-ai/vm0/commit/b9985bc5e1f689d8888c95e4ead33418a4018478))


### Bug Fixes

* **firewalls:** read current token from db for skipped connectors in auth endpoint ([#7291](https://github.com/vm0-ai/vm0/issues/7291)) ([3113be3](https://github.com/vm0-ai/vm0/commit/3113be3570fb214055f372bf37112e1f17a12ce0))
* remove /settings command from telegram bot slash menu ([#7259](https://github.com/vm0-ai/vm0/issues/7259)) ([c1ce754](https://github.com/vm0-ai/vm0/commit/c1ce75436a02a469f43fa31e6d73754a3f512d9a))
* unify schedule notification defaults to false (opt-in) ([#7277](https://github.com/vm0-ai/vm0/issues/7277)) ([e9ff75a](https://github.com/vm0-ai/vm0/commit/e9ff75aedd63c7c652d02cf95ab96d421fab8f4e)), closes [#7273](https://github.com/vm0-ai/vm0/issues/7273)


### Refactoring

* **e2e:** replace fixed test accounts with ephemeral per-job-ref accounts ([#7250](https://github.com/vm0-ai/vm0/issues/7250)) ([d2b6f20](https://github.com/vm0-ai/vm0/commit/d2b6f20b33812a7cdada8a84d2063b048d98f920))
* remove dead artifact name fields from schedule system ([#7281](https://github.com/vm0-ai/vm0/issues/7281)) ([9c366b7](https://github.com/vm0-ai/vm0/commit/9c366b7bb82214fa5ede25bda026c6916d5b010b))
* remove dead orgslug from run execution pipeline ([#7294](https://github.com/vm0-ai/vm0/issues/7294)) ([6dc9d6f](https://github.com/vm0-ai/vm0/commit/6dc9d6fa464eb66f7fe75f642436772a0bba8a92)), closes [#7286](https://github.com/vm0-ai/vm0/issues/7286)
* remove inject-zero-token flag from infra layer ([#7288](https://github.com/vm0-ai/vm0/issues/7288)) ([9015b02](https://github.com/vm0-ai/vm0/commit/9015b0213f6d22817674d3301b9b9d5e1d981741))
* remove unused chat-threads runs endpoint ([#7263](https://github.com/vm0-ai/vm0/issues/7263)) ([15850f2](https://github.com/vm0-ai/vm0/commit/15850f27e2d2219a7f89041d0702ba2a08009871)), closes [#7258](https://github.com/vm0-ai/vm0/issues/7258)
* split run creation into composable record and dispatch phases ([#7168](https://github.com/vm0-ai/vm0/issues/7168)) ([022a53e](https://github.com/vm0-ai/vm0/commit/022a53eb28f2a809a3f997fd0bc529c314438df5)), closes [#7164](https://github.com/vm0-ai/vm0/issues/7164)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.128.0

## [12.171.0](https://github.com/vm0-ai/vm0/compare/web-v12.170.1...web-v12.171.0) (2026-03-30)


### Features

* **cli:** add --firewall-policies flag to run commands ([#7223](https://github.com/vm0-ai/vm0/issues/7223)) ([f1d7c95](https://github.com/vm0-ai/vm0/commit/f1d7c953f62dd1676d535fd2a7a01e0bb7b55a06))


### Performance Improvements

* **axiom:** merge duplicate queries and consolidate logger client ([#7237](https://github.com/vm0-ai/vm0/issues/7237)) ([22998a4](https://github.com/vm0-ai/vm0/commit/22998a403db8e38231a366f1ced9fc9126b25889))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.127.0

## [12.170.1](https://github.com/vm0-ai/vm0/compare/web-v12.170.0...web-v12.170.1) (2026-03-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.126.0

## [12.170.0](https://github.com/vm0-ai/vm0/compare/web-v12.169.0...web-v12.170.0) (2026-03-30)


### Features

* add unified chat messages endpoint ([#7222](https://github.com/vm0-ai/vm0/issues/7222)) ([1a7bb9e](https://github.com/vm0-ai/vm0/commit/1a7bb9ee48d52b416924083e32c1af6230e24bd3))


### Bug Fixes

* **axiom:** batch ingestion and add query retry to avoid org rate limit ([#7228](https://github.com/vm0-ai/vm0/issues/7228)) ([d7bc284](https://github.com/vm0-ai/vm0/commit/d7bc284a5c6defaead0e4675b4e679a25369fcfe)), closes [#7219](https://github.com/vm0-ai/vm0/issues/7219)
* use org id instead of slug for s3 storage path prefix ([#7186](https://github.com/vm0-ai/vm0/issues/7186)) ([279be0e](https://github.com/vm0-ai/vm0/commit/279be0e184a789a238294ac95301d884ee1e0904))


### Refactoring

* remove user-defined runner groups and enforce vm0/ prefix ([#7207](https://github.com/vm0-ai/vm0/issues/7207)) ([233b5fd](https://github.com/vm0-ai/vm0/commit/233b5fd5f9e4c0a2606585ce548f3b2ba3c2e592)), closes [#7202](https://github.com/vm0-ai/vm0/issues/7202)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.125.0

## [12.169.0](https://github.com/vm0-ai/vm0/compare/web-v12.168.0...web-v12.169.0) (2026-03-30)


### Features

* **core:** add default firewall permission policies for connectors ([#7170](https://github.com/vm0-ai/vm0/issues/7170)) ([97beaa1](https://github.com/vm0-ai/vm0/commit/97beaa162835d25243a8535df8b76a4bc6992da4))


### Refactoring

* extract zero-runs writes from infra layer to zero platform layer ([#7162](https://github.com/vm0-ai/vm0/issues/7162)) ([9b62ba9](https://github.com/vm0-ai/vm0/commit/9b62ba9277d8441c163f8c61163a55eb881b6095)), closes [#7154](https://github.com/vm0-ai/vm0/issues/7154)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.124.0

## [12.168.0](https://github.com/vm0-ai/vm0/compare/web-v12.167.2...web-v12.168.0) (2026-03-30)


### Features

* **slack:** prompt admin to reinstall when oauth bot scopes change ([#7057](https://github.com/vm0-ai/vm0/issues/7057)) ([34a1045](https://github.com/vm0-ai/vm0/commit/34a104570cf0b6e75be7917dc558b6ce6ab81589))
* support dynamic base url in firewall configs for subdomain-based connectors ([#7148](https://github.com/vm0-ai/vm0/issues/7148)) ([d14d38d](https://github.com/vm0-ai/vm0/commit/d14d38d57f5d2ed4f68945f67970ca0363b40c02))


### Bug Fixes

* **platform:** add missing org management clerk features ([#7054](https://github.com/vm0-ai/vm0/issues/7054)) ([0c84dfb](https://github.com/vm0-ai/vm0/commit/0c84dfb78a5e21357616ef19e9a352a4fb0b3884))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.123.0

## [12.167.2](https://github.com/vm0-ai/vm0/compare/web-v12.167.1...web-v12.167.2) (2026-03-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.122.0

## [12.167.1](https://github.com/vm0-ai/vm0/compare/web-v12.167.0...web-v12.167.1) (2026-03-29)


### Documentation

* **cli:** add after-help examples and notes to all zero commands ([#7079](https://github.com/vm0-ai/vm0/issues/7079)) ([e4e756f](https://github.com/vm0-ai/vm0/commit/e4e756f8c4b96b9cb508878ee64a52c8dca9a5c5))


### Refactoring

* **web:** split oauth and api-token connector resolution ([#7083](https://github.com/vm0-ai/vm0/issues/7083)) ([d6aeb16](https://github.com/vm0-ai/vm0/commit/d6aeb16dcbea50d4e8e000b25a74897c8d55d32b))

## [12.167.0](https://github.com/vm0-ai/vm0/compare/web-v12.166.0...web-v12.167.0) (2026-03-27)


### Features

* add credit expiry records with first-expiring-first-out deduction ([#7049](https://github.com/vm0-ai/vm0/issues/7049)) ([f9bbfb1](https://github.com/vm0-ai/vm0/commit/f9bbfb170c42867c2aa64573ccf7f12c1e19ec74))


### Bug Fixes

* **web:** add --help hints to agent tools prompt for non-trivial commands ([#7059](https://github.com/vm0-ai/vm0/issues/7059)) ([b485614](https://github.com/vm0-ai/vm0/commit/b4856146d5be7dbb6f17d7564b4c086357227dc2))
* **web:** point agents to ask-user question --help for usage guidance ([#7056](https://github.com/vm0-ai/vm0/issues/7056)) ([fba8364](https://github.com/vm0-ai/vm0/commit/fba8364c4bb5ba78b6acc8c63ce00fa3d91b4d02))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.121.0

## [12.166.0](https://github.com/vm0-ai/vm0/compare/web-v12.165.0...web-v12.166.0) (2026-03-27)


### Features

* add persistent agent avatar with picker ui ([#7035](https://github.com/vm0-ai/vm0/issues/7035)) ([91e09d2](https://github.com/vm0-ai/vm0/commit/91e09d2310d978964c8b7f51b07f65d5700dc072))


### Bug Fixes

* strip markdown from auto-generated chat titles and descriptions ([#7037](https://github.com/vm0-ai/vm0/issues/7037)) ([deb0847](https://github.com/vm0-ai/vm0/commit/deb0847de08774b9e7484fc4425e5ca0477c97f5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.120.0

## [12.165.0](https://github.com/vm0-ai/vm0/compare/web-v12.164.1...web-v12.165.0) (2026-03-27)


### Features

* update og images with zero branding ([#7048](https://github.com/vm0-ai/vm0/issues/7048)) ([f31e98d](https://github.com/vm0-ai/vm0/commit/f31e98d5d26a270d1a887164a95adf5802004935))


### Bug Fixes

* display cancelled subscription status in billing settings ([#7045](https://github.com/vm0-ai/vm0/issues/7045)) ([c946bec](https://github.com/vm0-ai/vm0/commit/c946beca8d8498fe971bc750e3a5aaba40dd8953)), closes [#7038](https://github.com/vm0-ai/vm0/issues/7038)


### Refactoring

* **web:** extract api-token connector type derivation into shared function ([#7018](https://github.com/vm0-ai/vm0/issues/7018)) ([be6b90d](https://github.com/vm0-ai/vm0/commit/be6b90d2bf586b8131ed4431ba81fbd082d26d99))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.119.2

## [12.164.1](https://github.com/vm0-ai/vm0/compare/web-v12.164.0...web-v12.164.1) (2026-03-27)


### Bug Fixes

* add schedule quick link in activity log ([#6974](https://github.com/vm0-ai/vm0/issues/6974)) ([839cab3](https://github.com/vm0-ai/vm0/commit/839cab31b58acc22affe39e70ba748eec3c1ee52))
* capitalize initial letter in slack schedule attribution footer ([#6966](https://github.com/vm0-ai/vm0/issues/6966)) ([43c5c03](https://github.com/vm0-ai/vm0/commit/43c5c035568d13672304f4c97a172a0ffb8ae162))
* remove stale skills from database when deleted from source repo ([#7032](https://github.com/vm0-ai/vm0/issues/7032)) ([ed92922](https://github.com/vm0-ai/vm0/commit/ed9292206446481fec9f2a49fe023a7015fcc1c9))


### Refactoring

* **web:** simplify agent tools prompt ([#7034](https://github.com/vm0-ai/vm0/issues/7034)) ([647e925](https://github.com/vm0-ai/vm0/commit/647e9259c3f1944ada543461ac363412ff46564a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.119.1

## [12.164.0](https://github.com/vm0-ai/vm0/compare/web-v12.163.5...web-v12.164.0) (2026-03-27)


### Features

* add agent trigger source, sessionId inference, and agent tools prompt for zero run ([#6991](https://github.com/vm0-ai/vm0/issues/6991)) ([514c71b](https://github.com/vm0-ai/vm0/commit/514c71b3feb53a18d02e0b46f989f0a4e2bf8151))


### Bug Fixes

* replace 'Zero — agentName' with 'agentName from VM0' in email signatures ([#7024](https://github.com/vm0-ai/vm0/issues/7024)) ([5241c36](https://github.com/vm0-ai/vm0/commit/5241c368ea430adbb727b066a7765157aa55e0d6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.119.0

## [12.163.5](https://github.com/vm0-ai/vm0/compare/web-v12.163.4...web-v12.163.5) (2026-03-26)


### Bug Fixes

* require at least one option for ask-user question command ([#7022](https://github.com/vm0-ai/vm0/issues/7022)) ([4da712b](https://github.com/vm0-ai/vm0/commit/4da712b527355737faf3363f4513d28ef5735c74))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.118.3

## [12.163.4](https://github.com/vm0-ai/vm0/compare/web-v12.163.3...web-v12.163.4) (2026-03-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.118.2

## [12.163.3](https://github.com/vm0-ai/vm0/compare/web-v12.163.2...web-v12.163.3) (2026-03-26)


### Refactoring

* switch ask-user flow to blocking cli command ([#7008](https://github.com/vm0-ai/vm0/issues/7008)) ([a195392](https://github.com/vm0-ai/vm0/commit/a195392ca8ab0cfa61d78c1cf04255b5ffbddb2e))

## [12.163.2](https://github.com/vm0-ai/vm0/compare/web-v12.163.1...web-v12.163.2) (2026-03-26)


### Refactoring

* move chatMessages from agent_sessions to zero_agent_sessions extension table ([#6982](https://github.com/vm0-ai/vm0/issues/6982)) ([6c83665](https://github.com/vm0-ai/vm0/commit/6c83665317d0d2328dbb8cfc7a335e05e008ccc1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.118.1

## [12.163.1](https://github.com/vm0-ai/vm0/compare/web-v12.163.0...web-v12.163.1) (2026-03-26)


### Bug Fixes

* expand firewall placeholders to cover raw oauth names and aliases ([#6956](https://github.com/vm0-ai/vm0/issues/6956)) ([6171494](https://github.com/vm0-ai/vm0/commit/617149476e1e75c05b0a8bcf31fa37993e103226)), closes [#6941](https://github.com/vm0-ai/vm0/issues/6941)


### Documentation

* update server-side-compose jsdoc to reflect current behavior ([#6981](https://github.com/vm0-ai/vm0/issues/6981)) ([1979bf2](https://github.com/vm0-ai/vm0/commit/1979bf2811f597c8a63fad955c11673aa0d54933))


### Refactoring

* remove vm0_secrets/vm0_vars from skill frontmatter and clean up dead code ([#6967](https://github.com/vm0-ai/vm0/issues/6967)) ([b446cdd](https://github.com/vm0-ai/vm0/commit/b446cdd12cd03d71f828726e1decb507af90447a)), closes [#6936](https://github.com/vm0-ai/vm0/issues/6936)
* rename instagram secret to instagram_token ([#6959](https://github.com/vm0-ai/vm0/issues/6959)) ([07687e7](https://github.com/vm0-ai/vm0/commit/07687e7a1ab947201cba7f53da0a9221e8e2e1dc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.118.0

## [12.163.0](https://github.com/vm0-ai/vm0/compare/web-v12.162.0...web-v12.163.0) (2026-03-26)


### Features

* add spotify oauth connector with firewall rules ([#6947](https://github.com/vm0-ai/vm0/issues/6947)) ([353f1eb](https://github.com/vm0-ai/vm0/commit/353f1eba5771ecb559bce41b718cf651a5f07611))
* redesign onboarding as full-page split layout with 4-step flow ([#6683](https://github.com/vm0-ai/vm0/issues/6683)) ([e50ec07](https://github.com/vm0-ai/vm0/commit/e50ec079bbc9489407502a8f207c0a29635e3083))


### Bug Fixes

* use agent id instead of name in slack /settings command url ([#6953](https://github.com/vm0-ai/vm0/issues/6953)) ([23fd8e6](https://github.com/vm0-ai/vm0/commit/23fd8e6d6c1c7b8a4244343ec3a49c8a26d32605)), closes [#6951](https://github.com/vm0-ai/vm0/issues/6951) [#6795](https://github.com/vm0-ai/vm0/issues/6795)


### Refactoring

* derive compose env vars from connector environment mapping ([#6950](https://github.com/vm0-ai/vm0/issues/6950)) ([443e712](https://github.com/vm0-ai/vm0/commit/443e712885734d256a3724cbdb8c3bf6c889ff28))
* move scheduleId from agent_runs to zero_runs table ([#6944](https://github.com/vm0-ai/vm0/issues/6944)) ([f2604cb](https://github.com/vm0-ai/vm0/commit/f2604cbbbe7f6b0b67efede3278f8ae9763c999d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.117.0

## [12.162.0](https://github.com/vm0-ai/vm0/compare/web-v12.161.1...web-v12.162.0) (2026-03-26)


### Features

* add gamma api connector and firewall ([#6882](https://github.com/vm0-ai/vm0/issues/6882)) ([9e349b6](https://github.com/vm0-ai/vm0/commit/9e349b67014f7600a5bc116d12a1e29fe4a54322))


### Bug Fixes

* include api-token connectors in firewall resolution ([#6927](https://github.com/vm0-ai/vm0/issues/6927)) ([2198bc9](https://github.com/vm0-ai/vm0/commit/2198bc9e2b095174ea19b2b7d1b9211653d25eb5)), closes [#6926](https://github.com/vm0-ai/vm0/issues/6926)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.116.0

## [12.161.1](https://github.com/vm0-ai/vm0/compare/web-v12.161.0...web-v12.161.1) (2026-03-26)


### Refactoring

* move trigger source from agent_runs to zero_runs table ([#6877](https://github.com/vm0-ai/vm0/issues/6877)) ([7dbfa0a](https://github.com/vm0-ai/vm0/commit/7dbfa0a57e1fdfa6558ae2e329977db967ba9f25))

## [12.161.0](https://github.com/vm0-ai/vm0/compare/web-v12.160.5...web-v12.161.0) (2026-03-26)


### Features

* **slack:** add schedule attribution footer to slack notifications ([#6865](https://github.com/vm0-ai/vm0/issues/6865)) ([bafe721](https://github.com/vm0-ai/vm0/commit/bafe721ce2c28b79c3169db212339755830cd460))


### Bug Fixes

* optimize api latency with batch queries and missing indexes ([#6834](https://github.com/vm0-ai/vm0/issues/6834)) ([c3941f6](https://github.com/vm0-ai/vm0/commit/c3941f63111451b4c9c01a30143081b9ee4584d0))
* persist chat summaries with structured metadata for consistent display ([#6845](https://github.com/vm0-ai/vm0/issues/6845)) ([958b9f2](https://github.com/vm0-ai/vm0/commit/958b9f228420beb3a9576785b42ae45f3bac121e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.115.2

## [12.160.5](https://github.com/vm0-ai/vm0/compare/web-v12.160.4...web-v12.160.5) (2026-03-26)


### Bug Fixes

* add s3 cleanup and running-run guard to zero agent delete endpoint ([#6871](https://github.com/vm0-ai/vm0/issues/6871)) ([2920069](https://github.com/vm0-ai/vm0/commit/2920069adacb886cab7ad08b33830a8f473df98a)), closes [#6866](https://github.com/vm0-ai/vm0/issues/6866)
* **web:** add next typegen to check-types script to prevent stale validator errors ([#6862](https://github.com/vm0-ai/vm0/issues/6862)) ([28b2320](https://github.com/vm0-ai/vm0/commit/28b232072096592e4f66ccdee0a821a78987fd44)), closes [#6848](https://github.com/vm0-ai/vm0/issues/6848)


### Refactoring

* **cli:** add agent self-update guidance to zero --help and system prompt ([#6874](https://github.com/vm0-ai/vm0/issues/6874)) ([4cd38f1](https://github.com/vm0-ai/vm0/commit/4cd38f1a32ea2fcf6e1332f3d7a694807c2d4d39))
* introduce firewall connector type and simplify firewall api ([#6863](https://github.com/vm0-ai/vm0/issues/6863)) ([cef659e](https://github.com/vm0-ai/vm0/commit/cef659ec12d0c6fb54d7a42a3a90a2f67dadb74a))
* remove vm0 skill from seed skills list ([#6867](https://github.com/vm0-ai/vm0/issues/6867)) ([85d74a7](https://github.com/vm0-ai/vm0/commit/85d74a7325a9852712978f2f95afce3e94c1cfd0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.115.1

## [12.160.4](https://github.com/vm0-ai/vm0/compare/web-v12.160.3...web-v12.160.4) (2026-03-26)


### Refactoring

* consolidate api base url resolution to vm0_api_url ([#6857](https://github.com/vm0-ai/vm0/issues/6857)) ([be4a1bf](https://github.com/vm0-ai/vm0/commit/be4a1bf528facdff83b7f874b9d68de36afcbe36))
* **platform:** resolve schedule agent label from server-side display name ([#6835](https://github.com/vm0-ai/vm0/issues/6835)) ([5b53481](https://github.com/vm0-ai/vm0/commit/5b534813d87103fe423ad9aef43cf32b84536f2e))
* remove deep-links module and all usages across callback handlers ([#6859](https://github.com/vm0-ai/vm0/issues/6859)) ([444f12a](https://github.com/vm0-ai/vm0/commit/444f12a203218ba704fb77e843d684a49fa65034))
* restructure agent system prompt with agent tools section ([#6844](https://github.com/vm0-ai/vm0/issues/6844)) ([d73d8f2](https://github.com/vm0-ai/vm0/commit/d73d8f2bd2f001229dcee591e7244aebcd76752a))
* rewrite agent tools prompt to use situational when-do pattern ([#6850](https://github.com/vm0-ai/vm0/issues/6850)) ([942c991](https://github.com/vm0-ai/vm0/commit/942c9917b55d6e8a04b40594afcb6f6902aae621))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.115.0

## [12.160.3](https://github.com/vm0-ai/vm0/compare/web-v12.160.2...web-v12.160.3) (2026-03-26)


### Bug Fixes

* clarify slack token type in agent context ([#6819](https://github.com/vm0-ai/vm0/issues/6819)) ([3cd2bb3](https://github.com/vm0-ai/vm0/commit/3cd2bb300b3fc4c7e4eb52128d79260f2302888c))

## [12.160.2](https://github.com/vm0-ai/vm0/compare/web-v12.160.1...web-v12.160.2) (2026-03-26)


### Bug Fixes

* prevent agent from sending slack messages as user identity ([#6815](https://github.com/vm0-ai/vm0/issues/6815)) ([9e0d3d8](https://github.com/vm0-ai/vm0/commit/9e0d3d85f8dbbbb3da8383b52ac51af05a5d8cd4))
* restrict billing ui and api access to org admins only ([#6811](https://github.com/vm0-ai/vm0/issues/6811)) ([f13d297](https://github.com/vm0-ai/vm0/commit/f13d2973cf817dd37b19f3473a467ac0fe849088))

## [12.160.1](https://github.com/vm0-ai/vm0/compare/web-v12.160.0...web-v12.160.1) (2026-03-25)


### Bug Fixes

* **auth:** reject cli jwt requests when user is no longer an org member ([#6781](https://github.com/vm0-ai/vm0/issues/6781)) ([b0c889f](https://github.com/vm0-ai/vm0/commit/b0c889f6a86f463bc8e5a03c811896aa350b14bd)), closes [#6776](https://github.com/vm0-ai/vm0/issues/6776)
* **auth:** resolve membership role for zero tokens ([#6805](https://github.com/vm0-ai/vm0/issues/6805)) ([7c40dbb](https://github.com/vm0-ai/vm0/commit/7c40dbbf2e61f678b6e1405b0cc8f484f049926d))
* wrap cli command example in backticks to prevent markdown parsing ([#6782](https://github.com/vm0-ai/vm0/issues/6782)) ([a3070fd](https://github.com/vm0-ai/vm0/commit/a3070fd59635e1bbe8f77ae828d36baf0ad64f76))


### Refactoring

* **auth:** rename cli jwt token prefix from vm0_sandbox_ to vm0_pat_ ([#6784](https://github.com/vm0-ai/vm0/issues/6784)) ([63e848d](https://github.com/vm0-ai/vm0/commit/63e848d0fc07fa2d297097eb417c165c38551440))
* remove legacy vm0_live_ opaque cli token support ([#6786](https://github.com/vm0-ai/vm0/issues/6786)) ([06ea1c6](https://github.com/vm0-ai/vm0/commit/06ea1c6c28c271ae3ddc9ffdf96678c372cc21c0))

## [12.160.0](https://github.com/vm0-ai/vm0/compare/web-v12.159.1...web-v12.160.0) (2026-03-25)


### Features

* **billing:** redesign workspace settings, remove pricing gate, integrate PR [#6551](https://github.com/vm0-ai/vm0/issues/6551) ([#6760](https://github.com/vm0-ai/vm0/issues/6760)) ([e89a9f0](https://github.com/vm0-ai/vm0/commit/e89a9f0a05e4ef02e6e40dfd77c795e6b1fe7c61))


### Bug Fixes

* **platform:** create agent-instructions storage on agent creation ([#6783](https://github.com/vm0-ai/vm0/issues/6783)) ([6a21c6c](https://github.com/vm0-ai/vm0/commit/6a21c6cfda5df99262bc26417ce5b88bea0eb346))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.114.0

## [12.159.1](https://github.com/vm0-ai/vm0/compare/web-v12.159.0...web-v12.159.1) (2026-03-25)


### Refactoring

* disambiguate agent name semantics across frontend and backend ([#6743](https://github.com/vm0-ai/vm0/issues/6743)) ([7998f02](https://github.com/vm0-ai/vm0/commit/7998f020c40dee64c6ebf2f67eacbfe77f4121fb)), closes [#6733](https://github.com/vm0-ai/vm0/issues/6733)

## [12.159.0](https://github.com/vm0-ai/vm0/compare/web-v12.158.0...web-v12.159.0) (2026-03-25)


### Features

* **auth:** add cli jwt token type and auth context support ([#6725](https://github.com/vm0-ai/vm0/issues/6725)) ([40f233d](https://github.com/vm0-ai/vm0/commit/40f233d9a00b82b521daff7a6d286e8f00ac329a))
* **auth:** update server api endpoints to generate cli jwt tokens ([#6740](https://github.com/vm0-ai/vm0/issues/6740)) ([509893c](https://github.com/vm0-ai/vm0/commit/509893ca0eac7364ce422cd994fa3461399713d7))
* **schedule:** simplify create dialog, navigate to detail, add run history tab ([#6715](https://github.com/vm0-ai/vm0/issues/6715)) ([2275f60](https://github.com/vm0-ai/vm0/commit/2275f6042e99ea04f8ffdb9d376153a0c993e603))


### Bug Fixes

* use @clerk/backend for backfill script clerk client ([#6056](https://github.com/vm0-ai/vm0/issues/6056)) ([22d87e4](https://github.com/vm0-ai/vm0/commit/22d87e451944eebbd49d58ded6e925cae2a8a3c0))


### Refactoring

* **web:** convert skill sync to async i/o and concurrent processing ([#6748](https://github.com/vm0-ai/vm0/issues/6748)) ([d4d111b](https://github.com/vm0-ai/vm0/commit/d4d111ba50fb0a6ed98a5aeeda66eb7b458888ba))
* **web:** return flat array from team api endpoint ([#6730](https://github.com/vm0-ai/vm0/issues/6730)) ([2b6ccae](https://github.com/vm0-ai/vm0/commit/2b6ccae92de330f25e0612ecdffc66ccc85b2689))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.113.0

## [12.158.0](https://github.com/vm0-ai/vm0/compare/web-v12.157.0...web-v12.158.0) (2026-03-25)


### Features

* connect org management dialog billing tabs to real data ([#6692](https://github.com/vm0-ai/vm0/issues/6692)) ([00f8209](https://github.com/vm0-ai/vm0/commit/00f82091196d280878c632f895acc37457c6493c))


### Bug Fixes

* **cli:** add slack to capability map and replace curl guidance ([#6679](https://github.com/vm0-ai/vm0/issues/6679)) ([0ba1480](https://github.com/vm0-ai/vm0/commit/0ba1480cc8ab735d967df668806a3577595e5a1a))
* **e2e:** detect google oauth redirect for new users in e2e-auth ([#6702](https://github.com/vm0-ai/vm0/issues/6702)) ([8c6c611](https://github.com/vm0-ai/vm0/commit/8c6c611f0a544cfad0adc70e79fc04abcbaa0907))
* **web:** exclude connector env vars from secret connector map override filter ([#6684](https://github.com/vm0-ai/vm0/issues/6684)) ([89bfe8c](https://github.com/vm0-ai/vm0/commit/89bfe8c30d38b2ad61ef4a575ac3433fb87ef4de))


### Refactoring

* unify zero_agents primary key with agent_composes.id ([#6686](https://github.com/vm0-ai/vm0/issues/6686)) ([f451f21](https://github.com/vm0-ai/vm0/commit/f451f21e19eb9900ad2c7f92832593583e050097))
* **web:** rename firewall type variable for clarity ([#6705](https://github.com/vm0-ai/vm0/issues/6705)) ([eae5ca3](https://github.com/vm0-ai/vm0/commit/eae5ca36c520a459e5a0a4f317a388fc8fcc79aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.112.0

## [12.157.0](https://github.com/vm0-ai/vm0/compare/web-v12.156.1...web-v12.157.0) (2026-03-25)


### Features

* add billing dialog and rename stripe price env vars ([#5782](https://github.com/vm0-ai/vm0/issues/5782)) ([f6ea54d](https://github.com/vm0-ai/vm0/commit/f6ea54d138d6f65e7a1cf03262e6e71372a7fd82))
* add clerk metadata backfill script for complete data migration ([#5973](https://github.com/vm0-ai/vm0/issues/5973)) ([c32a23b](https://github.com/vm0-ai/vm0/commit/c32a23b0b2f59f761e0041e5da6e10f6a7da48dd))
* add clerk webhook endpoint with svix verification ([#5983](https://github.com/vm0-ai/vm0/issues/5983)) ([c2467d0](https://github.com/vm0-ai/vm0/commit/c2467d02132ae38e192bc9cc2f13031f6241b39b)), closes [#5977](https://github.com/vm0-ai/vm0/issues/5977)
* add connector search endpoint for connector discovery ([#6065](https://github.com/vm0-ai/vm0/issues/6065)) ([54cf245](https://github.com/vm0-ai/vm0/commit/54cf245a0fc4d768ded13aadb30b0437c2e79700))
* add description field to schedule with auto-generation fallback ([#6113](https://github.com/vm0-ai/vm0/issues/6113)) ([699c2ac](https://github.com/vm0-ai/vm0/commit/699c2acc587f3a118c49d3c2943090c1c923eab7))
* add dev seed script for credit pricing and api keys ([#5853](https://github.com/vm0-ai/vm0/issues/5853)) ([50bcc9f](https://github.com/vm0-ai/vm0/commit/50bcc9f5f502dd189d1d3f8ea0344e4c2002af11))
* add firewall config for linear connector ([#6448](https://github.com/vm0-ai/vm0/issues/6448)) ([823f8a0](https://github.com/vm0-ai/vm0/commit/823f8a0c9daa8af14bb0ff0049ffb1a12b902968))
* add integration-slack:write capability and proxy api endpoint ([#5970](https://github.com/vm0-ai/vm0/issues/5970)) ([afafbfc](https://github.com/vm0-ai/vm0/commit/afafbfc74e3f82ec9c80170869d0594713bf0385))
* add no-self-api-call eslint rule ([#6001](https://github.com/vm0-ai/vm0/issues/6001)) ([0d2b26f](https://github.com/vm0-ai/vm0/commit/0d2b26f0df6bf2661561a34539f9ae32e897e449))
* add org deletion service for database cascade cleanup ([#5988](https://github.com/vm0-ai/vm0/issues/5988)) ([220403f](https://github.com/vm0-ai/vm0/commit/220403fe8448534bb4a82627d7ad04105552b53c))
* add org external service cleanup function ([#5987](https://github.com/vm0-ai/vm0/issues/5987)) ([5acfc43](https://github.com/vm0-ai/vm0/commit/5acfc430c834f7488e7844a1edf19eef1864aca5))
* add org s3 data cleanup service for org deletion ([#5984](https://github.com/vm0-ai/vm0/issues/5984)) ([1981651](https://github.com/vm0-ai/vm0/commit/1981651631fcc2e9fbbd772fec01818d9fd50b55)), closes [#5979](https://github.com/vm0-ai/vm0/issues/5979)
* add org-level targeting to feature switch system ([#6667](https://github.com/vm0-ai/vm0/issues/6667)) ([46e96a1](https://github.com/vm0-ai/vm0/commit/46e96a137585c23ac82a12a904fd7215b2733b82)), closes [#6643](https://github.com/vm0-ai/vm0/issues/6643)
* add pay-as-you-go auto-recharge for org credits ([#5834](https://github.com/vm0-ai/vm0/issues/5834)) ([66228b7](https://github.com/vm0-ai/vm0/commit/66228b7494af85d25a3dbe54210149de7964fb43))
* add pre-flight credit check for vm0 model provider runs ([#5917](https://github.com/vm0-ai/vm0/issues/5917)) ([3bc42e8](https://github.com/vm0-ai/vm0/commit/3bc42e8662e8b7f54aab394401444fb7e6d74794))
* add slack channel selection for schedule notifications ([#6156](https://github.com/vm0-ai/vm0/issues/6156)) ([059f723](https://github.com/vm0-ai/vm0/commit/059f72309f67fe99bb1259ded54c56c2da33df2d))
* add slug editing to org settings dialog ([#6617](https://github.com/vm0-ai/vm0/issues/6617)) ([daf8229](https://github.com/vm0-ai/vm0/commit/daf82295869ddd7fffcfab337a832052e900698f))
* add stripe webhook forwarding to dev environment ([#6161](https://github.com/vm0-ai/vm0/issues/6161)) ([8bb7223](https://github.com/vm0-ai/vm0/commit/8bb7223b420b7ebb946054e7f714d09d45233a27))
* add trigger source filter to activity page ([#6091](https://github.com/vm0-ai/vm0/issues/6091)) ([89013bb](https://github.com/vm0-ai/vm0/commit/89013bb68137e74f355f7f6330cc17c394990c26))
* add usage page showing per-member token consumption in billing period ([#6019](https://github.com/vm0-ai/vm0/issues/6019)) ([b88b6b3](https://github.com/vm0-ai/vm0/commit/b88b6b33276c7551203f6ef91318439fb94cfcb5))
* add user deletion s3 and external service cleanup ([#6180](https://github.com/vm0-ai/vm0/issues/6180)) ([748b453](https://github.com/vm0-ai/vm0/commit/748b45310900ee0d670ae661265beda20d981b92))
* add user deletion service for database cascade cleanup ([#6169](https://github.com/vm0-ai/vm0/issues/6169)) ([#6181](https://github.com/vm0-ai/vm0/issues/6181)) ([772a7f9](https://github.com/vm0-ai/vm0/commit/772a7f926bfc654e1d24ece3184e8d150b6cfb26))
* add zero connector contracts for sessions, computer, and get-by-type ([#6286](https://github.com/vm0-ai/vm0/issues/6286)) ([ce04430](https://github.com/vm0-ai/vm0/commit/ce044303cb2c3ba9bc1d6b8b03d10d0815a750de))
* add zero connector routes for sessions and computer ([#6298](https://github.com/vm0-ai/vm0/issues/6298)) ([82a4a38](https://github.com/vm0-ai/vm0/commit/82a4a38782a1d57a4535d6d70ad33d9bd25fca44)), closes [#6293](https://github.com/vm0-ai/vm0/issues/6293)
* **api:** add get and delete endpoints for zero secrets and variables ([#6144](https://github.com/vm0-ai/vm0/issues/6144)) ([5b41bac](https://github.com/vm0-ai/vm0/commit/5b41bac8297c8f924261b53dd58a3ca40cd9a749)), closes [#6138](https://github.com/vm0-ai/vm0/issues/6138)
* **api:** add zero agent list and delete endpoints ([#6176](https://github.com/vm0-ai/vm0/issues/6176)) ([24a303b](https://github.com/vm0-ai/vm0/commit/24a303be859378eb9895c1c7d388d16b4d96a039))
* **api:** add zero org list endpoint ([#6150](https://github.com/vm0-ai/vm0/issues/6150)) ([98b39e9](https://github.com/vm0-ai/vm0/commit/98b39e96779d0d016aaa02ee0ff2cd4a68604f6f)), closes [#6139](https://github.com/vm0-ai/vm0/issues/6139)
* apply firewall policies when running zero agents ([#6288](https://github.com/vm0-ai/vm0/issues/6288)) ([f7a3f59](https://github.com/vm0-ai/vm0/commit/f7a3f594a5cf5a0eb8ace683da643d0e7276c4ab))
* auto-generate chat thread titles via lightweight model ([#6063](https://github.com/vm0-ai/vm0/issues/6063)) ([86f3bfb](https://github.com/vm0-ai/vm0/commit/86f3bfb82258ebe9cc8740e58755e03bf6d6eebb))
* **core:** restrict default agent profile and instructions to admin only ([#6658](https://github.com/vm0-ai/vm0/issues/6658)) ([a7e56af](https://github.com/vm0-ai/vm0/commit/a7e56af90508b1b12d2ddba9a42770f40a1de213))
* create zero-run-service to unify all zero trigger paths ([#6028](https://github.com/vm0-ai/vm0/issues/6028)) ([97f1854](https://github.com/vm0-ai/vm0/commit/97f1854c2b3458642022cb6430cf33b4db953b07))
* deduplicate auto-generated firewalls against compose-declared firewalls ([#6126](https://github.com/vm0-ai/vm0/issues/6126)) ([ced37df](https://github.com/vm0-ai/vm0/commit/ced37df6596e791085544e22bc3744507d286a46))
* handle no-model-provider error with dedicated deep link ([#6030](https://github.com/vm0-ai/vm0/issues/6030)) ([0707acd](https://github.com/vm0-ai/vm0/commit/0707acd4a384e0864aa947d432589b32123eef83))
* increase default starter credits from 2000 to 10000 ([#6055](https://github.com/vm0-ai/vm0/issues/6055)) ([c16b93e](https://github.com/vm0-ai/vm0/commit/c16b93e63937b899234f6b38d7591fe85e3d2a28)), closes [#6049](https://github.com/vm0-ai/vm0/issues/6049)
* integrate stripe billing for pro/max subscription plans ([#5764](https://github.com/vm0-ai/vm0/issues/5764)) ([078646b](https://github.com/vm0-ai/vm0/commit/078646baf6476061e4b9b15ebe5adca45d656139))
* log non-tcp traffic from sandbox vms via iptables and /dev/kmsg ([#6060](https://github.com/vm0-ai/vm0/issues/6060)) ([ddf2a0c](https://github.com/vm0-ai/vm0/commit/ddf2a0c3c2c99928d4f12eda1f48a887cfd5533a))
* per-member credit cap for VM0 model provider organizations ([#6173](https://github.com/vm0-ai/vm0/issues/6173)) ([1a551aa](https://github.com/vm0-ai/vm0/commit/1a551aa4a6b11bc0e7865a44e11d3b1737551bac))
* **platform:** add org management dialog with billing, members, and invoices tabs ([#5605](https://github.com/vm0-ai/vm0/issues/5605)) ([a7b3e28](https://github.com/vm0-ai/vm0/commit/a7b3e28c9bd1dbc61d79ee0d8d1155faea14915c))
* **platform:** firewall permissions drawer with persistent policies ([#5467](https://github.com/vm0-ai/vm0/issues/5467)) ([829485f](https://github.com/vm0-ai/vm0/commit/829485f8222f732217e68daae10fe0d56567cc81))
* **platform:** zero chat ux improvements ([#6067](https://github.com/vm0-ai/vm0/issues/6067)) ([8f1b188](https://github.com/vm0-ai/vm0/commit/8f1b188ffb795440858dc16b6f45a23d4ae55c40))
* **platform:** zero schedule detail route and schedule list UX ([#6155](https://github.com/vm0-ai/vm0/issues/6155)) ([3a1a466](https://github.com/vm0-ai/vm0/commit/3a1a466d4619865a99ad0144608e88bcb50a121f))
* **runner:** add job cancellation via ably real-time notifications ([#5949](https://github.com/vm0-ai/vm0/issues/5949)) ([e157f92](https://github.com/vm0-ai/vm0/commit/e157f925312c50ff8de62e986d7bc7afac0a3d53)), closes [#5762](https://github.com/vm0-ai/vm0/issues/5762)
* **slack:** add system prompt guidance for Slack messaging API ([#5967](https://github.com/vm0-ai/vm0/issues/5967)) ([2149427](https://github.com/vm0-ai/vm0/commit/2149427761367ad0ea2b520d88def8491b9d97d9)), closes [#5966](https://github.com/vm0-ai/vm0/issues/5966)
* **slack:** disable cron tools and add vm0 schedule guidance ([#5779](https://github.com/vm0-ai/vm0/issues/5779)) ([fa01ad9](https://github.com/vm0-ai/vm0/commit/fa01ad962c8cf22cb1b864aec0def756ddd0b416))
* structured error codes for pre-run checks with client-side guidance ([#5936](https://github.com/vm0-ai/vm0/issues/5936)) ([c6c0dda](https://github.com/vm0-ai/vm0/commit/c6c0ddaebfc7b0b2fc188a537e16d45fa7a65c02))
* support --settings flag for vm0 run ([#5663](https://github.com/vm0-ai/vm0/issues/5663)) ([#5753](https://github.com/vm0-ai/vm0/issues/5753)) ([d0aad87](https://github.com/vm0-ai/vm0/commit/d0aad87539c31ae4664d41b1cca46b556b3de66e))
* support --tools cli parameter across full pipeline ([#5752](https://github.com/vm0-ai/vm0/issues/5752)) ([b0cf364](https://github.com/vm0-ai/vm0/commit/b0cf364a8598dcd36ed1a6ffffdb8c1e03d1841c))
* switch zero schedule contracts to use zero agent id ([#6172](https://github.com/vm0-ai/vm0/issues/6172)) ([9b74977](https://github.com/vm0-ai/vm0/commit/9b749779d4c79795d8c982fb684fbc5ab1dbe624))
* update plan credits and pricing (free 10k, pro $40/20k, team $200/120k) ([#6075](https://github.com/vm0-ai/vm0/issues/6075)) ([7898caa](https://github.com/vm0-ai/vm0/commit/7898caa94a65ea855375fb9c6aae07207906429b))
* **web:** add zero token generation, secrets injection, and auth ([#6534](https://github.com/vm0-ai/vm0/issues/6534)) ([e7daeab](https://github.com/vm0-ai/vm0/commit/e7daeabb49f6cafad2b775cd6eca770b0e843ff2))
* wire org deletion cleanup into clerk webhook handler ([#6068](https://github.com/vm0-ai/vm0/issues/6068)) ([43594f0](https://github.com/vm0-ai/vm0/commit/43594f0ccc7a3c68d6576cd723a98a99de1d846b)), closes [#5981](https://github.com/vm0-ai/vm0/issues/5981)
* wire user deletion into clerk webhook handler ([#6171](https://github.com/vm0-ai/vm0/issues/6171)) ([#6211](https://github.com/vm0-ai/vm0/issues/6211)) ([bfcf53c](https://github.com/vm0-ai/vm0/commit/bfcf53c1e873783c7d2d7e11e561dc285ad66c2d))


### Bug Fixes

* accept compose id as alternative to zero agent id in schedule api ([#6265](https://github.com/vm0-ai/vm0/issues/6265)) ([e3061eb](https://github.com/vm0-ai/vm0/commit/e3061eb1a2b274040e337d5b5eb95b2d2de81c85))
* add missing cascade/set-null to slack foreign key constraints ([#6256](https://github.com/vm0-ai/vm0/issues/6256)) ([7d7c517](https://github.com/vm0-ai/vm0/commit/7d7c5176f7cb607093046491ab2a8fe80415a06c)), closes [#6241](https://github.com/vm0-ai/vm0/issues/6241)
* add missing fields to claim route response ([#5940](https://github.com/vm0-ai/vm0/issues/5940)) ([881e0b9](https://github.com/vm0-ai/vm0/commit/881e0b9f36653f08f2214e661c6404708746ff8e))
* add retry and graceful fallback for empty openrouter responses ([#6625](https://github.com/vm0-ai/vm0/issues/6625)) ([846408b](https://github.com/vm0-ai/vm0/commit/846408bdb6c45dad82f6050d742e4da124d73e8b))
* clean up schedules before agent runs in org deletion ([#6266](https://github.com/vm0-ai/vm0/issues/6266)) ([9213163](https://github.com/vm0-ai/vm0/commit/921316378162e8a4df61e4d9bff6b9cd363ef461))
* **cli:** add slack to capability map and replace curl guidance ([#6679](https://github.com/vm0-ai/vm0/issues/6679)) ([0ba1480](https://github.com/vm0-ai/vm0/commit/0ba1480cc8ab735d967df668806a3577595e5a1a))
* **core:** replace stale vm0 org cli references with zero org ([#6618](https://github.com/vm0-ai/vm0/issues/6618)) ([6756ab3](https://github.com/vm0-ai/vm0/commit/6756ab3f499fcffb5b54b0ba160ec995e387f533))
* **guest-agent:** add -- separator to prevent variadic flags from swallowing prompt ([#5789](https://github.com/vm0-ai/vm0/issues/5789)) ([b9b2fab](https://github.com/vm0-ai/vm0/commit/b9b2fabe509046af54776cb540b71deee0653c11))
* remove noisy info log from slack status endpoint ([#6634](https://github.com/vm0-ai/vm0/issues/6634)) ([9383598](https://github.com/vm0-ai/vm0/commit/93835983d3ea2b15e0aab25f6ca45993db158352)), closes [#6607](https://github.com/vm0-ai/vm0/issues/6607)
* resolve dark mode toggle hydration mismatch on landing page ([#5892](https://github.com/vm0-ai/vm0/issues/5892)) ([4e5b2d9](https://github.com/vm0-ai/vm0/commit/4e5b2d9f3aeed17c26a6abb7aba1d1743b966772))
* resolve eslint set-state-in-effect error in theme provider ([#5898](https://github.com/vm0-ai/vm0/issues/5898)) ([46f4fd4](https://github.com/vm0-ai/vm0/commit/46f4fd4ae1bb93979c8ee099d03ba223c9d0cb24)), closes [#5896](https://github.com/vm0-ai/vm0/issues/5896)
* return chat message summaries on page refresh ([#6003](https://github.com/vm0-ai/vm0/issues/6003)) ([51aa74f](https://github.com/vm0-ai/vm0/commit/51aa74f9e4b6d0ac7bf44b8776064b78a22ce49b))
* skip startup skills sync in production ([#6665](https://github.com/vm0-ai/vm0/issues/6665)) ([3030c11](https://github.com/vm0-ai/vm0/commit/3030c11bae7e78d8afc24630d89e87f1e18f94ef)), closes [#6608](https://github.com/vm0-ai/vm0/issues/6608)
* **slack:** remove disallowed-tools param to unblock agent runs ([#5783](https://github.com/vm0-ai/vm0/issues/5783)) ([cba9918](https://github.com/vm0-ai/vm0/commit/cba9918904814c6ea2aa5c706e945c01bcd091e2))
* update outbox-service test fixture to use new from address format ([#6454](https://github.com/vm0-ai/vm0/issues/6454)) ([e54539c](https://github.com/vm0-ai/vm0/commit/e54539c4dc5c68250a0c1f6ea8d9280abb3169ac)), closes [#6441](https://github.com/vm0-ai/vm0/issues/6441)
* update schedule guidance to use zero cli and new auth token ([#6477](https://github.com/vm0-ai/vm0/issues/6477)) ([1d51688](https://github.com/vm0-ai/vm0/commit/1d51688546873808ea30fefc727a9454acc553bf))
* update stale cascade comment in agent delete handler ([#6514](https://github.com/vm0-ai/vm0/issues/6514)) ([047bc66](https://github.com/vm0-ai/vm0/commit/047bc66c615a25d123999f399dd46534f2c1e8c7))
* use add column if not exists in migration 0178 to prevent duplicate column error ([#6096](https://github.com/vm0-ai/vm0/issues/6096)) ([318f562](https://github.com/vm0-ai/vm0/commit/318f5628013fe7c2973e225ca53e738c6d6b7874))
* use fake model names in vm0-provider test to avoid polluting dev database ([#6250](https://github.com/vm0-ai/vm0/issues/6250)) ([3b84007](https://github.com/vm0-ai/vm0/commit/3b8400764b4f3b4669fe9fdce8ba007364b9b3c3)), closes [#6243](https://github.com/vm0-ai/vm0/issues/6243)
* validate uuid format in zero agent api path params ([#6629](https://github.com/vm0-ai/vm0/issues/6629)) ([cebaef4](https://github.com/vm0-ai/vm0/commit/cebaef4ddb7dddde3ba8e5113c6772aa2f134fa9))
* **web:** align secret connector map keys with firewall template references ([#6428](https://github.com/vm0-ai/vm0/issues/6428)) ([a33d1a4](https://github.com/vm0-ai/vm0/commit/a33d1a46ee5839e377b8fcf7930980ff762d786c)), closes [#6264](https://github.com/vm0-ai/vm0/issues/6264)
* **web:** harden zero token validation and update stale capability jsdoc ([#6580](https://github.com/vm0-ai/vm0/issues/6580)) ([4f38903](https://github.com/vm0-ai/vm0/commit/4f3890374ba0c20275108cd1d26623013452c431)), closes [#6565](https://github.com/vm0-ai/vm0/issues/6565)
* **web:** return 502 when firewall auth token refresh fails ([#6462](https://github.com/vm0-ai/vm0/issues/6462)) ([6dc6d68](https://github.com/vm0-ai/vm0/commit/6dc6d68be3280d720abe8dfc88224ffc5723aed0))
* **www:** hide blog nav link when blog feature is disabled ([#5887](https://github.com/vm0-ai/vm0/issues/5887)) ([5678b01](https://github.com/vm0-ai/vm0/commit/5678b01b0b252d871ab2e2883bbe6cfdefc0754e)), closes [#5870](https://github.com/vm0-ai/vm0/issues/5870)


### CI

* add stripe billing environment variables to ci workflows ([#5758](https://github.com/vm0-ai/vm0/issues/5758)) ([7d48161](https://github.com/vm0-ai/vm0/commit/7d48161d4eb44bbabd0c79c191bd4d3ea38f6a96))
* upgrade deploy-web job to ubuntu-8core runner ([#6122](https://github.com/vm0-ai/vm0/issues/6122)) ([eba7167](https://github.com/vm0-ai/vm0/commit/eba7167567cbce76db7b0878d863e89784fe3191))


### Documentation

* **web:** update stale comments in firewall auth endpoint ([#6473](https://github.com/vm0-ai/vm0/issues/6473)) ([bca9a68](https://github.com/vm0-ai/vm0/commit/bca9a680a1a1d23eecdb001b6806a4e8d6fc22ee))


### Refactoring

* add zero model-providers update-model endpoint and cleanup orphans ([#5759](https://github.com/vm0-ai/vm0/issues/5759)) ([298a384](https://github.com/vm0-ai/vm0/commit/298a384ad2c95de4af1a685875ebf25a552e64b3))
* add zero-agent-id column to zero_agent_schedules and backfill ([#6136](https://github.com/vm0-ai/vm0/issues/6136)) ([dd1d65e](https://github.com/vm0-ai/vm0/commit/dd1d65efadd637709c2be1db1816ba50c1f6a868))
* **api:** use zero agent id instead of compose id for run creation ([#6239](https://github.com/vm0-ai/vm0/issues/6239)) ([51a1e64](https://github.com/vm0-ai/vm0/commit/51a1e6474c74d054dd8b2bf1fc75413188dfc4ee))
* clean up old agent schedule routes, cli commands, and compose-id column ([#6240](https://github.com/vm0-ai/vm0/issues/6240)) ([a77c622](https://github.com/vm0-ai/vm0/commit/a77c622ae11dde9f32d7a1ff0dea54f202f8f735))
* **db:** rename zeroAgentId to agentId across codebase ([#6272](https://github.com/vm0-ai/vm0/issues/6272)) ([4d3b01d](https://github.com/vm0-ai/vm0/commit/4d3b01de976b2a200117f3b0deed8bb841f24a62))
* **email:** migrate email thread sessions from compose-id to agent-id ([#6443](https://github.com/vm0-ai/vm0/issues/6443)) ([09bfb82](https://github.com/vm0-ai/vm0/commit/09bfb82c3cf22f60109ada3d0a09525b65f087db)), closes [#6431](https://github.com/vm0-ai/vm0/issues/6431)
* **email:** move email routes to /api/zero/email/ namespace ([#6470](https://github.com/vm0-ai/vm0/issues/6470)) ([9def766](https://github.com/vm0-ai/vm0/commit/9def766a08022989a84557ddd41c736766a9468e))
* enforce no-self-api-call eslint rule globally ([#6054](https://github.com/vm0-ai/vm0/issues/6054)) ([a9131c0](https://github.com/vm0-ai/vm0/commit/a9131c083971c66ec2e2193cbf7fe015742c44a2))
* enforce no-self-api-call eslint rule globally ([#6057](https://github.com/vm0-ai/vm0/issues/6057)) ([3f4a352](https://github.com/vm0-ai/vm0/commit/3f4a352d9c04bd098d01e12c0baa5b47af9e0f0b))
* extract onboard helper for zero api tests ([#6280](https://github.com/vm0-ai/vm0/issues/6280)) ([aa54ff7](https://github.com/vm0-ai/vm0/commit/aa54ff7caddafcf7c565d6208e02bc239bcacd8d)), closes [#6270](https://github.com/vm0-ai/vm0/issues/6270)
* extract run service functions and replace infra-client proxy in run routes ([#6094](https://github.com/vm0-ai/vm0/issues/6094)) ([3bd8770](https://github.com/vm0-ai/vm0/commit/3bd877009ffac52c6dc1e4d7879ab45d6e680e27))
* extract service functions for queue, sessions, and composes zero routes ([#6103](https://github.com/vm0-ai/vm0/issues/6103)) ([48476ba](https://github.com/vm0-ai/vm0/commit/48476ba7286af5a5ab3250e9ffb3128155865f0a))
* generalize slack file handling to support all file types ([#6093](https://github.com/vm0-ai/vm0/issues/6093)) ([a44492d](https://github.com/vm0-ai/vm0/commit/a44492dd0364d902e7b47ad7b2600d39dc463139))
* make plausible analytics config environment-driven ([#5985](https://github.com/vm0-ai/vm0/issues/5985)) ([7ec3011](https://github.com/vm0-ai/vm0/commit/7ec3011f04eb0ae66e328012fdd2a28af8ebe01d))
* migrate /api/agent/integrations/slack/message to /api/zero/integrations/slack/message ([#6279](https://github.com/vm0-ai/vm0/issues/6279)) ([e2c50dd](https://github.com/vm0-ai/vm0/commit/e2c50dde55ddb649a0cfbe661829955a40740955)), closes [#6276](https://github.com/vm0-ai/vm0/issues/6276)
* migrate org_metadata default_agent_compose_id to default_agent_id ([#6536](https://github.com/vm0-ai/vm0/issues/6536)) ([e413b38](https://github.com/vm0-ai/vm0/commit/e413b388b290392d2addbc956ab6a25293588b63))
* migrate remaining agent api routes to ts-rest contracts ([#5971](https://github.com/vm0-ai/vm0/issues/5971)) ([0dabe60](https://github.com/vm0-ai/vm0/commit/0dabe60a38e3d8bb96326ab701a272a1a3ac2d6c))
* migrate remaining non-zero api calls to /api/zero/ and add lint rule ([#6116](https://github.com/vm0-ai/vm0/issues/6116)) ([853e76a](https://github.com/vm0-ai/vm0/commit/853e76ac623682e91e31b5a9e87338fb3875cc0c))
* migrate vm0 preference to vm0 zero preference ([#6435](https://github.com/vm0-ai/vm0/issues/6435)) ([3a12d10](https://github.com/vm0-ai/vm0/commit/3a12d10dd4e3ffa5f20f5223e0ac2ba91e9b1387))
* remove agent-composes dependency from email default agent resolver ([#6502](https://github.com/vm0-ai/vm0/issues/6502)) ([1539f8f](https://github.com/vm0-ai/vm0/commit/1539f8f4d7a28e4195ba264e1a56bf6b5b5cf0c3)), closes [#6497](https://github.com/vm0-ai/vm0/issues/6497)
* remove experimental_capabilities and make vm0_token injection unconditional ([#6573](https://github.com/vm0-ai/vm0/issues/6573)) ([#6579](https://github.com/vm0-ai/vm0/issues/6579)) ([1fb7df0](https://github.com/vm0-ai/vm0/commit/1fb7df0201d70223d486c91b536cad93a78c23a3))
* remove global notification preferences ([#6548](https://github.com/vm0-ai/vm0/issues/6548)) ([1d500cd](https://github.com/vm0-ai/vm0/commit/1d500cdf0d0571c8a92d22b5cd8fdf27f44c649e))
* remove infra-client.ts and knip ignore entry ([#6127](https://github.com/vm0-ai/vm0/issues/6127)) ([f0fd988](https://github.com/vm0-ai/vm0/commit/f0fd988b30d5fb716383aca15afdc835146ebd31))
* remove non-anthropic vm0 model providers ([#6066](https://github.com/vm0-ai/vm0/issues/6066)) ([04e13fc](https://github.com/vm0-ai/vm0/commit/04e13fc8386361690f72f520d0810aeb0302c733))
* remove unused `triggerLocalPart` from email trigger payload ([#6456](https://github.com/vm0-ai/vm0/issues/6456)) ([b21169b](https://github.com/vm0-ai/vm0/commit/b21169b015e48fe2921ddbf8589a52f492fbda3c))
* remove vm0 model provider feature switch and auto-init during onboarding ([#6042](https://github.com/vm0-ai/vm0/issues/6042)) ([37dfd70](https://github.com/vm0-ai/vm0/commit/37dfd707b1c92def0237641293ee782843fc8bd8)), closes [#6033](https://github.com/vm0-ai/vm0/issues/6033)
* rename agent_schedules to zero_agent_schedules ([#6119](https://github.com/vm0-ai/vm0/issues/6119)) ([#6124](https://github.com/vm0-ai/vm0/issues/6124)) ([b40ed1d](https://github.com/vm0-ai/vm0/commit/b40ed1d09fd1bee713a3d50a803560ca77c29f84))
* rename organization tier 'max' to 'team' ([#6043](https://github.com/vm0-ai/vm0/issues/6043)) ([9727f5a](https://github.com/vm0-ai/vm0/commit/9727f5aee40559e7a2cc65db91c10c7f96e22556))
* replace agent name with id across zero platform routes and views ([#6541](https://github.com/vm0-ai/vm0/issues/6541)) ([a70cb4b](https://github.com/vm0-ai/vm0/commit/a70cb4b03ac003b7f44132a3dc5ba2a88d597ee6))
* replace http proxy with direct service calls in zero schedule routes ([#6053](https://github.com/vm0-ai/vm0/issues/6053)) ([c74a13c](https://github.com/vm0-ai/vm0/commit/c74a13c33276470d4cb61a35f2cf0ea0e7cfab8d))
* replace infra-client proxy with direct service calls in connector and org zero routes ([#6081](https://github.com/vm0-ai/vm0/issues/6081)) ([3f87c28](https://github.com/vm0-ai/vm0/commit/3f87c288259f330cb50c0e5cb87bace164d434c1))
* rewrite inbound email parsing and routing to org-level ([#6309](https://github.com/vm0-ai/vm0/issues/6309)) ([f25f6af](https://github.com/vm0-ai/vm0/commit/f25f6afd9fd83696744b51aa4cf4649436014a96))
* separate auth error from firewall action in network logs ([#5756](https://github.com/vm0-ai/vm0/issues/5756)) ([7b56aed](https://github.com/vm0-ai/vm0/commit/7b56aedb93ba323a4076af6ca19fb43a520aa6e1)), closes [#5754](https://github.com/vm0-ai/vm0/issues/5754)
* separate connectors from seed skills in zero agent API ([#6204](https://github.com/vm0-ai/vm0/issues/6204)) ([c7fd608](https://github.com/vm0-ai/vm0/commit/c7fd608cc73b9ae95725bc4828440b38d700f67c))
* store connectors directly in zero_agents table ([#6301](https://github.com/vm0-ai/vm0/issues/6301)) ([0e8ba67](https://github.com/vm0-ai/vm0/commit/0e8ba67c5fe354f9698f412c149d9dd0b85b886c))
* unify agent identity fields across all zero api endpoints ([#6302](https://github.com/vm0-ai/vm0/issues/6302)) ([83a0e5d](https://github.com/vm0-ai/vm0/commit/83a0e5d5b5981b709b1dd8e8e318946b6330d2c7))
* unify schedule slack notifications with shared block builder ([#6538](https://github.com/vm0-ai/vm0/issues/6538)) ([78f935d](https://github.com/vm0-ai/vm0/commit/78f935de0e955748c7a502577a0f3a9f4d26d690))
* unify zero cli guidance for sandbox agents ([#6649](https://github.com/vm0-ai/vm0/issues/6649)) ([2110e59](https://github.com/vm0-ai/vm0/commit/2110e5922b6fd6b2468a34ac54e5ad5f3e15b3b1))
* unify zero trigger params — typed callbacks and prompt standardization ([#6106](https://github.com/vm0-ai/vm0/issues/6106)) ([254529d](https://github.com/vm0-ai/vm0/commit/254529d854512b521dd48cbdd29914ec8e6dc230))
* update email callback from addresses to use org slug ([#6311](https://github.com/vm0-ai/vm0/issues/6311)) ([d7813b4](https://github.com/vm0-ai/vm0/commit/d7813b43f865c79ca23d0bdc724a0feec6a78aff))
* update email template signatures to use zero branding ([#6439](https://github.com/vm0-ai/vm0/issues/6439)) ([#6452](https://github.com/vm0-ai/vm0/issues/6452)) ([c2a7f32](https://github.com/vm0-ai/vm0/commit/c2a7f324adfcb89882ced83cd31d108f60820096))
* **web:** remove capability checks from infra routes ([#6496](https://github.com/vm0-ai/vm0/issues/6496)) ([af72f21](https://github.com/vm0-ai/vm0/commit/af72f21c901b702689040e308cb3aa177c77f137))
* **web:** rename integration-slack:write to slack:write and add run route capability checks ([#6552](https://github.com/vm0-ai/vm0/issues/6552)) ([ee21d72](https://github.com/vm0-ai/vm0/commit/ee21d7267c3f88799dc6ad1e8c3a2572193ae0b9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.111.1

## [12.156.1](https://github.com/vm0-ai/vm0/compare/web-v12.156.0...web-v12.156.1) (2026-03-25)


### Bug Fixes

* skip startup skills sync in production ([#6665](https://github.com/vm0-ai/vm0/issues/6665)) ([3030c11](https://github.com/vm0-ai/vm0/commit/3030c11bae7e78d8afc24630d89e87f1e18f94ef)), closes [#6608](https://github.com/vm0-ai/vm0/issues/6608)


### Refactoring

* remove global notification preferences ([#6548](https://github.com/vm0-ai/vm0/issues/6548)) ([1d500cd](https://github.com/vm0-ai/vm0/commit/1d500cdf0d0571c8a92d22b5cd8fdf27f44c649e))
* unify zero cli guidance for sandbox agents ([#6649](https://github.com/vm0-ai/vm0/issues/6649)) ([2110e59](https://github.com/vm0-ai/vm0/commit/2110e5922b6fd6b2468a34ac54e5ad5f3e15b3b1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.111.0

## [12.156.0](https://github.com/vm0-ai/vm0/compare/web-v12.155.1...web-v12.156.0) (2026-03-25)


### Features

* add slug editing to org settings dialog ([#6617](https://github.com/vm0-ai/vm0/issues/6617)) ([daf8229](https://github.com/vm0-ai/vm0/commit/daf82295869ddd7fffcfab337a832052e900698f))
* **platform:** zero schedule detail route and schedule list UX ([#6155](https://github.com/vm0-ai/vm0/issues/6155)) ([3a1a466](https://github.com/vm0-ai/vm0/commit/3a1a466d4619865a99ad0144608e88bcb50a121f))


### Bug Fixes

* add retry and graceful fallback for empty openrouter responses ([#6625](https://github.com/vm0-ai/vm0/issues/6625)) ([846408b](https://github.com/vm0-ai/vm0/commit/846408bdb6c45dad82f6050d742e4da124d73e8b))
* remove noisy info log from slack status endpoint ([#6634](https://github.com/vm0-ai/vm0/issues/6634)) ([9383598](https://github.com/vm0-ai/vm0/commit/93835983d3ea2b15e0aab25f6ca45993db158352)), closes [#6607](https://github.com/vm0-ai/vm0/issues/6607)
* validate uuid format in zero agent api path params ([#6629](https://github.com/vm0-ai/vm0/issues/6629)) ([cebaef4](https://github.com/vm0-ai/vm0/commit/cebaef4ddb7dddde3ba8e5113c6772aa2f134fa9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.110.0

## [12.155.1](https://github.com/vm0-ai/vm0/compare/web-v12.155.0...web-v12.155.1) (2026-03-25)


### Bug Fixes

* **web:** harden zero token validation and update stale capability jsdoc ([#6580](https://github.com/vm0-ai/vm0/issues/6580)) ([4f38903](https://github.com/vm0-ai/vm0/commit/4f3890374ba0c20275108cd1d26623013452c431)), closes [#6565](https://github.com/vm0-ai/vm0/issues/6565)


### Refactoring

* migrate org_metadata default_agent_compose_id to default_agent_id ([#6536](https://github.com/vm0-ai/vm0/issues/6536)) ([e413b38](https://github.com/vm0-ai/vm0/commit/e413b388b290392d2addbc956ab6a25293588b63))
* remove experimental_capabilities and make vm0_token injection unconditional ([#6573](https://github.com/vm0-ai/vm0/issues/6573)) ([#6579](https://github.com/vm0-ai/vm0/issues/6579)) ([1fb7df0](https://github.com/vm0-ai/vm0/commit/1fb7df0201d70223d486c91b536cad93a78c23a3))
* **web:** rename integration-slack:write to slack:write and add run route capability checks ([#6552](https://github.com/vm0-ai/vm0/issues/6552)) ([ee21d72](https://github.com/vm0-ai/vm0/commit/ee21d7267c3f88799dc6ad1e8c3a2572193ae0b9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.109.0

## [12.155.0](https://github.com/vm0-ai/vm0/compare/web-v12.154.2...web-v12.155.0) (2026-03-24)


### Features

* **web:** add zero token generation, secrets injection, and auth ([#6534](https://github.com/vm0-ai/vm0/issues/6534)) ([e7daeab](https://github.com/vm0-ai/vm0/commit/e7daeabb49f6cafad2b775cd6eca770b0e843ff2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.108.0

## [12.154.2](https://github.com/vm0-ai/vm0/compare/web-v12.154.1...web-v12.154.2) (2026-03-24)


### Refactoring

* unify agent identity fields across all zero api endpoints ([#6302](https://github.com/vm0-ai/vm0/issues/6302)) ([83a0e5d](https://github.com/vm0-ai/vm0/commit/83a0e5d5b5981b709b1dd8e8e318946b6330d2c7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.107.0

## [12.154.1](https://github.com/vm0-ai/vm0/compare/web-v12.154.0...web-v12.154.1) (2026-03-24)


### Refactoring

* remove agent-composes dependency from email default agent resolver ([#6502](https://github.com/vm0-ai/vm0/issues/6502)) ([1539f8f](https://github.com/vm0-ai/vm0/commit/1539f8f4d7a28e4195ba264e1a56bf6b5b5cf0c3)), closes [#6497](https://github.com/vm0-ai/vm0/issues/6497)
* **web:** remove capability checks from infra routes ([#6496](https://github.com/vm0-ai/vm0/issues/6496)) ([af72f21](https://github.com/vm0-ai/vm0/commit/af72f21c901b702689040e308cb3aa177c77f137))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.106.0

## [12.154.0](https://github.com/vm0-ai/vm0/compare/web-v12.153.2...web-v12.154.0) (2026-03-24)


### Features

* add firewall config for linear connector ([#6448](https://github.com/vm0-ai/vm0/issues/6448)) ([823f8a0](https://github.com/vm0-ai/vm0/commit/823f8a0c9daa8af14bb0ff0049ffb1a12b902968))
* add slack channel selection for schedule notifications ([#6156](https://github.com/vm0-ai/vm0/issues/6156)) ([059f723](https://github.com/vm0-ai/vm0/commit/059f72309f67fe99bb1259ded54c56c2da33df2d))


### Bug Fixes

* update outbox-service test fixture to use new from address format ([#6454](https://github.com/vm0-ai/vm0/issues/6454)) ([e54539c](https://github.com/vm0-ai/vm0/commit/e54539c4dc5c68250a0c1f6ea8d9280abb3169ac)), closes [#6441](https://github.com/vm0-ai/vm0/issues/6441)
* update schedule guidance to use zero cli and new auth token ([#6477](https://github.com/vm0-ai/vm0/issues/6477)) ([1d51688](https://github.com/vm0-ai/vm0/commit/1d51688546873808ea30fefc727a9454acc553bf))
* **web:** return 502 when firewall auth token refresh fails ([#6462](https://github.com/vm0-ai/vm0/issues/6462)) ([6dc6d68](https://github.com/vm0-ai/vm0/commit/6dc6d68be3280d720abe8dfc88224ffc5723aed0))


### Documentation

* **web:** update stale comments in firewall auth endpoint ([#6473](https://github.com/vm0-ai/vm0/issues/6473)) ([bca9a68](https://github.com/vm0-ai/vm0/commit/bca9a680a1a1d23eecdb001b6806a4e8d6fc22ee))


### Refactoring

* **email:** migrate email thread sessions from compose-id to agent-id ([#6443](https://github.com/vm0-ai/vm0/issues/6443)) ([09bfb82](https://github.com/vm0-ai/vm0/commit/09bfb82c3cf22f60109ada3d0a09525b65f087db)), closes [#6431](https://github.com/vm0-ai/vm0/issues/6431)
* **email:** move email routes to /api/zero/email/ namespace ([#6470](https://github.com/vm0-ai/vm0/issues/6470)) ([9def766](https://github.com/vm0-ai/vm0/commit/9def766a08022989a84557ddd41c736766a9468e))
* remove unused `triggerLocalPart` from email trigger payload ([#6456](https://github.com/vm0-ai/vm0/issues/6456)) ([b21169b](https://github.com/vm0-ai/vm0/commit/b21169b015e48fe2921ddbf8589a52f492fbda3c))
* update email template signatures to use zero branding ([#6439](https://github.com/vm0-ai/vm0/issues/6439)) ([#6452](https://github.com/vm0-ai/vm0/issues/6452)) ([c2a7f32](https://github.com/vm0-ai/vm0/commit/c2a7f324adfcb89882ced83cd31d108f60820096))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.105.0

## [12.153.2](https://github.com/vm0-ai/vm0/compare/web-v12.153.1...web-v12.153.2) (2026-03-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.104.0

## [12.153.1](https://github.com/vm0-ai/vm0/compare/web-v12.153.0...web-v12.153.1) (2026-03-24)


### Bug Fixes

* **web:** align secret connector map keys with firewall template references ([#6428](https://github.com/vm0-ai/vm0/issues/6428)) ([a33d1a4](https://github.com/vm0-ai/vm0/commit/a33d1a46ee5839e377b8fcf7930980ff762d786c)), closes [#6264](https://github.com/vm0-ai/vm0/issues/6264)


### Refactoring

* **db:** rename zeroAgentId to agentId across codebase ([#6272](https://github.com/vm0-ai/vm0/issues/6272)) ([4d3b01d](https://github.com/vm0-ai/vm0/commit/4d3b01de976b2a200117f3b0deed8bb841f24a62))
* rewrite inbound email parsing and routing to org-level ([#6309](https://github.com/vm0-ai/vm0/issues/6309)) ([f25f6af](https://github.com/vm0-ai/vm0/commit/f25f6afd9fd83696744b51aa4cf4649436014a96))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.103.0

## [12.153.0](https://github.com/vm0-ai/vm0/compare/web-v12.152.0...web-v12.153.0) (2026-03-24)


### Features

* add zero connector routes for sessions and computer ([#6298](https://github.com/vm0-ai/vm0/issues/6298)) ([82a4a38](https://github.com/vm0-ai/vm0/commit/82a4a38782a1d57a4535d6d70ad33d9bd25fca44)), closes [#6293](https://github.com/vm0-ai/vm0/issues/6293)
* apply firewall policies when running zero agents ([#6288](https://github.com/vm0-ai/vm0/issues/6288)) ([f7a3f59](https://github.com/vm0-ai/vm0/commit/f7a3f594a5cf5a0eb8ace683da643d0e7276c4ab))


### Refactoring

* store connectors directly in zero_agents table ([#6301](https://github.com/vm0-ai/vm0/issues/6301)) ([0e8ba67](https://github.com/vm0-ai/vm0/commit/0e8ba67c5fe354f9698f412c149d9dd0b85b886c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.102.0

## [12.152.0](https://github.com/vm0-ai/vm0/compare/web-v12.151.0...web-v12.152.0) (2026-03-24)


### Features

* add zero connector contracts for sessions, computer, and get-by-type ([#6286](https://github.com/vm0-ai/vm0/issues/6286)) ([ce04430](https://github.com/vm0-ai/vm0/commit/ce044303cb2c3ba9bc1d6b8b03d10d0815a750de))


### Bug Fixes

* clean up schedules before agent runs in org deletion ([#6266](https://github.com/vm0-ai/vm0/issues/6266)) ([9213163](https://github.com/vm0-ai/vm0/commit/921316378162e8a4df61e4d9bff6b9cd363ef461))


### Refactoring

* extract onboard helper for zero api tests ([#6280](https://github.com/vm0-ai/vm0/issues/6280)) ([aa54ff7](https://github.com/vm0-ai/vm0/commit/aa54ff7caddafcf7c565d6208e02bc239bcacd8d)), closes [#6270](https://github.com/vm0-ai/vm0/issues/6270)
* migrate /api/agent/integrations/slack/message to /api/zero/integrations/slack/message ([#6279](https://github.com/vm0-ai/vm0/issues/6279)) ([e2c50dd](https://github.com/vm0-ai/vm0/commit/e2c50dde55ddb649a0cfbe661829955a40740955)), closes [#6276](https://github.com/vm0-ai/vm0/issues/6276)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.101.0

## [12.151.0](https://github.com/vm0-ai/vm0/compare/web-v12.150.0...web-v12.151.0) (2026-03-24)


### Features

* **platform:** firewall permissions drawer with persistent policies ([#5467](https://github.com/vm0-ai/vm0/issues/5467)) ([829485f](https://github.com/vm0-ai/vm0/commit/829485f8222f732217e68daae10fe0d56567cc81))


### Bug Fixes

* accept compose id as alternative to zero agent id in schedule api ([#6265](https://github.com/vm0-ai/vm0/issues/6265)) ([e3061eb](https://github.com/vm0-ai/vm0/commit/e3061eb1a2b274040e337d5b5eb95b2d2de81c85))
* use fake model names in vm0-provider test to avoid polluting dev database ([#6250](https://github.com/vm0-ai/vm0/issues/6250)) ([3b84007](https://github.com/vm0-ai/vm0/commit/3b8400764b4f3b4669fe9fdce8ba007364b9b3c3)), closes [#6243](https://github.com/vm0-ai/vm0/issues/6243)


### Refactoring

* **api:** use zero agent id instead of compose id for run creation ([#6239](https://github.com/vm0-ai/vm0/issues/6239)) ([51a1e64](https://github.com/vm0-ai/vm0/commit/51a1e6474c74d054dd8b2bf1fc75413188dfc4ee))
* clean up old agent schedule routes, cli commands, and compose-id column ([#6240](https://github.com/vm0-ai/vm0/issues/6240)) ([a77c622](https://github.com/vm0-ai/vm0/commit/a77c622ae11dde9f32d7a1ff0dea54f202f8f735))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.100.0

## [12.150.0](https://github.com/vm0-ai/vm0/compare/web-v12.149.0...web-v12.150.0) (2026-03-23)


### Features

* switch zero schedule contracts to use zero agent id ([#6172](https://github.com/vm0-ai/vm0/issues/6172)) ([9b74977](https://github.com/vm0-ai/vm0/commit/9b749779d4c79795d8c982fb684fbc5ab1dbe624))
* wire user deletion into clerk webhook handler ([#6171](https://github.com/vm0-ai/vm0/issues/6171)) ([#6211](https://github.com/vm0-ai/vm0/issues/6211)) ([bfcf53c](https://github.com/vm0-ai/vm0/commit/bfcf53c1e873783c7d2d7e11e561dc285ad66c2d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.99.0

## [12.149.0](https://github.com/vm0-ai/vm0/compare/web-v12.148.0...web-v12.149.0) (2026-03-23)


### Features

* add user deletion s3 and external service cleanup ([#6180](https://github.com/vm0-ai/vm0/issues/6180)) ([748b453](https://github.com/vm0-ai/vm0/commit/748b45310900ee0d670ae661265beda20d981b92))


### Refactoring

* separate connectors from seed skills in zero agent API ([#6204](https://github.com/vm0-ai/vm0/issues/6204)) ([c7fd608](https://github.com/vm0-ai/vm0/commit/c7fd608cc73b9ae95725bc4828440b38d700f67c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.98.1

## [12.148.0](https://github.com/vm0-ai/vm0/compare/web-v12.147.0...web-v12.148.0) (2026-03-23)


### Features

* add stripe webhook forwarding to dev environment ([#6161](https://github.com/vm0-ai/vm0/issues/6161)) ([8bb7223](https://github.com/vm0-ai/vm0/commit/8bb7223b420b7ebb946054e7f714d09d45233a27))
* add user deletion service for database cascade cleanup ([#6169](https://github.com/vm0-ai/vm0/issues/6169)) ([#6181](https://github.com/vm0-ai/vm0/issues/6181)) ([772a7f9](https://github.com/vm0-ai/vm0/commit/772a7f926bfc654e1d24ece3184e8d150b6cfb26))
* **api:** add get and delete endpoints for zero secrets and variables ([#6144](https://github.com/vm0-ai/vm0/issues/6144)) ([5b41bac](https://github.com/vm0-ai/vm0/commit/5b41bac8297c8f924261b53dd58a3ca40cd9a749)), closes [#6138](https://github.com/vm0-ai/vm0/issues/6138)
* per-member credit cap for VM0 model provider organizations ([#6173](https://github.com/vm0-ai/vm0/issues/6173)) ([1a551aa](https://github.com/vm0-ai/vm0/commit/1a551aa4a6b11bc0e7865a44e11d3b1737551bac))


### CI

* upgrade deploy-web job to ubuntu-8core runner ([#6122](https://github.com/vm0-ai/vm0/issues/6122)) ([eba7167](https://github.com/vm0-ai/vm0/commit/eba7167567cbce76db7b0878d863e89784fe3191))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.98.0

## [12.147.0](https://github.com/vm0-ai/vm0/compare/web-v12.146.0...web-v12.147.0) (2026-03-23)


### Features

* **api:** add zero org list endpoint ([#6150](https://github.com/vm0-ai/vm0/issues/6150)) ([98b39e9](https://github.com/vm0-ai/vm0/commit/98b39e96779d0d016aaa02ee0ff2cd4a68604f6f)), closes [#6139](https://github.com/vm0-ai/vm0/issues/6139)


### Refactoring

* add zero-agent-id column to zero_agent_schedules and backfill ([#6136](https://github.com/vm0-ai/vm0/issues/6136)) ([dd1d65e](https://github.com/vm0-ai/vm0/commit/dd1d65efadd637709c2be1db1816ba50c1f6a868))
* migrate remaining non-zero api calls to /api/zero/ and add lint rule ([#6116](https://github.com/vm0-ai/vm0/issues/6116)) ([853e76a](https://github.com/vm0-ai/vm0/commit/853e76ac623682e91e31b5a9e87338fb3875cc0c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.97.0


## [12.146.0](https://github.com/vm0-ai/vm0/compare/web-v12.145.0...web-v12.146.0) (2026-03-23)


### Features

* add description field to schedule with auto-generation fallback ([#6113](https://github.com/vm0-ai/vm0/issues/6113)) ([699c2ac](https://github.com/vm0-ai/vm0/commit/699c2acc587f3a118c49d3c2943090c1c923eab7))
* deduplicate auto-generated firewalls against compose-declared firewalls ([#6126](https://github.com/vm0-ai/vm0/issues/6126)) ([ced37df](https://github.com/vm0-ai/vm0/commit/ced37df6596e791085544e22bc3744507d286a46))
* **platform:** zero chat ux improvements ([#6067](https://github.com/vm0-ai/vm0/issues/6067)) ([8f1b188](https://github.com/vm0-ai/vm0/commit/8f1b188ffb795440858dc16b6f45a23d4ae55c40))


### Refactoring

* extract service functions for queue, sessions, and composes zero routes ([#6103](https://github.com/vm0-ai/vm0/issues/6103)) ([48476ba](https://github.com/vm0-ai/vm0/commit/48476ba7286af5a5ab3250e9ffb3128155865f0a))
* remove infra-client.ts and knip ignore entry ([#6127](https://github.com/vm0-ai/vm0/issues/6127)) ([f0fd988](https://github.com/vm0-ai/vm0/commit/f0fd988b30d5fb716383aca15afdc835146ebd31))
* rename agent_schedules to zero_agent_schedules ([#6119](https://github.com/vm0-ai/vm0/issues/6119)) ([#6124](https://github.com/vm0-ai/vm0/issues/6124)) ([b40ed1d](https://github.com/vm0-ai/vm0/commit/b40ed1d09fd1bee713a3d50a803560ca77c29f84))
* unify zero trigger params — typed callbacks and prompt standardization ([#6106](https://github.com/vm0-ai/vm0/issues/6106)) ([254529d](https://github.com/vm0-ai/vm0/commit/254529d854512b521dd48cbdd29914ec8e6dc230))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.96.0

## [12.145.0](https://github.com/vm0-ai/vm0/compare/web-v12.144.0...web-v12.145.0) (2026-03-23)


### Features

* add trigger source filter to activity page ([#6091](https://github.com/vm0-ai/vm0/issues/6091)) ([89013bb](https://github.com/vm0-ai/vm0/commit/89013bb68137e74f355f7f6330cc17c394990c26))
* update plan credits and pricing (free 10k, pro $40/20k, team $200/120k) ([#6075](https://github.com/vm0-ai/vm0/issues/6075)) ([7898caa](https://github.com/vm0-ai/vm0/commit/7898caa94a65ea855375fb9c6aae07207906429b))


### Refactoring

* enforce no-self-api-call eslint rule globally ([#6054](https://github.com/vm0-ai/vm0/issues/6054)) ([a9131c0](https://github.com/vm0-ai/vm0/commit/a9131c083971c66ec2e2193cbf7fe015742c44a2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.95.0

## [12.144.0](https://github.com/vm0-ai/vm0/compare/web-v12.143.0...web-v12.144.0) (2026-03-23)


### Features

* add connector search endpoint for connector discovery ([#6065](https://github.com/vm0-ai/vm0/issues/6065)) ([54cf245](https://github.com/vm0-ai/vm0/commit/54cf245a0fc4d768ded13aadb30b0437c2e79700))
* auto-generate chat thread titles via lightweight model ([#6063](https://github.com/vm0-ai/vm0/issues/6063)) ([86f3bfb](https://github.com/vm0-ai/vm0/commit/86f3bfb82258ebe9cc8740e58755e03bf6d6eebb))


### Refactoring

* extract run service functions and replace infra-client proxy in run routes ([#6094](https://github.com/vm0-ai/vm0/issues/6094)) ([3bd8770](https://github.com/vm0-ai/vm0/commit/3bd877009ffac52c6dc1e4d7879ab45d6e680e27))
* generalize slack file handling to support all file types ([#6093](https://github.com/vm0-ai/vm0/issues/6093)) ([a44492d](https://github.com/vm0-ai/vm0/commit/a44492dd0364d902e7b47ad7b2600d39dc463139))
* replace infra-client proxy with direct service calls in connector and org zero routes ([#6081](https://github.com/vm0-ai/vm0/issues/6081)) ([3f87c28](https://github.com/vm0-ai/vm0/commit/3f87c288259f330cb50c0e5cb87bace164d434c1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.94.0

## [12.143.0](https://github.com/vm0-ai/vm0/compare/web-v12.142.0...web-v12.143.0) (2026-03-23)


### Features

* add clerk metadata backfill script for complete data migration ([#5973](https://github.com/vm0-ai/vm0/issues/5973)) ([c32a23b](https://github.com/vm0-ai/vm0/commit/c32a23b0b2f59f761e0041e5da6e10f6a7da48dd))
* add org deletion service for database cascade cleanup ([#5988](https://github.com/vm0-ai/vm0/issues/5988)) ([220403f](https://github.com/vm0-ai/vm0/commit/220403fe8448534bb4a82627d7ad04105552b53c))
* add usage page showing per-member token consumption in billing period ([#6019](https://github.com/vm0-ai/vm0/issues/6019)) ([b88b6b3](https://github.com/vm0-ai/vm0/commit/b88b6b33276c7551203f6ef91318439fb94cfcb5))
* create zero-run-service to unify all zero trigger paths ([#6028](https://github.com/vm0-ai/vm0/issues/6028)) ([97f1854](https://github.com/vm0-ai/vm0/commit/97f1854c2b3458642022cb6430cf33b4db953b07))
* handle no-model-provider error with dedicated deep link ([#6030](https://github.com/vm0-ai/vm0/issues/6030)) ([0707acd](https://github.com/vm0-ai/vm0/commit/0707acd4a384e0864aa947d432589b32123eef83))
* increase default starter credits from 2000 to 10000 ([#6055](https://github.com/vm0-ai/vm0/issues/6055)) ([c16b93e](https://github.com/vm0-ai/vm0/commit/c16b93e63937b899234f6b38d7591fe85e3d2a28)), closes [#6049](https://github.com/vm0-ai/vm0/issues/6049)
* wire org deletion cleanup into clerk webhook handler ([#6068](https://github.com/vm0-ai/vm0/issues/6068)) ([43594f0](https://github.com/vm0-ai/vm0/commit/43594f0ccc7a3c68d6576cd723a98a99de1d846b)), closes [#5981](https://github.com/vm0-ai/vm0/issues/5981)


### Refactoring

* enforce no-self-api-call eslint rule globally ([#6057](https://github.com/vm0-ai/vm0/issues/6057)) ([3f4a352](https://github.com/vm0-ai/vm0/commit/3f4a352d9c04bd098d01e12c0baa5b47af9e0f0b))
* remove non-anthropic vm0 model providers ([#6066](https://github.com/vm0-ai/vm0/issues/6066)) ([04e13fc](https://github.com/vm0-ai/vm0/commit/04e13fc8386361690f72f520d0810aeb0302c733))
* remove vm0 model provider feature switch and auto-init during onboarding ([#6042](https://github.com/vm0-ai/vm0/issues/6042)) ([37dfd70](https://github.com/vm0-ai/vm0/commit/37dfd707b1c92def0237641293ee782843fc8bd8)), closes [#6033](https://github.com/vm0-ai/vm0/issues/6033)
* rename organization tier 'max' to 'team' ([#6043](https://github.com/vm0-ai/vm0/issues/6043)) ([9727f5a](https://github.com/vm0-ai/vm0/commit/9727f5aee40559e7a2cc65db91c10c7f96e22556))
* replace http proxy with direct service calls in zero schedule routes ([#6053](https://github.com/vm0-ai/vm0/issues/6053)) ([c74a13c](https://github.com/vm0-ai/vm0/commit/c74a13c33276470d4cb61a35f2cf0ea0e7cfab8d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.93.0

## [12.142.0](https://github.com/vm0-ai/vm0/compare/web-v12.141.1...web-v12.142.0) (2026-03-23)


### Features

* add clerk webhook endpoint with svix verification ([#5983](https://github.com/vm0-ai/vm0/issues/5983)) ([c2467d0](https://github.com/vm0-ai/vm0/commit/c2467d02132ae38e192bc9cc2f13031f6241b39b)), closes [#5977](https://github.com/vm0-ai/vm0/issues/5977)
* add no-self-api-call eslint rule ([#6001](https://github.com/vm0-ai/vm0/issues/6001)) ([0d2b26f](https://github.com/vm0-ai/vm0/commit/0d2b26f0df6bf2661561a34539f9ae32e897e449))
* add org external service cleanup function ([#5987](https://github.com/vm0-ai/vm0/issues/5987)) ([5acfc43](https://github.com/vm0-ai/vm0/commit/5acfc430c834f7488e7844a1edf19eef1864aca5))
* add org s3 data cleanup service for org deletion ([#5984](https://github.com/vm0-ai/vm0/issues/5984)) ([1981651](https://github.com/vm0-ai/vm0/commit/1981651631fcc2e9fbbd772fec01818d9fd50b55)), closes [#5979](https://github.com/vm0-ai/vm0/issues/5979)
* **platform:** add org management dialog with billing, members, and invoices tabs ([#5605](https://github.com/vm0-ai/vm0/issues/5605)) ([a7b3e28](https://github.com/vm0-ai/vm0/commit/a7b3e28c9bd1dbc61d79ee0d8d1155faea14915c))


### Bug Fixes

* return chat message summaries on page refresh ([#6003](https://github.com/vm0-ai/vm0/issues/6003)) ([51aa74f](https://github.com/vm0-ai/vm0/commit/51aa74f9e4b6d0ac7bf44b8776064b78a22ce49b))


### Refactoring

* add zero model-providers update-model endpoint and cleanup orphans ([#5759](https://github.com/vm0-ai/vm0/issues/5759)) ([298a384](https://github.com/vm0-ai/vm0/commit/298a384ad2c95de4af1a685875ebf25a552e64b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.92.0

## [12.141.1](https://github.com/vm0-ai/vm0/compare/web-v12.141.0...web-v12.141.1) (2026-03-22)


### Refactoring

* make plausible analytics config environment-driven ([#5985](https://github.com/vm0-ai/vm0/issues/5985)) ([7ec3011](https://github.com/vm0-ai/vm0/commit/7ec3011f04eb0ae66e328012fdd2a28af8ebe01d))

## [12.141.0](https://github.com/vm0-ai/vm0/compare/web-v12.140.1...web-v12.141.0) (2026-03-22)


### Features

* add integration-slack:write capability and proxy api endpoint ([#5970](https://github.com/vm0-ai/vm0/issues/5970)) ([afafbfc](https://github.com/vm0-ai/vm0/commit/afafbfc74e3f82ec9c80170869d0594713bf0385))
* add pre-flight credit check for vm0 model provider runs ([#5917](https://github.com/vm0-ai/vm0/issues/5917)) ([3bc42e8](https://github.com/vm0-ai/vm0/commit/3bc42e8662e8b7f54aab394401444fb7e6d74794))
* **runner:** add job cancellation via ably real-time notifications ([#5949](https://github.com/vm0-ai/vm0/issues/5949)) ([e157f92](https://github.com/vm0-ai/vm0/commit/e157f925312c50ff8de62e986d7bc7afac0a3d53)), closes [#5762](https://github.com/vm0-ai/vm0/issues/5762)
* **slack:** add system prompt guidance for Slack messaging API ([#5967](https://github.com/vm0-ai/vm0/issues/5967)) ([2149427](https://github.com/vm0-ai/vm0/commit/2149427761367ad0ea2b520d88def8491b9d97d9)), closes [#5966](https://github.com/vm0-ai/vm0/issues/5966)
* structured error codes for pre-run checks with client-side guidance ([#5936](https://github.com/vm0-ai/vm0/issues/5936)) ([c6c0dda](https://github.com/vm0-ai/vm0/commit/c6c0ddaebfc7b0b2fc188a537e16d45fa7a65c02))


### Bug Fixes

* add missing fields to claim route response ([#5940](https://github.com/vm0-ai/vm0/issues/5940)) ([881e0b9](https://github.com/vm0-ai/vm0/commit/881e0b9f36653f08f2214e661c6404708746ff8e))


### Refactoring

* migrate remaining agent api routes to ts-rest contracts ([#5971](https://github.com/vm0-ai/vm0/issues/5971)) ([0dabe60](https://github.com/vm0-ai/vm0/commit/0dabe60a38e3d8bb96326ab701a272a1a3ac2d6c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.91.0

## [12.140.1](https://github.com/vm0-ai/vm0/compare/web-v12.140.0...web-v12.140.1) (2026-03-21)


### Bug Fixes

* resolve dark mode toggle hydration mismatch on landing page ([#5892](https://github.com/vm0-ai/vm0/issues/5892)) ([4e5b2d9](https://github.com/vm0-ai/vm0/commit/4e5b2d9f3aeed17c26a6abb7aba1d1743b966772))
* resolve eslint set-state-in-effect error in theme provider ([#5898](https://github.com/vm0-ai/vm0/issues/5898)) ([46f4fd4](https://github.com/vm0-ai/vm0/commit/46f4fd4ae1bb93979c8ee099d03ba223c9d0cb24)), closes [#5896](https://github.com/vm0-ai/vm0/issues/5896)
* **www:** hide blog nav link when blog feature is disabled ([#5887](https://github.com/vm0-ai/vm0/issues/5887)) ([5678b01](https://github.com/vm0-ai/vm0/commit/5678b01b0b252d871ab2e2883bbe6cfdefc0754e)), closes [#5870](https://github.com/vm0-ai/vm0/issues/5870)

## [12.140.0](https://github.com/vm0-ai/vm0/compare/web-v12.139.0...web-v12.140.0) (2026-03-21)


### Features

* add dev seed script for credit pricing and api keys ([#5853](https://github.com/vm0-ai/vm0/issues/5853)) ([50bcc9f](https://github.com/vm0-ai/vm0/commit/50bcc9f5f502dd189d1d3f8ea0344e4c2002af11))


### Bug Fixes

* **guest-agent:** add -- separator to prevent variadic flags from swallowing prompt ([#5789](https://github.com/vm0-ai/vm0/issues/5789)) ([b9b2fab](https://github.com/vm0-ai/vm0/commit/b9b2fabe509046af54776cb540b71deee0653c11))

## [12.139.0](https://github.com/vm0-ai/vm0/compare/web-v12.138.0...web-v12.139.0) (2026-03-21)


### Features

* add pay-as-you-go auto-recharge for org credits ([#5834](https://github.com/vm0-ai/vm0/issues/5834)) ([66228b7](https://github.com/vm0-ai/vm0/commit/66228b7494af85d25a3dbe54210149de7964fb43))

## [12.138.0](https://github.com/vm0-ai/vm0/compare/web-v12.137.1...web-v12.138.0) (2026-03-20)


### Features

* add billing dialog and rename stripe price env vars ([#5782](https://github.com/vm0-ai/vm0/issues/5782)) ([f6ea54d](https://github.com/vm0-ai/vm0/commit/f6ea54d138d6f65e7a1cf03262e6e71372a7fd82))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.90.0

## [12.137.1](https://github.com/vm0-ai/vm0/compare/web-v12.137.0...web-v12.137.1) (2026-03-20)


### Bug Fixes

* **slack:** remove disallowed-tools param to unblock agent runs ([#5783](https://github.com/vm0-ai/vm0/issues/5783)) ([cba9918](https://github.com/vm0-ai/vm0/commit/cba9918904814c6ea2aa5c706e945c01bcd091e2))

## [12.137.0](https://github.com/vm0-ai/vm0/compare/web-v12.136.0...web-v12.137.0) (2026-03-20)


### Features

* integrate stripe billing for pro/max subscription plans ([#5764](https://github.com/vm0-ai/vm0/issues/5764)) ([078646b](https://github.com/vm0-ai/vm0/commit/078646baf6476061e4b9b15ebe5adca45d656139))
* support --settings flag for vm0 run ([#5663](https://github.com/vm0-ai/vm0/issues/5663)) ([#5753](https://github.com/vm0-ai/vm0/issues/5753)) ([d0aad87](https://github.com/vm0-ai/vm0/commit/d0aad87539c31ae4664d41b1cca46b556b3de66e))
* support --tools cli parameter across full pipeline ([#5752](https://github.com/vm0-ai/vm0/issues/5752)) ([b0cf364](https://github.com/vm0-ai/vm0/commit/b0cf364a8598dcd36ed1a6ffffdb8c1e03d1841c))


### CI

* add stripe billing environment variables to ci workflows ([#5758](https://github.com/vm0-ai/vm0/issues/5758)) ([7d48161](https://github.com/vm0-ai/vm0/commit/7d48161d4eb44bbabd0c79c191bd4d3ea38f6a96))


### Refactoring

* separate auth error from firewall action in network logs ([#5756](https://github.com/vm0-ai/vm0/issues/5756)) ([7b56aed](https://github.com/vm0-ai/vm0/commit/7b56aedb93ba323a4076af6ca19fb43a520aa6e1)), closes [#5754](https://github.com/vm0-ai/vm0/issues/5754)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.89.0

## [12.136.0](https://github.com/vm0-ai/vm0/compare/web-v12.135.0...web-v12.136.0) (2026-03-20)


### Features

* add firewall fields to network logs and improve action handling ([#5745](https://github.com/vm0-ai/vm0/issues/5745)) ([ff2d271](https://github.com/vm0-ai/vm0/commit/ff2d271d7040f6367dd19a7f0e6f21fdd35a19c1))
* add sandbox token capability enforcement to /api/zero/agents endpoints ([#5746](https://github.com/vm0-ai/vm0/issues/5746)) ([ef77fa2](https://github.com/vm0-ai/vm0/commit/ef77fa2c75fbf7c1e0cc673f6dd4f73df02468ab))


### Refactoring

* api layer separation phase 5 — application-layer endpoint migration ([#5721](https://github.com/vm0-ai/vm0/issues/5721)) ([3ec2080](https://github.com/vm0-ai/vm0/commit/3ec2080b722dc02d1dc07caeabbd780b4f87c93f))
* rename org and org_members tables to org_metadata and org_members_metadata ([#5634](https://github.com/vm0-ai/vm0/issues/5634)) ([08e8599](https://github.com/vm0-ai/vm0/commit/08e85999e7a89e7ef5527a93166d3140e4500fc8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.88.0

## [12.135.0](https://github.com/vm0-ai/vm0/compare/web-v12.134.0...web-v12.135.0) (2026-03-20)


### Features

* add brevo api-token connector ([#5734](https://github.com/vm0-ai/vm0/issues/5734)) ([dd1cb42](https://github.com/vm0-ai/vm0/commit/dd1cb4262e948fad5a585ea474f9583d59800499)), closes [#5712](https://github.com/vm0-ai/vm0/issues/5712)
* add cal-com api-token connector ([#5729](https://github.com/vm0-ai/vm0/issues/5729)) ([9a8165a](https://github.com/vm0-ai/vm0/commit/9a8165ad65920f19271769f9ae06f4f8d66b335c)), closes [#5713](https://github.com/vm0-ai/vm0/issues/5713)
* add loops api-token connector ([#5744](https://github.com/vm0-ai/vm0/issues/5744)) ([62895ea](https://github.com/vm0-ai/vm0/commit/62895eaa443aa23910181d15255dff2a3c2ea6d9)), closes [#5717](https://github.com/vm0-ai/vm0/issues/5717)
* add salesforce api-token connector ([#5735](https://github.com/vm0-ai/vm0/issues/5735)) ([2b5866f](https://github.com/vm0-ai/vm0/commit/2b5866f1e43d29fa966edddf6eabb90c2e66d5ee))


### Bug Fixes

* store selectedModel on agent_runs for credit usage billing ([#5739](https://github.com/vm0-ai/vm0/issues/5739)) ([e8e33ce](https://github.com/vm0-ai/vm0/commit/e8e33ceba5acb77c5d17b64c48db6a0c2d1e80c4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.87.0

## [12.134.0](https://github.com/vm0-ai/vm0/compare/web-v12.133.0...web-v12.134.0) (2026-03-20)


### Features

* add calendly api-token connector ([#5727](https://github.com/vm0-ai/vm0/issues/5727)) ([b11325d](https://github.com/vm0-ai/vm0/commit/b11325d7696d67f823b2b5c48509b674eab017df)), closes [#5714](https://github.com/vm0-ai/vm0/issues/5714)
* add cloudinary api-token connector ([#5724](https://github.com/vm0-ai/vm0/issues/5724)) ([d1734d1](https://github.com/vm0-ai/vm0/commit/d1734d19408bc5e3c5eddfd9b44e2bfbff8b354e))
* add customer-io api-token connector ([#5730](https://github.com/vm0-ai/vm0/issues/5730)) ([04e85a7](https://github.com/vm0-ai/vm0/commit/04e85a7d01da9472a9f4f11e742fa5a0db10a9e7))
* add v0 api-token connector ([#5725](https://github.com/vm0-ai/vm0/issues/5725)) ([ce9481f](https://github.com/vm0-ai/vm0/commit/ce9481fd0fcfdd3e089c36773572ef680c07384b)), closes [#5710](https://github.com/vm0-ai/vm0/issues/5710)
* **platform:** add no-side-effect-in-render eslint rule and fix violations ([#5691](https://github.com/vm0-ai/vm0/issues/5691)) ([77fd903](https://github.com/vm0-ai/vm0/commit/77fd90313991a16f37dcb19fd8577c48d3e1645c))


### Bug Fixes

* preserve agent metadata when updating only connectors ([#5700](https://github.com/vm0-ai/vm0/issues/5700)) ([f7274d6](https://github.com/vm0-ai/vm0/commit/f7274d6af6aebaaba974fec3d103d3d204366105))


### Refactoring

* api layer separation phase 3 — core domain proxies ([#5694](https://github.com/vm0-ai/vm0/issues/5694)) ([9e94027](https://github.com/vm0-ai/vm0/commit/9e940274deab747aa8bf72de1c55a5c918f25e12))
* unify inconsistent api paths for model-providers, user-preferences, secrets ([#5689](https://github.com/vm0-ai/vm0/issues/5689)) ([cb986be](https://github.com/vm0-ai/vm0/commit/cb986beb3a9d103f51c967cb200b85c50507c0ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.86.0

## [12.133.0](https://github.com/vm0-ai/vm0/compare/web-v12.132.0...web-v12.133.0) (2026-03-20)


### Features

* add trigger_source column to agent_runs for fine-grained run origin tracking ([#5602](https://github.com/vm0-ai/vm0/issues/5602)) ([55fd4bf](https://github.com/vm0-ai/vm0/commit/55fd4bf4209ff92ca7ad8142e07dce7a91b67a4e))


### Bug Fixes

* deduplicate slack error messages on run dispatch failure ([#5678](https://github.com/vm0-ai/vm0/issues/5678)) ([7a90f53](https://github.com/vm0-ai/vm0/commit/7a90f53123b66c1cc201dff704c5933f7d0963d4))
* persist trigger source when enqueueing runs ([#5667](https://github.com/vm0-ai/vm0/issues/5667)) ([de2a280](https://github.com/vm0-ai/vm0/commit/de2a280cd8c841a9d8834cea9889df017ff6f0bd))
* **platform:** show error in chat for timeout and cancelled runs ([#5627](https://github.com/vm0-ai/vm0/issues/5627)) ([87b7a07](https://github.com/vm0-ai/vm0/commit/87b7a0738411190691bb2bc365e15ef09b730f58))


### Refactoring

* api layer separation phase 1 — foundation (infra-client + platform ts-rest) ([#5681](https://github.com/vm0-ai/vm0/issues/5681)) ([54d938f](https://github.com/vm0-ai/vm0/commit/54d938facc8df6d5f2486d18a2d8d25f45ef90f0))
* api layer separation phase 2 — simple proxy domains (connectors, org) ([#5686](https://github.com/vm0-ai/vm0/issues/5686)) ([8534f59](https://github.com/vm0-ai/vm0/commit/8534f5957817e3576845971c1a536c2a117457ab))
* extract workspace cleanup into reusable service function ([#5652](https://github.com/vm0-ai/vm0/issues/5652)) ([57540ef](https://github.com/vm0-ai/vm0/commit/57540ef4b5c7fbc4e2f29b58a637b87011462815))
* **slack:** use structured sender block in context formatting ([#5639](https://github.com/vm0-ai/vm0/issues/5639)) ([dfca766](https://github.com/vm0-ai/vm0/commit/dfca76616ac7e4b4e1904f105f2225d05e1fe0fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.85.0

## [12.132.0](https://github.com/vm0-ai/vm0/compare/web-v12.131.0...web-v12.132.0) (2026-03-19)


### Features

* add disallowed_tools to vm0.yaml schema and server pipeline ([#5576](https://github.com/vm0-ai/vm0/issues/5576)) ([6ac49d7](https://github.com/vm0-ai/vm0/commit/6ac49d7434b456e01df4d3fa6bf918923b07b2f5))
* add storage version lineage table for artifact/memory parent tracking ([#5501](https://github.com/vm0-ai/vm0/issues/5501)) ([c2b3115](https://github.com/vm0-ai/vm0/commit/c2b311506f65889215730b27a4ad0d244c651747))
* add zero agents rest api and remove compose jobs ([#5594](https://github.com/vm0-ai/vm0/issues/5594)) ([8e428bb](https://github.com/vm0-ai/vm0/commit/8e428bb40c663b50bb481928f708e004601ee1af))
* **connectors:** add bitrix, brave-search, cronlytic connectors ([#5528](https://github.com/vm0-ai/vm0/issues/5528)) ([21821cd](https://github.com/vm0-ai/vm0/commit/21821cd973e36e7906aa7ef97329e9c751cee491))
* **connectors:** add discord, discord-webhook, gitlab connectors ([#5542](https://github.com/vm0-ai/vm0/issues/5542)) ([99fb554](https://github.com/vm0-ai/vm0/commit/99fb5543059f62aa37625e3bb1ef3b405f787978)), closes [#5519](https://github.com/vm0-ai/vm0/issues/5519)
* **connectors:** add htmlcsstoimage, imgur, instagram api token connectors ([#5538](https://github.com/vm0-ai/vm0/issues/5538)) ([7c75fce](https://github.com/vm0-ai/vm0/commit/7c75fce26c15ad1f6781c71bea15ef108ed067f6)), closes [#5520](https://github.com/vm0-ai/vm0/issues/5520)
* **connectors:** add instantly, jira, and kommo API token connectors ([#5561](https://github.com/vm0-ai/vm0/issues/5561)) ([257b637](https://github.com/vm0-ai/vm0/commit/257b6377eb77b15db23dbdfd7ee66b129d082dc8))
* **connectors:** add lark, mailsac, minio api token connectors ([#5543](https://github.com/vm0-ai/vm0/issues/5543)) ([bb81ced](https://github.com/vm0-ai/vm0/commit/bb81ced1c3c53ea78e428b0a737ce62b0f59b086))
* **connectors:** add pdforge, slack-webhook, wix api token connectors ([#5545](https://github.com/vm0-ai/vm0/issues/5545)) ([5471a13](https://github.com/vm0-ai/vm0/commit/5471a1348897a4d045bbbdaa8cc8e5a4f8ed04e1)), closes [#5523](https://github.com/vm0-ai/vm0/issues/5523)
* create org_members table and migrate preferences from Clerk ([#5539](https://github.com/vm0-ai/vm0/issues/5539)) ([16bd437](https://github.com/vm0-ai/vm0/commit/16bd437ecbe5c02417868a54aa1049d2510475a9))
* **credit:** support multiple result events per run ([#5516](https://github.com/vm0-ai/vm0/issues/5516)) ([23ff198](https://github.com/vm0-ai/vm0/commit/23ff198501f2b4b814e0024ece1408f264c74597))
* implement vm0 managed model provider with meta-provider resolution ([#5623](https://github.com/vm0-ai/vm0/issues/5623)) ([b20b330](https://github.com/vm0-ai/vm0/commit/b20b330d5f83d3cef4591866eaec460c9ebedef0))
* inject agent identity metadata into web chat system prompt ([#5505](https://github.com/vm0-ai/vm0/issues/5505)) ([122cdfe](https://github.com/vm0-ai/vm0/commit/122cdfe78bdf28785b8e39115027b538be71fc78))
* migrate email_unsubscribed from clerk metadata to users table ([#5532](https://github.com/vm0-ai/vm0/issues/5532)) ([f19a439](https://github.com/vm0-ai/vm0/commit/f19a4396f22b4537f4a941e58947037d488b30de))
* **platform:** auto-pin on chat, remove pin limit, fix team nav ([#5536](https://github.com/vm0-ai/vm0/issues/5536)) ([f210650](https://github.com/vm0-ai/vm0/commit/f210650bc393fce2fb2d43156caab6c0a985a478))
* **platform:** migrate org tier and default_agent_compose_id from clerk metadata to org table ([#5541](https://github.com/vm0-ai/vm0/issues/5541)) ([d9201e1](https://github.com/vm0-ai/vm0/commit/d9201e1c581c249b1aae0245964cf410f32b4ebb))
* protect model provider tokens from sandbox exposure via firewall gateway ([#5464](https://github.com/vm0-ai/vm0/issues/5464)) ([5f3caee](https://github.com/vm0-ai/vm0/commit/5f3caeeddb8cf434976afe9fb8c03d637efc8443))
* **run:** block incompatible provider switch on session continue ([#5531](https://github.com/vm0-ai/vm0/issues/5531)) ([e9e4499](https://github.com/vm0-ai/vm0/commit/e9e44993dee8ea28e907b27cbaffec2db51c520e))


### Bug Fixes

* add clerk lazy migration fallbacks for read paths ([#5591](https://github.com/vm0-ai/vm0/issues/5591)) ([#5600](https://github.com/vm0-ai/vm0/issues/5600)) ([1ecbb69](https://github.com/vm0-ai/vm0/commit/1ecbb6940d19077ededb2aefe6b884d171fe4062))
* **api:** use upsert for default agent to handle missing org rows ([#5613](https://github.com/vm0-ai/vm0/issues/5613)) ([5234ddc](https://github.com/vm0-ai/vm0/commit/5234ddcf5e8118817aa8d3c760585b53c4ba45c6))
* **test:** prevent race condition in compose idempotency test ([#5585](https://github.com/vm0-ai/vm0/issues/5585)) ([b91d14b](https://github.com/vm0-ai/vm0/commit/b91d14bb841adb5cac3de70e05bd325a7cf12d8c))


### Refactoring

* **cli:** remove metadata from compose types and clone whitelist ([#5497](https://github.com/vm0-ai/vm0/issues/5497)) ([3d61855](https://github.com/vm0-ai/vm0/commit/3d6185591a1ebbc6262298a9ddfa9e143c8b0026))
* merge browser profile into default, install chromium in base rootfs ([#5568](https://github.com/vm0-ai/vm0/issues/5568)) ([e014dd1](https://github.com/vm0-ai/vm0/commit/e014dd1d9778d739b66844f2d67871ba61af9107)), closes [#5554](https://github.com/vm0-ai/vm0/issues/5554)
* move disallowed_tools from vm0.yaml to run-time parameter ([#5625](https://github.com/vm0-ai/vm0/issues/5625)) ([63b431c](https://github.com/vm0-ai/vm0/commit/63b431c86fb4548c51a5b2b02bc9887a04d7dfa4)), closes [#5614](https://github.com/vm0-ai/vm0/issues/5614)
* remove metadata field from compose pipeline ([#5549](https://github.com/vm0-ai/vm0/issues/5549)) ([#5566](https://github.com/vm0-ai/vm0/issues/5566)) ([aeaf504](https://github.com/vm0-ai/vm0/commit/aeaf504dc6b84dd32f09f9278c58fed417d4ecbf))
* **slack:** move integration context from userPrompt to systemPrompt ([#5569](https://github.com/vm0-ai/vm0/issues/5569)) ([7e9469b](https://github.com/vm0-ai/vm0/commit/7e9469bef3da52a352900f58d02776c4b187ea7f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.84.0

## [12.131.0](https://github.com/vm0-ai/vm0/compare/web-v12.130.1...web-v12.131.0) (2026-03-19)


### Features

* reply all result events to Slack instead of only the last one ([#5490](https://github.com/vm0-ai/vm0/issues/5490)) ([6e11ad9](https://github.com/vm0-ai/vm0/commit/6e11ad91c75a7938e90ed45d7e53409e25233bff))
* **run:** store resolved model provider on run record after context build ([#5460](https://github.com/vm0-ai/vm0/issues/5460)) ([06bbc92](https://github.com/vm0-ai/vm0/commit/06bbc92f16ece9993bfa519302649ec7042baf8d))
* **slack:** use native markdown block for agent response rendering ([#5489](https://github.com/vm0-ai/vm0/issues/5489)) ([199ce16](https://github.com/vm0-ai/vm0/commit/199ce16817eb527f7d83943d73b3e3b1c25771e5)), closes [#5486](https://github.com/vm0-ai/vm0/issues/5486)


### Refactoring

* consolidate run creation into single entry point ([#5488](https://github.com/vm0-ai/vm0/issues/5488)) ([20e9d56](https://github.com/vm0-ai/vm0/commit/20e9d56fffa296670923fee56d81aae4590a65b9))
* inline legacy slack shared handlers into slack-org module ([#5495](https://github.com/vm0-ai/vm0/issues/5495)) ([8f127e3](https://github.com/vm0-ai/vm0/commit/8f127e3cf43d9d2517b03b84d8658144b0df1a16))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.83.0

## [12.130.1](https://github.com/vm0-ai/vm0/compare/web-v12.130.0...web-v12.130.1) (2026-03-19)


### Refactoring

* migrate org credits from clerk metadata to database ([#5462](https://github.com/vm0-ai/vm0/issues/5462)) ([4b2c873](https://github.com/vm0-ai/vm0/commit/4b2c87336b8aa458d79fdc0685c9eb57b43e451a))
* **web:** unify run output extraction into shared service ([#5395](https://github.com/vm0-ai/vm0/issues/5395)) ([1b93611](https://github.com/vm0-ai/vm0/commit/1b9361161299bf766c61e822959a575e319edf2d))

## [12.130.0](https://github.com/vm0-ai/vm0/compare/web-v12.129.0...web-v12.130.0) (2026-03-19)


### Features

* add append-system-prompt support to schedule system ([#5426](https://github.com/vm0-ai/vm0/issues/5426)) ([56fcb08](https://github.com/vm0-ai/vm0/commit/56fcb082797280d0129f3fb3be287bb9b1290aa9)), closes [#5377](https://github.com/vm0-ai/vm0/issues/5377)
* block agent deletion for sandbox tokens ([#5427](https://github.com/vm0-ai/vm0/issues/5427)) ([4baf5bb](https://github.com/vm0-ai/vm0/commit/4baf5bba8b63d97dc4bb7cc76253d00ce8fe204d)), closes [#5425](https://github.com/vm0-ai/vm0/issues/5425)
* inject agent identity env vars and add whoami command ([#5461](https://github.com/vm0-ai/vm0/issues/5461)) ([76ceb92](https://github.com/vm0-ai/vm0/commit/76ceb92d5559ed2987abbacc24fcf422ebad2753))


### Refactoring

* migrate agent metadata to zero_agents table ([#5393](https://github.com/vm0-ai/vm0/issues/5393)) ([a6bc58d](https://github.com/vm0-ai/vm0/commit/a6bc58db3a554ff76a37554c553fe180c9d1a9c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.82.0

## [12.129.0](https://github.com/vm0-ai/vm0/compare/web-v12.128.1...web-v12.129.0) (2026-03-19)


### Features

* add append-system-prompt to web api pipeline ([#5385](https://github.com/vm0-ai/vm0/issues/5385)) ([d91d73c](https://github.com/vm0-ai/vm0/commit/d91d73cfdf338e7ab7ba9fb0d7581a57a7739f3e))
* extend credit_usage with cache tokens, web search requests, and cost ([#5428](https://github.com/vm0-ai/vm0/issues/5428)) ([fcfd1dc](https://github.com/vm0-ai/vm0/commit/fcfd1dcde3939bf7bfe3e8f61e4e90c4d9de8724))
* **runner:** add vm0/browser profile with dockerfile and ci integration ([#5311](https://github.com/vm0-ai/vm0/issues/5311)) ([a6b6077](https://github.com/vm0-ai/vm0/commit/a6b6077eb2e8a83f48bed456e4ee7d5e3323c192))


### Bug Fixes

* allow re-setting default agent when previous compose was deleted ([#5398](https://github.com/vm0-ai/vm0/issues/5398)) ([cf52c92](https://github.com/vm0-ai/vm0/commit/cf52c92bc474374623b8f96b76d95f51f6ef1b32))
* **platform:** unblock server-side compose from sandbox job concurrency limit ([#5416](https://github.com/vm0-ai/vm0/issues/5416)) ([a2f3af3](https://github.com/vm0-ai/vm0/commit/a2f3af3b97767dcce1a5fcd69a2c600dbdbed593)), closes [#5414](https://github.com/vm0-ai/vm0/issues/5414)


### CI

* test e2e-auth pipeline with trivial comment change ([#5435](https://github.com/vm0-ai/vm0/issues/5435)) ([aba00f2](https://github.com/vm0-ai/vm0/commit/aba00f23f6c1ad15665cb7c93de0c942c777ef0f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.81.0

## [12.128.1](https://github.com/vm0-ai/vm0/compare/web-v12.128.0...web-v12.128.1) (2026-03-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.80.0

## [12.128.0](https://github.com/vm0-ai/vm0/compare/web-v12.127.0...web-v12.128.0) (2026-03-18)


### Features

* add model provider tracking to credit_usage and credit_pricing ([#5360](https://github.com/vm0-ai/vm0/issues/5360)) ([d5b00c1](https://github.com/vm0-ai/vm0/commit/d5b00c1ba3f6fd06a72f0cc2acb9e4eda76d4be8))


### Bug Fixes

* drop residual zero prefix from queue session link and stale comment ([#5362](https://github.com/vm0-ai/vm0/issues/5362)) ([4b4ca17](https://github.com/vm0-ai/vm0/commit/4b4ca1737b32ae5477e947bd608f1d608bbe9a7e)), closes [#5356](https://github.com/vm0-ai/vm0/issues/5356)
* **web:** adjust hero section to full viewport height ([#5357](https://github.com/vm0-ai/vm0/issues/5357)) ([852f5e0](https://github.com/vm0-ai/vm0/commit/852f5e050eaac5cdb346e64460b35c8e9a3d8f66))
* **web:** fix blog page styles and navbar positioning ([#5369](https://github.com/vm0-ai/vm0/issues/5369)) ([0acbc42](https://github.com/vm0-ai/vm0/commit/0acbc429e04cd07ba116fd9e2571c1e9380ab81c))


### Refactoring

* migrate admin user-level model providers to org-level and clean up ([#5346](https://github.com/vm0-ai/vm0/issues/5346)) ([d7c5429](https://github.com/vm0-ai/vm0/commit/d7c5429b57efc5fe0655b23681e7603ef1e85472))
* remove deprecated image and working_dir fields from compose ([#5352](https://github.com/vm0-ai/vm0/issues/5352)) ([4768f00](https://github.com/vm0-ai/vm0/commit/4768f009118889681bb5c8b86a822ea0a4266eeb))
* remove legacy working_dir fallback from extract-working-dir ([#5365](https://github.com/vm0-ai/vm0/issues/5365)) ([58b8b41](https://github.com/vm0-ai/vm0/commit/58b8b41c8c7815d71d9db074487be20b6f433a5f))
* remove unused user-level model provider exports ([#5349](https://github.com/vm0-ai/vm0/issues/5349)) ([53716e0](https://github.com/vm0-ai/vm0/commit/53716e0b57bb7a826786c71738e7800db9a8ad03))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.79.2

## [12.127.0](https://github.com/vm0-ai/vm0/compare/web-v12.126.1...web-v12.127.0) (2026-03-18)


### Features

* auto-disconnect existing connector in /authorize endpoint ([#5351](https://github.com/vm0-ai/vm0/issues/5351)) ([e65f0d1](https://github.com/vm0-ai/vm0/commit/e65f0d1b1a6ddea1e1f5af826e471bc1f7367297)), closes [#5343](https://github.com/vm0-ai/vm0/issues/5343)
* **web:** redesign homepage and add security page ([#5338](https://github.com/vm0-ai/vm0/issues/5338)) ([6a1148f](https://github.com/vm0-ai/vm0/commit/6a1148f4713afa4ec8b80321a9fe5239fd1e04c6))


### Refactoring

* remove model provider step from member onboarding flow ([#5326](https://github.com/vm0-ai/vm0/issues/5326)) ([8dc83b4](https://github.com/vm0-ai/vm0/commit/8dc83b48159cb36994734c752d1b46dfd24ce188))
* remove platform naming remnants from codebase ([#5336](https://github.com/vm0-ai/vm0/issues/5336)) ([a846586](https://github.com/vm0-ai/vm0/commit/a84658654b6b9ae11801aa0c8ac0dd30a3d8fa9f)), closes [#5327](https://github.com/vm0-ai/vm0/issues/5327)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.79.1

## [12.126.1](https://github.com/vm0-ai/vm0/compare/web-v12.126.0...web-v12.126.1) (2026-03-18)


### Bug Fixes

* **web:** skip clerk middleware for sandbox token requests ([#5330](https://github.com/vm0-ai/vm0/issues/5330)) ([83194ae](https://github.com/vm0-ai/vm0/commit/83194aeff94c341b191f8853606f5b40213b9d59))


### Refactoring

* remove user-level model provider API routes ([#5301](https://github.com/vm0-ai/vm0/issues/5301)) ([c77178c](https://github.com/vm0-ai/vm0/commit/c77178c7ea3d7b4efaa5c62767044df1ac44eb50))

## [12.126.0](https://github.com/vm0-ai/vm0/compare/web-v12.125.1...web-v12.126.0) (2026-03-18)


### Features

* add organization-wide run queue web interface ([#4988](https://github.com/vm0-ai/vm0/issues/4988)) ([2da3dfd](https://github.com/vm0-ai/vm0/commit/2da3dfd5f6e8b0eced19135ad86333c8146d9f7e))
* **docs:** update model provider references from user-level to org-level commands ([#5325](https://github.com/vm0-ai/vm0/issues/5325)) ([d3afc0e](https://github.com/vm0-ai/vm0/commit/d3afc0e145539f679a7a39d2bb550c34d223a50b)), closes [#5323](https://github.com/vm0-ai/vm0/issues/5323)
* insert credit_usage records via events webhook ([#5307](https://github.com/vm0-ai/vm0/issues/5307)) ([4ea1555](https://github.com/vm0-ai/vm0/commit/4ea1555e49b6345f104ff78347b03dec0520190b))
* prompt users to review and approve oauth scope changes ([#5312](https://github.com/vm0-ai/vm0/issues/5312)) ([6cd80bf](https://github.com/vm0-ai/vm0/commit/6cd80bfeee99e0e13935222cb1081837ac31ed05))


### Bug Fixes

* check org-level model provider in onboarding status ([#5322](https://github.com/vm0-ai/vm0/issues/5322)) ([5120652](https://github.com/vm0-ai/vm0/commit/512065207583be28883cae5acd32007101ccda66))
* **web:** trigger release for slack org_id column fix ([#5288](https://github.com/vm0-ai/vm0/issues/5288)) ([#5315](https://github.com/vm0-ai/vm0/issues/5315)) ([f596950](https://github.com/vm0-ai/vm0/commit/f5969500ae17542849c97d2a5cc42cf5b872925a))


### Refactoring

* **auth:** rename get-user-id to get-auth-context and centralize session claims ([#5321](https://github.com/vm0-ai/vm0/issues/5321)) ([cfd5dc3](https://github.com/vm0-ai/vm0/commit/cfd5dc38ab0174331e7abbd9c763b99cd3636696))
* scope compose access checks to caller's active org ([#5308](https://github.com/vm0-ai/vm0/issues/5308)) ([5e75650](https://github.com/vm0-ai/vm0/commit/5e756504380e95815bf5a7aaa84b1d04525353e6))
* simplify build-context to org-only model provider resolution ([#5297](https://github.com/vm0-ai/vm0/issues/5297)) ([a6425c1](https://github.com/vm0-ai/vm0/commit/a6425c11283b39d8f0a6cbb2c0cbedd40359c83a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.79.0

## [12.125.1](https://github.com/vm0-ai/vm0/compare/web-v12.125.0...web-v12.125.1) (2026-03-18)


### Bug Fixes

* remove secrets/vars validation when deploying a schedule ([#5310](https://github.com/vm0-ai/vm0/issues/5310)) ([1a6b8dc](https://github.com/vm0-ai/vm0/commit/1a6b8dc32a4f74b9327a5c0fd7cf7ebb39ac9a4b)), closes [#5179](https://github.com/vm0-ai/vm0/issues/5179)

## [12.125.0](https://github.com/vm0-ai/vm0/compare/web-v12.124.1...web-v12.125.0) (2026-03-18)


### Features

* **platform:** add member onboarding flow and welcome animation ([#5060](https://github.com/vm0-ai/vm0/issues/5060)) ([de6b1e1](https://github.com/vm0-ai/vm0/commit/de6b1e1cf9467bf1171fd67b5ebbc560373322a2))


### Bug Fixes

* correct display name extraction path in platform logs api ([#5289](https://github.com/vm0-ai/vm0/issues/5289)) ([ce4b44b](https://github.com/vm0-ai/vm0/commit/ce4b44bd44d98cbd20bc7ef8f4e4ab2d91727aa1))


### Refactoring

* enforce mandatory org context in telemetry routes ([#5264](https://github.com/vm0-ai/vm0/issues/5264)) ([9f25118](https://github.com/vm0-ai/vm0/commit/9f25118b9a12525e79471195e5e6e62d9c9edc62))
* pass AuthContext to resolveOrg instead of calling auth() internally ([#5262](https://github.com/vm0-ai/vm0/issues/5262)) ([6cbd955](https://github.com/vm0-ai/vm0/commit/6cbd955ccefc43f9418ff85d90d500bc27661e7d))
* platform to app comprehensive rename (phase 2) ([#5275](https://github.com/vm0-ai/vm0/issues/5275)) ([73e8a5f](https://github.com/vm0-ai/vm0/commit/73e8a5f0edfac2a0b73a9f4d86812fd747de98db))
* remove redundant org-id from slack org tables ([#5288](https://github.com/vm0-ai/vm0/issues/5288)) ([c503e53](https://github.com/vm0-ai/vm0/commit/c503e53f2ad17cc1159c9c8c9ba69b33942ab57b)), closes [#5239](https://github.com/vm0-ai/vm0/issues/5239)
* remove server-level openrouter api key env var ([#5282](https://github.com/vm0-ai/vm0/issues/5282)) ([50ca446](https://github.com/vm0-ai/vm0/commit/50ca4465ce849fea2132b1cfcefaee1267cc447b))
* rename get-platform-url to get-app-url across web app ([#5279](https://github.com/vm0-ai/vm0/issues/5279)) ([066a5a7](https://github.com/vm0-ai/vm0/commit/066a5a7bc5a02160db50cce72e42f34b48ab52e8)), closes [#5271](https://github.com/vm0-ai/vm0/issues/5271)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.78.0

## [12.124.1](https://github.com/vm0-ai/vm0/compare/web-v12.124.0...web-v12.124.1) (2026-03-17)


### Bug Fixes

* add org-scoped filtering to /api/logs/search ([#5236](https://github.com/vm0-ai/vm0/issues/5236)) ([d751c19](https://github.com/vm0-ai/vm0/commit/d751c19469a6c330f3396ebaf92aeb3f339dd736))
* add org-scoped filtering to /api/usage ([#5240](https://github.com/vm0-ai/vm0/issues/5240)) ([fe83b0c](https://github.com/vm0-ai/vm0/commit/fe83b0c489304914647543f7739e3ceb9af1d3ec))
* revert merged provider list to return only user providers ([#5261](https://github.com/vm0-ai/vm0/issues/5261)) ([a5783c7](https://github.com/vm0-ai/vm0/commit/a5783c7376dc7b6584c189d55a31269ccaf5aabd)), closes [#5259](https://github.com/vm0-ai/vm0/issues/5259)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.77.1

## [12.124.0](https://github.com/vm0-ai/vm0/compare/web-v12.123.0...web-v12.124.0) (2026-03-17)


### Features

* add credit processing service with org-level advisory lock ([#5238](https://github.com/vm0-ai/vm0/issues/5238)) ([861d628](https://github.com/vm0-ai/vm0/commit/861d628ba9fbc152d842ec040748397b8b581742))


### Bug Fixes

* remove /zero prefix from audit links in notifications ([#5246](https://github.com/vm0-ai/vm0/issues/5246)) ([e4dadde](https://github.com/vm0-ai/vm0/commit/e4dadde36e06ee290291d1dd8a9029ac69c4896f)), closes [#5245](https://github.com/vm0-ai/vm0/issues/5245)


### Refactoring

* reorder token checks to skip auth() for vm0 tokens ([#5222](https://github.com/vm0-ai/vm0/issues/5222)) ([7f91d33](https://github.com/vm0-ai/vm0/commit/7f91d3324e9c3e49ebb5504782d3435b93fc0d5d)), closes [#5215](https://github.com/vm0-ai/vm0/issues/5215)

## [12.123.0](https://github.com/vm0-ai/vm0/compare/web-v12.122.0...web-v12.123.0) (2026-03-17)


### Features

* add credits billing storage layer ([#5221](https://github.com/vm0-ai/vm0/issues/5221)) ([0daf4e5](https://github.com/vm0-ai/vm0/commit/0daf4e5a3a7b9f807baa7e7aa88df4633656f100))
* add org secret and variable api routes and cli commands ([#5213](https://github.com/vm0-ai/vm0/issues/5213)) ([01b3662](https://github.com/vm0-ai/vm0/commit/01b3662aeaea0e7f32faacb1148e9722d45ef981)), closes [#5200](https://github.com/vm0-ai/vm0/issues/5200)
* add org/personal tabs for model provider settings ([#5214](https://github.com/vm0-ai/vm0/issues/5214)) ([d035f1d](https://github.com/vm0-ai/vm0/commit/d035f1d7b372f07c6054e27fd71b2ac437f8bb26))


### Bug Fixes

* remove re-created compose org access helper and add org filter to run sub-routes ([#5220](https://github.com/vm0-ai/vm0/issues/5220)) ([782a50f](https://github.com/vm0-ai/vm0/commit/782a50f8f9580c56281dd2d8ccc63074f5407566))
* use standard oauth with team param instead of oidc for slack connect ([#5201](https://github.com/vm0-ai/vm0/issues/5201)) ([87ab998](https://github.com/vm0-ai/vm0/commit/87ab99861f9abff3d0ed4aaac39ab6ad9f773eb2))


### Refactoring

* add explicit org slug to all resolve-org calls without org parameter ([#5219](https://github.com/vm0-ai/vm0/issues/5219)) ([1efaad5](https://github.com/vm0-ai/vm0/commit/1efaad55373336645081db5ef82444c20b3f0dd4))
* add vm0_sandbox_ prefix for stable token type identification ([#5146](https://github.com/vm0-ai/vm0/issues/5146)) ([525e8d6](https://github.com/vm0-ai/vm0/commit/525e8d646014ea8f68b9bb294609a6e13be64087))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.77.0

## [12.122.0](https://github.com/vm0-ai/vm0/compare/web-v12.121.0...web-v12.122.0) (2026-03-17)


### Features

* add org model-provider management api (admin-only) ([#5187](https://github.com/vm0-ai/vm0/issues/5187)) ([10e79f9](https://github.com/vm0-ai/vm0/commit/10e79f969862e66f845a7b56a3ed90b47e6d6575))
* add org-level fallback for model providers, secrets, and variables ([#5185](https://github.com/vm0-ai/vm0/issues/5185)) ([60fe6b0](https://github.com/vm0-ai/vm0/commit/60fe6b0fe6c5a48537b81285fc65953c0b723e4c)), closes [#5168](https://github.com/vm0-ai/vm0/issues/5168)
* add org-level secrets and variables service functions ([#5181](https://github.com/vm0-ai/vm0/issues/5181)) ([ee3de44](https://github.com/vm0-ai/vm0/commit/ee3de44c998e11d846691ff8b506cedad72300d3)), closes [#5171](https://github.com/vm0-ai/vm0/issues/5171)
* add scope field to merged model provider list endpoint ([#5182](https://github.com/vm0-ai/vm0/issues/5182)) ([2b3d4ef](https://github.com/vm0-ai/vm0/commit/2b3d4ef87af7ba9831ffb34ba2a207d1114decc6))


### Bug Fixes

* improve slack connect flow with loading state, install DM, and org check ([#5153](https://github.com/vm0-ai/vm0/issues/5153)) ([6f4f1f5](https://github.com/vm0-ai/vm0/commit/6f4f1f57214216477ebdb4b53d01de4cca0c924c))


### Refactoring

* remove remaining org cache fallbacks from resolve-org ([#5159](https://github.com/vm0-ai/vm0/issues/5159)) ([88c118b](https://github.com/vm0-ai/vm0/commit/88c118b58746102ebb40d8ad711b59dd94bca5b1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.76.0

## [12.121.0](https://github.com/vm0-ai/vm0/compare/web-v12.120.0...web-v12.121.0) (2026-03-17)


### Features

* shared sentinel infrastructure + org-level model-provider service ([#5163](https://github.com/vm0-ai/vm0/issues/5163)) ([167d4dd](https://github.com/vm0-ai/vm0/commit/167d4dd7fd292ff6cae4c1b923244c5492153d38))


### Bug Fixes

* add /export to skip-i18n prefixes to prevent redirect 404 ([#5184](https://github.com/vm0-ai/vm0/issues/5184)) ([3bebef1](https://github.com/vm0-ai/vm0/commit/3bebef1f2dfbdb178530f50c0a9a93b5c4c6cc49)), closes [#5180](https://github.com/vm0-ai/vm0/issues/5180)
* **test:** stabilize flaky queue cleanup test ([#5165](https://github.com/vm0-ai/vm0/issues/5165)) ([6624167](https://github.com/vm0-ai/vm0/commit/66241676ac200528291535ddf08ba3acc40b529c))

## [12.120.0](https://github.com/vm0-ai/vm0/compare/web-v12.119.1...web-v12.120.0) (2026-03-17)


### Features

* add user settings ui for gdpr data export ([#5152](https://github.com/vm0-ai/vm0/issues/5152)) ([46c8c96](https://github.com/vm0-ai/vm0/commit/46c8c960ad1ab6969ba04b11fa61d1f914ea12d5))
* **platform:** add talk route for url-driven agent chat selection ([#5098](https://github.com/vm0-ai/vm0/issues/5098)) ([34b6800](https://github.com/vm0-ai/vm0/commit/34b68005429fcfbede85fed2d55e8f54fd7a9ae1))


### Refactoring

* remove default org fallback from resolveOrg ([#5121](https://github.com/vm0-ai/vm0/issues/5121)) ([28e56f5](https://github.com/vm0-ai/vm0/commit/28e56f5c603e9c7c5ac28ee684fb291d325c1ba0))
* return display name from logs api instead of frontend mapping ([#5150](https://github.com/vm0-ai/vm0/issues/5150)) ([92d7877](https://github.com/vm0-ai/vm0/commit/92d787709fabc58b557a807749cf9d261bac707b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.75.0

## [12.119.1](https://github.com/vm0-ai/vm0/compare/web-v12.119.0...web-v12.119.1) (2026-03-17)


### Bug Fixes

* pass through descriptive error messages in schedule deploy route ([#5140](https://github.com/vm0-ai/vm0/issues/5140)) ([b157d00](https://github.com/vm0-ai/vm0/commit/b157d0066e95771cce4f6a7be1277975fddb1653)), closes [#5071](https://github.com/vm0-ai/vm0/issues/5071)


### Refactoring

* consolidate org resolution into single function ([#5117](https://github.com/vm0-ai/vm0/issues/5117)) ([8ad5e87](https://github.com/vm0-ai/vm0/commit/8ad5e8713ce810d5e6b57f05dfe05fac0e2b791b))

## [12.119.0](https://github.com/vm0-ai/vm0/compare/web-v12.118.3...web-v12.119.0) (2026-03-17)


### Features

* add chat threads for instant sidebar and stable url routing ([#5102](https://github.com/vm0-ai/vm0/issues/5102)) ([c902c8c](https://github.com/vm0-ai/vm0/commit/c902c8c892f93e3496c94a5fda0e835b1957086d))
* add needs-reconnect flag for connector token refresh failures ([#5128](https://github.com/vm0-ai/vm0/issues/5128)) ([5da9c4e](https://github.com/vm0-ai/vm0/commit/5da9c4e15385589a41a49007dfc2b0009f58bbe8))
* **runner:** add experimental profile passthrough from compose to runner ([#5100](https://github.com/vm0-ai/vm0/issues/5100)) ([5eb8dd4](https://github.com/vm0-ai/vm0/commit/5eb8dd44baaa24ea40baf2804ec022a3d006528a)), closes [#5037](https://github.com/vm0-ai/vm0/issues/5037)


### Bug Fixes

* capture response body and structured context in oauth error diagnostics ([#5132](https://github.com/vm0-ai/vm0/issues/5132)) ([3e59a60](https://github.com/vm0-ai/vm0/commit/3e59a607778dc90f27ce81e402911990f04f18c1)), closes [#5125](https://github.com/vm0-ai/vm0/issues/5125)
* compare with zeroChatThreadId$ and add loading guard. ([c902c8c](https://github.com/vm0-ai/vm0/commit/c902c8c892f93e3496c94a5fda0e835b1957086d))


### Refactoring

* remove deprecated capability aliases ([#5135](https://github.com/vm0-ai/vm0/issues/5135)) ([c2680d3](https://github.com/vm0-ai/vm0/commit/c2680d3d06da36cda2c139b232641931c44f4400)), closes [#5130](https://github.com/vm0-ai/vm0/issues/5130)
* update vercel ai gateway to use anthropic/claude-sonnet-4.6 ([#5123](https://github.com/vm0-ai/vm0/issues/5123)) ([41a0442](https://github.com/vm0-ai/vm0/commit/41a0442039f6597963fa83bd8a4c0e799881ce8f)), closes [#5119](https://github.com/vm0-ai/vm0/issues/5119)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.74.0

## [12.118.3](https://github.com/vm0-ai/vm0/compare/web-v12.118.2...web-v12.118.3) (2026-03-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.73.0

## [12.118.2](https://github.com/vm0-ai/vm0/compare/web-v12.118.1...web-v12.118.2) (2026-03-17)


### Bug Fixes

* add missing linear oauth scopes and force consent prompt ([#5109](https://github.com/vm0-ai/vm0/issues/5109)) ([cfee675](https://github.com/vm0-ai/vm0/commit/cfee675ef64aa7226cccd8547c45be60cb38db53))
* add org-scoped filtering to run list and detail endpoints ([#5096](https://github.com/vm0-ai/vm0/issues/5096)) ([5641382](https://github.com/vm0-ai/vm0/commit/564138219e34cddfa02e0fa96bff5a3afdfa5516)), closes [#5091](https://github.com/vm0-ai/vm0/issues/5091)


### Refactoring

* remove all non-zero platform pages and feature flag ([#5095](https://github.com/vm0-ai/vm0/issues/5095)) ([fa7f011](https://github.com/vm0-ai/vm0/commit/fa7f01187b84d7046b150f46f217c191d5ad5670))
* route connector deep links to /zero/team/:name instead of /zero/meet ([#5023](https://github.com/vm0-ai/vm0/issues/5023)) ([42f5c63](https://github.com/vm0-ai/vm0/commit/42f5c63f7402081c7821597acb802820f4abb98b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.72.2

## [12.118.1](https://github.com/vm0-ai/vm0/compare/web-v12.118.0...web-v12.118.1) (2026-03-17)


### Bug Fixes

* prevent cross-org session access via org validation ([#5069](https://github.com/vm0-ai/vm0/issues/5069)) ([bfd8d49](https://github.com/vm0-ai/vm0/commit/bfd8d492faedb8e00e9ab07fef661f820051757d))


### Refactoring

* **core:** replace deprecated z.string().url() with z.url() ([#5077](https://github.com/vm0-ai/vm0/issues/5077)) ([a093545](https://github.com/vm0-ai/vm0/commit/a0935459d145e06d71ad91abce9e70d7e2d4210f))
* replace deprecated z.string().uuid() with z.uuid() ([#5076](https://github.com/vm0-ai/vm0/issues/5076)) ([a11783d](https://github.com/vm0-ai/vm0/commit/a11783dc38e5c5226a7110a0bf64e519971249f6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.72.1

## [12.118.0](https://github.com/vm0-ai/vm0/compare/web-v12.117.0...web-v12.118.0) (2026-03-16)


### Features

* improve zero page with markdown theming, avatar overrides, and navigation ([#5065](https://github.com/vm0-ai/vm0/issues/5065)) ([5ca5a04](https://github.com/vm0-ai/vm0/commit/5ca5a0441b1019516b7a64baa8ca695863581686))

## [12.117.0](https://github.com/vm0-ai/vm0/compare/web-v12.116.3...web-v12.117.0) (2026-03-16)


### Features

* add vercel ai gateway as staff-only model provider ([#5032](https://github.com/vm0-ai/vm0/issues/5032)) ([53b5845](https://github.com/vm0-ai/vm0/commit/53b5845a8903721ea0d6dbafcd2815641552f254)), closes [#5029](https://github.com/vm0-ai/vm0/issues/5029)
* constrain vercel ai gateway to moonshot provider with kimi-k2.5 model ([#5049](https://github.com/vm0-ai/vm0/issues/5049)) ([6ac1739](https://github.com/vm0-ai/vm0/commit/6ac1739e5d07ca86675a8b577b5f139a70ba6a07)), closes [#5048](https://github.com/vm0-ai/vm0/issues/5048)


### Refactoring

* align experimental_capabilities with resource model ([#5063](https://github.com/vm0-ai/vm0/issues/5063)) ([9d025ce](https://github.com/vm0-ai/vm0/commit/9d025ce6e43570242af0604181adb3047fe81370))
* merge run queue dequeue and execute into single advisory lock transaction ([#5035](https://github.com/vm0-ai/vm0/issues/5035)) ([716db53](https://github.com/vm0-ai/vm0/commit/716db53b225599a2f018ae3d7f96a2e69a78adb9))
* rename firewall array fields to plural form ([#5034](https://github.com/vm0-ai/vm0/issues/5034)) ([79bd167](https://github.com/vm0-ai/vm0/commit/79bd1675288e6a5a92acb6ef9c199099b9dd11bf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.72.0

## [12.116.3](https://github.com/vm0-ai/vm0/compare/web-v12.116.2...web-v12.116.3) (2026-03-16)


### Bug Fixes

* model provider auto-default, onboarding, profile save, and slack install flow ([#4967](https://github.com/vm0-ai/vm0/issues/4967)) ([5d6c132](https://github.com/vm0-ai/vm0/commit/5d6c1327f8f4f41fa44bf5753030db67867d0a75))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.71.3

## [12.116.2](https://github.com/vm0-ai/vm0/compare/web-v12.116.1...web-v12.116.2) (2026-03-16)


### Bug Fixes

* **auth:** pass capabilities to sandbox token in runner claim route ([#4994](https://github.com/vm0-ai/vm0/issues/4994)) ([bc44f98](https://github.com/vm0-ai/vm0/commit/bc44f9877340b3401ae6f99a555350c6808751e2)), closes [#4981](https://github.com/vm0-ai/vm0/issues/4981)
* normalize deprecated capability names to unified storage prefix ([#4996](https://github.com/vm0-ai/vm0/issues/4996)) ([c13cffa](https://github.com/vm0-ai/vm0/commit/c13cffa1d050dd1fe189ab5b20d05ae8663b7907))
* **test:** restore e2b mock in compose webhook complete test ([#4987](https://github.com/vm0-ai/vm0/issues/4987)) ([727ed18](https://github.com/vm0-ai/vm0/commit/727ed18dc424d1118d0ce9ce5c239baca8021635))


### Refactoring

* **auth:** remove unused storage type parameter from capability check ([#4998](https://github.com/vm0-ai/vm0/issues/4998)) ([5f38dcb](https://github.com/vm0-ai/vm0/commit/5f38dcbb822b6031330899099b7c846cca8cb460))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.71.2

## [12.116.1](https://github.com/vm0-ai/vm0/compare/web-v12.116.0...web-v12.116.1) (2026-03-16)


### Bug Fixes

* **auth:** return 403 instead of 401 for sandbox tokens with insufficient capabilities ([#4955](https://github.com/vm0-ai/vm0/issues/4955)) ([14f8a6c](https://github.com/vm0-ai/vm0/commit/14f8a6c2c7904f9ada120ce103ffc8d1c3b94a32))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.71.1

## [12.116.0](https://github.com/vm0-ai/vm0/compare/web-v12.115.0...web-v12.116.0) (2026-03-16)


### Features

* configurable send mode preference (enter vs cmd+enter) ([#4953](https://github.com/vm0-ai/vm0/issues/4953)) ([d8a43b8](https://github.com/vm0-ai/vm0/commit/d8a43b846595cf4beec259e50400e3d3ccd04a62))
* **firewall:** support github-hosted yaml firewall configs ([#4940](https://github.com/vm0-ai/vm0/issues/4940)) ([8f75e89](https://github.com/vm0-ai/vm0/commit/8f75e89c1d786242c4ce39880f032ccf9d118ef4)), closes [#4853](https://github.com/vm0-ai/vm0/issues/4853)


### Bug Fixes

* **slack:** remove documentation links from app home and help message ([#4958](https://github.com/vm0-ai/vm0/issues/4958)) ([471b148](https://github.com/vm0-ai/vm0/commit/471b14887813a2cd0b6c095f420b512827be9557))


### Refactoring

* merge volume/artifact/memory capabilities into storage:read and storage:write ([#4959](https://github.com/vm0-ai/vm0/issues/4959)) ([cc0c3b4](https://github.com/vm0-ai/vm0/commit/cc0c3b40c3c6a5a8a6167a46531fb1db16191341)), closes [#4956](https://github.com/vm0-ai/vm0/issues/4956)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.71.0

## [12.115.0](https://github.com/vm0-ai/vm0/compare/web-v12.114.2...web-v12.115.0) (2026-03-16)


### Features

* add org run queue visibility api and cli command ([#4946](https://github.com/vm0-ai/vm0/issues/4946)) ([18f877a](https://github.com/vm0-ai/vm0/commit/18f877a1a5987b2653d2ea363e255cc6239d1912))


### Bug Fixes

* use last-loadable pattern, filter orphan connectors, and flex run result schema ([#4943](https://github.com/vm0-ai/vm0/issues/4943)) ([f5c6234](https://github.com/vm0-ai/vm0/commit/f5c623434401b0265912b325ebb44afc25d92027))


### Refactoring

* remove leftover "shared agent" terminology from tests and comments ([#4950](https://github.com/vm0-ai/vm0/issues/4950)) ([f9a01ff](https://github.com/vm0-ai/vm0/commit/f9a01ffcfda2dc5edec86733e7a3db4ca5a070a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.70.0

## [12.114.2](https://github.com/vm0-ai/vm0/compare/web-v12.114.1...web-v12.114.2) (2026-03-16)


### Refactoring

* drop agent_permissions table and clean up ACL remnants ([#4945](https://github.com/vm0-ai/vm0/issues/4945)) ([6b38b53](https://github.com/vm0-ai/vm0/commit/6b38b53ffc1619e7285f6020e64f6487481ca540))
* rename concurrent run limit env var to cap semantics ([#4947](https://github.com/vm0-ai/vm0/issues/4947)) ([5012f62](https://github.com/vm0-ai/vm0/commit/5012f624a5c9b1c44e63526f6e37ea67e2d67667))

## [12.114.1](https://github.com/vm0-ai/vm0/compare/web-v12.114.0...web-v12.114.1) (2026-03-16)


### Bug Fixes

* activity detail auth alignment and platform team endpoint ([#4933](https://github.com/vm0-ai/vm0/issues/4933)) ([fbfdb1d](https://github.com/vm0-ai/vm0/commit/fbfdb1dff690271bdfb6927d4deca852439cf624))
* enforce sandbox capabilities on compose sub-routes ([#4934](https://github.com/vm0-ai/vm0/issues/4934)) ([8625747](https://github.com/vm0-ai/vm0/commit/86257472fcd06b12fcd9807878ca498f429ce4f2))


### Refactoring

* remove server-side acl permission system and shared agent ui ([#4881](https://github.com/vm0-ai/vm0/issues/4881)) ([123c1cf](https://github.com/vm0-ai/vm0/commit/123c1cf5dd28cb7e9b5980ad1dfc97d052b4ce8f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.69.1

## [12.114.0](https://github.com/vm0-ai/vm0/compare/web-v12.113.0...web-v12.114.0) (2026-03-16)


### Features

* add per-schedule notification control ([#4885](https://github.com/vm0-ai/vm0/issues/4885)) ([904cdfb](https://github.com/vm0-ai/vm0/commit/904cdfb0fd6f8ce241420b288cc43860ba1c55f0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.69.0

## [12.113.0](https://github.com/vm0-ai/vm0/compare/web-v12.112.0...web-v12.113.0) (2026-03-16)


### Features

* add model provider tracking and org-scoped logs/schedules ([#4909](https://github.com/vm0-ai/vm0/issues/4909)) ([dc0de67](https://github.com/vm0-ai/vm0/commit/dc0de673b2e78eec803a3051148f1947dc292945))
* **auth:** add opt-in capability parameter to auth context ([#4903](https://github.com/vm0-ai/vm0/issues/4903)) ([58383e2](https://github.com/vm0-ai/vm0/commit/58383e289eda65ec52a066f454ab76044964d6cf))
* **auth:** encode capabilities in sandbox jwt token payload ([#4884](https://github.com/vm0-ai/vm0/issues/4884)) ([93395d7](https://github.com/vm0-ai/vm0/commit/93395d7fcc541b67930d8863e549058a54fb2ab3))
* flow experimental_capabilities through execution context pipeline ([#4883](https://github.com/vm0-ai/vm0/issues/4883)) ([beeee92](https://github.com/vm0-ai/vm0/commit/beeee92b8c41bb8f46a232b4a248e4ecb3136111))
* revoke oauth token on disconnect and force re-consent ([#4906](https://github.com/vm0-ai/vm0/issues/4906)) ([86db8ac](https://github.com/vm0-ai/vm0/commit/86db8ac489659b7dfeead441550c9a1463c6e33c)), closes [#4891](https://github.com/vm0-ai/vm0/issues/4891)
* sync skills cache on web server startup ([#4901](https://github.com/vm0-ai/vm0/issues/4901)) ([8144eaa](https://github.com/vm0-ai/vm0/commit/8144eaa164be8d3096e384bd7836cee8b62680e8))


### Refactoring

* rename middleware to proxy for next.js 16 compatibility ([#4897](https://github.com/vm0-ai/vm0/issues/4897)) ([2f37390](https://github.com/vm0-ai/vm0/commit/2f373909fdc7657864a914a6a867762484521d56))
* rename service to firewall across entire codebase ([#4877](https://github.com/vm0-ai/vm0/issues/4877)) ([#4895](https://github.com/vm0-ai/vm0/issues/4895)) ([d40192b](https://github.com/vm0-ai/vm0/commit/d40192b6df5672d525dd39b9215a167ba42a3722))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.68.0

## [12.112.0](https://github.com/vm0-ai/vm0/compare/web-v12.111.4...web-v12.112.0) (2026-03-16)


### Features

* add experimental_capabilities to compose schema and types ([#4876](https://github.com/vm0-ai/vm0/issues/4876)) ([09d8080](https://github.com/vm0-ai/vm0/commit/09d8080a9d155eb24816272d9824289c0c15f290))
* **slack:** add platform ui for org-aware slack integration ([#4715](https://github.com/vm0-ai/vm0/issues/4715)) ([deb9179](https://github.com/vm0-ai/vm0/commit/deb9179480bd318d4b91e8b7a87354ffbaa89564))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.67.0

## [12.111.4](https://github.com/vm0-ai/vm0/compare/web-v12.111.3...web-v12.111.4) (2026-03-16)


### Refactoring

* **services:** unify secret template syntax to ${{ }} ([#4862](https://github.com/vm0-ai/vm0/issues/4862)) ([607e8e9](https://github.com/vm0-ai/vm0/commit/607e8e9be8eb83b60895898686ca94f711f6debb)), closes [#4806](https://github.com/vm0-ai/vm0/issues/4806)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.66.1

## [12.111.3](https://github.com/vm0-ai/vm0/compare/web-v12.111.2...web-v12.111.3) (2026-03-16)


### Bug Fixes

* point email unsubscribe link to web app instead of platform ([#4859](https://github.com/vm0-ai/vm0/issues/4859)) ([32e8ac2](https://github.com/vm0-ai/vm0/commit/32e8ac229ac111a7549d62abf0601e9a3666853e)), closes [#4858](https://github.com/vm0-ai/vm0/issues/4858)

## [12.111.2](https://github.com/vm0-ai/vm0/compare/web-v12.111.1...web-v12.111.2) (2026-03-16)


### Bug Fixes

* dispatch callbacks on timeout and cancel to prevent loop schedule stall ([#4851](https://github.com/vm0-ai/vm0/issues/4851)) ([9cc6cc2](https://github.com/vm0-ai/vm0/commit/9cc6cc21e146559959c56f905c5d8f84dfefc776))

## [12.111.1](https://github.com/vm0-ai/vm0/compare/web-v12.111.0...web-v12.111.1) (2026-03-15)


### Refactoring

* strengthen type safety in run status transition function ([#4843](https://github.com/vm0-ai/vm0/issues/4843)) ([d9f5f86](https://github.com/vm0-ai/vm0/commit/d9f5f86dc865729ed9fef385453f70dd5ea7ca1a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.66.0

## [12.111.0](https://github.com/vm0-ai/vm0/compare/web-v12.110.0...web-v12.111.0) (2026-03-15)


### Features

* server-side compose for platform mode — bypass e2b sandbox ([#4830](https://github.com/vm0-ai/vm0/issues/4830)) ([#4841](https://github.com/vm0-ai/vm0/issues/4841)) ([88fb052](https://github.com/vm0-ai/vm0/commit/88fb052366c75a9a47eae2ee949c665994b80bf7))

## [12.110.0](https://github.com/vm0-ai/vm0/compare/web-v12.109.0...web-v12.110.0) (2026-03-15)


### Features

* server-side instruction upload utility for direct S3 write ([#4838](https://github.com/vm0-ai/vm0/issues/4838)) ([5097676](https://github.com/vm0-ai/vm0/commit/5097676007e9e25761a1ad30d2eee3a25ba95ae5))


### Bug Fixes

* add heartbeat update during build-and-dispatch-run pipeline ([#4827](https://github.com/vm0-ai/vm0/issues/4827)) ([5b0f605](https://github.com/vm0-ai/vm0/commit/5b0f60555221afec557a7366fa4a46adf43aa3a2))
* align stale queue drain with per-org concurrency and preserve ttl on re-enqueue ([#4828](https://github.com/vm0-ai/vm0/issues/4828)) ([1a061d9](https://github.com/vm0-ai/vm0/commit/1a061d9bd6f2b8747265a0ef3d62f2179a6f88dd))
* **web:** add atomic run status transition guards to prevent race conditions ([#4829](https://github.com/vm0-ai/vm0/issues/4829)) ([6f1d29e](https://github.com/vm0-ai/vm0/commit/6f1d29e0324cd6cf857ddd72dd9414c11aa2c34c))


### Refactoring

* unify run queue operations from per-user to per-org ([#4837](https://github.com/vm0-ai/vm0/issues/4837)) ([a01526f](https://github.com/vm0-ai/vm0/commit/a01526f04785723dafcad0d2992e79a862247650)), closes [#4832](https://github.com/vm0-ai/vm0/issues/4832)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.65.1

## [12.109.0](https://github.com/vm0-ai/vm0/compare/web-v12.108.1...web-v12.109.0) (2026-03-15)


### Features

* **services:** add oauth token refresh and ttl caching to auth endpoint ([#4802](https://github.com/vm0-ai/vm0/issues/4802)) ([eab1747](https://github.com/vm0-ai/vm0/commit/eab17475db94fbbc8e5a4d8317851fb09fef28a9))

## [12.108.1](https://github.com/vm0-ai/vm0/compare/web-v12.108.0...web-v12.108.1) (2026-03-14)


### Bug Fixes

* **connector:** update token expiry after oauth refresh with accurate expires_in ([#4799](https://github.com/vm0-ai/vm0/issues/4799)) ([8bcd794](https://github.com/vm0-ai/vm0/commit/8bcd794beeba60763441ca2440a20a3de31157e9))
* skip malformed frontmatter in sync-skills instead of crashing ([#4804](https://github.com/vm0-ai/vm0/issues/4804)) ([b3a74c9](https://github.com/vm0-ai/vm0/commit/b3a74c93c11af2e6b14698115aed700c00e2c8b9)), closes [#4803](https://github.com/vm0-ai/vm0/issues/4803)

## [12.108.0](https://github.com/vm0-ai/vm0/compare/web-v12.107.0...web-v12.108.0) (2026-03-14)


### Features

* add cron job to sync official skills from github ([#4782](https://github.com/vm0-ai/vm0/issues/4782)) ([d2d8a1a](https://github.com/vm0-ai/vm0/commit/d2d8a1ac644a527ff79ad8ee5b6129c83ccf48ca))
* add skills resolve endpoint for instant skill lookup ([#4781](https://github.com/vm0-ai/vm0/issues/4781)) ([63070a1](https://github.com/vm0-ai/vm0/commit/63070a1010bda485314c3a0f275494347377b177))
* resolve skill volumes from system org with agent org fallback ([#4780](https://github.com/vm0-ai/vm0/issues/4780)) ([f8962f4](https://github.com/vm0-ai/vm0/commit/f8962f4d75adf905600a4fe9405bfa1f1a095ff2))
* **runner:** plumb secret-connector map from build to proxy addon ([#4764](https://github.com/vm0-ai/vm0/issues/4764)) ([dcde11d](https://github.com/vm0-ai/vm0/commit/dcde11dd12a1484e4050370848e51f8bd4a14946))


### Refactoring

* **connector:** extract token refresh to connector-service ([#4795](https://github.com/vm0-ai/vm0/issues/4795)) ([f42bfe9](https://github.com/vm0-ai/vm0/commit/f42bfe95682775ca406dc5b2d4848982860dfe40))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.65.0

## [12.107.0](https://github.com/vm0-ai/vm0/compare/web-v12.106.0...web-v12.107.0) (2026-03-14)


### Features

* add skills table and system org id constant ([#4770](https://github.com/vm0-ai/vm0/issues/4770)) ([68ebaeb](https://github.com/vm0-ai/vm0/commit/68ebaebafd0b9159e5c8218a32048af31e18b684)), closes [#4769](https://github.com/vm0-ai/vm0/issues/4769)


### Bug Fixes

* **compose:** pass org context to e2b compose job sandbox ([#4755](https://github.com/vm0-ai/vm0/issues/4755)) ([f1e0b66](https://github.com/vm0-ai/vm0/commit/f1e0b6678bb585de4d787f39240130f3ee6725e4)), closes [#4752](https://github.com/vm0-ai/vm0/issues/4752)
* **email:** pass explicit org context in email handlers ([#4762](https://github.com/vm0-ai/vm0/issues/4762)) ([81220ea](https://github.com/vm0-ai/vm0/commit/81220ea91db65ccf991c79ae6ce09d5ca93a2071))


### Refactoring

* consolidate org resolution into single resolve-org function ([#4761](https://github.com/vm0-ai/vm0/issues/4761)) ([5735e7e](https://github.com/vm0-ai/vm0/commit/5735e7e63ffb9822af8aeab211b74265266cc389))
* **web:** remove unused runid parameter from resolve-secrets-and-environment ([#4763](https://github.com/vm0-ai/vm0/issues/4763)) ([0a46058](https://github.com/vm0-ai/vm0/commit/0a46058336112fda33f949c7820b831e56ade8e1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.64.0

## [12.106.0](https://github.com/vm0-ai/vm0/compare/web-v12.105.0...web-v12.106.0) (2026-03-13)


### Features

* remove org_id from cli_tokens, use org_members_cache for verification ([#4723](https://github.com/vm0-ai/vm0/issues/4723)) ([0c47323](https://github.com/vm0-ai/vm0/commit/0c473236a096b720e612e8084e553eeecfbf6e0b))


### Bug Fixes

* **webhooks:** use run.orgid instead of re-resolving org via clerk api ([#4746](https://github.com/vm0-ai/vm0/issues/4746)) ([3cd8b73](https://github.com/vm0-ai/vm0/commit/3cd8b73f9f7d8bc25daf754c2a5c3994fb138245))
* **web:** replace check-then-insert with atomic upsert in variable and checkpoint services ([#4735](https://github.com/vm0-ai/vm0/issues/4735)) ([3b0dc8f](https://github.com/vm0-ai/vm0/commit/3b0dc8fff50cd9329266b14f4e7933eb52e8ec5d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.63.0

## [12.105.0](https://github.com/vm0-ai/vm0/compare/web-v12.104.0...web-v12.105.0) (2026-03-13)


### Features

* **email:** add unsubscribe headers, suppression table, and bounce/complaint webhook ([#4737](https://github.com/vm0-ai/vm0/issues/4737)) ([e349aaa](https://github.com/vm0-ai/vm0/commit/e349aaa68a9ed8ea37c6b7cc251170daaaca05c4))

## [12.104.0](https://github.com/vm0-ai/vm0/compare/web-v12.103.1...web-v12.104.0) (2026-03-13)


### Features

* **zero:** add pinned agents, agent switching, and per-agent sessions ([#4727](https://github.com/vm0-ai/vm0/issues/4727)) ([d3ee3af](https://github.com/vm0-ai/vm0/commit/d3ee3af19e34c583efc8f9b6b4da1bf48de9f0fb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.62.0

## [12.103.1](https://github.com/vm0-ai/vm0/compare/web-v12.103.0...web-v12.103.1) (2026-03-13)


### Refactoring

* clean up remaining scope terminology in comments, docs, and telemetry ([#4726](https://github.com/vm0-ai/vm0/issues/4726)) ([6f6c2cd](https://github.com/vm0-ai/vm0/commit/6f6c2cdbbd439f1c8b7b2c6277b8d89ed927ef3a))

## [12.103.0](https://github.com/vm0-ai/vm0/compare/web-v12.102.5...web-v12.103.0) (2026-03-13)


### Features

* **compose:** add permission validation and filtering for experimental_services ([#4680](https://github.com/vm0-ai/vm0/issues/4680)) ([05a8638](https://github.com/vm0-ai/vm0/commit/05a86380f0652f182a3b09b938b7417a5f1111e7))
* **services:** permission-based request matching in mitm_addon ([#4721](https://github.com/vm0-ai/vm0/issues/4721)) ([98267dd](https://github.com/vm0-ai/vm0/commit/98267ddeb6d01e7b9b1c4599ead7a9c173b67130))
* **slack:** add org-aware oauth install and callback routes ([#4702](https://github.com/vm0-ai/vm0/issues/4702)) ([38c8947](https://github.com/vm0-ai/vm0/commit/38c89479d1276e54e1e2b7eba6f247972c4d719b))
* **slack:** add org-aware slack database schema ([#4670](https://github.com/vm0-ai/vm0/issues/4670)) ([9fe8cf3](https://github.com/vm0-ai/vm0/commit/9fe8cf3f627b21d4ca8626705910498e16a667d4))
* **slack:** add org-aware slack integration ([#4706](https://github.com/vm0-ai/vm0/issues/4706)) ([8d4fe05](https://github.com/vm0-ai/vm0/commit/8d4fe050b7b6f94a20096dff0dd34c5be222df65))
* **web:** upgrade next.js to v16 with full turbopack migration ([#4707](https://github.com/vm0-ai/vm0/issues/4707)) ([da26f47](https://github.com/vm0-ai/vm0/commit/da26f47a3c5694f28ab8c06cef6f8796dac0d05d)), closes [#4685](https://github.com/vm0-ai/vm0/issues/4685)
* **web:** upgrade next.js to v16 with full turbopack migration ([#4708](https://github.com/vm0-ai/vm0/issues/4708)) ([b635331](https://github.com/vm0-ai/vm0/commit/b6353318d5a7bef9e21788b44c1a57bf12bea6c5)), closes [#4685](https://github.com/vm0-ai/vm0/issues/4685)


### Bug Fixes

* update platform to send ?org= and clean up remaining scope references ([#4690](https://github.com/vm0-ai/vm0/issues/4690)) ([3788240](https://github.com/vm0-ai/vm0/commit/37882409b710bea326429c5bf3cf5f2d944abfd2))
* **web:** filter secret values to only include environment-present values ([#4684](https://github.com/vm0-ai/vm0/issues/4684)) ([52adb87](https://github.com/vm0-ai/vm0/commit/52adb874545d52c57780a9c09f4fdac1612d8082))
* **web:** replace check-then-insert with atomic upsert in secret and connector services ([#4725](https://github.com/vm0-ai/vm0/issues/4725)) ([77188c8](https://github.com/vm0-ai/vm0/commit/77188c8bbcf30d1c0dad79f59d03b42d65f33337))


### Refactoring

* change experimental services from flat apis to nested service entries ([#4711](https://github.com/vm0-ai/vm0/issues/4711)) ([a7dbfc8](https://github.com/vm0-ai/vm0/commit/a7dbfc8a18e65350ef701628f1b3e6ed6837d282))
* eliminate remaining scope references ([#4703](https://github.com/vm0-ai/vm0/issues/4703)) ([fd85a3b](https://github.com/vm0-ai/vm0/commit/fd85a3b6b4f4fe10eb0ff36a1f5140888d9a57f1))
* eliminate scope references in web, platform, and tests ([#4700](https://github.com/vm0-ai/vm0/issues/4700)) ([7451fc6](https://github.com/vm0-ai/vm0/commit/7451fc6bcb062d1163179667fff656cc55c182e9)), closes [#4693](https://github.com/vm0-ai/vm0/issues/4693)
* fix remaining scope references in org route and test comments ([#4704](https://github.com/vm0-ai/vm0/issues/4704)) ([f1d622b](https://github.com/vm0-ai/vm0/commit/f1d622bfff712df045eeaf271c03c9a16a3bc942))
* rename remaining scope references to org in contracts ([#4695](https://github.com/vm0-ai/vm0/issues/4695)) ([9d4a05e](https://github.com/vm0-ai/vm0/commit/9d4a05e89cd28a98f3496149bdaf5f19e93207eb)), closes [#4688](https://github.com/vm0-ai/vm0/issues/4688)
* rename remaining scope variables and remove dead scope field ([#4687](https://github.com/vm0-ai/vm0/issues/4687)) ([e1a8995](https://github.com/vm0-ai/vm0/commit/e1a8995bf95ccc2d71f69a6b080304f1a39497af))
* rename scope wire format to org across all packages ([#4656](https://github.com/vm0-ai/vm0/issues/4656)) ([43ac1f3](https://github.com/vm0-ai/vm0/commit/43ac1f30220a0d285b639f35cacaac842bccd5ff))
* rename VOLUME_SCOPE_USER_ID to VOLUME_ORG_USER_ID with data migration ([#4697](https://github.com/vm0-ai/vm0/issues/4697)) ([4ab266c](https://github.com/vm0-ai/vm0/commit/4ab266cebf9096caa4718a452680e91a74000e36))
* update remaining scope comments to use org terminology ([#4720](https://github.com/vm0-ai/vm0/issues/4720)) ([bc1b969](https://github.com/vm0-ai/vm0/commit/bc1b96976fc83e3c21d7cfe51c6464fd785ea4a7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.61.0

## [12.102.5](https://github.com/vm0-ai/vm0/compare/web-v12.102.4...web-v12.102.5) (2026-03-13)


### Refactoring

* **web:** route model provider env vars through expansion ([#4674](https://github.com/vm0-ai/vm0/issues/4674)) ([f4bfb75](https://github.com/vm0-ai/vm0/commit/f4bfb7559796ab3a4b673a6f5d59aaa227aa74a9))

## [12.102.4](https://github.com/vm0-ai/vm0/compare/web-v12.102.3...web-v12.102.4) (2026-03-13)


### Refactoring

* rename export_jobs.clerk_org_id to org_id for consistency ([#4652](https://github.com/vm0-ai/vm0/issues/4652)) ([3bac035](https://github.com/vm0-ai/vm0/commit/3bac035db39cf617cc7217ad2c7718f855241f91))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.60.0

## [12.102.3](https://github.com/vm0-ai/vm0/compare/web-v12.102.2...web-v12.102.3) (2026-03-13)


### Refactoring

* **run:** unify secret merging into single map with explicit priority ([#4630](https://github.com/vm0-ai/vm0/issues/4630)) ([dc68069](https://github.com/vm0-ai/vm0/commit/dc68069b5d3df15e7c93be55257be3f94bf3f374)), closes [#4628](https://github.com/vm0-ai/vm0/issues/4628)
* update user-facing error messages from scope to org ([#4629](https://github.com/vm0-ai/vm0/issues/4629)) ([a1a9712](https://github.com/vm0-ai/vm0/commit/a1a9712f3f1bcaa71dba91ce23c7dc1f8acd6b6a))
* **web:** rename internal scope references in service layer to org ([#4645](https://github.com/vm0-ai/vm0/issues/4645)) ([1b83eb0](https://github.com/vm0-ai/vm0/commit/1b83eb0b87579eaed1ad5cd48f58d3b6e6da7760))
* **web:** rename internal scope references to org in route handlers and tests ([#4646](https://github.com/vm0-ai/vm0/issues/4646)) ([d74023a](https://github.com/vm0-ai/vm0/commit/d74023a1414ac5038936b7f808cffd9c16173f23))
* **web:** rename lib/scope directory to lib/org ([#4643](https://github.com/vm0-ai/vm0/issues/4643)) ([6c80e92](https://github.com/vm0-ai/vm0/commit/6c80e9227e2232cb9e2625cfd5cb91c009dfe108)), closes [#4636](https://github.com/vm0-ai/vm0/issues/4636)

## [12.102.2](https://github.com/vm0-ai/vm0/compare/web-v12.102.1...web-v12.102.2) (2026-03-12)


### Refactoring

* rename scope to org in test helpers and test descriptions ([#4619](https://github.com/vm0-ai/vm0/issues/4619)) ([a940c17](https://github.com/vm0-ai/vm0/commit/a940c17b49cab24219683ba4cb112453e30f95f0))
* **services:** addon encrypted-secrets passthrough and auth endpoint rewrite ([#4613](https://github.com/vm0-ai/vm0/issues/4613)) ([3f19c4c](https://github.com/vm0-ai/vm0/commit/3f19c4c87102a69aeb75ed2f3102904c9479d7e9))
* update scope to org in env.ts comment and resolve-default.ts logs ([#4612](https://github.com/vm0-ai/vm0/issues/4612)) ([b62840b](https://github.com/vm0-ai/vm0/commit/b62840b92d2d5c17a638131829051ab485003968))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.59.2

## [12.102.1](https://github.com/vm0-ai/vm0/compare/web-v12.102.0...web-v12.102.1) (2026-03-12)


### Refactoring

* rename internal scope terminology to org ([#4590](https://github.com/vm0-ai/vm0/issues/4590)) ([af7e338](https://github.com/vm0-ai/vm0/commit/af7e3381e4a50b34699642511583eccebe842240))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.59.1

## [12.102.0](https://github.com/vm0-ai/vm0/compare/web-v12.101.1...web-v12.102.0) (2026-03-12)


### Features

* **zero:** add recent chat sidebar, file attachments, and session switching ([#4582](https://github.com/vm0-ai/vm0/issues/4582)) ([d460861](https://github.com/vm0-ai/vm0/commit/d4608610fa4eda2ffa8ff53663187f430987283c))


### Bug Fixes

* add explicit file size limits to storage upload handlers ([#4586](https://github.com/vm0-ai/vm0/issues/4586)) ([d899fdb](https://github.com/vm0-ai/vm0/commit/d899fdbc23a30b5e586fa0755a22f0c4d6826d8b)), closes [#4576](https://github.com/vm0-ai/vm0/issues/4576)
* add zod validation to api routes using raw request.json() ([#4591](https://github.com/vm0-ai/vm0/issues/4591)) ([148b5e7](https://github.com/vm0-ai/vm0/commit/148b5e703f5f5ce277bd193d39e4a301a8fc6983)), closes [#4573](https://github.com/vm0-ai/vm0/issues/4573)
* resolve 9 semgrep code scanning alerts on main ([#4566](https://github.com/vm0-ai/vm0/issues/4566)) ([6564875](https://github.com/vm0-ai/vm0/commit/65648751ae9a7aa0c850fade8205a5f35e95639e))
* sanitize error responses to prevent information leakage ([#4587](https://github.com/vm0-ai/vm0/issues/4587)) ([681d050](https://github.com/vm0-ai/vm0/commit/681d050952d769ea4c287c6fbfbea1425ab8b8fc))


### Refactoring

* change encrypted-secrets from value array to key-value map ([#4584](https://github.com/vm0-ai/vm0/issues/4584)) ([9ec335a](https://github.com/vm0-ai/vm0/commit/9ec335a86832c4b2347232840c62d1ba55501591))
* drop scopes table (phase 6 🆉) ([#4578](https://github.com/vm0-ai/vm0/issues/4578)) ([de7ba9f](https://github.com/vm0-ai/vm0/commit/de7ba9fd49482f689c0cca4d8ff2b3976d03d3c7))
* remove experimental_mitm and always enable mitm when proxy is active ([#4568](https://github.com/vm0-ai/vm0/issues/4568)) ([34e1257](https://github.com/vm0-ai/vm0/commit/34e1257a96ceb70a50c07fa258a442c940b5ef95))
* remove sni mode dead code from network logging ([#4592](https://github.com/vm0-ai/vm0/issues/4592)) ([20a55a8](https://github.com/vm0-ai/vm0/commit/20a55a8cc7cfd5284b072ec945c23185a58d1d8f))
* **services:** expand service configs at compose stage with secret-name keyed placeholders ([#4548](https://github.com/vm0-ai/vm0/issues/4548)) ([519df6c](https://github.com/vm0-ai/vm0/commit/519df6cd8125971c7aa46a478e7bcd1e6731d59b))
* **services:** pass encrypted-secrets blob in claim response to runner ([#4599](https://github.com/vm0-ai/vm0/issues/4599)) ([ffdfe6e](https://github.com/vm0-ai/vm0/commit/ffdfe6e617cceb1823e700f3754aa55dde3d5def))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.59.0

## [12.101.1](https://github.com/vm0-ai/vm0/compare/web-v12.101.0...web-v12.101.1) (2026-03-12)


### Bug Fixes

* resolve semgrep error-level findings for compliance ([#4547](https://github.com/vm0-ai/vm0/issues/4547)) ([c3a20f2](https://github.com/vm0-ai/vm0/commit/c3a20f298654070e72785e06c8dfa1cd056b91a9)), closes [#4542](https://github.com/vm0-ai/vm0/issues/4542)
* **slack:** add ssrf protection warning log and integration tests ([#4556](https://github.com/vm0-ai/vm0/issues/4556)) ([c17b653](https://github.com/vm0-ai/vm0/commit/c17b65307ce5805d83e2b18818d9e19543aa98e6)), closes [#4553](https://github.com/vm0-ai/vm0/issues/4553)
* **test:** scope user_cache cleanup to prevent parallel test interference ([#4532](https://github.com/vm0-ai/vm0/issues/4532)) ([09d10c7](https://github.com/vm0-ai/vm0/commit/09d10c75e63855d4038f4f57f172f0dd9bcff96d)), closes [#4527](https://github.com/vm0-ai/vm0/issues/4527)


### Refactoring

* drop scope_id column from 9 tables (phase 6) ([#4551](https://github.com/vm0-ai/vm0/issues/4551)) ([4d454d0](https://github.com/vm0-ai/vm0/commit/4d454d02e45414c4c7efcb02afd84e880aeba5bb))
* drop scope_members table (phase 6) ([#4549](https://github.com/vm0-ai/vm0/issues/4549)) ([5d94776](https://github.com/vm0-ai/vm0/commit/5d9477621ff3e9627c5b08aa6f9ddd1c7e649c4e))
* remove proxy rewrite endpoint and seal secrets ([#4539](https://github.com/vm0-ai/vm0/issues/4539)) ([f7af830](https://github.com/vm0-ai/vm0/commit/f7af8301f67b87f4615dad8e9b8a00adb449aeba))
* reuse grouped message components in zero activity detail ([#4525](https://github.com/vm0-ai/vm0/issues/4525)) ([a6b4f1e](https://github.com/vm0-ai/vm0/commit/a6b4f1ec48f38b2156900d869cab3b5b24a42b39))
* **web:** simplify termly integration and add unsafe-eval to csp ([#4546](https://github.com/vm0-ai/vm0/issues/4546)) ([56402f1](https://github.com/vm0-ai/vm0/commit/56402f1d7167704a87a7fe3fe54673466e49cd90))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.58.3

## [12.101.0](https://github.com/vm0-ai/vm0/compare/web-v12.100.1...web-v12.101.0) (2026-03-12)


### Features

* implement async GDPR data export with R2 storage and email notification ([#4513](https://github.com/vm0-ai/vm0/issues/4513)) ([6f2ef29](https://github.com/vm0-ai/vm0/commit/6f2ef2909eae9bf97105f4bd391905abaa786ce2))
* **zero:** add settings page, deferred skill saving, and onboarding improvements ([#4511](https://github.com/vm0-ai/vm0/issues/4511)) ([7452cd8](https://github.com/vm0-ai/vm0/commit/7452cd8e6c99f66765e6346eface7305a25b6b5f))


### Bug Fixes

* add input validation and request-target safeguards for external integrations ([#4520](https://github.com/vm0-ai/vm0/issues/4520)) ([34464c9](https://github.com/vm0-ai/vm0/commit/34464c96e1dc311c47603e64a9f6106bb204a30d))
* resolve 5 codeql code scanning alerts ([#4533](https://github.com/vm0-ai/vm0/issues/4533)) ([948b7af](https://github.com/vm0-ai/vm0/commit/948b7afa72d0ecf95095a704ada241ed1bc2c3bb))
* **web:** use hmac instead of plain hash for scope slug generation ([#4530](https://github.com/vm0-ai/vm0/issues/4530)) ([72cf3db](https://github.com/vm0-ai/vm0/commit/72cf3dbe03a3b846ef9d9895e88e111cc55ffb11))


### Refactoring

* **auth:** remove scope-id from auth context types (5c-1) ([#4541](https://github.com/vm0-ai/vm0/issues/4541)) ([0c093af](https://github.com/vm0-ai/vm0/commit/0c093afb77b6ffe19923cb96593d5df8a4b7c725)), closes [#4536](https://github.com/vm0-ai/vm0/issues/4536)
* remove all scopes table runtime dependencies (5b-5) ([#4484](https://github.com/vm0-ai/vm0/issues/4484)) ([4cfbb5a](https://github.com/vm0-ai/vm0/commit/4cfbb5a164c79cec7768fc6d6dc91c141bb34705))
* remove residual scope-id writes and reads (5c-2) ([#4540](https://github.com/vm0-ai/vm0/issues/4540)) ([7512893](https://github.com/vm0-ai/vm0/commit/7512893a6da7bf90b738e1d5549617a7f24860aa)), closes [#4537](https://github.com/vm0-ai/vm0/issues/4537)
* **web:** use react component for termly consent management ([#4534](https://github.com/vm0-ai/vm0/issues/4534)) ([ae01372](https://github.com/vm0-ai/vm0/commit/ae0137246527dcaf1935a838985bd770235842db))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.58.2

## [12.100.1](https://github.com/vm0-ai/vm0/compare/web-v12.100.0...web-v12.100.1) (2026-03-12)


### Bug Fixes

* **web:** add quote character escaping to telegram html output ([#4515](https://github.com/vm0-ai/vm0/issues/4515)) ([759abbd](https://github.com/vm0-ai/vm0/commit/759abbdea0f2a5a807f8c9280972c4b76650d9b3))
* **web:** add worker-src CSP directive and disable termly autoBlock ([#4522](https://github.com/vm0-ai/vm0/issues/4522)) ([ab7340a](https://github.com/vm0-ai/vm0/commit/ab7340a4794f12bce2ba1df98fafc190b004d438))


### Refactoring

* add extract-and-group-variables convenience function ([#4517](https://github.com/vm0-ai/vm0/issues/4517)) ([fe13128](https://github.com/vm0-ai/vm0/commit/fe13128c1a0b0e619c9a585867c3d3f5f81e2f9b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.58.1

## [12.100.0](https://github.com/vm0-ai/vm0/compare/web-v12.99.1...web-v12.100.0) (2026-03-12)


### Features

* **web:** add cookie consent banner via termly ([#4514](https://github.com/vm0-ai/vm0/issues/4514)) ([dcce5c7](https://github.com/vm0-ai/vm0/commit/dcce5c7e5113849808c4d413aaa2969790ee7be3)), closes [#4509](https://github.com/vm0-ai/vm0/issues/4509)
* **zero:** enhance schedule management with toggle, calendar, and multi-day support ([#4374](https://github.com/vm0-ai/vm0/issues/4374)) ([75b1539](https://github.com/vm0-ai/vm0/commit/75b1539e929a2d83b858d88e77f7cf05df97c197))


### Bug Fixes

* address semgrep sast findings for casa tier 2 compliance ([#4487](https://github.com/vm0-ai/vm0/issues/4487)) ([e900299](https://github.com/vm0-ai/vm0/commit/e9002997cf58e7424344f6c494cac25faee07641)), closes [#4422](https://github.com/vm0-ai/vm0/issues/4422)


### Refactoring

* remove secret names from build context and resolvers ([#4493](https://github.com/vm0-ai/vm0/issues/4493)) ([b17f239](https://github.com/vm0-ai/vm0/commit/b17f239d4e11693f509ad4e609c66f195ca55bd5))
* remove secret names from execution context ([#4489](https://github.com/vm0-ai/vm0/issues/4489)) ([bc70477](https://github.com/vm0-ai/vm0/commit/bc704775200d97dac742f730cb93350609636006))
* replace scopes table reads with org_cache lookups (5b-4) ([#4453](https://github.com/vm0-ai/vm0/issues/4453)) ([c3561fb](https://github.com/vm0-ai/vm0/commit/c3561fba855a3ea2ee4d28ff8b3f7b76a894f175))
* simplify secrets variable in build context ([#4496](https://github.com/vm0-ai/vm0/issues/4496)) ([4010a26](https://github.com/vm0-ai/vm0/commit/4010a260e013003556a0221cb728d7ddbfddbe40))
* **web:** remove dead code and defensive try-catch in slack shared.ts ([#4478](https://github.com/vm0-ai/vm0/issues/4478)) ([626dab7](https://github.com/vm0-ai/vm0/commit/626dab726bc083b17ad0b4ef6e907b3a32c8adb3)), closes [#4436](https://github.com/vm0-ai/vm0/issues/4436)
* **web:** remove defensive catch in enrich-message-content ([#4470](https://github.com/vm0-ai/vm0/issues/4470)) ([5a672b9](https://github.com/vm0-ai/vm0/commit/5a672b96257b7e794ad4d76dd33b4d1fc73d338f))
* **web:** remove locale prefix from privacy-policy and terms-of-use routes ([#4501](https://github.com/vm0-ai/vm0/issues/4501)) ([97092ea](https://github.com/vm0-ai/vm0/commit/97092ea46218c6fa950f860951df5c852590d2fb)), closes [#4498](https://github.com/vm0-ai/vm0/issues/4498)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.58.0

## [12.99.1](https://github.com/vm0-ai/vm0/compare/web-v12.99.0...web-v12.99.1) (2026-03-11)


### Bug Fixes

* resolve 6 high dependency vulnerabilities ([#4428](https://github.com/vm0-ai/vm0/issues/4428)) ([052a1e6](https://github.com/vm0-ai/vm0/commit/052a1e6eba0205a3b3a67ef5be6cdeab727a1765)), closes [#4392](https://github.com/vm0-ai/vm0/issues/4392)
* sanitize api error responses to prevent information leakage ([#4426](https://github.com/vm0-ai/vm0/issues/4426)) ([916f9b8](https://github.com/vm0-ai/vm0/commit/916f9b83e387359a9c1246d57ecf250e9bb1ff55))


### Refactoring

* remove redundant experimental_runner from e2e tests ([#4431](https://github.com/vm0-ai/vm0/issues/4431)) ([e09c02b](https://github.com/vm0-ai/vm0/commit/e09c02bb55d2b30fe58f47e5d8b88775a986ed17))
* rename clerk identity fields to provider-agnostic names ([#4412](https://github.com/vm0-ai/vm0/issues/4412)) ([5595b54](https://github.com/vm0-ai/vm0/commit/5595b5447af0346c36094130e54dd060091f1600))
* stop populating scope_id in INSERT operations (5b-3) ([#4427](https://github.com/vm0-ai/vm0/issues/4427)) ([cba12ad](https://github.com/vm0-ai/vm0/commit/cba12ade6da8d6cdc4e8284a9607ae6bdb8a68d6))
* **web:** remove defensive try-catch in axiom client query ([#4433](https://github.com/vm0-ai/vm0/issues/4433)) ([b2a38c0](https://github.com/vm0-ai/vm0/commit/b2a38c0701309791fc68d60955939cff266487e5)), closes [#4432](https://github.com/vm0-ai/vm0/issues/4432)
* **web:** remove defensive try-catch in runner group token generation ([#4448](https://github.com/vm0-ai/vm0/issues/4448)) ([0a207b6](https://github.com/vm0-ai/vm0/commit/0a207b606cfe8b6aff587b80e46c5f1aec10082c)), closes [#4434](https://github.com/vm0-ai/vm0/issues/4434)

## [12.99.0](https://github.com/vm0-ai/vm0/compare/web-v12.98.0...web-v12.99.0) (2026-03-11)


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
* add user_cache table for caching clerk user data ([#4377](https://github.com/vm0-ai/vm0/issues/4377)) ([098e252](https://github.com/vm0-ai/vm0/commit/098e2528b797744bff9acf525280cd87dda348fc))
* add zapier api-token connector ([#4401](https://github.com/vm0-ai/vm0/issues/4401)) ([b1a7f52](https://github.com/vm0-ai/vm0/commit/b1a7f52da40763510e4b64014fd6f21025608387))
* inject agent metadata into instructions as frontmatter during compose ([#4382](https://github.com/vm0-ai/vm0/issues/4382)) ([c9e4c02](https://github.com/vm0-ai/vm0/commit/c9e4c02ce0bea2182f14269856f21222a5b0d94f))
* **platform:** add agent metadata and improve meet settings ([#4351](https://github.com/vm0-ai/vm0/issues/4351)) ([8e6a34c](https://github.com/vm0-ai/vm0/commit/8e6a34cbf5efecf52b94a4f495a174f2aa5f27ac))
* replace scope_members with clerk api in permission check ([#4343](https://github.com/vm0-ai/vm0/issues/4343)) ([c7d1ce8](https://github.com/vm0-ai/vm0/commit/c7d1ce892bc0c74130c8a14124e1db1d075d9d2d))


### Bug Fixes

* add security response headers for casa compliance ([#4403](https://github.com/vm0-ai/vm0/issues/4403)) ([d504851](https://github.com/vm0-ai/vm0/commit/d504851f2247c325d4fc10ff7d3e15c834a85044))
* merge compose job cleanup into per-minute cleanup-sandboxes cron ([#4354](https://github.com/vm0-ai/vm0/issues/4354)) ([74579bc](https://github.com/vm0-ai/vm0/commit/74579bc1885caec2d5994f75a933501d06f49210))


### Refactoring

* decouple service proxy config from connector concept ([#4388](https://github.com/vm0-ai/vm0/issues/4388)) ([b970b33](https://github.com/vm0-ai/vm0/commit/b970b33d97fc4f1cf825215e4b94ed182110c31f))
* make scope_id nullable in 8 dependent tables ([#4415](https://github.com/vm0-ai/vm0/issues/4415)) ([c7717bb](https://github.com/vm0-ai/vm0/commit/c7717bb4b184d25a7129c36b9b50d6c92f92aaf0))
* remove all scope_members reads/writes (phase 5b-2) ([#4416](https://github.com/vm0-ai/vm0/issues/4416)) ([1473ade](https://github.com/vm0-ai/vm0/commit/1473ade20a64f17fea4ebc47cdc2e679de1377a4))
* remove defensive catch-null patterns from org data lookups ([#4408](https://github.com/vm0-ai/vm0/issues/4408)) ([86e107d](https://github.com/vm0-ai/vm0/commit/86e107db33f4f4a032edd2ca01d3875d3e5d54cf))
* remove e2b executor and sandbox service ([#4365](https://github.com/vm0-ai/vm0/issues/4365)) ([8feb5cb](https://github.com/vm0-ai/vm0/commit/8feb5cbd65b55fdedb54ffeba498c458cf12af01))
* standardize connector secret names to use token convention ([#4385](https://github.com/vm0-ai/vm0/issues/4385)) ([470101f](https://github.com/vm0-ai/vm0/commit/470101f7612e95e8826653b33df819cf0de49b26))
* switch forward scope.slug reads to org_cache via getOrgData ([#4373](https://github.com/vm0-ai/vm0/issues/4373)) ([0aba471](https://github.com/vm0-ai/vm0/commit/0aba4712886f6d238783f9766afbdde07d35e68f))
* **web:** clean up defensive try/catch in web app ([#4370](https://github.com/vm0-ai/vm0/issues/4370)) ([707f4d6](https://github.com/vm0-ai/vm0/commit/707f4d64637df7fb93c91e0b4d08296156a25b1e)), closes [#4155](https://github.com/vm0-ai/vm0/issues/4155)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.57.0

## [12.98.0](https://github.com/vm0-ai/vm0/compare/web-v12.97.0...web-v12.98.0) (2026-03-11)


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
* add org_cache table and cache service for non-jwt contexts ([#4239](https://github.com/vm0-ai/vm0/issues/4239)) ([1fb745d](https://github.com/vm0-ai/vm0/commit/1fb745d5d5af2a88b249b7a608ccb176ef96c8b5))
* add wrike api-token connector ([#4340](https://github.com/vm0-ai/vm0/issues/4340)) ([ddd3785](https://github.com/vm0-ai/vm0/commit/ddd3785fc219ce6711ac246597b7880d3558f61d))
* **platform:** wire zero meet settings tab to real api ([#4192](https://github.com/vm0-ai/vm0/issues/4192)) ([b5f8525](https://github.com/vm0-ai/vm0/commit/b5f8525c560b692967359ee7f66c2490e4362e61))
* remove Clerk org creation from scope service ([#4240](https://github.com/vm0-ai/vm0/issues/4240)) ([191c048](https://github.com/vm0-ai/vm0/commit/191c0482a0b6c1d209d144d61bd5c38e271b5a8e))
* support org query param as alternative to scope slug ([#4237](https://github.com/vm0-ai/vm0/issues/4237)) ([f06a15b](https://github.com/vm0-ai/vm0/commit/f06a15b833d40b7b4066ad89365bf25bfab36655))
* switch user preferences read path to clerk jwt claims ([#4344](https://github.com/vm0-ai/vm0/issues/4344)) ([58113eb](https://github.com/vm0-ai/vm0/commit/58113eb88a8a31eefaef3acc1e268347d56e314d))


### Refactoring

* remove legacy credential concept entirely ([#4345](https://github.com/vm0-ai/vm0/issues/4345)) ([13919fe](https://github.com/vm0-ai/vm0/commit/13919fe66518807d6598a202033af74a562fbf0b))
* remove unused default flag from agent compose response ([#4348](https://github.com/vm0-ai/vm0/issues/4348)) ([bb36686](https://github.com/vm0-ai/vm0/commit/bb36686d533dd8fce1c51d364cd9705a60ab1898)), closes [#4337](https://github.com/vm0-ai/vm0/issues/4337)
* rename skill references from dev.to/fal.ai to devto/fal ([#4347](https://github.com/vm0-ai/vm0/issues/4347)) ([0b86ca4](https://github.com/vm0-ai/vm0/commit/0b86ca4e3a8aa9ec153c4c15f495450cab027be1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.56.0

## [12.97.0](https://github.com/vm0-ai/vm0/compare/web-v12.96.0...web-v12.97.0) (2026-03-11)


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

## [12.96.0](https://github.com/vm0-ai/vm0/compare/web-v12.95.0...web-v12.96.0) (2026-03-11)


### Features

* dual-write default agent compose id to clerk org metadata ([#4226](https://github.com/vm0-ai/vm0/issues/4226)) ([6c1814e](https://github.com/vm0-ai/vm0/commit/6c1814e3e404494a6a159381cf72466425d27676))

## [12.95.0](https://github.com/vm0-ai/vm0/compare/web-v12.94.0...web-v12.95.0) (2026-03-10)


### Features

* add pnpm runner command for local build and deploy ([#4198](https://github.com/vm0-ai/vm0/issues/4198)) ([3e84a76](https://github.com/vm0-ai/vm0/commit/3e84a76e9e1e782fbd431d90ffbff2265fa8d726))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.54.1

## [12.94.0](https://github.com/vm0-ai/vm0/compare/web-v12.93.0...web-v12.94.0) (2026-03-10)


### Features

* add agentmail connector (api-token only) ([#4181](https://github.com/vm0-ai/vm0/issues/4181)) ([72eb5b1](https://github.com/vm0-ai/vm0/commit/72eb5b1952fc7ef0119bcfe01edc047e0791676b))
* add axiom connector with api token auth ([#4182](https://github.com/vm0-ai/vm0/issues/4182)) ([d7586c4](https://github.com/vm0-ai/vm0/commit/d7586c4579e0d84fe618c4559c1b4c4621dc7a15))
* add plausible analytics connector ([#4178](https://github.com/vm0-ai/vm0/issues/4178)) ([da9b451](https://github.com/vm0-ai/vm0/commit/da9b4517edc58c3db5f200958db760680971e049))
* add productlane connector with api-token auth ([#4183](https://github.com/vm0-ai/vm0/issues/4183)) ([ea7f8db](https://github.com/vm0-ai/vm0/commit/ea7f8db0dd3fae77091c97155d9524d587ccdb5c))
* add resend connector with api key authentication ([#4191](https://github.com/vm0-ai/vm0/issues/4191)) ([dc32ab8](https://github.com/vm0-ai/vm0/commit/dc32ab88eeb0c4f052458b5f3ab094bb7bf46b53))
* wire zero onboarding to real api calls ([#4128](https://github.com/vm0-ai/vm0/issues/4128)) ([b756f8a](https://github.com/vm0-ai/vm0/commit/b756f8aab13d8b5ebf5e8383e96538fd0d980d61))


### Refactoring

* resolve scope from Clerk API instead of scope_members table ([#4124](https://github.com/vm0-ai/vm0/issues/4124)) ([4996b04](https://github.com/vm0-ai/vm0/commit/4996b04e895eae6082ce7ca2661291b2b21c38d5))
* switch secrets, connectors, model_providers, agent_schedules from scope_id to clerk_org_id ([#4199](https://github.com/vm0-ai/vm0/issues/4199)) ([fa78d86](https://github.com/vm0-ai/vm0/commit/fa78d86c8c02ac86d17b40c3a75184c5c3e23019))
* switch storages table from scope_id to clerk_org_id ([#4142](https://github.com/vm0-ai/vm0/issues/4142)) ([52ef417](https://github.com/vm0-ai/vm0/commit/52ef417d4f89486a203ea96a4641031568e9ef3b))
* switch variables table from scope_id to clerk_org_id ([#4138](https://github.com/vm0-ai/vm0/issues/4138)) ([609f7c1](https://github.com/vm0-ai/vm0/commit/609f7c1d84c3d20238be1f75ac3beba39b8a971a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.54.0

## [12.93.0](https://github.com/vm0-ai/vm0/compare/web-v12.92.0...web-v12.93.0) (2026-03-10)


### Features

* **connectors:** implement proxy-side auth header injection for experimental connectors ([#4072](https://github.com/vm0-ai/vm0/issues/4072)) ([dabc986](https://github.com/vm0-ai/vm0/commit/dabc986158c0d98068a06599724da3307a4904f7))
* **platform:** add account switching and org switcher to zero sidebar ([#4139](https://github.com/vm0-ai/vm0/issues/4139)) ([17ecf9d](https://github.com/vm0-ai/vm0/commit/17ecf9d7cb154bb05bf065fa2489bab959196257))


### Refactoring

* standardize connector api-token secret naming and clean up env ([#4148](https://github.com/vm0-ai/vm0/issues/4148)) ([f3400fe](https://github.com/vm0-ai/vm0/commit/f3400fef2cb68a6ca911b61b09e3ca9db8825ec4))
* standardize connector api-token secret naming convention ([#4137](https://github.com/vm0-ai/vm0/issues/4137)) ([cc32c55](https://github.com/vm0-ai/vm0/commit/cc32c55527d76f5d7d8e83090d3bbfa06858ea5c))
* switch agent_composes queries from scope_id to clerk_org_id ([#4145](https://github.com/vm0-ai/vm0/issues/4145)) ([add49fa](https://github.com/vm0-ai/vm0/commit/add49fad002a108981e35c11b731f06b1869145d))
* switch agent_runs queries from scope_id to clerk_org_id ([#4143](https://github.com/vm0-ai/vm0/issues/4143)) ([265907d](https://github.com/vm0-ai/vm0/commit/265907dfaeb652e47c5c2030733203b4db4fe49f))
* treat api-token connector secrets as user secrets ([#4156](https://github.com/vm0-ai/vm0/issues/4156)) ([d12f5f6](https://github.com/vm0-ai/vm0/commit/d12f5f6060519514b316a6b126e5b30915ae54a1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.53.0

## [12.92.0](https://github.com/vm0-ai/vm0/compare/web-v12.91.0...web-v12.92.0) (2026-03-10)


### Features

* add ahrefs connector with api-token and oauth auth methods ([#4113](https://github.com/vm0-ai/vm0/issues/4113)) ([5c282b8](https://github.com/vm0-ai/vm0/commit/5c282b80719758dc0734f9c59d525934b03a366f))
* add mailchimp connector with oauth and api key auth ([#4116](https://github.com/vm0-ai/vm0/issues/4116)) ([eb72755](https://github.com/vm0-ai/vm0/commit/eb72755110adfe18e7f90ac07ecd59cc6038fe9f))
* add similarweb connector with api key authentication ([#4106](https://github.com/vm0-ai/vm0/issues/4106)) ([ae97fdb](https://github.com/vm0-ai/vm0/commit/ae97fdb399f28100780ca232e3023ff2f31a61b9))


### Refactoring

* add clerk_org_id column to all scope-dependent tables ([#4105](https://github.com/vm0-ai/vm0/issues/4105)) ([c8abd1d](https://github.com/vm0-ai/vm0/commit/c8abd1d2d9cce2465f49a99815c0362dddb14469))
* remove scope_members writes from member management operations ([#4118](https://github.com/vm0-ai/vm0/issues/4118)) ([c26e055](https://github.com/vm0-ai/vm0/commit/c26e055d297405e6d37660451070eab09317608d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.52.0

## [12.91.0](https://github.com/vm0-ai/vm0/compare/web-v12.90.0...web-v12.91.0) (2026-03-10)


### Features

* **scope:** add default agent compose field to scopes ([#4067](https://github.com/vm0-ai/vm0/issues/4067)) ([529b7fd](https://github.com/vm0-ai/vm0/commit/529b7fd3c559342c0eaba5c307ab0b879c5442d5))


### Bug Fixes

* allow shared agent detail access without scope membership ([#4069](https://github.com/vm0-ai/vm0/issues/4069)) ([9f596ab](https://github.com/vm0-ai/vm0/commit/9f596ab936674520e79a9c5e66b530547d972d7d))
* **slack:** add logs link to dispatch failure error messages ([#4068](https://github.com/vm0-ai/vm0/issues/4068)) ([6ddf062](https://github.com/vm0-ai/vm0/commit/6ddf0626aac73f43bc4ece64b076c73045e6902e))
* **web:** use clerk v6 redirect props for cross-domain sign-in ([#4109](https://github.com/vm0-ai/vm0/issues/4109)) ([c065eff](https://github.com/vm0-ai/vm0/commit/c065effdbca363b367b4e8326078184ed8ef8c95))


### Refactoring

* align remaining scope terminology with resource model ([#4094](https://github.com/vm0-ai/vm0/issues/4094)) ([e4df6c9](https://github.com/vm0-ai/vm0/commit/e4df6c96f84ef0e0e1393215a08122bf83a73a21))
* dual-write scope metadata to clerk org and membership metadata ([#4103](https://github.com/vm0-ai/vm0/issues/4103)) ([c2065a4](https://github.com/vm0-ai/vm0/commit/c2065a489b1317a653a33644e9d7ad992aee2dce)), closes [#4100](https://github.com/vm0-ai/vm0/issues/4100)
* **run:** remove unused return field from expand environment ([#4104](https://github.com/vm0-ai/vm0/issues/4104)) ([42df1e6](https://github.com/vm0-ai/vm0/commit/42df1e6abea11997b00ccd6a01825b1d2c9f85a1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.51.0

## [12.90.0](https://github.com/vm0-ai/vm0/compare/web-v12.89.0...web-v12.90.0) (2026-03-09)


### Features

* add close crm connector integration ([#4056](https://github.com/vm0-ai/vm0/issues/4056)) ([08134ea](https://github.com/vm0-ai/vm0/commit/08134ea6a8e90139eb55ed776e75b0ce3d97869f))
* add multi-auth method support for connectors ([#4053](https://github.com/vm0-ai/vm0/issues/4053)) ([b89cbdc](https://github.com/vm0-ai/vm0/commit/b89cbdcac841824b20feb93c50afdfb216a1d9ff))
* add outlook calendar connector with microsoft oauth ([#4059](https://github.com/vm0-ai/vm0/issues/4059)) ([5a6572d](https://github.com/vm0-ai/vm0/commit/5a6572d01028177e22215646eb9c32ab28464343))
* **scope:** auto-detect clerk org id in resolve-scope for platform requests ([#4083](https://github.com/vm0-ai/vm0/issues/4083)) ([0100f91](https://github.com/vm0-ai/vm0/commit/0100f917696a62d66c3e599f6ae1921c544efb31)), closes [#4076](https://github.com/vm0-ai/vm0/issues/4076)


### Refactoring

* align scope naming with resource model terminology ([#4088](https://github.com/vm0-ai/vm0/issues/4088)) ([cdc7738](https://github.com/vm0-ai/vm0/commit/cdc77383757a4a32d2acd8af08f3b090be06d322))
* remove self-hosting feature and restore saas-only mode ([#4051](https://github.com/vm0-ai/vm0/issues/4051)) ([5dcac9d](https://github.com/vm0-ai/vm0/commit/5dcac9d3374e78eb263d180faef9ee2909e34dcb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.50.0

## [12.89.0](https://github.com/vm0-ai/vm0/compare/web-v12.88.0...web-v12.89.0) (2026-03-09)


### Features

* add asana oauth connector integration ([#4066](https://github.com/vm0-ai/vm0/issues/4066)) ([488c35d](https://github.com/vm0-ai/vm0/commit/488c35d1bf8ff0fdf60730f5989c39c8433d1ba2))
* add meta ads oauth connector integration ([#4058](https://github.com/vm0-ai/vm0/issues/4058)) ([f887225](https://github.com/vm0-ai/vm0/commit/f88722560ef6cc5a06259a783f3cad7cc3b65861))
* add stripe oauth connector integration ([#4054](https://github.com/vm0-ai/vm0/issues/4054)) ([c9927fc](https://github.com/vm0-ai/vm0/commit/c9927fc1ec08bd4a46f3a10770610ed4979caf2d))


### Bug Fixes

* resolve model provider from runner's scope in integration handlers ([#4075](https://github.com/vm0-ai/vm0/issues/4075)) ([fc53218](https://github.com/vm0-ai/vm0/commit/fc53218e4787d0a6a97c501507e5cfa99524f46f))
* **telegram:** make /start prompt login same as /connect ([#4060](https://github.com/vm0-ai/vm0/issues/4060)) ([0a4d138](https://github.com/vm0-ai/vm0/commit/0a4d138cdef7b3abea0cc2a5cf9a1a7cc7b1499c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.49.0

## [12.88.0](https://github.com/vm0-ai/vm0/compare/web-v12.87.0...web-v12.88.0) (2026-03-09)


### Features

* **connectors:** add experimental connectors data pipeline ([#4048](https://github.com/vm0-ai/vm0/issues/4048)) ([f3ad976](https://github.com/vm0-ai/vm0/commit/f3ad976c82d86300636b545aa8b5b23c6ebfc744))
* **schedule:** associate schedules with scope and user identity for cross-scope sharing ([#4011](https://github.com/vm0-ai/vm0/issues/4011)) ([ac3e58b](https://github.com/vm0-ai/vm0/commit/ac3e58b100d7b272b54abc2e1ec962b40652f0d2))
* **scope:** extend resolve-scope to support clerk org id resolution ([#4047](https://github.com/vm0-ai/vm0/issues/4047)) ([9933100](https://github.com/vm0-ai/vm0/commit/993310046b13d62571dd4cba6d4ba342e11452eb))


### Bug Fixes

* **blog:** handle empty and invalid json responses from strapi api ([#4045](https://github.com/vm0-ai/vm0/issues/4045)) ([f481ed7](https://github.com/vm0-ai/vm0/commit/f481ed76eddd87d0bfbb3df13da3b35f652d466c))
* **blog:** handle truncated json responses from strapi cms ([#4044](https://github.com/vm0-ai/vm0/issues/4044)) ([cbb66a6](https://github.com/vm0-ai/vm0/commit/cbb66a6e64ff47f1c6f80e7e9e4daa888eda46fc))


### Refactoring

* **scope:** discover existing clerk orgs via jit api instead of creating new ones ([#4049](https://github.com/vm0-ai/vm0/issues/4049)) ([fdfb9c7](https://github.com/vm0-ai/vm0/commit/fdfb9c7bc14fb90c67215cd42042cb5e065bda8d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.48.0

## [12.87.0](https://github.com/vm0-ai/vm0/compare/web-v12.86.0...web-v12.87.0) (2026-03-09)


### Features

* add scope lookup by clerk organization id ([#4038](https://github.com/vm0-ai/vm0/issues/4038)) ([ff30ea5](https://github.com/vm0-ai/vm0/commit/ff30ea554c6b819dc16dcba5db42139debfd351d)), closes [#4033](https://github.com/vm0-ai/vm0/issues/4033)
* **auth:** extract org id and org slug from clerk auth session ([#4037](https://github.com/vm0-ai/vm0/issues/4037)) ([9db9814](https://github.com/vm0-ai/vm0/commit/9db981402347408663276c52b70f479e6bc7692f)), closes [#4034](https://github.com/vm0-ai/vm0/issues/4034)
* **env:** auto-configure runner group in sync-env.sh ([#4039](https://github.com/vm0-ai/vm0/issues/4039)) ([6300d32](https://github.com/vm0-ai/vm0/commit/6300d326323660ad183e882479c90024ae9691ef))
* **telegram:** manage queued message lifecycle via thinking message ([#4029](https://github.com/vm0-ai/vm0/issues/4029)) ([dff5984](https://github.com/vm0-ai/vm0/commit/dff598453b71ed98e12b8e5b6e3eee062b07026f))


### Bug Fixes

* add database-backed email outbox queue for rate limit resilience ([#3964](https://github.com/vm0-ai/vm0/issues/3964)) ([fc14d62](https://github.com/vm0-ai/vm0/commit/fc14d62cd9941b36ef6e42fe41cacacee9758b81))
* **run:** use runtime scope for artifact/memory storage instead of user default ([#4030](https://github.com/vm0-ai/vm0/issues/4030)) ([40f8a98](https://github.com/vm0-ai/vm0/commit/40f8a981ff9eee7bce2a69ee61f3147dcd0d2928)), closes [#4026](https://github.com/vm0-ai/vm0/issues/4026)


### Refactoring

* remove one-admin-per-user constraint from scope creation ([#4036](https://github.com/vm0-ai/vm0/issues/4036)) ([e7e8c95](https://github.com/vm0-ai/vm0/commit/e7e8c959e194b3d6915df93bcc20921606b9ab77)), closes [#4032](https://github.com/vm0-ai/vm0/issues/4032)

## [12.86.0](https://github.com/vm0-ai/vm0/compare/web-v12.85.2...web-v12.86.0) (2026-03-09)


### Features

* **scope:** add max tier to three-tier concurrency system ([#3981](https://github.com/vm0-ai/vm0/issues/3981)) ([573d124](https://github.com/vm0-ai/vm0/commit/573d12423cff1d56c81b79c5c01b2866dfee3c99))
* **storage:** add user-scope isolation for artifacts and memory ([#3996](https://github.com/vm0-ai/vm0/issues/3996)) ([94525c0](https://github.com/vm0-ai/vm0/commit/94525c00b5f14694a8f83ad48e92632ede7756d3))


### Bug Fixes

* auto-create scope for new web users and consolidate scope init logic ([#4005](https://github.com/vm0-ai/vm0/issues/4005)) ([9ae59f5](https://github.com/vm0-ai/vm0/commit/9ae59f501d31f15bcb89c4f405061d83e3166ac7))
* **telegram:** include reply context in bot mentions and DMs ([#4014](https://github.com/vm0-ai/vm0/issues/4014)) ([6b88d63](https://github.com/vm0-ai/vm0/commit/6b88d636dcdb3849335d3673c0befb13094ff688))
* **web:** reject invalid locale segments in middleware ([#4016](https://github.com/vm0-ai/vm0/issues/4016)) ([7730571](https://github.com/vm0-ai/vm0/commit/773057121d902534d488b991e1b183ec0d9c7f6f))


### Refactoring

* extract integration context builder into shared helper and add tests ([#4008](https://github.com/vm0-ai/vm0/issues/4008)) ([102c372](https://github.com/vm0-ai/vm0/commit/102c37278f659b3595553985ea08019b675189b8))
* rename "View logs" to "Audit" across notification channels ([#4020](https://github.com/vm0-ai/vm0/issues/4020)) ([1af2023](https://github.com/vm0-ai/vm0/commit/1af20239aa490b75f163c19a1e71bb4a5d497e70))
* **run:** remove domain-based rollout gate from runner dispatch ([#4013](https://github.com/vm0-ai/vm0/issues/4013)) ([ec9da91](https://github.com/vm0-ai/vm0/commit/ec9da916d76061e03918ab0d4da7962c0efa54cb)), closes [#4012](https://github.com/vm0-ai/vm0/issues/4012)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.47.0

## [12.85.2](https://github.com/vm0-ai/vm0/compare/web-v12.85.1...web-v12.85.2) (2026-03-09)


### Bug Fixes

* **slack:** allow file_share subtype in dm event filter ([#3980](https://github.com/vm0-ai/vm0/issues/3980)) ([d4c4844](https://github.com/vm0-ai/vm0/commit/d4c4844427cf83e54b921da47f9bc8de73c32bc0))
* **telegram:** improve reliability, security, and add image support ([#3949](https://github.com/vm0-ai/vm0/issues/3949)) ([8990fd9](https://github.com/vm0-ai/vm0/commit/8990fd915c2bb04cfcd9a568fe10f872da1503f6))


### Refactoring

* **run:** remove e2b executor from dispatch logic ([#3951](https://github.com/vm0-ai/vm0/issues/3951)) ([212b8da](https://github.com/vm0-ai/vm0/commit/212b8da09fc719310ce427856b16a07d69e6d1a8))

## [12.85.1](https://github.com/vm0-ai/vm0/compare/web-v12.85.0...web-v12.85.1) (2026-03-09)


### Bug Fixes

* **email:** add missing progress status guard to trigger and schedule callbacks ([#3971](https://github.com/vm0-ai/vm0/issues/3971)) ([3c6e38d](https://github.com/vm0-ai/vm0/commit/3c6e38df3cdd7acb6c39d6b03469851d1e95ebe1)), closes [#3970](https://github.com/vm0-ai/vm0/issues/3970)
* **web:** disable sentry error reporting in preview deployments ([#3975](https://github.com/vm0-ai/vm0/issues/3975)) ([f27c79d](https://github.com/vm0-ai/vm0/commit/f27c79d73ecd99c240037f53eb40281e69725ba9))


### CI

* remove e2e 02-parallel test suite and ci job ([#3977](https://github.com/vm0-ai/vm0/issues/3977)) ([16feb8b](https://github.com/vm0-ai/vm0/commit/16feb8bd5d7f22093c6b2573b59d3ee57af7d7d7))

## [12.85.0](https://github.com/vm0-ai/vm0/compare/web-v12.84.0...web-v12.85.0) (2026-03-09)


### Features

* **cli:** add vm0 logs search subcommand ([#3845](https://github.com/vm0-ai/vm0/issues/3845)) ([b3e0b4d](https://github.com/vm0-ai/vm0/commit/b3e0b4deda133396223b1e1b5b3d043454451144))
* **slack:** support file attachments and inject user info into prompts ([#3948](https://github.com/vm0-ai/vm0/issues/3948)) ([f7e1ddd](https://github.com/vm0-ai/vm0/commit/f7e1ddd31d77a5aab354456b30f38c702d1f65d4))


### Bug Fixes

* **storage:** unify memory storage auto-creation with artifact pattern ([#3944](https://github.com/vm0-ai/vm0/issues/3944)) ([e2af883](https://github.com/vm0-ai/vm0/commit/e2af88330c3bf305c1586ffd4315dff19a4e7504))
* use upsert for storage prepare to prevent race condition ([#3946](https://github.com/vm0-ai/vm0/issues/3946)) ([1cba856](https://github.com/vm0-ai/vm0/commit/1cba85668aeb351fb4445f3f5764c959055a83ec))
* **web:** filter browser extension errors in sentry config ([#3963](https://github.com/vm0-ai/vm0/issues/3963)) ([d556bf2](https://github.com/vm0-ai/vm0/commit/d556bf269dcba631315009cb410f97f31fc608b2))


### Refactoring

* **scope:** eliminate org layer and consolidate into scope ([#3901](https://github.com/vm0-ai/vm0/issues/3901)) ([622fc9d](https://github.com/vm0-ai/vm0/commit/622fc9db32ded7ad82da013550c9c5c9cbc0f283))
* **telegram:** deduplicate connect url construction into shared helper ([#3958](https://github.com/vm0-ai/vm0/issues/3958)) ([90416d0](https://github.com/vm0-ai/vm0/commit/90416d00a2864823d1d1087321d16f84d09147a4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.46.0

## [12.84.0](https://github.com/vm0-ai/vm0/compare/web-v12.83.0...web-v12.84.0) (2026-03-07)


### Features

* hardcode memory name convention in slack, telegram, and email handlers ([#3899](https://github.com/vm0-ai/vm0/issues/3899)) ([5d543f1](https://github.com/vm0-ai/vm0/commit/5d543f1c1f7e1ae5a6b7f9f5f2bd293948cfd23b))

## [12.83.0](https://github.com/vm0-ai/vm0/compare/web-v12.82.2...web-v12.83.0) (2026-03-07)


### Features

* add --memory flag for agent long-term memory ([#3424](https://github.com/vm0-ai/vm0/issues/3424)) ([9e0279f](https://github.com/vm0-ai/vm0/commit/9e0279f618efe5396dda9e1aaac43a72bba70bfe))
* add webflow oauth connector ([#3883](https://github.com/vm0-ai/vm0/issues/3883)) ([2024d3e](https://github.com/vm0-ai/vm0/commit/2024d3e0f570980a48685851dc1f20e93dada88c))


### Bug Fixes

* **connectors:** fix wix token exchange to use form-encoded body ([#3887](https://github.com/vm0-ai/vm0/issues/3887)) ([d324ed2](https://github.com/vm0-ai/vm0/commit/d324ed214bb01c3f1fba6f5339fdec95a59e363b))


### Refactoring

* replace scope role type assertions with runtime validation ([#3885](https://github.com/vm0-ai/vm0/issues/3885)) ([63277f3](https://github.com/vm0-ai/vm0/commit/63277f3c1cb5ab457bb0032cddf805af59416f27))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.45.0

## [12.82.2](https://github.com/vm0-ai/vm0/compare/web-v12.82.1...web-v12.82.2) (2026-03-07)


### Bug Fixes

* add cascade foreign keys to enable scope deletion ([#3846](https://github.com/vm0-ai/vm0/issues/3846)) ([9cb668c](https://github.com/vm0-ai/vm0/commit/9cb668c7a2e5a871259e2e60c06b4b385ef5f6d6))
* use server-computed connector-provided secret names in compose warning ([#3843](https://github.com/vm0-ai/vm0/issues/3843)) ([b66c877](https://github.com/vm0-ai/vm0/commit/b66c87774aa6fd21c73878026f3d0f2e7420928b))


### Refactoring

* unify scope creation and migrate org endpoints ([#3847](https://github.com/vm0-ai/vm0/issues/3847)) ([df5317c](https://github.com/vm0-ai/vm0/commit/df5317cd3eb171eaaf1f19148db58a754a68bf5e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.44.1

## [12.82.1](https://github.com/vm0-ai/vm0/compare/web-v12.82.0...web-v12.82.1) (2026-03-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.44.0

## [12.82.0](https://github.com/vm0-ai/vm0/compare/web-v12.81.0...web-v12.82.0) (2026-03-07)


### Features

* **connectors:** add canva oauth connector ([#3837](https://github.com/vm0-ai/vm0/issues/3837)) ([522fe59](https://github.com/vm0-ai/vm0/commit/522fe59a0dc16478ee97907c8f143e98579635c4))
* **connectors:** add hubspot oauth connector ([#3835](https://github.com/vm0-ai/vm0/issues/3835)) ([1cc3e37](https://github.com/vm0-ai/vm0/commit/1cc3e3795879b7a3988ec999ef16bca0cecd5ee9))
* **connectors:** add supabase oauth connector ([#3836](https://github.com/vm0-ai/vm0/issues/3836)) ([b7c2d2e](https://github.com/vm0-ai/vm0/commit/b7c2d2e5146de7c429113c07291886afbd1ec7b5))
* **connectors:** add todoist oauth connector ([#3850](https://github.com/vm0-ai/vm0/issues/3850)) ([7cce2b8](https://github.com/vm0-ai/vm0/commit/7cce2b89cfd5dc051d9fb0001be329ab5e17a46d))
* **connectors:** add wix oauth connector ([#3851](https://github.com/vm0-ai/vm0/issues/3851)) ([faa337d](https://github.com/vm0-ai/vm0/commit/faa337d1e4513851024cb57c3e2d1f0de09cd11a))


### Bug Fixes

* **connectors:** add missing redirect_uri to todoist oauth flow ([#3857](https://github.com/vm0-ai/vm0/issues/3857)) ([cb25f4e](https://github.com/vm0-ai/vm0/commit/cb25f4e0e63c691e7bfde0e9ac855f915debc4b0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.43.0

## [12.81.0](https://github.com/vm0-ai/vm0/compare/web-v12.80.1...web-v12.81.0) (2026-03-06)


### Features

* add airtable oauth connector with pkce support ([#3833](https://github.com/vm0-ai/vm0/issues/3833)) ([2e64f13](https://github.com/vm0-ai/vm0/commit/2e64f1363058e9d258073c140f9a669047321438))


### Bug Fixes

* allow github app reinstall on different organization ([#3832](https://github.com/vm0-ai/vm0/issues/3832)) ([ee56499](https://github.com/vm0-ai/vm0/commit/ee56499cc872a43ef4e292456bf248c2483bcc14))


### Refactoring

* **web:** extract shared auth layout from sign-in and sign-up pages ([#3827](https://github.com/vm0-ai/vm0/issues/3827)) ([d4bee10](https://github.com/vm0-ai/vm0/commit/d4bee10a55ed79357f8191cd9f419caa805c0afd)), closes [#3826](https://github.com/vm0-ai/vm0/issues/3826)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.42.0

## [12.80.1](https://github.com/vm0-ai/vm0/compare/web-v12.80.0...web-v12.80.1) (2026-03-06)


### Bug Fixes

* skip progress callbacks for completed or failed runs ([#3818](https://github.com/vm0-ai/vm0/issues/3818)) ([074d1fa](https://github.com/vm0-ai/vm0/commit/074d1fa3bc97f156336be8e207a9d15241bd8cb3))
* **web:** add missing otp input styles to sign-in page ([#3817](https://github.com/vm0-ai/vm0/issues/3817)) ([6dd8d08](https://github.com/vm0-ai/vm0/commit/6dd8d08dee99ce5e4a7ab9c7013c1aac6c5b59ff)), closes [#3814](https://github.com/vm0-ai/vm0/issues/3814)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.41.0

## [12.80.0](https://github.com/vm0-ai/vm0/compare/web-v12.79.0...web-v12.80.0) (2026-03-06)


### Features

* add scope tier with per-scope concurrency limits ([#3802](https://github.com/vm0-ai/vm0/issues/3802)) ([210a307](https://github.com/vm0-ai/vm0/commit/210a307d12be7dcc33c17af1c8c641feb3a1044a))


### Performance Improvements

* deduplicate clerk user email fetch in run creation ([#3810](https://github.com/vm0-ai/vm0/issues/3810)) ([6fd4cd1](https://github.com/vm0-ai/vm0/commit/6fd4cd19f5eb4e3ef92bb9e4690278073abb3203)), closes [#3806](https://github.com/vm0-ai/vm0/issues/3806)
* **run:** parallelize independent db queries in prepare step ([#3812](https://github.com/vm0-ai/vm0/issues/3812)) ([c71fc97](https://github.com/vm0-ai/vm0/commit/c71fc973197465246c5de5a343e764111c7bb7ae)), closes [#3807](https://github.com/vm0-ai/vm0/issues/3807)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.40.0

## [12.79.0](https://github.com/vm0-ai/vm0/compare/web-v12.78.0...web-v12.79.0) (2026-03-06)


### Features

* **run-queue:** implement per-user run queue mechanism ([#3764](https://github.com/vm0-ai/vm0/issues/3764)) ([85a4fbd](https://github.com/vm0-ai/vm0/commit/85a4fbd7707e72f31631c21ae6a3f5698cd138bf))


### Bug Fixes

* **connectors:** store requested oauth scopes instead of provider-granted scopes ([#3791](https://github.com/vm0-ai/vm0/issues/3791)) ([29acfa1](https://github.com/vm0-ai/vm0/commit/29acfa1573fb2cab40367ef3664a4530fcf87be2)), closes [#3756](https://github.com/vm0-ai/vm0/issues/3756)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.39.0

## [12.78.0](https://github.com/vm0-ai/vm0/compare/web-v12.77.1...web-v12.78.0) (2026-03-06)


### Features

* **monday:** add domain verification file for marketplace review ([#3796](https://github.com/vm0-ai/vm0/issues/3796)) ([679220c](https://github.com/vm0-ai/vm0/commit/679220c094aeeb2885cb78f17892d06a59e19e00))


### Bug Fixes

* **slack:** keep spinner alive during long agent runs via progress callbacks ([#3788](https://github.com/vm0-ai/vm0/issues/3788)) ([b221421](https://github.com/vm0-ai/vm0/commit/b2214214cc6caedcf37464633789997aec0db12b))


### Performance Improvements

* add per-step timing metrics to run creation flow ([#3795](https://github.com/vm0-ai/vm0/issues/3795)) ([a900f49](https://github.com/vm0-ai/vm0/commit/a900f49c6e5c9c8ddc8f7f0c57f7789685ddfed1))

## [12.77.1](https://github.com/vm0-ai/vm0/compare/web-v12.77.0...web-v12.77.1) (2026-03-06)


### Bug Fixes

* **e2e:** bypass clerk org creation in test-token endpoint ([#3785](https://github.com/vm0-ai/vm0/issues/3785)) ([84c53b7](https://github.com/vm0-ai/vm0/commit/84c53b7d60009204dccee5b4e9f4b44b87aa497d))
* handle invalid json in github oauth callback state parameter ([#3744](https://github.com/vm0-ai/vm0/issues/3744)) ([cc55520](https://github.com/vm0-ai/vm0/commit/cc55520617c670e4bfe78cb85863e856e3ee6f80))
* prevent compose job toctou race and catch handler rejections ([#3746](https://github.com/vm0-ai/vm0/issues/3746)) ([6588d26](https://github.com/vm0-ai/vm0/commit/6588d264763783a69944f052d1ee65c98d232135))
* reject cron requests when cron secret is not configured ([#3743](https://github.com/vm0-ai/vm0/issues/3743)) ([1167750](https://github.com/vm0-ai/vm0/commit/1167750b0ea394249d1d05e66f3b560ad8b5d931))
* remove unused refresh_token from cli auth token response ([#3747](https://github.com/vm0-ai/vm0/issues/3747)) ([0f5a09a](https://github.com/vm0-ai/vm0/commit/0f5a09a784b8d11ab242942c0ab145c3c1148193))
* use advisory lock to prevent run concurrency limit race ([#3745](https://github.com/vm0-ai/vm0/issues/3745)) ([5bb4afb](https://github.com/vm0-ai/vm0/commit/5bb4afb99ab20eadf93913f73e1f9d13b5e2b297))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.38.1

## [12.77.0](https://github.com/vm0-ai/vm0/compare/web-v12.76.0...web-v12.77.0) (2026-03-05)


### Features

* **docs:** add 12 new skill pages and fix naming inconsistencies ([#3740](https://github.com/vm0-ai/vm0/issues/3740)) ([0e1e0ef](https://github.com/vm0-ai/vm0/commit/0e1e0ef5d01359fc1963d75cdf54929b1e23d64b))
* **docusign:** add pkce support and expand oauth scopes ([#3725](https://github.com/vm0-ai/vm0/issues/3725)) ([8aa15f3](https://github.com/vm0-ai/vm0/commit/8aa15f3e39c34c7c2486386ab00a25bbc7fdb1f1))
* **github:** add issue context, reactions, and session validation to handler ([#3713](https://github.com/vm0-ai/vm0/issues/3713)) ([9b27b2a](https://github.com/vm0-ai/vm0/commit/9b27b2a2760fa7a35f5e4c34ef0fe1a3b291af19))
* **monday:** add monday.com oauth connector ([#3753](https://github.com/vm0-ai/vm0/issues/3753)) ([8bdf5fb](https://github.com/vm0-ai/vm0/commit/8bdf5fb29edb1f309d692ee6f5d5fe0c74634ca5))
* scope unification phase 3 — constraints, cleanup, and token simplification ([#3719](https://github.com/vm0-ai/vm0/issues/3719)) ([9ecbb1b](https://github.com/vm0-ai/vm0/commit/9ecbb1b1addfb855b0ac17fe45508bddd483485f))


### Bug Fixes

* remove email-reply-parser to preserve forwarded email content ([#3754](https://github.com/vm0-ai/vm0/issues/3754)) ([0d9233c](https://github.com/vm0-ai/vm0/commit/0d9233ce74b7dc22bab359bd362ccf6b6983f621))
* replace non-english characters with english in source code ([#3757](https://github.com/vm0-ai/vm0/issues/3757)) ([b5d6b38](https://github.com/vm0-ai/vm0/commit/b5d6b38fe2cdba0cbd34df85f612cf2267a27734))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.38.0

## [12.76.0](https://github.com/vm0-ai/vm0/compare/web-v12.75.0...web-v12.76.0) (2026-03-05)


### Features

* add batch backfill script for clerk organization ids ([#3671](https://github.com/vm0-ai/vm0/issues/3671)) ([621ca7c](https://github.com/vm0-ai/vm0/commit/621ca7c4ed7ef8d76d2965e88dd432c9b9ebe541))
* **telegram:** streamline re-link flow after /disconnect ([#3701](https://github.com/vm0-ai/vm0/issues/3701)) ([8dd4db4](https://github.com/vm0-ai/vm0/commit/8dd4db4a9fc255bc34ad6928861a9cb077cd83c2))


### Bug Fixes

* set api start time inside create-run for e2e telemetry ([#3707](https://github.com/vm0-ai/vm0/issues/3707)) ([e902696](https://github.com/vm0-ai/vm0/commit/e902696adb72414e5b248552379ee59c9cbbabd0)), closes [#3706](https://github.com/vm0-ai/vm0/issues/3706)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.37.0

## [12.75.0](https://github.com/vm0-ai/vm0/compare/web-v12.74.0...web-v12.75.0) (2026-03-05)


### Features

* **telegram:** add emoji branding, deep links, session reuse, and /new_session command ([#3678](https://github.com/vm0-ai/vm0/issues/3678)) ([a1cf9ca](https://github.com/vm0-ai/vm0/commit/a1cf9ca9ae8c19ede9d3fe3a2a606aa0ac25467d))
* **telegram:** improve UX with bot commands and deep links ([#3695](https://github.com/vm0-ai/vm0/issues/3695)) ([9e15219](https://github.com/vm0-ai/vm0/commit/9e15219abbb0fe3f6e7a78a5b975a82e7fb94912))
* **web:** route [@vm0](https://github.com/vm0).ai users to runner for domain-based rollout ([#3690](https://github.com/vm0-ai/vm0/issues/3690)) ([978f115](https://github.com/vm0-ai/vm0/commit/978f1153a41bb0672d730b4e7e27624663cac5bf))


### Bug Fixes

* **email:** preserve cc recipients when bot is sole to recipient ([#3677](https://github.com/vm0-ai/vm0/issues/3677)) ([94f6ec2](https://github.com/vm0-ai/vm0/commit/94f6ec28f46b33fc9467a8589746f19debbb1f48)), closes [#3675](https://github.com/vm0-ai/vm0/issues/3675)
* **slack:** extract rich text content from blocks instead of lossy text fallback ([#3689](https://github.com/vm0-ai/vm0/issues/3689)) ([e2ad7b6](https://github.com/vm0-ai/vm0/commit/e2ad7b6aa33d35798b9c384e524ac07dd431fbf5))

## [12.74.0](https://github.com/vm0-ai/vm0/compare/web-v12.73.0...web-v12.74.0) (2026-03-05)


### Features

* **vercel:** switch to integration oauth flow ([#3676](https://github.com/vm0-ai/vm0/issues/3676)) ([c35545b](https://github.com/vm0-ai/vm0/commit/c35545be2c3d180a0e82baa02d852db078ff65f1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.36.0

## [12.73.0](https://github.com/vm0-ai/vm0/compare/web-v12.72.0...web-v12.73.0) (2026-03-05)


### Features

* **telegram:** persistent thinking, clean dm replies, structured format ([#3650](https://github.com/vm0-ai/vm0/issues/3650)) ([74616d1](https://github.com/vm0-ai/vm0/commit/74616d1e4409dd7c8ff008eb6364fe84402ef07e))


### Bug Fixes

* **github:** detect existing app installations before redirecting ([#3642](https://github.com/vm0-ai/vm0/issues/3642)) ([7b094f4](https://github.com/vm0-ai/vm0/commit/7b094f490c88887420b076faa9e2186acdabf009))

## [12.72.0](https://github.com/vm0-ai/vm0/compare/web-v12.71.0...web-v12.72.0) (2026-03-05)


### Features

* **telegram:** auto-link admin on bot install ([#3644](https://github.com/vm0-ai/vm0/issues/3644)) ([cc1089b](https://github.com/vm0-ai/vm0/commit/cc1089bc9a9891de7de57fcd00b542cace1da212))

## [12.71.0](https://github.com/vm0-ai/vm0/compare/web-v12.70.0...web-v12.71.0) (2026-03-05)


### Features

* unify scope types with scope_members table (Phase 1+2) ([#3592](https://github.com/vm0-ai/vm0/issues/3592)) ([60bb170](https://github.com/vm0-ai/vm0/commit/60bb1709832dfe7337ffa419702ce524c06441ed))


### Bug Fixes

* **email:** add sender verification to email reply handler ([#3663](https://github.com/vm0-ai/vm0/issues/3663)) ([fe96d10](https://github.com/vm0-ai/vm0/commit/fe96d1086e451d8e84e7f0e9580016f90112f529))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.35.0

## [12.70.0](https://github.com/vm0-ai/vm0/compare/web-v12.69.4...web-v12.70.0) (2026-03-04)


### Features

* **email:** add smart reply-all behavior for email agent ([#3659](https://github.com/vm0-ai/vm0/issues/3659)) ([fd74d89](https://github.com/vm0-ai/vm0/commit/fd74d8986b039ea5c0072a9b5d836a9db1378cee))

## [12.69.4](https://github.com/vm0-ai/vm0/compare/web-v12.69.3...web-v12.69.4) (2026-03-04)


### Bug Fixes

* **compose:** generate server-side cli token for sandbox auth ([#3658](https://github.com/vm0-ai/vm0/issues/3658)) ([13782bb](https://github.com/vm0-ai/vm0/commit/13782bb292424abd385407f18b465a305dd69d1c))

## [12.69.3](https://github.com/vm0-ai/vm0/compare/web-v12.69.2...web-v12.69.3) (2026-03-04)


### Bug Fixes

* **callback:** use callback id for signature verification to fix multi-callback runs ([#3633](https://github.com/vm0-ai/vm0/issues/3633)) ([711d4d6](https://github.com/vm0-ai/vm0/commit/711d4d607c63abc3bd8adb99c96ff62ffb4ea2b1))

## [12.69.2](https://github.com/vm0-ai/vm0/compare/web-v12.69.1...web-v12.69.2) (2026-03-04)


### Bug Fixes

* **slack:** restrict ask-user question submission to initiator only ([#3631](https://github.com/vm0-ai/vm0/issues/3631)) ([d5a52be](https://github.com/vm0-ai/vm0/commit/d5a52be2b85e307c70ac1df936e0f05015ea1523))


### Reverts

* **slack:** restore permission denial detection for ask-user ([#3632](https://github.com/vm0-ai/vm0/issues/3632)) ([769cc9c](https://github.com/vm0-ai/vm0/commit/769cc9ce6094b87204638df8d02eef5335b644ea))

## [12.69.1](https://github.com/vm0-ai/vm0/compare/web-v12.69.0...web-v12.69.1) (2026-03-04)


### Bug Fixes

* correct 1password reference key for platform url in env template ([#3624](https://github.com/vm0-ai/vm0/issues/3624)) ([71aa437](https://github.com/vm0-ai/vm0/commit/71aa4377578442a5c09bf01543d9034347780f44))

## [12.69.0](https://github.com/vm0-ai/vm0/compare/web-v12.68.0...web-v12.69.0) (2026-03-04)


### Features

* **slack:** interactive ask-user cards via prompt-based detection ([#3602](https://github.com/vm0-ai/vm0/issues/3602)) ([94f11a5](https://github.com/vm0-ai/vm0/commit/94f11a582a59cdd9db84848523f2d2406ee0d624))

## [12.68.0](https://github.com/vm0-ai/vm0/compare/web-v12.67.0...web-v12.68.0) (2026-03-04)


### Features

* add intervals.icu oauth connector ([#3608](https://github.com/vm0-ai/vm0/issues/3608)) ([6bae2a2](https://github.com/vm0-ai/vm0/commit/6bae2a24c261527f4c1d1467f52b7611501ad5b5)), closes [#3606](https://github.com/vm0-ai/vm0/issues/3606)
* add xero oauth connector ([#3601](https://github.com/vm0-ai/vm0/issues/3601)) ([40e51d4](https://github.com/vm0-ai/vm0/commit/40e51d4a0246d1c419a554d62f5112ef5ff980b6)), closes [#3598](https://github.com/vm0-ai/vm0/issues/3598)
* **compose:** migrate platform compose to e2b sandbox execution ([#3593](https://github.com/vm0-ai/vm0/issues/3593)) ([cbed13c](https://github.com/vm0-ai/vm0/commit/cbed13c2901ac87b38e3c1041b43f431b670d2c6))
* **connectors:** add neon oauth connector ([#3591](https://github.com/vm0-ai/vm0/issues/3591)) ([5024986](https://github.com/vm0-ai/vm0/commit/5024986a1f4d2440b503f1b5dbf9bda7267c55f3))
* **github:** add pending approval flow for org installations ([#3599](https://github.com/vm0-ai/vm0/issues/3599)) ([c83100a](https://github.com/vm0-ai/vm0/commit/c83100a4b401fb0c87cd4cc14ce92102594c99cf))
* **telegram:** add agent completion callback handler ([#3611](https://github.com/vm0-ai/vm0/issues/3611)) ([c07ff56](https://github.com/vm0-ai/vm0/commit/c07ff565c858d9374f826d557a72fc60dd9352e8))
* **telegram:** add bot registration and integration management endpoints ([#3596](https://github.com/vm0-ai/vm0/issues/3596)) ([5f92fe7](https://github.com/vm0-ai/vm0/commit/5f92fe7627126bf8007b34398a4ea2dcd1096032))
* **telegram:** add webhook handler and message handlers ([#3595](https://github.com/vm0-ai/vm0/issues/3595)) ([c12e76b](https://github.com/vm0-ai/vm0/commit/c12e76bf2adfa1cef306517301a849e2cf4289c8))


### Bug Fixes

* use atomic upsert for model-provider and scope to prevent race conditions ([#3605](https://github.com/vm0-ai/vm0/issues/3605)) ([337c943](https://github.com/vm0-ai/vm0/commit/337c943eb147b0a50cd026bd7e774d6daf327e2a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.34.0

## [12.67.0](https://github.com/vm0-ai/vm0/compare/web-v12.66.0...web-v12.67.0) (2026-03-04)


### Features

* add sentry oauth connector ([#3582](https://github.com/vm0-ai/vm0/issues/3582)) ([b80aa49](https://github.com/vm0-ai/vm0/commit/b80aa49255a0aa493cc217885ed80fad17c5a801))
* add vercel oauth connector ([#3590](https://github.com/vm0-ai/vm0/issues/3590)) ([b5d8898](https://github.com/vm0-ai/vm0/commit/b5d8898bcca548e1300cc1f14b7ebdfa1a1c57c3)), closes [#3586](https://github.com/vm0-ai/vm0/issues/3586)
* complete reddit and x connector integration ([#3581](https://github.com/vm0-ai/vm0/issues/3581)) ([c4e038e](https://github.com/vm0-ai/vm0/commit/c4e038ea6dc329aee10df96cb0c5291e5fb9957e))
* **telegram:** add bot api client library ([#3580](https://github.com/vm0-ai/vm0/issues/3580)) ([032f49e](https://github.com/vm0-ai/vm0/commit/032f49eb020c36d350e90d779d6553353d88afa3))
* **telegram:** add message retention cleanup cron job ([#3579](https://github.com/vm0-ai/vm0/issues/3579)) ([acd8ce6](https://github.com/vm0-ai/vm0/commit/acd8ce6318c7cb581546d08671d142c96e9b0cc5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.33.0

## [12.66.0](https://github.com/vm0-ai/vm0/compare/web-v12.65.1...web-v12.66.0) (2026-03-04)


### Features

* **db:** add telegram integration database schema ([#3542](https://github.com/vm0-ai/vm0/issues/3542)) ([a37ecd6](https://github.com/vm0-ai/vm0/commit/a37ecd60576d960d2e903b069da3f5b7e0b11429))
* **github:** add GitHub integration configuration UI ([#3538](https://github.com/vm0-ai/vm0/issues/3538)) ([df1d682](https://github.com/vm0-ai/vm0/commit/df1d68212aae2059a2d8f270eac84be64d2ddc1a))
* **github:** implement callback handler for posting agent responses as issue comments ([#3530](https://github.com/vm0-ai/vm0/issues/3530)) ([83d7710](https://github.com/vm0-ai/vm0/commit/83d77100594c8c9f76f2857d17b42cfd1de7c50f))

## [12.65.1](https://github.com/vm0-ai/vm0/compare/web-v12.65.0...web-v12.65.1) (2026-03-04)


### Bug Fixes

* **platform:** remove agent rename to fix storage reference bug ([#3545](https://github.com/vm0-ai/vm0/issues/3545)) ([c8c5156](https://github.com/vm0-ai/vm0/commit/c8c5156160cafe54b1049585df32eed7b440d94f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.32.1

## [12.65.0](https://github.com/vm0-ai/vm0/compare/web-v12.64.0...web-v12.65.0) (2026-03-04)


### Features

* **api:** clean up agent-instructions volume on agent delete ([#3553](https://github.com/vm0-ai/vm0/issues/3553)) ([aeaf791](https://github.com/vm0-ai/vm0/commit/aeaf79126e4d9f1288f8c91b0653480fb020f653))

## [12.64.0](https://github.com/vm0-ai/vm0/compare/web-v12.63.0...web-v12.64.0) (2026-03-04)


### Features

* add reddit oauth connector ([#3532](https://github.com/vm0-ai/vm0/issues/3532)) ([ecc31b4](https://github.com/vm0-ai/vm0/commit/ecc31b45276946812962d6877ff5072e1e4d55e9))
* add x (twitter) read-only connector ([#3554](https://github.com/vm0-ai/vm0/issues/3554)) ([05dca8a](https://github.com/vm0-ai/vm0/commit/05dca8ab0f6fd9c535b534bcf54cf15eced72afb))
* **github:** add webhook endpoint for issue events ([#3533](https://github.com/vm0-ai/vm0/issues/3533)) ([3bca3cc](https://github.com/vm0-ai/vm0/commit/3bca3cc0ed871e4369949418887a5b034e7e8872))
* **platform:** add chat session history and message persistence ([#3520](https://github.com/vm0-ai/vm0/issues/3520)) ([f02f228](https://github.com/vm0-ai/vm0/commit/f02f228c78e2e53ce64bc2b36f08b937e42f2ec2))
* **schedules:** add loop execution mode for recurring agent runs ([#3423](https://github.com/vm0-ai/vm0/issues/3423)) ([00d8876](https://github.com/vm0-ai/vm0/commit/00d8876ada1144fee2d40e2e6e4eb60ab893c4fd))


### Bug Fixes

* update google calendar icon with higher quality version ([#3555](https://github.com/vm0-ai/vm0/issues/3555)) ([b04185e](https://github.com/vm0-ai/vm0/commit/b04185e90dfc68d1ab98922d0c474cdba76a1319))
* use uppercase 1password field refs in env templates ([#3566](https://github.com/vm0-ai/vm0/issues/3566)) ([233e6cc](https://github.com/vm0-ai/vm0/commit/233e6cc071f666be4985ebbccc5629a8b8fab934))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.32.0

## [12.63.0](https://github.com/vm0-ai/vm0/compare/web-v12.62.0...web-v12.63.0) (2026-03-03)


### Features

* **connectors:** add google calendar connector ([#3522](https://github.com/vm0-ai/vm0/issues/3522)) ([878ef7d](https://github.com/vm0-ai/vm0/commit/878ef7d3979ac161fdf822d7c674bad51c5000a3))
* **platform:** add one-time schedule option to agent run dialog ([#3507](https://github.com/vm0-ai/vm0/issues/3507)) ([3c23118](https://github.com/vm0-ai/vm0/commit/3c2311828af86446a409a6a193ac2d6f65b6fd66))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.31.0

## [12.62.0](https://github.com/vm0-ai/vm0/compare/web-v12.61.0...web-v12.62.0) (2026-03-03)


### Features

* **connectors:** add token refresh for all oauth connectors ([#3503](https://github.com/vm0-ai/vm0/issues/3503)) ([c579402](https://github.com/vm0-ai/vm0/commit/c579402aad57414806d5f4cfdcaea723d7e2a6bc))
* **connectors:** add token refresh for linear connector during run context build ([#3490](https://github.com/vm0-ai/vm0/issues/3490)) ([25a5bde](https://github.com/vm0-ai/vm0/commit/25a5bdeffbd324f5f066d963a2d2765da02759a7))
* **github:** add oauth installation flow for github app ([#3466](https://github.com/vm0-ai/vm0/issues/3466)) ([5e07a31](https://github.com/vm0-ai/vm0/commit/5e07a3154da03b64d6e5553ee0cecc05ebc43a7a))
* support bare skill names in vm0.yaml with default registry ([#3465](https://github.com/vm0-ai/vm0/issues/3465)) ([353d295](https://github.com/vm0-ai/vm0/commit/353d29501a569620118203b71dc1b1a99f891b3a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.30.0

## [12.61.0](https://github.com/vm0-ai/vm0/compare/web-v12.60.0...web-v12.61.0) (2026-03-03)


### Features

* **connectors:** filter connector types by configured oauth credentials ([#3477](https://github.com/vm0-ai/vm0/issues/3477)) ([09319ec](https://github.com/vm0-ai/vm0/commit/09319ec9081e38d476b6f0e4b9c1e106ba0df8cb))
* **docs:** remove remaining public api v1 references ([#3469](https://github.com/vm0-ai/vm0/issues/3469)) ([d956347](https://github.com/vm0-ai/vm0/commit/d956347feeb87ffb828eedc01e5fc650e074fa9d))
* **github:** add database schema for github issue integration ([#3456](https://github.com/vm0-ai/vm0/issues/3456)) ([0d1f88d](https://github.com/vm0-ai/vm0/commit/0d1f88dd939c691c357467dca492a0ba59b7a66f)), closes [#3439](https://github.com/vm0-ai/vm0/issues/3439)
* **storage:** auto-create artifact when not found during run ([#3446](https://github.com/vm0-ai/vm0/issues/3446)) ([1b045c4](https://github.com/vm0-ai/vm0/commit/1b045c4ee576d41bc94c39a410c13341a0190e75))
* **web:** update connector oauth scopes and add deel pkce support ([#3459](https://github.com/vm0-ai/vm0/issues/3459)) ([3c9926a](https://github.com/vm0-ai/vm0/commit/3c9926ac223b3458c9ffc38600e0c19cc552b044))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.29.0

## [12.60.0](https://github.com/vm0-ai/vm0/compare/web-v12.59.0...web-v12.60.0) (2026-03-02)


### Features

* **web:** auto-upload skill storage on compose save from platform ([#3434](https://github.com/vm0-ai/vm0/issues/3434)) ([b591a23](https://github.com/vm0-ai/vm0/commit/b591a231e1ebfee1418fa1f1bb71e41514630fa1))


### Bug Fixes

* **db:** clean up fk references before deleting system scopes in migration 0093 ([#3455](https://github.com/vm0-ai/vm0/issues/3455)) ([ce9ed6a](https://github.com/vm0-ai/vm0/commit/ce9ed6a1ef3df2cdb9e1a813feec5f1ea7fc1ed6))
* redirect to platform after sign-up and handle locale-prefixed auth paths ([#3438](https://github.com/vm0-ai/vm0/issues/3438)) ([28206ac](https://github.com/vm0-ai/vm0/commit/28206ac632eb65148d1fdb4b0829a3fd95c836cd)), closes [#3390](https://github.com/vm0-ai/vm0/issues/3390)
* **web:** use next/link for sign-up to prevent locale prefix 404 ([#3444](https://github.com/vm0-ai/vm0/issues/3444)) ([2e7b471](https://github.com/vm0-ai/vm0/commit/2e7b471a7232ff21da01b4436dc6c958b59ebca7)), closes [#3390](https://github.com/vm0-ai/vm0/issues/3390)

## [12.59.0](https://github.com/vm0-ai/vm0/compare/web-v12.58.2...web-v12.59.0) (2026-03-02)


### Features

* **connector:** add deel oauth2 connector ([#3401](https://github.com/vm0-ai/vm0/issues/3401)) ([8128da7](https://github.com/vm0-ai/vm0/commit/8128da7cb693bdb51b006edc7ed8cc1aae14b9c2))
* **connector:** add docusign oauth2 connector ([#3402](https://github.com/vm0-ai/vm0/issues/3402)) ([2273b1c](https://github.com/vm0-ai/vm0/commit/2273b1c3db937c8c2e5794c0348f2d5a063c724e))
* **connector:** add google sheets, docs, and drive oauth2 connectors ([#3403](https://github.com/vm0-ai/vm0/issues/3403)) ([97cca63](https://github.com/vm0-ai/vm0/commit/97cca638861824b887feaa3d97372028e8affdba))
* **connector:** add mercury oauth2 connector ([#3397](https://github.com/vm0-ai/vm0/issues/3397)) ([a5f4e79](https://github.com/vm0-ai/vm0/commit/a5f4e794fe12e6250d770fef1d8ec444a5cdcec3))
* **connector:** add strava and garmin connect oauth2 connectors ([#3399](https://github.com/vm0-ai/vm0/issues/3399)) ([2aa431a](https://github.com/vm0-ai/vm0/commit/2aa431ae1142234ee0d2add1438249540dc91ad8))
* **email:** send error reply emails for inbound processing failures ([#3400](https://github.com/vm0-ai/vm0/issues/3400)) ([5d781fe](https://github.com/vm0-ai/vm0/commit/5d781fe0aaee3cfb29482f7140085a384d24a002))
* **slack:** replace thinking reaction with assistant thread status ([#3410](https://github.com/vm0-ai/vm0/issues/3410)) ([08ebf8a](https://github.com/vm0-ai/vm0/commit/08ebf8ad2ed2b2e1c821040fd12f94c22532542c))


### Bug Fixes

* **platform:** resolve empty logs page for scoped agents ([#3392](https://github.com/vm0-ai/vm0/issues/3392)) ([d611bd0](https://github.com/vm0-ai/vm0/commit/d611bd026a6f74a27707c3877c1c4f9cb19acb65))
* **schedule:** reject schedule creation for organization-scoped agents ([#3420](https://github.com/vm0-ai/vm0/issues/3420)) ([7945a10](https://github.com/vm0-ai/vm0/commit/7945a10ea3d2c21e8bde0516326f98804e61ea87))
* unify variable resolution in build-context via caller-provided scope ([#3417](https://github.com/vm0-ai/vm0/issues/3417)) ([3563fb2](https://github.com/vm0-ai/vm0/commit/3563fb24962f10f9a4480ec9d7e69540af884398))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.28.0

## [12.58.2](https://github.com/vm0-ai/vm0/compare/web-v12.58.1...web-v12.58.2) (2026-03-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.27.0

## [12.58.1](https://github.com/vm0-ai/vm0/compare/web-v12.58.0...web-v12.58.1) (2026-03-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.26.0

## [12.58.0](https://github.com/vm0-ai/vm0/compare/web-v12.57.0...web-v12.58.0) (2026-03-01)


### Features

* **scope:** enable vm0 admin users to activate system scope ([#3378](https://github.com/vm0-ai/vm0/issues/3378)) ([c4d05ac](https://github.com/vm0-ai/vm0/commit/c4d05acc257e7777dab8822362e07437add11511))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.25.0

## [12.57.0](https://github.com/vm0-ai/vm0/compare/web-v12.56.0...web-v12.57.0) (2026-03-01)


### Features

* **runner:** inject agent name and scope env vars into sandbox runtime ([#3375](https://github.com/vm0-ai/vm0/issues/3375)) ([53a1d42](https://github.com/vm0-ai/vm0/commit/53a1d4211cf4dbb477b1fb92a2412b719d46d8a8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.24.0

## [12.56.0](https://github.com/vm0-ai/vm0/compare/web-v12.55.0...web-v12.56.0) (2026-03-01)


### Features

* **connectors:** add dropbox oauth connector ([#3368](https://github.com/vm0-ai/vm0/issues/3368)) ([1dc5d4c](https://github.com/vm0-ai/vm0/commit/1dc5d4c151f986ded68c169b19bd7c9c6a07f4b6))
* **connectors:** add feature flag for linear connector visibility ([#3372](https://github.com/vm0-ai/vm0/issues/3372)) ([f6da04e](https://github.com/vm0-ai/vm0/commit/f6da04e4653c62103975cb43f44d7c70067e4dc1))
* **connectors:** add figma oauth connector ([#3369](https://github.com/vm0-ai/vm0/issues/3369)) ([4d93f59](https://github.com/vm0-ai/vm0/commit/4d93f59827c3567ba83ef115d90decc4ca7fa294))
* **connectors:** add linear oauth connector ([#3366](https://github.com/vm0-ai/vm0/issues/3366)) ([f943498](https://github.com/vm0-ai/vm0/commit/f94349842e5501fe487d078fa7138a3010d65635))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.23.0

## [12.55.0](https://github.com/vm0-ai/vm0/compare/web-v12.54.0...web-v12.55.0) (2026-03-01)


### Features

* **connectors:** add gmail oauth connector ([#3332](https://github.com/vm0-ai/vm0/issues/3332)) ([ca303b7](https://github.com/vm0-ai/vm0/commit/ca303b71916095e799c22b975f71216ea89df021))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.22.0

## [12.54.0](https://github.com/vm0-ai/vm0/compare/web-v12.53.0...web-v12.54.0) (2026-03-01)


### Features

* **connectors:** add token expiry and refresh token storage (phase 0.5) ([#3326](https://github.com/vm0-ai/vm0/issues/3326)) ([d1f42f8](https://github.com/vm0-ai/vm0/commit/d1f42f87be4075be2c8d98051b7c91eddd07e959))

## [12.53.0](https://github.com/vm0-ai/vm0/compare/web-v12.52.0...web-v12.53.0) (2026-03-01)


### Features

* add organization scope support with clerk integration ([#2863](https://github.com/vm0-ai/vm0/issues/2863)) ([ec821d7](https://github.com/vm0-ai/vm0/commit/ec821d79768153368aa3ff213b31e3e219baf320))


### Bug Fixes

* remove eslint-disable for no-explicit-any in global types ([#3292](https://github.com/vm0-ai/vm0/issues/3292)) ([d8dbc75](https://github.com/vm0-ai/vm0/commit/d8dbc75cf99ab682b7383cbd499320d2f281fb8d))
* remove eslint-disable for no-html-link-for-pages in navbar ([#3293](https://github.com/vm0-ai/vm0/issues/3293)) ([55532c4](https://github.com/vm0-ai/vm0/commit/55532c453ff0d9afdb6684e4a58a2f6f2f4a330f))
* remove eslint-disable suppressions in skills client ([#3294](https://github.com/vm0-ai/vm0/issues/3294)) ([42cf6e3](https://github.com/vm0-ai/vm0/commit/42cf6e3cd1348113807ad109f589e15eeda6c20f))
* remove lint suppressions in test-helpers ([#3296](https://github.com/vm0-ai/vm0/issues/3296)) ([5c2d34f](https://github.com/vm0-ai/vm0/commit/5c2d34fe7d70ed89a31a72d5c4a337cc2fb7b739))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.21.0

## [12.52.0](https://github.com/vm0-ai/vm0/compare/web-v12.51.0...web-v12.52.0) (2026-02-28)


### Features

* **connectors:** add self-hosted slack connector ([#3281](https://github.com/vm0-ai/vm0/issues/3281)) ([13e92fd](https://github.com/vm0-ai/vm0/commit/13e92fde8468324ca7502fa8ded5eb60179eba05)), closes [#3279](https://github.com/vm0-ai/vm0/issues/3279)
* **connectors:** add self-hosted slack connector ([#3286](https://github.com/vm0-ai/vm0/issues/3286)) ([6089289](https://github.com/vm0-ai/vm0/commit/608928923103497eadee7c832c9103d9545aa826))
* **web:** add instatus status popup widget ([#3285](https://github.com/vm0-ai/vm0/issues/3285)) ([c798155](https://github.com/vm0-ai/vm0/commit/c7981558cfba13848884c1f4548b2afcebe719be))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.20.0

## [12.51.0](https://github.com/vm0-ai/vm0/compare/web-v12.50.1...web-v12.51.0) (2026-02-26)


### Features

* **email:** improve reply template with content-first layout ([#3261](https://github.com/vm0-ai/vm0/issues/3261)) ([3d28058](https://github.com/vm0-ai/vm0/commit/3d280583470605ff095f063424109e216a823c8e))

## [12.50.1](https://github.com/vm0-ai/vm0/compare/web-v12.50.0...web-v12.50.1) (2026-02-25)


### Bug Fixes

* replace inline image data uris with placeholder in email body ([#3255](https://github.com/vm0-ai/vm0/issues/3255)) ([7bd85bf](https://github.com/vm0-ai/vm0/commit/7bd85bf91ee8b17504bd59615c53f1b2ea9919f9)), closes [#3254](https://github.com/vm0-ai/vm0/issues/3254)

## [12.50.0](https://github.com/vm0-ai/vm0/compare/web-v12.49.1...web-v12.50.0) (2026-02-25)


### Features

* **email:** pass attachments to agent sessions via r2 presigned urls ([#3249](https://github.com/vm0-ai/vm0/issues/3249)) ([b524482](https://github.com/vm0-ai/vm0/commit/b524482998f31d443e65da1f211bf6479d478f81))

## [12.49.1](https://github.com/vm0-ai/vm0/compare/web-v12.49.0...web-v12.49.1) (2026-02-25)


### Bug Fixes

* **email:** correct In-Reply-To and References headers for proper threading ([#3235](https://github.com/vm0-ai/vm0/issues/3235)) ([fe86f75](https://github.com/vm0-ai/vm0/commit/fe86f752d24b8f5497db6044ff1504bb93f54fee))

## [12.49.0](https://github.com/vm0-ai/vm0/compare/web-v12.48.1...web-v12.49.0) (2026-02-23)


### Features

* **email:** add threading, mirrored from address, and original subject to trigger response ([#3227](https://github.com/vm0-ai/vm0/issues/3227)) ([21f7962](https://github.com/vm0-ai/vm0/commit/21f79620893424bdf8b9d465cf203354011f99c6))

## [12.48.1](https://github.com/vm0-ai/vm0/compare/web-v12.48.0...web-v12.48.1) (2026-02-23)


### Bug Fixes

* **email:** prefer html body with text fallback for inbound email content ([#3220](https://github.com/vm0-ai/vm0/issues/3220)) ([d10236f](https://github.com/vm0-ai/vm0/commit/d10236ff20612560cd99f06cecb2a42b002dd741))

## [12.48.0](https://github.com/vm0-ai/vm0/compare/web-v12.47.0...web-v12.48.0) (2026-02-23)


### Features

* **platform:** add editable agent name and skills multi-select to config dialog ([#3216](https://github.com/vm0-ai/vm0/issues/3216)) ([50fc6f3](https://github.com/vm0-ai/vm0/commit/50fc6f3fc03d6595b9ee326df2dd88a1697eb837))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.19.0

## [12.47.0](https://github.com/vm0-ai/vm0/compare/web-v12.46.0...web-v12.47.0) (2026-02-22)


### Features

* **email:** auto-detect scope from sender for agent-only addresses ([#3198](https://github.com/vm0-ai/vm0/issues/3198)) ([ad0837d](https://github.com/vm0-ai/vm0/commit/ad0837dba470110ca1bd13840ff171e9feed8860))


### Bug Fixes

* **api:** use framework-based filename lookup in instructions api ([#3192](https://github.com/vm0-ai/vm0/issues/3192)) ([607608a](https://github.com/vm0-ai/vm0/commit/607608aa76b4237e2692dec598318a614e44ac02))
* **email:** validate sender authenticity via dmarc for email triggers ([#3196](https://github.com/vm0-ai/vm0/issues/3196)) ([aec7039](https://github.com/vm0-ai/vm0/commit/aec703937eb780fdc5594ef600d92b13d9c579a7)), closes [#3194](https://github.com/vm0-ai/vm0/issues/3194)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.18.1

## [12.46.0](https://github.com/vm0-ai/vm0/compare/web-v12.45.0...web-v12.46.0) (2026-02-22)


### Features

* **email:** add email-triggered agent runs ([#2959](https://github.com/vm0-ai/vm0/issues/2959)) ([a4ce976](https://github.com/vm0-ai/vm0/commit/a4ce976bd364744ef8f73bf575c5272d1682cb04))

## [12.45.0](https://github.com/vm0-ai/vm0/compare/web-v12.44.0...web-v12.45.0) (2026-02-18)


### Features

* **cli:** add computer connector support ([#3124](https://github.com/vm0-ai/vm0/issues/3124)) ([a950821](https://github.com/vm0-ai/vm0/commit/a9508213014337b0a4a7effb4756ed7056e3cb0f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.18.0

## [12.44.0](https://github.com/vm0-ai/vm0/compare/web-v12.43.1...web-v12.44.0) (2026-02-17)


### Features

* use ngrok reserved domains for computer connector ([#3116](https://github.com/vm0-ai/vm0/issues/3116)) ([7e30f2c](https://github.com/vm0-ai/vm0/commit/7e30f2c83f7fb4f82dd0b1e9aed38267ca5919f9))


### Bug Fixes

* improve validation error handler robustness ([#3114](https://github.com/vm0-ai/vm0/issues/3114)) ([6506d06](https://github.com/vm0-ai/vm0/commit/6506d066ab5dd01c4c33a3f1e6dbe6241ac662cb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.17.0

## [12.43.1](https://github.com/vm0-ai/vm0/compare/web-v12.43.0...web-v12.43.1) (2026-02-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.16.1

## [12.43.0](https://github.com/vm0-ai/vm0/compare/web-v12.42.2...web-v12.43.0) (2026-02-16)


### Features

* add gmail connector with nango platform integration ([#3065](https://github.com/vm0-ai/vm0/issues/3065)) ([d43dfe1](https://github.com/vm0-ai/vm0/commit/d43dfe1a5a868c8413ffd2b8a250d48dafc791cb))
* **web:** add migration consistency testing ([#3066](https://github.com/vm0-ai/vm0/issues/3066)) ([cef8348](https://github.com/vm0-ai/vm0/commit/cef83484f87bfceacf03f1bfd185be49504080da))


### Bug Fixes

* **web:** rebuild migration snapshots for consistency ([#3070](https://github.com/vm0-ai/vm0/issues/3070)) ([c455382](https://github.com/vm0-ai/vm0/commit/c4553824116e78002f755bcdac28a8041055ac2e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.16.0

## [12.42.2](https://github.com/vm0-ai/vm0/compare/web-v12.42.1...web-v12.42.2) (2026-02-15)


### Bug Fixes

* **web:** fix drizzle-kit generate partial indexes ([#3062](https://github.com/vm0-ai/vm0/issues/3062)) ([96eca9b](https://github.com/vm0-ai/vm0/commit/96eca9b8b8ee8074f78f43d9fe08761ed4bfe6d4))

## [12.42.1](https://github.com/vm0-ai/vm0/compare/web-v12.42.0...web-v12.42.1) (2026-02-15)


### Bug Fixes

* prevent env validation errors on client side ([#3059](https://github.com/vm0-ai/vm0/issues/3059)) ([886bd66](https://github.com/vm0-ai/vm0/commit/886bd663b062ec515d59821663d21011f83b391e))

## [12.42.0](https://github.com/vm0-ai/vm0/compare/web-v12.41.0...web-v12.42.0) (2026-02-15)


### Features

* **platform:** add config dialog and run dialog for agent detail page ([#3016](https://github.com/vm0-ai/vm0/issues/3016)) ([7811f00](https://github.com/vm0-ai/vm0/commit/7811f0045c022856d283174722cfacf6ced72b7f))
* simplify environment variable naming ([#3047](https://github.com/vm0-ai/vm0/issues/3047)) ([609ba7d](https://github.com/vm0-ai/vm0/commit/609ba7d35985e905f6e198275e0ab862313deafe))
* simplify environment variable naming ([#3050](https://github.com/vm0-ai/vm0/issues/3050)) ([9241e1f](https://github.com/vm0-ai/vm0/commit/9241e1fc28e12024fad37e27334c79569fd69665))
* **web:** add per-user cloud endpoint with traffic policy for computer connector ([#3019](https://github.com/vm0-ai/vm0/issues/3019)) ([24e8154](https://github.com/vm0-ai/vm0/commit/24e81542baffb2efe15c2633a34e808c37ab2a92))


### Bug Fixes

* **slack:** sync agent permissions when admin switches workspace agent ([#3024](https://github.com/vm0-ai/vm0/issues/3024)) ([dbdafec](https://github.com/vm0-ai/vm0/commit/dbdafeca2ba2483841ac0606d5216a45198f3c4d))

## [12.41.0](https://github.com/vm0-ai/vm0/compare/web-v12.40.0...web-v12.41.0) (2026-02-13)


### Features

* owner inline editing for agent instructions ([#3015](https://github.com/vm0-ai/vm0/issues/3015)) ([e7022c8](https://github.com/vm0-ai/vm0/commit/e7022c848b7b247ee6f2475c204bfb656588c5ad))

## [12.40.0](https://github.com/vm0-ai/vm0/compare/web-v12.39.0...web-v12.40.0) (2026-02-13)


### Features

* **platform:** add agent detail page with feature flag gating ([#2998](https://github.com/vm0-ai/vm0/issues/2998)) ([5386de0](https://github.com/vm0-ai/vm0/commit/5386de0662eb2a85e69040788e2ca08e7f976cba))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.15.0

## [12.39.0](https://github.com/vm0-ai/vm0/compare/web-v12.38.0...web-v12.39.0) (2026-02-13)


### Features

* add markdown preview for prompts, slack image hints, and platform tests ([#2991](https://github.com/vm0-ai/vm0/issues/2991)) ([35da51b](https://github.com/vm0-ai/vm0/commit/35da51b563330c45444e1cb16b3de566519d2c07))
* **web:** add keyword detection for slack agent responses with deep links ([#3003](https://github.com/vm0-ai/vm0/issues/3003)) ([24adaff](https://github.com/vm0-ai/vm0/commit/24adaffd619e65a692eb643a4dec25d8cb6f457c)), closes [#2995](https://github.com/vm0-ai/vm0/issues/2995)

## [12.38.0](https://github.com/vm0-ai/vm0/compare/web-v12.37.0...web-v12.38.0) (2026-02-13)


### Features

* **api:** add backend support for agent detail page ([#2979](https://github.com/vm0-ai/vm0/issues/2979)) ([4103d8f](https://github.com/vm0-ai/vm0/commit/4103d8f66ccc9546bccc67454d139b8d1de04599))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.14.0

## [12.37.0](https://github.com/vm0-ai/vm0/compare/web-v12.36.1...web-v12.37.0) (2026-02-12)


### Features

* add computer connector api for authenticated local tunneling via ngrok ([#2937](https://github.com/vm0-ai/vm0/issues/2937)) ([4f3fc4e](https://github.com/vm0-ai/vm0/commit/4f3fc4ebf137409a30b85b5882634a6bb8846836))


### Bug Fixes

* **api:** preserve slack admin and default agent on workspace re-install ([#2963](https://github.com/vm0-ai/vm0/issues/2963)) ([d8f26b2](https://github.com/vm0-ai/vm0/commit/d8f26b2e9146fd0923f88c7f082c2c117dfc5a79))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.13.0

## [12.36.1](https://github.com/vm0-ai/vm0/compare/web-v12.36.0...web-v12.36.1) (2026-02-12)


### Bug Fixes

* **web:** make vars validation respect checkenv flag ([#2960](https://github.com/vm0-ai/vm0/issues/2960)) ([a52b291](https://github.com/vm0-ai/vm0/commit/a52b291dbbadec36d048387aa1f76c4131d44fd5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.12.0

## [12.36.0](https://github.com/vm0-ai/vm0/compare/web-v12.35.1...web-v12.36.0) (2026-02-12)


### Features

* **api:** include email-shared agents in agent list endpoints ([#2941](https://github.com/vm0-ai/vm0/issues/2941)) ([1687a74](https://github.com/vm0-ai/vm0/commit/1687a7453b1fa796b85327f959cbfefe1f3f9ee4))
* **email:** add vm0 branding to scheduled run notifications ([#2949](https://github.com/vm0-ai/vm0/issues/2949)) ([db03c4a](https://github.com/vm0-ai/vm0/commit/db03c4af4c67cb25c57163238e241a76a5e67348))


### Bug Fixes

* **email:** align reply subject with schedule notification for threading ([#2952](https://github.com/vm0-ai/vm0/issues/2952)) ([b70c814](https://github.com/vm0-ai/vm0/commit/b70c8149847e70ab831ea2e7f502d6efcdda1711))
* **slack:** add artifact name to create-run call in slack agent handler ([#2955](https://github.com/vm0-ai/vm0/issues/2955)) ([e12262d](https://github.com/vm0-ai/vm0/commit/e12262d261237b4742160ceb0e00f7291984cf5c))
* **web:** resolve build warnings for circular imports, ssh2, and e2b ([#2933](https://github.com/vm0-ai/vm0/issues/2933)) ([87ac6c4](https://github.com/vm0-ai/vm0/commit/87ac6c4a1884629e415447e37e2f2055b5f8b3a3))
* **web:** suppress remaining build warnings ([#2953](https://github.com/vm0-ai/vm0/issues/2953)) ([8bd2c4f](https://github.com/vm0-ai/vm0/commit/8bd2c4f5bc069f1ca9018ceb99703fd5b3938dd0))

## [12.35.1](https://github.com/vm0-ai/vm0/compare/web-v12.35.0...web-v12.35.1) (2026-02-12)


### Bug Fixes

* **slack:** use most recent workspace link for settings api ([#2928](https://github.com/vm0-ai/vm0/issues/2928)) ([53513d1](https://github.com/vm0-ai/vm0/commit/53513d18d9817254a2f6869c6283fa3e618168f6))
* **slack:** use session's compose when continuing conversation ([#2934](https://github.com/vm0-ai/vm0/issues/2934)) ([ca19a82](https://github.com/vm0-ai/vm0/commit/ca19a8266cad225d4e8f3f726f49d3cd66c074e6))

## [12.35.0](https://github.com/vm0-ai/vm0/compare/web-v12.34.0...web-v12.35.0) (2026-02-12)


### Features

* **email:** add email notifications and reply-to-continue via Resend ([#2836](https://github.com/vm0-ai/vm0/issues/2836)) ([fd6aa4c](https://github.com/vm0-ai/vm0/commit/fd6aa4c032a84f25e8c6a8cf4ba4cef5ff070bd9))
* **self-host:** add docker compose setup ([#2853](https://github.com/vm0-ai/vm0/issues/2853)) ([bd757fd](https://github.com/vm0-ai/vm0/commit/bd757fd21385dca449e82f6880bc5265dcf1b80d))
* **storage:** add optional volume support for graceful degradation ([#2929](https://github.com/vm0-ai/vm0/issues/2929)) ([fd052a4](https://github.com/vm0-ai/vm0/commit/fd052a4fef4b2157bb1b1a7a2a0eaccffa6ff262))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.11.0

## [12.34.0](https://github.com/vm0-ai/vm0/compare/web-v12.33.0...web-v12.34.0) (2026-02-12)


### Features

* **docs:** update slack docs and rename ecosystem to integrations ([#2917](https://github.com/vm0-ai/vm0/issues/2917)) ([fe90cd9](https://github.com/vm0-ai/vm0/commit/fe90cd90aa92291fd3f277ca324dd9f43d76b6ac))
* **slack:** redirect to provider setup after connect ([#2854](https://github.com/vm0-ai/vm0/issues/2854)) ([3701bf6](https://github.com/vm0-ai/vm0/commit/3701bf66ad61c8d2ed525e2f97547cfa4bca8d82))


### Bug Fixes

* ensure after() awaits callback dispatch promise ([#2902](https://github.com/vm0-ai/vm0/issues/2902)) ([d62c92f](https://github.com/vm0-ai/vm0/commit/d62c92fcbcf0f7ac330493a6a8be1d52f8643d26))
* **platform:** fix bash error overflow and markdown table light mode ([#2891](https://github.com/vm0-ai/vm0/issues/2891)) ([98c89fd](https://github.com/vm0-ai/vm0/commit/98c89fd53acfe601bc818b1b48b5d67e30676374))

## [12.33.0](https://github.com/vm0-ai/vm0/compare/web-v12.32.2...web-v12.33.0) (2026-02-12)


### Features

* allow users to set timezone preference for sandbox and scheduling ([#2866](https://github.com/vm0-ai/vm0/issues/2866)) ([89437c7](https://github.com/vm0-ai/vm0/commit/89437c733b4e34eee46009b20c99f455c5963289))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.10.0

## [12.32.2](https://github.com/vm0-ai/vm0/compare/web-v12.32.1...web-v12.32.2) (2026-02-11)


### Bug Fixes

* **web:** ensure platform url is available in client components ([#2873](https://github.com/vm0-ai/vm0/issues/2873)) ([b16f8f9](https://github.com/vm0-ai/vm0/commit/b16f8f93dc7c7487681a214050e874dbe3e898d3))

## [12.32.1](https://github.com/vm0-ai/vm0/compare/web-v12.32.0...web-v12.32.1) (2026-02-11)


### Bug Fixes

* enable parallel test execution in web app ([#2865](https://github.com/vm0-ai/vm0/issues/2865)) ([0c04ef0](https://github.com/vm0-ai/vm0/commit/0c04ef08066bf2854b43029b862a48511cce2ccb))

## [12.32.0](https://github.com/vm0-ai/vm0/compare/web-v12.31.0...web-v12.32.0) (2026-02-11)


### Features

* add webhook callback mechanism for agent run completion ([#2829](https://github.com/vm0-ai/vm0/issues/2829)) ([6069b7c](https://github.com/vm0-ai/vm0/commit/6069b7c6c99bc8bda79f214e10df5d2590ef5fad))

## [12.31.0](https://github.com/vm0-ai/vm0/compare/web-v12.30.0...web-v12.31.0) (2026-02-11)


### Features

* **platform:** add connector management to settings page ([#2769](https://github.com/vm0-ai/vm0/issues/2769)) ([418bc1e](https://github.com/vm0-ai/vm0/commit/418bc1e2dd6afb94b3caca84abf260bf542359c8)), closes [#2766](https://github.com/vm0-ai/vm0/issues/2766)
* **slack:** move settings to platform integrations page ([#2797](https://github.com/vm0-ai/vm0/issues/2797)) ([030e41f](https://github.com/vm0-ai/vm0/commit/030e41fa55e7f7eeebb811f6619ad84c954de173))


### Bug Fixes

* **telemetry:** await db fallback instead of fire-and-forget ([#2841](https://github.com/vm0-ai/vm0/issues/2841)) ([7dbabc0](https://github.com/vm0-ai/vm0/commit/7dbabc0cdb6c34e1a221d0353aa77b1405e15e03))


### Performance Improvements

* **web:** optimize agent API query performance with JOINs and Promise.all ([#2816](https://github.com/vm0-ai/vm0/issues/2816)) ([5149283](https://github.com/vm0-ai/vm0/commit/5149283480a3c8c2525a75dace00b6c41946f203))

## [12.30.0](https://github.com/vm0-ai/vm0/compare/web-v12.29.0...web-v12.30.0) (2026-02-11)


### Features

* **deploy:** add self-hosted deployment support with docker and local auth ([#2718](https://github.com/vm0-ai/vm0/issues/2718)) ([498da5e](https://github.com/vm0-ai/vm0/commit/498da5e0a411a034df83c18c00fc287143dc0259))

## [12.29.0](https://github.com/vm0-ai/vm0/compare/web-v12.28.1...web-v12.29.0) (2026-02-11)


### Features

* **slack:** redesign to per-workspace single-agent model ([#2772](https://github.com/vm0-ai/vm0/issues/2772)) ([58f2b94](https://github.com/vm0-ai/vm0/commit/58f2b94b8c6220a5c87de3ecc13bca5eae60dd08))


### Performance Improvements

* **web:** replace N+1 upsert loop with single INSERT...SELECT in aggregate-usage cron ([#2795](https://github.com/vm0-ai/vm0/issues/2795)) ([f5dd92c](https://github.com/vm0-ai/vm0/commit/f5dd92c2f1704697895e07fd8fce6b65fe0735dd))

## [12.28.1](https://github.com/vm0-ai/vm0/compare/web-v12.28.0...web-v12.28.1) (2026-02-11)


### Bug Fixes

* **db:** register orphaned migration 0077 as 0079 in journal ([#2785](https://github.com/vm0-ai/vm0/issues/2785)) ([7a5e013](https://github.com/vm0-ai/vm0/commit/7a5e01395c083b497b38ff3c1b36a3a15b0c6828))

## [12.28.0](https://github.com/vm0-ai/vm0/compare/web-v12.27.0...web-v12.28.0) (2026-02-10)


### Features

* **cli:** add agent delete command ([#2767](https://github.com/vm0-ai/vm0/issues/2767)) ([11d555a](https://github.com/vm0-ai/vm0/commit/11d555ad5432a9893ddc37e55f89a58e7dd5657c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.9.0

## [12.27.0](https://github.com/vm0-ai/vm0/compare/web-v12.26.0...web-v12.27.0) (2026-02-10)


### Features

* **cli:** add --check-env flag to vm0 run commands ([#2760](https://github.com/vm0-ai/vm0/issues/2760)) ([f6711e0](https://github.com/vm0-ai/vm0/commit/f6711e0d047aa872c76f97c8cfaf1257d2f35fb0))
* **slack:** send DM notification when scheduled agent run completes ([#2720](https://github.com/vm0-ai/vm0/issues/2720)) ([77cf47b](https://github.com/vm0-ai/vm0/commit/77cf47b9911a28394bd0b851d75183ea22764bab))
* **web:** add Notion OAuth connector support ([#2738](https://github.com/vm0-ai/vm0/issues/2738)) ([a201b5d](https://github.com/vm0-ai/vm0/commit/a201b5d7ffdd081b4a9f299297bad0e06fa890b1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.8.0

## [12.26.0](https://github.com/vm0-ai/vm0/compare/web-v12.25.0...web-v12.26.0) (2026-02-10)


### Features

* **slack:** add compose agent button to app home ([#2751](https://github.com/vm0-ai/vm0/issues/2751)) ([f5ee9e5](https://github.com/vm0-ai/vm0/commit/f5ee9e57f03b7c5db669480923f019a3a7875e8e))


### Bug Fixes

* exclude connector-provided secrets from missing-secrets checks ([#2752](https://github.com/vm0-ai/vm0/issues/2752)) ([3dc98d4](https://github.com/vm0-ai/vm0/commit/3dc98d47451a2084b50a9a6ebce2f2ccb31d2833)), closes [#2747](https://github.com/vm0-ai/vm0/issues/2747)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.7.1

## [12.25.0](https://github.com/vm0-ai/vm0/compare/web-v12.24.2...web-v12.25.0) (2026-02-10)


### Features

* **slack:** add documentation link to app home and help command ([#2744](https://github.com/vm0-ai/vm0/issues/2744)) ([17145af](https://github.com/vm0-ai/vm0/commit/17145af4512ad4181a7d368bc1b8d931fbf46355))

## [12.24.2](https://github.com/vm0-ai/vm0/compare/web-v12.24.1...web-v12.24.2) (2026-02-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.7.0

## [12.24.1](https://github.com/vm0-ai/vm0/compare/web-v12.24.0...web-v12.24.1) (2026-02-10)


### Performance Improvements

* **ci:** speed up preview deploy with vercel prebuilt and skip sentry source maps ([#2712](https://github.com/vm0-ai/vm0/issues/2712)) ([bf2fdfd](https://github.com/vm0-ai/vm0/commit/bf2fdfdb9c10137bcafe3099f8c107bece82eee6))

## [12.24.0](https://github.com/vm0-ai/vm0/compare/web-v12.23.0...web-v12.24.0) (2026-02-10)


### Features

* **platform:** detect and display missing secrets for agents ([#2664](https://github.com/vm0-ai/vm0/issues/2664)) ([e43fb63](https://github.com/vm0-ai/vm0/commit/e43fb63d574f3f614254e702c76270b59381fedf))

## [12.23.0](https://github.com/vm0-ai/vm0/compare/web-v12.22.2...web-v12.23.0) (2026-02-09)


### Features

* **slack:** auto-setup scope, model provider check, and artifact during link flow ([#2697](https://github.com/vm0-ai/vm0/issues/2697)) ([846f90d](https://github.com/vm0-ai/vm0/commit/846f90d652a63bb9c1487768f79cf637f9fa3798))

## [12.22.2](https://github.com/vm0-ai/vm0/compare/web-v12.22.1...web-v12.22.2) (2026-02-09)


### Bug Fixes

* **web:** disable json query to fix flaky ambiguous-prefix test ([#2701](https://github.com/vm0-ai/vm0/issues/2701)) ([a5f8e8a](https://github.com/vm0-ai/vm0/commit/a5f8e8a375a3a84c46518780201b66f75ea845a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.6.1

## [12.22.1](https://github.com/vm0-ai/vm0/compare/web-v12.22.0...web-v12.22.1) (2026-02-09)


### Bug Fixes

* **slack:** return caddy proxy address for platform in dev environment ([#2687](https://github.com/vm0-ai/vm0/issues/2687)) ([d2fa6e4](https://github.com/vm0-ai/vm0/commit/d2fa6e4c278dc021b490087c505ca43e7beea603))
* **test:** remove vi.unstubAllEnvs from CLI tests and fix compose job race condition ([#2695](https://github.com/vm0-ai/vm0/issues/2695)) ([04ab29b](https://github.com/vm0-ai/vm0/commit/04ab29bf89201bb921d6a2f63b9ea4e3f2ab899d))

## [12.22.0](https://github.com/vm0-ai/vm0/compare/web-v12.21.0...web-v12.22.0) (2026-02-09)


### Features

* **slack:** deduplicate context messages across thread turns ([#2641](https://github.com/vm0-ai/vm0/issues/2641)) ([f0159cb](https://github.com/vm0-ai/vm0/commit/f0159cbccb96089a6379735617836ca930a247ca))
* **web:** add db:reset script for local development ([#2676](https://github.com/vm0-ai/vm0/issues/2676)) ([2dd6429](https://github.com/vm0-ai/vm0/commit/2dd64297c5982da0f7d4c02a4726f82e49630619))


### Bug Fixes

* **web:** add pointer-events-none to auth page overlays and fix otp input styles ([#2683](https://github.com/vm0-ai/vm0/issues/2683)) ([aca61f1](https://github.com/vm0-ai/vm0/commit/aca61f16767942d6bd9b5ab4922bd5d22ae258e7))

## [12.21.0](https://github.com/vm0-ai/vm0/compare/web-v12.20.0...web-v12.21.0) (2026-02-09)


### Features

* **cli:** add filtering options to run list command ([#2646](https://github.com/vm0-ai/vm0/issues/2646)) ([73c3509](https://github.com/vm0-ai/vm0/commit/73c3509380b5038eb5b97df6ab50106d41ea7358))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.6.0

## [12.20.0](https://github.com/vm0-ai/vm0/compare/web-v12.19.1...web-v12.20.0) (2026-02-09)


### Features

* **slack:** extract /vm0 agent compose as standalone command ([#2638](https://github.com/vm0-ai/vm0/issues/2638)) ([bb0ee22](https://github.com/vm0-ai/vm0/commit/bb0ee22df4d72a0e4cd09c06f51f975c56eefc12))

## [12.19.1](https://github.com/vm0-ai/vm0/compare/web-v12.19.0...web-v12.19.1) (2026-02-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.5.1

## [12.19.0](https://github.com/vm0-ai/vm0/compare/web-v12.18.0...web-v12.19.0) (2026-02-09)


### Features

* **platform:** add secret/variable settings page with tabs and url deep-linking ([#2624](https://github.com/vm0-ai/vm0/issues/2624)) ([dac5bad](https://github.com/vm0-ai/vm0/commit/dac5badf4773b7602ceca837a224eb58220f4b5e))

## [12.18.0](https://github.com/vm0-ai/vm0/compare/web-v12.17.0...web-v12.18.0) (2026-02-09)


### Features

* **slack:** display user email instead of user ID on app home page ([#2618](https://github.com/vm0-ai/vm0/issues/2618)) ([5963097](https://github.com/vm0-ai/vm0/commit/5963097e89ded2dd8b76b562dc03ef210c2db494))

## [12.17.0](https://github.com/vm0-ai/vm0/compare/web-v12.16.0...web-v12.17.0) (2026-02-09)


### Features

* **web:** split axiom token into scoped tokens for least-privilege access ([#2578](https://github.com/vm0-ai/vm0/issues/2578)) ([bb8eded](https://github.com/vm0-ai/vm0/commit/bb8ededd238e504cf9ccf79867205d115259aec2)), closes [#2564](https://github.com/vm0-ai/vm0/issues/2564)

## [12.16.0](https://github.com/vm0-ai/vm0/compare/web-v12.15.0...web-v12.16.0) (2026-02-09)


### Features

* **slack:** allow composing agents from github in agent link command ([#2567](https://github.com/vm0-ai/vm0/issues/2567)) ([66ea133](https://github.com/vm0-ai/vm0/commit/66ea13371e3b28525e82019a483d8503d6cdd8dc))

## [12.15.0](https://github.com/vm0-ai/vm0/compare/web-v12.14.2...web-v12.15.0) (2026-02-09)


### Features

* **web:** add usage_daily aggregation with dual-path on-demand caching ([#2587](https://github.com/vm0-ai/vm0/issues/2587)) ([5fbacc5](https://github.com/vm0-ai/vm0/commit/5fbacc5e68c93c5445c40ab98f6ed59c982663be))
* **web:** handle agent timeout with user notification in Slack threads ([#2563](https://github.com/vm0-ai/vm0/issues/2563)) ([00456d8](https://github.com/vm0-ai/vm0/commit/00456d841dde7fed7e848cbab41bb6236c34ffe7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.5.0

## [12.14.2](https://github.com/vm0-ai/vm0/compare/web-v12.14.1...web-v12.14.2) (2026-02-08)


### Bug Fixes

* **web:** improve responsive padding for landing page cards ([#2573](https://github.com/vm0-ai/vm0/issues/2573)) ([ed9f8ea](https://github.com/vm0-ai/vm0/commit/ed9f8ea828a1aeef64d156fc90295d810aee8bfe))
* **web:** inject connector secrets only for explicit ${{ secrets.* }} references ([#2599](https://github.com/vm0-ai/vm0/issues/2599)) ([281baa0](https://github.com/vm0-ai/vm0/commit/281baa07e0451371f176d4546c7a7b8f6d3059f2)), closes [#2598](https://github.com/vm0-ai/vm0/issues/2598)

## [12.14.1](https://github.com/vm0-ai/vm0/compare/web-v12.14.0...web-v12.14.1) (2026-02-07)


### Bug Fixes

* **web:** inject connector secrets into agent execution environment ([#2584](https://github.com/vm0-ai/vm0/issues/2584)) ([f483b5b](https://github.com/vm0-ai/vm0/commit/f483b5b0c0c94e45a149f99b8f108c3fc74399a4))
* **web:** make storage download ambiguous-prefix test deterministic ([#2572](https://github.com/vm0-ai/vm0/issues/2572)) ([e48f09e](https://github.com/vm0-ai/vm0/commit/e48f09ebf9c341c8e3647adba05b6b50e968eee4)), closes [#2562](https://github.com/vm0-ai/vm0/issues/2562)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.4.2

## [12.14.0](https://github.com/vm0-ai/vm0/compare/web-v12.13.2...web-v12.14.0) (2026-02-07)


### Features

* **slack:** add app home tab, welcome message, and DM improvements ([#2554](https://github.com/vm0-ai/vm0/issues/2554)) ([131b380](https://github.com/vm0-ai/vm0/commit/131b3807e6b056e71717c5b7e1e36ca3c04ed14f))


### Bug Fixes

* **schedule:** validate secrets/vars against platform tables ([#2558](https://github.com/vm0-ai/vm0/issues/2558)) ([f19d550](https://github.com/vm0-ai/vm0/commit/f19d5506e61f16536bf163e5884266d31326fe40))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.4.1

## [12.13.2](https://github.com/vm0-ai/vm0/compare/web-v12.13.1...web-v12.13.2) (2026-02-07)


### Bug Fixes

* **web:** add api url fallback for compose job webhooks ([#2553](https://github.com/vm0-ai/vm0/issues/2553)) ([361e3b7](https://github.com/vm0-ai/vm0/commit/361e3b799d529d02a7c2e6082f13723d5262bd81)), closes [#2550](https://github.com/vm0-ai/vm0/issues/2550)

## [12.13.1](https://github.com/vm0-ai/vm0/compare/web-v12.13.0...web-v12.13.1) (2026-02-07)


### Bug Fixes

* **web:** add missing job ID filter in cleanup-compose-jobs cron WHERE clause ([#2534](https://github.com/vm0-ai/vm0/issues/2534)) ([f6bea80](https://github.com/vm0-ai/vm0/commit/f6bea803423da0527386e0a890a245757d949d0f))

## [12.13.0](https://github.com/vm0-ai/vm0/compare/web-v12.12.0...web-v12.13.0) (2026-02-07)


### Features

* **connector:** implement github oauth connector with cli support ([#2446](https://github.com/vm0-ai/vm0/issues/2446)) ([c12c97a](https://github.com/vm0-ai/vm0/commit/c12c97a2af0b74d8bdfd452e2cbe7000f9e24f34))


### Performance Improvements

* **web:** add vm0-cli e2b template for faster compose jobs ([#2519](https://github.com/vm0-ai/vm0/issues/2519)) ([d560bde](https://github.com/vm0-ai/vm0/commit/d560bde2f2fb3fc3b71b7f2c125709ab6c66008a)), closes [#2516](https://github.com/vm0-ai/vm0/issues/2516)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.4.0

## [12.12.0](https://github.com/vm0-ai/vm0/compare/web-v12.11.0...web-v12.12.0) (2026-02-07)


### Features

* **web:** add server-side github compose api ([#2473](https://github.com/vm0-ai/vm0/issues/2473)) ([9ab1f23](https://github.com/vm0-ai/vm0/commit/9ab1f2344f11086fd0f4c30036d04c72fab61b68))


### Performance Improvements

* **web:** replace N+1 queries with JOIN in runs list endpoint ([#2501](https://github.com/vm0-ai/vm0/issues/2501)) ([e426b59](https://github.com/vm0-ai/vm0/commit/e426b595771fc6348a45d5fe843e68c2134af358))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.3.0

## [12.11.0](https://github.com/vm0-ai/vm0/compare/web-v12.10.0...web-v12.11.0) (2026-02-06)


### Features

* **cli:** add --porcelain option to compose command ([#2494](https://github.com/vm0-ai/vm0/issues/2494)) ([f5f5a3f](https://github.com/vm0-ai/vm0/commit/f5f5a3fad10cff2a2cc7e962d40062f9c004fd88))


### Bug Fixes

* **web:** exclude stale pending runs from concurrency check ([#2445](https://github.com/vm0-ai/vm0/issues/2445)) ([0dc7427](https://github.com/vm0-ai/vm0/commit/0dc7427a10d4faa382d771664a09b1b0739231c6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.2.2

## [12.10.0](https://github.com/vm0-ai/vm0/compare/web-v12.9.0...web-v12.10.0) (2026-02-06)


### Features

* **slack:** add direct message chat capability ([#2489](https://github.com/vm0-ai/vm0/issues/2489)) ([b5a01bf](https://github.com/vm0-ai/vm0/commit/b5a01bfb927d360b73bbf28b5e9e370cdb5127ce))

## [12.9.0](https://github.com/vm0-ai/vm0/compare/web-v12.8.0...web-v12.9.0) (2026-02-06)


### Features

* improve banner and navbar design ([#2478](https://github.com/vm0-ai/vm0/issues/2478)) ([e028418](https://github.com/vm0-ai/vm0/commit/e0284187c6e00e999d26863c7578c933c8e91f8a))

## [12.8.0](https://github.com/vm0-ai/vm0/compare/web-v12.7.2...web-v12.8.0) (2026-02-06)


### Features

* **web:** add blog public routes and fix list styling ([#2472](https://github.com/vm0-ai/vm0/issues/2472)) ([c93aa30](https://github.com/vm0-ai/vm0/commit/c93aa30ca65ce37982ff7129cc2616eba722f4ab))
* **web:** add eslint rule to prevent direct db access in tests ([#2470](https://github.com/vm0-ai/vm0/issues/2470)) ([da6c435](https://github.com/vm0-ai/vm0/commit/da6c435fdba3686380720bfc25db4fc4c538fc6f))
* **web:** load author avatars from strapi in blog ([#2474](https://github.com/vm0-ai/vm0/issues/2474)) ([d490cfa](https://github.com/vm0-ai/vm0/commit/d490cfac7635c38fcb95cb64fc42def47b92208c))


### Bug Fixes

* **web:** validate locale before dynamic import in i18n config ([#2453](https://github.com/vm0-ai/vm0/issues/2453)) ([0a84b2a](https://github.com/vm0-ai/vm0/commit/0a84b2a224d9af8099a5cda452cbc3c1df1d3379)), closes [#2452](https://github.com/vm0-ai/vm0/issues/2452)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.2.1

## [12.7.2](https://github.com/vm0-ai/vm0/compare/web-v12.7.1...web-v12.7.2) (2026-02-05)


### Bug Fixes

* **slack:** update command naming and auto-configure dev environment ([#2424](https://github.com/vm0-ai/vm0/issues/2424)) ([a684bfe](https://github.com/vm0-ai/vm0/commit/a684bfe99b362a8677d2075d9fc67a06fb0a8704))

## [12.7.1](https://github.com/vm0-ai/vm0/compare/web-v12.7.0...web-v12.7.1) (2026-02-05)


### Bug Fixes

* **cli:** normalize agent name to lowercase before uploading instructions ([#2417](https://github.com/vm0-ai/vm0/issues/2417)) ([afb1a9c](https://github.com/vm0-ai/vm0/commit/afb1a9cb07fe2aeef4b139ff79a1179351ff35c8)), closes [#2414](https://github.com/vm0-ai/vm0/issues/2414)
* **slack:** download and upload images to R2 for Claude Code access ([#2413](https://github.com/vm0-ai/vm0/issues/2413)) ([eda84dc](https://github.com/vm0-ai/vm0/commit/eda84dc6065a66f0aa70c925323933fc80a12579))

## [12.7.0](https://github.com/vm0-ai/vm0/compare/web-v12.6.0...web-v12.7.0) (2026-02-05)


### Features

* **web:** make database pool settings configurable via env vars ([#2373](https://github.com/vm0-ai/vm0/issues/2373)) ([baf911f](https://github.com/vm0-ai/vm0/commit/baf911f2e88aa5bcbabbd74d32d9314275271144))

## [12.6.0](https://github.com/vm0-ai/vm0/compare/web-v12.5.0...web-v12.6.0) (2026-02-05)


### Features

* **web:** integrate sentry error tracking ([#2397](https://github.com/vm0-ai/vm0/issues/2397)) ([994c21d](https://github.com/vm0-ai/vm0/commit/994c21d18d0380594bb72dc20ade24b36efe3d2b))

## [12.5.0](https://github.com/vm0-ai/vm0/compare/web-v12.4.0...web-v12.5.0) (2026-02-05)


### Features

* **slack:** add vars input support in agent add/update flow ([#2388](https://github.com/vm0-ai/vm0/issues/2388)) ([7711d2e](https://github.com/vm0-ai/vm0/commit/7711d2e94ca58493447fa19ef0524e3b8c9845dd)), closes [#2387](https://github.com/vm0-ai/vm0/issues/2387)


### Bug Fixes

* **slack:** remove thread_ts from ephemeral login prompt ([#2390](https://github.com/vm0-ai/vm0/issues/2390)) ([a8a459d](https://github.com/vm0-ai/vm0/commit/a8a459d4cfa16af6683c0d33f80ce1aedb561961))

## [12.4.0](https://github.com/vm0-ai/vm0/compare/web-v12.3.0...web-v12.4.0) (2026-02-05)


### Features

* **agent:** add agent sharing with acl-based access control ([#2377](https://github.com/vm0-ai/vm0/issues/2377)) ([d3f63c6](https://github.com/vm0-ai/vm0/commit/d3f63c61b08a93bf9cbffda51ff77f389e18316b))


### Bug Fixes

* **slack:** add artifact name parameter to run context ([#2378](https://github.com/vm0-ai/vm0/issues/2378)) ([11529db](https://github.com/vm0-ai/vm0/commit/11529dbcee53a6adb6e3cc173c84ca0e7348cb81))

## [12.3.0](https://github.com/vm0-ai/vm0/compare/web-v12.2.1...web-v12.3.0) (2026-02-05)


### Features

* **docs:** update environment variables documentation to reflect current implementation ([#2379](https://github.com/vm0-ai/vm0/issues/2379)) ([f937d73](https://github.com/vm0-ai/vm0/commit/f937d735d7c2fa45a709997cfbe1370d5fb0bbc8))

## [12.2.1](https://github.com/vm0-ai/vm0/compare/web-v12.2.0...web-v12.2.1) (2026-02-05)


### Bug Fixes

* **slack:** make login prompt ephemeral and restore bindings on re-link ([#2359](https://github.com/vm0-ai/vm0/issues/2359)) ([8564e5a](https://github.com/vm0-ai/vm0/commit/8564e5a12e051d0704edd3a3285c9a0268de71f9))

## [12.2.0](https://github.com/vm0-ai/vm0/compare/web-v12.1.1...web-v12.2.0) (2026-02-04)


### Features

* **cli:** add vm0 variable command for server-side variable storage ([#2344](https://github.com/vm0-ai/vm0/issues/2344)) ([6831866](https://github.com/vm0-ai/vm0/commit/6831866c271e5b711fa979c1deef56c1ab9bd2a4))


### Bug Fixes

* **api:** pass authorization header in /v1/runs/:id/logs endpoint ([#2363](https://github.com/vm0-ai/vm0/issues/2363)) ([a3d3171](https://github.com/vm0-ai/vm0/commit/a3d3171e21f16f5f6128ec9116f68aa97129d880)), closes [#2335](https://github.com/vm0-ai/vm0/issues/2335)
* auto-fetch secrets from database for secrets.* references ([#2358](https://github.com/vm0-ai/vm0/issues/2358)) ([7197a86](https://github.com/vm0-ai/vm0/commit/7197a865e1d89259599ee0b5c71d6618c3ae221f)), closes [#2355](https://github.com/vm0-ai/vm0/issues/2355)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.2.0

## [12.1.1](https://github.com/vm0-ai/vm0/compare/web-v12.1.0...web-v12.1.1) (2026-02-04)


### Bug Fixes

* **site,web,platform:** replace favicon with vm0 logo ([#2347](https://github.com/vm0-ai/vm0/issues/2347)) ([b380a1e](https://github.com/vm0-ai/vm0/commit/b380a1edb42e485d6392e9861a62064761fcbede))

## [12.1.0](https://github.com/vm0-ai/vm0/compare/web-v12.0.0...web-v12.1.0) (2026-02-04)


### Features

* **slack:** integrate user secrets with agent modals ([#2328](https://github.com/vm0-ai/vm0/issues/2328)) ([8657063](https://github.com/vm0-ai/vm0/commit/865706306fe3be3254ef0699fdf5c5479a9f9262))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.1.0

## [12.0.0](https://github.com/vm0-ai/vm0/compare/web-v11.26.0...web-v12.0.0) (2026-02-04)


### ⚠ BREAKING CHANGES

* **e2b:** The :dev tag is no longer supported for system images. Use vm0/claude-code or vm0/codex without tag (defaults to :latest).

### Bug Fixes

* **slack:** resolve connection timeout in [@mention](https://github.com/mention) handler ([#2309](https://github.com/vm0-ai/vm0/issues/2309)) ([c2bddb0](https://github.com/vm0-ai/vm0/commit/c2bddb0e4c2ab0a72b3d912e1ce7f9eb2bb240e4))
* **web:** improve e2b config documentation ([#2313](https://github.com/vm0-ai/vm0/issues/2313)) ([b1a86a9](https://github.com/vm0-ai/vm0/commit/b1a86a9e5b6360cb23f4db6ee1e893c4ec6bcd34))


### Code Refactoring

* **e2b:** remove -dev suffix and hardcode template names ([#2306](https://github.com/vm0-ai/vm0/issues/2306)) ([f2aaf5b](https://github.com/vm0-ai/vm0/commit/f2aaf5b734c6799e841c596bdcaa18c86e3cbb0d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.0.0

## [11.26.0](https://github.com/vm0-ai/vm0/compare/web-v11.25.0...web-v11.26.0) (2026-02-04)


### Features

* add /api/secrets endpoints for credential-to-secret migration (Phase 1) ([#2293](https://github.com/vm0-ai/vm0/issues/2293)) ([0954347](https://github.com/vm0-ai/vm0/commit/0954347e24a495d40b4ad0b28afb7c338e56ee6c))
* **web:** add slack session continuation and binding preservation ([#2294](https://github.com/vm0-ai/vm0/issues/2294)) ([8a9701e](https://github.com/vm0-ai/vm0/commit/8a9701ecd7a1e3639000e8f2936a322216ab2006))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.15.0

## [11.25.0](https://github.com/vm0-ai/vm0/compare/web-v11.24.1...web-v11.25.0) (2026-02-04)


### Features

* **model-provider:** add deepseek api key support and simplify provider labels ([#2276](https://github.com/vm0-ai/vm0/issues/2276)) ([1fcd190](https://github.com/vm0-ai/vm0/commit/1fcd190fe8d95dc141001f911442b8f2b592c7d0)), closes [#2262](https://github.com/vm0-ai/vm0/issues/2262)
* **storage:** migrate storages from user-level to scope-level ownership ([#2263](https://github.com/vm0-ai/vm0/issues/2263)) ([698d021](https://github.com/vm0-ai/vm0/commit/698d0218258387ace372cfc3f69e0132a7b33f14)), closes [#2252](https://github.com/vm0-ai/vm0/issues/2252)


### Bug Fixes

* **web:** handle invalid slack auth errors with auto-cleanup ([#2281](https://github.com/vm0-ai/vm0/issues/2281)) ([02bd5de](https://github.com/vm0-ai/vm0/commit/02bd5de14088e8afb83ca7d9a4ace59372876571))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.14.0

## [11.24.1](https://github.com/vm0-ai/vm0/compare/web-v11.24.0...web-v11.24.1) (2026-02-03)


### Bug Fixes

* **web:** make slack login success message ephemeral and update wording ([#2253](https://github.com/vm0-ai/vm0/issues/2253)) ([a485b33](https://github.com/vm0-ai/vm0/commit/a485b33de3f7848e39450d1e4a8d907c87a3173a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.13.0

## [11.24.0](https://github.com/vm0-ai/vm0/compare/web-v11.23.0...web-v11.24.0) (2026-02-03)


### Features

* **model-provider:** add aws bedrock support with multi-auth provider architecture ([#2214](https://github.com/vm0-ai/vm0/issues/2214)) ([8009acf](https://github.com/vm0-ai/vm0/commit/8009acf84785e70aaf63f47e23358184d6058c22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.12.0

## [11.23.0](https://github.com/vm0-ai/vm0/compare/web-v11.22.0...web-v11.23.0) (2026-02-03)


### Features

* **web:** add llm chat api using openrouter sdk ([#2195](https://github.com/vm0-ai/vm0/issues/2195)) ([d0368a2](https://github.com/vm0-ai/vm0/commit/d0368a28c662fbc4894704a733c05f778c502aac))
* **web:** enhance slack agent management with dynamic modals ([#2238](https://github.com/vm0-ai/vm0/issues/2238)) ([e319427](https://github.com/vm0-ai/vm0/commit/e319427e65b75e90954b567c63497caa7bf0436d))


### Bug Fixes

* **web:** add execution step tracking to E2B executor for better error diagnostics ([#2230](https://github.com/vm0-ai/vm0/issues/2230)) ([1484cb1](https://github.com/vm0-ai/vm0/commit/1484cb167fa147846a21135a98726b11bc16accf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.11.0

## [11.22.0](https://github.com/vm0-ai/vm0/compare/web-v11.21.0...web-v11.22.0) (2026-02-03)


### Features

* **auth:** environment-based access control for test-token endpoint ([#2216](https://github.com/vm0-ai/vm0/issues/2216)) ([aff841a](https://github.com/vm0-ai/vm0/commit/aff841ab747bb08e2df8f584bfb232d6d516c1c4)), closes [#2211](https://github.com/vm0-ai/vm0/issues/2211)
* **platform:** add session id and framework fields to logs list response ([#2208](https://github.com/vm0-ai/vm0/issues/2208)) ([8a55eca](https://github.com/vm0-ai/vm0/commit/8a55eca92e46080d248160cbba8eebdf40769750))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.10.0

## [11.21.0](https://github.com/vm0-ai/vm0/compare/web-v11.20.0...web-v11.21.0) (2026-02-03)


### Features

* enhance design system with improved components ([#2190](https://github.com/vm0-ai/vm0/issues/2190)) ([b6fc9c4](https://github.com/vm0-ai/vm0/commit/b6fc9c4131b223be1f45e5d17951e5c3243ffb6d))

## [11.20.0](https://github.com/vm0-ai/vm0/compare/web-v11.19.0...web-v11.20.0) (2026-02-03)


### Features

* add minimax-api-key model provider ([#2178](https://github.com/vm0-ai/vm0/issues/2178)) ([4176dbc](https://github.com/vm0-ai/vm0/commit/4176dbc3af4a1836cc4758d58d51e29e2f8feccc))
* **ci:** replace playwright browser auth with API-based test-approve endpoint ([#2155](https://github.com/vm0-ai/vm0/issues/2155)) ([d0abf6b](https://github.com/vm0-ai/vm0/commit/d0abf6b6dcb23213bbdf3a7a37e67dbad842276a))
* **cli:** improve model-provider setup ux with configuration status ([#2182](https://github.com/vm0-ai/vm0/issues/2182)) ([6c6617d](https://github.com/vm0-ai/vm0/commit/6c6617d5014ae86861df99488e64b577ee94ef26))
* **core:** add openrouter-api-key model provider with auto routing ([#2151](https://github.com/vm0-ai/vm0/issues/2151)) ([861d7dc](https://github.com/vm0-ai/vm0/commit/861d7dcee779d4d0082e3b9f7deed67e1d429c02))
* **slack:** add event handling for [@mentions](https://github.com/mentions) ([#2163](https://github.com/vm0-ai/vm0/issues/2163)) ([4781d2d](https://github.com/vm0-ai/vm0/commit/4781d2d556f0149d33fdaa75fe61fc3fd0c43fff))
* **slack:** add slash commands and interactive endpoints ([#2173](https://github.com/vm0-ai/vm0/issues/2173)) ([aeb778a](https://github.com/vm0-ai/vm0/commit/aeb778a642520b01aed1ce9b8417759af9caf618))


### Bug Fixes

* **web:** surface volume resolution errors to users ([#2175](https://github.com/vm0-ai/vm0/issues/2175)) ([66b8b64](https://github.com/vm0-ai/vm0/commit/66b8b644196392644c79f817c8ac8d564f3d990a))


### Performance Improvements

* **platform:** include basic log info in logs list API response ([#2165](https://github.com/vm0-ai/vm0/issues/2165)) ([1a4d4c5](https://github.com/vm0-ai/vm0/commit/1a4d4c51171bf1f08df6d305dd9dce488d8c652f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.9.0

## [11.19.0](https://github.com/vm0-ai/vm0/compare/web-v11.18.0...web-v11.19.0) (2026-02-02)


### Features

* **slack:** add oauth flow and user account linking ([#2145](https://github.com/vm0-ai/vm0/issues/2145)) ([90f5950](https://github.com/vm0-ai/vm0/commit/90f59509f8195ad270181c7534fce8d224c98676))

## [11.18.0](https://github.com/vm0-ai/vm0/compare/web-v11.17.0...web-v11.18.0) (2026-02-02)


### Features

* add status page link to landing page footer ([#2149](https://github.com/vm0-ai/vm0/issues/2149)) ([e5073a5](https://github.com/vm0-ai/vm0/commit/e5073a5bd6c4df4ee244c8c47385f2fa18df5589)), closes [#2139](https://github.com/vm0-ai/vm0/issues/2139)

## [11.17.0](https://github.com/vm0-ai/vm0/compare/web-v11.16.0...web-v11.17.0) (2026-02-02)


### Features

* **slack:** add foundation for slack bot integration ([#2114](https://github.com/vm0-ai/vm0/issues/2114)) ([22ee223](https://github.com/vm0-ai/vm0/commit/22ee223c2e94a3cdf2ff72ed81306f9aae054cf1))
* **web:** redirect get started button to platform for signed-in users ([#2132](https://github.com/vm0-ai/vm0/issues/2132)) ([725f7ea](https://github.com/vm0-ai/vm0/commit/725f7ea8624aa5689f6e0604bcd538d0702a38f7))

## [11.16.0](https://github.com/vm0-ai/vm0/compare/web-v11.15.1...web-v11.16.0) (2026-02-02)


### Features

* add moonshot-api-key provider with credential mapping and model selection ([#2110](https://github.com/vm0-ai/vm0/issues/2110)) ([88f8f9d](https://github.com/vm0-ai/vm0/commit/88f8f9d369529752eac68eec426153d8b82ab5fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.8.0

## [11.15.1](https://github.com/vm0-ai/vm0/compare/web-v11.15.0...web-v11.15.1) (2026-02-02)


### Bug Fixes

* **cli:** show helpful hints when concurrent run limit is reached ([#2122](https://github.com/vm0-ai/vm0/issues/2122)) ([47c7dfa](https://github.com/vm0-ai/vm0/commit/47c7dfa4996ea615b0e14b0a22fd909774ccde87))

## [11.15.0](https://github.com/vm0-ai/vm0/compare/web-v11.14.1...web-v11.15.0) (2026-02-02)


### Features

* **schedule:** retry scheduled runs on concurrency limit ([#2008](https://github.com/vm0-ai/vm0/issues/2008)) ([0f86346](https://github.com/vm0-ai/vm0/commit/0f8634676633bd9f1f6ab061b122cd5e1e39a065))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.7.0

## [11.14.1](https://github.com/vm0-ai/vm0/compare/web-v11.14.0...web-v11.14.1) (2026-02-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.6.1

## [11.14.0](https://github.com/vm0-ai/vm0/compare/web-v11.13.0...web-v11.14.0) (2026-02-01)


### Features

* **cli:** release onboard banner update ([#2084](https://github.com/vm0-ai/vm0/issues/2084)) ([402820c](https://github.com/vm0-ai/vm0/commit/402820cbeabed134c3a757d4c8400037fce4c427))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.6.0

## [11.13.0](https://github.com/vm0-ai/vm0/compare/web-v11.12.1...web-v11.13.0) (2026-02-01)


### Features

* **web:** optimize landing page responsive design and styling ([#2063](https://github.com/vm0-ai/vm0/issues/2063)) ([ce3c6de](https://github.com/vm0-ai/vm0/commit/ce3c6de1541871667d71587f1bc0ef06e8ea8499))

## [11.12.1](https://github.com/vm0-ai/vm0/compare/web-v11.12.0...web-v11.12.1) (2026-01-31)


### Bug Fixes

* **web:** make logo clickable on sign-in and sign-up pages ([#2053](https://github.com/vm0-ai/vm0/issues/2053)) ([18e7ff5](https://github.com/vm0-ai/vm0/commit/18e7ff5071a919dac9edf4ee6af86e9ee19a970c)), closes [#2051](https://github.com/vm0-ai/vm0/issues/2051)

## [11.12.0](https://github.com/vm0-ai/vm0/compare/web-v11.11.0...web-v11.12.0) (2026-01-31)


### Features

* **web:** optimize sign-up verification code input styling ([#2044](https://github.com/vm0-ai/vm0/issues/2044)) ([0efacaf](https://github.com/vm0-ai/vm0/commit/0efacafd69f93cffa4952d5206d7f87fd3c48a53))

## [11.11.0](https://github.com/vm0-ai/vm0/compare/web-v11.10.0...web-v11.11.0) (2026-01-31)


### Features

* **web:** replace waitlist with signup component ([#2038](https://github.com/vm0-ai/vm0/issues/2038)) ([350c9f5](https://github.com/vm0-ai/vm0/commit/350c9f5268510f9e6484e5b933ab267ae3455cbf))

## [11.10.0](https://github.com/vm0-ai/vm0/compare/web-v11.9.1...web-v11.10.0) (2026-01-31)


### Features

* enable observation logs and redirect logged-in users to platform ([#2027](https://github.com/vm0-ai/vm0/issues/2027)) ([eb51f47](https://github.com/vm0-ai/vm0/commit/eb51f47cfea75abaf1aee0a0a288bf1497675a15))
* **web:** sync landing page from site app ([#2029](https://github.com/vm0-ai/vm0/issues/2029)) ([4cec6ab](https://github.com/vm0-ai/vm0/commit/4cec6ab0a2f3d3f124b98f0dcd677c2bbbf386d3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.5.0

## [11.9.1](https://github.com/vm0-ai/vm0/compare/web-v11.9.0...web-v11.9.1) (2026-01-31)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.4.2

## [11.9.0](https://github.com/vm0-ai/vm0/compare/web-v11.8.0...web-v11.9.0) (2026-01-30)


### Features

* **seo:** enhance seo and social sharing for vm0.ai and docs.vm0.ai ([#1939](https://github.com/vm0-ai/vm0/issues/1939)) ([761fecb](https://github.com/vm0-ai/vm0/commit/761fecb9d3afdbe50b3b8d7b568bc40926db14cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.4.1

## [11.8.0](https://github.com/vm0-ai/vm0/compare/web-v11.7.0...web-v11.8.0) (2026-01-30)


### Features

* **ui:** enhance design system and improve onboarding and settings ui ([#1894](https://github.com/vm0-ai/vm0/issues/1894)) ([6a11166](https://github.com/vm0-ai/vm0/commit/6a1116694544c01c69ea20dbf80a986ee8294f30))

## [11.7.0](https://github.com/vm0-ai/vm0/compare/web-v11.6.1...web-v11.7.0) (2026-01-30)


### Features

* add api timing metrics for runner and e2b executor analysis ([#1836](https://github.com/vm0-ai/vm0/issues/1836)) ([3ac62ef](https://github.com/vm0-ai/vm0/commit/3ac62ef48325514c2e7fa8d5d1c87bd45d440446))


### Bug Fixes

* detect and use existing package manager in install.sh ([#1882](https://github.com/vm0-ai/vm0/issues/1882)) ([740ee67](https://github.com/vm0-ai/vm0/commit/740ee670cc0052545c2df640e17845bfd3f77edf)), closes [#1881](https://github.com/vm0-ai/vm0/issues/1881)

## [11.6.1](https://github.com/vm0-ai/vm0/compare/web-v11.6.0...web-v11.6.1) (2026-01-29)


### Bug Fixes

* add missing NEXT_PUBLIC_BASE_URL env var for blog ([#1856](https://github.com/vm0-ai/vm0/issues/1856)) ([a80ccef](https://github.com/vm0-ai/vm0/commit/a80ccef34c9052206be0abd35ac90c1a6b376144))

## [11.6.0](https://github.com/vm0-ai/vm0/compare/web-v11.5.0...web-v11.6.0) (2026-01-29)


### Features

* **web:** add install.sh for curl-based cli installation ([#1846](https://github.com/vm0-ai/vm0/issues/1846)) ([cf7a254](https://github.com/vm0-ai/vm0/commit/cf7a2540582ad55e70460f929f34a259fcc80c5b))


### Bug Fixes

* **web:** kill e2b sandbox when cancelling runs ([#1840](https://github.com/vm0-ai/vm0/issues/1840)) ([2af5ac7](https://github.com/vm0-ai/vm0/commit/2af5ac70ea95ec9b13364c922c14b717dedc9ae1))

## [11.5.0](https://github.com/vm0-ai/vm0/compare/web-v11.4.1...web-v11.5.0) (2026-01-29)


### Features

* add E2E timing metrics from API to agent start ([#1830](https://github.com/vm0-ai/vm0/issues/1830)) ([4884e14](https://github.com/vm0-ai/vm0/commit/4884e143b81334f06d3863ad70ba7885c2ba8a5f))
* **cli:** add `vm0 run list` and `vm0 run kill` commands ([#1826](https://github.com/vm0-ai/vm0/issues/1826)) ([7b42a47](https://github.com/vm0-ai/vm0/commit/7b42a47bba2da1bfe5ac59c9ce01b242e9c8524f))


### Bug Fixes

* **web:** cleanup stale pending runs and handle null heartbeat fallback ([#1831](https://github.com/vm0-ai/vm0/issues/1831)) ([80f5154](https://github.com/vm0-ai/vm0/commit/80f515454b53b52c29878b9e434f15906ca784de)), closes [#1828](https://github.com/vm0-ai/vm0/issues/1828)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.4.0

## [11.4.1](https://github.com/vm0-ai/vm0/compare/web-v11.4.0...web-v11.4.1) (2026-01-29)


### Bug Fixes

* **web:** add todo for pending run cleanup bug ([#1824](https://github.com/vm0-ai/vm0/issues/1824)) ([07840a7](https://github.com/vm0-ai/vm0/commit/07840a7554c4f4a83550de82be7ed453ec2e42c4))

## [11.4.0](https://github.com/vm0-ai/vm0/compare/web-v11.3.1...web-v11.4.0) (2026-01-28)


### Features

* **runner:** add Ably realtime job notifications with polling fallback ([#1783](https://github.com/vm0-ai/vm0/issues/1783)) ([eef9cfc](https://github.com/vm0-ai/vm0/commit/eef9cfc1ce959d708043b5355a42160c306c8de4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.3.0

## [11.3.1](https://github.com/vm0-ai/vm0/compare/web-v11.3.0...web-v11.3.1) (2026-01-28)


### Performance Improvements

* **skills:** convert skills page from ISR to static generation ([#1789](https://github.com/vm0-ai/vm0/issues/1789)) ([182ab9f](https://github.com/vm0-ai/vm0/commit/182ab9f78ffa6aff6ddf2bd8148f5c5e8c153d50))

## [11.3.0](https://github.com/vm0-ai/vm0/compare/web-v11.2.0...web-v11.3.0) (2026-01-28)


### Features

* **web:** add per-user concurrent run limit ([#1749](https://github.com/vm0-ai/vm0/issues/1749)) ([a0277ff](https://github.com/vm0-ai/vm0/commit/a0277ffda3efe2aed0e1e32a7313f14d8b89dcd0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.2.0

## [11.2.0](https://github.com/vm0-ai/vm0/compare/web-v11.1.0...web-v11.2.0) (2026-01-28)


### Features

* **web:** add custom filename for artifact download ([#1767](https://github.com/vm0-ai/vm0/issues/1767)) ([2530e27](https://github.com/vm0-ai/vm0/commit/2530e27ec7fd846479c6c7d50c5d3e42ccf7db34))


### Bug Fixes

* **api:** use camelcase for sse lasteventid query parameter ([#1769](https://github.com/vm0-ai/vm0/issues/1769)) ([0efbfa6](https://github.com/vm0-ai/vm0/commit/0efbfa6dc10c2817ae7bdc862558b09aa2658d1c)), closes [#1764](https://github.com/vm0-ai/vm0/issues/1764)

## [11.1.0](https://github.com/vm0-ai/vm0/compare/web-v11.0.0...web-v11.1.0) (2026-01-28)


### Features

* **docs:** rename integration to agent skills and add skills documentation ([#1750](https://github.com/vm0-ai/vm0/issues/1750)) ([6305911](https://github.com/vm0-ai/vm0/commit/63059115b21a1bf3b36579dac9646271c7354d19)), closes [#1748](https://github.com/vm0-ai/vm0/issues/1748)
* **platform:** add log detail page with agent events and artifact download ([#1738](https://github.com/vm0-ai/vm0/issues/1738)) ([ef8b01d](https://github.com/vm0-ai/vm0/commit/ef8b01d3ef809ed8c6c3e2ce2061b4f65c0fc69e))
* **platform:** improve logs page ui styling and layout ([#1759](https://github.com/vm0-ai/vm0/issues/1759)) ([e0f7568](https://github.com/vm0-ai/vm0/commit/e0f7568fa001e44c41d7191b370ddea4f3aceb0b))


### Bug Fixes

* **platform:** correct artifact extraction and rename provider to framework ([#1745](https://github.com/vm0-ai/vm0/issues/1745)) ([f53f75a](https://github.com/vm0-ai/vm0/commit/f53f75a81a920fcf4eca12c84e098b7432287161))
* **web:** add ably to server external packages ([#1742](https://github.com/vm0-ai/vm0/issues/1742)) ([08f4887](https://github.com/vm0-ai/vm0/commit/08f4887f7d5882f4b994d5d2ef7fc0f0cedfe4c1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.1.0

## [11.0.0](https://github.com/vm0-ai/vm0/compare/web-v10.12.0...web-v11.0.0) (2026-01-27)


### ⚠ BREAKING CHANGES

* **api:** All Public API v1 endpoints now use camelCase field names instead of snake_case. This affects request bodies, response bodies, and query parameters.

### Features

* integrate cloudflare tunnel into pnpm dev automatically ([#1728](https://github.com/vm0-ai/vm0/issues/1728)) ([18f2ddc](https://github.com/vm0-ai/vm0/commit/18f2ddc13df953402198738b5b10937e01a5e65c)), closes [#1726](https://github.com/vm0-ai/vm0/issues/1726)


### Code Refactoring

* **api:** migrate public API v1 from snake_case to camelCase ([#1730](https://github.com/vm0-ai/vm0/issues/1730)) ([5dfcc28](https://github.com/vm0-ai/vm0/commit/5dfcc28597991f408a33bbd565b6619f47d6b92c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.0.0

## [10.12.0](https://github.com/vm0-ai/vm0/compare/web-v10.11.0...web-v10.12.0) (2026-01-27)


### Features

* **api:** add platform logs API endpoints ([#1717](https://github.com/vm0-ai/vm0/issues/1717)) ([9c87393](https://github.com/vm0-ai/vm0/commit/9c873936dec218536a1ffa810eb2d9fd7032d373))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.3.0

## [10.11.0](https://github.com/vm0-ai/vm0/compare/web-v10.10.0...web-v10.11.0) (2026-01-27)


### Features

* **docs:** trigger release for documentation updates ([#1697](https://github.com/vm0-ai/vm0/issues/1697)) ([c078287](https://github.com/vm0-ai/vm0/commit/c078287de06336abd3157fcaa056bdedcb47838d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.2.0

## [10.10.0](https://github.com/vm0-ai/vm0/compare/web-v10.9.1...web-v10.10.0) (2026-01-27)


### Features

* improve google sign-in button styling with hover effects ([#1692](https://github.com/vm0-ai/vm0/issues/1692)) ([03ad4ba](https://github.com/vm0-ai/vm0/commit/03ad4ba8e1d9c516f1967e7d444d008f548d244c))

## [10.9.1](https://github.com/vm0-ai/vm0/compare/web-v10.9.0...web-v10.9.1) (2026-01-27)


### Bug Fixes

* preserve existing secrets when updating schedule ([#1682](https://github.com/vm0-ai/vm0/issues/1682)) ([4a6150a](https://github.com/vm0-ai/vm0/commit/4a6150a6b0b126e0bb2a58899e4eab8c68fa7007)), closes [#1679](https://github.com/vm0-ai/vm0/issues/1679)
* prevent sign-in/sign-up routes from i18n locale redirects ([#1680](https://github.com/vm0-ai/vm0/issues/1680)) ([29a6a08](https://github.com/vm0-ai/vm0/commit/29a6a0850984a4305fc2efb3ee229fb7b26b68e5))

## [10.9.0](https://github.com/vm0-ai/vm0/compare/web-v10.8.0...web-v10.9.0) (2026-01-27)


### Features

* enhance auth pages with brand gradient background and improved styling ([#1676](https://github.com/vm0-ai/vm0/issues/1676)) ([ab5fc44](https://github.com/vm0-ai/vm0/commit/ab5fc4400f4065d0548116b3a1bff0c807f425db))
* improve cli auth success page ui ([#1663](https://github.com/vm0-ai/vm0/issues/1663)) ([af71dfe](https://github.com/vm0-ai/vm0/commit/af71dfe438b5d13854996880fa5d62c8cafb3d7f))

## [10.8.0](https://github.com/vm0-ai/vm0/compare/web-v10.7.2...web-v10.8.0) (2026-01-26)


### Features

* improve cli auth page ui and design system ([#1656](https://github.com/vm0-ai/vm0/issues/1656)) ([eb1ef40](https://github.com/vm0-ai/vm0/commit/eb1ef40c74a5fea169ef6c36af5425dbcece1f25))
* **platform:** redesign homepage and add settings page ([#1639](https://github.com/vm0-ai/vm0/issues/1639)) ([b0515d5](https://github.com/vm0-ai/vm0/commit/b0515d5e75149dd92a11f14f6b80c6661f76afa5))


### Bug Fixes

* **cli:** improve missing secrets/vars error messages to mention --env-file option ([#1654](https://github.com/vm0-ai/vm0/issues/1654)) ([14dbaef](https://github.com/vm0-ai/vm0/commit/14dbaef49248e2397a1c01dedc2afaa9a1409590))
* mark scheduled runs as failed when execution preparation fails ([#1657](https://github.com/vm0-ai/vm0/issues/1657)) ([8fda8c0](https://github.com/vm0-ai/vm0/commit/8fda8c0f7384cc0e536255d90e1aea934bd311e6)), closes [#1653](https://github.com/vm0-ai/vm0/issues/1653)
* **schedule:** validate required secrets/vars before schedule creation ([#1659](https://github.com/vm0-ai/vm0/issues/1659)) ([0c7908e](https://github.com/vm0-ai/vm0/commit/0c7908e0c673b741e7d4497326d9ed81151a9f14)), closes [#1650](https://github.com/vm0-ai/vm0/issues/1650)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.1.0

## [10.7.2](https://github.com/vm0-ai/vm0/compare/web-v10.7.1...web-v10.7.2) (2026-01-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.0.1

## [10.7.1](https://github.com/vm0-ai/vm0/compare/web-v10.7.0...web-v10.7.1) (2026-01-24)


### Performance Improvements

* **test:** use unique prefix isolation for runs api tests ([#1597](https://github.com/vm0-ai/vm0/issues/1597)) ([ef8b88e](https://github.com/vm0-ai/vm0/commit/ef8b88e32c0069881afae44232206c863d014b5c))

## [10.7.0](https://github.com/vm0-ai/vm0/compare/web-v10.6.1...web-v10.7.0) (2026-01-24)


### Features

* **cli:** rename experimental-credential to credential ([#1582](https://github.com/vm0-ai/vm0/issues/1582)) ([499e605](https://github.com/vm0-ai/vm0/commit/499e605c046f7f048c96f3ca6d8b257189aca40c))


### Performance Improvements

* **test:** use unique prefix isolation for slow web tests instead of cleanup ([#1590](https://github.com/vm0-ai/vm0/issues/1590)) ([283c8f4](https://github.com/vm0-ai/vm0/commit/283c8f4a6239e8443b3ed2d706e47ad5f226006f)), closes [#1589](https://github.com/vm0-ai/vm0/issues/1589)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.0.0

## [10.6.1](https://github.com/vm0-ai/vm0/compare/web-v10.6.0...web-v10.6.1) (2026-01-23)


### Bug Fixes

* **run:** recognize alternative llm auth methods in env detection ([#1579](https://github.com/vm0-ai/vm0/issues/1579)) ([28ce716](https://github.com/vm0-ai/vm0/commit/28ce716f5deb1e30bec1d71c043740f5a392684e))
* unify terminology from llm to model provider ([#1580](https://github.com/vm0-ai/vm0/issues/1580)) ([dfe6a2c](https://github.com/vm0-ai/vm0/commit/dfe6a2c99f9b8a0de02cb3afc902ae2eb57cefd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.5.0

## [10.6.0](https://github.com/vm0-ai/vm0/compare/web-v10.5.0...web-v10.6.0) (2026-01-23)


### Features

* **cli:** improve vm0 init onboarding with model-provider setup ([#1571](https://github.com/vm0-ai/vm0/issues/1571)) ([e4e4c23](https://github.com/vm0-ai/vm0/commit/e4e4c23c7d5681965f573e1795b360b5cc3d07b1))


### Bug Fixes

* auto-inject model provider credential into environment ([#1561](https://github.com/vm0-ai/vm0/issues/1561)) ([66d891d](https://github.com/vm0-ai/vm0/commit/66d891d611f20b0cb349b19fafdbf68e2c688d86))
* **test:** make credential service test user id unique ([#1548](https://github.com/vm0-ai/vm0/issues/1548)) ([555be25](https://github.com/vm0-ai/vm0/commit/555be256144ace98a475037d573db258bac094f4))


### Performance Improvements

* **web:** prioritize clerk session auth over cli token validation ([#1566](https://github.com/vm0-ai/vm0/issues/1566)) ([4b90fb8](https://github.com/vm0-ai/vm0/commit/4b90fb8856fd57a8894e5441d2b8b84fb857daec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.4.0

## [10.5.0](https://github.com/vm0-ai/vm0/compare/web-v10.4.0...web-v10.5.0) (2026-01-23)


### Features

* **platform:** add onboarding flow with automatic scope creation ([#1514](https://github.com/vm0-ai/vm0/issues/1514)) ([a6c34b4](https://github.com/vm0-ai/vm0/commit/a6c34b4069c94a4d7d3bb6426aa05549424b4f85))
* reduce vm0 run production timeout from 24 hours to 2 hours ([#1512](https://github.com/vm0-ai/vm0/issues/1512)) ([26d5011](https://github.com/vm0-ai/vm0/commit/26d5011627b535d002e3e07a74e13609d691ef4b)), closes [#1510](https://github.com/vm0-ai/vm0/issues/1510)


### Bug Fixes

* support dark mode for cli-auth page logo ([#1509](https://github.com/vm0-ai/vm0/issues/1509)) ([c9e4ab8](https://github.com/vm0-ai/vm0/commit/c9e4ab8eda738802b76b978bd9763752df0a79bd))
* **web:** cors, auth token identification, and scope error responses ([#1506](https://github.com/vm0-ai/vm0/issues/1506)) ([b14ec55](https://github.com/vm0-ai/vm0/commit/b14ec559743c9538af5f6294d6581fbaff15a434))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.3.1

## [10.4.0](https://github.com/vm0-ai/vm0/compare/web-v10.3.0...web-v10.4.0) (2026-01-22)


### Features

* add cyclomatic complexity checking to eslint ([#1502](https://github.com/vm0-ai/vm0/issues/1502)) ([d3b2859](https://github.com/vm0-ai/vm0/commit/d3b2859ca7374964c78fc5a4f0a76566c01551e3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.3.0

## [10.3.0](https://github.com/vm0-ai/vm0/compare/web-v10.2.0...web-v10.3.0) (2026-01-22)


### Features

* **eslint:** add naming convention rule to base config ([#1487](https://github.com/vm0-ai/vm0/issues/1487)) ([91d948c](https://github.com/vm0-ai/vm0/commit/91d948c56a4a6032e541d956edd190224b4d59b5))

## [10.2.0](https://github.com/vm0-ai/vm0/compare/web-v10.1.0...web-v10.2.0) (2026-01-22)


### Features

* **run:** integrate model provider with vm0 run command ([#1472](https://github.com/vm0-ai/vm0/issues/1472)) ([74c0a4c](https://github.com/vm0-ai/vm0/commit/74c0a4cfbc10683359065249dfbd9b8e282c2b84))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.2.0

## [10.1.0](https://github.com/vm0-ai/vm0/compare/web-v10.0.0...web-v10.1.0) (2026-01-21)


### Features

* add environment-aware cors support for platform logs page in preview deployments ([#1456](https://github.com/vm0-ai/vm0/issues/1456)) ([a482dbf](https://github.com/vm0-ai/vm0/commit/a482dbfbda96151408000a9f767012f67f93e3cd))
* add model provider entity and CLI commands ([#1452](https://github.com/vm0-ai/vm0/issues/1452)) ([86900d2](https://github.com/vm0-ai/vm0/commit/86900d2aa26420e1b940c039a87755c3feda531b))
* **ui:** enhance design system with color tokens and improve navigation icons and clerk styling ([#1466](https://github.com/vm0-ai/vm0/issues/1466)) ([be12e83](https://github.com/vm0-ai/vm0/commit/be12e83029093b9beab0afc5307926ccecb30571))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.1.0

## [10.0.0](https://github.com/vm0-ai/vm0/compare/web-v9.18.0...web-v10.0.0) (2026-01-21)


### ⚠ BREAKING CHANGES

* The `provider` field in vm0.yaml has been renamed to `framework`. Users must update their vm0.yaml files to use `framework` instead of `provider`.

### Features

* rename provider to framework in vm0.yaml configuration ([#1430](https://github.com/vm0-ai/vm0/issues/1430)) ([e2a242e](https://github.com/vm0-ai/vm0/commit/e2a242ef2b9c337b29dc992524abf6ebf2181804))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.0.0

## [9.18.0](https://github.com/vm0-ai/vm0/compare/web-v9.17.0...web-v9.18.0) (2026-01-21)


### Features

* **pricing:** redesign pricing page with enhanced visual effects and improved UX ([#1396](https://github.com/vm0-ai/vm0/issues/1396)) ([ee958b3](https://github.com/vm0-ai/vm0/commit/ee958b39f0f9b24a37e3824db5fe9ad63970934f))

## [9.17.0](https://github.com/vm0-ai/vm0/compare/web-v9.16.1...web-v9.17.0) (2026-01-21)


### Features

* **cli:** add experimental realtime event streaming with ably ([#1383](https://github.com/vm0-ai/vm0/issues/1383)) ([a37b177](https://github.com/vm0-ai/vm0/commit/a37b1776819c9c1653f214a513c206032e37af01))


### Bug Fixes

* add missing foreign key constraint on agent_runs.scheduleId ([#1393](https://github.com/vm0-ai/vm0/issues/1393)) ([c2319ac](https://github.com/vm0-ai/vm0/commit/c2319ac5890de7551eb4c92ee51909206a08a841)), closes [#1387](https://github.com/vm0-ai/vm0/issues/1387)
* **run:** merge credentials into secrets for client-side log masking ([#1409](https://github.com/vm0-ai/vm0/issues/1409)) ([dea6d04](https://github.com/vm0-ai/vm0/commit/dea6d04a675e930dc848ea2901c81139cc39841b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.9.0

## [9.16.1](https://github.com/vm0-ai/vm0/compare/web-v9.16.0...web-v9.16.1) (2026-01-20)


### Bug Fixes

* update credential hint messages to use experimental-credential command ([#1348](https://github.com/vm0-ai/vm0/issues/1348)) ([3ac009a](https://github.com/vm0-ai/vm0/commit/3ac009a7db9af2dddc567d116c7e7f13628c1866))

## [9.16.0](https://github.com/vm0-ai/vm0/compare/web-v9.15.0...web-v9.16.0) (2026-01-20)


### Features

* **credentials:** add persistent credential management for third-party services ([#1303](https://github.com/vm0-ai/vm0/issues/1303)) ([ceff78a](https://github.com/vm0-ai/vm0/commit/ceff78a8285454f69ee3c25190c305795c6b327f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.8.0

## [9.15.0](https://github.com/vm0-ai/vm0/compare/web-v9.14.0...web-v9.15.0) (2026-01-20)


### Features

* add --debug-no-mock-claude flag for real Claude E2E tests ([#1324](https://github.com/vm0-ai/vm0/issues/1324)) ([f75cdb5](https://github.com/vm0-ai/vm0/commit/f75cdb5cc5f27b5979f4d8f882af5fdfdce9c07c))
* **cli:** add usage command to view daily run statistics ([#1301](https://github.com/vm0-ai/vm0/issues/1301)) ([1aaeaf1](https://github.com/vm0-ai/vm0/commit/1aaeaf1fed3fd07afaef8668bb92b09a7e9b3cdc))
* **web:** remove pricing link from navigation ([#1332](https://github.com/vm0-ai/vm0/issues/1332)) ([55573d4](https://github.com/vm0-ai/vm0/commit/55573d47f3b1223f39c1068ac43c87c3732ba924))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.7.0

## [9.14.0](https://github.com/vm0-ai/vm0/compare/web-v9.13.1...web-v9.14.0) (2026-01-19)


### Features

* **billing:** integrate clerk billing mvp ([#1308](https://github.com/vm0-ai/vm0/issues/1308)) ([836a295](https://github.com/vm0-ai/vm0/commit/836a2953fe5eaae70450b544d0a155f8b30e0742))

## [9.13.1](https://github.com/vm0-ai/vm0/compare/web-v9.13.0...web-v9.13.1) (2026-01-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.6.1

## [9.13.0](https://github.com/vm0-ai/vm0/compare/web-v9.12.1...web-v9.13.0) (2026-01-19)


### Features

* **web:** add instatus status widget to landing page ([#1313](https://github.com/vm0-ai/vm0/issues/1313)) ([be54222](https://github.com/vm0-ai/vm0/commit/be54222b5f11951e1d370da1b63940548867ca58))

## [9.12.1](https://github.com/vm0-ai/vm0/compare/web-v9.12.0...web-v9.12.1) (2026-01-17)


### Performance Improvements

* **db:** add missing indexes for high-frequency queries ([#1286](https://github.com/vm0-ai/vm0/issues/1286)) ([c0ae99c](https://github.com/vm0-ai/vm0/commit/c0ae99c504202f5e6988255696de47277b1d5a1f)), closes [#1284](https://github.com/vm0-ai/vm0/issues/1284)

## [9.12.0](https://github.com/vm0-ai/vm0/compare/web-v9.11.0...web-v9.12.0) (2026-01-15)


### Features

* **i18n:** complete glossary translations for german and spanish ([#1259](https://github.com/vm0-ai/vm0/issues/1259)) ([633d977](https://github.com/vm0-ai/vm0/commit/633d977db40789bacf799716a3d2c7e43613d271))

## [9.11.0](https://github.com/vm0-ai/vm0/compare/web-v9.10.1...web-v9.11.0) (2026-01-15)


### Features

* add multilingual glossary page with 29 agent building terms ([#1256](https://github.com/vm0-ai/vm0/issues/1256)) ([407b353](https://github.com/vm0-ai/vm0/commit/407b3539167511f0eb1cc410c9bcc24a86f8514f))

## [9.10.1](https://github.com/vm0-ai/vm0/compare/web-v9.10.0...web-v9.10.1) (2026-01-15)


### Bug Fixes

* **api:** handle axiom eventual consistency in events endpoint ([#1240](https://github.com/vm0-ai/vm0/issues/1240)) ([7c7b6b6](https://github.com/vm0-ai/vm0/commit/7c7b6b69f0fcf9d3b7c9eaa45cc8f8ec2239d5da)), closes [#1233](https://github.com/vm0-ai/vm0/issues/1233)

## [9.10.0](https://github.com/vm0-ai/vm0/compare/web-v9.9.1...web-v9.10.0) (2026-01-14)


### Features

* **schedule:** add api endpoint to view schedule run history ([#1204](https://github.com/vm0-ai/vm0/issues/1204)) ([c53f1a6](https://github.com/vm0-ai/vm0/commit/c53f1a664ecbf460727217364f62089eff1cc408))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.6.0

## [9.9.1](https://github.com/vm0-ai/vm0/compare/web-v9.9.0...web-v9.9.1) (2026-01-14)


### Bug Fixes

* **ci:** use hash for even runner host distribution ([#1214](https://github.com/vm0-ai/vm0/issues/1214)) ([ec74840](https://github.com/vm0-ai/vm0/commit/ec7484080f32e0b16e81a451ca5447e7db1170e8))

## [9.9.0](https://github.com/vm0-ai/vm0/compare/web-v9.8.1...web-v9.9.0) (2026-01-14)


### Features

* **web:** add debug configuration status utility ([#1223](https://github.com/vm0-ai/vm0/issues/1223)) ([0172112](https://github.com/vm0-ai/vm0/commit/0172112a3b818067110819980640267d8b3c86c8))

## [9.8.1](https://github.com/vm0-ai/vm0/compare/web-v9.8.0...web-v9.8.1) (2026-01-14)


### Bug Fixes

* **metrics:** correct sandbox metrics dataset name ([#1209](https://github.com/vm0-ai/vm0/issues/1209)) ([f30ee0e](https://github.com/vm0-ai/vm0/commit/f30ee0e16321e421cff1763d8df93667e84deec1))

## [9.8.0](https://github.com/vm0-ai/vm0/compare/web-v9.7.0...web-v9.8.0) (2026-01-14)


### Features

* **metrics:** add sandbox internal metrics for operation timing ([#1202](https://github.com/vm0-ai/vm0/issues/1202)) ([7134662](https://github.com/vm0-ai/vm0/commit/7134662d5351ef8debc795e9a1c1e61a86a7df4c)), closes [#1174](https://github.com/vm0-ai/vm0/issues/1174)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.5.0

## [9.7.0](https://github.com/vm0-ai/vm0/compare/web-v9.6.0...web-v9.7.0) (2026-01-14)


### Features

* **web:** redesign cli auth page with figma design ([#1192](https://github.com/vm0-ai/vm0/issues/1192)) ([ea23262](https://github.com/vm0-ai/vm0/commit/ea23262b8a987e066a8a3b05f3d6f8f54e8f375f))

## [9.6.0](https://github.com/vm0-ai/vm0/compare/web-v9.5.0...web-v9.6.0) (2026-01-14)


### Features

* **schedule:** add vm0 schedule command for automated agent runs ([#1105](https://github.com/vm0-ai/vm0/issues/1105)) ([ecdc2c5](https://github.com/vm0-ai/vm0/commit/ecdc2c5c01ea1340aefdc8ea20407fce1c264a34))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.4.0

## [9.5.0](https://github.com/vm0-ai/vm0/compare/web-v9.4.2...web-v9.5.0) (2026-01-13)


### Features

* **runner:** add RED metrics infrastructure for runner operations ([#1168](https://github.com/vm0-ai/vm0/issues/1168)) ([0c46ee2](https://github.com/vm0-ai/vm0/commit/0c46ee224ac17a579aae53515588416987aa133e))
* **web:** add RED metrics infrastructure for API and sandbox operations ([#1160](https://github.com/vm0-ai/vm0/issues/1160)) ([8083908](https://github.com/vm0-ai/vm0/commit/808390859c84fae3f424547b5ecea07d1e55ed53))


### Bug Fixes

* **docs:** trigger production deployment for cli reference updates ([#1173](https://github.com/vm0-ai/vm0/issues/1173)) ([57baf42](https://github.com/vm0-ai/vm0/commit/57baf42d83a19652c9db2881e48f50fd1a0054e6))
* **metrics:** require AXIOM_DATASET_SUFFIX environment variable ([#1176](https://github.com/vm0-ai/vm0/issues/1176)) ([8ffe664](https://github.com/vm0-ai/vm0/commit/8ffe6647b239d357dadd59cf693269d19f3ab78c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.3.0

## [9.4.2](https://github.com/vm0-ai/vm0/compare/web-v9.4.1...web-v9.4.2) (2026-01-13)


### Bug Fixes

* **docs:** trigger production deployment for quick start updates ([#1142](https://github.com/vm0-ai/vm0/issues/1142)) ([f8fb029](https://github.com/vm0-ai/vm0/commit/f8fb029227bfc5151a5af30154a0cfb4bc28b480)), closes [#1118](https://github.com/vm0-ai/vm0/issues/1118)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.2.1

## [9.4.1](https://github.com/vm0-ai/vm0/compare/web-v9.4.0...web-v9.4.1) (2026-01-13)


### Performance Improvements

* improve lcp performance for landing page ([#1138](https://github.com/vm0-ai/vm0/issues/1138)) ([9f29297](https://github.com/vm0-ai/vm0/commit/9f2929764ad008158f7ae89bc2b7a0498d1f12d0))

## [9.4.0](https://github.com/vm0-ai/vm0/compare/web-v9.3.0...web-v9.4.0) (2026-01-12)


### Features

* optimize skills metadata and documentation ([#1114](https://github.com/vm0-ai/vm0/issues/1114)) ([5babe6e](https://github.com/vm0-ai/vm0/commit/5babe6e74feb42b47db5a21457bda030fb6c7f14))


### Performance Improvements

* **web:** skip eslint during vercel build ([#1111](https://github.com/vm0-ai/vm0/issues/1111)) ([e2d3619](https://github.com/vm0-ai/vm0/commit/e2d36194345afda06588cdef6bd773573f30b02b))

## [9.3.0](https://github.com/vm0-ai/vm0/compare/web-v9.2.1...web-v9.3.0) (2026-01-12)


### Features

* **lifecycle:** add postCreateCommand hook and hardcode working_dir ([#1077](https://github.com/vm0-ai/vm0/issues/1077)) ([86f7077](https://github.com/vm0-ai/vm0/commit/86f70777701d2d8715edec620e804c9ceeea0bad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.2.0

## [9.2.1](https://github.com/vm0-ai/vm0/compare/web-v9.2.0...web-v9.2.1) (2026-01-11)


### Bug Fixes

* **runner:** support SNI-only mode network logs in experimental_firewall ([#1088](https://github.com/vm0-ai/vm0/issues/1088)) ([c8308ef](https://github.com/vm0-ai/vm0/commit/c8308ef3490b03069b2a65253ab2209c9ba30eac)), closes [#1063](https://github.com/vm0-ai/vm0/issues/1063)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.1.1

## [9.2.0](https://github.com/vm0-ai/vm0/compare/web-v9.1.0...web-v9.2.0) (2026-01-10)


### Features

* **web:** update og image with new branding ([#1076](https://github.com/vm0-ai/vm0/issues/1076)) ([5ad2596](https://github.com/vm0-ai/vm0/commit/5ad25966a15e3fb743f1b1398a49cf28c8e7648a))

## [9.1.0](https://github.com/vm0-ai/vm0/compare/web-v9.0.0...web-v9.1.0) (2026-01-10)


### Features

* remove v1 API create and delete endpoints for agents, volumes, artifacts ([#1062](https://github.com/vm0-ai/vm0/issues/1062)) ([b54697f](https://github.com/vm0-ai/vm0/commit/b54697fdfbee82e28de43d74bc2ac63403ea9ebe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.1.0

## [9.0.0](https://github.com/vm0-ai/vm0/compare/web-v8.5.0...web-v9.0.0) (2026-01-10)


### ⚠ BREAKING CHANGES

* experimental_network_security field removed from agent compose schema

### Code Refactoring

* remove deprecated experimental_network_security feature ([#1057](https://github.com/vm0-ai/vm0/issues/1057)) ([457864b](https://github.com/vm0-ai/vm0/commit/457864bcea4665b302f9f0df265233aa3f9270d5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.0.0

## [8.5.0](https://github.com/vm0-ai/vm0/compare/web-v8.4.1...web-v8.5.0) (2026-01-10)


### Features

* **api:** add name query parameter to GET /v1/agents ([#1044](https://github.com/vm0-ai/vm0/issues/1044)) ([8339227](https://github.com/vm0-ai/vm0/commit/83392274a34deb966d71dea8d2aaf0f3bb05671b)), closes [#1043](https://github.com/vm0-ai/vm0/issues/1043)
* **runner:** add experimental_firewall configuration with domain/IP rules ([#1027](https://github.com/vm0-ai/vm0/issues/1027)) ([18be77e](https://github.com/vm0-ai/vm0/commit/18be77e69f437e1f4cc536f7caf438bdf3321948))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.4.0

## [8.4.1](https://github.com/vm0-ai/vm0/compare/web-v8.4.0...web-v8.4.1) (2026-01-10)


### Bug Fixes

* add v1 api routes to middleware and e2e tests ([#1035](https://github.com/vm0-ai/vm0/issues/1035)) ([73d5dd3](https://github.com/vm0-ai/vm0/commit/73d5dd3d411fc2a69df8ec9c9433334cb92a31ea))

## [8.4.0](https://github.com/vm0-ai/vm0/compare/web-v8.3.0...web-v8.4.0) (2026-01-09)


### Features

* **cli:** add vm0 agents list and inspect commands ([#1003](https://github.com/vm0-ai/vm0/issues/1003)) ([a214d3b](https://github.com/vm0-ai/vm0/commit/a214d3b08e5cb78d27033dc6b5e23601993472bc))
* **public-api:** add tokens api for self-service token management ([#1019](https://github.com/vm0-ai/vm0/issues/1019)) ([63c2195](https://github.com/vm0-ai/vm0/commit/63c21958b94d8ba9cda78fa355e8f82cbeac2075))
* **web:** add public api v1 foundation and infrastructure ([#997](https://github.com/vm0-ai/vm0/issues/997)) ([#1004](https://github.com/vm0-ai/vm0/issues/1004)) ([3a8dd44](https://github.com/vm0-ai/vm0/commit/3a8dd4400493a833f676441c0ebfef838cb18096))


### Bug Fixes

* **web:** add authorization check for scope access in composes list ([#1018](https://github.com/vm0-ai/vm0/issues/1018)) ([3ecb355](https://github.com/vm0-ai/vm0/commit/3ecb355d93c0819f159d88be0733c46b2f5d4d86)), closes [#1007](https://github.com/vm0-ai/vm0/issues/1007)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.3.0

## [8.3.0](https://github.com/vm0-ai/vm0/compare/web-v8.2.1...web-v8.3.0) (2026-01-09)


### Features

* **runner:** move network security proxy to runner host level ([#964](https://github.com/vm0-ai/vm0/issues/964)) ([6a77a51](https://github.com/vm0-ai/vm0/commit/6a77a51f8bec551b3ff8dec278456a2a53cd3aac))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.2.0

## [8.2.1](https://github.com/vm0-ai/vm0/compare/web-v8.2.0...web-v8.2.1) (2026-01-09)


### Bug Fixes

* **docs:** trigger release for documentation updates ([#993](https://github.com/vm0-ai/vm0/issues/993)) ([1f3e2be](https://github.com/vm0-ai/vm0/commit/1f3e2be18c74219b2954c0d98a6456bf35b055ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.1.1

## [8.2.0](https://github.com/vm0-ai/vm0/compare/web-v8.1.1...web-v8.2.0) (2026-01-08)


### Features

* **app:** initialize app subproject with Vite SPA and ccstate ([#967](https://github.com/vm0-ai/vm0/issues/967)) ([b3227d3](https://github.com/vm0-ai/vm0/commit/b3227d341e53ba33e3a43321e863d8760cbb7eee))
* replace custom image building with apps-based image selection ([#963](https://github.com/vm0-ai/vm0/issues/963)) ([231f9b0](https://github.com/vm0-ai/vm0/commit/231f9b0890b07baaa618be58a7da14cc52b0ec7d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.1.0

## [8.1.1](https://github.com/vm0-ai/vm0/compare/web-v8.1.0...web-v8.1.1) (2026-01-07)


### Bug Fixes

* **web:** add module documentation to trigger production deployment ([#948](https://github.com/vm0-ai/vm0/issues/948)) ([4af933c](https://github.com/vm0-ai/vm0/commit/4af933c0d04ec0cd5edbde29769e522831172fa8))

## [8.1.0](https://github.com/vm0-ai/vm0/compare/web-v8.0.2...web-v8.1.0) (2026-01-06)


### Features

* **runner:** add official runner support for vm0/* groups ([#930](https://github.com/vm0-ai/vm0/issues/930)) ([8bc6382](https://github.com/vm0-ai/vm0/commit/8bc63826a242cb6f632ac9456c8b64008020a8b1))

## [8.0.2](https://github.com/vm0-ai/vm0/compare/web-v8.0.1...web-v8.0.2) (2026-01-06)


### Bug Fixes

* handle jsonQuery parsing hex version IDs as numbers ([#926](https://github.com/vm0-ai/vm0/issues/926)) ([b8cd4f8](https://github.com/vm0-ai/vm0/commit/b8cd4f8480f8ae103559c2ffd5f48cce2581c315))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.0.2

## [8.0.1](https://github.com/vm0-ai/vm0/compare/web-v8.0.0...web-v8.0.1) (2026-01-05)


### Bug Fixes

* **runner:** use config server url instead of claim response ([#921](https://github.com/vm0-ai/vm0/issues/921)) ([f7b2b54](https://github.com/vm0-ai/vm0/commit/f7b2b54e61e2dafed797be155c5ed8200f5789eb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.0.1

## [8.0.0](https://github.com/vm0-ai/vm0/compare/web-v7.12.0...web-v8.0.0) (2026-01-05)


### ⚠ BREAKING CHANGES

* **runner:** stub_mode config option removed

### Features

* **runner:** implement @vm0/runner MVP with firecracker execution ([#851](https://github.com/vm0-ai/vm0/issues/851)) ([d2437a2](https://github.com/vm0-ai/vm0/commit/d2437a2cdc7b9df240b26b5cbcb00bf17334b509))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.0.0

## [7.12.0](https://github.com/vm0-ai/vm0/compare/web-v7.11.0...web-v7.12.0) (2026-01-04)


### Features

* **docs:** trigger release for product philosophy page ([#884](https://github.com/vm0-ai/vm0/issues/884)) ([45ec3a2](https://github.com/vm0-ai/vm0/commit/45ec3a296b4d4ac01b4ac1f0536692d1626c7551))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.6.0

## [7.11.0](https://github.com/vm0-ai/vm0/compare/web-v7.10.0...web-v7.11.0) (2026-01-04)


### Features

* **web:** remove cookbooks from navigation ([#880](https://github.com/vm0-ai/vm0/issues/880)) ([627ecaa](https://github.com/vm0-ai/vm0/commit/627ecaa9e415f5a9c59510fbf7dae1dd3d27b4cd))

## [7.10.0](https://github.com/vm0-ai/vm0/compare/web-v7.9.0...web-v7.10.0) (2026-01-04)


### Features

* add docs analytics and update main site sitemap ([#856](https://github.com/vm0-ai/vm0/issues/856)) ([1c870cd](https://github.com/vm0-ai/vm0/commit/1c870cd44b68a460e55a3248f09003e69ca0ec89))

## [7.9.0](https://github.com/vm0-ai/vm0/compare/web-v7.8.0...web-v7.9.0) (2025-12-31)


### Features

* load secrets from env vars for run continue/resume ([#846](https://github.com/vm0-ai/vm0/issues/846)) ([2d8ae98](https://github.com/vm0-ai/vm0/commit/2d8ae9837463d44846326bd5eca925026ccc3c4c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.5.0

## [7.8.0](https://github.com/vm0-ai/vm0/compare/web-v7.7.0...web-v7.8.0) (2025-12-31)


### Features

* add image assets for email template ([#841](https://github.com/vm0-ai/vm0/issues/841)) ([43610e7](https://github.com/vm0-ai/vm0/commit/43610e7f0b32e52cf3e89232cb2db81ef2f95407))

## [7.7.0](https://github.com/vm0-ai/vm0/compare/web-v7.6.0...web-v7.7.0) (2025-12-30)


### Features

* add docs link to main website navigation ([#828](https://github.com/vm0-ai/vm0/issues/828)) ([a74a296](https://github.com/vm0-ai/vm0/commit/a74a296961ce70c20026150a7ccf57305be1effc))

## [7.6.0](https://github.com/vm0-ai/vm0/compare/web-v7.5.0...web-v7.6.0) (2025-12-30)


### Features

* **cli:** add artifact/volume list and clone commands with interactive prompts ([#800](https://github.com/vm0-ai/vm0/issues/800)) ([3a95d22](https://github.com/vm0-ai/vm0/commit/3a95d224fb9f38de92db5fd97e75c6968d7daed5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.4.0

## [7.5.0](https://github.com/vm0-ai/vm0/compare/web-v7.4.0...web-v7.5.0) (2025-12-30)


### Features

* separate secrets from vars in checkpoint/session system ([#803](https://github.com/vm0-ai/vm0/issues/803)) ([538b4e5](https://github.com/vm0-ai/vm0/commit/538b4e56d9300905cf06f6fdd41143639615efcd))

## [7.4.0](https://github.com/vm0-ai/vm0/compare/web-v7.3.1...web-v7.4.0) (2025-12-30)


### Features

* **cli:** replace --limit with --tail and --head flags for logs command ([#797](https://github.com/vm0-ai/vm0/issues/797)) ([bc5aa0e](https://github.com/vm0-ai/vm0/commit/bc5aa0ebdb3e5d8195a76197ed79df099610a257))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.3.0

## [7.3.1](https://github.com/vm0-ai/vm0/compare/web-v7.3.0...web-v7.3.1) (2025-12-30)


### Bug Fixes

* remove locale from legal pages paths ([#794](https://github.com/vm0-ai/vm0/issues/794)) ([67d0d24](https://github.com/vm0-ai/vm0/commit/67d0d249c48d204b06caaaa87e370edcd47787c5))

## [7.3.0](https://github.com/vm0-ai/vm0/compare/web-v7.2.0...web-v7.3.0) (2025-12-29)


### Features

* add terms of use and privacy policy pages ([#789](https://github.com/vm0-ai/vm0/issues/789)) ([e352cce](https://github.com/vm0-ai/vm0/commit/e352ccea6bee935a46cde1e76820e02876b06a6c))

## [7.2.0](https://github.com/vm0-ai/vm0/compare/web-v7.1.1...web-v7.2.0) (2025-12-29)


### Features

* **core:** add ts-rest contracts for storage direct upload endpoints ([#779](https://github.com/vm0-ai/vm0/issues/779)) ([18b7e89](https://github.com/vm0-ai/vm0/commit/18b7e89008a852d6cd5ba8dda363b8878256792b))
* restore 3d cube hero and update cta to schedule demo ([#787](https://github.com/vm0-ai/vm0/issues/787)) ([7052c30](https://github.com/vm0-ai/vm0/commit/7052c305371864ea85ef1ecca1507a3d6d58a37f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.2.0

## [7.1.1](https://github.com/vm0-ai/vm0/compare/web-v7.1.0...web-v7.1.1) (2025-12-27)


### Bug Fixes

* prevent FK violation in concurrent storage commit transactions ([#768](https://github.com/vm0-ai/vm0/issues/768)) ([524ebd7](https://github.com/vm0-ai/vm0/commit/524ebd727a298c1f054eeccee659afa5812ae16e))

## [7.1.0](https://github.com/vm0-ai/vm0/compare/web-v7.0.0...web-v7.1.0) (2025-12-26)


### Features

* add scope support to agent compose ([#764](https://github.com/vm0-ai/vm0/issues/764)) ([79e8103](https://github.com/vm0-ai/vm0/commit/79e8103327dde0db6562d13dcaab0c36bb070ee6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.1.0

## [7.0.0](https://github.com/vm0-ai/vm0/compare/web-v6.10.0...web-v7.0.0) (2025-12-26)


### ⚠ BREAKING CHANGES

* Users must update their agent.yaml files to use experimental_network_security instead of beta_network_security.

### Bug Fixes

* remove composeId filter from version lookup to fix cross-compose deduplication ([#765](https://github.com/vm0-ai/vm0/issues/765)) ([46a4682](https://github.com/vm0-ai/vm0/commit/46a46825c6e0ff584c9c9a831b47d089181eb000))


### Code Refactoring

* rename beta_network_security to experimental_network_security ([#760](https://github.com/vm0-ai/vm0/issues/760)) ([c1cd01a](https://github.com/vm0-ai/vm0/commit/c1cd01a8160858214304168ffdc0b784cc272a02))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.0.0

## [6.10.0](https://github.com/vm0-ai/vm0/compare/web-v6.9.2...web-v6.10.0) (2025-12-26)


### Features

* **skills:** add missing skill descriptions and fix github description ([#754](https://github.com/vm0-ai/vm0/issues/754)) ([159fc7c](https://github.com/vm0-ai/vm0/commit/159fc7cbd2afdae93a61bb90198e559494398ba4))

## [6.9.2](https://github.com/vm0-ai/vm0/compare/web-v6.9.1...web-v6.9.2) (2025-12-25)


### Performance Improvements

* **ci:** increase cli e2e test parallelism from 4 to 20 ([#740](https://github.com/vm0-ai/vm0/issues/740)) ([5ded433](https://github.com/vm0-ai/vm0/commit/5ded43356445829748dfb7c0d8ad85b3505a4c88))

## [6.9.1](https://github.com/vm0-ai/vm0/compare/web-v6.9.0...web-v6.9.1) (2025-12-25)


### Bug Fixes

* **web:** add flushlogs to ensure axiom log delivery in serverless ([#728](https://github.com/vm0-ai/vm0/issues/728)) ([a390938](https://github.com/vm0-ai/vm0/commit/a3909383cec6a0931de57e02c4de710082612cb6))

## [6.9.0](https://github.com/vm0-ai/vm0/compare/web-v6.8.0...web-v6.9.0) (2025-12-25)


### Features

* remove unused sessions API and migrate session history to R2 ([#718](https://github.com/vm0-ai/vm0/issues/718)) ([a5cd85d](https://github.com/vm0-ai/vm0/commit/a5cd85d2f9f2c513ab88f90359dd21414a36e24b))
* **web:** integrate axiom logging transport for web logs ([#726](https://github.com/vm0-ai/vm0/issues/726)) ([b7a1ec1](https://github.com/vm0-ai/vm0/commit/b7a1ec18609aaf43057d5e0b71eb416cfbf9170a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.5.0

## [6.8.0](https://github.com/vm0-ai/vm0/compare/web-v6.7.1...web-v6.8.0) (2025-12-25)


### Features

* migrate agent run events to axiom ([#715](https://github.com/vm0-ai/vm0/issues/715)) ([4a68278](https://github.com/vm0-ai/vm0/commit/4a68278ff7dd5bd94915a873f8e69efdd42e3c7f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.4.0

## [6.7.1](https://github.com/vm0-ai/vm0/compare/web-v6.7.0...web-v6.7.1) (2025-12-24)


### Bug Fixes

* include _time field in axiom query results ([#714](https://github.com/vm0-ai/vm0/issues/714)) ([94d8e5e](https://github.com/vm0-ai/vm0/commit/94d8e5ed29b332d4322cfb0980fc3c7b12bfcf17))
* inherit vars/secrets and compose version in continue/resume runs ([#713](https://github.com/vm0-ai/vm0/issues/713)) ([44b2212](https://github.com/vm0-ai/vm0/commit/44b22124c569371ea812be2155b89d9417b7b471))

## [6.7.0](https://github.com/vm0-ai/vm0/compare/web-v6.6.0...web-v6.7.0) (2025-12-24)


### Features

* migrate sandbox telemetry metrics and network logs to axiom ([#710](https://github.com/vm0-ai/vm0/issues/710)) ([acb2cd5](https://github.com/vm0-ai/vm0/commit/acb2cd5730c2aa69e5e4dc9d501147a3813fafe3))

## [6.6.0](https://github.com/vm0-ai/vm0/compare/web-v6.5.0...web-v6.6.0) (2025-12-24)


### Features

* migrate sandbox system logs to axiom ([#706](https://github.com/vm0-ai/vm0/issues/706)) ([bf34716](https://github.com/vm0-ai/vm0/commit/bf34716cc2367ec15a0f335b10fd790959623f00))

## [6.5.0](https://github.com/vm0-ai/vm0/compare/web-v6.4.0...web-v6.5.0) (2025-12-23)


### Features

* add blog.vm0.ai to sitemap with multilingual support ([#700](https://github.com/vm0-ai/vm0/issues/700)) ([d0b5359](https://github.com/vm0-ai/vm0/commit/d0b535940e26633ab509cf0fa7e9d9e1a0e47246))

## [6.4.0](https://github.com/vm0-ai/vm0/compare/web-v6.3.2...web-v6.4.0) (2025-12-23)


### Features

* add auto-fetch and multilingual support for cookbooks and skills ([#696](https://github.com/vm0-ai/vm0/issues/696)) ([a331bc9](https://github.com/vm0-ai/vm0/commit/a331bc92e5153b9f7214c400c0e82f82a7918c19))

## [6.3.2](https://github.com/vm0-ai/vm0/compare/web-v6.3.1...web-v6.3.2) (2025-12-23)


### Bug Fixes

* return provider in events APIs for correct rendering ([#697](https://github.com/vm0-ai/vm0/issues/697)) ([c72c9d7](https://github.com/vm0-ai/vm0/commit/c72c9d7d90792ffffde7f92737dfdbe022052a99))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.3.1

## [6.3.1](https://github.com/vm0-ai/vm0/compare/web-v6.3.0...web-v6.3.1) (2025-12-23)


### Performance Improvements

* **web:** optimize images and enhance seo ([#693](https://github.com/vm0-ai/vm0/issues/693)) ([769dc3a](https://github.com/vm0-ai/vm0/commit/769dc3a4af24d72d6c7e5839b2c8d560dda34a0d))

## [6.3.0](https://github.com/vm0-ai/vm0/compare/web-v6.2.0...web-v6.3.0) (2025-12-23)


### Features

* add codex support alongside claude code ([#637](https://github.com/vm0-ai/vm0/issues/637)) ([db42ad7](https://github.com/vm0-ai/vm0/commit/db42ad79db60a026e97257c4c752fcec35afbbd8))
* **web:** replace clerk signup with waitlist component ([#690](https://github.com/vm0-ai/vm0/issues/690)) ([ba477cc](https://github.com/vm0-ai/vm0/commit/ba477cc341563ece8194c3d9cf4d461f771174de))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.3.0

## [6.2.0](https://github.com/vm0-ai/vm0/compare/web-v6.1.4...web-v6.2.0) (2025-12-23)


### Features

* **cli:** promote beta features to stable and add image auto-config ([#689](https://github.com/vm0-ai/vm0/issues/689)) ([76161b2](https://github.com/vm0-ai/vm0/commit/76161b2d6a982fafc9eb6fdf731d9b485f263b21))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.2.0

## [6.1.4](https://github.com/vm0-ai/vm0/compare/web-v6.1.3...web-v6.1.4) (2025-12-22)


### Bug Fixes

* update skills page and fix mobile language switcher ([#682](https://github.com/vm0-ai/vm0/issues/682)) ([83de928](https://github.com/vm0-ai/vm0/commit/83de9283e853b20b666c3aa3731d65a89b2ff162))

## [6.1.3](https://github.com/vm0-ai/vm0/compare/web-v6.1.2...web-v6.1.3) (2025-12-22)


### Bug Fixes

* use direct API import instead of HTTP fetch in server component ([#676](https://github.com/vm0-ai/vm0/issues/676)) ([99d57e4](https://github.com/vm0-ai/vm0/commit/99d57e414561760e4227b841898bdeaf14fca7f2))

## [6.1.2](https://github.com/vm0-ai/vm0/compare/web-v6.1.1...web-v6.1.2) (2025-12-22)


### Bug Fixes

* **image:** support scoped references and version tags in validateImageAccess ([#674](https://github.com/vm0-ai/vm0/issues/674)) ([3f6d715](https://github.com/vm0-ai/vm0/commit/3f6d7156b7903cfc46518abaab9fcdc12ffacf5c))

## [6.1.1](https://github.com/vm0-ai/vm0/compare/web-v6.1.0...web-v6.1.1) (2025-12-22)


### Bug Fixes

* use correct base URL for skills API in server-side fetch ([#671](https://github.com/vm0-ai/vm0/issues/671)) ([4cd2723](https://github.com/vm0-ai/vm0/commit/4cd2723ce696ff11d9b02215a7f6d9311186cd5d))

## [6.1.0](https://github.com/vm0-ai/vm0/compare/web-v6.0.1...web-v6.1.0) (2025-12-22)


### Features

* add dynamic skills page with local logo assets ([#667](https://github.com/vm0-ai/vm0/issues/667)) ([a0112e8](https://github.com/vm0-ai/vm0/commit/a0112e89c87aa6f24e437d74444f1b7d62c4a8d9))
* **image:** enforce lowercase image names for Docker compatibility ([#662](https://github.com/vm0-ai/vm0/issues/662)) ([7a6f5ff](https://github.com/vm0-ai/vm0/commit/7a6f5fffb0d517d853e2bd272534a868b0875837))


### Bug Fixes

* prevent duplicate "not found" in error messages ([#666](https://github.com/vm0-ai/vm0/issues/666)) ([cd472af](https://github.com/vm0-ai/vm0/commit/cd472af752f28a055682e337918a354e2c9b6502))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.1.0

## [6.0.1](https://github.com/vm0-ai/vm0/compare/web-v6.0.0...web-v6.0.1) (2025-12-22)


### Bug Fixes

* verify S3 files exist during deduplication to prevent 404 errors ([#659](https://github.com/vm0-ai/vm0/issues/659)) ([25288d7](https://github.com/vm0-ai/vm0/commit/25288d79091744ad828b8d435170673688d54b6c))

## [6.0.0](https://github.com/vm0-ai/vm0/compare/web-v5.19.0...web-v6.0.0) (2025-12-22)


### ⚠ BREAKING CHANGES

* Users must update volume mounts from /home/user/.config/claude to /home/user/.claude in their vm0.yaml files.

### Features

* **image:** support @vm0/claude-code format for system images ([#655](https://github.com/vm0-ai/vm0/issues/655)) ([1ddd99f](https://github.com/vm0-ai/vm0/commit/1ddd99fa1b640956244dfd463e6eda6a942e8416))


### Code Refactoring

* remove CLAUDE_CONFIG_DIR override and use ~/.claude default ([#656](https://github.com/vm0-ai/vm0/issues/656)) ([bb009a0](https://github.com/vm0-ai/vm0/commit/bb009a0edbda1a8064a396991ee51f3ea9f38a1f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.0.0

## [5.19.0](https://github.com/vm0-ai/vm0/compare/web-v5.18.1...web-v5.19.0) (2025-12-22)


### Features

* add responsive mobile menu and improve footer layout ([#647](https://github.com/vm0-ai/vm0/issues/647)) ([1649810](https://github.com/vm0-ai/vm0/commit/1649810be1ed8ca353a1116ae4e631b04e46d52e))

## [5.18.1](https://github.com/vm0-ai/vm0/compare/web-v5.18.0...web-v5.18.1) (2025-12-21)


### Bug Fixes

* sandbox calls commit on deduplication to update HEAD ([#650](https://github.com/vm0-ai/vm0/issues/650)) ([51da31a](https://github.com/vm0-ai/vm0/commit/51da31a7bae1e431d7f3fd8b8cc04f0e951603f7))

## [5.18.0](https://github.com/vm0-ai/vm0/compare/web-v5.17.1...web-v5.18.0) (2025-12-21)


### Features

* **image:** add versioning support with tag syntax ([#643](https://github.com/vm0-ai/vm0/issues/643)) ([761ce57](https://github.com/vm0-ai/vm0/commit/761ce5791aca56e96739db7513fd4e5a83065717))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.8.0

## [5.17.1](https://github.com/vm0-ai/vm0/compare/web-v5.17.0...web-v5.17.1) (2025-12-20)


### Bug Fixes

* move theme toggle and language switcher to footer ([#645](https://github.com/vm0-ai/vm0/issues/645)) ([9cf6d5b](https://github.com/vm0-ai/vm0/commit/9cf6d5b9649ea3bee1263df99c38e57f8ac451b9))

## [5.17.0](https://github.com/vm0-ai/vm0/compare/web-v5.16.0...web-v5.17.0) (2025-12-20)


### Features

* add scope/namespace system for resource isolation ([#636](https://github.com/vm0-ai/vm0/issues/636)) ([1369059](https://github.com/vm0-ai/vm0/commit/1369059e3e3d7a82aca3f00e59dd2f2814dab0e4))
* **cli:** make --artifact-name optional for vm0 run command ([#640](https://github.com/vm0-ai/vm0/issues/640)) ([6895cfe](https://github.com/vm0-ai/vm0/commit/6895cfe6411b48b23b49d9c5a500fdd0aa746fd0))


### Bug Fixes

* remove locale prefix from sign-up links ([#644](https://github.com/vm0-ai/vm0/issues/644)) ([167b4bd](https://github.com/vm0-ai/vm0/commit/167b4bdc0ee947130042b9dae7bbfc829022f707))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.7.0

## [5.16.0](https://github.com/vm0-ai/vm0/compare/web-v5.15.0...web-v5.16.0) (2025-12-20)


### Features

* add multi-language support (de, ja, es) ([#638](https://github.com/vm0-ai/vm0/issues/638)) ([0cf687b](https://github.com/vm0-ai/vm0/commit/0cf687b360fef7c599bfd5ec57feeb3e68d8ee5b))


### Bug Fixes

* explicitly set Plausible domain to vm0.ai ([#630](https://github.com/vm0-ai/vm0/issues/630)) ([d2dfb7e](https://github.com/vm0-ai/vm0/commit/d2dfb7ec6595f3879577deab5031be0a3852cbff))

## [5.15.0](https://github.com/vm0-ai/vm0/compare/web-v5.14.0...web-v5.15.0) (2025-12-19)


### Features

* **api:** add secrets masking to telemetry webhook ([#621](https://github.com/vm0-ai/vm0/issues/621)) ([6755f65](https://github.com/vm0-ai/vm0/commit/6755f6587253d39949515860e67e44a1c74c302f))

## [5.14.0](https://github.com/vm0-ai/vm0/compare/web-v5.13.0...web-v5.14.0) (2025-12-19)


### Features

* **web:** replace Home nav link with Blog link ([#620](https://github.com/vm0-ai/vm0/issues/620)) ([a63e083](https://github.com/vm0-ai/vm0/commit/a63e08360be3fda9a20f4a30df87a14076432001))


### Bug Fixes

* **storage:** allow empty artifact push to update remote HEAD ([#618](https://github.com/vm0-ai/vm0/issues/618)) ([93352c4](https://github.com/vm0-ai/vm0/commit/93352c4ac03c5a4861edb1d94e188efb17195694))

## [5.13.0](https://github.com/vm0-ai/vm0/compare/web-v5.12.0...web-v5.13.0) (2025-12-19)


### Features

* **api:** migrate storage backend from AWS S3 to Cloudflare R2 ([#614](https://github.com/vm0-ai/vm0/issues/614)) ([a61592f](https://github.com/vm0-ai/vm0/commit/a61592f9f44dc49d7d2b4338f5dbfd0c8e609df2))

## [5.12.0](https://github.com/vm0-ai/vm0/compare/web-v5.11.0...web-v5.12.0) (2025-12-19)


### Features

* **api:** add direct S3 upload endpoints for large file support ([#595](https://github.com/vm0-ai/vm0/issues/595)) ([5eb11d0](https://github.com/vm0-ai/vm0/commit/5eb11d05c12ee55064dd946a1c99f3a19aaf96e9))

## [5.11.0](https://github.com/vm0-ai/vm0/compare/web-v5.10.1...web-v5.11.0) (2025-12-18)


### Features

* **web:** add light/dark theme toggle to website ([#599](https://github.com/vm0-ai/vm0/issues/599)) ([e27761f](https://github.com/vm0-ai/vm0/commit/e27761fddffea7901add954740784f3aa2c3fd8f))

## [5.10.1](https://github.com/vm0-ai/vm0/compare/web-v5.10.0...web-v5.10.1) (2025-12-18)


### Bug Fixes

* **e2b:** add -f flag to curl in http_post_form for proper HTTP error handling ([#590](https://github.com/vm0-ai/vm0/issues/590)) ([5168d59](https://github.com/vm0-ai/vm0/commit/5168d593d3b36df7d1f83abdd53fece7884b0358))

## [5.10.0](https://github.com/vm0-ai/vm0/compare/web-v5.9.0...web-v5.10.0) (2025-12-17)


### Features

* **e2b:** standardize sandbox logging format ([#578](https://github.com/vm0-ai/vm0/issues/578)) ([5873e6f](https://github.com/vm0-ai/vm0/commit/5873e6f397be4c6459548e3edb7c696ecc07e085))

## [5.9.0](https://github.com/vm0-ai/vm0/compare/web-v5.8.0...web-v5.9.0) (2025-12-17)


### Features

* **storage:** skip S3 upload/download for empty artifacts ([#575](https://github.com/vm0-ai/vm0/issues/575)) ([bd75e53](https://github.com/vm0-ai/vm0/commit/bd75e53f28019fa262f98adede304c99556d999d))


### Bug Fixes

* **storage:** reorder s3 upload before database write for transactional consistency ([#573](https://github.com/vm0-ai/vm0/issues/573)) ([910d7a4](https://github.com/vm0-ai/vm0/commit/910d7a4a274471cc6f8f09e83b1a0fd97c61eda0))

## [5.8.0](https://github.com/vm0-ai/vm0/compare/web-v5.7.0...web-v5.8.0) (2025-12-17)


### Features

* **cli:** add beta_system_prompt and beta_system_skills support for agent compose ([#565](https://github.com/vm0-ai/vm0/issues/565)) ([b6388d9](https://github.com/vm0-ai/vm0/commit/b6388d9b9511bf7a6407dc2d17a6a81f85e8d3eb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.6.0

## [5.7.0](https://github.com/vm0-ai/vm0/compare/web-v5.6.0...web-v5.7.0) (2025-12-16)


### Features

* add cookbooks page to sitemap ([#561](https://github.com/vm0-ai/vm0/issues/561)) ([80e6839](https://github.com/vm0-ai/vm0/commit/80e6839798c1911d77c8aeaeac2eaebee58e5e4a))

## [5.6.0](https://github.com/vm0-ai/vm0/compare/web-v5.5.2...web-v5.6.0) (2025-12-13)


### Features

* **storage:** optimize empty storage handling by skipping tar upload/download ([#557](https://github.com/vm0-ai/vm0/issues/557)) ([56b9ab4](https://github.com/vm0-ai/vm0/commit/56b9ab46d288abfc332c77b3725200abed857a46))


### Bug Fixes

* handle empty tar.gz from python in storage webhooks ([#554](https://github.com/vm0-ai/vm0/issues/554)) ([ddd02ca](https://github.com/vm0-ai/vm0/commit/ddd02cafd12c74608421302bfa93abb659deaf73))

## [5.5.2](https://github.com/vm0-ai/vm0/compare/web-v5.5.1...web-v5.5.2) (2025-12-13)


### Bug Fixes

* **sandbox:** ensure cleanup runs on early errors in run-agent.py ([#551](https://github.com/vm0-ai/vm0/issues/551)) ([2551182](https://github.com/vm0-ai/vm0/commit/25511823e5182462e59a90e816c0ac76bab6e588))

## [5.5.1](https://github.com/vm0-ai/vm0/compare/web-v5.5.0...web-v5.5.1) (2025-12-13)


### Bug Fixes

* **sandbox:** create working directory if it doesn't exist on agent startup ([#547](https://github.com/vm0-ai/vm0/issues/547)) ([18d1e1d](https://github.com/vm0-ai/vm0/commit/18d1e1dcac481fed29313f61122569907cefc193))

## [5.5.0](https://github.com/vm0-ai/vm0/compare/web-v5.4.9...web-v5.5.0) (2025-12-13)


### Features

* **cron:** add debug timeout for compose names starting with debug- ([#543](https://github.com/vm0-ai/vm0/issues/543)) ([3263ac2](https://github.com/vm0-ai/vm0/commit/3263ac2559e6141ed61175db467ac3d2952b9976))

## [5.4.9](https://github.com/vm0-ai/vm0/compare/web-v5.4.8...web-v5.4.9) (2025-12-13)


### Bug Fixes

* **cli:** revert system_prompt and system_skills feature ([#540](https://github.com/vm0-ai/vm0/issues/540)) ([b2254fe](https://github.com/vm0-ai/vm0/commit/b2254fec128a641106aa1db67faac938e39e3b3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.5.1

## [5.4.8](https://github.com/vm0-ai/vm0/compare/web-v5.4.7...web-v5.4.8) (2025-12-13)


### Bug Fixes

* **e2b:** add detailed debug logging for sandbox execution stages ([#537](https://github.com/vm0-ai/vm0/issues/537)) ([c143ea4](https://github.com/vm0-ai/vm0/commit/c143ea427d56db4e198d8238c2f707fdbc7e8ca1))

## [5.4.7](https://github.com/vm0-ai/vm0/compare/web-v5.4.6...web-v5.4.7) (2025-12-13)


### Bug Fixes

* **e2b:** revert all sandbox script debug changes to fix startup hang ([#534](https://github.com/vm0-ai/vm0/issues/534)) ([28c2aa0](https://github.com/vm0-ai/vm0/commit/28c2aa069754065a3ef38a5d9cfa6978070b902b))

## [5.4.6](https://github.com/vm0-ai/vm0/compare/web-v5.4.5...web-v5.4.6) (2025-12-13)


### Bug Fixes

* **e2b:** make telemetry uploads non-blocking to agent startup ([#531](https://github.com/vm0-ai/vm0/issues/531)) ([2322250](https://github.com/vm0-ai/vm0/commit/2322250295d510460cda4851de9f4fd650663630))

## [5.4.5](https://github.com/vm0-ai/vm0/compare/web-v5.4.4...web-v5.4.5) (2025-12-13)


### Bug Fixes

* **e2b:** avoid concurrent telemetry requests at startup ([#528](https://github.com/vm0-ai/vm0/issues/528)) ([f1f6354](https://github.com/vm0-ai/vm0/commit/f1f63545690c116f6d45f5e7d9279044a12e1af1))
* **e2b:** use log.debug instead of log.info in telemetry endpoint ([#529](https://github.com/vm0-ai/vm0/issues/529)) ([a42b6d7](https://github.com/vm0-ai/vm0/commit/a42b6d7a25c860f88d899e1a243d987e9c8a8967))

## [5.4.4](https://github.com/vm0-ai/vm0/compare/web-v5.4.3...web-v5.4.4) (2025-12-13)


### Bug Fixes

* **e2b:** add detailed logging inside upload_telemetry function ([#524](https://github.com/vm0-ai/vm0/issues/524)) ([11f4a7c](https://github.com/vm0-ai/vm0/commit/11f4a7cb97f2c8b137dc13335d34d673692f743d))

## [5.4.3](https://github.com/vm0-ai/vm0/compare/web-v5.4.2...web-v5.4.3) (2025-12-13)


### Bug Fixes

* **e2b:** add sync telemetry upload and detailed logging for debugging ([#522](https://github.com/vm0-ai/vm0/issues/522)) ([d545391](https://github.com/vm0-ai/vm0/commit/d545391dcdfe8dce95cae2ba78cfc4ebbb016c2f))

## [5.4.2](https://github.com/vm0-ai/vm0/compare/web-v5.4.1...web-v5.4.2) (2025-12-13)


### Bug Fixes

* **e2b:** remove blocking telemetry upload calls during startup ([#519](https://github.com/vm0-ai/vm0/issues/519)) ([642f43c](https://github.com/vm0-ai/vm0/commit/642f43cd24cdbc033b72ca5e3f8dc9acad7ba885))

## [5.4.1](https://github.com/vm0-ai/vm0/compare/web-v5.4.0...web-v5.4.1) (2025-12-13)


### Bug Fixes

* **e2b:** add startup diagnostics for debugging sandbox execution issues ([#517](https://github.com/vm0-ai/vm0/issues/517)) ([4f0b6f9](https://github.com/vm0-ai/vm0/commit/4f0b6f977ce235abd9161e6c80634a45730f769d))
* **web:** add sandboxId to run response and fix migration conflict ([#516](https://github.com/vm0-ai/vm0/issues/516)) ([4824851](https://github.com/vm0-ai/vm0/commit/482485182fa53e86690b537b7af589340d538958))

## [5.4.0](https://github.com/vm0-ai/vm0/compare/web-v5.3.2...web-v5.4.0) (2025-12-12)


### Features

* **cli:** add --secrets parameter for passing secrets via CLI ([#512](https://github.com/vm0-ai/vm0/issues/512)) ([7972bf4](https://github.com/vm0-ai/vm0/commit/7972bf4f82f76112f99ebf8068c133e953a4ae20))
* **cli:** add system_prompt and system_skills support for agent compose ([#513](https://github.com/vm0-ai/vm0/issues/513)) ([5079a4a](https://github.com/vm0-ai/vm0/commit/5079a4a9d7a41617e53b22c7ea9e666cf4838f08))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.5.0

## [5.3.2](https://github.com/vm0-ai/vm0/compare/web-v5.3.1...web-v5.3.2) (2025-12-12)


### Bug Fixes

* **web:** implement transparent proxy for Authorization header ([#509](https://github.com/vm0-ai/vm0/issues/509)) ([5b38537](https://github.com/vm0-ai/vm0/commit/5b38537b46713ec015ab4ef23dfb79158bd0dc96))

## [5.3.1](https://github.com/vm0-ai/vm0/compare/web-v5.3.0...web-v5.3.1) (2025-12-12)


### Bug Fixes

* **web:** use pretty_host for transparent proxy hostname resolution ([#506](https://github.com/vm0-ai/vm0/issues/506)) ([1a804f5](https://github.com/vm0-ai/vm0/commit/1a804f551ed625afca2f58db96614011f162095f))

## [5.3.0](https://github.com/vm0-ai/vm0/compare/web-v5.2.1...web-v5.3.0) (2025-12-12)


### Features

* **web:** add generic proxy endpoint for sandbox requests ([#503](https://github.com/vm0-ai/vm0/issues/503)) ([36eda65](https://github.com/vm0-ai/vm0/commit/36eda650e853a62e2269380a777e305505e50702))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.4.0

## [5.2.1](https://github.com/vm0-ai/vm0/compare/web-v5.2.0...web-v5.2.1) (2025-12-11)


### Bug Fixes

* **cli:** handle run preparation failures immediately ([#496](https://github.com/vm0-ai/vm0/issues/496)) ([72917c5](https://github.com/vm0-ai/vm0/commit/72917c5c665c797dbda09b1b9278db0ef8e2afb8))

## [5.2.0](https://github.com/vm0-ai/vm0/compare/web-v5.1.0...web-v5.2.0) (2025-12-10)


### Features

* **storage:** support same name for volume and artifact with type isolation ([#477](https://github.com/vm0-ai/vm0/issues/477)) ([c7ad149](https://github.com/vm0-ai/vm0/commit/c7ad149716eae4c3ab33650c3fbcd47b881944eb))

## [5.1.0](https://github.com/vm0-ai/vm0/compare/web-v5.0.1...web-v5.1.0) (2025-12-10)


### Features

* **api:** add storages contract and standardize error responses ([#465](https://github.com/vm0-ai/vm0/issues/465)) ([8fa72f4](https://github.com/vm0-ai/vm0/commit/8fa72f461adf28f5f1a5c8e285e02b2416b475bf))
* **api:** complete ts-rest migration for images and cron routes ([#474](https://github.com/vm0-ai/vm0/issues/474)) ([fdf8657](https://github.com/vm0-ai/vm0/commit/fdf86578bd70bb850058ac1eceac3f900e1a8d51))
* **api:** migrate /api/agent/composes routes to ts-rest contract-first architecture ([#458](https://github.com/vm0-ai/vm0/issues/458)) ([4a066d2](https://github.com/vm0-ai/vm0/commit/4a066d2489c4e05ecb4626d0c03694bd683299d9))
* **api:** migrate /api/agent/runs to ts-rest contract-first architecture ([#463](https://github.com/vm0-ai/vm0/issues/463)) ([2f160ec](https://github.com/vm0-ai/vm0/commit/2f160ecbdae67f2a7d8346c6ee393a9dfd0e2e79))
* **api:** migrate /api/agent/sessions to ts-rest contract-first architecture ([#464](https://github.com/vm0-ai/vm0/issues/464)) ([03f32cb](https://github.com/vm0-ai/vm0/commit/03f32cbe506b009d452bfc2b3595c793265b64fb))
* **api:** migrate /api/secrets to ts-rest contract-first architecture ([#453](https://github.com/vm0-ai/vm0/issues/453)) ([27fd2fa](https://github.com/vm0-ai/vm0/commit/27fd2fa1cf0f5c7b3b6b227c547d59d56f13b9de))
* **api:** migrate webhooks and auth routes to ts-rest contracts ([#468](https://github.com/vm0-ai/vm0/issues/468)) ([08c38aa](https://github.com/vm0-ai/vm0/commit/08c38aa399bc776d6ef391ae5bfdd7da1d5d5b7c))
* **observability:** implement sandbox telemetry collection and storage ([#466](https://github.com/vm0-ai/vm0/issues/466)) ([8fe6748](https://github.com/vm0-ai/vm0/commit/8fe674887d84fba9f35838e7ebbdb288967feae4))
* **sandbox:** add metrics collection module with file logging ([#456](https://github.com/vm0-ai/vm0/issues/456)) ([98a9642](https://github.com/vm0-ai/vm0/commit/98a96422c288f42b3c37894aa1445a9e7f1ab5e8))
* **sandbox:** persist agent logs with per-run log files ([#451](https://github.com/vm0-ai/vm0/issues/451)) ([50bc170](https://github.com/vm0-ai/vm0/commit/50bc170028af3c8e241bf513312e07664361991d))


### Bug Fixes

* **e2b:** await sandbox kill in complete api to prevent orphaned sandboxes ([#452](https://github.com/vm0-ai/vm0/issues/452)) ([8a37ee5](https://github.com/vm0-ai/vm0/commit/8a37ee528ab8416255526d993dd637cfb0475436))
* **sandbox:** add timestamp to main log output ([#462](https://github.com/vm0-ai/vm0/issues/462)) ([b60a27f](https://github.com/vm0-ai/vm0/commit/b60a27f398ca3e50791e774dc5be7ecedc02323e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.3.0

## [5.0.1](https://github.com/vm0-ai/vm0/compare/web-v5.0.0...web-v5.0.1) (2025-12-09)


### Bug Fixes

* **e2b:** validate checkpoint api response before returning success ([#446](https://github.com/vm0-ai/vm0/issues/446)) ([4cd32ec](https://github.com/vm0-ai/vm0/commit/4cd32ecac41cc76f03e48edc5ef80f740fb80dd7))

## [5.0.0](https://github.com/vm0-ai/vm0/compare/web-v4.9.0...web-v5.0.0) (2025-12-09)


### ⚠ BREAKING CHANGES

* Server-level Minimax configuration removed. Users must configure API credentials via vm0 secrets and Agent Compose environment.

### Features

* **secrets:** mask user secrets in agent events before database storage ([#438](https://github.com/vm0-ai/vm0/issues/438)) ([0285f68](https://github.com/vm0-ai/vm0/commit/0285f68576f2bee83fc6a31fd51dddb88b399d66))


### Code Refactoring

* remove server-level Minimax config, use Agent Compose secrets ([#439](https://github.com/vm0-ai/vm0/issues/439)) ([b84f931](https://github.com/vm0-ai/vm0/commit/b84f9315d1516746179626b06ca712250c3d2182))

## [4.9.0](https://github.com/vm0-ai/vm0/compare/web-v4.8.2...web-v4.9.0) (2025-12-08)


### Features

* **image:** add E2B template deletion and improve error handling ([#427](https://github.com/vm0-ai/vm0/issues/427)) ([5630899](https://github.com/vm0-ai/vm0/commit/5630899d74a223f2e6e1185b5ae620971927b61e))

## [4.8.2](https://github.com/vm0-ai/vm0/compare/web-v4.8.1...web-v4.8.2) (2025-12-08)


### Bug Fixes

* rename VERCEL_CRON_SECRET to CRON_SECRET for Vercel cron authentication ([#425](https://github.com/vm0-ai/vm0/issues/425)) ([5a15fb3](https://github.com/vm0-ai/vm0/commit/5a15fb3ab53c96a8a8c40edb68016f2c2c3d977b))

## [4.8.1](https://github.com/vm0-ai/vm0/compare/web-v4.8.0...web-v4.8.1) (2025-12-08)


### Bug Fixes

* **web:** use entry.message instead of toString() for E2B build logs ([#423](https://github.com/vm0-ai/vm0/issues/423)) ([f81de6f](https://github.com/vm0-ai/vm0/commit/f81de6f9aba612c472ffd65741027fc6b49bd0c9))

## [4.8.0](https://github.com/vm0-ai/vm0/compare/web-v4.7.0...web-v4.8.0) (2025-12-08)


### Features

* add vm0 image build command for custom Dockerfile support ([#408](https://github.com/vm0-ai/vm0/issues/408)) ([66953a2](https://github.com/vm0-ai/vm0/commit/66953a22c4fce93d60ef8a176b58df555ce504a0))

## [4.7.0](https://github.com/vm0-ai/vm0/compare/web-v4.6.0...web-v4.7.0) (2025-12-06)


### Features

* **cli:** remove timeout option and detect sandbox termination via events API ([#417](https://github.com/vm0-ai/vm0/issues/417)) ([72fd836](https://github.com/vm0-ai/vm0/commit/72fd836f018e14719f1c9c47ceb11096c66228b2))


### Bug Fixes

* remove deprecated neonConfig.fetchConnectionCache option ([#412](https://github.com/vm0-ai/vm0/issues/412)) ([df9be35](https://github.com/vm0-ai/vm0/commit/df9be35eefacd9294bd2669f63cbfe61ebc27ffc))

## [4.6.0](https://github.com/vm0-ai/vm0/compare/web-v4.5.2...web-v4.6.0) (2025-12-06)


### Features

* **e2b:** add heartbeat-based sandbox cleanup mechanism ([#405](https://github.com/vm0-ai/vm0/issues/405)) ([6648962](https://github.com/vm0-ai/vm0/commit/6648962238f1ac2954ebe1c09f0583010abe0e5a))
* **web:** increase e2b sandbox timeout to 24 hours for production ([#411](https://github.com/vm0-ai/vm0/issues/411)) ([57c0258](https://github.com/vm0-ai/vm0/commit/57c02584275c677fb0a69a5fd320e3bf77a68014))

## [4.5.2](https://github.com/vm0-ai/vm0/compare/web-v4.5.1...web-v4.5.2) (2025-12-05)


### Bug Fixes

* patch critical react server components security vulnerability ([#397](https://github.com/vm0-ai/vm0/issues/397)) ([c5d6bb5](https://github.com/vm0-ai/vm0/commit/c5d6bb51e4bb74ed235b687e9fb369e31ca47d8e))

## [4.5.1](https://github.com/vm0-ai/vm0/compare/web-v4.5.0...web-v4.5.1) (2025-12-04)


### Bug Fixes

* **e2b:** use nohup to prevent agent process from being killed by SIGHUP ([#395](https://github.com/vm0-ai/vm0/issues/395)) ([0bcc76d](https://github.com/vm0-ai/vm0/commit/0bcc76de0ab8a8f0d6d3fe02fe153f6c0f70e5d1))

## [4.5.0](https://github.com/vm0-ai/vm0/compare/web-v4.4.2...web-v4.5.0) (2025-12-04)


### Features

* **e2b:** migrate sandbox scripts from bash to python ([#393](https://github.com/vm0-ai/vm0/issues/393)) ([a678a06](https://github.com/vm0-ai/vm0/commit/a678a06a0c72dc85143d0c4cfa212ee58ed3cc00))

## [4.4.2](https://github.com/vm0-ai/vm0/compare/web-v4.4.1...web-v4.4.2) (2025-12-04)


### Bug Fixes

* prevent script termination after claude exits in run-agent ([#386](https://github.com/vm0-ai/vm0/issues/386)) ([bac56b8](https://github.com/vm0-ai/vm0/commit/bac56b886a2ee25c8d8d630cfb1c81d8482a8d51))

## [4.4.1](https://github.com/vm0-ai/vm0/compare/web-v4.4.0...web-v4.4.1) (2025-12-04)


### Bug Fixes

* preserve file permissions during tar extraction in sandbox ([#375](https://github.com/vm0-ai/vm0/issues/375)) ([f352cb0](https://github.com/vm0-ai/vm0/commit/f352cb0c08958fd00dffa9965e3db72354b9e104))

## [4.4.0](https://github.com/vm0-ai/vm0/compare/web-v4.3.0...web-v4.4.0) (2025-12-03)


### Features

* add unified environment variable syntax ([#362](https://github.com/vm0-ai/vm0/issues/362)) ([e218dd7](https://github.com/vm0-ai/vm0/commit/e218dd76ddd4b7e6508725570b0cd7ee7d769f56))


### Bug Fixes

* update sandboxId in database immediately after sandbox creation ([#368](https://github.com/vm0-ai/vm0/issues/368)) ([bdaeccf](https://github.com/vm0-ai/vm0/commit/bdaeccf1b6c6ebbe7267859caabafd0356b879f5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.2.0

## [4.3.0](https://github.com/vm0-ai/vm0/compare/web-v4.2.0...web-v4.3.0) (2025-12-03)


### Features

* **cli:** support compose version specifier in vm0 run command ([#365](https://github.com/vm0-ai/vm0/issues/365)) ([7df7623](https://github.com/vm0-ai/vm0/commit/7df7623f9a2f32e5aa264bb17e348a97124e332e))

## [4.2.0](https://github.com/vm0-ai/vm0/compare/web-v4.1.0...web-v4.2.0) (2025-12-02)


### Features

* add immutable versioning for agent composes ([#355](https://github.com/vm0-ai/vm0/issues/355)) ([10f3000](https://github.com/vm0-ai/vm0/commit/10f300049e74e902a93444b469350a4f3d13c72d))


### Performance Improvements

* reduce e2b api calls with tar bundling for scripts ([#361](https://github.com/vm0-ai/vm0/issues/361)) ([252e4d5](https://github.com/vm0-ai/vm0/commit/252e4d550985c7d60c5a7938b075df1b64b9af7d))

## [4.1.0](https://github.com/vm0-ai/vm0/compare/web-v4.0.1...web-v4.1.0) (2025-12-02)


### Features

* capture stderr for detailed error messages in vm0_error ([#348](https://github.com/vm0-ai/vm0/issues/348)) ([e961a6f](https://github.com/vm0-ai/vm0/commit/e961a6f1d0edbaab2fcfd065ca7cf1158e3f34c6))


### Bug Fixes

* session resume fails due to agents dict being treated as array ([#347](https://github.com/vm0-ai/vm0/issues/347)) ([8bad8d9](https://github.com/vm0-ai/vm0/commit/8bad8d942621a881ffec1f8bf3452e4b004d7711))

## [4.0.1](https://github.com/vm0-ai/vm0/compare/web-v4.0.0...web-v4.0.1) (2025-12-02)


### Bug Fixes

* add sandbox cleanup via unified complete API ([#339](https://github.com/vm0-ai/vm0/issues/339)) ([7c282b2](https://github.com/vm0-ai/vm0/commit/7c282b20651675878f854dd9e64985acb33feaef))

## [4.0.0](https://github.com/vm0-ai/vm0/compare/web-v3.0.0...web-v4.0.0) (2025-12-01)


### ⚠ BREAKING CHANGES

* Existing agent.yaml files need to be migrated from: ```yaml agents:   - name: "my-agent"     image: "..." ``` to: ```yaml agents:   my-agent:     image: "..." ```

### Code Refactoring

* change agents from array to dictionary in agent.yaml ([#334](https://github.com/vm0-ai/vm0/issues/334)) ([c21a1d0](https://github.com/vm0-ai/vm0/commit/c21a1d09d36e93fdb3cba36ee16c536a8a69a960))

## [3.0.0](https://github.com/vm0-ai/vm0/compare/web-v2.8.2...web-v3.0.0) (2025-12-01)


### ⚠ BREAKING CHANGES

* CLI and API now use tar.gz format exclusively. Clients must be updated to send/receive tar.gz instead of zip.

### Code Refactoring

* unify compression stack to tar.gz ([#331](https://github.com/vm0-ai/vm0/issues/331)) ([0745967](https://github.com/vm0-ai/vm0/commit/07459676b1385d30223ec63d16b2190857b70a2b))

## [2.8.2](https://github.com/vm0-ai/vm0/compare/web-v2.8.1...web-v2.8.2) (2025-12-01)


### Bug Fixes

* handle empty artifact pull without TAR_BAD_ARCHIVE error ([#328](https://github.com/vm0-ai/vm0/issues/328)) ([3f23505](https://github.com/vm0-ai/vm0/commit/3f23505af3cbbb87926fd6baa255429ee52c29b8))

## [2.8.1](https://github.com/vm0-ai/vm0/compare/web-v2.8.0...web-v2.8.1) (2025-12-01)


### Bug Fixes

* implement conversation restoration for direct --conversation flag ([#326](https://github.com/vm0-ai/vm0/issues/326)) ([faa5c0a](https://github.com/vm0-ai/vm0/commit/faa5c0adcb1f7c7125b35911d31275604cdd1bf8))

## [2.8.0](https://github.com/vm0-ai/vm0/compare/web-v2.7.0...web-v2.8.0) (2025-11-30)


### Features

* **cli:** add --force flag to volume push command ([#321](https://github.com/vm0-ai/vm0/issues/321)) ([9e42c86](https://github.com/vm0-ai/vm0/commit/9e42c86fd6eec99062911b0e367bf27de89eabcb))

## [2.7.0](https://github.com/vm0-ai/vm0/compare/web-v2.6.2...web-v2.7.0) (2025-11-30)


### Features

* implement incremental upload for sandbox checkpoint ([#320](https://github.com/vm0-ai/vm0/issues/320)) ([2f4f1ef](https://github.com/vm0-ai/vm0/commit/2f4f1efef12bcbefc3faf4371634320005ba4ab5))
* tar.gz streaming with content-addressable blob storage ([#311](https://github.com/vm0-ai/vm0/issues/311)) ([d271acb](https://github.com/vm0-ai/vm0/commit/d271acb1ce5b641dda20e64199f9c26b3e013bff))

## [2.6.2](https://github.com/vm0-ai/vm0/compare/web-v2.6.1...web-v2.6.2) (2025-11-29)


### Bug Fixes

* handle empty artifact/volume in storage operations ([#312](https://github.com/vm0-ai/vm0/issues/312)) ([053b658](https://github.com/vm0-ai/vm0/commit/053b658412e12b8a5f91072d781d8f3eaaa24193))

## [2.6.1](https://github.com/vm0-ai/vm0/compare/web-v2.6.0...web-v2.6.1) (2025-11-29)


### Bug Fixes

* handle empty zip uploads in storage webhook ([#306](https://github.com/vm0-ai/vm0/issues/306)) ([cad45a8](https://github.com/vm0-ai/vm0/commit/cad45a874ab6006db3106b3aca8d36dde7f57804))

## [2.6.0](https://github.com/vm0-ai/vm0/compare/web-v2.5.0...web-v2.6.0) (2025-11-29)


### Features

* enforce promise await with eslint rules ([#303](https://github.com/vm0-ai/vm0/issues/303)) ([1989958](https://github.com/vm0-ai/vm0/commit/19899587084d866c462bf552b4e78f352163e5e0))

## [2.5.0](https://github.com/vm0-ai/vm0/compare/web-v2.4.1...web-v2.5.0) (2025-11-29)


### Features

* add direct S3 download to sandbox for faster storage preparation ([#299](https://github.com/vm0-ai/vm0/issues/299)) ([297d508](https://github.com/vm0-ai/vm0/commit/297d508674d009d059d7dc7bad60cb297bc5bc93))
* support empty artifact and volume push ([#296](https://github.com/vm0-ai/vm0/issues/296)) ([d1449e9](https://github.com/vm0-ai/vm0/commit/d1449e9cc691d28cc9a69f622d9bf5fe5076ec3d))


### Bug Fixes

* use waituntil to ensure background execution completes ([#302](https://github.com/vm0-ai/vm0/issues/302)) ([f95f1aa](https://github.com/vm0-ai/vm0/commit/f95f1aab327308a8097b065050eebf2078a46361))


### Performance Improvements

* parallelize storage operations for faster agent startup ([#298](https://github.com/vm0-ai/vm0/issues/298)) ([7a643c2](https://github.com/vm0-ai/vm0/commit/7a643c2b72df679566e1d7276c81b1b2844c87d9))

## [2.4.1](https://github.com/vm0-ai/vm0/compare/web-v2.4.0...web-v2.4.1) (2025-11-29)


### Bug Fixes

* display volumes in vm0_start event ([#293](https://github.com/vm0-ai/vm0/issues/293)) ([2249f03](https://github.com/vm0-ai/vm0/commit/2249f0349a7088130ff0bd6fc17664a930ccc53e))

## [2.4.0](https://github.com/vm0-ai/vm0/compare/web-v2.3.0...web-v2.4.0) (2025-11-28)


### Features

* use content-based sha-256 hash for storage version ids ([#289](https://github.com/vm0-ai/vm0/issues/289)) ([69eb252](https://github.com/vm0-ai/vm0/commit/69eb252d85883f4cb9943613142f6feafbe947b6))

## [2.3.0](https://github.com/vm0-ai/vm0/compare/web-v2.2.0...web-v2.3.0) (2025-11-28)


### Features

* enhance vm0 run output with complete execution context ([#283](https://github.com/vm0-ai/vm0/issues/283)) ([5f4eeb6](https://github.com/vm0-ai/vm0/commit/5f4eeb624522f109f4afb916b374cf005528d5cc))
* **web:** add structured logging system ([#277](https://github.com/vm0-ai/vm0/issues/277)) ([c2788b4](https://github.com/vm0-ai/vm0/commit/c2788b4ceb3bd140656efb890d4a55e686df4f0c))


### Bug Fixes

* extract stderr from E2B CommandExitError for better error reporting ([#287](https://github.com/vm0-ai/vm0/issues/287)) ([80df946](https://github.com/vm0-ai/vm0/commit/80df9464df9512ecf0281c29e6c3b4bca0b9b106))
* improve sandbox script error handling with retry and unified logging ([#273](https://github.com/vm0-ai/vm0/issues/273)) ([5201591](https://github.com/vm0-ai/vm0/commit/5201591864b327579050d94112734cc13a08adbd))

## [2.2.0](https://github.com/vm0-ai/vm0/compare/web-v2.1.1...web-v2.2.0) (2025-11-28)


### Features

* unify agent run API with volume version override support ([#258](https://github.com/vm0-ai/vm0/issues/258)) ([7a5260e](https://github.com/vm0-ai/vm0/commit/7a5260e573dbd42ef084e30d739d7a7773ec65c5))

## [2.1.1](https://github.com/vm0-ai/vm0/compare/web-v2.1.0...web-v2.1.1) (2025-11-28)


### Bug Fixes

* **web:** make landing page cube respond to window-wide mouse movement ([#252](https://github.com/vm0-ai/vm0/issues/252)) ([ea50d7f](https://github.com/vm0-ai/vm0/commit/ea50d7f19356b5b741910d4ddd42938a00fb1c73))

## [2.1.0](https://github.com/vm0-ai/vm0/compare/web-v2.0.0...web-v2.1.0) (2025-11-27)


### Features

* introduce Agent Session concept and refactor vm0 run CLI ([#243](https://github.com/vm0-ai/vm0/issues/243)) ([2211c97](https://github.com/vm0-ai/vm0/commit/2211c972d5ee295a9f84780dd938c27ebec40ff7))

## [2.0.0](https://github.com/vm0-ai/vm0/compare/web-v1.6.1...web-v2.0.0) (2025-11-27)


### ⚠ BREAKING CHANGES

* Checkpoint schema changed, requires database migration

### Features

* **cli:** add version selection support for volume and artifact pull ([#223](https://github.com/vm0-ai/vm0/issues/223)) ([7981119](https://github.com/vm0-ai/vm0/commit/7981119217f138b912773808a98e85725c7f4752))
* **config:** restructure agent.yaml format and artifact handling ([#224](https://github.com/vm0-ai/vm0/issues/224)) ([b60d92e](https://github.com/vm0-ai/vm0/commit/b60d92ef1e97aef54fc9a39b6c13e09aa593b928))
* remove git driver and rename vm0 to VAS ([#230](https://github.com/vm0-ai/vm0/issues/230)) ([0c5bdad](https://github.com/vm0-ai/vm0/commit/0c5bdadf09a0d281d42a90951e5e89bc5e47550b))
* **web:** add github repository link to navbar ([#245](https://github.com/vm0-ai/vm0/issues/245)) ([f13cbbb](https://github.com/vm0-ai/vm0/commit/f13cbbba4203bbfdaf11f8b45885a914ebe837b7))


### Code Refactoring

* restructure checkpoint schema with conversations table ([#231](https://github.com/vm0-ai/vm0/issues/231)) ([#239](https://github.com/vm0-ai/vm0/issues/239)) ([8f05f0b](https://github.com/vm0-ai/vm0/commit/8f05f0b7a38dbd7ac9c24da2f442517de8c70a29))

## [1.6.1](https://github.com/vm0-ai/vm0/compare/web-v1.6.0...web-v1.6.1) (2025-11-26)


### Bug Fixes

* fail fast when vm0 artifact configured but no artifact key provided ([#214](https://github.com/vm0-ai/vm0/issues/214)) ([bebcedc](https://github.com/vm0-ai/vm0/commit/bebcedcf21111611607c9b8dc352a539dc2ed473))
* make s3 bucket name configurable via environment variable ([#212](https://github.com/vm0-ai/vm0/issues/212)) ([6f61cc5](https://github.com/vm0-ai/vm0/commit/6f61cc50ae59a4e3554e428c465ce7e7085b1768))

## [1.6.0](https://github.com/vm0-ai/vm0/compare/web-v1.5.0...web-v1.6.0) (2025-11-26)


### Features

* add mock-claude for faster e2e testing ([#207](https://github.com/vm0-ai/vm0/issues/207)) ([745ba86](https://github.com/vm0-ai/vm0/commit/745ba86306c71af8b8c2f45b63819f8283dbeb70))
* replace dynamic_volumes with artifact concept ([#210](https://github.com/vm0-ai/vm0/issues/210)) ([5cc831c](https://github.com/vm0-ai/vm0/commit/5cc831c81041ae8f80c425d68b9491354eaafa2b))

## [1.5.0](https://github.com/vm0-ai/vm0/compare/web-v1.4.0...web-v1.5.0) (2025-11-25)


### Features

* add contact us and website tracking ([#205](https://github.com/vm0-ai/vm0/issues/205)) ([c3b93a9](https://github.com/vm0-ai/vm0/commit/c3b93a9375efd71c887be86a84ad2749a63d76fa))

## [1.4.0](https://github.com/vm0-ai/vm0/compare/web-v1.3.3...web-v1.4.0) (2025-11-25)


### Features

* add vm0 driver support for dynamic_volumes with checkpoint versioning ([#190](https://github.com/vm0-ai/vm0/issues/190)) ([a8e10b8](https://github.com/vm0-ai/vm0/commit/a8e10b848d41055686775197d4c650e70d6fe3f9))

## [1.3.3](https://github.com/vm0-ai/vm0/compare/web-v1.3.2...web-v1.3.3) (2025-11-25)


### Bug Fixes

* push git branch to remote in sandbox script even without changes ([#197](https://github.com/vm0-ai/vm0/issues/197)) ([4213bfe](https://github.com/vm0-ai/vm0/commit/4213bfe6deca858095077d1c7317bc677e77dfe1))

## [1.3.2](https://github.com/vm0-ai/vm0/compare/web-v1.3.1...web-v1.3.2) (2025-11-25)


### Bug Fixes

* push git branch to remote even when no changes to commit ([#193](https://github.com/vm0-ai/vm0/issues/193)) ([687a71d](https://github.com/vm0-ai/vm0/commit/687a71de1eb7f3869c9beab3fefb9dbe9d0d5151))

## [1.3.1](https://github.com/vm0-ai/vm0/compare/web-v1.3.0...web-v1.3.1) (2025-11-25)


### Bug Fixes

* fail agent run when vm0 volume preparation fails ([#188](https://github.com/vm0-ai/vm0/issues/188)) ([406a5ed](https://github.com/vm0-ai/vm0/commit/406a5ed6733077696c97f734be2e8405d19e9782))

## [1.3.0](https://github.com/vm0-ai/vm0/compare/web-v1.2.1...web-v1.3.0) (2025-11-25)


### Features

* add version management to vm0 volumes ([#182](https://github.com/vm0-ai/vm0/issues/182)) ([96677de](https://github.com/vm0-ai/vm0/commit/96677de998ca22f7e441c4b38d44c1dd47bac64c))

## [1.2.1](https://github.com/vm0-ai/vm0/compare/web-v1.2.0...web-v1.2.1) (2025-11-24)


### Bug Fixes

* improve checkpoint resume debugging for git volumes ([#176](https://github.com/vm0-ai/vm0/issues/176)) ([#178](https://github.com/vm0-ai/vm0/issues/178)) ([228bab2](https://github.com/vm0-ai/vm0/commit/228bab2bb0fea624ee31ee99267d3179154ba2d0))

## [1.2.0](https://github.com/vm0-ai/vm0/compare/web-v1.1.0...web-v1.2.0) (2025-11-24)


### Features

* implement vm0 managed volumes (simple MVP - full upload/download) ([#172](https://github.com/vm0-ai/vm0/issues/172)) ([ce2f717](https://github.com/vm0-ai/vm0/commit/ce2f717ae1c05c806a9a2f5cd1febd57ad7be1ce))


### Bug Fixes

* remove all eslint suppression comments and use vi.stubEnv for tests ([#171](https://github.com/vm0-ai/vm0/issues/171)) ([e210c7c](https://github.com/vm0-ai/vm0/commit/e210c7c0df82e045b3e9103b0bd6dabc28567c12))

## [1.1.0](https://github.com/vm0-ai/vm0/compare/web-v1.0.0...web-v1.1.0) (2025-11-23)


### Features

* add validation for environment and template variables before execution ([#164](https://github.com/vm0-ai/vm0/issues/164)) ([a197eba](https://github.com/vm0-ai/vm0/commit/a197eba8ee189e37317e80fd720d1a8df64a863a))


### Bug Fixes

* remove duplicate result event emission in agent execution ([#162](https://github.com/vm0-ai/vm0/issues/162)) ([3d7b336](https://github.com/vm0-ai/vm0/commit/3d7b3364fba12ff2519e2176e8ef42305cb8d08d))

## [1.0.0](https://github.com/vm0-ai/vm0/compare/web-v0.7.0...web-v1.0.0) (2025-11-22)


### ⚠ BREAKING CHANGES

* rename 'dynamic-volumes' to 'dynamic_volumes' in config files

### Features

* add checkpoint api endpoint for saving agent run state ([#152](https://github.com/vm0-ai/vm0/issues/152)) ([098adc6](https://github.com/vm0-ai/vm0/commit/098adc6368b9c7bb4f9c6584bc988dd3ab0aa311))
* add git volume driver support for repository mounting ([#150](https://github.com/vm0-ai/vm0/issues/150)) ([6f3d79c](https://github.com/vm0-ai/vm0/commit/6f3d79cdfb785107beab09c9fb5b7fdb737b7bb3))
* enable runtime script transfer for dynamic agent execution ([#139](https://github.com/vm0-ai/vm0/issues/139)) ([77383f0](https://github.com/vm0-ai/vm0/commit/77383f077bc38fc64b7cb566275c6c2e23f21481))
* implement checkpoint resume functionality ([#156](https://github.com/vm0-ai/vm0/issues/156)) ([304f672](https://github.com/vm0-ai/vm0/commit/304f672dd800a5d9d2b18001438ff67260019efe))
* implement VM0 system events for run lifecycle management ([#154](https://github.com/vm0-ai/vm0/issues/154)) ([8e2ff1d](https://github.com/vm0-ai/vm0/commit/8e2ff1d6f8370225b3e6085a56e3bb8eb680a755))
* standardize config naming to snake_case for reserved keywords ([#135](https://github.com/vm0-ai/vm0/issues/135)) ([126fcfd](https://github.com/vm0-ai/vm0/commit/126fcfde1b1101fc7d10de1b4886ac11c0da156d))


### Bug Fixes

* correct typos in landing page CLI section ([#158](https://github.com/vm0-ai/vm0/issues/158)) ([eccd66b](https://github.com/vm0-ai/vm0/commit/eccd66bce473b3fa62ab652350e935671335c1da))


### Performance Improvements

* optimize landing page background images ([#141](https://github.com/vm0-ai/vm0/issues/141)) ([6d160ab](https://github.com/vm0-ai/vm0/commit/6d160ab3540e063856144dfbec80578920eaefda))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/web-v0.6.0...web-v0.7.0) (2025-11-21)


### Features

* migrate landing page to apps/web ([#136](https://github.com/vm0-ai/vm0/issues/136)) ([a11e26e](https://github.com/vm0-ai/vm0/commit/a11e26ebbc0a8787792918882c6243180a1603f4))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/web-v0.5.1...web-v0.6.0) (2025-11-21)


### Features

* use agent.image for E2B template selection ([#125](https://github.com/vm0-ai/vm0/issues/125)) ([6d73ddb](https://github.com/vm0-ai/vm0/commit/6d73ddbfe1d9589f96b9956cbe4f5284409d4478))

## [0.5.1](https://github.com/vm0-ai/vm0/compare/web-v0.5.0...web-v0.5.1) (2025-11-20)


### Bug Fixes

* set explicit 1-hour timeout for e2b sandbox lifecycle ([#117](https://github.com/vm0-ai/vm0/issues/117)) ([b1594b8](https://github.com/vm0-ai/vm0/commit/b1594b8b59600341d5ea3bde3623da4e7cec4b8d))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/web-v0.4.1...web-v0.5.0) (2025-11-20)


### Features

* add working_dir support for agent execution ([#113](https://github.com/vm0-ai/vm0/issues/113)) ([a96f487](https://github.com/vm0-ai/vm0/commit/a96f487d8536041b86ef49cd05621dfa5476d5dc))
* implement volume mounting for S3-backed agent workspaces ([#103](https://github.com/vm0-ai/vm0/issues/103)) ([85f7b8e](https://github.com/vm0-ai/vm0/commit/85f7b8e758a6b4d2d5ae6b899be2c4b247959302))


### Bug Fixes

* remove timeout limitation for e2b sandbox command execution ([#114](https://github.com/vm0-ai/vm0/issues/114)) ([e4c5c86](https://github.com/vm0-ai/vm0/commit/e4c5c869aa4af6433f871b38a199f13895e94704))
* require authentication for cli device authorization page ([#104](https://github.com/vm0-ai/vm0/issues/104)) ([39428a4](https://github.com/vm0-ai/vm0/commit/39428a4c209403e15a48eea8d468860a50ec716b))

## [0.4.1](https://github.com/vm0-ai/vm0/compare/web-v0.4.0...web-v0.4.1) (2025-11-20)


### Bug Fixes

* use production url for e2b webhook callbacks ([#100](https://github.com/vm0-ai/vm0/issues/100)) ([ead881d](https://github.com/vm0-ai/vm0/commit/ead881d89efbe33d0a2f656b230aa0aac2ba51e3))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/web-v0.3.0...web-v0.4.0) (2025-11-20)


### Features

* **ci:** add environment variables injection for e2b and minimax ([#97](https://github.com/vm0-ai/vm0/issues/97)) ([584ebcc](https://github.com/vm0-ai/vm0/commit/584ebcc92f9ef888921319d2944fa6106175c223))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/web-v0.2.0...web-v0.3.0) (2025-11-20)


### Features

* add CLI e2e device flow automation and production API fallback ([#73](https://github.com/vm0-ai/vm0/issues/73)) ([8eb2d21](https://github.com/vm0-ai/vm0/commit/8eb2d21e6a2f363f93575f85bde5081a2ff218a7))
* add device flow authentication for cli ([#39](https://github.com/vm0-ai/vm0/issues/39)) ([b6ae61c](https://github.com/vm0-ai/vm0/commit/b6ae61c4244b318e9a6d3969d1ab57bd3d47c873))
* add e2b api key configuration ([#41](https://github.com/vm0-ai/vm0/issues/41)) ([e4fd5ed](https://github.com/vm0-ai/vm0/commit/e4fd5edd85a30225f6efac9e26677d9a4ec59f77))
* add support for agent names in vm0 run command ([#71](https://github.com/vm0-ai/vm0/issues/71)) ([4842d80](https://github.com/vm0-ai/vm0/commit/4842d80f0ce24aec3683ff0e364fc9e22eb24177))
* implement CLI build and run commands ([#65](https://github.com/vm0-ai/vm0/issues/65)) ([c0b8d11](https://github.com/vm0-ai/vm0/commit/c0b8d114a8c6910bfce7c2e4e10a82509889a28f))
* implement event streaming for vm0 run command ([#92](https://github.com/vm0-ai/vm0/issues/92)) ([a551950](https://github.com/vm0-ai/vm0/commit/a5519501aa6e7b3b739e05a965d58868498dbdca))
* implement phase 1 database schema and api framework for agent configs ([#37](https://github.com/vm0-ai/vm0/issues/37)) ([f8a9b08](https://github.com/vm0-ai/vm0/commit/f8a9b0815c8b3c4b5063d8f1d84cea522006f79c))
* implement phase 1 database schema and api framework with integration tests ([#44](https://github.com/vm0-ai/vm0/issues/44)) ([d89e686](https://github.com/vm0-ai/vm0/commit/d89e686282b409149187c684371077387b91b31a))
* implement Phase 1.5 E2B Service Layer with Hello World ([#46](https://github.com/vm0-ai/vm0/issues/46)) ([7e5b639](https://github.com/vm0-ai/vm0/commit/7e5b6397c21222843de07ee5895e9f7c9c844038))
* implement webhook API for agent events ([#54](https://github.com/vm0-ai/vm0/issues/54)) ([ea55437](https://github.com/vm0-ai/vm0/commit/ea554376a3b0f2188d8ea53a15f02883fbd84f01))
* integrate Claude Code execution in E2B sandbox ([#58](https://github.com/vm0-ai/vm0/issues/58)) ([a8434d9](https://github.com/vm0-ai/vm0/commit/a8434d9fbf7d00b4854040227477d8d66a609266))
* integrate database storage with agent runtime API ([#49](https://github.com/vm0-ai/vm0/issues/49)) ([d743837](https://github.com/vm0-ai/vm0/commit/d743837224cc639791bae78c28cbe1c6cf742328))
* migrate authentication from api keys to bearer tokens ([#59](https://github.com/vm0-ai/vm0/issues/59)) ([87c887c](https://github.com/vm0-ai/vm0/commit/87c887cdf900010f8b71bf900b910abf8af60a69))


### Bug Fixes

* change agent_runtime_events.sequenceNumber from varchar to integer ([#55](https://github.com/vm0-ai/vm0/issues/55)) ([0b860e1](https://github.com/vm0-ai/vm0/commit/0b860e1a43ab0a1a7eb62223f8c787b2270ed05c))
* resolve E2B script loading error by pre-installing run-agent.sh in template ([#68](https://github.com/vm0-ai/vm0/issues/68)) ([0cc2bd3](https://github.com/vm0-ai/vm0/commit/0cc2bd3875bce658f3055290c1f1643b732ac24c))
* update webhook sequence numbers to use integer type ([#57](https://github.com/vm0-ai/vm0/issues/57)) ([d67380a](https://github.com/vm0-ai/vm0/commit/d67380afea6aed7e09e92bef9ff71fa41efec58e))
* use correct env var and auth header for webhook authentication ([#80](https://github.com/vm0-ai/vm0/issues/80)) ([b821df4](https://github.com/vm0-ai/vm0/commit/b821df4d412da54aa880dbd98d1b57567cf1b4e0))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/web-v0.1.0...web-v0.2.0) (2025-11-15)

### Features

- integrate clerk authentication for web app ([#15](https://github.com/vm0-ai/vm0/issues/15)) ([c855703](https://github.com/vm0-ai/vm0/commit/c8557031027ccc03d147f164bd03821962a71daa))

## [0.1.0](https://github.com/vm0-ai/vm0/compare/web-v0.0.1...web-v0.1.0) (2025-11-15)

### Features

- initial project setup from makita template ([e9c330a](https://github.com/vm0-ai/vm0/commit/e9c330a5952526d657f245e8db9522de553018b3))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @vm0/core bumped to 0.1.0

## [0.1.0](https://github.com/e7h4n/vm0/compare/web-v0.0.1...web-v0.1.0) (2025-08-30)

### Features

- add database migration support with postgres driver ([#24](https://github.com/e7h4n/vm0/issues/24)) ([3760efa](https://github.com/e7h4n/vm0/commit/3760efae5a3cb47a6dfa56e13507dcddb58b92b6))
- add t3-env for type-safe environment variable validation ([#5](https://github.com/e7h4n/vm0/issues/5)) ([10ac6ab](https://github.com/e7h4n/vm0/commit/10ac6ab67e654b6fa8aeef8e6c63649f003f5656))
- implement centralized API contract system ([#13](https://github.com/e7h4n/vm0/issues/13)) ([77bbbd9](https://github.com/e7h4n/vm0/commit/77bbbd913b52341a7720e9bb711d889253d9681a))
- implement lightweight service container for dependency management ([#18](https://github.com/e7h4n/vm0/issues/18)) ([ce6efe9](https://github.com/e7h4n/vm0/commit/ce6efe9df914c0e2bc8de3ccc7a0af114a2b4037))
- initial commit - app template with turborepo monorepo structure ([4123914](https://github.com/e7h4n/vm0/commit/41239143cdaea284f55a02c89fde348c2e3b53ff))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @vm0/core bumped to 0.1.0
