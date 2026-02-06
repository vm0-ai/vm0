# Changelog

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
