# Changelog

## [1.351.0](https://github.com/vm0-ai/vm0/compare/api-v1.350.0...api-v1.351.0) (2026-07-30)


### Features

* **connectors:** add agent-driven custom connector creation ([#24020](https://github.com/vm0-ai/vm0/issues/24020)) ([49a30be](https://github.com/vm0-ai/vm0/commit/49a30bed8aa3295f875ea56ad81edcd473a49fce))


### Bug Fixes

* **api:** reject redirected axiom ingestion ([#24022](https://github.com/vm0-ai/vm0/issues/24022)) ([ac5e94f](https://github.com/vm0-ai/vm0/commit/ac5e94f18ea92e51732567faacb77dc018931d4f))


### Refactoring

* **test-api:** use slug fields in connector auth fixtures ([#24024](https://github.com/vm0-ai/vm0/issues/24024)) ([c655087](https://github.com/vm0-ai/vm0/commit/c65508731a6db6648f28253d1657aff63822e3d9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.251.0
    * @vm0/core bumped to 8.490.0
    * @vm0/db bumped to 1.156.3

## [1.350.0](https://github.com/vm0-ai/vm0/compare/api-v1.349.1...api-v1.350.0) (2026-07-30)


### Features

* **platform:** enable locale rollout and browser detection ([#23983](https://github.com/vm0-ai/vm0/issues/23983)) ([9b689ad](https://github.com/vm0-ai/vm0/commit/9b689ad900016b7a04f930a57ae20f9702fdff69))


### Refactoring

* **api:** move runner run creation to test route ([#24013](https://github.com/vm0-ai/vm0/issues/24013)) ([6114c5e](https://github.com/vm0-ai/vm0/commit/6114c5e93b9b28e11bd8c1d3a78bebea32739732))
* **insights:** migrate connector identity to slug ([#23952](https://github.com/vm0-ai/vm0/issues/23952)) ([596d96d](https://github.com/vm0-ai/vm0/commit/596d96d3d5972f9753c20ba3cdaff4e4506a0969))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.250.2
    * @vm0/core bumped to 8.489.0
    * @vm0/db bumped to 1.156.2

## [1.349.1](https://github.com/vm0-ai/vm0/compare/api-v1.349.0...api-v1.349.1) (2026-07-30)


### Bug Fixes

* **runner:** reconcile terminal network policy refreshes ([#23975](https://github.com/vm0-ai/vm0/issues/23975)) ([5c57871](https://github.com/vm0-ai/vm0/commit/5c5787153a35882762ef786b734555a85243739d))


### Refactoring

* **github:** retire github_issue_sessions runtime access ([#24008](https://github.com/vm0-ai/vm0/issues/24008)) ([8197440](https://github.com/vm0-ai/vm0/commit/8197440a926037bc9fba832b1ce14e64647952db))
* retire draft content storage ([#23940](https://github.com/vm0-ai/vm0/issues/23940)) ([baa4589](https://github.com/vm0-ai/vm0/commit/baa45899ef04ae8607ea6d5552632c95940ea259))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.250.1
    * @vm0/core bumped to 8.488.3
    * @vm0/db bumped to 1.156.1

## [1.349.0](https://github.com/vm0-ai/vm0/compare/api-v1.348.1...api-v1.349.0) (2026-07-30)


### Features

* **chat:** render composer agent mentions as structured agent parts ([#23943](https://github.com/vm0-ai/vm0/issues/23943)) ([ae861b8](https://github.com/vm0-ai/vm0/commit/ae861b86e7873f6d8811f00c877af6e0483f888c))
* **github:** route issue and pr chats through canonical threads ([#23953](https://github.com/vm0-ai/vm0/issues/23953)) ([1aac828](https://github.com/vm0-ai/vm0/commit/1aac828435bd7da57eabd2b25db098e78b3b5411))


### Refactoring

* **agentphone:** remove legacy thread session access ([#23970](https://github.com/vm0-ai/vm0/issues/23970)) ([331ab52](https://github.com/vm0-ai/vm0/commit/331ab5292d6e95f13831750f75ae1ad10ed808d5))
* **chat:** stop backward history paging at seq id one ([#23966](https://github.com/vm0-ai/vm0/issues/23966)) ([5d48c32](https://github.com/vm0-ai/vm0/commit/5d48c32163d609e48b8ec156547cf219bf283bdf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.250.0
    * @vm0/core bumped to 8.488.2
    * @vm0/db bumped to 1.156.0

## [1.348.1](https://github.com/vm0-ai/vm0/compare/api-v1.348.0...api-v1.348.1) (2026-07-30)


### Bug Fixes

* title ingress chat threads when their run is created ([#23947](https://github.com/vm0-ai/vm0/issues/23947)) ([93860c8](https://github.com/vm0-ai/vm0/commit/93860c8f4439f374b048128236ba1a6da343dd57))


### Refactoring

* drop legacy chat event transport columns ([#23931](https://github.com/vm0-ai/vm0/issues/23931)) ([09cf8b2](https://github.com/vm0-ai/vm0/commit/09cf8b215260e801d331356fefc66cfea81bbb3f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.249.2
    * @vm0/core bumped to 8.488.1
    * @vm0/db bumped to 1.155.1

## [1.348.0](https://github.com/vm0-ai/vm0/compare/api-v1.347.0...api-v1.348.0) (2026-07-30)


### Features

* **agentphone:** route conversations through canonical chat threads ([#23912](https://github.com/vm0-ai/vm0/issues/23912)) ([30acfce](https://github.com/vm0-ai/vm0/commit/30acfce2c5aaadb99a1526c27112e892bbd5590d))
* enable codex session pruning globally ([#23937](https://github.com/vm0-ai/vm0/issues/23937)) ([e186ffe](https://github.com/vm0-ai/vm0/commit/e186ffe85a92fe9a5b960e5e3174893d54526557))
* put each workflow automation firing's trigger identity in its user turn ([#23898](https://github.com/vm0-ai/vm0/issues/23898)) ([f397b2b](https://github.com/vm0-ai/vm0/commit/f397b2b71c2520ffc1012324521d388f0490a9a1))


### Refactoring

* **api:** rename chat SQL aliases to event vocabulary ([#23938](https://github.com/vm0-ai/vm0/issues/23938)) ([213638e](https://github.com/vm0-ai/vm0/commit/213638e6104a4962d482bdfadd2fbb0a1789f5c9))
* move chat input transport params into queue table ([#23909](https://github.com/vm0-ai/vm0/issues/23909)) ([182afc4](https://github.com/vm0-ai/vm0/commit/182afc46600bf4c4ed2fd19df3d000d17301a906))
* **observability:** migrate connector diagnostics to slug ([#23907](https://github.com/vm0-ai/vm0/issues/23907)) ([ce77eaa](https://github.com/vm0-ai/vm0/commit/ce77eaa374b8c2f6975c3550e8c76c15ccb224ce))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.249.1
    * @vm0/core bumped to 8.488.0
    * @vm0/db bumped to 1.155.0

## [1.347.0](https://github.com/vm0-ai/vm0/compare/api-v1.346.1...api-v1.347.0) (2026-07-30)


### Features

* add chat-run-finished workflow automation event trigger ([#23861](https://github.com/vm0-ai/vm0/issues/23861)) ([402ce7e](https://github.com/vm0-ai/vm0/commit/402ce7e1484a34a172624ea0047ccd1ffcc1441b))


### Bug Fixes

* remove legacy network policy connector fields ([#23866](https://github.com/vm0-ai/vm0/issues/23866)) ([8c5bd04](https://github.com/vm0-ai/vm0/commit/8c5bd0436863535ad36baa9c22b1f849657fb8ac))


### Refactoring

* **api:** unify server chat naming with chat events ([#23896](https://github.com/vm0-ai/vm0/issues/23896)) ([90ea01f](https://github.com/vm0-ai/vm0/commit/90ea01f6748bc3ccfcc289437aa48a621ab254ff))
* remove the fully rolled out zero-finance feature switch ([#23889](https://github.com/vm0-ai/vm0/issues/23889)) ([aa55c8f](https://github.com/vm0-ai/vm0/commit/aa55c8f6a90c5a1b3c6fa043b8852c71f1dbc009))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.249.0
    * @vm0/core bumped to 8.487.0
    * @vm0/db bumped to 1.154.0

## [1.346.1](https://github.com/vm0-ai/vm0/compare/api-v1.346.0...api-v1.346.1) (2026-07-30)


### Bug Fixes

* **api:** enforce thread queue-claim admission ([#23820](https://github.com/vm0-ai/vm0/issues/23820)) ([e2478c4](https://github.com/vm0-ai/vm0/commit/e2478c4410dddd6b2bf76e9ad66172f8d0014cf1))


### Refactoring

* **api:** use stable grouping expressions ([#23843](https://github.com/vm0-ai/vm0/issues/23843)) ([af5ee1f](https://github.com/vm0-ai/vm0/commit/af5ee1fa2bb3bce43a579dd16965c2cacef0328c))
* **telegram:** retire legacy thread session runtime ([#23864](https://github.com/vm0-ai/vm0/issues/23864)) ([83a947e](https://github.com/vm0-ai/vm0/commit/83a947e8c874d41245065fc9b9bfcbf49aecae20))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.248.1
    * @vm0/core bumped to 8.486.3
    * @vm0/db bumped to 1.153.3

## [1.346.0](https://github.com/vm0-ai/vm0/compare/api-v1.345.1...api-v1.346.0) (2026-07-30)


### Features

* **api:** add slug-named connector client contracts ([#23842](https://github.com/vm0-ai/vm0/issues/23842)) ([f81813a](https://github.com/vm0-ai/vm0/commit/f81813a6d3833f65dce8df63cd0e26f1249e8815))


### Bug Fixes

* **api:** stop seeding input content in the chat thread bench ([#23855](https://github.com/vm0-ai/vm0/issues/23855)) ([ef03088](https://github.com/vm0-ai/vm0/commit/ef030881c595e3acd7ccbd8fc85089a9c58d771b))
* **chat:** return the complete per-thread event stream to the frontend ([#23851](https://github.com/vm0-ai/vm0/issues/23851)) ([93422b3](https://github.com/vm0-ai/vm0/commit/93422b35196da90f57648366144742f97800a308))


### Refactoring

* **observability:** add canonical connector slug dimensions ([#23846](https://github.com/vm0-ai/vm0/issues/23846)) ([4a6483a](https://github.com/vm0-ai/vm0/commit/4a6483aa21fb45b84ce7d05d72511ebd5d683558))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.248.0
    * @vm0/core bumped to 8.486.2
    * @vm0/db bumped to 1.153.2

## [1.345.1](https://github.com/vm0-ai/vm0/compare/api-v1.345.0...api-v1.345.1) (2026-07-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.153.1

## [1.345.0](https://github.com/vm0-ai/vm0/compare/api-v1.344.0...api-v1.345.0) (2026-07-29)


### Features

* add manual fit-window control to browser sidebar ([#23778](https://github.com/vm0-ai/vm0/issues/23778)) ([5e83d19](https://github.com/vm0-ai/vm0/commit/5e83d193d95d34895ec1855467dbeba602314e0a))
* **browser:** enforce org concurrency without credit billing ([#23796](https://github.com/vm0-ai/vm0/issues/23796)) ([e42df26](https://github.com/vm0-ai/vm0/commit/e42df26c5958f17ab3d76c0c1a82e5e333893cfe))


### Bug Fixes

* bridge network policy connector slug fields ([#23828](https://github.com/vm0-ai/vm0/issues/23828)) ([ce1a3bb](https://github.com/vm0-ai/vm0/commit/ce1a3bb8d32e5049e3916af9f7233447ed3f5790))
* **chat:** return the complete redacted event stream ([#23815](https://github.com/vm0-ai/vm0/issues/23815)) ([816b9f2](https://github.com/vm0-ai/vm0/commit/816b9f205ab913fca3249b0828d8c362dd2eb207))
* derive automation queue rows from chat events ([#23810](https://github.com/vm0-ai/vm0/issues/23810)) ([9611ed8](https://github.com/vm0-ai/vm0/commit/9611ed8e92f1c3dc57a9c598f0d426b49b08221f))
* **slack:** preserve terminal callbacks on realtime failure ([#23836](https://github.com/vm0-ai/vm0/issues/23836)) ([72cf017](https://github.com/vm0-ai/vm0/commit/72cf017631d599f09d2acc91baf61f19aa92fc3f))
* **telegram:** harden canonical cutover invariants ([#23825](https://github.com/vm0-ai/vm0/issues/23825)) ([74b7e64](https://github.com/vm0-ai/vm0/commit/74b7e6491ed69180cb5071843b5a71282c65cc7a))


### Refactoring

* **api:** replace raw scalar subquery ([#23808](https://github.com/vm0-ai/vm0/issues/23808)) ([82809f2](https://github.com/vm0-ai/vm0/commit/82809f2a8ed9038457fe53596bead978c19630b0))
* **db:** expand connector slug columns ([#23813](https://github.com/vm0-ai/vm0/issues/23813)) ([c85213a](https://github.com/vm0-ai/vm0/commit/c85213aa8c495687d85842c2ae8f6a17eb71fcd5))
* retire signed model pricing protocol ([#23811](https://github.com/vm0-ai/vm0/issues/23811)) ([918a5ef](https://github.com/vm0-ai/vm0/commit/918a5ef92aeccf84ebfbf78a745d1f6062a4d55e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.247.0
    * @vm0/connectors bumped to 1.202.1
    * @vm0/core bumped to 8.486.1
    * @vm0/db bumped to 1.153.0

## [1.344.0](https://github.com/vm0-ai/vm0/compare/api-v1.343.0...api-v1.344.0) (2026-07-29)


### Features

* **cli:** add chat send, queue, and cancel commands ([#23798](https://github.com/vm0-ai/vm0/issues/23798)) ([acae822](https://github.com/vm0-ai/vm0/commit/acae82290bcd72aaf2af292f405db86a05821226))


### Refactoring

* **chat:** retire legacy input content storage ([#23658](https://github.com/vm0-ai/vm0/issues/23658)) ([dcbe985](https://github.com/vm0-ai/vm0/commit/dcbe985bf518c6bf745f8714417df2e9a92576de))
* **connectors:** align custom oauth storage with organization model ([#23521](https://github.com/vm0-ai/vm0/issues/23521)) ([ab3e118](https://github.com/vm0-ai/vm0/commit/ab3e118690a3d7346dadb571ffb38bf9e5d40bbf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.246.0
    * @vm0/core bumped to 8.486.0
    * @vm0/db bumped to 1.152.1

## [1.343.0](https://github.com/vm0-ai/vm0/compare/api-v1.342.0...api-v1.343.0) (2026-07-29)


### Features

* **connectors:** route cloudflare oauth through the app callback ([#23739](https://github.com/vm0-ai/vm0/issues/23739)) ([8fc2316](https://github.com/vm0-ai/vm0/commit/8fc23165b7b813b7c1227f724d7975197baab1ae))
* **telegram:** route reply chains through canonical chat threads ([#23785](https://github.com/vm0-ai/vm0/issues/23785)) ([f55813b](https://github.com/vm0-ai/vm0/commit/f55813b5a07b8b3388510cc84f85afe0036e35dc))


### Bug Fixes

* **api:** harden morning brief failure paths ([#23758](https://github.com/vm0-ai/vm0/issues/23758)) ([2769085](https://github.com/vm0-ai/vm0/commit/2769085d188d83c1468a4bda4e447bf107bff92f))
* **api:** use custom plan periods for team usage ([#23787](https://github.com/vm0-ai/vm0/issues/23787)) ([e7ea364](https://github.com/vm0-ai/vm0/commit/e7ea364061e463087fa2a0cd6c17dc85e5df641a))
* **connectors:** preserve committed mutations on realtime failure ([#23779](https://github.com/vm0-ai/vm0/issues/23779)) ([a4abdee](https://github.com/vm0-ai/vm0/commit/a4abdee3caa2f7e837a3919f6ecf66cc895e54e2))
* **runner:** checkpoint sessions before job timeout ([#23734](https://github.com/vm0-ai/vm0/issues/23734)) ([15f44cc](https://github.com/vm0-ai/vm0/commit/15f44cc68e1387d5b18f604fea9c964a1557561d))
* separate cloud browser viewer access from agent authorization ([#23752](https://github.com/vm0-ai/vm0/issues/23752)) ([3f431f7](https://github.com/vm0-ai/vm0/commit/3f431f721fcb7b7137465c2259dfa15792820a83))


### Refactoring

* **api:** use chat_events in raw sql ([#23760](https://github.com/vm0-ai/vm0/issues/23760)) ([f12b968](https://github.com/vm0-ai/vm0/commit/f12b968bdac602761be42ccfd497f2281be64645))
* **connectors:** consume catalog v2 slug identity ([#23786](https://github.com/vm0-ai/vm0/issues/23786)) ([e9dc374](https://github.com/vm0-ai/vm0/commit/e9dc3740a661f3d549b7e8062e5cb15ea58e017d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.245.0
    * @vm0/connectors bumped to 1.202.0
    * @vm0/core bumped to 8.485.1
    * @vm0/db bumped to 1.152.0

## [1.342.0](https://github.com/vm0-ai/vm0/compare/api-v1.341.0...api-v1.342.0) (2026-07-29)


### Features

* **api:** admit morning briefs through the chat thread queue ([#23713](https://github.com/vm0-ai/vm0/issues/23713)) ([f7fe7aa](https://github.com/vm0-ai/vm0/commit/f7fe7aa84358e363b8042cd6ea85dafccd132046))
* **chat:** admit goal continuation through the thread queue ([#23714](https://github.com/vm0-ai/vm0/issues/23714)) ([5913886](https://github.com/vm0-ai/vm0/commit/591388645ddd0614c9a80c1942c59f4e05255b8e))
* **zero:** enable zero finance for all users ([#23701](https://github.com/vm0-ai/vm0/issues/23701)) ([e2aac84](https://github.com/vm0-ai/vm0/commit/e2aac848b5e88debc8f729e1899210e742183fb0))


### Bug Fixes

* **goals:** harden queued goal rejection ([#23740](https://github.com/vm0-ai/vm0/issues/23740)) ([4728a57](https://github.com/vm0-ai/vm0/commit/4728a579e20772b4fee8230fc038b0179b32231f))


### Refactoring

* **api:** replace redundant sql column wrappers ([#23719](https://github.com/vm0-ai/vm0/issues/23719)) ([cb8356b](https://github.com/vm0-ai/vm0/commit/cb8356be5cb15bc3d79a8715fb5327ddd0e2f133))
* **connectors:** adopt slug terminology internally ([#23697](https://github.com/vm0-ai/vm0/issues/23697)) ([ffa2a39](https://github.com/vm0-ai/vm0/commit/ffa2a39c3624c85ceed4d3b6bed32bc652ed4feb))
* **teams:** retire legacy thread session continuity ([#23720](https://github.com/vm0-ai/vm0/issues/23720)) ([c6341a4](https://github.com/vm0-ai/vm0/commit/c6341a4eaaadc3167314955471f524cfac300e73))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.244.0
    * @vm0/connectors bumped to 1.201.1
    * @vm0/core bumped to 8.485.0
    * @vm0/db bumped to 1.151.0

## [1.341.0](https://github.com/vm0-ai/vm0/compare/api-v1.340.4...api-v1.341.0) (2026-07-29)


### Features

* **platform:** localize account and workspace settings ([#23524](https://github.com/vm0-ai/vm0/issues/23524)) ([f43885a](https://github.com/vm0-ai/vm0/commit/f43885ac2ea5e28fd22862fd729725eb5720dcdd))


### Bug Fixes

* **browser:** sync cards after session lifecycle changes ([#23682](https://github.com/vm0-ai/vm0/issues/23682)) ([babb3d6](https://github.com/vm0-ai/vm0/commit/babb3d6fa22bc34a007920b7603fbd06765eaa38))
* expose inline template switch in lab ([#23670](https://github.com/vm0-ai/vm0/issues/23670)) ([cfd234c](https://github.com/vm0-ai/vm0/commit/cfd234c7a304f88877e2a1f226c9d017fb229a91))


### Refactoring

* remove org plan entitlement reads switch ([#23698](https://github.com/vm0-ai/vm0/issues/23698)) ([8fde46e](https://github.com/vm0-ai/vm0/commit/8fde46ecfbddaf2b003ff33dbcb01ee37f87f859))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.243.4
    * @vm0/connectors bumped to 1.201.0
    * @vm0/core bumped to 8.484.4
    * @vm0/db bumped to 1.150.7

## [1.340.4](https://github.com/vm0-ai/vm0/compare/api-v1.340.3...api-v1.340.4) (2026-07-29)


### Bug Fixes

* **usage:** distinguish people search from web search ([#23635](https://github.com/vm0-ai/vm0/issues/23635)) ([c3f3bd1](https://github.com/vm0-ai/vm0/commit/c3f3bd1be60c48bf2ceae5a0a46a1a901ab2a5ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.243.3
    * @vm0/connectors bumped to 1.200.0
    * @vm0/core bumped to 8.484.3
    * @vm0/db bumped to 1.150.6

## [1.340.3](https://github.com/vm0-ai/vm0/compare/api-v1.340.2...api-v1.340.3) (2026-07-29)


### Refactoring

* **api:** build usage record queries with drizzle ctes ([#23636](https://github.com/vm0-ai/vm0/issues/23636)) ([0bb6628](https://github.com/vm0-ai/vm0/commit/0bb6628aee3040f7c432760485429dd89c7d2386))


### Performance Improvements

* compact hourly usage while retaining source events ([#23632](https://github.com/vm0-ai/vm0/issues/23632)) ([e247f8c](https://github.com/vm0-ai/vm0/commit/e247f8cd27b24c6453d9f9f4a4e86a7ed9532a76))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.243.2
    * @vm0/core bumped to 8.484.2
    * @vm0/db bumped to 1.150.5

## [1.340.2](https://github.com/vm0-ai/vm0/compare/api-v1.340.1...api-v1.340.2) (2026-07-29)


### Bug Fixes

* **browser:** log bounded provider cost diagnostics ([#23613](https://github.com/vm0-ai/vm0/issues/23613)) ([a32f0bb](https://github.com/vm0-ai/vm0/commit/a32f0bbe87fc0a79f7fc36ec1d65d4b3057eadaf))

## [1.340.1](https://github.com/vm0-ai/vm0/compare/api-v1.340.0...api-v1.340.1) (2026-07-29)


### Refactoring

* **api:** build model rankings with drizzle ctes ([#23607](https://github.com/vm0-ai/vm0/issues/23607)) ([162f64f](https://github.com/vm0-ai/vm0/commit/162f64f20dbd232009695331449c5d02adf252ee))
* **api:** remove legacy queue storage manifest state ([#23606](https://github.com/vm0-ai/vm0/issues/23606)) ([8c45c71](https://github.com/vm0-ai/vm0/commit/8c45c7103894f66a0a5abafe09998fc5790bda8b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.243.1
    * @vm0/core bumped to 8.484.1
    * @vm0/db bumped to 1.150.4

## [1.340.0](https://github.com/vm0-ai/vm0/compare/api-v1.339.0...api-v1.340.0) (2026-07-29)


### Features

* **platform:** support brazilian portuguese locale ([#23515](https://github.com/vm0-ai/vm0/issues/23515)) ([a242a1d](https://github.com/vm0-ai/vm0/commit/a242a1dbb984ce339a39f9496ea389b54057a8ea))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.243.0
    * @vm0/core bumped to 8.484.0
    * @vm0/db bumped to 1.150.3

## [1.339.0](https://github.com/vm0-ai/vm0/compare/api-v1.338.2...api-v1.339.0) (2026-07-29)


### Features

* **platform:** enable chat history backfill progress globally ([#23575](https://github.com/vm0-ai/vm0/issues/23575)) ([de38e8f](https://github.com/vm0-ai/vm0/commit/de38e8f94cf489f0e38fd23130357cbd7fc075bf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.483.0
    * @vm0/db bumped to 1.150.2

## [1.338.2](https://github.com/vm0-ai/vm0/compare/api-v1.338.1...api-v1.338.2) (2026-07-28)


### Refactoring

* **chat:** migrate and require canonical user messages ([#23505](https://github.com/vm0-ai/vm0/issues/23505)) ([52955a3](https://github.com/vm0-ai/vm0/commit/52955a380745b5d717750eb9409bf064e33c514c))


### Performance Improvements

* **api:** avoid catalog loading during runner claim ([#23555](https://github.com/vm0-ai/vm0/issues/23555)) ([a2247ee](https://github.com/vm0-ai/vm0/commit/a2247ee072c508d39916621c3bc34980aabded40))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.242.1
    * @vm0/core bumped to 8.482.1
    * @vm0/db bumped to 1.150.1

## [1.338.1](https://github.com/vm0-ai/vm0/compare/api-v1.338.0...api-v1.338.1) (2026-07-28)


### Bug Fixes

* trigger api platform and runner releases ([#23559](https://github.com/vm0-ai/vm0/issues/23559)) ([bc61816](https://github.com/vm0-ai/vm0/commit/bc61816360ad9ebe814198d3bd41cff38eeff116))

## [1.338.0](https://github.com/vm0-ai/vm0/compare/api-v1.337.1...api-v1.338.0) (2026-07-28)


### Features

* add disabled no-auth mcp management domain ([#23513](https://github.com/vm0-ai/vm0/issues/23513)) ([6bcd50b](https://github.com/vm0-ai/vm0/commit/6bcd50b396ea6acc9afff609380da7abbc464f11))


### Bug Fixes

* **api:** log managed browser response validation issues ([#23506](https://github.com/vm0-ai/vm0/issues/23506)) ([a0a0980](https://github.com/vm0-ai/vm0/commit/a0a098079d0fef10af4a7d5191c567a742b0b42d))
* upload large attachments through r2 multipart ([#23490](https://github.com/vm0-ai/vm0/issues/23490)) ([a10f111](https://github.com/vm0-ai/vm0/commit/a10f111c7fe5a4e6b777c5ab7d81582d6f9630a3))


### Refactoring

* **api:** prepare storage queue manifest contraction ([#23512](https://github.com/vm0-ai/vm0/issues/23512)) ([9f63154](https://github.com/vm0-ai/vm0/commit/9f6315470b16f681b7f3d9dd7a3b1be1112fed6b))
* **chat:** drive queues from chat event stream ([#23451](https://github.com/vm0-ai/vm0/issues/23451)) ([1ccf9ef](https://github.com/vm0-ai/vm0/commit/1ccf9efc5653fd6b777e6f45a1873d1b9489f174))


### Performance Improvements

* prepare usage compaction serialization ([#23519](https://github.com/vm0-ai/vm0/issues/23519)) ([e10f70a](https://github.com/vm0-ai/vm0/commit/e10f70a6ac1b0f634e38234ae6edab11033b3d57))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.242.0
    * @vm0/core bumped to 8.482.0
    * @vm0/db bumped to 1.150.0

## [1.337.1](https://github.com/vm0-ai/vm0/compare/api-v1.337.0...api-v1.337.1) (2026-07-28)


### Bug Fixes

* **feishu:** limit workspaces to one admin-managed bot ([#23486](https://github.com/vm0-ai/vm0/issues/23486)) ([382cf02](https://github.com/vm0-ai/vm0/commit/382cf02e09dc7fd29f39849007bbed0509feb038))


### Refactoring

* **chat:** remove legacy message compatibility ([#23394](https://github.com/vm0-ai/vm0/issues/23394)) ([e6fca94](https://github.com/vm0-ai/vm0/commit/e6fca9481261ad52080bb0f202b15b6d75de767d))


### Performance Improvements

* **api:** attribute atomic launch transaction latency ([#23497](https://github.com/vm0-ai/vm0/issues/23497)) ([ce12b51](https://github.com/vm0-ai/vm0/commit/ce12b51f270e8cadcebfe25fd04527170a241edb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.241.1
    * @vm0/core bumped to 8.481.1
    * @vm0/db bumped to 1.149.1

## [1.337.0](https://github.com/vm0-ai/vm0/compare/api-v1.336.0...api-v1.337.0) (2026-07-28)


### Features

* add strapi integration and entry-published automations ([#23397](https://github.com/vm0-ai/vm0/issues/23397)) ([2303632](https://github.com/vm0-ai/vm0/commit/23036322816e375918499c53da66148154c889cf))


### Refactoring

* **db:** remove structured prompt feedback compatibility columns ([#23418](https://github.com/vm0-ai/vm0/issues/23418)) ([c66a81f](https://github.com/vm0-ai/vm0/commit/c66a81fba41413a1ae518be377b77298bc571efe))
* **zero:** graduate people search ([#23477](https://github.com/vm0-ai/vm0/issues/23477)) ([b72f4e1](https://github.com/vm0-ai/vm0/commit/b72f4e152e27a156d79968c742c6720a3132fb19))


### Performance Improvements

* **api:** lazily materialize connector server firewalls ([#23447](https://github.com/vm0-ai/vm0/issues/23447)) ([c3d1f22](https://github.com/vm0-ai/vm0/commit/c3d1f22eaf594215e759a7b137aadd55488bc8c2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.241.0
    * @vm0/core bumped to 8.481.0
    * @vm0/db bumped to 1.149.0

## [1.336.0](https://github.com/vm0-ai/vm0/compare/api-v1.335.1...api-v1.336.0) (2026-07-28)


### Features

* **platform:** persist workspace language preference ([#23396](https://github.com/vm0-ai/vm0/issues/23396)) ([7a409c9](https://github.com/vm0-ai/vm0/commit/7a409c99494fe765a896e72aee1b5450df3b1427))


### Bug Fixes

* **ci:** use immutable pages urls for browser e2e ([#23382](https://github.com/vm0-ai/vm0/issues/23382)) ([0ca6562](https://github.com/vm0-ai/vm0/commit/0ca6562131023efb48ea8fd4ca1e331115011703))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.240.0
    * @vm0/core bumped to 8.480.0
    * @vm0/db bumped to 1.148.0

## [1.335.1](https://github.com/vm0-ai/vm0/compare/api-v1.335.0...api-v1.335.1) (2026-07-28)


### Performance Improvements

* **api:** prepare hourly usage rollup readers ([#23407](https://github.com/vm0-ai/vm0/issues/23407)) ([b5b46d0](https://github.com/vm0-ai/vm0/commit/b5b46d0c0848499e2b027b56e9ab8d534db014fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.239.2
    * @vm0/core bumped to 8.479.1
    * @vm0/db bumped to 1.147.2

## [1.335.0](https://github.com/vm0-ai/vm0/compare/api-v1.334.0...api-v1.335.0) (2026-07-28)


### Features

* **connectors:** default oauth callbacks to app ([#23392](https://github.com/vm0-ai/vm0/issues/23392)) ([b626e8b](https://github.com/vm0-ai/vm0/commit/b626e8b5d781ad635652943c493031c5fae369d4))


### Bug Fixes

* **api:** send low-credit alerts from contact address ([#23390](https://github.com/vm0-ai/vm0/issues/23390)) ([1b50558](https://github.com/vm0-ai/vm0/commit/1b505580bd0d50f07f6740c97cb125b5517864b1))
* **api:** use support address for low-credit alerts ([#23406](https://github.com/vm0-ai/vm0/issues/23406)) ([880934d](https://github.com/vm0-ai/vm0/commit/880934d8d73890d8dfc5d197be5d6ea8d935daa2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.239.1
    * @vm0/connectors bumped to 1.199.0
    * @vm0/core bumped to 8.479.0
    * @vm0/db bumped to 1.147.1

## [1.334.0](https://github.com/vm0-ai/vm0/compare/api-v1.333.0...api-v1.334.0) (2026-07-28)


### Features

* **mail:** add reply follow-up action ([#23291](https://github.com/vm0-ai/vm0/issues/23291)) ([83c7cba](https://github.com/vm0-ai/vm0/commit/83c7cbafc1d241aa0fd072625547cbbc6e81b042))


### Bug Fixes

* **chat:** preserve full recommended follow-up prompts ([#23377](https://github.com/vm0-ai/vm0/issues/23377)) ([58698c7](https://github.com/vm0-ai/vm0/commit/58698c7f7b25d82da7ec04fabdf72363b9a25e66))
* improve feishu setup guidance and oauth callback ([#23384](https://github.com/vm0-ai/vm0/issues/23384)) ([7529209](https://github.com/vm0-ai/vm0/commit/7529209c3e4761cca04d5d05f99b8663b8ec4ffb))


### Refactoring

* **chat:** use full structured prompt as canonical message ([#23380](https://github.com/vm0-ai/vm0/issues/23380)) ([94e9abb](https://github.com/vm0-ai/vm0/commit/94e9abbb99239d85669a4728fbcb513546560b5d))
* **runner:** canonicalize profile discovery contract ([#23387](https://github.com/vm0-ai/vm0/issues/23387)) ([b2fb830](https://github.com/vm0-ai/vm0/commit/b2fb830a6c4d656d35ca95f23ee877b652aa8599))


### Performance Improvements

* **api:** trust api-release-attested connector catalogs ([#23348](https://github.com/vm0-ai/vm0/issues/23348)) ([eda102e](https://github.com/vm0-ai/vm0/commit/eda102ea43c58828f5a6053b00aaaf41b3afdbf5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.239.0
    * @vm0/core bumped to 8.478.0
    * @vm0/db bumped to 1.147.0

## [1.333.0](https://github.com/vm0-ai/vm0/compare/api-v1.332.2...api-v1.333.0) (2026-07-28)


### Features

* **billing:** add monthly invoice downloads ([#23285](https://github.com/vm0-ai/vm0/issues/23285)) ([1dcd80b](https://github.com/vm0-ai/vm0/commit/1dcd80b67a7dd0527dfe8f8557df2610c9672a1b))
* **chat:** add sequence cursors to thread events ([#23347](https://github.com/vm0-ai/vm0/issues/23347)) ([27d941d](https://github.com/vm0-ai/vm0/commit/27d941df65372b980b7f1aa4d3d7d4f7fa871750))


### Bug Fixes

* fork slack and teams dm thread sessions ([#23280](https://github.com/vm0-ai/vm0/issues/23280)) ([de3244b](https://github.com/vm0-ai/vm0/commit/de3244b23d5c0306699fb3f15c0ed88cea7fb2d3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.238.0
    * @vm0/core bumped to 8.477.0
    * @vm0/db bumped to 1.146.0

## [1.332.2](https://github.com/vm0-ai/vm0/compare/api-v1.332.1...api-v1.332.2) (2026-07-28)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.237.2
    * @vm0/connectors bumped to 1.198.0
    * @vm0/core bumped to 8.476.2
    * @vm0/db bumped to 1.145.2

## [1.332.1](https://github.com/vm0-ai/vm0/compare/api-v1.332.0...api-v1.332.1) (2026-07-28)


### Bug Fixes

* **connectors:** limit realtime refreshes to active interactions ([#23343](https://github.com/vm0-ai/vm0/issues/23343)) ([21079b1](https://github.com/vm0-ai/vm0/commit/21079b1b273e7cd17bc3ed2a67ba307b2cffdd51))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.237.1
    * @vm0/core bumped to 8.476.1
    * @vm0/db bumped to 1.145.1

## [1.332.0](https://github.com/vm0-ai/vm0/compare/api-v1.331.0...api-v1.332.0) (2026-07-27)


### Features

* **chat:** add automation queue event consumers ([#23356](https://github.com/vm0-ai/vm0/issues/23356)) ([ae28bdd](https://github.com/vm0-ai/vm0/commit/ae28bdda4f94c2ea12f0fec5f26017cc62fd4abb))
* **chat:** support multiple inline templates ([#23326](https://github.com/vm0-ai/vm0/issues/23326)) ([1e0f8f4](https://github.com/vm0-ai/vm0/commit/1e0f8f4b2b742fbc0a417b8ec410d7b0b824f856))
* enable website template v2 globally ([#23289](https://github.com/vm0-ai/vm0/issues/23289)) ([2bbb2cc](https://github.com/vm0-ai/vm0/commit/2bbb2cc8ff6911b83bde9dc0abd326d7be137b7f))
* **teams:** start runs through chat threads ([#23296](https://github.com/vm0-ai/vm0/issues/23296)) ([841d0f0](https://github.com/vm0-ai/vm0/commit/841d0f0028157abd195ad1cc1408cd5f9068dec2))


### Bug Fixes

* **browser:** accept browser use v3 session responses ([#23334](https://github.com/vm0-ai/vm0/issues/23334)) ([a19ea6e](https://github.com/vm0-ai/vm0/commit/a19ea6e0cc7004883a445c8c00d2d89b0d1a2c60))
* **chat:** classify read and usage state by event type ([#23303](https://github.com/vm0-ai/vm0/issues/23303)) ([7c6858c](https://github.com/vm0-ai/vm0/commit/7c6858c4ea18f2f12708a3b063798c497dae291a))
* **chat:** suppress run push notifications while goals remain active ([#23320](https://github.com/vm0-ai/vm0/issues/23320)) ([c692dec](https://github.com/vm0-ai/vm0/commit/c692dec6130ca23dec36221509c9a6922d98fdde))


### Refactoring

* **api:** require public connector form field ids ([#23313](https://github.com/vm0-ai/vm0/issues/23313)) ([2b8310d](https://github.com/vm0-ai/vm0/commit/2b8310d6e49e896d48641dadba212a295e886e9f))
* **chat:** require non-null chat event types ([#23331](https://github.com/vm0-ai/vm0/issues/23331)) ([3da9b1a](https://github.com/vm0-ai/vm0/commit/3da9b1af7130dbcd4a41d9d9c15ed81625bcc5b0))
* move feature switch keys into core ([#23299](https://github.com/vm0-ai/vm0/issues/23299)) ([11071e0](https://github.com/vm0-ai/vm0/commit/11071e056383e7ead21cc578961ed8496865f718))
* reduce fallback slop in organization member ids ([#23357](https://github.com/vm0-ai/vm0/issues/23357)) ([9431713](https://github.com/vm0-ai/vm0/commit/943171356d4af4bf641e5530d6ac3864dc2b0b39))
* remove graduated user-facing feature switches ([#23308](https://github.com/vm0-ai/vm0/issues/23308)) ([88670a3](https://github.com/vm0-ai/vm0/commit/88670a3f7df97bdf4a6caec3b17ed1550126f51a))
* retire mail and thread mention feature switches ([#23324](https://github.com/vm0-ai/vm0/issues/23324)) ([535b9bc](https://github.com/vm0-ai/vm0/commit/535b9bc54238cc1ee75367dd33c9e4f314981eb7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.237.0
    * @vm0/connectors bumped to 1.197.1
    * @vm0/core bumped to 8.476.0
    * @vm0/db bumped to 1.145.0

## [1.331.0](https://github.com/vm0-ai/vm0/compare/api-v1.330.0...api-v1.331.0) (2026-07-27)


### Features

* add thread-scoped cloud browser access ([#23253](https://github.com/vm0-ai/vm0/issues/23253)) ([0699a79](https://github.com/vm0-ai/vm0/commit/0699a7935ad6994b00ad97c00a7aeae307dbd4d2))
* enable mail drafts and chat thread mentions for all users ([#23257](https://github.com/vm0-ai/vm0/issues/23257)) ([4a5de22](https://github.com/vm0-ai/vm0/commit/4a5de22f8c7636de66e2feeffba99767bec5e383))


### Bug Fixes

* **feishu:** expose group id in agent system prompt ([#23281](https://github.com/vm0-ai/vm0/issues/23281)) ([6a8b518](https://github.com/vm0-ai/vm0/commit/6a8b5180e36df2df74faa0bed27d704e41993648))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.236.0
    * @vm0/connectors bumped to 1.197.0
    * @vm0/core bumped to 8.475.0
    * @vm0/db bumped to 1.144.0

## [1.330.0](https://github.com/vm0-ai/vm0/compare/api-v1.329.1...api-v1.330.0) (2026-07-27)


### Features

* thread-owned chat sidebar shell behind newChatThreadSidebar switch ([#23269](https://github.com/vm0-ai/vm0/issues/23269)) ([c67c965](https://github.com/vm0-ai/vm0/commit/c67c96547fb4646b7d424a42de7f790b28e3f3a1))


### Refactoring

* **api:** move connector feature states into api ([#23273](https://github.com/vm0-ai/vm0/issues/23273)) ([0a77e82](https://github.com/vm0-ai/vm0/commit/0a77e82f3f6f6dfa364187736af33eef8486184b))
* **artifacts:** remove favorite api routes ([#22700](https://github.com/vm0-ai/vm0/issues/22700)) ([376c328](https://github.com/vm0-ai/vm0/commit/376c3288889fc663038db90a7297f608babf34dd))
* **chat:** type the immutable event stream ([#23148](https://github.com/vm0-ai/vm0/issues/23148)) ([6cdd9c5](https://github.com/vm0-ai/vm0/commit/6cdd9c5155895556f1e9f78ced2e190dad080568))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.235.0
    * @vm0/connectors bumped to 1.196.0
    * @vm0/core bumped to 8.474.0
    * @vm0/db bumped to 1.143.6

## [1.329.1](https://github.com/vm0-ai/vm0/compare/api-v1.329.0...api-v1.329.1) (2026-07-27)


### Refactoring

* **storage:** remove legacy type residue ([#23232](https://github.com/vm0-ai/vm0/issues/23232)) ([eeb8daa](https://github.com/vm0-ai/vm0/commit/eeb8daadad7c5c81c3cfd5cd7e08bb8b0e130f01))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.234.1
    * @vm0/core bumped to 8.473.0
    * @vm0/db bumped to 1.143.5

## [1.329.0](https://github.com/vm0-ai/vm0/compare/api-v1.328.1...api-v1.329.0) (2026-07-27)


### Features

* enable image style r2 globally ([#23176](https://github.com/vm0-ai/vm0/issues/23176)) ([441d729](https://github.com/vm0-ai/vm0/commit/441d729f24d98b34f570cf732d99e2f49079e2ce))
* **feishu:** improve setup and oauth callback flow ([#23202](https://github.com/vm0-ai/vm0/issues/23202)) ([d0a75ae](https://github.com/vm0-ai/vm0/commit/d0a75ae68f23fcf28898b20afefc183ca9167da8))


### Bug Fixes

* **api:** give the morning brief run its own delivery facts ([#23171](https://github.com/vm0-ai/vm0/issues/23171)) ([4a934f6](https://github.com/vm0-ai/vm0/commit/4a934f63474d40aab8d57893db4f39f4c8168bfb))
* **api:** retire legacy feishu org run dispatch ([#23187](https://github.com/vm0-ai/vm0/issues/23187)) ([8d70530](https://github.com/vm0-ai/vm0/commit/8d70530e8989532e5aa6c5d58a19d787f4e550e9))
* **api:** validate and recover canonical chat session bindings ([#23192](https://github.com/vm0-ai/vm0/issues/23192)) ([3145dae](https://github.com/vm0-ai/vm0/commit/3145daed930da540447229386defcfa33f30d32a))


### Refactoring

* **connectors:** remove static catalog authority ([#23201](https://github.com/vm0-ai/vm0/issues/23201)) ([590a2ff](https://github.com/vm0-ai/vm0/commit/590a2ff16caf5ca5534954be53a0e7bf4b61376e))
* **storage:** detach legacy type columns from writes ([#23189](https://github.com/vm0-ai/vm0/issues/23189)) ([abc29ca](https://github.com/vm0-ai/vm0/commit/abc29caa49306c0ee3daaee1915495ec45c7c3d9))
* **storage:** remove legacy type columns ([#23210](https://github.com/vm0-ai/vm0/issues/23210)) ([3c60bc7](https://github.com/vm0-ai/vm0/commit/3c60bc70a9fa63ece9bd8249881f6e01a5ed382e))


### Performance Improvements

* **api:** batch exact storage version resolution ([#23186](https://github.com/vm0-ai/vm0/issues/23186)) ([580ca10](https://github.com/vm0-ai/vm0/commit/580ca10df0898a4ef0123844319ffe6eeced1c7b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.234.0
    * @vm0/connectors bumped to 1.195.2
    * @vm0/core bumped to 8.472.0
    * @vm0/db bumped to 1.143.4

## [1.328.1](https://github.com/vm0-ai/vm0/compare/api-v1.328.0...api-v1.328.1) (2026-07-27)


### Refactoring

* **connectors:** make catalog consumption external-only ([#23138](https://github.com/vm0-ai/vm0/issues/23138)) ([5a79f3b](https://github.com/vm0-ai/vm0/commit/5a79f3b532a5a97cb3623bd865130c4259017707))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.233.3
    * @vm0/connectors bumped to 1.195.1
    * @vm0/core bumped to 8.471.1
    * @vm0/db bumped to 1.143.3

## [1.328.0](https://github.com/vm0-ai/vm0/compare/api-v1.327.1...api-v1.328.0) (2026-07-26)


### Features

* prune oversized codex session history ([#23136](https://github.com/vm0-ai/vm0/issues/23136)) ([010d286](https://github.com/vm0-ai/vm0/commit/010d286e46b4b7035ef41e6417bdfca707688aa0))


### Refactoring

* require slack file id and permalink for delivered assets ([#23147](https://github.com/vm0-ai/vm0/issues/23147)) ([1929e12](https://github.com/vm0-ai/vm0/commit/1929e12a6c015c2ba0eef9a3d4d985b1f51c6506))
* **storage:** detach runtime from legacy storage type ([#23143](https://github.com/vm0-ai/vm0/issues/23143)) ([cc415c5](https://github.com/vm0-ai/vm0/commit/cc415c5c844343ab573c0d9de5a31d1fd378ad69))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.233.2
    * @vm0/connectors bumped to 1.195.0
    * @vm0/core bumped to 8.471.0
    * @vm0/db bumped to 1.143.2

## [1.327.1](https://github.com/vm0-ai/vm0/compare/api-v1.327.0...api-v1.327.1) (2026-07-26)


### Bug Fixes

* **chat:** preserve feedback as structured message parts ([#22893](https://github.com/vm0-ai/vm0/issues/22893)) ([c23162f](https://github.com/vm0-ai/vm0/commit/c23162ff3e0e025378f1b3c47051c203cd84cbcc))


### Refactoring

* **api:** use settlement time for finalized usage reports ([#23137](https://github.com/vm0-ai/vm0/issues/23137)) ([f9360d0](https://github.com/vm0-ai/vm0/commit/f9360d0c979f063bc0b290c6874b37890edcf9f1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.233.1
    * @vm0/core bumped to 8.470.1
    * @vm0/db bumped to 1.143.1

## [1.327.0](https://github.com/vm0-ai/vm0/compare/api-v1.326.1...api-v1.327.0) (2026-07-26)


### Features

* add fixed r2 packages for image styles behind a rollout switch ([#23120](https://github.com/vm0-ai/vm0/issues/23120)) ([bbeeaee](https://github.com/vm0-ai/vm0/commit/bbeeaee0515508f9a58359bb78984d074ff2c7fb))
* **api:** unify chat thread session resolution across run sources ([#23129](https://github.com/vm0-ai/vm0/issues/23129)) ([99efc92](https://github.com/vm0-ai/vm0/commit/99efc92f37078e17aac8687ebcc87bf054074e28))
* prefer thumbnails for chat artifact covers ([#23131](https://github.com/vm0-ai/vm0/issues/23131)) ([e1b9cdf](https://github.com/vm0-ai/vm0/commit/e1b9cdf2f5c781883ae4c0540b69b50b88a4389a))


### Refactoring

* **connectors:** decouple execution from static registry ([#23128](https://github.com/vm0-ai/vm0/issues/23128)) ([7a8688d](https://github.com/vm0-ai/vm0/commit/7a8688d08fec2fd4d2e7046ef2bed883e3683a2e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.233.0
    * @vm0/connectors bumped to 1.194.0
    * @vm0/core bumped to 8.470.0
    * @vm0/db bumped to 1.143.0

## [1.326.1](https://github.com/vm0-ai/vm0/compare/api-v1.326.0...api-v1.326.1) (2026-07-26)


### Bug Fixes

* refresh website template v2 archives to upstream ccff774 ([#23126](https://github.com/vm0-ai/vm0/issues/23126)) ([b564fa1](https://github.com/vm0-ai/vm0/commit/b564fa11bcd86b0e7f26ed7c464299e673e61fbf))


### Refactoring

* detach slack routing from legacy route fields ([#23127](https://github.com/vm0-ai/vm0/issues/23127)) ([50c43ab](https://github.com/vm0-ai/vm0/commit/50c43abc1be127d4b40e5d429058dcd6954597b6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.232.2
    * @vm0/core bumped to 8.469.1
    * @vm0/db bumped to 1.142.2

## [1.326.0](https://github.com/vm0-ai/vm0/compare/api-v1.325.0...api-v1.326.0) (2026-07-26)


### Features

* prune compacted claude session history ([#23081](https://github.com/vm0-ai/vm0/issues/23081)) ([671dc1c](https://github.com/vm0-ai/vm0/commit/671dc1c3a1ffe14b3be6d7079afd6f2cc24f14b0))


### Bug Fixes

* **api:** persist thread session binding telemetry ([#23121](https://github.com/vm0-ai/vm0/issues/23121)) ([c0bfeef](https://github.com/vm0-ai/vm0/commit/c0bfeef2934bfc3cc59f9fd3c1da4e762f31702c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.232.1
    * @vm0/connectors bumped to 1.193.0
    * @vm0/core bumped to 8.469.0
    * @vm0/db bumped to 1.142.1

## [1.325.0](https://github.com/vm0-ai/vm0/compare/api-v1.324.2...api-v1.325.0) (2026-07-26)


### Features

* persist chat thread session bindings on admission ([#23105](https://github.com/vm0-ai/vm0/issues/23105)) ([3292c55](https://github.com/vm0-ai/vm0/commit/3292c55025c9ee308454a8de5185d3df9918cad8))


### Refactoring

* retire legacy slack runtime branches ([#23104](https://github.com/vm0-ai/vm0/issues/23104)) ([e1d8dde](https://github.com/vm0-ai/vm0/commit/e1d8ddeaaba338b59c56cc2515c7599abf13cbe3))
* **storage:** authorize writeback by storage id ([#23112](https://github.com/vm0-ai/vm0/issues/23112)) ([321117e](https://github.com/vm0-ai/vm0/commit/321117edaf5f2304b87a435748557ad47cf73ea3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.232.0
    * @vm0/connectors bumped to 1.192.2
    * @vm0/core bumped to 8.468.2
    * @vm0/db bumped to 1.142.0

## [1.324.2](https://github.com/vm0-ai/vm0/compare/api-v1.324.1...api-v1.324.2) (2026-07-26)


### CI

* decouple app release from api promotion ([#23100](https://github.com/vm0-ai/vm0/issues/23100)) ([8f3ddcb](https://github.com/vm0-ai/vm0/commit/8f3ddcb3977c8ace140995e94219c7e051557a48))


### Performance Improvements

* retire html artifact editing and presentation export ([#23083](https://github.com/vm0-ai/vm0/issues/23083)) ([d0d3a24](https://github.com/vm0-ai/vm0/commit/d0d3a248437eb67270c8fc76ade7d95c013b0029))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.231.2
    * @vm0/connectors bumped to 1.192.1
    * @vm0/core bumped to 8.468.1
    * @vm0/db bumped to 1.141.3

## [1.324.1](https://github.com/vm0-ai/vm0/compare/api-v1.324.0...api-v1.324.1) (2026-07-26)


### Bug Fixes

* trigger api platform and runner releases ([#23091](https://github.com/vm0-ai/vm0/issues/23091)) ([100f6fe](https://github.com/vm0-ai/vm0/commit/100f6fe7fbb9fd8d84044bf12f1c6633c1c0b025))

## [1.324.0](https://github.com/vm0-ai/vm0/compare/api-v1.323.1...api-v1.324.0) (2026-07-26)


### Features

* **api:** enable external connector catalog ([#23064](https://github.com/vm0-ai/vm0/issues/23064)) ([8e802f2](https://github.com/vm0-ai/vm0/commit/8e802f29cdfe41dcb80cd57ad543b01a0298d6b6))


### Bug Fixes

* **api:** make artifact previews write-once and immutable ([#23079](https://github.com/vm0-ai/vm0/issues/23079)) ([41b3c2c](https://github.com/vm0-ai/vm0/commit/41b3c2c0533f49d9f68b4f13af23292d2a595d3b))
* **api:** seed connector catalog for local development ([#23077](https://github.com/vm0-ai/vm0/issues/23077)) ([ef2c7f4](https://github.com/vm0-ai/vm0/commit/ef2c7f4ffbf881f6441557e17aa2b55977053de3))
* trigger api and platform releases ([#23076](https://github.com/vm0-ai/vm0/issues/23076)) ([a005cfc](https://github.com/vm0-ai/vm0/commit/a005cfce2200944636124ab35be19702c879dba9))


### Performance Improvements

* resize artifact catalog thumbnails with cloudflare ([#23074](https://github.com/vm0-ai/vm0/issues/23074)) ([215532c](https://github.com/vm0-ai/vm0/commit/215532cead0823908f2e7a46148b6d4f9fa447f0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.468.0
    * @vm0/db bumped to 1.141.2

## [1.323.1](https://github.com/vm0-ai/vm0/compare/api-v1.323.0...api-v1.323.1) (2026-07-25)


### Refactoring

* **storage:** require canonical runner claim manifests ([#23059](https://github.com/vm0-ai/vm0/issues/23059)) ([2c8b7d3](https://github.com/vm0-ai/vm0/commit/2c8b7d3cfe190c762cd7d6559d057fa6d189b092))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.231.1
    * @vm0/core bumped to 8.467.2
    * @vm0/db bumped to 1.141.1

## [1.323.0](https://github.com/vm0-ai/vm0/compare/api-v1.322.2...api-v1.323.0) (2026-07-25)


### Features

* add the artifact catalog behind a per-org feature switch ([#23030](https://github.com/vm0-ai/vm0/issues/23030)) ([6faf025](https://github.com/vm0-ai/vm0/commit/6faf0253b7ed7e522660b028faa2a62372bd90b4))
* **api:** graduate canonical slack ingress ([#23033](https://github.com/vm0-ai/vm0/issues/23033)) ([68ae6bd](https://github.com/vm0-ai/vm0/commit/68ae6bd2e310da3bfeb926f22a20b11c70909822))


### Bug Fixes

* stabilize workflow queue stale-sweep admission barrier ([#23065](https://github.com/vm0-ai/vm0/issues/23065)) ([5dd31a5](https://github.com/vm0-ai/vm0/commit/5dd31a58e19c4b691a6a19bc6b1223cb615d63fc))


### Refactoring

* reduce fallback slop in workflow schedules ([#23066](https://github.com/vm0-ai/vm0/issues/23066)) ([f498c76](https://github.com/vm0-ai/vm0/commit/f498c76b392dc5d08ef3770450ce75ace23aa3f7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.231.0
    * @vm0/core bumped to 8.467.1
    * @vm0/db bumped to 1.141.0

## [1.322.2](https://github.com/vm0-ai/vm0/compare/api-v1.322.1...api-v1.322.2) (2026-07-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.467.0
    * @vm0/db bumped to 1.140.2

## [1.322.1](https://github.com/vm0-ai/vm0/compare/api-v1.322.0...api-v1.322.1) (2026-07-25)


### Refactoring

* **api:** retire catalog rejection rollout guards ([#23042](https://github.com/vm0-ai/vm0/issues/23042)) ([fc90bd2](https://github.com/vm0-ai/vm0/commit/fc90bd248956a6bba0a3577a512c0aa2f0295694))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.230.1
    * @vm0/core bumped to 8.466.3
    * @vm0/db bumped to 1.140.1

## [1.322.0](https://github.com/vm0-ai/vm0/compare/api-v1.321.1...api-v1.322.0) (2026-07-25)


### Features

* **browser:** keep managed browsers alive after a run with an idle lease ([#23037](https://github.com/vm0-ai/vm0/issues/23037)) ([405591d](https://github.com/vm0-ai/vm0/commit/405591d1e7416a18ab8e0e66e456d3669da74629))


### Bug Fixes

* **preview:** propagate bypass to sandbox CLI ([#23045](https://github.com/vm0-ai/vm0/issues/23045)) ([6e4dc99](https://github.com/vm0-ai/vm0/commit/6e4dc99ba1327bc789708255b7e2ba4f387c7df3))
* **workflows:** claim queued events atomically with run creation ([#23028](https://github.com/vm0-ai/vm0/issues/23028)) ([f8c7f64](https://github.com/vm0-ai/vm0/commit/f8c7f64b54b7e430b58883cb2b9c57cce3f67cbf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.230.0
    * @vm0/core bumped to 8.466.2
    * @vm0/db bumped to 1.140.0

## [1.321.1](https://github.com/vm0-ai/vm0/compare/api-v1.321.0...api-v1.321.1) (2026-07-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.229.2
    * @vm0/connectors bumped to 1.192.0
    * @vm0/core bumped to 8.466.1
    * @vm0/db bumped to 1.139.2

## [1.321.0](https://github.com/vm0-ai/vm0/compare/api-v1.320.0...api-v1.321.0) (2026-07-25)


### Features

* **billing:** enable plan upgrade guidance globally ([#23019](https://github.com/vm0-ai/vm0/issues/23019)) ([4f6feb6](https://github.com/vm0-ai/vm0/commit/4f6feb654f4c3a0b908786e481f91cbbb235ebb9))


### Bug Fixes

* **api:** revalidate catalog rejections after backend releases ([#23001](https://github.com/vm0-ai/vm0/issues/23001)) ([ac8c4ab](https://github.com/vm0-ai/vm0/commit/ac8c4ab4d51a574cec6c0f8c274e7a880868e11f))


### Refactoring

* **api:** replace usage insight sql with typed drizzle builders ([#23003](https://github.com/vm0-ai/vm0/issues/23003)) ([9df6f88](https://github.com/vm0-ai/vm0/commit/9df6f88c128974f1f131c6ca2a9d255d98c2c362))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.229.1
    * @vm0/core bumped to 8.466.0
    * @vm0/db bumped to 1.139.1

## [1.320.0](https://github.com/vm0-ai/vm0/compare/api-v1.319.0...api-v1.320.0) (2026-07-25)


### Features

* resume web chat after a linked gmail draft is sent ([#22963](https://github.com/vm0-ai/vm0/issues/22963)) ([7e00412](https://github.com/vm0-ai/vm0/commit/7e00412db66d95670476451828603f1efe742f97))
* **zero:** add managed browsers with shared user profiles ([#22940](https://github.com/vm0-ai/vm0/issues/22940)) ([a56eeac](https://github.com/vm0-ai/vm0/commit/a56eeac6a74f30fae2fcfb2d69fa8b0840da6764))


### Bug Fixes

* **goals:** unify goal capabilities across run sources ([#22986](https://github.com/vm0-ai/vm0/issues/22986)) ([04e6169](https://github.com/vm0-ai/vm0/commit/04e616918121b883cda790f855327ec2dcf906f2))


### Refactoring

* **api:** remove eight unused api routes ([#22958](https://github.com/vm0-ai/vm0/issues/22958)) ([f05dc99](https://github.com/vm0-ai/vm0/commit/f05dc9910c0e0f21d64a463bab55a7c8b1862568))
* **api:** replace builder-owned sql predicates ([#22965](https://github.com/vm0-ai/vm0/issues/22965)) ([0cba6a6](https://github.com/vm0-ai/vm0/commit/0cba6a6abde97022866a1a6d76368b6c01149bd3))
* remove model observation compatibility layer ([#22975](https://github.com/vm0-ai/vm0/issues/22975)) ([d7b600f](https://github.com/vm0-ai/vm0/commit/d7b600f0ee35c6d32366bf7004e6c1e17b5bbe23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.229.0
    * @vm0/connectors bumped to 1.191.0
    * @vm0/core bumped to 8.465.0
    * @vm0/db bumped to 1.139.0

## [1.319.0](https://github.com/vm0-ai/vm0/compare/api-v1.318.0...api-v1.319.0) (2026-07-25)


### Features

* show connector catalog diagnostics in debug settings ([#22962](https://github.com/vm0-ai/vm0/issues/22962)) ([fc40bb1](https://github.com/vm0-ai/vm0/commit/fc40bb12dcecc464dce2d4a1c9b56a5506ec733c))


### Refactoring

* **api:** replace credit availability sql with typed drizzle queries ([#22941](https://github.com/vm0-ai/vm0/issues/22941)) ([c29e911](https://github.com/vm0-ai/vm0/commit/c29e911ab1eb7ca490cc1b242b1d665a797b3328))


### Performance Improvements

* add first-output coverage and codex lifecycle timings ([#22946](https://github.com/vm0-ai/vm0/issues/22946)) ([12e1316](https://github.com/vm0-ai/vm0/commit/12e13160392117b0fbe950b51fb0edc986059b90))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.228.0
    * @vm0/core bumped to 8.464.1
    * @vm0/db bumped to 1.138.0

## [1.318.0](https://github.com/vm0-ai/vm0/compare/api-v1.317.0...api-v1.318.0) (2026-07-25)


### Features

* add claude opus 5 to new organization defaults ([#22955](https://github.com/vm0-ai/vm0/issues/22955)) ([70cb3ba](https://github.com/vm0-ai/vm0/commit/70cb3bac4954f0b89df4bd30725ec00adc0b2eb7))
* **api:** force app.vm0.ai clients to upgrade to v0.631.1 ([#22950](https://github.com/vm0-ai/vm0/issues/22950)) ([866e468](https://github.com/vm0-ai/vm0/commit/866e468e0219a517c76041c700a3104a4973ca1f))
* **api:** prepare external connector catalog cutover ([#22920](https://github.com/vm0-ai/vm0/issues/22920)) ([f92abc3](https://github.com/vm0-ai/vm0/commit/f92abc3a1103418f92f382e4c2ebba7edfa0a340))


### Bug Fixes

* **core:** limit default seed skills to execution essentials ([#22948](https://github.com/vm0-ai/vm0/issues/22948)) ([2c9aa24](https://github.com/vm0-ai/vm0/commit/2c9aa24d1f2effa0af92d08d992d3987df142aaf))


### Refactoring

* **chat:** trim thread detail and drop legacy mail draft marker ([#22949](https://github.com/vm0-ai/vm0/issues/22949)) ([bcda14a](https://github.com/vm0-ai/vm0/commit/bcda14abbf7b135ed7a2ef8485c07f3240ae0a17))
* **db:** remove legacy model observation storage ([#22907](https://github.com/vm0-ai/vm0/issues/22907)) ([ee4895e](https://github.com/vm0-ai/vm0/commit/ee4895e77f921cccbfd44c422763652120e2de82))
* reduce fallback slop in people search ([#22954](https://github.com/vm0-ai/vm0/issues/22954)) ([68e832c](https://github.com/vm0-ai/vm0/commit/68e832cbd913353fb0b235684f967bacf5006130))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.227.0
    * @vm0/core bumped to 8.464.0
    * @vm0/db bumped to 1.137.0

## [1.317.0](https://github.com/vm0-ai/vm0/compare/api-v1.316.0...api-v1.317.0) (2026-07-24)


### Features

* **cli:** add cached chat thread listing and targeted rename ([#22927](https://github.com/vm0-ai/vm0/issues/22927)) ([1f11e99](https://github.com/vm0-ai/vm0/commit/1f11e99eda61c426b5e5782529a9aa5eb9366b50))


### Bug Fixes

* **feishu:** shorten file ids in run prompts ([#22929](https://github.com/vm0-ai/vm0/issues/22929)) ([e861d6e](https://github.com/vm0-ai/vm0/commit/e861d6e0caac4aaec7328dc1015242af6da272ad))
* retire gpt-5.4 models ([#22923](https://github.com/vm0-ai/vm0/issues/22923)) ([0e5de85](https://github.com/vm0-ai/vm0/commit/0e5de85debf5ae6eb58e3a56a598ca2d21e506a0))
* **workflows:** route manual runs through the chat queue ([#22933](https://github.com/vm0-ai/vm0/issues/22933)) ([b586e29](https://github.com/vm0-ai/vm0/commit/b586e29777c315815054da64a8657377d6708775))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.226.0
    * @vm0/core bumped to 8.463.0
    * @vm0/db bumped to 1.136.1

## [1.316.0](https://github.com/vm0-ai/vm0/compare/api-v1.315.0...api-v1.316.0) (2026-07-24)


### Features

* add github job, review, deployment, and comment automations ([#22904](https://github.com/vm0-ai/vm0/issues/22904)) ([6e20502](https://github.com/vm0-ai/vm0/commit/6e20502a92bb6cc5eea35a98d6583fd8c949cd1d))


### Performance Improvements

* **chat:** reduce duplicate message sync requests ([#22886](https://github.com/vm0-ai/vm0/issues/22886)) ([ff34466](https://github.com/vm0-ai/vm0/commit/ff344661065158de4c29728c31ee92439a2cec58))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.225.0
    * @vm0/connectors bumped to 1.190.0
    * @vm0/core bumped to 8.462.0
    * @vm0/db bumped to 1.136.0

## [1.315.0](https://github.com/vm0-ai/vm0/compare/api-v1.314.0...api-v1.315.0) (2026-07-24)


### Features

* **chat:** source service tier and computer use host from thread events ([#22890](https://github.com/vm0-ai/vm0/issues/22890)) ([173e9c9](https://github.com/vm0-ai/vm0/commit/173e9c99c5e56f2a9cba55b0fd31a93d4e52c60e))


### Refactoring

* **api:** detach legacy storage persistence columns ([#22899](https://github.com/vm0-ai/vm0/issues/22899)) ([522c3de](https://github.com/vm0-ai/vm0/commit/522c3dee4efff435fa8235445208d81ccc92926e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.224.0
    * @vm0/core bumped to 8.461.2
    * @vm0/db bumped to 1.135.0

## [1.314.0](https://github.com/vm0-ai/vm0/compare/api-v1.313.2...api-v1.314.0) (2026-07-24)


### Features

* add feishu file transfer commands ([#22895](https://github.com/vm0-ai/vm0/issues/22895)) ([6ebf407](https://github.com/vm0-ai/vm0/commit/6ebf407f7b2bfdc7ca1d8d2393b7fcde31494ac8))
* **mail:** add rich draft rendering and selection feedback ([#22775](https://github.com/vm0-ai/vm0/issues/22775)) ([d91894a](https://github.com/vm0-ai/vm0/commit/d91894a9653b3d854f90ed1f5389afd8cca6e9b1))


### Bug Fixes

* **zero:** restore managed people search requests ([#22896](https://github.com/vm0-ai/vm0/issues/22896)) ([705e31d](https://github.com/vm0-ai/vm0/commit/705e31d44d528f1efe8681ecc200052b8bdafdac))


### Refactoring

* **api:** gate external connector catalog with feature switch ([#22884](https://github.com/vm0-ai/vm0/issues/22884)) ([2b37dd2](https://github.com/vm0-ai/vm0/commit/2b37dd2dde88860dfbd7e98c6fc2c8cd4a39cb45))
* **api:** replace cache touch locking cte with drizzle builders ([#22873](https://github.com/vm0-ai/vm0/issues/22873)) ([3586ba7](https://github.com/vm0-ai/vm0/commit/3586ba7d55c801a0f0cc77afaf95246cb26f34c6))
* **chat:** remove message-by-id api and sync path ([#22874](https://github.com/vm0-ai/vm0/issues/22874)) ([fa699ed](https://github.com/vm0-ai/vm0/commit/fa699ed9417569bd14a12535a8d371a4f81c0c63))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.223.0
    * @vm0/connectors bumped to 1.189.1
    * @vm0/core bumped to 8.461.1
    * @vm0/db bumped to 1.134.0

## [1.313.2](https://github.com/vm0-ai/vm0/compare/api-v1.313.1...api-v1.313.2) (2026-07-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.133.4

## [1.313.1](https://github.com/vm0-ai/vm0/compare/api-v1.313.0...api-v1.313.1) (2026-07-24)


### Refactoring

* **api:** require canonical persisted storage state ([#22868](https://github.com/vm0-ai/vm0/issues/22868)) ([a9d7b47](https://github.com/vm0-ai/vm0/commit/a9d7b47c0b8191a16bd752cc1be827966115fa34))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.222.1
    * @vm0/core bumped to 8.461.0
    * @vm0/db bumped to 1.133.3

## [1.313.0](https://github.com/vm0-ai/vm0/compare/api-v1.312.2...api-v1.313.0) (2026-07-24)


### Features

* **api:** prefer zero scrape for public pages ([#22861](https://github.com/vm0-ai/vm0/issues/22861)) ([96c52aa](https://github.com/vm0-ai/vm0/commit/96c52aace5242dc934232730bd5aee9e523badb3))

## [1.312.2](https://github.com/vm0-ai/vm0/compare/api-v1.312.1...api-v1.312.2) (2026-07-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.222.0
    * @vm0/connectors bumped to 1.189.0
    * @vm0/core bumped to 8.460.0
    * @vm0/db bumped to 1.133.2

## [1.312.1](https://github.com/vm0-ai/vm0/compare/api-v1.312.0...api-v1.312.1) (2026-07-24)


### Bug Fixes

* **api:** preserve preview override for queued chat runs ([#22843](https://github.com/vm0-ai/vm0/issues/22843)) ([691aadd](https://github.com/vm0-ai/vm0/commit/691aaddee11573d6f5053c5b7afe4456ba6b66f2))


### Refactoring

* **api:** use builders for unnest-backed bulk updates ([#22840](https://github.com/vm0-ai/vm0/issues/22840)) ([d0b13bd](https://github.com/vm0-ai/vm0/commit/d0b13bd29b4a7f4be9fcd314ec2880cf3196553b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.133.1

## [1.312.0](https://github.com/vm0-ai/vm0/compare/api-v1.311.0...api-v1.312.0) (2026-07-24)


### Features

* trigger automations from completed github workflow runs ([#22831](https://github.com/vm0-ai/vm0/issues/22831)) ([407a3e8](https://github.com/vm0-ai/vm0/commit/407a3e874fded0deef147d260cb5e06f0f0746b7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.221.0
    * @vm0/connectors bumped to 1.188.0
    * @vm0/core bumped to 8.459.0
    * @vm0/db bumped to 1.133.0

## [1.311.0](https://github.com/vm0-ai/vm0/compare/api-v1.310.0...api-v1.311.0) (2026-07-24)


### Features

* **api:** force app.vm0.ai clients to upgrade to v0.626.0 ([#22824](https://github.com/vm0-ai/vm0/issues/22824)) ([f16abaf](https://github.com/vm0-ai/vm0/commit/f16abaf433802169e5c19812eadfb55a528725bd))


### Bug Fixes

* **billing:** guide video-restricted workspaces to plan upgrade ([#22794](https://github.com/vm0-ai/vm0/issues/22794)) ([ec7c924](https://github.com/vm0-ai/vm0/commit/ec7c924358ea0fa63ec71e9c6be85317a6ebaa1c))


### Refactoring

* **api:** remove checkpoint resume and read api ([#22815](https://github.com/vm0-ai/vm0/issues/22815)) ([ad0d0b3](https://github.com/vm0-ai/vm0/commit/ad0d0b39655d1dd4bafeabe0e8a8bbb32247db47))
* **api:** use builders for artifact history and visibility ([#22781](https://github.com/vm0-ai/vm0/issues/22781)) ([02f11a5](https://github.com/vm0-ai/vm0/commit/02f11a5cd541d7dff9a461e49c6f8550796239ba))
* **email:** remove retired agent email runtime ([#22818](https://github.com/vm0-ai/vm0/issues/22818)) ([4d20d9f](https://github.com/vm0-ai/vm0/commit/4d20d9f67edf960051d6ad4fab185aee5ea96c4d))


### Performance Improvements

* **api:** measure first assistant message latency ([#22750](https://github.com/vm0-ai/vm0/issues/22750)) ([be099fa](https://github.com/vm0-ai/vm0/commit/be099fa84679b4d142af24c110622e1e2bb5dd58))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.220.1
    * @vm0/connectors bumped to 1.187.1
    * @vm0/core bumped to 8.458.2
    * @vm0/db bumped to 1.132.1

## [1.310.0](https://github.com/vm0-ai/vm0/compare/api-v1.309.0...api-v1.310.0) (2026-07-24)


### Features

* **chat:** add strict per-thread message sequence ids ([#22766](https://github.com/vm0-ai/vm0/issues/22766)) ([32fca1f](https://github.com/vm0-ai/vm0/commit/32fca1f3dd20f43d23dc217c290bae496cb6b78c))


### Bug Fixes

* **workflows:** create template drafts before setup ([#22786](https://github.com/vm0-ai/vm0/issues/22786)) ([cad5b07](https://github.com/vm0-ai/vm0/commit/cad5b07ab35c916a0ef8d6caebfab410208246bb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.220.0
    * @vm0/core bumped to 8.458.1
    * @vm0/db bumped to 1.132.0

## [1.309.0](https://github.com/vm0-ai/vm0/compare/api-v1.308.3...api-v1.309.0) (2026-07-23)


### Features

* canonicalize slack attachments and agent-published files ([#22801](https://github.com/vm0-ai/vm0/issues/22801)) ([22f947f](https://github.com/vm0-ai/vm0/commit/22f947f5c533b06efc321ffda43d100fe610edec))


### Refactoring

* **email:** stop inbound agent runs ([#22807](https://github.com/vm0-ai/vm0/issues/22807)) ([bb79fc4](https://github.com/vm0-ai/vm0/commit/bb79fc415971bfb8845b10ca5795d53f72107b79))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.219.0
    * @vm0/connectors bumped to 1.187.0
    * @vm0/core bumped to 8.458.0
    * @vm0/db bumped to 1.131.0

## [1.308.3](https://github.com/vm0-ai/vm0/compare/api-v1.308.2...api-v1.308.3) (2026-07-23)


### Refactoring

* **api:** consume canonical connector catalog snapshot ([#22721](https://github.com/vm0-ai/vm0/issues/22721)) ([4c92cfa](https://github.com/vm0-ai/vm0/commit/4c92cfa5e96b61351cd42ba7ca55a252b88d37cf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.218.1
    * @vm0/connectors bumped to 1.186.1
    * @vm0/core bumped to 8.457.3
    * @vm0/db bumped to 1.130.3

## [1.308.2](https://github.com/vm0-ai/vm0/compare/api-v1.308.1...api-v1.308.2) (2026-07-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.218.0
    * @vm0/connectors bumped to 1.186.0
    * @vm0/core bumped to 8.457.2
    * @vm0/db bumped to 1.130.2

## [1.308.1](https://github.com/vm0-ai/vm0/compare/api-v1.308.0...api-v1.308.1) (2026-07-23)


### Bug Fixes

* use app url for connector action links ([#22748](https://github.com/vm0-ai/vm0/issues/22748)) ([0121552](https://github.com/vm0-ai/vm0/commit/01215521ae72717b37e746480c84e9bbc7fca3d9))


### Refactoring

* **api:** replace atomic org credit upserts with builders ([#22756](https://github.com/vm0-ai/vm0/issues/22756)) ([53146a3](https://github.com/vm0-ai/vm0/commit/53146a3223c115f9743aebeb890bcae51441ebc1))


### Performance Improvements

* **api:** reduce chat thread read query overhead ([#22747](https://github.com/vm0-ai/vm0/issues/22747)) ([aa4568c](https://github.com/vm0-ai/vm0/commit/aa4568c098898080cdd6a6e2f049f4c78548c4f7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.457.1
    * @vm0/db bumped to 1.130.1

## [1.308.0](https://github.com/vm0-ai/vm0/compare/api-v1.307.0...api-v1.308.0) (2026-07-23)


### Features

* add managed weather and air quality commands ([#22670](https://github.com/vm0-ai/vm0/issues/22670)) ([f03e33f](https://github.com/vm0-ai/vm0/commit/f03e33f34134d9de0ea8dd0d5422dcd135f42bd3))
* simplify morning brief emails ([#22720](https://github.com/vm0-ai/vm0/issues/22720)) ([35bd772](https://github.com/vm0-ai/vm0/commit/35bd772c3f8e69bab490b69aa9600d8cad9fc196))


### Bug Fixes

* **chat:** use structured prompts in derived message views ([#22702](https://github.com/vm0-ai/vm0/issues/22702)) ([98e48c2](https://github.com/vm0-ai/vm0/commit/98e48c25c95668f600ccdb5a00f97ae592cac52d))


### Refactoring

* **platform:** remove image editing ([#22712](https://github.com/vm0-ai/vm0/issues/22712)) ([96bcedb](https://github.com/vm0-ai/vm0/commit/96bcedb673c1e8f3049981a446aec89024060cfa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.217.0
    * @vm0/connectors bumped to 1.185.0
    * @vm0/core bumped to 8.457.0
    * @vm0/db bumped to 1.130.0

## [1.307.0](https://github.com/vm0-ai/vm0/compare/api-v1.306.3...api-v1.307.0) (2026-07-23)


### Features

* gate presentation pptx export and google slides upload ([#22695](https://github.com/vm0-ai/vm0/issues/22695)) ([b535773](https://github.com/vm0-ai/vm0/commit/b535773de642e5bbf03449ea740d7d72f191d247))


### Bug Fixes

* **api:** preserve Slack thinking status across queue handoff ([#22728](https://github.com/vm0-ai/vm0/issues/22728)) ([22f6eff](https://github.com/vm0-ai/vm0/commit/22f6effdb7db79b056dba5e3e416b9fac0872f4e))
* **desktop:** retire intel mac downloads and builds ([#22711](https://github.com/vm0-ai/vm0/issues/22711)) ([b24adec](https://github.com/vm0-ai/vm0/commit/b24adec5910023d8a0feec76fb1428d3aad6d87c))


### Performance Improvements

* **chat:** skip chat message refetch when the created event watermark is already cached locally ([#22718](https://github.com/vm0-ai/vm0/issues/22718)) ([1f4268e](https://github.com/vm0-ai/vm0/commit/1f4268e6eba136d2d6b176905a1e1fbc56bd7290))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.216.6
    * @vm0/connectors bumped to 1.184.0
    * @vm0/core bumped to 8.456.0
    * @vm0/db bumped to 1.129.6

## [1.306.3](https://github.com/vm0-ai/vm0/compare/api-v1.306.2...api-v1.306.3) (2026-07-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.216.5
    * @vm0/connectors bumped to 1.183.0
    * @vm0/core bumped to 8.455.0
    * @vm0/db bumped to 1.129.5

## [1.306.2](https://github.com/vm0-ai/vm0/compare/api-v1.306.1...api-v1.306.2) (2026-07-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.216.4
    * @vm0/connectors bumped to 1.182.2
    * @vm0/core bumped to 8.454.1
    * @vm0/db bumped to 1.129.4

## [1.306.1](https://github.com/vm0-ai/vm0/compare/api-v1.306.0...api-v1.306.1) (2026-07-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.216.3
    * @vm0/connectors bumped to 1.182.1
    * @vm0/core bumped to 8.454.0
    * @vm0/db bumped to 1.129.3

## [1.306.0](https://github.com/vm0-ai/vm0/compare/api-v1.305.1...api-v1.306.0) (2026-07-23)


### Features

* **billing:** use fixed unit price for credit purchases ([#22638](https://github.com/vm0-ai/vm0/issues/22638)) ([f3ebe4d](https://github.com/vm0-ai/vm0/commit/f3ebe4dca3319e0242b17edd673668f6dc6d33ca))


### Bug Fixes

* **chat:** use structured incomplete-round context ([#22654](https://github.com/vm0-ai/vm0/issues/22654)) ([881a680](https://github.com/vm0-ai/vm0/commit/881a680e3ede0fde2bcba0f20e5eff6044f0c813))
* restore thinking status for canonical slack threads ([#22668](https://github.com/vm0-ai/vm0/issues/22668)) ([ce0a1b7](https://github.com/vm0-ai/vm0/commit/ce0a1b7124ac2de934e47e41e91ae2c44ca9f494))
* stop usage settlement billing refreshes ([#22667](https://github.com/vm0-ai/vm0/issues/22667)) ([53ce6a5](https://github.com/vm0-ai/vm0/commit/53ce6a5ce479bd77d6d54e99272b7e53590ef3d2))


### Refactoring

* **api:** stop legacy storage state writes ([#22642](https://github.com/vm0-ai/vm0/issues/22642)) ([1a0b25b](https://github.com/vm0-ai/vm0/commit/1a0b25b9216785792135b2be17efe7e954bce182))
* **memory:** retire viewer and activity runtime ([#22655](https://github.com/vm0-ai/vm0/issues/22655)) ([1f8a11f](https://github.com/vm0-ai/vm0/commit/1f8a11fadc8893e5e87a00c3d6cdf6e986afcf4f))


### Performance Improvements

* **api:** make queue-first chat launches atomic ([#22611](https://github.com/vm0-ai/vm0/issues/22611)) ([7b7d681](https://github.com/vm0-ai/vm0/commit/7b7d6819c0a0a4a974d5cc6111fc0342cfd83ef6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.216.2
    * @vm0/connectors bumped to 1.182.0
    * @vm0/core bumped to 8.453.3
    * @vm0/db bumped to 1.129.2

## [1.305.1](https://github.com/vm0-ai/vm0/compare/api-v1.305.0...api-v1.305.1) (2026-07-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.216.1
    * @vm0/connectors bumped to 1.181.1
    * @vm0/core bumped to 8.453.2
    * @vm0/db bumped to 1.129.1

## [1.305.0](https://github.com/vm0-ai/vm0/compare/api-v1.304.1...api-v1.305.0) (2026-07-23)


### Features

* link slack chat messages to their source ([#22633](https://github.com/vm0-ai/vm0/issues/22633)) ([83351c6](https://github.com/vm0-ai/vm0/commit/83351c64b87880a39ba90103754b350f491281d0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.216.0
    * @vm0/core bumped to 8.453.1
    * @vm0/db bumped to 1.129.0

## [1.304.1](https://github.com/vm0-ai/vm0/compare/api-v1.304.0...api-v1.304.1) (2026-07-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.215.1
    * @vm0/connectors bumped to 1.181.0
    * @vm0/core bumped to 8.453.0
    * @vm0/db bumped to 1.128.1

## [1.304.0](https://github.com/vm0-ai/vm0/compare/api-v1.303.0...api-v1.304.0) (2026-07-23)


### Features

* **storage:** persist canonical mounts for capable runners ([#22594](https://github.com/vm0-ai/vm0/issues/22594)) ([ea2d220](https://github.com/vm0-ai/vm0/commit/ea2d2207727441e9435fe3f53184f768c758a891))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.215.0
    * @vm0/core bumped to 8.452.1
    * @vm0/db bumped to 1.128.0

## [1.303.0](https://github.com/vm0-ai/vm0/compare/api-v1.302.0...api-v1.303.0) (2026-07-22)


### Features

* enable zero scrape for all organizations ([#22599](https://github.com/vm0-ai/vm0/issues/22599)) ([3f0755a](https://github.com/vm0-ai/vm0/commit/3f0755a059742f6c1585b9452dac01c75733abe6))
* make managed zero web search authoritative ([#22544](https://github.com/vm0-ai/vm0/issues/22544)) ([e8e66ce](https://github.com/vm0-ai/vm0/commit/e8e66ce625f8bde4673ed4846eecd8cda15c7fa9))


### Refactoring

* **api:** convert active run lookups to drizzle builders ([#22587](https://github.com/vm0-ai/vm0/issues/22587)) ([8e78e37](https://github.com/vm0-ai/vm0/commit/8e78e37a0becd45abee30e4fe38e8cc29fab4bd5))
* **api:** register connector skills from catalog metadata ([#22606](https://github.com/vm0-ai/vm0/issues/22606)) ([5cc44cf](https://github.com/vm0-ai/vm0/commit/5cc44cfec3b502250b696187b28e388d663e7b2e))
* reduce fallback slop in log search ([#22615](https://github.com/vm0-ai/vm0/issues/22615)) ([a9cf034](https://github.com/vm0-ai/vm0/commit/a9cf034cae6a36968257329677e8d768c35a33d9))
* remove obsolete platform and api compatibility fallbacks ([#22573](https://github.com/vm0-ai/vm0/issues/22573)) ([427124a](https://github.com/vm0-ai/vm0/commit/427124a7d9afa3f174a86b33d213d8ba143e35e1))


### Performance Improvements

* **api:** consolidate chat message metadata lookups ([#22604](https://github.com/vm0-ai/vm0/issues/22604)) ([0c35542](https://github.com/vm0-ai/vm0/commit/0c355425bb2336c46637e607e27af58a5fdc687e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.214.1
    * @vm0/connectors bumped to 1.180.0
    * @vm0/core bumped to 8.452.0
    * @vm0/db bumped to 1.127.1

## [1.302.0](https://github.com/vm0-ai/vm0/compare/api-v1.301.0...api-v1.302.0) (2026-07-22)


### Features

* **api:** register connector skills during catalog sync ([#22586](https://github.com/vm0-ai/vm0/issues/22586)) ([d5635f7](https://github.com/vm0-ai/vm0/commit/d5635f76c5d6e08650e7f2f92bc233fa35f472f0))
* **chat:** make structured prompts authoritative on send ([#22537](https://github.com/vm0-ai/vm0/issues/22537)) ([454772b](https://github.com/vm0-ai/vm0/commit/454772bcd57c585e7ac0fbe64615b04c6862fcb7))
* version hosted site artifacts ([#22553](https://github.com/vm0-ai/vm0/issues/22553)) ([70fe55b](https://github.com/vm0-ai/vm0/commit/70fe55be77ae4736187afb5a0f68b30d609fb4a7))


### CI

* remove per-pr www preview infrastructure ([#22539](https://github.com/vm0-ai/vm0/issues/22539)) ([1aacb72](https://github.com/vm0-ai/vm0/commit/1aacb72ed6b6d22db3f161608e263087123ba9ec))


### Performance Improvements

* **api:** overlap storage and context preparation ([#22581](https://github.com/vm0-ai/vm0/issues/22581)) ([b77ffa3](https://github.com/vm0-ai/vm0/commit/b77ffa3897ec485d9cfcd75513684a5ee51cb0d7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.214.0
    * @vm0/connectors bumped to 1.179.0
    * @vm0/core bumped to 8.451.0
    * @vm0/db bumped to 1.127.0

## [1.301.0](https://github.com/vm0-ai/vm0/compare/api-v1.300.2...api-v1.301.0) (2026-07-22)


### Features

* **billing:** use org plan entitlements for gated actions ([#22498](https://github.com/vm0-ai/vm0/issues/22498)) ([4d2c428](https://github.com/vm0-ai/vm0/commit/4d2c428c66178ec65cae0ff2fb9483a3f3643097))


### Bug Fixes

* **chat:** timestamp queued messages when claimed ([#22561](https://github.com/vm0-ai/vm0/issues/22561)) ([b727717](https://github.com/vm0-ai/vm0/commit/b727717fb6df997d6b68bbd52e4b9082246005ea))
* stop app asset misses from using spa fallback ([#22463](https://github.com/vm0-ai/vm0/issues/22463)) ([4ac650f](https://github.com/vm0-ai/vm0/commit/4ac650fbd2c216b727934975a276e71fd31b08db))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.213.0
    * @vm0/connectors bumped to 1.178.2
    * @vm0/core bumped to 8.450.0
    * @vm0/db bumped to 1.126.0

## [1.300.2](https://github.com/vm0-ai/vm0/compare/api-v1.300.1...api-v1.300.2) (2026-07-22)


### Bug Fixes

* **connectors:** route browser oauth through api.vm0.ai ([#22407](https://github.com/vm0-ai/vm0/issues/22407)) ([141e70e](https://github.com/vm0-ai/vm0/commit/141e70e3c4b94f59ebdc5df480b33308781bb7e5))
* enforce current policy for chat model routes ([#22549](https://github.com/vm0-ai/vm0/issues/22549)) ([aeed00d](https://github.com/vm0-ai/vm0/commit/aeed00db26f4beaf6c4a22e2caf17a2f5112afe8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.212.1
    * @vm0/core bumped to 8.449.0
    * @vm0/db bumped to 1.125.7

## [1.300.1](https://github.com/vm0-ai/vm0/compare/api-v1.300.0...api-v1.300.1) (2026-07-22)


### Bug Fixes

* refresh website template archives ([#22497](https://github.com/vm0-ai/vm0/issues/22497)) ([408b2ce](https://github.com/vm0-ai/vm0/commit/408b2ce6a0e2da4be339e008752575c74bcac15f))


### Performance Improvements

* **api:** skip kms for internal run callbacks ([#22500](https://github.com/vm0-ai/vm0/issues/22500)) ([17e30fe](https://github.com/vm0-ai/vm0/commit/17e30fecd4462a3a05988924881d57b618e3b826))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.448.5
    * @vm0/db bumped to 1.125.6

## [1.300.0](https://github.com/vm0-ai/vm0/compare/api-v1.299.0...api-v1.300.0) (2026-07-22)


### Features

* show next scheduled morning brief send time in settings ([#22515](https://github.com/vm0-ai/vm0/issues/22515)) ([2c5052f](https://github.com/vm0-ai/vm0/commit/2c5052f41d9ff64bfb1b60f525930b3bdbf6706e))


### Bug Fixes

* **api:** extend sandbox token lifetime ([#22502](https://github.com/vm0-ai/vm0/issues/22502)) ([1782b92](https://github.com/vm0-ai/vm0/commit/1782b929542b4e829cc2203f3497ffd1d5aed8f3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.212.0
    * @vm0/core bumped to 8.448.4
    * @vm0/db bumped to 1.125.5

## [1.299.0](https://github.com/vm0-ai/vm0/compare/api-v1.298.0...api-v1.299.0) (2026-07-22)


### Features

* deliver canonical slack chat replies exactly once ([#22496](https://github.com/vm0-ai/vm0/issues/22496)) ([fb8bb00](https://github.com/vm0-ai/vm0/commit/fb8bb0076dd372cb6a23c46e233716d374ee21f1))
* report unread chat threads in the morning brief email ([#22507](https://github.com/vm0-ai/vm0/issues/22507)) ([c94c2d3](https://github.com/vm0-ai/vm0/commit/c94c2d3372d4c79ec011c143a82f04155104636d))
* serve the morning brief unsubscribe page from the platform app ([#22495](https://github.com/vm0-ai/vm0/issues/22495)) ([44b0f9a](https://github.com/vm0-ai/vm0/commit/44b0f9a4de8e8fb4456f80492c694fc38987f44e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.211.0
    * @vm0/core bumped to 8.448.3
    * @vm0/db bumped to 1.125.4

## [1.298.0](https://github.com/vm0-ai/vm0/compare/api-v1.297.1...api-v1.298.0) (2026-07-22)


### Features

* **computer-use:** share chat thread grants with automations ([#22485](https://github.com/vm0-ai/vm0/issues/22485)) ([482c97d](https://github.com/vm0-ai/vm0/commit/482c97d79d9be463b7794a293444dda612784c78))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.210.0
    * @vm0/core bumped to 8.448.2
    * @vm0/db bumped to 1.125.3

## [1.297.1](https://github.com/vm0-ai/vm0/compare/api-v1.297.0...api-v1.297.1) (2026-07-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.209.1
    * @vm0/connectors bumped to 1.178.1
    * @vm0/core bumped to 8.448.1
    * @vm0/db bumped to 1.125.2

## [1.297.0](https://github.com/vm0-ai/vm0/compare/api-v1.296.1...api-v1.297.0) (2026-07-22)


### Features

* **artifacts:** expose artifact update timestamps ([#22402](https://github.com/vm0-ai/vm0/issues/22402)) ([14cb524](https://github.com/vm0-ai/vm0/commit/14cb524e721340826b70c1c4c86633febab1e386))
* **artifacts:** generate video posters on creation ([#22387](https://github.com/vm0-ai/vm0/issues/22387)) ([309920f](https://github.com/vm0-ai/vm0/commit/309920f74b9e17780f4d479b45ed70f1d3458986))


### Refactoring

* clarify connector identity names ([#22442](https://github.com/vm0-ai/vm0/issues/22442)) ([58bafe7](https://github.com/vm0-ai/vm0/commit/58bafe76bf61575a003784d98086dbe958f66051))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.209.0
    * @vm0/connectors bumped to 1.178.0
    * @vm0/core bumped to 8.448.0
    * @vm0/db bumped to 1.125.1

## [1.296.1](https://github.com/vm0-ai/vm0/compare/api-v1.296.0...api-v1.296.1) (2026-07-21)


### Bug Fixes

* preserve github connection during morning brief ([#22457](https://github.com/vm0-ai/vm0/issues/22457)) ([735e24e](https://github.com/vm0-ai/vm0/commit/735e24e0f0a92f6ba95def54183d88255930d096))

## [1.296.0](https://github.com/vm0-ai/vm0/compare/api-v1.295.0...api-v1.296.0) (2026-07-21)


### Features

* **api:** compose external connector runner firewalls ([#22415](https://github.com/vm0-ai/vm0/issues/22415)) ([4f6ee12](https://github.com/vm0-ai/vm0/commit/4f6ee12d71e0df1e49ea86c1fc9d6f285712955e))
* route canonical slack turns through chat message queue ([#22429](https://github.com/vm0-ai/vm0/issues/22429)) ([eddb41b](https://github.com/vm0-ai/vm0/commit/eddb41b47ef26e02468f6fac1926346624e75492))


### Refactoring

* reduce fallback slop in api runtime state ([#22454](https://github.com/vm0-ai/vm0/issues/22454)) ([35cc4c3](https://github.com/vm0-ai/vm0/commit/35cc4c3bd167528427cebe638f30bbd9f0588f52))


### Performance Improvements

* **api:** collapse chat read cursor updates ([#22447](https://github.com/vm0-ai/vm0/issues/22447)) ([879b3b9](https://github.com/vm0-ai/vm0/commit/879b3b910c497be52b9d6349712d4e4b13600737))
* **api:** collapse stored connector snapshot reads ([#22432](https://github.com/vm0-ai/vm0/issues/22432)) ([ce94864](https://github.com/vm0-ai/vm0/commit/ce948647d94086c453cc38d530fb1d5bfc405a57))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.208.0
    * @vm0/connectors bumped to 1.177.0
    * @vm0/core bumped to 8.447.0
    * @vm0/db bumped to 1.125.0

## [1.295.0](https://github.com/vm0-ai/vm0/compare/api-v1.294.0...api-v1.295.0) (2026-07-21)


### Features

* daily morning brief email from github, gmail, and google calendar ([#22408](https://github.com/vm0-ai/vm0/issues/22408)) ([0eee1cd](https://github.com/vm0-ai/vm0/commit/0eee1cd687cafa53f9145aa5479ae57d9814af90))
* migrate www previews to cloudflare ([#22425](https://github.com/vm0-ai/vm0/issues/22425)) ([2c7cfce](https://github.com/vm0-ai/vm0/commit/2c7cfce6172818bc43bcb5b13e8017919b05743c))


### Refactoring

* **artifacts:** remove favorites from artifact synchronization ([#22381](https://github.com/vm0-ai/vm0/issues/22381)) ([7d5f43a](https://github.com/vm0-ai/vm0/commit/7d5f43a87c7493ce1037765da86c12d925d24d7a))
* retire bb0 and public v1 apis ([#22404](https://github.com/vm0-ai/vm0/issues/22404)) ([af4a5f3](https://github.com/vm0-ai/vm0/commit/af4a5f347628a4f533ca7f8a38132e42f350d9c7))
* stop provisioning channel artifact storages ([#22393](https://github.com/vm0-ai/vm0/issues/22393)) ([fd2a259](https://github.com/vm0-ai/vm0/commit/fd2a259acbad18a82933876482f330171dac8d62))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.207.0
    * @vm0/connectors bumped to 1.176.0
    * @vm0/core bumped to 8.446.0
    * @vm0/db bumped to 1.124.0

## [1.294.0](https://github.com/vm0-ai/vm0/compare/api-v1.293.0...api-v1.294.0) (2026-07-21)


### Features

* **artifacts:** load favorites independently ([#22371](https://github.com/vm0-ai/vm0/issues/22371)) ([c4d23d9](https://github.com/vm0-ai/vm0/commit/c4d23d9a5e4c92b323df57d50fb732ec5ccacde1))


### Performance Improvements

* **api:** avoid eager workflow queue encryption ([#22372](https://github.com/vm0-ai/vm0/issues/22372)) ([a7e1846](https://github.com/vm0-ai/vm0/commit/a7e18461a8a3b77181260e4e329eb3425c772521))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.206.0
    * @vm0/connectors bumped to 1.175.0
    * @vm0/core bumped to 8.445.1
    * @vm0/db bumped to 1.123.2

## [1.293.0](https://github.com/vm0-ai/vm0/compare/api-v1.292.0...api-v1.293.0) (2026-07-21)


### Features

* add provider-neutral image attribution url ([#22367](https://github.com/vm0-ai/vm0/issues/22367)) ([5da8a96](https://github.com/vm0-ai/vm0/commit/5da8a96caedd8f35dcd1d91764bf918493d15c17))
* **chat:** persist structured prompts through api and indexeddb ([#22357](https://github.com/vm0-ai/vm0/issues/22357)) ([655136e](https://github.com/vm0-ai/vm0/commit/655136e2d01cbe57ac67af61711b21867eea2d2a))
* **connectors:** use accepted server firewall metadata ([#22348](https://github.com/vm0-ai/vm0/issues/22348)) ([09ec460](https://github.com/vm0-ai/vm0/commit/09ec4607884b3d8b5d16847df1eed9e10cfae28b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.205.0
    * @vm0/connectors bumped to 1.174.0
    * @vm0/core bumped to 8.445.0
    * @vm0/db bumped to 1.123.1

## [1.292.0](https://github.com/vm0-ai/vm0/compare/api-v1.291.1...api-v1.292.0) (2026-07-21)


### Features

* **api:** alert on orphaned queued chat messages ([#22312](https://github.com/vm0-ai/vm0/issues/22312)) ([b7615ae](https://github.com/vm0-ai/vm0/commit/b7615ae6b31f938f8bab8696c9b05b70498f32be))


### Refactoring

* **chat:** make chat_message_queue authoritative for queued messages ([#22311](https://github.com/vm0-ai/vm0/issues/22311)) ([5128f65](https://github.com/vm0-ai/vm0/commit/5128f65071d738fd9d2f3790cb04c625e7835153))
* **chat:** remove mobile unread thread shortcuts ([#22362](https://github.com/vm0-ai/vm0/issues/22362)) ([5233677](https://github.com/vm0-ai/vm0/commit/5233677f553a4437ff34827546189ee8228900c1))
* remove vm0 logs command and its cli-only telemetry read routes ([#22307](https://github.com/vm0-ai/vm0/issues/22307)) ([b98ffd6](https://github.com/vm0-ai/vm0/commit/b98ffd600f6fd6379e19c91259fdf15ebbbc24ce))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.204.0
    * @vm0/connectors bumped to 1.173.4
    * @vm0/core bumped to 8.444.4
    * @vm0/db bumped to 1.123.0

## [1.291.1](https://github.com/vm0-ai/vm0/compare/api-v1.291.0...api-v1.291.1) (2026-07-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.203.4
    * @vm0/connectors bumped to 1.173.3
    * @vm0/core bumped to 8.444.3
    * @vm0/db bumped to 1.122.4

## [1.291.0](https://github.com/vm0-ai/vm0/compare/api-v1.290.1...api-v1.291.0) (2026-07-21)


### Features

* support custom credits in atom grant invoices ([#22030](https://github.com/vm0-ai/vm0/issues/22030)) ([d80a7b0](https://github.com/vm0-ai/vm0/commit/d80a7b02bb25db892f60c51a6971482894c91ba8))


### Refactoring

* **api:** enforce connector credential ownership invariants ([#22266](https://github.com/vm0-ai/vm0/issues/22266)) ([df7bece](https://github.com/vm0-ai/vm0/commit/df7bece5c31b95007976a1b00118e271a8067554))


### Performance Improvements

* **api:** batch chat search context queries ([#22308](https://github.com/vm0-ai/vm0/issues/22308)) ([bbc97f7](https://github.com/vm0-ai/vm0/commit/bbc97f7fcbb0fb84922b0edb52bcc8b7ac515391))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.203.3
    * @vm0/connectors bumped to 1.173.2
    * @vm0/core bumped to 8.444.2
    * @vm0/db bumped to 1.122.3

## [1.290.1](https://github.com/vm0-ai/vm0/compare/api-v1.290.0...api-v1.290.1) (2026-07-21)


### Refactoring

* **api:** eliminate unsafe sql.raw usage ([#22271](https://github.com/vm0-ai/vm0/issues/22271)) ([e29eb69](https://github.com/vm0-ai/vm0/commit/e29eb69bc2c360298dfb6178de356f06db60b5d1))
* remove workflow queue trigger identifier ([#22268](https://github.com/vm0-ai/vm0/issues/22268)) ([b01589d](https://github.com/vm0-ai/vm0/commit/b01589dff4a18427b99a73ae2c77fe1a0f336c84))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.203.2
    * @vm0/core bumped to 8.444.1
    * @vm0/db bumped to 1.122.2

## [1.290.0](https://github.com/vm0-ai/vm0/compare/api-v1.289.0...api-v1.290.0) (2026-07-21)


### Features

* enable connector action callbacks for all users ([#22259](https://github.com/vm0-ai/vm0/issues/22259)) ([6814796](https://github.com/vm0-ai/vm0/commit/68147969deb3c57ae57a820360f4db5bee087021))


### Bug Fixes

* derive cloudflare app preview urls in cli and desktop ([#22253](https://github.com/vm0-ai/vm0/issues/22253)) ([b61b678](https://github.com/vm0-ai/vm0/commit/b61b678b2af53393738dbad794a2a41dd8731601))
* **runner:** prevent claim rejection rediscovery loops ([#22250](https://github.com/vm0-ai/vm0/issues/22250)) ([068c509](https://github.com/vm0-ai/vm0/commit/068c509eb9b9e864fb4665c1bc8450a3d9bfbd37))


### Refactoring

* prepare workflow queue identifier contract ([#22260](https://github.com/vm0-ai/vm0/issues/22260)) ([50f4f7f](https://github.com/vm0-ai/vm0/commit/50f4f7f7b5b65601ee08586a7a8398498a4475b5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.203.1
    * @vm0/connectors bumped to 1.173.1
    * @vm0/core bumped to 8.444.0
    * @vm0/db bumped to 1.122.1

## [1.289.0](https://github.com/vm0-ai/vm0/compare/api-v1.288.0...api-v1.289.0) (2026-07-20)


### Features

* **api:** activate connector credential ownership ([#22212](https://github.com/vm0-ai/vm0/issues/22212)) ([54af3e2](https://github.com/vm0-ai/vm0/commit/54af3e2fb9b890901c03efe8d6abb45e59e6b927))


### Refactoring

* **api:** enforce structured sql result mapping ([#22197](https://github.com/vm0-ai/vm0/issues/22197)) ([a2df783](https://github.com/vm0-ai/vm0/commit/a2df7831713e1ed80ede73e811412f0adf981752))
* **api:** remove blanket raw sql lint ratchet ([#22242](https://github.com/vm0-ai/vm0/issues/22242)) ([3fdb739](https://github.com/vm0-ai/vm0/commit/3fdb739c635088c1185ab9a143f8e865f5271fdc))
* **api:** replace raw sql predicates with drizzle operators in nine services ([#22237](https://github.com/vm0-ai/vm0/issues/22237)) ([c3b4612](https://github.com/vm0-ai/vm0/commit/c3b46127ab70b747935b69b4c26bef6220998b35)), closes [#22106](https://github.com/vm0-ai/vm0/issues/22106)
* reduce fallback slop in slack oauth ([#22254](https://github.com/vm0-ai/vm0/issues/22254)) ([7c4ed68](https://github.com/vm0-ai/vm0/commit/7c4ed680d790bd9f7c07a2920931518f8505404c))


### Performance Improvements

* **api:** reduce zero bootstrap snapshot cost ([#22214](https://github.com/vm0-ai/vm0/issues/22214)) ([bfc03ff](https://github.com/vm0-ai/vm0/commit/bfc03ff0070ad96ab9a3c259f6c322e73e4c9748))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.203.0
    * @vm0/core bumped to 8.443.1
    * @vm0/db bumped to 1.122.0

## [1.288.0](https://github.com/vm0-ai/vm0/compare/api-v1.287.0...api-v1.288.0) (2026-07-20)


### Features

* gate refreshed website template packages ([#22222](https://github.com/vm0-ai/vm0/issues/22222)) ([d1059c0](https://github.com/vm0-ai/vm0/commit/d1059c0b51a98376509587161183d207b8f8952e))


### Refactoring

* **runner:** remove claim resource telemetry ([#22230](https://github.com/vm0-ai/vm0/issues/22230)) ([cbb2bf1](https://github.com/vm0-ai/vm0/commit/cbb2bf1b10c9b2364d7f13b2b8d7409f35c2f360))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.202.5
    * @vm0/connectors bumped to 1.173.0
    * @vm0/core bumped to 8.443.0
    * @vm0/db bumped to 1.121.5

## [1.287.0](https://github.com/vm0-ai/vm0/compare/api-v1.286.4...api-v1.287.0) (2026-07-20)


### Features

* **lint:** ban hand-written drizzle raw sql behind a file allowlist ([#22158](https://github.com/vm0-ai/vm0/issues/22158)) ([53a6dbd](https://github.com/vm0-ai/vm0/commit/53a6dbd43d11e707e0e9cfbd6c91c97b930bedcf))


### Refactoring

* canonicalize workflow queue automation IDs ([#22151](https://github.com/vm0-ai/vm0/issues/22151)) ([af2f5fd](https://github.com/vm0-ai/vm0/commit/af2f5fd4e7381372388e5ba597b27b33de9899fb))
* graduate website templates to always-on ([#22209](https://github.com/vm0-ai/vm0/issues/22209)) ([9c1a75a](https://github.com/vm0-ai/vm0/commit/9c1a75ab743c243447eb8f850c61a89cae177422))
* **runner:** remove generation claim attribution ([#22201](https://github.com/vm0-ai/vm0/issues/22201)) ([5f0d316](https://github.com/vm0-ai/vm0/commit/5f0d316ccb916fd575b0fe93f23061cb88dc4df7))


### Performance Improvements

* **artifacts:** sync artifact updates incrementally ([#22190](https://github.com/vm0-ai/vm0/issues/22190)) ([d6875b3](https://github.com/vm0-ai/vm0/commit/d6875b307c961321442f4a15c37d96a188860845))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.202.4
    * @vm0/connectors bumped to 1.172.2
    * @vm0/core bumped to 8.442.3
    * @vm0/db bumped to 1.121.4

## [1.286.4](https://github.com/vm0-ai/vm0/compare/api-v1.286.3...api-v1.286.4) (2026-07-20)


### Refactoring

* **api:** validate structured sql result rows ([#22160](https://github.com/vm0-ai/vm0/issues/22160)) ([64b23fb](https://github.com/vm0-ai/vm0/commit/64b23fba25b78252a1378e3d42324fe561f040ab))

## [1.286.3](https://github.com/vm0-ai/vm0/compare/api-v1.286.2...api-v1.286.3) (2026-07-20)


### Bug Fixes

* stop user-deletion s3 cleanup from deleting other users' storage objects via shared prefixes ([#22152](https://github.com/vm0-ai/vm0/issues/22152)) ([9c839c8](https://github.com/vm0-ai/vm0/commit/9c839c85ac9e4cf6ddc95a7f9f10d29d9d200672))


### Refactoring

* **api:** validate raw execute result rows ([#22143](https://github.com/vm0-ai/vm0/issues/22143)) ([1a9a8dc](https://github.com/vm0-ai/vm0/commit/1a9a8dc2224d8a794d3471b1d7584894e404a170))
* prepare connector credential storage persistence ([#22141](https://github.com/vm0-ai/vm0/issues/22141)) ([9f9587c](https://github.com/vm0-ai/vm0/commit/9f9587c3aa888d2365b1f47f7695bc8355d2d0c4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.202.3
    * @vm0/connectors bumped to 1.172.1
    * @vm0/core bumped to 8.442.2
    * @vm0/db bumped to 1.121.3

## [1.286.2](https://github.com/vm0-ai/vm0/compare/api-v1.286.1...api-v1.286.2) (2026-07-19)


### Performance Improvements

* **storage:** propagate encoded archive sizes ([#22142](https://github.com/vm0-ai/vm0/issues/22142)) ([10fc760](https://github.com/vm0-ai/vm0/commit/10fc7608fdd82ab064da0dfc280667bba0cd64a8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.202.2
    * @vm0/core bumped to 8.442.1
    * @vm0/db bumped to 1.121.2

## [1.286.1](https://github.com/vm0-ai/vm0/compare/api-v1.286.0...api-v1.286.1) (2026-07-19)


### Bug Fixes

* **api:** decode workflow timestamps in bootstrap snapshot ([#22121](https://github.com/vm0-ai/vm0/issues/22121)) ([53de781](https://github.com/vm0-ai/vm0/commit/53de781043b38f450d09b22b8d8c85852fd2b234))

## [1.286.0](https://github.com/vm0-ai/vm0/compare/api-v1.285.0...api-v1.286.0) (2026-07-19)


### Features

* remove workflow queue feature switch and legacy dispatch paths ([#22091](https://github.com/vm0-ai/vm0/issues/22091)) ([ecde8ca](https://github.com/vm0-ai/vm0/commit/ecde8caec9fcb742a79102a9ef3778f62f46eb38))


### Refactoring

* reduce fallback slop in teams activity handling ([#22086](https://github.com/vm0-ai/vm0/issues/22086)) ([b93235a](https://github.com/vm0-ai/vm0/commit/b93235a36164caf66671283feb605f3868c2961d))


### Performance Improvements

* **api:** collapse zero bootstrap reads ([#22084](https://github.com/vm0-ai/vm0/issues/22084)) ([1879581](https://github.com/vm0-ai/vm0/commit/18795818b13bba43b3985ed5ad434d7114ad08a0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.202.1
    * @vm0/connectors bumped to 1.172.0
    * @vm0/core bumped to 8.442.0
    * @vm0/db bumped to 1.121.1

## [1.285.0](https://github.com/vm0-ai/vm0/compare/api-v1.284.0...api-v1.285.0) (2026-07-18)


### Features

* **api:** drive connector credentials from runtime catalog ([#21886](https://github.com/vm0-ai/vm0/issues/21886)) ([94adb1e](https://github.com/vm0-ai/vm0/commit/94adb1eee0622505eafdadb19a497f26278c6d36))
* **mail:** link gmail drafts for read-only review ([#22074](https://github.com/vm0-ai/vm0/issues/22074)) ([a56d364](https://github.com/vm0-ai/vm0/commit/a56d364854f85d81e6315e1755e6b9974d1ba13a))
* **platform:** recognize okou.ai as a production clerk satellite ([#22063](https://github.com/vm0-ai/vm0/issues/22063)) ([4c18b84](https://github.com/vm0-ai/vm0/commit/4c18b846ebe689323fcd214f956f8a326c580060))


### Bug Fixes

* require canonical automation id for workflow callbacks ([#22060](https://github.com/vm0-ai/vm0/issues/22060)) ([0f41a1d](https://github.com/vm0-ai/vm0/commit/0f41a1dbf224715d4b187a4383d3681fb0b9a0c2))
* **runner:** reject stale heartbeat snapshots ([#22076](https://github.com/vm0-ai/vm0/issues/22076)) ([d91617a](https://github.com/vm0-ai/vm0/commit/d91617a24c17a394a9836033548808350dcc05db))


### Refactoring

* **mail:** publish draft cards through assistant links ([#22069](https://github.com/vm0-ai/vm0/issues/22069)) ([14a7584](https://github.com/vm0-ai/vm0/commit/14a758448046133eb93f797beab2c8b41b376ad5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.202.0
    * @vm0/connectors bumped to 1.171.0
    * @vm0/core bumped to 8.441.1
    * @vm0/db bumped to 1.121.0

## [1.284.0](https://github.com/vm0-ai/vm0/compare/api-v1.283.3...api-v1.284.0) (2026-07-18)


### Features

* **mail:** back chat draft cards with gmail drafts ([#22044](https://github.com/vm0-ai/vm0/issues/22044)) ([60cbc99](https://github.com/vm0-ai/vm0/commit/60cbc992fe47ac48716790110b5ff58b37fcdd6c))
* resume chats after connector access actions ([#22043](https://github.com/vm0-ai/vm0/issues/22043)) ([81d91ce](https://github.com/vm0-ai/vm0/commit/81d91cefce67110bec98e230313887e47179fb53))


### Bug Fixes

* **chat:** preserve sessions between gpt and auto ([#22046](https://github.com/vm0-ai/vm0/issues/22046)) ([ffd6e0b](https://github.com/vm0-ai/vm0/commit/ffd6e0b8dbd8381a329402c3107bfa18666bdcb1))


### Refactoring

* **chat:** centralize append-only message mutations ([#22033](https://github.com/vm0-ai/vm0/issues/22033)) ([74cccc1](https://github.com/vm0-ai/vm0/commit/74cccc1e1775c24c08cfebfcdbed446bc9a58649))
* **runner:** remove affinity rollout compatibility ([#22021](https://github.com/vm0-ai/vm0/issues/22021)) ([8cc7c76](https://github.com/vm0-ai/vm0/commit/8cc7c76552a1f0bbf9361b0b26721fc36867dc12))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.201.0
    * @vm0/connectors bumped to 1.170.0
    * @vm0/core bumped to 8.441.0
    * @vm0/db bumped to 1.120.0

## [1.283.3](https://github.com/vm0-ai/vm0/compare/api-v1.283.2...api-v1.283.3) (2026-07-17)


### Bug Fixes

* **agent:** prefer workspace directory in runtime prompt ([#22009](https://github.com/vm0-ai/vm0/issues/22009)) ([8407c01](https://github.com/vm0-ai/vm0/commit/8407c017b06b5e7203e4723f220cb740058d43e5))


### Refactoring

* reduce fallback slop in slack oauth ([#22025](https://github.com/vm0-ai/vm0/issues/22025)) ([e0d6f42](https://github.com/vm0-ai/vm0/commit/e0d6f4271e3826e63c950ef97c23db252671dce8))


### Performance Improvements

* **api:** load persisted run environment in one statement ([#22020](https://github.com/vm0-ai/vm0/issues/22020)) ([c6817df](https://github.com/vm0-ai/vm0/commit/c6817df2686b90e893c054192ed341f999c1c596))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.200.4
    * @vm0/core bumped to 8.440.1
    * @vm0/db bumped to 1.119.5

## [1.283.2](https://github.com/vm0-ai/vm0/compare/api-v1.283.1...api-v1.283.2) (2026-07-17)


### Bug Fixes

* **api:** spend usage allowance before credits for all billable usage ([#21987](https://github.com/vm0-ai/vm0/issues/21987)) ([e144db9](https://github.com/vm0-ai/vm0/commit/e144db92fdf67ea34b6e83ca85430097e428e90a))
* update stripe customer default card after payment ([#21989](https://github.com/vm0-ai/vm0/issues/21989)) ([e3afc21](https://github.com/vm0-ai/vm0/commit/e3afc213f621566f131148959f44e1f0dd6b1132))

## [1.283.1](https://github.com/vm0-ai/vm0/compare/api-v1.283.0...api-v1.283.1) (2026-07-17)


### Bug Fixes

* fall back to attached card for auto-recharge ([#21986](https://github.com/vm0-ai/vm0/issues/21986)) ([ef3ee72](https://github.com/vm0-ai/vm0/commit/ef3ee723948a9e9a91add672b7a0468ce32dc116))

## [1.283.0](https://github.com/vm0-ai/vm0/compare/api-v1.282.4...api-v1.283.0) (2026-07-17)


### Features

* enable website templates rollout ([#21203](https://github.com/vm0-ai/vm0/issues/21203)) ([5a16112](https://github.com/vm0-ai/vm0/commit/5a161121a2fdfaffcd38c87755fdeb05d849c665))


### Performance Improvements

* **runner:** attribute generation-specific workspace sidecars ([#21972](https://github.com/vm0-ai/vm0/issues/21972)) ([315f271](https://github.com/vm0-ai/vm0/commit/315f27174d6a759204e378a793acf03ed89bddd8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.200.3
    * @vm0/core bumped to 8.440.0
    * @vm0/db bumped to 1.119.4

## [1.282.4](https://github.com/vm0-ai/vm0/compare/api-v1.282.3...api-v1.282.4) (2026-07-17)


### Bug Fixes

* rename vm0 model to auto ([#21969](https://github.com/vm0-ai/vm0/issues/21969)) ([aa7fd46](https://github.com/vm0-ai/vm0/commit/aa7fd46efde4f8400539a53adf71461105cb4aa5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.200.2
    * @vm0/core bumped to 8.439.2
    * @vm0/db bumped to 1.119.3

## [1.282.3](https://github.com/vm0-ai/vm0/compare/api-v1.282.2...api-v1.282.3) (2026-07-17)


### Refactoring

* **platform:** cache chat blocks and share permission card signals ([#21919](https://github.com/vm0-ai/vm0/issues/21919)) ([f04823d](https://github.com/vm0-ai/vm0/commit/f04823da274101b5a921bce0c3eb6246e8f89f75))

## [1.282.2](https://github.com/vm0-ai/vm0/compare/api-v1.282.1...api-v1.282.2) (2026-07-17)


### Bug Fixes

* **api:** cache clerk identity reads in e2e setup ([#21909](https://github.com/vm0-ai/vm0/issues/21909)) ([5dbe55f](https://github.com/vm0-ai/vm0/commit/5dbe55fd1cc4f5f63eed4141c9c7ec2075d82955))


### Documentation

* **api:** clarify dev seed database contents ([#21891](https://github.com/vm0-ai/vm0/issues/21891)) ([bb18877](https://github.com/vm0-ai/vm0/commit/bb1887759521fb7a1c6cc320767a9bcc61ef35f0))


### Refactoring

* **api:** remove legacy web client compatibility endpoint ([#21915](https://github.com/vm0-ai/vm0/issues/21915)) ([f899f65](https://github.com/vm0-ai/vm0/commit/f899f65e7d2977cd0207432f10621d8ff0c81d58))
* **runner:** add generic workspace affinity resource classes ([#21888](https://github.com/vm0-ai/vm0/issues/21888)) ([92bf6af](https://github.com/vm0-ai/vm0/commit/92bf6af909f9aa3666a256edbfdad016b94947a6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.200.1
    * @vm0/core bumped to 8.439.1
    * @vm0/db bumped to 1.119.2

## [1.282.1](https://github.com/vm0-ai/vm0/compare/api-v1.282.0...api-v1.282.1) (2026-07-16)


### Bug Fixes

* **db:** enforce append-only chat event tables ([#21903](https://github.com/vm0-ai/vm0/issues/21903)) ([880cffc](https://github.com/vm0-ai/vm0/commit/880cffc307658b6fd865b233c5a7675271a965fd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.119.1

## [1.282.0](https://github.com/vm0-ai/vm0/compare/api-v1.281.1...api-v1.282.0) (2026-07-16)


### Features

* add kimi k3 pricing and managed keys ([#21892](https://github.com/vm0-ai/vm0/issues/21892)) ([5b5901f](https://github.com/vm0-ai/vm0/commit/5b5901f21453723a299ab0c71d1a47ce3d14cf87))


### Refactoring

* reduce fallback slop in cli auth ([#21898](https://github.com/vm0-ai/vm0/issues/21898)) ([89601f9](https://github.com/vm0-ai/vm0/commit/89601f96e1216c34fcf8202860f50a2eaa74bcfb))
* remove relationship memory experiments ([#21890](https://github.com/vm0-ai/vm0/issues/21890)) ([2009691](https://github.com/vm0-ai/vm0/commit/2009691cb46549e3c79304cfc5a4658be2091720))


### Performance Improvements

* **api:** bulk upsert development seed data ([#21894](https://github.com/vm0-ai/vm0/issues/21894)) ([a3eddfb](https://github.com/vm0-ai/vm0/commit/a3eddfb32d9b665f87d746b241d99d12b63702e6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.200.0
    * @vm0/connectors bumped to 1.169.1
    * @vm0/core bumped to 8.439.0
    * @vm0/db bumped to 1.119.0

## [1.281.1](https://github.com/vm0-ai/vm0/compare/api-v1.281.0...api-v1.281.1) (2026-07-16)


### Bug Fixes

* **chat:** append insufficient-credit replacements ([#21884](https://github.com/vm0-ai/vm0/issues/21884)) ([9bd1ec4](https://github.com/vm0-ai/vm0/commit/9bd1ec4f6c43a3e466ad305b336d518a4e345007))
* **chat:** restore append-only queued message claims ([#21883](https://github.com/vm0-ai/vm0/issues/21883)) ([c4ba9fd](https://github.com/vm0-ai/vm0/commit/c4ba9fd85a3010950cd95cc2be0db75fc2997472))
* emit one complete usage chat message per run ([#21885](https://github.com/vm0-ai/vm0/issues/21885)) ([6a0446d](https://github.com/vm0-ai/vm0/commit/6a0446db9ab725dc26017308bef383f11a8e8a60))


### Refactoring

* **mail:** store email drafts outside chat messages ([#21887](https://github.com/vm0-ai/vm0/issues/21887)) ([b269ede](https://github.com/vm0-ai/vm0/commit/b269edec386afe0413eddb62bfc90c046a91be89))
* **runner:** publish profile-qualified workspace cache state ([#21874](https://github.com/vm0-ai/vm0/issues/21874)) ([68b399b](https://github.com/vm0-ai/vm0/commit/68b399b571023b63db4a2f4f625eef1c9ded9b48))


### Performance Improvements

* **api:** collapse resumed-session resolution into one snapshot query ([#21872](https://github.com/vm0-ai/vm0/issues/21872)) ([856b69d](https://github.com/vm0-ai/vm0/commit/856b69d5cee4241d1f0b09cad1b58747a68d6c2d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.199.1
    * @vm0/core bumped to 8.438.1
    * @vm0/db bumped to 1.118.1

## [1.281.0](https://github.com/vm0-ai/vm0/compare/api-v1.280.2...api-v1.281.0) (2026-07-16)


### Features

* bill model usage from signed proxy price schedules ([#21696](https://github.com/vm0-ai/vm0/issues/21696)) ([e4c9fc7](https://github.com/vm0-ai/vm0/commit/e4c9fc72ec4004b8ff6db197c6e4ee1a888e9d30))
* enable workflow queue for all orgs ([#21853](https://github.com/vm0-ai/vm0/issues/21853)) ([5076e79](https://github.com/vm0-ai/vm0/commit/5076e79781786049aa346dcd908661388dbe7a3a))


### Bug Fixes

* **cli:** enforce source-first image template generation ([#21472](https://github.com/vm0-ai/vm0/issues/21472)) ([e686661](https://github.com/vm0-ai/vm0/commit/e686661b6fe100cbf821810daf9b1d00a587fc78))


### Performance Improvements

* **api:** lower postgres dns hedge delay and attribute budget misses ([#21846](https://github.com/vm0-ai/vm0/issues/21846)) ([a29eb59](https://github.com/vm0-ai/vm0/commit/a29eb5996c49bc329cf42b2f767debb9e1f8f5f8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.199.0
    * @vm0/connectors bumped to 1.169.0
    * @vm0/core bumped to 8.438.0
    * @vm0/db bumped to 1.118.0

## [1.280.2](https://github.com/vm0-ai/vm0/compare/api-v1.280.1...api-v1.280.2) (2026-07-16)


### Refactoring

* switch automation identifier writes ([#21839](https://github.com/vm0-ai/vm0/issues/21839)) ([630671e](https://github.com/vm0-ai/vm0/commit/630671e82fc91fdb51cf5bdb251950a98a39f2aa))

## [1.280.1](https://github.com/vm0-ai/vm0/compare/api-v1.280.0...api-v1.280.1) (2026-07-16)


### Bug Fixes

* use app tenant for teams bot replies ([#21782](https://github.com/vm0-ai/vm0/issues/21782)) ([5f35f05](https://github.com/vm0-ai/vm0/commit/5f35f058bc30e375bcb756ac70a105844b251b6a))

## [1.280.0](https://github.com/vm0-ai/vm0/compare/api-v1.279.4...api-v1.280.0) (2026-07-16)


### Features

* prepare external public connector catalog backend ([#21773](https://github.com/vm0-ai/vm0/issues/21773)) ([f0c5204](https://github.com/vm0-ai/vm0/commit/f0c5204903dededbe7a6d88cc44558320bc1e542))


### Bug Fixes

* support dynamic vm0 model routing ([#21693](https://github.com/vm0-ai/vm0/issues/21693)) ([80d0dca](https://github.com/vm0-ai/vm0/commit/80d0dca1f3e198f7c83ed28783da740d2215675f))


### Refactoring

* dual-write automation identifiers across callbacks and chat snapshots ([#21795](https://github.com/vm0-ai/vm0/issues/21795)) ([b8fd86e](https://github.com/vm0-ai/vm0/commit/b8fd86ea8d3c7bf119f4a83e381698d6484120d7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.198.0
    * @vm0/connectors bumped to 1.168.0
    * @vm0/core bumped to 8.437.3
    * @vm0/db bumped to 1.117.3

## [1.279.4](https://github.com/vm0-ai/vm0/compare/api-v1.279.3...api-v1.279.4) (2026-07-16)


### Performance Improvements

* **api:** hedge slow postgres dns lookups ([#21774](https://github.com/vm0-ai/vm0/issues/21774)) ([cbac131](https://github.com/vm0-ai/vm0/commit/cbac1311fc79a065f644ecc01df4ce7e1fed606e))

## [1.279.3](https://github.com/vm0-ai/vm0/compare/api-v1.279.2...api-v1.279.3) (2026-07-16)


### Refactoring

* read queued user messages from chat_message_queue ([#21779](https://github.com/vm0-ai/vm0/issues/21779)) ([dc6a275](https://github.com/vm0-ai/vm0/commit/dc6a27573bf527a04723bfae2d6cf69980ca3191))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.197.2
    * @vm0/connectors bumped to 1.167.0
    * @vm0/core bumped to 8.437.2
    * @vm0/db bumped to 1.117.2

## [1.279.2](https://github.com/vm0-ai/vm0/compare/api-v1.279.1...api-v1.279.2) (2026-07-16)


### Performance Improvements

* **api:** move queue-first invalidation off dispatch path ([#21745](https://github.com/vm0-ai/vm0/issues/21745)) ([206a772](https://github.com/vm0-ai/vm0/commit/206a77208bfade42d519930495ad2e91ce574b71))

## [1.279.1](https://github.com/vm0-ai/vm0/compare/api-v1.279.0...api-v1.279.1) (2026-07-16)


### Refactoring

* remove chat model family session continuity switch ([#21716](https://github.com/vm0-ai/vm0/issues/21716)) ([533031a](https://github.com/vm0-ai/vm0/commit/533031a8c81b20be9e5322e3be94e9d2f1eb2308))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.197.1
    * @vm0/connectors bumped to 1.166.1
    * @vm0/core bumped to 8.437.1
    * @vm0/db bumped to 1.117.1

## [1.279.0](https://github.com/vm0-ai/vm0/compare/api-v1.278.1...api-v1.279.0) (2026-07-16)


### Features

* **api:** reconcile connector catalog compatibility ([#21706](https://github.com/vm0-ai/vm0/issues/21706)) ([b1434dd](https://github.com/vm0-ai/vm0/commit/b1434dde242495914a4e4d6a44b36fc03bfbce85))
* **api:** sync connector catalog snapshots from r2 ([#21568](https://github.com/vm0-ai/vm0/issues/21568)) ([9d38804](https://github.com/vm0-ai/vm0/commit/9d388040f4d502b5c8b63434cab03031f70f7c60))
* enable chat model family session continuity for all users ([#21713](https://github.com/vm0-ai/vm0/issues/21713)) ([a427ac9](https://github.com/vm0-ai/vm0/commit/a427ac9652c276f8f219c0dba5ef458a7ca400d6))
* route vm0-auto through signed usage proxy ([#21437](https://github.com/vm0-ai/vm0/issues/21437)) ([cdb5bee](https://github.com/vm0-ai/vm0/commit/cdb5beeb3617f207570635e1497d57a4f796e329))


### Bug Fixes

* **api:** serve color-system-fixed presentation runbooks ([#21688](https://github.com/vm0-ai/vm0/issues/21688)) ([e7a6bd8](https://github.com/vm0-ai/vm0/commit/e7a6bd884cfd52c7b1e924497c40729935dfb256))
* authorize agents during connector connection ([#21709](https://github.com/vm0-ai/vm0/issues/21709)) ([5edaafc](https://github.com/vm0-ai/vm0/commit/5edaafcdf15ab37c2c96b3584c70f9b145ace20e))
* claim queued chat messages in place ([#21627](https://github.com/vm0-ai/vm0/issues/21627)) ([c47ccc4](https://github.com/vm0-ai/vm0/commit/c47ccc4fa687b5ae369369432b4bad1de6bc9297))
* describe zero scrape capabilities in agent context ([#21574](https://github.com/vm0-ai/vm0/issues/21574)) ([5d5b298](https://github.com/vm0-ai/vm0/commit/5d5b298b1396f2e4c1ee6873d429987fcb9df4cc))


### Refactoring

* **api:** reject invalid x api response bodies ([#21504](https://github.com/vm0-ai/vm0/issues/21504)) ([031cd91](https://github.com/vm0-ai/vm0/commit/031cd91ee1de12038eca264007af1c4bd70348e1))
* remove workflow trigger compatibility surfaces ([#21523](https://github.com/vm0-ai/vm0/issues/21523)) ([88edf69](https://github.com/vm0-ai/vm0/commit/88edf6915fdb75904e866ac8df8107737286c95b))


### Performance Improvements

* **api:** reuse memory candidate rows during final ranking ([#21692](https://github.com/vm0-ai/vm0/issues/21692)) ([b1f3e60](https://github.com/vm0-ai/vm0/commit/b1f3e60d1a8f0c729e03ad872f551ff34d6a786c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.197.0
    * @vm0/connectors bumped to 1.166.0
    * @vm0/core bumped to 8.437.0
    * @vm0/db bumped to 1.117.0

## [1.278.1](https://github.com/vm0-ai/vm0/compare/api-v1.278.0...api-v1.278.1) (2026-07-15)


### Bug Fixes

* require static DOM for HTML presentations ([#21625](https://github.com/vm0-ai/vm0/issues/21625)) ([f55e3a9](https://github.com/vm0-ai/vm0/commit/f55e3a930869187b0195d1dc1eaf967f3eed68ab))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.196.0
    * @vm0/connectors bumped to 1.165.0
    * @vm0/core bumped to 8.436.1
    * @vm0/db bumped to 1.116.1

## [1.278.0](https://github.com/vm0-ai/vm0/compare/api-v1.277.5...api-v1.278.0) (2026-07-15)


### Features

* add artifact favorite api ([#20837](https://github.com/vm0-ai/vm0/issues/20837)) ([5c935ea](https://github.com/vm0-ai/vm0/commit/5c935eab0bc13098bbf06a7503939722a257b5f5))
* add artifact favorite controls ([#20838](https://github.com/vm0-ai/vm0/issues/20838)) ([c7c0bee](https://github.com/vm0-ai/vm0/commit/c7c0bee953d6268e572bfa254a6cdd7bcef86774))
* add artifacts page preview lightbox ([#20889](https://github.com/vm0-ai/vm0/issues/20889)) ([9952a50](https://github.com/vm0-ai/vm0/commit/9952a505c82e354ea432e03977e1b43549b7e8a4))
* add chat_message_queue table and migrate workflow events into it ([#21339](https://github.com/vm0-ai/vm0/issues/21339)) ([83862e6](https://github.com/vm0-ai/vm0/commit/83862e68345be825f2427b8aca5ac9c74ace18ed))
* add dot matrix and frosted scatter website templates ([#20944](https://github.com/vm0-ai/vm0/issues/20944)) ([ab6471c](https://github.com/vm0-ai/vm0/commit/ab6471c0eace009cad8aa87c99f9b1f830a4ade3))
* add gated github and notion memory backfills ([#20801](https://github.com/vm0-ai/vm0/issues/20801)) ([a8fb592](https://github.com/vm0-ai/vm0/commit/a8fb59226bcf1f39e47e62e6c76ccbea5226b950))
* add gpt-5.6 model support ([#20841](https://github.com/vm0-ai/vm0/issues/20841)) ([70d551f](https://github.com/vm0-ai/vm0/commit/70d551f731976130af4a640d571ac2aa2708e100))
* add managed perplexity web search ([#21466](https://github.com/vm0-ai/vm0/issues/21466)) ([ca4786b](https://github.com/vm0-ai/vm0/commit/ca4786b58cb9af5778bf5f66d7843870a5d6a9d8))
* add managed zero scrape ([#20778](https://github.com/vm0-ai/vm0/issues/20778)) ([4e72f67](https://github.com/vm0-ai/vm0/commit/4e72f67713b096f72ba4cab591c440906783e68f))
* add manual connector readiness checks to workflow settings ([#20913](https://github.com/vm0-ai/vm0/issues/20913)) ([98d604b](https://github.com/vm0-ai/vm0/commit/98d604b20841ef60e482e207416b03d056c1cb1f))
* add microsoft teams cli support ([#20489](https://github.com/vm0-ai/vm0/issues/20489)) ([c908d0a](https://github.com/vm0-ai/vm0/commit/c908d0a502222793856de48bb90b5fdadd079a49))
* add nine feature-gated business connectors ([#21277](https://github.com/vm0-ai/vm0/issues/21277)) ([5f08ac9](https://github.com/vm0-ai/vm0/commit/5f08ac9bc73515b1b483114835b26e210b14265b))
* add nintendo store connector ([#20768](https://github.com/vm0-ai/vm0/issues/20768)) ([a84b0e0](https://github.com/vm0-ai/vm0/commit/a84b0e04ba6382380a6b81331aed372d2abe1149))
* add nintendo switch parental controls connector ([#21016](https://github.com/vm0-ai/vm0/issues/21016)) ([a06a01c](https://github.com/vm0-ai/vm0/commit/a06a01ce0798d7d38efd183345c1559c1bdd7bc5))
* add per-workflow trigger event queue with serial drain behind feature switch ([#20882](https://github.com/vm0-ai/vm0/issues/20882)) ([3aec4a8](https://github.com/vm0-ai/vm0/commit/3aec4a898c6ff7891d9dedb6713efbbfbe244412))
* add persistent zero mail review cards ([#21458](https://github.com/vm0-ai/vm0/issues/21458)) ([4f4b056](https://github.com/vm0-ai/vm0/commit/4f4b0562dd32800e5fc6adbc75fd4a8f4cf2444a))
* add workflow queue inspection and control api with per-thread realtime signal ([#20895](https://github.com/vm0-ai/vm0/issues/20895)) ([6c02526](https://github.com/vm0-ai/vm0/commit/6c025261b754d16d25c1a88f5e5e8f37bb9a6dc7)), closes [#20876](https://github.com/vm0-ai/vm0/issues/20876)
* add zero memory document rag substrate ([#20846](https://github.com/vm0-ai/vm0/issues/20846)) ([52f1e35](https://github.com/vm0-ai/vm0/commit/52f1e35b51a72850a5d4a5d0e1cfba89b9382944))
* add zero memory lifecycle api, cli, and ui surfaces ([#20850](https://github.com/vm0-ai/vm0/issues/20850)) ([7ef3ee0](https://github.com/vm0-ai/vm0/commit/7ef3ee0b50901584644ab1ceed240d5c6cd97dcc))
* **agent:** request planned connector permissions together ([#21424](https://github.com/vm0-ai/vm0/issues/21424)) ([a39ef20](https://github.com/vm0-ai/vm0/commit/a39ef207062eece0b44742736d55822e0683718a))
* align teams integration with slack parity ([#20544](https://github.com/vm0-ai/vm0/issues/20544)) ([3212311](https://github.com/vm0-ai/vm0/commit/3212311ffeb24690074c3df51fa02e9cc4045275))
* **api:** add connector permission-deny diagnostics ([#21272](https://github.com/vm0-ai/vm0/issues/21272)) ([da440e9](https://github.com/vm0-ai/vm0/commit/da440e9493305ebf0b541f9120fcecc94c3b1c8f))
* **api:** add connector runtime diagnostics ([#21295](https://github.com/vm0-ai/vm0/issues/21295)) ([3ef7cf3](https://github.com/vm0-ai/vm0/commit/3ef7cf3390c2881236b335172c0db20cbd0bad7f))
* **api:** add workflow automation routes with legacy parity ([#21426](https://github.com/vm0-ai/vm0/issues/21426)) ([bc92379](https://github.com/vm0-ai/vm0/commit/bc923796f156821a399402def0d656c9419e1d84))
* **api:** add workflow automation webhook URL ([#21465](https://github.com/vm0-ai/vm0/issues/21465)) ([a971f50](https://github.com/vm0-ai/vm0/commit/a971f5096b1e41f20b1808f07ac63ce26d6f31fc))
* **api:** register refreshed Playful Launch archive ([#21435](https://github.com/vm0-ai/vm0/issues/21435)) ([1154f45](https://github.com/vm0-ai/vm0/commit/1154f45f2d541e96e340c84675c3afca661e96c9))
* **api:** serve refreshed presentation runbooks compatibly ([#21321](https://github.com/vm0-ai/vm0/issues/21321)) ([eadaba4](https://github.com/vm0-ai/vm0/commit/eadaba4dff87b85de340ef49db65158113553970))
* bill openrouter edit helpers ([#20945](https://github.com/vm0-ai/vm0/issues/20945)) ([825c5fa](https://github.com/vm0-ai/vm0/commit/825c5fa33e400b11470ea51388546c672ca6f354))
* **chat:** preserve sessions across model family switches ([#21544](https://github.com/vm0-ai/vm0/issues/21544)) ([d4cbf9f](https://github.com/vm0-ai/vm0/commit/d4cbf9f1193c009bc86668012ffb3b98a0e5289e))
* **codex:** enable fast mode for gpt-5.6 models ([#21344](https://github.com/vm0-ai/vm0/issues/21344)) ([fb11b7e](https://github.com/vm0-ai/vm0/commit/fb11b7e0a09bcff1e6ee0c2c55f88b3cc3056542))
* **connectors:** make nintendo connectors generally available ([#21526](https://github.com/vm0-ai/vm0/issues/21526)) ([17975ab](https://github.com/vm0-ai/vm0/commit/17975abc762f8909990b8be5db128937123355b5))
* curate default models for new organizations ([#20880](https://github.com/vm0-ai/vm0/issues/20880)) ([c10661e](https://github.com/vm0-ai/vm0/commit/c10661e0a8541f9b1c2e7de8ef7fe46b2d59d4d6))
* default new organizations to luna with ultra reasoning ([#21323](https://github.com/vm0-ai/vm0/issues/21323)) ([d42f4c3](https://github.com/vm0-ai/vm0/commit/d42f4c30743bcb6aa087fd2c077b348b519175ca))
* enable chat message queue for all users ([#21494](https://github.com/vm0-ai/vm0/issues/21494)) ([1cfe5d4](https://github.com/vm0-ai/vm0/commit/1cfe5d4511f61b142c65243b9ab3468967845ce6))
* expose connector catalog icon descriptors ([#21092](https://github.com/vm0-ai/vm0/issues/21092)) ([c0b8e0f](https://github.com/vm0-ai/vm0/commit/c0b8e0f4c485c69884cae063c2c15dd68ea5c112))
* gate stale app clients by version header ([#21225](https://github.com/vm0-ai/vm0/issues/21225)) ([c31bf5d](https://github.com/vm0-ai/vm0/commit/c31bf5d4d43ebc2f303638da849371ae5a8f18af))
* generate poster-frame previews for video artifacts ([#20831](https://github.com/vm0-ai/vm0/issues/20831)) ([f14a997](https://github.com/vm0-ai/vm0/commit/f14a997e3d3abf8f95066a5869475b20fe959d9c))
* **image-editor:** share edited images to x ([#20836](https://github.com/vm0-ai/vm0/issues/20836)) ([fca6111](https://github.com/vm0-ai/vm0/commit/fca611179fda0489a8f92b0edecd5532cbf6ca0d))
* inject connector document rag into zero memory runtime ([#20854](https://github.com/vm0-ai/vm0/issues/20854)) ([d457c9b](https://github.com/vm0-ai/vm0/commit/d457c9b8daaf33dde0c32b46e81baeb66b56f673))
* interpret marked image regions into targeted edits ([#20822](https://github.com/vm0-ai/vm0/issues/20822)) ([62444e3](https://github.com/vm0-ai/vm0/commit/62444e3cb87332aafa869bc413077bbf4626a287))
* migrate member model preferences to workspace default when org removes a model ([#20884](https://github.com/vm0-ai/vm0/issues/20884)) ([fb3cf31](https://github.com/vm0-ai/vm0/commit/fb3cf31d900504b4f0b592175463d6a157d30ee8))
* persist image edit canvas snapshots ([#21266](https://github.com/vm0-ai/vm0/issues/21266)) ([21d21f4](https://github.com/vm0-ai/vm0/commit/21d21f4c3660652f70e9bc8c16f5756a9b1b1f5a))
* queue-first user message dispatch on chat_message_queue behind a feature switch ([#21368](https://github.com/vm0-ai/vm0/issues/21368)) ([791774d](https://github.com/vm0-ai/vm0/commit/791774dad8dca817b273c55b580e6e1a783970b8))
* render static preview images for html/website artifacts ([#20814](https://github.com/vm0-ai/vm0/issues/20814)) ([3b52479](https://github.com/vm0-ai/vm0/commit/3b52479f8c12e00c55b536a4c279809a75ec80ec))
* restrict webhook triggers to team and custom workspaces ([#20966](https://github.com/vm0-ai/vm0/issues/20966)) ([18b727b](https://github.com/vm0-ai/vm0/commit/18b727b45cf337c76b73bf89f9d893eeb4cbd0b5))
* **runner:** make session affinity admission-aware ([#21111](https://github.com/vm0-ai/vm0/issues/21111)) ([ecf0021](https://github.com/vm0-ai/vm0/commit/ecf00216864b70cc5cea5fb0c148aa4f14705b90))
* sync org plan entitlement writes ([#20960](https://github.com/vm0-ai/vm0/issues/20960)) ([c956864](https://github.com/vm0-ai/vm0/commit/c956864a4e43ef30f4acec2f949bcec1141084e4))
* **workflows:** enable webhook trigger creation globally ([#21294](https://github.com/vm0-ai/vm0/issues/21294)) ([515f996](https://github.com/vm0-ai/vm0/commit/515f9963e06ecc1a51c166ff0ead0d7135820512))


### Bug Fixes

* acknowledge incompatible Notion webhook events ([#21165](https://github.com/vm0-ai/vm0/issues/21165)) ([773c9af](https://github.com/vm0-ai/vm0/commit/773c9afa82643658aa06e44d6e504f44599e6992)), closes [#21157](https://github.com/vm0-ai/vm0/issues/21157)
* align artifacts page with chat thread artifacts ([#21193](https://github.com/vm0-ai/vm0/issues/21193)) ([51cf2b5](https://github.com/vm0-ai/vm0/commit/51cf2b53ad62de17cbf68d96498f5c4fdda0c921))
* align teams oauth connect flow ([#21200](https://github.com/vm0-ai/vm0/issues/21200)) ([af0060e](https://github.com/vm0-ai/vm0/commit/af0060e3407d850f46c9f89a8097b368ad80e7ec))
* align typescript tests across local and ci ([#20963](https://github.com/vm0-ai/vm0/issues/20963)) ([1613d7f](https://github.com/vm0-ai/vm0/commit/1613d7fe2ccd6a887acec51f9457eb7c045ec6db))
* allow limited-free billable firewall auth ([#20843](https://github.com/vm0-ai/vm0/issues/20843)) ([ef07fbb](https://github.com/vm0-ai/vm0/commit/ef07fbba1ec3cf8aa820e734c34414aa8f8f2033))
* **api:** classify workflow automation sources across consumers ([#21280](https://github.com/vm0-ai/vm0/issues/21280)) ([59ac3a3](https://github.com/vm0-ai/vm0/commit/59ac3a3ef2ae420e8fee4045acc71c61a963fcce))
* **api:** ignore unknown zero token capabilities ([#20881](https://github.com/vm0-ai/vm0/issues/20881)) ([ccf9783](https://github.com/vm0-ai/vm0/commit/ccf9783625c3a2fc7480b1daf42fbd0109313b52))
* **api:** persist workflow schedule run briefs ([#20839](https://github.com/vm0-ai/vm0/issues/20839)) ([5db9855](https://github.com/vm0-ai/vm0/commit/5db98557afa4fbad5f2ebdcaacad658a1bd78b24))
* **api:** preserve run agent identity across shared versions ([#21064](https://github.com/vm0-ai/vm0/issues/21064)) ([20bd45a](https://github.com/vm0-ai/vm0/commit/20bd45a83893258e745de6f572a6b6a3d974c641))
* **api:** refresh api release marker comment ([#20858](https://github.com/vm0-ai/vm0/issues/20858)) ([4fbd6cd](https://github.com/vm0-ai/vm0/commit/4fbd6cd24590f716066fd5f3038693152e89edc0))
* **api:** require app version 0.599.19 ([#21616](https://github.com/vm0-ai/vm0/issues/21616)) ([14643c9](https://github.com/vm0-ai/vm0/commit/14643c9799fdd5970ee4e818db3b78b8ce182e22))
* authenticate and validate html artifact previews ([#21171](https://github.com/vm0-ai/vm0/issues/21171)) ([9f9ec3b](https://github.com/vm0-ai/vm0/commit/9f9ec3be9e20b0908f1e61a1504511e1b0b2bcff))
* **chat:** refresh workflows created in threads ([#21346](https://github.com/vm0-ai/vm0/issues/21346)) ([f0fa94f](https://github.com/vm0-ai/vm0/commit/f0fa94f2ea913213e65c864944aae6dedd6576d6))
* classify completion failures before retrying ([#21041](https://github.com/vm0-ai/vm0/issues/21041)) ([d28ccb6](https://github.com/vm0-ai/vm0/commit/d28ccb60eafbaa3aac279160c5f8fb2a76fa8e3e)), closes [#21006](https://github.com/vm0-ai/vm0/issues/21006)
* **connectors:** ignore unsupported stored connectors ([#21163](https://github.com/vm0-ai/vm0/issues/21163)) ([3315d83](https://github.com/vm0-ai/vm0/commit/3315d8308784f2833de883ec3590f88900f03be4))
* **connectors:** stabilize firewall hostname validation ([#21378](https://github.com/vm0-ai/vm0/issues/21378)) ([727aa35](https://github.com/vm0-ai/vm0/commit/727aa35803396a0a1a11ca209f5134f83263e935))
* disable chat message queue by default ([#21600](https://github.com/vm0-ai/vm0/issues/21600)) ([837997d](https://github.com/vm0-ai/vm0/commit/837997d45b854d0e19827ad3e8fdef94fb11e344))
* drain queued user messages whenever a thread goes idle ([#21397](https://github.com/vm0-ai/vm0/issues/21397)) ([5ad9069](https://github.com/vm0-ai/vm0/commit/5ad9069e1beb71822539ea9d17f0a7666b873722))
* enable codex subscriptions for gpt 5.6 models ([#20851](https://github.com/vm0-ai/vm0/issues/20851)) ([1dcb103](https://github.com/vm0-ai/vm0/commit/1dcb103fddd113b29a124cbd1de0d24f1da3b8d1))
* enforce org tier capability limits ([#21370](https://github.com/vm0-ai/vm0/issues/21370)) ([70c863e](https://github.com/vm0-ai/vm0/commit/70c863e1931a1412e588d88c8eb76ff33e981c92))
* harden nintendo parental controls credentials ([#21078](https://github.com/vm0-ai/vm0/issues/21078)) ([1360d30](https://github.com/vm0-ai/vm0/commit/1360d30ddf543769b2bf255bc2f444b98f5c86d6))
* improve teams bot validation responses ([#21560](https://github.com/vm0-ai/vm0/issues/21560)) ([7987e90](https://github.com/vm0-ai/vm0/commit/7987e90cd08526c3f95af6bec301ce10c3b9c4e9))
* improve teams okou bot validation ([#21412](https://github.com/vm0-ai/vm0/issues/21412)) ([dff7782](https://github.com/vm0-ai/vm0/commit/dff77826a148be4c983c833efe90ca68da4f0621))
* load webhook automations in chat threads ([#21161](https://github.com/vm0-ai/vm0/issues/21161)) ([2a055dd](https://github.com/vm0-ai/vm0/commit/2a055ddf4da9e119f4b22de228e3d5e7affc6e67))
* **mitm-addon:** fail closed on ambiguous connector owners ([#21109](https://github.com/vm0-ai/vm0/issues/21109)) ([19bc1ca](https://github.com/vm0-ai/vm0/commit/19bc1ca3694afd1ee0b1814c099d8575e1a08534))
* move claimed chat messages out of the composer queue ([#21428](https://github.com/vm0-ai/vm0/issues/21428)) ([f716c1b](https://github.com/vm0-ai/vm0/commit/f716c1bc5f5d11c823ddbc47b23c4856b7915817))
* refresh frosted scatter archive ([#20972](https://github.com/vm0-ai/vm0/issues/20972)) ([518cccc](https://github.com/vm0-ai/vm0/commit/518cccc4d4231a3009319381269eaf19fd8a18a5))
* refresh teams status on bot activity ([#21282](https://github.com/vm0-ai/vm0/issues/21282)) ([b6fa9a6](https://github.com/vm0-ai/vm0/commit/b6fa9a6297dcbadb6d6ef0114dcb07766a826f94))
* require static DOM for HTML presentations ([#21625](https://github.com/vm0-ai/vm0/issues/21625)) ([f55e3a9](https://github.com/vm0-ai/vm0/commit/f55e3a930869187b0195d1dc1eaf967f3eed68ab))
* restore artifact preview screenshots ([#21223](https://github.com/vm0-ai/vm0/issues/21223)) ([7236561](https://github.com/vm0-ai/vm0/commit/72365612e37279b9c00f0ec9e50b39a2ba524e4f))
* show billing recovery for post-dispatch credit failures ([#20844](https://github.com/vm0-ai/vm0/issues/20844)) ([9b375f1](https://github.com/vm0-ai/vm0/commit/9b375f15d8230bd7f27ef1c323ef2e406a5bde9d))
* show friendly claude overload guidance ([#21249](https://github.com/vm0-ai/vm0/issues/21249)) ([09026b5](https://github.com/vm0-ai/vm0/commit/09026b58cc8c7ec01219681d8f54ef4f0e4e80b0))
* trigger api and platform releases ([#21091](https://github.com/vm0-ai/vm0/issues/21091)) ([8fa46f3](https://github.com/vm0-ai/vm0/commit/8fa46f35ec7c7b96fa46954e020e1f6c0df74e51))
* upload large presentations to google slides ([#20974](https://github.com/vm0-ai/vm0/issues/20974)) ([e4e15e8](https://github.com/vm0-ai/vm0/commit/e4e15e8d99a627fd4c5a0e837e16ba424d78c7d2))


### Refactoring

* **api:** accept workflow automation callback kinds before cutover ([#21425](https://github.com/vm0-ai/vm0/issues/21425)) ([fa70e1a](https://github.com/vm0-ai/vm0/commit/fa70e1a9d70d1cb99dd4a8202fba5a8d4d34b869))
* **api:** canonicalize workflow automation identifiers ([#21493](https://github.com/vm0-ai/vm0/issues/21493)) ([c733907](https://github.com/vm0-ai/vm0/commit/c733907ba7302672e4c13e6ec750dd06419f360e))
* **api:** cut over zero run automation provenance ([#21480](https://github.com/vm0-ai/vm0/issues/21480)) ([9d17461](https://github.com/vm0-ai/vm0/commit/9d17461b09aec8bc5decf0025ec0c3950314ce3f))
* **api:** dual-write workflow detail automation fields ([#21552](https://github.com/vm0-ai/vm0/issues/21552)) ([41b5b38](https://github.com/vm0-ai/vm0/commit/41b5b389a3fe8c906e8dedac8268cc8c75afdf29))
* **api:** emit workflow automation callback kinds ([#21471](https://github.com/vm0-ai/vm0/issues/21471)) ([9f463ab](https://github.com/vm0-ai/vm0/commit/9f463ab4c8d5527613d78a644e7628926222b226))
* **api:** read notion pending events by automation id ([#21485](https://github.com/vm0-ai/vm0/issues/21485)) ([9ea81cb](https://github.com/vm0-ai/vm0/commit/9ea81cbe149a0ec8e29c9dd5744d7257678df230))
* **api:** read webhook deliveries by automation id ([#21481](https://github.com/vm0-ai/vm0/issues/21481)) ([b572816](https://github.com/vm0-ai/vm0/commit/b572816b499b762902af0e82771fe5c606e44177))
* **api:** remove legacy automation source compatibility ([#21374](https://github.com/vm0-ai/vm0/issues/21374)) ([c574b5c](https://github.com/vm0-ai/vm0/commit/c574b5cf3c69cef20386db3560202a785f5c87f3))
* **api:** rename workflow automation timing telemetry ([#21482](https://github.com/vm0-ai/vm0/issues/21482)) ([1a965f8](https://github.com/vm0-ai/vm0/commit/1a965f8ce0af64b0e0cfb34b6f8c6cdfc9764892))
* **api:** require runner redaction metadata ([#21003](https://github.com/vm0-ai/vm0/issues/21003)) ([7cb569c](https://github.com/vm0-ai/vm0/commit/7cb569c87cd97ba8f2414729dd77860ec988c4bb))
* **api:** retire legacy workflow callback kinds ([#21501](https://github.com/vm0-ai/vm0/issues/21501)) ([84ec5cd](https://github.com/vm0-ai/vm0/commit/84ec5cd698f87512b297755f8ef46855cfb3689a))
* **api:** stop writing the legacy automation identifier ([#21507](https://github.com/vm0-ai/vm0/issues/21507)) ([24ed4ac](https://github.com/vm0-ai/vm0/commit/24ed4ac5deb3bff63901a7ae896cbd094081a9cd))
* **connectors:** make catalog identities server-authored ([#21128](https://github.com/vm0-ai/vm0/issues/21128)) ([fceb0b2](https://github.com/vm0-ai/vm0/commit/fceb0b2d2afa301c9edd05fbd3c2898ec4ae186f))
* consolidate routine settle error handling ([#21382](https://github.com/vm0-ai/vm0/issues/21382)) ([f104f67](https://github.com/vm0-ai/vm0/commit/f104f67a32d10121953a2e531b38db4d50ad6585))
* **contracts:** canonicalize workflow automation schemas ([#21488](https://github.com/vm0-ai/vm0/issues/21488)) ([24acf1b](https://github.com/vm0-ai/vm0/commit/24acf1b2028a7d8b43555796d3b881f1c27e6d74))
* **db:** canonicalize workflow automation schema identifiers ([#21497](https://github.com/vm0-ai/vm0/issues/21497)) ([0f2e228](https://github.com/vm0-ai/vm0/commit/0f2e22894bcb6fa784bb32baaeade418ab60d5da))
* **db:** contract workflow automation identifiers ([#21509](https://github.com/vm0-ai/vm0/issues/21509)) ([1acfd38](https://github.com/vm0-ai/vm0/commit/1acfd3863a11dd2b88fb681254e73ab320b31678))
* **db:** drop legacy chat automation columns ([#21320](https://github.com/vm0-ai/vm0/issues/21320)) ([47b832c](https://github.com/vm0-ai/vm0/commit/47b832cc762a95649c44b93f7cf8c9c5818d38ea))
* **db:** drop legacy event trigger ids ([#21514](https://github.com/vm0-ai/vm0/issues/21514)) ([63e2659](https://github.com/vm0-ai/vm0/commit/63e2659f79454f01fdb339963a1b07cd9dade1b2))
* **db:** expand automation ids for workflow event records ([#21478](https://github.com/vm0-ai/vm0/issues/21478)) ([597396b](https://github.com/vm0-ai/vm0/commit/597396b4215f4698ebcc262a79527f233bd043f0))
* **db:** expand event source automation ids ([#21484](https://github.com/vm0-ai/vm0/issues/21484)) ([bc98170](https://github.com/vm0-ai/vm0/commit/bc981704cd0756343b8f0ec2fff491c9278e35f5))
* **db:** expand workflow automation memory identifiers ([#21503](https://github.com/vm0-ai/vm0/issues/21503)) ([7aee897](https://github.com/vm0-ai/vm0/commit/7aee8976f913814ac94efb09358e25ea36df0fe9))
* guard workflow automation terminology ([#21500](https://github.com/vm0-ai/vm0/issues/21500)) ([bc290f8](https://github.com/vm0-ai/vm0/commit/bc290f83b5ad4b54630a969c5e282645f523c05a))
* keep gmail workflow events metadata-only ([#21287](https://github.com/vm0-ai/vm0/issues/21287)) ([8cc41f8](https://github.com/vm0-ai/vm0/commit/8cc41f808e42d1e8abfe6245c45996a1e0593abd))
* neutralize shared workflow run identifiers ([#21212](https://github.com/vm0-ai/vm0/issues/21212)) ([d40ff98](https://github.com/vm0-ai/vm0/commit/d40ff98a40ddc75acdbeeacf75b0276d2f690d99))
* **platform:** accept workflow detail automation field ([#21528](https://github.com/vm0-ai/vm0/issues/21528)) ([5a7a9f6](https://github.com/vm0-ai/vm0/commit/5a7a9f619c58baa3499340f16a10b7b383fcda13))
* **platform:** render connector icons from catalog metadata ([#21108](https://github.com/vm0-ai/vm0/issues/21108)) ([71209cb](https://github.com/vm0-ai/vm0/commit/71209cbc7906dd741e9677854d248a9128e0ebd3))
* **platform:** simplify chat message persistence ([#21059](https://github.com/vm0-ai/vm0/issues/21059)) ([756abcf](https://github.com/vm0-ai/vm0/commit/756abcf36614f1d7236d85e6d706e3a0e089456e))
* read staff plan limits from org entitlements ([#21398](https://github.com/vm0-ai/vm0/issues/21398)) ([dbf5a61](https://github.com/vm0-ai/vm0/commit/dbf5a612bf2431b3b56c6a67ac2f6d45aba235df))
* reduce fallback slop in webhook firewall auth ([#20852](https://github.com/vm0-ai/vm0/issues/20852)) ([ebf0b09](https://github.com/vm0-ai/vm0/commit/ebf0b09842436d3e33f701bb6d4bb1fa37e34c76))
* remove dead fallbacks in memory document adapters and ingestion ([#20859](https://github.com/vm0-ai/vm0/issues/20859)) ([a67777c](https://github.com/vm0-ai/vm0/commit/a67777cc17df29fb9964f5d1435200136e143b9b))
* remove vm0 api url env ([#21215](https://github.com/vm0-ai/vm0/issues/21215)) ([6f0d6a9](https://github.com/vm0-ai/vm0/commit/6f0d6a9bdf80c0437d3ef529fd06eacd62a0c412))
* replace 18 settle branches with existing utils ([#21521](https://github.com/vm0-ai/vm0/issues/21521)) ([00e3b8b](https://github.com/vm0-ai/vm0/commit/00e3b8b27d00cab22b329951cfa980ca9a1f208f))
* replace 56 optional settle branches with tap-error ([#21515](https://github.com/vm0-ai/vm0/issues/21515)) ([f56cfd4](https://github.com/vm0-ai/vm0/commit/f56cfd4e17f022b9f9a34517e6ea3addd81c82b0))
* require github user id at the issues api boundary ([#20862](https://github.com/vm0-ai/vm0/issues/20862)) ([ced0b9a](https://github.com/vm0-ai/vm0/commit/ced0b9a8ee06554c2537c9f515e369fa6fdc22b2))
* retain connector facts without raw memory documents ([#21019](https://github.com/vm0-ai/vm0/issues/21019)) ([880570d](https://github.com/vm0-ai/vm0/commit/880570db351b4e37367a0e4b4bcbbd96e95a1589))
* retire artifact video preview feature switch ([#21276](https://github.com/vm0-ai/vm0/issues/21276)) ([700d3cc](https://github.com/vm0-ai/vm0/commit/700d3cc983b376f6ec75e6617aba1da95b60f56c))
* retire the workflow-trigger cron endpoint ([#21505](https://github.com/vm0-ai/vm0/issues/21505)) ([56d6da0](https://github.com/vm0-ai/vm0/commit/56d6da0f7cbaeaa8c60c8177af080323c41664c6))
* roll out artifact favorites and retire the switch ([#21293](https://github.com/vm0-ai/vm0/issues/21293)) ([20accfa](https://github.com/vm0-ai/vm0/commit/20accfa64190f6c04596dda2e9879de3e5d7b339))
* serve connector secret display from api ([#21228](https://github.com/vm0-ai/vm0/issues/21228)) ([272a58b](https://github.com/vm0-ai/vm0/commit/272a58b79234ef63da93c84191f879b9ef16934a))
* stop application writes to legacy event automation ids ([#21511](https://github.com/vm0-ai/vm0/issues/21511)) ([c6244e6](https://github.com/vm0-ai/vm0/commit/c6244e632b2549989ff14757eef5ca0565a5dfff))
* unify chat thread queue drain entry ([#21463](https://github.com/vm0-ai/vm0/issues/21463)) ([627409f](https://github.com/vm0-ai/vm0/commit/627409faad31f88bcc67f9c24796c8ac4a210295))
* **workflows:** rename notion automation switch with rollout compatibility ([#21446](https://github.com/vm0-ai/vm0/issues/21446)) ([3a1e851](https://github.com/vm0-ai/vm0/commit/3a1e8517a3b8c904067b48166067fe672cb051c6))
* **workflows:** retire webhook trigger rollout switch ([#21332](https://github.com/vm0-ai/vm0/issues/21332)) ([517a7c3](https://github.com/vm0-ai/vm0/commit/517a7c34646baeb1c13cef8b49f0b84e00a8b505))


### Performance Improvements

* **api:** attribute claim response assembly stages ([#21124](https://github.com/vm0-ai/vm0/issues/21124)) ([3f84d56](https://github.com/vm0-ai/vm0/commit/3f84d56313e9156d4dee842ae324c951dabfad22))
* **api:** attribute database pool acquisition in query spans ([#21012](https://github.com/vm0-ai/vm0/issues/21012)) ([2ac08f9](https://github.com/vm0-ai/vm0/commit/2ac08f912e22428be8af5d994d2f34c72a3d27ad))
* **api:** attribute normal send preparation stages ([#21245](https://github.com/vm0-ai/vm0/issues/21245)) ([289a1a7](https://github.com/vm0-ai/vm0/commit/289a1a727f220dc98418e434c1287d19baa61ebe))
* **api:** attribute runner notification latency ([#21164](https://github.com/vm0-ai/vm0/issues/21164)) ([3a198f8](https://github.com/vm0-ai/vm0/commit/3a198f8c1d0ca725ec7df7ebada02303ac6cb480))
* **api:** batch usage allowance settlement ([#21495](https://github.com/vm0-ai/vm0/issues/21495)) ([4e470a8](https://github.com/vm0-ai/vm0/commit/4e470a86836f5808ded8a4c419c62a9df2c5dccd))
* **api:** bound incomplete chat round loading ([#21301](https://github.com/vm0-ai/vm0/issues/21301)) ([8bdd66c](https://github.com/vm0-ai/vm0/commit/8bdd66c6cf55bae296d7e89c08b19b889babe59f))
* **api:** bound storage manifest preload to requested keys ([#21454](https://github.com/vm0-ai/vm0/issues/21454)) ([317c7a8](https://github.com/vm0-ai/vm0/commit/317c7a82a3fddffcc7437d88111a4d786f07ec28))
* **api:** cache recurring workflow memory embeddings ([#21345](https://github.com/vm0-ai/vm0/issues/21345)) ([45eafb3](https://github.com/vm0-ai/vm0/commit/45eafb3cc1a9a1333a61e5f99e6ed19d95c35121))
* **api:** consolidate run admission reads ([#21633](https://github.com/vm0-ai/vm0/issues/21633)) ([1c7d4f4](https://github.com/vm0-ai/vm0/commit/1c7d4f4a84c26b7f9044b5d38ceeba54d0c67010))
* **api:** correct runner queue timing boundary ([#21095](https://github.com/vm0-ai/vm0/issues/21095)) ([b0ec02b](https://github.com/vm0-ai/vm0/commit/b0ec02bc71e08dea835fb78ab645a99e5446329e))
* **api:** load feature switch overrides in one query ([#21593](https://github.com/vm0-ai/vm0/issues/21593)) ([cc58560](https://github.com/vm0-ai/vm0/commit/cc58560dcbf0cd11810661982a7a641c6ae38c44))
* **api:** overlap claim response assembly work ([#21199](https://github.com/vm0-ai/vm0/issues/21199)) ([b9c1254](https://github.com/vm0-ai/vm0/commit/b9c1254e202fb36fe1d479a12c707f46c124bb57))
* **api:** overlap runtime memory with run context preparation ([#21230](https://github.com/vm0-ai/vm0/issues/21230)) ([1be0015](https://github.com/vm0-ai/vm0/commit/1be0015cdea57d93f7ee64fead5dbd48820a9124))
* **api:** reuse zero feature switch context during run preparation ([#21557](https://github.com/vm0-ai/vm0/issues/21557)) ([a17ea7a](https://github.com/vm0-ai/vm0/commit/a17ea7a6bff4ba92f8fceab5f487a49e974036fd))
* attribute runtime document memory retrieval ([#20952](https://github.com/vm0-ai/vm0/issues/20952)) ([f550e02](https://github.com/vm0-ai/vm0/commit/f550e024ef448c68c49492b10ccb23d616bc5af5))
* cache goal continuation memory embeddings ([#21107](https://github.com/vm0-ai/vm0/issues/21107)) ([35d0d51](https://github.com/vm0-ai/vm0/commit/35d0d51ff844975fde0f87e591e16d280cda92c7))
* drain workflow skill presigned url refresh backlog ([#21070](https://github.com/vm0-ai/vm0/issues/21070)) ([3fb94c3](https://github.com/vm0-ai/vm0/commit/3fb94c3ba7d251499bd8054f676944ea38717830))
* eliminate redundant runner claim secret materialization ([#20968](https://github.com/vm0-ai/vm0/issues/20968)) ([536e238](https://github.com/vm0-ai/vm0/commit/536e238b92833b70e5380ade1edfc8b7ac3cac64))
* **platform:** reduce chat and composer renders ([#21034](https://github.com/vm0-ai/vm0/issues/21034)) ([9c4458d](https://github.com/vm0-ai/vm0/commit/9c4458d75456653a68aaf076b603b3ac48360ee3))
* **platform:** reduce chat render commits ([#21023](https://github.com/vm0-ai/vm0/issues/21023)) ([6d37bf9](https://github.com/vm0-ai/vm0/commit/6d37bf9b62748da09db8405df2ee4d289ad6d01c))
* redesign runtime profile retrieval ([#21048](https://github.com/vm0-ai/vm0/issues/21048)) ([cdf6142](https://github.com/vm0-ai/vm0/commit/cdf614220dd29c84ce349508bb7f757744c2c67b))
* reduce goal continuation memory search cost ([#20823](https://github.com/vm0-ai/vm0/issues/20823)) ([3dff6c3](https://github.com/vm0-ai/vm0/commit/3dff6c363fd54055231ea02da03c3cc023c185c4))
* **runner:** attribute session history generation claims ([#21550](https://github.com/vm0-ai/vm0/issues/21550)) ([2a2a348](https://github.com/vm0-ai/vm0/commit/2a2a348de2359fe1bae15fd0c03273449565dc51))
* **runner:** prefer exact history generations during affinity claims ([#21618](https://github.com/vm0-ai/vm0/issues/21618)) ([e856646](https://github.com/vm0-ai/vm0/commit/e856646852bab3d2462404da6dcaf29aa9a5f094))
* **runner:** reduce claim database round trips ([#21042](https://github.com/vm0-ai/vm0/issues/21042)) ([e4ee3a3](https://github.com/vm0-ai/vm0/commit/e4ee3a38d6d8d4366c785cb91b8a39337f56e884))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.195.0
    * @vm0/connectors bumped to 1.164.0
    * @vm0/core bumped to 8.436.0
    * @vm0/db bumped to 1.116.0

## [1.277.5](https://github.com/vm0-ai/vm0/compare/api-v1.277.4...api-v1.277.5) (2026-07-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.435.1
    * @vm0/db bumped to 1.115.14

## [1.277.4](https://github.com/vm0-ai/vm0/compare/api-v1.277.3...api-v1.277.4) (2026-07-15)


### Bug Fixes

* **api:** require app version 0.599.19 ([#21616](https://github.com/vm0-ai/vm0/issues/21616)) ([14643c9](https://github.com/vm0-ai/vm0/commit/14643c9799fdd5970ee4e818db3b78b8ce182e22))

## [1.277.3](https://github.com/vm0-ai/vm0/compare/api-v1.277.2...api-v1.277.3) (2026-07-15)


### Performance Improvements

* **api:** load feature switch overrides in one query ([#21593](https://github.com/vm0-ai/vm0/issues/21593)) ([cc58560](https://github.com/vm0-ai/vm0/commit/cc58560dcbf0cd11810661982a7a641c6ae38c44))

## [1.277.2](https://github.com/vm0-ai/vm0/compare/api-v1.277.1...api-v1.277.2) (2026-07-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.194.6
    * @vm0/connectors bumped to 1.163.0
    * @vm0/core bumped to 8.435.0
    * @vm0/db bumped to 1.115.13

## [1.277.1](https://github.com/vm0-ai/vm0/compare/api-v1.277.0...api-v1.277.1) (2026-07-15)


### Performance Improvements

* **runner:** attribute session history generation claims ([#21550](https://github.com/vm0-ai/vm0/issues/21550)) ([2a2a348](https://github.com/vm0-ai/vm0/commit/2a2a348de2359fe1bae15fd0c03273449565dc51))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.194.5
    * @vm0/core bumped to 8.434.1
    * @vm0/db bumped to 1.115.12

## [1.277.0](https://github.com/vm0-ai/vm0/compare/api-v1.276.0...api-v1.277.0) (2026-07-15)


### Features

* **chat:** preserve sessions across model family switches ([#21544](https://github.com/vm0-ai/vm0/issues/21544)) ([d4cbf9f](https://github.com/vm0-ai/vm0/commit/d4cbf9f1193c009bc86668012ffb3b98a0e5289e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.194.4
    * @vm0/connectors bumped to 1.162.0
    * @vm0/core bumped to 8.434.0
    * @vm0/db bumped to 1.115.11

## [1.276.0](https://github.com/vm0-ai/vm0/compare/api-v1.275.9...api-v1.276.0) (2026-07-15)


### Features

* **connectors:** make nintendo connectors generally available ([#21526](https://github.com/vm0-ai/vm0/issues/21526)) ([17975ab](https://github.com/vm0-ai/vm0/commit/17975abc762f8909990b8be5db128937123355b5))


### Refactoring

* **platform:** accept workflow detail automation field ([#21528](https://github.com/vm0-ai/vm0/issues/21528)) ([5a7a9f6](https://github.com/vm0-ai/vm0/commit/5a7a9f619c58baa3499340f16a10b7b383fcda13))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.194.3
    * @vm0/connectors bumped to 1.161.0
    * @vm0/core bumped to 8.433.0
    * @vm0/db bumped to 1.115.10

## [1.275.9](https://github.com/vm0-ai/vm0/compare/api-v1.275.8...api-v1.275.9) (2026-07-15)


### Refactoring

* replace 18 settle branches with existing utils ([#21521](https://github.com/vm0-ai/vm0/issues/21521)) ([00e3b8b](https://github.com/vm0-ai/vm0/commit/00e3b8b27d00cab22b329951cfa980ca9a1f208f))


### Performance Improvements

* **api:** batch usage allowance settlement ([#21495](https://github.com/vm0-ai/vm0/issues/21495)) ([4e470a8](https://github.com/vm0-ai/vm0/commit/4e470a86836f5808ded8a4c419c62a9df2c5dccd))

## [1.275.8](https://github.com/vm0-ai/vm0/compare/api-v1.275.7...api-v1.275.8) (2026-07-15)


### Refactoring

* **db:** drop legacy event trigger ids ([#21514](https://github.com/vm0-ai/vm0/issues/21514)) ([63e2659](https://github.com/vm0-ai/vm0/commit/63e2659f79454f01fdb339963a1b07cd9dade1b2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.115.9

## [1.275.7](https://github.com/vm0-ai/vm0/compare/api-v1.275.6...api-v1.275.7) (2026-07-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.432.0
    * @vm0/db bumped to 1.115.8

## [1.275.6](https://github.com/vm0-ai/vm0/compare/api-v1.275.5...api-v1.275.6) (2026-07-15)


### Refactoring

* stop application writes to legacy event automation ids ([#21511](https://github.com/vm0-ai/vm0/issues/21511)) ([c6244e6](https://github.com/vm0-ai/vm0/commit/c6244e632b2549989ff14757eef5ca0565a5dfff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.115.7

## [1.275.5](https://github.com/vm0-ai/vm0/compare/api-v1.275.4...api-v1.275.5) (2026-07-14)


### Refactoring

* **db:** contract workflow automation identifiers ([#21509](https://github.com/vm0-ai/vm0/issues/21509)) ([1acfd38](https://github.com/vm0-ai/vm0/commit/1acfd3863a11dd2b88fb681254e73ab320b31678))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.115.6

## [1.275.4](https://github.com/vm0-ai/vm0/compare/api-v1.275.3...api-v1.275.4) (2026-07-14)


### Refactoring

* **api:** stop writing the legacy automation identifier ([#21507](https://github.com/vm0-ai/vm0/issues/21507)) ([24ed4ac](https://github.com/vm0-ai/vm0/commit/24ed4ac5deb3bff63901a7ae896cbd094081a9cd))

## [1.275.3](https://github.com/vm0-ai/vm0/compare/api-v1.275.2...api-v1.275.3) (2026-07-14)


### Refactoring

* retire the workflow-trigger cron endpoint ([#21505](https://github.com/vm0-ai/vm0/issues/21505)) ([56d6da0](https://github.com/vm0-ai/vm0/commit/56d6da0f7cbaeaa8c60c8177af080323c41664c6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.194.2
    * @vm0/core bumped to 8.431.4
    * @vm0/db bumped to 1.115.5

## [1.275.2](https://github.com/vm0-ai/vm0/compare/api-v1.275.1...api-v1.275.2) (2026-07-14)


### Refactoring

* **api:** canonicalize workflow automation identifiers ([#21493](https://github.com/vm0-ai/vm0/issues/21493)) ([c733907](https://github.com/vm0-ai/vm0/commit/c733907ba7302672e4c13e6ec750dd06419f360e))
* **api:** retire legacy workflow callback kinds ([#21501](https://github.com/vm0-ai/vm0/issues/21501)) ([84ec5cd](https://github.com/vm0-ai/vm0/commit/84ec5cd698f87512b297755f8ef46855cfb3689a))
* **contracts:** canonicalize workflow automation schemas ([#21488](https://github.com/vm0-ai/vm0/issues/21488)) ([24acf1b](https://github.com/vm0-ai/vm0/commit/24acf1b2028a7d8b43555796d3b881f1c27e6d74))
* **db:** canonicalize workflow automation schema identifiers ([#21497](https://github.com/vm0-ai/vm0/issues/21497)) ([0f2e228](https://github.com/vm0-ai/vm0/commit/0f2e22894bcb6fa784bb32baaeade418ab60d5da))
* **db:** expand workflow automation memory identifiers ([#21503](https://github.com/vm0-ai/vm0/issues/21503)) ([7aee897](https://github.com/vm0-ai/vm0/commit/7aee8976f913814ac94efb09358e25ea36df0fe9))
* guard workflow automation terminology ([#21500](https://github.com/vm0-ai/vm0/issues/21500)) ([bc290f8](https://github.com/vm0-ai/vm0/commit/bc290f83b5ad4b54630a969c5e282645f523c05a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.194.1
    * @vm0/core bumped to 8.431.3
    * @vm0/db bumped to 1.115.4

## [1.275.1](https://github.com/vm0-ai/vm0/compare/api-v1.275.0...api-v1.275.1) (2026-07-14)


### Refactoring

* **api:** cut over zero run automation provenance ([#21480](https://github.com/vm0-ai/vm0/issues/21480)) ([9d17461](https://github.com/vm0-ai/vm0/commit/9d17461b09aec8bc5decf0025ec0c3950314ce3f))
* **api:** read webhook deliveries by automation id ([#21481](https://github.com/vm0-ai/vm0/issues/21481)) ([b572816](https://github.com/vm0-ai/vm0/commit/b572816b499b762902af0e82771fe5c606e44177))

## [1.275.0](https://github.com/vm0-ai/vm0/compare/api-v1.274.1...api-v1.275.0) (2026-07-14)


### Features

* **api:** add workflow automation routes with legacy parity ([#21426](https://github.com/vm0-ai/vm0/issues/21426)) ([bc92379](https://github.com/vm0-ai/vm0/commit/bc923796f156821a399402def0d656c9419e1d84))
* **api:** add workflow automation webhook URL ([#21465](https://github.com/vm0-ai/vm0/issues/21465)) ([a971f50](https://github.com/vm0-ai/vm0/commit/a971f5096b1e41f20b1808f07ac63ce26d6f31fc))


### Refactoring

* **api:** emit workflow automation callback kinds ([#21471](https://github.com/vm0-ai/vm0/issues/21471)) ([9f463ab](https://github.com/vm0-ai/vm0/commit/9f463ab4c8d5527613d78a644e7628926222b226))
* **api:** rename workflow automation timing telemetry ([#21482](https://github.com/vm0-ai/vm0/issues/21482)) ([1a965f8](https://github.com/vm0-ai/vm0/commit/1a965f8ce0af64b0e0cfb34b6f8c6cdfc9764892))
* **db:** expand automation ids for workflow event records ([#21478](https://github.com/vm0-ai/vm0/issues/21478)) ([597396b](https://github.com/vm0-ai/vm0/commit/597396b4215f4698ebcc262a79527f233bd043f0))
* **workflows:** rename notion automation switch with rollout compatibility ([#21446](https://github.com/vm0-ai/vm0/issues/21446)) ([3a1e851](https://github.com/vm0-ai/vm0/commit/3a1e8517a3b8c904067b48166067fe672cb051c6))


### Performance Improvements

* **api:** bound storage manifest preload to requested keys ([#21454](https://github.com/vm0-ai/vm0/issues/21454)) ([317c7a8](https://github.com/vm0-ai/vm0/commit/317c7a82a3fddffcc7437d88111a4d786f07ec28))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.194.0
    * @vm0/connectors bumped to 1.160.2
    * @vm0/core bumped to 8.431.2
    * @vm0/db bumped to 1.115.3

## [1.274.1](https://github.com/vm0-ai/vm0/compare/api-v1.274.0...api-v1.274.1) (2026-07-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.193.2
    * @vm0/connectors bumped to 1.160.1
    * @vm0/core bumped to 8.431.1
    * @vm0/db bumped to 1.115.2

## [1.274.0](https://github.com/vm0-ai/vm0/compare/api-v1.273.1...api-v1.274.0) (2026-07-14)


### Features

* **agent:** request planned connector permissions together ([#21424](https://github.com/vm0-ai/vm0/issues/21424)) ([a39ef20](https://github.com/vm0-ai/vm0/commit/a39ef207062eece0b44742736d55822e0683718a))


### Bug Fixes

* move claimed chat messages out of the composer queue ([#21428](https://github.com/vm0-ai/vm0/issues/21428)) ([f716c1b](https://github.com/vm0-ai/vm0/commit/f716c1bc5f5d11c823ddbc47b23c4856b7915817))


### Refactoring

* **api:** accept workflow automation callback kinds before cutover ([#21425](https://github.com/vm0-ai/vm0/issues/21425)) ([fa70e1a](https://github.com/vm0-ai/vm0/commit/fa70e1a9d70d1cb99dd4a8202fba5a8d4d34b869))

## [1.273.1](https://github.com/vm0-ai/vm0/compare/api-v1.273.0...api-v1.273.1) (2026-07-14)


### Bug Fixes

* improve teams okou bot validation ([#21412](https://github.com/vm0-ai/vm0/issues/21412)) ([dff7782](https://github.com/vm0-ai/vm0/commit/dff77826a148be4c983c833efe90ca68da4f0621))


### Refactoring

* read staff plan limits from org entitlements ([#21398](https://github.com/vm0-ai/vm0/issues/21398)) ([dbf5a61](https://github.com/vm0-ai/vm0/commit/dbf5a612bf2431b3b56c6a67ac2f6d45aba235df))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.193.1
    * @vm0/connectors bumped to 1.160.0
    * @vm0/core bumped to 8.431.0
    * @vm0/db bumped to 1.115.1

## [1.273.0](https://github.com/vm0-ai/vm0/compare/api-v1.272.1...api-v1.273.0) (2026-07-14)


### Features

* add managed zero scrape ([#20778](https://github.com/vm0-ai/vm0/issues/20778)) ([4e72f67](https://github.com/vm0-ai/vm0/commit/4e72f67713b096f72ba4cab591c440906783e68f))


### Bug Fixes

* drain queued user messages whenever a thread goes idle ([#21397](https://github.com/vm0-ai/vm0/issues/21397)) ([5ad9069](https://github.com/vm0-ai/vm0/commit/5ad9069e1beb71822539ea9d17f0a7666b873722))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.193.0
    * @vm0/connectors bumped to 1.159.0
    * @vm0/core bumped to 8.430.0
    * @vm0/db bumped to 1.115.0

## [1.272.1](https://github.com/vm0-ai/vm0/compare/api-v1.272.0...api-v1.272.1) (2026-07-14)


### Bug Fixes

* enforce org tier capability limits ([#21370](https://github.com/vm0-ai/vm0/issues/21370)) ([70c863e](https://github.com/vm0-ai/vm0/commit/70c863e1931a1412e588d88c8eb76ff33e981c92))


### Refactoring

* consolidate routine settle error handling ([#21382](https://github.com/vm0-ai/vm0/issues/21382)) ([f104f67](https://github.com/vm0-ai/vm0/commit/f104f67a32d10121953a2e531b38db4d50ad6585))


### Performance Improvements

* **api:** cache recurring workflow memory embeddings ([#21345](https://github.com/vm0-ai/vm0/issues/21345)) ([45eafb3](https://github.com/vm0-ai/vm0/commit/45eafb3cc1a9a1333a61e5f99e6ed19d95c35121))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.114.1

## [1.272.0](https://github.com/vm0-ai/vm0/compare/api-v1.271.1...api-v1.272.0) (2026-07-14)


### Features

* queue-first user message dispatch on chat_message_queue behind a feature switch ([#21368](https://github.com/vm0-ai/vm0/issues/21368)) ([791774d](https://github.com/vm0-ai/vm0/commit/791774dad8dca817b273c55b580e6e1a783970b8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.192.1
    * @vm0/connectors bumped to 1.158.0
    * @vm0/core bumped to 8.429.0
    * @vm0/db bumped to 1.114.0

## [1.271.1](https://github.com/vm0-ai/vm0/compare/api-v1.271.0...api-v1.271.1) (2026-07-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.192.0
    * @vm0/core bumped to 8.428.0
    * @vm0/db bumped to 1.113.1

## [1.271.0](https://github.com/vm0-ai/vm0/compare/api-v1.270.0...api-v1.271.0) (2026-07-14)


### Features

* add chat_message_queue table and migrate workflow events into it ([#21339](https://github.com/vm0-ai/vm0/issues/21339)) ([83862e6](https://github.com/vm0-ai/vm0/commit/83862e68345be825f2427b8aca5ac9c74ace18ed))


### Bug Fixes

* **chat:** refresh workflows created in threads ([#21346](https://github.com/vm0-ai/vm0/issues/21346)) ([f0fa94f](https://github.com/vm0-ai/vm0/commit/f0fa94f2ea913213e65c864944aae6dedd6576d6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.113.0

## [1.270.0](https://github.com/vm0-ai/vm0/compare/api-v1.269.0...api-v1.270.0) (2026-07-14)


### Features

* persist image edit canvas snapshots ([#21266](https://github.com/vm0-ai/vm0/issues/21266)) ([21d21f4](https://github.com/vm0-ai/vm0/commit/21d21f4c3660652f70e9bc8c16f5756a9b1b1f5a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.191.0
    * @vm0/core bumped to 8.427.3
    * @vm0/db bumped to 1.112.0

## [1.269.0](https://github.com/vm0-ai/vm0/compare/api-v1.268.0...api-v1.269.0) (2026-07-14)


### Features

* **api:** serve refreshed presentation runbooks compatibly ([#21321](https://github.com/vm0-ai/vm0/issues/21321)) ([eadaba4](https://github.com/vm0-ai/vm0/commit/eadaba4dff87b85de340ef49db65158113553970))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.190.0
    * @vm0/core bumped to 8.427.2
    * @vm0/db bumped to 1.111.6

## [1.268.0](https://github.com/vm0-ai/vm0/compare/api-v1.267.0...api-v1.268.0) (2026-07-14)


### Features

* default new organizations to luna with ultra reasoning ([#21323](https://github.com/vm0-ai/vm0/issues/21323)) ([d42f4c3](https://github.com/vm0-ai/vm0/commit/d42f4c30743bcb6aa087fd2c077b348b519175ca))


### Refactoring

* **db:** drop legacy chat automation columns ([#21320](https://github.com/vm0-ai/vm0/issues/21320)) ([47b832c](https://github.com/vm0-ai/vm0/commit/47b832cc762a95649c44b93f7cf8c9c5818d38ea))
* roll out artifact favorites and retire the switch ([#21293](https://github.com/vm0-ai/vm0/issues/21293)) ([20accfa](https://github.com/vm0-ai/vm0/commit/20accfa64190f6c04596dda2e9879de3e5d7b339))


### Performance Improvements

* **api:** bound incomplete chat round loading ([#21301](https://github.com/vm0-ai/vm0/issues/21301)) ([8bdd66c](https://github.com/vm0-ai/vm0/commit/8bdd66c6cf55bae296d7e89c08b19b889babe59f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.189.0
    * @vm0/connectors bumped to 1.157.1
    * @vm0/core bumped to 8.427.1
    * @vm0/db bumped to 1.111.5

## [1.267.0](https://github.com/vm0-ai/vm0/compare/api-v1.266.1...api-v1.267.0) (2026-07-13)


### Features

* add nine feature-gated business connectors ([#21277](https://github.com/vm0-ai/vm0/issues/21277)) ([5f08ac9](https://github.com/vm0-ai/vm0/commit/5f08ac9bc73515b1b483114835b26e210b14265b))
* **api:** add connector permission-deny diagnostics ([#21272](https://github.com/vm0-ai/vm0/issues/21272)) ([da440e9](https://github.com/vm0-ai/vm0/commit/da440e9493305ebf0b541f9120fcecc94c3b1c8f))
* **workflows:** enable webhook trigger creation globally ([#21294](https://github.com/vm0-ai/vm0/issues/21294)) ([515f996](https://github.com/vm0-ai/vm0/commit/515f9963e06ecc1a51c166ff0ead0d7135820512))


### Bug Fixes

* **api:** classify workflow automation sources across consumers ([#21280](https://github.com/vm0-ai/vm0/issues/21280)) ([59ac3a3](https://github.com/vm0-ai/vm0/commit/59ac3a3ef2ae420e8fee4045acc71c61a963fcce))
* refresh teams status on bot activity ([#21282](https://github.com/vm0-ai/vm0/issues/21282)) ([b6fa9a6](https://github.com/vm0-ai/vm0/commit/b6fa9a6297dcbadb6d6ef0114dcb07766a826f94))
* show friendly claude overload guidance ([#21249](https://github.com/vm0-ai/vm0/issues/21249)) ([09026b5](https://github.com/vm0-ai/vm0/commit/09026b58cc8c7ec01219681d8f54ef4f0e4e80b0))


### Refactoring

* keep gmail workflow events metadata-only ([#21287](https://github.com/vm0-ai/vm0/issues/21287)) ([8cc41f8](https://github.com/vm0-ai/vm0/commit/8cc41f808e42d1e8abfe6245c45996a1e0593abd))
* retire artifact video preview feature switch ([#21276](https://github.com/vm0-ai/vm0/issues/21276)) ([700d3cc](https://github.com/vm0-ai/vm0/commit/700d3cc983b376f6ec75e6617aba1da95b60f56c))


### Performance Improvements

* **api:** attribute normal send preparation stages ([#21245](https://github.com/vm0-ai/vm0/issues/21245)) ([289a1a7](https://github.com/vm0-ai/vm0/commit/289a1a727f220dc98418e434c1287d19baa61ebe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.188.0
    * @vm0/connectors bumped to 1.157.0
    * @vm0/core bumped to 8.427.0
    * @vm0/db bumped to 1.111.4

## [1.266.1](https://github.com/vm0-ai/vm0/compare/api-v1.266.0...api-v1.266.1) (2026-07-13)


### Refactoring

* remove vm0 api url env ([#21215](https://github.com/vm0-ai/vm0/issues/21215)) ([6f0d6a9](https://github.com/vm0-ai/vm0/commit/6f0d6a9bdf80c0437d3ef529fd06eacd62a0c412))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.187.1
    * @vm0/connectors bumped to 1.156.1
    * @vm0/core bumped to 8.426.1
    * @vm0/db bumped to 1.111.3

## [1.266.0](https://github.com/vm0-ai/vm0/compare/api-v1.265.5...api-v1.266.0) (2026-07-13)


### Features

* bill openrouter edit helpers ([#20945](https://github.com/vm0-ai/vm0/issues/20945)) ([825c5fa](https://github.com/vm0-ai/vm0/commit/825c5fa33e400b11470ea51388546c672ca6f354))


### Bug Fixes

* restore artifact preview screenshots ([#21223](https://github.com/vm0-ai/vm0/issues/21223)) ([7236561](https://github.com/vm0-ai/vm0/commit/72365612e37279b9c00f0ec9e50b39a2ba524e4f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.187.0
    * @vm0/core bumped to 8.426.0
    * @vm0/db bumped to 1.111.2

## [1.265.5](https://github.com/vm0-ai/vm0/compare/api-v1.265.4...api-v1.265.5) (2026-07-13)


### Bug Fixes

* align artifacts page with chat thread artifacts ([#21193](https://github.com/vm0-ai/vm0/issues/21193)) ([51cf2b5](https://github.com/vm0-ai/vm0/commit/51cf2b53ad62de17cbf68d96498f5c4fdda0c921))
* align teams oauth connect flow ([#21200](https://github.com/vm0-ai/vm0/issues/21200)) ([af0060e](https://github.com/vm0-ai/vm0/commit/af0060e3407d850f46c9f89a8097b368ad80e7ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.186.1
    * @vm0/core bumped to 8.425.4
    * @vm0/db bumped to 1.111.1

## [1.265.4](https://github.com/vm0-ai/vm0/compare/api-v1.265.3...api-v1.265.4) (2026-07-13)


### Performance Improvements

* **api:** attribute runner notification latency ([#21164](https://github.com/vm0-ai/vm0/issues/21164)) ([3a198f8](https://github.com/vm0-ai/vm0/commit/3a198f8c1d0ca725ec7df7ebada02303ac6cb480))

## [1.265.3](https://github.com/vm0-ai/vm0/compare/api-v1.265.2...api-v1.265.3) (2026-07-13)


### Bug Fixes

* authenticate and validate html artifact previews ([#21171](https://github.com/vm0-ai/vm0/issues/21171)) ([9f9ec3b](https://github.com/vm0-ai/vm0/commit/9f9ec3be9e20b0908f1e61a1504511e1b0b2bcff))

## [1.265.2](https://github.com/vm0-ai/vm0/compare/api-v1.265.1...api-v1.265.2) (2026-07-13)


### Bug Fixes

* acknowledge incompatible Notion webhook events ([#21165](https://github.com/vm0-ai/vm0/issues/21165)) ([773c9af](https://github.com/vm0-ai/vm0/commit/773c9afa82643658aa06e44d6e504f44599e6992)), closes [#21157](https://github.com/vm0-ai/vm0/issues/21157)

## [1.265.1](https://github.com/vm0-ai/vm0/compare/api-v1.265.0...api-v1.265.1) (2026-07-13)


### Bug Fixes

* **connectors:** ignore unsupported stored connectors ([#21163](https://github.com/vm0-ai/vm0/issues/21163)) ([3315d83](https://github.com/vm0-ai/vm0/commit/3315d8308784f2833de883ec3590f88900f03be4))

## [1.265.0](https://github.com/vm0-ai/vm0/compare/api-v1.264.0...api-v1.265.0) (2026-07-13)


### Features

* restrict webhook triggers to team and custom workspaces ([#20966](https://github.com/vm0-ai/vm0/issues/20966)) ([18b727b](https://github.com/vm0-ai/vm0/commit/18b727b45cf337c76b73bf89f9d893eeb4cbd0b5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.186.0
    * @vm0/core bumped to 8.425.3
    * @vm0/db bumped to 1.111.0

## [1.264.0](https://github.com/vm0-ai/vm0/compare/api-v1.263.1...api-v1.264.0) (2026-07-12)


### Features

* expose connector catalog icon descriptors ([#21092](https://github.com/vm0-ai/vm0/issues/21092)) ([c0b8e0f](https://github.com/vm0-ai/vm0/commit/c0b8e0f4c485c69884cae063c2c15dd68ea5c112))
* **runner:** make session affinity admission-aware ([#21111](https://github.com/vm0-ai/vm0/issues/21111)) ([ecf0021](https://github.com/vm0-ai/vm0/commit/ecf00216864b70cc5cea5fb0c148aa4f14705b90))


### Bug Fixes

* **mitm-addon:** fail closed on ambiguous connector owners ([#21109](https://github.com/vm0-ai/vm0/issues/21109)) ([19bc1ca](https://github.com/vm0-ai/vm0/commit/19bc1ca3694afd1ee0b1814c099d8575e1a08534))


### Refactoring

* **connectors:** make catalog identities server-authored ([#21128](https://github.com/vm0-ai/vm0/issues/21128)) ([fceb0b2](https://github.com/vm0-ai/vm0/commit/fceb0b2d2afa301c9edd05fbd3c2898ec4ae186f))
* **platform:** render connector icons from catalog metadata ([#21108](https://github.com/vm0-ai/vm0/issues/21108)) ([71209cb](https://github.com/vm0-ai/vm0/commit/71209cbc7906dd741e9677854d248a9128e0ebd3))
* **platform:** simplify chat message persistence ([#21059](https://github.com/vm0-ai/vm0/issues/21059)) ([756abcf](https://github.com/vm0-ai/vm0/commit/756abcf36614f1d7236d85e6d706e3a0e089456e))


### Performance Improvements

* **api:** attribute claim response assembly stages ([#21124](https://github.com/vm0-ai/vm0/issues/21124)) ([3f84d56](https://github.com/vm0-ai/vm0/commit/3f84d56313e9156d4dee842ae324c951dabfad22))
* **api:** correct runner queue timing boundary ([#21095](https://github.com/vm0-ai/vm0/issues/21095)) ([b0ec02b](https://github.com/vm0-ai/vm0/commit/b0ec02bc71e08dea835fb78ab645a99e5446329e))
* cache goal continuation memory embeddings ([#21107](https://github.com/vm0-ai/vm0/issues/21107)) ([35d0d51](https://github.com/vm0-ai/vm0/commit/35d0d51ff844975fde0f87e591e16d280cda92c7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.185.0
    * @vm0/connectors bumped to 1.156.0
    * @vm0/core bumped to 8.425.2
    * @vm0/db bumped to 1.110.0

## [1.263.1](https://github.com/vm0-ai/vm0/compare/api-v1.263.0...api-v1.263.1) (2026-07-12)


### Bug Fixes

* harden nintendo parental controls credentials ([#21078](https://github.com/vm0-ai/vm0/issues/21078)) ([1360d30](https://github.com/vm0-ai/vm0/commit/1360d30ddf543769b2bf255bc2f444b98f5c86d6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.184.4
    * @vm0/connectors bumped to 1.155.1
    * @vm0/core bumped to 8.425.1
    * @vm0/db bumped to 1.109.8

## [1.263.0](https://github.com/vm0-ai/vm0/compare/api-v1.262.4...api-v1.263.0) (2026-07-11)


### Features

* add nintendo switch parental controls connector ([#21016](https://github.com/vm0-ai/vm0/issues/21016)) ([a06a01c](https://github.com/vm0-ai/vm0/commit/a06a01ce0798d7d38efd183345c1559c1bdd7bc5))


### Bug Fixes

* **api:** preserve run agent identity across shared versions ([#21064](https://github.com/vm0-ai/vm0/issues/21064)) ([20bd45a](https://github.com/vm0-ai/vm0/commit/20bd45a83893258e745de6f572a6b6a3d974c641))


### Performance Improvements

* drain workflow skill presigned url refresh backlog ([#21070](https://github.com/vm0-ai/vm0/issues/21070)) ([3fb94c3](https://github.com/vm0-ai/vm0/commit/3fb94c3ba7d251499bd8054f676944ea38717830))
* **platform:** reduce chat and composer renders ([#21034](https://github.com/vm0-ai/vm0/issues/21034)) ([9c4458d](https://github.com/vm0-ai/vm0/commit/9c4458d75456653a68aaf076b603b3ac48360ee3))
* redesign runtime profile retrieval ([#21048](https://github.com/vm0-ai/vm0/issues/21048)) ([cdf6142](https://github.com/vm0-ai/vm0/commit/cdf614220dd29c84ce349508bb7f757744c2c67b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.184.3
    * @vm0/connectors bumped to 1.155.0
    * @vm0/core bumped to 8.425.0
    * @vm0/db bumped to 1.109.7

## [1.262.4](https://github.com/vm0-ai/vm0/compare/api-v1.262.3...api-v1.262.4) (2026-07-11)


### Bug Fixes

* classify completion failures before retrying ([#21041](https://github.com/vm0-ai/vm0/issues/21041)) ([d28ccb6](https://github.com/vm0-ai/vm0/commit/d28ccb60eafbaa3aac279160c5f8fb2a76fa8e3e)), closes [#21006](https://github.com/vm0-ai/vm0/issues/21006)


### Performance Improvements

* **runner:** reduce claim database round trips ([#21042](https://github.com/vm0-ai/vm0/issues/21042)) ([e4ee3a3](https://github.com/vm0-ai/vm0/commit/e4ee3a38d6d8d4366c785cb91b8a39337f56e884))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.109.6

## [1.262.3](https://github.com/vm0-ai/vm0/compare/api-v1.262.2...api-v1.262.3) (2026-07-11)


### Performance Improvements

* **platform:** reduce chat render commits ([#21023](https://github.com/vm0-ai/vm0/issues/21023)) ([6d37bf9](https://github.com/vm0-ai/vm0/commit/6d37bf9b62748da09db8405df2ee4d289ad6d01c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.184.2
    * @vm0/core bumped to 8.424.5
    * @vm0/db bumped to 1.109.5

## [1.262.2](https://github.com/vm0-ai/vm0/compare/api-v1.262.1...api-v1.262.2) (2026-07-11)


### Refactoring

* retain connector facts without raw memory documents ([#21019](https://github.com/vm0-ai/vm0/issues/21019)) ([880570d](https://github.com/vm0-ai/vm0/commit/880570db351b4e37367a0e4b4bcbbd96e95a1589))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.109.4

## [1.262.1](https://github.com/vm0-ai/vm0/compare/api-v1.262.0...api-v1.262.1) (2026-07-10)


### Refactoring

* **api:** require runner redaction metadata ([#21003](https://github.com/vm0-ai/vm0/issues/21003)) ([7cb569c](https://github.com/vm0-ai/vm0/commit/7cb569c87cd97ba8f2414729dd77860ec988c4bb))


### Performance Improvements

* **api:** attribute database pool acquisition in query spans ([#21012](https://github.com/vm0-ai/vm0/issues/21012)) ([2ac08f9](https://github.com/vm0-ai/vm0/commit/2ac08f912e22428be8af5d994d2f34c72a3d27ad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.184.1
    * @vm0/connectors bumped to 1.154.3
    * @vm0/core bumped to 8.424.4
    * @vm0/db bumped to 1.109.3

## [1.262.0](https://github.com/vm0-ai/vm0/compare/api-v1.261.1...api-v1.262.0) (2026-07-10)


### Features

* **image-editor:** share edited images to x ([#20836](https://github.com/vm0-ai/vm0/issues/20836)) ([fca6111](https://github.com/vm0-ai/vm0/commit/fca611179fda0489a8f92b0edecd5532cbf6ca0d))


### Bug Fixes

* refresh frosted scatter archive ([#20972](https://github.com/vm0-ai/vm0/issues/20972)) ([518cccc](https://github.com/vm0-ai/vm0/commit/518cccc4d4231a3009319381269eaf19fd8a18a5))
* upload large presentations to google slides ([#20974](https://github.com/vm0-ai/vm0/issues/20974)) ([e4e15e8](https://github.com/vm0-ai/vm0/commit/e4e15e8d99a627fd4c5a0e837e16ba424d78c7d2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.184.0
    * @vm0/connectors bumped to 1.154.2
    * @vm0/core bumped to 8.424.3
    * @vm0/db bumped to 1.109.2

## [1.261.1](https://github.com/vm0-ai/vm0/compare/api-v1.261.0...api-v1.261.1) (2026-07-10)


### Bug Fixes

* align typescript tests across local and ci ([#20963](https://github.com/vm0-ai/vm0/issues/20963)) ([1613d7f](https://github.com/vm0-ai/vm0/commit/1613d7fe2ccd6a887acec51f9457eb7c045ec6db))


### Performance Improvements

* attribute runtime document memory retrieval ([#20952](https://github.com/vm0-ai/vm0/issues/20952)) ([f550e02](https://github.com/vm0-ai/vm0/commit/f550e024ef448c68c49492b10ccb23d616bc5af5))
* eliminate redundant runner claim secret materialization ([#20968](https://github.com/vm0-ai/vm0/issues/20968)) ([536e238](https://github.com/vm0-ai/vm0/commit/536e238b92833b70e5380ade1edfc8b7ac3cac64))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.183.1
    * @vm0/connectors bumped to 1.154.1
    * @vm0/core bumped to 8.424.2
    * @vm0/db bumped to 1.109.1

## [1.261.0](https://github.com/vm0-ai/vm0/compare/api-v1.260.0...api-v1.261.0) (2026-07-10)


### Features

* add microsoft teams cli support ([#20489](https://github.com/vm0-ai/vm0/issues/20489)) ([c908d0a](https://github.com/vm0-ai/vm0/commit/c908d0a502222793856de48bb90b5fdadd079a49))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.183.0
    * @vm0/core bumped to 8.424.1
    * @vm0/db bumped to 1.109.0

## [1.260.0](https://github.com/vm0-ai/vm0/compare/api-v1.259.0...api-v1.260.0) (2026-07-10)


### Features

* add dot matrix and frosted scatter website templates ([#20944](https://github.com/vm0-ai/vm0/issues/20944)) ([ab6471c](https://github.com/vm0-ai/vm0/commit/ab6471c0eace009cad8aa87c99f9b1f830a4ade3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.182.1
    * @vm0/core bumped to 8.424.0
    * @vm0/db bumped to 1.108.4

## [1.259.0](https://github.com/vm0-ai/vm0/compare/api-v1.258.0...api-v1.259.0) (2026-07-10)


### Features

* add artifacts page preview lightbox ([#20889](https://github.com/vm0-ai/vm0/issues/20889)) ([9952a50](https://github.com/vm0-ai/vm0/commit/9952a505c82e354ea432e03977e1b43549b7e8a4))
* add manual connector readiness checks to workflow settings ([#20913](https://github.com/vm0-ai/vm0/issues/20913)) ([98d604b](https://github.com/vm0-ai/vm0/commit/98d604b20841ef60e482e207416b03d056c1cb1f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.182.0
    * @vm0/connectors bumped to 1.154.0
    * @vm0/core bumped to 8.423.0
    * @vm0/db bumped to 1.108.3

## [1.258.0](https://github.com/vm0-ai/vm0/compare/api-v1.257.0...api-v1.258.0) (2026-07-10)


### Features

* add workflow queue inspection and control api with per-thread realtime signal ([#20895](https://github.com/vm0-ai/vm0/issues/20895)) ([6c02526](https://github.com/vm0-ai/vm0/commit/6c025261b754d16d25c1a88f5e5e8f37bb9a6dc7)), closes [#20876](https://github.com/vm0-ai/vm0/issues/20876)
* curate default models for new organizations ([#20880](https://github.com/vm0-ai/vm0/issues/20880)) ([c10661e](https://github.com/vm0-ai/vm0/commit/c10661e0a8541f9b1c2e7de8ef7fe46b2d59d4d6))
* migrate member model preferences to workspace default when org removes a model ([#20884](https://github.com/vm0-ai/vm0/issues/20884)) ([fb3cf31](https://github.com/vm0-ai/vm0/commit/fb3cf31d900504b4f0b592175463d6a157d30ee8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.181.0
    * @vm0/core bumped to 8.422.1
    * @vm0/db bumped to 1.108.2

## [1.257.0](https://github.com/vm0-ai/vm0/compare/api-v1.256.2...api-v1.257.0) (2026-07-10)


### Features

* generate poster-frame previews for video artifacts ([#20831](https://github.com/vm0-ai/vm0/issues/20831)) ([f14a997](https://github.com/vm0-ai/vm0/commit/f14a997e3d3abf8f95066a5869475b20fe959d9c))


### Performance Improvements

* reduce goal continuation memory search cost ([#20823](https://github.com/vm0-ai/vm0/issues/20823)) ([3dff6c3](https://github.com/vm0-ai/vm0/commit/3dff6c363fd54055231ea02da03c3cc023c185c4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.180.0
    * @vm0/connectors bumped to 1.153.0
    * @vm0/core bumped to 8.422.0
    * @vm0/db bumped to 1.108.1

## [1.256.2](https://github.com/vm0-ai/vm0/compare/api-v1.256.1...api-v1.256.2) (2026-07-10)


### Refactoring

* require github user id at the issues api boundary ([#20862](https://github.com/vm0-ai/vm0/issues/20862)) ([ced0b9a](https://github.com/vm0-ai/vm0/commit/ced0b9a8ee06554c2537c9f515e369fa6fdc22b2))

## [1.256.1](https://github.com/vm0-ai/vm0/compare/api-v1.256.0...api-v1.256.1) (2026-07-10)


### Bug Fixes

* **api:** refresh api release marker comment ([#20858](https://github.com/vm0-ai/vm0/issues/20858)) ([4fbd6cd](https://github.com/vm0-ai/vm0/commit/4fbd6cd24590f716066fd5f3038693152e89edc0))

## [1.256.0](https://github.com/vm0-ai/vm0/compare/api-v1.255.0...api-v1.256.0) (2026-07-09)


### Features

* inject connector document rag into zero memory runtime ([#20854](https://github.com/vm0-ai/vm0/issues/20854)) ([d457c9b](https://github.com/vm0-ai/vm0/commit/d457c9b8daaf33dde0c32b46e81baeb66b56f673))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.179.0
    * @vm0/core bumped to 8.421.2
    * @vm0/db bumped to 1.108.0

## [1.255.0](https://github.com/vm0-ai/vm0/compare/api-v1.254.0...api-v1.255.0) (2026-07-09)


### Features

* add zero memory lifecycle api, cli, and ui surfaces ([#20850](https://github.com/vm0-ai/vm0/issues/20850)) ([7ef3ee0](https://github.com/vm0-ai/vm0/commit/7ef3ee0b50901584644ab1ceed240d5c6cd97dcc))


### Bug Fixes

* enable codex subscriptions for gpt 5.6 models ([#20851](https://github.com/vm0-ai/vm0/issues/20851)) ([1dcb103](https://github.com/vm0-ai/vm0/commit/1dcb103fddd113b29a124cbd1de0d24f1da3b8d1))


### Refactoring

* reduce fallback slop in webhook firewall auth ([#20852](https://github.com/vm0-ai/vm0/issues/20852)) ([ebf0b09](https://github.com/vm0-ai/vm0/commit/ebf0b09842436d3e33f701bb6d4bb1fa37e34c76))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.178.0
    * @vm0/core bumped to 8.421.1
    * @vm0/db bumped to 1.107.0

## [1.254.0](https://github.com/vm0-ai/vm0/compare/api-v1.253.0...api-v1.254.0) (2026-07-09)


### Features

* add gpt-5.6 model support ([#20841](https://github.com/vm0-ai/vm0/issues/20841)) ([70d551f](https://github.com/vm0-ai/vm0/commit/70d551f731976130af4a640d571ac2aa2708e100))
* add zero memory document rag substrate ([#20846](https://github.com/vm0-ai/vm0/issues/20846)) ([52f1e35](https://github.com/vm0-ai/vm0/commit/52f1e35b51a72850a5d4a5d0e1cfba89b9382944))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.177.0
    * @vm0/core bumped to 8.421.0
    * @vm0/db bumped to 1.106.0

## [1.253.0](https://github.com/vm0-ai/vm0/compare/api-v1.252.0...api-v1.253.0) (2026-07-09)


### Features

* add artifact favorite api ([#20837](https://github.com/vm0-ai/vm0/issues/20837)) ([5c935ea](https://github.com/vm0-ai/vm0/commit/5c935eab0bc13098bbf06a7503939722a257b5f5))
* add artifact favorite controls ([#20838](https://github.com/vm0-ai/vm0/issues/20838)) ([c7c0bee](https://github.com/vm0-ai/vm0/commit/c7c0bee953d6268e572bfa254a6cdd7bcef86774))
* add nintendo store connector ([#20768](https://github.com/vm0-ai/vm0/issues/20768)) ([a84b0e0](https://github.com/vm0-ai/vm0/commit/a84b0e04ba6382380a6b81331aed372d2abe1149))


### Bug Fixes

* allow limited-free billable firewall auth ([#20843](https://github.com/vm0-ai/vm0/issues/20843)) ([ef07fbb](https://github.com/vm0-ai/vm0/commit/ef07fbba1ec3cf8aa820e734c34414aa8f8f2033))
* **api:** persist workflow schedule run briefs ([#20839](https://github.com/vm0-ai/vm0/issues/20839)) ([5db9855](https://github.com/vm0-ai/vm0/commit/5db98557afa4fbad5f2ebdcaacad658a1bd78b24))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.176.0
    * @vm0/connectors bumped to 1.152.0
    * @vm0/core bumped to 8.420.0
    * @vm0/db bumped to 1.105.0

## [1.252.0](https://github.com/vm0-ai/vm0/compare/api-v1.251.1...api-v1.252.0) (2026-07-09)


### Features

* add gated github and notion memory backfills ([#20801](https://github.com/vm0-ai/vm0/issues/20801)) ([a8fb592](https://github.com/vm0-ai/vm0/commit/a8fb59226bcf1f39e47e62e6c76ccbea5226b950))
* align teams integration with slack parity ([#20544](https://github.com/vm0-ai/vm0/issues/20544)) ([3212311](https://github.com/vm0-ai/vm0/commit/3212311ffeb24690074c3df51fa02e9cc4045275))
* interpret marked image regions into targeted edits ([#20822](https://github.com/vm0-ai/vm0/issues/20822)) ([62444e3](https://github.com/vm0-ai/vm0/commit/62444e3cb87332aafa869bc413077bbf4626a287))
* render static preview images for html/website artifacts ([#20814](https://github.com/vm0-ai/vm0/issues/20814)) ([3b52479](https://github.com/vm0-ai/vm0/commit/3b52479f8c12e00c55b536a4c279809a75ec80ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.175.0
    * @vm0/connectors bumped to 1.151.0
    * @vm0/core bumped to 8.419.0
    * @vm0/db bumped to 1.104.0

## [1.251.1](https://github.com/vm0-ai/vm0/compare/api-v1.251.0...api-v1.251.1) (2026-07-09)


### Bug Fixes

* allow mcp server discovery from computer-use run tokens ([#20803](https://github.com/vm0-ai/vm0/issues/20803)) ([3a283a7](https://github.com/vm0-ai/vm0/commit/3a283a7e6b7aee2f546c5f698fbf11bc2d7b53af))
* suppress notion content updates during create windows ([#20812](https://github.com/vm0-ai/vm0/issues/20812)) ([576b7d6](https://github.com/vm0-ai/vm0/commit/576b7d61565aed87f4088a5529586aa318b95ce7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.103.0

## [1.251.0](https://github.com/vm0-ai/vm0/compare/api-v1.250.3...api-v1.251.0) (2026-07-09)


### Features

* add custom billing tier ([#20690](https://github.com/vm0-ai/vm0/issues/20690)) ([2f3fdc2](https://github.com/vm0-ai/vm0/commit/2f3fdc2e7834ff86215fd7ea87227f702b47598c))
* **api:** keyset-paginate the artifacts list endpoint ([#20800](https://github.com/vm0-ai/vm0/issues/20800)) ([2bb327c](https://github.com/vm0-ai/vm0/commit/2bb327c5dccd13fc14877684079df5fcd1b211ff))


### Bug Fixes

* reconcile usage allowance subscriptions ([#20684](https://github.com/vm0-ai/vm0/issues/20684)) ([3849bcd](https://github.com/vm0-ai/vm0/commit/3849bcd1baf67bcb455bc5eea27dd57f4df0183d))
* route builtin glm models via zai ([#20795](https://github.com/vm0-ai/vm0/issues/20795)) ([34e9dd6](https://github.com/vm0-ai/vm0/commit/34e9dd608b70ffa82a302539c4bea6e440ff2991))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.174.0
    * @vm0/core bumped to 8.418.2
    * @vm0/db bumped to 1.102.0

## [1.250.3](https://github.com/vm0-ai/vm0/compare/api-v1.250.2...api-v1.250.3) (2026-07-09)


### Bug Fixes

* inject only prompt-relevant memory context ([#20786](https://github.com/vm0-ai/vm0/issues/20786)) ([fd74f33](https://github.com/vm0-ai/vm0/commit/fd74f333f810dc7802cdfef0b337eb559c6c480c))


### Performance Improvements

* add zero memory runtime timing attribution ([#20787](https://github.com/vm0-ai/vm0/issues/20787)) ([ca0d5ea](https://github.com/vm0-ai/vm0/commit/ca0d5ea17ec463fba491144ea1972c4ddd937c11))

## [1.250.2](https://github.com/vm0-ai/vm0/compare/api-v1.250.1...api-v1.250.2) (2026-07-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.173.1
    * @vm0/connectors bumped to 1.150.2
    * @vm0/core bumped to 8.418.1
    * @vm0/db bumped to 1.101.2

## [1.250.1](https://github.com/vm0-ai/vm0/compare/api-v1.250.0...api-v1.250.1) (2026-07-09)


### Refactoring

* tighten slack user info resolver coverage ([#20764](https://github.com/vm0-ai/vm0/issues/20764)) ([7b3ae3b](https://github.com/vm0-ai/vm0/commit/7b3ae3b543e7ee0b8ace4a88ab2bfa4c81b21165))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.418.0
    * @vm0/db bumped to 1.101.1

## [1.250.0](https://github.com/vm0-ai/vm0/compare/api-v1.249.0...api-v1.250.0) (2026-07-09)


### Features

* add r2-backed website template packages ([#20700](https://github.com/vm0-ai/vm0/issues/20700)) ([2c9c4d4](https://github.com/vm0-ai/vm0/commit/2c9c4d43a96ee11abc8a25268cd8910af1f538de))
* add semantic structured memory recall ([#20742](https://github.com/vm0-ai/vm0/issues/20742)) ([70de301](https://github.com/vm0-ai/vm0/commit/70de3018bf33e44db076172316597513e9b0be1a))
* route mcp plugin commands and add plugin mcp cli ([#20756](https://github.com/vm0-ai/vm0/issues/20756)) ([89d4e76](https://github.com/vm0-ai/vm0/commit/89d4e76f2eda168c2d9012e93b4f00bb260f2bd4))


### Bug Fixes

* accept notion data source parent webhooks ([#20709](https://github.com/vm0-ai/vm0/issues/20709)) ([b5b478c](https://github.com/vm0-ai/vm0/commit/b5b478c358765746efc8b13021dcc2a539572195))
* exempt external webhooks from preview automation bypass guard ([#20754](https://github.com/vm0-ai/vm0/issues/20754)) ([8df2f80](https://github.com/vm0-ai/vm0/commit/8df2f80e34c174da079adf08e7b598c2c0e235f0))


### Performance Improvements

* coalesce slack user info lookups ([#20724](https://github.com/vm0-ai/vm0/issues/20724)) ([7bd020c](https://github.com/vm0-ai/vm0/commit/7bd020c2b0f989bfcd3070f0b1b3a75e1495b9a2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.173.0
    * @vm0/connectors bumped to 1.150.1
    * @vm0/core bumped to 8.417.0
    * @vm0/db bumped to 1.101.0

## [1.249.0](https://github.com/vm0-ai/vm0/compare/api-v1.248.0...api-v1.249.0) (2026-07-08)


### Features

* add nintendo eshop catalog connector ([#20660](https://github.com/vm0-ai/vm0/issues/20660)) ([2ea4549](https://github.com/vm0-ai/vm0/commit/2ea45494646c4ecfcdfe1dcce65c8517d902cabd))


### Bug Fixes

* persist Vercel preview bypass cookie ([#20715](https://github.com/vm0-ai/vm0/issues/20715)) ([972b41f](https://github.com/vm0-ai/vm0/commit/972b41f88246bf49059300c11eeb7823895f9764))
* remove minimax codex legacy base url ([#20707](https://github.com/vm0-ai/vm0/issues/20707)) ([a4a9e77](https://github.com/vm0-ai/vm0/commit/a4a9e77fe2d8e1065f1b57a9ead26565b054fa39))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.172.0
    * @vm0/connectors bumped to 1.150.0
    * @vm0/core bumped to 8.416.0
    * @vm0/db bumped to 1.100.7

## [1.248.0](https://github.com/vm0-ai/vm0/compare/api-v1.247.0...api-v1.248.0) (2026-07-08)


### Features

* enable playstation connector for all users ([#20693](https://github.com/vm0-ai/vm0/issues/20693)) ([78572ef](https://github.com/vm0-ai/vm0/commit/78572efdae6b293e07558df9cd1dd1ee72e29231))
* load artifacts page from a bulk fetch cached in indexeddb ([#20601](https://github.com/vm0-ai/vm0/issues/20601)) ([854bb86](https://github.com/vm0-ai/vm0/commit/854bb867c952ecc0bbc6d9ae3c65c53c0da42d94))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.171.0
    * @vm0/connectors bumped to 1.149.0
    * @vm0/core bumped to 8.415.0
    * @vm0/db bumped to 1.100.6

## [1.247.0](https://github.com/vm0-ai/vm0/compare/api-v1.246.1...api-v1.247.0) (2026-07-08)


### Features

* accept runner starting heartbeat mode ([#20672](https://github.com/vm0-ai/vm0/issues/20672)) ([7c49c7b](https://github.com/vm0-ai/vm0/commit/7c49c7b703a6163b1ebf4b5084c284ee60d9ff13))


### Refactoring

* remove unused zero compose and custom connector routes ([#20644](https://github.com/vm0-ai/vm0/issues/20644)) ([f40d11e](https://github.com/vm0-ai/vm0/commit/f40d11eb3e65bd5c7c685171f785f367270c3857))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.170.0
    * @vm0/core bumped to 8.414.8
    * @vm0/db bumped to 1.100.5

## [1.246.1](https://github.com/vm0-ai/vm0/compare/api-v1.246.0...api-v1.246.1) (2026-07-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.169.3
    * @vm0/core bumped to 8.414.7
    * @vm0/db bumped to 1.100.4

## [1.246.0](https://github.com/vm0-ai/vm0/compare/api-v1.245.1...api-v1.246.0) (2026-07-08)


### Features

* expose zero memory tools in run prompts ([#20657](https://github.com/vm0-ai/vm0/issues/20657)) ([37664a5](https://github.com/vm0-ai/vm0/commit/37664a5bb31673b649ab0af28f5778800c7b3da1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.169.2
    * @vm0/connectors bumped to 1.148.2
    * @vm0/core bumped to 8.414.6
    * @vm0/db bumped to 1.100.3

## [1.245.1](https://github.com/vm0-ai/vm0/compare/api-v1.245.0...api-v1.245.1) (2026-07-08)


### Bug Fixes

* clear slack pre-run status on dispatch failure ([#20628](https://github.com/vm0-ai/vm0/issues/20628)) ([1b5d359](https://github.com/vm0-ai/vm0/commit/1b5d3595b78dde333cf9c2a7aaecf5e56e0d0423))
* configure minimax codex runtime provider ([#20588](https://github.com/vm0-ai/vm0/issues/20588)) ([a5ae66b](https://github.com/vm0-ai/vm0/commit/a5ae66be4034b2b018175593b02b57d00a90615e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.169.1
    * @vm0/core bumped to 8.414.5
    * @vm0/db bumped to 1.100.2

## [1.245.0](https://github.com/vm0-ai/vm0/compare/api-v1.244.0...api-v1.245.0) (2026-07-08)


### Features

* add zero memory recall surfaces ([#20630](https://github.com/vm0-ai/vm0/issues/20630)) ([c937665](https://github.com/vm0-ai/vm0/commit/c9376657012a4fefedfabc0a033b53d18c7065cb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.169.0
    * @vm0/core bumped to 8.414.4
    * @vm0/db bumped to 1.100.1

## [1.244.0](https://github.com/vm0-ai/vm0/compare/api-v1.243.1...api-v1.244.0) (2026-07-08)


### Features

* add desktop client request headers ([#20622](https://github.com/vm0-ai/vm0/issues/20622)) ([00a66b8](https://github.com/vm0-ai/vm0/commit/00a66b894644a59f4646c31799a918e6ceafa19a))
* add usage allowance billing ([#20524](https://github.com/vm0-ai/vm0/issues/20524)) ([118cdc1](https://github.com/vm0-ai/vm0/commit/118cdc130c407c030d6c766387afa6105a0db229))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.168.0
    * @vm0/connectors bumped to 1.148.1
    * @vm0/core bumped to 8.414.3
    * @vm0/db bumped to 1.100.0

## [1.243.1](https://github.com/vm0-ai/vm0/compare/api-v1.243.0...api-v1.243.1) (2026-07-08)


### Performance Improvements

* reduce slack pre-create latency ([#20604](https://github.com/vm0-ai/vm0/issues/20604)) ([fa1deeb](https://github.com/vm0-ai/vm0/commit/fa1deeb93eee34a981d4506d880e548b9bfeb8f3))

## [1.243.0](https://github.com/vm0-ai/vm0/compare/api-v1.242.0...api-v1.243.0) (2026-07-08)


### Features

* add web integration messaging prompt ([#20550](https://github.com/vm0-ai/vm0/issues/20550)) ([3b2a106](https://github.com/vm0-ai/vm0/commit/3b2a106102a0883fa995171166f42e77201b6ab8))


### Performance Improvements

* add session history fetch response telemetry ([#20605](https://github.com/vm0-ai/vm0/issues/20605)) ([146fc5b](https://github.com/vm0-ai/vm0/commit/146fc5b39f9697ebb318bf01ca086506e7c0bc66))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.167.1
    * @vm0/core bumped to 8.414.2
    * @vm0/db bumped to 1.99.4

## [1.242.0](https://github.com/vm0-ai/vm0/compare/api-v1.241.0...api-v1.242.0) (2026-07-08)


### Features

* add memory source detail view ([#20607](https://github.com/vm0-ai/vm0/issues/20607)) ([e32c1d0](https://github.com/vm0-ai/vm0/commit/e32c1d0eb01994ffc384b1274810ed396e40f034))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.167.0
    * @vm0/core bumped to 8.414.1
    * @vm0/db bumped to 1.99.3

## [1.241.0](https://github.com/vm0-ai/vm0/compare/api-v1.240.0...api-v1.241.0) (2026-07-08)


### Features

* add org-level artifacts api ([#20563](https://github.com/vm0-ai/vm0/issues/20563)) ([1828d6c](https://github.com/vm0-ai/vm0/commit/1828d6c3d4d6259c7c4f35ef95093b0c06ecefe9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.166.0
    * @vm0/connectors bumped to 1.148.0
    * @vm0/core bumped to 8.414.0
    * @vm0/db bumped to 1.99.2

## [1.240.0](https://github.com/vm0-ai/vm0/compare/api-v1.239.0...api-v1.240.0) (2026-07-08)


### Features

* **cli:** split image prompt generation modes ([#20580](https://github.com/vm0-ai/vm0/issues/20580)) ([1cb5e06](https://github.com/vm0-ai/vm0/commit/1cb5e06c00ea331d15df5412c994ec8ee934aa91))


### Refactoring

* clean up empty artifact compatibility ([#20574](https://github.com/vm0-ai/vm0/issues/20574)) ([dc86eae](https://github.com/vm0-ai/vm0/commit/dc86eae0bf05e3c6a5787c330b9490548c3512a4))
* reduce fallback slop in runtime boundaries ([#20589](https://github.com/vm0-ai/vm0/issues/20589)) ([36dcf45](https://github.com/vm0-ai/vm0/commit/36dcf451acde410fca40dfd910ebe3ab2e12fa4b))


### Performance Improvements

* add direct ably claim timing telemetry ([#20579](https://github.com/vm0-ai/vm0/issues/20579)) ([3167db5](https://github.com/vm0-ai/vm0/commit/3167db5f5a44b4c72fd07ebf6b162d2e41b1cad9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.165.0
    * @vm0/connectors bumped to 1.147.1
    * @vm0/core bumped to 8.413.0
    * @vm0/db bumped to 1.99.1

## [1.239.0](https://github.com/vm0-ai/vm0/compare/api-v1.238.0...api-v1.239.0) (2026-07-07)


### Features

* add notion page content updated workflow trigger ([#20562](https://github.com/vm0-ai/vm0/issues/20562)) ([833395e](https://github.com/vm0-ai/vm0/commit/833395ed1bd75e7e94b5baa1ede1506d3584ecea))
* add zero chat model switching ([#20566](https://github.com/vm0-ai/vm0/issues/20566)) ([5a996cb](https://github.com/vm0-ai/vm0/commit/5a996cb2d1b8201887831aaf2122f09a636c2dda))


### CI

* **release:** revert app/api release guard ([#20567](https://github.com/vm0-ai/vm0/issues/20567)) ([595cbfd](https://github.com/vm0-ai/vm0/commit/595cbfdfb2f40777604134f175e2606542597662))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.164.0
    * @vm0/core bumped to 8.412.3
    * @vm0/db bumped to 1.99.0

## [1.238.0](https://github.com/vm0-ai/vm0/compare/api-v1.237.1...api-v1.238.0) (2026-07-07)


### Features

* default limited-free workspaces to sonnet 4.6 ([#20564](https://github.com/vm0-ai/vm0/issues/20564)) ([7a876cb](https://github.com/vm0-ai/vm0/commit/7a876cb1f0a8e6a6255b4f5b527fcc3033b3b9ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.163.0
    * @vm0/core bumped to 8.412.2
    * @vm0/db bumped to 1.98.2

## [1.237.1](https://github.com/vm0-ai/vm0/compare/api-v1.237.0...api-v1.237.1) (2026-07-07)


### Bug Fixes

* keep mobile unread shortcuts personal ([#20558](https://github.com/vm0-ai/vm0/issues/20558)) ([de0abb4](https://github.com/vm0-ai/vm0/commit/de0abb489415605332ce985b2ee1b80185ab72a1))


### CI

* **release:** guard app releases from unreleased api diffs ([#20549](https://github.com/vm0-ai/vm0/issues/20549)) ([e1d6e28](https://github.com/vm0-ai/vm0/commit/e1d6e282f1b30e3a2fc67b57ca5173587cb43e38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.412.1
    * @vm0/db bumped to 1.98.1

## [1.237.0](https://github.com/vm0-ai/vm0/compare/api-v1.236.0...api-v1.237.0) (2026-07-07)


### Features

* add notion database item workflow trigger ([#20533](https://github.com/vm0-ai/vm0/issues/20533)) ([e4c078c](https://github.com/vm0-ai/vm0/commit/e4c078c3a5da6a9e1684941421ef73223c146393))
* add platform client request headers ([#20518](https://github.com/vm0-ai/vm0/issues/20518)) ([d5ceb5c](https://github.com/vm0-ai/vm0/commit/d5ceb5c312874b48604de701e1ce12887e0d4f91))
* add playstation connector ([#20459](https://github.com/vm0-ai/vm0/issues/20459)) ([588ee8b](https://github.com/vm0-ai/vm0/commit/588ee8b242242277e752c91f64a1b9698b6d3afd))
* **api:** log platform client headers on request logs ([#20539](https://github.com/vm0-ai/vm0/issues/20539)) ([a433531](https://github.com/vm0-ai/vm0/commit/a433531030d2deb5f7ab590fd5463f7ad74f17a2))
* extract slack memory from source ledger ([#20519](https://github.com/vm0-ai/vm0/issues/20519)) ([d60a77c](https://github.com/vm0-ai/vm0/commit/d60a77ce42aa1f0db17f2b4d8dfdf98c59e10d28))


### Refactoring

* accept empty artifact manifests without archive urls ([#20525](https://github.com/vm0-ai/vm0/issues/20525)) ([1ce8bfd](https://github.com/vm0-ai/vm0/commit/1ce8bfd954a2c9c0d963dd0a46e34b31fdceb73f))


### Performance Improvements

* add session history attribution telemetry ([#20497](https://github.com/vm0-ai/vm0/issues/20497)) ([2daa651](https://github.com/vm0-ai/vm0/commit/2daa6519837d9f2ca3bbc640e2f1d8e8cc135630))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.162.0
    * @vm0/connectors bumped to 1.147.0
    * @vm0/core bumped to 8.412.0
    * @vm0/db bumped to 1.98.0

## [1.236.0](https://github.com/vm0-ai/vm0/compare/api-v1.235.1...api-v1.236.0) (2026-07-07)


### Features

* add build versions to debug build info ([#20056](https://github.com/vm0-ai/vm0/issues/20056)) ([41d2921](https://github.com/vm0-ai/vm0/commit/41d2921df0beb8f56f12abf3c6c98bd14cdd4cea))
* add Codex fast mode for ChatGPT subscription runs ([#19811](https://github.com/vm0-ai/vm0/issues/19811)) ([42e8e48](https://github.com/vm0-ai/vm0/commit/42e8e4883e548d497eb0b86a936b6be308ad1bed))
* add codex reset controls ([#20119](https://github.com/vm0-ai/vm0/issues/20119)) ([c1f9d22](https://github.com/vm0-ai/vm0/commit/c1f9d22b253bdeb60e4436e13a90793553865230))
* add compatible custom connector auth refs ([#20217](https://github.com/vm0-ai/vm0/issues/20217)) ([d73dee7](https://github.com/vm0-ai/vm0/commit/d73dee77faec8221d93d9b4bb48a8bb1546fd384))
* add Desktop Computer Use filesystem plugins ([#19814](https://github.com/vm0-ai/vm0/issues/19814)) ([062a44c](https://github.com/vm0-ai/vm0/commit/062a44c181536df868bc6b081bae0dd7a2d9d9d6))
* add gmail backfill stop controls ([#20213](https://github.com/vm0-ai/vm0/issues/20213)) ([97ab218](https://github.com/vm0-ai/vm0/commit/97ab2184f5dd9daa1d00856add3531f2f6999bbb))
* add Gmail relationship backfill options ([#20135](https://github.com/vm0-ai/vm0/issues/20135)) ([f2170eb](https://github.com/vm0-ai/vm0/commit/f2170eb06db7a20da76fe571635ce80eb5907dd8))
* add Google Meet transcript-generated workflow trigger ([#19789](https://github.com/vm0-ai/vm0/issues/19789)) ([91aef71](https://github.com/vm0-ai/vm0/commit/91aef711953cb2107c62ae7d2d3a7f9da38a071f))
* add image style transfer toolbar ([#19891](https://github.com/vm0-ai/vm0/issues/19891)) ([f7be929](https://github.com/vm0-ai/vm0/commit/f7be9296810eb9be21725a1a5f5ea589687d5083))
* add notion child page workflow trigger ([#20391](https://github.com/vm0-ai/vm0/issues/20391)) ([e16798b](https://github.com/vm0-ai/vm0/commit/e16798bdef02cd212425fe275c5873a36b6a8ec1))
* add onboarding completion marker ([#20055](https://github.com/vm0-ai/vm0/issues/20055)) ([6d5bf36](https://github.com/vm0-ai/vm0/commit/6d5bf3630093c7a9120ce91b2b746eedf299171d))
* add provider-neutral memory substrate ([#20273](https://github.com/vm0-ai/vm0/issues/20273)) ([67f5573](https://github.com/vm0-ai/vm0/commit/67f5573e2f4c290a94eb016fc45c5ce46df289a4))
* add relationship memory foundation ([#20077](https://github.com/vm0-ai/vm0/issues/20077)) ([805a79e](https://github.com/vm0-ai/vm0/commit/805a79ed91fc55a6261bf6f7180fa4b3c663af7d))
* add runner builtin firewall resolver ([#20368](https://github.com/vm0-ai/vm0/issues/20368)) ([03df5fc](https://github.com/vm0-ai/vm0/commit/03df5fc4eb60b11a262775bbc684fceae4b65b7d))
* add selected model updates to chat thread events ([#20194](https://github.com/vm0-ai/vm0/issues/20194)) ([c558fa4](https://github.com/vm0-ai/vm0/commit/c558fa40e15b0219da973aada401701fa1754749))
* add steam player connector ([#20359](https://github.com/vm0-ai/vm0/issues/20359)) ([830096d](https://github.com/vm0-ai/vm0/commit/830096d68b93cd490769ed98c0c91090bcde6f31))
* add website generation template api prompt support ([#20456](https://github.com/vm0-ai/vm0/issues/20456)) ([dfccd74](https://github.com/vm0-ai/vm0/commit/dfccd7471f2e01176e6064705cba583cd6b07f30))
* bootstrap clerk orgs into limited-free workspaces ([#20029](https://github.com/vm0-ai/vm0/issues/20029)) ([d5ba8c4](https://github.com/vm0-ai/vm0/commit/d5ba8c4359c45fb82032eba9a927d4ffbac72a88))
* **computer-use:** add per-command state-size and structure telemetry ([#19868](https://github.com/vm0-ai/vm0/issues/19868)) ([b829cea](https://github.com/vm0-ai/vm0/commit/b829ceaa83f9279225c21b85a83ca65bd36819a4))
* enable chat thread event sourcing globally ([#20082](https://github.com/vm0-ai/vm0/issues/20082)) ([548a68e](https://github.com/vm0-ai/vm0/commit/548a68eca8f4b700d639d83470b16e026444b851))
* enable gmail relationship backfill from memory ([#20114](https://github.com/vm0-ai/vm0/issues/20114)) ([fd84afd](https://github.com/vm0-ai/vm0/commit/fd84afd077a35a750f4fa01abb6bba87b207f02b))
* enable unsplash-preferred presentation images ([#20473](https://github.com/vm0-ai/vm0/issues/20473)) ([62e713e](https://github.com/vm0-ai/vm0/commit/62e713eeb661823c13c4293f997a6134d10b7c5c))
* expose build commit sha ([#19954](https://github.com/vm0-ai/vm0/issues/19954)) ([50733bd](https://github.com/vm0-ai/vm0/commit/50733bd6e0ed5e57dd476f5139072b18d56018fb))
* extend limited-free onboarding credits ([#20048](https://github.com/vm0-ai/vm0/issues/20048)) ([edddbc0](https://github.com/vm0-ai/vm0/commit/edddbc08cf69ee88c5b9dcada32c7b5ffc25e19a))
* gate composer upload popover ([#20398](https://github.com/vm0-ai/vm0/issues/20398)) ([3718c0e](https://github.com/vm0-ai/vm0/commit/3718c0e91051a8ae57f34775fbb0eb39f59d07cc))
* make steam connector generally available ([#20491](https://github.com/vm0-ai/vm0/issues/20491)) ([2ba3860](https://github.com/vm0-ai/vm0/commit/2ba386084b4134e5b0044dfb8969990b189478ab))
* migrate legacy automations to workflow schedule triggers globally ([#20033](https://github.com/vm0-ai/vm0/issues/20033)) ([eeb91c2](https://github.com/vm0-ai/vm0/commit/eeb91c258a50f67b05a341ebbbbb7e1b872d0030))
* paginate relationship memory search ([#20262](https://github.com/vm0-ai/vm0/issues/20262)) ([f1d4130](https://github.com/vm0-ai/vm0/commit/f1d4130ff818bda248280d0bfc37a08060c1c64a))
* prompt for force upgrade ([#20351](https://github.com/vm0-ai/vm0/issues/20351)) ([2579a2e](https://github.com/vm0-ai/vm0/commit/2579a2e0621b3bf62388b54d9421019bc9bdac3a))
* record chat thread events ([#19807](https://github.com/vm0-ai/vm0/issues/19807)) ([8663a39](https://github.com/vm0-ai/vm0/commit/8663a392c6b94d38a92dd8a3560599fac680678c))
* redesign workflows list with connector pills and next-run view ([#19790](https://github.com/vm0-ai/vm0/issues/19790)) ([1114b1e](https://github.com/vm0-ai/vm0/commit/1114b1e0bdd7b7e0007e91e6048318a568c2fabc))
* refresh active connector permission policies ([#20035](https://github.com/vm0-ai/vm0/issues/20035)) ([8d7cec2](https://github.com/vm0-ai/vm0/commit/8d7cec2537cd512d12bd3e550abc43c07cb2026a))
* render chat threads from event sourcing ([#19929](https://github.com/vm0-ai/vm0/issues/19929)) ([577d15e](https://github.com/vm0-ai/vm0/commit/577d15e5316e45102698c2e33eb0d71a02420228))
* resolve presentation runbook templates in `zero generate presentation --template` ([#20061](https://github.com/vm0-ai/vm0/issues/20061)) ([e4565ed](https://github.com/vm0-ai/vm0/commit/e4565ed884e32e7ecfc99c95bed415b37845ce90))
* roll out chat and memory switches to all orgs ([#20145](https://github.com/vm0-ai/vm0/issues/20145)) ([8cd0184](https://github.com/vm0-ai/vm0/commit/8cd0184b1227f36b76a3919f5a3574e96304d511))
* scope chat thread event sourcing overrides to orgs ([#20069](https://github.com/vm0-ai/vm0/issues/20069)) ([ace2951](https://github.com/vm0-ai/vm0/commit/ace29512a64ac76fbb82f2ca4fecc766c9e41c22))
* serve web client compatibility from api ([#20514](https://github.com/vm0-ai/vm0/issues/20514)) ([9cc8491](https://github.com/vm0-ai/vm0/commit/9cc84912973de3a913413220f68de56d093c71d7))
* show workflow owner Clerk avatar and widen hover card row spacing ([#19960](https://github.com/vm0-ai/vm0/issues/19960)) ([9ee4853](https://github.com/vm0-ai/vm0/commit/9ee48530988d3e8fa4c2a4637b930ca191f48031))
* support full runner builtin firewall catalog resolve ([#20458](https://github.com/vm0-ai/vm0/issues/20458)) ([6bde030](https://github.com/vm0-ai/vm0/commit/6bde030ff15cfdb932c6935c5aefb0c7c269abfc))
* support safe script patches for html edits ([#19810](https://github.com/vm0-ai/vm0/issues/19810)) ([72a6222](https://github.com/vm0-ai/vm0/commit/72a622216dca7282a8e84f0f91804b90c628eacd))
* support zstd session history blobs ([#20341](https://github.com/vm0-ai/vm0/issues/20341)) ([c4188fa](https://github.com/vm0-ai/vm0/commit/c4188fa5b28587f197998421ac5032c228913c25))
* upload presentation artifacts to google slides ([#20039](https://github.com/vm0-ai/vm0/issues/20039)) ([af5a149](https://github.com/vm0-ai/vm0/commit/af5a149c6d9c67634a753ffb806da3dc69012d50))
* use zero avatar for default agents ([#20053](https://github.com/vm0-ai/vm0/issues/20053)) ([08deee2](https://github.com/vm0-ai/vm0/commit/08deee28bd3d5c255d1d1dce94c540caa632ea97))
* wire warm cards website template resource ([#20432](https://github.com/vm0-ai/vm0/issues/20432)) ([523b392](https://github.com/vm0-ai/vm0/commit/523b392ed25a36663d77a522fb457f16d9803609))
* **workflows:** gate webhook trigger creation with a separate switch ([#20041](https://github.com/vm0-ai/vm0/issues/20041)) ([9c0f0c2](https://github.com/vm0-ai/vm0/commit/9c0f0c21a0cf62d97d682d6f4de2831c17e1a832))


### Bug Fixes

* align teams system prompt organization ([#19736](https://github.com/vm0-ai/vm0/issues/19736)) ([f196882](https://github.com/vm0-ai/vm0/commit/f196882fbe1eac2e89c9115c3fbb2f81e5949783))
* allow private workflows on visible agents ([#20502](https://github.com/vm0-ai/vm0/issues/20502)) ([ff4f6de](https://github.com/vm0-ai/vm0/commit/ff4f6de496a05710e2c3ea4d99692e0c22d11804))
* allow team access to paid video templates ([#19922](https://github.com/vm0-ai/vm0/issues/19922)) ([1c4476e](https://github.com/vm0-ai/vm0/commit/1c4476e702b597b093d3d07396843d21fc5cea04))
* allow vm7 preview cors origins ([#20378](https://github.com/vm0-ai/vm0/issues/20378)) ([1e16d99](https://github.com/vm0-ai/vm0/commit/1e16d99eac5af148f5d878dce3fbf6579835cae4))
* **api:** enforce signal-aware deferred promises ([#20187](https://github.com/vm0-ai/vm0/issues/20187)) ([a37afd6](https://github.com/vm0-ai/vm0/commit/a37afd65548e181f76a34a851285bbd34b0a6f6e))
* **api:** make generation template context one-shot ([#19962](https://github.com/vm0-ai/vm0/issues/19962)) ([fa29e6e](https://github.com/vm0-ai/vm0/commit/fa29e6eb688eee3fad803691411697cff656011f))
* **api:** refresh API release marker comment ([#19882](https://github.com/vm0-ai/vm0/issues/19882)) ([9335907](https://github.com/vm0-ai/vm0/commit/93359071908b7209a3d3503d2a81a9bf3fef2904))
* avoid storing raw gmail relationship excerpts ([#20130](https://github.com/vm0-ai/vm0/issues/20130)) ([cc3643d](https://github.com/vm0-ai/vm0/commit/cc3643d435314f8ee5da7c7859367ccd4664e7ab))
* block byok model routes for limited-free workspaces ([#20066](https://github.com/vm0-ai/vm0/issues/20066)) ([4f05e30](https://github.com/vm0-ai/vm0/commit/4f05e3002cdfe75b7a7162e8bc363adf74500248))
* cache workflow avatars and reveal webhook secrets on demand ([#20073](https://github.com/vm0-ai/vm0/issues/20073)) ([d39c8eb](https://github.com/vm0-ai/vm0/commit/d39c8eb9b3fe014795aaef38f2baab2dbd67704b))
* coalesce runner direct candidate bursts ([#19969](https://github.com/vm0-ai/vm0/issues/19969)) ([1135a51](https://github.com/vm0-ai/vm0/commit/1135a514c5e5ca21bb0b929885e98e9061fe581b))
* **core:** update schoolhouse and sticker scrapbook runbook archives ([#19947](https://github.com/vm0-ai/vm0/issues/19947)) ([017be61](https://github.com/vm0-ai/vm0/commit/017be619eea4a82478ddab3f77eb6bad339a81bd))
* drop the fallback DB note for generation template selections ([#19831](https://github.com/vm0-ai/vm0/issues/19831)) ([83cb5f3](https://github.com/vm0-ai/vm0/commit/83cb5f35ca84d4dc3d6f83ef639ed95b581e9129))
* exclude active runs and goals from unread thread ids ([#20243](https://github.com/vm0-ai/vm0/issues/20243)) ([5cf4b03](https://github.com/vm0-ai/vm0/commit/5cf4b03408e6049e83f7f313dcba790f51f8c85f))
* fetch all draft chat thread ids ([#20149](https://github.com/vm0-ai/vm0/issues/20149)) ([7b02fa2](https://github.com/vm0-ai/vm0/commit/7b02fa272811f75f9b897f92ab82da618d818110))
* hydrate event-sourced chat thread running state ([#20031](https://github.com/vm0-ai/vm0/issues/20031)) ([40a3f06](https://github.com/vm0-ai/vm0/commit/40a3f06a578903e50ae51990905f23c843bea39e))
* keep follow-up prompts plain text ([#20308](https://github.com/vm0-ai/vm0/issues/20308)) ([0883d8b](https://github.com/vm0-ai/vm0/commit/0883d8b23c67affb0f48782cf11edf75514c4aca))
* make chat messages immutable in thread views ([#20332](https://github.com/vm0-ai/vm0/issues/20332)) ([c231866](https://github.com/vm0-ai/vm0/commit/c231866b635ebbe621d73a83c6bff7bebd2a1532))
* narrow org-scoped feature switch rollouts ([#20196](https://github.com/vm0-ai/vm0/issues/20196)) ([639c9f1](https://github.com/vm0-ai/vm0/commit/639c9f1e34a8d31802c8936ccfa006b9dde0b65f))
* persist chat thread model selection at creation ([#20229](https://github.com/vm0-ai/vm0/issues/20229)) ([ded7688](https://github.com/vm0-ai/vm0/commit/ded7688a0d9ef4b703d1037d15af43389ff3f65a))
* prefill workflow refine prompts ([#20131](https://github.com/vm0-ai/vm0/issues/20131)) ([7c6847f](https://github.com/vm0-ai/vm0/commit/7c6847f0e76035a4821d32ac27a483869057ba3a))
* prevent chat thread snapshot compactor starvation ([#20313](https://github.com/vm0-ai/vm0/issues/20313)) ([aff8142](https://github.com/vm0-ai/vm0/commit/aff81423409d472a5cc162617cdbf816e30d1498))
* prevent goal continuation from preempting queued chat ([#19950](https://github.com/vm0-ai/vm0/issues/19950)) ([2af12c7](https://github.com/vm0-ai/vm0/commit/2af12c7a28e815cd53f120384859b8a4e16cceb0))
* protect same-session runner affinity claims ([#19764](https://github.com/vm0-ai/vm0/issues/19764)) ([5bbd286](https://github.com/vm0-ai/vm0/commit/5bbd2862e2eceb51a71ba681a24d64b87894d712))
* prune chat thread events after compaction ([#20072](https://github.com/vm0-ai/vm0/issues/20072)) ([5b382db](https://github.com/vm0-ai/vm0/commit/5b382db8883a14abff23cda3ac79772ed6423c31))
* remove google oauth preconnect notice ([#20298](https://github.com/vm0-ai/vm0/issues/20298)) ([fc6ac03](https://github.com/vm0-ai/vm0/commit/fc6ac0399054084d2b3f19b12fd0496e90d493d6))
* remove invalid goal deny rules ([#19996](https://github.com/vm0-ai/vm0/issues/19996)) ([f990cc2](https://github.com/vm0-ai/vm0/commit/f990cc2bc5c16e924fa9f08dfe7ad46cf550db2f))
* remove limited free onboarding endpoint ([#20047](https://github.com/vm0-ai/vm0/issues/20047)) ([c216eb3](https://github.com/vm0-ai/vm0/commit/c216eb313d3a73a685b9b2c1d5d39c5b531b85f9))
* require agent google drive authorization for artifact sync ([#20382](https://github.com/vm0-ai/vm0/issues/20382)) ([84c9732](https://github.com/vm0-ai/vm0/commit/84c97329b9edc8aea951959446533c64893594f4))
* route byteplus stt through proxy ([#20015](https://github.com/vm0-ai/vm0/issues/20015)) ([9090018](https://github.com/vm0-ai/vm0/commit/9090018f39b18678c1cfe1fa79fa8e84fc39c815))
* run goal continuations from the full objective prompt ([#19991](https://github.com/vm0-ai/vm0/issues/19991)) ([05a2ef8](https://github.com/vm0-ai/vm0/commit/05a2ef8136d310b8068f53d70e485992ee891639))
* **runner:** remove session history claim capabilities ([#19832](https://github.com/vm0-ai/vm0/issues/19832)) ([f80876f](https://github.com/vm0-ai/vm0/commit/f80876f4dbfd3674f7b60b34941a1783dbe26f04))
* show gpt 5.5 as the friendly model label ([#20364](https://github.com/vm0-ai/vm0/issues/20364)) ([984a98b](https://github.com/vm0-ai/vm0/commit/984a98bbee7a72674a9b79b60c0b046a1ce865eb))
* show owner name and avatar in workflow detail created-by tooltip ([#20279](https://github.com/vm0-ai/vm0/issues/20279)) ([e4e54ba](https://github.com/vm0-ai/vm0/commit/e4e54ba9b22e4f5d0a27df0ea66f0da8df9b1d0f))
* update chat thread recency for direct sends and run finishes ([#20256](https://github.com/vm0-ai/vm0/issues/20256)) ([e70397f](https://github.com/vm0-ai/vm0/commit/e70397f7d8c3aa8f86828bf60ac46abc57dbfb38))
* use Gmail message time for relationship memory ([#20197](https://github.com/vm0-ai/vm0/issues/20197)) ([616c316](https://github.com/vm0-ai/vm0/commit/616c316061891266deb4773ae32dff44e33ebc57))
* use run-finish timestamps for chat thread unread state ([#20236](https://github.com/vm0-ai/vm0/issues/20236)) ([9e4cb65](https://github.com/vm0-ai/vm0/commit/9e4cb659f32a0449d3f506232f4b4ca8dabc6a29))
* warm background chat cache after follow-ups finish ([#20487](https://github.com/vm0-ai/vm0/issues/20487)) ([0173a36](https://github.com/vm0-ai/vm0/commit/0173a36238c741ca6b3748808d64df9eeb8d3a56))


### Documentation

* add deployment compatibility guidance ([#20037](https://github.com/vm0-ai/vm0/issues/20037)) ([0d0d145](https://github.com/vm0-ai/vm0/commit/0d0d145b8a7ad4bb792b8a5d9dd0ece70741f2ff))


### Refactoring

* **api:** remove zero chat thread list route ([#20113](https://github.com/vm0-ai/vm0/issues/20113)) ([71550af](https://github.com/vm0-ai/vm0/commit/71550af196199bffdc23d231a2bc1ad6c54155fb))
* bridge runner_state admittable profiles ([#20272](https://github.com/vm0-ai/vm0/issues/20272)) ([743a786](https://github.com/vm0-ai/vm0/commit/743a78618b048c7db0b84513f18d3459be1b4057))
* clarify runner profile availability contract ([#20171](https://github.com/vm0-ai/vm0/issues/20171)) ([ef94c04](https://github.com/vm0-ai/vm0/commit/ef94c04b34a0eacb9a3ddc7ffd1cabc419c19113))
* drop legacy automation tables and read-only automation surfaces ([#20420](https://github.com/vm0-ai/vm0/issues/20420)) ([bfbf99b](https://github.com/vm0-ai/vm0/commit/bfbf99bbe639ec9c9ce67a37b5155e8478f96224))
* drop legacy runner state profile columns ([#20327](https://github.com/vm0-ai/vm0/issues/20327)) ([6ef8133](https://github.com/vm0-ai/vm0/commit/6ef8133e7d5095c1697541946a3e47c9c1caed8d))
* extract custom eslint rules package ([#20188](https://github.com/vm0-ai/vm0/issues/20188)) ([e2ca0d3](https://github.com/vm0-ai/vm0/commit/e2ca0d3dd59a3f80e77a79a626615c532841201b))
* narrow chat thread detail payload ([#20267](https://github.com/vm0-ai/vm0/issues/20267)) ([9717d60](https://github.com/vm0-ai/vm0/commit/9717d60b535745157f9bc2a743f42c20be58ec0b))
* **platform:** remove pinned agent sorting ([#20051](https://github.com/vm0-ai/vm0/issues/20051)) ([e3e7436](https://github.com/vm0-ai/vm0/commit/e3e7436aeee8170a54e846a86bf7dd4a36449f0a))
* read chat thread selected model from event projection ([#20204](https://github.com/vm0-ai/vm0/issues/20204)) ([2a76f6d](https://github.com/vm0-ai/vm0/commit/2a76f6dfbe6ad7bbc32e2d5803d8c3207e976284))
* reduce fallback slop in API model state ([#19920](https://github.com/vm0-ai/vm0/issues/19920)) ([9e80759](https://github.com/vm0-ai/vm0/commit/9e807591f3a5c03aa115a7224dc032d2a990d6e3))
* reduce fallback slop in runtime guards ([#20275](https://github.com/vm0-ai/vm0/issues/20275)) ([73e668c](https://github.com/vm0-ai/vm0/commit/73e668ce7135504b171be98ca2832d09b433f34b))
* reduce fallback slop in test support contracts ([#19915](https://github.com/vm0-ai/vm0/issues/19915)) ([d2ca8c0](https://github.com/vm0-ai/vm0/commit/d2ca8c013c73602f2ed48b34693914b78a31cf3d))
* remove computer use delegated authorization switch ([#19971](https://github.com/vm0-ai/vm0/issues/19971)) ([682219b](https://github.com/vm0-ai/vm0/commit/682219bb52c9519cf96d6cfe39e50385718dad71))
* remove ga chat and export feature switches ([#20108](https://github.com/vm0-ai/vm0/issues/20108)) ([722d7c7](https://github.com/vm0-ai/vm0/commit/722d7c7833a003ea58b12fc8a34132c1aa4eb152))
* remove legacy automation poller, mutating routes, and the cli command ([#20103](https://github.com/vm0-ai/vm0/issues/20103)) ([2245f83](https://github.com/vm0-ai/vm0/commit/2245f83430aefa545077e5da1e8929d9c4968628))
* remove presentation design-system selection ([#20371](https://github.com/vm0-ai/vm0/issues/20371)) ([bb56ceb](https://github.com/vm0-ai/vm0/commit/bb56ceb0c43fe57028535ab03cd4911f051aeff0))
* remove runner profile compatibility fields ([#20255](https://github.com/vm0-ai/vm0/issues/20255)) ([7972fa3](https://github.com/vm0-ai/vm0/commit/7972fa3a2aa317e99ba40503b5d6dae35e0d6df8))
* retire legacy html-ppt presentation registry entries (presentations runbook-only) ([#20064](https://github.com/vm0-ai/vm0/issues/20064)) ([b92a71c](https://github.com/vm0-ai/vm0/commit/b92a71c98a4c48b1fec6a610dd179a09f4d86c62))
* retire presentation-deck-tools server-side (phase 2) ([#20012](https://github.com/vm0-ai/vm0/issues/20012)) ([9626a84](https://github.com/vm0-ai/vm0/commit/9626a842ba1ad35502dc97d507acbd58f969e7aa))
* retire PresentationTemplateRunbook feature switch, make runbook flow the default ([#19965](https://github.com/vm0-ai/vm0/issues/19965)) ([47bc92d](https://github.com/vm0-ai/vm0/commit/47bc92da3ffbcabd103ef91dd87739be813c4989))
* retire the workflow automation feature switch as always-on ([#20357](https://github.com/vm0-ai/vm0/issues/20357)) ([840b415](https://github.com/vm0-ai/vm0/commit/840b41551ab88a25aeeec08f01a18ccd6a5b36ff))
* serve connector category metadata from catalog api ([#20089](https://github.com/vm0-ai/vm0/issues/20089)) ([99bafd7](https://github.com/vm0-ai/vm0/commit/99bafd7d276f1ae151c4cd7b409e8268a8487848))
* serve platform permission metadata from catalog api ([#20028](https://github.com/vm0-ai/vm0/issues/20028)) ([2c8f731](https://github.com/vm0-ai/vm0/commit/2c8f73192fcdd01f53571d2ed5d6c60c83429807))
* split chat thread draft read API ([#20192](https://github.com/vm0-ai/vm0/issues/20192)) ([61c4e87](https://github.com/vm0-ai/vm0/commit/61c4e87c3015982d8a419f5f176cc6280549eef4))
* tighten google meet event schema ([#20105](https://github.com/vm0-ai/vm0/issues/20105)) ([c0f810c](https://github.com/vm0-ai/vm0/commit/c0f810c40ef6d139f1739f5b19b14ec07363793a))


### Performance Improvements

* accept platform secret firewall auth metadata ([#20415](https://github.com/vm0-ai/vm0/issues/20415)) ([93be26d](https://github.com/vm0-ai/vm0/commit/93be26d46ee80cd43d61e2641fd7a8af15899ff3))
* add artifact ensure storage manifest timing ([#19901](https://github.com/vm0-ai/vm0/issues/19901)) ([749e1bb](https://github.com/vm0-ai/vm0/commit/749e1bb01dcd16c04347ec1c7f174af7e167c9ad))
* add custom connector runtime timing ([#19949](https://github.com/vm0-ai/vm0/issues/19949)) ([e2d7a85](https://github.com/vm0-ai/vm0/commit/e2d7a857caf510b76004a708f68fdbb6094718d1))
* add session history attribution telemetry ([#20497](https://github.com/vm0-ai/vm0/issues/20497)) ([2daa651](https://github.com/vm0-ai/vm0/commit/2daa6519837d9f2ca3bbc640e2f1d8e8cc135630))
* add session history telemetry buckets ([#19953](https://github.com/vm0-ai/vm0/issues/19953)) ([27309a2](https://github.com/vm0-ai/vm0/commit/27309a250f9374e3e8a1d46fa4476d57b248522d))
* **api:** lazily emit connector platform secret metadata ([#20451](https://github.com/vm0-ai/vm0/issues/20451)) ([232b7f9](https://github.com/vm0-ai/vm0/commit/232b7f9c5c5ff4ec92cf4ebf5cbb6eb2ea4d8662))
* attribute storage manifest presign sources ([#20080](https://github.com/vm0-ai/vm0/issues/20080)) ([5d3e2ae](https://github.com/vm0-ai/vm0/commit/5d3e2aea66a9bc1ccf29f1e4ac0be6da1e90e861))
* attribute workflow event source timing ([#19998](https://github.com/vm0-ai/vm0/issues/19998)) ([2856fff](https://github.com/vm0-ai/vm0/commit/2856fff042e21529141082a27c7ecb528266fc5d))
* cache workflow skill storage presigned urls ([#20323](https://github.com/vm0-ai/vm0/issues/20323)) ([cb6fab3](https://github.com/vm0-ai/vm0/commit/cb6fab39784b16d810d1ef239370607f4dc4753a))
* lazily materialize custom connector auth ([#20258](https://github.com/vm0-ai/vm0/issues/20258)) ([57d47d7](https://github.com/vm0-ai/vm0/commit/57d47d729ad48e626b63d71fcd69f93deec7c692))
* skip empty artifact uploads during run creation ([#20447](https://github.com/vm0-ai/vm0/issues/20447)) ([85f5231](https://github.com/vm0-ai/vm0/commit/85f5231cceb002fdcbf8faf826d8ca7df7332a39))
* skip session affinity delay without viable holder ([#20030](https://github.com/vm0-ai/vm0/issues/20030)) ([c96b651](https://github.com/vm0-ai/vm0/commit/c96b6516047d448edb72a82d20a546871ed0dcfa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.161.0
    * @vm0/core bumped to 8.411.1
    * @vm0/db bumped to 1.97.2

## [1.235.1](https://github.com/vm0-ai/vm0/compare/api-v1.235.0...api-v1.235.1) (2026-07-07)


### Bug Fixes

* require agent google drive authorization for artifact sync ([#20382](https://github.com/vm0-ai/vm0/issues/20382)) ([84c9732](https://github.com/vm0-ai/vm0/commit/84c97329b9edc8aea951959446533c64893594f4))

## [1.235.0](https://github.com/vm0-ai/vm0/compare/api-v1.234.0...api-v1.235.0) (2026-07-07)


### Features

* make steam connector generally available ([#20491](https://github.com/vm0-ai/vm0/issues/20491)) ([2ba3860](https://github.com/vm0-ai/vm0/commit/2ba386084b4134e5b0044dfb8969990b189478ab))


### Bug Fixes

* align teams system prompt organization ([#19736](https://github.com/vm0-ai/vm0/issues/19736)) ([f196882](https://github.com/vm0-ai/vm0/commit/f196882fbe1eac2e89c9115c3fbb2f81e5949783))
* allow private workflows on visible agents ([#20502](https://github.com/vm0-ai/vm0/issues/20502)) ([ff4f6de](https://github.com/vm0-ai/vm0/commit/ff4f6de496a05710e2c3ea4d99692e0c22d11804))
* warm background chat cache after follow-ups finish ([#20487](https://github.com/vm0-ai/vm0/issues/20487)) ([0173a36](https://github.com/vm0-ai/vm0/commit/0173a36238c741ca6b3748808d64df9eeb8d3a56))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.160.1
    * @vm0/connectors bumped to 1.146.0
    * @vm0/core bumped to 8.411.0
    * @vm0/db bumped to 1.97.1

## [1.234.0](https://github.com/vm0-ai/vm0/compare/api-v1.233.1...api-v1.234.0) (2026-07-07)


### Features

* add website generation template api prompt support ([#20456](https://github.com/vm0-ai/vm0/issues/20456)) ([dfccd74](https://github.com/vm0-ai/vm0/commit/dfccd7471f2e01176e6064705cba583cd6b07f30))
* support full runner builtin firewall catalog resolve ([#20458](https://github.com/vm0-ai/vm0/issues/20458)) ([6bde030](https://github.com/vm0-ai/vm0/commit/6bde030ff15cfdb932c6935c5aefb0c7c269abfc))


### Performance Improvements

* skip empty artifact uploads during run creation ([#20447](https://github.com/vm0-ai/vm0/issues/20447)) ([85f5231](https://github.com/vm0-ai/vm0/commit/85f5231cceb002fdcbf8faf826d8ca7df7332a39))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.160.0
    * @vm0/connectors bumped to 1.145.0
    * @vm0/core bumped to 8.410.0
    * @vm0/db bumped to 1.97.0

## [1.233.1](https://github.com/vm0-ai/vm0/compare/api-v1.233.0...api-v1.233.1) (2026-07-07)


### Performance Improvements

* **api:** lazily emit connector platform secret metadata ([#20451](https://github.com/vm0-ai/vm0/issues/20451)) ([232b7f9](https://github.com/vm0-ai/vm0/commit/232b7f9c5c5ff4ec92cf4ebf5cbb6eb2ea4d8662))

## [1.233.0](https://github.com/vm0-ai/vm0/compare/api-v1.232.2...api-v1.233.0) (2026-07-07)


### Features

* prompt for force upgrade ([#20351](https://github.com/vm0-ai/vm0/issues/20351)) ([2579a2e](https://github.com/vm0-ai/vm0/commit/2579a2e0621b3bf62388b54d9421019bc9bdac3a))
* wire warm cards website template resource ([#20432](https://github.com/vm0-ai/vm0/issues/20432)) ([523b392](https://github.com/vm0-ai/vm0/commit/523b392ed25a36663d77a522fb457f16d9803609))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.159.3
    * @vm0/connectors bumped to 1.144.0
    * @vm0/core bumped to 8.409.0
    * @vm0/db bumped to 1.96.7

## [1.232.2](https://github.com/vm0-ai/vm0/compare/api-v1.232.1...api-v1.232.2) (2026-07-06)


### Refactoring

* drop legacy automation tables and read-only automation surfaces ([#20420](https://github.com/vm0-ai/vm0/issues/20420)) ([bfbf99b](https://github.com/vm0-ai/vm0/commit/bfbf99bbe639ec9c9ce67a37b5155e8478f96224))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.159.2
    * @vm0/core bumped to 8.408.2
    * @vm0/db bumped to 1.96.6

## [1.232.1](https://github.com/vm0-ai/vm0/compare/api-v1.232.0...api-v1.232.1) (2026-07-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.159.1
    * @vm0/core bumped to 8.408.1
    * @vm0/db bumped to 1.96.5

## [1.232.0](https://github.com/vm0-ai/vm0/compare/api-v1.231.3...api-v1.232.0) (2026-07-06)


### Features

* add steam player connector ([#20359](https://github.com/vm0-ai/vm0/issues/20359)) ([830096d](https://github.com/vm0-ai/vm0/commit/830096d68b93cd490769ed98c0c91090bcde6f31))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.159.0
    * @vm0/connectors bumped to 1.143.0
    * @vm0/core bumped to 8.408.0
    * @vm0/db bumped to 1.96.4

## [1.231.3](https://github.com/vm0-ai/vm0/compare/api-v1.231.2...api-v1.231.3) (2026-07-06)


### Performance Improvements

* accept platform secret firewall auth metadata ([#20415](https://github.com/vm0-ai/vm0/issues/20415)) ([93be26d](https://github.com/vm0-ai/vm0/commit/93be26d46ee80cd43d61e2641fd7a8af15899ff3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.158.2
    * @vm0/connectors bumped to 1.142.1
    * @vm0/core bumped to 8.407.2
    * @vm0/db bumped to 1.96.3

## [1.231.2](https://github.com/vm0-ai/vm0/compare/api-v1.231.1...api-v1.231.2) (2026-07-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.407.1
    * @vm0/db bumped to 1.96.2

## [1.231.1](https://github.com/vm0-ai/vm0/compare/api-v1.231.0...api-v1.231.1) (2026-07-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.158.1
    * @vm0/connectors bumped to 1.142.0
    * @vm0/core bumped to 8.407.0
    * @vm0/db bumped to 1.96.1

## [1.231.0](https://github.com/vm0-ai/vm0/compare/api-v1.230.1...api-v1.231.0) (2026-07-06)


### Features

* add notion child page workflow trigger ([#20391](https://github.com/vm0-ai/vm0/issues/20391)) ([e16798b](https://github.com/vm0-ai/vm0/commit/e16798bdef02cd212425fe275c5873a36b6a8ec1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.158.0
    * @vm0/connectors bumped to 1.141.0
    * @vm0/core bumped to 8.406.0
    * @vm0/db bumped to 1.96.0

## [1.230.1](https://github.com/vm0-ai/vm0/compare/api-v1.230.0...api-v1.230.1) (2026-07-06)


### Bug Fixes

* allow vm7 preview cors origins ([#20378](https://github.com/vm0-ai/vm0/issues/20378)) ([1e16d99](https://github.com/vm0-ai/vm0/commit/1e16d99eac5af148f5d878dce3fbf6579835cae4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.95.0

## [1.230.0](https://github.com/vm0-ai/vm0/compare/api-v1.229.0...api-v1.230.0) (2026-07-06)


### Features

* support zstd session history blobs ([#20341](https://github.com/vm0-ai/vm0/issues/20341)) ([c4188fa](https://github.com/vm0-ai/vm0/commit/c4188fa5b28587f197998421ac5032c228913c25))


### Bug Fixes

* make chat messages immutable in thread views ([#20332](https://github.com/vm0-ai/vm0/issues/20332)) ([c231866](https://github.com/vm0-ai/vm0/commit/c231866b635ebbe621d73a83c6bff7bebd2a1532))


### Refactoring

* retire the workflow automation feature switch as always-on ([#20357](https://github.com/vm0-ai/vm0/issues/20357)) ([840b415](https://github.com/vm0-ai/vm0/commit/840b41551ab88a25aeeec08f01a18ccd6a5b36ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.157.0
    * @vm0/connectors bumped to 1.140.0
    * @vm0/core bumped to 8.405.0
    * @vm0/db bumped to 1.94.2

## [1.229.0](https://github.com/vm0-ai/vm0/compare/api-v1.228.0...api-v1.229.0) (2026-07-06)


### Features

* upload presentation artifacts to google slides ([#20039](https://github.com/vm0-ai/vm0/issues/20039)) ([af5a149](https://github.com/vm0-ai/vm0/commit/af5a149c6d9c67634a753ffb806da3dc69012d50))


### Refactoring

* drop legacy runner state profile columns ([#20327](https://github.com/vm0-ai/vm0/issues/20327)) ([6ef8133](https://github.com/vm0-ai/vm0/commit/6ef8133e7d5095c1697541946a3e47c9c1caed8d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.156.0
    * @vm0/connectors bumped to 1.139.0
    * @vm0/core bumped to 8.404.0
    * @vm0/db bumped to 1.94.1

## [1.228.0](https://github.com/vm0-ai/vm0/compare/api-v1.227.4...api-v1.228.0) (2026-07-06)


### Features

* add birefnet and clarity-upscaler transform image models ([#19704](https://github.com/vm0-ai/vm0/issues/19704)) ([e62b2e0](https://github.com/vm0-ai/vm0/commit/e62b2e0a242af4e522cda1f440ee6a5e4ebdbbc5))
* add build versions to debug build info ([#20056](https://github.com/vm0-ai/vm0/issues/20056)) ([41d2921](https://github.com/vm0-ai/vm0/commit/41d2921df0beb8f56f12abf3c6c98bd14cdd4cea))
* add byteplus voice input stt ([#19510](https://github.com/vm0-ai/vm0/issues/19510)) ([42665c5](https://github.com/vm0-ai/vm0/commit/42665c5054ab243593122ab999f98829f301f6b7))
* add Codex fast mode for ChatGPT subscription runs ([#19811](https://github.com/vm0-ai/vm0/issues/19811)) ([42e8e48](https://github.com/vm0-ai/vm0/commit/42e8e4883e548d497eb0b86a936b6be308ad1bed))
* add codex reset controls ([#20119](https://github.com/vm0-ai/vm0/issues/20119)) ([c1f9d22](https://github.com/vm0-ai/vm0/commit/c1f9d22b253bdeb60e4436e13a90793553865230))
* add compatible custom connector auth refs ([#20217](https://github.com/vm0-ai/vm0/issues/20217)) ([d73dee7](https://github.com/vm0-ai/vm0/commit/d73dee77faec8221d93d9b4bb48a8bb1546fd384))
* add Desktop Computer Use filesystem plugins ([#19814](https://github.com/vm0-ai/vm0/issues/19814)) ([062a44c](https://github.com/vm0-ai/vm0/commit/062a44c181536df868bc6b081bae0dd7a2d9d9d6))
* add gmail backfill stop controls ([#20213](https://github.com/vm0-ai/vm0/issues/20213)) ([97ab218](https://github.com/vm0-ai/vm0/commit/97ab2184f5dd9daa1d00856add3531f2f6999bbb))
* add Gmail relationship backfill options ([#20135](https://github.com/vm0-ai/vm0/issues/20135)) ([f2170eb](https://github.com/vm0-ai/vm0/commit/f2170eb06db7a20da76fe571635ce80eb5907dd8))
* add Google Meet transcript-generated workflow trigger ([#19789](https://github.com/vm0-ai/vm0/issues/19789)) ([91aef71](https://github.com/vm0-ai/vm0/commit/91aef711953cb2107c62ae7d2d3a7f9da38a071f))
* add onboarding completion marker ([#20055](https://github.com/vm0-ai/vm0/issues/20055)) ([6d5bf36](https://github.com/vm0-ai/vm0/commit/6d5bf3630093c7a9120ce91b2b746eedf299171d))
* add Pexels as presentation image provider with Unsplash-preferred switch ([#19756](https://github.com/vm0-ai/vm0/issues/19756)) ([9222ea2](https://github.com/vm0-ai/vm0/commit/9222ea207ba7a4224eb6809d46ccac2b02ece38b))
* add provider-neutral memory substrate ([#20273](https://github.com/vm0-ai/vm0/issues/20273)) ([67f5573](https://github.com/vm0-ai/vm0/commit/67f5573e2f4c290a94eb016fc45c5ce46df289a4))
* add relationship memory foundation ([#20077](https://github.com/vm0-ai/vm0/issues/20077)) ([805a79e](https://github.com/vm0-ai/vm0/commit/805a79ed91fc55a6261bf6f7180fa4b3c663af7d))
* add selected model updates to chat thread events ([#20194](https://github.com/vm0-ai/vm0/issues/20194)) ([c558fa4](https://github.com/vm0-ai/vm0/commit/c558fa40e15b0219da973aada401701fa1754749))
* add teams settings ui ([#19570](https://github.com/vm0-ai/vm0/issues/19570)) ([242e261](https://github.com/vm0-ai/vm0/commit/242e26146208b187de904e92116590bb767bc5e9))
* add workflow templates to composer ([#19660](https://github.com/vm0-ai/vm0/issues/19660)) ([1f110fd](https://github.com/vm0-ai/vm0/commit/1f110fd9d3ae503e731e957767a76d0094ce88a9))
* bootstrap clerk orgs into limited-free workspaces ([#20029](https://github.com/vm0-ai/vm0/issues/20029)) ([d5ba8c4](https://github.com/vm0-ai/vm0/commit/d5ba8c4359c45fb82032eba9a927d4ffbac72a88))
* **chat:** add initial thinking indicator ([#19690](https://github.com/vm0-ai/vm0/issues/19690)) ([8536d01](https://github.com/vm0-ai/vm0/commit/8536d012ca9cc7581c7f912d9dce1b06efe21d9b))
* **chat:** relax initial thinking prompt ([#19706](https://github.com/vm0-ai/vm0/issues/19706)) ([be396cd](https://github.com/vm0-ai/vm0/commit/be396cd3c291d3390faccd313a26fd7d1620e019))
* **computer-use:** add per-command state-size and structure telemetry ([#19868](https://github.com/vm0-ai/vm0/issues/19868)) ([b829cea](https://github.com/vm0-ai/vm0/commit/b829ceaa83f9279225c21b85a83ca65bd36819a4))
* enable chat thread event sourcing globally ([#20082](https://github.com/vm0-ai/vm0/issues/20082)) ([548a68e](https://github.com/vm0-ai/vm0/commit/548a68eca8f4b700d639d83470b16e026444b851))
* enable gmail relationship backfill from memory ([#20114](https://github.com/vm0-ai/vm0/issues/20114)) ([fd84afd](https://github.com/vm0-ai/vm0/commit/fd84afd077a35a750f4fa01abb6bba87b207f02b))
* export user-owned data files ([#19664](https://github.com/vm0-ai/vm0/issues/19664)) ([af2f0f3](https://github.com/vm0-ai/vm0/commit/af2f0f3c41cb147690d179937197762604479e11))
* expose build commit sha ([#19954](https://github.com/vm0-ai/vm0/issues/19954)) ([50733bd](https://github.com/vm0-ai/vm0/commit/50733bd6e0ed5e57dd476f5139072b18d56018fb))
* expose connector catalog status view models ([#19580](https://github.com/vm0-ai/vm0/issues/19580)) ([697e259](https://github.com/vm0-ai/vm0/commit/697e25903a89443aa024dc38dfaca850133d99db))
* extend limited-free onboarding credits ([#20048](https://github.com/vm0-ai/vm0/issues/20048)) ([edddbc0](https://github.com/vm0-ai/vm0/commit/edddbc08cf69ee88c5b9dcada32c7b5ffc25e19a))
* gate MiniMax Codex framework routing ([#19616](https://github.com/vm0-ai/vm0/issues/19616)) ([ed9b1de](https://github.com/vm0-ai/vm0/commit/ed9b1dea4c8b95ed78074f6fa2f9197dded9cdbc))
* migrate legacy automations to workflow schedule triggers globally ([#20033](https://github.com/vm0-ai/vm0/issues/20033)) ([eeb91c2](https://github.com/vm0-ai/vm0/commit/eeb91c258a50f67b05a341ebbbbb7e1b872d0030))
* paginate relationship memory search ([#20262](https://github.com/vm0-ai/vm0/issues/20262)) ([f1d4130](https://github.com/vm0-ai/vm0/commit/f1d4130ff818bda248280d0bfc37a08060c1c64a))
* record chat thread events ([#19807](https://github.com/vm0-ai/vm0/issues/19807)) ([8663a39](https://github.com/vm0-ai/vm0/commit/8663a392c6b94d38a92dd8a3560599fac680678c))
* redesign workflows list with connector pills and next-run view ([#19790](https://github.com/vm0-ai/vm0/issues/19790)) ([1114b1e](https://github.com/vm0-ai/vm0/commit/1114b1e0bdd7b7e0007e91e6048318a568c2fabc))
* refresh active connector permission policies ([#20035](https://github.com/vm0-ai/vm0/issues/20035)) ([8d7cec2](https://github.com/vm0-ai/vm0/commit/8d7cec2537cd512d12bd3e550abc43c07cb2026a))
* render chat threads from event sourcing ([#19929](https://github.com/vm0-ai/vm0/issues/19929)) ([577d15e](https://github.com/vm0-ai/vm0/commit/577d15e5316e45102698c2e33eb0d71a02420228))
* resolve presentation runbook templates in `zero generate presentation --template` ([#20061](https://github.com/vm0-ai/vm0/issues/20061)) ([e4565ed](https://github.com/vm0-ai/vm0/commit/e4565ed884e32e7ecfc99c95bed415b37845ce90))
* restore Claude Fable 5 support ([#19721](https://github.com/vm0-ai/vm0/issues/19721)) ([97a7753](https://github.com/vm0-ai/vm0/commit/97a775354429e1f3de625627e3fbeeaf01c2552d))
* roll out chat and memory switches to all orgs ([#20145](https://github.com/vm0-ai/vm0/issues/20145)) ([8cd0184](https://github.com/vm0-ai/vm0/commit/8cd0184b1227f36b76a3919f5a3574e96304d511))
* scope chat thread event sourcing overrides to orgs ([#20069](https://github.com/vm0-ai/vm0/issues/20069)) ([ace2951](https://github.com/vm0-ai/vm0/commit/ace29512a64ac76fbb82f2ca4fecc766c9e41c22))
* show subscription account details ([#19500](https://github.com/vm0-ai/vm0/issues/19500)) ([b33f4ca](https://github.com/vm0-ai/vm0/commit/b33f4ca766b19a91ed782766ca29f8f9b50640aa))
* show workflow owner Clerk avatar and widen hover card row spacing ([#19960](https://github.com/vm0-ai/vm0/issues/19960)) ([9ee4853](https://github.com/vm0-ai/vm0/commit/9ee48530988d3e8fa4c2a4637b930ca191f48031))
* support darwin x64 desktop builds ([#19766](https://github.com/vm0-ai/vm0/issues/19766)) ([d58dd67](https://github.com/vm0-ai/vm0/commit/d58dd6729078d9bf6556ed5a75c4a66e08b87373))
* support safe script patches for html edits ([#19810](https://github.com/vm0-ai/vm0/issues/19810)) ([72a6222](https://github.com/vm0-ai/vm0/commit/72a622216dca7282a8e84f0f91804b90c628eacd))
* support scoped workflow name refs ([#19655](https://github.com/vm0-ai/vm0/issues/19655)) ([7018ee0](https://github.com/vm0-ai/vm0/commit/7018ee0446da472fb5b10370951513f189f52535))
* update new org default models ([#19606](https://github.com/vm0-ai/vm0/issues/19606)) ([9fdc5db](https://github.com/vm0-ai/vm0/commit/9fdc5db1ab9dc77b6e20d731f84ddd5f226d48ac))
* use zero avatar for default agents ([#20053](https://github.com/vm0-ai/vm0/issues/20053)) ([08deee2](https://github.com/vm0-ai/vm0/commit/08deee28bd3d5c255d1d1dce94c540caa632ea97))
* **workflows:** gate webhook trigger creation with a separate switch ([#20041](https://github.com/vm0-ai/vm0/issues/20041)) ([9c0f0c2](https://github.com/vm0-ai/vm0/commit/9c0f0c21a0cf62d97d682d6f4de2831c17e1a832))


### Bug Fixes

* allow team access to paid video templates ([#19922](https://github.com/vm0-ai/vm0/issues/19922)) ([1c4476e](https://github.com/vm0-ai/vm0/commit/1c4476e702b597b093d3d07396843d21fc5cea04))
* **api:** enforce signal-aware deferred promises ([#20187](https://github.com/vm0-ai/vm0/issues/20187)) ([a37afd6](https://github.com/vm0-ai/vm0/commit/a37afd65548e181f76a34a851285bbd34b0a6f6e))
* **api:** make generation template context one-shot ([#19962](https://github.com/vm0-ai/vm0/issues/19962)) ([fa29e6e](https://github.com/vm0-ai/vm0/commit/fa29e6eb688eee3fad803691411697cff656011f))
* **api:** refresh API release marker comment ([#19882](https://github.com/vm0-ai/vm0/issues/19882)) ([9335907](https://github.com/vm0-ai/vm0/commit/93359071908b7209a3d3503d2a81a9bf3fef2904))
* **api:** suppress malformed follow-up suggestions ([#19762](https://github.com/vm0-ai/vm0/issues/19762)) ([70208d8](https://github.com/vm0-ai/vm0/commit/70208d8fe9d594ecfb07dc841041d5738b9fd2c3))
* apply sandbox io limiters from host capacity ([#19668](https://github.com/vm0-ai/vm0/issues/19668)) ([8baa893](https://github.com/vm0-ai/vm0/commit/8baa893dbbae076adbde5e31f467103a0c06179e))
* avoid storing raw gmail relationship excerpts ([#20130](https://github.com/vm0-ai/vm0/issues/20130)) ([cc3643d](https://github.com/vm0-ai/vm0/commit/cc3643d435314f8ee5da7c7859367ccd4664e7ab))
* block byok model routes for limited-free workspaces ([#20066](https://github.com/vm0-ai/vm0/issues/20066)) ([4f05e30](https://github.com/vm0-ai/vm0/commit/4f05e3002cdfe75b7a7162e8bc363adf74500248))
* cache workflow avatars and reveal webhook secrets on demand ([#20073](https://github.com/vm0-ai/vm0/issues/20073)) ([d39c8eb](https://github.com/vm0-ai/vm0/commit/d39c8eb9b3fe014795aaef38f2baab2dbd67704b))
* coalesce runner direct candidate bursts ([#19969](https://github.com/vm0-ai/vm0/issues/19969)) ([1135a51](https://github.com/vm0-ai/vm0/commit/1135a514c5e5ca21bb0b929885e98e9061fe581b))
* commit create-run launch rows atomically ([#19641](https://github.com/vm0-ai/vm0/issues/19641)) ([24c9414](https://github.com/vm0-ai/vm0/commit/24c941437c27b918c7cad1e36bc5a14ce8021869))
* **core:** update schoolhouse and sticker scrapbook runbook archives ([#19947](https://github.com/vm0-ai/vm0/issues/19947)) ([017be61](https://github.com/vm0-ai/vm0/commit/017be619eea4a82478ddab3f77eb6bad339a81bd))
* drop the fallback DB note for generation template selections ([#19831](https://github.com/vm0-ai/vm0/issues/19831)) ([83cb5f3](https://github.com/vm0-ai/vm0/commit/83cb5f35ca84d4dc3d6f83ef639ed95b581e9129))
* exclude active runs and goals from unread thread ids ([#20243](https://github.com/vm0-ai/vm0/issues/20243)) ([5cf4b03](https://github.com/vm0-ai/vm0/commit/5cf4b03408e6049e83f7f313dcba790f51f8c85f))
* fetch all draft chat thread ids ([#20149](https://github.com/vm0-ai/vm0/issues/20149)) ([7b02fa2](https://github.com/vm0-ai/vm0/commit/7b02fa272811f75f9b897f92ab82da618d818110))
* fire Google Ads signup conversion ([#19775](https://github.com/vm0-ai/vm0/issues/19775)) ([c1092a7](https://github.com/vm0-ai/vm0/commit/c1092a70ba713db885cb89475bb57b3d1883db95))
* gate initial thinking to direct chat sends ([#19792](https://github.com/vm0-ai/vm0/issues/19792)) ([e961f1f](https://github.com/vm0-ai/vm0/commit/e961f1fbc6b894e44c365f7cd50199f7997244dc))
* gate workflow trigger firing by fireability ([#19768](https://github.com/vm0-ai/vm0/issues/19768)) ([cfb7c81](https://github.com/vm0-ai/vm0/commit/cfb7c81110271d2f79db668a933c5546318e34c9))
* hydrate event-sourced chat thread running state ([#20031](https://github.com/vm0-ai/vm0/issues/20031)) ([40a3f06](https://github.com/vm0-ai/vm0/commit/40a3f06a578903e50ae51990905f23c843bea39e))
* keep follow-up markers after assistant content ([#19737](https://github.com/vm0-ai/vm0/issues/19737)) ([d135270](https://github.com/vm0-ai/vm0/commit/d135270c327e2aece0a9a014128928e1e230107b))
* keep follow-up prompts plain text ([#20308](https://github.com/vm0-ai/vm0/issues/20308)) ([0883d8b](https://github.com/vm0-ai/vm0/commit/0883d8b23c67affb0f48782cf11edf75514c4aca))
* make generation templates one-shot instead of thread-sticky ([#19765](https://github.com/vm0-ai/vm0/issues/19765)) ([29c9633](https://github.com/vm0-ai/vm0/commit/29c9633272045d932aef71f80cae2d91008bf415))
* narrow org-scoped feature switch rollouts ([#20196](https://github.com/vm0-ai/vm0/issues/20196)) ([639c9f1](https://github.com/vm0-ai/vm0/commit/639c9f1e34a8d31802c8936ccfa006b9dde0b65f))
* persist chat thread model selection at creation ([#20229](https://github.com/vm0-ai/vm0/issues/20229)) ([ded7688](https://github.com/vm0-ai/vm0/commit/ded7688a0d9ef4b703d1037d15af43389ff3f65a))
* prefill workflow refine prompts ([#20131](https://github.com/vm0-ai/vm0/issues/20131)) ([7c6847f](https://github.com/vm0-ai/vm0/commit/7c6847f0e76035a4821d32ac27a483869057ba3a))
* preserve agent connector add semantics ([#19815](https://github.com/vm0-ai/vm0/issues/19815)) ([1dbc317](https://github.com/vm0-ai/vm0/commit/1dbc317f5b5aebe9dff79353accac2e3f8878d18))
* prevent chat thread snapshot compactor starvation ([#20313](https://github.com/vm0-ai/vm0/issues/20313)) ([aff8142](https://github.com/vm0-ai/vm0/commit/aff81423409d472a5cc162617cdbf816e30d1498))
* prevent goal continuation from preempting queued chat ([#19950](https://github.com/vm0-ai/vm0/issues/19950)) ([2af12c7](https://github.com/vm0-ai/vm0/commit/2af12c7a28e815cd53f120384859b8a4e16cceb0))
* protect same-session runner affinity claims ([#19764](https://github.com/vm0-ai/vm0/issues/19764)) ([5bbd286](https://github.com/vm0-ai/vm0/commit/5bbd2862e2eceb51a71ba681a24d64b87894d712))
* prune chat thread events after compaction ([#20072](https://github.com/vm0-ai/vm0/issues/20072)) ([5b382db](https://github.com/vm0-ai/vm0/commit/5b382db8883a14abff23cda3ac79772ed6423c31))
* publish workflow trigger automation refreshes ([#19629](https://github.com/vm0-ai/vm0/issues/19629)) ([c719a69](https://github.com/vm0-ai/vm0/commit/c719a6909e762072901600b00b487c8c47618fa9))
* remove invalid goal deny rules ([#19996](https://github.com/vm0-ai/vm0/issues/19996)) ([f990cc2](https://github.com/vm0-ai/vm0/commit/f990cc2bc5c16e924fa9f08dfe7ad46cf550db2f))
* remove limited free onboarding endpoint ([#20047](https://github.com/vm0-ai/vm0/issues/20047)) ([c216eb3](https://github.com/vm0-ai/vm0/commit/c216eb313d3a73a685b9b2c1d5d39c5b531b85f9))
* remove workflow follow-up suggestions ([#19646](https://github.com/vm0-ai/vm0/issues/19646)) ([c21341b](https://github.com/vm0-ai/vm0/commit/c21341bb4e5d09d0879727a8efe5424081dfdb3f))
* remove workflow publish approval flow ([#19767](https://github.com/vm0-ai/vm0/issues/19767)) ([19d0fa7](https://github.com/vm0-ai/vm0/commit/19d0fa765fe2fb9a15d64e2a04616b41b8546a17))
* restart full thinking typewriter lines ([#19771](https://github.com/vm0-ai/vm0/issues/19771)) ([063aac1](https://github.com/vm0-ai/vm0/commit/063aac15a9cf3c7ac5d48963583db987e980899d))
* run goal continuations from the full objective prompt ([#19991](https://github.com/vm0-ai/vm0/issues/19991)) ([05a2ef8](https://github.com/vm0-ai/vm0/commit/05a2ef8136d310b8068f53d70e485992ee891639))
* **runner:** remove session history claim capabilities ([#19832](https://github.com/vm0-ai/vm0/issues/19832)) ([f80876f](https://github.com/vm0-ai/vm0/commit/f80876f4dbfd3674f7b60b34941a1783dbe26f04))
* scope data export feature switch to org ([#19700](https://github.com/vm0-ai/vm0/issues/19700)) ([ae28726](https://github.com/vm0-ai/vm0/commit/ae2872625db443cbba1398a8215fa4e5e8c3d153))
* show owner name and avatar in workflow detail created-by tooltip ([#20279](https://github.com/vm0-ai/vm0/issues/20279)) ([e4e54ba](https://github.com/vm0-ai/vm0/commit/e4e54ba9b22e4f5d0a27df0ea66f0da8df9b1d0f))
* sync chat message updates by id ([#19701](https://github.com/vm0-ai/vm0/issues/19701)) ([dc56030](https://github.com/vm0-ai/vm0/commit/dc56030baa32d7452c906edb3ec36d14543c9ac5))
* update chat thread recency for direct sends and run finishes ([#20256](https://github.com/vm0-ai/vm0/issues/20256)) ([e70397f](https://github.com/vm0-ai/vm0/commit/e70397f7d8c3aa8f86828bf60ac46abc57dbfb38))
* use Gmail message time for relationship memory ([#20197](https://github.com/vm0-ai/vm0/issues/20197)) ([616c316](https://github.com/vm0-ai/vm0/commit/616c316061891266deb4773ae32dff44e33ebc57))
* use run-finish timestamps for chat thread unread state ([#20236](https://github.com/vm0-ai/vm0/issues/20236)) ([9e4cb65](https://github.com/vm0-ai/vm0/commit/9e4cb659f32a0449d3f506232f4b4ca8dabc6a29))


### Documentation

* add deployment compatibility guidance ([#20037](https://github.com/vm0-ai/vm0/issues/20037)) ([0d0d145](https://github.com/vm0-ai/vm0/commit/0d0d145b8a7ad4bb792b8a5d9dd0ece70741f2ff))


### Refactoring

* **api:** remove zero chat thread list route ([#20113](https://github.com/vm0-ai/vm0/issues/20113)) ([71550af](https://github.com/vm0-ai/vm0/commit/71550af196199bffdc23d231a2bc1ad6c54155fb))
* bridge runner_state admittable profiles ([#20272](https://github.com/vm0-ai/vm0/issues/20272)) ([743a786](https://github.com/vm0-ai/vm0/commit/743a78618b048c7db0b84513f18d3459be1b4057))
* clarify runner profile availability contract ([#20171](https://github.com/vm0-ai/vm0/issues/20171)) ([ef94c04](https://github.com/vm0-ai/vm0/commit/ef94c04b34a0eacb9a3ddc7ffd1cabc419c19113))
* extract custom eslint rules package ([#20188](https://github.com/vm0-ai/vm0/issues/20188)) ([e2ca0d3](https://github.com/vm0-ai/vm0/commit/e2ca0d3dd59a3f80e77a79a626615c532841201b))
* narrow chat thread detail payload ([#20267](https://github.com/vm0-ai/vm0/issues/20267)) ([9717d60](https://github.com/vm0-ai/vm0/commit/9717d60b535745157f9bc2a743f42c20be58ec0b))
* **platform:** remove pinned agent sorting ([#20051](https://github.com/vm0-ai/vm0/issues/20051)) ([e3e7436](https://github.com/vm0-ai/vm0/commit/e3e7436aeee8170a54e846a86bf7dd4a36449f0a))
* read chat thread selected model from event projection ([#20204](https://github.com/vm0-ai/vm0/issues/20204)) ([2a76f6d](https://github.com/vm0-ai/vm0/commit/2a76f6dfbe6ad7bbc32e2d5803d8c3207e976284))
* reduce fallback slop in API model state ([#19920](https://github.com/vm0-ai/vm0/issues/19920)) ([9e80759](https://github.com/vm0-ai/vm0/commit/9e807591f3a5c03aa115a7224dc032d2a990d6e3))
* reduce fallback slop in runtime guards ([#19720](https://github.com/vm0-ai/vm0/issues/19720)) ([5d61de7](https://github.com/vm0-ai/vm0/commit/5d61de75720518d76e917f06a7be0bf95f155973))
* reduce fallback slop in runtime guards ([#20275](https://github.com/vm0-ai/vm0/issues/20275)) ([73e668c](https://github.com/vm0-ai/vm0/commit/73e668ce7135504b171be98ca2832d09b433f34b))
* reduce fallback slop in test support contracts ([#19915](https://github.com/vm0-ai/vm0/issues/19915)) ([d2ca8c0](https://github.com/vm0-ai/vm0/commit/d2ca8c013c73602f2ed48b34693914b78a31cf3d))
* remove computer use delegated authorization switch ([#19971](https://github.com/vm0-ai/vm0/issues/19971)) ([682219b](https://github.com/vm0-ai/vm0/commit/682219bb52c9519cf96d6cfe39e50385718dad71))
* remove ga chat and export feature switches ([#20108](https://github.com/vm0-ai/vm0/issues/20108)) ([722d7c7](https://github.com/vm0-ai/vm0/commit/722d7c7833a003ea58b12fc8a34132c1aa4eb152))
* remove legacy automation poller, mutating routes, and the cli command ([#20103](https://github.com/vm0-ai/vm0/issues/20103)) ([2245f83](https://github.com/vm0-ai/vm0/commit/2245f83430aefa545077e5da1e8929d9c4968628))
* remove runner profile compatibility fields ([#20255](https://github.com/vm0-ai/vm0/issues/20255)) ([7972fa3](https://github.com/vm0-ai/vm0/commit/7972fa3a2aa317e99ba40503b5d6dae35e0d6df8))
* retire legacy html-ppt presentation registry entries (presentations runbook-only) ([#20064](https://github.com/vm0-ai/vm0/issues/20064)) ([b92a71c](https://github.com/vm0-ai/vm0/commit/b92a71c98a4c48b1fec6a610dd179a09f4d86c62))
* retire presentation-deck-tools server-side (phase 2) ([#20012](https://github.com/vm0-ai/vm0/issues/20012)) ([9626a84](https://github.com/vm0-ai/vm0/commit/9626a842ba1ad35502dc97d507acbd58f969e7aa))
* retire PresentationTemplateRunbook feature switch, make runbook flow the default ([#19965](https://github.com/vm0-ai/vm0/issues/19965)) ([47bc92d](https://github.com/vm0-ai/vm0/commit/47bc92da3ffbcabd103ef91dd87739be813c4989))
* serve connector category metadata from catalog api ([#20089](https://github.com/vm0-ai/vm0/issues/20089)) ([99bafd7](https://github.com/vm0-ai/vm0/commit/99bafd7d276f1ae151c4cd7b409e8268a8487848))
* serve platform permission metadata from catalog api ([#20028](https://github.com/vm0-ai/vm0/issues/20028)) ([2c8f731](https://github.com/vm0-ai/vm0/commit/2c8f73192fcdd01f53571d2ed5d6c60c83429807))
* split chat thread draft read API ([#20192](https://github.com/vm0-ai/vm0/issues/20192)) ([61c4e87](https://github.com/vm0-ai/vm0/commit/61c4e87c3015982d8a419f5f176cc6280549eef4))
* tighten google meet event schema ([#20105](https://github.com/vm0-ai/vm0/issues/20105)) ([c0f810c](https://github.com/vm0-ai/vm0/commit/c0f810c40ef6d139f1739f5b19b14ec07363793a))
* update feature switch rollout scopes ([#19728](https://github.com/vm0-ai/vm0/issues/19728)) ([868fa93](https://github.com/vm0-ai/vm0/commit/868fa931c4cacdb8e9f586f3621aa47c13e72aef))
* use public connector catalog in platform ui ([#19663](https://github.com/vm0-ai/vm0/issues/19663)) ([85ca45f](https://github.com/vm0-ai/vm0/commit/85ca45f3a136a40245e9dd16a8e6eeffc06d9477))


### Performance Improvements

* add artifact ensure storage manifest timing ([#19901](https://github.com/vm0-ai/vm0/issues/19901)) ([749e1bb](https://github.com/vm0-ai/vm0/commit/749e1bb01dcd16c04347ec1c7f174af7e167c9ad))
* add compressed resume session history transport ([#19667](https://github.com/vm0-ai/vm0/issues/19667)) ([ee23c32](https://github.com/vm0-ai/vm0/commit/ee23c326ccf794228d2c4f9dd6d8844cd032fc49))
* add custom connector runtime timing ([#19949](https://github.com/vm0-ai/vm0/issues/19949)) ([e2d7a85](https://github.com/vm0-ai/vm0/commit/e2d7a857caf510b76004a708f68fdbb6094718d1))
* add session history encoding telemetry ([#19812](https://github.com/vm0-ai/vm0/issues/19812)) ([7c0814a](https://github.com/vm0-ai/vm0/commit/7c0814af703af9ad89cd34dc0fd131db0916fec7))
* add session history telemetry buckets ([#19953](https://github.com/vm0-ai/vm0/issues/19953)) ([27309a2](https://github.com/vm0-ai/vm0/commit/27309a250f9374e3e8a1d46fa4476d57b248522d))
* attribute storage manifest presign sources ([#20080](https://github.com/vm0-ai/vm0/issues/20080)) ([5d3e2ae](https://github.com/vm0-ai/vm0/commit/5d3e2aea66a9bc1ccf29f1e4ac0be6da1e90e861))
* attribute storage manifest presign work ([#19693](https://github.com/vm0-ai/vm0/issues/19693)) ([0f78c6b](https://github.com/vm0-ai/vm0/commit/0f78c6b66c06c3004a52cd97940ab3a2d5e4eb22))
* attribute workflow event source timing ([#19998](https://github.com/vm0-ai/vm0/issues/19998)) ([2856fff](https://github.com/vm0-ai/vm0/commit/2856fff042e21529141082a27c7ecb528266fc5d))
* attribute zero source entrypoint timing ([#19713](https://github.com/vm0-ai/vm0/issues/19713)) ([5e897dc](https://github.com/vm0-ai/vm0/commit/5e897dc6e6ccee463e081c464d9d614f8d1b1ed3))
* cache system storage presigned urls ([#19777](https://github.com/vm0-ai/vm0/issues/19777)) ([62f66b9](https://github.com/vm0-ai/vm0/commit/62f66b9474c1bfbf19155790f1d2a839d332b331))
* lazily materialize custom connector auth ([#20258](https://github.com/vm0-ai/vm0/issues/20258)) ([57d47d7](https://github.com/vm0-ai/vm0/commit/57d47d729ad48e626b63d71fcd69f93deec7c692))
* reduce artifact storage manifest presigning ([#19650](https://github.com/vm0-ai/vm0/issues/19650)) ([0672271](https://github.com/vm0-ai/vm0/commit/0672271c090e1a5431ac762c566328125958a218))
* skip session affinity delay without viable holder ([#20030](https://github.com/vm0-ai/vm0/issues/20030)) ([c96b651](https://github.com/vm0-ai/vm0/commit/c96b6516047d448edb72a82d20a546871ed0dcfa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.403.0
    * @vm0/db bumped to 1.94.0

## [1.227.4](https://github.com/vm0-ai/vm0/compare/api-v1.227.3...api-v1.227.4) (2026-07-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.402.0
    * @vm0/db bumped to 1.93.2

## [1.227.3](https://github.com/vm0-ai/vm0/compare/api-v1.227.2...api-v1.227.3) (2026-07-06)


### Refactoring

* bridge runner_state admittable profiles ([#20272](https://github.com/vm0-ai/vm0/issues/20272)) ([743a786](https://github.com/vm0-ai/vm0/commit/743a78618b048c7db0b84513f18d3459be1b4057))
* extract custom eslint rules package ([#20188](https://github.com/vm0-ai/vm0/issues/20188)) ([e2ca0d3](https://github.com/vm0-ai/vm0/commit/e2ca0d3dd59a3f80e77a79a626615c532841201b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.155.4
    * @vm0/core bumped to 8.401.5
    * @vm0/db bumped to 1.93.1

## [1.227.2](https://github.com/vm0-ai/vm0/compare/api-v1.227.1...api-v1.227.2) (2026-07-06)


### Bug Fixes

* show owner name and avatar in workflow detail created-by tooltip ([#20279](https://github.com/vm0-ai/vm0/issues/20279)) ([e4e54ba](https://github.com/vm0-ai/vm0/commit/e4e54ba9b22e4f5d0a27df0ea66f0da8df9b1d0f))

## [1.227.1](https://github.com/vm0-ai/vm0/compare/api-v1.227.0...api-v1.227.1) (2026-07-06)


### Refactoring

* reduce fallback slop in runtime guards ([#20275](https://github.com/vm0-ai/vm0/issues/20275)) ([73e668c](https://github.com/vm0-ai/vm0/commit/73e668ce7135504b171be98ca2832d09b433f34b))

## [1.227.0](https://github.com/vm0-ai/vm0/compare/api-v1.226.2...api-v1.227.0) (2026-07-05)


### Features

* add provider-neutral memory substrate ([#20273](https://github.com/vm0-ai/vm0/issues/20273)) ([67f5573](https://github.com/vm0-ai/vm0/commit/67f5573e2f4c290a94eb016fc45c5ce46df289a4))


### Refactoring

* narrow chat thread detail payload ([#20267](https://github.com/vm0-ai/vm0/issues/20267)) ([9717d60](https://github.com/vm0-ai/vm0/commit/9717d60b535745157f9bc2a743f42c20be58ec0b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.155.3
    * @vm0/core bumped to 8.401.4
    * @vm0/db bumped to 1.93.0

## [1.226.2](https://github.com/vm0-ai/vm0/compare/api-v1.226.1...api-v1.226.2) (2026-07-05)


### Refactoring

* remove runner profile compatibility fields ([#20255](https://github.com/vm0-ai/vm0/issues/20255)) ([7972fa3](https://github.com/vm0-ai/vm0/commit/7972fa3a2aa317e99ba40503b5d6dae35e0d6df8))


### Performance Improvements

* lazily materialize custom connector auth ([#20258](https://github.com/vm0-ai/vm0/issues/20258)) ([57d47d7](https://github.com/vm0-ai/vm0/commit/57d47d729ad48e626b63d71fcd69f93deec7c692))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.155.2
    * @vm0/core bumped to 8.401.3
    * @vm0/db bumped to 1.92.6

## [1.226.1](https://github.com/vm0-ai/vm0/compare/api-v1.226.0...api-v1.226.1) (2026-07-05)


### Bug Fixes

* persist chat thread model selection at creation ([#20229](https://github.com/vm0-ai/vm0/issues/20229)) ([ded7688](https://github.com/vm0-ai/vm0/commit/ded7688a0d9ef4b703d1037d15af43389ff3f65a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.155.1
    * @vm0/core bumped to 8.401.2
    * @vm0/db bumped to 1.92.5

## [1.226.0](https://github.com/vm0-ai/vm0/compare/api-v1.225.0...api-v1.226.0) (2026-07-05)


### Features

* paginate relationship memory search ([#20262](https://github.com/vm0-ai/vm0/issues/20262)) ([f1d4130](https://github.com/vm0-ai/vm0/commit/f1d4130ff818bda248280d0bfc37a08060c1c64a))


### Bug Fixes

* update chat thread recency for direct sends and run finishes ([#20256](https://github.com/vm0-ai/vm0/issues/20256)) ([e70397f](https://github.com/vm0-ai/vm0/commit/e70397f7d8c3aa8f86828bf60ac46abc57dbfb38))
* use run-finish timestamps for chat thread unread state ([#20236](https://github.com/vm0-ai/vm0/issues/20236)) ([9e4cb65](https://github.com/vm0-ai/vm0/commit/9e4cb659f32a0449d3f506232f4b4ca8dabc6a29))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.155.0
    * @vm0/core bumped to 8.401.1
    * @vm0/db bumped to 1.92.4

## [1.225.0](https://github.com/vm0-ai/vm0/compare/api-v1.224.2...api-v1.225.0) (2026-07-05)


### Features

* support safe script patches for html edits ([#19810](https://github.com/vm0-ai/vm0/issues/19810)) ([72a6222](https://github.com/vm0-ai/vm0/commit/72a622216dca7282a8e84f0f91804b90c628eacd))


### Bug Fixes

* exclude active runs and goals from unread thread ids ([#20243](https://github.com/vm0-ai/vm0/issues/20243)) ([5cf4b03](https://github.com/vm0-ai/vm0/commit/5cf4b03408e6049e83f7f313dcba790f51f8c85f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.154.3
    * @vm0/connectors bumped to 1.138.0
    * @vm0/core bumped to 8.401.0
    * @vm0/db bumped to 1.92.3

## [1.224.2](https://github.com/vm0-ai/vm0/compare/api-v1.224.1...api-v1.224.2) (2026-07-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.154.2
    * @vm0/connectors bumped to 1.137.0
    * @vm0/core bumped to 8.400.0
    * @vm0/db bumped to 1.92.2

## [1.224.1](https://github.com/vm0-ai/vm0/compare/api-v1.224.0...api-v1.224.1) (2026-07-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.154.1
    * @vm0/connectors bumped to 1.136.0
    * @vm0/core bumped to 8.399.7
    * @vm0/db bumped to 1.92.1

## [1.224.0](https://github.com/vm0-ai/vm0/compare/api-v1.223.6...api-v1.224.0) (2026-07-05)


### Features

* add gmail backfill stop controls ([#20213](https://github.com/vm0-ai/vm0/issues/20213)) ([97ab218](https://github.com/vm0-ai/vm0/commit/97ab2184f5dd9daa1d00856add3531f2f6999bbb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.154.0
    * @vm0/core bumped to 8.399.6
    * @vm0/db bumped to 1.92.0

## [1.223.6](https://github.com/vm0-ai/vm0/compare/api-v1.223.5...api-v1.223.6) (2026-07-05)


### Refactoring

* read chat thread selected model from event projection ([#20204](https://github.com/vm0-ai/vm0/issues/20204)) ([2a76f6d](https://github.com/vm0-ai/vm0/commit/2a76f6dfbe6ad7bbc32e2d5803d8c3207e976284))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.153.6
    * @vm0/core bumped to 8.399.5
    * @vm0/db bumped to 1.91.9

## [1.223.5](https://github.com/vm0-ai/vm0/compare/api-v1.223.4...api-v1.223.5) (2026-07-05)


### Bug Fixes

* use Gmail message time for relationship memory ([#20197](https://github.com/vm0-ai/vm0/issues/20197)) ([616c316](https://github.com/vm0-ai/vm0/commit/616c316061891266deb4773ae32dff44e33ebc57))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.91.8

## [1.223.4](https://github.com/vm0-ai/vm0/compare/api-v1.223.3...api-v1.223.4) (2026-07-05)


### Bug Fixes

* narrow org-scoped feature switch rollouts ([#20196](https://github.com/vm0-ai/vm0/issues/20196)) ([639c9f1](https://github.com/vm0-ai/vm0/commit/639c9f1e34a8d31802c8936ccfa006b9dde0b65f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.399.4
    * @vm0/db bumped to 1.91.7

## [1.223.3](https://github.com/vm0-ai/vm0/compare/api-v1.223.2...api-v1.223.3) (2026-07-05)


### Bug Fixes

* **api:** enforce signal-aware deferred promises ([#20187](https://github.com/vm0-ai/vm0/issues/20187)) ([a37afd6](https://github.com/vm0-ai/vm0/commit/a37afd65548e181f76a34a851285bbd34b0a6f6e))


### Refactoring

* split chat thread draft read API ([#20192](https://github.com/vm0-ai/vm0/issues/20192)) ([61c4e87](https://github.com/vm0-ai/vm0/commit/61c4e87c3015982d8a419f5f176cc6280549eef4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.153.5
    * @vm0/core bumped to 8.399.3
    * @vm0/db bumped to 1.91.6

## [1.223.2](https://github.com/vm0-ai/vm0/compare/api-v1.223.1...api-v1.223.2) (2026-07-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.153.4
    * @vm0/core bumped to 8.399.2
    * @vm0/db bumped to 1.91.5

## [1.223.1](https://github.com/vm0-ai/vm0/compare/api-v1.223.0...api-v1.223.1) (2026-07-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.153.3
    * @vm0/connectors bumped to 1.135.1
    * @vm0/core bumped to 8.399.1
    * @vm0/db bumped to 1.91.4

## [1.223.0](https://github.com/vm0-ai/vm0/compare/api-v1.222.2...api-v1.223.0) (2026-07-04)


### Features

* roll out chat and memory switches to all orgs ([#20145](https://github.com/vm0-ai/vm0/issues/20145)) ([8cd0184](https://github.com/vm0-ai/vm0/commit/8cd0184b1227f36b76a3919f5a3574e96304d511))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.399.0
    * @vm0/db bumped to 1.91.3

## [1.222.2](https://github.com/vm0-ai/vm0/compare/api-v1.222.1...api-v1.222.2) (2026-07-04)


### Bug Fixes

* fetch all draft chat thread ids ([#20149](https://github.com/vm0-ai/vm0/issues/20149)) ([7b02fa2](https://github.com/vm0-ai/vm0/commit/7b02fa272811f75f9b897f92ab82da618d818110))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.153.2
    * @vm0/core bumped to 8.398.1
    * @vm0/db bumped to 1.91.2

## [1.222.1](https://github.com/vm0-ai/vm0/compare/api-v1.222.0...api-v1.222.1) (2026-07-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.153.1
    * @vm0/connectors bumped to 1.135.0
    * @vm0/core bumped to 8.398.0
    * @vm0/db bumped to 1.91.1

## [1.222.0](https://github.com/vm0-ai/vm0/compare/api-v1.221.2...api-v1.222.0) (2026-07-04)


### Features

* add Gmail relationship backfill options ([#20135](https://github.com/vm0-ai/vm0/issues/20135)) ([f2170eb](https://github.com/vm0-ai/vm0/commit/f2170eb06db7a20da76fe571635ce80eb5907dd8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.153.0
    * @vm0/core bumped to 8.397.1
    * @vm0/db bumped to 1.91.0

## [1.221.2](https://github.com/vm0-ai/vm0/compare/api-v1.221.1...api-v1.221.2) (2026-07-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.152.1
    * @vm0/connectors bumped to 1.134.0
    * @vm0/core bumped to 8.397.0
    * @vm0/db bumped to 1.90.2

## [1.221.1](https://github.com/vm0-ai/vm0/compare/api-v1.221.0...api-v1.221.1) (2026-07-04)


### Bug Fixes

* avoid storing raw gmail relationship excerpts ([#20130](https://github.com/vm0-ai/vm0/issues/20130)) ([cc3643d](https://github.com/vm0-ai/vm0/commit/cc3643d435314f8ee5da7c7859367ccd4664e7ab))
* prefill workflow refine prompts ([#20131](https://github.com/vm0-ai/vm0/issues/20131)) ([7c6847f](https://github.com/vm0-ai/vm0/commit/7c6847f0e76035a4821d32ac27a483869057ba3a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.90.1

## [1.221.0](https://github.com/vm0-ai/vm0/compare/api-v1.220.1...api-v1.221.0) (2026-07-04)


### Features

* add codex reset controls ([#20119](https://github.com/vm0-ai/vm0/issues/20119)) ([c1f9d22](https://github.com/vm0-ai/vm0/commit/c1f9d22b253bdeb60e4436e13a90793553865230))
* enable gmail relationship backfill from memory ([#20114](https://github.com/vm0-ai/vm0/issues/20114)) ([fd84afd](https://github.com/vm0-ai/vm0/commit/fd84afd077a35a750f4fa01abb6bba87b207f02b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.152.0
    * @vm0/core bumped to 8.396.2
    * @vm0/db bumped to 1.90.0

## [1.220.1](https://github.com/vm0-ai/vm0/compare/api-v1.220.0...api-v1.220.1) (2026-07-04)


### Refactoring

* **api:** remove zero chat thread list route ([#20113](https://github.com/vm0-ai/vm0/issues/20113)) ([71550af](https://github.com/vm0-ai/vm0/commit/71550af196199bffdc23d231a2bc1ad6c54155fb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.151.1
    * @vm0/core bumped to 8.396.1
    * @vm0/db bumped to 1.89.1

## [1.220.0](https://github.com/vm0-ai/vm0/compare/api-v1.219.1...api-v1.220.0) (2026-07-04)


### Features

* add relationship memory foundation ([#20077](https://github.com/vm0-ai/vm0/issues/20077)) ([805a79e](https://github.com/vm0-ai/vm0/commit/805a79ed91fc55a6261bf6f7180fa4b3c663af7d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.151.0
    * @vm0/connectors bumped to 1.133.0
    * @vm0/core bumped to 8.396.0
    * @vm0/db bumped to 1.89.0

## [1.219.1](https://github.com/vm0-ai/vm0/compare/api-v1.219.0...api-v1.219.1) (2026-07-04)


### Refactoring

* tighten google meet event schema ([#20105](https://github.com/vm0-ai/vm0/issues/20105)) ([c0f810c](https://github.com/vm0-ai/vm0/commit/c0f810c40ef6d139f1739f5b19b14ec07363793a))

## [1.219.0](https://github.com/vm0-ai/vm0/compare/api-v1.218.3...api-v1.219.0) (2026-07-03)


### Features

* enable chat thread event sourcing globally ([#20082](https://github.com/vm0-ai/vm0/issues/20082)) ([548a68e](https://github.com/vm0-ai/vm0/commit/548a68eca8f4b700d639d83470b16e026444b851))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.395.0
    * @vm0/db bumped to 1.88.7

## [1.218.3](https://github.com/vm0-ai/vm0/compare/api-v1.218.2...api-v1.218.3) (2026-07-03)


### Refactoring

* remove legacy automation poller, mutating routes, and the cli command ([#20103](https://github.com/vm0-ai/vm0/issues/20103)) ([2245f83](https://github.com/vm0-ai/vm0/commit/2245f83430aefa545077e5da1e8929d9c4968628))
* serve connector category metadata from catalog api ([#20089](https://github.com/vm0-ai/vm0/issues/20089)) ([99bafd7](https://github.com/vm0-ai/vm0/commit/99bafd7d276f1ae151c4cd7b409e8268a8487848))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.150.3
    * @vm0/connectors bumped to 1.132.3
    * @vm0/core bumped to 8.394.6
    * @vm0/db bumped to 1.88.6

## [1.218.2](https://github.com/vm0-ai/vm0/compare/api-v1.218.1...api-v1.218.2) (2026-07-03)


### Bug Fixes

* cache workflow avatars and reveal webhook secrets on demand ([#20073](https://github.com/vm0-ai/vm0/issues/20073)) ([d39c8eb](https://github.com/vm0-ai/vm0/commit/d39c8eb9b3fe014795aaef38f2baab2dbd67704b))


### Performance Improvements

* attribute storage manifest presign sources ([#20080](https://github.com/vm0-ai/vm0/issues/20080)) ([5d3e2ae](https://github.com/vm0-ai/vm0/commit/5d3e2aea66a9bc1ccf29f1e4ac0be6da1e90e861))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.150.2
    * @vm0/connectors bumped to 1.132.2
    * @vm0/core bumped to 8.394.5
    * @vm0/db bumped to 1.88.5

## [1.218.1](https://github.com/vm0-ai/vm0/compare/api-v1.218.0...api-v1.218.1) (2026-07-03)


### Refactoring

* retire presentation-deck-tools server-side (phase 2) ([#20012](https://github.com/vm0-ai/vm0/issues/20012)) ([9626a84](https://github.com/vm0-ai/vm0/commit/9626a842ba1ad35502dc97d507acbd58f969e7aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.150.1
    * @vm0/connectors bumped to 1.132.1
    * @vm0/core bumped to 8.394.4
    * @vm0/db bumped to 1.88.4

## [1.218.0](https://github.com/vm0-ai/vm0/compare/api-v1.217.1...api-v1.218.0) (2026-07-03)


### Features

* add build versions to debug build info ([#20056](https://github.com/vm0-ai/vm0/issues/20056)) ([41d2921](https://github.com/vm0-ai/vm0/commit/41d2921df0beb8f56f12abf3c6c98bd14cdd4cea))


### Documentation

* add deployment compatibility guidance ([#20037](https://github.com/vm0-ai/vm0/issues/20037)) ([0d0d145](https://github.com/vm0-ai/vm0/commit/0d0d145b8a7ad4bb792b8a5d9dd0ece70741f2ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.150.0
    * @vm0/core bumped to 8.394.3
    * @vm0/db bumped to 1.88.3

## [1.217.1](https://github.com/vm0-ai/vm0/compare/api-v1.217.0...api-v1.217.1) (2026-07-03)


### Bug Fixes

* block byok model routes for limited-free workspaces ([#20066](https://github.com/vm0-ai/vm0/issues/20066)) ([4f05e30](https://github.com/vm0-ai/vm0/commit/4f05e3002cdfe75b7a7162e8bc363adf74500248))
* prune chat thread events after compaction ([#20072](https://github.com/vm0-ai/vm0/issues/20072)) ([5b382db](https://github.com/vm0-ai/vm0/commit/5b382db8883a14abff23cda3ac79772ed6423c31))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.149.1
    * @vm0/core bumped to 8.394.2
    * @vm0/db bumped to 1.88.2

## [1.217.0](https://github.com/vm0-ai/vm0/compare/api-v1.216.0...api-v1.217.0) (2026-07-03)


### Features

* scope chat thread event sourcing overrides to orgs ([#20069](https://github.com/vm0-ai/vm0/issues/20069)) ([ace2951](https://github.com/vm0-ai/vm0/commit/ace29512a64ac76fbb82f2ca4fecc766c9e41c22))


### Refactoring

* retire legacy html-ppt presentation registry entries (presentations runbook-only) ([#20064](https://github.com/vm0-ai/vm0/issues/20064)) ([b92a71c](https://github.com/vm0-ai/vm0/commit/b92a71c98a4c48b1fec6a610dd179a09f4d86c62))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.394.1
    * @vm0/db bumped to 1.88.1

## [1.216.0](https://github.com/vm0-ai/vm0/compare/api-v1.215.0...api-v1.216.0) (2026-07-03)


### Features

* add onboarding completion marker ([#20055](https://github.com/vm0-ai/vm0/issues/20055)) ([6d5bf36](https://github.com/vm0-ai/vm0/commit/6d5bf3630093c7a9120ce91b2b746eedf299171d))
* extend limited-free onboarding credits ([#20048](https://github.com/vm0-ai/vm0/issues/20048)) ([edddbc0](https://github.com/vm0-ai/vm0/commit/edddbc08cf69ee88c5b9dcada32c7b5ffc25e19a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.149.0
    * @vm0/core bumped to 8.394.0
    * @vm0/db bumped to 1.88.0

## [1.215.0](https://github.com/vm0-ai/vm0/compare/api-v1.214.0...api-v1.215.0) (2026-07-03)


### Features

* **workflows:** gate webhook trigger creation with a separate switch ([#20041](https://github.com/vm0-ai/vm0/issues/20041)) ([9c0f0c2](https://github.com/vm0-ai/vm0/commit/9c0f0c21a0cf62d97d682d6f4de2831c17e1a832))


### Refactoring

* **platform:** remove pinned agent sorting ([#20051](https://github.com/vm0-ai/vm0/issues/20051)) ([e3e7436](https://github.com/vm0-ai/vm0/commit/e3e7436aeee8170a54e846a86bf7dd4a36449f0a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.148.0
    * @vm0/connectors bumped to 1.132.0
    * @vm0/core bumped to 8.393.0
    * @vm0/db bumped to 1.87.1

## [1.214.0](https://github.com/vm0-ai/vm0/compare/api-v1.213.0...api-v1.214.0) (2026-07-03)


### Features

* migrate legacy automations to workflow schedule triggers globally ([#20033](https://github.com/vm0-ai/vm0/issues/20033)) ([eeb91c2](https://github.com/vm0-ai/vm0/commit/eeb91c258a50f67b05a341ebbbbb7e1b872d0030))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.392.0
    * @vm0/db bumped to 1.87.0

## [1.213.0](https://github.com/vm0-ai/vm0/compare/api-v1.212.2...api-v1.213.0) (2026-07-03)


### Features

* bootstrap clerk orgs into limited-free workspaces ([#20029](https://github.com/vm0-ai/vm0/issues/20029)) ([d5ba8c4](https://github.com/vm0-ai/vm0/commit/d5ba8c4359c45fb82032eba9a927d4ffbac72a88))

## [1.212.2](https://github.com/vm0-ai/vm0/compare/api-v1.212.1...api-v1.212.2) (2026-07-03)


### Performance Improvements

* attribute workflow event source timing ([#19998](https://github.com/vm0-ai/vm0/issues/19998)) ([2856fff](https://github.com/vm0-ai/vm0/commit/2856fff042e21529141082a27c7ecb528266fc5d))

## [1.212.1](https://github.com/vm0-ai/vm0/compare/api-v1.212.0...api-v1.212.1) (2026-07-03)


### Bug Fixes

* coalesce runner direct candidate bursts ([#19969](https://github.com/vm0-ai/vm0/issues/19969)) ([1135a51](https://github.com/vm0-ai/vm0/commit/1135a514c5e5ca21bb0b929885e98e9061fe581b))
* remove invalid goal deny rules ([#19996](https://github.com/vm0-ai/vm0/issues/19996)) ([f990cc2](https://github.com/vm0-ai/vm0/commit/f990cc2bc5c16e924fa9f08dfe7ad46cf550db2f))
* run goal continuations from the full objective prompt ([#19991](https://github.com/vm0-ai/vm0/issues/19991)) ([05a2ef8](https://github.com/vm0-ai/vm0/commit/05a2ef8136d310b8068f53d70e485992ee891639))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.147.1
    * @vm0/core bumped to 8.391.4
    * @vm0/db bumped to 1.86.2

## [1.212.0](https://github.com/vm0-ai/vm0/compare/api-v1.211.0...api-v1.212.0) (2026-07-03)


### Features

* expose build commit sha ([#19954](https://github.com/vm0-ai/vm0/issues/19954)) ([50733bd](https://github.com/vm0-ai/vm0/commit/50733bd6e0ed5e57dd476f5139072b18d56018fb))
* show workflow owner Clerk avatar and widen hover card row spacing ([#19960](https://github.com/vm0-ai/vm0/issues/19960)) ([9ee4853](https://github.com/vm0-ai/vm0/commit/9ee48530988d3e8fa4c2a4637b930ca191f48031))


### Bug Fixes

* prevent goal continuation from preempting queued chat ([#19950](https://github.com/vm0-ai/vm0/issues/19950)) ([2af12c7](https://github.com/vm0-ai/vm0/commit/2af12c7a28e815cd53f120384859b8a4e16cceb0))


### Refactoring

* remove computer use delegated authorization switch ([#19971](https://github.com/vm0-ai/vm0/issues/19971)) ([682219b](https://github.com/vm0-ai/vm0/commit/682219bb52c9519cf96d6cfe39e50385718dad71))
* retire PresentationTemplateRunbook feature switch, make runbook flow the default ([#19965](https://github.com/vm0-ai/vm0/issues/19965)) ([47bc92d](https://github.com/vm0-ai/vm0/commit/47bc92da3ffbcabd103ef91dd87739be813c4989))


### Performance Improvements

* add session history telemetry buckets ([#19953](https://github.com/vm0-ai/vm0/issues/19953)) ([27309a2](https://github.com/vm0-ai/vm0/commit/27309a250f9374e3e8a1d46fa4476d57b248522d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.147.0
    * @vm0/connectors bumped to 1.131.1
    * @vm0/core bumped to 8.391.3
    * @vm0/db bumped to 1.86.1

## [1.211.0](https://github.com/vm0-ai/vm0/compare/api-v1.210.1...api-v1.211.0) (2026-07-03)


### Features

* add Google Meet transcript-generated workflow trigger ([#19789](https://github.com/vm0-ai/vm0/issues/19789)) ([91aef71](https://github.com/vm0-ai/vm0/commit/91aef711953cb2107c62ae7d2d3a7f9da38a071f))


### Performance Improvements

* add custom connector runtime timing ([#19949](https://github.com/vm0-ai/vm0/issues/19949)) ([e2d7a85](https://github.com/vm0-ai/vm0/commit/e2d7a857caf510b76004a708f68fdbb6094718d1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.146.0
    * @vm0/connectors bumped to 1.131.0
    * @vm0/core bumped to 8.391.2
    * @vm0/db bumped to 1.86.0

## [1.210.1](https://github.com/vm0-ai/vm0/compare/api-v1.210.0...api-v1.210.1) (2026-07-03)


### Bug Fixes

* allow team access to paid video templates ([#19922](https://github.com/vm0-ai/vm0/issues/19922)) ([1c4476e](https://github.com/vm0-ai/vm0/commit/1c4476e702b597b093d3d07396843d21fc5cea04))
* **core:** update schoolhouse and sticker scrapbook runbook archives ([#19947](https://github.com/vm0-ai/vm0/issues/19947)) ([017be61](https://github.com/vm0-ai/vm0/commit/017be619eea4a82478ddab3f77eb6bad339a81bd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.391.1
    * @vm0/db bumped to 1.85.6

## [1.210.0](https://github.com/vm0-ai/vm0/compare/api-v1.209.3...api-v1.210.0) (2026-07-03)


### Features

* render chat threads from event sourcing ([#19929](https://github.com/vm0-ai/vm0/issues/19929)) ([577d15e](https://github.com/vm0-ai/vm0/commit/577d15e5316e45102698c2e33eb0d71a02420228))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.145.0
    * @vm0/connectors bumped to 1.130.0
    * @vm0/core bumped to 8.391.0
    * @vm0/db bumped to 1.85.5

## [1.209.3](https://github.com/vm0-ai/vm0/compare/api-v1.209.2...api-v1.209.3) (2026-07-03)


### Refactoring

* reduce fallback slop in API model state ([#19920](https://github.com/vm0-ai/vm0/issues/19920)) ([9e80759](https://github.com/vm0-ai/vm0/commit/9e807591f3a5c03aa115a7224dc032d2a990d6e3))

## [1.209.2](https://github.com/vm0-ai/vm0/compare/api-v1.209.1...api-v1.209.2) (2026-07-03)


### Refactoring

* reduce fallback slop in test support contracts ([#19915](https://github.com/vm0-ai/vm0/issues/19915)) ([d2ca8c0](https://github.com/vm0-ai/vm0/commit/d2ca8c013c73602f2ed48b34693914b78a31cf3d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.144.1
    * @vm0/core bumped to 8.390.1
    * @vm0/db bumped to 1.85.4

## [1.209.1](https://github.com/vm0-ai/vm0/compare/api-v1.209.0...api-v1.209.1) (2026-07-02)


### Performance Improvements

* add artifact ensure storage manifest timing ([#19901](https://github.com/vm0-ai/vm0/issues/19901)) ([749e1bb](https://github.com/vm0-ai/vm0/commit/749e1bb01dcd16c04347ec1c7f174af7e167c9ad))

## [1.209.0](https://github.com/vm0-ai/vm0/compare/api-v1.208.3...api-v1.209.0) (2026-07-02)


### Features

* add Codex fast mode for ChatGPT subscription runs ([#19811](https://github.com/vm0-ai/vm0/issues/19811)) ([42e8e48](https://github.com/vm0-ai/vm0/commit/42e8e4883e548d497eb0b86a936b6be308ad1bed))
* redesign workflows list with connector pills and next-run view ([#19790](https://github.com/vm0-ai/vm0/issues/19790)) ([1114b1e](https://github.com/vm0-ai/vm0/commit/1114b1e0bdd7b7e0007e91e6048318a568c2fabc))


### Bug Fixes

* **runner:** remove session history claim capabilities ([#19832](https://github.com/vm0-ai/vm0/issues/19832)) ([f80876f](https://github.com/vm0-ai/vm0/commit/f80876f4dbfd3674f7b60b34941a1783dbe26f04))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.144.0
    * @vm0/connectors bumped to 1.129.0
    * @vm0/core bumped to 8.390.0
    * @vm0/db bumped to 1.85.3

## [1.208.3](https://github.com/vm0-ai/vm0/compare/api-v1.208.2...api-v1.208.3) (2026-07-02)


### Bug Fixes

* protect same-session runner affinity claims ([#19764](https://github.com/vm0-ai/vm0/issues/19764)) ([5bbd286](https://github.com/vm0-ai/vm0/commit/5bbd2862e2eceb51a71ba681a24d64b87894d712))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.143.3
    * @vm0/core bumped to 8.389.1
    * @vm0/db bumped to 1.85.2

## [1.208.2](https://github.com/vm0-ai/vm0/compare/api-v1.208.1...api-v1.208.2) (2026-07-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.143.2
    * @vm0/connectors bumped to 1.128.0
    * @vm0/core bumped to 8.389.0
    * @vm0/db bumped to 1.85.1

## [1.208.1](https://github.com/vm0-ai/vm0/compare/api-v1.208.0...api-v1.208.1) (2026-07-02)


### Bug Fixes

* drop the fallback DB note for generation template selections ([#19831](https://github.com/vm0-ai/vm0/issues/19831)) ([83cb5f3](https://github.com/vm0-ai/vm0/commit/83cb5f35ca84d4dc3d6f83ef639ed95b581e9129))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.143.1
    * @vm0/core bumped to 8.388.0
    * @vm0/db bumped to 1.85.0

## [1.208.0](https://github.com/vm0-ai/vm0/compare/api-v1.207.1...api-v1.208.0) (2026-07-02)


### Features

* add Desktop Computer Use filesystem plugins ([#19814](https://github.com/vm0-ai/vm0/issues/19814)) ([062a44c](https://github.com/vm0-ai/vm0/commit/062a44c181536df868bc6b081bae0dd7a2d9d9d6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.143.0
    * @vm0/connectors bumped to 1.127.0
    * @vm0/core bumped to 8.387.0
    * @vm0/db bumped to 1.84.6

## [1.207.1](https://github.com/vm0-ai/vm0/compare/api-v1.207.0...api-v1.207.1) (2026-07-02)


### Bug Fixes

* preserve agent connector add semantics ([#19815](https://github.com/vm0-ai/vm0/issues/19815)) ([1dbc317](https://github.com/vm0-ai/vm0/commit/1dbc317f5b5aebe9dff79353accac2e3f8878d18))


### Performance Improvements

* add session history encoding telemetry ([#19812](https://github.com/vm0-ai/vm0/issues/19812)) ([7c0814a](https://github.com/vm0-ai/vm0/commit/7c0814af703af9ad89cd34dc0fd131db0916fec7))
* cache system storage presigned urls ([#19777](https://github.com/vm0-ai/vm0/issues/19777)) ([62f66b9](https://github.com/vm0-ai/vm0/commit/62f66b9474c1bfbf19155790f1d2a839d332b331))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.142.2
    * @vm0/core bumped to 8.386.2
    * @vm0/db bumped to 1.84.5

## [1.207.0](https://github.com/vm0-ai/vm0/compare/api-v1.206.0...api-v1.207.0) (2026-07-02)


### Features

* add birefnet and clarity-upscaler transform image models ([#19704](https://github.com/vm0-ai/vm0/issues/19704)) ([e62b2e0](https://github.com/vm0-ai/vm0/commit/e62b2e0a242af4e522cda1f440ee6a5e4ebdbbc5))


### Bug Fixes

* make generation templates one-shot instead of thread-sticky ([#19765](https://github.com/vm0-ai/vm0/issues/19765)) ([29c9633](https://github.com/vm0-ai/vm0/commit/29c9633272045d932aef71f80cae2d91008bf415))


### Refactoring

* use public connector catalog in platform ui ([#19663](https://github.com/vm0-ai/vm0/issues/19663)) ([85ca45f](https://github.com/vm0-ai/vm0/commit/85ca45f3a136a40245e9dd16a8e6eeffc06d9477))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.142.1
    * @vm0/core bumped to 8.386.1
    * @vm0/db bumped to 1.84.4

## [1.206.0](https://github.com/vm0-ai/vm0/compare/api-v1.205.0...api-v1.206.0) (2026-07-02)


### Features

* add byteplus voice input stt ([#19510](https://github.com/vm0-ai/vm0/issues/19510)) ([42665c5](https://github.com/vm0-ai/vm0/commit/42665c5054ab243593122ab999f98829f301f6b7))
* add Pexels as presentation image provider with Unsplash-preferred switch ([#19756](https://github.com/vm0-ai/vm0/issues/19756)) ([9222ea2](https://github.com/vm0-ai/vm0/commit/9222ea207ba7a4224eb6809d46ccac2b02ece38b))


### Bug Fixes

* **api:** suppress malformed follow-up suggestions ([#19762](https://github.com/vm0-ai/vm0/issues/19762)) ([70208d8](https://github.com/vm0-ai/vm0/commit/70208d8fe9d594ecfb07dc841041d5738b9fd2c3))
* fire Google Ads signup conversion ([#19775](https://github.com/vm0-ai/vm0/issues/19775)) ([c1092a7](https://github.com/vm0-ai/vm0/commit/c1092a70ba713db885cb89475bb57b3d1883db95))
* gate workflow trigger firing by fireability ([#19768](https://github.com/vm0-ai/vm0/issues/19768)) ([cfb7c81](https://github.com/vm0-ai/vm0/commit/cfb7c81110271d2f79db668a933c5546318e34c9))
* restart full thinking typewriter lines ([#19771](https://github.com/vm0-ai/vm0/issues/19771)) ([063aac1](https://github.com/vm0-ai/vm0/commit/063aac15a9cf3c7ac5d48963583db987e980899d))


### Performance Improvements

* add compressed resume session history transport ([#19667](https://github.com/vm0-ai/vm0/issues/19667)) ([ee23c32](https://github.com/vm0-ai/vm0/commit/ee23c326ccf794228d2c4f9dd6d8844cd032fc49))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.142.0
    * @vm0/connectors bumped to 1.126.0
    * @vm0/core bumped to 8.386.0
    * @vm0/db bumped to 1.84.3

## [1.205.0](https://github.com/vm0-ai/vm0/compare/api-v1.204.2...api-v1.205.0) (2026-07-02)


### Features

* support darwin x64 desktop builds ([#19766](https://github.com/vm0-ai/vm0/issues/19766)) ([d58dd67](https://github.com/vm0-ai/vm0/commit/d58dd6729078d9bf6556ed5a75c4a66e08b87373))


### Bug Fixes

* remove workflow publish approval flow ([#19767](https://github.com/vm0-ai/vm0/issues/19767)) ([19d0fa7](https://github.com/vm0-ai/vm0/commit/19d0fa765fe2fb9a15d64e2a04616b41b8546a17))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.141.0
    * @vm0/connectors bumped to 1.125.0
    * @vm0/core bumped to 8.385.0
    * @vm0/db bumped to 1.84.2

## [1.204.2](https://github.com/vm0-ai/vm0/compare/api-v1.204.1...api-v1.204.2) (2026-07-02)


### Bug Fixes

* keep follow-up markers after assistant content ([#19737](https://github.com/vm0-ai/vm0/issues/19737)) ([d135270](https://github.com/vm0-ai/vm0/commit/d135270c327e2aece0a9a014128928e1e230107b))

## [1.204.1](https://github.com/vm0-ai/vm0/compare/api-v1.204.0...api-v1.204.1) (2026-07-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.140.1
    * @vm0/connectors bumped to 1.124.1
    * @vm0/core bumped to 8.384.4
    * @vm0/db bumped to 1.84.1

## [1.204.0](https://github.com/vm0-ai/vm0/compare/api-v1.203.4...api-v1.204.0) (2026-07-02)


### Features

* restore Claude Fable 5 support ([#19721](https://github.com/vm0-ai/vm0/issues/19721)) ([97a7753](https://github.com/vm0-ai/vm0/commit/97a775354429e1f3de625627e3fbeeaf01c2552d))


### Bug Fixes

* sync chat message updates by id ([#19701](https://github.com/vm0-ai/vm0/issues/19701)) ([dc56030](https://github.com/vm0-ai/vm0/commit/dc56030baa32d7452c906edb3ec36d14543c9ac5))


### Refactoring

* reduce fallback slop in runtime guards ([#19720](https://github.com/vm0-ai/vm0/issues/19720)) ([5d61de7](https://github.com/vm0-ai/vm0/commit/5d61de75720518d76e917f06a7be0bf95f155973))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.140.0
    * @vm0/core bumped to 8.384.3
    * @vm0/db bumped to 1.84.0

## [1.203.4](https://github.com/vm0-ai/vm0/compare/api-v1.203.3...api-v1.203.4) (2026-07-01)


### Performance Improvements

* attribute zero source entrypoint timing ([#19713](https://github.com/vm0-ai/vm0/issues/19713)) ([5e897dc](https://github.com/vm0-ai/vm0/commit/5e897dc6e6ccee463e081c464d9d614f8d1b1ed3))

## [1.203.3](https://github.com/vm0-ai/vm0/compare/api-v1.203.2...api-v1.203.3) (2026-07-01)


### Performance Improvements

* attribute storage manifest presign work ([#19693](https://github.com/vm0-ai/vm0/issues/19693)) ([0f78c6b](https://github.com/vm0-ai/vm0/commit/0f78c6b66c06c3004a52cd97940ab3a2d5e4eb22))

## [1.203.2](https://github.com/vm0-ai/vm0/compare/api-v1.203.1...api-v1.203.2) (2026-07-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.139.2
    * @vm0/connectors bumped to 1.124.0
    * @vm0/core bumped to 8.384.2
    * @vm0/db bumped to 1.83.3

## [1.203.1](https://github.com/vm0-ai/vm0/compare/api-v1.203.0...api-v1.203.1) (2026-07-01)


### Bug Fixes

* scope data export feature switch to org ([#19700](https://github.com/vm0-ai/vm0/issues/19700)) ([ae28726](https://github.com/vm0-ai/vm0/commit/ae2872625db443cbba1398a8215fa4e5e8c3d153))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.139.1
    * @vm0/core bumped to 8.384.1
    * @vm0/db bumped to 1.83.2

## [1.203.0](https://github.com/vm0-ai/vm0/compare/api-v1.202.0...api-v1.203.0) (2026-07-01)


### Features

* add teams settings ui ([#19570](https://github.com/vm0-ai/vm0/issues/19570)) ([242e261](https://github.com/vm0-ai/vm0/commit/242e26146208b187de904e92116590bb767bc5e9))
* export user-owned data files ([#19664](https://github.com/vm0-ai/vm0/issues/19664)) ([af2f0f3](https://github.com/vm0-ai/vm0/commit/af2f0f3c41cb147690d179937197762604479e11))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.139.0
    * @vm0/connectors bumped to 1.123.0
    * @vm0/core bumped to 8.384.0
    * @vm0/db bumped to 1.83.1

## [1.202.0](https://github.com/vm0-ai/vm0/compare/api-v1.201.0...api-v1.202.0) (2026-07-01)


### Features

* add workflow templates to composer ([#19660](https://github.com/vm0-ai/vm0/issues/19660)) ([1f110fd](https://github.com/vm0-ai/vm0/commit/1f110fd9d3ae503e731e957767a76d0094ce88a9))


### Bug Fixes

* commit create-run launch rows atomically ([#19641](https://github.com/vm0-ai/vm0/issues/19641)) ([24c9414](https://github.com/vm0-ai/vm0/commit/24c941437c27b918c7cad1e36bc5a14ce8021869))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.138.0
    * @vm0/connectors bumped to 1.122.0
    * @vm0/core bumped to 8.383.0
    * @vm0/db bumped to 1.83.0

## [1.201.0](https://github.com/vm0-ai/vm0/compare/api-v1.200.0...api-v1.201.0) (2026-07-01)


### Features

* gate MiniMax Codex framework routing ([#19616](https://github.com/vm0-ai/vm0/issues/19616)) ([ed9b1de](https://github.com/vm0-ai/vm0/commit/ed9b1dea4c8b95ed78074f6fa2f9197dded9cdbc))
* support scoped workflow name refs ([#19655](https://github.com/vm0-ai/vm0/issues/19655)) ([7018ee0](https://github.com/vm0-ai/vm0/commit/7018ee0446da472fb5b10370951513f189f52535))
* update new org default models ([#19606](https://github.com/vm0-ai/vm0/issues/19606)) ([9fdc5db](https://github.com/vm0-ai/vm0/commit/9fdc5db1ab9dc77b6e20d731f84ddd5f226d48ac))


### Bug Fixes

* apply sandbox io limiters from host capacity ([#19668](https://github.com/vm0-ai/vm0/issues/19668)) ([8baa893](https://github.com/vm0-ai/vm0/commit/8baa893dbbae076adbde5e31f467103a0c06179e))


### Performance Improvements

* reduce artifact storage manifest presigning ([#19650](https://github.com/vm0-ai/vm0/issues/19650)) ([0672271](https://github.com/vm0-ai/vm0/commit/0672271c090e1a5431ac762c566328125958a218))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.137.0
    * @vm0/connectors bumped to 1.121.0
    * @vm0/core bumped to 8.382.0
    * @vm0/db bumped to 1.82.0

## [1.200.0](https://github.com/vm0-ai/vm0/compare/api-v1.199.2...api-v1.200.0) (2026-07-01)


### Features

* expose connector catalog status view models ([#19580](https://github.com/vm0-ai/vm0/issues/19580)) ([697e259](https://github.com/vm0-ai/vm0/commit/697e25903a89443aa024dc38dfaca850133d99db))
* show subscription account details ([#19500](https://github.com/vm0-ai/vm0/issues/19500)) ([b33f4ca](https://github.com/vm0-ai/vm0/commit/b33f4ca766b19a91ed782766ca29f8f9b50640aa))


### Bug Fixes

* publish workflow trigger automation refreshes ([#19629](https://github.com/vm0-ai/vm0/issues/19629)) ([c719a69](https://github.com/vm0-ai/vm0/commit/c719a6909e762072901600b00b487c8c47618fa9))
* remove workflow follow-up suggestions ([#19646](https://github.com/vm0-ai/vm0/issues/19646)) ([c21341b](https://github.com/vm0-ai/vm0/commit/c21341bb4e5d09d0879727a8efe5424081dfdb3f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.136.0
    * @vm0/connectors bumped to 1.120.1
    * @vm0/core bumped to 8.381.3
    * @vm0/db bumped to 1.81.0

## [1.199.2](https://github.com/vm0-ai/vm0/compare/api-v1.199.1...api-v1.199.2) (2026-07-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.135.0
    * @vm0/core bumped to 8.381.2
    * @vm0/db bumped to 1.80.2

## [1.199.1](https://github.com/vm0-ai/vm0/compare/api-v1.199.0...api-v1.199.1) (2026-07-01)


### Bug Fixes

* defer run launch side effects until persistence ([#19579](https://github.com/vm0-ai/vm0/issues/19579)) ([b7f6de5](https://github.com/vm0-ai/vm0/commit/b7f6de51d4305d881d486de694889a9550c1f92a))


### Performance Improvements

* skip Axiom chat output wait when DB complete ([#19563](https://github.com/vm0-ai/vm0/issues/19563)) ([f1283e3](https://github.com/vm0-ai/vm0/commit/f1283e36c2b2779dffbf8fbc33a18cb6a76a45d1))
* speed up workflow list api ([#19604](https://github.com/vm0-ai/vm0/issues/19604)) ([bc371dd](https://github.com/vm0-ai/vm0/commit/bc371dd085ce6d882a7a73b9a2a87b396dea9bc3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.80.1

## [1.199.0](https://github.com/vm0-ai/vm0/compare/api-v1.198.0...api-v1.199.0) (2026-07-01)


### Features

* add Google Calendar event-updated workflow trigger ([#19562](https://github.com/vm0-ai/vm0/issues/19562)) ([814bd2f](https://github.com/vm0-ai/vm0/commit/814bd2ffb0d5e024463d1c90203f40512f792bae))


### Bug Fixes

* disable Claude Code attachments for incompatible providers ([#19558](https://github.com/vm0-ai/vm0/issues/19558)) ([d5cd233](https://github.com/vm0-ai/vm0/commit/d5cd233e81363cedaab73bafffa8eae1325d2180))


### Refactoring

* remove legacy generate image route ([#19568](https://github.com/vm0-ai/vm0/issues/19568)) ([7d62a26](https://github.com/vm0-ai/vm0/commit/7d62a268d0737a7effbfbbd174a4ef1b0a5bb4fa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.134.0
    * @vm0/core bumped to 8.381.1
    * @vm0/db bumped to 1.80.0

## [1.198.0](https://github.com/vm0-ai/vm0/compare/api-v1.197.0...api-v1.198.0) (2026-07-01)


### Features

* make connector catalog api generally available ([#19560](https://github.com/vm0-ai/vm0/issues/19560)) ([797a756](https://github.com/vm0-ai/vm0/commit/797a756f36d59db010b3bc7171a8bee590bc115a))
* post teams run callbacks ([#19553](https://github.com/vm0-ai/vm0/issues/19553)) ([c29c946](https://github.com/vm0-ai/vm0/commit/c29c946eeae86befb451538c750b1e8074e1b5ea))


### Bug Fixes

* add telegram callback rate-limit retry ([#19559](https://github.com/vm0-ai/vm0/issues/19559)) ([d3b3ccc](https://github.com/vm0-ai/vm0/commit/d3b3ccc708107d1bf74d1838e5c20736a4440bc8))
* clean up run launch orphans ([#19534](https://github.com/vm0-ai/vm0/issues/19534)) ([e405c2b](https://github.com/vm0-ai/vm0/commit/e405c2b20132bcebea9f4e2a2eb636639895783e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.133.2
    * @vm0/connectors bumped to 1.120.0
    * @vm0/core bumped to 8.381.0
    * @vm0/db bumped to 1.79.8

## [1.197.0](https://github.com/vm0-ai/vm0/compare/api-v1.196.1...api-v1.197.0) (2026-07-01)


### Features

* support public connector form field ids ([#19506](https://github.com/vm0-ai/vm0/issues/19506)) ([c18d792](https://github.com/vm0-ai/vm0/commit/c18d7928e35477389809273f8f8c594b9f96d09d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.133.1
    * @vm0/connectors bumped to 1.119.0
    * @vm0/core bumped to 8.380.2
    * @vm0/db bumped to 1.79.7

## [1.196.1](https://github.com/vm0-ai/vm0/compare/api-v1.196.0...api-v1.196.1) (2026-07-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.380.1
    * @vm0/db bumped to 1.79.6

## [1.196.0](https://github.com/vm0-ai/vm0/compare/api-v1.195.3...api-v1.196.0) (2026-07-01)


### Features

* add Claude Sonnet 5 model support ([#19539](https://github.com/vm0-ai/vm0/issues/19539)) ([399f1ad](https://github.com/vm0-ai/vm0/commit/399f1ad74ef3ec9e91b7331cb5ed80c550ed5599))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.133.0
    * @vm0/connectors bumped to 1.118.0
    * @vm0/core bumped to 8.380.0
    * @vm0/db bumped to 1.79.5

## [1.195.3](https://github.com/vm0-ai/vm0/compare/api-v1.195.2...api-v1.195.3) (2026-06-30)


### Refactoring

* reduce fallback slop in axiom telemetry ([#19537](https://github.com/vm0-ai/vm0/issues/19537)) ([55a11c0](https://github.com/vm0-ai/vm0/commit/55a11c0c6246cd8f84a466baeeb8b138650cd70c))

## [1.195.2](https://github.com/vm0-ai/vm0/compare/api-v1.195.1...api-v1.195.2) (2026-06-30)


### Refactoring

* remove legacy GitHub integration surface ([#19516](https://github.com/vm0-ai/vm0/issues/19516)) ([c7c6b30](https://github.com/vm0-ai/vm0/commit/c7c6b3003aecca18104de6e3e9f540ea2a3fe60d))


### Performance Improvements

* reduce queued chat auto-send delay ([#19397](https://github.com/vm0-ai/vm0/issues/19397)) ([461eda0](https://github.com/vm0-ai/vm0/commit/461eda085658dfb212d7dfeda13d4c355f22818c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.132.1
    * @vm0/connectors bumped to 1.117.2
    * @vm0/core bumped to 8.379.3
    * @vm0/db bumped to 1.79.4

## [1.195.1](https://github.com/vm0-ai/vm0/compare/api-v1.195.0...api-v1.195.1) (2026-06-30)


### Bug Fixes

* restore default agent mark all read menu ([#19515](https://github.com/vm0-ai/vm0/issues/19515)) ([aaa0aee](https://github.com/vm0-ai/vm0/commit/aaa0aee02f026554cf7d341e850ef76b3106048c))

## [1.195.0](https://github.com/vm0-ai/vm0/compare/api-v1.194.0...api-v1.195.0) (2026-06-30)


### Features

* add teams installation connect flow ([#19499](https://github.com/vm0-ai/vm0/issues/19499)) ([c6ba311](https://github.com/vm0-ai/vm0/commit/c6ba311bbc015fdcda49aadbc3c26536aaefc4b0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.132.0
    * @vm0/core bumped to 8.379.2
    * @vm0/db bumped to 1.79.3

## [1.194.0](https://github.com/vm0-ai/vm0/compare/api-v1.193.2...api-v1.194.0) (2026-06-30)


### Features

* add Teams bot ingress verification ([#19483](https://github.com/vm0-ai/vm0/issues/19483)) ([457f8db](https://github.com/vm0-ai/vm0/commit/457f8dbe04ff4bff402deef852adfa9a7222ffc4))


### Bug Fixes

* suppress agent unread during active chat runs ([#19444](https://github.com/vm0-ai/vm0/issues/19444)) ([19035cb](https://github.com/vm0-ai/vm0/commit/19035cb011d144ae04cecced717f004a57e59534))


### Refactoring

* unify workflow automation feature switch ([#19476](https://github.com/vm0-ai/vm0/issues/19476)) ([7af9712](https://github.com/vm0-ai/vm0/commit/7af97127c1b742c1d7e4e3ba20b96bfccc5e08ad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.131.0
    * @vm0/connectors bumped to 1.117.1
    * @vm0/core bumped to 8.379.1
    * @vm0/db bumped to 1.79.2

## [1.193.2](https://github.com/vm0-ai/vm0/compare/api-v1.193.1...api-v1.193.2) (2026-06-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.130.0
    * @vm0/connectors bumped to 1.117.0
    * @vm0/core bumped to 8.379.0
    * @vm0/db bumped to 1.79.1

## [1.193.1](https://github.com/vm0-ai/vm0/compare/api-v1.193.0...api-v1.193.1) (2026-06-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.79.0

## [1.193.0](https://github.com/vm0-ai/vm0/compare/api-v1.192.0...api-v1.193.0) (2026-06-30)


### Features

* suggest workflow automation in chat followups ([#19456](https://github.com/vm0-ai/vm0/issues/19456)) ([42eba73](https://github.com/vm0-ai/vm0/commit/42eba737749a1e0e2439ca6cf6c0a6e301ca3742))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.129.1
    * @vm0/connectors bumped to 1.116.0
    * @vm0/core bumped to 8.378.0
    * @vm0/db bumped to 1.78.6

## [1.192.0](https://github.com/vm0-ai/vm0/compare/api-v1.191.0...api-v1.192.0) (2026-06-30)


### Features

* add zero chat get command ([#19405](https://github.com/vm0-ai/vm0/issues/19405)) ([3a90d8f](https://github.com/vm0-ai/vm0/commit/3a90d8f6fd3d575359569843da81b34d2c1a0604))


### Refactoring

* add connector catalog reader ([#19413](https://github.com/vm0-ai/vm0/issues/19413)) ([2d4da46](https://github.com/vm0-ai/vm0/commit/2d4da46517093ef9558ffc93419ffc1f072d2e6d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.129.0
    * @vm0/core bumped to 8.377.2
    * @vm0/db bumped to 1.78.5

## [1.191.0](https://github.com/vm0-ai/vm0/compare/api-v1.190.0...api-v1.191.0) (2026-06-30)


### Features

* add zero chat rename command ([#19381](https://github.com/vm0-ai/vm0/issues/19381)) ([dd04ffb](https://github.com/vm0-ai/vm0/commit/dd04ffb0651ed7083bdb2831e9775315180d8ecd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.128.0
    * @vm0/core bumped to 8.377.1
    * @vm0/db bumped to 1.78.4

## [1.190.0](https://github.com/vm0-ai/vm0/compare/api-v1.189.2...api-v1.190.0) (2026-06-30)


### Features

* add agent unread indicators ([#19374](https://github.com/vm0-ai/vm0/issues/19374)) ([d04cfbc](https://github.com/vm0-ai/vm0/commit/d04cfbc55ea55235ac77321760a3dedc29dd7a87))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.127.0
    * @vm0/connectors bumped to 1.115.0
    * @vm0/core bumped to 8.377.0
    * @vm0/db bumped to 1.78.3

## [1.189.2](https://github.com/vm0-ai/vm0/compare/api-v1.189.1...api-v1.189.2) (2026-06-29)


### Bug Fixes

* **cli:** make permission-deny base-aware ([#19330](https://github.com/vm0-ai/vm0/issues/19330)) ([3e2c7f6](https://github.com/vm0-ai/vm0/commit/3e2c7f64f81518f36df41d81521201dc8bff51ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.126.2
    * @vm0/connectors bumped to 1.114.1
    * @vm0/core bumped to 8.376.2
    * @vm0/db bumped to 1.78.2

## [1.189.1](https://github.com/vm0-ai/vm0/compare/api-v1.189.0...api-v1.189.1) (2026-06-29)


### Refactoring

* remove legacy agent run telemetry route ([#19358](https://github.com/vm0-ai/vm0/issues/19358)) ([be6301c](https://github.com/vm0-ai/vm0/commit/be6301cd6a9dc5f81f87c37d511e845f9c512f20))


### Performance Improvements

* split zero web chat pre-create timing ([#19356](https://github.com/vm0-ai/vm0/issues/19356)) ([f765730](https://github.com/vm0-ai/vm0/commit/f7657309d326e84c10b05321d12829be21f9185e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.126.1
    * @vm0/core bumped to 8.376.1
    * @vm0/db bumped to 1.78.1

## [1.189.0](https://github.com/vm0-ai/vm0/compare/api-v1.188.0...api-v1.189.0) (2026-06-29)


### Features

* add Google Calendar event-created workflow trigger ([#19345](https://github.com/vm0-ai/vm0/issues/19345)) ([8219bad](https://github.com/vm0-ai/vm0/commit/8219bad3a8ebd3cc0ae373e0546e99118b866466))
* add presentation template runbook generation switch ([#19341](https://github.com/vm0-ai/vm0/issues/19341)) ([a933ab7](https://github.com/vm0-ai/vm0/commit/a933ab7626d0e5f5f73868f23b21622911afb5b1))
* improve Gmail workflow trigger briefs ([#19332](https://github.com/vm0-ai/vm0/issues/19332)) ([a8b419f](https://github.com/vm0-ai/vm0/commit/a8b419f2644996a2ed7434d08e066dc631dc3f3e))


### Refactoring

* remove legacy agent compose list route ([#19353](https://github.com/vm0-ai/vm0/issues/19353)) ([8dd78cc](https://github.com/vm0-ai/vm0/commit/8dd78ccabb8ab41a63a7fd0839447a50a3140f20))
* remove legacy agent compose metadata route ([#19347](https://github.com/vm0-ai/vm0/issues/19347)) ([d60898a](https://github.com/vm0-ai/vm0/commit/d60898aa67a07d672182d015549c48955614ba52))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.126.0
    * @vm0/connectors bumped to 1.114.0
    * @vm0/core bumped to 8.376.0
    * @vm0/db bumped to 1.78.0

## [1.188.0](https://github.com/vm0-ai/vm0/compare/api-v1.187.3...api-v1.188.0) (2026-06-29)


### Features

* add GitHub label workflow triggers ([#19322](https://github.com/vm0-ai/vm0/issues/19322)) ([245be48](https://github.com/vm0-ai/vm0/commit/245be48e4eab3b4644e00fe9480213c327dda1b9))


### Bug Fixes

* default new workspaces to sonnet ([#19293](https://github.com/vm0-ai/vm0/issues/19293)) ([fcfed7d](https://github.com/vm0-ai/vm0/commit/fcfed7d9522172c0a0b1210a554b45da166e57f8))


### Refactoring

* remove legacy agent compose delete route ([#19329](https://github.com/vm0-ai/vm0/issues/19329)) ([c2e1453](https://github.com/vm0-ai/vm0/commit/c2e14538da699adacfa1187347e27f1a42921c42))
* remove legacy agent compose instructions route ([#19338](https://github.com/vm0-ai/vm0/issues/19338)) ([9835703](https://github.com/vm0-ai/vm0/commit/9835703457fb0cedb8aeb4516c61299e843577b2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.125.0
    * @vm0/connectors bumped to 1.113.0
    * @vm0/core bumped to 8.375.0
    * @vm0/db bumped to 1.77.0

## [1.187.3](https://github.com/vm0-ai/vm0/compare/api-v1.187.2...api-v1.187.3) (2026-06-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.124.6
    * @vm0/connectors bumped to 1.112.1
    * @vm0/core bumped to 8.374.6
    * @vm0/db bumped to 1.76.8

## [1.187.2](https://github.com/vm0-ai/vm0/compare/api-v1.187.1...api-v1.187.2) (2026-06-29)


### Bug Fixes

* allow concurrent workflow event triggers ([#19314](https://github.com/vm0-ai/vm0/issues/19314)) ([1f21d42](https://github.com/vm0-ai/vm0/commit/1f21d42c3fbbeb5c7061d9389b72451a2055d8b9))

## [1.187.1](https://github.com/vm0-ai/vm0/compare/api-v1.187.0...api-v1.187.1) (2026-06-29)


### Performance Improvements

* lazy materialize firewall auth secrets ([#19277](https://github.com/vm0-ai/vm0/issues/19277)) ([2aaa344](https://github.com/vm0-ai/vm0/commit/2aaa3441e8c8c70aa6bad4d887808e9484ff0946))

## [1.187.0](https://github.com/vm0-ai/vm0/compare/api-v1.186.5...api-v1.187.0) (2026-06-29)


### Features

* add atom grant invoice entitlements ([#19275](https://github.com/vm0-ai/vm0/issues/19275)) ([2c00769](https://github.com/vm0-ai/vm0/commit/2c007696e9588b4a53d9ec5115f735ece6bd63e4))


### Refactoring

* remove workflow permission grants ([#19271](https://github.com/vm0-ai/vm0/issues/19271)) ([07e590a](https://github.com/vm0-ai/vm0/commit/07e590af6b59fd53a565a7be9341d685f0321299))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.124.5
    * @vm0/core bumped to 8.374.5
    * @vm0/db bumped to 1.76.7

## [1.186.5](https://github.com/vm0-ai/vm0/compare/api-v1.186.4...api-v1.186.5) (2026-06-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.124.4
    * @vm0/connectors bumped to 1.112.0
    * @vm0/core bumped to 8.374.4
    * @vm0/db bumped to 1.76.6

## [1.186.4](https://github.com/vm0-ai/vm0/compare/api-v1.186.3...api-v1.186.4) (2026-06-29)


### Bug Fixes

* copy workflow runtime configuration ([#19252](https://github.com/vm0-ai/vm0/issues/19252)) ([aa7dfdf](https://github.com/vm0-ai/vm0/commit/aa7dfdfe4db634174c43cdffb7ec94457f24e0cf))

## [1.186.3](https://github.com/vm0-ai/vm0/compare/api-v1.186.2...api-v1.186.3) (2026-06-28)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.124.3
    * @vm0/core bumped to 8.374.3
    * @vm0/db bumped to 1.76.5

## [1.186.2](https://github.com/vm0-ai/vm0/compare/api-v1.186.1...api-v1.186.2) (2026-06-28)


### Bug Fixes

* **api:** deploy API for runtime dependency releases ([#19243](https://github.com/vm0-ai/vm0/issues/19243)) ([ba51114](https://github.com/vm0-ai/vm0/commit/ba5111415aab9e1cc3076e1d0ad60a551a9f87cf))
* bind workflow creation to current chat thread ([#19247](https://github.com/vm0-ai/vm0/issues/19247)) ([e656035](https://github.com/vm0-ai/vm0/commit/e6560354593174dcb2389013b3afe29cd31ffabc))
* block schedule automation writes behind workflow trigger switch ([#19248](https://github.com/vm0-ai/vm0/issues/19248)) ([6b1cf5f](https://github.com/vm0-ai/vm0/commit/6b1cf5f2dc5f062c3d3c39a4763ad89fb337d1dc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.124.2
    * @vm0/core bumped to 8.374.2
    * @vm0/db bumped to 1.76.4

## [1.186.1](https://github.com/vm0-ai/vm0/compare/api-v1.186.0...api-v1.186.1) (2026-06-28)


### Bug Fixes

* avoid workflow detail fanout on automations page ([#19239](https://github.com/vm0-ai/vm0/issues/19239)) ([c7f4116](https://github.com/vm0-ai/vm0/commit/c7f411634ce894d449b75dd6206157613fb2ff6e))


### Performance Improvements

* add zero run origin timing attribution ([#19235](https://github.com/vm0-ai/vm0/issues/19235)) ([a726e89](https://github.com/vm0-ai/vm0/commit/a726e894d0f8bbc80f7a3a882d45ee4985d860f4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.124.1
    * @vm0/core bumped to 8.374.1
    * @vm0/db bumped to 1.76.3

## [1.186.0](https://github.com/vm0-ai/vm0/compare/api-v1.185.1...api-v1.186.0) (2026-06-28)


### Features

* add workflow permission request cards ([#19224](https://github.com/vm0-ai/vm0/issues/19224)) ([7e4907c](https://github.com/vm0-ai/vm0/commit/7e4907c3bb7e7d0a9043686a3cd56f5fc38fa799))


### Bug Fixes

* preserve workflow trigger loop cadence ([#19231](https://github.com/vm0-ai/vm0/issues/19231)) ([7e3cf79](https://github.com/vm0-ai/vm0/commit/7e3cf79b67b15be72f490566de090491cc78bb69))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.124.0
    * @vm0/connectors bumped to 1.111.0
    * @vm0/core bumped to 8.374.0
    * @vm0/db bumped to 1.76.2

## [1.185.1](https://github.com/vm0-ai/vm0/compare/api-v1.185.0...api-v1.185.1) (2026-06-28)


### Refactoring

* use trigger id as run group id for workflow triggers ([#19215](https://github.com/vm0-ai/vm0/issues/19215)) ([8ce95b7](https://github.com/vm0-ai/vm0/commit/8ce95b7a7ca0e6c28d355899b0c368f21c5a42b4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.76.1

## [1.185.0](https://github.com/vm0-ai/vm0/compare/api-v1.184.3...api-v1.185.0) (2026-06-27)


### Features

* share workflow trigger chat threads ([#19208](https://github.com/vm0-ai/vm0/issues/19208)) ([6f47f8e](https://github.com/vm0-ai/vm0/commit/6f47f8ee081c2d2033c74e2a384d92a609d05642))


### Refactoring

* reduce fallback slop in media contracts ([#19209](https://github.com/vm0-ai/vm0/issues/19209)) ([e0b4f47](https://github.com/vm0-ai/vm0/commit/e0b4f47deda2876191f0891e778354f21896be3b))


### Performance Improvements

* add storage manifest entry build timing ([#19206](https://github.com/vm0-ai/vm0/issues/19206)) ([b5d8cc8](https://github.com/vm0-ai/vm0/commit/b5d8cc8fdb40b9aadfd6789d4290b48761084a4b))
* reduce stored connector decrypt work ([#19202](https://github.com/vm0-ai/vm0/issues/19202)) ([10e8bf0](https://github.com/vm0-ai/vm0/commit/10e8bf00115804ad27cd9a4388787cf6e79573b9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.123.0
    * @vm0/core bumped to 8.373.4
    * @vm0/db bumped to 1.76.0

## [1.184.3](https://github.com/vm0-ai/vm0/compare/api-v1.184.2...api-v1.184.3) (2026-06-27)


### Bug Fixes

* cancel trial subscriptions on account deletion ([#19197](https://github.com/vm0-ai/vm0/issues/19197)) ([924fd60](https://github.com/vm0-ai/vm0/commit/924fd60279d7cc1e2c5e2256fd1b3d2ef54b2654))
* update atom grant expiry ([#19201](https://github.com/vm0-ai/vm0/issues/19201)) ([589e3dd](https://github.com/vm0-ai/vm0/commit/589e3dd8b401d12837c14490db58e7313edbf9c4))


### Refactoring

* reduce fallback slop in runtime validation ([#19200](https://github.com/vm0-ai/vm0/issues/19200)) ([9f367c2](https://github.com/vm0-ai/vm0/commit/9f367c27b4c49578f8dd644ee73e166e092cbe09))


### Performance Improvements

* add storage manifest dispatch timing ([#19190](https://github.com/vm0-ai/vm0/issues/19190)) ([baf713f](https://github.com/vm0-ai/vm0/commit/baf713f63f3ceabb39d65fe895986c343c2a764a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.122.0
    * @vm0/connectors bumped to 1.110.4
    * @vm0/core bumped to 8.373.3
    * @vm0/db bumped to 1.75.3

## [1.184.2](https://github.com/vm0-ai/vm0/compare/api-v1.184.1...api-v1.184.2) (2026-06-27)


### Performance Improvements

* add Zero service pre-create timing ([#19185](https://github.com/vm0-ai/vm0/issues/19185)) ([2d8e05f](https://github.com/vm0-ai/vm0/commit/2d8e05f7d2b49e9b87fdbf17cb986f2676b083cc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.121.2
    * @vm0/connectors bumped to 1.110.3
    * @vm0/core bumped to 8.373.2
    * @vm0/db bumped to 1.75.2

## [1.184.1](https://github.com/vm0-ai/vm0/compare/api-v1.184.0...api-v1.184.1) (2026-06-27)


### Performance Improvements

* scope direct run connectors ([#19145](https://github.com/vm0-ai/vm0/issues/19145)) ([1fd3496](https://github.com/vm0-ai/vm0/commit/1fd349612583dc27bb333b53b19040eb622576ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.121.1
    * @vm0/connectors bumped to 1.110.2
    * @vm0/core bumped to 8.373.1
    * @vm0/db bumped to 1.75.1

## [1.184.0](https://github.com/vm0-ai/vm0/compare/api-v1.183.0...api-v1.184.0) (2026-06-27)


### Features

* add workflow-scoped authorization ([#19147](https://github.com/vm0-ai/vm0/issues/19147)) ([b17dcd9](https://github.com/vm0-ai/vm0/commit/b17dcd9d1b4499321bf6f5f8760ab6f43d9285d5))
* enable goal workflows for staff orgs ([#19141](https://github.com/vm0-ai/vm0/issues/19141)) ([6d01523](https://github.com/vm0-ai/vm0/commit/6d01523dbf2ecfaa6f583d4f64652122e825ca37))


### Bug Fixes

* add ScrapeNinja RapidAPI host header ([#19138](https://github.com/vm0-ai/vm0/issues/19138)) ([5bd367c](https://github.com/vm0-ai/vm0/commit/5bd367cff031a467dcb15cd01aa00636add12c12))
* restrict credentialed dynamic firewall hosts ([#19137](https://github.com/vm0-ai/vm0/issues/19137)) ([9801134](https://github.com/vm0-ai/vm0/commit/9801134aede293f0fd3c1f11c386bf4483fff78d))


### Refactoring

* replace ts-rest contracts with trpc-backed contracts ([#19150](https://github.com/vm0-ai/vm0/issues/19150)) ([100ff36](https://github.com/vm0-ai/vm0/commit/100ff36c7a8abb9a0506c1183596680b1e0c8199))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.121.0
    * @vm0/connectors bumped to 1.110.1
    * @vm0/core bumped to 8.373.0
    * @vm0/db bumped to 1.75.0

## [1.183.0](https://github.com/vm0-ai/vm0/compare/api-v1.182.3...api-v1.183.0) (2026-06-26)


### Features

* add workflow trigger sidebar controls ([#19102](https://github.com/vm0-ai/vm0/issues/19102)) ([dd06b8d](https://github.com/vm0-ai/vm0/commit/dd06b8db7916473a6b87ed4edd3efb4f66c8e6a2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.120.0
    * @vm0/core bumped to 8.372.2
    * @vm0/db bumped to 1.74.4

## [1.182.3](https://github.com/vm0-ai/vm0/compare/api-v1.182.2...api-v1.182.3) (2026-06-26)


### Performance Improvements

* parallelize stored connector secret decrypts ([#19134](https://github.com/vm0-ai/vm0/issues/19134)) ([d863945](https://github.com/vm0-ai/vm0/commit/d863945607c699fb8b3d5e9b1b6c0217023c68c1))

## [1.182.2](https://github.com/vm0-ai/vm0/compare/api-v1.182.1...api-v1.182.2) (2026-06-26)


### Bug Fixes

* update workflow edit metadata ([#19100](https://github.com/vm0-ai/vm0/issues/19100)) ([c88e78f](https://github.com/vm0-ai/vm0/commit/c88e78f14c7f6670b99fc2a7b7d27b1947fb4349))


### Performance Improvements

* split create-run pre-create timing ([#19103](https://github.com/vm0-ai/vm0/issues/19103)) ([0bd906c](https://github.com/vm0-ai/vm0/commit/0bd906c02f3acc99a7df51e07793ad55941da188))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.119.0
    * @vm0/connectors bumped to 1.110.0
    * @vm0/core bumped to 8.372.1
    * @vm0/db bumped to 1.74.3

## [1.182.1](https://github.com/vm0-ai/vm0/compare/api-v1.182.0...api-v1.182.1) (2026-06-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.372.0
    * @vm0/db bumped to 1.74.2

## [1.182.0](https://github.com/vm0-ai/vm0/compare/api-v1.181.0...api-v1.182.0) (2026-06-26)


### Features

* group workflow cards by visibility ([#19059](https://github.com/vm0-ai/vm0/issues/19059)) ([4726706](https://github.com/vm0-ai/vm0/commit/4726706d354eae71db054ef2a93763971291a073))


### Performance Improvements

* split create-run connector context timing ([#19075](https://github.com/vm0-ai/vm0/issues/19075)) ([bf6c299](https://github.com/vm0-ai/vm0/commit/bf6c2994f4bb607c2609ff2244b88ad1c80ae211))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.118.0
    * @vm0/core bumped to 8.371.2
    * @vm0/db bumped to 1.74.1

## [1.181.0](https://github.com/vm0-ai/vm0/compare/api-v1.180.0...api-v1.181.0) (2026-06-26)


### Features

* add onboarding template params and scrollable org switcher ([#19067](https://github.com/vm0-ai/vm0/issues/19067)) ([cef7cbd](https://github.com/vm0-ai/vm0/commit/cef7cbd4f8f6af4f7e17702a09a9417c908cd8e2))
* show workflow audit metadata in actions menu ([#19058](https://github.com/vm0-ai/vm0/issues/19058)) ([a631f04](https://github.com/vm0-ai/vm0/commit/a631f049970f7de34b6f21932a4e5cda7b01f124))


### Bug Fixes

* scope computer use authorization state to host ([#19072](https://github.com/vm0-ai/vm0/issues/19072)) ([ba5240d](https://github.com/vm0-ai/vm0/commit/ba5240d98bc76ad127919f98ee2ddcbb7274c66b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.117.0
    * @vm0/connectors bumped to 1.109.1
    * @vm0/core bumped to 8.371.1
    * @vm0/db bumped to 1.74.0

## [1.180.0](https://github.com/vm0-ai/vm0/compare/api-v1.179.7...api-v1.180.0) (2026-06-26)


### Features

* add Gmail label-applied workflow trigger ([#19045](https://github.com/vm0-ai/vm0/issues/19045)) ([6565e75](https://github.com/vm0-ai/vm0/commit/6565e75562c82e907449ffb8919011d680cdfd77))


### Performance Improvements

* move resume history download to runner ([#19025](https://github.com/vm0-ai/vm0/issues/19025)) ([7296964](https://github.com/vm0-ai/vm0/commit/729696498963ef377697681f49c597fc28180e02))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.116.0
    * @vm0/connectors bumped to 1.109.0
    * @vm0/core bumped to 8.371.0
    * @vm0/db bumped to 1.73.0

## [1.179.7](https://github.com/vm0-ai/vm0/compare/api-v1.179.6...api-v1.179.7) (2026-06-26)


### Refactoring

* remove typescript firewall runtime loader ([#19027](https://github.com/vm0-ai/vm0/issues/19027)) ([a2c7b0e](https://github.com/vm0-ai/vm0/commit/a2c7b0e2cd7c484ccb13a0f85864305c086dc5af))


### Performance Improvements

* **runner:** restore ably direct candidates ([#19028](https://github.com/vm0-ai/vm0/issues/19028)) ([b148317](https://github.com/vm0-ai/vm0/commit/b1483176ef8f1cb5b29347a4b13e4effb6fce1b9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.115.4
    * @vm0/connectors bumped to 1.108.6
    * @vm0/core bumped to 8.370.9
    * @vm0/db bumped to 1.72.6

## [1.179.6](https://github.com/vm0-ai/vm0/compare/api-v1.179.5...api-v1.179.6) (2026-06-26)


### Refactoring

* remove MobileSingleLineComposer/CustomConnectorProposals switches and enable ChatRunGroupFolding ([#18995](https://github.com/vm0-ai/vm0/issues/18995)) ([1f74dc2](https://github.com/vm0-ai/vm0/commit/1f74dc21392f011239b88b3472092df4909762b4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.115.3
    * @vm0/connectors bumped to 1.108.5
    * @vm0/core bumped to 8.370.8
    * @vm0/db bumped to 1.72.5

## [1.179.5](https://github.com/vm0-ai/vm0/compare/api-v1.179.4...api-v1.179.5) (2026-06-26)


### Bug Fixes

* restore presentation deck QA flow ([#19008](https://github.com/vm0-ai/vm0/issues/19008)) ([2a137bb](https://github.com/vm0-ai/vm0/commit/2a137bb3e5849bc5d9a569ed96d62285d2add574))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.370.7
    * @vm0/db bumped to 1.72.4

## [1.179.4](https://github.com/vm0-ai/vm0/compare/api-v1.179.3...api-v1.179.4) (2026-06-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.115.2
    * @vm0/connectors bumped to 1.108.4
    * @vm0/core bumped to 8.370.6
    * @vm0/db bumped to 1.72.3

## [1.179.3](https://github.com/vm0-ai/vm0/compare/api-v1.179.2...api-v1.179.3) (2026-06-25)


### Bug Fixes

* refresh presentation template registry archives ([#18980](https://github.com/vm0-ai/vm0/issues/18980)) ([941727a](https://github.com/vm0-ai/vm0/commit/941727a14a176feb173f70c63843dafb027fe964))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.370.5
    * @vm0/db bumped to 1.72.2

## [1.179.2](https://github.com/vm0-ai/vm0/compare/api-v1.179.1...api-v1.179.2) (2026-06-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.115.1
    * @vm0/connectors bumped to 1.108.3
    * @vm0/core bumped to 8.370.4
    * @vm0/db bumped to 1.72.1

## [1.179.1](https://github.com/vm0-ai/vm0/compare/api-v1.179.0...api-v1.179.1) (2026-06-25)


### Performance Improvements

* split compose resolution timing ([#18979](https://github.com/vm0-ai/vm0/issues/18979)) ([dcfda07](https://github.com/vm0-ai/vm0/commit/dcfda07e5bc575a0752b2c08532f3b739e952491))

## [1.179.0](https://github.com/vm0-ai/vm0/compare/api-v1.178.4...api-v1.179.0) (2026-06-25)


### Features

* add workflow trigger connector access ([#18959](https://github.com/vm0-ai/vm0/issues/18959)) ([2302afb](https://github.com/vm0-ai/vm0/commit/2302afb6169ec835f3f9782c99c0573a598132b9))
* simplify workflow trigger creation ([#18951](https://github.com/vm0-ai/vm0/issues/18951)) ([48d1eab](https://github.com/vm0-ai/vm0/commit/48d1eab7f0644ec3938618c22a347105fcdfc80d))


### Bug Fixes

* normalize codex cli log rendering ([#18773](https://github.com/vm0-ai/vm0/issues/18773)) ([731975b](https://github.com/vm0-ai/vm0/commit/731975b8fa1376fbec62c86527ae87935d9a4d07))
* use figma api token header in builtin firewall ([#18953](https://github.com/vm0-ai/vm0/issues/18953)) ([81dad4e](https://github.com/vm0-ai/vm0/commit/81dad4e7685ae21c7f6a3df863934adb6d44207c))


### Performance Improvements

* optimize stored connector allowlist loading ([#18972](https://github.com/vm0-ai/vm0/issues/18972)) ([5ab6e86](https://github.com/vm0-ai/vm0/commit/5ab6e8681d0956097b515809014d5239a5f8bfaa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.115.0
    * @vm0/connectors bumped to 1.108.2
    * @vm0/core bumped to 8.370.3
    * @vm0/db bumped to 1.72.0

## [1.178.4](https://github.com/vm0-ai/vm0/compare/api-v1.178.3...api-v1.178.4) (2026-06-25)


### Performance Improvements

* add runner queue-to-claim timing ([#18940](https://github.com/vm0-ai/vm0/issues/18940)) ([ae6564c](https://github.com/vm0-ai/vm0/commit/ae6564cd58f595ec239d6f1c1f4155911ded8655))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.114.3
    * @vm0/core bumped to 8.370.2
    * @vm0/db bumped to 1.71.3

## [1.178.3](https://github.com/vm0-ai/vm0/compare/api-v1.178.2...api-v1.178.3) (2026-06-25)


### Bug Fixes

* constrain presentation template imagery ([#18938](https://github.com/vm0-ai/vm0/issues/18938)) ([75c9003](https://github.com/vm0-ai/vm0/commit/75c9003900b875b9f3f467e37840cd6a179044d1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.114.2
    * @vm0/connectors bumped to 1.108.1
    * @vm0/core bumped to 8.370.1
    * @vm0/db bumped to 1.71.2

## [1.178.2](https://github.com/vm0-ai/vm0/compare/api-v1.178.1...api-v1.178.2) (2026-06-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.114.1
    * @vm0/connectors bumped to 1.108.0
    * @vm0/core bumped to 8.370.0
    * @vm0/db bumped to 1.71.1

## [1.178.1](https://github.com/vm0-ai/vm0/compare/api-v1.178.0...api-v1.178.1) (2026-06-25)


### Performance Improvements

* **api:** split runner job queue persistence timing ([#18892](https://github.com/vm0-ai/vm0/issues/18892)) ([be15828](https://github.com/vm0-ai/vm0/commit/be1582845c5b01c96441c303956ac6b3c65d4698))

## [1.178.0](https://github.com/vm0-ai/vm0/compare/api-v1.177.2...api-v1.178.0) (2026-06-25)


### Features

* add OpenStreetMap rendering to zero maps ([#18884](https://github.com/vm0-ai/vm0/issues/18884)) ([6883357](https://github.com/vm0-ai/vm0/commit/68833575af76d583e91f73d14b2f9f8f5b8ff38a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.114.0
    * @vm0/core bumped to 8.369.1
    * @vm0/db bumped to 1.71.0

## [1.177.2](https://github.com/vm0-ai/vm0/compare/api-v1.177.1...api-v1.177.2) (2026-06-25)


### Refactoring

* remove eager firewall all-catalog ([#18871](https://github.com/vm0-ai/vm0/issues/18871)) ([76893cf](https://github.com/vm0-ai/vm0/commit/76893cf76433d5e241934faf1c6c7e54987afc10))


### Performance Improvements

* add pre-create dispatch timing ([#18883](https://github.com/vm0-ai/vm0/issues/18883)) ([b86c8f6](https://github.com/vm0-ai/vm0/commit/b86c8f68774a2ed1a5a517a1b42bb1daab8baf6f))
* split prepare run context timing ([#18854](https://github.com/vm0-ai/vm0/issues/18854)) ([e872ad3](https://github.com/vm0-ai/vm0/commit/e872ad37e35e700b3228b2e9173981135bada39e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.113.3
    * @vm0/connectors bumped to 1.107.1
    * @vm0/core bumped to 8.369.0
    * @vm0/db bumped to 1.70.3

## [1.177.1](https://github.com/vm0-ai/vm0/compare/api-v1.177.0...api-v1.177.1) (2026-06-25)


### Bug Fixes

* require model usage provider for model observations ([#18800](https://github.com/vm0-ai/vm0/issues/18800)) ([92609b6](https://github.com/vm0-ai/vm0/commit/92609b62d6073d8c9c93167dac68c02f508df150))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.113.2
    * @vm0/core bumped to 8.368.2
    * @vm0/db bumped to 1.70.2

## [1.177.0](https://github.com/vm0-ai/vm0/compare/api-v1.176.0...api-v1.177.0) (2026-06-24)


### Features

* **triggers:** trigger-aware permission-change link + blocked-run feedback ([#18839](https://github.com/vm0-ai/vm0/issues/18839)) ([0c523b2](https://github.com/vm0-ai/vm0/commit/0c523b20a11c5d3a8866cd4df3989c323336cea0))


### Bug Fixes

* update run group fold copy ([#18830](https://github.com/vm0-ai/vm0/issues/18830)) ([b49fe6b](https://github.com/vm0-ai/vm0/commit/b49fe6ba5851b0849acd51acb2bc7f44b5d40977))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.113.1
    * @vm0/core bumped to 8.368.1
    * @vm0/db bumped to 1.70.1

## [1.176.0](https://github.com/vm0-ai/vm0/compare/api-v1.175.1...api-v1.176.0) (2026-06-24)


### Features

* add delegated computer use authorization ([#18824](https://github.com/vm0-ai/vm0/issues/18824)) ([33b0547](https://github.com/vm0-ai/vm0/commit/33b05471b244b51f94dee5b9404eebc8707211d6))
* **triggers:** add session-gated route to set unattended permission policy ([#18819](https://github.com/vm0-ai/vm0/issues/18819)) ([26cd67e](https://github.com/vm0-ai/vm0/commit/26cd67ef4a04577178f51653167320caa673a0dc))
* **triggers:** add unattendedPermissionPolicy column and contract type ([#18806](https://github.com/vm0-ai/vm0/issues/18806)) ([e452d86](https://github.com/vm0-ai/vm0/commit/e452d8677c93183c64d5139dca0a8c7d72e09c56))


### Performance Improvements

* add api dispatch timing telemetry ([#18816](https://github.com/vm0-ai/vm0/issues/18816)) ([03237da](https://github.com/vm0-ai/vm0/commit/03237da88a861b159808f2b080ac031786956ba5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.113.0
    * @vm0/connectors bumped to 1.107.0
    * @vm0/core bumped to 8.368.0
    * @vm0/db bumped to 1.70.0

## [1.175.1](https://github.com/vm0-ai/vm0/compare/api-v1.175.0...api-v1.175.1) (2026-06-24)


### Bug Fixes

* polish archived goal chat folds ([#18786](https://github.com/vm0-ai/vm0/issues/18786)) ([b6cff9b](https://github.com/vm0-ai/vm0/commit/b6cff9b45b86976a5f3aeae62da06047a0255342))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.112.3
    * @vm0/core bumped to 8.367.1
    * @vm0/db bumped to 1.69.3

## [1.175.0](https://github.com/vm0-ai/vm0/compare/api-v1.174.1...api-v1.175.0) (2026-06-24)


### Features

* add presentation R2 template resources ([#18792](https://github.com/vm0-ai/vm0/issues/18792)) ([9907b5e](https://github.com/vm0-ai/vm0/commit/9907b5ee9c8f8101156f359ffe4e8dc89cddfa3a))


### Bug Fixes

* align storage hash sort with javascript ([#18783](https://github.com/vm0-ai/vm0/issues/18783)) ([1864d86](https://github.com/vm0-ai/vm0/commit/1864d86dd39340fab24b85855ea659fe61597b59))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.112.2
    * @vm0/connectors bumped to 1.106.1
    * @vm0/core bumped to 8.367.0
    * @vm0/db bumped to 1.69.2

## [1.174.1](https://github.com/vm0-ai/vm0/compare/api-v1.174.0...api-v1.174.1) (2026-06-24)


### Refactoring

* narrow gmail workflow trigger match fields ([#18778](https://github.com/vm0-ai/vm0/issues/18778)) ([421e930](https://github.com/vm0-ai/vm0/commit/421e930e0ca9dc79b70d46402a8eea6598eea92c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.112.1
    * @vm0/core bumped to 8.366.1
    * @vm0/db bumped to 1.69.1

## [1.174.0](https://github.com/vm0-ai/vm0/compare/api-v1.173.2...api-v1.174.0) (2026-06-24)


### Features

* fold chat runs by run group ([#18754](https://github.com/vm0-ai/vm0/issues/18754)) ([c28ffbc](https://github.com/vm0-ai/vm0/commit/c28ffbca17de6fa9f62a8403f9886657084d2677))


### Bug Fixes

* enforce public workflow slug uniqueness ([#18756](https://github.com/vm0-ai/vm0/issues/18756)) ([b2e099e](https://github.com/vm0-ai/vm0/commit/b2e099e0ede62155fe6a58c50b3df7a3935bd829))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.112.0
    * @vm0/connectors bumped to 1.106.0
    * @vm0/core bumped to 8.366.0
    * @vm0/db bumped to 1.69.0

## [1.173.2](https://github.com/vm0-ai/vm0/compare/api-v1.173.1...api-v1.173.2) (2026-06-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.111.2
    * @vm0/connectors bumped to 1.105.4
    * @vm0/core bumped to 8.365.4
    * @vm0/db bumped to 1.68.2

## [1.173.1](https://github.com/vm0-ai/vm0/compare/api-v1.173.0...api-v1.173.1) (2026-06-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.111.1
    * @vm0/connectors bumped to 1.105.3
    * @vm0/core bumped to 8.365.3
    * @vm0/db bumped to 1.68.1

## [1.173.0](https://github.com/vm0-ai/vm0/compare/api-v1.172.1...api-v1.173.0) (2026-06-23)


### Features

* add OpenRouter MiMo and Hy3 models ([#18706](https://github.com/vm0-ai/vm0/issues/18706)) ([6e5137c](https://github.com/vm0-ai/vm0/commit/6e5137c5a77e544afd6fb86d5fe89df623030b69))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.111.0
    * @vm0/connectors bumped to 1.105.2
    * @vm0/core bumped to 8.365.2
    * @vm0/db bumped to 1.68.0

## [1.172.1](https://github.com/vm0-ai/vm0/compare/api-v1.172.0...api-v1.172.1) (2026-06-23)


### Bug Fixes

* deduplicate Slack firewall route owners ([#18675](https://github.com/vm0-ai/vm0/issues/18675)) ([fdccc38](https://github.com/vm0-ai/vm0/commit/fdccc38bbd5b6cacac21926e233dec8f649e087b))


### Refactoring

* decouple workflow triggers from automation api ([#18695](https://github.com/vm0-ai/vm0/issues/18695)) ([39ca57a](https://github.com/vm0-ai/vm0/commit/39ca57a33caea773aeba1eca4d243cadaf10fae1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.110.1
    * @vm0/connectors bumped to 1.105.1
    * @vm0/core bumped to 8.365.1
    * @vm0/db bumped to 1.67.1

## [1.172.0](https://github.com/vm0-ai/vm0/compare/api-v1.171.2...api-v1.172.0) (2026-06-23)


### Features

* add custom connector proposal flow ([#18654](https://github.com/vm0-ai/vm0/issues/18654)) ([211c963](https://github.com/vm0-ai/vm0/commit/211c9637b01ffa1764928d83cf5e079c5232a4db))


### Bug Fixes

* avoid rescheduling disabled automation triggers ([#18644](https://github.com/vm0-ai/vm0/issues/18644)) ([8b99d8d](https://github.com/vm0-ai/vm0/commit/8b99d8d9352570f5a07673b96158e03d796eddc6))
* show goal briefs in continuation chat ([#18655](https://github.com/vm0-ai/vm0/issues/18655)) ([7db27d0](https://github.com/vm0-ai/vm0/commit/7db27d0d0f610d4f92bcce52f6ad8c78314f122e))


### Refactoring

* remove automation multi trigger ([#18668](https://github.com/vm0-ai/vm0/issues/18668)) ([95ef04f](https://github.com/vm0-ai/vm0/commit/95ef04fa79b65821d26fb8b74525c5b954caaa7c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.110.0
    * @vm0/connectors bumped to 1.105.0
    * @vm0/core bumped to 8.365.0
    * @vm0/db bumped to 1.67.0

## [1.171.2](https://github.com/vm0-ai/vm0/compare/api-v1.171.1...api-v1.171.2) (2026-06-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.109.3
    * @vm0/connectors bumped to 1.104.3
    * @vm0/core bumped to 8.364.3
    * @vm0/db bumped to 1.66.3

## [1.171.1](https://github.com/vm0-ai/vm0/compare/api-v1.171.0...api-v1.171.1) (2026-06-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.109.2
    * @vm0/connectors bumped to 1.104.2
    * @vm0/core bumped to 8.364.2
    * @vm0/db bumped to 1.66.2

## [1.171.0](https://github.com/vm0-ai/vm0/compare/api-v1.170.0...api-v1.171.0) (2026-06-23)


### Features

* add chat thread dev benchmark seed ([#18608](https://github.com/vm0-ai/vm0/issues/18608)) ([24ca7d1](https://github.com/vm0-ai/vm0/commit/24ca7d1ef5ee0fbb60b822091a969807a5b3a66a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.109.1
    * @vm0/connectors bumped to 1.104.1
    * @vm0/core bumped to 8.364.1
    * @vm0/db bumped to 1.66.1

## [1.170.0](https://github.com/vm0-ai/vm0/compare/api-v1.169.0...api-v1.170.0) (2026-06-23)


### Features

* add Gmail new message workflow trigger ([#18591](https://github.com/vm0-ai/vm0/issues/18591)) ([3ce1cb5](https://github.com/vm0-ai/vm0/commit/3ce1cb525fb8c01e81513383789e40646ed81c0b))


### Refactoring

* remove automation webhook triggers ([#18563](https://github.com/vm0-ai/vm0/issues/18563)) ([b4e8e96](https://github.com/vm0-ai/vm0/commit/b4e8e9640e7922c7ea2969c36584d719ecddd196))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.109.0
    * @vm0/connectors bumped to 1.104.0
    * @vm0/core bumped to 8.364.0
    * @vm0/db bumped to 1.66.0

## [1.169.0](https://github.com/vm0-ai/vm0/compare/api-v1.168.3...api-v1.169.0) (2026-06-22)


### Features

* enable computer use by default ([#18521](https://github.com/vm0-ai/vm0/issues/18521)) ([317e825](https://github.com/vm0-ai/vm0/commit/317e8253c92e0f4afc8733f508ee985ee87a1586))


### Bug Fixes

* respect timezone for once trigger atTime ([#18514](https://github.com/vm0-ai/vm0/issues/18514)) ([823fd8d](https://github.com/vm0-ai/vm0/commit/823fd8dfcdc3d552c5d9ec2874da587911b6c4e2))
* update presentation R2 deck archives ([#18531](https://github.com/vm0-ai/vm0/issues/18531)) ([eeb8699](https://github.com/vm0-ai/vm0/commit/eeb86999675c9989cd8a59c1fd84ebb9f6d9495f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.108.4
    * @vm0/connectors bumped to 1.103.0
    * @vm0/core bumped to 8.363.0
    * @vm0/db bumped to 1.65.0

## [1.168.3](https://github.com/vm0-ai/vm0/compare/api-v1.168.2...api-v1.168.3) (2026-06-22)


### Bug Fixes

* show goal objective briefs in markers ([#18530](https://github.com/vm0-ai/vm0/issues/18530)) ([dc3c7e7](https://github.com/vm0-ai/vm0/commit/dc3c7e7aa378268b576cfd514e1cea7bd81021ea))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.108.3
    * @vm0/connectors bumped to 1.102.0
    * @vm0/core bumped to 8.362.5
    * @vm0/db bumped to 1.64.0

## [1.168.2](https://github.com/vm0-ai/vm0/compare/api-v1.168.1...api-v1.168.2) (2026-06-22)


### Refactoring

* isolate all-catalog firewall entrypoint ([#18497](https://github.com/vm0-ai/vm0/issues/18497)) ([8052c51](https://github.com/vm0-ai/vm0/commit/8052c5108e52e9451c64df54e789b49f5121411b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.108.2
    * @vm0/connectors bumped to 1.101.0
    * @vm0/core bumped to 8.362.4
    * @vm0/db bumped to 1.63.0

## [1.168.1](https://github.com/vm0-ai/vm0/compare/api-v1.168.0...api-v1.168.1) (2026-06-22)


### Bug Fixes

* **goal:** drop sandbox-fresh note from continuation prompt ([#18438](https://github.com/vm0-ai/vm0/issues/18438)) ([321fe60](https://github.com/vm0-ai/vm0/commit/321fe605f6affa6f87975448a9aa21cb50a422c2))


### Refactoring

* fold firewall execution metadata into server metadata ([#18472](https://github.com/vm0-ai/vm0/issues/18472)) ([f86f3e1](https://github.com/vm0-ai/vm0/commit/f86f3e17e5ab5e6e06f3625ebbdee6c4e2bce65e))
* remove computer use command approval flow ([#18481](https://github.com/vm0-ai/vm0/issues/18481)) ([12d4897](https://github.com/vm0-ai/vm0/commit/12d48973b4926c6f2be676667db3ad0c4bc300f8))
* unify user permission grant write api ([#18469](https://github.com/vm0-ai/vm0/issues/18469)) ([17d02f7](https://github.com/vm0-ai/vm0/commit/17d02f7f5b9256e12623037907d812a3c00fc995))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.108.1
    * @vm0/connectors bumped to 1.100.0
    * @vm0/core bumped to 8.362.3
    * @vm0/db bumped to 1.62.0

## [1.168.0](https://github.com/vm0-ai/vm0/compare/api-v1.167.1...api-v1.168.0) (2026-06-22)


### Features

* add computer use automation preflight ([#18445](https://github.com/vm0-ai/vm0/issues/18445)) ([874ba1a](https://github.com/vm0-ai/vm0/commit/874ba1a8290ae71c305634af32e4f6c252b6b255))


### Refactoring

* agent-scoped workflow ownership and management (1:N redesign) ([#18436](https://github.com/vm0-ai/vm0/issues/18436)) ([9275df5](https://github.com/vm0-ai/vm0/commit/9275df501a6908443d913284da05703768e778d6))
* remove delivered connector feature switches ([#18453](https://github.com/vm0-ai/vm0/issues/18453)) ([d970411](https://github.com/vm0-ai/vm0/commit/d97041194d7e53981248ca24abd1037785f2524c))


### Performance Improvements

* avoid eager firewall catalogs in run creation ([#18446](https://github.com/vm0-ai/vm0/issues/18446)) ([c868355](https://github.com/vm0-ai/vm0/commit/c8683557c945d86a91057afbaa105e4afd80cf6f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.108.0
    * @vm0/connectors bumped to 1.99.0
    * @vm0/core bumped to 8.362.2
    * @vm0/db bumped to 1.61.0

## [1.167.1](https://github.com/vm0-ai/vm0/compare/api-v1.167.0...api-v1.167.1) (2026-06-21)


### Performance Improvements

* remove metadata-only runtime firewall imports ([#18406](https://github.com/vm0-ai/vm0/issues/18406)) ([521a295](https://github.com/vm0-ai/vm0/commit/521a295b45906b164a0eb7cc01d4c2bc6be4dfc8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.107.1
    * @vm0/connectors bumped to 1.98.1
    * @vm0/core bumped to 8.362.1
    * @vm0/db bumped to 1.60.1

## [1.167.0](https://github.com/vm0-ai/vm0/compare/api-v1.166.0...api-v1.167.0) (2026-06-21)


### Features

* add goal objective editing, stop reasons, and creation guard ([#18408](https://github.com/vm0-ai/vm0/issues/18408)) ([a942723](https://github.com/vm0-ai/vm0/commit/a942723f5640a4019cd710935432e658d582b213))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.107.0
    * @vm0/connectors bumped to 1.98.0
    * @vm0/core bumped to 8.362.0
    * @vm0/db bumped to 1.60.0

## [1.166.0](https://github.com/vm0-ai/vm0/compare/api-v1.165.1...api-v1.166.0) (2026-06-20)


### Features

* gate goal seed skill on GoalWorkflows and disable built-in goal ([#18394](https://github.com/vm0-ai/vm0/issues/18394)) ([4340dc7](https://github.com/vm0-ai/vm0/commit/4340dc7842f1a3505c116053dd7be6829199aca8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.361.0

## [1.165.1](https://github.com/vm0-ai/vm0/compare/api-v1.165.0...api-v1.165.1) (2026-06-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.106.2
    * @vm0/connectors bumped to 1.97.0
    * @vm0/core bumped to 8.360.1
    * @vm0/db bumped to 1.59.4

## [1.165.0](https://github.com/vm0-ai/vm0/compare/api-v1.164.1...api-v1.165.0) (2026-06-20)


### Features

* gate goal-triggered PWA pushes to terminal goal states ([#18383](https://github.com/vm0-ai/vm0/issues/18383)) ([91a4bdf](https://github.com/vm0-ai/vm0/commit/91a4bdfd37ec8fce5fba04af500093a8748b48f9))

## [1.164.1](https://github.com/vm0-ai/vm0/compare/api-v1.164.0...api-v1.164.1) (2026-06-20)


### Bug Fixes

* correct cli logs pagination cursors ([#18340](https://github.com/vm0-ai/vm0/issues/18340)) ([8c49dc6](https://github.com/vm0-ai/vm0/commit/8c49dc6e6fb5303a71443bfc02309a49abfbc20a))


### Refactoring

* remove delivered ChatInlineFeedback and StripeConnector feature switches ([#18376](https://github.com/vm0-ai/vm0/issues/18376)) ([9638b06](https://github.com/vm0-ai/vm0/commit/9638b064b169a9df8a7368d5c5978fb2369fa0be))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.106.1
    * @vm0/connectors bumped to 1.96.0
    * @vm0/core bumped to 8.360.0
    * @vm0/db bumped to 1.59.3

## [1.164.0](https://github.com/vm0-ai/vm0/compare/api-v1.163.0...api-v1.164.0) (2026-06-20)


### Features

* surface a thread's active goal above the composer via folded goal-state messages ([#18361](https://github.com/vm0-ai/vm0/issues/18361)) ([df15d7b](https://github.com/vm0-ai/vm0/commit/df15d7be20c072770f8cc0fd589d66766d47cd2c))

## [1.163.0](https://github.com/vm0-ai/vm0/compare/api-v1.162.1...api-v1.163.0) (2026-06-20)


### Features

* add connector-scoped permission grant apply ([#18347](https://github.com/vm0-ai/vm0/issues/18347)) ([14018d1](https://github.com/vm0-ai/vm0/commit/14018d16fe4265e659b87c82e2d3584942a0ce34))
* chat-thread workflow triggers in the automations list and sidebar ([#18346](https://github.com/vm0-ai/vm0/issues/18346)) ([c096ad4](https://github.com/vm0-ai/vm0/commit/c096ad4c70536b617321de0fe6ef56ef6443c059))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.106.0
    * @vm0/core bumped to 8.359.2
    * @vm0/db bumped to 1.59.2

## [1.162.1](https://github.com/vm0-ai/vm0/compare/api-v1.162.0...api-v1.162.1) (2026-06-19)


### Bug Fixes

* **api:** harden network log reads ([#18339](https://github.com/vm0-ai/vm0/issues/18339)) ([7a05a59](https://github.com/vm0-ai/vm0/commit/7a05a597902f628b02871eaf51d0837ae7ec4a05))
* enforce one active goal per chat thread ([#18351](https://github.com/vm0-ai/vm0/issues/18351)) ([b477c39](https://github.com/vm0-ai/vm0/commit/b477c391b5da1af0d20042d80e7d1020b84cd588))
* restore stripe cli device auth ([#18336](https://github.com/vm0-ai/vm0/issues/18336)) ([fe7ad84](https://github.com/vm0-ai/vm0/commit/fe7ad84a8ca9aa1918f39c6c986bdb4ca1d47df5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.105.1
    * @vm0/connectors bumped to 1.95.1
    * @vm0/core bumped to 8.359.1
    * @vm0/db bumped to 1.59.1

## [1.162.0](https://github.com/vm0-ai/vm0/compare/api-v1.161.0...api-v1.162.0) (2026-06-19)


### Features

* show goal workflows in the workflow list ([#18341](https://github.com/vm0-ai/vm0/issues/18341)) ([02c474a](https://github.com/vm0-ai/vm0/commit/02c474adf96be6b28e41317c14274baefaf32b12))


### Bug Fixes

* stop stamping http.route onto pg client spans ([#18348](https://github.com/vm0-ai/vm0/issues/18348)) ([024b990](https://github.com/vm0-ai/vm0/commit/024b990b75098f8bf74cae0aa4e5bdaa24654d22))

## [1.161.0](https://github.com/vm0-ai/vm0/compare/api-v1.160.0...api-v1.161.0) (2026-06-19)


### Features

* drive goal continuation from a rendered prompt and provision a thread for thread-less runs ([#18337](https://github.com/vm0-ai/vm0/issues/18337)) ([80658ce](https://github.com/vm0-ai/vm0/commit/80658cec994aa96a915b54f26e443560e08934a9))


### Bug Fixes

* harden firewall permission insight aggregation ([#18335](https://github.com/vm0-ai/vm0/issues/18335)) ([85ae73c](https://github.com/vm0-ai/vm0/commit/85ae73c6186426893960beb170fc5c266428a798))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.359.0

## [1.160.0](https://github.com/vm0-ai/vm0/compare/api-v1.159.0...api-v1.160.0) (2026-06-19)


### Features

* add goal workflows continuation ([#18328](https://github.com/vm0-ai/vm0/issues/18328)) ([969d660](https://github.com/vm0-ai/vm0/commit/969d66023b20059ab874d08c1e293be87641d5ab))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.105.0
    * @vm0/connectors bumped to 1.95.0
    * @vm0/core bumped to 8.358.0
    * @vm0/db bumped to 1.59.0

## [1.159.0](https://github.com/vm0-ai/vm0/compare/api-v1.158.0...api-v1.159.0) (2026-06-19)


### Features

* restore stripe api-token connector auth method ([#18316](https://github.com/vm0-ai/vm0/issues/18316)) ([9a47ef4](https://github.com/vm0-ai/vm0/commit/9a47ef481d4f6a63706986ae60c014a05ecdc4df))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.104.1
    * @vm0/connectors bumped to 1.94.0
    * @vm0/core bumped to 8.357.1
    * @vm0/db bumped to 1.58.1

## [1.158.0](https://github.com/vm0-ai/vm0/compare/api-v1.157.0...api-v1.158.0) (2026-06-18)


### Features

* add workflow schedule trigger management surface and test run ([#18311](https://github.com/vm0-ai/vm0/issues/18311)) ([2af4f58](https://github.com/vm0-ai/vm0/commit/2af4f58e0c9ac33167d8eb2b3c7acd7df4b71902)), closes [#18258](https://github.com/vm0-ai/vm0/issues/18258)
* **api:** add workflow schedule trigger persistence and management endpoints ([#18272](https://github.com/vm0-ai/vm0/issues/18272)) ([7e86c2d](https://github.com/vm0-ai/vm0/commit/7e86c2db0526fac21abc6704371406bb56ad7e32))
* **api:** add workflow schedule trigger scheduler and execution ([#18297](https://github.com/vm0-ai/vm0/issues/18297)) ([f1275d0](https://github.com/vm0-ai/vm0/commit/f1275d0fb851ba2a73c4439fbd357b8fc2b11567)), closes [#18257](https://github.com/vm0-ai/vm0/issues/18257)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.104.0
    * @vm0/core bumped to 8.357.0
    * @vm0/db bumped to 1.58.0

## [1.157.0](https://github.com/vm0-ai/vm0/compare/api-v1.156.0...api-v1.157.0) (2026-06-18)


### Features

* add QuickBooks OAuth connector ([#18273](https://github.com/vm0-ai/vm0/issues/18273)) ([6f4aa42](https://github.com/vm0-ai/vm0/commit/6f4aa424c5311f4a36326ec81279dbd937d366e6))
* silently cache chat history ([#18300](https://github.com/vm0-ai/vm0/issues/18300)) ([85fa183](https://github.com/vm0-ai/vm0/commit/85fa18391d12438d886cbe4356a572de36f159a6))
* use stripe connector oauth ([#18249](https://github.com/vm0-ai/vm0/issues/18249)) ([3045308](https://github.com/vm0-ai/vm0/commit/3045308f5672939067b6689b1bcfb7d491055d47))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.103.0
    * @vm0/connectors bumped to 1.93.0
    * @vm0/core bumped to 8.356.0
    * @vm0/db bumped to 1.57.4

## [1.156.0](https://github.com/vm0-ai/vm0/compare/api-v1.155.1...api-v1.156.0) (2026-06-18)


### Features

* **connectors:** give InsForge a firewall with user-entered backend URL ([#18229](https://github.com/vm0-ai/vm0/issues/18229)) ([e1f702c](https://github.com/vm0-ai/vm0/commit/e1f702cb7000fa9290fcb5812cec2df76f886b85))


### Bug Fixes

* use figma pat firewall header ([#18266](https://github.com/vm0-ai/vm0/issues/18266)) ([f86838c](https://github.com/vm0-ai/vm0/commit/f86838c9e1aa3bef21ebe0f97689de0695c829a0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.102.3
    * @vm0/connectors bumped to 1.92.0
    * @vm0/core bumped to 8.355.1
    * @vm0/db bumped to 1.57.3

## [1.155.1](https://github.com/vm0-ai/vm0/compare/api-v1.155.0...api-v1.155.1) (2026-06-18)


### Refactoring

* clarify agent and cli session ids ([#18232](https://github.com/vm0-ai/vm0/issues/18232)) ([18fa8d6](https://github.com/vm0-ai/vm0/commit/18fa8d6e5740b7121b3985a19b5082a637f9d39b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.102.2
    * @vm0/connectors bumped to 1.91.0
    * @vm0/core bumped to 8.355.0
    * @vm0/db bumped to 1.57.2

## [1.155.0](https://github.com/vm0-ai/vm0/compare/api-v1.154.0...api-v1.155.0) (2026-06-18)


### Features

* register nocturne and neo-brutalism presentation resources ([#18209](https://github.com/vm0-ai/vm0/issues/18209)) ([5b76751](https://github.com/vm0-ai/vm0/commit/5b767515121b00104f45a81ecbd145c672e2ee3e))


### Bug Fixes

* support local onboarding proxy and usage popover ([#18212](https://github.com/vm0-ai/vm0/issues/18212)) ([b89ff82](https://github.com/vm0-ai/vm0/commit/b89ff82824347365a4244dcd646048294a97762b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.102.1
    * @vm0/connectors bumped to 1.90.0
    * @vm0/core bumped to 8.354.0
    * @vm0/db bumped to 1.57.1

## [1.154.0](https://github.com/vm0-ai/vm0/compare/api-v1.153.0...api-v1.154.0) (2026-06-18)


### Features

* add agent chat draft persistence ([#18181](https://github.com/vm0-ai/vm0/issues/18181)) ([98ac2e3](https://github.com/vm0-ai/vm0/commit/98ac2e36e56725ca8b620d30782057973d2d03da))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.102.0
    * @vm0/connectors bumped to 1.89.0
    * @vm0/core bumped to 8.353.0
    * @vm0/db bumped to 1.57.0

## [1.153.0](https://github.com/vm0-ai/vm0/compare/api-v1.152.3...api-v1.153.0) (2026-06-18)


### Features

* add presentation template theme previews ([#18049](https://github.com/vm0-ai/vm0/issues/18049)) ([ae67bb4](https://github.com/vm0-ai/vm0/commit/ae67bb4bf811e8c07d2ae7df8f95afd7b7e4242d))


### Bug Fixes

* clarify video template prompt guidance ([#18167](https://github.com/vm0-ai/vm0/issues/18167)) ([de0fa42](https://github.com/vm0-ai/vm0/commit/de0fa4285d3b931115fcf79639419ee205cb470e))
* recover from computer use completion conflicts ([#18173](https://github.com/vm0-ai/vm0/issues/18173)) ([2accc05](https://github.com/vm0-ai/vm0/commit/2accc05ae5901d55edc70357c12bc56b94533bb5))


### Refactoring

* remove legacy internal callback URL fallback ([#18172](https://github.com/vm0-ai/vm0/issues/18172)) ([3ef9198](https://github.com/vm0-ai/vm0/commit/3ef9198aedbeb014959440e0dffb284bc4eaf87a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.101.0
    * @vm0/connectors bumped to 1.88.0
    * @vm0/core bumped to 8.352.0
    * @vm0/db bumped to 1.56.0

## [1.152.3](https://github.com/vm0-ai/vm0/compare/api-v1.152.2...api-v1.152.3) (2026-06-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.100.3
    * @vm0/connectors bumped to 1.87.1
    * @vm0/core bumped to 8.351.2
    * @vm0/db bumped to 1.55.3

## [1.152.2](https://github.com/vm0-ai/vm0/compare/api-v1.152.1...api-v1.152.2) (2026-06-18)


### Bug Fixes

* guard workflow storage object deletion ([#18144](https://github.com/vm0-ai/vm0/issues/18144)) ([6842ee9](https://github.com/vm0-ai/vm0/commit/6842ee91b7d7ad31c4574d23bc046669530f89cd))

## [1.152.1](https://github.com/vm0-ai/vm0/compare/api-v1.152.0...api-v1.152.1) (2026-06-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.100.2
    * @vm0/connectors bumped to 1.87.0
    * @vm0/core bumped to 8.351.1
    * @vm0/db bumped to 1.55.2

## [1.152.0](https://github.com/vm0-ai/vm0/compare/api-v1.151.1...api-v1.152.0) (2026-06-18)


### Features

* add batch presentation R2 templates ([#18106](https://github.com/vm0-ai/vm0/issues/18106)) ([aac1ca9](https://github.com/vm0-ai/vm0/commit/aac1ca9a4794a2bb8a378de195aa5d38cf1d5306))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.351.0

## [1.151.1](https://github.com/vm0-ai/vm0/compare/api-v1.151.0...api-v1.151.1) (2026-06-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.100.1
    * @vm0/connectors bumped to 1.86.0
    * @vm0/core bumped to 8.350.1
    * @vm0/db bumped to 1.55.1

## [1.151.0](https://github.com/vm0-ai/vm0/compare/api-v1.150.0...api-v1.151.0) (2026-06-17)


### Features

* rename zero skills to workflows ([#18099](https://github.com/vm0-ai/vm0/issues/18099)) ([c38a8fa](https://github.com/vm0-ai/vm0/commit/c38a8faaf091ea9950afdc344c7fb9701d502576))


### Refactoring

* remove stale feature switches and dead code ([#18090](https://github.com/vm0-ai/vm0/issues/18090)) ([9406838](https://github.com/vm0-ai/vm0/commit/940683865a2256f83b2d92d36cf102e0fb06e131))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.100.0
    * @vm0/connectors bumped to 1.85.0
    * @vm0/core bumped to 8.350.0
    * @vm0/db bumped to 1.55.0

## [1.150.0](https://github.com/vm0-ai/vm0/compare/api-v1.149.1...api-v1.150.0) (2026-06-17)


### Features

* pull presentation resources from private r2 archives ([#18036](https://github.com/vm0-ai/vm0/issues/18036)) ([542cbfe](https://github.com/vm0-ai/vm0/commit/542cbfe151f42c06bde02d8dcbf3c35d2bc7b41a))


### Bug Fixes

* keep desktop computer-use host stable across restarts ([#18097](https://github.com/vm0-ai/vm0/issues/18097)) ([48c3d73](https://github.com/vm0-ai/vm0/commit/48c3d735708424d7e4e0cc062cac6178c72813f2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.99.0
    * @vm0/connectors bumped to 1.84.1
    * @vm0/core bumped to 8.349.0
    * @vm0/db bumped to 1.54.2

## [1.149.1](https://github.com/vm0-ai/vm0/compare/api-v1.149.0...api-v1.149.1) (2026-06-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.98.1
    * @vm0/core bumped to 8.348.1
    * @vm0/db bumped to 1.54.1

## [1.149.0](https://github.com/vm0-ai/vm0/compare/api-v1.148.4...api-v1.149.0) (2026-06-17)


### Features

* add GLM 5.2 model support ([#18012](https://github.com/vm0-ai/vm0/issues/18012)) ([f39a67f](https://github.com/vm0-ai/vm0/commit/f39a67f88e52bdbd406765d9cb8953dcf9952692))


### Bug Fixes

* stabilize model stats ranking windows ([#18031](https://github.com/vm0-ai/vm0/issues/18031)) ([aa5fea9](https://github.com/vm0-ai/vm0/commit/aa5fea98003a18ae41278643e0847a864891d6ba))


### Refactoring

* align model stats cron route ([#18037](https://github.com/vm0-ai/vm0/issues/18037)) ([6bc9c96](https://github.com/vm0-ai/vm0/commit/6bc9c96d3f323aeae05b43bb526aaade032f2459))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.98.0
    * @vm0/core bumped to 8.348.0
    * @vm0/db bumped to 1.54.0

## [1.148.4](https://github.com/vm0-ai/vm0/compare/api-v1.148.3...api-v1.148.4) (2026-06-17)


### Bug Fixes

* rename playful launch presentation template ([#18005](https://github.com/vm0-ai/vm0/issues/18005)) ([5bc2161](https://github.com/vm0-ai/vm0/commit/5bc2161ea257f194e16c2eae85c0d824eeaa02ea))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.347.2

## [1.148.3](https://github.com/vm0-ai/vm0/compare/api-v1.148.2...api-v1.148.3) (2026-06-17)


### Refactoring

* dispatch agentphone typing in process ([#18011](https://github.com/vm0-ai/vm0/issues/18011)) ([f46b208](https://github.com/vm0-ai/vm0/commit/f46b2085e1ec9e6ba04caea9e8e3098a6f052e86))
* dispatch telegram typing in process ([#18006](https://github.com/vm0-ai/vm0/issues/18006)) ([9819d08](https://github.com/vm0-ai/vm0/commit/9819d08c68f2232ccecca5addb86e0fb2efbb1ef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.97.6
    * @vm0/core bumped to 8.347.1
    * @vm0/db bumped to 1.53.6

## [1.148.2](https://github.com/vm0-ai/vm0/compare/api-v1.148.1...api-v1.148.2) (2026-06-17)


### Refactoring

* remove axiom event consumer route ([#17995](https://github.com/vm0-ai/vm0/issues/17995)) ([3adefcb](https://github.com/vm0-ai/vm0/commit/3adefcbfff017182412ad5d90dd1f74984bd778d))
* remove chat assistant event consumer route ([#18003](https://github.com/vm0-ai/vm0/issues/18003)) ([e0528cf](https://github.com/vm0-ai/vm0/commit/e0528cf21bc248c3c1be2fc6ea1d15fe2a1f4a66))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.97.5
    * @vm0/connectors bumped to 1.84.0
    * @vm0/core bumped to 8.347.0
    * @vm0/db bumped to 1.53.5

## [1.148.1](https://github.com/vm0-ai/vm0/compare/api-v1.148.0...api-v1.148.1) (2026-06-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.97.4
    * @vm0/core bumped to 8.346.1
    * @vm0/db bumped to 1.53.4

## [1.148.0](https://github.com/vm0-ai/vm0/compare/api-v1.147.3...api-v1.148.0) (2026-06-16)


### Features

* register playful editorial presentation template ([#17919](https://github.com/vm0-ai/vm0/issues/17919)) ([c967214](https://github.com/vm0-ai/vm0/commit/c967214afe7108fea84d31c64a846b54a6fefc45))


### Bug Fixes

* update hono for security advisories ([#17945](https://github.com/vm0-ai/vm0/issues/17945)) ([3889c43](https://github.com/vm0-ai/vm0/commit/3889c43b0dc589741da44f891777de665671bc04))
* upgrade hono to patched release ([#17948](https://github.com/vm0-ai/vm0/issues/17948)) ([77f4146](https://github.com/vm0-ai/vm0/commit/77f4146334036b1dc80c1db523a1064e8980334b))


### Refactoring

* dispatch agentphone callbacks through ccstate ([#17940](https://github.com/vm0-ai/vm0/issues/17940)) ([630462b](https://github.com/vm0-ai/vm0/commit/630462ba5cfa195151f8551297c18a187a0178f8))
* dispatch chat callbacks through ccstate ([#17942](https://github.com/vm0-ai/vm0/issues/17942)) ([719aa89](https://github.com/vm0-ai/vm0/commit/719aa89a8d51800681beb26bb420a6585b4e8da8))
* dispatch telegram callbacks through ccstate ([#17937](https://github.com/vm0-ai/vm0/issues/17937)) ([8fa4a28](https://github.com/vm0-ai/vm0/commit/8fa4a28ec363eb6ada0a69d3a1c76ff920936751))
* remove agent internal callback route ([#17944](https://github.com/vm0-ai/vm0/issues/17944)) ([1b01189](https://github.com/vm0-ai/vm0/commit/1b0118943e5a9eadb3934b330f97955e4124df4c))
* remove agentphone internal callback route ([#17953](https://github.com/vm0-ai/vm0/issues/17953)) ([6448beb](https://github.com/vm0-ai/vm0/commit/6448beb15244e62f896bf439d8f4f7f93807bdb9))
* remove chat internal callback route ([#17950](https://github.com/vm0-ai/vm0/issues/17950)) ([61fa5e2](https://github.com/vm0-ai/vm0/commit/61fa5e23a6068b81dcae82c7c0e2c138442f4bab))
* remove cron trigger internal callback route ([#17961](https://github.com/vm0-ai/vm0/issues/17961)) ([0eba595](https://github.com/vm0-ai/vm0/commit/0eba595f87d511d2bda1299ae00a77d78da234a8))
* remove github issues internal callback route ([#17959](https://github.com/vm0-ai/vm0/issues/17959)) ([b4288ff](https://github.com/vm0-ai/vm0/commit/b4288ffafae089f185ae713471ee6e56803c310c))
* remove loop trigger internal callback route ([#17963](https://github.com/vm0-ai/vm0/issues/17963)) ([b429b07](https://github.com/vm0-ai/vm0/commit/b429b07fb2b31356c85637113634f340d0b5fede))
* remove slack org internal callback route ([#17957](https://github.com/vm0-ai/vm0/issues/17957)) ([d1315cb](https://github.com/vm0-ai/vm0/commit/d1315cbf70aec4a2bca44bf8743ba184705fe29e))
* remove telegram internal callback route ([#17955](https://github.com/vm0-ai/vm0/issues/17955)) ([a1f6690](https://github.com/vm0-ai/vm0/commit/a1f669078447c14ccf4c2291b2d6f5ddebf7a7cd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.97.3
    * @vm0/connectors bumped to 1.83.0
    * @vm0/core bumped to 8.346.0
    * @vm0/db bumped to 1.53.3

## [1.147.3](https://github.com/vm0-ai/vm0/compare/api-v1.147.2...api-v1.147.3) (2026-06-16)


### Refactoring

* dispatch slack org callbacks through ccstate ([#17932](https://github.com/vm0-ai/vm0/issues/17932)) ([e48ae30](https://github.com/vm0-ai/vm0/commit/e48ae30e342b268be340f15057b1136ddefd6eec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.97.2
    * @vm0/connectors bumped to 1.82.0
    * @vm0/core bumped to 8.345.0
    * @vm0/db bumped to 1.53.2

## [1.147.2](https://github.com/vm0-ai/vm0/compare/api-v1.147.1...api-v1.147.2) (2026-06-16)


### Refactoring

* dispatch trigger callbacks through ccstate ([#17906](https://github.com/vm0-ai/vm0/issues/17906)) ([f85b57b](https://github.com/vm0-ai/vm0/commit/f85b57bc5838fe8f06349c3b676ab06d253a6f41))

## [1.147.1](https://github.com/vm0-ai/vm0/compare/api-v1.147.0...api-v1.147.1) (2026-06-16)


### Bug Fixes

* clean up runner e2e zero agents ([#17884](https://github.com/vm0-ai/vm0/issues/17884)) ([0631d03](https://github.com/vm0-ai/vm0/commit/0631d0386716fb3a32cca6f28135ca4f911a5640))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.97.1
    * @vm0/connectors bumped to 1.81.1
    * @vm0/core bumped to 8.344.1
    * @vm0/db bumped to 1.53.1

## [1.147.0](https://github.com/vm0-ai/vm0/compare/api-v1.146.2...api-v1.147.0) (2026-06-16)


### Features

* show connector reconnect reasons ([#17885](https://github.com/vm0-ai/vm0/issues/17885)) ([ca5ea4c](https://github.com/vm0-ai/vm0/commit/ca5ea4cbbc796c83ab614402a835ade2e1f13315))


### Bug Fixes

* clarify custom skill persistence guidance ([#17828](https://github.com/vm0-ai/vm0/issues/17828)) ([b8ca919](https://github.com/vm0-ai/vm0/commit/b8ca9198b31ef855ec5bbaea379fdde149ccedfe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.97.0
    * @vm0/connectors bumped to 1.81.0
    * @vm0/core bumped to 8.344.0
    * @vm0/db bumped to 1.53.0

## [1.146.2](https://github.com/vm0-ai/vm0/compare/api-v1.146.1...api-v1.146.2) (2026-06-16)


### Bug Fixes

* handle blocked network log uploads ([#17822](https://github.com/vm0-ai/vm0/issues/17822)) ([19b1b37](https://github.com/vm0-ai/vm0/commit/19b1b373a3669064fb7ddc1067692f820f34cdb6))


### Refactoring

* dispatch agent callbacks through ccstate ([#17836](https://github.com/vm0-ai/vm0/issues/17836)) ([cb45a3d](https://github.com/vm0-ai/vm0/commit/cb45a3d154b37f43e4d8d3a4f15913745618d3ad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.96.2
    * @vm0/core bumped to 8.343.1
    * @vm0/db bumped to 1.52.7

## [1.146.1](https://github.com/vm0-ai/vm0/compare/api-v1.146.0...api-v1.146.1) (2026-06-16)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.96.1
    * @vm0/connectors bumped to 1.80.0
    * @vm0/core bumped to 8.343.0
    * @vm0/db bumped to 1.52.6

## [1.146.0](https://github.com/vm0-ai/vm0/compare/api-v1.145.1...api-v1.146.0) (2026-06-16)


### Features

* persist computer use host selection ([#17818](https://github.com/vm0-ai/vm0/issues/17818)) ([f59cc04](https://github.com/vm0-ai/vm0/commit/f59cc044090b287c09b3e42ad5c2cc57351e1f7b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.96.0
    * @vm0/core bumped to 8.342.0
    * @vm0/db bumped to 1.52.5

## [1.145.1](https://github.com/vm0-ai/vm0/compare/api-v1.145.0...api-v1.145.1) (2026-06-16)


### Bug Fixes

* rebalance generation template prompt context ([#17810](https://github.com/vm0-ai/vm0/issues/17810)) ([96c5c9a](https://github.com/vm0-ai/vm0/commit/96c5c9afa165729a570dfe39643d03ca8d73aa38))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.95.2
    * @vm0/core bumped to 8.341.2
    * @vm0/db bumped to 1.52.4

## [1.145.0](https://github.com/vm0-ai/vm0/compare/api-v1.144.0...api-v1.145.0) (2026-06-15)


### Features

* move computer use into connectors menu ([#17791](https://github.com/vm0-ai/vm0/issues/17791)) ([5758078](https://github.com/vm0-ai/vm0/commit/5758078dff13e951d289fc9923bfef9e7f9ea222))


### Bug Fixes

* clean slack test vm0 keys ([#17784](https://github.com/vm0-ai/vm0/issues/17784)) ([13488e4](https://github.com/vm0-ai/vm0/commit/13488e4106908f496a8e0212bdf74e1c3761b2e9))
* clean up stripe billing for deleted clerk users ([#17324](https://github.com/vm0-ai/vm0/issues/17324)) ([0d578b6](https://github.com/vm0-ai/vm0/commit/0d578b61341a1f4ccfab4e9d58992a41b1205cb6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.95.1
    * @vm0/connectors bumped to 1.79.1
    * @vm0/core bumped to 8.341.1
    * @vm0/db bumped to 1.52.3

## [1.144.0](https://github.com/vm0-ai/vm0/compare/api-v1.143.0...api-v1.144.0) (2026-06-15)


### Features

* add google maps oauth connector ([#17351](https://github.com/vm0-ai/vm0/issues/17351)) ([c89bd02](https://github.com/vm0-ai/vm0/commit/c89bd0254903898ce5cdc7df4859ba7497364cc7))
* default new orgs to kimi k2.7 ([#17712](https://github.com/vm0-ai/vm0/issues/17712)) ([2d0d56b](https://github.com/vm0-ai/vm0/commit/2d0d56b963d1ccd761b7b19434058a3a18af6ab2))
* enable youtube connector by default ([#17754](https://github.com/vm0-ai/vm0/issues/17754)) ([d378cea](https://github.com/vm0-ai/vm0/commit/d378cea01569c5cbddceb978e88af294db9919a8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.95.0
    * @vm0/connectors bumped to 1.79.0
    * @vm0/core bumped to 8.341.0
    * @vm0/db bumped to 1.52.2

## [1.143.0](https://github.com/vm0-ai/vm0/compare/api-v1.142.0...api-v1.143.0) (2026-06-15)


### Features

* redirect onboarding to so site ([#17654](https://github.com/vm0-ai/vm0/issues/17654)) ([55dd940](https://github.com/vm0-ai/vm0/commit/55dd940a002c83356545486c884021d8d3d427fd))


### Bug Fixes

* add usage underbilling alert signals ([#17691](https://github.com/vm0-ai/vm0/issues/17691)) ([4edf467](https://github.com/vm0-ai/vm0/commit/4edf467d84ec10bcd7138ba90d44330e94083f35))
* store credit purchases with distinct source ([#17729](https://github.com/vm0-ai/vm0/issues/17729)) ([2b4a8f0](https://github.com/vm0-ai/vm0/commit/2b4a8f02460a8c9f8c59a74f238c4ca12c1f68f8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.94.1
    * @vm0/connectors bumped to 1.78.0
    * @vm0/core bumped to 8.340.0
    * @vm0/db bumped to 1.52.1

## [1.142.0](https://github.com/vm0-ai/vm0/compare/api-v1.141.0...api-v1.142.0) (2026-06-15)


### Features

* configure connector unknown endpoint defaults ([#17699](https://github.com/vm0-ai/vm0/issues/17699)) ([d9f193e](https://github.com/vm0-ai/vm0/commit/d9f193efdd6c2209b2de7aa96b6a3f8fddd023d1))
* persist generation template per thread so style sticks across follow-ups ([#17525](https://github.com/vm0-ai/vm0/issues/17525)) ([#17681](https://github.com/vm0-ai/vm0/issues/17681)) ([37b295e](https://github.com/vm0-ai/vm0/commit/37b295ed9e5c4ca7b550dc5c19aaf964ff483a31))


### Bug Fixes

* harden openrouter provider auth ([#17704](https://github.com/vm0-ai/vm0/issues/17704)) ([9ada505](https://github.com/vm0-ai/vm0/commit/9ada5055216f0ba6f875f28b17d2ce67e57b8f9f))
* seed deepseek dev api key ([#17607](https://github.com/vm0-ai/vm0/issues/17607)) ([e957b49](https://github.com/vm0-ai/vm0/commit/e957b4993dd1f7fddfa28822c7ac9a0a4c021c25))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.94.0
    * @vm0/connectors bumped to 1.77.0
    * @vm0/core bumped to 8.339.0
    * @vm0/db bumped to 1.52.0

## [1.141.0](https://github.com/vm0-ai/vm0/compare/api-v1.140.1...api-v1.141.0) (2026-06-15)


### Features

* add desktop dmg download dialog ([#17706](https://github.com/vm0-ai/vm0/issues/17706)) ([7586bbc](https://github.com/vm0-ai/vm0/commit/7586bbc2cf3c6272717639c05bdd49c88a294952))
* replace YouTube API key auth with OAuth ([#17661](https://github.com/vm0-ai/vm0/issues/17661)) ([c548213](https://github.com/vm0-ai/vm0/commit/c54821371703d3be2c996db429630b36b1404e67))
* send low credit balance alerts ([#17595](https://github.com/vm0-ai/vm0/issues/17595)) ([8c4037b](https://github.com/vm0-ai/vm0/commit/8c4037bb1eef85a4d544463f8c22b26144397f1e))


### Bug Fixes

* disable org-member automations on removal ([#17689](https://github.com/vm0-ai/vm0/issues/17689)) ([13c48dc](https://github.com/vm0-ai/vm0/commit/13c48dc8c7b82ad79d2e901e969c9278bcef5392))
* give agent context for attached illustration style ([#17525](https://github.com/vm0-ai/vm0/issues/17525)) ([#17657](https://github.com/vm0-ai/vm0/issues/17657)) ([cf2d344](https://github.com/vm0-ai/vm0/commit/cf2d344c737dc2467c5338739453935f43668c6b))
* remove api web fallback ([#17509](https://github.com/vm0-ai/vm0/issues/17509)) ([dab9e38](https://github.com/vm0-ai/vm0/commit/dab9e3819b42fbd6aaacb6f1d0ef39a4928c8c54))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.93.0
    * @vm0/connectors bumped to 1.76.0
    * @vm0/core bumped to 8.338.0
    * @vm0/db bumped to 1.51.0

## [1.140.1](https://github.com/vm0-ai/vm0/compare/api-v1.140.0...api-v1.140.1) (2026-06-14)


### Refactoring

* remove chat recommended followups switch ([#17608](https://github.com/vm0-ai/vm0/issues/17608)) ([8e03d5a](https://github.com/vm0-ai/vm0/commit/8e03d5a65d4b2a666c56e0cea534402d12a947ed))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.92.1
    * @vm0/connectors bumped to 1.75.0
    * @vm0/core bumped to 8.337.0
    * @vm0/db bumped to 1.50.1

## [1.140.0](https://github.com/vm0-ai/vm0/compare/api-v1.139.3...api-v1.140.0) (2026-06-13)


### Features

* add Kimi K2.7 Code model ([#17568](https://github.com/vm0-ai/vm0/issues/17568)) ([841b0ff](https://github.com/vm0-ai/vm0/commit/841b0ff05bf4f594080bd7fb5b17e2ff0cecf2a2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.92.0
    * @vm0/core bumped to 8.336.0
    * @vm0/db bumped to 1.50.0

## [1.139.3](https://github.com/vm0-ai/vm0/compare/api-v1.139.2...api-v1.139.3) (2026-06-13)


### Bug Fixes

* remove claude fable 5 model support ([#17567](https://github.com/vm0-ai/vm0/issues/17567)) ([63733bf](https://github.com/vm0-ai/vm0/commit/63733bf637ce02afe00d0f97a2439f988c59078d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.91.2
    * @vm0/core bumped to 8.335.5
    * @vm0/db bumped to 1.49.3

## [1.139.2](https://github.com/vm0-ai/vm0/compare/api-v1.139.1...api-v1.139.2) (2026-06-13)


### Bug Fixes

* surface connector diagnostics for failed requests ([#17457](https://github.com/vm0-ai/vm0/issues/17457)) ([52a3083](https://github.com/vm0-ai/vm0/commit/52a308358d08bb30dd1e87e11747cfe13743a444))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.91.1
    * @vm0/core bumped to 8.335.4
    * @vm0/db bumped to 1.49.2

## [1.139.1](https://github.com/vm0-ai/vm0/compare/api-v1.139.0...api-v1.139.1) (2026-06-13)


### Bug Fixes

* clarify custom skill sync guidance ([#17544](https://github.com/vm0-ai/vm0/issues/17544)) ([45b5c5e](https://github.com/vm0-ai/vm0/commit/45b5c5e9d13f93710ca7c71c03cc5bb3e5ae76f6))

## [1.139.0](https://github.com/vm0-ai/vm0/compare/api-v1.138.0...api-v1.139.0) (2026-06-13)


### Features

* cancel runs and disable automations on clerk user.banned webhook ([#17523](https://github.com/vm0-ai/vm0/issues/17523)) ([f728b8f](https://github.com/vm0-ai/vm0/commit/f728b8f34106055a80fa53b61b64d0dd5547a56e))
* update a time trigger's schedule in place ([#17543](https://github.com/vm0-ai/vm0/issues/17543)) ([1c4cdb1](https://github.com/vm0-ai/vm0/commit/1c4cdb18b84b8924684b33545781112275437c97))


### Bug Fixes

* append chat usage settlement messages ([#17521](https://github.com/vm0-ai/vm0/issues/17521)) ([a937645](https://github.com/vm0-ai/vm0/commit/a937645344bdc687227019304f5af2fd3d4fcc74))
* stop disabled automations from starving the trigger poller ([#17549](https://github.com/vm0-ai/vm0/issues/17549)) ([78eadde](https://github.com/vm0-ai/vm0/commit/78eadde22357d5b52f02749dbdff13f819efea82)), closes [#17546](https://github.com/vm0-ai/vm0/issues/17546)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.91.0
    * @vm0/core bumped to 8.335.3
    * @vm0/db bumped to 1.49.1

## [1.138.0](https://github.com/vm0-ai/vm0/compare/api-v1.137.0...api-v1.138.0) (2026-06-12)


### Features

* **db:** drop the schedule columns ([#17537](https://github.com/vm0-ai/vm0/issues/17537)) ([c490692](https://github.com/vm0-ai/vm0/commit/c4906922c4d14d16f1ddcda22dc1199e7eea6336))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.49.0

## [1.137.0](https://github.com/vm0-ai/vm0/compare/api-v1.136.1...api-v1.137.0) (2026-06-12)


### Features

* stop touching the schedule columns and rename the wire fields ([#17535](https://github.com/vm0-ai/vm0/issues/17535)) ([7ffec48](https://github.com/vm0-ai/vm0/commit/7ffec48d24efa30899a74026d2593ec52e4cc9a5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.90.0
    * @vm0/core bumped to 8.335.2
    * @vm0/db bumped to 1.48.0

## [1.136.1](https://github.com/vm0-ai/vm0/compare/api-v1.136.0...api-v1.136.1) (2026-06-12)


### Refactoring

* retire the remaining schedule residue ([#17529](https://github.com/vm0-ai/vm0/issues/17529)) ([bf2b208](https://github.com/vm0-ai/vm0/commit/bf2b2082775c38dcf3d5938bc6ed4fb3df76c306))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.89.1
    * @vm0/connectors bumped to 1.74.0
    * @vm0/core bumped to 8.335.1
    * @vm0/db bumped to 1.47.4

## [1.136.0](https://github.com/vm0-ai/vm0/compare/api-v1.135.2...api-v1.136.0) (2026-06-12)


### Features

* stream assistant text deltas to web chat ([#17370](https://github.com/vm0-ai/vm0/issues/17370)) ([cbfdf74](https://github.com/vm0-ai/vm0/commit/cbfdf74761771d0142603030ca764d1f33d61479))


### Bug Fixes

* load all cached chat messages on thread entry ([#17520](https://github.com/vm0-ai/vm0/issues/17520)) ([0ebd1c4](https://github.com/vm0-ai/vm0/commit/0ebd1c4b149399d87ae2833d2ba08f556778233d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.89.0
    * @vm0/connectors bumped to 1.73.0
    * @vm0/core bumped to 8.335.0
    * @vm0/db bumped to 1.47.3

## [1.135.2](https://github.com/vm0-ai/vm0/compare/api-v1.135.1...api-v1.135.2) (2026-06-12)


### Bug Fixes

* aggregate deleted chat usage records ([#17516](https://github.com/vm0-ai/vm0/issues/17516)) ([91b7973](https://github.com/vm0-ai/vm0/commit/91b797382147f89d3e0df7b3e84fb36d5aebfb79))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.88.2
    * @vm0/core bumped to 8.334.2
    * @vm0/db bumped to 1.47.2

## [1.135.1](https://github.com/vm0-ai/vm0/compare/api-v1.135.0...api-v1.135.1) (2026-06-12)


### Refactoring

* retire obsolete feature switches ([#17496](https://github.com/vm0-ai/vm0/issues/17496)) ([b37964a](https://github.com/vm0-ai/vm0/commit/b37964aa0c45ad3feb291762fdbaaf2fc457cc20))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.88.1
    * @vm0/connectors bumped to 1.72.1
    * @vm0/core bumped to 8.334.1
    * @vm0/db bumped to 1.47.1

## [1.135.0](https://github.com/vm0-ai/vm0/compare/api-v1.134.3...api-v1.135.0) (2026-06-12)


### Features

* add web chat run usage messages ([#17368](https://github.com/vm0-ai/vm0/issues/17368)) ([57abb19](https://github.com/vm0-ai/vm0/commit/57abb19caa4829b682478a94b4781d818d7047ea))
* **video-preset:** add promptConstraints and negativePrompt to all 33 video style presets ([#17405](https://github.com/vm0-ai/vm0/issues/17405)) ([7045867](https://github.com/vm0-ai/vm0/commit/70458677e2bade872e9e97e467e2731e181e3750))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.88.0
    * @vm0/connectors bumped to 1.72.0
    * @vm0/core bumped to 8.334.0
    * @vm0/db bumped to 1.47.0

## [1.134.3](https://github.com/vm0-ai/vm0/compare/api-v1.134.2...api-v1.134.3) (2026-06-12)


### Refactoring

* **platform:** rename the schedule internals to automation ([#17465](https://github.com/vm0-ai/vm0/issues/17465)) ([e27fde6](https://github.com/vm0-ai/vm0/commit/e27fde65b93e6be3bb97fa65c606fa5c69277d41))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.87.2
    * @vm0/core bumped to 8.333.3
    * @vm0/db bumped to 1.46.4

## [1.134.2](https://github.com/vm0-ai/vm0/compare/api-v1.134.1...api-v1.134.2) (2026-06-12)


### Bug Fixes

* **api:** poll the org-teardown assertions in the clerk deletion test ([#17462](https://github.com/vm0-ai/vm0/issues/17462)) ([7e162bf](https://github.com/vm0-ai/vm0/commit/7e162bfee955c134bb6272b5677c382fd0ad79b9)), closes [#17451](https://github.com/vm0-ai/vm0/issues/17451)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.87.1
    * @vm0/connectors bumped to 1.71.1
    * @vm0/core bumped to 8.333.2
    * @vm0/db bumped to 1.46.3

## [1.134.1](https://github.com/vm0-ai/vm0/compare/api-v1.134.0...api-v1.134.1) (2026-06-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.333.1

## [1.134.0](https://github.com/vm0-ai/vm0/compare/api-v1.133.0...api-v1.134.0) (2026-06-12)


### Features

* add connector auth method visibility ([#17409](https://github.com/vm0-ai/vm0/issues/17409)) ([0f4f707](https://github.com/vm0-ai/vm0/commit/0f4f707535b225eb141b93df698f81e9b0b29969))
* retire the schedule trigger source value ([#17401](https://github.com/vm0-ai/vm0/issues/17401)) ([87cd4b5](https://github.com/vm0-ai/vm0/commit/87cd4b50e1ba9c37bd2d59e74e936d3accb8988e))


### Bug Fixes

* keep expanded work in assistant group ([#17410](https://github.com/vm0-ai/vm0/issues/17410)) ([65ec61e](https://github.com/vm0-ai/vm0/commit/65ec61ef9dd01001ea82172a98e10ad8167757a8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.87.0
    * @vm0/connectors bumped to 1.71.0
    * @vm0/core bumped to 8.333.0
    * @vm0/db bumped to 1.46.2

## [1.133.0](https://github.com/vm0-ai/vm0/compare/api-v1.132.2...api-v1.133.0) (2026-06-12)


### Features

* **api:** drop the transition aliases for the automation paths ([#17388](https://github.com/vm0-ai/vm0/issues/17388)) ([7f34ec6](https://github.com/vm0-ai/vm0/commit/7f34ec674f4245c58204aa7fa1d509571712ab22))


### Bug Fixes

* fold completed chat work per run ([#17369](https://github.com/vm0-ai/vm0/issues/17369)) ([a450d65](https://github.com/vm0-ai/vm0/commit/a450d6548926d6d1f6b9695e476cbf4d4d2868b7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.86.1
    * @vm0/connectors bumped to 1.70.0
    * @vm0/core bumped to 8.332.0
    * @vm0/db bumped to 1.46.1

## [1.132.2](https://github.com/vm0-ai/vm0/compare/api-v1.132.1...api-v1.132.2) (2026-06-12)


### Bug Fixes

* send follow-ups without revoking messages ([#17367](https://github.com/vm0-ai/vm0/issues/17367)) ([ebcca89](https://github.com/vm0-ai/vm0/commit/ebcca8954e552c2c6e73254493494cd19d9b4c26))

## [1.132.1](https://github.com/vm0-ai/vm0/compare/api-v1.132.0...api-v1.132.1) (2026-06-11)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.46.0

## [1.132.0](https://github.com/vm0-ai/vm0/compare/api-v1.131.0...api-v1.132.0) (2026-06-11)


### Features

* **api:** delete the legacy schedule and flat automation surfaces ([#17358](https://github.com/vm0-ai/vm0/issues/17358)) ([e25c44c](https://github.com/vm0-ai/vm0/commit/e25c44c01b57e8858ecb687b977ee3c14012700b))
* **api:** move the automation resource api to /api/automations ([#17362](https://github.com/vm0-ai/vm0/issues/17362)) ([c4ab2d8](https://github.com/vm0-ai/vm0/commit/c4ab2d82a84a4bb083c6755e0b027401cb997626))
* **api:** replace schedule capabilities with automation capabilities ([#17356](https://github.com/vm0-ai/vm0/issues/17356)) ([5e4d31c](https://github.com/vm0-ai/vm0/commit/5e4d31ca8a4293985d8707f226a0699d68a5a8f9))
* enable zero automations for all users ([#17340](https://github.com/vm0-ai/vm0/issues/17340)) ([f864dca](https://github.com/vm0-ai/vm0/commit/f864dcab9cf5292a8513e18801657a63e16d10d6))
* **platform:** manage schedules through the automation resource api ([#17352](https://github.com/vm0-ai/vm0/issues/17352)) ([a3c6583](https://github.com/vm0-ai/vm0/commit/a3c658320786cff32a60d2da2014be6820b75b6d))
* remove the zero automations feature switch ([#17354](https://github.com/vm0-ai/vm0/issues/17354)) ([c2c8d98](https://github.com/vm0-ai/vm0/commit/c2c8d983449a0deb69c3f836f684239ede16f5cd))
* rename the cron tick and platform routes to automations ([#17363](https://github.com/vm0-ai/vm0/issues/17363)) ([8ddb863](https://github.com/vm0-ai/vm0/commit/8ddb863ee22c268d3905a1255d3cdfac905e1ff5))


### Refactoring

* remove legacy execution firewall compatibility ([#17349](https://github.com/vm0-ai/vm0/issues/17349)) ([385ea93](https://github.com/vm0-ai/vm0/commit/385ea9345fb9613b0041eefb2ed7557f2af62beb))


### Performance Improvements

* store compact run context firewalls ([#17350](https://github.com/vm0-ai/vm0/issues/17350)) ([4979488](https://github.com/vm0-ai/vm0/commit/4979488ffd3af48f248b1824dd9190d6650d13ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.86.0
    * @vm0/connectors bumped to 1.69.0
    * @vm0/core bumped to 8.331.0
    * @vm0/db bumped to 1.45.1

## [1.131.0](https://github.com/vm0-ai/vm0/compare/api-v1.130.1...api-v1.131.0) (2026-06-11)


### Features

* **api:** gate webhook triggers behind a feature switch ([#17315](https://github.com/vm0-ai/vm0/issues/17315)) ([3264d05](https://github.com/vm0-ai/vm0/commit/3264d05970511eaa7a493d97fe6cf44c46540aad))
* **api:** record automation as the trigger source for automation runs ([#17334](https://github.com/vm0-ai/vm0/issues/17334)) ([cb7a907](https://github.com/vm0-ai/vm0/commit/cb7a907086418ad90941aeff5ff554526a6df184))
* support multiple computer use hosts ([#17326](https://github.com/vm0-ai/vm0/issues/17326)) ([214bc55](https://github.com/vm0-ai/vm0/commit/214bc556f3223689b06f956fda0687e622255ac5))


### Bug Fixes

* log runner context validation issues ([#17322](https://github.com/vm0-ai/vm0/issues/17322)) ([4349e84](https://github.com/vm0-ai/vm0/commit/4349e84f11d356343be163cb7ab6841ce0591fe4))


### Refactoring

* drop unused soft-state fields from chat thread detail ([#17323](https://github.com/vm0-ai/vm0/issues/17323)) ([1d2618a](https://github.com/vm0-ai/vm0/commit/1d2618a6ab81ecb4aeed3cd578e9d809b9f33823))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.85.0
    * @vm0/connectors bumped to 1.68.0
    * @vm0/core bumped to 8.330.0
    * @vm0/db bumped to 1.45.0

## [1.130.1](https://github.com/vm0-ai/vm0/compare/api-v1.130.0...api-v1.130.1) (2026-06-11)


### Bug Fixes

* aggregate team credit usage by member ([#17287](https://github.com/vm0-ai/vm0/issues/17287)) ([542d7eb](https://github.com/vm0-ai/vm0/commit/542d7eb85ecdbc188f85df346cce14c877d8e4d8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.84.1
    * @vm0/core bumped to 8.329.1
    * @vm0/db bumped to 1.44.2

## [1.130.0](https://github.com/vm0-ai/vm0/compare/api-v1.129.0...api-v1.130.0) (2026-06-11)


### Features

* send compact builtin firewall refs to runner ([#17252](https://github.com/vm0-ai/vm0/issues/17252)) ([e65864a](https://github.com/vm0-ai/vm0/commit/e65864afdea65f6ded9b9de7c3bcc057184852aa))


### Bug Fixes

* add illustration template preview ([#17276](https://github.com/vm0-ai/vm0/issues/17276)) ([51e0bb1](https://github.com/vm0-ai/vm0/commit/51e0bb1e6bb0db65cc17335a2c3f5742ae68b8e3))
* **api:** remove audioInputVerbose feature flag, always use verbose STT ([#17253](https://github.com/vm0-ai/vm0/issues/17253)) ([60c89bc](https://github.com/vm0-ai/vm0/commit/60c89bcc0b76bb10f947f0f707077c275227a430))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.84.0
    * @vm0/connectors bumped to 1.67.0
    * @vm0/core bumped to 8.329.0
    * @vm0/db bumped to 1.44.1

## [1.129.0](https://github.com/vm0-ai/vm0/compare/api-v1.128.1...api-v1.129.0) (2026-06-11)


### Features

* add runner claim pickup telemetry ([#17268](https://github.com/vm0-ai/vm0/issues/17268)) ([270d94e](https://github.com/vm0-ai/vm0/commit/270d94ed8ca7820d4c097c38484871e8373b104b))
* **db:** drop zero_agent_schedules and retire the legacy schedule paths ([#17258](https://github.com/vm0-ai/vm0/issues/17258)) ([8f89943](https://github.com/vm0-ai/vm0/commit/8f89943a31309f02c35a1c58e1d1cabfc5cfa8ba))


### Bug Fixes

* show usage range filter in credit balance ([#17260](https://github.com/vm0-ai/vm0/issues/17260)) ([bdb1d0c](https://github.com/vm0-ai/vm0/commit/bdb1d0c4c0f8c59481fd993908b4ae933b44c324))
* store run context maps as Axiom entries ([#17232](https://github.com/vm0-ai/vm0/issues/17232)) ([c8ebf36](https://github.com/vm0-ai/vm0/commit/c8ebf363f3c6b60dd7d13094ab9e60327147d05d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.83.0
    * @vm0/core bumped to 8.328.1
    * @vm0/db bumped to 1.44.0

## [1.128.1](https://github.com/vm0-ai/vm0/compare/api-v1.128.0...api-v1.128.1) (2026-06-11)


### Bug Fixes

* clarify static artifact delivery context ([#17249](https://github.com/vm0-ai/vm0/issues/17249)) ([0c2c2cc](https://github.com/vm0-ai/vm0/commit/0c2c2cc1c9cb2837b4a14beba427f9c815525368))

## [1.128.0](https://github.com/vm0-ai/vm0/compare/api-v1.127.1...api-v1.128.0) (2026-06-11)


### Features

* add credit usage range controls ([#17192](https://github.com/vm0-ai/vm0/issues/17192)) ([0c9eafb](https://github.com/vm0-ai/vm0/commit/0c9eafb0e208e60edaed58b1612105a0b875a4db))
* **api:** cut schedule reads and writes over to the events-first tables ([#17225](https://github.com/vm0-ai/vm0/issues/17225)) ([967f948](https://github.com/vm0-ai/vm0/commit/967f94879bcbca83f3ae90854de72c81597dc5de))
* **api:** per-trigger webhook gate + trigger kind-config constraint ([#17233](https://github.com/vm0-ai/vm0/issues/17233)) ([05e3b88](https://github.com/vm0-ai/vm0/commit/05e3b88b941366649313ecaec0c6e1f771051f9e))
* promote computer-use to seed skill ([#17224](https://github.com/vm0-ai/vm0/issues/17224)) ([ea828c1](https://github.com/vm0-ai/vm0/commit/ea828c17a224e259da51003d3af24576647beaa0))


### Bug Fixes

* download hosted site clones from r2 ([#17240](https://github.com/vm0-ai/vm0/issues/17240)) ([d0da982](https://github.com/vm0-ai/vm0/commit/d0da9827fc74145974e4bb48e7fde90169ef3b57))
* only auto-name chat threads once ([#17228](https://github.com/vm0-ai/vm0/issues/17228)) ([808d124](https://github.com/vm0-ai/vm0/commit/808d124df97492db9996c85d3f5a82cc43125daa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.82.0
    * @vm0/connectors bumped to 1.66.0
    * @vm0/core bumped to 8.328.0
    * @vm0/db bumped to 1.43.0

## [1.127.1](https://github.com/vm0-ai/vm0/compare/api-v1.127.0...api-v1.127.1) (2026-06-11)


### Bug Fixes

* use system hostname for computer use hosts ([#17193](https://github.com/vm0-ai/vm0/issues/17193)) ([c17abcc](https://github.com/vm0-ai/vm0/commit/c17abcc586e83e26d7b4476ca36ca4550c2a261c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.81.1
    * @vm0/connectors bumped to 1.65.0
    * @vm0/core bumped to 8.327.0
    * @vm0/db bumped to 1.42.3

## [1.127.0](https://github.com/vm0-ai/vm0/compare/api-v1.126.1...api-v1.127.0) (2026-06-11)


### Features

* add Cloudflare OAuth connector ([#17123](https://github.com/vm0-ai/vm0/issues/17123)) ([84bb1e0](https://github.com/vm0-ai/vm0/commit/84bb1e0f1d899ba051e490228ccac7aefd6656aa))
* add Google Cloud connector ([#16302](https://github.com/vm0-ai/vm0/issues/16302)) ([edc2046](https://github.com/vm0-ai/vm0/commit/edc2046a5f599fcfc33d45d7fc68a54bf8835c09))
* add TikTok Ads connector ([#17148](https://github.com/vm0-ai/vm0/issues/17148)) ([5e0824b](https://github.com/vm0-ai/vm0/commit/5e0824bb254f1bbef2672792bc5e56560d7717c7))
* enable connector permission reset by default ([#17140](https://github.com/vm0-ai/vm0/issues/17140)) ([036ed23](https://github.com/vm0-ai/vm0/commit/036ed23787cf999cc9c002c0764b9382d3b99993))


### Bug Fixes

* route desktop connect link to release page ([#17190](https://github.com/vm0-ai/vm0/issues/17190)) ([cfa3531](https://github.com/vm0-ai/vm0/commit/cfa3531ce706ac773080c28868f7dcb6a2739bb3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.81.0
    * @vm0/connectors bumped to 1.64.0
    * @vm0/core bumped to 8.326.0
    * @vm0/db bumped to 1.42.2

## [1.126.1](https://github.com/vm0-ai/vm0/compare/api-v1.126.0...api-v1.126.1) (2026-06-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.80.1
    * @vm0/connectors bumped to 1.63.0
    * @vm0/core bumped to 8.325.0
    * @vm0/db bumped to 1.42.1

## [1.126.0](https://github.com/vm0-ai/vm0/compare/api-v1.125.0...api-v1.126.0) (2026-06-10)


### Features

* add hosted site content access ([#17021](https://github.com/vm0-ai/vm0/issues/17021)) ([05d6cc1](https://github.com/vm0-ai/vm0/commit/05d6cc19428d593167196ff6cef767fe2aca72d2))
* add video style template picker to chat composer ([#17027](https://github.com/vm0-ai/vm0/issues/17027)) ([c8a51ba](https://github.com/vm0-ai/vm0/commit/c8a51baa53b4505b6f33dee2db78b1cad9e9e413))
* **api:** mirror schedule runtime state onto events-first tables ([#17061](https://github.com/vm0-ai/vm0/issues/17061)) ([8beae3f](https://github.com/vm0-ai/vm0/commit/8beae3fe29ee154f2c500a6d72c60195935727e2))
* show desktop auth success after completion ([#17092](https://github.com/vm0-ai/vm0/issues/17092)) ([dae5585](https://github.com/vm0-ai/vm0/commit/dae5585e94d6fa49535529b1c38c79d0914fb207))


### Bug Fixes

* **api:** measure STT WAV duration via RIFF chunk-walk, not fixed offset ([#17083](https://github.com/vm0-ai/vm0/issues/17083)) ([dfad095](https://github.com/vm0-ai/vm0/commit/dfad095f8e21d813d4ddee7eae50662e84a548ad))
* restore web chat queue indicator ([#17011](https://github.com/vm0-ai/vm0/issues/17011)) ([2a83cb7](https://github.com/vm0-ai/vm0/commit/2a83cb74933f19ad3e42889b4ec8085b5a8a11f3))
* upload billing conversions to google ads ([#17044](https://github.com/vm0-ai/vm0/issues/17044)) ([d7f9108](https://github.com/vm0-ai/vm0/commit/d7f91083e4de8340511b2c4473a2ccbe358fa3d2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.80.0
    * @vm0/connectors bumped to 1.62.0
    * @vm0/core bumped to 8.324.0
    * @vm0/db bumped to 1.42.0

## [1.125.0](https://github.com/vm0-ai/vm0/compare/api-v1.124.0...api-v1.125.0) (2026-06-10)


### Features

* add enterprise zero maps places fieldsets ([#17024](https://github.com/vm0-ai/vm0/issues/17024)) ([9d38554](https://github.com/vm0-ai/vm0/commit/9d38554464b72359bc97dc3dfdca93d44717f9d5))
* add google search console connector ([#17020](https://github.com/vm0-ai/vm0/issues/17020)) ([9cb2db5](https://github.com/vm0-ai/vm0/commit/9cb2db5f763ad3a2aed9cf25963472c38b05875e))


### Bug Fixes

* filter slack agent switch options ([#17031](https://github.com/vm0-ai/vm0/issues/17031)) ([23b951b](https://github.com/vm0-ai/vm0/commit/23b951bd757e781a06673cdd265647c280184abb))
* surface claude rate limits in integrations ([#17014](https://github.com/vm0-ai/vm0/issues/17014)) ([364da26](https://github.com/vm0-ai/vm0/commit/364da26df9f8c3457ec35f9233eaf3e69aaab85d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.79.0
    * @vm0/connectors bumped to 1.61.0
    * @vm0/core bumped to 8.323.0
    * @vm0/db bumped to 1.41.0

## [1.124.0](https://github.com/vm0-ai/vm0/compare/api-v1.123.0...api-v1.124.0) (2026-06-10)


### Features

* **api:** carry append_system_prompt onto automations ([#17034](https://github.com/vm0-ai/vm0/issues/17034)) ([e87d407](https://github.com/vm0-ai/vm0/commit/e87d4078e7c8b4e6c449668ac25df1e54e26051c))
* **api:** carry schedule chip onto automation chat messages ([#17049](https://github.com/vm0-ai/vm0/issues/17049)) ([a68d443](https://github.com/vm0-ai/vm0/commit/a68d4438dd8f2fcb61fc82243952c4720ce0c40e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.78.1
    * @vm0/connectors bumped to 1.60.0
    * @vm0/core bumped to 8.322.0
    * @vm0/db bumped to 1.40.0

## [1.123.0](https://github.com/vm0-ai/vm0/compare/api-v1.122.0...api-v1.123.0) (2026-06-10)


### Features

* **api:** trigger completion callbacks restore live schedule semantics ([#17013](https://github.com/vm0-ai/vm0/issues/17013)) ([5c8740d](https://github.com/vm0-ai/vm0/commit/5c8740da92319b3f626cba70321e7f9f97ee38b8))


### Bug Fixes

* **api:** make schedule dual-write mirror best-effort ([#17009](https://github.com/vm0-ai/vm0/issues/17009)) ([37fce38](https://github.com/vm0-ai/vm0/commit/37fce38d1504d501cdaf472b0dc076088b1eee88))
* **platform:** generate complete presentation scripts ([#16927](https://github.com/vm0-ai/vm0/issues/16927)) ([45254d9](https://github.com/vm0-ai/vm0/commit/45254d9501bac6cb0195ff1508b354d960fb18d6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.78.0
    * @vm0/core bumped to 8.321.1
    * @vm0/db bumped to 1.39.1

## [1.122.0](https://github.com/vm0-ai/vm0/compare/api-v1.121.0...api-v1.122.0) (2026-06-10)


### Features

* add claude fable 5 model support ([#16996](https://github.com/vm0-ai/vm0/issues/16996)) ([c9a6eb1](https://github.com/vm0-ai/vm0/commit/c9a6eb12ddae7e58940d72436f5ceb2032d557d6))
* **cli:** re-land zero video transcribe + frames with sandbox STT access ([#17003](https://github.com/vm0-ai/vm0/issues/17003)) ([8ec0ffc](https://github.com/vm0-ai/vm0/commit/8ec0ffc6dd4fb797dc3f065160d8d118a4c24e4d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.77.0
    * @vm0/connectors bumped to 1.59.0
    * @vm0/core bumped to 8.321.0
    * @vm0/db bumped to 1.39.0

## [1.121.0](https://github.com/vm0-ai/vm0/compare/api-v1.120.0...api-v1.121.0) (2026-06-10)


### Features

* add aws sigv4 firewall auth runtime ([#16876](https://github.com/vm0-ai/vm0/issues/16876)) ([1be4dfc](https://github.com/vm0-ai/vm0/commit/1be4dfc3b764a38a2759c0b0164ebb158f2ffe86))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.76.0
    * @vm0/connectors bumped to 1.58.0
    * @vm0/core bumped to 8.320.2
    * @vm0/db bumped to 1.38.1

## [1.120.0](https://github.com/vm0-ai/vm0/compare/api-v1.119.0...api-v1.120.0) (2026-06-09)


### Features

* **api:** dual-write schedule mutations to new tables + backfill ([#16921](https://github.com/vm0-ai/vm0/issues/16921)) ([55690e3](https://github.com/vm0-ai/vm0/commit/55690e3ce9d76ca9139e97a9f5beb0303ee148c7))
* **cli:** add zero video transcribe command with timestamped STT output ([#16799](https://github.com/vm0-ai/vm0/issues/16799)) ([365c0db](https://github.com/vm0-ai/vm0/commit/365c0db4ac494869778f7a7c62671e2715fc3b54))
* support connector output variables ([#16901](https://github.com/vm0-ai/vm0/issues/16901)) ([edfd55b](https://github.com/vm0-ai/vm0/commit/edfd55b3a37b611deaf9f5eac9d4bf3326e4bcda))


### Bug Fixes

* comment when github labels start runs ([#16913](https://github.com/vm0-ai/vm0/issues/16913)) ([4b49481](https://github.com/vm0-ai/vm0/commit/4b494816da2b363000e51408a2b40b6b6d6fbb67))
* grant custom credits from invoices ([#16330](https://github.com/vm0-ai/vm0/issues/16330)) ([09d8bcd](https://github.com/vm0-ai/vm0/commit/09d8bcda7f8534ad9ca8d3b213c26ac7c607b94b))
* store aws connector regions as variables ([#16944](https://github.com/vm0-ai/vm0/issues/16944)) ([72947d7](https://github.com/vm0-ai/vm0/commit/72947d75f508ea99a40f5e1082a6829e6ed51d6f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.75.0
    * @vm0/connectors bumped to 1.57.0
    * @vm0/core bumped to 8.320.1
    * @vm0/db bumped to 1.38.0

## [1.119.0](https://github.com/vm0-ai/vm0/compare/api-v1.118.0...api-v1.119.0) (2026-06-09)


### Features

* add staged connector permission reset ([#16840](https://github.com/vm0-ai/vm0/issues/16840)) ([c622626](https://github.com/vm0-ai/vm0/commit/c622626b687cb41e78669864422b824e328e9aeb))
* **api:** persist run provenance (automationId + triggerId) on zero_runs ([#16897](https://github.com/vm0-ai/vm0/issues/16897)) ([56cabc2](https://github.com/vm0-ai/vm0/commit/56cabc286d3ba17222a78028f0b9aabdffb25402))


### Bug Fixes

* download hosted html artifacts ([#16611](https://github.com/vm0-ai/vm0/issues/16611)) ([732edbf](https://github.com/vm0-ai/vm0/commit/732edbfb55eb765fae2173cfa0d89cee130cf083))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.74.0
    * @vm0/connectors bumped to 1.56.0
    * @vm0/core bumped to 8.320.0
    * @vm0/db bumped to 1.37.0

## [1.118.0](https://github.com/vm0-ai/vm0/compare/api-v1.117.0...api-v1.118.0) (2026-06-09)


### Features

* add aws external-code connector ([#16577](https://github.com/vm0-ai/vm0/issues/16577)) ([6aaf392](https://github.com/vm0-ai/vm0/commit/6aaf392435773785e31fb9bbba15dc820c97aed1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.73.0
    * @vm0/connectors bumped to 1.55.0
    * @vm0/core bumped to 8.319.0
    * @vm0/db bumped to 1.36.0

## [1.117.0](https://github.com/vm0-ai/vm0/compare/api-v1.116.2...api-v1.117.0) (2026-06-09)


### Features

* **api:** manage webhook automations (create/list/delete) behind switch ([#16776](https://github.com/vm0-ai/vm0/issues/16776)) ([770e5e4](https://github.com/vm0-ai/vm0/commit/770e5e4a7e59448ae31d99464f0f2196174d8894))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.72.0
    * @vm0/connectors bumped to 1.54.0
    * @vm0/core bumped to 8.318.0
    * @vm0/db bumped to 1.35.1

## [1.116.2](https://github.com/vm0-ai/vm0/compare/api-v1.116.1...api-v1.116.2) (2026-06-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.35.0

## [1.116.1](https://github.com/vm0-ai/vm0/compare/api-v1.116.0...api-v1.116.1) (2026-06-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.71.2
    * @vm0/connectors bumped to 1.53.0
    * @vm0/core bumped to 8.317.3
    * @vm0/db bumped to 1.34.3

## [1.116.0](https://github.com/vm0-ai/vm0/compare/api-v1.115.1...api-v1.116.0) (2026-06-09)


### Features

* add presentation HTML editor ([#16728](https://github.com/vm0-ai/vm0/issues/16728)) ([b1c33ca](https://github.com/vm0-ai/vm0/commit/b1c33ca770a1b342bcb77b48172fe5638e1a4ac1))

## [1.115.1](https://github.com/vm0-ai/vm0/compare/api-v1.115.0...api-v1.115.1) (2026-06-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.71.1
    * @vm0/connectors bumped to 1.52.1
    * @vm0/core bumped to 8.317.2
    * @vm0/db bumped to 1.34.2

## [1.115.0](https://github.com/vm0-ai/vm0/compare/api-v1.114.0...api-v1.115.0) (2026-06-08)


### Features

* consolidate usage into Credit balance with per-source records ([#16192](https://github.com/vm0-ai/vm0/issues/16192)) ([b6c0795](https://github.com/vm0-ai/vm0/commit/b6c07954d332b99ca7b207fe8a9e608c64d98c7a))


### Bug Fixes

* move chat session switching to server ([#16702](https://github.com/vm0-ai/vm0/issues/16702)) ([0eac1be](https://github.com/vm0-ai/vm0/commit/0eac1be1b6e9368c417f5ba384e8c79d2de8123a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.71.0
    * @vm0/core bumped to 8.317.1
    * @vm0/db bumped to 1.34.1

## [1.114.0](https://github.com/vm0-ai/vm0/compare/api-v1.113.0...api-v1.114.0) (2026-06-08)


### Features

* add onboarding redeem code flow ([#16614](https://github.com/vm0-ai/vm0/issues/16614)) ([b09c0e1](https://github.com/vm0-ai/vm0/commit/b09c0e10a3ff53ebb694a8fc23a6e24ee0370eb0))
* collapse scheduled chat runs into cards ([#16579](https://github.com/vm0-ai/vm0/issues/16579)) ([068db4e](https://github.com/vm0-ai/vm0/commit/068db4efd32eb1e7651be7096bbd519079a106a8))
* **zero:** add Automations API over the shared schedule service ([#16674](https://github.com/vm0-ai/vm0/issues/16674)) ([5a01efc](https://github.com/vm0-ai/vm0/commit/5a01efcef4af070adcb0a2daaeb5debec7305e95))


### Bug Fixes

* reuse web chat send path for v1 messages ([#16701](https://github.com/vm0-ai/vm0/issues/16701)) ([e5a1b9a](https://github.com/vm0-ai/vm0/commit/e5a1b9a59c5eb24fd49a6d25dc0d0a537cfbfcfb))


### Refactoring

* **zero:** extract TimeTrigger and route poller + callbacks through it ([#16673](https://github.com/vm0-ai/vm0/issues/16673)) ([4a47a6e](https://github.com/vm0-ai/vm0/commit/4a47a6e0d50bec176a910ef52a381cc4064cfa78))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.70.0
    * @vm0/connectors bumped to 1.52.0
    * @vm0/core bumped to 8.317.0
    * @vm0/db bumped to 1.34.0

## [1.113.0](https://github.com/vm0-ai/vm0/compare/api-v1.112.0...api-v1.113.0) (2026-06-08)


### Features

* add desktop auto-update feed ([#16656](https://github.com/vm0-ai/vm0/issues/16656)) ([4d91842](https://github.com/vm0-ai/vm0/commit/4d9184289f3e159b88f6b84946776c3187bd1358))


### Refactoring

* **zero:** drop secrets/vars/volumeVersions from schedule surface ([#16645](https://github.com/vm0-ai/vm0/issues/16645)) ([cc78c7b](https://github.com/vm0-ai/vm0/commit/cc78c7b4f6b0c309597cee236ed4e4b2b43d56f1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.69.0
    * @vm0/core bumped to 8.316.0
    * @vm0/db bumped to 1.33.7

## [1.112.0](https://github.com/vm0-ai/vm0/compare/api-v1.111.1...api-v1.112.0) (2026-06-08)


### Features

* add presentation PPTX download ([#16515](https://github.com/vm0-ai/vm0/issues/16515)) ([983d5cc](https://github.com/vm0-ai/vm0/commit/983d5ccc406a0394a78dd0a7027f64d77f8e55c8))


### Performance Improvements

* defer chat callback terminal processing to background ([#16589](https://github.com/vm0-ai/vm0/issues/16589)) ([1360e3d](https://github.com/vm0-ai/vm0/commit/1360e3da069de6447050d1732d9eb10e99a90196))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.68.1
    * @vm0/connectors bumped to 1.51.0
    * @vm0/core bumped to 8.315.0
    * @vm0/db bumped to 1.33.6

## [1.111.1](https://github.com/vm0-ai/vm0/compare/api-v1.111.0...api-v1.111.1) (2026-06-08)


### CI

* manage stripe preview webhooks per pr ([#16524](https://github.com/vm0-ai/vm0/issues/16524)) ([8c8d9e9](https://github.com/vm0-ai/vm0/commit/8c8d9e988d23ee4505692dedcff17c0f914c1ef8))

## [1.111.0](https://github.com/vm0-ai/vm0/compare/api-v1.110.0...api-v1.111.0) (2026-06-07)


### Features

* expose chat artifact kind ([#16326](https://github.com/vm0-ai/vm0/issues/16326)) ([b5df16b](https://github.com/vm0-ai/vm0/commit/b5df16b892924d7209cb6101c1125c2d6e773fa9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.68.0
    * @vm0/core bumped to 8.314.3
    * @vm0/db bumped to 1.33.5

## [1.110.0](https://github.com/vm0-ai/vm0/compare/api-v1.109.1...api-v1.110.0) (2026-06-07)


### Features

* add connector device auth start options ([#16353](https://github.com/vm0-ai/vm0/issues/16353)) ([3a846f5](https://github.com/vm0-ai/vm0/commit/3a846f5e9fdd2884c874b96824de5701f85e8f3f))
* add device auth provider poll state ([#16405](https://github.com/vm0-ai/vm0/issues/16405)) ([84c8c72](https://github.com/vm0-ai/vm0/commit/84c8c72a572da4f830d6d54e1220e44e4597f625))
* add stripe cli dashboard connector ([#16418](https://github.com/vm0-ai/vm0/issues/16418)) ([852128d](https://github.com/vm0-ai/vm0/commit/852128d179c9fc89d3ec9b3d84d5daea36bd6a28))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.67.0
    * @vm0/connectors bumped to 1.50.0
    * @vm0/core bumped to 8.314.2
    * @vm0/db bumped to 1.33.4

## [1.109.1](https://github.com/vm0-ai/vm0/compare/api-v1.109.0...api-v1.109.1) (2026-06-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.66.3
    * @vm0/connectors bumped to 1.49.0
    * @vm0/core bumped to 8.314.1
    * @vm0/db bumped to 1.33.3

## [1.109.0](https://github.com/vm0-ai/vm0/compare/api-v1.108.1...api-v1.109.0) (2026-06-06)


### Features

* **chat-threads:** sort sidebar by last run-end time ([#16360](https://github.com/vm0-ai/vm0/issues/16360)) ([98f8edb](https://github.com/vm0-ai/vm0/commit/98f8edb2eeaff196ce67784df33ba4ae869c0b9e))


### Refactoring

* remove zero chat message send CLI command and backend ([#16359](https://github.com/vm0-ai/vm0/issues/16359)) ([14e189c](https://github.com/vm0-ai/vm0/commit/14e189c1c49d8092c9a466b643904bb4972e1cd5))
* stop accepting chatThreadId on schedule update and CLI ([#16357](https://github.com/vm0-ai/vm0/issues/16357)) ([1236779](https://github.com/vm0-ai/vm0/commit/1236779de0365a4b1be1ff00c364a9116f8e4a0f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.66.2
    * @vm0/core bumped to 8.314.0
    * @vm0/db bumped to 1.33.2

## [1.108.1](https://github.com/vm0-ai/vm0/compare/api-v1.108.0...api-v1.108.1) (2026-06-05)


### Bug Fixes

* treat expired connectors as reconnect required ([#16313](https://github.com/vm0-ai/vm0/issues/16313)) ([523c20b](https://github.com/vm0-ai/vm0/commit/523c20bcf51fb1e30e3b126b1e5a37357c866f85))


### Refactoring

* assume schedules always have a chat thread ([#16332](https://github.com/vm0-ai/vm0/issues/16332)) ([d371992](https://github.com/vm0-ai/vm0/commit/d371992d53c2681ed4b1b398ca881b095799f715))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.66.1
    * @vm0/core bumped to 8.313.2
    * @vm0/db bumped to 1.33.1

## [1.108.0](https://github.com/vm0-ai/vm0/compare/api-v1.107.3...api-v1.108.0) (2026-06-05)


### Features

* preserve hosted artifact kind ([#16316](https://github.com/vm0-ai/vm0/issues/16316)) ([d4befd9](https://github.com/vm0-ai/vm0/commit/d4befd9ff13968e9c3e2f2788ef1c178c8f875bb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.66.0
    * @vm0/core bumped to 8.313.1
    * @vm0/db bumped to 1.33.0

## [1.107.3](https://github.com/vm0-ai/vm0/compare/api-v1.107.2...api-v1.107.3) (2026-06-05)


### Bug Fixes

* reject incomplete memory summaries ([#16308](https://github.com/vm0-ai/vm0/issues/16308)) ([8bc74ad](https://github.com/vm0-ai/vm0/commit/8bc74ad4b3ff4c3735303cb57da79383248045a5))

## [1.107.2](https://github.com/vm0-ai/vm0/compare/api-v1.107.1...api-v1.107.2) (2026-06-05)


### Bug Fixes

* **api:** block claude loop skill in zero runs ([#16301](https://github.com/vm0-ai/vm0/issues/16301)) ([9795144](https://github.com/vm0-ai/vm0/commit/9795144f49731acb60b8ce27476f39c473333674))
* drain billing queues after entitlement updates ([#16298](https://github.com/vm0-ai/vm0/issues/16298)) ([58f5674](https://github.com/vm0-ai/vm0/commit/58f5674fb1bd2a57bb091274549e8726287cc297))
* stop schedules and runs when deleting a chat thread ([#16279](https://github.com/vm0-ai/vm0/issues/16279)) ([83efb00](https://github.com/vm0-ai/vm0/commit/83efb00210f82125ad875267a776c369898b562f))


### Performance Improvements

* route internal callback dispatch via internal api base url ([#16282](https://github.com/vm0-ai/vm0/issues/16282)) ([1b43e33](https://github.com/vm0-ai/vm0/commit/1b43e3324cb853a0ff8d5aeaea217e222bc2ac85))

## [1.107.1](https://github.com/vm0-ai/vm0/compare/api-v1.107.0...api-v1.107.1) (2026-06-05)


### Bug Fixes

* handle scheduled billing plan changes ([#16261](https://github.com/vm0-ai/vm0/issues/16261)) ([3453471](https://github.com/vm0-ai/vm0/commit/345347139ca5151393bacd9ab15951572f37d084))
* make memory summaries describe natural memory changes ([#16288](https://github.com/vm0-ai/vm0/issues/16288)) ([e46e829](https://github.com/vm0-ai/vm0/commit/e46e8294e1c70f3859152cb4768651c5c3e84fac))
* remove auto memory generated provenance ([#16284](https://github.com/vm0-ai/vm0/issues/16284)) ([59bef75](https://github.com/vm0-ai/vm0/commit/59bef75742fda0653c0d4df413144c93c639ec2f))
* remove lark connector feature switch ([#16289](https://github.com/vm0-ai/vm0/issues/16289)) ([844fb53](https://github.com/vm0-ai/vm0/commit/844fb53259a5eba2600e02a90ce0255f8383b3f9))


### Performance Improvements

* dispatch agent event consumers in-process ([#16286](https://github.com/vm0-ai/vm0/issues/16286)) ([28c9b42](https://github.com/vm0-ai/vm0/commit/28c9b42df2cb91cfc589f29c0dec692b1f966ad2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.65.2
    * @vm0/connectors bumped to 1.48.1
    * @vm0/core bumped to 8.313.0
    * @vm0/db bumped to 1.32.4

## [1.107.0](https://github.com/vm0-ai/vm0/compare/api-v1.106.0...api-v1.107.0) (2026-06-05)


### Features

* roll out scheduled chat ([#16260](https://github.com/vm0-ai/vm0/issues/16260)) ([00bf130](https://github.com/vm0-ai/vm0/commit/00bf130980a3989ee7b48b6f13ad05fc681ec9ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.312.0

## [1.106.0](https://github.com/vm0-ai/vm0/compare/api-v1.105.0...api-v1.106.0) (2026-06-05)


### Features

* add sandbox claim timing spans ([#16264](https://github.com/vm0-ai/vm0/issues/16264)) ([bfef241](https://github.com/vm0-ai/vm0/commit/bfef2416317ca36253f05a2ebf8f19377b7b9f9b))


### Bug Fixes

* remove schedule chat migration flow ([#16262](https://github.com/vm0-ai/vm0/issues/16262)) ([5df9c43](https://github.com/vm0-ai/vm0/commit/5df9c43dadd24b3b03ea5c68b7331052bd446613))
* render memory summaries as markdown ([#16265](https://github.com/vm0-ai/vm0/issues/16265)) ([391e64f](https://github.com/vm0-ai/vm0/commit/391e64f33522f64d090b544d837e414a43172bcd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.65.1
    * @vm0/core bumped to 8.311.1
    * @vm0/db bumped to 1.32.3

## [1.105.0](https://github.com/vm0-ai/vm0/compare/api-v1.104.1...api-v1.105.0) (2026-06-05)


### Features

* add memory dev refresh ([#16244](https://github.com/vm0-ai/vm0/issues/16244)) ([95f3877](https://github.com/vm0-ai/vm0/commit/95f387719cc9b1d18eed2340ab6cad3039961c13))


### Bug Fixes

* preserve missing auto-memory artifact roots ([#16245](https://github.com/vm0-ai/vm0/issues/16245)) ([44cd72a](https://github.com/vm0-ai/vm0/commit/44cd72a947c260572181cf6735e2ecbfe85624d8))
* preserve sandbox operation timestamps ([#16257](https://github.com/vm0-ai/vm0/issues/16257)) ([0ce68fd](https://github.com/vm0-ai/vm0/commit/0ce68fda135563ce87491fe615a4933a7c8c0df1))
* remove follow-up prompt length limit ([#16209](https://github.com/vm0-ai/vm0/issues/16209)) ([e9baf7f](https://github.com/vm0-ai/vm0/commit/e9baf7f927947c99a1843e28ffa0f525c96aed53))


### Refactoring

* rename connector env binding availability metadata ([#16225](https://github.com/vm0-ai/vm0/issues/16225)) ([9a8a399](https://github.com/vm0-ai/vm0/commit/9a8a3999233d20cc71a12efde256c9c216a8aa57))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.65.0
    * @vm0/connectors bumped to 1.48.0
    * @vm0/core bumped to 8.311.0
    * @vm0/db bumped to 1.32.2

## [1.104.1](https://github.com/vm0-ai/vm0/compare/api-v1.104.0...api-v1.104.1) (2026-06-05)


### Bug Fixes

* auto-create chat threads for scheduled chat ([#16220](https://github.com/vm0-ai/vm0/issues/16220)) ([3109b21](https://github.com/vm0-ai/vm0/commit/3109b2180e76a0e6ef6c645152c0ee325bcb479b))
* backfill schedule chat threads ([#16218](https://github.com/vm0-ai/vm0/issues/16218)) ([8081d91](https://github.com/vm0-ai/vm0/commit/8081d91d611a8f7b387cf8cdf4c1f5e655fa28d1))
* persist thread composer model selection ([#16219](https://github.com/vm0-ai/vm0/issues/16219)) ([b1e7682](https://github.com/vm0-ai/vm0/commit/b1e768217fab71380d4b4dc3f0f72f5fabb7379a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.64.1
    * @vm0/core bumped to 8.310.2
    * @vm0/db bumped to 1.32.1

## [1.104.0](https://github.com/vm0-ai/vm0/compare/api-v1.103.0...api-v1.104.0) (2026-06-04)


### Features

* migrate legacy schedules to chat thread from schedules page ([#16215](https://github.com/vm0-ai/vm0/issues/16215)) ([f103975](https://github.com/vm0-ai/vm0/commit/f103975ad8fe77ab4b350c223740f215a67e92ee))


### Bug Fixes

* migrate Lark to refresh-token access ([#16198](https://github.com/vm0-ai/vm0/issues/16198)) ([748faae](https://github.com/vm0-ai/vm0/commit/748faae0abe2ee087ef13923f1aa202f1d623dcc))


### Refactoring

* replace connector provided env names ([#16212](https://github.com/vm0-ai/vm0/issues/16212)) ([defceb5](https://github.com/vm0-ai/vm0/commit/defceb5b08717af9228f1c7021bc54fdf7ab7893))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.64.0
    * @vm0/connectors bumped to 1.47.1
    * @vm0/core bumped to 8.310.1
    * @vm0/db bumped to 1.32.0

## [1.103.0](https://github.com/vm0-ai/vm0/compare/api-v1.102.0...api-v1.103.0) (2026-06-04)


### Features

* scope chat header schedule menu to the thread and refresh it in realtime ([#16208](https://github.com/vm0-ai/vm0/issues/16208)) ([6a3ed06](https://github.com/vm0-ai/vm0/commit/6a3ed060531645250e875c1dbba1ac119b6e665f))

## [1.102.0](https://github.com/vm0-ai/vm0/compare/api-v1.101.0...api-v1.102.0) (2026-06-04)


### Features

* paginate memory activity updates ([#16204](https://github.com/vm0-ai/vm0/issues/16204)) ([45522b7](https://github.com/vm0-ai/vm0/commit/45522b73f613d08ec66a8d21123962bff37faf05))
* run schedules as web-chat turns in a linked chat thread ([#16176](https://github.com/vm0-ai/vm0/issues/16176)) ([f403258](https://github.com/vm0-ai/vm0/commit/f4032589b6c024852293bb4ee16f2ea1a22e9c87))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.63.0
    * @vm0/connectors bumped to 1.47.0
    * @vm0/core bumped to 8.310.0
    * @vm0/db bumped to 1.31.0

## [1.101.0](https://github.com/vm0-ai/vm0/compare/api-v1.100.0...api-v1.101.0) (2026-06-04)


### Features

* show template on sent chat messages ([#16191](https://github.com/vm0-ai/vm0/issues/16191)) ([0083a37](https://github.com/vm0-ai/vm0/commit/0083a37acbde5e348758bffb4a93bb8f046476ed))


### Bug Fixes

* show memory index diffs separately ([#16183](https://github.com/vm0-ai/vm0/issues/16183)) ([f2cf8e8](https://github.com/vm0-ai/vm0/commit/f2cf8e8ddc9b4ed5933f492db1e5af296eca98d8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.62.0
    * @vm0/core bumped to 8.309.12
    * @vm0/db bumped to 1.30.1

## [1.100.0](https://github.com/vm0-ai/vm0/compare/api-v1.99.0...api-v1.100.0) (2026-06-04)


### Features

* simplify memory activity updates ([#16175](https://github.com/vm0-ai/vm0/issues/16175)) ([6187410](https://github.com/vm0-ai/vm0/commit/618741097fc725534135efcdb4690818d26ba233))


### Refactoring

* group connector auth providers by connector ([#16174](https://github.com/vm0-ai/vm0/issues/16174)) ([0cd90bf](https://github.com/vm0-ai/vm0/commit/0cd90bf76236f55c40a76d023ee47cc4dc7e3a84))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.61.0
    * @vm0/connectors bumped to 1.46.2
    * @vm0/core bumped to 8.309.11
    * @vm0/db bumped to 1.30.0

## [1.99.0](https://github.com/vm0-ai/vm0/compare/api-v1.98.7...api-v1.99.0) (2026-06-04)


### Features

* add structured memory activity diffs ([#16145](https://github.com/vm0-ai/vm0/issues/16145)) ([7b91b35](https://github.com/vm0-ai/vm0/commit/7b91b357292ecb5611ab5f98b2ae9e5909ed4fbf))


### Bug Fixes

* sanitize artifact filename consistently across upload and message storage ([#16042](https://github.com/vm0-ai/vm0/issues/16042)) ([7e4b497](https://github.com/vm0-ai/vm0/commit/7e4b49701a09943a05b844c0a76b8b2f6471ea4b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.60.0
    * @vm0/core bumped to 8.309.10
    * @vm0/db bumped to 1.29.0

## [1.98.7](https://github.com/vm0-ai/vm0/compare/api-v1.98.6...api-v1.98.7) (2026-06-04)


### Refactoring

* normalize connector type naming ([#16115](https://github.com/vm0-ai/vm0/issues/16115)) ([507236c](https://github.com/vm0-ai/vm0/commit/507236c5006123dc4d8aef21624243ff4b18c037))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.59.6
    * @vm0/connectors bumped to 1.46.1
    * @vm0/core bumped to 8.309.9
    * @vm0/db bumped to 1.28.7

## [1.98.6](https://github.com/vm0-ai/vm0/compare/api-v1.98.5...api-v1.98.6) (2026-06-04)


### Bug Fixes

* **api:** ignore stale onboarding pending for paid orgs ([#16033](https://github.com/vm0-ai/vm0/issues/16033)) ([da7b043](https://github.com/vm0-ai/vm0/commit/da7b0432c913ed17410b785e9b8add336e314c02))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.59.5
    * @vm0/connectors bumped to 1.46.0
    * @vm0/core bumped to 8.309.8
    * @vm0/db bumped to 1.28.6

## [1.98.5](https://github.com/vm0-ai/vm0/compare/api-v1.98.4...api-v1.98.5) (2026-06-04)


### Bug Fixes

* **api:** summarize only yesterday and gate memory cron by feature switch ([#16098](https://github.com/vm0-ai/vm0/issues/16098)) ([9ccb50b](https://github.com/vm0-ai/vm0/commit/9ccb50bd7bc5a34931130774ca784e03e41c2d4c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.59.4
    * @vm0/core bumped to 8.309.7
    * @vm0/db bumped to 1.28.5

## [1.98.4](https://github.com/vm0-ai/vm0/compare/api-v1.98.3...api-v1.98.4) (2026-06-04)


### Bug Fixes

* materialize cached artifact mount roots ([#16083](https://github.com/vm0-ai/vm0/issues/16083)) ([d6a4ed3](https://github.com/vm0-ai/vm0/commit/d6a4ed307b5c4aeac8edb400aec1f65369d5f781))

## [1.98.3](https://github.com/vm0-ai/vm0/compare/api-v1.98.2...api-v1.98.3) (2026-06-04)


### Bug Fixes

* preserve canonical auto memory missing roots ([#16053](https://github.com/vm0-ai/vm0/issues/16053)) ([a3ea955](https://github.com/vm0-ai/vm0/commit/a3ea955d7e4d968d155cd70beed1a95a1a7d1109))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.59.3
    * @vm0/core bumped to 8.309.6
    * @vm0/db bumped to 1.28.4

## [1.98.2](https://github.com/vm0-ai/vm0/compare/api-v1.98.1...api-v1.98.2) (2026-06-04)


### Bug Fixes

* **api:** handle invalid memory frontmatter in summary cron ([#16045](https://github.com/vm0-ai/vm0/issues/16045)) ([b49ed30](https://github.com/vm0-ai/vm0/commit/b49ed3021c9097eea14a761870205c824920e863))


### Refactoring

* separate connector grant result types ([#16037](https://github.com/vm0-ai/vm0/issues/16037)) ([77a2994](https://github.com/vm0-ai/vm0/commit/77a2994cf5bd943b68df074aecc9c33c2865d6d3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.59.2
    * @vm0/connectors bumped to 1.45.3
    * @vm0/core bumped to 8.309.5
    * @vm0/db bumped to 1.28.3

## [1.98.1](https://github.com/vm0-ai/vm0/compare/api-v1.98.0...api-v1.98.1) (2026-06-03)


### Refactoring

* generalize model-provider refresh boundary ([#16032](https://github.com/vm0-ai/vm0/issues/16032)) ([3bdb4c3](https://github.com/vm0-ai/vm0/commit/3bdb4c3978e70f2f7403e35dbcdd7101adf9cd58))
* generalize refreshable access mappings ([#15984](https://github.com/vm0-ai/vm0/issues/15984)) ([f844436](https://github.com/vm0-ai/vm0/commit/f8444365caa37d90e92bdcaeb14fb38b7cb01b49))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.59.1
    * @vm0/connectors bumped to 1.45.2
    * @vm0/core bumped to 8.309.4
    * @vm0/db bumped to 1.28.2

## [1.98.0](https://github.com/vm0-ai/vm0/compare/api-v1.97.0...api-v1.98.0) (2026-06-03)


### Features

* add generation template chat contract ([#16011](https://github.com/vm0-ai/vm0/issues/16011)) ([511bb29](https://github.com/vm0-ai/vm0/commit/511bb29ded2c017a7651292151c7235bca930336))


### Bug Fixes

* **api:** make memory activity item ordering deterministic ([#16016](https://github.com/vm0-ai/vm0/issues/16016)) ([c01da32](https://github.com/vm0-ai/vm0/commit/c01da3276abd86763a9c7945fb5f43c91f78f262))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.59.0
    * @vm0/core bumped to 8.309.3
    * @vm0/db bumped to 1.28.1

## [1.97.0](https://github.com/vm0-ai/vm0/compare/api-v1.96.1...api-v1.97.0) (2026-06-03)


### Features

* **api:** add memory activity read endpoint ([#15998](https://github.com/vm0-ai/vm0/issues/15998)) ([0f98a9c](https://github.com/vm0-ai/vm0/commit/0f98a9c6f413343b56fb45e03801ff34e6773baf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.58.0
    * @vm0/core bumped to 8.309.2
    * @vm0/db bumped to 1.28.0

## [1.96.1](https://github.com/vm0-ai/vm0/compare/api-v1.96.0...api-v1.96.1) (2026-06-03)


### Bug Fixes

* preserve missing auto memory artifact checkpoints ([#15964](https://github.com/vm0-ai/vm0/issues/15964)) ([020dc4a](https://github.com/vm0-ai/vm0/commit/020dc4a62cd90237639396419ccee1ba85d7d4d0))
* use finicity app secret env ([#15988](https://github.com/vm0-ai/vm0/issues/15988)) ([69f3125](https://github.com/vm0-ai/vm0/commit/69f31251fb459b3edbb905d1f31478cde5c7a969))


### Refactoring

* retire legacy zero permission approval paths ([#15978](https://github.com/vm0-ai/vm0/issues/15978)) ([ed43996](https://github.com/vm0-ai/vm0/commit/ed43996269688f9b255ecc6839b5e0496b99ce15))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.57.1
    * @vm0/connectors bumped to 1.45.1
    * @vm0/core bumped to 8.309.1
    * @vm0/db bumped to 1.27.0

## [1.96.0](https://github.com/vm0-ai/vm0/compare/api-v1.95.4...api-v1.96.0) (2026-06-03)


### Features

* add chat follow-up suggestions ([#15876](https://github.com/vm0-ai/vm0/issues/15876)) ([79a56ee](https://github.com/vm0-ai/vm0/commit/79a56eeea76b3bf5a4e20d1a3f500026c8fe6c62))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.57.0
    * @vm0/connectors bumped to 1.45.0
    * @vm0/core bumped to 8.309.0
    * @vm0/db bumped to 1.26.0

## [1.95.4](https://github.com/vm0-ai/vm0/compare/api-v1.95.3...api-v1.95.4) (2026-06-03)


### Bug Fixes

* remove stripe checkout flow metadata ([#15904](https://github.com/vm0-ai/vm0/issues/15904)) ([800ef1c](https://github.com/vm0-ai/vm0/commit/800ef1cc528288d1867aaa12eb97ce8e54bf992b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.308.4

## [1.95.3](https://github.com/vm0-ai/vm0/compare/api-v1.95.2...api-v1.95.3) (2026-06-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.56.3
    * @vm0/connectors bumped to 1.44.2
    * @vm0/core bumped to 8.308.3
    * @vm0/db bumped to 1.25.4

## [1.95.2](https://github.com/vm0-ai/vm0/compare/api-v1.95.1...api-v1.95.2) (2026-06-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.56.2
    * @vm0/core bumped to 8.308.2
    * @vm0/db bumped to 1.25.3

## [1.95.1](https://github.com/vm0-ai/vm0/compare/api-v1.95.0...api-v1.95.1) (2026-06-02)


### Refactoring

* type connector auth provider args by method ([#15892](https://github.com/vm0-ai/vm0/issues/15892)) ([3207904](https://github.com/vm0-ai/vm0/commit/32079047b3404f139a1912e86943f886b925a8f0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.56.1
    * @vm0/connectors bumped to 1.44.1
    * @vm0/core bumped to 8.308.1
    * @vm0/db bumped to 1.25.2

## [1.95.0](https://github.com/vm0-ai/vm0/compare/api-v1.94.0...api-v1.95.0) (2026-06-02)


### Features

* add github pr tracking in chat threads ([#15867](https://github.com/vm0-ai/vm0/issues/15867)) ([4756f5e](https://github.com/vm0-ai/vm0/commit/4756f5e53c3e2b011773680fbf994634b2c4b890))
* add read-only memory viewer page to platform ([#15901](https://github.com/vm0-ai/vm0/issues/15901)) ([6edb542](https://github.com/vm0-ai/vm0/commit/6edb5421c366c5ec98f8e4d24db261c3271dd946))


### Bug Fixes

* add reusable zero host slug suffixes ([#15869](https://github.com/vm0-ai/vm0/issues/15869)) ([563d67f](https://github.com/vm0-ai/vm0/commit/563d67f6a59c05606f650c4e9d64571b526b890a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.56.0
    * @vm0/connectors bumped to 1.44.0
    * @vm0/core bumped to 8.308.0
    * @vm0/db bumped to 1.25.1

## [1.94.0](https://github.com/vm0-ai/vm0/compare/api-v1.93.0...api-v1.94.0) (2026-06-02)


### Features

* add zero banking gateway ([#15698](https://github.com/vm0-ai/vm0/issues/15698)) ([c24743c](https://github.com/vm0-ai/vm0/commit/c24743c8eea487201545458c9d8f3400d772473f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.55.0
    * @vm0/connectors bumped to 1.43.0
    * @vm0/core bumped to 8.307.0
    * @vm0/db bumped to 1.25.0

## [1.93.0](https://github.com/vm0-ai/vm0/compare/api-v1.92.0...api-v1.93.0) (2026-06-02)


### Features

* add org skills library page ([#15816](https://github.com/vm0-ai/vm0/issues/15816)) ([fc7e26f](https://github.com/vm0-ai/vm0/commit/fc7e26f2c38bfa84ed424c5ee38c28487aeed99c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.54.0
    * @vm0/connectors bumped to 1.42.0
    * @vm0/core bumped to 8.306.0
    * @vm0/db bumped to 1.24.7

## [1.92.0](https://github.com/vm0-ai/vm0/compare/api-v1.91.4...api-v1.92.0) (2026-06-02)


### Features

* **cli:** show permission wording from grant rollout ([#15860](https://github.com/vm0-ai/vm0/issues/15860)) ([cd0b814](https://github.com/vm0-ai/vm0/commit/cd0b814897f2283f82b31993767c42faa3ce1e53))


### Bug Fixes

* **api:** clean up user permission grants on user deletion ([#15857](https://github.com/vm0-ai/vm0/issues/15857)) ([e42ad22](https://github.com/vm0-ai/vm0/commit/e42ad22fdd1dd7403fdaac7df2f7df3a892fbd10))


### Refactoring

* make connector storage ownership explicit ([#15853](https://github.com/vm0-ai/vm0/issues/15853)) ([921b75f](https://github.com/vm0-ai/vm0/commit/921b75fd143449178d9b14f011b8c33b10deb2f0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.53.0
    * @vm0/connectors bumped to 1.41.2
    * @vm0/core bumped to 8.305.6
    * @vm0/db bumped to 1.24.6

## [1.91.4](https://github.com/vm0-ai/vm0/compare/api-v1.91.3...api-v1.91.4) (2026-06-02)


### Bug Fixes

* remove poor agent backend models ([#15807](https://github.com/vm0-ai/vm0/issues/15807)) ([e73e675](https://github.com/vm0-ai/vm0/commit/e73e675f6fa38e199634b37734f2f73a56437a62))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.52.2
    * @vm0/core bumped to 8.305.5
    * @vm0/db bumped to 1.24.5

## [1.91.3](https://github.com/vm0-ai/vm0/compare/api-v1.91.2...api-v1.91.3) (2026-06-02)


### Refactoring

* centralize permission grant policy folding ([#15817](https://github.com/vm0-ai/vm0/issues/15817)) ([df5e219](https://github.com/vm0-ai/vm0/commit/df5e2199404af850eba3e4de8c13289724afe4ff))
* scope legacy manual grant cleanup ([#15814](https://github.com/vm0-ai/vm0/issues/15814)) ([25c59f8](https://github.com/vm0-ai/vm0/commit/25c59f87e561cd71da1678905167de2de7ea8476))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.52.1
    * @vm0/connectors bumped to 1.41.1
    * @vm0/core bumped to 8.305.4
    * @vm0/db bumped to 1.24.4

## [1.91.2](https://github.com/vm0-ai/vm0/compare/api-v1.91.1...api-v1.91.2) (2026-06-02)


### Bug Fixes

* **api:** move cron schedules to api deployment ([#15784](https://github.com/vm0-ai/vm0/issues/15784)) ([cdcd2f4](https://github.com/vm0-ai/vm0/commit/cdcd2f42802b50b641adf5d6eda1065a1b3ee901))
* reject invalid zero chat model selections ([#15796](https://github.com/vm0-ai/vm0/issues/15796)) ([3f053ed](https://github.com/vm0-ai/vm0/commit/3f053ede91dc67ff4ba7f063ac4053275fa97b31))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.52.0
    * @vm0/connectors bumped to 1.41.0
    * @vm0/core bumped to 8.305.3
    * @vm0/db bumped to 1.24.3

## [1.91.1](https://github.com/vm0-ai/vm0/compare/api-v1.91.0...api-v1.91.1) (2026-06-02)


### Bug Fixes

* **api:** schedule computer-use screenshot cleanup cron ([#15775](https://github.com/vm0-ai/vm0/issues/15775)) ([b659164](https://github.com/vm0-ai/vm0/commit/b659164fa3209b89d9d42ee8dde879e749ea7d26))

## [1.91.0](https://github.com/vm0-ai/vm0/compare/api-v1.90.10...api-v1.91.0) (2026-06-01)


### Features

* add user permission grants api ([#15727](https://github.com/vm0-ai/vm0/issues/15727)) ([d866875](https://github.com/vm0-ai/vm0/commit/d8668757f060fc37bd54c7e0b1368500c880ce38))
* **api:** tighten no-getter-setter-params to catch aliased + object-field Getter/Setter ([#15734](https://github.com/vm0-ai/vm0/issues/15734)) ([#15749](https://github.com/vm0-ai/vm0/issues/15749)) ([b277490](https://github.com/vm0-ai/vm0/commit/b277490ec736a9cc22f92f2bc20f9ea2f410f27c))
* resolve zero run permissions from user grants ([#15755](https://github.com/vm0-ai/vm0/issues/15755)) ([92a9366](https://github.com/vm0-ai/vm0/commit/92a936663bd72dd61a1e16490eebf8f478c69b94))


### Bug Fixes

* add subscription checkout metadata ([#15753](https://github.com/vm0-ai/vm0/issues/15753)) ([681480d](https://github.com/vm0-ai/vm0/commit/681480d04ec3f75909593c26df037c9c6b9ecbb9))
* keep computer-use heartbeat active during commands ([#15750](https://github.com/vm0-ai/vm0/issues/15750)) ([7747131](https://github.com/vm0-ai/vm0/commit/7747131dd5eadf61965388ef3b4777235be02ab9))
* preserve signup attribution in stripe metadata ([#15759](https://github.com/vm0-ai/vm0/issues/15759)) ([eaca49b](https://github.com/vm0-ai/vm0/commit/eaca49be6a4cc398937f6102079d525d171b73d2))


### Refactoring

* **api:** model agent-run-create.service.ts helpers as computed ([#15643](https://github.com/vm0-ai/vm0/issues/15643)) ([#15669](https://github.com/vm0-ai/vm0/issues/15669)) ([a135552](https://github.com/vm0-ai/vm0/commit/a1355520312fe62ecdd154077fd23f262a9bf2a8))
* **api:** model agent-run-storage.service.ts helpers as computed ([#15644](https://github.com/vm0-ai/vm0/issues/15644)) ([#15664](https://github.com/vm0-ai/vm0/issues/15664)) ([5e75c9e](https://github.com/vm0-ai/vm0/commit/5e75c9e7bd4dd0aeb1814f84067958627dc1aed8))
* **api:** model claude-code-device-auth.service.ts helpers as command ([#15735](https://github.com/vm0-ai/vm0/issues/15735)) ([#15741](https://github.com/vm0-ai/vm0/issues/15741)) ([d21f16a](https://github.com/vm0-ai/vm0/commit/d21f16a5f95c659b9322377b4f192653cab5a653))
* **api:** model codex-device-auth.service.ts helpers as command ([#15736](https://github.com/vm0-ai/vm0/issues/15736)) ([#15743](https://github.com/vm0-ai/vm0/issues/15743)) ([0c49591](https://github.com/vm0-ai/vm0/commit/0c49591773ffe16936abf26d6fe77f0ce228945d))
* **api:** model cron-aggregate-insights.service.ts helpers as computed ([#15645](https://github.com/vm0-ai/vm0/issues/15645)) ([#15666](https://github.com/vm0-ai/vm0/issues/15666)) ([2ad70a5](https://github.com/vm0-ai/vm0/commit/2ad70a564f4a38ff58122493567e39e81b264187))
* **api:** model cron-sync-skills.service.ts helpers as computed ([#15647](https://github.com/vm0-ai/vm0/issues/15647)) ([#15662](https://github.com/vm0-ai/vm0/issues/15662)) ([2c8de89](https://github.com/vm0-ai/vm0/commit/2c8de8902587cbd8ba0b3f8aa1670558329aea41))
* **api:** model diagnostic-bundle.service.ts helpers as computed ([#15648](https://github.com/vm0-ai/vm0/issues/15648)) ([#15665](https://github.com/vm0-ai/vm0/issues/15665)) ([0b69629](https://github.com/vm0-ai/vm0/commit/0b69629f80236c4aa694d6496a1dfc5166ca7c44))
* **api:** model runners.ts helpers as command ([#15638](https://github.com/vm0-ai/vm0/issues/15638)) ([#15658](https://github.com/vm0-ai/vm0/issues/15658)) ([75fdfd0](https://github.com/vm0-ai/vm0/commit/75fdfd0580919387d22a480c826926074b1452f4))
* **api:** model storage-write.service.ts helpers as computed ([#15650](https://github.com/vm0-ai/vm0/issues/15650)) ([#15675](https://github.com/vm0-ai/vm0/issues/15675)) ([d6b73b3](https://github.com/vm0-ai/vm0/commit/d6b73b34ff90e2405fe61c4dad936a47dc87303e))
* **api:** model webhooks-clerk-cleanup.service.ts helpers as command ([#15651](https://github.com/vm0-ai/vm0/issues/15651)) ([#15672](https://github.com/vm0-ai/vm0/issues/15672)) ([b9cf84d](https://github.com/vm0-ai/vm0/commit/b9cf84dc43f0509037c2f73128ec731f582b88d8))
* **api:** model webhooks-github.service.ts helpers as command ([#15652](https://github.com/vm0-ai/vm0/issues/15652)) ([#15670](https://github.com/vm0-ai/vm0/issues/15670)) ([2c44b7e](https://github.com/vm0-ai/vm0/commit/2c44b7e7700a717808463099450bc8b3151a7f70))
* **api:** model zero-agentphone.service.ts helpers as command ([#15653](https://github.com/vm0-ai/vm0/issues/15653)) ([#15676](https://github.com/vm0-ai/vm0/issues/15676)) ([0c1c644](https://github.com/vm0-ai/vm0/commit/0c1c6445353b5354aa8609c016154f4f97d6e211))
* **api:** model zero-email-inbound.ts helpers as command ([#15639](https://github.com/vm0-ai/vm0/issues/15639)) ([#15661](https://github.com/vm0-ai/vm0/issues/15661)) ([839b790](https://github.com/vm0-ai/vm0/commit/839b7909c97a077b55f5397dc9f1fa342fa5f7dc))
* **api:** model zero-integrations-slack.ts helpers as computed ([#15640](https://github.com/vm0-ai/vm0/issues/15640)) ([#15667](https://github.com/vm0-ai/vm0/issues/15667)) ([d4dc6f4](https://github.com/vm0-ai/vm0/commit/d4dc6f46c56291b5a47c8242c479770c49153edc))
* **api:** model zero-slack-oauth.ts helpers as command ([#15641](https://github.com/vm0-ai/vm0/issues/15641)) ([#15663](https://github.com/vm0-ai/vm0/issues/15663)) ([c014e3f](https://github.com/vm0-ai/vm0/commit/c014e3fa4d09f0f1bd746aaded35e86f33bdba18))
* **api:** model zero-slack-webhooks.service.ts helpers as command ([#15655](https://github.com/vm0-ai/vm0/issues/15655)) ([#15678](https://github.com/vm0-ai/vm0/issues/15678)) ([fe8b2ca](https://github.com/vm0-ai/vm0/commit/fe8b2cac85baee79cc208d69c07f79ba0451dbb5))
* **api:** model zero-telegram-dispatch.service.ts helpers as command ([#15656](https://github.com/vm0-ai/vm0/issues/15656)) ([#15673](https://github.com/vm0-ai/vm0/issues/15673)) ([465792d](https://github.com/vm0-ai/vm0/commit/465792d4a29467de3b4131416ee3109984342168))
* **api:** model zero-telegram-post.service.ts helpers as command ([#15657](https://github.com/vm0-ai/vm0/issues/15657)) ([#15682](https://github.com/vm0-ai/vm0/issues/15682)) ([51e9a61](https://github.com/vm0-ai/vm0/commit/51e9a61765c03ad8e671fe88a017a763314c168e))
* derive platform secrets from access config ([#15739](https://github.com/vm0-ai/vm0/issues/15739)) ([45d6def](https://github.com/vm0-ai/vm0/commit/45d6def9bec9822671272fd4ebb3b5379b50f5af))
* move legacy file redirects to api ([#15732](https://github.com/vm0-ai/vm0/issues/15732)) ([372e41e](https://github.com/vm0-ai/vm0/commit/372e41e54a10b1dc4a86ee3fe5aab28efb11b0f9))
* remove connector auth provider capability helpers ([#15763](https://github.com/vm0-ai/vm0/issues/15763)) ([06f81cc](https://github.com/vm0-ai/vm0/commit/06f81cc498f3f3b705cefc0daf8e085af7625b51))
* share connector-owned access secret bindings ([#15760](https://github.com/vm0-ai/vm0/issues/15760)) ([cfc51b1](https://github.com/vm0-ai/vm0/commit/cfc51b163c1f1a72bd18cb8794ea2d10273cac9d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.51.0
    * @vm0/connectors bumped to 1.40.1
    * @vm0/core bumped to 8.305.2
    * @vm0/db bumped to 1.24.2

## [1.90.10](https://github.com/vm0-ai/vm0/compare/api-v1.90.9...api-v1.90.10) (2026-06-01)


### Bug Fixes

* prevent lower-tier checkout replacement ([#15623](https://github.com/vm0-ai/vm0/issues/15623)) ([5382807](https://github.com/vm0-ai/vm0/commit/5382807e08a67fa9495fe93a2a0fcc658a4d45c7))
* validate chat thread path ids ([#15691](https://github.com/vm0-ai/vm0/issues/15691)) ([19eeffa](https://github.com/vm0-ai/vm0/commit/19eeffa13693e13dc41509b096e2ad7a37d3ebfe))


### Refactoring

* remove connector session handoff ([#15689](https://github.com/vm0-ai/vm0/issues/15689)) ([1ea6d2a](https://github.com/vm0-ai/vm0/commit/1ea6d2a3aa5a0db8d8b6118cba818210a5a49df6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.50.9
    * @vm0/core bumped to 8.305.1
    * @vm0/db bumped to 1.24.1

## [1.90.9](https://github.com/vm0-ai/vm0/compare/api-v1.90.8...api-v1.90.9) (2026-06-01)


### Bug Fixes

* **api:** handle duplicate client message ids ([#15627](https://github.com/vm0-ai/vm0/issues/15627)) ([a57b209](https://github.com/vm0-ai/vm0/commit/a57b209e57b2904b082d59059a1d94b49e0caddb))


### Refactoring

* split api and web env templates ([#15679](https://github.com/vm0-ai/vm0/issues/15679)) ([6e4773e](https://github.com/vm0-ai/vm0/commit/6e4773e2356b60686e906b31b146a480b2e96823))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.50.8
    * @vm0/connectors bumped to 1.40.0
    * @vm0/core bumped to 8.305.0
    * @vm0/db bumped to 1.24.0

## [1.90.8](https://github.com/vm0-ai/vm0/compare/api-v1.90.7...api-v1.90.8) (2026-06-01)


### Bug Fixes

* **api:** bound axiom log search run filters ([#15618](https://github.com/vm0-ai/vm0/issues/15618)) ([bb77816](https://github.com/vm0-ai/vm0/commit/bb778169bef76b9136fef0e9118b56aa427bc556))
* **api:** handle duplicate client thread ids ([#15619](https://github.com/vm0-ai/vm0/issues/15619)) ([b7e16cb](https://github.com/vm0-ai/vm0/commit/b7e16cb57dedc7340528a3bb176a04ceb62357ea))


### Refactoring

* hardcode runner working directory ([#15606](https://github.com/vm0-ai/vm0/issues/15606)) ([132296d](https://github.com/vm0-ai/vm0/commit/132296da082953e4cdeb796c8a4432e07cd38c20))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.50.7
    * @vm0/connectors bumped to 1.39.6
    * @vm0/core bumped to 8.304.9
    * @vm0/db bumped to 1.23.12

## [1.90.7](https://github.com/vm0-ai/vm0/compare/api-v1.90.6...api-v1.90.7) (2026-06-01)


### Bug Fixes

* reject zero run permission policy overrides ([#15608](https://github.com/vm0-ai/vm0/issues/15608)) ([ac92dda](https://github.com/vm0-ai/vm0/commit/ac92dda1c295d2b71d4e84d3536dbd5843718d5c))


### Refactoring

* centralize connector lifecycle provider registry ([#15596](https://github.com/vm0-ai/vm0/issues/15596)) ([d8767a4](https://github.com/vm0-ai/vm0/commit/d8767a4a92bda3bd220377639950d16f37300ade))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.50.6
    * @vm0/connectors bumped to 1.39.5
    * @vm0/core bumped to 8.304.8
    * @vm0/db bumped to 1.23.11

## [1.90.6](https://github.com/vm0-ai/vm0/compare/api-v1.90.5...api-v1.90.6) (2026-06-01)


### Bug Fixes

* block suspended org uploads ([#15591](https://github.com/vm0-ai/vm0/issues/15591)) ([0c2fc41](https://github.com/vm0-ai/vm0/commit/0c2fc415d2da084c040c7b6594512a66b95b87cd))


### Performance Improvements

* **computer-use:** store screenshots in object storage instead of jsonb ([#15404](https://github.com/vm0-ai/vm0/issues/15404)) ([e743943](https://github.com/vm0-ai/vm0/commit/e74394382c14df85ecbc761564859dc0bf0b23bf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.50.5
    * @vm0/core bumped to 8.304.7
    * @vm0/db bumped to 1.23.10

## [1.90.5](https://github.com/vm0-ai/vm0/compare/api-v1.90.4...api-v1.90.5) (2026-06-01)


### Bug Fixes

* enforce reconnect-required firewall auth state ([#15585](https://github.com/vm0-ai/vm0/issues/15585)) ([956d2a9](https://github.com/vm0-ai/vm0/commit/956d2a90be5ff299c2d1cbce9ae784b8d1b322a9))

## [1.90.4](https://github.com/vm0-ai/vm0/compare/api-v1.90.3...api-v1.90.4) (2026-05-31)


### Refactoring

* support multiple connector auth methods ([#15582](https://github.com/vm0-ai/vm0/issues/15582)) ([e00abe8](https://github.com/vm0-ai/vm0/commit/e00abe8ce57f5e14d56dfe8b1ae0e18e2e1e1ef1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.50.4
    * @vm0/connectors bumped to 1.39.4
    * @vm0/core bumped to 8.304.6
    * @vm0/db bumped to 1.23.9

## [1.90.3](https://github.com/vm0-ai/vm0/compare/api-v1.90.2...api-v1.90.3) (2026-05-31)


### Refactoring

* bind connector grant providers to auth methods ([#15574](https://github.com/vm0-ai/vm0/issues/15574)) ([0082e33](https://github.com/vm0-ai/vm0/commit/0082e33df69733193a88272008add2e5610e2617))
* preserve connector auth method selection ([#15559](https://github.com/vm0-ai/vm0/issues/15559)) ([d3931bb](https://github.com/vm0-ai/vm0/commit/d3931bb34ce30fce1278e79a7ad20d411f3d4605))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.50.3
    * @vm0/connectors bumped to 1.39.3
    * @vm0/core bumped to 8.304.5
    * @vm0/db bumped to 1.23.8

## [1.90.2](https://github.com/vm0-ai/vm0/compare/api-v1.90.1...api-v1.90.2) (2026-05-31)


### Bug Fixes

* bound firewall auth refresh requests ([#15546](https://github.com/vm0-ai/vm0/issues/15546)) ([a3a301d](https://github.com/vm0-ai/vm0/commit/a3a301dffd5dd9e9de7942c2e2774b1b6c3b4885))


### Refactoring

* route manual connector grants by method ([#15541](https://github.com/vm0-ai/vm0/issues/15541)) ([65eaa81](https://github.com/vm0-ai/vm0/commit/65eaa8144bd0096f741114f97362eeb69a50e503))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.50.2
    * @vm0/connectors bumped to 1.39.2
    * @vm0/core bumped to 8.304.4
    * @vm0/db bumped to 1.23.7

## [1.90.1](https://github.com/vm0-ai/vm0/compare/api-v1.90.0...api-v1.90.1) (2026-05-31)


### Bug Fixes

* add firewall auth failure reason ([#15386](https://github.com/vm0-ai/vm0/issues/15386)) ([6c7e09c](https://github.com/vm0-ai/vm0/commit/6c7e09c76e9a184478fddbcb1a9ceefdc94bb3f2))


### Refactoring

* bind connector revoke providers to auth method ([#15457](https://github.com/vm0-ai/vm0/issues/15457)) ([6e1a2b8](https://github.com/vm0-ai/vm0/commit/6e1a2b8dd09e6cf8e26d91f327c66601aa5a5e02))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.50.1
    * @vm0/connectors bumped to 1.39.1
    * @vm0/core bumped to 8.304.3
    * @vm0/db bumped to 1.23.6

## [1.90.0](https://github.com/vm0-ai/vm0/compare/api-v1.89.0...api-v1.90.0) (2026-05-30)


### Features

* persist raw ad click IDs for offline conversion import ([#15500](https://github.com/vm0-ai/vm0/issues/15500)) ([55b15d8](https://github.com/vm0-ai/vm0/commit/55b15d8ff1b2b02b1bbad9a519a089115c1d1755))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.50.0
    * @vm0/connectors bumped to 1.39.0
    * @vm0/core bumped to 8.304.2
    * @vm0/db bumped to 1.23.5

## [1.89.0](https://github.com/vm0-ai/vm0/compare/api-v1.88.4...api-v1.89.0) (2026-05-30)


### Features

* persist ad attribution to Stripe and Clerk ([#15451](https://github.com/vm0-ai/vm0/issues/15451)) ([920f02e](https://github.com/vm0-ai/vm0/commit/920f02e53e47602e87c195ba37fadc71de43f6a1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.49.0
    * @vm0/core bumped to 8.304.1
    * @vm0/db bumped to 1.23.4

## [1.88.4](https://github.com/vm0-ai/vm0/compare/api-v1.88.3...api-v1.88.4) (2026-05-30)


### Bug Fixes

* filter unavailable connector types from agent user-connectors GET ([#15459](https://github.com/vm0-ai/vm0/issues/15459)) ([76edd36](https://github.com/vm0-ai/vm0/commit/76edd36994a569a473d766c6aaffbe2ac45bb21a))


### Refactoring

* retire connector auth provider secret metadata ([#15445](https://github.com/vm0-ai/vm0/issues/15445)) ([c03de8c](https://github.com/vm0-ai/vm0/commit/c03de8cad5d2205ebca244c564ef6796cf11d02c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.48.3
    * @vm0/connectors bumped to 1.38.2
    * @vm0/core bumped to 8.304.0
    * @vm0/db bumped to 1.23.3

## [1.88.3](https://github.com/vm0-ai/vm0/compare/api-v1.88.2...api-v1.88.3) (2026-05-30)


### Refactoring

* clean connector oauth naming ([#15440](https://github.com/vm0-ai/vm0/issues/15440)) ([98ecec6](https://github.com/vm0-ai/vm0/commit/98ecec6297caf5065693159ba417caf654f88149))
* split connector access provider registry ([#15432](https://github.com/vm0-ai/vm0/issues/15432)) ([5eab41a](https://github.com/vm0-ai/vm0/commit/5eab41ade4769804987d43789e591bac21d790aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.48.2
    * @vm0/connectors bumped to 1.38.1
    * @vm0/core bumped to 8.303.1
    * @vm0/db bumped to 1.23.2

## [1.88.2](https://github.com/vm0-ai/vm0/compare/api-v1.88.1...api-v1.88.2) (2026-05-29)


### Bug Fixes

* avoid stale access after refresh failure ([#15422](https://github.com/vm0-ai/vm0/issues/15422)) ([3675d03](https://github.com/vm0-ai/vm0/commit/3675d03631954d96ea6201687b61e50d3f721c0f))

## [1.88.1](https://github.com/vm0-ai/vm0/compare/api-v1.88.0...api-v1.88.1) (2026-05-29)


### Bug Fixes

* disable GitHub label session continuity ([#15417](https://github.com/vm0-ai/vm0/issues/15417)) ([32f8d31](https://github.com/vm0-ai/vm0/commit/32f8d310f880fce20dfc863d0c1955f80bf43f2a))
* serialize runtime oauth refresh ([#15405](https://github.com/vm0-ai/vm0/issues/15405)) ([d05156c](https://github.com/vm0-ai/vm0/commit/d05156c3a4877119212dcac29f95f0d86b755f8d))
* use chat model selection for schedules ([#15409](https://github.com/vm0-ai/vm0/issues/15409)) ([8e7747f](https://github.com/vm0-ai/vm0/commit/8e7747fb053101fd3677ab140cdc55aa41172006))


### Refactoring

* rename connector auth provider apis ([#15421](https://github.com/vm0-ai/vm0/issues/15421)) ([15e7958](https://github.com/vm0-ai/vm0/commit/15e7958aab5442657a125b33dab229f47d1033d4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.48.1
    * @vm0/connectors bumped to 1.38.0
    * @vm0/core bumped to 8.303.0
    * @vm0/db bumped to 1.23.1

## [1.88.0](https://github.com/vm0-ai/vm0/compare/api-v1.87.2...api-v1.88.0) (2026-05-29)


### Features

* **onboarding:** add role picker on step 1 and gallery on trial step ([#15334](https://github.com/vm0-ai/vm0/issues/15334)) ([ec0b632](https://github.com/vm0-ai/vm0/commit/ec0b6326c2eb49db1d869c3a2db53d40537bd5a9))


### Refactoring

* resolve connector auth clients by method ([#15392](https://github.com/vm0-ai/vm0/issues/15392)) ([d602fea](https://github.com/vm0-ai/vm0/commit/d602feaf9b0d5eca469bf7e5a3508c5ada0a6806))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.48.0
    * @vm0/connectors bumped to 1.37.8
    * @vm0/core bumped to 8.302.4
    * @vm0/db bumped to 1.23.0

## [1.87.2](https://github.com/vm0-ai/vm0/compare/api-v1.87.1...api-v1.87.2) (2026-05-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.47.1
    * @vm0/connectors bumped to 1.37.7
    * @vm0/core bumped to 8.302.3
    * @vm0/db bumped to 1.22.5

## [1.87.1](https://github.com/vm0-ai/vm0/compare/api-v1.87.0...api-v1.87.1) (2026-05-29)


### Bug Fixes

* show negative org credit balances ([#15383](https://github.com/vm0-ai/vm0/issues/15383)) ([cfd3cb7](https://github.com/vm0-ai/vm0/commit/cfd3cb769b6b1164fcdcd46fe728f7826836c07d))
* unify credit checkout pricing ([#15380](https://github.com/vm0-ai/vm0/issues/15380)) ([9e65342](https://github.com/vm0-ai/vm0/commit/9e65342d6e605579499d42f23f938ecc631f3a5d))

## [1.87.0](https://github.com/vm0-ai/vm0/compare/api-v1.86.0...api-v1.87.0) (2026-05-29)


### Features

* **platform:** add buy credits section to billing settings ([#15365](https://github.com/vm0-ai/vm0/issues/15365)) ([2816d0d](https://github.com/vm0-ai/vm0/commit/2816d0d0b05eb5436c82cc9bac1451255e356756))


### Bug Fixes

* allow zero tokens to manage credit checkout ([#15358](https://github.com/vm0-ai/vm0/issues/15358)) ([b220f32](https://github.com/vm0-ai/vm0/commit/b220f32577741af5e30017b72b884f0172b29ec6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.47.0
    * @vm0/core bumped to 8.302.2
    * @vm0/db bumped to 1.22.4

## [1.86.0](https://github.com/vm0-ai/vm0/compare/api-v1.85.1...api-v1.86.0) (2026-05-29)


### Features

* add permission request realtime refresh ([#15356](https://github.com/vm0-ai/vm0/issues/15356)) ([e2868a9](https://github.com/vm0-ai/vm0/commit/e2868a99aee635fbe288872fa20c30f0a3fd384d))


### Bug Fixes

* allow promo codes for credit checkouts ([#15361](https://github.com/vm0-ai/vm0/issues/15361)) ([a04e585](https://github.com/vm0-ai/vm0/commit/a04e5851bc7afe5126450a67e3f49886c3d07e1e))
* harden auto recharge setup ([#15364](https://github.com/vm0-ai/vm0/issues/15364)) ([e75d12c](https://github.com/vm0-ai/vm0/commit/e75d12c927037591842954858c033603e19e9ab2))
* require kms secret envelopes ([#15339](https://github.com/vm0-ai/vm0/issues/15339)) ([bc95653](https://github.com/vm0-ai/vm0/commit/bc95653928fe2516c8e030c23590faaea3f12fd3))

## [1.85.1](https://github.com/vm0-ai/vm0/compare/api-v1.85.0...api-v1.85.1) (2026-05-29)


### Refactoring

* derive connector checks from lifecycle config ([#15328](https://github.com/vm0-ai/vm0/issues/15328)) ([d910717](https://github.com/vm0-ai/vm0/commit/d9107173fb255846c20e46d903852cf449aceae3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.46.1
    * @vm0/connectors bumped to 1.37.6
    * @vm0/core bumped to 8.302.1
    * @vm0/db bumped to 1.22.3

## [1.85.0](https://github.com/vm0-ai/vm0/compare/api-v1.84.1...api-v1.85.0) (2026-05-29)


### Features

* add Claude Opus 4.8 model ([#15330](https://github.com/vm0-ai/vm0/issues/15330)) ([e8b94fb](https://github.com/vm0-ai/vm0/commit/e8b94fb259268057d0717166c15c0b5bbc403e45))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.46.0
    * @vm0/core bumped to 8.302.0
    * @vm0/db bumped to 1.22.2

## [1.84.1](https://github.com/vm0-ai/vm0/compare/api-v1.84.0...api-v1.84.1) (2026-05-28)


### Refactoring

* cut over api-token connectors to connector state ([#15232](https://github.com/vm0-ai/vm0/issues/15232)) ([2e949a2](https://github.com/vm0-ai/vm0/commit/2e949a2c49ff35851b5441514d864b9d5c4c7efd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.45.1
    * @vm0/connectors bumped to 1.37.5
    * @vm0/core bumped to 8.301.2
    * @vm0/db bumped to 1.22.1

## [1.84.0](https://github.com/vm0-ai/vm0/compare/api-v1.83.2...api-v1.84.0) (2026-05-28)


### Features

* add generation-aware runner session affinity ([#15246](https://github.com/vm0-ai/vm0/issues/15246)) ([141473b](https://github.com/vm0-ai/vm0/commit/141473b3e36af6392d0fd8fc6734ee223e6729e4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.45.0
    * @vm0/core bumped to 8.301.1
    * @vm0/db bumped to 1.22.0

## [1.83.2](https://github.com/vm0-ai/vm0/compare/api-v1.83.1...api-v1.83.2) (2026-05-28)


### Bug Fixes

* hide stale queued chat indicators ([#15260](https://github.com/vm0-ai/vm0/issues/15260)) ([733ff65](https://github.com/vm0-ai/vm0/commit/733ff654479010412e84dfbc050e968c8daee0e0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.21.2

## [1.83.1](https://github.com/vm0-ai/vm0/compare/api-v1.83.0...api-v1.83.1) (2026-05-28)


### Bug Fixes

* ignore blank chat assistant output ([#15257](https://github.com/vm0-ai/vm0/issues/15257)) ([eb055ff](https://github.com/vm0-ai/vm0/commit/eb055ff95de057d8f1f909794e78077057ecd24b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.21.1

## [1.83.0](https://github.com/vm0-ai/vm0/compare/api-v1.82.0...api-v1.83.0) (2026-05-28)


### Features

* add chat run lifecycle markers ([#15210](https://github.com/vm0-ai/vm0/issues/15210)) ([9c9b4b9](https://github.com/vm0-ai/vm0/commit/9c9b4b9a765810d5868cdafd9dbddd4d1b3f16f3))


### Bug Fixes

* make zero run cancellation race-safe ([#15200](https://github.com/vm0-ai/vm0/issues/15200)) ([13f8903](https://github.com/vm0-ai/vm0/commit/13f890374a8712c4faf9177608dd51a6c70b5eb0))


### Refactoring

* rename slack oauth client env vars ([#15238](https://github.com/vm0-ai/vm0/issues/15238)) ([7e34661](https://github.com/vm0-ai/vm0/commit/7e346611c003d45b9e6cea5fe63b13e067becf9d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.44.0
    * @vm0/connectors bumped to 1.37.4
    * @vm0/core bumped to 8.301.0
    * @vm0/db bumped to 1.21.0

## [1.82.0](https://github.com/vm0-ai/vm0/compare/api-v1.81.0...api-v1.82.0) (2026-05-28)


### Features

* add run-based web chat context ([#15207](https://github.com/vm0-ai/vm0/issues/15207)) ([4d1a9ca](https://github.com/vm0-ai/vm0/commit/4d1a9ca3482cdbdcb3f0e6970b536ad7f41b18bd))

## [1.81.0](https://github.com/vm0-ai/vm0/compare/api-v1.80.1...api-v1.81.0) (2026-05-27)


### Features

* mention agent-browser in zero system prompt ([#15191](https://github.com/vm0-ai/vm0/issues/15191)) ([e9fe46e](https://github.com/vm0-ai/vm0/commit/e9fe46e75ee802c18ae5c3a66b5511220c9f5a8e))


### Bug Fixes

* harden runner job expiry claims ([#15189](https://github.com/vm0-ai/vm0/issues/15189)) ([6caac75](https://github.com/vm0-ai/vm0/commit/6caac75d4f464d71fbb2e93b49b3f5a532bd1ead))


### Refactoring

* add connector variable ownership foundation ([#15187](https://github.com/vm0-ai/vm0/issues/15187)) ([53aec3b](https://github.com/vm0-ai/vm0/commit/53aec3b3499e80ec114d0bebba482e3f3ca9f867))
* rename model provider auth sessions ([#15186](https://github.com/vm0-ai/vm0/issues/15186)) ([643ad27](https://github.com/vm0-ai/vm0/commit/643ad2720215d7bd32bba6580ee4bab832b16201))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.43.1
    * @vm0/connectors bumped to 1.37.3
    * @vm0/core bumped to 8.300.3
    * @vm0/db bumped to 1.20.3

## [1.80.1](https://github.com/vm0-ai/vm0/compare/api-v1.80.0...api-v1.80.1) (2026-05-27)


### Bug Fixes

* use consistent manual connector snapshot for runs ([#15102](https://github.com/vm0-ai/vm0/issues/15102)) ([5e27a91](https://github.com/vm0-ai/vm0/commit/5e27a9187aec003b49faad79c0a5de4f57a30893))

## [1.80.0](https://github.com/vm0-ai/vm0/compare/api-v1.79.1...api-v1.80.0) (2026-05-27)


### Features

* simplify computer use command output ([#15152](https://github.com/vm0-ai/vm0/issues/15152)) ([81007c6](https://github.com/vm0-ai/vm0/commit/81007c6be3b2649d5f3ea9bf1be3a3faa4d6adf8))


### Bug Fixes

* add compare plans links for integration credit errors ([#15070](https://github.com/vm0-ai/vm0/issues/15070)) ([18b3bb7](https://github.com/vm0-ai/vm0/commit/18b3bb7aeb67bf7bde47d293f743ba193d912019))
* **zero:** gate local-agent skill and token access ([#15149](https://github.com/vm0-ai/vm0/issues/15149)) ([f388ae2](https://github.com/vm0-ai/vm0/commit/f388ae2b1ab2cf012fc4d4795596b443b6db6481))


### Refactoring

* model slock oauth client as dynamic ([#15142](https://github.com/vm0-ai/vm0/issues/15142)) ([a55ce78](https://github.com/vm0-ai/vm0/commit/a55ce78ef218ed5cf16d30a21e725cd730f6ce5c))
* **web:** move rankings query behind public api ([#15154](https://github.com/vm0-ai/vm0/issues/15154)) ([15b7398](https://github.com/vm0-ai/vm0/commit/15b739812c0330ae8d68822e4c3b502e69ef2660))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.43.0
    * @vm0/connectors bumped to 1.37.2
    * @vm0/core bumped to 8.300.2
    * @vm0/db bumped to 1.20.2

## [1.79.1](https://github.com/vm0-ai/vm0/compare/api-v1.79.0...api-v1.79.1) (2026-05-27)


### Bug Fixes

* write persistent secrets with kms only ([#15129](https://github.com/vm0-ai/vm0/issues/15129)) ([1312000](https://github.com/vm0-ai/vm0/commit/13120008ef96aa6a378f58fa9b384e4846bd9fbe))


### Refactoring

* prune connector utility exports ([#15132](https://github.com/vm0-ai/vm0/issues/15132)) ([4df6f99](https://github.com/vm0-ai/vm0/commit/4df6f99f69e9cbea9f15dd4cb3add8eb52f20cab))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.42.5
    * @vm0/connectors bumped to 1.37.1
    * @vm0/core bumped to 8.300.1
    * @vm0/db bumped to 1.20.1

## [1.79.0](https://github.com/vm0-ai/vm0/compare/api-v1.78.2...api-v1.79.0) (2026-05-27)


### Features

* add nano banana 2 image generation ([#15122](https://github.com/vm0-ai/vm0/issues/15122)) ([ee43836](https://github.com/vm0-ai/vm0/commit/ee43836a706e4f6d8fdfddef95dd119f4533f711))


### Refactoring

* align connector lifecycle checks ([#15115](https://github.com/vm0-ai/vm0/issues/15115)) ([ead9783](https://github.com/vm0-ai/vm0/commit/ead97835707696396efa8a57fea46fe0c6297477))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.42.4
    * @vm0/connectors bumped to 1.37.0
    * @vm0/core bumped to 8.300.0
    * @vm0/db bumped to 1.20.0

## [1.78.2](https://github.com/vm0-ai/vm0/compare/api-v1.78.1...api-v1.78.2) (2026-05-27)


### Bug Fixes

* validate claude tool list entries ([#15092](https://github.com/vm0-ai/vm0/issues/15092)) ([7f48d58](https://github.com/vm0-ai/vm0/commit/7f48d5836cd891200f3b0a4159aad9d0ad59726f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.42.3
    * @vm0/core bumped to 8.299.1
    * @vm0/db bumped to 1.19.3

## [1.78.1](https://github.com/vm0-ai/vm0/compare/api-v1.78.0...api-v1.78.1) (2026-05-27)


### Bug Fixes

* harden runner claim lifecycle ([#15091](https://github.com/vm0-ai/vm0/issues/15091)) ([6de4d34](https://github.com/vm0-ai/vm0/commit/6de4d340fd951702c7e4dc2b8149f61c66ad27a6))


### Refactoring

* rename runtime env bindings ([#15089](https://github.com/vm0-ai/vm0/issues/15089)) ([60f703a](https://github.com/vm0-ai/vm0/commit/60f703a79f621c8d583e106c395a62adea9f6676))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.42.2
    * @vm0/connectors bumped to 1.36.6
    * @vm0/core bumped to 8.299.0
    * @vm0/db bumped to 1.19.2

## [1.78.0](https://github.com/vm0-ai/vm0/compare/api-v1.77.0...api-v1.78.0) (2026-05-27)


### Features

* **cli:** unify generate command (replace doctor + built-in generate) ([#15071](https://github.com/vm0-ai/vm0/issues/15071)) ([b8f60a6](https://github.com/vm0-ai/vm0/commit/b8f60a6de1eae6ee3d6ce3a65d5cccd6f320136d))
* enable zero maps ([#15085](https://github.com/vm0-ai/vm0/issues/15085)) ([992069b](https://github.com/vm0-ai/vm0/commit/992069ba162f19702d57d31ee9d20e4967541367))


### Bug Fixes

* add connector-aware api-token connect ([#15069](https://github.com/vm0-ai/vm0/issues/15069)) ([18fe5e4](https://github.com/vm0-ai/vm0/commit/18fe5e48906d34a331b5e58e3647c046412a1a1d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.42.1
    * @vm0/connectors bumped to 1.36.5
    * @vm0/core bumped to 8.298.0
    * @vm0/db bumped to 1.19.1

## [1.77.0](https://github.com/vm0-ai/vm0/compare/api-v1.76.3...api-v1.77.0) (2026-05-27)


### Features

* add Pro features + 7-day trial onboarding step ([#14348](https://github.com/vm0-ai/vm0/issues/14348)) ([dad9a48](https://github.com/vm0-ai/vm0/commit/dad9a48110ee2e5e3871f73d494a27bc3fc7bb46))


### Refactoring

* rename connector oauth client resolution ([#15064](https://github.com/vm0-ai/vm0/issues/15064)) ([6fad31e](https://github.com/vm0-ai/vm0/commit/6fad31ec416a8ea6f4ad3a38ed319a0a140cefbe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.42.0
    * @vm0/connectors bumped to 1.36.4
    * @vm0/core bumped to 8.297.4
    * @vm0/db bumped to 1.19.0

## [1.76.3](https://github.com/vm0-ai/vm0/compare/api-v1.76.2...api-v1.76.3) (2026-05-27)


### Bug Fixes

* ignore unbound github app webhooks ([#15048](https://github.com/vm0-ai/vm0/issues/15048)) ([d30579e](https://github.com/vm0-ai/vm0/commit/d30579e752c23f5740c884ea0c762c3e106ea15f))


### Refactoring

* remove stripe cli auth ([#15047](https://github.com/vm0-ai/vm0/issues/15047)) ([3e4a698](https://github.com/vm0-ai/vm0/commit/3e4a69802b2c255e2879305efce1592b08941acf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.41.5
    * @vm0/connectors bumped to 1.36.3
    * @vm0/core bumped to 8.297.3
    * @vm0/db bumped to 1.18.22

## [1.76.2](https://github.com/vm0-ai/vm0/compare/api-v1.76.1...api-v1.76.2) (2026-05-27)


### Bug Fixes

* stop dual-writing stored secrets ([#14975](https://github.com/vm0-ai/vm0/issues/14975)) ([b93ff4e](https://github.com/vm0-ai/vm0/commit/b93ff4ed89a6b402fdce0dc5c120b0e9d76100d0))


### Refactoring

* remove computer connector ([#15026](https://github.com/vm0-ai/vm0/issues/15026)) ([65bde32](https://github.com/vm0-ai/vm0/commit/65bde32845381c27f46858770762ab531a8565cc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.41.4
    * @vm0/connectors bumped to 1.36.2
    * @vm0/core bumped to 8.297.2
    * @vm0/db bumped to 1.18.21

## [1.76.1](https://github.com/vm0-ai/vm0/compare/api-v1.76.0...api-v1.76.1) (2026-05-26)


### Bug Fixes

* align connector feature gate follow-ups ([#15024](https://github.com/vm0-ai/vm0/issues/15024)) ([d41002b](https://github.com/vm0-ai/vm0/commit/d41002b319849570badd15ed728e41e5235f85c6))
* gate connector entry points by feature switches ([#15005](https://github.com/vm0-ai/vm0/issues/15005)) ([5b0cd83](https://github.com/vm0-ai/vm0/commit/5b0cd834a401571f9040fb277ef80e13239ad1ad))
* validate model provider env placeholders in runner ([#15002](https://github.com/vm0-ai/vm0/issues/15002)) ([44177d8](https://github.com/vm0-ai/vm0/commit/44177d8d154bfa727ee9500a9dc1d221ff21da29))


### Refactoring

* clarify manual grant field names ([#15025](https://github.com/vm0-ai/vm0/issues/15025)) ([d8e37b8](https://github.com/vm0-ai/vm0/commit/d8e37b8d58933861598cf73ab855e9744398d773))
* remove oauth token endpoint auth metadata ([#15017](https://github.com/vm0-ai/vm0/issues/15017)) ([165f954](https://github.com/vm0-ai/vm0/commit/165f954dce70a920c5b9c2f1b59ec06a067c59df))
* simplify connector auth method lookup ([#15020](https://github.com/vm0-ai/vm0/issues/15020)) ([429e4ee](https://github.com/vm0-ai/vm0/commit/429e4ee28f3be8fc4cf7306479dd636047639455))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.41.3
    * @vm0/connectors bumped to 1.36.1
    * @vm0/core bumped to 8.297.1
    * @vm0/db bumped to 1.18.20

## [1.76.0](https://github.com/vm0-ai/vm0/compare/api-v1.75.0...api-v1.76.0) (2026-05-26)


### Features

* expose slock connector without feature switch ([#15007](https://github.com/vm0-ai/vm0/issues/15007)) ([dba7317](https://github.com/vm0-ai/vm0/commit/dba73170e9f925bb5b44c152a4c8afc7f3cc4537))


### Bug Fixes

* scope pinned chat threads to the requested agent ([#15000](https://github.com/vm0-ai/vm0/issues/15000)) ([5d89665](https://github.com/vm0-ai/vm0/commit/5d89665639383505679e348d3472302831553fbf))


### Refactoring

* derive manual credential connector state ([#15008](https://github.com/vm0-ai/vm0/issues/15008)) ([abe9dc6](https://github.com/vm0-ai/vm0/commit/abe9dc6f77496a050ab0b0a311b329c03aca7dc8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.41.2
    * @vm0/connectors bumped to 1.36.0
    * @vm0/core bumped to 8.297.0
    * @vm0/db bumped to 1.18.19

## [1.75.0](https://github.com/vm0-ai/vm0/compare/api-v1.74.1...api-v1.75.0) (2026-05-26)


### Features

* add Slock OAuth device connector ([#14922](https://github.com/vm0-ai/vm0/issues/14922)) ([0245428](https://github.com/vm0-ai/vm0/commit/02454282990b75242da2a0e05d39f3801f8e09ea))


### Bug Fixes

* keep model provider secrets out of sandbox env ([#14984](https://github.com/vm0-ai/vm0/issues/14984)) ([e2fa7e2](https://github.com/vm0-ai/vm0/commit/e2fa7e2e1ba270e2bf4b9b7175bcf28d3f9bc2b7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.41.1
    * @vm0/connectors bumped to 1.35.0
    * @vm0/core bumped to 8.296.0
    * @vm0/db bumped to 1.18.18

## [1.74.1](https://github.com/vm0-ai/vm0/compare/api-v1.74.0...api-v1.74.1) (2026-05-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.41.0
    * @vm0/core bumped to 8.295.1
    * @vm0/db bumped to 1.18.17

## [1.74.0](https://github.com/vm0-ai/vm0/compare/api-v1.73.0...api-v1.74.0) (2026-05-26)


### Features

* enable google ads connector for everyone ([#14911](https://github.com/vm0-ai/vm0/issues/14911)) ([bbb2480](https://github.com/vm0-ai/vm0/commit/bbb24801eaa8161642354cfe27ec97192446a11b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.295.0

## [1.73.0](https://github.com/vm0-ai/vm0/compare/api-v1.72.7...api-v1.73.0) (2026-05-26)


### Features

* make base44 connector generally available ([#14909](https://github.com/vm0-ai/vm0/issues/14909)) ([5bea76c](https://github.com/vm0-ai/vm0/commit/5bea76c103ccbebdd3017b033bef8ff159f8eaf1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.40.5
    * @vm0/connectors bumped to 1.34.0
    * @vm0/core bumped to 8.294.0
    * @vm0/db bumped to 1.18.16

## [1.72.7](https://github.com/vm0-ai/vm0/compare/api-v1.72.6...api-v1.72.7) (2026-05-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.40.4
    * @vm0/connectors bumped to 1.33.4
    * @vm0/core bumped to 8.293.6
    * @vm0/db bumped to 1.18.15

## [1.72.6](https://github.com/vm0-ai/vm0/compare/api-v1.72.5...api-v1.72.6) (2026-05-26)


### Bug Fixes

* prevent stale computer-use hosts from reactivating ([#14915](https://github.com/vm0-ai/vm0/issues/14915)) ([5732e94](https://github.com/vm0-ai/vm0/commit/5732e9456429c15ac4506c58944ee7ba3926bef4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.40.3
    * @vm0/core bumped to 8.293.5
    * @vm0/db bumped to 1.18.14

## [1.72.5](https://github.com/vm0-ai/vm0/compare/api-v1.72.4...api-v1.72.5) (2026-05-26)


### Bug Fixes

* add static website hosting context ([#14907](https://github.com/vm0-ai/vm0/issues/14907)) ([af1204d](https://github.com/vm0-ai/vm0/commit/af1204d019a80b6711283f176ab9114909f2dc68))

## [1.72.4](https://github.com/vm0-ai/vm0/compare/api-v1.72.3...api-v1.72.4) (2026-05-26)


### Bug Fixes

* make file delivery prompt contextual ([#14898](https://github.com/vm0-ai/vm0/issues/14898)) ([b211d23](https://github.com/vm0-ai/vm0/commit/b211d23dca3dc0ca781f604589da60ffbd0d262d))

## [1.72.3](https://github.com/vm0-ai/vm0/compare/api-v1.72.2...api-v1.72.3) (2026-05-25)


### Refactoring

* migrate connector auth callers to lifecycle helpers ([#14894](https://github.com/vm0-ai/vm0/issues/14894)) ([8e4b85e](https://github.com/vm0-ai/vm0/commit/8e4b85e071c5dceee8d5013885f2d452e91ec75f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.40.2
    * @vm0/connectors bumped to 1.33.3
    * @vm0/core bumped to 8.293.4
    * @vm0/db bumped to 1.18.13

## [1.72.2](https://github.com/vm0-ai/vm0/compare/api-v1.72.1...api-v1.72.2) (2026-05-25)


### Refactoring

* remove open design generate switch ([#14873](https://github.com/vm0-ai/vm0/issues/14873)) ([f3c647a](https://github.com/vm0-ai/vm0/commit/f3c647a3a38bb841bcfbfd12c1193ff007529fe8))


### Performance Improvements

* add side-effect-free API GET benches ([#14801](https://github.com/vm0-ai/vm0/issues/14801)) ([1756446](https://github.com/vm0-ai/vm0/commit/1756446b320d2e05bf374305af63956208482e52))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.40.1
    * @vm0/connectors bumped to 1.33.2
    * @vm0/core bumped to 8.293.3
    * @vm0/db bumped to 1.18.12

## [1.72.1](https://github.com/vm0-ai/vm0/compare/api-v1.72.0...api-v1.72.1) (2026-05-25)


### Refactoring

* **connectors:** replace stripe cli auth client polling with ably push ([#14879](https://github.com/vm0-ai/vm0/issues/14879)) ([5ed9106](https://github.com/vm0-ai/vm0/commit/5ed9106d155e55cd42ab288188d9f90d0b1a2e8d))

## [1.72.0](https://github.com/vm0-ai/vm0/compare/api-v1.71.1...api-v1.72.0) (2026-05-25)


### Features

* add GitHub bot mention connects ([#14560](https://github.com/vm0-ai/vm0/issues/14560)) ([4b5af7c](https://github.com/vm0-ai/vm0/commit/4b5af7c6216c7926626217f1cfb614f6ee99e034))


### Refactoring

* split connector auth lifecycle config ([#14808](https://github.com/vm0-ai/vm0/issues/14808)) ([dd05010](https://github.com/vm0-ai/vm0/commit/dd050100fc134a4c44c1cf2afd0a539402abddf0))


### Performance Improvements

* **api:** reduce type-aware oxlint scope ([#14852](https://github.com/vm0-ai/vm0/issues/14852)) ([a5934a1](https://github.com/vm0-ai/vm0/commit/a5934a152bbbb274c920f243915d33b5b73c97cf))
* persist chat message attachment metadata ([#14857](https://github.com/vm0-ai/vm0/issues/14857)) ([37cad3b](https://github.com/vm0-ai/vm0/commit/37cad3b92a310f80e986b0b310d14cb89d0f2685))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.40.0
    * @vm0/connectors bumped to 1.33.1
    * @vm0/core bumped to 8.293.2
    * @vm0/db bumped to 1.18.11

## [1.71.1](https://github.com/vm0-ai/vm0/compare/api-v1.71.0...api-v1.71.1) (2026-05-25)


### Bug Fixes

* inject connector env at run creation ([#14820](https://github.com/vm0-ai/vm0/issues/14820)) ([68a4844](https://github.com/vm0-ai/vm0/commit/68a48441b4c05ccd25d9599dd2b4e7be808aa450))

## [1.71.0](https://github.com/vm0-ai/vm0/compare/api-v1.70.2...api-v1.71.0) (2026-05-25)


### Features

* render connector authorize links in chat ([#14812](https://github.com/vm0-ai/vm0/issues/14812)) ([064be36](https://github.com/vm0-ai/vm0/commit/064be36a17bc98595837d3b89ec3a29b82ea540f))


### Bug Fixes

* restore platform url origins ([#14829](https://github.com/vm0-ai/vm0/issues/14829)) ([247134a](https://github.com/vm0-ai/vm0/commit/247134a2c0b7f30681badd6d38c0319153970b23))


### Refactoring

* remove trinity voice chat ([#14814](https://github.com/vm0-ai/vm0/issues/14814)) ([512de4a](https://github.com/vm0-ai/vm0/commit/512de4a0c22e356065e32a66596ae450e6e647cf))
* remove web agent compose leftovers ([#14821](https://github.com/vm0-ai/vm0/issues/14821)) ([03150f3](https://github.com/vm0-ai/vm0/commit/03150f3f8ae823b9e3456b7704ba6444197c5f73))
* remove web realtime leftovers ([#14817](https://github.com/vm0-ai/vm0/issues/14817)) ([1df512d](https://github.com/vm0-ai/vm0/commit/1df512d6640eb0707c2499bd2a5431223016bf0d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.39.2
    * @vm0/connectors bumped to 1.33.0
    * @vm0/core bumped to 8.293.1
    * @vm0/db bumped to 1.18.10

## [1.70.2](https://github.com/vm0-ai/vm0/compare/api-v1.70.1...api-v1.70.2) (2026-05-25)


### Refactoring

* **api:** wrap integration model route in command ([#14798](https://github.com/vm0-ai/vm0/issues/14798)) ([725f1fb](https://github.com/vm0-ai/vm0/commit/725f1fbc971e38b33a167f1fad328f61994b7a45))
* remove web callback infra leftovers ([#14790](https://github.com/vm0-ai/vm0/issues/14790)) ([dfe62f1](https://github.com/vm0-ai/vm0/commit/dfe62f16a1e118c65feba1e5063774428c44ebec))
* remove web org metadata leftovers ([#14800](https://github.com/vm0-ai/vm0/issues/14800)) ([419aa86](https://github.com/vm0-ai/vm0/commit/419aa86ab579c277050e96aa3fb26abf490e8183))

## [1.70.1](https://github.com/vm0-ai/vm0/compare/api-v1.70.0...api-v1.70.1) (2026-05-25)


### Bug Fixes

* show pinned chat threads across agents ([#14735](https://github.com/vm0-ai/vm0/issues/14735)) ([9764de2](https://github.com/vm0-ai/vm0/commit/9764de2797e676e31419c0d8012edc3b9a6407ce))


### Refactoring

* remove web oauth provider key bridge ([#14765](https://github.com/vm0-ai/vm0/issues/14765)) ([9209c1e](https://github.com/vm0-ai/vm0/commit/9209c1edcdbaca2a462b986249dfa131a5645072))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.39.1
    * @vm0/connectors bumped to 1.32.0
    * @vm0/core bumped to 8.293.0
    * @vm0/db bumped to 1.18.9

## [1.70.0](https://github.com/vm0-ai/vm0/compare/api-v1.69.5...api-v1.70.0) (2026-05-25)


### Features

* **platform:** cap sidebar at 25 with cursor-paginated All Threads page ([#14686](https://github.com/vm0-ai/vm0/issues/14686)) ([6a88691](https://github.com/vm0-ai/vm0/commit/6a88691078dba8a04696c55bb6c0701e8a6be151))


### Bug Fixes

* add credit recharge guidance ([#14687](https://github.com/vm0-ai/vm0/issues/14687)) ([d02621e](https://github.com/vm0-ai/vm0/commit/d02621e0b1bc47605cd5c9611ec2979e1f57610a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.39.0
    * @vm0/core bumped to 8.292.4
    * @vm0/db bumped to 1.18.8

## [1.69.5](https://github.com/vm0-ai/vm0/compare/api-v1.69.4...api-v1.69.5) (2026-05-24)


### Refactoring

* move connector auth registry boundary ([#14690](https://github.com/vm0-ai/vm0/issues/14690)) ([b8e6078](https://github.com/vm0-ai/vm0/commit/b8e60789e89da9da1090eea444b1a90d3268a502))
* nest oauth providers under auth providers ([#14702](https://github.com/vm0-ai/vm0/issues/14702)) ([02bb57c](https://github.com/vm0-ai/vm0/commit/02bb57cb9b9d2156f492c4b670b8390514eff04c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.38.6
    * @vm0/connectors bumped to 1.31.3
    * @vm0/core bumped to 8.292.3
    * @vm0/db bumped to 1.18.7

## [1.69.4](https://github.com/vm0-ai/vm0/compare/api-v1.69.3...api-v1.69.4) (2026-05-24)


### Refactoring

* route connector oauth revocation through registry ([#14676](https://github.com/vm0-ai/vm0/issues/14676)) ([67d5b8e](https://github.com/vm0-ai/vm0/commit/67d5b8e288f20571edb364fa390b17c52f5e8e82))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.38.5
    * @vm0/connectors bumped to 1.31.2
    * @vm0/core bumped to 8.292.2
    * @vm0/db bumped to 1.18.6

## [1.69.3](https://github.com/vm0-ai/vm0/compare/api-v1.69.2...api-v1.69.3) (2026-05-24)


### Performance Improvements

* add bench-api workflow with chat-threads baseline ([#14663](https://github.com/vm0-ai/vm0/issues/14663)) ([cfb181a](https://github.com/vm0-ai/vm0/commit/cfb181ab34e5670e4f93c86cbec56088559054d6))

## [1.69.2](https://github.com/vm0-ai/vm0/compare/api-v1.69.1...api-v1.69.2) (2026-05-24)


### Refactoring

* remove connector oauth provider adapter ([#14659](https://github.com/vm0-ai/vm0/issues/14659)) ([7d6cff9](https://github.com/vm0-ai/vm0/commit/7d6cff9d712aa9dd1eb3ac410b3c1e7fb9dc366d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.38.4
    * @vm0/connectors bumped to 1.31.1
    * @vm0/core bumped to 8.292.1
    * @vm0/db bumped to 1.18.5

## [1.69.1](https://github.com/vm0-ai/vm0/compare/api-v1.69.0...api-v1.69.1) (2026-05-24)


### Bug Fixes

* **api:** exclude org queue wait from api_to_claim ([#14631](https://github.com/vm0-ai/vm0/issues/14631)) ([ebc150e](https://github.com/vm0-ai/vm0/commit/ebc150eda9f6056bb49e33a373dee63dbf316b04))


### Refactoring

* keep connector oauth provider map private ([#14613](https://github.com/vm0-ai/vm0/issues/14613)) ([1fa7693](https://github.com/vm0-ai/vm0/commit/1fa7693922f1780c98d940bcb968abb82869cf83))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.38.3
    * @vm0/connectors bumped to 1.31.0
    * @vm0/core bumped to 8.292.0
    * @vm0/db bumped to 1.18.4

## [1.69.0](https://github.com/vm0-ai/vm0/compare/api-v1.68.1...api-v1.69.0) (2026-05-23)


### Features

* add Base44 OAuth device connector ([#14586](https://github.com/vm0-ai/vm0/issues/14586)) ([76ffda5](https://github.com/vm0-ai/vm0/commit/76ffda5b97395dddf06f7e7c284ac3db43435058))


### Bug Fixes

* **api:** log BytePlus video submit failures ([#14593](https://github.com/vm0-ai/vm0/issues/14593)) ([30e4dbe](https://github.com/vm0-ai/vm0/commit/30e4dbe9c1bb6444a59567598f124a9a6601836e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.38.2
    * @vm0/connectors bumped to 1.30.0
    * @vm0/core bumped to 8.291.0
    * @vm0/db bumped to 1.18.3

## [1.68.1](https://github.com/vm0-ai/vm0/compare/api-v1.68.0...api-v1.68.1) (2026-05-23)


### Refactoring

* remove goal feature switch and codex-style goal mode ([#14581](https://github.com/vm0-ai/vm0/issues/14581)) ([56bd3a1](https://github.com/vm0-ai/vm0/commit/56bd3a1978ff3e47c3326c913a23856ab3084194))
* remove unused member credit cap feature ([#14582](https://github.com/vm0-ai/vm0/issues/14582)) ([59abd6d](https://github.com/vm0-ai/vm0/commit/59abd6dbc26cacd7ecfa4bd66472880d2a1a179d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.38.1
    * @vm0/connectors bumped to 1.29.0
    * @vm0/core bumped to 8.290.0
    * @vm0/db bumped to 1.18.2

## [1.68.0](https://github.com/vm0-ai/vm0/compare/api-v1.67.0...api-v1.68.0) (2026-05-23)


### Features

* **agentphone:** rewrite imessage connect prompt as zero intro ([#14576](https://github.com/vm0-ai/vm0/issues/14576)) ([baae64d](https://github.com/vm0-ai/vm0/commit/baae64d47f0fac6e7dbc7843e0fe60e08bb0458c))


### Bug Fixes

* **api:** align Seedance first-frame requests ([#14569](https://github.com/vm0-ai/vm0/issues/14569)) ([c79e2eb](https://github.com/vm0-ai/vm0/commit/c79e2ebab05ea0cba609d90571911b57723ba536))
* log built-in generation failure details ([#14567](https://github.com/vm0-ai/vm0/issues/14567)) ([06ea9b5](https://github.com/vm0-ai/vm0/commit/06ea9b53066db2ade4ae3ca8319e480eedfc7602))


### Refactoring

* remove legacy web user preference backend ([#14573](https://github.com/vm0-ai/vm0/issues/14573)) ([d8e46aa](https://github.com/vm0-ai/vm0/commit/d8e46aa1b90d5e11c0498767cd85d96f99d85ea4))

## [1.67.0](https://github.com/vm0-ai/vm0/compare/api-v1.66.0...api-v1.67.0) (2026-05-22)


### Features

* add github zero file tools ([#14551](https://github.com/vm0-ai/vm0/issues/14551)) ([82a9adf](https://github.com/vm0-ai/vm0/commit/82a9adf5234d4cfbbb3ea9e71ffd50a7e33cf1e1))
* switch built-in video generation to byteplus ([#14547](https://github.com/vm0-ai/vm0/issues/14547)) ([7be0a3e](https://github.com/vm0-ai/vm0/commit/7be0a3edd4ae401d42a2f038de26d4a6f782e7a7))


### Bug Fixes

* harden github integration triggers ([#14541](https://github.com/vm0-ai/vm0/issues/14541)) ([4dc2dcb](https://github.com/vm0-ai/vm0/commit/4dc2dcb27bcca045bc1ae3b9757da6495137e93e))


### Refactoring

* **web:** remove legacy model-provider backend ([#14561](https://github.com/vm0-ai/vm0/issues/14561)) ([48ec9f1](https://github.com/vm0-ai/vm0/commit/48ec9f127062d47f663219ecb98756ee2e210a08))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.38.0
    * @vm0/core bumped to 8.289.1
    * @vm0/db bumped to 1.18.1

## [1.66.0](https://github.com/vm0-ai/vm0/compare/api-v1.65.0...api-v1.66.0) (2026-05-22)


### Features

* add claude code device auth login ([#14431](https://github.com/vm0-ai/vm0/issues/14431)) ([7f159ae](https://github.com/vm0-ai/vm0/commit/7f159ae5d81d52ad09f0715794750de44e8b713a))
* add github label listeners ([#14374](https://github.com/vm0-ai/vm0/issues/14374)) ([8d6d24b](https://github.com/vm0-ai/vm0/commit/8d6d24bbc00882dbc628650f94842fb9e3d71dc1))
* add OAuth device session API ([#14472](https://github.com/vm0-ai/vm0/issues/14472)) ([d32dd4b](https://github.com/vm0-ai/vm0/commit/d32dd4bd69c9b3dab1f6720f8bd84cc2c66aad2e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.37.0
    * @vm0/connectors bumped to 1.28.0
    * @vm0/core bumped to 8.289.0
    * @vm0/db bumped to 1.18.0

## [1.65.0](https://github.com/vm0-ai/vm0/compare/api-v1.64.0...api-v1.65.0) (2026-05-21)


### Features

* add OAuth device authorization provider capability ([#14465](https://github.com/vm0-ai/vm0/issues/14465)) ([0d721f9](https://github.com/vm0-ai/vm0/commit/0d721f93ddc06f4c20a7e60f622f35868b81df63))


### Bug Fixes

* **api:** validate checkout redirect origin against APP_URL ([#14473](https://github.com/vm0-ai/vm0/issues/14473)) ([61db180](https://github.com/vm0-ai/vm0/commit/61db180144ac055977a8b78cce8c66976876611f))
* **desktop:** map computer use screenshot clicks ([#14469](https://github.com/vm0-ai/vm0/issues/14469)) ([d3f697a](https://github.com/vm0-ai/vm0/commit/d3f697a92a1a26dbf87fa6e9c3edbda96e4348e2))
* target computer-use input dispatch ([#14471](https://github.com/vm0-ai/vm0/issues/14471)) ([d3471a6](https://github.com/vm0-ai/vm0/commit/d3471a6b2b147da00cff315e254c0b78d65e8d73))
* tolerate legacy runner contexts in kms backfill ([#14364](https://github.com/vm0-ai/vm0/issues/14364)) ([334fa60](https://github.com/vm0-ai/vm0/commit/334fa602b6a62c2592bbe76ae7e1811bb31c3620))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.36.2
    * @vm0/connectors bumped to 1.27.0
    * @vm0/core bumped to 8.288.1
    * @vm0/db bumped to 1.17.8

## [1.64.0](https://github.com/vm0-ai/vm0/compare/api-v1.63.0...api-v1.64.0) (2026-05-21)


### Features

* enable codex device auth ([#14462](https://github.com/vm0-ai/vm0/issues/14462)) ([1f93728](https://github.com/vm0-ai/vm0/commit/1f93728c3a294d34bbea61c50f860fede41f567f))


### Bug Fixes

* preserve admin role for workspace settings ([#14463](https://github.com/vm0-ai/vm0/issues/14463)) ([de67de4](https://github.com/vm0-ai/vm0/commit/de67de4cbc436136a4a17cf6ce971bbeb2b9bc73))


### Refactoring

* deduplicate connector oauth start helpers ([#14445](https://github.com/vm0-ai/vm0/issues/14445)) ([748a2d4](https://github.com/vm0-ai/vm0/commit/748a2d4398b3ead44ba869869470376595f6bbb4))
* move cli auth approval to api ([#14447](https://github.com/vm0-ai/vm0/issues/14447)) ([380c53b](https://github.com/vm0-ai/vm0/commit/380c53b2210b933642a37cd7cbe7a22fe6d0121b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.36.1
    * @vm0/connectors bumped to 1.26.1
    * @vm0/core bumped to 8.288.0
    * @vm0/db bumped to 1.17.7

## [1.63.0](https://github.com/vm0-ai/vm0/compare/api-v1.62.5...api-v1.63.0) (2026-05-21)


### Features

* add codex device auth login ([#14286](https://github.com/vm0-ai/vm0/issues/14286)) ([dfb9d35](https://github.com/vm0-ai/vm0/commit/dfb9d35612e6b86d7a0bd0d379180b6818e39f53))


### Bug Fixes

* run computer use writes without approval prompts ([#14429](https://github.com/vm0-ai/vm0/issues/14429)) ([42b694c](https://github.com/vm0-ai/vm0/commit/42b694ce02666194ca78cbb834f7eaef2c3f3405))


### Refactoring

* clarify connector oauth config getters ([#14430](https://github.com/vm0-ai/vm0/issues/14430)) ([66063df](https://github.com/vm0-ai/vm0/commit/66063dfd60f7d97acb110a47fa44c7b1c72135e6))
* type connector oauth provider credentials ([#14409](https://github.com/vm0-ai/vm0/issues/14409)) ([b3bc3f5](https://github.com/vm0-ai/vm0/commit/b3bc3f5b6367b7d90275b56aba16b9373113a4c6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.36.0
    * @vm0/connectors bumped to 1.26.0
    * @vm0/core bumped to 8.287.0
    * @vm0/db bumped to 1.17.6

## [1.62.5](https://github.com/vm0-ai/vm0/compare/api-v1.62.4...api-v1.62.5) (2026-05-21)


### Bug Fixes

* **api:** re-throw non-abort errors in clearAllDetached ([#14360](https://github.com/vm0-ai/vm0/issues/14360)) ([c6db49b](https://github.com/vm0-ai/vm0/commit/c6db49be151ab7d292ffeec0a477c91a1971bdc5))


### Refactoring

* require oauth config for oauth connectors ([#14365](https://github.com/vm0-ai/vm0/issues/14365)) ([e094dc4](https://github.com/vm0-ai/vm0/commit/e094dc416f33254749cbd618e4a06ca2de17b035))
* route connector oauth authorize through providers ([#14359](https://github.com/vm0-ai/vm0/issues/14359)) ([77886f8](https://github.com/vm0-ai/vm0/commit/77886f842141a5892f1c1435ab061bef9d1a04bd))
* type connector oauth credential results ([#14394](https://github.com/vm0-ai/vm0/issues/14394)) ([65fdd65](https://github.com/vm0-ai/vm0/commit/65fdd652ea45d11e9595a886134a5e6fbe30411e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.35.5
    * @vm0/connectors bumped to 1.25.2
    * @vm0/core bumped to 8.286.5
    * @vm0/db bumped to 1.17.5

## [1.62.4](https://github.com/vm0-ai/vm0/compare/api-v1.62.3...api-v1.62.4) (2026-05-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.35.4
    * @vm0/connectors bumped to 1.25.1
    * @vm0/core bumped to 8.286.4
    * @vm0/db bumped to 1.17.4

## [1.62.3](https://github.com/vm0-ai/vm0/compare/api-v1.62.2...api-v1.62.3) (2026-05-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.35.3
    * @vm0/connectors bumped to 1.25.0
    * @vm0/core bumped to 8.286.3
    * @vm0/db bumped to 1.17.3

## [1.62.2](https://github.com/vm0-ai/vm0/compare/api-v1.62.1...api-v1.62.2) (2026-05-20)


### Bug Fixes

* load all user secrets so firewall-only connector secrets resolve ([#14342](https://github.com/vm0-ai/vm0/issues/14342)) ([1e60c2b](https://github.com/vm0-ai/vm0/commit/1e60c2bc853e011dbc0aabf3c24b1c9564c11104))


### Refactoring

* cut over github webhook route ([#14341](https://github.com/vm0-ai/vm0/issues/14341)) ([0671a6f](https://github.com/vm0-ai/vm0/commit/0671a6f3ca1101109d2d807b31952710a0103946))
* cut over stripe webhook route ([#14345](https://github.com/vm0-ai/vm0/issues/14345)) ([4e54a8b](https://github.com/vm0-ai/vm0/commit/4e54a8b23ead56f9f7f7510df4560b7eb8be4561))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.35.2
    * @vm0/connectors bumped to 1.24.2
    * @vm0/core bumped to 8.286.2
    * @vm0/db bumped to 1.17.2

## [1.62.1](https://github.com/vm0-ai/vm0/compare/api-v1.62.0...api-v1.62.1) (2026-05-20)


### Refactoring

* cut over clerk webhook route ([#14332](https://github.com/vm0-ai/vm0/issues/14332)) ([76b12c8](https://github.com/vm0-ai/vm0/commit/76b12c88894b60d26e33c75b9314c7e8e27571e0))


### Performance Improvements

* batch agent run storage manifest lookups into one query ([#14327](https://github.com/vm0-ai/vm0/issues/14327)) ([2cb13e2](https://github.com/vm0-ai/vm0/commit/2cb13e25d0dc9ced27d74a7694bafebaf404557e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.35.1
    * @vm0/connectors bumped to 1.24.1
    * @vm0/core bumped to 8.286.1
    * @vm0/db bumped to 1.17.1

## [1.62.0](https://github.com/vm0-ai/vm0/compare/api-v1.61.1...api-v1.62.0) (2026-05-20)


### Features

* add agentphone group mention handling ([#13658](https://github.com/vm0-ai/vm0/issues/13658)) ([7cc63f1](https://github.com/vm0-ai/vm0/commit/7cc63f1d65fe19b63562e14241c5a2fbc2544aa8))
* add generated images to built-in websites ([#14250](https://github.com/vm0-ai/vm0/issues/14250)) ([fd87b33](https://github.com/vm0-ai/vm0/commit/fd87b3305d6bd0f2e463a9810012d51012ea56d3))
* add zero maps cli and server billing ([#13943](https://github.com/vm0-ai/vm0/issues/13943)) ([236b38d](https://github.com/vm0-ai/vm0/commit/236b38dc51012e7b62e3714eea6681b127689cb1))
* record hosted site artifacts ([#14203](https://github.com/vm0-ai/vm0/issues/14203)) ([6a21f72](https://github.com/vm0-ai/vm0/commit/6a21f72d49b60c1edf70b0dec9cf1cf91dd23151))


### Bug Fixes

* migrate persistent secrets to kms envelopes ([#14225](https://github.com/vm0-ai/vm0/issues/14225)) ([d012b83](https://github.com/vm0-ai/vm0/commit/d012b8316bb6295ce8ff6bc5cf1204104f9b1a39))


### Refactoring

* cut over agent events webhook ([#14245](https://github.com/vm0-ai/vm0/issues/14245)) ([a6c7b42](https://github.com/vm0-ai/vm0/commit/a6c7b427f0dda537102d3273c1ddf4e4ff514ac5))
* cut over agent firewall auth webhook ([#14282](https://github.com/vm0-ai/vm0/issues/14282)) ([f03200d](https://github.com/vm0-ai/vm0/commit/f03200d6a4e1afa9acc85ec65b3bff14969308b7))
* cut over agent heartbeat webhook ([#14298](https://github.com/vm0-ai/vm0/issues/14298)) ([df5d3c2](https://github.com/vm0-ai/vm0/commit/df5d3c26e4aaf888f3fd1df661e5652798cc160b))
* cut over agent storage commit webhook ([#14304](https://github.com/vm0-ai/vm0/issues/14304)) ([feccb10](https://github.com/vm0-ai/vm0/commit/feccb1074b1451b94ce0a3c7187a8da3f5956003))
* cut over agent storage prepare webhook ([#14309](https://github.com/vm0-ai/vm0/issues/14309)) ([a5060fd](https://github.com/vm0-ai/vm0/commit/a5060fdcf3366ed1317f2e5d3539603eb48d34ce))
* cut over agent telemetry webhook route ([#14318](https://github.com/vm0-ai/vm0/issues/14318)) ([4382997](https://github.com/vm0-ai/vm0/commit/43829972ec40fd1700a9da5b24fbdcfe9b7ef527))
* cut over runners job claim route ([#14258](https://github.com/vm0-ai/vm0/issues/14258)) ([54539e4](https://github.com/vm0-ai/vm0/commit/54539e4144e2f7d4441a38eb00bba94d660f49d6))
* cut over runners realtime token route ([#14243](https://github.com/vm0-ai/vm0/issues/14243)) ([59460e9](https://github.com/vm0-ai/vm0/commit/59460e9e6f4d3dadf2914494a33ea1e503c73307))
* cut over telegram avatar route ([#14271](https://github.com/vm0-ai/vm0/issues/14271)) ([f0c190b](https://github.com/vm0-ai/vm0/commit/f0c190b261ac577ba690826616f40b4212f5daa3))
* cut over telegram bot route ([#14285](https://github.com/vm0-ai/vm0/issues/14285)) ([6afc8f5](https://github.com/vm0-ai/vm0/commit/6afc8f55185f6fb366a9c8f10b0222774e5c7950))
* cut over telegram link route to api backend ([#14242](https://github.com/vm0-ai/vm0/issues/14242)) ([43f6576](https://github.com/vm0-ai/vm0/commit/43f65764694f179658308a81c3d6efd758397649))
* cut over zero integrations telegram bots route ([#14280](https://github.com/vm0-ai/vm0/issues/14280)) ([29fd974](https://github.com/vm0-ai/vm0/commit/29fd974266d5e1cc0a3b2eb14cccbf58504eedec))
* cut over zero integrations telegram download route ([#14288](https://github.com/vm0-ai/vm0/issues/14288)) ([c17187e](https://github.com/vm0-ai/vm0/commit/c17187e79ae57b79bba7d0d8eb6069dc8a6ceea6))
* cut over zero integrations telegram message route ([#14227](https://github.com/vm0-ai/vm0/issues/14227)) ([7761257](https://github.com/vm0-ai/vm0/commit/776125745630868a5e15d5ba484678839a83d528))
* cut over zero slack events route ([#14262](https://github.com/vm0-ai/vm0/issues/14262)) ([81398f1](https://github.com/vm0-ai/vm0/commit/81398f1733300b0723a05b8731397349c06713a1))
* cut over zero slack interactive route ([#14290](https://github.com/vm0-ai/vm0/issues/14290)) ([794d6b6](https://github.com/vm0-ai/vm0/commit/794d6b61d0d06c7c04d5d3ddb971d588a0911928))
* cut over zero slack oauth callback route ([#14294](https://github.com/vm0-ai/vm0/issues/14294)) ([3064307](https://github.com/vm0-ai/vm0/commit/306430774f7a9f2a5e2392937cf2f49dd16fa1a2))
* cut over zero slack oauth connect route ([#14300](https://github.com/vm0-ai/vm0/issues/14300)) ([d67c733](https://github.com/vm0-ai/vm0/commit/d67c7332b5af7ebb034a9902b1e91e071adcb659))
* cut over zero slack oauth install route ([#14307](https://github.com/vm0-ai/vm0/issues/14307)) ([653ac7a](https://github.com/vm0-ai/vm0/commit/653ac7a985d9a90c5fe67c1f4f4f606f80bcdee5))
* split oauth provider capabilities ([#14272](https://github.com/vm0-ai/vm0/issues/14272)) ([eb30ffa](https://github.com/vm0-ai/vm0/commit/eb30ffa6c3e5323cfddc64ad55bb45b4f985d3f8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.35.0
    * @vm0/connectors bumped to 1.24.0
    * @vm0/core bumped to 8.286.0
    * @vm0/db bumped to 1.17.0

## [1.61.1](https://github.com/vm0-ai/vm0/compare/api-v1.61.0...api-v1.61.1) (2026-05-20)


### Bug Fixes

* align slack api parity with web ([#14219](https://github.com/vm0-ai/vm0/issues/14219)) ([f5672b1](https://github.com/vm0-ai/vm0/commit/f5672b1353460da343b3b45b14fa054bdfe149ce))
* align telegram api endpoints with web behavior ([#14220](https://github.com/vm0-ai/vm0/issues/14220)) ([db85904](https://github.com/vm0-ai/vm0/commit/db8590459093b2ee04ccbe8a28c3a4e0b0935a3b))


### Refactoring

* cut over agent complete webhook ([#14224](https://github.com/vm0-ai/vm0/issues/14224)) ([4ee88b4](https://github.com/vm0-ai/vm0/commit/4ee88b4059235ee6e12cfa78481708364807f5e6))
* cut over runners poll route ([#14223](https://github.com/vm0-ai/vm0/issues/14223)) ([4b51be3](https://github.com/vm0-ai/vm0/commit/4b51be3a1d4febf9ed2af31a5e21c33e161a9713))
* cut over telegram integrations list ([#14208](https://github.com/vm0-ai/vm0/issues/14208)) ([9a73c07](https://github.com/vm0-ai/vm0/commit/9a73c07fe78c6db1dbd15ae960bd6017f155408b))
* cut over zero slack connect route ([#14216](https://github.com/vm0-ai/vm0/issues/14216)) ([8f097e1](https://github.com/vm0-ai/vm0/commit/8f097e1c5b5d0ba23532d5e8d473448e9697c6f7))

## [1.61.0](https://github.com/vm0-ai/vm0/compare/api-v1.60.1...api-v1.61.0) (2026-05-20)


### Features

* serve user artifacts from public cdn ([#13956](https://github.com/vm0-ai/vm0/issues/13956)) ([32604d5](https://github.com/vm0-ai/vm0/commit/32604d5bd56b042a35b1ff8b50622eb54f4635f1))


### Bug Fixes

* align integration session model reuse ([#14171](https://github.com/vm0-ai/vm0/issues/14171)) ([3f3cd2a](https://github.com/vm0-ai/vm0/commit/3f3cd2a44d3e800d7fe30f051eb781392192a6b6))
* format external callback errors ([#14153](https://github.com/vm0-ai/vm0/issues/14153)) ([15f8e30](https://github.com/vm0-ai/vm0/commit/15f8e30b7772e7065dfa5d91293c05835c61bc34))
* stop injecting google ads login customer header ([#14181](https://github.com/vm0-ai/vm0/issues/14181)) ([dbc371b](https://github.com/vm0-ai/vm0/commit/dbc371b92265844be46752987ffaa87131a78e5c))


### Refactoring

* cut over custom connector by-id route ([#14159](https://github.com/vm0-ai/vm0/issues/14159)) ([9be7496](https://github.com/vm0-ai/vm0/commit/9be74961aa5c02e11a825c246b06e6efb7ff24dc))
* cut over custom connector secret route ([#14180](https://github.com/vm0-ai/vm0/issues/14180)) ([713aa75](https://github.com/vm0-ai/vm0/commit/713aa75c937707246d46339fb35a01cdc2b28f8d))
* cut over prepare-history webhook ([#14155](https://github.com/vm0-ai/vm0/issues/14155)) ([f137293](https://github.com/vm0-ai/vm0/commit/f137293900de6f9845791abcd50e558961447a75))
* cut over telegram auth callback route ([#14191](https://github.com/vm0-ai/vm0/issues/14191)) ([c576fc5](https://github.com/vm0-ai/vm0/commit/c576fc536bb39f38b0633a51b4f037418f54d363))
* cut over zero billing invoices route ([#14156](https://github.com/vm0-ai/vm0/issues/14156)) ([a721b5c](https://github.com/vm0-ai/vm0/commit/a721b5c1a53c85ea0262f4bfee0dc76d16e4fff2))
* cut over zero developer support route ([#14179](https://github.com/vm0-ai/vm0/issues/14179)) ([6c5a32b](https://github.com/vm0-ai/vm0/commit/6c5a32ba862ece42167e212c6e42248a1da97db8))
* cut over zero image generation route ([#14186](https://github.com/vm0-ai/vm0/issues/14186)) ([8a9989a](https://github.com/vm0-ai/vm0/commit/8a9989a535da992ab52f2a1dec318c7463cb9a5c))
* cut over zero integrations chat message route ([#14192](https://github.com/vm0-ai/vm0/issues/14192)) ([b8d20ad](https://github.com/vm0-ai/vm0/commit/b8d20adecd3fbb686f48c7273c0e8a8042ff4981))
* proxy zero billing portal to api ([#14170](https://github.com/vm0-ai/vm0/issues/14170)) ([576bcc7](https://github.com/vm0-ai/vm0/commit/576bcc790fc18791932d8fe36b98b61dddc239b0))
* proxy zero billing redeem to api ([#14184](https://github.com/vm0-ai/vm0/issues/14184)) ([3c669f2](https://github.com/vm0-ai/vm0/commit/3c669f203dba67773ff96ffed5c7043e35d1b9f6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.34.0
    * @vm0/connectors bumped to 1.23.1
    * @vm0/core bumped to 8.285.2
    * @vm0/db bumped to 1.16.2

## [1.60.1](https://github.com/vm0-ai/vm0/compare/api-v1.60.0...api-v1.60.1) (2026-05-20)


### Bug Fixes

* add connector oauth handoff flow ([#14138](https://github.com/vm0-ai/vm0/issues/14138)) ([43da171](https://github.com/vm0-ai/vm0/commit/43da1713912134ca23a609760cd6bf27c614510f))


### Refactoring

* cut over telegram register route ([#14125](https://github.com/vm0-ai/vm0/issues/14125)) ([9f37f12](https://github.com/vm0-ai/vm0/commit/9f37f12ee8bf6ac32a0aa1973edffb36fd18e79c))
* cut over telegram webhook route ([#14139](https://github.com/vm0-ai/vm0/issues/14139)) ([0e05e2b](https://github.com/vm0-ai/vm0/commit/0e05e2bf23f638ee1102766c091f362c5e3654d2))
* cut over zero email inbound route ([#14137](https://github.com/vm0-ai/vm0/issues/14137)) ([3d0a011](https://github.com/vm0-ai/vm0/commit/3d0a011f790395472f09aa1ba7e4536afb56397d))
* cut over zero email trigger callback route ([#14124](https://github.com/vm0-ai/vm0/issues/14124)) ([5432bff](https://github.com/vm0-ai/vm0/commit/5432bffc1bc517f6927a73bd75046cd744921bba))
* proxy zero billing auto-recharge to api ([#14122](https://github.com/vm0-ai/vm0/issues/14122)) ([6ec47cf](https://github.com/vm0-ai/vm0/commit/6ec47cfab6c698dce83060134e5f781f967f8e6d))
* proxy zero billing checkout to api ([#14136](https://github.com/vm0-ai/vm0/issues/14136)) ([92c3dc5](https://github.com/vm0-ai/vm0/commit/92c3dc5561069c855d0fa20f668299e57147d81e))
* proxy zero billing downgrade to api ([#14141](https://github.com/vm0-ai/vm0/issues/14141)) ([fa04e9a](https://github.com/vm0-ai/vm0/commit/fa04e9a48bb60ede26b1c6f43b6c13fced728403))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.33.1
    * @vm0/core bumped to 8.285.1
    * @vm0/db bumped to 1.16.1

## [1.60.0](https://github.com/vm0-ai/vm0/compare/api-v1.59.1...api-v1.60.0) (2026-05-20)


### Features

* **runner:** add firecracker io limiters ([#13585](https://github.com/vm0-ai/vm0/issues/13585)) ([653b854](https://github.com/vm0-ai/vm0/commit/653b854613580861d503848a3eeffff98fe75095))


### Bug Fixes

* align external run error copy ([#14098](https://github.com/vm0-ai/vm0/issues/14098)) ([7377423](https://github.com/vm0-ai/vm0/commit/7377423018ea54c45b4d75299525b3b604129875))
* pin integration model routes for runs ([#14100](https://github.com/vm0-ai/vm0/issues/14100)) ([4aa1ab1](https://github.com/vm0-ai/vm0/commit/4aa1ab1668faf25f8bb1564fc59db3d8833e6701))


### Refactoring

* cut over telegram setup status route ([#14115](https://github.com/vm0-ai/vm0/issues/14115)) ([2143f0d](https://github.com/vm0-ai/vm0/commit/2143f0d7936509ed156c25a16890ba7b3a07318d))
* cut over zero email reply callback route ([#14116](https://github.com/vm0-ai/vm0/issues/14116)) ([2cda078](https://github.com/vm0-ai/vm0/commit/2cda0789129fb9c7af4765038d9da876552bddba))
* remove codex oauth browser flow ([#14113](https://github.com/vm0-ai/vm0/issues/14113)) ([0db0857](https://github.com/vm0-ai/vm0/commit/0db0857413a56989e856a2c721634a2549a0be3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.33.0
    * @vm0/connectors bumped to 1.23.0
    * @vm0/core bumped to 8.285.0
    * @vm0/db bumped to 1.16.0

## [1.59.1](https://github.com/vm0-ai/vm0/compare/api-v1.59.0...api-v1.59.1) (2026-05-20)


### Bug Fixes

* generate fal webhooks on web origin ([#14093](https://github.com/vm0-ai/vm0/issues/14093)) ([bf81e37](https://github.com/vm0-ai/vm0/commit/bf81e370a14828f666d1476a5c6354f2d6028f8c))
* route slack selected models via policy ([#14097](https://github.com/vm0-ai/vm0/issues/14097)) ([9ca079a](https://github.com/vm0-ai/vm0/commit/9ca079a745427adc8d4554c6a53ac7f8ab9960f2))


### Refactoring

* proxy test telegram mock route to api ([#14087](https://github.com/vm0-ai/vm0/issues/14087)) ([6f91bfa](https://github.com/vm0-ai/vm0/commit/6f91bfa59415ef4fea5e83084fa74b97c90437ef))

## [1.59.0](https://github.com/vm0-ai/vm0/compare/api-v1.58.0...api-v1.59.0) (2026-05-19)


### Features

* redesign computer use around desktop host ([#14067](https://github.com/vm0-ai/vm0/issues/14067)) ([7b5bc86](https://github.com/vm0-ai/vm0/commit/7b5bc864edb3bba064d5a3aa35e904a96c9e627c))


### Bug Fixes

* keep github oauth on web origin ([#14084](https://github.com/vm0-ai/vm0/issues/14084)) ([7976243](https://github.com/vm0-ai/vm0/commit/79762435c4ccab7eaf934dd36170c9476639e7a1))
* keep slack oauth on web origin ([#14057](https://github.com/vm0-ai/vm0/issues/14057)) ([6c1a674](https://github.com/vm0-ai/vm0/commit/6c1a67455b835cb1182f03453d83a6ab079ceea7))
* keep telegram callbacks on web origin ([#14068](https://github.com/vm0-ai/vm0/issues/14068)) ([36b10af](https://github.com/vm0-ai/vm0/commit/36b10aff3fa404c3069451d8277a709c3c0a4b0c))
* restore queued chat auto-send runs ([#14083](https://github.com/vm0-ai/vm0/issues/14083)) ([f46c0f5](https://github.com/vm0-ai/vm0/commit/f46c0f5c53c514c314d94576cd79345919796aba))


### Refactoring

* cut over internal cron schedule callback route ([#14036](https://github.com/vm0-ai/vm0/issues/14036)) ([96d9e6b](https://github.com/vm0-ai/vm0/commit/96d9e6be8979594605af97ae42891cf67f453c14))
* cut over internal loop schedule callback route ([#14056](https://github.com/vm0-ai/vm0/issues/14056)) ([5caad66](https://github.com/vm0-ai/vm0/commit/5caad663d6c18d4f1e09f12e0f4e62f4a8029426))
* cut over internal slack org callback route ([#14065](https://github.com/vm0-ai/vm0/issues/14065)) ([1e79768](https://github.com/vm0-ai/vm0/commit/1e7976884465071724154860d4e21e0ac6644dd5))
* cut over internal voice-chat callback route ([#14085](https://github.com/vm0-ai/vm0/issues/14085)) ([3564202](https://github.com/vm0-ai/vm0/commit/3564202dbfaa935b0476ef8b015e30ad5a859791))
* migrate zero runs create rewrite ([#14033](https://github.com/vm0-ai/vm0/issues/14033)) ([1563d5e](https://github.com/vm0-ai/vm0/commit/1563d5e24a2be1906fc265ec0cfb5c831a626769))
* proxy test slack conversations history route to api ([#14035](https://github.com/vm0-ai/vm0/issues/14035)) ([1f61e38](https://github.com/vm0-ai/vm0/commit/1f61e38ac172654081b37de90f43f1f1145c3b6d))
* proxy test slack conversations open route to api ([#14050](https://github.com/vm0-ai/vm0/issues/14050)) ([b3a3b30](https://github.com/vm0-ai/vm0/commit/b3a3b30719c8cbe7e2a4add1bfa618272e98ba11))
* proxy test slack conversations replies to api ([#14059](https://github.com/vm0-ai/vm0/issues/14059)) ([1ca8b8a](https://github.com/vm0-ai/vm0/commit/1ca8b8ab365f7761437704930d662cec9d6af789))
* proxy test slack ephemeral route to api ([#14015](https://github.com/vm0-ai/vm0/issues/14015)) ([ea8480a](https://github.com/vm0-ai/vm0/commit/ea8480ac574d44bd542dea9f01cc57ec9536e776))
* proxy test slack oauth access route to api ([#14066](https://github.com/vm0-ai/vm0/issues/14066)) ([22eeb2d](https://github.com/vm0-ai/vm0/commit/22eeb2dbbbd0509706c234afb86079663ba3b1c3))
* proxy test slack users info to api ([#14073](https://github.com/vm0-ai/vm0/issues/14073)) ([beeacb5](https://github.com/vm0-ai/vm0/commit/beeacb5cb6530d9d691e30ebf90a937659cf770d))
* proxy test slack views publish route to api ([#14080](https://github.com/vm0-ai/vm0/issues/14080)) ([5402481](https://github.com/vm0-ai/vm0/commit/54024813bc108b5a9e06298edfe0e7e5e6c5ad4c))
* proxy test telegram state route to api ([#14089](https://github.com/vm0-ai/vm0/issues/14089)) ([828cc1c](https://github.com/vm0-ai/vm0/commit/828cc1c986ae6a7a07e81fc372de42a40d1144e3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.32.0
    * @vm0/connectors bumped to 1.22.0
    * @vm0/core bumped to 8.284.0
    * @vm0/db bumped to 1.15.0

## [1.58.0](https://github.com/vm0-ai/vm0/compare/api-v1.57.1...api-v1.58.0) (2026-05-19)


### Features

* **platform:** redesign edit model route modal ([#13606](https://github.com/vm0-ai/vm0/issues/13606)) ([47c770f](https://github.com/vm0-ai/vm0/commit/47c770f85e0912048bc37cb78ec45e0ed928cc12))


### Bug Fixes

* keep connector oauth on web host ([#14029](https://github.com/vm0-ai/vm0/issues/14029)) ([2058734](https://github.com/vm0-ai/vm0/commit/20587341936530649de46491119045562f55277b))
* pass api feature flags to runner jobs ([#14009](https://github.com/vm0-ai/vm0/issues/14009)) ([8e615e1](https://github.com/vm0-ai/vm0/commit/8e615e1080bc728028b5902fa32ea37be1b82a27))


### Refactoring

* cut over internal chat callback route ([#14007](https://github.com/vm0-ai/vm0/issues/14007)) ([6c1f851](https://github.com/vm0-ai/vm0/commit/6c1f8518dd4b78580b5802acbdc45e318a199b28))
* cut over internal github issue callback route ([#14026](https://github.com/vm0-ai/vm0/issues/14026)) ([2f4d865](https://github.com/vm0-ai/vm0/commit/2f4d86546b09edaac9c3f1cb9ac75947d1568ac8))
* migrate zero run agent events rewrite ([#14016](https://github.com/vm0-ai/vm0/issues/14016)) ([1e7db97](https://github.com/vm0-ai/vm0/commit/1e7db977a9c645779952e78d739654e87cb7015a))
* proxy test slack chat message route to api ([#14025](https://github.com/vm0-ai/vm0/issues/14025)) ([5e1e66b](https://github.com/vm0-ai/vm0/commit/5e1e66b6a1b05e7229137ed92bb74df92b128b37))

## [1.57.1](https://github.com/vm0-ai/vm0/compare/api-v1.57.0...api-v1.57.1) (2026-05-19)


### Bug Fixes

* preserve web origin for api backend rewrites ([#14000](https://github.com/vm0-ai/vm0/issues/14000)) ([610c5d6](https://github.com/vm0-ai/vm0/commit/610c5d6a58b2dc94c8383af2583e97c64611b02e))


### Refactoring

* proxy test slack assistant status route to api ([#14005](https://github.com/vm0-ai/vm0/issues/14005)) ([5e0a824](https://github.com/vm0-ai/vm0/commit/5e0a824db687448e190945315d5d86e0e231f65a))

## [1.57.0](https://github.com/vm0-ai/vm0/compare/api-v1.56.1...api-v1.57.0) (2026-05-19)


### Features

* add connector oauth client plumbing ([#13973](https://github.com/vm0-ai/vm0/issues/13973)) ([5c1ede5](https://github.com/vm0-ai/vm0/commit/5c1ede5a435a2c6a95efbf676aeb88bf8ec08788))
* enable stored secret kms reads ([#13970](https://github.com/vm0-ai/vm0/issues/13970)) ([11ee709](https://github.com/vm0-ai/vm0/commit/11ee7097d118f5b6b03726b3e810a5be0fae5d15))


### Bug Fixes

* encode oauth callback cookies ([#13990](https://github.com/vm0-ai/vm0/issues/13990)) ([909a47b](https://github.com/vm0-ai/vm0/commit/909a47bb36eb6274bf156bb43c30b832e4398523))
* enforce api start time milliseconds ([#13963](https://github.com/vm0-ai/vm0/issues/13963)) ([847d7a2](https://github.com/vm0-ai/vm0/commit/847d7a2054778457d0c65da5e75439b71b78d965))
* separate desktop development app identity ([#13980](https://github.com/vm0-ai/vm0/issues/13980)) ([21fe633](https://github.com/vm0-ai/vm0/commit/21fe6334d52eb4059df4a65fd6d177f1a8293012))


### Refactoring

* cut over cron voice chat cleanup route ([#13972](https://github.com/vm0-ai/vm0/issues/13972)) ([e7ced61](https://github.com/vm0-ai/vm0/commit/e7ced61c23bdc3c1baa25f1ac4fedf59eef9c690))
* migrate test slack dispatch probe rewrite ([#13948](https://github.com/vm0-ai/vm0/issues/13948)) ([b19f9c0](https://github.com/vm0-ai/vm0/commit/b19f9c0c8d5e5809b4de3ccad081a6e44bbbf622))
* proxy test oauth token route to api ([#13965](https://github.com/vm0-ai/vm0/issues/13965)) ([b45401f](https://github.com/vm0-ai/vm0/commit/b45401f5c9d0360ba858d4fbc669c7c0849c49b2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.31.1
    * @vm0/connectors bumped to 1.21.0
    * @vm0/core bumped to 8.283.0
    * @vm0/db bumped to 1.14.16

## [1.56.1](https://github.com/vm0-ai/vm0/compare/api-v1.56.0...api-v1.56.1) (2026-05-19)


### Refactoring

* cut over cron telegram cleanup route ([#13958](https://github.com/vm0-ai/vm0/issues/13958)) ([d33d5bc](https://github.com/vm0-ai/vm0/commit/d33d5bc21c71df6195138c483b4de4afe982b7fc))
* cut over zero insights route ([#13949](https://github.com/vm0-ai/vm0/issues/13949)) ([6cee53d](https://github.com/vm0-ai/vm0/commit/6cee53df7b45caaff58cbf4e08355d8159efe4c0))

## [1.56.0](https://github.com/vm0-ai/vm0/compare/api-v1.55.0...api-v1.56.0) (2026-05-19)


### Features

* add Atlas Cloud connector ([#13896](https://github.com/vm0-ai/vm0/issues/13896)) ([d6fe5a7](https://github.com/vm0-ai/vm0/commit/d6fe5a76be42291e5826daf3363e8ded0f040e48))
* add built-in website generation ([#13655](https://github.com/vm0-ai/vm0/issues/13655)) ([f88868e](https://github.com/vm0-ai/vm0/commit/f88868ef7362503752aaa7dbb5465d2fa0770ed6))
* add fal image-to-image generation ([#13890](https://github.com/vm0-ai/vm0/issues/13890)) ([98a1a94](https://github.com/vm0-ai/vm0/commit/98a1a94647d08b31070ff9385982c768aa0de19d))
* enable stored secret kms writes ([#13946](https://github.com/vm0-ai/vm0/issues/13946)) ([77f6fd7](https://github.com/vm0-ai/vm0/commit/77f6fd7d2fc61ced4e4350260235d6d5dd84efc3))


### Bug Fixes

* block telegram connect before onboarding ([#13942](https://github.com/vm0-ai/vm0/issues/13942)) ([1331dfd](https://github.com/vm0-ai/vm0/commit/1331dfdae8efec681d2c7ba55fb7df2f331ca6c8))


### Refactoring

* cut over cron process usage events route ([#13923](https://github.com/vm0-ai/vm0/issues/13923)) ([6700c58](https://github.com/vm0-ai/vm0/commit/6700c58c48b9cf3f32d04f1ca9d39ad30db1bf6f))
* cut over cron reconcile billing entitlements route ([#13934](https://github.com/vm0-ai/vm0/issues/13934)) ([3c51fde](https://github.com/vm0-ai/vm0/commit/3c51fde143fa9cc1a02c86e1fe75cc3acb98d615))
* migrate zero schedules root rewrite ([#13920](https://github.com/vm0-ai/vm0/issues/13920)) ([9db1a6e](https://github.com/vm0-ai/vm0/commit/9db1a6e8ac9f546697100f183bff622013c3e0fa))
* proxy test oauth echo route to api ([#13936](https://github.com/vm0-ai/vm0/issues/13936)) ([d919095](https://github.com/vm0-ai/vm0/commit/d9190954eea60268f2859f5a9682172bf48727b5))
* remove codex oauth connector ([#13937](https://github.com/vm0-ai/vm0/issues/13937)) ([6a60a23](https://github.com/vm0-ai/vm0/commit/6a60a23bc1ff798e3c1f5c5431cd0da59dd6e83e))
* remove obsolete connector helper exports ([#13933](https://github.com/vm0-ai/vm0/issues/13933)) ([efd4129](https://github.com/vm0-ai/vm0/commit/efd41291ae124b30010102caab81ca5c39505ee0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.31.0
    * @vm0/connectors bumped to 1.20.0
    * @vm0/core bumped to 8.282.0
    * @vm0/db bumped to 1.14.15

## [1.55.0](https://github.com/vm0-ai/vm0/compare/api-v1.54.9...api-v1.55.0) (2026-05-19)


### Features

* improve presentation deck planning ([#13712](https://github.com/vm0-ai/vm0/issues/13712)) ([6359c48](https://github.com/vm0-ai/vm0/commit/6359c48cf30d795a0c233ea8e8ba5567dbf689c3))


### Bug Fixes

* pass feature switch context to secret writes ([#13862](https://github.com/vm0-ai/vm0/issues/13862)) ([401ca37](https://github.com/vm0-ai/vm0/commit/401ca373336428642808cc0781fd8b326aaff675))


### Refactoring

* cut over connector authorize route ([#13849](https://github.com/vm0-ai/vm0/issues/13849)) ([4c64323](https://github.com/vm0-ai/vm0/commit/4c64323d305e79d7b7d94504aa260cb658902ef0))
* cut over connector callback route ([#13870](https://github.com/vm0-ai/vm0/issues/13870)) ([891f0e0](https://github.com/vm0-ai/vm0/commit/891f0e0e3e99780babd2de9008c3f66115ee0aab))
* cut over cron aggregate insights route ([#13848](https://github.com/vm0-ai/vm0/issues/13848)) ([82277bb](https://github.com/vm0-ai/vm0/commit/82277bb43f3908209c59b18e6564aae79417686a))
* cut over cron aggregate usage route ([#13857](https://github.com/vm0-ai/vm0/issues/13857)) ([702c608](https://github.com/vm0-ai/vm0/commit/702c608c98f6f1b6ff89e5454115066188f9bf30))
* cut over cron cleanup sandboxes route ([#13869](https://github.com/vm0-ai/vm0/issues/13869)) ([645bc3e](https://github.com/vm0-ai/vm0/commit/645bc3ec0ef785b0e7c5a4f35d1e22038d034dd6))
* cut over cron drain email outbox route ([#13892](https://github.com/vm0-ai/vm0/issues/13892)) ([436dd3e](https://github.com/vm0-ai/vm0/commit/436dd3e6d8812b11c3b608ecf41f16c1868682bb))
* cut over cron execute schedules route ([#13917](https://github.com/vm0-ai/vm0/issues/13917)) ([7d2cbcf](https://github.com/vm0-ai/vm0/commit/7d2cbcfe26e6a9899ce15c0bb6b0bd027566405f))
* cut over zero chat messages route ([#13833](https://github.com/vm0-ai/vm0/issues/13833)) ([e418e5f](https://github.com/vm0-ai/vm0/commit/e418e5f413ea1f329347d19d854863fcec2606ec))
* cut over zero computer-use host route ([#13871](https://github.com/vm0-ai/vm0/issues/13871)) ([481fc14](https://github.com/vm0-ai/vm0/commit/481fc1419a9e6b914f1cf02f5ca6b389160fffdb))
* cut over zero computer-use register route ([#13894](https://github.com/vm0-ai/vm0/issues/13894)) ([e557bc0](https://github.com/vm0-ai/vm0/commit/e557bc0cc56a7d2c52d56768649c8953b45c5212))
* cut over zero computer-use unregister route ([#13903](https://github.com/vm0-ai/vm0/issues/13903)) ([67a4d58](https://github.com/vm0-ai/vm0/commit/67a4d58a7407953da33ffc3320d8121c56dec385))
* proxy agent run metrics telemetry to api ([#13839](https://github.com/vm0-ai/vm0/issues/13839)) ([dbb116b](https://github.com/vm0-ai/vm0/commit/dbb116bc015eea2b85a7da6ef2cbc8ca4060093a))
* proxy agent run network telemetry to api ([#13843](https://github.com/vm0-ai/vm0/issues/13843)) ([4618a93](https://github.com/vm0-ai/vm0/commit/4618a933da41f3a9c452e53d9b0f7eeab708d313))
* proxy agent run system log to api ([#13860](https://github.com/vm0-ai/vm0/issues/13860)) ([da415f7](https://github.com/vm0-ai/vm0/commit/da415f70b60b60f0e351cdf7b7f29d46f50c963c))
* proxy agent run telemetry to api ([#13854](https://github.com/vm0-ai/vm0/issues/13854)) ([1b6f965](https://github.com/vm0-ai/vm0/commit/1b6f965a530256f63ab4a514fd103e4560d60e8a))
* proxy agent runs to api ([#13875](https://github.com/vm0-ai/vm0/issues/13875)) ([4633caa](https://github.com/vm0-ai/vm0/commit/4633caabd24cb0e482305ee5c1e0f8d1be442650))
* reduce connector registry coupling ([#13919](https://github.com/vm0-ai/vm0/issues/13919)) ([59beef3](https://github.com/vm0-ai/vm0/commit/59beef398677629082e27347e3ec9d4292273904))
* use runtime connector availability helper ([#13905](https://github.com/vm0-ai/vm0/issues/13905)) ([43d6bc8](https://github.com/vm0-ai/vm0/commit/43d6bc84d7cc06039868b6049bec2a17c6c363b7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.30.9
    * @vm0/connectors bumped to 1.19.1
    * @vm0/core bumped to 8.281.7
    * @vm0/db bumped to 1.14.14

## [1.54.9](https://github.com/vm0-ai/vm0/compare/api-v1.54.8...api-v1.54.9) (2026-05-19)


### Refactoring

* cut over cli auth token route ([#13812](https://github.com/vm0-ai/vm0/issues/13812)) ([9e56c33](https://github.com/vm0-ai/vm0/commit/9e56c336c44bd73583aa884d116649f3962cfdc3))
* cut over zero chat thread detail route ([#13815](https://github.com/vm0-ai/vm0/issues/13815)) ([795f23a](https://github.com/vm0-ai/vm0/commit/795f23a5a615813dc7fe7a64ca0748f535dfd904))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.30.8
    * @vm0/connectors bumped to 1.19.0
    * @vm0/core bumped to 8.281.6
    * @vm0/db bumped to 1.14.13

## [1.54.8](https://github.com/vm0-ai/vm0/compare/api-v1.54.7...api-v1.54.8) (2026-05-18)


### Bug Fixes

* gate KMS dual-write behind StoredSecretKmsWrite feature switch ([#13799](https://github.com/vm0-ai/vm0/issues/13799)) ([e699848](https://github.com/vm0-ai/vm0/commit/e6998484e874db0da320924b17ea57f4c2f383c2))


### Refactoring

* cut over cli auth test connector route ([#13788](https://github.com/vm0-ai/vm0/issues/13788)) ([41398c5](https://github.com/vm0-ai/vm0/commit/41398c5f561bfcc40c6d99ca21fa43770212f03f))
* cut over cli auth test enable connector route ([#13798](https://github.com/vm0-ai/vm0/issues/13798)) ([efff382](https://github.com/vm0-ai/vm0/commit/efff3828c654ca4922c443e65c874e96654f1a6b))
* cut over cli auth test token route ([#13806](https://github.com/vm0-ai/vm0/issues/13806)) ([e747ec8](https://github.com/vm0-ai/vm0/commit/e747ec8c7361843aa746cfa4df8c96121354b1fd))
* cut over zero agent by-id route ([#13785](https://github.com/vm0-ai/vm0/issues/13785)) ([594c1ed](https://github.com/vm0-ai/vm0/commit/594c1edcaad6b90d279d347da1c78e56c5527b3d))
* cut over zero agents root route ([#13801](https://github.com/vm0-ai/vm0/issues/13801)) ([bcb294c](https://github.com/vm0-ai/vm0/commit/bcb294c7d9b3c0ee8239ed6360d72659ef430c9f))
* cut over zero chat thread artifacts route ([#13805](https://github.com/vm0-ai/vm0/issues/13805)) ([a6df09e](https://github.com/vm0-ai/vm0/commit/a6df09e53a2e076a9be538a0f299879bf90bfa22))
* proxy agent composes list to api ([#13783](https://github.com/vm0-ai/vm0/issues/13783)) ([0ff96f6](https://github.com/vm0-ai/vm0/commit/0ff96f6378b5e4362f6e96720bf7350f1864b620))
* proxy agent composes metadata to api ([#13794](https://github.com/vm0-ai/vm0/issues/13794)) ([a00b967](https://github.com/vm0-ai/vm0/commit/a00b9670dc6a908e09b55bcd8225159d619c0aa7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.30.7
    * @vm0/connectors bumped to 1.18.1
    * @vm0/core bumped to 8.281.5
    * @vm0/db bumped to 1.14.12

## [1.54.7](https://github.com/vm0-ai/vm0/compare/api-v1.54.6...api-v1.54.7) (2026-05-18)


### Refactoring

* cut over cli auth device route ([#13760](https://github.com/vm0-ai/vm0/issues/13760)) ([cd32d09](https://github.com/vm0-ai/vm0/commit/cd32d096bf38b2c177888d3279e172df36a2a60e))
* cut over cli auth org route ([#13764](https://github.com/vm0-ai/vm0/issues/13764)) ([e1bbb4a](https://github.com/vm0-ai/vm0/commit/e1bbb4a3cd6b836ac71ba5edf6e8340fedc6a06a))
* cut over cli auth test approve route ([#13768](https://github.com/vm0-ai/vm0/issues/13768)) ([6aaa704](https://github.com/vm0-ai/vm0/commit/6aaa70496ecd4eb096cb00caae16f767b780e642))
* cut over cli auth test codex oauth route ([#13773](https://github.com/vm0-ai/vm0/issues/13773)) ([1269915](https://github.com/vm0-ai/vm0/commit/1269915601fa6f3baddb41892be90bcc8048c3d9))
* cut over zero agent custom connectors route ([#13759](https://github.com/vm0-ai/vm0/issues/13759)) ([20eadb8](https://github.com/vm0-ai/vm0/commit/20eadb8a03f5e214051239eafcef770228e64c4c))
* cut over zero agent instructions route ([#13769](https://github.com/vm0-ai/vm0/issues/13769)) ([a6bea0c](https://github.com/vm0-ai/vm0/commit/a6bea0c17b7f576fbe7f4e5ae36f818985446b96))
* cut over zero agent user connectors route ([#13762](https://github.com/vm0-ai/vm0/issues/13762)) ([8601aea](https://github.com/vm0-ai/vm0/commit/8601aeafd5a98ebf95f698b9daeeedb2fabaf211))
* proxy agent composes versions to api ([#13775](https://github.com/vm0-ai/vm0/issues/13775)) ([01daecf](https://github.com/vm0-ai/vm0/commit/01daecf0516c5e56c0cee0fe5c93d24af1150048))
* proxy agent runs cancel to api ([#13766](https://github.com/vm0-ai/vm0/issues/13766)) ([3b69613](https://github.com/vm0-ai/vm0/commit/3b69613ac0092cdf328a99d031e95ecb56de68d3))
* proxy agent runs queue to api ([#13755](https://github.com/vm0-ai/vm0/issues/13755)) ([b4d0a3d](https://github.com/vm0-ai/vm0/commit/b4d0a3ddbe86a4fa607a67ac877b55ebefb2e989))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.30.6
    * @vm0/connectors bumped to 1.18.0
    * @vm0/core bumped to 8.281.4
    * @vm0/db bumped to 1.14.11

## [1.54.6](https://github.com/vm0-ai/vm0/compare/api-v1.54.5...api-v1.54.6) (2026-05-18)


### Bug Fixes

* close local-agent host on shutdown ([#13653](https://github.com/vm0-ai/vm0/issues/13653)) ([25c506c](https://github.com/vm0-ai/vm0/commit/25c506ca0269195af577f7d7ed889071fffc7230))
* disable api sentry outside production ([#13715](https://github.com/vm0-ai/vm0/issues/13715)) ([679e089](https://github.com/vm0-ai/vm0/commit/679e089d392997c18b9a761ea04f9b038e5e3ac8))
* move built-in generation to provider callbacks ([#13475](https://github.com/vm0-ai/vm0/issues/13475)) ([3476a88](https://github.com/vm0-ai/vm0/commit/3476a885bd0691af362fca7c94727d581d5b2c81))
* remove legacy sandbox cli auth ([#13657](https://github.com/vm0-ai/vm0/issues/13657)) ([f63a1f3](https://github.com/vm0-ai/vm0/commit/f63a1f3e2bd48c3013fa5c0621253d160f788cb2))
* require local-agent realtime notifications ([#13661](https://github.com/vm0-ai/vm0/issues/13661)) ([5455eca](https://github.com/vm0-ai/vm0/commit/5455ecab8d69c0cd60ce70ccee5d6166281e9502))
* route electron auth through api handoff ([#13734](https://github.com/vm0-ai/vm0/issues/13734)) ([52770b9](https://github.com/vm0-ai/vm0/commit/52770b9e3bcbfcc30bf2e4a3ebdadc118731d908))
* share dev tunnel url with api dev server ([#13727](https://github.com/vm0-ai/vm0/issues/13727)) ([60c61ca](https://github.com/vm0-ai/vm0/commit/60c61ca00e296f05e58d814b5ea4443ac8f0d98d))


### Refactoring

* cut over /api/zero/model-providers to API backend ([#13654](https://github.com/vm0-ai/vm0/issues/13654)) ([695cc39](https://github.com/vm0-ai/vm0/commit/695cc399d4d425d9f4e03229ed57e9e0a3497cb0))
* cut over auth me route to api ([#13681](https://github.com/vm0-ai/vm0/issues/13681)) ([a29c470](https://github.com/vm0-ai/vm0/commit/a29c470f7ba9ac358f50cfd2eca2bb3d5624aaab))
* cut over permission access requests route ([#13643](https://github.com/vm0-ai/vm0/issues/13643)) ([44d8a16](https://github.com/vm0-ai/vm0/commit/44d8a16eb8c490c7de7ae77fad0d7386709967bf))
* cut over zero me model-provider delete route ([#13650](https://github.com/vm0-ai/vm0/issues/13650)) ([a6bf6f1](https://github.com/vm0-ai/vm0/commit/a6bf6f10e6f0ccb1ead50bfde97c28638897f991))
* cut over zero me model-providers route ([#13666](https://github.com/vm0-ai/vm0/issues/13666)) ([9094811](https://github.com/vm0-ai/vm0/commit/9094811abd1c9643c6b3c7299462564a7e761ed2))
* cut over zero member credit cap route ([#13664](https://github.com/vm0-ai/vm0/issues/13664)) ([28dfb3e](https://github.com/vm0-ai/vm0/commit/28dfb3e0ed32bbdd8f7fdfd3a027863dc5fcfb70))
* cut over zero onboarding setup route ([#13710](https://github.com/vm0-ai/vm0/issues/13710)) ([0918f8f](https://github.com/vm0-ai/vm0/commit/0918f8f34abfa35cfb5665e9abd41bdf2c852e23))
* cut over zero onboarding status route ([#13639](https://github.com/vm0-ai/vm0/issues/13639)) ([54ca1c9](https://github.com/vm0-ai/vm0/commit/54ca1c9c1bb256b7e3eb72c8ec0fa0e0278371a4))
* cut over zero org delete route ([#13745](https://github.com/vm0-ai/vm0/issues/13745)) ([960e3f0](https://github.com/vm0-ai/vm0/commit/960e3f0e5ed97c52a87bd9b555e04781ab365a05))
* cut over zero org invite route ([#13733](https://github.com/vm0-ai/vm0/issues/13733)) ([d7a3bdd](https://github.com/vm0-ai/vm0/commit/d7a3bddf455165ea000ae5016d49c1312c602795))
* cut over zero org logo route ([#13743](https://github.com/vm0-ai/vm0/issues/13743)) ([95dad74](https://github.com/vm0-ai/vm0/commit/95dad740ecc1cdbdcb3f05fe7eb7d245fb417ffb))
* cut over zero org members route ([#13744](https://github.com/vm0-ai/vm0/issues/13744)) ([01af229](https://github.com/vm0-ai/vm0/commit/01af229dd3ff4adca48a57132167b5c6c7c44cdd))
* cut over zero org membership requests route ([#13694](https://github.com/vm0-ai/vm0/issues/13694)) ([6f92671](https://github.com/vm0-ai/vm0/commit/6f926716735fb1a3760c8fe8db2e141f4b14d766))
* cut over zero skills collection route ([#13642](https://github.com/vm0-ai/vm0/issues/13642)) ([d5a37a3](https://github.com/vm0-ai/vm0/commit/d5a37a3acdc100c68760f327bc01641854745b83))
* cut over zero skills detail route ([#13739](https://github.com/vm0-ai/vm0/issues/13739)) ([b1018d8](https://github.com/vm0-ai/vm0/commit/b1018d8ed08b3dc1b67f6b253d9dbe5f7cf4f512))
* cut over zero team route ([#13634](https://github.com/vm0-ai/vm0/issues/13634)) ([95250ba](https://github.com/vm0-ai/vm0/commit/95250ba655d7b73ecce7ce3bea51f25c7c8b6a66))
* proxy storages commit to api ([#13741](https://github.com/vm0-ai/vm0/issues/13741)) ([f359213](https://github.com/vm0-ai/vm0/commit/f3592130aea010b58bb5fbd7e62cd13e213a5351))
* proxy storages download to api ([#13649](https://github.com/vm0-ai/vm0/issues/13649)) ([ac58522](https://github.com/vm0-ai/vm0/commit/ac58522d6badc85039ea4a850f5e6253f84d7c99))
* proxy storages list to api ([#13616](https://github.com/vm0-ai/vm0/issues/13616)) ([a6516c6](https://github.com/vm0-ai/vm0/commit/a6516c6e7eebccb3c8f6df59257135aa9a994564))
* proxy storages prepare to api ([#13683](https://github.com/vm0-ai/vm0/issues/13683)) ([6b6639d](https://github.com/vm0-ai/vm0/commit/6b6639dee2f06c481ed338b08c886e83663c2f56))
* proxy zero model policies to api ([#13652](https://github.com/vm0-ai/vm0/issues/13652)) ([3e4443e](https://github.com/vm0-ai/vm0/commit/3e4443e9d76a6ad3cc2f914c705b1dd67a9ababf))
* proxy zero report-error to api backend ([#13637](https://github.com/vm0-ai/vm0/issues/13637)) ([daff1c4](https://github.com/vm0-ai/vm0/commit/daff1c49f227733a527a41b2e6870f2f184f2597))
* **web:** proxy zero permission policies to api ([#13646](https://github.com/vm0-ai/vm0/issues/13646)) ([e0ddb2f](https://github.com/vm0-ai/vm0/commit/e0ddb2f4907e3498c588b8663cc335696748b7a0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.30.5
    * @vm0/core bumped to 8.281.3
    * @vm0/db bumped to 1.14.10

## [1.54.5](https://github.com/vm0-ai/vm0/compare/api-v1.54.4...api-v1.54.5) (2026-05-18)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.30.4
    * @vm0/connectors bumped to 1.17.0
    * @vm0/core bumped to 8.281.2
    * @vm0/db bumped to 1.14.9

## [1.54.4](https://github.com/vm0-ai/vm0/compare/api-v1.54.3...api-v1.54.4) (2026-05-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.30.3
    * @vm0/connectors bumped to 1.16.0
    * @vm0/core bumped to 8.281.1
    * @vm0/db bumped to 1.14.8

## [1.54.3](https://github.com/vm0-ai/vm0/compare/api-v1.54.2...api-v1.54.3) (2026-05-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.30.2
    * @vm0/connectors bumped to 1.15.0
    * @vm0/core bumped to 8.281.0
    * @vm0/db bumped to 1.14.7

## [1.54.2](https://github.com/vm0-ai/vm0/compare/api-v1.54.1...api-v1.54.2) (2026-05-17)


### Bug Fixes

* use api vercel project id for sandbox auth ([#13599](https://github.com/vm0-ai/vm0/issues/13599)) ([6a0daf6](https://github.com/vm0-ai/vm0/commit/6a0daf642039250f720ee45f12c08d70c15c939c))


### Refactoring

* proxy logs search to api ([#13589](https://github.com/vm0-ai/vm0/issues/13589)) ([c2365a6](https://github.com/vm0-ai/vm0/commit/c2365a6273827087c45f93e9f9b725e2274f66c1))

## [1.54.1](https://github.com/vm0-ai/vm0/compare/api-v1.54.0...api-v1.54.1) (2026-05-17)


### Bug Fixes

* **api:** route v1 chat send through createZeroRun$ ([#13557](https://github.com/vm0-ai/vm0/issues/13557)) ([0732f67](https://github.com/vm0-ai/vm0/commit/0732f67bd65bfa5028ab21279f04544e4983d82b))


### Performance Improvements

* **api:** cut apps/api tsc memory ~20% via barrel + phantom-inference cleanup ([#13553](https://github.com/vm0-ai/vm0/issues/13553)) ([447e0af](https://github.com/vm0-ai/vm0/commit/447e0af1870b3ca7262f6cd4345b4485c984b046))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.30.1
    * @vm0/connectors bumped to 1.14.1
    * @vm0/core bumped to 8.280.1
    * @vm0/db bumped to 1.14.6

## [1.54.0](https://github.com/vm0-ai/vm0/compare/api-v1.53.0...api-v1.54.0) (2026-05-16)


### Features

* add stripe cli auth browser flow ([#13532](https://github.com/vm0-ai/vm0/issues/13532)) ([0fadd22](https://github.com/vm0-ai/vm0/commit/0fadd226b52d1c7e817a75d47e0e905497d7ddf1))
* expose model and provider routing commands ([#13519](https://github.com/vm0-ai/vm0/issues/13519)) ([25eaf85](https://github.com/vm0-ai/vm0/commit/25eaf85d1c576ce679c32d1beecbdc470bbf09a0))


### Bug Fixes

* align api agent tools prompt ([#13546](https://github.com/vm0-ai/vm0/issues/13546)) ([d78f478](https://github.com/vm0-ai/vm0/commit/d78f478f7bd36e8cd0796677388d761256bb1a73))
* **api:** target runner dispatch by session affinity ([#13529](https://github.com/vm0-ai/vm0/issues/13529)) ([ff4e263](https://github.com/vm0-ai/vm0/commit/ff4e26333c3736075f1e00014af475f0012e030a))
* re-resolve chat thread providers ([#13545](https://github.com/vm0-ai/vm0/issues/13545)) ([08b13c8](https://github.com/vm0-ai/vm0/commit/08b13c8d2c7e7c12c650a613b86d3d3d7ec928d4))


### Refactoring

* proxy push subscriptions to api ([#13536](https://github.com/vm0-ai/vm0/issues/13536)) ([9fb1698](https://github.com/vm0-ai/vm0/commit/9fb1698d300ff994c60267083e015580a43b854c))


### Performance Improvements

* **api:** trim tsc include and enable incremental ([#13540](https://github.com/vm0-ai/vm0/issues/13540)) ([c77764c](https://github.com/vm0-ai/vm0/commit/c77764c3038266818673cca50ed1f8a186f23e67))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.30.0
    * @vm0/connectors bumped to 1.14.0
    * @vm0/core bumped to 8.280.0
    * @vm0/db bumped to 1.14.5

## [1.53.0](https://github.com/vm0-ai/vm0/compare/api-v1.52.3...api-v1.53.0) (2026-05-16)


### Features

* support custom connector host wildcards ([#13513](https://github.com/vm0-ai/vm0/issues/13513)) ([2416d13](https://github.com/vm0-ai/vm0/commit/2416d13aea112966572d48334c1ff80e690ae3a5))


### Refactoring

* proxy user model preference to api ([#13523](https://github.com/vm0-ai/vm0/issues/13523)) ([fdbb539](https://github.com/vm0-ai/vm0/commit/fdbb53963075023dbc15c760adf0bbb991660af4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.29.0
    * @vm0/connectors bumped to 1.13.0
    * @vm0/core bumped to 8.279.0
    * @vm0/db bumped to 1.14.4

## [1.52.3](https://github.com/vm0-ai/vm0/compare/api-v1.52.2...api-v1.52.3) (2026-05-15)


### Refactoring

* rename remote-agent to local-agent across cli + platform ([#13511](https://github.com/vm0-ai/vm0/issues/13511)) ([fc419a4](https://github.com/vm0-ai/vm0/commit/fc419a41ad6d046c04b4bf641ad8cb076064c054))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.28.1
    * @vm0/connectors bumped to 1.12.2
    * @vm0/core bumped to 8.278.2
    * @vm0/db bumped to 1.14.3

## [1.52.2](https://github.com/vm0-ai/vm0/compare/api-v1.52.1...api-v1.52.2) (2026-05-15)


### Refactoring

* proxy voice-io stt route to api backend ([#13501](https://github.com/vm0-ai/vm0/issues/13501)) ([f16cc64](https://github.com/vm0-ai/vm0/commit/f16cc64bc9b86c797ad39b6502ed19b78b1bfdc7))

## [1.52.1](https://github.com/vm0-ai/vm0/compare/api-v1.52.0...api-v1.52.1) (2026-05-15)


### Bug Fixes

* **api:** resolve resume session history from R2 hash ([#13495](https://github.com/vm0-ai/vm0/issues/13495)) ([2fce61f](https://github.com/vm0-ai/vm0/commit/2fce61fc6b7f727a85796cf9d665fc90fc9cc6ea)), closes [#13489](https://github.com/vm0-ai/vm0/issues/13489)


### Refactoring

* proxy voice-io speech route to api backend ([#13473](https://github.com/vm0-ai/vm0/issues/13473)) ([829be26](https://github.com/vm0-ai/vm0/commit/829be26fb2d1f2ee46584199a178fe77e269a26c))
* proxy zero voice-chat token to api backend ([#13500](https://github.com/vm0-ai/vm0/issues/13500)) ([244fff8](https://github.com/vm0-ai/vm0/commit/244fff8600d643ac2cb6c12444a2b63a26dc258b))

## [1.52.0](https://github.com/vm0-ai/vm0/compare/api-v1.51.1...api-v1.52.0) (2026-05-15)


### Features

* **zero-host:** add org hash to hosted site domain to prevent slug conflicts ([#13485](https://github.com/vm0-ai/vm0/issues/13485)) ([4ac102c](https://github.com/vm0-ai/vm0/commit/4ac102c5944e44957a29a1c6f79bf38ff54f3df0))


### Refactoring

* **web:** proxy voice chat tasks to api backend ([#13444](https://github.com/vm0-ai/vm0/issues/13444)) ([8dbcf6e](https://github.com/vm0-ai/vm0/commit/8dbcf6ec4dc4dc84cc25dfdd03c2c1525aa84392))

## [1.51.1](https://github.com/vm0-ai/vm0/compare/api-v1.51.0...api-v1.51.1) (2026-05-15)


### Bug Fixes

* align host worker deploy with release-please ([#13466](https://github.com/vm0-ai/vm0/issues/13466)) ([95b2669](https://github.com/vm0-ai/vm0/commit/95b2669913ddae625191ffe97ea6af56e756b340))
* isolate image pricing route test ([#13469](https://github.com/vm0-ai/vm0/issues/13469)) ([af7e3f6](https://github.com/vm0-ai/vm0/commit/af7e3f639073e014670fe5c842973a2fbcc7a32d))
* limit built-in generations per run ([#13453](https://github.com/vm0-ai/vm0/issues/13453)) ([36acef6](https://github.com/vm0-ai/vm0/commit/36acef6a0a8a6e807622521253ed0024e6f5bd42))
* update image generation defaults ([#13471](https://github.com/vm0-ai/vm0/issues/13471)) ([73db760](https://github.com/vm0-ai/vm0/commit/73db760e0240dfc332c6283d84bcd18028e018a4))


### Refactoring

* cut over zero uploads complete route ([#13462](https://github.com/vm0-ai/vm0/issues/13462)) ([b2aa8d6](https://github.com/vm0-ai/vm0/commit/b2aa8d6ec593331beb660cba2e8a6b009ab3b274))
* cut over zero web file download route ([#13432](https://github.com/vm0-ai/vm0/issues/13432)) ([a205f29](https://github.com/vm0-ai/vm0/commit/a205f296f793b7860ce742863fcb6cea32d11475))
* **web:** cut over usage runs route to api backend ([#13447](https://github.com/vm0-ai/vm0/issues/13447)) ([2ab9f26](https://github.com/vm0-ai/vm0/commit/2ab9f26365b3df091e064df2607f4ee6d5a556df))
* **web:** proxy voice-chat item append to api ([#13413](https://github.com/vm0-ai/vm0/issues/13413)) ([8b80563](https://github.com/vm0-ai/vm0/commit/8b805631d52b790b3ed9d30a555cf907bdf62d3c))
* **web:** proxy voice-chat session detail to API backend ([#13411](https://github.com/vm0-ai/vm0/issues/13411)) ([b2f8eef](https://github.com/vm0-ai/vm0/commit/b2f8eef87c453738bcf6422d5b77478f5a5e6839))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/db bumped to 1.14.2

## [1.51.0](https://github.com/vm0-ai/vm0/compare/api-v1.50.0...api-v1.51.0) (2026-05-15)


### Features

* add presentation image model option ([#13436](https://github.com/vm0-ai/vm0/issues/13436)) ([b17f2a2](https://github.com/vm0-ai/vm0/commit/b17f2a2f823bb772010f159ec5e41967061a7eb1))
* gate billable firewall auth on credits ([#13433](https://github.com/vm0-ai/vm0/issues/13433)) ([235587d](https://github.com/vm0-ai/vm0/commit/235587df8efd5539d87e3fddda72c9726e231a9e))


### Bug Fixes

* make built-in generation asynchronous ([#13416](https://github.com/vm0-ai/vm0/issues/13416)) ([11104c8](https://github.com/vm0-ai/vm0/commit/11104c8b0a1c77f95ea219171821905bc9e1d27b))


### Refactoring

* gate connector auth methods ([#13426](https://github.com/vm0-ai/vm0/issues/13426)) ([3d5fa56](https://github.com/vm0-ai/vm0/commit/3d5fa56f7ad3bf1f386a88a8006f6428e97eb7b4))
* proxy voice io quota route to api ([#13409](https://github.com/vm0-ai/vm0/issues/13409)) ([d730f31](https://github.com/vm0-ai/vm0/commit/d730f318f9090d812f91c8f6fdd19a8444413a11))
* **web:** proxy zero voice-chat collection to api backend ([#13412](https://github.com/vm0-ai/vm0/issues/13412)) ([d216d92](https://github.com/vm0-ai/vm0/commit/d216d926116b889aa88b1a9efea0d4fb59447dfa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.28.0
    * @vm0/connectors bumped to 1.12.1
    * @vm0/core bumped to 8.278.1
    * @vm0/db bumped to 1.14.1

## [1.50.0](https://github.com/vm0-ai/vm0/compare/api-v1.49.0...api-v1.50.0) (2026-05-15)


### Features

* add built-in image model options ([#13381](https://github.com/vm0-ai/vm0/issues/13381)) ([ae89855](https://github.com/vm0-ai/vm0/commit/ae8985539dc9864ed0fd69ad228d2e48d6f1c718))
* add local-browser host and audit cli ([#13394](https://github.com/vm0-ai/vm0/issues/13394)) ([8786ed7](https://github.com/vm0-ai/vm0/commit/8786ed74f2a52cc50ea08689f781f4b4cab7bdae))
* enable private agents by default ([#13417](https://github.com/vm0-ai/vm0/issues/13417)) ([4710b9f](https://github.com/vm0-ai/vm0/commit/4710b9fcb95c95bddbbaa28aad971d1d885431cd))


### Bug Fixes

* clean orphan zero agent composes ([#13386](https://github.com/vm0-ai/vm0/issues/13386)) ([4a2b2c2](https://github.com/vm0-ai/vm0/commit/4a2b2c2d35ac4e756261311b6be7291f2208dd64))
* improve presentation generation and previews ([#13393](https://github.com/vm0-ai/vm0/issues/13393)) ([fb08663](https://github.com/vm0-ai/vm0/commit/fb086637a04323b7439554dc35e8b8d06c8ea3aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.27.0
    * @vm0/core bumped to 8.278.0
    * @vm0/db bumped to 1.14.0

## [1.49.0](https://github.com/vm0-ai/vm0/compare/api-v1.48.0...api-v1.49.0) (2026-05-15)


### Features

* add local-browser write approvals ([#13368](https://github.com/vm0-ai/vm0/issues/13368)) ([6b226ba](https://github.com/vm0-ai/vm0/commit/6b226baae25cf08f80b96902d3cfa1673c2c756d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.26.0
    * @vm0/core bumped to 8.277.1
    * @vm0/db bumped to 1.13.0

## [1.48.0](https://github.com/vm0-ai/vm0/compare/api-v1.47.2...api-v1.48.0) (2026-05-15)


### Features

* add local-browser read command queue ([#13338](https://github.com/vm0-ai/vm0/issues/13338)) ([a627678](https://github.com/vm0-ai/vm0/commit/a627678ad051ba97d9d4748418b89784542275ea))
* add zero hosted sites ([#13135](https://github.com/vm0-ai/vm0/issues/13135)) ([7e5c995](https://github.com/vm0-ai/vm0/commit/7e5c995810af12c79a2c704459dba2265df2d23d))
* harden cli auth lifecycle ([#13361](https://github.com/vm0-ai/vm0/issues/13361)) ([37b9b84](https://github.com/vm0-ai/vm0/commit/37b9b8478feb294b06e921d377cf47b198405937))


### Bug Fixes

* route api chat runs through zero run service ([#13362](https://github.com/vm0-ai/vm0/issues/13362)) ([4b66ccf](https://github.com/vm0-ai/vm0/commit/4b66ccf8d1b964cc5e4d5f91479d30ac3385b6f0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.25.0
    * @vm0/connectors bumped to 1.12.0
    * @vm0/core bumped to 8.277.0
    * @vm0/db bumped to 1.12.0

## [1.47.2](https://github.com/vm0-ai/vm0/compare/api-v1.47.1...api-v1.47.2) (2026-05-15)


### Bug Fixes

* accept ZERO_TOKEN on connector search route ([#13349](https://github.com/vm0-ai/vm0/issues/13349)) ([86a16ee](https://github.com/vm0-ai/vm0/commit/86a16ee038ebafc3138a25a1284dbbe05485c9ef))
* build run skill volumes from the model provider framework ([#13352](https://github.com/vm0-ai/vm0/issues/13352)) ([351d2bc](https://github.com/vm0-ai/vm0/commit/351d2bca28854e20f8899f3196ff10b8f7f1216c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.24.2
    * @vm0/core bumped to 8.276.4
    * @vm0/db bumped to 1.11.3

## [1.47.1](https://github.com/vm0-ai/vm0/compare/api-v1.47.0...api-v1.47.1) (2026-05-14)


### Refactoring

* **onboarding:** simplify to admin-only workspace setup ([#13330](https://github.com/vm0-ai/vm0/issues/13330)) ([8d1d2ce](https://github.com/vm0-ai/vm0/commit/8d1d2ce78d03b6e53c497ce5ba433cfca061b622))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.24.1
    * @vm0/core bumped to 8.276.3
    * @vm0/db bumped to 1.11.2

## [1.47.0](https://github.com/vm0-ai/vm0/compare/api-v1.46.0...api-v1.47.0) (2026-05-14)


### Features

* **api:** support Stripe CLI auth modes ([#13344](https://github.com/vm0-ai/vm0/issues/13344)) ([45803c0](https://github.com/vm0-ai/vm0/commit/45803c02557b3f813766a4e6d597b0b7fae5bb19))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.24.0
    * @vm0/core bumped to 8.276.2
    * @vm0/db bumped to 1.11.1

## [1.46.0](https://github.com/vm0-ai/vm0/compare/api-v1.45.0...api-v1.46.0) (2026-05-14)


### Features

* add local-browser pairing runtime ([#13329](https://github.com/vm0-ai/vm0/issues/13329)) ([63d66fb](https://github.com/vm0-ai/vm0/commit/63d66fbb868996e9d41a897cda5bf8bd45bfbddc))
* **api:** persist cli auth sessions ([#13317](https://github.com/vm0-ai/vm0/issues/13317)) ([c42dc30](https://github.com/vm0-ai/vm0/commit/c42dc30fe738dbcc76788a5442745933279c8866))


### Bug Fixes

* filter typing event consumers ([#13337](https://github.com/vm0-ai/vm0/issues/13337)) ([cf9611d](https://github.com/vm0-ai/vm0/commit/cf9611d25a3ff8bcc9cf45431058dc7e615b2ae6))


### Refactoring

* extract stripe cli auth parser ([#13342](https://github.com/vm0-ai/vm0/issues/13342)) ([2be05b8](https://github.com/vm0-ai/vm0/commit/2be05b8d1a33d0ab28b66bed8a4e51fe9b658c56))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.23.0
    * @vm0/core bumped to 8.276.1
    * @vm0/db bumped to 1.11.0

## [1.45.0](https://github.com/vm0-ai/vm0/compare/api-v1.44.2...api-v1.45.0) (2026-05-14)


### Features

* add local-browser connector foundation ([#13241](https://github.com/vm0-ai/vm0/issues/13241)) ([74eaaaa](https://github.com/vm0-ai/vm0/commit/74eaaaa0ea6876014d08562ae284db1cc10139a5))
* **api:** add stripe cli auth import flow ([#13273](https://github.com/vm0-ai/vm0/issues/13273)) ([25d59c5](https://github.com/vm0-ai/vm0/commit/25d59c58c08b188d56110a4874cb6d9388b2ecdc))


### Refactoring

* **api:** migrate AgentPhone routes to API backend ([#13312](https://github.com/vm0-ai/vm0/issues/13312)) ([c6a6024](https://github.com/vm0-ai/vm0/commit/c6a602455197067b119e134c41feeba6bdb5d6fe))
* **api:** migrate cleanup sandboxes cron route ([#13295](https://github.com/vm0-ai/vm0/issues/13295)) ([09a3ea8](https://github.com/vm0-ai/vm0/commit/09a3ea8e8b6f908b548c5a5023d6e7d480cd50bf))
* **api:** migrate execute schedules cron route ([#13298](https://github.com/vm0-ai/vm0/issues/13298)) ([f1ec469](https://github.com/vm0-ai/vm0/commit/f1ec469c1495f5463056c4519430daeb5c56c018))
* **api:** migrate skills sync cron route ([#13288](https://github.com/vm0-ai/vm0/issues/13288)) ([e0c8547](https://github.com/vm0-ai/vm0/commit/e0c8547eb276d5b34b1add515c3480b39e91c7a3))
* **api:** migrate voice-chat billing routes ([#13316](https://github.com/vm0-ai/vm0/issues/13316)) ([bd33472](https://github.com/vm0-ai/vm0/commit/bd33472486c30ee0491df2bd61edeb835a39b3d9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.22.0
    * @vm0/connectors bumped to 1.11.0
    * @vm0/core bumped to 8.276.0
    * @vm0/db bumped to 1.10.0

## [1.44.2](https://github.com/vm0-ai/vm0/compare/api-v1.44.1...api-v1.44.2) (2026-05-14)


### Refactoring

* **api:** migrate email outbox cron route ([#13269](https://github.com/vm0-ai/vm0/issues/13269)) ([bac00c1](https://github.com/vm0-ai/vm0/commit/bac00c1e1e69b4d0376387b59f871ec49b4a9fe3))
* **api:** migrate voice chat cleanup cron route ([#13265](https://github.com/vm0-ai/vm0/issues/13265)) ([1820c4d](https://github.com/vm0-ai/vm0/commit/1820c4df0ea6d124c6dcd803885255308a268024))
* migrate agent firewall auth webhook to api ([#13268](https://github.com/vm0-ai/vm0/issues/13268)) ([503491f](https://github.com/vm0-ai/vm0/commit/503491fecbe370abf4caa325f674814290db3ec2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.21.0
    * @vm0/core bumped to 8.275.4
    * @vm0/db bumped to 1.9.7

## [1.44.1](https://github.com/vm0-ai/vm0/compare/api-v1.44.0...api-v1.44.1) (2026-05-14)


### Bug Fixes

* **api:** sanitize run detail telemetry responses ([#13245](https://github.com/vm0-ai/vm0/issues/13245)) ([ac03118](https://github.com/vm0-ai/vm0/commit/ac03118d566f887eb2195cd389f734bb3af7198c))
* attribute generated asset usage to runs ([#13239](https://github.com/vm0-ai/vm0/issues/13239)) ([eefe3cd](https://github.com/vm0-ai/vm0/commit/eefe3cd5dc5bc91bebae2eedda76e9bc3c49c50e))
* migrate telegram dispatch probe to api ([#13237](https://github.com/vm0-ai/vm0/issues/13237)) ([b0f4206](https://github.com/vm0-ai/vm0/commit/b0f4206b9ff1dcac483c990eb0879588d5754946))


### Refactoring

* **api:** migrate agent checkpoint webhooks ([#13238](https://github.com/vm0-ai/vm0/issues/13238)) ([a9873d7](https://github.com/vm0-ai/vm0/commit/a9873d7b18d2986ad2d51da476c40fd3839314c3))
* migrate agent event webhook to api ([#13244](https://github.com/vm0-ai/vm0/issues/13244)) ([7e8281e](https://github.com/vm0-ai/vm0/commit/7e8281e9aaf134562b1c7df864e036a1ab0476ae))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.20.1
    * @vm0/connectors bumped to 1.10.0
    * @vm0/core bumped to 8.275.3
    * @vm0/db bumped to 1.9.6

## [1.44.0](https://github.com/vm0-ai/vm0/compare/api-v1.43.4...api-v1.44.0) (2026-05-14)


### Features

* **api:** add serverless vercel sandbox abstraction ([#13225](https://github.com/vm0-ai/vm0/issues/13225)) ([4a69f93](https://github.com/vm0-ai/vm0/commit/4a69f93e503df3541f02cf6b138b0f6616e0c555))
* **api:** migrate telegram post routes ([#13223](https://github.com/vm0-ai/vm0/issues/13223)) ([27c7b2a](https://github.com/vm0-ai/vm0/commit/27c7b2a7ab1dd9f09f1f27bcf5ea4e641a22106d))


### Bug Fixes

* align api run context session snapshots ([#13222](https://github.com/vm0-ai/vm0/issues/13222)) ([72b1f68](https://github.com/vm0-ai/vm0/commit/72b1f6893ab0c9bbb4f803fc729dd5e3f8403631))
* resolve api model-first runtime framework ([#13221](https://github.com/vm0-ai/vm0/issues/13221)) ([d1ce254](https://github.com/vm0-ai/vm0/commit/d1ce2543579cd1ec9b832df484017656b0dcdfdf))


### Refactoring

* migrate agent storage webhooks ([#13224](https://github.com/vm0-ai/vm0/issues/13224)) ([d278077](https://github.com/vm0-ai/vm0/commit/d27807718b4c9ec7098081219af73457313f9792))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.20.0
    * @vm0/connectors bumped to 1.9.1
    * @vm0/core bumped to 8.275.2
    * @vm0/db bumped to 1.9.5

## [1.43.4](https://github.com/vm0-ai/vm0/compare/api-v1.43.3...api-v1.43.4) (2026-05-14)


### Bug Fixes

* dispatch api run failure callbacks ([#13217](https://github.com/vm0-ai/vm0/issues/13217)) ([5908f79](https://github.com/vm0-ai/vm0/commit/5908f79c5dc7319b3953ea9110991026f434e553))


### Refactoring

* migrate agent health usage telemetry webhooks ([#13219](https://github.com/vm0-ai/vm0/issues/13219)) ([5130aa5](https://github.com/vm0-ai/vm0/commit/5130aa536b280a58a3ed9b4ef70c1574ef514644))

## [1.43.3](https://github.com/vm0-ai/vm0/compare/api-v1.43.2...api-v1.43.3) (2026-05-14)


### Bug Fixes

* **agentphone:** preserve email Apple ID handles for inbound iMessage webhooks ([#13203](https://github.com/vm0-ai/vm0/issues/13203)) ([8a014b9](https://github.com/vm0-ai/vm0/commit/8a014b9bc50764f89c963d5bf02fa27f82ec6309))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.19.2
    * @vm0/core bumped to 8.275.1
    * @vm0/db bumped to 1.9.4

## [1.43.2](https://github.com/vm0-ai/vm0/compare/api-v1.43.1...api-v1.43.2) (2026-05-13)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.275.0

## [1.43.1](https://github.com/vm0-ai/vm0/compare/api-v1.43.0...api-v1.43.1) (2026-05-13)


### Bug Fixes

* enable built-in openai codex billing ([#13193](https://github.com/vm0-ai/vm0/issues/13193)) ([616ad30](https://github.com/vm0-ai/vm0/commit/616ad30f79a0e046ece9a62ea8b195d1bfe6b407))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.19.1
    * @vm0/connectors bumped to 1.9.0
    * @vm0/core bumped to 8.274.2
    * @vm0/db bumped to 1.9.3

## [1.43.0](https://github.com/vm0-ai/vm0/compare/api-v1.42.1...api-v1.43.0) (2026-05-13)


### Features

* **zero:** expose gpt-image-2 generation options ([#13190](https://github.com/vm0-ai/vm0/issues/13190)) ([b2df33d](https://github.com/vm0-ai/vm0/commit/b2df33d007203bd298c28fcc52d41bbaa5161c24))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.19.0
    * @vm0/core bumped to 8.274.1
    * @vm0/db bumped to 1.9.2

## [1.42.1](https://github.com/vm0-ai/vm0/compare/api-v1.42.0...api-v1.42.1) (2026-05-13)


### Bug Fixes

* log AgentPhone verification send failures ([#13184](https://github.com/vm0-ai/vm0/issues/13184)) ([00dee4a](https://github.com/vm0-ai/vm0/commit/00dee4a0aa4509bf90cf5c02cd13f5f27ccfc300))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.274.0

## [1.42.0](https://github.com/vm0-ai/vm0/compare/api-v1.41.0...api-v1.42.0) (2026-05-13)


### Features

* add vercel sandbox smoke path ([#13163](https://github.com/vm0-ai/vm0/issues/13163)) ([fb961ed](https://github.com/vm0-ai/vm0/commit/fb961ed7e229d1917589bcc79cbd84c6172a17be))

## [1.41.0](https://github.com/vm0-ai/vm0/compare/api-v1.40.0...api-v1.41.0) (2026-05-13)


### Features

* add agentphone app ui ([#13080](https://github.com/vm0-ai/vm0/issues/13080)) ([ee19fc5](https://github.com/vm0-ai/vm0/commit/ee19fc53fc786fd8890d8a0bc3a6209d86f41889))
* add fal video generation ([#13121](https://github.com/vm0-ai/vm0/issues/13121)) ([152b289](https://github.com/vm0-ai/vm0/commit/152b28990211cb7ea3756218adab2e0152c41947))
* add model-first policy admin controls ([#12180](https://github.com/vm0-ai/vm0/issues/12180)) ([ff5b8c9](https://github.com/vm0-ai/vm0/commit/ff5b8c9b8d5fe06ff0120724f509d5baa873ade2))
* add private agents ([#12655](https://github.com/vm0-ai/vm0/issues/12655)) ([e37c8e5](https://github.com/vm0-ai/vm0/commit/e37c8e535da8ce48e011066b7c99e8ebffd8f076))
* add remote agent connector ([#12905](https://github.com/vm0-ai/vm0/issues/12905)) ([7627df6](https://github.com/vm0-ai/vm0/commit/7627df6dcb78e27bdac6d1c81d44f8f384b4de36))
* add remote-agent cli execution flow ([#12671](https://github.com/vm0-ai/vm0/issues/12671)) ([4f68949](https://github.com/vm0-ai/vm0/commit/4f68949d869868851ef281911160bf2b138a75ec))
* add remote-agent run inspection commands ([#12971](https://github.com/vm0-ai/vm0/issues/12971)) ([27c2da0](https://github.com/vm0-ai/vm0/commit/27c2da07db02ed1b227fb70a93a64b3cb16a6926))
* add web chat context prompt ([#13168](https://github.com/vm0-ai/vm0/issues/13168)) ([5122b36](https://github.com/vm0-ai/vm0/commit/5122b36463b009abe1763b722722f1f9526c7624))
* **api:** add attachDatabasePool and env-configurable pool params ([#12239](https://github.com/vm0-ai/vm0/issues/12239)) ([b4f000d](https://github.com/vm0-ai/vm0/commit/b4f000d86f0792dcb09d50c4c2865b2afbb63993))
* **api:** add callback-route hmac auth primitive (prereq for Wave 6 [#19](https://github.com/vm0-ai/vm0/issues/19)) ([#12768](https://github.com/vm0-ai/vm0/issues/12768)) ([d25165a](https://github.com/vm0-ai/vm0/commit/d25165a0ea8618833484168fc46b974cedaf35a2))
* **api:** implement agent run create and cancel routes ([#13035](https://github.com/vm0-ai/vm0/issues/13035)) ([d9ec3af](https://github.com/vm0-ai/vm0/commit/d9ec3af52581f2d0fba217226eba9dbe3a6e2bb3))
* **api:** implement zero org members list clerk parity ([#12447](https://github.com/vm0-ai/vm0/issues/12447)) ([19f4888](https://github.com/vm0-ai/vm0/commit/19f4888f517dbf4cb277e0199e6e0242768cd374))
* **api:** migrate agent compose metadata route ([#13007](https://github.com/vm0-ai/vm0/issues/13007)) ([7aab48e](https://github.com/vm0-ai/vm0/commit/7aab48ec2d9c6ade59686d73031632214f3ab688))
* **api:** migrate auto-recharge put to api backend (wave 6 [#9](https://github.com/vm0-ai/vm0/issues/9)) ([#12715](https://github.com/vm0-ai/vm0/issues/12715)) ([5fb26e1](https://github.com/vm0-ai/vm0/commit/5fb26e181a42817bd7fa21237e7d85e2fe44eafc)), closes [#12290](https://github.com/vm0-ai/vm0/issues/12290) [#12711](https://github.com/vm0-ai/vm0/issues/12711)
* **api:** migrate billing checkout endpoint to api backend ([#12596](https://github.com/vm0-ai/vm0/issues/12596)) ([#12606](https://github.com/vm0-ai/vm0/issues/12606)) ([a666f95](https://github.com/vm0-ai/vm0/commit/a666f9528f008b1e825d7081f273788aa17a230f))
* **api:** migrate billing downgrade endpoint to api backend ([#12680](https://github.com/vm0-ai/vm0/issues/12680)) ([#12697](https://github.com/vm0-ai/vm0/issues/12697)) ([bb19bf0](https://github.com/vm0-ai/vm0/commit/bb19bf0a0f6a93dd53890a4062ca9335e4eaf3a2))
* **api:** migrate billing/redeem post to api backend (wave 6 [#14](https://github.com/vm0-ai/vm0/issues/14)) ([#12751](https://github.com/vm0-ai/vm0/issues/12751)) ([9848d11](https://github.com/vm0-ai/vm0/commit/9848d118aeb473d3abc56cc647b4f170f51e7a25))
* **api:** migrate chat-threads patch [id] (update draft) to api backend ([#12569](https://github.com/vm0-ai/vm0/issues/12569)) ([d706640](https://github.com/vm0-ai/vm0/commit/d706640a6f3d25b2b54d693f5cd8ad4912868f62))
* **api:** migrate chat-threads pin route to api backend ([#12517](https://github.com/vm0-ai/vm0/issues/12517)) ([f2188d4](https://github.com/vm0-ai/vm0/commit/f2188d40c16ba7f0cfa8ae048348fc3c002866bd))
* **api:** migrate computer-use register+unregister to api backend (wave 6 [#16](https://github.com/vm0-ai/vm0/issues/16)) ([#12750](https://github.com/vm0-ai/vm0/issues/12750)) ([8437d31](https://github.com/vm0-ai/vm0/commit/8437d31c3cfb8765601337dbb8d58aa19da62ab9)), closes [#12737](https://github.com/vm0-ai/vm0/issues/12737) [#12290](https://github.com/vm0-ai/vm0/issues/12290)
* **api:** migrate custom-connectors put [id]/secret to api backend ([#12534](https://github.com/vm0-ai/vm0/issues/12534)) ([34e1242](https://github.com/vm0-ai/vm0/commit/34e12422714c98cfac944d061107bba0bca67218))
* **api:** migrate github integration update route ([#13015](https://github.com/vm0-ai/vm0/issues/13015)) ([b5663ab](https://github.com/vm0-ai/vm0/commit/b5663ab73f329263af46adf3eda72a247fbd30b2))
* **api:** migrate integrations/slack/connect post to api backend ([#12795](https://github.com/vm0-ai/vm0/issues/12795)) ([cea3812](https://github.com/vm0-ai/vm0/commit/cea381281078dcf2874279510d9e4ac074ac12f9))
* **api:** migrate integrations/slack/message post to api backend (wave 6 [#15](https://github.com/vm0-ai/vm0/issues/15)) ([#12748](https://github.com/vm0-ai/vm0/issues/12748)) ([5d39641](https://github.com/vm0-ai/vm0/commit/5d396418e9de7689811f742bc6355abb06a0eedb))
* **api:** migrate integrations/slack/upload-file init+complete to api backend (wave 6 [#18](https://github.com/vm0-ai/vm0/issues/18)) ([#12767](https://github.com/vm0-ai/vm0/issues/12767)) ([fad9050](https://github.com/vm0-ai/vm0/commit/fad9050746abb4292017e2c9e2f7542333d3e84f))
* **api:** migrate integrations/telegram/upload-file init+complete to api backend (wave 6 [#17](https://github.com/vm0-ai/vm0/issues/17)) ([#12752](https://github.com/vm0-ai/vm0/issues/12752)) ([6cb78ac](https://github.com/vm0-ai/vm0/commit/6cb78ac1f03145836e7fdd482b5cce235e83ef1e))
* **api:** migrate internal telegram-typing post to api backend ([#12525](https://github.com/vm0-ai/vm0/issues/12525)) ([29f62cf](https://github.com/vm0-ai/vm0/commit/29f62cfee65a19b6d23e5d9f6be80f41a3dac067))
* **api:** migrate me/model-providers post [type]/default to api backend ([#12560](https://github.com/vm0-ai/vm0/issues/12560)) ([af6c776](https://github.com/vm0-ai/vm0/commit/af6c776e4923c05dc8cb9b6f435a9aa2d67b56a5))
* **api:** migrate me/model-providers post upsert to api backend (Wave 5 — completes family) ([#12591](https://github.com/vm0-ai/vm0/issues/12591)) ([acca625](https://github.com/vm0-ai/vm0/commit/acca625468e9d19e8c6eb8133a7ecb68998f4060))
* **api:** migrate onboarding/complete post to api backend ([#12695](https://github.com/vm0-ai/vm0/issues/12695)) ([622a993](https://github.com/vm0-ai/vm0/commit/622a99373eb7c33bf796538771281199c779f261))
* **api:** migrate org model-provider mutations ([#12972](https://github.com/vm0-ai/vm0/issues/12972)) ([54a5eb7](https://github.com/vm0-ai/vm0/commit/54a5eb775ee0194181b11a98fd9d1bbf641b6736))
* **api:** migrate org/invite delete (revoke) to api backend (wave 6 [#11](https://github.com/vm0-ai/vm0/issues/11)) ([#12724](https://github.com/vm0-ai/vm0/issues/12724)) ([cede412](https://github.com/vm0-ai/vm0/commit/cede41246203854349cc5da8a91e2b4b26c02019))
* **api:** migrate org/members/credit-cap put to api backend (wave 6 [#13](https://github.com/vm0-ai/vm0/issues/13)) ([#12732](https://github.com/vm0-ai/vm0/issues/12732)) ([566a767](https://github.com/vm0-ai/vm0/commit/566a76775d26130b2e4444f4f5f40a89a1275e96)), closes [#12290](https://github.com/vm0-ai/vm0/issues/12290) [#12726](https://github.com/vm0-ai/vm0/issues/12726)
* **api:** migrate org/membership-requests accept+reject to api backend (wave 6 [#12](https://github.com/vm0-ai/vm0/issues/12)) ([#12728](https://github.com/vm0-ai/vm0/issues/12728)) ([4df31c6](https://github.com/vm0-ai/vm0/commit/4df31c6c7e68fb53fca5643fa8c2f2add23ca04a))
* **api:** migrate permission-policies put to api backend (Wave 6 [#6](https://github.com/vm0-ai/vm0/issues/6)) ([#12687](https://github.com/vm0-ai/vm0/issues/12687)) ([843d550](https://github.com/vm0-ai/vm0/commit/843d55024d5b848912e9b01cc8ce0356c26e33c0))
* **api:** migrate push-subscriptions post to api backend (wave 6 [#8](https://github.com/vm0-ai/vm0/issues/8)) ([#12694](https://github.com/vm0-ai/vm0/issues/12694)) ([864ec4d](https://github.com/vm0-ai/vm0/commit/864ec4d66dc9c0b3cfcfb01fec03d9b77cf925de)), closes [#12683](https://github.com/vm0-ai/vm0/issues/12683)
* **api:** migrate schedules enable/disable post to api backend (wave 6 [#10](https://github.com/vm0-ai/vm0/issues/10)) ([#12722](https://github.com/vm0-ai/vm0/issues/12722)) ([38add2b](https://github.com/vm0-ai/vm0/commit/38add2bfea1db1327ace023b90ddedd5a86423ef)), closes [#12713](https://github.com/vm0-ai/vm0/issues/12713)
* **api:** migrate telegram link route ([#13031](https://github.com/vm0-ai/vm0/issues/13031)) ([510d5e8](https://github.com/vm0-ai/vm0/commit/510d5e85b62e93ad61a807f1629d7d2979b5fd24))
* **api:** migrate test oauth token route ([#12998](https://github.com/vm0-ai/vm0/issues/12998)) ([e6f75b9](https://github.com/vm0-ai/vm0/commit/e6f75b96ce0533710e503e206db5fae0db9afa37))
* **api:** migrate third-party webhooks ([#13160](https://github.com/vm0-ai/vm0/issues/13160)) ([ad242ca](https://github.com/vm0-ai/vm0/commit/ad242cae340445b92e24bc5d8240ad0f32532cd3))
* **api:** migrate variables delete [name] to api backend ([#12549](https://github.com/vm0-ai/vm0/issues/12549)) ([808c8ae](https://github.com/vm0-ai/vm0/commit/808c8aece8b067b69cf27e0ab7cdc635decf0ec5))
* **api:** migrate voice io post routes ([#12944](https://github.com/vm0-ai/vm0/issues/12944)) ([384fef8](https://github.com/vm0-ai/vm0/commit/384fef84e7b87163e0dc47f4a0112f11a72394ea))
* **api:** migrate zero agents create route ([#13159](https://github.com/vm0-ai/vm0/issues/13159)) ([d9b751e](https://github.com/vm0-ai/vm0/commit/d9b751eea5c4ba187bfb2b4d5a35d4809f6fd02b))
* **api:** migrate zero chat messages route ([#13060](https://github.com/vm0-ai/vm0/issues/13060)) ([3047e83](https://github.com/vm0-ai/vm0/commit/3047e8393e2d24e6075ef3bb8643b989f08411f3))
* **api:** migrate zero connector post routes ([#12987](https://github.com/vm0-ai/vm0/issues/12987)) ([45d831e](https://github.com/vm0-ai/vm0/commit/45d831e9a78dcdf34f1a0f473210a007f541ff5e))
* **api:** migrate zero email routes ([#13150](https://github.com/vm0-ai/vm0/issues/13150)) ([f65657e](https://github.com/vm0-ai/vm0/commit/f65657e0675667c31bda43e93b4534047b8ae9f5))
* **api:** migrate zero org logo delete route ([#12994](https://github.com/vm0-ai/vm0/issues/12994)) ([1bfd352](https://github.com/vm0-ai/vm0/commit/1bfd352141b94630b71194661b1dfca2860e098a))
* **api:** migrate zero schedules deploy and run routes ([#13137](https://github.com/vm0-ai/vm0/issues/13137)) ([5affefa](https://github.com/vm0-ai/vm0/commit/5affefa7531aa2f658c8d924fb1e17e676774e9b))
* **api:** port build talker payload to voice-chat session get ([#12470](https://github.com/vm0-ai/vm0/issues/12470)) ([ab189cc](https://github.com/vm0-ai/vm0/commit/ab189ccbc6bfb3de4398e99d00cb02173342dab9)), closes [#12463](https://github.com/vm0-ai/vm0/issues/12463)
* **api:** port chat-threads mark-read post to api backend ([#12511](https://github.com/vm0-ai/vm0/issues/12511)) ([e37f0e8](https://github.com/vm0-ai/vm0/commit/e37f0e8d774013073d6e0c11174c464b79e84f6f))
* **api:** port composes [id]/metadata PATCH to api backend (Wave 5) ([#12561](https://github.com/vm0-ai/vm0/issues/12561)) ([1fbaa00](https://github.com/vm0-ai/vm0/commit/1fbaa005166a28299f41f3eb9bf1381f4cebee2c))
* **api:** port custom-connectors create post to api backend ([#12524](https://github.com/vm0-ai/vm0/issues/12524)) ([b4421a8](https://github.com/vm0-ai/vm0/commit/b4421a8f8eebabd8c187879e79ffcb124bd729eb))
* **api:** port custom-connectors delete to api backend ([#12535](https://github.com/vm0-ai/vm0/issues/12535)) ([eee2bdc](https://github.com/vm0-ai/vm0/commit/eee2bdc7e626e934dfcd5c71f8354b13891f7b53))
* **api:** port integrations/telegram/message POST to api backend (Wave 5) ([#12580](https://github.com/vm0-ai/vm0/issues/12580)) ([98e3521](https://github.com/vm0-ai/vm0/commit/98e3521495a16569204289e06a66abd5554aba3a))
* **api:** port me/model-providers delete to api backend ([#12552](https://github.com/vm0-ai/vm0/issues/12552)) ([4fa5958](https://github.com/vm0-ai/vm0/commit/4fa59589f64793a28c9ae6dd850845efd9ecfafe))
* **api:** port member-cap evaluation for runs cancel credit reconciliation ([#12594](https://github.com/vm0-ai/vm0/issues/12594)) ([55870bd](https://github.com/vm0-ai/vm0/commit/55870bde9e060eb54c0d0b2103d31dbd19355005))
* **api:** port official telegram bot logic for parity with web ([#12378](https://github.com/vm0-ai/vm0/issues/12378)) ([a8ce3d7](https://github.com/vm0-ai/vm0/commit/a8ce3d74db51d11ffe43d7dc0a92bad524383046)), closes [#12290](https://github.com/vm0-ai/vm0/issues/12290) [#12370](https://github.com/vm0-ai/vm0/issues/12370)
* **api:** port secrets delete to api backend ([#12542](https://github.com/vm0-ai/vm0/issues/12542)) ([c2738af](https://github.com/vm0-ai/vm0/commit/c2738af9df9a12783a5143aaa12b976c09c3647b))
* **api:** port slack connect side effects ([#13117](https://github.com/vm0-ai/vm0/issues/13117)) ([bae9fc9](https://github.com/vm0-ai/vm0/commit/bae9fc913b5e5947553ca8437080e56795300bf2))
* **chat:** add append-only chat interrupt events ([#12404](https://github.com/vm0-ai/vm0/issues/12404)) ([947fb71](https://github.com/vm0-ai/vm0/commit/947fb714fa212a9d2dee6e8db6a50ea44800fad6))
* **chat:** add append-only queued message recall ([#12253](https://github.com/vm0-ai/vm0/issues/12253)) ([d094a8f](https://github.com/vm0-ai/vm0/commit/d094a8fb4103adc8e09b7e25bc796484d45b7281))
* switch zero model pickers to model-first ([#12286](https://github.com/vm0-ai/vm0/issues/12286)) ([4c0dafc](https://github.com/vm0-ai/vm0/commit/4c0dafcfef16f977d9dda8d4ed72c03aa8b310fb))


### Bug Fixes

* add missing id field and remove revoke filter from API thread messages ([#12339](https://github.com/vm0-ai/vm0/issues/12339)) ([26d28f2](https://github.com/vm0-ai/vm0/commit/26d28f224febb19de17741c3900176b37ba53ae1))
* align agent instructions route parity ([#12672](https://github.com/vm0-ai/vm0/issues/12672)) ([4d796b7](https://github.com/vm0-ai/vm0/commit/4d796b78025fb52132f0104fa295cb470e85c923))
* align v1 chat thread read route parity ([#12632](https://github.com/vm0-ai/vm0/issues/12632)) ([f0e9abd](https://github.com/vm0-ai/vm0/commit/f0e9abd379d9e8fc55bbd311e8a5cede3cf06330))
* align zero model provider route parity ([#12747](https://github.com/vm0-ai/vm0/issues/12747)) ([5864eca](https://github.com/vm0-ai/vm0/commit/5864ecab99087af29b1474036b750d8a46620080))
* align zero org read parity ([#12763](https://github.com/vm0-ai/vm0/issues/12763)) ([8ea3279](https://github.com/vm0-ai/vm0/commit/8ea32795aef6a69525f7759723b784a2703f0356))
* align zero skills route parity ([#12773](https://github.com/vm0-ai/vm0/issues/12773)) ([4cd4998](https://github.com/vm0-ai/vm0/commit/4cd4998d80b5dd04dd60faa20215939839015756))
* align zero usage insight route parity ([#12775](https://github.com/vm0-ai/vm0/issues/12775)) ([2580064](https://github.com/vm0-ai/vm0/commit/2580064aee8ba4b8a560073a7c28878abfae4efd))
* align zero web download parity ([#12780](https://github.com/vm0-ai/vm0/issues/12780)) ([8bea40a](https://github.com/vm0-ai/vm0/commit/8bea40a50b7b42876acf2250b196cb2ff78543c8))
* anchor cron schedule next run time ([#13138](https://github.com/vm0-ai/vm0/issues/13138)) ([b7c78e0](https://github.com/vm0-ai/vm0/commit/b7c78e0a9f423b055f69186741f4d841cd2aeef6))
* **api:** add modelProviderType/modelProviderCredentialScope to chat-thread detail ([#12252](https://github.com/vm0-ai/vm0/issues/12252)) ([a15af0e](https://github.com/vm0-ai/vm0/commit/a15af0e569dc16751eb431b675e4153156c9a409))
* **api:** add scopeMismatch/reinstallUrl to Slack shadow response ([#12277](https://github.com/vm0-ai/vm0/issues/12277)) ([61b03e5](https://github.com/vm0-ai/vm0/commit/61b03e5bb28d2bd6d359f76ce05bd4bc43617c14))
* **api:** align chat message env validation ([#13116](https://github.com/vm0-ai/vm0/issues/13116)) ([bcc1457](https://github.com/vm0-ai/vm0/commit/bcc145719f53cca232e0c496291e58cd49bebb56))
* **api:** align connector configured types ([#12306](https://github.com/vm0-ai/vm0/issues/12306)) ([771065b](https://github.com/vm0-ai/vm0/commit/771065bf8678c076e2632de83c0acb456d9d5684))
* **api:** drop visibility filter from zeroChatThreadMessagesPage ([#12498](https://github.com/vm0-ai/vm0/issues/12498)) ([26aca91](https://github.com/vm0-ai/vm0/commit/26aca9170d7e69418c3912065644f8aa104bf4da))
* **api:** exclude user-revoke ghost rows in visibleChatMessageCondition ([#12372](https://github.com/vm0-ai/vm0/issues/12372)) ([656e2ab](https://github.com/vm0-ai/vm0/commit/656e2ab8a5cacc14cb7c2c1c39d18faa4626b628))
* **api:** port axiom event watermark to mask indexing lag ([#12502](https://github.com/vm0-ai/vm0/issues/12502)) ([f79c79e](https://github.com/vm0-ai/vm0/commit/f79c79e353231372d78955bcf5a984adfcc1c187))
* **api:** port google drive artifact sync status to chat-threads artifacts get ([#12499](https://github.com/vm0-ai/vm0/issues/12499)) ([541165f](https://github.com/vm0-ai/vm0/commit/541165f97bacc3b3b93752e1655e7ccab9c67e3b)), closes [#12488](https://github.com/vm0-ai/vm0/issues/12488)
* **api:** preserve chat model provider selection ([#13156](https://github.com/vm0-ai/vm0/issues/13156)) ([241cfb8](https://github.com/vm0-ai/vm0/commit/241cfb8ce13d190b33abca4096ff829b5c8f62f0))
* **deps:** patch hono audit advisories ([#12257](https://github.com/vm0-ai/vm0/issues/12257)) ([8507e4a](https://github.com/vm0-ai/vm0/commit/8507e4a16a7f0c06e54a5c00c42384aeffde916a))
* pin model-first chat thread model ([#12740](https://github.com/vm0-ai/vm0/issues/12740)) ([de6006a](https://github.com/vm0-ai/vm0/commit/de6006ac76936e3f67257ac736e81a2c360b1c30))
* refresh connector auth state and catalog ([#12218](https://github.com/vm0-ai/vm0/issues/12218)) ([9cde9c6](https://github.com/vm0-ai/vm0/commit/9cde9c6dd39a3fe2bc266d681ae8c15227a15782))
* restore website docs and nav behavior ([#13123](https://github.com/vm0-ai/vm0/issues/13123)) ([6d2f45f](https://github.com/vm0-ai/vm0/commit/6d2f45f4870150fd9ac72773099721a68acbc1ac))
* route api axiom session queries to sessions token ([#12266](https://github.com/vm0-ai/vm0/issues/12266)) ([4de2fce](https://github.com/vm0-ai/vm0/commit/4de2fce52314c259978e1ddb2a8c81baae8d2abf))


### Refactoring

* **api:** migrate agent composes create route ([#13032](https://github.com/vm0-ai/vm0/issues/13032)) ([0fdd33b](https://github.com/vm0-ai/vm0/commit/0fdd33b6017440ea068c1125585f28866934e8d3))
* **api:** migrate agent instructions get ([#12409](https://github.com/vm0-ai/vm0/issues/12409)) ([c0a707b](https://github.com/vm0-ai/vm0/commit/c0a707b1cd2cadf6f08059a3bf8101c905fdf801))
* **api:** migrate agents by id get to api backend ([#12435](https://github.com/vm0-ai/vm0/issues/12435)) ([ccb5cac](https://github.com/vm0-ai/vm0/commit/ccb5cac48c0b8c25b901d1697f0b97cfd47a7bad))
* **api:** migrate agents custom-connectors put to api backend ([#12523](https://github.com/vm0-ai/vm0/issues/12523)) ([9d5c1b7](https://github.com/vm0-ai/vm0/commit/9d5c1b7d9bdcd8eb04b465cd60c6cfb0c21d2878))
* **api:** migrate agents list get ([#12431](https://github.com/vm0-ai/vm0/issues/12431)) ([e5acde9](https://github.com/vm0-ai/vm0/commit/e5acde91edb589968c450fd9adc46b18027f2b20))
* **api:** migrate agents user-connectors put to api backend ([#12581](https://github.com/vm0-ai/vm0/issues/12581)) ([0bc5a98](https://github.com/vm0-ai/vm0/commit/0bc5a98f1690426a44b06bff95da6f1cf7a87dc4))
* **api:** migrate api keys get to api backend ([#12357](https://github.com/vm0-ai/vm0/issues/12357)) ([d967a6c](https://github.com/vm0-ai/vm0/commit/d967a6cb1a9fbfc412deb897786b997e27187bc3)), closes [#12350](https://github.com/vm0-ai/vm0/issues/12350)
* **api:** migrate api-keys delete to api backend (wave 5) ([#12540](https://github.com/vm0-ai/vm0/issues/12540)) ([7c53ddf](https://github.com/vm0-ai/vm0/commit/7c53ddfa411183eb65f4ff86f44e60198a407a6b)), closes [#12538](https://github.com/vm0-ai/vm0/issues/12538)
* **api:** migrate billing auto-recharge get to api backend ([#12351](https://github.com/vm0-ai/vm0/issues/12351)) ([5686c5c](https://github.com/vm0-ai/vm0/commit/5686c5c2da47a4c71912c59073a8acb11c5effbf))
* **api:** migrate billing invoices get to api backend ([#12363](https://github.com/vm0-ai/vm0/issues/12363)) ([504c11a](https://github.com/vm0-ai/vm0/commit/504c11a585c681e2d5c15bc7504e87538c6f13c3))
* **api:** migrate billing status get to api backend ([#12353](https://github.com/vm0-ai/vm0/issues/12353)) ([351be15](https://github.com/vm0-ai/vm0/commit/351be15fdbb2a54e21c973e72d6b9ee4a59a8008)), closes [#12345](https://github.com/vm0-ai/vm0/issues/12345)
* **api:** migrate billing/portal post to api backend (wave 6 [#1](https://github.com/vm0-ai/vm0/issues/1)) ([#12670](https://github.com/vm0-ai/vm0/issues/12670)) ([7508575](https://github.com/vm0-ai/vm0/commit/750857546875646d151b0b7e0635440a0a34e1d8)), closes [#12595](https://github.com/vm0-ai/vm0/issues/12595)
* **api:** migrate chat callback ([#13111](https://github.com/vm0-ai/vm0/issues/13111)) ([4ff6f43](https://github.com/vm0-ai/vm0/commit/4ff6f4375712738a10f0495d26e7576ed660da29))
* **api:** migrate chat-threads artifacts sync to api backend (wave 5) ([#12563](https://github.com/vm0-ai/vm0/issues/12563)) ([d24b397](https://github.com/vm0-ai/vm0/commit/d24b3974f2f1bc30af83af27f390646ac3be4878)), closes [#12562](https://github.com/vm0-ai/vm0/issues/12562)
* **api:** migrate chat-threads delete [id] to api backend ([#12565](https://github.com/vm0-ai/vm0/issues/12565)) ([66ef7de](https://github.com/vm0-ai/vm0/commit/66ef7decc4b18a4c874ab6095cef8c004a2224af))
* **api:** migrate chat-threads post (create thread) to api backend ([#12553](https://github.com/vm0-ai/vm0/issues/12553)) ([0790f7d](https://github.com/vm0-ai/vm0/commit/0790f7d565440eac6da45fa37b99a2f74c712747))
* **api:** migrate chat-threads rename post to api backend ([#12516](https://github.com/vm0-ai/vm0/issues/12516)) ([96604b5](https://github.com/vm0-ai/vm0/commit/96604b58d91d1e30f94606239a202a7661239468))
* **api:** migrate chat-threads unpin post to api backend ([#12515](https://github.com/vm0-ai/vm0/issues/12515)) ([a9bcfba](https://github.com/vm0-ai/vm0/commit/a9bcfbad44cfb6d72a4177676776f4a1e6199060)), closes [#12514](https://github.com/vm0-ai/vm0/issues/12514)
* **api:** migrate cli auth routes ([#13033](https://github.com/vm0-ai/vm0/issues/13033)) ([a7c2a07](https://github.com/vm0-ai/vm0/commit/a7c2a07ef66882744298374231a64183c61923bc))
* **api:** migrate Codex OAuth model-provider routes ([#12956](https://github.com/vm0-ai/vm0/issues/12956)) ([721a18c](https://github.com/vm0-ai/vm0/commit/721a18c93b3994b0fc7d3ac0f0c8773386a5a69a))
* **api:** migrate composes by id get to api backend ([#12429](https://github.com/vm0-ai/vm0/issues/12429)) ([b061f46](https://github.com/vm0-ai/vm0/commit/b061f464e2d803cd90a19a8a91427a7a6f1933c0)), closes [#12428](https://github.com/vm0-ai/vm0/issues/12428)
* **api:** migrate composes by name get to api backend ([#12427](https://github.com/vm0-ai/vm0/issues/12427)) ([df66047](https://github.com/vm0-ai/vm0/commit/df66047b121c17400efbd57df59dcf39abb555fd))
* **api:** migrate composes delete to api backend (wave 5) ([#12548](https://github.com/vm0-ai/vm0/issues/12548)) ([f2e9359](https://github.com/vm0-ai/vm0/commit/f2e93593f8091c49cdc77271afac0d62ad7c7c93)), closes [#12544](https://github.com/vm0-ai/vm0/issues/12544)
* **api:** migrate composes list get to api backend ([#12415](https://github.com/vm0-ai/vm0/issues/12415)) ([ea06420](https://github.com/vm0-ai/vm0/commit/ea06420c7ce356d49c1f16fdf178caf64d869ac7))
* **api:** migrate computer use host get to api backend ([#12371](https://github.com/vm0-ai/vm0/issues/12371)) ([fe3a421](https://github.com/vm0-ai/vm0/commit/fe3a421e42e0515db80dd87ea09ff7173f81517a)), closes [#12367](https://github.com/vm0-ai/vm0/issues/12367)
* **api:** migrate connector oauth direct routes ([#12962](https://github.com/vm0-ai/vm0/issues/12962)) ([2293ee9](https://github.com/vm0-ai/vm0/commit/2293ee986e4e55f1004d6d58c8d5550c4938a203))
* **api:** migrate cron usage billing routes ([#13030](https://github.com/vm0-ai/vm0/issues/13030)) ([8bdee9c](https://github.com/vm0-ai/vm0/commit/8bdee9c022480628b42f809753963150ee4693c6))
* **api:** migrate custom-connectors delete secret to api backend ([#12532](https://github.com/vm0-ai/vm0/issues/12532)) ([2fc9e02](https://github.com/vm0-ai/vm0/commit/2fc9e02efb83579c63c1082d453e11890a7c6a75)), closes [#12531](https://github.com/vm0-ai/vm0/issues/12531)
* **api:** migrate custom-connectors list get to api backend ([#12392](https://github.com/vm0-ai/vm0/issues/12392)) ([076d707](https://github.com/vm0-ai/vm0/commit/076d70721621415ab2bbb8556fc4d6a9f97efe93))
* **api:** migrate custom-connectors patch [id] to api backend ([#12533](https://github.com/vm0-ai/vm0/issues/12533)) ([374097d](https://github.com/vm0-ai/vm0/commit/374097d077c280096a3850d2cceef10f6d4930ba))
* **api:** migrate default-agent put to api backend ([#12604](https://github.com/vm0-ai/vm0/issues/12604)) ([d51726c](https://github.com/vm0-ai/vm0/commit/d51726ca7a4fa6034e61022fd8197c4c70dd2694)), closes [#12290](https://github.com/vm0-ai/vm0/issues/12290) [#12598](https://github.com/vm0-ai/vm0/issues/12598)
* **api:** migrate email unsubscribe get route ([#13005](https://github.com/vm0-ai/vm0/issues/13005)) ([5fef14a](https://github.com/vm0-ai/vm0/commit/5fef14ae4d87fa7894436d83de6a073acbb0c6d2))
* **api:** migrate email unsubscribe route ([#13010](https://github.com/vm0-ai/vm0/issues/13010)) ([6b6ef71](https://github.com/vm0-ai/vm0/commit/6b6ef71b5e34070925c36b9dbd6bcf90d073ef77))
* **api:** migrate feature switches get ([#12335](https://github.com/vm0-ai/vm0/issues/12335)) ([87c69cc](https://github.com/vm0-ai/vm0/commit/87c69cce5490d7a7511359af5642f1d77763da90))
* **api:** migrate feature-switches post + delete to api backend ([#12546](https://github.com/vm0-ai/vm0/issues/12546)) ([8107427](https://github.com/vm0-ai/vm0/commit/810742718741213be6b0bd99906796771762d446))
* **api:** migrate github integration delete route ([#12954](https://github.com/vm0-ai/vm0/issues/12954)) ([399dfe5](https://github.com/vm0-ai/vm0/commit/399dfe5f57514e3e7cad840f297643b4d5adceed))
* **api:** migrate github issues callback ([#13085](https://github.com/vm0-ai/vm0/issues/13085)) ([5d627c1](https://github.com/vm0-ai/vm0/commit/5d627c1ef7bf243003e5192f9adeaf3447699a34))
* **api:** migrate github oauth get routes ([#12986](https://github.com/vm0-ai/vm0/issues/12986)) ([ca4b7f1](https://github.com/vm0-ai/vm0/commit/ca4b7f1964f4762044a612ee867868166940fecf))
* **api:** migrate insights get ([#12369](https://github.com/vm0-ai/vm0/issues/12369)) ([1ed312e](https://github.com/vm0-ai/vm0/commit/1ed312ebda451ebf8528bdc0bf3e17889364fff8))
* **api:** migrate insights range get ([#12376](https://github.com/vm0-ai/vm0/issues/12376)) ([65d16b2](https://github.com/vm0-ai/vm0/commit/65d16b2fbfe230bb85e6e9c73690c8d6a97fe15d))
* **api:** migrate internal agent callback ([#13077](https://github.com/vm0-ai/vm0/issues/13077)) ([b40a430](https://github.com/vm0-ai/vm0/commit/b40a4301b30c5abee3d544fa282bad636b21c975))
* **api:** migrate internal event consumers ([#13006](https://github.com/vm0-ai/vm0/issues/13006)) ([90a0043](https://github.com/vm0-ai/vm0/commit/90a0043d4ddccfd9599c4d16f305742abe6092fe))
* **api:** migrate internal schedule callbacks ([#13084](https://github.com/vm0-ai/vm0/issues/13084)) ([f11641a](https://github.com/vm0-ai/vm0/commit/f11641a748d784f518d19043b32893bfa40b61b5))
* **api:** migrate me/model-providers patch model to api backend (wave 5) ([#12559](https://github.com/vm0-ai/vm0/issues/12559)) ([097f4a4](https://github.com/vm0-ai/vm0/commit/097f4a449d1537ff308c51976f26a5899301537e)), closes [#12556](https://github.com/vm0-ai/vm0/issues/12556)
* **api:** migrate member credit cap get ([#12383](https://github.com/vm0-ai/vm0/issues/12383)) ([9c6c779](https://github.com/vm0-ai/vm0/commit/9c6c7794ae8e86be1a3f46fe40d970be6b936b7b))
* **api:** migrate model provider model update route ([#13016](https://github.com/vm0-ai/vm0/issues/13016)) ([bbc8684](https://github.com/vm0-ai/vm0/commit/bbc8684df65753a527285e9151befdbb3997ff1f))
* **api:** migrate model providers list get to api backend ([#12391](https://github.com/vm0-ai/vm0/issues/12391)) ([2bc1348](https://github.com/vm0-ai/vm0/commit/2bc1348546796fda261826db060aadc6a988a294)), closes [#12387](https://github.com/vm0-ai/vm0/issues/12387)
* **api:** migrate onboarding status get to api backend ([#12338](https://github.com/vm0-ai/vm0/issues/12338)) ([61e11e8](https://github.com/vm0-ai/vm0/commit/61e11e8ca7f8de10543eb3b9254b1e3f85fb2c5a)), closes [#12333](https://github.com/vm0-ai/vm0/issues/12333)
* **api:** migrate org domains list get to api backend ([#12440](https://github.com/vm0-ai/vm0/issues/12440)) ([2c15a05](https://github.com/vm0-ai/vm0/commit/2c15a05dff7013d186cb774aad93942abc4f73c9)), closes [#12437](https://github.com/vm0-ai/vm0/issues/12437)
* **api:** migrate org get to api backend ([#12449](https://github.com/vm0-ai/vm0/issues/12449)) ([325fe7a](https://github.com/vm0-ai/vm0/commit/325fe7a78cac71e1e4b9d7d7c459659b51ed05c9))
* **api:** migrate org list get to api backend ([#12433](https://github.com/vm0-ai/vm0/issues/12433)) ([9b6d0b0](https://github.com/vm0-ai/vm0/commit/9b6d0b03d334acf78e4654f703b39f290ff13b0a)), closes [#12432](https://github.com/vm0-ai/vm0/issues/12432)
* **api:** migrate org members get to api backend ([#12450](https://github.com/vm0-ai/vm0/issues/12450)) ([724045d](https://github.com/vm0-ai/vm0/commit/724045dc878e6ea647408bc4cdac417f03d19a2d)), closes [#12443](https://github.com/vm0-ai/vm0/issues/12443)
* **api:** migrate org/invite post to api backend ([#12607](https://github.com/vm0-ai/vm0/issues/12607)) ([2218e92](https://github.com/vm0-ai/vm0/commit/2218e92a10afada7f8b63a7c822b93ff8d2a3956))
* **api:** migrate permission access create route ([#12959](https://github.com/vm0-ai/vm0/issues/12959)) ([ed4df55](https://github.com/vm0-ai/vm0/commit/ed4df55ca31c697f2c67a4758a7b7bde565eaf56)), closes [#12883](https://github.com/vm0-ai/vm0/issues/12883)
* **api:** migrate permission access resolve route ([#12938](https://github.com/vm0-ai/vm0/issues/12938)) ([4f999a5](https://github.com/vm0-ai/vm0/commit/4f999a53da9a0d89ddb22d4da81b4294dd522168))
* **api:** migrate run agent events get to api backend ([#12422](https://github.com/vm0-ai/vm0/issues/12422)) ([75f4efa](https://github.com/vm0-ai/vm0/commit/75f4efaca4354a0c57f64e69d47a1b72cee974a2))
* **api:** migrate run context get ([#12420](https://github.com/vm0-ai/vm0/issues/12420)) ([fc9cc36](https://github.com/vm0-ai/vm0/commit/fc9cc367b9fbe67fa17b670353e86c36a267b985))
* **api:** migrate run network logs get to api backend ([#12421](https://github.com/vm0-ai/vm0/issues/12421)) ([f2bd43b](https://github.com/vm0-ai/vm0/commit/f2bd43b86783e625f06b489ac6deb86802b3ed89)), closes [#12417](https://github.com/vm0-ai/vm0/issues/12417)
* **api:** migrate runner post routes ([#13001](https://github.com/vm0-ai/vm0/issues/13001)) ([d352abb](https://github.com/vm0-ai/vm0/commit/d352abb0dae68703da190d98c82dc67653b7a15c))
* **api:** migrate runs cancel to api backend (wave 5) ([#12577](https://github.com/vm0-ai/vm0/issues/12577)) ([bc6f2e7](https://github.com/vm0-ai/vm0/commit/bc6f2e7b865804c5673ea0f1a0cdc9a390a15c58)), closes [#12570](https://github.com/vm0-ai/vm0/issues/12570)
* **api:** migrate runs get-by-id ([#12414](https://github.com/vm0-ai/vm0/issues/12414)) ([472839e](https://github.com/vm0-ai/vm0/commit/472839e416d1d879eb4d83ffddb691dbb9934b90))
* **api:** migrate runs queue get to api backend ([#12402](https://github.com/vm0-ai/vm0/issues/12402)) ([60df3d2](https://github.com/vm0-ai/vm0/commit/60df3d24a092e9570f5de615cba621a53579b207))
* **api:** migrate runs runner get to api backend ([#12408](https://github.com/vm0-ai/vm0/issues/12408)) ([73e76c8](https://github.com/vm0-ai/vm0/commit/73e76c897412e5724568913abffa724c851d7624))
* **api:** migrate schedules list get to api backend ([#12393](https://github.com/vm0-ai/vm0/issues/12393)) ([f9da2eb](https://github.com/vm0-ai/vm0/commit/f9da2eb63fc3b3860396d75c23d38ef740c5bc18)), closes [#12389](https://github.com/vm0-ai/vm0/issues/12389)
* **api:** migrate secrets get to api backend ([#12377](https://github.com/vm0-ai/vm0/issues/12377)) ([ce5bf36](https://github.com/vm0-ai/vm0/commit/ce5bf363e103188c3fa5e76935f4e92e89cdbe8f))
* **api:** migrate skill detail get to api backend ([#12401](https://github.com/vm0-ai/vm0/issues/12401)) ([95a2893](https://github.com/vm0-ai/vm0/commit/95a289332ed91629c5f9b8c9a8b9a3b4564d06f7)), closes [#12398](https://github.com/vm0-ai/vm0/issues/12398)
* **api:** migrate skills list get ([#12388](https://github.com/vm0-ai/vm0/issues/12388)) ([f171574](https://github.com/vm0-ai/vm0/commit/f171574f50649eb989c71577f8537573cbd41a55))
* **api:** migrate slack channels get to api backend ([#12385](https://github.com/vm0-ai/vm0/issues/12385)) ([f0f2bba](https://github.com/vm0-ai/vm0/commit/f0f2bbac33aa5e0e6076a481a356268164631fd7)), closes [#12380](https://github.com/vm0-ai/vm0/issues/12380)
* **api:** migrate slack connect status get to api backend ([#12384](https://github.com/vm0-ai/vm0/issues/12384)) ([27d8bb8](https://github.com/vm0-ai/vm0/commit/27d8bb89a990324ec8e198e75cdec378b0fdac74))
* **api:** migrate slack integration delete route ([#12991](https://github.com/vm0-ai/vm0/issues/12991)) ([ffa5290](https://github.com/vm0-ai/vm0/commit/ffa5290b227dc8a162af3a06aa13b2e0a23ec9e2))
* **api:** migrate slack integration status get to api backend ([#12399](https://github.com/vm0-ai/vm0/issues/12399)) ([db594c0](https://github.com/vm0-ai/vm0/commit/db594c0488c1a1c7c509566dd2afdc29699463f5)), closes [#12396](https://github.com/vm0-ai/vm0/issues/12396)
* **api:** migrate slack org callback ([#13099](https://github.com/vm0-ai/vm0/issues/13099)) ([cd9abe1](https://github.com/vm0-ai/vm0/commit/cd9abe1a7c7b27b561cecd0f845a4ca213a16b41))
* **api:** migrate slack state delete route ([#12968](https://github.com/vm0-ai/vm0/issues/12968)) ([4f84a71](https://github.com/vm0-ai/vm0/commit/4f84a7178a54373dffcfb0d7e5c0f004dadfdfe4))
* **api:** migrate slack webhooks ([#13145](https://github.com/vm0-ai/vm0/issues/13145)) ([280d359](https://github.com/vm0-ai/vm0/commit/280d359fc085cbd309ee80788296ad61d2d60ee9))
* **api:** migrate storage write routes ([#13002](https://github.com/vm0-ai/vm0/issues/13002)) ([8e6e5db](https://github.com/vm0-ai/vm0/commit/8e6e5dbe47ef05054d443d54c16f61b601890306))
* **api:** migrate team get to api backend ([#12337](https://github.com/vm0-ai/vm0/issues/12337)) ([c065931](https://github.com/vm0-ai/vm0/commit/c065931b5e5cd9cafd7db7ccfa2f5a77ae95ca98))
* **api:** migrate telegram bots list get to api backend ([#12405](https://github.com/vm0-ai/vm0/issues/12405)) ([722f9f7](https://github.com/vm0-ai/vm0/commit/722f9f7e3e3b48784d44e01416ae0cb173622aa2)), closes [#12366](https://github.com/vm0-ai/vm0/issues/12366)
* **api:** migrate telegram callback ([#13093](https://github.com/vm0-ai/vm0/issues/13093)) ([755e1bb](https://github.com/vm0-ai/vm0/commit/755e1bbad99763927c8233923c7d1ed040fb80e2))
* **api:** migrate telegram integration get routes ([#12969](https://github.com/vm0-ai/vm0/issues/12969)) ([4e62786](https://github.com/vm0-ai/vm0/commit/4e62786c07b510166073c740552b4b7fec5b90e6))
* **api:** migrate telegram integration patch route ([#13013](https://github.com/vm0-ai/vm0/issues/13013)) ([6b8f1e9](https://github.com/vm0-ai/vm0/commit/6b8f1e9c69d40a7410ac30ac2866c5293668f733))
* **api:** migrate telegram mock route ([#12995](https://github.com/vm0-ai/vm0/issues/12995)) ([7c7d409](https://github.com/vm0-ai/vm0/commit/7c7d4095ef24e9dc2343b83853da58e32081156f))
* **api:** migrate telegram test state seeding ([#12985](https://github.com/vm0-ai/vm0/issues/12985)) ([96b8fbb](https://github.com/vm0-ai/vm0/commit/96b8fbb62b7f6b3d55a322a8bbcd3a77df8cdb69))
* **api:** migrate test slack state post route ([#12988](https://github.com/vm0-ai/vm0/issues/12988)) ([1a77b71](https://github.com/vm0-ai/vm0/commit/1a77b71818739e448f2bfa9529656c48421fdf36))
* **api:** migrate test telegram state delete route ([#12977](https://github.com/vm0-ai/vm0/issues/12977)) ([5ade3b3](https://github.com/vm0-ai/vm0/commit/5ade3b3dcaebeb32e6fa7d15c9975c306a334601))
* **api:** migrate uploads complete post to api backend ([#12592](https://github.com/vm0-ai/vm0/issues/12592)) ([4b1f30f](https://github.com/vm0-ai/vm0/commit/4b1f30f890e7c62bf68b335081e7a1b5c9d5b5cb))
* **api:** migrate uploads/prepare post to api backend (Wave 5) ([#12590](https://github.com/vm0-ai/vm0/issues/12590)) ([37bc690](https://github.com/vm0-ai/vm0/commit/37bc690f6744a96b48412b6a172e91e7e79fa3ec))
* **api:** migrate usage insight get ([#12356](https://github.com/vm0-ai/vm0/issues/12356)) ([3f31844](https://github.com/vm0-ai/vm0/commit/3f31844fdd3e485b813da1f8a52123451eed5047))
* **api:** migrate usage route to api backend ([#12906](https://github.com/vm0-ai/vm0/issues/12906)) ([df42008](https://github.com/vm0-ai/vm0/commit/df42008a4dd9fece0a021e35c957ff343f713285))
* **api:** migrate user connectors get ([#12439](https://github.com/vm0-ai/vm0/issues/12439)) ([de02718](https://github.com/vm0-ai/vm0/commit/de027181f14feb883b5eefcc07e7fd2e0c126375))
* **api:** migrate user export POST ([#13034](https://github.com/vm0-ai/vm0/issues/13034)) ([193fed0](https://github.com/vm0-ai/vm0/commit/193fed08017d9767be51c73ae5d083e761917447))
* **api:** migrate user preferences get ([#12312](https://github.com/vm0-ai/vm0/issues/12312)) ([baf0445](https://github.com/vm0-ai/vm0/commit/baf0445c9d4305fb696f71564bc647ee96bdf0ff))
* **api:** migrate user preferences post ([#12315](https://github.com/vm0-ai/vm0/issues/12315)) ([c0788c4](https://github.com/vm0-ai/vm0/commit/c0788c45d478503c94adc9c332d8f6dd94f9fdf4))
* **api:** migrate variables list get ([#12397](https://github.com/vm0-ai/vm0/issues/12397)) ([3953c2f](https://github.com/vm0-ai/vm0/commit/3953c2f154c140db62b50f0e06a1659825e039d4))
* **api:** migrate voice chat list tasks get to api backend ([#12464](https://github.com/vm0-ai/vm0/issues/12464)) ([2c8bf7e](https://github.com/vm0-ai/vm0/commit/2c8bf7e020083701d4be11577944f5f489dcac8c)), closes [#12458](https://github.com/vm0-ai/vm0/issues/12458)
* **api:** migrate voice chat post routes ([#13039](https://github.com/vm0-ai/vm0/issues/13039)) ([417be66](https://github.com/vm0-ai/vm0/commit/417be6633818d5a80796e277c6d4eacab335343f))
* **api:** migrate voice-chat callback ([#13105](https://github.com/vm0-ai/vm0/issues/13105)) ([bdc1367](https://github.com/vm0-ai/vm0/commit/bdc1367cf833a912f4e320c21c05af2a5893c71a))
* **api:** migrate voice-chat get session get to api backend ([#12460](https://github.com/vm0-ai/vm0/issues/12460)) ([9c9f0d8](https://github.com/vm0-ai/vm0/commit/9c9f0d8b7e34bec3267c327560b52a2b60cae278))
* **api:** migrate voice-chat list-sessions get to api backend ([#12448](https://github.com/vm0-ai/vm0/issues/12448)) ([8be77ab](https://github.com/vm0-ai/vm0/commit/8be77ab96c1712c4babf219e3a33a2cd51104d25))
* **api:** migrate zero agent update routes to api backend ([#12940](https://github.com/vm0-ai/vm0/issues/12940)) ([83758da](https://github.com/vm0-ai/vm0/commit/83758dadb4386cb00efb337bd9066b0f9083158c))
* **api:** migrate zero agents delete route ([#12983](https://github.com/vm0-ai/vm0/issues/12983)) ([1a7b5af](https://github.com/vm0-ai/vm0/commit/1a7b5af6c0bf2e59909c6787b8cb54795354626c))
* **api:** migrate zero agents patch route ([#13020](https://github.com/vm0-ai/vm0/issues/13020)) ([45663c9](https://github.com/vm0-ai/vm0/commit/45663c9ec30e3a1b493326a81e568583d933ef75))
* **api:** migrate zero api key creation ([#12993](https://github.com/vm0-ai/vm0/issues/12993)) ([34a915d](https://github.com/vm0-ai/vm0/commit/34a915d77fcd5b1a2158c0253e2db32e862fced8))
* **api:** migrate zero chat search get to api backend ([#12494](https://github.com/vm0-ai/vm0/issues/12494)) ([a21a72a](https://github.com/vm0-ai/vm0/commit/a21a72a6c86d74c43653c435532b074661e376c6)), closes [#12491](https://github.com/vm0-ai/vm0/issues/12491)
* **api:** migrate zero chat thread messages get to api backend ([#12492](https://github.com/vm0-ai/vm0/issues/12492)) ([7c3b418](https://github.com/vm0-ai/vm0/commit/7c3b41839c2feb30a2dcaf6149445f806e8454dd))
* **api:** migrate zero chat threads artifacts list get to api backend ([#12489](https://github.com/vm0-ai/vm0/issues/12489)) ([bf4d50b](https://github.com/vm0-ai/vm0/commit/bf4d50bb44bf29cc8a8f720a9c5e6b4d62c2af95)), closes [#12486](https://github.com/vm0-ai/vm0/issues/12486) [#12488](https://github.com/vm0-ai/vm0/issues/12488)
* **api:** migrate zero chat threads get by id to api backend ([#12487](https://github.com/vm0-ai/vm0/issues/12487)) ([549b84b](https://github.com/vm0-ai/vm0/commit/549b84b92d800475f85524668fe4817c70dded6b)), closes [#12484](https://github.com/vm0-ai/vm0/issues/12484)
* **api:** migrate zero chat threads list get to api backend ([#12485](https://github.com/vm0-ai/vm0/issues/12485)) ([64858fa](https://github.com/vm0-ai/vm0/commit/64858fadaaca5780c50fcd3e0e5219e9ebe07b59)), closes [#12482](https://github.com/vm0-ai/vm0/issues/12482)
* **api:** migrate zero connector authorize routes ([#12910](https://github.com/vm0-ai/vm0/issues/12910)) ([f122f40](https://github.com/vm0-ai/vm0/commit/f122f40dc126240b232902e37829271b1e1c11ff))
* **api:** migrate zero connector deletes ([#12989](https://github.com/vm0-ai/vm0/issues/12989)) ([2a2706e](https://github.com/vm0-ai/vm0/commit/2a2706e8d61272ad7697f7ecb2aab737473cbbf9))
* **api:** migrate zero connectors by type get to api backend ([#12479](https://github.com/vm0-ai/vm0/issues/12479)) ([f071e6b](https://github.com/vm0-ai/vm0/commit/f071e6b636c248e6fdd7c939db8ef27a24a9463d)), closes [#12476](https://github.com/vm0-ai/vm0/issues/12476)
* **api:** migrate zero connectors computer get to api backend ([#12473](https://github.com/vm0-ai/vm0/issues/12473)) ([442a1a7](https://github.com/vm0-ai/vm0/commit/442a1a768b1f115765fc4bf7d08a3128e534ca3c)), closes [#12471](https://github.com/vm0-ai/vm0/issues/12471)
* **api:** migrate zero connectors list get to api backend ([#12467](https://github.com/vm0-ai/vm0/issues/12467)) ([535e9a7](https://github.com/vm0-ai/vm0/commit/535e9a7baba6a3d93f50f8779a62ce3a7d94ffd5))
* **api:** migrate zero connectors scope diff get to api backend ([#12480](https://github.com/vm0-ai/vm0/issues/12480)) ([52431bb](https://github.com/vm0-ai/vm0/commit/52431bbf9a7391a0cc29f8943137855dee2c6df4))
* **api:** migrate zero connectors search get to api backend ([#12474](https://github.com/vm0-ai/vm0/issues/12474)) ([3ca8039](https://github.com/vm0-ai/vm0/commit/3ca80390be85d1ca0f622d46c931e7f5c9c6b41c))
* **api:** migrate zero developer support route ([#12984](https://github.com/vm0-ai/vm0/issues/12984)) ([2c23fcf](https://github.com/vm0-ai/vm0/commit/2c23fcf0b842b08ffc6e0c8ff781263cd84ed555))
* **api:** migrate zero image io generate route ([#13061](https://github.com/vm0-ai/vm0/issues/13061)) ([8976c68](https://github.com/vm0-ai/vm0/commit/8976c68a6a2a277cc75982810b2a9331e5a1d77f))
* **api:** migrate zero logs get by id to api backend ([#12478](https://github.com/vm0-ai/vm0/issues/12478)) ([2328045](https://github.com/vm0-ai/vm0/commit/23280452e5b7f3dc7e264a888d54215bbc51e883)), closes [#12475](https://github.com/vm0-ai/vm0/issues/12475)
* **api:** migrate zero logs list get to api backend ([#12469](https://github.com/vm0-ai/vm0/issues/12469)) ([4f0a3c3](https://github.com/vm0-ai/vm0/commit/4f0a3c36b3a9c64eeb138498289603d587a9714d)), closes [#12465](https://github.com/vm0-ai/vm0/issues/12465)
* **api:** migrate zero logs search get to api backend ([#12483](https://github.com/vm0-ai/vm0/issues/12483)) ([8e21a71](https://github.com/vm0-ai/vm0/commit/8e21a71653e2031050640ca52f1523ef1e368780))
* **api:** migrate zero model providers delete route ([#12990](https://github.com/vm0-ai/vm0/issues/12990)) ([9cd2a73](https://github.com/vm0-ai/vm0/commit/9cd2a73ca2a477ee0cb49a0146cda591e6610507))
* **api:** migrate zero onboarding setup route ([#12975](https://github.com/vm0-ai/vm0/issues/12975)) ([a99038b](https://github.com/vm0-ai/vm0/commit/a99038ba5394dccfeeb2428171eaa9ff4ed20301))
* **api:** migrate zero org delete route ([#12973](https://github.com/vm0-ai/vm0/issues/12973)) ([7e4033e](https://github.com/vm0-ai/vm0/commit/7e4033e48ccbfbc87db90a46774887aa29da2c13))
* **api:** migrate zero org domain verification ([#13009](https://github.com/vm0-ai/vm0/issues/13009)) ([42174f2](https://github.com/vm0-ai/vm0/commit/42174f23f3729410f6f831eb779da71d7f6cd5ba))
* **api:** migrate zero org domains add route ([#12966](https://github.com/vm0-ai/vm0/issues/12966)) ([20677d6](https://github.com/vm0-ai/vm0/commit/20677d68d455a18f778566efe9f904bc5b4cb16a))
* **api:** migrate zero org domains delete route ([#12992](https://github.com/vm0-ai/vm0/issues/12992)) ([4a1f844](https://github.com/vm0-ai/vm0/commit/4a1f84484a0af16f8c39ff87560a5f7c926e9d05))
* **api:** migrate zero org leave route ([#12963](https://github.com/vm0-ai/vm0/issues/12963)) ([e6271ef](https://github.com/vm0-ai/vm0/commit/e6271efe807772850185e808ef7446e549fb79f2))
* **api:** migrate zero org logo upload route ([#12953](https://github.com/vm0-ai/vm0/issues/12953)) ([dee447f](https://github.com/vm0-ai/vm0/commit/dee447f07b6423fa426e41a3bef885f2d0d0f633))
* **api:** migrate zero org members delete route ([#13003](https://github.com/vm0-ai/vm0/issues/13003)) ([6a1dcb2](https://github.com/vm0-ai/vm0/commit/6a1dcb2fed5869df5983c68e0999bc2d588acfb5))
* **api:** migrate zero org members patch ([#13029](https://github.com/vm0-ai/vm0/issues/13029)) ([659cff6](https://github.com/vm0-ai/vm0/commit/659cff699968e2e2d26ba6f4f865170c98c01302))
* **api:** migrate zero org update route ([#12942](https://github.com/vm0-ai/vm0/issues/12942)) ([2993177](https://github.com/vm0-ai/vm0/commit/2993177a164a592a4782aea1e9ef92ea6a4f496e))
* **api:** migrate zero queue-position get to api backend ([#12336](https://github.com/vm0-ai/vm0/issues/12336)) ([5e4eee2](https://github.com/vm0-ai/vm0/commit/5e4eee257ea1ce6543379e1d220826cdf99ba4f3)), closes [#12332](https://github.com/vm0-ai/vm0/issues/12332)
* **api:** migrate zero realtime token route ([#12955](https://github.com/vm0-ai/vm0/issues/12955)) ([d5d74f0](https://github.com/vm0-ai/vm0/commit/d5d74f0ea9b1709f6663471e98e7084d084fb3bb))
* **api:** migrate zero report-error route ([#12961](https://github.com/vm0-ai/vm0/issues/12961)) ([f6a0127](https://github.com/vm0-ai/vm0/commit/f6a012768ed0939c2cabce390a0d7f0941e9188a))
* **api:** migrate zero runs create route ([#13076](https://github.com/vm0-ai/vm0/issues/13076)) ([2b64ac7](https://github.com/vm0-ai/vm0/commit/2b64ac71d8ac51509b1953d40fe140b707a2d444))
* **api:** migrate zero schedules delete route ([#12999](https://github.com/vm0-ai/vm0/issues/12999)) ([74c2817](https://github.com/vm0-ai/vm0/commit/74c28173061133bbfaabe6e10e5734b83eba95c2))
* **api:** migrate zero secrets post route ([#12946](https://github.com/vm0-ai/vm0/issues/12946)) ([bf2e7bf](https://github.com/vm0-ai/vm0/commit/bf2e7bffc08c3bc83be8dc5e04388955b5b9c1e4))
* **api:** migrate zero skill deletion ([#13004](https://github.com/vm0-ai/vm0/issues/13004)) ([1e962d2](https://github.com/vm0-ai/vm0/commit/1e962d2d80acb6b6e5d2d039a83358c19ca69183))
* **api:** migrate zero skills create route ([#12952](https://github.com/vm0-ai/vm0/issues/12952)) ([a9f063c](https://github.com/vm0-ai/vm0/commit/a9f063c85e9c217f5ee89b7ad46ad46efca5ac28))
* **api:** migrate zero skills update route ([#12913](https://github.com/vm0-ai/vm0/issues/12913)) ([fe3000e](https://github.com/vm0-ai/vm0/commit/fe3000effede31da8b96643cf0d2491b6a11aaa2))
* **api:** migrate zero slack oauth routes ([#12958](https://github.com/vm0-ai/vm0/issues/12958)) ([7e76cde](https://github.com/vm0-ai/vm0/commit/7e76cde7a3ee7ee8358b7cdd5b060d265f41f9fc))
* **api:** migrate zero variables post route ([#12945](https://github.com/vm0-ai/vm0/issues/12945)) ([8d4607d](https://github.com/vm0-ai/vm0/commit/8d4607d2d11e737d8d9d0e4343bdee2bf905aa1d))
* **api:** port runs cancel credit reconciliation atomic core (wave 5 follow-up) ([#12585](https://github.com/vm0-ai/vm0/issues/12585)) ([beee285](https://github.com/vm0-ai/vm0/commit/beee28545c51bf9098569c6b9145ec96cac97b8d))
* **api:** port runs cancel queue-drain (wave 5 follow-up) ([#12582](https://github.com/vm0-ai/vm0/issues/12582)) ([46ce11e](https://github.com/vm0-ai/vm0/commit/46ce11eb79bae216df1f1ec899b63e52bd1c1c4a))
* **api:** port stripe auto-recharge for runs cancel (wave 5 cascade) ([#12593](https://github.com/vm0-ai/vm0/issues/12593)) ([b6b5d8b](https://github.com/vm0-ai/vm0/commit/b6b5d8b37c7f78e7e99f2e670fe8cb794045b436)), closes [#12587](https://github.com/vm0-ai/vm0/issues/12587)
* make codex providers feature-switch free ([#13126](https://github.com/vm0-ai/vm0/issues/13126)) ([6a3e7b3](https://github.com/vm0-ai/vm0/commit/6a3e7b37ff6fb0cd473bd72f61ff80e6ca74195f))
* make zero model-first only ([#13017](https://github.com/vm0-ai/vm0/issues/13017)) ([9bcb323](https://github.com/vm0-ai/vm0/commit/9bcb323d6e2c32dfdd2d1bf9fa63d0d2bf9e1ef1))
* migrate agent checkpoints route to api ([#12914](https://github.com/vm0-ai/vm0/issues/12914)) ([004e3c6](https://github.com/vm0-ai/vm0/commit/004e3c6ff61164a62f926adddcbcd094b1093941))
* migrate agent compose delete route ([#12915](https://github.com/vm0-ai/vm0/issues/12915)) ([08408d6](https://github.com/vm0-ai/vm0/commit/08408d6756e737fb9c922757bd8b1be6012f635a))
* migrate agent composes read routes to api ([#12950](https://github.com/vm0-ai/vm0/issues/12950)) ([bc0a2fb](https://github.com/vm0-ai/vm0/commit/bc0a2fb55b133e044c0dc991cfc50d5c95dc9d42))
* migrate agent run telemetry to api ([#12981](https://github.com/vm0-ai/vm0/issues/12981)) ([451d2b5](https://github.com/vm0-ai/vm0/commit/451d2b5a44a878f0f4ce048424790ef2f1f90cb5))
* migrate agent runs read routes to api ([#12974](https://github.com/vm0-ai/vm0/issues/12974)) ([edcb5a4](https://github.com/vm0-ai/vm0/commit/edcb5a41dec38adfce88a822812b14cf15182c18))
* migrate agent sessions route to api ([#12939](https://github.com/vm0-ai/vm0/issues/12939)) ([f11ea4c](https://github.com/vm0-ai/vm0/commit/f11ea4c3c8916e942706b719d42fb2522b1fe5f4))
* migrate auth me GET to api backend ([#12911](https://github.com/vm0-ai/vm0/issues/12911)) ([9140e92](https://github.com/vm0-ai/vm0/commit/9140e92ee8be732e8e0a3421b516169cf0910181))
* migrate generate image route to api ([#13012](https://github.com/vm0-ai/vm0/issues/13012)) ([1718609](https://github.com/vm0-ai/vm0/commit/171860936b1f0f585209db68ad302d1dc9b320f4))
* migrate github integration status to api ([#12976](https://github.com/vm0-ai/vm0/issues/12976)) ([bdf0270](https://github.com/vm0-ai/vm0/commit/bdf0270487661b5d8f44aac480e75ddcd651682b))
* migrate integrations chat message route to api ([#12978](https://github.com/vm0-ai/vm0/issues/12978)) ([12a4171](https://github.com/vm0-ai/vm0/commit/12a41718f155c7e9c19a6c4b58898c656ee1fb7e))
* migrate logs search to api ([#12960](https://github.com/vm0-ai/vm0/issues/12960)) ([fc42cf7](https://github.com/vm0-ai/vm0/commit/fc42cf7e4c7a78fe9d3eaf3c1c40acb28a52c20a))
* migrate permission access request list route ([#12904](https://github.com/vm0-ai/vm0/issues/12904)) ([44e5f1e](https://github.com/vm0-ai/vm0/commit/44e5f1eccdbcaa7bfdbc88cf31f2e64adbc6ac28))
* migrate slack mock test routes to api ([#12996](https://github.com/vm0-ai/vm0/issues/12996)) ([453e60f](https://github.com/vm0-ai/vm0/commit/453e60f4e70305fc86896e539430030bc861e073))
* migrate storage GET routes to api backend ([#12957](https://github.com/vm0-ai/vm0/issues/12957)) ([1fe70fb](https://github.com/vm0-ai/vm0/commit/1fe70fb9ff07ceaf9f986816f8879d1f7a86e034))
* migrate telegram delete routes to api ([#12965](https://github.com/vm0-ai/vm0/issues/12965)) ([77881e0](https://github.com/vm0-ai/vm0/commit/77881e0342dd7489b5866e8c9c4d263efb137743))
* migrate test oauth provider get routes to api ([#12916](https://github.com/vm0-ai/vm0/issues/12916)) ([37019ca](https://github.com/vm0-ai/vm0/commit/37019ca6abb6bb29a0d391976e6377bc2e2dd83c))
* migrate test slack state get to api ([#12948](https://github.com/vm0-ai/vm0/issues/12948)) ([0e8ff89](https://github.com/vm0-ai/vm0/commit/0e8ff89ef99316ad6dfc0291e517db2d1eead220))
* migrate test telegram state GET to api backend ([#12943](https://github.com/vm0-ai/vm0/issues/12943)) ([e1ad37d](https://github.com/vm0-ai/vm0/commit/e1ad37d29feae5b567237e4f06510da4b832554f))
* migrate user export status to api ([#12949](https://github.com/vm0-ai/vm0/issues/12949)) ([0286e19](https://github.com/vm0-ai/vm0/commit/0286e19438623b2a84f2b898e93655c3fdb270d2))
* migrate v1 chat message send to api ([#13038](https://github.com/vm0-ai/vm0/issues/13038)) ([bf1a41e](https://github.com/vm0-ai/vm0/commit/bf1a41e56e05fad9b1b2487ae8f15f3d175b5877))
* migrate voice IO quota GET to api ([#12314](https://github.com/vm0-ai/vm0/issues/12314)) ([985ca34](https://github.com/vm0-ai/vm0/commit/985ca3456f237d8788e6a4fb9f404453ef6e3c82))
* migrate zero org logo GET to api backend ([#12929](https://github.com/vm0-ai/vm0/issues/12929)) ([91c2e28](https://github.com/vm0-ai/vm0/commit/91c2e28a5066a02a42419d9b1c3e06917a7cc51a))
* migrate zero usage GET routes to api ([#12936](https://github.com/vm0-ai/vm0/issues/12936)) ([6aa5612](https://github.com/vm0-ai/vm0/commit/6aa5612b961bc53fc5d1709c4215d8f4b47b8638))
* remove fully-enabled OfficialTelegramBot and ChatManualHistory feature switches ([#12349](https://github.com/vm0-ai/vm0/issues/12349)) ([ed51160](https://github.com/vm0-ai/vm0/commit/ed511603a19ec14a0003fccba66250560c290165))
* remove personal model provider switch ([#12361](https://github.com/vm0-ai/vm0/issues/12361)) ([6953d00](https://github.com/vm0-ai/vm0/commit/6953d0046a8c160e394ae079b0d3f5037b9f7c08))
* remove vm0 default agent env fallback ([#13011](https://github.com/vm0-ai/vm0/issues/13011)) ([5c90dfe](https://github.com/vm0-ai/vm0/commit/5c90dfe1f1aa7ce32dbadac90c6de53c0066e12f))
* use member metadata for model-first preference ([#12630](https://github.com/vm0-ai/vm0/issues/12630)) ([452eeb3](https://github.com/vm0-ai/vm0/commit/452eeb3fd693feac5c369ad22d432c7dd49b8c29))


### Performance Improvements

* **chat-threads:** replace ROW_NUMBER with LATERAL last-message lookup ([#12641](https://github.com/vm0-ai/vm0/issues/12641)) ([ba82b88](https://github.com/vm0-ai/vm0/commit/ba82b88bc34f948878ef6f862cae2a1c36aa77df))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.18.0
    * @vm0/core bumped to 8.273.0
    * @vm0/db bumped to 1.9.1

## [1.40.0](https://github.com/vm0-ai/vm0/compare/api-v1.39.1...api-v1.40.0) (2026-05-13)


### Features

* add fal video generation ([#13121](https://github.com/vm0-ai/vm0/issues/13121)) ([152b289](https://github.com/vm0-ai/vm0/commit/152b28990211cb7ea3756218adab2e0152c41947))
* **api:** migrate zero agents create route ([#13159](https://github.com/vm0-ai/vm0/issues/13159)) ([d9b751e](https://github.com/vm0-ai/vm0/commit/d9b751eea5c4ba187bfb2b4d5a35d4809f6fd02b))
* **api:** migrate zero schedules deploy and run routes ([#13137](https://github.com/vm0-ai/vm0/issues/13137)) ([5affefa](https://github.com/vm0-ai/vm0/commit/5affefa7531aa2f658c8d924fb1e17e676774e9b))


### Bug Fixes

* **api:** preserve chat model provider selection ([#13156](https://github.com/vm0-ai/vm0/issues/13156)) ([241cfb8](https://github.com/vm0-ai/vm0/commit/241cfb8ce13d190b33abca4096ff829b5c8f62f0))


### Refactoring

* **api:** migrate slack webhooks ([#13145](https://github.com/vm0-ai/vm0/issues/13145)) ([280d359](https://github.com/vm0-ai/vm0/commit/280d359fc085cbd309ee80788296ad61d2d60ee9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.17.0
    * @vm0/core bumped to 8.272.2
    * @vm0/db bumped to 1.9.0

## [1.39.1](https://github.com/vm0-ai/vm0/compare/api-v1.39.0...api-v1.39.1) (2026-05-13)


### Bug Fixes

* anchor cron schedule next run time ([#13138](https://github.com/vm0-ai/vm0/issues/13138)) ([b7c78e0](https://github.com/vm0-ai/vm0/commit/b7c78e0a9f423b055f69186741f4d841cd2aeef6))
* restore website docs and nav behavior ([#13123](https://github.com/vm0-ai/vm0/issues/13123)) ([6d2f45f](https://github.com/vm0-ai/vm0/commit/6d2f45f4870150fd9ac72773099721a68acbc1ac))


### Refactoring

* make codex providers feature-switch free ([#13126](https://github.com/vm0-ai/vm0/issues/13126)) ([6a3e7b3](https://github.com/vm0-ai/vm0/commit/6a3e7b37ff6fb0cd473bd72f61ff80e6ca74195f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.16.1
    * @vm0/connectors bumped to 1.8.1
    * @vm0/core bumped to 8.272.1
    * @vm0/db bumped to 1.8.1

## [1.39.0](https://github.com/vm0-ai/vm0/compare/api-v1.38.0...api-v1.39.0) (2026-05-13)


### Features

* add agentphone app ui ([#13080](https://github.com/vm0-ai/vm0/issues/13080)) ([ee19fc5](https://github.com/vm0-ai/vm0/commit/ee19fc53fc786fd8890d8a0bc3a6209d86f41889))
* **api:** port slack connect side effects ([#13117](https://github.com/vm0-ai/vm0/issues/13117)) ([bae9fc9](https://github.com/vm0-ai/vm0/commit/bae9fc913b5e5947553ca8437080e56795300bf2))


### Bug Fixes

* **api:** align chat message env validation ([#13116](https://github.com/vm0-ai/vm0/issues/13116)) ([bcc1457](https://github.com/vm0-ai/vm0/commit/bcc145719f53cca232e0c496291e58cd49bebb56))


### Refactoring

* **api:** migrate chat callback ([#13111](https://github.com/vm0-ai/vm0/issues/13111)) ([4ff6f43](https://github.com/vm0-ai/vm0/commit/4ff6f4375712738a10f0495d26e7576ed660da29))
* **api:** migrate slack org callback ([#13099](https://github.com/vm0-ai/vm0/issues/13099)) ([cd9abe1](https://github.com/vm0-ai/vm0/commit/cd9abe1a7c7b27b561cecd0f845a4ca213a16b41))
* **api:** migrate voice-chat callback ([#13105](https://github.com/vm0-ai/vm0/issues/13105)) ([bdc1367](https://github.com/vm0-ai/vm0/commit/bdc1367cf833a912f4e320c21c05af2a5893c71a))
* **api:** migrate zero runs create route ([#13076](https://github.com/vm0-ai/vm0/issues/13076)) ([2b64ac7](https://github.com/vm0-ai/vm0/commit/2b64ac71d8ac51509b1953d40fe140b707a2d444))
* make zero model-first only ([#13017](https://github.com/vm0-ai/vm0/issues/13017)) ([9bcb323](https://github.com/vm0-ai/vm0/commit/9bcb323d6e2c32dfdd2d1bf9fa63d0d2bf9e1ef1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.16.0
    * @vm0/connectors bumped to 1.8.0
    * @vm0/core bumped to 8.272.0
    * @vm0/db bumped to 1.8.0

## [1.38.0](https://github.com/vm0-ai/vm0/compare/api-v1.37.1...api-v1.38.0) (2026-05-13)


### Features

* **api:** migrate zero chat messages route ([#13060](https://github.com/vm0-ai/vm0/issues/13060)) ([3047e83](https://github.com/vm0-ai/vm0/commit/3047e8393e2d24e6075ef3bb8643b989f08411f3))


### Refactoring

* **api:** migrate github issues callback ([#13085](https://github.com/vm0-ai/vm0/issues/13085)) ([5d627c1](https://github.com/vm0-ai/vm0/commit/5d627c1ef7bf243003e5192f9adeaf3447699a34))
* **api:** migrate internal agent callback ([#13077](https://github.com/vm0-ai/vm0/issues/13077)) ([b40a430](https://github.com/vm0-ai/vm0/commit/b40a4301b30c5abee3d544fa282bad636b21c975))
* **api:** migrate internal schedule callbacks ([#13084](https://github.com/vm0-ai/vm0/issues/13084)) ([f11641a](https://github.com/vm0-ai/vm0/commit/f11641a748d784f518d19043b32893bfa40b61b5))
* **api:** migrate zero image io generate route ([#13061](https://github.com/vm0-ai/vm0/issues/13061)) ([8976c68](https://github.com/vm0-ai/vm0/commit/8976c68a6a2a277cc75982810b2a9331e5a1d77f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.15.0
    * @vm0/core bumped to 8.271.2
    * @vm0/db bumped to 1.7.2

## [1.37.1](https://github.com/vm0-ai/vm0/compare/api-v1.37.0...api-v1.37.1) (2026-05-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.14.0
    * @vm0/core bumped to 8.271.1
    * @vm0/db bumped to 1.7.1

## [1.37.0](https://github.com/vm0-ai/vm0/compare/api-v1.36.0...api-v1.37.0) (2026-05-12)


### Features

* **api:** implement agent run create and cancel routes ([#13035](https://github.com/vm0-ai/vm0/issues/13035)) ([d9ec3af](https://github.com/vm0-ai/vm0/commit/d9ec3af52581f2d0fba217226eba9dbe3a6e2bb3))
* **api:** migrate agent compose metadata route ([#13007](https://github.com/vm0-ai/vm0/issues/13007)) ([7aab48e](https://github.com/vm0-ai/vm0/commit/7aab48ec2d9c6ade59686d73031632214f3ab688))
* **api:** migrate github integration update route ([#13015](https://github.com/vm0-ai/vm0/issues/13015)) ([b5663ab](https://github.com/vm0-ai/vm0/commit/b5663ab73f329263af46adf3eda72a247fbd30b2))
* **api:** migrate telegram link route ([#13031](https://github.com/vm0-ai/vm0/issues/13031)) ([510d5e8](https://github.com/vm0-ai/vm0/commit/510d5e85b62e93ad61a807f1629d7d2979b5fd24))
* **api:** migrate test oauth token route ([#12998](https://github.com/vm0-ai/vm0/issues/12998)) ([e6f75b9](https://github.com/vm0-ai/vm0/commit/e6f75b96ce0533710e503e206db5fae0db9afa37))


### Refactoring

* **api:** migrate agent composes create route ([#13032](https://github.com/vm0-ai/vm0/issues/13032)) ([0fdd33b](https://github.com/vm0-ai/vm0/commit/0fdd33b6017440ea068c1125585f28866934e8d3))
* **api:** migrate cli auth routes ([#13033](https://github.com/vm0-ai/vm0/issues/13033)) ([a7c2a07](https://github.com/vm0-ai/vm0/commit/a7c2a07ef66882744298374231a64183c61923bc))
* **api:** migrate cron usage billing routes ([#13030](https://github.com/vm0-ai/vm0/issues/13030)) ([8bdee9c](https://github.com/vm0-ai/vm0/commit/8bdee9c022480628b42f809753963150ee4693c6))
* **api:** migrate email unsubscribe get route ([#13005](https://github.com/vm0-ai/vm0/issues/13005)) ([5fef14a](https://github.com/vm0-ai/vm0/commit/5fef14ae4d87fa7894436d83de6a073acbb0c6d2))
* **api:** migrate email unsubscribe route ([#13010](https://github.com/vm0-ai/vm0/issues/13010)) ([6b6ef71](https://github.com/vm0-ai/vm0/commit/6b6ef71b5e34070925c36b9dbd6bcf90d073ef77))
* **api:** migrate internal event consumers ([#13006](https://github.com/vm0-ai/vm0/issues/13006)) ([90a0043](https://github.com/vm0-ai/vm0/commit/90a0043d4ddccfd9599c4d16f305742abe6092fe))
* **api:** migrate model provider model update route ([#13016](https://github.com/vm0-ai/vm0/issues/13016)) ([bbc8684](https://github.com/vm0-ai/vm0/commit/bbc8684df65753a527285e9151befdbb3997ff1f))
* **api:** migrate permission access create route ([#12959](https://github.com/vm0-ai/vm0/issues/12959)) ([ed4df55](https://github.com/vm0-ai/vm0/commit/ed4df55ca31c697f2c67a4758a7b7bde565eaf56)), closes [#12883](https://github.com/vm0-ai/vm0/issues/12883)
* **api:** migrate runner post routes ([#13001](https://github.com/vm0-ai/vm0/issues/13001)) ([d352abb](https://github.com/vm0-ai/vm0/commit/d352abb0dae68703da190d98c82dc67653b7a15c))
* **api:** migrate storage write routes ([#13002](https://github.com/vm0-ai/vm0/issues/13002)) ([8e6e5db](https://github.com/vm0-ai/vm0/commit/8e6e5dbe47ef05054d443d54c16f61b601890306))
* **api:** migrate telegram integration patch route ([#13013](https://github.com/vm0-ai/vm0/issues/13013)) ([6b8f1e9](https://github.com/vm0-ai/vm0/commit/6b8f1e9c69d40a7410ac30ac2866c5293668f733))
* **api:** migrate telegram mock route ([#12995](https://github.com/vm0-ai/vm0/issues/12995)) ([7c7d409](https://github.com/vm0-ai/vm0/commit/7c7d4095ef24e9dc2343b83853da58e32081156f))
* **api:** migrate user export POST ([#13034](https://github.com/vm0-ai/vm0/issues/13034)) ([193fed0](https://github.com/vm0-ai/vm0/commit/193fed08017d9767be51c73ae5d083e761917447))
* **api:** migrate voice chat post routes ([#13039](https://github.com/vm0-ai/vm0/issues/13039)) ([417be66](https://github.com/vm0-ai/vm0/commit/417be6633818d5a80796e277c6d4eacab335343f))
* **api:** migrate zero agents patch route ([#13020](https://github.com/vm0-ai/vm0/issues/13020)) ([45663c9](https://github.com/vm0-ai/vm0/commit/45663c9ec30e3a1b493326a81e568583d933ef75))
* **api:** migrate zero org domain verification ([#13009](https://github.com/vm0-ai/vm0/issues/13009)) ([42174f2](https://github.com/vm0-ai/vm0/commit/42174f23f3729410f6f831eb779da71d7f6cd5ba))
* **api:** migrate zero org members delete route ([#13003](https://github.com/vm0-ai/vm0/issues/13003)) ([6a1dcb2](https://github.com/vm0-ai/vm0/commit/6a1dcb2fed5869df5983c68e0999bc2d588acfb5))
* **api:** migrate zero org members patch ([#13029](https://github.com/vm0-ai/vm0/issues/13029)) ([659cff6](https://github.com/vm0-ai/vm0/commit/659cff699968e2e2d26ba6f4f865170c98c01302))
* **api:** migrate zero schedules delete route ([#12999](https://github.com/vm0-ai/vm0/issues/12999)) ([74c2817](https://github.com/vm0-ai/vm0/commit/74c28173061133bbfaabe6e10e5734b83eba95c2))
* **api:** migrate zero skill deletion ([#13004](https://github.com/vm0-ai/vm0/issues/13004)) ([1e962d2](https://github.com/vm0-ai/vm0/commit/1e962d2d80acb6b6e5d2d039a83358c19ca69183))
* migrate generate image route to api ([#13012](https://github.com/vm0-ai/vm0/issues/13012)) ([1718609](https://github.com/vm0-ai/vm0/commit/171860936b1f0f585209db68ad302d1dc9b320f4))
* migrate v1 chat message send to api ([#13038](https://github.com/vm0-ai/vm0/issues/13038)) ([bf1a41e](https://github.com/vm0-ai/vm0/commit/bf1a41e56e05fad9b1b2487ae8f15f3d175b5877))
* remove vm0 default agent env fallback ([#13011](https://github.com/vm0-ai/vm0/issues/13011)) ([5c90dfe](https://github.com/vm0-ai/vm0/commit/5c90dfe1f1aa7ce32dbadac90c6de53c0066e12f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.13.0
    * @vm0/core bumped to 8.271.0
    * @vm0/db bumped to 1.7.0

## [1.36.0](https://github.com/vm0-ai/vm0/compare/api-v1.35.0...api-v1.36.0) (2026-05-12)


### Features

* add remote-agent run inspection commands ([#12971](https://github.com/vm0-ai/vm0/issues/12971)) ([27c2da0](https://github.com/vm0-ai/vm0/commit/27c2da07db02ed1b227fb70a93a64b3cb16a6926))
* **api:** migrate org model-provider mutations ([#12972](https://github.com/vm0-ai/vm0/issues/12972)) ([54a5eb7](https://github.com/vm0-ai/vm0/commit/54a5eb775ee0194181b11a98fd9d1bbf641b6736))
* **api:** migrate voice io post routes ([#12944](https://github.com/vm0-ai/vm0/issues/12944)) ([384fef8](https://github.com/vm0-ai/vm0/commit/384fef84e7b87163e0dc47f4a0112f11a72394ea))
* **api:** migrate zero connector post routes ([#12987](https://github.com/vm0-ai/vm0/issues/12987)) ([45d831e](https://github.com/vm0-ai/vm0/commit/45d831e9a78dcdf34f1a0f473210a007f541ff5e))


### Refactoring

* **api:** migrate Codex OAuth model-provider routes ([#12956](https://github.com/vm0-ai/vm0/issues/12956)) ([721a18c](https://github.com/vm0-ai/vm0/commit/721a18c93b3994b0fc7d3ac0f0c8773386a5a69a))
* **api:** migrate connector oauth direct routes ([#12962](https://github.com/vm0-ai/vm0/issues/12962)) ([2293ee9](https://github.com/vm0-ai/vm0/commit/2293ee986e4e55f1004d6d58c8d5550c4938a203))
* **api:** migrate github integration delete route ([#12954](https://github.com/vm0-ai/vm0/issues/12954)) ([399dfe5](https://github.com/vm0-ai/vm0/commit/399dfe5f57514e3e7cad840f297643b4d5adceed))
* **api:** migrate github oauth get routes ([#12986](https://github.com/vm0-ai/vm0/issues/12986)) ([ca4b7f1](https://github.com/vm0-ai/vm0/commit/ca4b7f1964f4762044a612ee867868166940fecf))
* **api:** migrate permission access resolve route ([#12938](https://github.com/vm0-ai/vm0/issues/12938)) ([4f999a5](https://github.com/vm0-ai/vm0/commit/4f999a53da9a0d89ddb22d4da81b4294dd522168))
* **api:** migrate slack integration delete route ([#12991](https://github.com/vm0-ai/vm0/issues/12991)) ([ffa5290](https://github.com/vm0-ai/vm0/commit/ffa5290b227dc8a162af3a06aa13b2e0a23ec9e2))
* **api:** migrate slack state delete route ([#12968](https://github.com/vm0-ai/vm0/issues/12968)) ([4f84a71](https://github.com/vm0-ai/vm0/commit/4f84a7178a54373dffcfb0d7e5c0f004dadfdfe4))
* **api:** migrate telegram integration get routes ([#12969](https://github.com/vm0-ai/vm0/issues/12969)) ([4e62786](https://github.com/vm0-ai/vm0/commit/4e62786c07b510166073c740552b4b7fec5b90e6))
* **api:** migrate telegram test state seeding ([#12985](https://github.com/vm0-ai/vm0/issues/12985)) ([96b8fbb](https://github.com/vm0-ai/vm0/commit/96b8fbb62b7f6b3d55a322a8bbcd3a77df8cdb69))
* **api:** migrate test slack state post route ([#12988](https://github.com/vm0-ai/vm0/issues/12988)) ([1a77b71](https://github.com/vm0-ai/vm0/commit/1a77b71818739e448f2bfa9529656c48421fdf36))
* **api:** migrate test telegram state delete route ([#12977](https://github.com/vm0-ai/vm0/issues/12977)) ([5ade3b3](https://github.com/vm0-ai/vm0/commit/5ade3b3dcaebeb32e6fa7d15c9975c306a334601))
* **api:** migrate zero agent update routes to api backend ([#12940](https://github.com/vm0-ai/vm0/issues/12940)) ([83758da](https://github.com/vm0-ai/vm0/commit/83758dadb4386cb00efb337bd9066b0f9083158c))
* **api:** migrate zero agents delete route ([#12983](https://github.com/vm0-ai/vm0/issues/12983)) ([1a7b5af](https://github.com/vm0-ai/vm0/commit/1a7b5af6c0bf2e59909c6787b8cb54795354626c))
* **api:** migrate zero api key creation ([#12993](https://github.com/vm0-ai/vm0/issues/12993)) ([34a915d](https://github.com/vm0-ai/vm0/commit/34a915d77fcd5b1a2158c0253e2db32e862fced8))
* **api:** migrate zero connector deletes ([#12989](https://github.com/vm0-ai/vm0/issues/12989)) ([2a2706e](https://github.com/vm0-ai/vm0/commit/2a2706e8d61272ad7697f7ecb2aab737473cbbf9))
* **api:** migrate zero developer support route ([#12984](https://github.com/vm0-ai/vm0/issues/12984)) ([2c23fcf](https://github.com/vm0-ai/vm0/commit/2c23fcf0b842b08ffc6e0c8ff781263cd84ed555))
* **api:** migrate zero model providers delete route ([#12990](https://github.com/vm0-ai/vm0/issues/12990)) ([9cd2a73](https://github.com/vm0-ai/vm0/commit/9cd2a73ca2a477ee0cb49a0146cda591e6610507))
* **api:** migrate zero onboarding setup route ([#12975](https://github.com/vm0-ai/vm0/issues/12975)) ([a99038b](https://github.com/vm0-ai/vm0/commit/a99038ba5394dccfeeb2428171eaa9ff4ed20301))
* **api:** migrate zero org delete route ([#12973](https://github.com/vm0-ai/vm0/issues/12973)) ([7e4033e](https://github.com/vm0-ai/vm0/commit/7e4033e48ccbfbc87db90a46774887aa29da2c13))
* **api:** migrate zero org domains add route ([#12966](https://github.com/vm0-ai/vm0/issues/12966)) ([20677d6](https://github.com/vm0-ai/vm0/commit/20677d68d455a18f778566efe9f904bc5b4cb16a))
* **api:** migrate zero org domains delete route ([#12992](https://github.com/vm0-ai/vm0/issues/12992)) ([4a1f844](https://github.com/vm0-ai/vm0/commit/4a1f84484a0af16f8c39ff87560a5f7c926e9d05))
* **api:** migrate zero org leave route ([#12963](https://github.com/vm0-ai/vm0/issues/12963)) ([e6271ef](https://github.com/vm0-ai/vm0/commit/e6271efe807772850185e808ef7446e549fb79f2))
* **api:** migrate zero org logo upload route ([#12953](https://github.com/vm0-ai/vm0/issues/12953)) ([dee447f](https://github.com/vm0-ai/vm0/commit/dee447f07b6423fa426e41a3bef885f2d0d0f633))
* **api:** migrate zero org update route ([#12942](https://github.com/vm0-ai/vm0/issues/12942)) ([2993177](https://github.com/vm0-ai/vm0/commit/2993177a164a592a4782aea1e9ef92ea6a4f496e))
* **api:** migrate zero realtime token route ([#12955](https://github.com/vm0-ai/vm0/issues/12955)) ([d5d74f0](https://github.com/vm0-ai/vm0/commit/d5d74f0ea9b1709f6663471e98e7084d084fb3bb))
* **api:** migrate zero report-error route ([#12961](https://github.com/vm0-ai/vm0/issues/12961)) ([f6a0127](https://github.com/vm0-ai/vm0/commit/f6a012768ed0939c2cabce390a0d7f0941e9188a))
* **api:** migrate zero secrets post route ([#12946](https://github.com/vm0-ai/vm0/issues/12946)) ([bf2e7bf](https://github.com/vm0-ai/vm0/commit/bf2e7bffc08c3bc83be8dc5e04388955b5b9c1e4))
* **api:** migrate zero skills create route ([#12952](https://github.com/vm0-ai/vm0/issues/12952)) ([a9f063c](https://github.com/vm0-ai/vm0/commit/a9f063c85e9c217f5ee89b7ad46ad46efca5ac28))
* **api:** migrate zero slack oauth routes ([#12958](https://github.com/vm0-ai/vm0/issues/12958)) ([7e76cde](https://github.com/vm0-ai/vm0/commit/7e76cde7a3ee7ee8358b7cdd5b060d265f41f9fc))
* **api:** migrate zero variables post route ([#12945](https://github.com/vm0-ai/vm0/issues/12945)) ([8d4607d](https://github.com/vm0-ai/vm0/commit/8d4607d2d11e737d8d9d0e4343bdee2bf905aa1d))
* migrate agent compose delete route ([#12915](https://github.com/vm0-ai/vm0/issues/12915)) ([08408d6](https://github.com/vm0-ai/vm0/commit/08408d6756e737fb9c922757bd8b1be6012f635a))
* migrate agent composes read routes to api ([#12950](https://github.com/vm0-ai/vm0/issues/12950)) ([bc0a2fb](https://github.com/vm0-ai/vm0/commit/bc0a2fb55b133e044c0dc991cfc50d5c95dc9d42))
* migrate agent run telemetry to api ([#12981](https://github.com/vm0-ai/vm0/issues/12981)) ([451d2b5](https://github.com/vm0-ai/vm0/commit/451d2b5a44a878f0f4ce048424790ef2f1f90cb5))
* migrate agent runs read routes to api ([#12974](https://github.com/vm0-ai/vm0/issues/12974)) ([edcb5a4](https://github.com/vm0-ai/vm0/commit/edcb5a41dec38adfce88a822812b14cf15182c18))
* migrate agent sessions route to api ([#12939](https://github.com/vm0-ai/vm0/issues/12939)) ([f11ea4c](https://github.com/vm0-ai/vm0/commit/f11ea4c3c8916e942706b719d42fb2522b1fe5f4))
* migrate github integration status to api ([#12976](https://github.com/vm0-ai/vm0/issues/12976)) ([bdf0270](https://github.com/vm0-ai/vm0/commit/bdf0270487661b5d8f44aac480e75ddcd651682b))
* migrate integrations chat message route to api ([#12978](https://github.com/vm0-ai/vm0/issues/12978)) ([12a4171](https://github.com/vm0-ai/vm0/commit/12a41718f155c7e9c19a6c4b58898c656ee1fb7e))
* migrate logs search to api ([#12960](https://github.com/vm0-ai/vm0/issues/12960)) ([fc42cf7](https://github.com/vm0-ai/vm0/commit/fc42cf7e4c7a78fe9d3eaf3c1c40acb28a52c20a))
* migrate storage GET routes to api backend ([#12957](https://github.com/vm0-ai/vm0/issues/12957)) ([1fe70fb](https://github.com/vm0-ai/vm0/commit/1fe70fb9ff07ceaf9f986816f8879d1f7a86e034))
* migrate telegram delete routes to api ([#12965](https://github.com/vm0-ai/vm0/issues/12965)) ([77881e0](https://github.com/vm0-ai/vm0/commit/77881e0342dd7489b5866e8c9c4d263efb137743))
* migrate test slack state get to api ([#12948](https://github.com/vm0-ai/vm0/issues/12948)) ([0e8ff89](https://github.com/vm0-ai/vm0/commit/0e8ff89ef99316ad6dfc0291e517db2d1eead220))
* migrate test telegram state GET to api backend ([#12943](https://github.com/vm0-ai/vm0/issues/12943)) ([e1ad37d](https://github.com/vm0-ai/vm0/commit/e1ad37d29feae5b567237e4f06510da4b832554f))
* migrate user export status to api ([#12949](https://github.com/vm0-ai/vm0/issues/12949)) ([0286e19](https://github.com/vm0-ai/vm0/commit/0286e19438623b2a84f2b898e93655c3fdb270d2))
* migrate zero usage GET routes to api ([#12936](https://github.com/vm0-ai/vm0/issues/12936)) ([6aa5612](https://github.com/vm0-ai/vm0/commit/6aa5612b961bc53fc5d1709c4215d8f4b47b8638))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.12.0
    * @vm0/connectors bumped to 1.7.0
    * @vm0/core bumped to 8.270.0
    * @vm0/db bumped to 1.6.2

## [1.35.0](https://github.com/vm0-ai/vm0/compare/api-v1.34.0...api-v1.35.0) (2026-05-12)


### Features

* add remote agent connector ([#12905](https://github.com/vm0-ai/vm0/issues/12905)) ([7627df6](https://github.com/vm0-ai/vm0/commit/7627df6dcb78e27bdac6d1c81d44f8f384b4de36))
* **api:** add callback-route hmac auth primitive (prereq for Wave 6 [#19](https://github.com/vm0-ai/vm0/issues/19)) ([#12768](https://github.com/vm0-ai/vm0/issues/12768)) ([d25165a](https://github.com/vm0-ai/vm0/commit/d25165a0ea8618833484168fc46b974cedaf35a2))
* **api:** migrate integrations/slack/connect post to api backend ([#12795](https://github.com/vm0-ai/vm0/issues/12795)) ([cea3812](https://github.com/vm0-ai/vm0/commit/cea381281078dcf2874279510d9e4ac074ac12f9))
* **api:** migrate integrations/slack/upload-file init+complete to api backend (wave 6 [#18](https://github.com/vm0-ai/vm0/issues/18)) ([#12767](https://github.com/vm0-ai/vm0/issues/12767)) ([fad9050](https://github.com/vm0-ai/vm0/commit/fad9050746abb4292017e2c9e2f7542333d3e84f))


### Refactoring

* **api:** migrate usage route to api backend ([#12906](https://github.com/vm0-ai/vm0/issues/12906)) ([df42008](https://github.com/vm0-ai/vm0/commit/df42008a4dd9fece0a021e35c957ff343f713285))
* **api:** migrate zero skills update route ([#12913](https://github.com/vm0-ai/vm0/issues/12913)) ([fe3000e](https://github.com/vm0-ai/vm0/commit/fe3000effede31da8b96643cf0d2491b6a11aaa2))
* migrate agent checkpoints route to api ([#12914](https://github.com/vm0-ai/vm0/issues/12914)) ([004e3c6](https://github.com/vm0-ai/vm0/commit/004e3c6ff61164a62f926adddcbcd094b1093941))
* migrate auth me GET to api backend ([#12911](https://github.com/vm0-ai/vm0/issues/12911)) ([9140e92](https://github.com/vm0-ai/vm0/commit/9140e92ee8be732e8e0a3421b516169cf0910181))
* migrate permission access request list route ([#12904](https://github.com/vm0-ai/vm0/issues/12904)) ([44e5f1e](https://github.com/vm0-ai/vm0/commit/44e5f1eccdbcaa7bfdbc88cf31f2e64adbc6ac28))
* migrate test oauth provider get routes to api ([#12916](https://github.com/vm0-ai/vm0/issues/12916)) ([37019ca](https://github.com/vm0-ai/vm0/commit/37019ca6abb6bb29a0d391976e6377bc2e2dd83c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.11.0
    * @vm0/connectors bumped to 1.6.0
    * @vm0/core bumped to 8.269.1
    * @vm0/db bumped to 1.6.1

## [1.34.0](https://github.com/vm0-ai/vm0/compare/api-v1.33.0...api-v1.34.0) (2026-05-12)


### Features

* add remote-agent cli execution flow ([#12671](https://github.com/vm0-ai/vm0/issues/12671)) ([4f68949](https://github.com/vm0-ai/vm0/commit/4f68949d869868851ef281911160bf2b138a75ec))
* **api:** migrate billing/redeem post to api backend (wave 6 [#14](https://github.com/vm0-ai/vm0/issues/14)) ([#12751](https://github.com/vm0-ai/vm0/issues/12751)) ([9848d11](https://github.com/vm0-ai/vm0/commit/9848d118aeb473d3abc56cc647b4f170f51e7a25))
* **api:** migrate computer-use register+unregister to api backend (wave 6 [#16](https://github.com/vm0-ai/vm0/issues/16)) ([#12750](https://github.com/vm0-ai/vm0/issues/12750)) ([8437d31](https://github.com/vm0-ai/vm0/commit/8437d31c3cfb8765601337dbb8d58aa19da62ab9)), closes [#12737](https://github.com/vm0-ai/vm0/issues/12737) [#12290](https://github.com/vm0-ai/vm0/issues/12290)
* **api:** migrate integrations/slack/message post to api backend (wave 6 [#15](https://github.com/vm0-ai/vm0/issues/15)) ([#12748](https://github.com/vm0-ai/vm0/issues/12748)) ([5d39641](https://github.com/vm0-ai/vm0/commit/5d396418e9de7689811f742bc6355abb06a0eedb))
* **api:** migrate integrations/telegram/upload-file init+complete to api backend (wave 6 [#17](https://github.com/vm0-ai/vm0/issues/17)) ([#12752](https://github.com/vm0-ai/vm0/issues/12752)) ([6cb78ac](https://github.com/vm0-ai/vm0/commit/6cb78ac1f03145836e7fdd482b5cce235e83ef1e))
* **api:** migrate org/members/credit-cap put to api backend (wave 6 [#13](https://github.com/vm0-ai/vm0/issues/13)) ([#12732](https://github.com/vm0-ai/vm0/issues/12732)) ([566a767](https://github.com/vm0-ai/vm0/commit/566a76775d26130b2e4444f4f5f40a89a1275e96)), closes [#12290](https://github.com/vm0-ai/vm0/issues/12290) [#12726](https://github.com/vm0-ai/vm0/issues/12726)
* **api:** migrate org/membership-requests accept+reject to api backend (wave 6 [#12](https://github.com/vm0-ai/vm0/issues/12)) ([#12728](https://github.com/vm0-ai/vm0/issues/12728)) ([4df31c6](https://github.com/vm0-ai/vm0/commit/4df31c6c7e68fb53fca5643fa8c2f2add23ca04a))


### Bug Fixes

* align zero model provider route parity ([#12747](https://github.com/vm0-ai/vm0/issues/12747)) ([5864eca](https://github.com/vm0-ai/vm0/commit/5864ecab99087af29b1474036b750d8a46620080))
* align zero org read parity ([#12763](https://github.com/vm0-ai/vm0/issues/12763)) ([8ea3279](https://github.com/vm0-ai/vm0/commit/8ea32795aef6a69525f7759723b784a2703f0356))
* align zero skills route parity ([#12773](https://github.com/vm0-ai/vm0/issues/12773)) ([4cd4998](https://github.com/vm0-ai/vm0/commit/4cd4998d80b5dd04dd60faa20215939839015756))
* align zero usage insight route parity ([#12775](https://github.com/vm0-ai/vm0/issues/12775)) ([2580064](https://github.com/vm0-ai/vm0/commit/2580064aee8ba4b8a560073a7c28878abfae4efd))
* align zero web download parity ([#12780](https://github.com/vm0-ai/vm0/issues/12780)) ([8bea40a](https://github.com/vm0-ai/vm0/commit/8bea40a50b7b42876acf2250b196cb2ff78543c8))
* pin model-first chat thread model ([#12740](https://github.com/vm0-ai/vm0/issues/12740)) ([de6006a](https://github.com/vm0-ai/vm0/commit/de6006ac76936e3f67257ac736e81a2c360b1c30))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.10.0
    * @vm0/connectors bumped to 1.5.0
    * @vm0/core bumped to 8.269.0
    * @vm0/db bumped to 1.6.0

## [1.33.0](https://github.com/vm0-ai/vm0/compare/api-v1.32.0...api-v1.33.0) (2026-05-11)


### Features

* **api:** migrate auto-recharge put to api backend (wave 6 [#9](https://github.com/vm0-ai/vm0/issues/9)) ([#12715](https://github.com/vm0-ai/vm0/issues/12715)) ([5fb26e1](https://github.com/vm0-ai/vm0/commit/5fb26e181a42817bd7fa21237e7d85e2fe44eafc)), closes [#12290](https://github.com/vm0-ai/vm0/issues/12290) [#12711](https://github.com/vm0-ai/vm0/issues/12711)
* **api:** migrate billing downgrade endpoint to api backend ([#12680](https://github.com/vm0-ai/vm0/issues/12680)) ([#12697](https://github.com/vm0-ai/vm0/issues/12697)) ([bb19bf0](https://github.com/vm0-ai/vm0/commit/bb19bf0a0f6a93dd53890a4062ca9335e4eaf3a2))
* **api:** migrate onboarding/complete post to api backend ([#12695](https://github.com/vm0-ai/vm0/issues/12695)) ([622a993](https://github.com/vm0-ai/vm0/commit/622a99373eb7c33bf796538771281199c779f261))
* **api:** migrate permission-policies put to api backend (Wave 6 [#6](https://github.com/vm0-ai/vm0/issues/6)) ([#12687](https://github.com/vm0-ai/vm0/issues/12687)) ([843d550](https://github.com/vm0-ai/vm0/commit/843d55024d5b848912e9b01cc8ce0356c26e33c0))
* **api:** migrate push-subscriptions post to api backend (wave 6 [#8](https://github.com/vm0-ai/vm0/issues/8)) ([#12694](https://github.com/vm0-ai/vm0/issues/12694)) ([864ec4d](https://github.com/vm0-ai/vm0/commit/864ec4d66dc9c0b3cfcfb01fec03d9b77cf925de)), closes [#12683](https://github.com/vm0-ai/vm0/issues/12683)


### Performance Improvements

* **chat-threads:** replace ROW_NUMBER with LATERAL last-message lookup ([#12641](https://github.com/vm0-ai/vm0/issues/12641)) ([ba82b88](https://github.com/vm0-ai/vm0/commit/ba82b88bc34f948878ef6f862cae2a1c36aa77df))

## [1.32.0](https://github.com/vm0-ai/vm0/compare/api-v1.31.1...api-v1.32.0) (2026-05-11)


### Features

* add private agents ([#12655](https://github.com/vm0-ai/vm0/issues/12655)) ([e37c8e5](https://github.com/vm0-ai/vm0/commit/e37c8e535da8ce48e011066b7c99e8ebffd8f076))
* **api:** migrate billing checkout endpoint to api backend ([#12596](https://github.com/vm0-ai/vm0/issues/12596)) ([#12606](https://github.com/vm0-ai/vm0/issues/12606)) ([a666f95](https://github.com/vm0-ai/vm0/commit/a666f9528f008b1e825d7081f273788aa17a230f))


### Bug Fixes

* align agent instructions route parity ([#12672](https://github.com/vm0-ai/vm0/issues/12672)) ([4d796b7](https://github.com/vm0-ai/vm0/commit/4d796b78025fb52132f0104fa295cb470e85c923))
* align v1 chat thread read route parity ([#12632](https://github.com/vm0-ai/vm0/issues/12632)) ([f0e9abd](https://github.com/vm0-ai/vm0/commit/f0e9abd379d9e8fc55bbd311e8a5cede3cf06330))


### Refactoring

* **api:** migrate billing/portal post to api backend (wave 6 [#1](https://github.com/vm0-ai/vm0/issues/1)) ([#12670](https://github.com/vm0-ai/vm0/issues/12670)) ([7508575](https://github.com/vm0-ai/vm0/commit/750857546875646d151b0b7e0635440a0a34e1d8)), closes [#12595](https://github.com/vm0-ai/vm0/issues/12595)
* remove personal model provider switch ([#12361](https://github.com/vm0-ai/vm0/issues/12361)) ([6953d00](https://github.com/vm0-ai/vm0/commit/6953d0046a8c160e394ae079b0d3f5037b9f7c08))
* use member metadata for model-first preference ([#12630](https://github.com/vm0-ai/vm0/issues/12630)) ([452eeb3](https://github.com/vm0-ai/vm0/commit/452eeb3fd693feac5c369ad22d432c7dd49b8c29))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.9.0
    * @vm0/connectors bumped to 1.4.0
    * @vm0/core bumped to 8.268.0
    * @vm0/db bumped to 1.5.0

## [1.31.1](https://github.com/vm0-ai/vm0/compare/api-v1.31.0...api-v1.31.1) (2026-05-11)


### Refactoring

* **api:** migrate default-agent put to api backend ([#12604](https://github.com/vm0-ai/vm0/issues/12604)) ([d51726c](https://github.com/vm0-ai/vm0/commit/d51726ca7a4fa6034e61022fd8197c4c70dd2694)), closes [#12290](https://github.com/vm0-ai/vm0/issues/12290) [#12598](https://github.com/vm0-ai/vm0/issues/12598)
* **api:** migrate org/invite post to api backend ([#12607](https://github.com/vm0-ai/vm0/issues/12607)) ([2218e92](https://github.com/vm0-ai/vm0/commit/2218e92a10afada7f8b63a7c822b93ff8d2a3956))

## [1.31.0](https://github.com/vm0-ai/vm0/compare/api-v1.30.0...api-v1.31.0) (2026-05-10)


### Features

* **api:** migrate chat-threads patch [id] (update draft) to api backend ([#12569](https://github.com/vm0-ai/vm0/issues/12569)) ([d706640](https://github.com/vm0-ai/vm0/commit/d706640a6f3d25b2b54d693f5cd8ad4912868f62))
* **api:** migrate me/model-providers post upsert to api backend (Wave 5 — completes family) ([#12591](https://github.com/vm0-ai/vm0/issues/12591)) ([acca625](https://github.com/vm0-ai/vm0/commit/acca625468e9d19e8c6eb8133a7ecb68998f4060))
* **api:** port composes [id]/metadata PATCH to api backend (Wave 5) ([#12561](https://github.com/vm0-ai/vm0/issues/12561)) ([1fbaa00](https://github.com/vm0-ai/vm0/commit/1fbaa005166a28299f41f3eb9bf1381f4cebee2c))
* **api:** port integrations/telegram/message POST to api backend (Wave 5) ([#12580](https://github.com/vm0-ai/vm0/issues/12580)) ([98e3521](https://github.com/vm0-ai/vm0/commit/98e3521495a16569204289e06a66abd5554aba3a))
* **api:** port member-cap evaluation for runs cancel credit reconciliation ([#12594](https://github.com/vm0-ai/vm0/issues/12594)) ([55870bd](https://github.com/vm0-ai/vm0/commit/55870bde9e060eb54c0d0b2103d31dbd19355005))


### Refactoring

* **api:** migrate agents user-connectors put to api backend ([#12581](https://github.com/vm0-ai/vm0/issues/12581)) ([0bc5a98](https://github.com/vm0-ai/vm0/commit/0bc5a98f1690426a44b06bff95da6f1cf7a87dc4))
* **api:** migrate chat-threads artifacts sync to api backend (wave 5) ([#12563](https://github.com/vm0-ai/vm0/issues/12563)) ([d24b397](https://github.com/vm0-ai/vm0/commit/d24b3974f2f1bc30af83af27f390646ac3be4878)), closes [#12562](https://github.com/vm0-ai/vm0/issues/12562)
* **api:** migrate chat-threads delete [id] to api backend ([#12565](https://github.com/vm0-ai/vm0/issues/12565)) ([66ef7de](https://github.com/vm0-ai/vm0/commit/66ef7decc4b18a4c874ab6095cef8c004a2224af))
* **api:** migrate runs cancel to api backend (wave 5) ([#12577](https://github.com/vm0-ai/vm0/issues/12577)) ([bc6f2e7](https://github.com/vm0-ai/vm0/commit/bc6f2e7b865804c5673ea0f1a0cdc9a390a15c58)), closes [#12570](https://github.com/vm0-ai/vm0/issues/12570)
* **api:** migrate uploads complete post to api backend ([#12592](https://github.com/vm0-ai/vm0/issues/12592)) ([4b1f30f](https://github.com/vm0-ai/vm0/commit/4b1f30f890e7c62bf68b335081e7a1b5c9d5b5cb))
* **api:** migrate uploads/prepare post to api backend (Wave 5) ([#12590](https://github.com/vm0-ai/vm0/issues/12590)) ([37bc690](https://github.com/vm0-ai/vm0/commit/37bc690f6744a96b48412b6a172e91e7e79fa3ec))
* **api:** port runs cancel credit reconciliation atomic core (wave 5 follow-up) ([#12585](https://github.com/vm0-ai/vm0/issues/12585)) ([beee285](https://github.com/vm0-ai/vm0/commit/beee28545c51bf9098569c6b9145ec96cac97b8d))
* **api:** port runs cancel queue-drain (wave 5 follow-up) ([#12582](https://github.com/vm0-ai/vm0/issues/12582)) ([46ce11e](https://github.com/vm0-ai/vm0/commit/46ce11eb79bae216df1f1ec899b63e52bd1c1c4a))
* **api:** port stripe auto-recharge for runs cancel (wave 5 cascade) ([#12593](https://github.com/vm0-ai/vm0/issues/12593)) ([b6b5d8b](https://github.com/vm0-ai/vm0/commit/b6b5d8b37c7f78e7e99f2e670fe8cb794045b436)), closes [#12587](https://github.com/vm0-ai/vm0/issues/12587)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.8.0
    * @vm0/core bumped to 8.267.3
    * @vm0/db bumped to 1.4.4

## [1.30.0](https://github.com/vm0-ai/vm0/compare/api-v1.29.0...api-v1.30.0) (2026-05-10)


### Features

* **api:** port me/model-providers delete to api backend ([#12552](https://github.com/vm0-ai/vm0/issues/12552)) ([4fa5958](https://github.com/vm0-ai/vm0/commit/4fa59589f64793a28c9ae6dd850845efd9ecfafe))


### Refactoring

* **api:** migrate chat-threads post (create thread) to api backend ([#12553](https://github.com/vm0-ai/vm0/issues/12553)) ([0790f7d](https://github.com/vm0-ai/vm0/commit/0790f7d565440eac6da45fa37b99a2f74c712747))
* **api:** migrate me/model-providers patch model to api backend (wave 5) ([#12559](https://github.com/vm0-ai/vm0/issues/12559)) ([097f4a4](https://github.com/vm0-ai/vm0/commit/097f4a449d1537ff308c51976f26a5899301537e)), closes [#12556](https://github.com/vm0-ai/vm0/issues/12556)

## [1.29.0](https://github.com/vm0-ai/vm0/compare/api-v1.28.0...api-v1.29.0) (2026-05-10)


### Features

* **api:** migrate variables delete [name] to api backend ([#12549](https://github.com/vm0-ai/vm0/issues/12549)) ([808c8ae](https://github.com/vm0-ai/vm0/commit/808c8aece8b067b69cf27e0ab7cdc635decf0ec5))
* **api:** port secrets delete to api backend ([#12542](https://github.com/vm0-ai/vm0/issues/12542)) ([c2738af](https://github.com/vm0-ai/vm0/commit/c2738af9df9a12783a5143aaa12b976c09c3647b))


### Refactoring

* **api:** migrate composes delete to api backend (wave 5) ([#12548](https://github.com/vm0-ai/vm0/issues/12548)) ([f2e9359](https://github.com/vm0-ai/vm0/commit/f2e93593f8091c49cdc77271afac0d62ad7c7c93)), closes [#12544](https://github.com/vm0-ai/vm0/issues/12544)
* **api:** migrate feature-switches post + delete to api backend ([#12546](https://github.com/vm0-ai/vm0/issues/12546)) ([8107427](https://github.com/vm0-ai/vm0/commit/810742718741213be6b0bd99906796771762d446))

## [1.28.0](https://github.com/vm0-ai/vm0/compare/api-v1.27.1...api-v1.28.0) (2026-05-10)


### Features

* **api:** migrate custom-connectors put [id]/secret to api backend ([#12534](https://github.com/vm0-ai/vm0/issues/12534)) ([34e1242](https://github.com/vm0-ai/vm0/commit/34e12422714c98cfac944d061107bba0bca67218))
* **api:** port custom-connectors delete to api backend ([#12535](https://github.com/vm0-ai/vm0/issues/12535)) ([eee2bdc](https://github.com/vm0-ai/vm0/commit/eee2bdc7e626e934dfcd5c71f8354b13891f7b53))


### Refactoring

* **api:** migrate custom-connectors patch [id] to api backend ([#12533](https://github.com/vm0-ai/vm0/issues/12533)) ([374097d](https://github.com/vm0-ai/vm0/commit/374097d077c280096a3850d2cceef10f6d4930ba))

## [1.27.1](https://github.com/vm0-ai/vm0/compare/api-v1.27.0...api-v1.27.1) (2026-05-10)


### Refactoring

* **api:** migrate custom-connectors delete secret to api backend ([#12532](https://github.com/vm0-ai/vm0/issues/12532)) ([2fc9e02](https://github.com/vm0-ai/vm0/commit/2fc9e02efb83579c63c1082d453e11890a7c6a75)), closes [#12531](https://github.com/vm0-ai/vm0/issues/12531)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.7.1
    * @vm0/connectors bumped to 1.3.0
    * @vm0/core bumped to 8.267.2
    * @vm0/db bumped to 1.4.3

## [1.27.0](https://github.com/vm0-ai/vm0/compare/api-v1.26.0...api-v1.27.0) (2026-05-10)


### Features

* **api:** migrate internal telegram-typing post to api backend ([#12525](https://github.com/vm0-ai/vm0/issues/12525)) ([29f62cf](https://github.com/vm0-ai/vm0/commit/29f62cfee65a19b6d23e5d9f6be80f41a3dac067))
* **api:** port custom-connectors create post to api backend ([#12524](https://github.com/vm0-ai/vm0/issues/12524)) ([b4421a8](https://github.com/vm0-ai/vm0/commit/b4421a8f8eebabd8c187879e79ffcb124bd729eb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.7.0
    * @vm0/core bumped to 8.267.1
    * @vm0/db bumped to 1.4.2

## [1.26.0](https://github.com/vm0-ai/vm0/compare/api-v1.25.0...api-v1.26.0) (2026-05-10)


### Features

* **api:** migrate chat-threads pin route to api backend ([#12517](https://github.com/vm0-ai/vm0/issues/12517)) ([f2188d4](https://github.com/vm0-ai/vm0/commit/f2188d40c16ba7f0cfa8ae048348fc3c002866bd))


### Refactoring

* **api:** migrate chat-threads rename post to api backend ([#12516](https://github.com/vm0-ai/vm0/issues/12516)) ([96604b5](https://github.com/vm0-ai/vm0/commit/96604b58d91d1e30f94606239a202a7661239468))
* **api:** migrate chat-threads unpin post to api backend ([#12515](https://github.com/vm0-ai/vm0/issues/12515)) ([a9bcfba](https://github.com/vm0-ai/vm0/commit/a9bcfbad44cfb6d72a4177676776f4a1e6199060)), closes [#12514](https://github.com/vm0-ai/vm0/issues/12514)

## [1.25.0](https://github.com/vm0-ai/vm0/compare/api-v1.24.3...api-v1.25.0) (2026-05-10)


### Features

* **api:** port chat-threads mark-read post to api backend ([#12511](https://github.com/vm0-ai/vm0/issues/12511)) ([e37f0e8](https://github.com/vm0-ai/vm0/commit/e37f0e8d774013073d6e0c11174c464b79e84f6f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.6.1
    * @vm0/connectors bumped to 1.2.0
    * @vm0/core bumped to 8.267.0
    * @vm0/db bumped to 1.4.1

## [1.24.3](https://github.com/vm0-ai/vm0/compare/api-v1.24.2...api-v1.24.3) (2026-05-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.266.0

## [1.24.2](https://github.com/vm0-ai/vm0/compare/api-v1.24.1...api-v1.24.2) (2026-05-10)


### Bug Fixes

* **api:** drop visibility filter from zeroChatThreadMessagesPage ([#12498](https://github.com/vm0-ai/vm0/issues/12498)) ([26aca91](https://github.com/vm0-ai/vm0/commit/26aca9170d7e69418c3912065644f8aa104bf4da))
* **api:** port axiom event watermark to mask indexing lag ([#12502](https://github.com/vm0-ai/vm0/issues/12502)) ([f79c79e](https://github.com/vm0-ai/vm0/commit/f79c79e353231372d78955bcf5a984adfcc1c187))

## [1.24.1](https://github.com/vm0-ai/vm0/compare/api-v1.24.0...api-v1.24.1) (2026-05-10)


### Bug Fixes

* **api:** port google drive artifact sync status to chat-threads artifacts get ([#12499](https://github.com/vm0-ai/vm0/issues/12499)) ([541165f](https://github.com/vm0-ai/vm0/commit/541165f97bacc3b3b93752e1655e7ccab9c67e3b)), closes [#12488](https://github.com/vm0-ai/vm0/issues/12488)


### Refactoring

* **api:** migrate zero chat search get to api backend ([#12494](https://github.com/vm0-ai/vm0/issues/12494)) ([a21a72a](https://github.com/vm0-ai/vm0/commit/a21a72a6c86d74c43653c435532b074661e376c6)), closes [#12491](https://github.com/vm0-ai/vm0/issues/12491)
* **api:** migrate zero chat thread messages get to api backend ([#12492](https://github.com/vm0-ai/vm0/issues/12492)) ([7c3b418](https://github.com/vm0-ai/vm0/commit/7c3b41839c2feb30a2dcaf6149445f806e8454dd))
* **api:** migrate zero chat threads artifacts list get to api backend ([#12489](https://github.com/vm0-ai/vm0/issues/12489)) ([bf4d50b](https://github.com/vm0-ai/vm0/commit/bf4d50bb44bf29cc8a8f720a9c5e6b4d62c2af95)), closes [#12486](https://github.com/vm0-ai/vm0/issues/12486) [#12488](https://github.com/vm0-ai/vm0/issues/12488)
* **api:** migrate zero chat threads get by id to api backend ([#12487](https://github.com/vm0-ai/vm0/issues/12487)) ([549b84b](https://github.com/vm0-ai/vm0/commit/549b84b92d800475f85524668fe4817c70dded6b)), closes [#12484](https://github.com/vm0-ai/vm0/issues/12484)

## [1.24.0](https://github.com/vm0-ai/vm0/compare/api-v1.23.1...api-v1.24.0) (2026-05-09)


### Features

* **api:** implement zero org members list clerk parity ([#12447](https://github.com/vm0-ai/vm0/issues/12447)) ([19f4888](https://github.com/vm0-ai/vm0/commit/19f4888f517dbf4cb277e0199e6e0242768cd374))
* **api:** port build talker payload to voice-chat session get ([#12470](https://github.com/vm0-ai/vm0/issues/12470)) ([ab189cc](https://github.com/vm0-ai/vm0/commit/ab189ccbc6bfb3de4398e99d00cb02173342dab9)), closes [#12463](https://github.com/vm0-ai/vm0/issues/12463)


### Refactoring

* **api:** migrate agent instructions get ([#12409](https://github.com/vm0-ai/vm0/issues/12409)) ([c0a707b](https://github.com/vm0-ai/vm0/commit/c0a707b1cd2cadf6f08059a3bf8101c905fdf801))
* **api:** migrate agents by id get to api backend ([#12435](https://github.com/vm0-ai/vm0/issues/12435)) ([ccb5cac](https://github.com/vm0-ai/vm0/commit/ccb5cac48c0b8c25b901d1697f0b97cfd47a7bad))
* **api:** migrate agents list get ([#12431](https://github.com/vm0-ai/vm0/issues/12431)) ([e5acde9](https://github.com/vm0-ai/vm0/commit/e5acde91edb589968c450fd9adc46b18027f2b20))
* **api:** migrate composes by id get to api backend ([#12429](https://github.com/vm0-ai/vm0/issues/12429)) ([b061f46](https://github.com/vm0-ai/vm0/commit/b061f464e2d803cd90a19a8a91427a7a6f1933c0)), closes [#12428](https://github.com/vm0-ai/vm0/issues/12428)
* **api:** migrate composes by name get to api backend ([#12427](https://github.com/vm0-ai/vm0/issues/12427)) ([df66047](https://github.com/vm0-ai/vm0/commit/df66047b121c17400efbd57df59dcf39abb555fd))
* **api:** migrate composes list get to api backend ([#12415](https://github.com/vm0-ai/vm0/issues/12415)) ([ea06420](https://github.com/vm0-ai/vm0/commit/ea06420c7ce356d49c1f16fdf178caf64d869ac7))
* **api:** migrate org domains list get to api backend ([#12440](https://github.com/vm0-ai/vm0/issues/12440)) ([2c15a05](https://github.com/vm0-ai/vm0/commit/2c15a05dff7013d186cb774aad93942abc4f73c9)), closes [#12437](https://github.com/vm0-ai/vm0/issues/12437)
* **api:** migrate org get to api backend ([#12449](https://github.com/vm0-ai/vm0/issues/12449)) ([325fe7a](https://github.com/vm0-ai/vm0/commit/325fe7a78cac71e1e4b9d7d7c459659b51ed05c9))
* **api:** migrate org list get to api backend ([#12433](https://github.com/vm0-ai/vm0/issues/12433)) ([9b6d0b0](https://github.com/vm0-ai/vm0/commit/9b6d0b03d334acf78e4654f703b39f290ff13b0a)), closes [#12432](https://github.com/vm0-ai/vm0/issues/12432)
* **api:** migrate org members get to api backend ([#12450](https://github.com/vm0-ai/vm0/issues/12450)) ([724045d](https://github.com/vm0-ai/vm0/commit/724045dc878e6ea647408bc4cdac417f03d19a2d)), closes [#12443](https://github.com/vm0-ai/vm0/issues/12443)
* **api:** migrate run agent events get to api backend ([#12422](https://github.com/vm0-ai/vm0/issues/12422)) ([75f4efa](https://github.com/vm0-ai/vm0/commit/75f4efaca4354a0c57f64e69d47a1b72cee974a2))
* **api:** migrate run context get ([#12420](https://github.com/vm0-ai/vm0/issues/12420)) ([fc9cc36](https://github.com/vm0-ai/vm0/commit/fc9cc367b9fbe67fa17b670353e86c36a267b985))
* **api:** migrate run network logs get to api backend ([#12421](https://github.com/vm0-ai/vm0/issues/12421)) ([f2bd43b](https://github.com/vm0-ai/vm0/commit/f2bd43b86783e625f06b489ac6deb86802b3ed89)), closes [#12417](https://github.com/vm0-ai/vm0/issues/12417)
* **api:** migrate runs get-by-id ([#12414](https://github.com/vm0-ai/vm0/issues/12414)) ([472839e](https://github.com/vm0-ai/vm0/commit/472839e416d1d879eb4d83ffddb691dbb9934b90))
* **api:** migrate runs runner get to api backend ([#12408](https://github.com/vm0-ai/vm0/issues/12408)) ([73e76c8](https://github.com/vm0-ai/vm0/commit/73e76c897412e5724568913abffa724c851d7624))
* **api:** migrate user connectors get ([#12439](https://github.com/vm0-ai/vm0/issues/12439)) ([de02718](https://github.com/vm0-ai/vm0/commit/de027181f14feb883b5eefcc07e7fd2e0c126375))
* **api:** migrate voice chat list tasks get to api backend ([#12464](https://github.com/vm0-ai/vm0/issues/12464)) ([2c8bf7e](https://github.com/vm0-ai/vm0/commit/2c8bf7e020083701d4be11577944f5f489dcac8c)), closes [#12458](https://github.com/vm0-ai/vm0/issues/12458)
* **api:** migrate voice-chat get session get to api backend ([#12460](https://github.com/vm0-ai/vm0/issues/12460)) ([9c9f0d8](https://github.com/vm0-ai/vm0/commit/9c9f0d8b7e34bec3267c327560b52a2b60cae278))
* **api:** migrate voice-chat list-sessions get to api backend ([#12448](https://github.com/vm0-ai/vm0/issues/12448)) ([8be77ab](https://github.com/vm0-ai/vm0/commit/8be77ab96c1712c4babf219e3a33a2cd51104d25))
* **api:** migrate zero chat threads list get to api backend ([#12485](https://github.com/vm0-ai/vm0/issues/12485)) ([64858fa](https://github.com/vm0-ai/vm0/commit/64858fadaaca5780c50fcd3e0e5219e9ebe07b59)), closes [#12482](https://github.com/vm0-ai/vm0/issues/12482)
* **api:** migrate zero connectors by type get to api backend ([#12479](https://github.com/vm0-ai/vm0/issues/12479)) ([f071e6b](https://github.com/vm0-ai/vm0/commit/f071e6b636c248e6fdd7c939db8ef27a24a9463d)), closes [#12476](https://github.com/vm0-ai/vm0/issues/12476)
* **api:** migrate zero connectors computer get to api backend ([#12473](https://github.com/vm0-ai/vm0/issues/12473)) ([442a1a7](https://github.com/vm0-ai/vm0/commit/442a1a768b1f115765fc4bf7d08a3128e534ca3c)), closes [#12471](https://github.com/vm0-ai/vm0/issues/12471)
* **api:** migrate zero connectors list get to api backend ([#12467](https://github.com/vm0-ai/vm0/issues/12467)) ([535e9a7](https://github.com/vm0-ai/vm0/commit/535e9a7baba6a3d93f50f8779a62ce3a7d94ffd5))
* **api:** migrate zero connectors scope diff get to api backend ([#12480](https://github.com/vm0-ai/vm0/issues/12480)) ([52431bb](https://github.com/vm0-ai/vm0/commit/52431bbf9a7391a0cc29f8943137855dee2c6df4))
* **api:** migrate zero connectors search get to api backend ([#12474](https://github.com/vm0-ai/vm0/issues/12474)) ([3ca8039](https://github.com/vm0-ai/vm0/commit/3ca80390be85d1ca0f622d46c931e7f5c9c6b41c))
* **api:** migrate zero logs get by id to api backend ([#12478](https://github.com/vm0-ai/vm0/issues/12478)) ([2328045](https://github.com/vm0-ai/vm0/commit/23280452e5b7f3dc7e264a888d54215bbc51e883)), closes [#12475](https://github.com/vm0-ai/vm0/issues/12475)
* **api:** migrate zero logs list get to api backend ([#12469](https://github.com/vm0-ai/vm0/issues/12469)) ([4f0a3c3](https://github.com/vm0-ai/vm0/commit/4f0a3c36b3a9c64eeb138498289603d587a9714d)), closes [#12465](https://github.com/vm0-ai/vm0/issues/12465)
* **api:** migrate zero logs search get to api backend ([#12483](https://github.com/vm0-ai/vm0/issues/12483)) ([8e21a71](https://github.com/vm0-ai/vm0/commit/8e21a71653e2031050640ca52f1523ef1e368780))
* remove fully-enabled OfficialTelegramBot and ChatManualHistory feature switches ([#12349](https://github.com/vm0-ai/vm0/issues/12349)) ([ed51160](https://github.com/vm0-ai/vm0/commit/ed511603a19ec14a0003fccba66250560c290165))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.6.0
    * @vm0/connectors bumped to 1.1.2
    * @vm0/core bumped to 8.265.2
    * @vm0/db bumped to 1.4.0

## [1.23.1](https://github.com/vm0-ai/vm0/compare/api-v1.23.0...api-v1.23.1) (2026-05-09)


### Refactoring

* **api:** migrate custom-connectors list get to api backend ([#12392](https://github.com/vm0-ai/vm0/issues/12392)) ([076d707](https://github.com/vm0-ai/vm0/commit/076d70721621415ab2bbb8556fc4d6a9f97efe93))
* **api:** migrate model providers list get to api backend ([#12391](https://github.com/vm0-ai/vm0/issues/12391)) ([2bc1348](https://github.com/vm0-ai/vm0/commit/2bc1348546796fda261826db060aadc6a988a294)), closes [#12387](https://github.com/vm0-ai/vm0/issues/12387)
* **api:** migrate runs queue get to api backend ([#12402](https://github.com/vm0-ai/vm0/issues/12402)) ([60df3d2](https://github.com/vm0-ai/vm0/commit/60df3d24a092e9570f5de615cba621a53579b207))
* **api:** migrate schedules list get to api backend ([#12393](https://github.com/vm0-ai/vm0/issues/12393)) ([f9da2eb](https://github.com/vm0-ai/vm0/commit/f9da2eb63fc3b3860396d75c23d38ef740c5bc18)), closes [#12389](https://github.com/vm0-ai/vm0/issues/12389)
* **api:** migrate skill detail get to api backend ([#12401](https://github.com/vm0-ai/vm0/issues/12401)) ([95a2893](https://github.com/vm0-ai/vm0/commit/95a289332ed91629c5f9b8c9a8b9a3b4564d06f7)), closes [#12398](https://github.com/vm0-ai/vm0/issues/12398)
* **api:** migrate skills list get ([#12388](https://github.com/vm0-ai/vm0/issues/12388)) ([f171574](https://github.com/vm0-ai/vm0/commit/f171574f50649eb989c71577f8537573cbd41a55))
* **api:** migrate slack integration status get to api backend ([#12399](https://github.com/vm0-ai/vm0/issues/12399)) ([db594c0](https://github.com/vm0-ai/vm0/commit/db594c0488c1a1c7c509566dd2afdc29699463f5)), closes [#12396](https://github.com/vm0-ai/vm0/issues/12396)
* **api:** migrate variables list get ([#12397](https://github.com/vm0-ai/vm0/issues/12397)) ([3953c2f](https://github.com/vm0-ai/vm0/commit/3953c2f154c140db62b50f0e06a1659825e039d4))

## [1.23.0](https://github.com/vm0-ai/vm0/compare/api-v1.22.1...api-v1.23.0) (2026-05-09)


### Features

* **api:** port official telegram bot logic for parity with web ([#12378](https://github.com/vm0-ai/vm0/issues/12378)) ([a8ce3d7](https://github.com/vm0-ai/vm0/commit/a8ce3d74db51d11ffe43d7dc0a92bad524383046)), closes [#12290](https://github.com/vm0-ai/vm0/issues/12290) [#12370](https://github.com/vm0-ai/vm0/issues/12370)


### Bug Fixes

* **api:** exclude user-revoke ghost rows in visibleChatMessageCondition ([#12372](https://github.com/vm0-ai/vm0/issues/12372)) ([656e2ab](https://github.com/vm0-ai/vm0/commit/656e2ab8a5cacc14cb7c2c1c39d18faa4626b628))


### Refactoring

* **api:** migrate api keys get to api backend ([#12357](https://github.com/vm0-ai/vm0/issues/12357)) ([d967a6c](https://github.com/vm0-ai/vm0/commit/d967a6cb1a9fbfc412deb897786b997e27187bc3)), closes [#12350](https://github.com/vm0-ai/vm0/issues/12350)
* **api:** migrate billing auto-recharge get to api backend ([#12351](https://github.com/vm0-ai/vm0/issues/12351)) ([5686c5c](https://github.com/vm0-ai/vm0/commit/5686c5c2da47a4c71912c59073a8acb11c5effbf))
* **api:** migrate billing invoices get to api backend ([#12363](https://github.com/vm0-ai/vm0/issues/12363)) ([504c11a](https://github.com/vm0-ai/vm0/commit/504c11a585c681e2d5c15bc7504e87538c6f13c3))
* **api:** migrate billing status get to api backend ([#12353](https://github.com/vm0-ai/vm0/issues/12353)) ([351be15](https://github.com/vm0-ai/vm0/commit/351be15fdbb2a54e21c973e72d6b9ee4a59a8008)), closes [#12345](https://github.com/vm0-ai/vm0/issues/12345)
* **api:** migrate computer use host get to api backend ([#12371](https://github.com/vm0-ai/vm0/issues/12371)) ([fe3a421](https://github.com/vm0-ai/vm0/commit/fe3a421e42e0515db80dd87ea09ff7173f81517a)), closes [#12367](https://github.com/vm0-ai/vm0/issues/12367)
* **api:** migrate insights get ([#12369](https://github.com/vm0-ai/vm0/issues/12369)) ([1ed312e](https://github.com/vm0-ai/vm0/commit/1ed312ebda451ebf8528bdc0bf3e17889364fff8))
* **api:** migrate insights range get ([#12376](https://github.com/vm0-ai/vm0/issues/12376)) ([65d16b2](https://github.com/vm0-ai/vm0/commit/65d16b2fbfe230bb85e6e9c73690c8d6a97fe15d))
* **api:** migrate secrets get to api backend ([#12377](https://github.com/vm0-ai/vm0/issues/12377)) ([ce5bf36](https://github.com/vm0-ai/vm0/commit/ce5bf363e103188c3fa5e76935f4e92e89cdbe8f))
* **api:** migrate usage insight get ([#12356](https://github.com/vm0-ai/vm0/issues/12356)) ([3f31844](https://github.com/vm0-ai/vm0/commit/3f31844fdd3e485b813da1f8a52123451eed5047))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.5.1
    * @vm0/core bumped to 8.265.1
    * @vm0/db bumped to 1.3.2

## [1.22.1](https://github.com/vm0-ai/vm0/compare/api-v1.22.0...api-v1.22.1) (2026-05-09)


### Bug Fixes

* add missing id field and remove revoke filter from API thread messages ([#12339](https://github.com/vm0-ai/vm0/issues/12339)) ([26d28f2](https://github.com/vm0-ai/vm0/commit/26d28f224febb19de17741c3900176b37ba53ae1))


### Refactoring

* **api:** migrate feature switches get ([#12335](https://github.com/vm0-ai/vm0/issues/12335)) ([87c69cc](https://github.com/vm0-ai/vm0/commit/87c69cce5490d7a7511359af5642f1d77763da90))
* **api:** migrate team get to api backend ([#12337](https://github.com/vm0-ai/vm0/issues/12337)) ([c065931](https://github.com/vm0-ai/vm0/commit/c065931b5e5cd9cafd7db7ccfa2f5a77ae95ca98))
* **api:** migrate zero queue-position get to api backend ([#12336](https://github.com/vm0-ai/vm0/issues/12336)) ([5e4eee2](https://github.com/vm0-ai/vm0/commit/5e4eee257ea1ce6543379e1d220826cdf99ba4f3)), closes [#12332](https://github.com/vm0-ai/vm0/issues/12332)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.5.0
    * @vm0/core bumped to 8.265.0
    * @vm0/db bumped to 1.3.1

## [1.22.0](https://github.com/vm0-ai/vm0/compare/api-v1.21.4...api-v1.22.0) (2026-05-09)


### Features

* add model-first policy admin controls ([#12180](https://github.com/vm0-ai/vm0/issues/12180)) ([ff5b8c9](https://github.com/vm0-ai/vm0/commit/ff5b8c9b8d5fe06ff0120724f509d5baa873ade2))
* switch zero model pickers to model-first ([#12286](https://github.com/vm0-ai/vm0/issues/12286)) ([4c0dafc](https://github.com/vm0-ai/vm0/commit/4c0dafcfef16f977d9dda8d4ed72c03aa8b310fb))


### Bug Fixes

* **api:** add scopeMismatch/reinstallUrl to Slack shadow response ([#12277](https://github.com/vm0-ai/vm0/issues/12277)) ([61b03e5](https://github.com/vm0-ai/vm0/commit/61b03e5bb28d2bd6d359f76ce05bd4bc43617c14))
* **api:** align connector configured types ([#12306](https://github.com/vm0-ai/vm0/issues/12306)) ([771065b](https://github.com/vm0-ai/vm0/commit/771065bf8678c076e2632de83c0acb456d9d5684))


### Refactoring

* **api:** migrate user preferences get ([#12312](https://github.com/vm0-ai/vm0/issues/12312)) ([baf0445](https://github.com/vm0-ai/vm0/commit/baf0445c9d4305fb696f71564bc647ee96bdf0ff))
* **api:** migrate user preferences post ([#12315](https://github.com/vm0-ai/vm0/issues/12315)) ([c0788c4](https://github.com/vm0-ai/vm0/commit/c0788c45d478503c94adc9c332d8f6dd94f9fdf4))
* migrate voice IO quota GET to api ([#12314](https://github.com/vm0-ai/vm0/issues/12314)) ([985ca34](https://github.com/vm0-ai/vm0/commit/985ca3456f237d8788e6a4fb9f404453ef6e3c82))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.4.0
    * @vm0/connectors bumped to 1.1.1
    * @vm0/core bumped to 8.264.4
    * @vm0/db bumped to 1.3.0

## [1.21.4](https://github.com/vm0-ai/vm0/compare/api-v1.21.3...api-v1.21.4) (2026-05-09)


### Bug Fixes

* refresh connector auth state and catalog ([#12218](https://github.com/vm0-ai/vm0/issues/12218)) ([9cde9c6](https://github.com/vm0-ai/vm0/commit/9cde9c6dd39a3fe2bc266d681ae8c15227a15782))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.3.2
    * @vm0/core bumped to 8.264.3
    * @vm0/db bumped to 1.2.3

## [1.21.3](https://github.com/vm0-ai/vm0/compare/api-v1.21.2...api-v1.21.3) (2026-05-09)


### Bug Fixes

* route api axiom session queries to sessions token ([#12266](https://github.com/vm0-ai/vm0/issues/12266)) ([4de2fce](https://github.com/vm0-ai/vm0/commit/4de2fce52314c259978e1ddb2a8c81baae8d2abf))

## [1.21.2](https://github.com/vm0-ai/vm0/compare/api-v1.21.1...api-v1.21.2) (2026-05-09)


### Bug Fixes

* **api:** add modelProviderType/modelProviderCredentialScope to chat-thread detail ([#12252](https://github.com/vm0-ai/vm0/issues/12252)) ([a15af0e](https://github.com/vm0-ai/vm0/commit/a15af0e569dc16751eb431b675e4153156c9a409))

## [1.21.1](https://github.com/vm0-ai/vm0/compare/api-v1.21.0...api-v1.21.1) (2026-05-09)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.3.1
    * @vm0/core bumped to 8.264.2
    * @vm0/db bumped to 1.2.2

## [1.21.0](https://github.com/vm0-ai/vm0/compare/api-v1.20.2...api-v1.21.0) (2026-05-08)


### Features

* **api:** add attachDatabasePool and env-configurable pool params ([#12239](https://github.com/vm0-ai/vm0/issues/12239)) ([b4f000d](https://github.com/vm0-ai/vm0/commit/b4f000d86f0792dcb09d50c4c2865b2afbb63993))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.3.0
    * @vm0/core bumped to 8.264.1
    * @vm0/db bumped to 1.2.1

## [1.20.2](https://github.com/vm0-ai/vm0/compare/api-v1.20.1...api-v1.20.2) (2026-05-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.264.0

## [1.20.1](https://github.com/vm0-ai/vm0/compare/api-v1.20.0...api-v1.20.1) (2026-05-08)


### Bug Fixes

* **api,web:** sort configuredTypes to eliminate connector shadow divergence ([#12217](https://github.com/vm0-ai/vm0/issues/12217)) ([74d7648](https://github.com/vm0-ai/vm0/commit/74d7648143c9e0e977b9b8abbe36edc0170cddbe))

## [1.20.0](https://github.com/vm0-ai/vm0/compare/api-v1.19.4...api-v1.20.0) (2026-05-08)


### Features

* **voice-chat:** backend transcript ingestion and talker tool dispatch from relay ([#12148](https://github.com/vm0-ai/vm0/issues/12148)) ([978db30](https://github.com/vm0-ai/vm0/commit/978db3048a0a7bc48b6de3785443d37399f17f83))
* **voice-chat:** implement vm0 realtime relay runtime and openai client ([#12150](https://github.com/vm0-ai/vm0/issues/12150)) ([4194a73](https://github.com/vm0-ai/vm0/commit/4194a73ba3175087676c380ee5e1908f3b2c9c1f))


### Bug Fixes

* **api:** strip Clerk user_ prefix from attachment file URLs ([#12163](https://github.com/vm0-ai/vm0/issues/12163)) ([ab23a04](https://github.com/vm0-ai/vm0/commit/ab23a041dd44395496603fcf5e74bf22857c6b51))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.2.0
    * @vm0/core bumped to 8.263.0
    * @vm0/db bumped to 1.2.0

## [1.19.4](https://github.com/vm0-ai/vm0/compare/api-v1.19.3...api-v1.19.4) (2026-05-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.1.0
    * @vm0/connectors bumped to 1.1.0
    * @vm0/core bumped to 8.262.0
    * @vm0/db bumped to 1.1.0

## [1.19.3](https://github.com/vm0-ai/vm0/compare/api-v1.19.2...api-v1.19.3) (2026-05-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.0.2
    * @vm0/core bumped to 8.261.2
    * @vm0/db bumped to 1.0.2

## [1.19.2](https://github.com/vm0-ai/vm0/compare/api-v1.19.1...api-v1.19.2) (2026-05-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.0.1
    * @vm0/core bumped to 8.261.1
    * @vm0/db bumped to 1.0.1

## [1.19.1](https://github.com/vm0-ai/vm0/compare/api-v1.19.0...api-v1.19.1) (2026-05-07)


### Bug Fixes

* **api:** track shared packages in release graph ([#12096](https://github.com/vm0-ai/vm0/issues/12096)) ([20c3751](https://github.com/vm0-ai/vm0/commit/20c375130a5368a95d270722e1d99d5ab1388893))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.0.0
    * @vm0/connectors bumped to 1.0.0
    * @vm0/core bumped to 8.261.0
    * @vm0/db bumped to 1.0.0

## [1.19.0](https://github.com/vm0-ai/vm0/compare/api-v1.18.0...api-v1.19.0) (2026-05-07)


### Features

* **chat:** render queued message as a user bubble with id-based dedup ([#12059](https://github.com/vm0-ai/vm0/issues/12059)) ([1e12849](https://github.com/vm0-ai/vm0/commit/1e12849625116a3bb0839a3a5788b4acac62b699))


### Bug Fixes

* fix two api shadow divergence sources — slack environment and connector timestamps ([#12055](https://github.com/vm0-ai/vm0/issues/12055)) ([17eaf0b](https://github.com/vm0-ai/vm0/commit/17eaf0bfcc4ace52a92034d17f3322cff554b360))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.260.0

## [1.18.0](https://github.com/vm0-ai/vm0/compare/api-v1.17.1...api-v1.18.0) (2026-05-06)


### Features

* add chat thread pending message api ([#11946](https://github.com/vm0-ai/vm0/issues/11946)) ([57717fe](https://github.com/vm0-ai/vm0/commit/57717feece2ba9dc3cf7b48862f56d03f06ced74))


### Bug Fixes

* order pinned threads first in chat thread list API ([#11989](https://github.com/vm0-ai/vm0/issues/11989)) ([14bed95](https://github.com/vm0-ai/vm0/commit/14bed954842a0ccf56b5633e4a6197909e3dfca3))
* use zero agent id for search filters ([#11995](https://github.com/vm0-ai/vm0/issues/11995)) ([3224bd0](https://github.com/vm0-ai/vm0/commit/3224bd05992be321f80f7c74febd5a393dbae6c4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.259.0

## [1.17.1](https://github.com/vm0-ai/vm0/compare/api-v1.17.0...api-v1.17.1) (2026-05-06)


### Bug Fixes

* align zero log agent filters with zero agent ids ([#11964](https://github.com/vm0-ai/vm0/issues/11964)) ([49c5d70](https://github.com/vm0-ai/vm0/commit/49c5d70063fea5ee6852ed3bed41d1bd9b5f0f7d))

## [1.17.0](https://github.com/vm0-ai/vm0/compare/api-v1.16.1...api-v1.17.0) (2026-05-06)


### Features

* **zero:** wire chatgpt-oauth metadata + stale-provider ux ([#11945](https://github.com/vm0-ai/vm0/issues/11945)) ([00da00d](https://github.com/vm0-ai/vm0/commit/00da00dee821515aaba65627f0b9128175797d13))

## [1.16.1](https://github.com/vm0-ai/vm0/compare/api-v1.16.0...api-v1.16.1) (2026-05-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.258.0

## [1.16.0](https://github.com/vm0-ai/vm0/compare/api-v1.15.1...api-v1.16.0) (2026-05-06)


### Features

* **zero:** plumb prefer_personal_provider through agent and schedule contracts ([#11903](https://github.com/vm0-ai/vm0/issues/11903)) ([5f7eff3](https://github.com/vm0-ai/vm0/commit/5f7eff3ec22c62087f57ffeb5d611a12afd5b2fa))


### Bug Fixes

* fill missing fields in API shadow responses ([#11900](https://github.com/vm0-ai/vm0/issues/11900)) ([5e9b034](https://github.com/vm0-ai/vm0/commit/5e9b03491c72363934179312f25b0e7583b48761))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.257.0

## [1.15.1](https://github.com/vm0-ai/vm0/compare/api-v1.15.0...api-v1.15.1) (2026-05-05)


### Bug Fixes

* use EVENT symbol to override top-level source field in Axiom logs ([#11853](https://github.com/vm0-ai/vm0/issues/11853)) ([4e199aa](https://github.com/vm0-ai/vm0/commit/4e199aa35911ae8950939ee44a72905b9acfcc64))

## [1.15.0](https://github.com/vm0-ai/vm0/compare/api-v1.14.8...api-v1.15.0) (2026-05-05)


### Features

* **api:** stream API logs to Axiom web-logs dataset ([#11807](https://github.com/vm0-ai/vm0/issues/11807)) ([5983cab](https://github.com/vm0-ai/vm0/commit/5983cab54210551cab9de486e257a65f529fc567))


### Bug Fixes

* **api:** raise shadow-compare default timeout to 5 minutes ([#11789](https://github.com/vm0-ai/vm0/issues/11789)) ([0811864](https://github.com/vm0-ai/vm0/commit/081186499462667739bd70643effe28b4fd658ec))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.256.0

## [1.14.8](https://github.com/vm0-ai/vm0/compare/api-v1.14.7...api-v1.14.8) (2026-05-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.255.0

## [1.14.7](https://github.com/vm0-ai/vm0/compare/api-v1.14.6...api-v1.14.7) (2026-05-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.254.0

## [1.14.6](https://github.com/vm0-ai/vm0/compare/api-v1.14.5...api-v1.14.6) (2026-05-03)


### Bug Fixes

* **api:** pass null body to fallthrough proxy for null-body upstream statuses ([#11690](https://github.com/vm0-ai/vm0/issues/11690)) ([7b7753f](https://github.com/vm0-ai/vm0/commit/7b7753f0e68138476aa79179b70699cdbd21d16f))

## [1.14.5](https://github.com/vm0-ai/vm0/compare/api-v1.14.4...api-v1.14.5) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.253.0

## [1.14.4](https://github.com/vm0-ai/vm0/compare/api-v1.14.3...api-v1.14.4) (2026-05-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.252.0

## [1.14.3](https://github.com/vm0-ai/vm0/compare/api-v1.14.2...api-v1.14.3) (2026-05-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.251.0

## [1.14.2](https://github.com/vm0-ai/vm0/compare/api-v1.14.1...api-v1.14.2) (2026-05-01)


### Bug Fixes

* remove permissive auth probe default to eliminate shadow mismatches ([#11646](https://github.com/vm0-ai/vm0/issues/11646)) ([3a49158](https://github.com/vm0-ai/vm0/commit/3a491586c1242f81590eadf5a46b2dc5a3d8cbe6))

## [1.14.1](https://github.com/vm0-ai/vm0/compare/api-v1.14.0...api-v1.14.1) (2026-04-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.250.0

## [1.14.0](https://github.com/vm0-ai/vm0/compare/api-v1.13.2...api-v1.14.0) (2026-04-30)


### Features

* **api:** add cors middleware for cross-origin browser access ([#11633](https://github.com/vm0-ai/vm0/issues/11633)) ([ca50728](https://github.com/vm0-ai/vm0/commit/ca50728186ca1d0619d41bf29f357bf62bde1ab3))

## [1.13.2](https://github.com/vm0-ai/vm0/compare/api-v1.13.1...api-v1.13.2) (2026-04-30)


### Refactoring

* **api:** tighten env schema and clean up dead code ([#11621](https://github.com/vm0-ai/vm0/issues/11621)) ([849fe02](https://github.com/vm0-ai/vm0/commit/849fe027474e831d4721c3f3758142f4677a60da))
* remove legacy credit ledger ([#11603](https://github.com/vm0-ai/vm0/issues/11603)) ([dad38a5](https://github.com/vm0-ai/vm0/commit/dad38a5ce28902731fdfe7379e55580a06a93ca3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.249.0

## [1.13.1](https://github.com/vm0-ai/vm0/compare/api-v1.13.0...api-v1.13.1) (2026-04-30)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.248.1

## [1.13.0](https://github.com/vm0-ai/vm0/compare/api-v1.12.2...api-v1.13.0) (2026-04-30)


### Features

* **api:** migrate remaining read routes, services, and mocks to apps/api ([#11565](https://github.com/vm0-ai/vm0/issues/11565)) ([a6a2013](https://github.com/vm0-ai/vm0/commit/a6a20136ed9395ac79c4868a8d64576ad772c1c1))

## [1.12.2](https://github.com/vm0-ai/vm0/compare/api-v1.12.1...api-v1.12.2) (2026-04-30)


### Bug Fixes

* **api:** buffer upstream body in proxyToWeb to prevent ReadableStream loss ([#11572](https://github.com/vm0-ai/vm0/issues/11572)) ([42ddc6a](https://github.com/vm0-ai/vm0/commit/42ddc6a8f12e307cec5ac0291d2180ee43cf81e9))

## [1.12.1](https://github.com/vm0-ai/vm0/compare/api-v1.12.0...api-v1.12.1) (2026-04-29)


### Bug Fixes

* strip forwarded headers from api fallback proxy ([#11557](https://github.com/vm0-ai/vm0/issues/11557)) ([8cbe7df](https://github.com/vm0-ai/vm0/commit/8cbe7dfdcf80fc069b1eb429d834b097b336ca10))


### Refactoring

* **api:** convert route test db helpers to commands ([#11553](https://github.com/vm0-ai/vm0/issues/11553)) ([451ce87](https://github.com/vm0-ai/vm0/commit/451ce87a5695a0c58920c239702da4111d9eba89))

## [1.12.0](https://github.com/vm0-ai/vm0/compare/api-v1.11.2...api-v1.12.0) (2026-04-29)


### Features

* **api:** migrate zero read routes to api ([#11540](https://github.com/vm0-ai/vm0/issues/11540)) ([3105ff0](https://github.com/vm0-ai/vm0/commit/3105ff071ad9110f705d30c2335185cb2877dd14))


### Refactoring

* **api:** convert body validation to computed and drop barrel reexports ([#11543](https://github.com/vm0-ai/vm0/issues/11543)) ([8bbea21](https://github.com/vm0-ai/vm0/commit/8bbea21ca61e43cb9eb6c6d7f8fba7d9eabbf164))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.248.0

## [1.11.2](https://github.com/vm0-ai/vm0/compare/api-v1.11.1...api-v1.11.2) (2026-04-29)


### Bug Fixes

* add min pool connection to api db to eliminate cold-start latency ([#11534](https://github.com/vm0-ai/vm0/issues/11534)) ([c3c6ddb](https://github.com/vm0-ai/vm0/commit/c3c6ddb8e630f6770b8e22ef818cba09d11fa6b7))

## [1.11.1](https://github.com/vm0-ai/vm0/compare/api-v1.11.0...api-v1.11.1) (2026-04-29)


### Bug Fixes

* aggregate model rankings by model name ([#11518](https://github.com/vm0-ai/vm0/issues/11518)) ([a61863a](https://github.com/vm0-ai/vm0/commit/a61863a45b373cc92d78e5281c038594f580a22d))

## [1.11.0](https://github.com/vm0-ai/vm0/compare/api-v1.10.2...api-v1.11.0) (2026-04-29)


### Features

* add api backend shadow migration and migrate read routes ([#11454](https://github.com/vm0-ai/vm0/issues/11454)) ([d45cbef](https://github.com/vm0-ai/vm0/commit/d45cbef58410bf5e7ea8f2c1debbce52ca3f4cb8))


### Bug Fixes

* harden model rankings cron aggregation ([#11485](https://github.com/vm0-ai/vm0/issues/11485)) ([39bc094](https://github.com/vm0-ai/vm0/commit/39bc0948c813a3250a8c3e8990c9ceb665a5f848))

## [1.10.2](https://github.com/vm0-ai/vm0/compare/api-v1.10.1...api-v1.10.2) (2026-04-29)


### Bug Fixes

* **api:** emit pg client spans by wrapping the pool instance ([#11499](https://github.com/vm0-ai/vm0/issues/11499)) ([2ebb619](https://github.com/vm0-ai/vm0/commit/2ebb61963a1c81050ad532629e224ffb8b23be42))
* **api:** include cron definitions in build output ([#11498](https://github.com/vm0-ai/vm0/issues/11498)) ([e5ed066](https://github.com/vm0-ai/vm0/commit/e5ed0669745fb3da9d83b6059afce58a2fcb89a1))

## [1.10.1](https://github.com/vm0-ai/vm0/compare/api-v1.10.0...api-v1.10.1) (2026-04-29)


### Bug Fixes

* **api:** stop @sentry/node from emitting duplicate spans ([#11462](https://github.com/vm0-ai/vm0/issues/11462)) ([5fe6c4f](https://github.com/vm0-ai/vm0/commit/5fe6c4f61686f826a654932614e6f5942cf4f280))

## [1.10.0](https://github.com/vm0-ai/vm0/compare/api-v1.9.0...api-v1.10.0) (2026-04-29)


### Features

* add model usage rankings ([#11464](https://github.com/vm0-ai/vm0/issues/11464)) ([e251a05](https://github.com/vm0-ai/vm0/commit/e251a05dcc738ea7b2ae0c798ef9a47e21978746))

## [1.9.0](https://github.com/vm0-ai/vm0/compare/api-v1.8.1...api-v1.9.0) (2026-04-28)


### Features

* add bb0 device flow ([#11383](https://github.com/vm0-ai/vm0/issues/11383)) ([00871f5](https://github.com/vm0-ai/vm0/commit/00871f521741d5769c0f20e7da9e93de9fbaf91b))

## [1.8.1](https://github.com/vm0-ai/vm0/compare/api-v1.8.0...api-v1.8.1) (2026-04-28)


### Bug Fixes

* thread auth options through shadow probe to eliminate false mismatch ([#11378](https://github.com/vm0-ai/vm0/issues/11378)) ([4c433f2](https://github.com/vm0-ai/vm0/commit/4c433f268530641f23e2b9d62d352bdfc8469519))

## [1.8.0](https://github.com/vm0-ai/vm0/compare/api-v1.7.0...api-v1.8.0) (2026-04-28)


### Features

* add voice transcription api ([#11365](https://github.com/vm0-ai/vm0/issues/11365)) ([4b15bf5](https://github.com/vm0-ai/vm0/commit/4b15bf5e4b75b97180a0c7e0044a7aa1b0f8975d))

## [1.7.0](https://github.com/vm0-ai/vm0/compare/api-v1.6.0...api-v1.7.0) (2026-04-28)


### Features

* add bb0 device onboarding api ([#11340](https://github.com/vm0-ai/vm0/issues/11340)) ([0fc8ebe](https://github.com/vm0-ai/vm0/commit/0fc8ebedfa81ec7cb5b64707635654231604845d))


### Bug Fixes

* evaluate zero token before sandbox capability guard in API auth ([#11349](https://github.com/vm0-ai/vm0/issues/11349)) ([f9c24fd](https://github.com/vm0-ai/vm0/commit/f9c24fdbf50fc0ffae59ee99c48120203384b39d))

## [1.6.0](https://github.com/vm0-ai/vm0/compare/api-v1.5.0...api-v1.6.0) (2026-04-28)


### Features

* **api:** per-route opentelemetry traces routed to axiom ([#11339](https://github.com/vm0-ai/vm0/issues/11339)) ([c4d83ad](https://github.com/vm0-ai/vm0/commit/c4d83adcf10248b765a1fdcb1711877c1b65f391))

## [1.5.0](https://github.com/vm0-ai/vm0/compare/api-v1.4.1...api-v1.5.0) (2026-04-28)


### Features

* **api:** proxy unmatched requests to the web app ([#11308](https://github.com/vm0-ai/vm0/issues/11308)) ([5edb547](https://github.com/vm0-ai/vm0/commit/5edb547217e654556839e1b57fdf6de9c9d03d70))

## [1.4.1](https://github.com/vm0-ai/vm0/compare/api-v1.4.0...api-v1.4.1) (2026-04-28)


### Bug Fixes

* **api:** tighten bearer auth fallthrough and adopt platform's lint rules ([#11294](https://github.com/vm0-ai/vm0/issues/11294)) ([b458bef](https://github.com/vm0-ai/vm0/commit/b458beffb74d9577d686fb9f035ab46b320f22c1))

## [1.4.0](https://github.com/vm0-ai/vm0/compare/api-v1.3.1...api-v1.4.0) (2026-04-28)


### Features

* shadow web /api/v1/chat-threads read routes against new api handlers ([#11278](https://github.com/vm0-ai/vm0/issues/11278)) ([df01cb6](https://github.com/vm0-ai/vm0/commit/df01cb601d221a19a26b44e19d20b337a6e83758))


### Bug Fixes

* **api:** align auth resolution with web app for shadow comparison ([#11271](https://github.com/vm0-ai/vm0/issues/11271)) ([2df9c36](https://github.com/vm0-ai/vm0/commit/2df9c36c126c25da1898e727eb64f6ef5b06169f))

## [1.3.1](https://github.com/vm0-ai/vm0/compare/api-v1.3.0...api-v1.3.1) (2026-04-27)


### Refactoring

* **api:** consolidate auth tests into a single /health/auth probe ([#11233](https://github.com/vm0-ai/vm0/issues/11233)) ([809c5d6](https://github.com/vm0-ai/vm0/commit/809c5d6f2722c8517e5d59b6430367483c6e13fe))

## [1.3.0](https://github.com/vm0-ai/vm0/compare/api-v1.2.1...api-v1.3.0) (2026-04-27)


### Features

* **api:** add auth-route wrapper, lazy-singleton helpers, and lint rules ([#11228](https://github.com/vm0-ai/vm0/issues/11228)) ([d513a3a](https://github.com/vm0-ai/vm0/commit/d513a3a1c81d5c1582e2e40224d0172b6c9f1cda))

## [1.2.1](https://github.com/vm0-ai/vm0/compare/api-v1.2.0...api-v1.2.1) (2026-04-27)


### Refactoring

* **api:** replace routesExtend with keyed handlers in test helpers ([#11168](https://github.com/vm0-ai/vm0/issues/11168)) ([d2be45e](https://github.com/vm0-ai/vm0/commit/d2be45ef884a8df8214df0d10fe077cf9d928114))

## [1.2.0](https://github.com/vm0-ai/vm0/compare/api-v1.1.0...api-v1.2.0) (2026-04-26)


### Features

* **api:** add typed health routes ([#11165](https://github.com/vm0-ai/vm0/issues/11165)) ([4b03280](https://github.com/vm0-ai/vm0/commit/4b032809e451cbdcbc0e7e864ea0c1d152ba1cab))
* **api:** migrate infra auth to hono service ([#11146](https://github.com/vm0-ai/vm0/issues/11146)) ([3e6f32f](https://github.com/vm0-ai/vm0/commit/3e6f32f43c4eab95e51f292bddc99f3f8ccb13dc))


### Bug Fixes

* **api:** add health check endpoint ([#11154](https://github.com/vm0-ai/vm0/issues/11154)) ([c1b9d63](https://github.com/vm0-ai/vm0/commit/c1b9d63ad0ccbf51a885a01fa7a1c5c3909e9ab5))

## [1.1.0](https://github.com/vm0-ai/vm0/compare/api-v1.0.1...api-v1.1.0) (2026-04-26)


### Features

* **api:** add hono tracing and built-in model listing ([#11133](https://github.com/vm0-ai/vm0/issues/11133)) ([0c954d5](https://github.com/vm0-ai/vm0/commit/0c954d5729d36959e7660874e61be80157e64290))

## [1.0.1](https://github.com/vm0-ai/vm0/compare/api-v1.0.0...api-v1.0.1) (2026-04-26)


### Bug Fixes

* **api:** Vercel picks wrong entrypoint, causing FUNCTION_INVOCATION_FAILED ([#11121](https://github.com/vm0-ai/vm0/issues/11121)) ([f340ff2](https://github.com/vm0-ai/vm0/commit/f340ff20ec3376eca0675b205015c313eb9a0bbd))

## 1.0.0 (2026-04-25)


### Features

* add hono api server ([#11095](https://github.com/vm0-ai/vm0/issues/11095)) ([fb18794](https://github.com/vm0-ai/vm0/commit/fb187940811d4e0c47f41964efbec499de3f8bac))


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))
