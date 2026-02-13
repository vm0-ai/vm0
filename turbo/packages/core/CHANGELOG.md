# Changelog

## [8.14.0](https://github.com/vm0-ai/vm0/compare/core-v8.13.0...core-v8.14.0) (2026-02-13)


### Features

* **api:** add backend support for agent detail page ([#2979](https://github.com/vm0-ai/vm0/issues/2979)) ([4103d8f](https://github.com/vm0-ai/vm0/commit/4103d8f66ccc9546bccc67454d139b8d1de04599))

## [8.13.0](https://github.com/vm0-ai/vm0/compare/core-v8.12.0...core-v8.13.0) (2026-02-12)


### Features

* add computer connector api for authenticated local tunneling via ngrok ([#2937](https://github.com/vm0-ai/vm0/issues/2937)) ([4f3fc4e](https://github.com/vm0-ai/vm0/commit/4f3fc4ebf137409a30b85b5882634a6bb8846836))

## [8.12.0](https://github.com/vm0-ai/vm0/compare/core-v8.11.0...core-v8.12.0) (2026-02-12)


### Features

* add notify-slack preference to gate slack schedule notifications ([#2945](https://github.com/vm0-ai/vm0/issues/2945)) ([a0058e6](https://github.com/vm0-ai/vm0/commit/a0058e6d2c2a7f6c4d20c78a287488ba843cce02))

## [8.11.0](https://github.com/vm0-ai/vm0/compare/core-v8.10.0...core-v8.11.0) (2026-02-12)


### Features

* **email:** add email notifications and reply-to-continue via Resend ([#2836](https://github.com/vm0-ai/vm0/issues/2836)) ([fd6aa4c](https://github.com/vm0-ai/vm0/commit/fd6aa4c032a84f25e8c6a8cf4ba4cef5ff070bd9))
* **storage:** add optional volume support for graceful degradation ([#2929](https://github.com/vm0-ai/vm0/issues/2929)) ([fd052a4](https://github.com/vm0-ai/vm0/commit/fd052a4fef4b2157bb1b1a7a2a0eaccffa6ff262))

## [8.10.0](https://github.com/vm0-ai/vm0/compare/core-v8.9.0...core-v8.10.0) (2026-02-12)


### Features

* allow users to set timezone preference for sandbox and scheduling ([#2866](https://github.com/vm0-ai/vm0/issues/2866)) ([89437c7](https://github.com/vm0-ai/vm0/commit/89437c733b4e34eee46009b20c99f455c5963289))
* **core:** add glm-5 model and fix model id casing ([#2889](https://github.com/vm0-ai/vm0/issues/2889)) ([f7dff90](https://github.com/vm0-ai/vm0/commit/f7dff9098110a983c8bf6c15740fa01010f09f5b)), closes [#2883](https://github.com/vm0-ai/vm0/issues/2883)

## [8.9.0](https://github.com/vm0-ai/vm0/compare/core-v8.8.0...core-v8.9.0) (2026-02-10)


### Features

* **cli:** add agent delete command ([#2767](https://github.com/vm0-ai/vm0/issues/2767)) ([11d555a](https://github.com/vm0-ai/vm0/commit/11d555ad5432a9893ddc37e55f89a58e7dd5657c))

## [8.8.0](https://github.com/vm0-ai/vm0/compare/core-v8.7.1...core-v8.8.0) (2026-02-10)


### Features

* **cli:** add --check-env flag to vm0 run commands ([#2760](https://github.com/vm0-ai/vm0/issues/2760)) ([f6711e0](https://github.com/vm0-ai/vm0/commit/f6711e0d047aa872c76f97c8cfaf1257d2f35fb0))
* **web:** add Notion OAuth connector support ([#2738](https://github.com/vm0-ai/vm0/issues/2738)) ([a201b5d](https://github.com/vm0-ai/vm0/commit/a201b5d7ffdd081b4a9f299297bad0e06fa890b1))

## [8.7.1](https://github.com/vm0-ai/vm0/compare/core-v8.7.0...core-v8.7.1) (2026-02-10)


### Bug Fixes

* exclude connector-provided secrets from missing-secrets checks ([#2752](https://github.com/vm0-ai/vm0/issues/2752)) ([3dc98d4](https://github.com/vm0-ai/vm0/commit/3dc98d47451a2084b50a9a6ebce2f2ccb31d2833)), closes [#2747](https://github.com/vm0-ai/vm0/issues/2747)

## [8.7.0](https://github.com/vm0-ai/vm0/compare/core-v8.6.1...core-v8.7.0) (2026-02-10)


### Features

* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))

## [8.6.1](https://github.com/vm0-ai/vm0/compare/core-v8.6.0...core-v8.6.1) (2026-02-09)


### Bug Fixes

* **web:** disable json query to fix flaky ambiguous-prefix test ([#2701](https://github.com/vm0-ai/vm0/issues/2701)) ([a5f8e8a](https://github.com/vm0-ai/vm0/commit/a5f8e8a375a3a84c46518780201b66f75ea845a3))

## [8.6.0](https://github.com/vm0-ai/vm0/compare/core-v8.5.1...core-v8.6.0) (2026-02-09)


### Features

* **cli:** add filtering options to run list command ([#2646](https://github.com/vm0-ai/vm0/issues/2646)) ([73c3509](https://github.com/vm0-ai/vm0/commit/73c3509380b5038eb5b97df6ab50106d41ea7358))

## [8.5.1](https://github.com/vm0-ai/vm0/compare/core-v8.5.0...core-v8.5.1) (2026-02-09)


### Bug Fixes

* **sandbox:** remove prompt content from agent execution logs ([#2653](https://github.com/vm0-ai/vm0/issues/2653)) ([cfc8b2d](https://github.com/vm0-ai/vm0/commit/cfc8b2dfecb0120d3e83bb0b7568e0b9916b3414))

## [8.5.0](https://github.com/vm0-ai/vm0/compare/core-v8.4.2...core-v8.5.0) (2026-02-09)


### Features

* **cli:** show connector-derived secret names in secret list ([#2602](https://github.com/vm0-ai/vm0/issues/2602)) ([877a318](https://github.com/vm0-ai/vm0/commit/877a31858cf10b7d3d6060d6e10e606c22cd2a83)), closes [#2601](https://github.com/vm0-ai/vm0/issues/2601)

## [8.4.2](https://github.com/vm0-ai/vm0/compare/core-v8.4.1...core-v8.4.2) (2026-02-07)


### Bug Fixes

* **web:** inject connector secrets into agent execution environment ([#2584](https://github.com/vm0-ai/vm0/issues/2584)) ([f483b5b](https://github.com/vm0-ai/vm0/commit/f483b5b0c0c94e45a149f99b8f108c3fc74399a4))

## [8.4.1](https://github.com/vm0-ai/vm0/compare/core-v8.4.0...core-v8.4.1) (2026-02-07)


### Bug Fixes

* **schedule:** validate secrets/vars against platform tables ([#2558](https://github.com/vm0-ai/vm0/issues/2558)) ([f19d550](https://github.com/vm0-ai/vm0/commit/f19d5506e61f16536bf163e5884266d31326fe40))

## [8.4.0](https://github.com/vm0-ai/vm0/compare/core-v8.3.0...core-v8.4.0) (2026-02-07)


### Features

* **connector:** implement github oauth connector with cli support ([#2446](https://github.com/vm0-ai/vm0/issues/2446)) ([c12c97a](https://github.com/vm0-ai/vm0/commit/c12c97a2af0b74d8bdfd452e2cbe7000f9e24f34))

## [8.3.0](https://github.com/vm0-ai/vm0/compare/core-v8.2.2...core-v8.3.0) (2026-02-07)


### Features

* **web:** add server-side github compose api ([#2473](https://github.com/vm0-ai/vm0/issues/2473)) ([9ab1f23](https://github.com/vm0-ai/vm0/commit/9ab1f2344f11086fd0f4c30036d04c72fab61b68))

## [8.2.2](https://github.com/vm0-ai/vm0/compare/core-v8.2.1...core-v8.2.2) (2026-02-06)


### Bug Fixes

* **docs:** update aws bedrock setup guide url ([#2495](https://github.com/vm0-ai/vm0/issues/2495)) ([8026a4a](https://github.com/vm0-ai/vm0/commit/8026a4a185ebea25738d580ebe8cda5ea067d59e))

## [8.2.1](https://github.com/vm0-ai/vm0/compare/core-v8.2.0...core-v8.2.1) (2026-02-06)


### Bug Fixes

* **cli:** support repository root GitHub URLs in vm0 compose ([#2427](https://github.com/vm0-ai/vm0/issues/2427)) ([6c0ba38](https://github.com/vm0-ai/vm0/commit/6c0ba385bdca8a63d1bff03840d0595150d78cd4)), closes [#2423](https://github.com/vm0-ai/vm0/issues/2423)
* **core:** handle trailing slashes in GitHub URL parsing ([#2459](https://github.com/vm0-ai/vm0/issues/2459)) ([10226c7](https://github.com/vm0-ai/vm0/commit/10226c74372cfd3a9e9f08295ad086c41e80acc7)), closes [#2455](https://github.com/vm0-ai/vm0/issues/2455)

## [8.2.0](https://github.com/vm0-ai/vm0/compare/core-v8.1.0...core-v8.2.0) (2026-02-04)


### Features

* **cli:** add vm0 variable command for server-side variable storage ([#2344](https://github.com/vm0-ai/vm0/issues/2344)) ([6831866](https://github.com/vm0-ai/vm0/commit/6831866c271e5b711fa979c1deef56c1ab9bd2a4))

## [8.1.0](https://github.com/vm0-ai/vm0/compare/core-v8.0.0...core-v8.1.0) (2026-02-04)


### Features

* **model-provider:** add Azure Foundry support ([#2317](https://github.com/vm0-ai/vm0/issues/2317)) ([7926adb](https://github.com/vm0-ai/vm0/commit/7926adb0a34c25277b49c9d0bea263c5737f959d)), closes [#2310](https://github.com/vm0-ai/vm0/issues/2310)

## [8.0.0](https://github.com/vm0-ai/vm0/compare/core-v7.15.0...core-v8.0.0) (2026-02-04)


### ⚠ BREAKING CHANGES

* **e2b:** The :dev tag is no longer supported for system images. Use vm0/claude-code or vm0/codex without tag (defaults to :latest).

### Code Refactoring

* **e2b:** remove -dev suffix and hardcode template names ([#2306](https://github.com/vm0-ai/vm0/issues/2306)) ([f2aaf5b](https://github.com/vm0-ai/vm0/commit/f2aaf5b734c6799e841c596bdcaa18c86e3cbb0d))

## [7.15.0](https://github.com/vm0-ai/vm0/compare/core-v7.14.0...core-v7.15.0) (2026-02-04)


### Features

* add /api/secrets endpoints for credential-to-secret migration (Phase 1) ([#2293](https://github.com/vm0-ai/vm0/issues/2293)) ([0954347](https://github.com/vm0-ai/vm0/commit/0954347e24a495d40b4ad0b28afb7c338e56ee6c))
* **model-provider:** add Z.AI (GLM) support ([#2291](https://github.com/vm0-ai/vm0/issues/2291)) ([a4a0df9](https://github.com/vm0-ai/vm0/commit/a4a0df92c63461c0e957b80eb2f79d4cfa83889b)), closes [#2283](https://github.com/vm0-ai/vm0/issues/2283)

## [7.14.0](https://github.com/vm0-ai/vm0/compare/core-v7.13.0...core-v7.14.0) (2026-02-04)


### Features

* **model-provider:** add deepseek api key support and simplify provider labels ([#2276](https://github.com/vm0-ai/vm0/issues/2276)) ([1fcd190](https://github.com/vm0-ai/vm0/commit/1fcd190fe8d95dc141001f911442b8f2b592c7d0)), closes [#2262](https://github.com/vm0-ai/vm0/issues/2262)

## [7.13.0](https://github.com/vm0-ai/vm0/compare/core-v7.12.0...core-v7.13.0) (2026-02-03)


### Features

* **core:** enable platform agents feature switch by default ([#2256](https://github.com/vm0-ai/vm0/issues/2256)) ([8a4ada4](https://github.com/vm0-ai/vm0/commit/8a4ada42ae4bf965cb626bd87cbd4e4bb0d99e61))

## [7.12.0](https://github.com/vm0-ai/vm0/compare/core-v7.11.0...core-v7.12.0) (2026-02-03)


### Features

* **model-provider:** add aws bedrock support with multi-auth provider architecture ([#2214](https://github.com/vm0-ai/vm0/issues/2214)) ([8009acf](https://github.com/vm0-ai/vm0/commit/8009acf84785e70aaf63f47e23358184d6058c22))

## [7.11.0](https://github.com/vm0-ai/vm0/compare/core-v7.10.0...core-v7.11.0) (2026-02-03)


### Features

* **web:** add llm chat api using openrouter sdk ([#2195](https://github.com/vm0-ai/vm0/issues/2195)) ([d0368a2](https://github.com/vm0-ai/vm0/commit/d0368a28c662fbc4894704a733c05f778c502aac))

## [7.10.0](https://github.com/vm0-ai/vm0/compare/core-v7.9.0...core-v7.10.0) (2026-02-03)


### Features

* **platform:** add session id and framework fields to logs list response ([#2208](https://github.com/vm0-ai/vm0/issues/2208)) ([8a55eca](https://github.com/vm0-ai/vm0/commit/8a55eca92e46080d248160cbba8eebdf40769750))

## [7.9.0](https://github.com/vm0-ai/vm0/compare/core-v7.8.0...core-v7.9.0) (2026-02-03)


### Features

* add minimax-api-key model provider ([#2178](https://github.com/vm0-ai/vm0/issues/2178)) ([4176dbc](https://github.com/vm0-ai/vm0/commit/4176dbc3af4a1836cc4758d58d51e29e2f8feccc))
* **cli:** improve model-provider setup ux with configuration status ([#2182](https://github.com/vm0-ai/vm0/issues/2182)) ([6c6617d](https://github.com/vm0-ai/vm0/commit/6c6617d5014ae86861df99488e64b577ee94ef26))
* **core:** add openrouter-api-key model provider with auto routing ([#2151](https://github.com/vm0-ai/vm0/issues/2151)) ([861d7dc](https://github.com/vm0-ai/vm0/commit/861d7dcee779d4d0082e3b9f7deed67e1d429c02))


### Performance Improvements

* **platform:** include basic log info in logs list API response ([#2165](https://github.com/vm0-ai/vm0/issues/2165)) ([1a4d4c5](https://github.com/vm0-ai/vm0/commit/1a4d4c51171bf1f08df6d305dd9dce488d8c652f))

## [7.8.0](https://github.com/vm0-ai/vm0/compare/core-v7.7.0...core-v7.8.0) (2026-02-02)


### Features

* add moonshot-api-key provider with credential mapping and model selection ([#2110](https://github.com/vm0-ai/vm0/issues/2110)) ([88f8f9d](https://github.com/vm0-ai/vm0/commit/88f8f9d369529752eac68eec426153d8b82ab5fc))

## [7.7.0](https://github.com/vm0-ai/vm0/compare/core-v7.6.1...core-v7.7.0) (2026-02-02)


### Features

* **schedule:** retry scheduled runs on concurrency limit ([#2008](https://github.com/vm0-ai/vm0/issues/2008)) ([0f86346](https://github.com/vm0-ai/vm0/commit/0f8634676633bd9f1f6ab061b122cd5e1e39a065))

## [7.6.1](https://github.com/vm0-ai/vm0/compare/core-v7.6.0...core-v7.6.1) (2026-02-01)


### Bug Fixes

* **runner:** ensure proper cleanup and metrics collection ([#2088](https://github.com/vm0-ai/vm0/issues/2088)) ([a2c825e](https://github.com/vm0-ai/vm0/commit/a2c825e2bf76e4226c4428778617d5bd54a1936f))

## [7.6.0](https://github.com/vm0-ai/vm0/compare/core-v7.5.0...core-v7.6.0) (2026-02-01)


### Features

* **cli:** release onboard banner update ([#2084](https://github.com/vm0-ai/vm0/issues/2084)) ([402820c](https://github.com/vm0-ai/vm0/commit/402820cbeabed134c3a757d4c8400037fce4c427))

## [7.5.0](https://github.com/vm0-ai/vm0/compare/core-v7.4.2...core-v7.5.0) (2026-01-31)


### Features

* enable observation logs and redirect logged-in users to platform ([#2027](https://github.com/vm0-ai/vm0/issues/2027)) ([eb51f47](https://github.com/vm0-ai/vm0/commit/eb51f47cfea75abaf1aee0a0a288bf1497675a15))

## [7.4.2](https://github.com/vm0-ai/vm0/compare/core-v7.4.1...core-v7.4.2) (2026-01-31)


### Performance Improvements

* **runner:** remove preflight check and fail fast on first heartbeat ([#1976](https://github.com/vm0-ai/vm0/issues/1976)) ([1bb881a](https://github.com/vm0-ai/vm0/commit/1bb881a4a4b77eaa740cc98cd545bfc722bd1fac))

## [7.4.1](https://github.com/vm0-ai/vm0/compare/core-v7.4.0...core-v7.4.1) (2026-01-30)


### Bug Fixes

* **contracts:** use c.nobody() for 204 responses ([#1910](https://github.com/vm0-ai/vm0/issues/1910)) ([9ba5354](https://github.com/vm0-ai/vm0/commit/9ba5354aa76182540a398ced5e5e968d6c9878e2)), closes [#1902](https://github.com/vm0-ai/vm0/issues/1902)

## [7.4.0](https://github.com/vm0-ai/vm0/compare/core-v7.3.0...core-v7.4.0) (2026-01-29)


### Features

* add E2E timing metrics from API to agent start ([#1830](https://github.com/vm0-ai/vm0/issues/1830)) ([4884e14](https://github.com/vm0-ai/vm0/commit/4884e143b81334f06d3863ad70ba7885c2ba8a5f))
* **cli:** add `vm0 run list` and `vm0 run kill` commands ([#1826](https://github.com/vm0-ai/vm0/issues/1826)) ([7b42a47](https://github.com/vm0-ai/vm0/commit/7b42a47bba2da1bfe5ac59c9ce01b242e9c8524f))

## [7.3.0](https://github.com/vm0-ai/vm0/compare/core-v7.2.0...core-v7.3.0) (2026-01-28)


### Features

* **runner:** add Ably realtime job notifications with polling fallback ([#1783](https://github.com/vm0-ai/vm0/issues/1783)) ([eef9cfc](https://github.com/vm0-ai/vm0/commit/eef9cfc1ce959d708043b5355a42160c306c8de4))

## [7.2.0](https://github.com/vm0-ai/vm0/compare/core-v7.1.0...core-v7.2.0) (2026-01-28)


### Features

* **web:** add per-user concurrent run limit ([#1749](https://github.com/vm0-ai/vm0/issues/1749)) ([a0277ff](https://github.com/vm0-ai/vm0/commit/a0277ffda3efe2aed0e1e32a7313f14d8b89dcd0))


### Bug Fixes

* **api:** remove unimplemented filters and fix docs gaps ([#1775](https://github.com/vm0-ai/vm0/issues/1775)) ([ca4a728](https://github.com/vm0-ai/vm0/commit/ca4a72839895235e0b873374909fc4a8de80607a))

## [7.1.0](https://github.com/vm0-ai/vm0/compare/core-v7.0.0...core-v7.1.0) (2026-01-28)


### Features

* **platform:** add log detail page with agent events and artifact download ([#1738](https://github.com/vm0-ai/vm0/issues/1738)) ([ef8b01d](https://github.com/vm0-ai/vm0/commit/ef8b01d3ef809ed8c6c3e2ce2061b4f65c0fc69e))
* **platform:** improve logs page ui styling and layout ([#1759](https://github.com/vm0-ai/vm0/issues/1759)) ([e0f7568](https://github.com/vm0-ai/vm0/commit/e0f7568fa001e44c41d7191b370ddea4f3aceb0b))


### Bug Fixes

* **platform:** correct artifact extraction and rename provider to framework ([#1745](https://github.com/vm0-ai/vm0/issues/1745)) ([f53f75a](https://github.com/vm0-ai/vm0/commit/f53f75a81a920fcf4eca12c84e098b7432287161))

## [7.0.0](https://github.com/vm0-ai/vm0/compare/core-v6.3.0...core-v7.0.0) (2026-01-27)


### ⚠ BREAKING CHANGES

* **api:** All Public API v1 endpoints now use camelCase field names instead of snake_case. This affects request bodies, response bodies, and query parameters.

### Code Refactoring

* **api:** migrate public API v1 from snake_case to camelCase ([#1730](https://github.com/vm0-ai/vm0/issues/1730)) ([5dfcc28](https://github.com/vm0-ai/vm0/commit/5dfcc28597991f408a33bbd565b6619f47d6b92c))

## [6.3.0](https://github.com/vm0-ai/vm0/compare/core-v6.2.0...core-v6.3.0) (2026-01-27)


### Features

* **api:** add platform logs API endpoints ([#1717](https://github.com/vm0-ai/vm0/issues/1717)) ([9c87393](https://github.com/vm0-ai/vm0/commit/9c873936dec218536a1ffa810eb2d9fd7032d373))

## [6.2.0](https://github.com/vm0-ai/vm0/compare/core-v6.1.0...core-v6.2.0) (2026-01-27)


### Features

* **docs:** trigger release for documentation updates ([#1697](https://github.com/vm0-ai/vm0/issues/1697)) ([c078287](https://github.com/vm0-ai/vm0/commit/c078287de06336abd3157fcaa056bdedcb47838d))

## [6.1.0](https://github.com/vm0-ai/vm0/compare/core-v6.0.1...core-v6.1.0) (2026-01-26)


### Features

* **platform:** redesign homepage and add settings page ([#1639](https://github.com/vm0-ai/vm0/issues/1639)) ([b0515d5](https://github.com/vm0-ai/vm0/commit/b0515d5e75149dd92a11f14f6b80c6661f76afa5))

## [6.0.1](https://github.com/vm0-ai/vm0/compare/core-v6.0.0...core-v6.0.1) (2026-01-24)


### Bug Fixes

* **ci:** add production environment to release workflow jobs ([#1612](https://github.com/vm0-ai/vm0/issues/1612)) ([96912b0](https://github.com/vm0-ai/vm0/commit/96912b0329960f4404087418323266c0c711d599))

## [6.0.0](https://github.com/vm0-ai/vm0/compare/core-v5.5.0...core-v6.0.0) (2026-01-24)


### ⚠ BREAKING CHANGES

* The experimental_secrets and experimental_vars fields have been removed from the agent compose schema. Users must migrate to the environment syntax with ${{ secrets.X }} and ${{ vars.X }} patterns.

### Features

* **cli:** rename experimental-credential to credential ([#1582](https://github.com/vm0-ai/vm0/issues/1582)) ([499e605](https://github.com/vm0-ai/vm0/commit/499e605c046f7f048c96f3ca6d8b257189aca40c))


### Miscellaneous Chores

* remove experimental_secrets/vars syntax sugar ([#1588](https://github.com/vm0-ai/vm0/issues/1588)) ([7960555](https://github.com/vm0-ai/vm0/commit/79605555ec153c21a689d0b15e61ab40e05ad073))

## [5.5.0](https://github.com/vm0-ai/vm0/compare/core-v5.4.0...core-v5.5.0) (2026-01-23)


### Features

* **platform:** add onboarding ui and model providers signal ([#1575](https://github.com/vm0-ai/vm0/issues/1575)) ([4e2c017](https://github.com/vm0-ai/vm0/commit/4e2c0173a258779e971dc4b7834746f0be63e1c5))


### Bug Fixes

* unify terminology from llm to model provider ([#1580](https://github.com/vm0-ai/vm0/issues/1580)) ([dfe6a2c](https://github.com/vm0-ai/vm0/commit/dfe6a2c99f9b8a0de02cb3afc902ae2eb57cefd3))

## [5.4.0](https://github.com/vm0-ai/vm0/compare/core-v5.3.1...core-v5.4.0) (2026-01-23)


### Features

* **cli:** add help text for credential acquisition in model-provider setup ([#1562](https://github.com/vm0-ai/vm0/issues/1562)) ([3230f08](https://github.com/vm0-ai/vm0/commit/3230f0872227319519e473ecc53b053d4673f03a)), closes [#1558](https://github.com/vm0-ai/vm0/issues/1558)
* **cli:** improve vm0 init onboarding with model-provider setup ([#1571](https://github.com/vm0-ai/vm0/issues/1571)) ([e4e4c23](https://github.com/vm0-ai/vm0/commit/e4e4c23c7d5681965f573e1795b360b5cc3d07b1))
* **platform:** add feature switches for sidebar navigation sections ([#1556](https://github.com/vm0-ai/vm0/issues/1556)) ([993375f](https://github.com/vm0-ai/vm0/commit/993375f342b4f11d6e8b050ac9c8b6dfdc27c410))

## [5.3.1](https://github.com/vm0-ai/vm0/compare/core-v5.3.0...core-v5.3.1) (2026-01-23)


### Bug Fixes

* **web:** cors, auth token identification, and scope error responses ([#1506](https://github.com/vm0-ai/vm0/issues/1506)) ([b14ec55](https://github.com/vm0-ai/vm0/commit/b14ec559743c9538af5f6294d6581fbaff15a434))

## [5.3.0](https://github.com/vm0-ai/vm0/compare/core-v5.2.0...core-v5.3.0) (2026-01-22)


### Features

* add cyclomatic complexity checking to eslint ([#1502](https://github.com/vm0-ai/vm0/issues/1502)) ([d3b2859](https://github.com/vm0-ai/vm0/commit/d3b2859ca7374964c78fc5a4f0a76566c01551e3))

## [5.2.0](https://github.com/vm0-ai/vm0/compare/core-v5.1.0...core-v5.2.0) (2026-01-22)


### Features

* **run:** integrate model provider with vm0 run command ([#1472](https://github.com/vm0-ai/vm0/issues/1472)) ([74c0a4c](https://github.com/vm0-ai/vm0/commit/74c0a4cfbc10683359065249dfbd9b8e282c2b84))

## [5.1.0](https://github.com/vm0-ai/vm0/compare/core-v5.0.0...core-v5.1.0) (2026-01-21)


### Features

* add model provider entity and CLI commands ([#1452](https://github.com/vm0-ai/vm0/issues/1452)) ([86900d2](https://github.com/vm0-ai/vm0/commit/86900d2aa26420e1b940c039a87755c3feda531b))

## [5.0.0](https://github.com/vm0-ai/vm0/compare/core-v4.9.0...core-v5.0.0) (2026-01-21)


### ⚠ BREAKING CHANGES

* The `provider` field in vm0.yaml has been renamed to `framework`. Users must update their vm0.yaml files to use `framework` instead of `provider`.

### Features

* rename provider to framework in vm0.yaml configuration ([#1430](https://github.com/vm0-ai/vm0/issues/1430)) ([e2a242e](https://github.com/vm0-ai/vm0/commit/e2a242ef2b9c337b29dc992524abf6ebf2181804))

## [4.9.0](https://github.com/vm0-ai/vm0/compare/core-v4.8.0...core-v4.9.0) (2026-01-21)


### Features

* **cli:** add experimental realtime event streaming with ably ([#1383](https://github.com/vm0-ai/vm0/issues/1383)) ([a37b177](https://github.com/vm0-ai/vm0/commit/a37b1776819c9c1653f214a513c206032e37af01))

## [4.8.0](https://github.com/vm0-ai/vm0/compare/core-v4.7.0...core-v4.8.0) (2026-01-20)


### Features

* **credentials:** add persistent credential management for third-party services ([#1303](https://github.com/vm0-ai/vm0/issues/1303)) ([ceff78a](https://github.com/vm0-ai/vm0/commit/ceff78a8285454f69ee3c25190c305795c6b327f))

## [4.7.0](https://github.com/vm0-ai/vm0/compare/core-v4.6.1...core-v4.7.0) (2026-01-20)


### Features

* add --debug-no-mock-claude flag for real Claude E2E tests ([#1324](https://github.com/vm0-ai/vm0/issues/1324)) ([f75cdb5](https://github.com/vm0-ai/vm0/commit/f75cdb5cc5f27b5979f4d8f882af5fdfdce9c07c))

## [4.6.1](https://github.com/vm0-ai/vm0/compare/core-v4.6.0...core-v4.6.1) (2026-01-19)


### Bug Fixes

* **sandbox:** use ignore for stdin to prevent claude code hang ([#1316](https://github.com/vm0-ai/vm0/issues/1316)) ([5e4a279](https://github.com/vm0-ai/vm0/commit/5e4a2790a79459a05da4430f8222f0fa23fd502c))

## [4.6.0](https://github.com/vm0-ai/vm0/compare/core-v4.5.0...core-v4.6.0) (2026-01-14)


### Features

* **schedule:** add api endpoint to view schedule run history ([#1204](https://github.com/vm0-ai/vm0/issues/1204)) ([c53f1a6](https://github.com/vm0-ai/vm0/commit/c53f1a664ecbf460727217364f62089eff1cc408))

## [4.5.0](https://github.com/vm0-ai/vm0/compare/core-v4.4.0...core-v4.5.0) (2026-01-14)


### Features

* **metrics:** add sandbox internal metrics for operation timing ([#1202](https://github.com/vm0-ai/vm0/issues/1202)) ([7134662](https://github.com/vm0-ai/vm0/commit/7134662d5351ef8debc795e9a1c1e61a86a7df4c)), closes [#1174](https://github.com/vm0-ai/vm0/issues/1174)

## [4.4.0](https://github.com/vm0-ai/vm0/compare/core-v4.3.0...core-v4.4.0) (2026-01-14)


### Features

* **schedule:** add vm0 schedule command for automated agent runs ([#1105](https://github.com/vm0-ai/vm0/issues/1105)) ([ecdc2c5](https://github.com/vm0-ai/vm0/commit/ecdc2c5c01ea1340aefdc8ea20407fce1c264a34))

## [4.3.0](https://github.com/vm0-ai/vm0/compare/core-v4.2.1...core-v4.3.0) (2026-01-13)


### Features

* **runner:** add benchmark command for VM performance testing ([#1171](https://github.com/vm0-ai/vm0/issues/1171)) ([b7ab24f](https://github.com/vm0-ai/vm0/commit/b7ab24f1fa24bef883e662f1610fa69c5ee9d838))


### Bug Fixes

* **cli:** quote version parameter to prevent scientific notation parsing ([#1155](https://github.com/vm0-ai/vm0/issues/1155)) ([792dbc1](https://github.com/vm0-ai/vm0/commit/792dbc15714fe788d9ae519dd7be0e8061046506))
* **docs:** trigger production deployment for cli reference updates ([#1173](https://github.com/vm0-ai/vm0/issues/1173)) ([57baf42](https://github.com/vm0-ai/vm0/commit/57baf42d83a19652c9db2881e48f50fd1a0054e6))

## [4.2.1](https://github.com/vm0-ai/vm0/compare/core-v4.2.0...core-v4.2.1) (2026-01-13)


### Bug Fixes

* **docs:** trigger production deployment for quick start updates ([#1142](https://github.com/vm0-ai/vm0/issues/1142)) ([f8fb029](https://github.com/vm0-ai/vm0/commit/f8fb029227bfc5151a5af30154a0cfb4bc28b480)), closes [#1118](https://github.com/vm0-ai/vm0/issues/1118)

## [4.2.0](https://github.com/vm0-ai/vm0/compare/core-v4.1.1...core-v4.2.0) (2026-01-12)


### Features

* **lifecycle:** add postCreateCommand hook and hardcode working_dir ([#1077](https://github.com/vm0-ai/vm0/issues/1077)) ([86f7077](https://github.com/vm0-ai/vm0/commit/86f70777701d2d8715edec620e804c9ceeea0bad))

## [4.1.1](https://github.com/vm0-ai/vm0/compare/core-v4.1.0...core-v4.1.1) (2026-01-11)


### Bug Fixes

* **runner:** support SNI-only mode network logs in experimental_firewall ([#1088](https://github.com/vm0-ai/vm0/issues/1088)) ([c8308ef](https://github.com/vm0-ai/vm0/commit/c8308ef3490b03069b2a65253ab2209c9ba30eac)), closes [#1063](https://github.com/vm0-ai/vm0/issues/1063)

## [4.1.0](https://github.com/vm0-ai/vm0/compare/core-v4.0.0...core-v4.1.0) (2026-01-10)


### Features

* remove v1 API create and delete endpoints for agents, volumes, artifacts ([#1062](https://github.com/vm0-ai/vm0/issues/1062)) ([b54697f](https://github.com/vm0-ai/vm0/commit/b54697fdfbee82e28de43d74bc2ac63403ea9ebe))

## [4.0.0](https://github.com/vm0-ai/vm0/compare/core-v3.4.0...core-v4.0.0) (2026-01-10)


### ⚠ BREAKING CHANGES

* experimental_network_security field removed from agent compose schema

### Code Refactoring

* remove deprecated experimental_network_security feature ([#1057](https://github.com/vm0-ai/vm0/issues/1057)) ([457864b](https://github.com/vm0-ai/vm0/commit/457864bcea4665b302f9f0df265233aa3f9270d5))

## [3.4.0](https://github.com/vm0-ai/vm0/compare/core-v3.3.0...core-v3.4.0) (2026-01-10)


### Features

* **api:** add name query parameter to GET /v1/agents ([#1044](https://github.com/vm0-ai/vm0/issues/1044)) ([8339227](https://github.com/vm0-ai/vm0/commit/83392274a34deb966d71dea8d2aaf0f3bb05671b)), closes [#1043](https://github.com/vm0-ai/vm0/issues/1043)
* **runner:** add experimental_firewall configuration with domain/IP rules ([#1027](https://github.com/vm0-ai/vm0/issues/1027)) ([18be77e](https://github.com/vm0-ai/vm0/commit/18be77e69f437e1f4cc536f7caf438bdf3321948))

## [3.3.0](https://github.com/vm0-ai/vm0/compare/core-v3.2.0...core-v3.3.0) (2026-01-09)


### Features

* **cli:** add vm0 agents list and inspect commands ([#1003](https://github.com/vm0-ai/vm0/issues/1003)) ([a214d3b](https://github.com/vm0-ai/vm0/commit/a214d3b08e5cb78d27033dc6b5e23601993472bc))
* **public-api:** add tokens api for self-service token management ([#1019](https://github.com/vm0-ai/vm0/issues/1019)) ([63c2195](https://github.com/vm0-ai/vm0/commit/63c21958b94d8ba9cda78fa355e8f82cbeac2075))
* **web:** add public api v1 foundation and infrastructure ([#997](https://github.com/vm0-ai/vm0/issues/997)) ([#1004](https://github.com/vm0-ai/vm0/issues/1004)) ([3a8dd44](https://github.com/vm0-ai/vm0/commit/3a8dd4400493a833f676441c0ebfef838cb18096))

## [3.2.0](https://github.com/vm0-ai/vm0/compare/core-v3.1.1...core-v3.2.0) (2026-01-09)


### Features

* **runner:** move network security proxy to runner host level ([#964](https://github.com/vm0-ai/vm0/issues/964)) ([6a77a51](https://github.com/vm0-ai/vm0/commit/6a77a51f8bec551b3ff8dec278456a2a53cd3aac))

## [3.1.1](https://github.com/vm0-ai/vm0/compare/core-v3.1.0...core-v3.1.1) (2026-01-09)


### Bug Fixes

* **docs:** trigger release for documentation updates ([#993](https://github.com/vm0-ai/vm0/issues/993)) ([1f3e2be](https://github.com/vm0-ai/vm0/commit/1f3e2be18c74219b2954c0d98a6456bf35b055ca))

## [3.1.0](https://github.com/vm0-ai/vm0/compare/core-v3.0.2...core-v3.1.0) (2026-01-08)


### Features

* replace custom image building with apps-based image selection ([#963](https://github.com/vm0-ai/vm0/issues/963)) ([231f9b0](https://github.com/vm0-ai/vm0/commit/231f9b0890b07baaa618be58a7da14cc52b0ec7d))

## [3.0.2](https://github.com/vm0-ai/vm0/compare/core-v3.0.1...core-v3.0.2) (2026-01-06)


### Bug Fixes

* handle jsonQuery parsing hex version IDs as numbers ([#926](https://github.com/vm0-ai/vm0/issues/926)) ([b8cd4f8](https://github.com/vm0-ai/vm0/commit/b8cd4f8480f8ae103559c2ffd5f48cce2581c315))

## [3.0.1](https://github.com/vm0-ai/vm0/compare/core-v3.0.0...core-v3.0.1) (2026-01-05)


### Bug Fixes

* **runner:** use config server url instead of claim response ([#921](https://github.com/vm0-ai/vm0/issues/921)) ([f7b2b54](https://github.com/vm0-ai/vm0/commit/f7b2b54e61e2dafed797be155c5ed8200f5789eb))

## [3.0.0](https://github.com/vm0-ai/vm0/compare/core-v2.6.0...core-v3.0.0) (2026-01-05)


### ⚠ BREAKING CHANGES

* **runner:** stub_mode config option removed

### Features

* **runner:** implement @vm0/runner MVP with firecracker execution ([#851](https://github.com/vm0-ai/vm0/issues/851)) ([d2437a2](https://github.com/vm0-ai/vm0/commit/d2437a2cdc7b9df240b26b5cbcb00bf17334b509))

## [2.6.0](https://github.com/vm0-ai/vm0/compare/core-v2.5.0...core-v2.6.0) (2026-01-04)


### Features

* **docs:** trigger release for product philosophy page ([#884](https://github.com/vm0-ai/vm0/issues/884)) ([45ec3a2](https://github.com/vm0-ai/vm0/commit/45ec3a296b4d4ac01b4ac1f0536692d1626c7551))

## [2.5.0](https://github.com/vm0-ai/vm0/compare/core-v2.4.0...core-v2.5.0) (2025-12-31)


### Features

* load secrets from env vars for run continue/resume ([#846](https://github.com/vm0-ai/vm0/issues/846)) ([2d8ae98](https://github.com/vm0-ai/vm0/commit/2d8ae9837463d44846326bd5eca925026ccc3c4c))

## [2.4.0](https://github.com/vm0-ai/vm0/compare/core-v2.3.0...core-v2.4.0) (2025-12-30)


### Features

* **cli:** add artifact/volume list and clone commands with interactive prompts ([#800](https://github.com/vm0-ai/vm0/issues/800)) ([3a95d22](https://github.com/vm0-ai/vm0/commit/3a95d224fb9f38de92db5fd97e75c6968d7daed5))

## [2.3.0](https://github.com/vm0-ai/vm0/compare/core-v2.2.0...core-v2.3.0) (2025-12-30)


### Features

* **cli:** replace --limit with --tail and --head flags for logs command ([#797](https://github.com/vm0-ai/vm0/issues/797)) ([bc5aa0e](https://github.com/vm0-ai/vm0/commit/bc5aa0ebdb3e5d8195a76197ed79df099610a257))

## [2.2.0](https://github.com/vm0-ai/vm0/compare/core-v2.1.0...core-v2.2.0) (2025-12-29)


### Features

* **core:** add ts-rest contracts for storage direct upload endpoints ([#779](https://github.com/vm0-ai/vm0/issues/779)) ([18b7e89](https://github.com/vm0-ai/vm0/commit/18b7e89008a852d6cd5ba8dda363b8878256792b))

## [2.1.0](https://github.com/vm0-ai/vm0/compare/core-v2.0.0...core-v2.1.0) (2025-12-26)


### Features

* add scope support to agent compose ([#764](https://github.com/vm0-ai/vm0/issues/764)) ([79e8103](https://github.com/vm0-ai/vm0/commit/79e8103327dde0db6562d13dcaab0c36bb070ee6))

## [2.0.0](https://github.com/vm0-ai/vm0/compare/core-v1.5.0...core-v2.0.0) (2025-12-26)


### ⚠ BREAKING CHANGES

* Users must update their agent.yaml files to use experimental_network_security instead of beta_network_security.

### Code Refactoring

* rename beta_network_security to experimental_network_security ([#760](https://github.com/vm0-ai/vm0/issues/760)) ([c1cd01a](https://github.com/vm0-ai/vm0/commit/c1cd01a8160858214304168ffdc0b784cc272a02))

## [1.5.0](https://github.com/vm0-ai/vm0/compare/core-v1.4.0...core-v1.5.0) (2025-12-25)


### Features

* remove unused sessions API and migrate session history to R2 ([#718](https://github.com/vm0-ai/vm0/issues/718)) ([a5cd85d](https://github.com/vm0-ai/vm0/commit/a5cd85d2f9f2c513ab88f90359dd21414a36e24b))

## [1.4.0](https://github.com/vm0-ai/vm0/compare/core-v1.3.1...core-v1.4.0) (2025-12-25)


### Features

* migrate agent run events to axiom ([#715](https://github.com/vm0-ai/vm0/issues/715)) ([4a68278](https://github.com/vm0-ai/vm0/commit/4a68278ff7dd5bd94915a873f8e69efdd42e3c7f))

## [1.3.1](https://github.com/vm0-ai/vm0/compare/core-v1.3.0...core-v1.3.1) (2025-12-23)


### Bug Fixes

* return provider in events APIs for correct rendering ([#697](https://github.com/vm0-ai/vm0/issues/697)) ([c72c9d7](https://github.com/vm0-ai/vm0/commit/c72c9d7d90792ffffde7f92737dfdbe022052a99))

## [1.3.0](https://github.com/vm0-ai/vm0/compare/core-v1.2.0...core-v1.3.0) (2025-12-23)


### Features

* add codex support alongside claude code ([#637](https://github.com/vm0-ai/vm0/issues/637)) ([db42ad7](https://github.com/vm0-ai/vm0/commit/db42ad79db60a026e97257c4c752fcec35afbbd8))

## [1.2.0](https://github.com/vm0-ai/vm0/compare/core-v1.1.0...core-v1.2.0) (2025-12-23)


### Features

* **cli:** promote beta features to stable and add image auto-config ([#689](https://github.com/vm0-ai/vm0/issues/689)) ([76161b2](https://github.com/vm0-ai/vm0/commit/76161b2d6a982fafc9eb6fdf731d9b485f263b21))

## [1.1.0](https://github.com/vm0-ai/vm0/compare/core-v1.0.0...core-v1.1.0) (2025-12-22)


### Features

* **image:** enforce lowercase image names for Docker compatibility ([#662](https://github.com/vm0-ai/vm0/issues/662)) ([7a6f5ff](https://github.com/vm0-ai/vm0/commit/7a6f5fffb0d517d853e2bd272534a868b0875837))

## [1.0.0](https://github.com/vm0-ai/vm0/compare/core-v0.8.0...core-v1.0.0) (2025-12-22)


### ⚠ BREAKING CHANGES

* Users must update volume mounts from /home/user/.config/claude to /home/user/.claude in their vm0.yaml files.

### Features

* **image:** support @vm0/claude-code format for system images ([#655](https://github.com/vm0-ai/vm0/issues/655)) ([1ddd99f](https://github.com/vm0-ai/vm0/commit/1ddd99fa1b640956244dfd463e6eda6a942e8416))


### Code Refactoring

* remove CLAUDE_CONFIG_DIR override and use ~/.claude default ([#656](https://github.com/vm0-ai/vm0/issues/656)) ([bb009a0](https://github.com/vm0-ai/vm0/commit/bb009a0edbda1a8064a396991ee51f3ea9f38a1f))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/core-v0.7.0...core-v0.8.0) (2025-12-21)


### Features

* **image:** add versioning support with tag syntax ([#643](https://github.com/vm0-ai/vm0/issues/643)) ([761ce57](https://github.com/vm0-ai/vm0/commit/761ce5791aca56e96739db7513fd4e5a83065717))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/core-v0.6.0...core-v0.7.0) (2025-12-20)


### Features

* add scope/namespace system for resource isolation ([#636](https://github.com/vm0-ai/vm0/issues/636)) ([1369059](https://github.com/vm0-ai/vm0/commit/1369059e3e3d7a82aca3f00e59dd2f2814dab0e4))
* **cli:** make --artifact-name optional for vm0 run command ([#640](https://github.com/vm0-ai/vm0/issues/640)) ([6895cfe](https://github.com/vm0-ai/vm0/commit/6895cfe6411b48b23b49d9c5a500fdd0aa746fd0))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/core-v0.5.1...core-v0.6.0) (2025-12-17)


### Features

* **cli:** add beta_system_prompt and beta_system_skills support for agent compose ([#565](https://github.com/vm0-ai/vm0/issues/565)) ([b6388d9](https://github.com/vm0-ai/vm0/commit/b6388d9b9511bf7a6407dc2d17a6a81f85e8d3eb))

## [0.5.1](https://github.com/vm0-ai/vm0/compare/core-v0.5.0...core-v0.5.1) (2025-12-13)


### Bug Fixes

* **cli:** revert system_prompt and system_skills feature ([#540](https://github.com/vm0-ai/vm0/issues/540)) ([b2254fe](https://github.com/vm0-ai/vm0/commit/b2254fec128a641106aa1db67faac938e39e3b3b))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/core-v0.4.0...core-v0.5.0) (2025-12-12)


### Features

* **cli:** add --secrets parameter for passing secrets via CLI ([#512](https://github.com/vm0-ai/vm0/issues/512)) ([7972bf4](https://github.com/vm0-ai/vm0/commit/7972bf4f82f76112f99ebf8068c133e953a4ae20))
* **cli:** add system_prompt and system_skills support for agent compose ([#513](https://github.com/vm0-ai/vm0/issues/513)) ([5079a4a](https://github.com/vm0-ai/vm0/commit/5079a4a9d7a41617e53b22c7ea9e666cf4838f08))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/core-v0.3.0...core-v0.4.0) (2025-12-12)


### Features

* **web:** add generic proxy endpoint for sandbox requests ([#503](https://github.com/vm0-ai/vm0/issues/503)) ([36eda65](https://github.com/vm0-ai/vm0/commit/36eda650e853a62e2269380a777e305505e50702))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/core-v0.2.0...core-v0.3.0) (2025-12-10)


### Features

* **api:** add storages contract and standardize error responses ([#465](https://github.com/vm0-ai/vm0/issues/465)) ([8fa72f4](https://github.com/vm0-ai/vm0/commit/8fa72f461adf28f5f1a5c8e285e02b2416b475bf))
* **api:** complete ts-rest migration for images and cron routes ([#474](https://github.com/vm0-ai/vm0/issues/474)) ([fdf8657](https://github.com/vm0-ai/vm0/commit/fdf86578bd70bb850058ac1eceac3f900e1a8d51))
* **api:** migrate /api/agent/composes routes to ts-rest contract-first architecture ([#458](https://github.com/vm0-ai/vm0/issues/458)) ([4a066d2](https://github.com/vm0-ai/vm0/commit/4a066d2489c4e05ecb4626d0c03694bd683299d9))
* **api:** migrate /api/agent/runs to ts-rest contract-first architecture ([#463](https://github.com/vm0-ai/vm0/issues/463)) ([2f160ec](https://github.com/vm0-ai/vm0/commit/2f160ecbdae67f2a7d8346c6ee393a9dfd0e2e79))
* **api:** migrate /api/agent/sessions to ts-rest contract-first architecture ([#464](https://github.com/vm0-ai/vm0/issues/464)) ([03f32cb](https://github.com/vm0-ai/vm0/commit/03f32cbe506b009d452bfc2b3595c793265b64fb))
* **api:** migrate /api/secrets to ts-rest contract-first architecture ([#453](https://github.com/vm0-ai/vm0/issues/453)) ([27fd2fa](https://github.com/vm0-ai/vm0/commit/27fd2fa1cf0f5c7b3b6b227c547d59d56f13b9de))
* **api:** migrate webhooks and auth routes to ts-rest contracts ([#468](https://github.com/vm0-ai/vm0/issues/468)) ([08c38aa](https://github.com/vm0-ai/vm0/commit/08c38aa399bc776d6ef391ae5bfdd7da1d5d5b7c))
* **observability:** implement sandbox telemetry collection and storage ([#466](https://github.com/vm0-ai/vm0/issues/466)) ([8fe6748](https://github.com/vm0-ai/vm0/commit/8fe674887d84fba9f35838e7ebbdb288967feae4))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/core-v0.1.0...core-v0.2.0) (2025-12-03)


### Features

* add unified environment variable syntax ([#362](https://github.com/vm0-ai/vm0/issues/362)) ([e218dd7](https://github.com/vm0-ai/vm0/commit/e218dd76ddd4b7e6508725570b0cd7ee7d769f56))

## [0.1.0](https://github.com/vm0-ai/vm0/compare/core-v0.0.1...core-v0.1.0) (2025-11-15)


### Features

* initial project setup from makita template ([e9c330a](https://github.com/vm0-ai/vm0/commit/e9c330a5952526d657f245e8db9522de553018b3))

## [0.1.0](https://github.com/e7h4n/vm0/compare/core-v0.0.1...core-v0.1.0) (2025-08-30)


### Features

* implement centralized API contract system ([#13](https://github.com/e7h4n/vm0/issues/13)) ([77bbbd9](https://github.com/e7h4n/vm0/commit/77bbbd913b52341a7720e9bb711d889253d9681a))
* initial commit - app template with turborepo monorepo structure ([4123914](https://github.com/e7h4n/vm0/commit/41239143cdaea284f55a02c89fde348c2e3b53ff))

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
