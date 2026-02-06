# Changelog

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
