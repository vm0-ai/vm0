# Changelog

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
