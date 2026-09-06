# Changelog - 2026-08

[Current changelog](../../CHANGELOG.md)

## [0.815.0](https://github.com/vm0-ai/vm0/compare/app-v0.814.2...app-v0.815.0) (2026-08-31)


### Features

* **platform:** add chat event deep links ([#30611](https://github.com/vm0-ai/vm0/issues/30611)) ([bfd41de](https://github.com/vm0-ai/vm0/commit/bfd41def55d0949c70c002f6dad1b51efc36c37b))

## [0.814.2](https://github.com/vm0-ai/vm0/compare/app-v0.814.1...app-v0.814.2) (2026-08-31)


### Refactoring

* remove expired deployment compatibility ([#30648](https://github.com/vm0-ai/vm0/issues/30648)) ([2a664a9](https://github.com/vm0-ai/vm0/commit/2a664a9c7a70b8b956073b3b1588bb3204b970f1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.384.1
    * @okouai/core bumped to 8.605.4

## [0.814.1](https://github.com/vm0-ai/vm0/compare/app-v0.814.0...app-v0.814.1) (2026-08-31)


### Refactoring

* **app:** own client version per runtime ([#30618](https://github.com/vm0-ai/vm0/issues/30618)) ([1c5ddee](https://github.com/vm0-ai/vm0/commit/1c5ddee15bb11d6a2f3c3cbcb099c8b4a2b74798))
* remove legacy morning brief pipeline ([#30438](https://github.com/vm0-ai/vm0/issues/30438)) ([9c59bfe](https://github.com/vm0-ai/vm0/commit/9c59bfe9ad3575244584924c1408839e8aa5d500))


### Performance Improvements

* **platform:** overlap clerk and onboarding bootstrap ([#30442](https://github.com/vm0-ai/vm0/issues/30442)) ([dd211f3](https://github.com/vm0-ai/vm0/commit/dd211f372d5824ff3e7aa86057f11e42fe57f79a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.384.0
    * @okouai/core bumped to 8.605.3

## [0.814.0](https://github.com/vm0-ai/vm0/compare/app-v0.813.5...app-v0.814.0) (2026-08-31)


### Features

* **codex:** preserve thread item semantics ([#30579](https://github.com/vm0-ai/vm0/issues/30579)) ([31b1be9](https://github.com/vm0-ai/vm0/commit/31b1be9fd870504252b4277e3480442170963426))
* **platform:** share indicators through shared worker ([#30339](https://github.com/vm0-ai/vm0/issues/30339)) ([5d900dc](https://github.com/vm0-ai/vm0/commit/5d900dc601daa8c6ac27f8926dfaa604bb6e8583))


### Bug Fixes

* **chat-search:** avoid thread deletion lock contention ([#30453](https://github.com/vm0-ai/vm0/issues/30453)) ([b5676e7](https://github.com/vm0-ai/vm0/commit/b5676e768129c4bc63bdbba59c05e434a771b336))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.383.0
    * @okouai/core bumped to 8.605.2

## [0.813.5](https://github.com/vm0-ai/vm0/compare/app-v0.813.4...app-v0.813.5) (2026-08-31)


### Bug Fixes

* **app:** open billing plans from upgrade card ([#30575](https://github.com/vm0-ai/vm0/issues/30575)) ([d68b213](https://github.com/vm0-ai/vm0/commit/d68b2136a94f5a65b44cce35b55b476a8c72a09e))


### Refactoring

* **platform:** retire locale asset fallback ([#30521](https://github.com/vm0-ai/vm0/issues/30521)) ([594e795](https://github.com/vm0-ai/vm0/commit/594e795908d8e54359fcad41d4efbeaed0b8952d))


### Performance Improvements

* **platform:** start Clerk before font loading ([#30588](https://github.com/vm0-ai/vm0/issues/30588)) ([d4f968f](https://github.com/vm0-ai/vm0/commit/d4f968f9777c730805a5fea4089abd7354dc3c65))

## [0.813.4](https://github.com/vm0-ai/vm0/compare/app-v0.813.3...app-v0.813.4) (2026-08-31)


### Bug Fixes

* continue chat with current model ([#30520](https://github.com/vm0-ai/vm0/issues/30520)) ([0850f78](https://github.com/vm0-ai/vm0/commit/0850f7833d24fc393c05065f7f9877d5f1a5d1a7))
* **platform:** route chat realtime through user-org channels ([#30358](https://github.com/vm0-ai/vm0/issues/30358)) ([5cd95cf](https://github.com/vm0-ai/vm0/commit/5cd95cfbd3c7ebe2dd207135de80dc0b5cbe913e))
* **platform:** route locked video templates to plans ([#30567](https://github.com/vm0-ai/vm0/issues/30567)) ([ddc223a](https://github.com/vm0-ai/vm0/commit/ddc223ac07b00cc3e76b3ee1f1c1d7af87eccb20))
* **platform:** stop connector account pagination at the last page ([#30580](https://github.com/vm0-ai/vm0/issues/30580)) ([d511bc3](https://github.com/vm0-ai/vm0/commit/d511bc3c43574ce2f5e25a3291e4a14e3d93e633))


### Performance Improvements

* **platform:** render skeleton before app startup ([#30484](https://github.com/vm0-ai/vm0/issues/30484)) ([fcf8fc4](https://github.com/vm0-ai/vm0/commit/fcf8fc4e0a03e1e27fd015ad76dfe682c00503aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.382.0
    * @okouai/connectors bumped to 3.1.0
    * @okouai/core bumped to 8.605.1

## [0.813.3](https://github.com/vm0-ai/vm0/compare/app-v0.813.2...app-v0.813.3) (2026-08-31)


### Bug Fixes

* **platform:** prevent deleted template resurrection ([#29722](https://github.com/vm0-ai/vm0/issues/29722)) ([94ea6ce](https://github.com/vm0-ai/vm0/commit/94ea6ce117d6b633d6912b9d40fb6c53d67095ef))


### Refactoring

* **auth:** remove Clerk hosted UI runtime ([#30499](https://github.com/vm0-ai/vm0/issues/30499)) ([c987893](https://github.com/vm0-ai/vm0/commit/c98789371d841762e73c9d1e0442b06c7f9ceb2c))
* **connectors:** enable the direct okou oauth callback for the slack connector ([#30555](https://github.com/vm0-ai/vm0/issues/30555)) ([6e45142](https://github.com/vm0-ai/vm0/commit/6e45142a9f4f7471348b886efba5655f8c8420fc)), closes [#30550](https://github.com/vm0-ai/vm0/issues/30550)


### Performance Improvements

* **app:** decouple build metadata from javascript hashes ([#30436](https://github.com/vm0-ai/vm0/issues/30436)) ([eb5ca9f](https://github.com/vm0-ai/vm0/commit/eb5ca9ffd557817a66a47296301bacd1dac1be39))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.16
    * @okouai/connectors bumped to 3.0.2
    * @okouai/core bumped to 8.605.0

## [0.813.2](https://github.com/vm0-ai/vm0/compare/app-v0.813.1...app-v0.813.2) (2026-08-31)


### Performance Improvements

* **platform:** remove server contracts from startup graph ([#30444](https://github.com/vm0-ai/vm0/issues/30444)) ([e9aff31](https://github.com/vm0-ai/vm0/commit/e9aff312223e62e4e451eb68b61864687e08b007))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.15
    * @okouai/core bumped to 8.604.1

## [0.813.1](https://github.com/vm0-ai/vm0/compare/app-v0.813.0...app-v0.813.1) (2026-08-31)


### Refactoring

* **auth:** fully roll out auth v2 ([#30406](https://github.com/vm0-ai/vm0/issues/30406)) ([9509186](https://github.com/vm0-ai/vm0/commit/950918630f56ba9019dfc32893dd29e8f5bd5797))


### Performance Improvements

* **platform:** load Google Fonts from document head ([#30449](https://github.com/vm0-ai/vm0/issues/30449)) ([882445c](https://github.com/vm0-ai/vm0/commit/882445c0008c52f284db0885cc1ed8e34ff60ea8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.14
    * @okouai/connectors bumped to 3.0.1
    * @okouai/core bumped to 8.604.0

## [0.813.0](https://github.com/vm0-ai/vm0/compare/app-v0.812.6...app-v0.813.0) (2026-08-31)


### Features

* **platform:** add intro video visual balance ([#30399](https://github.com/vm0-ai/vm0/issues/30399)) ([adf2b69](https://github.com/vm0-ai/vm0/commit/adf2b693c71a29714269e78ca6608c1f1a7e6141))


### Bug Fixes

* **chat:** offer recovery for unsupported codex models ([#30420](https://github.com/vm0-ai/vm0/issues/30420)) ([2aab056](https://github.com/vm0-ai/vm0/commit/2aab056fbdb9eb1c48238a8f1a75dd5d97066182))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.13
    * @okouai/core bumped to 8.603.6

## [0.812.6](https://github.com/vm0-ai/vm0/compare/app-v0.812.5...app-v0.812.6) (2026-08-31)


### Refactoring

* remove teams integration feature switch ([#30383](https://github.com/vm0-ai/vm0/issues/30383)) ([21bfe91](https://github.com/vm0-ai/vm0/commit/21bfe915ee1183d2267b62c36fb90773f54192a5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.603.5

## [0.812.5](https://github.com/vm0-ai/vm0/compare/app-v0.812.4...app-v0.812.5) (2026-08-31)


### Bug Fixes

* **platform:** derive thinking indicator from chat events ([#30357](https://github.com/vm0-ai/vm0/issues/30357)) ([19fe4f5](https://github.com/vm0-ai/vm0/commit/19fe4f529e23558401e59fb898d895144e1959c5))

## [0.812.4](https://github.com/vm0-ai/vm0/compare/app-v0.812.3...app-v0.812.4) (2026-08-30)


### Refactoring

* remove expired deployment compatibility ([#30366](https://github.com/vm0-ai/vm0/issues/30366)) ([ec658a5](https://github.com/vm0-ai/vm0/commit/ec658a548883f28e75126106528e53c7241a1ade))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.12
    * @okouai/core bumped to 8.603.4

## [0.812.3](https://github.com/vm0-ai/vm0/compare/app-v0.812.2...app-v0.812.3) (2026-08-30)


### Bug Fixes

* **platform:** align pinned agent shortcuts with sidebar navigation ([#30338](https://github.com/vm0-ai/vm0/issues/30338)) ([81834c3](https://github.com/vm0-ai/vm0/commit/81834c35a51d4ce5920946acdd3712d4c8c9a21d))


### Refactoring

* clear app and connector lint warnings ([#30350](https://github.com/vm0-ai/vm0/issues/30350)) ([36e363e](https://github.com/vm0-ai/vm0/commit/36e363e2bd57c38ba82c541cb80e17c568551364))
* remove shared chat database feature switch ([#30272](https://github.com/vm0-ai/vm0/issues/30272)) ([2210065](https://github.com/vm0-ai/vm0/commit/221006596f337e8d50882a3c427b2cdd56619d87))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.11
    * @okouai/connectors bumped to 1.210.8
    * @okouai/core bumped to 8.603.3

## [0.812.2](https://github.com/vm0-ai/vm0/compare/app-v0.812.1...app-v0.812.2) (2026-08-30)


### Refactoring

* **platform:** remove markdown preview dependency ([#30330](https://github.com/vm0-ai/vm0/issues/30330)) ([ff2be93](https://github.com/vm0-ai/vm0/commit/ff2be93200242e4ab6b58cc673bac1853c84cc82))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.10
    * @okouai/core bumped to 8.603.2

## [0.812.1](https://github.com/vm0-ai/vm0/compare/app-v0.812.0...app-v0.812.1) (2026-08-30)


### Refactoring

* detach chat event cursors from projection ([#30280](https://github.com/vm0-ai/vm0/issues/30280)) ([4af0bb3](https://github.com/vm0-ai/vm0/commit/4af0bb302f2365e03543e7423b6fc7368f392650))
* route recording progress through setLoop ([#30328](https://github.com/vm0-ai/vm0/issues/30328)) ([812d999](https://github.com/vm0-ai/vm0/commit/812d999884231f83a95149191e936e1d864b8c46))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.9
    * @okouai/core bumped to 8.603.1

## [0.812.0](https://github.com/vm0-ai/vm0/compare/app-v0.811.0...app-v0.812.0) (2026-08-30)


### Features

* **platform:** add intro video creation flow ([#30177](https://github.com/vm0-ai/vm0/issues/30177)) ([0907ea3](https://github.com/vm0-ai/vm0/commit/0907ea3f326c0c1bdb42e34a6c0faa2664c134f4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.603.0

## [0.811.0](https://github.com/vm0-ai/vm0/compare/app-v0.810.3...app-v0.811.0) (2026-08-30)


### Features

* roll out chat forwarding to all users ([#29575](https://github.com/vm0-ai/vm0/issues/29575)) ([312e629](https://github.com/vm0-ai/vm0/commit/312e62966b4454b266a192c347727b3904a72dba))


### Refactoring

* retire legacy morning brief runtime ([#30267](https://github.com/vm0-ai/vm0/issues/30267)) ([f71e821](https://github.com/vm0-ai/vm0/commit/f71e821906627a3e7198eb8a395d2e2825b0e748))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.8
    * @okouai/core bumped to 8.602.0

## [0.810.3](https://github.com/vm0-ai/vm0/compare/app-v0.810.2...app-v0.810.3) (2026-08-30)


### Bug Fixes

* **platform:** recover shared database authentication ([#30265](https://github.com/vm0-ai/vm0/issues/30265)) ([02dea69](https://github.com/vm0-ai/vm0/commit/02dea690f43867a6b743808e51022018f2f78471))


### Refactoring

* **platform:** remove mermaid lazy loading ([#30268](https://github.com/vm0-ai/vm0/issues/30268)) ([87cb9bd](https://github.com/vm0-ai/vm0/commit/87cb9bd559365a5c8c9e753bfcee3d1bd0dba673))

## [0.810.2](https://github.com/vm0-ai/vm0/compare/app-v0.810.1...app-v0.810.2) (2026-08-30)


### Bug Fixes

* **platform:** stop the shared database worker from reading page globals ([#30263](https://github.com/vm0-ai/vm0/issues/30263)) ([2f2113e](https://github.com/vm0-ai/vm0/commit/2f2113e26e8420ded0d1ff8f91395be2d6ac26e3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.7
    * @okouai/core bumped to 8.601.8

## [0.810.1](https://github.com/vm0-ai/vm0/compare/app-v0.810.0...app-v0.810.1) (2026-08-29)


### Refactoring

* **platform:** unify markdown and editor dependencies ([#30234](https://github.com/vm0-ai/vm0/issues/30234)) ([0b12df5](https://github.com/vm0-ai/vm0/commit/0b12df587c290e371c36f16d3dd9091d5ec2992b))
* remove expired deployment compatibility ([#30262](https://github.com/vm0-ai/vm0/issues/30262)) ([e119d89](https://github.com/vm0-ai/vm0/commit/e119d898bc4926e8c67c54c1fa9fcf1f016b24fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.6
    * @okouai/core bumped to 8.601.7

## [0.810.0](https://github.com/vm0-ai/vm0/compare/app-v0.809.3...app-v0.810.0) (2026-08-29)


### Features

* isolate shared worker realtime by organization ([#30224](https://github.com/vm0-ai/vm0/issues/30224)) ([0283235](https://github.com/vm0-ai/vm0/commit/0283235bd5b730de3e7fd601b75b46a294f3cd14))


### Refactoring

* **platform:** select clerk bootstrap config in browser ([#30232](https://github.com/vm0-ai/vm0/issues/30232)) ([7b89569](https://github.com/vm0-ai/vm0/commit/7b89569f9eb24be4e35b4f8e09d504d66fa99558))


### Performance Improvements

* **platform:** use default production minification ([#30228](https://github.com/vm0-ai/vm0/issues/30228)) ([9491e71](https://github.com/vm0-ai/vm0/commit/9491e7196f3f6dee16c93adeb856e5705253aa8e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.5
    * @okouai/core bumped to 8.601.6

## [0.809.3](https://github.com/vm0-ai/vm0/compare/app-v0.809.2...app-v0.809.3) (2026-08-29)


### Bug Fixes

* **platform:** align clerk ui release set ([#30223](https://github.com/vm0-ai/vm0/issues/30223)) ([52c7bb5](https://github.com/vm0-ai/vm0/commit/52c7bb52145e3b83161b6dc6b361c3697000fe75))


### Refactoring

* remove chat event version fallbacks ([#30226](https://github.com/vm0-ai/vm0/issues/30226)) ([713e58e](https://github.com/vm0-ai/vm0/commit/713e58e581c660f73f836511118cecef551d6d29))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.4
    * @okouai/core bumped to 8.601.5

## [0.809.2](https://github.com/vm0-ai/vm0/compare/app-v0.809.1...app-v0.809.2) (2026-08-29)


### Performance Improvements

* **platform:** declare clerk core in initial html ([#30211](https://github.com/vm0-ai/vm0/issues/30211)) ([cca1a34](https://github.com/vm0-ai/vm0/commit/cca1a3497bb8210c86a0a05abea588ac9242931a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.3
    * @okouai/core bumped to 8.601.4

## [0.809.1](https://github.com/vm0-ai/vm0/compare/app-v0.809.0...app-v0.809.1) (2026-08-29)


### Bug Fixes

* **platform:** navigate on push notification click ([#30213](https://github.com/vm0-ai/vm0/issues/30213)) ([8f64daa](https://github.com/vm0-ai/vm0/commit/8f64daaceb57530641af457a222a7125de8b2ab1))


### Refactoring

* remove chat tool activity ([#30215](https://github.com/vm0-ai/vm0/issues/30215)) ([c475f9e](https://github.com/vm0-ai/vm0/commit/c475f9e59935ec292acd8b35ceb66e1f59708866))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.2
    * @okouai/core bumped to 8.601.3

## [0.809.0](https://github.com/vm0-ai/vm0/compare/app-v0.808.3...app-v0.809.0) (2026-08-29)


### Features

* **platform:** use flowchart-only mermaid build ([#30170](https://github.com/vm0-ai/vm0/issues/30170)) ([683db88](https://github.com/vm0-ai/vm0/commit/683db889dd2d31920c6294df75b7904be6db7747))


### Bug Fixes

* **app:** serve immutable bundles from r2 ([#30185](https://github.com/vm0-ai/vm0/issues/30185)) ([7d7188a](https://github.com/vm0-ai/vm0/commit/7d7188ab84a1a01344deb6e9e56e93e1bfe1cd89))
* **platform:** pin bootstrap skeleton to initial viewport ([#30176](https://github.com/vm0-ai/vm0/issues/30176)) ([0a2d76a](https://github.com/vm0-ai/vm0/commit/0a2d76a09c1d1f18dd4aa4494e480ae8f5c570a3))


### Refactoring

* remove expired deployment compatibility ([#30187](https://github.com/vm0-ai/vm0/issues/30187)) ([a9910df](https://github.com/vm0-ai/vm0/commit/a9910df72430a95969da7914975cd0b2d6d5fd9a))


### Performance Improvements

* **platform:** trim vendors and ship one app bundle ([#30175](https://github.com/vm0-ai/vm0/issues/30175)) ([48d88b9](https://github.com/vm0-ai/vm0/commit/48d88b92e7ffdf98de82e57c5681506da891986a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.1
    * @okouai/connectors bumped to 1.210.7
    * @okouai/core bumped to 8.601.2
    * @okouai/ui bumped to 1.0.2

## [0.808.3](https://github.com/vm0-ai/vm0/compare/app-v0.808.2...app-v0.808.3) (2026-08-28)


### Bug Fixes

* **platform:** recover shared database worker transport ([#30140](https://github.com/vm0-ai/vm0/issues/30140)) ([cad77b0](https://github.com/vm0-ai/vm0/commit/cad77b0a69d6c054d8f6bca0588c88a2aace0a48))


### Refactoring

* remove introVideoTemplates feature switch ([#30158](https://github.com/vm0-ai/vm0/issues/30158)) ([5797b76](https://github.com/vm0-ai/vm0/commit/5797b76de0daad39916c79d72714b043da8cb03b))


### Performance Improvements

* **platform:** bound stable chunk graph traversal ([#30168](https://github.com/vm0-ai/vm0/issues/30168)) ([98dc764](https://github.com/vm0-ai/vm0/commit/98dc76471a1614b0bc60d1226adaed89d019d67d))
* **platform:** lazy-load rich message content ([#30100](https://github.com/vm0-ai/vm0/issues/30100)) ([96d5ad9](https://github.com/vm0-ai/vm0/commit/96d5ad9364b49d09223407cd50754015913c6cb9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.381.0
    * @okouai/core bumped to 8.601.1

## [0.808.2](https://github.com/vm0-ai/vm0/compare/app-v0.808.1...app-v0.808.2) (2026-08-28)


### Bug Fixes

* **platform:** prevent mobile input focus zoom ([#30159](https://github.com/vm0-ai/vm0/issues/30159)) ([aae87e4](https://github.com/vm0-ai/vm0/commit/aae87e417fd77ced9a24ea0917fe8250222948fd))

## [0.808.1](https://github.com/vm0-ai/vm0/compare/app-v0.808.0...app-v0.808.1) (2026-08-28)


### Bug Fixes

* **platform:** anchor bootstrap skeleton to visible viewport ([#30156](https://github.com/vm0-ai/vm0/issues/30156)) ([1c738e9](https://github.com/vm0-ai/vm0/commit/1c738e9e2aa611616dbd947243e9ab8f8f1b2404))
* **platform:** clarify chat model scope ([#30127](https://github.com/vm0-ai/vm0/issues/30127)) ([da26576](https://github.com/vm0-ai/vm0/commit/da265761edfd2d0c29ee3da7bd45cba0622c46d3))

## [0.808.0](https://github.com/vm0-ai/vm0/compare/app-v0.807.1...app-v0.808.0) (2026-08-28)


### Features

* add official workflow product surface ([#29996](https://github.com/vm0-ai/vm0/issues/29996)) ([71ff589](https://github.com/vm0-ai/vm0/commit/71ff589c65d4f6852f331243472e9d1002418a02))
* **platform:** improve shared conversation handoff ([#29752](https://github.com/vm0-ai/vm0/issues/29752)) ([c60c27d](https://github.com/vm0-ai/vm0/commit/c60c27d452cf7679abc220f68c7590faecc04672))


### Bug Fixes

* **auth:** preserve resend cooldown and accessibility ([#30084](https://github.com/vm0-ai/vm0/issues/30084)) ([7504b64](https://github.com/vm0-ai/vm0/commit/7504b64fcccbc975a0ca207432efbb1b25e3b1d9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.380.0
    * @okouai/core bumped to 8.601.0

## [0.807.1](https://github.com/vm0-ai/vm0/compare/app-v0.807.0...app-v0.807.1) (2026-08-28)


### Bug Fixes

* **platform:** persist appearance preferences ([#30051](https://github.com/vm0-ai/vm0/issues/30051)) ([21d2954](https://github.com/vm0-ai/vm0/commit/21d2954bebb4336546670465bcee7796959f5cad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.379.1
    * @okouai/connectors bumped to 1.210.6
    * @okouai/core bumped to 8.600.1

## [0.807.0](https://github.com/vm0-ai/vm0/compare/app-v0.806.1...app-v0.807.0) (2026-08-28)


### Features

* **auth:** add custom add-account rollout ([#29901](https://github.com/vm0-ai/vm0/issues/29901)) ([895b70c](https://github.com/vm0-ai/vm0/commit/895b70cc33b936090afc7c86a4c71bf82a591324))


### Bug Fixes

* **platform:** reserve growth entry space before loading ([#30014](https://github.com/vm0-ai/vm0/issues/30014)) ([a50d82f](https://github.com/vm0-ai/vm0/commit/a50d82f03c320ec7034c0408a211902745191f39))


### Performance Improvements

* **platform:** add skeleton duration to bootstrap phases ([#30017](https://github.com/vm0-ai/vm0/issues/30017)) ([8e9d333](https://github.com/vm0-ai/vm0/commit/8e9d333effada141917385e0482bcc35fd419fab))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.379.0
    * @okouai/core bumped to 8.600.0

## [0.806.1](https://github.com/vm0-ai/vm0/compare/app-v0.806.0...app-v0.806.1) (2026-08-28)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.378.1
    * @okouai/core bumped to 8.599.5

## [0.806.0](https://github.com/vm0-ai/vm0/compare/app-v0.805.3...app-v0.806.0) (2026-08-28)


### Features

* migrate chat event snapshots to v7 ([#29950](https://github.com/vm0-ai/vm0/issues/29950)) ([6746a51](https://github.com/vm0-ai/vm0/commit/6746a519009477e95d6ed6e3d3cab093d19db04e))


### Bug Fixes

* **platform:** clarify connector account and agent summaries ([#29883](https://github.com/vm0-ai/vm0/issues/29883)) ([d690729](https://github.com/vm0-ai/vm0/commit/d690729f348a79b6d1b117a656a6b4c9d0a8c161))


### Refactoring

* **db:** canonicalize built-in provider writes ([#29938](https://github.com/vm0-ai/vm0/issues/29938)) ([aad55f4](https://github.com/vm0-ai/vm0/commit/aad55f424b8a4b72c2b06e25335e06de53e10c7a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.378.0
    * @okouai/core bumped to 8.599.4

## [0.805.3](https://github.com/vm0-ai/vm0/compare/app-v0.805.2...app-v0.805.3) (2026-08-27)


### Refactoring

* remove three column nav feature switch ([#29900](https://github.com/vm0-ai/vm0/issues/29900)) ([b6f4b4b](https://github.com/vm0-ai/vm0/commit/b6f4b4b5b0117ba4f86f6428f04ecd4440639b61))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.599.3

## [0.805.2](https://github.com/vm0-ai/vm0/compare/app-v0.805.1...app-v0.805.2) (2026-08-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.377.1
    * @okouai/core bumped to 8.599.2

## [0.805.1](https://github.com/vm0-ai/vm0/compare/app-v0.805.0...app-v0.805.1) (2026-08-27)


### Bug Fixes

* **auth:** remove focus ring from error alerts ([#29878](https://github.com/vm0-ai/vm0/issues/29878)) ([da3369e](https://github.com/vm0-ai/vm0/commit/da3369e0933e807c3c5fc04b75af08430e01bedd))
* **platform:** prevent stale page renders during navigation ([#29829](https://github.com/vm0-ai/vm0/issues/29829)) ([6e2af35](https://github.com/vm0-ai/vm0/commit/6e2af353876e6f06e0bc1d6e5aa715ceece443d5))


### Refactoring

* remove connector discovery feature switch ([#29885](https://github.com/vm0-ai/vm0/issues/29885)) ([011fcf8](https://github.com/vm0-ai/vm0/commit/011fcf8feaf50b34fa3e9d6c391e6c0a9cb4e3be))


### Performance Improvements

* **platform:** stabilize lazy chunk loading across deploys ([#29738](https://github.com/vm0-ai/vm0/issues/29738)) ([70a459a](https://github.com/vm0-ai/vm0/commit/70a459ae1b191bc520589692416bbe9e9fee65a7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.377.0
    * @okouai/core bumped to 8.599.1

## [0.805.0](https://github.com/vm0-ai/vm0/compare/app-v0.804.5...app-v0.805.0) (2026-08-27)


### Features

* **platform:** redesign the not-found page ([#29850](https://github.com/vm0-ai/vm0/issues/29850)) ([62babba](https://github.com/vm0-ai/vm0/commit/62babbae1d1630a8ff9de85371bb9298f4abe6b3))


### Bug Fixes

* **platform:** hide create workspace after limit reached ([#29841](https://github.com/vm0-ai/vm0/issues/29841)) ([72b37b4](https://github.com/vm0-ai/vm0/commit/72b37b48f06ada9e8c7ef18470924d7aea3db5d5))


### Performance Improvements

* **platform:** trim eager clerk localization and posthog code ([#29750](https://github.com/vm0-ai/vm0/issues/29750)) ([6b16c7e](https://github.com/vm0-ai/vm0/commit/6b16c7eb565482598ca9c2f6f9a98271e960448c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.376.3
    * @okouai/connectors bumped to 1.210.5
    * @okouai/core bumped to 8.599.0

## [0.804.5](https://github.com/vm0-ai/vm0/compare/app-v0.804.4...app-v0.804.5) (2026-08-27)


### Bug Fixes

* **platform:** clarify color theme navigation hierarchy ([#29724](https://github.com/vm0-ai/vm0/issues/29724)) ([70b7b4f](https://github.com/vm0-ai/vm0/commit/70b7b4fa877b5d17c340d1d91392dd35251b59a1))


### Performance Improvements

* **platform:** enable name-preserving identifier mangling ([#29728](https://github.com/vm0-ai/vm0/issues/29728)) ([2ce53ca](https://github.com/vm0-ai/vm0/commit/2ce53ca93f3140e5a61339b7061c8a43d668ec28))

## [0.804.4](https://github.com/vm0-ai/vm0/compare/app-v0.804.3...app-v0.804.4) (2026-08-27)


### Bug Fixes

* **platform:** release template rename focus on submit ([#29833](https://github.com/vm0-ai/vm0/issues/29833)) ([6733e19](https://github.com/vm0-ai/vm0/commit/6733e19df77385b6a4ff324bc206f7b6a1a524a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.376.2
    * @okouai/core bumped to 8.598.2

## [0.804.3](https://github.com/vm0-ai/vm0/compare/app-v0.804.2...app-v0.804.3) (2026-08-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.376.1
    * @okouai/core bumped to 8.598.1

## [0.804.2](https://github.com/vm0-ai/vm0/compare/app-v0.804.1...app-v0.804.2) (2026-08-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.376.0
    * @okouai/core bumped to 8.598.0

## [0.804.1](https://github.com/vm0-ai/vm0/compare/app-v0.804.0...app-v0.804.1) (2026-08-27)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.597.0

## [0.804.0](https://github.com/vm0-ai/vm0/compare/app-v0.803.4...app-v0.804.0) (2026-08-27)


### Features

* **platform:** add usage pack configuration action ([#29747](https://github.com/vm0-ai/vm0/issues/29747)) ([6074c9b](https://github.com/vm0-ai/vm0/commit/6074c9b69b84bb0385601ee22a3a90ddb0e6bd3b))
* **platform:** give intro-video templates their own picker category ([#29718](https://github.com/vm0-ai/vm0/issues/29718)) ([6476f2a](https://github.com/vm0-ai/vm0/commit/6476f2adb887bd3b60457a426edb000e09270e60))


### Bug Fixes

* **auth:** align clerk page action styling ([#29730](https://github.com/vm0-ai/vm0/issues/29730)) ([a6a6b4e](https://github.com/vm0-ai/vm0/commit/a6a6b4e251eb1d61be8605ddb6138aa99f21700f))
* **auth:** harden Clerk identity and signup attribution ([#29732](https://github.com/vm0-ai/vm0/issues/29732)) ([13c15e9](https://github.com/vm0-ai/vm0/commit/13c15e9089c8a8aa7dd3001db3f78ab51cd90fe6)), closes [#29711](https://github.com/vm0-ai/vm0/issues/29711)
* **auth:** restore v2 login parity ([#29734](https://github.com/vm0-ai/vm0/issues/29734)) ([bde9a4d](https://github.com/vm0-ai/vm0/commit/bde9a4d912c198382fe1eaa13a162e0c3fd8bdbf))
* **platform:** clear stale agent after onboarding ([#29726](https://github.com/vm0-ai/vm0/issues/29726)) ([376758f](https://github.com/vm0-ai/vm0/commit/376758fe5d16e54b8aecf380818c2bc0ee13c474))
* **platform:** fit the annotated image and keep the marks on the draft ([#29702](https://github.com/vm0-ai/vm0/issues/29702)) ([7bb820c](https://github.com/vm0-ai/vm0/commit/7bb820c5fbe47607cb216e57a495a870c98861d5))
* **platform:** place account action before permissions ([#29725](https://github.com/vm0-ai/vm0/issues/29725)) ([dd4b659](https://github.com/vm0-ai/vm0/commit/dd4b6595a88206f49f85073dc91990dde0dd5ae4))
* **platform:** prevent growth entry layout shift ([#29723](https://github.com/vm0-ai/vm0/issues/29723)) ([af45f6d](https://github.com/vm0-ai/vm0/commit/af45f6dff6f48f88e3e2ef0b68d64c419f80ea5f))
* **platform:** update initial document title once ([#29737](https://github.com/vm0-ai/vm0/issues/29737)) ([9a0a6cf](https://github.com/vm0-ai/vm0/commit/9a0a6cf813f85f977d615d9f6043170e91990c5f))
* remove legacy sign-in fallback from auth v2 ([#29735](https://github.com/vm0-ai/vm0/issues/29735)) ([fe7a110](https://github.com/vm0-ai/vm0/commit/fe7a110f9169e0587a97ca7f9d3c05f9c88d1c7d))


### Refactoring

* remove composerFlatFeedbackNote feature switch ([#29721](https://github.com/vm0-ai/vm0/issues/29721)) ([897515d](https://github.com/vm0-ai/vm0/commit/897515d2e90822674b61d3a65074afc3f36c7496))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.375.2
    * @okouai/core bumped to 8.596.2

## [0.803.4](https://github.com/vm0-ai/vm0/compare/app-v0.803.3...app-v0.803.4) (2026-08-27)


### Bug Fixes

* align permission controls across scrollbar gutter ([#29675](https://github.com/vm0-ai/vm0/issues/29675)) ([e94cd19](https://github.com/vm0-ai/vm0/commit/e94cd19ae112db48a783d8154b7fd0d88cbfef99))
* **platform:** use chat terminology for account selector ([#29686](https://github.com/vm0-ai/vm0/issues/29686)) ([7435737](https://github.com/vm0-ai/vm0/commit/74357375c1f9e95db3fb07e855e42f9f6d1733ef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.375.1
    * @okouai/core bumped to 8.596.1

## [0.803.3](https://github.com/vm0-ai/vm0/compare/app-v0.803.2...app-v0.803.3) (2026-08-27)


### Refactoring

* **platform:** use the agents list endpoint ([#29695](https://github.com/vm0-ai/vm0/issues/29695)) ([38a9a44](https://github.com/vm0-ai/vm0/commit/38a9a44b8fd694e5d1b875b47992547804f0b6a9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.375.0
    * @okouai/core bumped to 8.596.0

## [0.803.2](https://github.com/vm0-ai/vm0/compare/app-v0.803.1...app-v0.803.2) (2026-08-26)


### Performance Improvements

* **platform:** render agent chat before team validation ([#29691](https://github.com/vm0-ai/vm0/issues/29691)) ([9ecbdba](https://github.com/vm0-ai/vm0/commit/9ecbdba24c6613145d9bae6d6a7c94177c2a70b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.374.2
    * @okouai/core bumped to 8.595.7

## [0.803.1](https://github.com/vm0-ai/vm0/compare/app-v0.803.0...app-v0.803.1) (2026-08-26)


### Bug Fixes

* **platform:** keep cold start on one skeleton ([#29661](https://github.com/vm0-ai/vm0/issues/29661)) ([05c482c](https://github.com/vm0-ai/vm0/commit/05c482c4930e3209cd5853bbcef50205eee28983))


### Refactoring

* dual-accept built-in provider discriminator ([#29681](https://github.com/vm0-ai/vm0/issues/29681)) ([9a6d224](https://github.com/vm0-ai/vm0/commit/9a6d2247e14012fd5ba987bc44d1b6b11fb7bda1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.374.1
    * @okouai/connectors bumped to 1.210.4
    * @okouai/core bumped to 8.595.6

## [0.803.0](https://github.com/vm0-ai/vm0/compare/app-v0.802.0...app-v0.803.0) (2026-08-26)


### Features

* **activity:** display persisted runner attribution ([#29640](https://github.com/vm0-ai/vm0/issues/29640)) ([9006f5f](https://github.com/vm0-ai/vm0/commit/9006f5fde43f6563d1d0cfc7914319a287536a85))

## [0.802.0](https://github.com/vm0-ai/vm0/compare/app-v0.801.1...app-v0.802.0) (2026-08-26)


### Features

* **cli:** list connector accounts ([#29634](https://github.com/vm0-ai/vm0/issues/29634)) ([867a92f](https://github.com/vm0-ai/vm0/commit/867a92f821ebdae8558f2ccbba5bd342d3707089))


### Bug Fixes

* separate requested and granted oauth scopes ([#29509](https://github.com/vm0-ai/vm0/issues/29509)) ([8f2c584](https://github.com/vm0-ai/vm0/commit/8f2c58413029090974c908de8595d1fda55af74d))


### Performance Improvements

* **platform:** lazy-load selected locale resources ([#29597](https://github.com/vm0-ai/vm0/issues/29597)) ([52cf4b9](https://github.com/vm0-ai/vm0/commit/52cf4b9418620d13537f30dd5017d5b34e4c89d5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.374.0
    * @okouai/connectors bumped to 1.210.3
    * @okouai/core bumped to 8.595.5

## [0.801.1](https://github.com/vm0-ai/vm0/compare/app-v0.801.0...app-v0.801.1) (2026-08-26)


### Performance Improvements

* **platform:** shorten chat thread metadata readiness ([#29598](https://github.com/vm0-ai/vm0/issues/29598)) ([b4f7387](https://github.com/vm0-ai/vm0/commit/b4f7387f421aa7ba485f97451e7629986e698b85))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.373.1
    * @okouai/core bumped to 8.595.4

## [0.801.0](https://github.com/vm0-ai/vm0/compare/app-v0.800.2...app-v0.801.0) (2026-08-26)


### Features

* **platform:** search workflows and artifacts from spotlight ([#29580](https://github.com/vm0-ai/vm0/issues/29580)) ([2f71dbf](https://github.com/vm0-ai/vm0/commit/2f71dbf326daf4727d66cd2f3ef44ce679cd85da))


### Performance Improvements

* **platform:** add bootstrap phase telemetry ([#29583](https://github.com/vm0-ai/vm0/issues/29583)) ([1b3afc3](https://github.com/vm0-ai/vm0/commit/1b3afc3b5f1882461f1d2154cddce8ca57209b5e))
* **platform:** avoid serialized home agent validation ([#29599](https://github.com/vm0-ai/vm0/issues/29599)) ([8c5719c](https://github.com/vm0-ai/vm0/commit/8c5719c271c6274406c0e93de804c96b5e703ae2))
* **platform:** defer marketing scripts until first content ([#29581](https://github.com/vm0-ai/vm0/issues/29581)) ([3ce0ab4](https://github.com/vm0-ai/vm0/commit/3ce0ab480ea0844f221c27d3c9a75b80d233143b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.373.0
    * @okouai/core bumped to 8.595.3

## [0.800.2](https://github.com/vm0-ai/vm0/compare/app-v0.800.1...app-v0.800.2) (2026-08-26)


### Bug Fixes

* **auth:** restore identity edit button sizing ([#29552](https://github.com/vm0-ai/vm0/issues/29552)) ([40fc587](https://github.com/vm0-ai/vm0/commit/40fc5872d9404be553625f3a4077de93d9a0f645))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.372.0
    * @okouai/core bumped to 8.595.2

## [0.800.1](https://github.com/vm0-ai/vm0/compare/app-v0.800.0...app-v0.800.1) (2026-08-26)


### Refactoring

* remove home growth entry feature switch ([#29579](https://github.com/vm0-ai/vm0/issues/29579)) ([a6e7c72](https://github.com/vm0-ai/vm0/commit/a6e7c72715914cfe0bb4a4e780eac3c0c0285d47))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.595.1

## [0.800.0](https://github.com/vm0-ai/vm0/compare/app-v0.799.4...app-v0.800.0) (2026-08-26)


### Features

* add gradient color themes ([#29449](https://github.com/vm0-ai/vm0/issues/29449)) ([5ce77fb](https://github.com/vm0-ai/vm0/commit/5ce77fbbd64f2bf6ebf991587aab295f2a67155e))


### Bug Fixes

* **auth:** remove heading focus ring ([#29550](https://github.com/vm0-ai/vm0/issues/29550)) ([bff5e44](https://github.com/vm0-ai/vm0/commit/bff5e444a121069a37a31d5195c7bf7dcf3bfd0a))
* **billing:** read concurrency price from stripe ([#29359](https://github.com/vm0-ai/vm0/issues/29359)) ([aac0e75](https://github.com/vm0-ai/vm0/commit/aac0e7537423f201225b8960839e6e0e8b33d4d6))
* **platform:** add missing icon tooltips ([#29556](https://github.com/vm0-ai/vm0/issues/29556)) ([bddc882](https://github.com/vm0-ai/vm0/commit/bddc8827d4ef8a0feaa12cc73cc105eabf6b1f7f))
* **platform:** stabilize connector row alignment ([#29584](https://github.com/vm0-ai/vm0/issues/29584)) ([309a88b](https://github.com/vm0-ai/vm0/commit/309a88bbbd610b051355a58dc22b20484bae5db0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.371.0
    * @okouai/core bumped to 8.595.0
    * @okouai/ui bumped to 1.0.1

## [0.799.4](https://github.com/vm0-ai/vm0/compare/app-v0.799.3...app-v0.799.4) (2026-08-26)


### Bug Fixes

* **auth:** align Clerk passkey action styling ([#29549](https://github.com/vm0-ai/vm0/issues/29549)) ([66e28c4](https://github.com/vm0-ai/vm0/commit/66e28c4874286b75a43919bdcb1b006a9f35c1f3))
* **auth:** reuse alert for field errors ([#29548](https://github.com/vm0-ai/vm0/issues/29548)) ([2119a9b](https://github.com/vm0-ai/vm0/commit/2119a9b8cd0f5dd07017fe7746bd764ef7adafe6))
* drop the model picker's fixed dropdown height cap ([#29533](https://github.com/vm0-ai/vm0/issues/29533)) ([6247a94](https://github.com/vm0-ai/vm0/commit/6247a94ef585d0ed57512dca00af6da9c99a952d))
* **platform:** clarify forward target choices ([#29539](https://github.com/vm0-ai/vm0/issues/29539)) ([f85cfe1](https://github.com/vm0-ai/vm0/commit/f85cfe19e3691ee7094290e07ad87303be8d162c))
* **platform:** keep pin dialog open after updates ([#29561](https://github.com/vm0-ai/vm0/issues/29561)) ([a9f721f](https://github.com/vm0-ai/vm0/commit/a9f721f4dad80d405aadfb78901e297502798e3d))
* **platform:** label three-column works nav as channels ([#29535](https://github.com/vm0-ai/vm0/issues/29535)) ([1cc80d5](https://github.com/vm0-ai/vm0/commit/1cc80d503445e1bb2e77f88d6bb1beebf5f624da))
* **platform:** prevent pinned agent drags from opening split view ([#29559](https://github.com/vm0-ai/vm0/issues/29559)) ([897a6ef](https://github.com/vm0-ai/vm0/commit/897a6ef9464d81479a8989295498ef3c1b8e2547))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.370.0
    * @okouai/core bumped to 8.594.4
    * @okouai/ui bumped to 1.0.0

## [0.799.3](https://github.com/vm0-ai/vm0/compare/app-v0.799.2...app-v0.799.3) (2026-08-26)


### Bug Fixes

* **platform:** keep connector row height stable ([#29502](https://github.com/vm0-ai/vm0/issues/29502)) ([e67a40c](https://github.com/vm0-ai/vm0/commit/e67a40c22f7e4a0df671fe315aba00e4bfdac2a3))
* **platform:** keep thread account selection in a menu ([#29526](https://github.com/vm0-ai/vm0/issues/29526)) ([f3b0840](https://github.com/vm0-ai/vm0/commit/f3b0840afc628c01cae5c81a260f7a0b0355b3f7))
* **platform:** preview the real shape while drawing and widen the keyboard ([#29505](https://github.com/vm0-ai/vm0/issues/29505)) ([ae7fef8](https://github.com/vm0-ai/vm0/commit/ae7fef885b83f59c9c974dbf4d07b5db5934cef1))
* **platform:** share uploaded template resources ([#29506](https://github.com/vm0-ai/vm0/issues/29506)) ([1ec4a25](https://github.com/vm0-ai/vm0/commit/1ec4a250ac4aa5a33a302f65863da2c421cb3d8d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.369.0
    * @okouai/core bumped to 8.594.3

## [0.799.2](https://github.com/vm0-ai/vm0/compare/app-v0.799.1...app-v0.799.2) (2026-08-26)


### Bug Fixes

* wrap long imported template names instead of clipping them ([#29458](https://github.com/vm0-ai/vm0/issues/29458)) ([e36cf3c](https://github.com/vm0-ai/vm0/commit/e36cf3c3aac2aa0344e1fa1c9fd76a8ade4e5355))

## [0.799.1](https://github.com/vm0-ai/vm0/compare/app-v0.799.0...app-v0.799.1) (2026-08-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.368.2
    * @okouai/connectors bumped to 1.210.2
    * @okouai/core bumped to 8.594.2

## [0.799.0](https://github.com/vm0-ai/vm0/compare/app-v0.798.0...app-v0.799.0) (2026-08-26)


### Features

* **onboarding:** open product templates directly ([#29431](https://github.com/vm0-ai/vm0/issues/29431)) ([ba25155](https://github.com/vm0-ai/vm0/commit/ba25155074c853890ef2f9a822bfaef9eb2df81c))


### Bug Fixes

* improve three-column sidebar usability ([#29448](https://github.com/vm0-ai/vm0/issues/29448)) ([8194a3b](https://github.com/vm0-ai/vm0/commit/8194a3b6e94588c1dae2f2f21889fd6b31819273))
* **platform:** isolate connector popover row actions ([#29460](https://github.com/vm0-ai/vm0/issues/29460)) ([84264e3](https://github.com/vm0-ai/vm0/commit/84264e3e708f6187692577ed7825694850dc57c6))
* **platform:** preview effective connector account names ([#29477](https://github.com/vm0-ai/vm0/issues/29477)) ([4b0c630](https://github.com/vm0-ai/vm0/commit/4b0c63079a943e675a4517235f533a64ce9470d7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.368.1
    * @okouai/core bumped to 8.594.1

## [0.798.0](https://github.com/vm0-ai/vm0/compare/app-v0.797.0...app-v0.798.0) (2026-08-26)


### Features

* **platform:** edit annotation marks directly and drop the modal tools ([#29453](https://github.com/vm0-ai/vm0/issues/29453)) ([cd65c4a](https://github.com/vm0-ai/vm0/commit/cd65c4ad2322126cee65ecfcad84246c7a2dfab3))


### Bug Fixes

* **platform:** unify dialog corner radius ([#29432](https://github.com/vm0-ai/vm0/issues/29432)) ([8837247](https://github.com/vm0-ai/vm0/commit/88372474837072be7b1be00c02d866c47a35e4f8))


### Refactoring

* remove the media model selection feature switches ([#29430](https://github.com/vm0-ai/vm0/issues/29430)) ([1b11e08](https://github.com/vm0-ai/vm0/commit/1b11e08edcc2a07cac7698c6bdded314ec77901e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.594.0

## [0.797.0](https://github.com/vm0-ai/vm0/compare/app-v0.796.2...app-v0.797.0) (2026-08-26)


### Features

* **chat:** make tool activity copy lifecycle-aware ([#29434](https://github.com/vm0-ai/vm0/issues/29434)) ([bec654e](https://github.com/vm0-ai/vm0/commit/bec654e4597cbbe2b4a1776cd9fc439a19e66489))
* scaffold intro-video templates ([#29370](https://github.com/vm0-ai/vm0/issues/29370)) ([8c5da7c](https://github.com/vm0-ai/vm0/commit/8c5da7c4ca03434810c4d401e1b6f11a9cac305e))


### Bug Fixes

* keep the deck import message to the request itself ([#29441](https://github.com/vm0-ai/vm0/issues/29441)) ([c60e01b](https://github.com/vm0-ai/vm0/commit/c60e01bc7a5bdbf1dd5bed0812ba3ed51b02aad3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.368.0
    * @okouai/core bumped to 8.593.0

## [0.796.2](https://github.com/vm0-ai/vm0/compare/app-v0.796.1...app-v0.796.2) (2026-08-26)


### Bug Fixes

* **auth:** restore accessible brand action colors ([#29410](https://github.com/vm0-ai/vm0/issues/29410)) ([139e91e](https://github.com/vm0-ai/vm0/commit/139e91e6c56936849c7da98a53761d45d80fd560))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.592.1

## [0.796.1](https://github.com/vm0-ai/vm0/compare/app-v0.796.0...app-v0.796.1) (2026-08-26)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.592.0

## [0.796.0](https://github.com/vm0-ai/vm0/compare/app-v0.795.1...app-v0.796.0) (2026-08-25)


### Features

* add per-thread connector account picker ([#29337](https://github.com/vm0-ai/vm0/issues/29337)) ([8434768](https://github.com/vm0-ai/vm0/commit/843476856beade4376249579dac0ce96d2df1dc5))
* render tool activity in the chat timeline ([#29388](https://github.com/vm0-ai/vm0/issues/29388)) ([8081ab7](https://github.com/vm0-ai/vm0/commit/8081ab7590a584ef394347a884b31fa254def2c7))


### Bug Fixes

* **auth:** match device verification notice ([#29391](https://github.com/vm0-ai/vm0/issues/29391)) ([958a8ef](https://github.com/vm0-ai/vm0/commit/958a8ef14998930f4c3da3dbdffde5071fbab767))


### Refactoring

* remove expired deployment compatibility ([#29405](https://github.com/vm0-ai/vm0/issues/29405)) ([d86c760](https://github.com/vm0-ai/vm0/commit/d86c760015662e5272734aa0e0172836be75c1b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.367.0
    * @okouai/connectors bumped to 1.210.1
    * @okouai/core bumped to 8.591.1

## [0.795.1](https://github.com/vm0-ai/vm0/compare/app-v0.795.0...app-v0.795.1) (2026-08-25)


### Bug Fixes

* **auth:** match auth v2 visual hierarchy ([#29346](https://github.com/vm0-ai/vm0/issues/29346)) ([80700b1](https://github.com/vm0-ai/vm0/commit/80700b179404d79316eaa8cfd4a71abcca63c76b))

## [0.795.0](https://github.com/vm0-ai/vm0/compare/app-v0.794.2...app-v0.795.0) (2026-08-25)


### Features

* add output tool transport foundation ([#29361](https://github.com/vm0-ai/vm0/issues/29361)) ([0820224](https://github.com/vm0-ai/vm0/commit/0820224394881c0a76d2376bcbff728061b0dd55))
* **onboarding:** add slack entry card ([#29263](https://github.com/vm0-ai/vm0/issues/29263)) ([345ea87](https://github.com/vm0-ai/vm0/commit/345ea87a70a0049001828ce37214211e6efb2783))
* **platform:** show only the title on imported deck tiles ([#29348](https://github.com/vm0-ai/vm0/issues/29348)) ([83be786](https://github.com/vm0-ai/vm0/commit/83be78698a15cea7e6e483564f3ae01a9d6d8b79))
* **platform:** state template visibility as a sentence with a change popover ([#29334](https://github.com/vm0-ai/vm0/issues/29334)) ([5f734a5](https://github.com/vm0-ai/vm0/commit/5f734a56928a6781617c71a7e6969fee3c3278ee))


### Bug Fixes

* **auth:** handle clerk device trust in auth v2 ([#29194](https://github.com/vm0-ai/vm0/issues/29194)) ([2fe2b71](https://github.com/vm0-ai/vm0/commit/2fe2b71922ed66954e6ac7197488848d77477b70))
* **composer:** keep the flat note chrome stable while typing ([#29354](https://github.com/vm0-ai/vm0/issues/29354)) ([a69df64](https://github.com/vm0-ai/vm0/commit/a69df6423f296837d547e8fa811520fca4865e19))
* keep uploaded template images visible while refreshing ([#29308](https://github.com/vm0-ai/vm0/issues/29308)) ([959a8c9](https://github.com/vm0-ai/vm0/commit/959a8c932573954cdeb5d905717eb0d33fd35942))
* **platform:** show marks in the viewer and edit notes on the image ([#29331](https://github.com/vm0-ai/vm0/issues/29331)) ([e32196e](https://github.com/vm0-ai/vm0/commit/e32196e45d554e9133fc886b34ea36dcedac7e17))


### Refactoring

* remove usage pack plans feature switch ([#29349](https://github.com/vm0-ai/vm0/issues/29349)) ([eb8a72a](https://github.com/vm0-ai/vm0/commit/eb8a72a5ae960eb4e2ff70c2c15e45e2c351b6b8))


### Performance Improvements

* **connectors:** debounce account search requests ([#29307](https://github.com/vm0-ai/vm0/issues/29307)) ([ce3ba01](https://github.com/vm0-ai/vm0/commit/ce3ba013c741b1f3e8e260b2ef49d5f09fdb8616))
* resize uploaded template previews ([#29330](https://github.com/vm0-ai/vm0/issues/29330)) ([4fc670c](https://github.com/vm0-ai/vm0/commit/4fc670c0af68f3513ba1e426cf194b7ddd667ebf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.366.0
    * @okouai/core bumped to 8.591.0

## [0.794.2](https://github.com/vm0-ai/vm0/compare/app-v0.794.1...app-v0.794.2) (2026-08-25)


### Refactoring

* **api-contracts:** drop the vm0 prefix from the built-in model route types ([#29319](https://github.com/vm0-ai/vm0/issues/29319)) ([796aba5](https://github.com/vm0-ai/vm0/commit/796aba530c66cc5ea5aa24afc832c463f2d428f8)), closes [#29314](https://github.com/vm0-ai/vm0/issues/29314)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.365.0
    * @okouai/core bumped to 8.590.3

## [0.794.1](https://github.com/vm0-ai/vm0/compare/app-v0.794.0...app-v0.794.1) (2026-08-25)


### Bug Fixes

* **auth:** improve v2 action contrast ([#29267](https://github.com/vm0-ai/vm0/issues/29267)) ([fe7a5f8](https://github.com/vm0-ai/vm0/commit/fe7a5f8f8e58102885a4f61acc959fe8378c7ed9))
* **auth:** preserve v2 sign-up switch context ([#29262](https://github.com/vm0-ai/vm0/issues/29262)) ([b4e79f8](https://github.com/vm0-ai/vm0/commit/b4e79f88b9999d304aaa85c1883657fb09173b9c))
* **connectors:** keep default accounts visible in manager ([#29282](https://github.com/vm0-ai/vm0/issues/29282)) ([2887b08](https://github.com/vm0-ai/vm0/commit/2887b0846676a0b47f3e4378cee54ef61ec0ee91))


### Refactoring

* **platform:** migrate auth v2 timers to signal ownership ([#29303](https://github.com/vm0-ai/vm0/issues/29303)) ([1d48084](https://github.com/vm0-ai/vm0/commit/1d480843a89810a181e9285b79722aa446c6925b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.590.2

## [0.794.0](https://github.com/vm0-ai/vm0/compare/app-v0.793.0...app-v0.794.0) (2026-08-25)


### Features

* **ads:** add adsmarch website conversions ([#29187](https://github.com/vm0-ai/vm0/issues/29187)) ([1fa2bf6](https://github.com/vm0-ai/vm0/commit/1fa2bf61489d3eda7238239210d93c60cbfd8898))


### Bug Fixes

* **auth:** associate sign-in field errors with alerts ([#29247](https://github.com/vm0-ai/vm0/issues/29247)) ([9797644](https://github.com/vm0-ai/vm0/commit/97976444543d8f4c865a2bae04441cc26ad1e62c)), closes [#28927](https://github.com/vm0-ai/vm0/issues/28927)
* **auth:** derive pristine sign-up fields from Clerk config ([#29246](https://github.com/vm0-ai/vm0/issues/29246)) ([a1d21d1](https://github.com/vm0-ai/vm0/commit/a1d21d178bcffc198400b1d23b77bfbf77197dbe))
* **auth:** localize remaining Auth v2 copy ([#29251](https://github.com/vm0-ai/vm0/issues/29251)) ([d07931c](https://github.com/vm0-ai/vm0/commit/d07931ce3c525631376b095a66a03e590ec63ab8)), closes [#28927](https://github.com/vm0-ai/vm0/issues/28927)
* **connectors:** polish account manager hierarchy ([#29196](https://github.com/vm0-ai/vm0/issues/29196)) ([a01ab25](https://github.com/vm0-ai/vm0/commit/a01ab2510ff000ed6ed336e0f4aeb5b19ea58285))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.364.0
    * @okouai/core bumped to 8.590.1

## [0.793.0](https://github.com/vm0-ai/vm0/compare/app-v0.792.0...app-v0.793.0) (2026-08-25)


### Features

* accept legacy .ppt decks in template import ([#28870](https://github.com/vm0-ai/vm0/issues/28870)) ([f3cd82c](https://github.com/vm0-ai/vm0/commit/f3cd82c62633caa58f018aa6ee3cc68ab9a7349f))
* add auth v2 organization continuation ([#29110](https://github.com/vm0-ai/vm0/issues/29110)) ([9c62e8c](https://github.com/vm0-ai/vm0/commit/9c62e8c601dddf1e17a28a20447310f746b72a6b))
* add flux.2 pro and ideogram 4 ([#28640](https://github.com/vm0-ai/vm0/issues/28640)) ([7022170](https://github.com/vm0-ai/vm0/commit/7022170536a28805f6cbcb7e625e84755552b898))
* add qwen image 3 and nano banana 2 lite built-in image models ([#28518](https://github.com/vm0-ai/vm0/issues/28518)) ([9691fc3](https://github.com/vm0-ai/vm0/commit/9691fc30b999724efd07d2d82c384c47ff59c150))
* **agentphone:** decouple provider identity from public brand ([#28953](https://github.com/vm0-ai/vm0/issues/28953)) ([e7fcd06](https://github.com/vm0-ai/vm0/commit/e7fcd06ba2647f55d8a83e7e94be2ed066b74a97))
* annotate an attached image in the composer ([#28976](https://github.com/vm0-ai/vm0/issues/28976)) ([19096b6](https://github.com/vm0-ai/vm0/commit/19096b6c2ef65e8d885cbadbf0f6f7cc81ef4508))
* **api:** add managed model fallback resolver ([#28301](https://github.com/vm0-ai/vm0/issues/28301)) ([745a08f](https://github.com/vm0-ai/vm0/commit/745a08fa51b6b0b51208fae1a02ec599664be115))
* **auth:** add advanced v2 sign-in strategies ([#29090](https://github.com/vm0-ai/vm0/issues/29090)) ([c59a376](https://github.com/vm0-ai/vm0/commit/c59a3768f3d1267ca03549f380705781e589f128))
* **auth:** add auth v2 navigation context ([#28999](https://github.com/vm0-ai/vm0/issues/28999)) ([8cfed8c](https://github.com/vm0-ai/vm0/commit/8cfed8cd93cde210d039b37c3b293fd11029f5be))
* **auth:** add privacy-safe v2 diagnostics ([#29131](https://github.com/vm0-ai/vm0/issues/29131)) ([4be6f12](https://github.com/vm0-ai/vm0/commit/4be6f1284f3369404cd9be7b466d96f8ae1fd0e7))
* **auth:** add v2 google sign-up ([#29109](https://github.com/vm0-ai/vm0/issues/29109)) ([e3682a7](https://github.com/vm0-ai/vm0/commit/e3682a7a1832c7dd82b265b7aaeb782d43375dc0))
* **auth:** add v2 sign-in flow ([#29035](https://github.com/vm0-ai/vm0/issues/29035)) ([5cdeba4](https://github.com/vm0-ai/vm0/commit/5cdeba4b32757db052f7a63aa1582b2b38726ffa))
* **auth:** add v2 sign-up flow ([#29096](https://github.com/vm0-ai/vm0/issues/29096)) ([627bf97](https://github.com/vm0-ai/vm0/commit/627bf970c44ae77a221f50ceaa3dae208583b1a8))
* **auth:** complete auth v2 sign-in ux parity ([#29141](https://github.com/vm0-ai/vm0/issues/29141)) ([10fbb8e](https://github.com/vm0-ai/vm0/commit/10fbb8ea6b69d90f09d0b0a71042a088a87c3d7c))
* **auth:** refine v2 presentation shell ([#28993](https://github.com/vm0-ai/vm0/issues/28993)) ([c9b2e6f](https://github.com/vm0-ai/vm0/commit/c9b2e6ff28254cc5e952c5e22345f3dd75015048))
* **auth:** scaffold versioned authentication routes ([#28950](https://github.com/vm0-ai/vm0/issues/28950)) ([2d3a789](https://github.com/vm0-ai/vm0/commit/2d3a789095f63f44886788dfe9fdfb2bf9c3d227))
* **banking:** add chat-based mastercard connect flow ([#28832](https://github.com/vm0-ai/vm0/issues/28832)) ([faf1021](https://github.com/vm0-ai/vm0/commit/faf10210ffc1a956a1c3f077e3410bcc27ae4cb8))
* **composer:** offer one model per family in the media pickers ([#28510](https://github.com/vm0-ai/vm0/issues/28510)) ([3389b85](https://github.com/vm0-ai/vm0/commit/3389b85bbb3916d38a71661227ccfc1d02662e75))
* **core:** roll out usage pack plans ([#28771](https://github.com/vm0-ai/vm0/issues/28771)) ([f83844e](https://github.com/vm0-ai/vm0/commit/f83844e5aaafee2c8ad6c2f8048c90483a144fa2))
* **feishu:** preserve host-derived public branding ([#28935](https://github.com/vm0-ai/vm0/issues/28935)) ([bbb60c7](https://github.com/vm0-ai/vm0/commit/bbb60c70fb46dcc1ca6a15694de0770edba98c95))
* **host:** prepare okou public domains ([#28359](https://github.com/vm0-ai/vm0/issues/28359)) ([853415c](https://github.com/vm0-ai/vm0/commit/853415cbe56481d6e2c44c8cbd73ee50c6064902))
* let staff cancel built-in model cooldowns ([#29142](https://github.com/vm0-ai/vm0/issues/29142)) ([d0ab9d6](https://github.com/vm0-ai/vm0/commit/d0ab9d6c8534491a06878c9d705f726e440cb4c5)), closes [#29121](https://github.com/vm0-ai/vm0/issues/29121)
* **onboarding:** refresh oauth workflow templates ([#28371](https://github.com/vm0-ai/vm0/issues/28371)) ([1b42df2](https://github.com/vm0-ai/vm0/commit/1b42df2a8b21728e74a365fc22143031440342db))
* **platform:** add multi-account connector settings ([#28904](https://github.com/vm0-ai/vm0/issues/28904)) ([e8d0c2a](https://github.com/vm0-ai/vm0/commit/e8d0c2acb679ccd23b218a694aaf1a6893f97791))
* **platform:** collapse connector catalog diagnostics ([#28722](https://github.com/vm0-ai/vm0/issues/28722)) ([ae8ea3e](https://github.com/vm0-ai/vm0/commit/ae8ea3e3ae743af607374bd8168f0e65651cc2b5))
* **platform:** import a deck as a presentation template from the picker ([#28344](https://github.com/vm0-ai/vm0/issues/28344)) ([e7efc60](https://github.com/vm0-ai/vm0/commit/e7efc606a87a71da3e81eeabf62710af8f0617e7))
* **platform:** list the user's imported decks in the presentation picker ([#28533](https://github.com/vm0-ai/vm0/issues/28533)) ([e1901a6](https://github.com/vm0-ai/vm0/commit/e1901a6025ef826071a8d21851133536e37263c4))
* **platform:** offer nano banana 2 lite and price tiers for media models ([#28674](https://github.com/vm0-ai/vm0/issues/28674)) ([dc7962c](https://github.com/vm0-ai/vm0/commit/dc7962c9c51e8e74cab94eb39af89ab31e68fd4b))
* **platform:** rebalance the pro and team plan highlight lists ([#28540](https://github.com/vm0-ai/vm0/issues/28540)) ([de72f0c](https://github.com/vm0-ai/vm0/commit/de72f0c0208fe1a1d0ec48695434f1dbc43d357c))
* **platform:** rebuild the chat search dialog on shared components ([#28376](https://github.com/vm0-ai/vm0/issues/28376)) ([0b4b819](https://github.com/vm0-ai/vm0/commit/0b4b819b556df06b61035bc684508f11bd092ce3))
* **platform:** show managed model cooldown diagnostics ([#28733](https://github.com/vm0-ai/vm0/issues/28733)) ([f86c836](https://github.com/vm0-ai/vm0/commit/f86c836c2f5275ca97b288a757a3d5e118ca0566))
* **platform:** state the plan value props on plan selection ([#28322](https://github.com/vm0-ai/vm0/issues/28322)) ([7caf8ba](https://github.com/vm0-ai/vm0/commit/7caf8ba117fa2a61c98fc8581a816fffb5d1209a))
* **platform:** turn the home invite button into a growth entry ([#28439](https://github.com/vm0-ai/vm0/issues/28439)) ([632fbb9](https://github.com/vm0-ai/vm0/commit/632fbb9f12b7886dafa5860c778245742e4ad689))
* point runs at the deck reverse-engineering guide ([#28362](https://github.com/vm0-ai/vm0/issues/28362)) ([8022cb6](https://github.com/vm0-ai/vm0/commit/8022cb61be52befefacfd44e1d758bd1a54f7584))
* pull presentation reverse-template from r2 ([#29043](https://github.com/vm0-ai/vm0/issues/29043)) ([5da72eb](https://github.com/vm0-ai/vm0/commit/5da72eb706544d50731cab880c4d006979b63afe))
* **rebranding:** emit branded static asset urls ([#28446](https://github.com/vm0-ai/vm0/issues/28446)) ([3eb6c67](https://github.com/vm0-ai/vm0/commit/3eb6c679aef093e43d24dd3c625cb526cc461c7f))
* roll out image and video model selection to all users ([#29042](https://github.com/vm0-ai/vm0/issues/29042)) ([9c61cec](https://github.com/vm0-ai/vm0/commit/9c61cecb5a6f5a4dfcaa045910a4646d1576f5fe))
* show runtime model routes in activity diagnostics ([#28866](https://github.com/vm0-ai/vm0/issues/28866)) ([f9e7acc](https://github.com/vm0-ai/vm0/commit/f9e7acc8a26b9bcf7fc13fd094a3acf05562015d))
* **slack:** migrate official app to okou ([#28795](https://github.com/vm0-ai/vm0/issues/28795)) ([57d1a9f](https://github.com/vm0-ai/vm0/commit/57d1a9f500272b2b8214462fcbc640528103dd8f))
* support workspace presentation templates ([#28596](https://github.com/vm0-ai/vm0/issues/28596)) ([f25dbbb](https://github.com/vm0-ai/vm0/commit/f25dbbbae2aae3546070a36eaeead062ec563ee7))
* **teams:** separate provider identity from public brand ([#28938](https://github.com/vm0-ai/vm0/issues/28938)) ([6e717c5](https://github.com/vm0-ai/vm0/commit/6e717c58fad35281b0e30e296ea135ed9487d363))
* **telegram:** support dual-brand ingress ([#28945](https://github.com/vm0-ai/vm0/issues/28945)) ([c5f6b87](https://github.com/vm0-ai/vm0/commit/c5f6b87adc0ba25a73bddd595d5740360fd32d0d))


### Bug Fixes

* align media model price badge with run model rows ([#28741](https://github.com/vm0-ai/vm0/issues/28741)) ([ba56392](https://github.com/vm0-ai/vm0/commit/ba56392f325975292ed67ddef0db6d7737c34671))
* align paid concurrency with plan endings ([#28370](https://github.com/vm0-ai/vm0/issues/28370)) ([4fbaafa](https://github.com/vm0-ai/vm0/commit/4fbaafa3586cdbe6f08a23f6adc198f81cd8d68b))
* **composer:** keep the feedback note chrome outside the editable flow ([#29037](https://github.com/vm0-ai/vm0/issues/29037)) ([05d6dcc](https://github.com/vm0-ai/vm0/commit/05d6dcca4a00acbac33b98d031790da594a0e7a1))
* **composer:** rebuild the quote block on native prosemirror machinery ([#29137](https://github.com/vm0-ai/vm0/issues/29137)) ([626a055](https://github.com/vm0-ai/vm0/commit/626a055c38c9dfd936d5011c875fcd39a82c91b2))
* **composer:** reconcile live dom before submission ([#28574](https://github.com/vm0-ai/vm0/issues/28574)) ([cf781f9](https://github.com/vm0-ai/vm0/commit/cf781f94c8bec7ac7521a02c8406eea866de793f))
* **connectors:** simplify multi-account settings interactions ([#29094](https://github.com/vm0-ai/vm0/issues/29094)) ([023b916](https://github.com/vm0-ai/vm0/commit/023b916626ff1488f54ed6c5d10658fbf0f34e7c))
* keep uploaded template preview stable on visibility updates ([#29165](https://github.com/vm0-ai/vm0/issues/29165)) ([30bbbde](https://github.com/vm0-ai/vm0/commit/30bbbde846e8bdc0d90ab0e72e8c4a9d462be497))
* **platform:** bind chat actions to current thread ([#28595](https://github.com/vm0-ai/vm0/issues/28595)) ([bcbcba2](https://github.com/vm0-ai/vm0/commit/bcbcba26b2e7ad9c18a6d86fef17a5f47c009fa1))
* **platform:** bold the selected pinned agent label ([#28551](https://github.com/vm0-ai/vm0/issues/28551)) ([a9da8a4](https://github.com/vm0-ai/vm0/commit/a9da8a4bfaa152dea4a9591d6606c3e94108c301))
* **platform:** fit seven models without scrolling ([#28260](https://github.com/vm0-ai/vm0/issues/28260)) ([98f9ac8](https://github.com/vm0-ai/vm0/commit/98f9ac831b6a64d31618ec6bdf22a6b95bbf2e5f))
* **platform:** flatten the model picker category switch and tighten its header ([#28874](https://github.com/vm0-ai/vm0/issues/28874)) ([db4e11b](https://github.com/vm0-ai/vm0/commit/db4e11beb0b5c940370c5be93e81dbb2ef13536a))
* **platform:** keep debug diagnostic icons stationary ([#28802](https://github.com/vm0-ai/vm0/issues/28802)) ([135d308](https://github.com/vm0-ai/vm0/commit/135d30829576ce3233d5738cdc245fd709cd26b0))
* **platform:** keep deck import alive across the new-thread navigation ([#28491](https://github.com/vm0-ai/vm0/issues/28491)) ([67e9f2b](https://github.com/vm0-ai/vm0/commit/67e9f2bc40550d2a714964ee0135cc41e2616c75))
* **platform:** keep the model picker checkmark in one column ([#28335](https://github.com/vm0-ai/vm0/issues/28335)) ([505d95b](https://github.com/vm0-ai/vm0/commit/505d95baf205ef262b0fafe715f204145d0506e1))
* **platform:** keep the model picker measurement row hidden on category switch ([#29046](https://github.com/vm0-ai/vm0/issues/29046)) ([4771a6f](https://github.com/vm0-ai/vm0/commit/4771a6fe681d674fb16d80120a19541597a63866))
* **platform:** label unmatched endpoints as other endpoints ([#28760](https://github.com/vm0-ai/vm0/issues/28760)) ([1f99095](https://github.com/vm0-ai/vm0/commit/1f99095cfeada9eed2bcde77af98725a1808e42e))
* **platform:** localize workflow template copy ([#28360](https://github.com/vm0-ai/vm0/issues/28360)) ([b07bcba](https://github.com/vm0-ai/vm0/commit/b07bcbae9b26fa46c0f5a75e417ce9478ef50b77))
* **platform:** narrow the model picker popover back to 260px ([#28542](https://github.com/vm0-ai/vm0/issues/28542)) ([787b8c7](https://github.com/vm0-ai/vm0/commit/787b8c7597206ed952f5fc69c31ec48a5d890a83))
* **platform:** open the image annotation editor from any surface ([#29173](https://github.com/vm0-ai/vm0/issues/29173)) ([6ce64f0](https://github.com/vm0-ai/vm0/commit/6ce64f0da3be32e11a8834b0645d145e6673e2dc))
* **platform:** paginate personal usage records ([#28557](https://github.com/vm0-ai/vm0/issues/28557)) ([da68dc3](https://github.com/vm0-ai/vm0/commit/da68dc3b56b131f662d66b5aab1b38f2921f85c9))
* **platform:** preserve clerk reset password checkbox styles ([#28817](https://github.com/vm0-ai/vm0/issues/28817)) ([da035ef](https://github.com/vm0-ai/vm0/commit/da035eff331af489a48a7ed56107fe9c35c608c1))
* **platform:** preserve composer state during feature hydration ([#29026](https://github.com/vm0-ai/vm0/issues/29026)) ([65b1577](https://github.com/vm0-ai/vm0/commit/65b1577d45cfd95f7df3355d8f5507ec9df9ce92))
* **platform:** preserve cooldown diagnostics during refresh ([#28748](https://github.com/vm0-ai/vm0/issues/28748)) ([bec8623](https://github.com/vm0-ai/vm0/commit/bec862314a87002697cfcf89efb9ea94dc59af9c))
* **platform:** prevent blank uploaded template covers ([#28783](https://github.com/vm0-ai/vm0/issues/28783)) ([5d256d8](https://github.com/vm0-ai/vm0/commit/5d256d842772ae2446d684d752d6f20be73d1710))
* **platform:** put the growth entry back in the top-right corner ([#28563](https://github.com/vm0-ai/vm0/issues/28563)) ([2fc93d9](https://github.com/vm0-ai/vm0/commit/2fc93d965433d9766537e7f1b3e534b58785cb31))
* **platform:** remove unavailable restored attachments ([#28871](https://github.com/vm0-ai/vm0/issues/28871)) ([16a3f22](https://github.com/vm0-ai/vm0/commit/16a3f2278db41669f27e3af909312f80429b782e))
* **platform:** use semantic icons for debug diagnostics ([#28759](https://github.com/vm0-ai/vm0/issues/28759)) ([ffd7484](https://github.com/vm0-ai/vm0/commit/ffd748457aeedb16d51fee83a1b30858a02aae47))
* **platform:** use the Ideogram brand mark in the image model picker ([#28781](https://github.com/vm0-ai/vm0/issues/28781)) ([1c273db](https://github.com/vm0-ai/vm0/commit/1c273db0c7a64c28f78e45828d78b9c2a6ea3249))
* polish uploaded presentation templates ([#28671](https://github.com/vm0-ai/vm0/issues/28671)) ([687ef27](https://github.com/vm0-ai/vm0/commit/687ef278ec5b6164e40d0e7ed48ba75e49a1b648))
* prefetch uploaded template previews ([#28705](https://github.com/vm0-ai/vm0/issues/28705)) ([e17447c](https://github.com/vm0-ai/vm0/commit/e17447c69a398ee38598b00beeb791483482f841))
* **rebranding:** neutralize agent-facing brand copy ([#29167](https://github.com/vm0-ai/vm0/issues/29167)) ([d1a4cc6](https://github.com/vm0-ai/vm0/commit/d1a4cc63dfc912c36e636315772d9353ee190334))
* revise chat usage after late settlement ([#28378](https://github.com/vm0-ai/vm0/issues/28378)) ([21ca637](https://github.com/vm0-ai/vm0/commit/21ca637a2975b12d44aa1dce9d62633e89fb0556))
* sync workspace presentation templates without picker flicker ([#29054](https://github.com/vm0-ai/vm0/issues/29054)) ([0309fcb](https://github.com/vm0-ai/vm0/commit/0309fcb9dd1c15a3c7138df003cc28d10286e1de))
* **video:** default to a video model the picker offers ([#29045](https://github.com/vm0-ai/vm0/issues/29045)) ([33a6dba](https://github.com/vm0-ai/vm0/commit/33a6dba91522f57fc231773833d1cac9ad88a2e4))


### Refactoring

* **activity:** neutralize the activity vertical in platform ([#29159](https://github.com/vm0-ai/vm0/issues/29159)) ([d49855b](https://github.com/vm0-ai/vm0/commit/d49855b1aa7405e653b43a5c34d1816118deade4)), closes [#29151](https://github.com/vm0-ai/vm0/issues/29151)
* **agent-detail:** neutralize agent detail and creation vertical ([#29161](https://github.com/vm0-ai/vm0/issues/29161)) ([5f3ba5c](https://github.com/vm0-ai/vm0/commit/5f3ba5c5ef9ceeb4cca41080fa263f599a4ada57))
* **api:** move agents, workflows, and workflow automations off the brand namespace ([#28497](https://github.com/vm0-ai/vm0/issues/28497)) ([ee1f56f](https://github.com/vm0-ai/vm0/commit/ee1f56f9a4994b5b6978e6e8515fdbe9df9e6970))
* **api:** move artifact catalog, logs, and run reads off the brand namespace ([#28435](https://github.com/vm0-ai/vm0/issues/28435)) ([fa800f0](https://github.com/vm0-ai/vm0/commit/fa800f04ec58ad7835649b2acc6000b8538154c5))
* **api:** move chat threads, chat events, and shared threads off the brand namespace ([#28471](https://github.com/vm0-ai/vm0/issues/28471)) ([6c2036f](https://github.com/vm0-ai/vm0/commit/6c2036fa7e5f02e01cf163ab1a515364e8ec29d8))
* **api:** move chat-thread, indicator and attribution routes off the brand namespace ([#28425](https://github.com/vm0-ai/vm0/issues/28425)) ([f0bf52e](https://github.com/vm0-ai/vm0/commit/f0bf52eb50e5f7bd30a4f3aa5eee00a5cf81d344))
* **api:** move connectors and catalog off the brand namespace ([#28490](https://github.com/vm0-ai/vm0/issues/28490)) ([942449c](https://github.com/vm0-ai/vm0/commit/942449c2866e51c0d6e7148fc0b4220d1c8feb80))
* **api:** move desktop update routes off the brand namespace ([#28489](https://github.com/vm0-ai/vm0/issues/28489)) ([cef2269](https://github.com/vm0-ai/vm0/commit/cef2269fb823155ef359347544683ed3219149a9)), closes [#28465](https://github.com/vm0-ai/vm0/issues/28465)
* **api:** move integrations off the brand namespace ([#28488](https://github.com/vm0-ai/vm0/issues/28488)) ([cafdde6](https://github.com/vm0-ai/vm0/commit/cafdde60bbdcf29e58a45a0c72ec457103cf8588))
* **api:** move org, model provider, and usage routes off the brand namespace ([#28492](https://github.com/vm0-ai/vm0/issues/28492)) ([a8b8a31](https://github.com/vm0-ai/vm0/commit/a8b8a311c4abaaa2892dca6ad7b4437cb2a617e0))
* **api:** move slack, teams, and feishu connect routes off the brand namespace ([#28485](https://github.com/vm0-ai/vm0/issues/28485)) ([ae6999f](https://github.com/vm0-ai/vm0/commit/ae6999f9a1b4193cdf2bece16d0baba6cf343f30)), closes [#28464](https://github.com/vm0-ai/vm0/issues/28464)
* **api:** move user config and personal model provider routes off the brand namespace ([#28429](https://github.com/vm0-ai/vm0/issues/28429)) ([6ef5bd2](https://github.com/vm0-ai/vm0/commit/6ef5bd26a731fe5372c2fedd6dad7c173e1ff591))
* **api:** move web, uploads, voice-io and more off the brand namespace ([#28496](https://github.com/vm0-ai/vm0/issues/28496)) ([911553c](https://github.com/vm0-ai/vm0/commit/911553c29ebada5da274bdcaf647272e1f3aa8dd))
* **api:** retire target-only connector mutations ([#28708](https://github.com/vm0-ai/vm0/issues/28708)) ([a600615](https://github.com/vm0-ai/vm0/commit/a6006156e747df605582c3aa2742806f58263658))
* **connectors:** neutralize the connector and provider connect flows in platform ([#29157](https://github.com/vm0-ai/vm0/issues/29157)) ([6d3162e](https://github.com/vm0-ai/vm0/commit/6d3162eeb9a12a2d452e16d3fccd6242a2ad01aa)), closes [#29153](https://github.com/vm0-ai/vm0/issues/29153)
* **contracts:** neutralize custom connector and feature switch contract naming ([#28206](https://github.com/vm0-ai/vm0/issues/28206)) ([0610293](https://github.com/vm0-ai/vm0/commit/0610293ab1acdae01334925c81c79846c11a2009)), closes [#28190](https://github.com/vm0-ai/vm0/issues/28190)
* **contracts:** neutralize permission grant and connector contract naming ([#28200](https://github.com/vm0-ai/vm0/issues/28200)) ([5e3518c](https://github.com/vm0-ai/vm0/commit/5e3518c53373cae28513d5565f91eca9d12c11b9))
* **core:** rename zeroDebug feature switch to okouDebug ([#28816](https://github.com/vm0-ai/vm0/issues/28816)) ([9d86a26](https://github.com/vm0-ai/vm0/commit/9d86a26650ef5c7ac400356fb9f0fc6c173611e6))
* migrate built-in model terminology ([#29079](https://github.com/vm0-ai/vm0/issues/29079)) ([4de6522](https://github.com/vm0-ai/vm0/commit/4de65229d749c81d2b27b5fdc15320e3da5d91ce))
* **platform:** drop zero prefix from onboarding and preferences symbols ([#29162](https://github.com/vm0-ai/vm0/issues/29162)) ([1ad7ff8](https://github.com/vm0-ai/vm0/commit/1ad7ff8222c75243bcaab26feea87f4d535b5cc7)), closes [#29154](https://github.com/vm0-ai/vm0/issues/29154)
* **platform:** remove restored attachment validation switch ([#29130](https://github.com/vm0-ai/vm0/issues/29130)) ([c57004f](https://github.com/vm0-ai/vm0/commit/c57004f83e9a556554afc6d063e6dc91425f6f4d))
* **platform:** rename the zero client factory to a neutral api name ([#28615](https://github.com/vm0-ai/vm0/issues/28615)) ([8a6a043](https://github.com/vm0-ai/vm0/commit/8a6a043acd0725a1c799ec70f8c8590658341ac8))
* **platform:** rename the zero-page directories ([#28847](https://github.com/vm0-ai/vm0/issues/28847)) ([0f0ded9](https://github.com/vm0-ai/vm0/commit/0f0ded9b208cbeb41998c04f43db70ac1cf11d22))
* **platform:** use explicit single-account connector operations ([#28638](https://github.com/vm0-ai/vm0/issues/28638)) ([e14046b](https://github.com/vm0-ai/vm0/commit/e14046b3e69fa6734a9424811d132dd8563e8f16))
* **platform:** use setLoop for template URL refresh ([#28903](https://github.com/vm0-ai/vm0/issues/28903)) ([3cb549e](https://github.com/vm0-ai/vm0/commit/3cb549e3ebf297ffc2f8f3cecdd20962eb62a901))
* remove chat mark unread feature switch ([#28898](https://github.com/vm0-ai/vm0/issues/28898)) ([ea8fa6e](https://github.com/vm0-ai/vm0/commit/ea8fa6ee98f3bd1d0eb02959542bcbe1ae7fa31c))
* remove chat run continuation presentation ([#28641](https://github.com/vm0-ai/vm0/issues/28641)) ([4b46f97](https://github.com/vm0-ai/vm0/commit/4b46f9713160c1a2679ac87aa0c38ff5c86f5602))
* remove chatQuoteOnlyFeedback feature switch ([#28845](https://github.com/vm0-ai/vm0/issues/28845)) ([f35dd1d](https://github.com/vm0-ai/vm0/commit/f35dd1d89dd0274ec0b098de16cc91a1576714f6))
* remove expired deployment compatibility ([#28452](https://github.com/vm0-ai/vm0/issues/28452)) ([cfc81f2](https://github.com/vm0-ai/vm0/commit/cfc81f2a5b5c833db1729ad889eae7b552e20dd3))
* remove home start cards feature switch ([#29044](https://github.com/vm0-ai/vm0/issues/29044)) ([6f777ef](https://github.com/vm0-ai/vm0/commit/6f777ef3e3560c76b4924fb05801ec8937b6800a))
* remove joggai built-in feature switch ([#28896](https://github.com/vm0-ai/vm0/issues/28896)) ([80a87fe](https://github.com/vm0-ai/vm0/commit/80a87fe81391786adb8448ea7c80bc4a13477c27))
* remove retired agent compose persistence plane ([#28880](https://github.com/vm0-ai/vm0/issues/28880)) ([7d91b6b](https://github.com/vm0-ai/vm0/commit/7d91b6bb470128e2a4598218a636692040a03f4e))
* remove saved billing credit purchase switch ([#28897](https://github.com/vm0-ai/vm0/issues/28897)) ([aba35fb](https://github.com/vm0-ai/vm0/commit/aba35fb74906723713fc01665389adf49681038c))
* remove the composer submit dom reconcile switch ([#29144](https://github.com/vm0-ai/vm0/issues/29144)) ([1704de4](https://github.com/vm0-ai/vm0/commit/1704de411b2d0f47e395492668ef24348312f11e))
* **run:** finish the version-independent runtime cutover ([#28517](https://github.com/vm0-ai/vm0/issues/28517)) ([d6a1f75](https://github.com/vm0-ai/vm0/commit/d6a1f753c2146b421c09ce8cd0cae59212d169f0))
* **shell:** neutralize the remaining okou-page shell symbols in platform ([#29163](https://github.com/vm0-ai/vm0/issues/29163)) ([c124279](https://github.com/vm0-ai/vm0/commit/c124279826510c90cfcf75ffd632f784bd1034c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.363.0
    * @okouai/core bumped to 8.590.0

## [0.792.0](https://github.com/vm0-ai/vm0/compare/app-v0.791.0...app-v0.792.0) (2026-08-25)


### Features

* **auth:** add privacy-safe v2 diagnostics ([#29131](https://github.com/vm0-ai/vm0/issues/29131)) ([4be6f12](https://github.com/vm0-ai/vm0/commit/4be6f1284f3369404cd9be7b466d96f8ae1fd0e7))
* **auth:** complete auth v2 sign-in ux parity ([#29141](https://github.com/vm0-ai/vm0/issues/29141)) ([10fbb8e](https://github.com/vm0-ai/vm0/commit/10fbb8ea6b69d90f09d0b0a71042a088a87c3d7c))
* roll out image and video model selection to all users ([#29042](https://github.com/vm0-ai/vm0/issues/29042)) ([9c61cec](https://github.com/vm0-ai/vm0/commit/9c61cecb5a6f5a4dfcaa045910a4646d1576f5fe))


### Bug Fixes

* **composer:** rebuild the quote block on native prosemirror machinery ([#29137](https://github.com/vm0-ai/vm0/issues/29137)) ([626a055](https://github.com/vm0-ai/vm0/commit/626a055c38c9dfd936d5011c875fcd39a82c91b2))
* keep uploaded template preview stable on visibility updates ([#29165](https://github.com/vm0-ai/vm0/issues/29165)) ([30bbbde](https://github.com/vm0-ai/vm0/commit/30bbbde846e8bdc0d90ab0e72e8c4a9d462be497))
* **platform:** open the image annotation editor from any surface ([#29173](https://github.com/vm0-ai/vm0/issues/29173)) ([6ce64f0](https://github.com/vm0-ai/vm0/commit/6ce64f0da3be32e11a8834b0645d145e6673e2dc))
* **rebranding:** neutralize agent-facing brand copy ([#29167](https://github.com/vm0-ai/vm0/issues/29167)) ([d1a4cc6](https://github.com/vm0-ai/vm0/commit/d1a4cc63dfc912c36e636315772d9353ee190334))


### Refactoring

* **platform:** drop zero prefix from onboarding and preferences symbols ([#29162](https://github.com/vm0-ai/vm0/issues/29162)) ([1ad7ff8](https://github.com/vm0-ai/vm0/commit/1ad7ff8222c75243bcaab26feea87f4d535b5cc7)), closes [#29154](https://github.com/vm0-ai/vm0/issues/29154)
* **platform:** remove restored attachment validation switch ([#29130](https://github.com/vm0-ai/vm0/issues/29130)) ([c57004f](https://github.com/vm0-ai/vm0/commit/c57004f83e9a556554afc6d063e6dc91425f6f4d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.362.0
    * @okouai/core bumped to 8.589.0

## [0.791.0](https://github.com/vm0-ai/vm0/compare/app-v0.790.1...app-v0.791.0) (2026-08-25)


### Features

* let staff cancel built-in model cooldowns ([#29142](https://github.com/vm0-ai/vm0/issues/29142)) ([d0ab9d6](https://github.com/vm0-ai/vm0/commit/d0ab9d6c8534491a06878c9d705f726e440cb4c5)), closes [#29121](https://github.com/vm0-ai/vm0/issues/29121)


### Refactoring

* **activity:** neutralize the activity vertical in platform ([#29159](https://github.com/vm0-ai/vm0/issues/29159)) ([d49855b](https://github.com/vm0-ai/vm0/commit/d49855b1aa7405e653b43a5c34d1816118deade4)), closes [#29151](https://github.com/vm0-ai/vm0/issues/29151)
* **agent-detail:** neutralize agent detail and creation vertical ([#29161](https://github.com/vm0-ai/vm0/issues/29161)) ([5f3ba5c](https://github.com/vm0-ai/vm0/commit/5f3ba5c5ef9ceeb4cca41080fa263f599a4ada57))
* **connectors:** neutralize the connector and provider connect flows in platform ([#29157](https://github.com/vm0-ai/vm0/issues/29157)) ([6d3162e](https://github.com/vm0-ai/vm0/commit/6d3162eeb9a12a2d452e16d3fccd6242a2ad01aa)), closes [#29153](https://github.com/vm0-ai/vm0/issues/29153)
* remove the composer submit dom reconcile switch ([#29144](https://github.com/vm0-ai/vm0/issues/29144)) ([1704de4](https://github.com/vm0-ai/vm0/commit/1704de411b2d0f47e395492668ef24348312f11e))
* **shell:** neutralize the remaining okou-page shell symbols in platform ([#29163](https://github.com/vm0-ai/vm0/issues/29163)) ([c124279](https://github.com/vm0-ai/vm0/commit/c124279826510c90cfcf75ffd632f784bd1034c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.361.0
    * @okouai/core bumped to 8.588.0

## [0.790.1](https://github.com/vm0-ai/vm0/compare/app-v0.790.0...app-v0.790.1) (2026-08-25)


### Bug Fixes

* **connectors:** simplify multi-account settings interactions ([#29094](https://github.com/vm0-ai/vm0/issues/29094)) ([023b916](https://github.com/vm0-ai/vm0/commit/023b916626ff1488f54ed6c5d10658fbf0f34e7c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.360.1
    * @okouai/core bumped to 8.587.3

## [0.790.0](https://github.com/vm0-ai/vm0/compare/app-v0.789.0...app-v0.790.0) (2026-08-24)


### Features

* add auth v2 organization continuation ([#29110](https://github.com/vm0-ai/vm0/issues/29110)) ([9c62e8c](https://github.com/vm0-ai/vm0/commit/9c62e8c601dddf1e17a28a20447310f746b72a6b))
* **auth:** add v2 google sign-up ([#29109](https://github.com/vm0-ai/vm0/issues/29109)) ([e3682a7](https://github.com/vm0-ai/vm0/commit/e3682a7a1832c7dd82b265b7aaeb782d43375dc0))

## [0.789.0](https://github.com/vm0-ai/vm0/compare/app-v0.788.0...app-v0.789.0) (2026-08-24)


### Features

* **agentphone:** decouple provider identity from public brand ([#28953](https://github.com/vm0-ai/vm0/issues/28953)) ([e7fcd06](https://github.com/vm0-ai/vm0/commit/e7fcd06ba2647f55d8a83e7e94be2ed066b74a97))
* **auth:** add advanced v2 sign-in strategies ([#29090](https://github.com/vm0-ai/vm0/issues/29090)) ([c59a376](https://github.com/vm0-ai/vm0/commit/c59a3768f3d1267ca03549f380705781e589f128))
* **auth:** add v2 sign-in flow ([#29035](https://github.com/vm0-ai/vm0/issues/29035)) ([5cdeba4](https://github.com/vm0-ai/vm0/commit/5cdeba4b32757db052f7a63aa1582b2b38726ffa))
* **auth:** add v2 sign-up flow ([#29096](https://github.com/vm0-ai/vm0/issues/29096)) ([627bf97](https://github.com/vm0-ai/vm0/commit/627bf970c44ae77a221f50ceaa3dae208583b1a8))
* **feishu:** preserve host-derived public branding ([#28935](https://github.com/vm0-ai/vm0/issues/28935)) ([bbb60c7](https://github.com/vm0-ai/vm0/commit/bbb60c70fb46dcc1ca6a15694de0770edba98c95))
* **telegram:** support dual-brand ingress ([#28945](https://github.com/vm0-ai/vm0/issues/28945)) ([c5f6b87](https://github.com/vm0-ai/vm0/commit/c5f6b87adc0ba25a73bddd595d5740360fd32d0d))


### Bug Fixes

* sync workspace presentation templates without picker flicker ([#29054](https://github.com/vm0-ai/vm0/issues/29054)) ([0309fcb](https://github.com/vm0-ai/vm0/commit/0309fcb9dd1c15a3c7138df003cc28d10286e1de))


### Refactoring

* migrate built-in model terminology ([#29079](https://github.com/vm0-ai/vm0/issues/29079)) ([4de6522](https://github.com/vm0-ai/vm0/commit/4de65229d749c81d2b27b5fdc15320e3da5d91ce))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.360.0
    * @okouai/core bumped to 8.587.2

## [0.788.0](https://github.com/vm0-ai/vm0/compare/app-v0.787.0...app-v0.788.0) (2026-08-24)


### Features

* **slack:** migrate official app to okou ([#28795](https://github.com/vm0-ai/vm0/issues/28795)) ([57d1a9f](https://github.com/vm0-ai/vm0/commit/57d1a9f500272b2b8214462fcbc640528103dd8f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.359.0
    * @okouai/core bumped to 8.587.1

## [0.787.0](https://github.com/vm0-ai/vm0/compare/app-v0.786.0...app-v0.787.0) (2026-08-24)


### Features

* annotate an attached image in the composer ([#28976](https://github.com/vm0-ai/vm0/issues/28976)) ([19096b6](https://github.com/vm0-ai/vm0/commit/19096b6c2ef65e8d885cbadbf0f6f7cc81ef4508))
* **auth:** add auth v2 navigation context ([#28999](https://github.com/vm0-ai/vm0/issues/28999)) ([8cfed8c](https://github.com/vm0-ai/vm0/commit/8cfed8cd93cde210d039b37c3b293fd11029f5be))
* **auth:** refine v2 presentation shell ([#28993](https://github.com/vm0-ai/vm0/issues/28993)) ([c9b2e6f](https://github.com/vm0-ai/vm0/commit/c9b2e6ff28254cc5e952c5e22345f3dd75015048))
* **banking:** add chat-based mastercard connect flow ([#28832](https://github.com/vm0-ai/vm0/issues/28832)) ([faf1021](https://github.com/vm0-ai/vm0/commit/faf10210ffc1a956a1c3f077e3410bcc27ae4cb8))
* **platform:** add multi-account connector settings ([#28904](https://github.com/vm0-ai/vm0/issues/28904)) ([e8d0c2a](https://github.com/vm0-ai/vm0/commit/e8d0c2acb679ccd23b218a694aaf1a6893f97791))
* pull presentation reverse-template from r2 ([#29043](https://github.com/vm0-ai/vm0/issues/29043)) ([5da72eb](https://github.com/vm0-ai/vm0/commit/5da72eb706544d50731cab880c4d006979b63afe))
* **teams:** separate provider identity from public brand ([#28938](https://github.com/vm0-ai/vm0/issues/28938)) ([6e717c5](https://github.com/vm0-ai/vm0/commit/6e717c58fad35281b0e30e296ea135ed9487d363))


### Bug Fixes

* **composer:** keep the feedback note chrome outside the editable flow ([#29037](https://github.com/vm0-ai/vm0/issues/29037)) ([05d6dcc](https://github.com/vm0-ai/vm0/commit/05d6dcca4a00acbac33b98d031790da594a0e7a1))
* **platform:** keep the model picker measurement row hidden on category switch ([#29046](https://github.com/vm0-ai/vm0/issues/29046)) ([4771a6f](https://github.com/vm0-ai/vm0/commit/4771a6fe681d674fb16d80120a19541597a63866))
* **platform:** preserve composer state during feature hydration ([#29026](https://github.com/vm0-ai/vm0/issues/29026)) ([65b1577](https://github.com/vm0-ai/vm0/commit/65b1577d45cfd95f7df3355d8f5507ec9df9ce92))
* **video:** default to a video model the picker offers ([#29045](https://github.com/vm0-ai/vm0/issues/29045)) ([33a6dba](https://github.com/vm0-ai/vm0/commit/33a6dba91522f57fc231773833d1cac9ad88a2e4))


### Refactoring

* remove home start cards feature switch ([#29044](https://github.com/vm0-ai/vm0/issues/29044)) ([6f777ef](https://github.com/vm0-ai/vm0/commit/6f777ef3e3560c76b4924fb05801ec8937b6800a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.358.0
    * @okouai/core bumped to 8.587.0

## [0.786.0](https://github.com/vm0-ai/vm0/compare/app-v0.785.1...app-v0.786.0) (2026-08-24)


### Features

* **auth:** scaffold versioned authentication routes ([#28950](https://github.com/vm0-ai/vm0/issues/28950)) ([2d3a789](https://github.com/vm0-ai/vm0/commit/2d3a789095f63f44886788dfe9fdfb2bf9c3d227))


### Bug Fixes

* **platform:** remove unavailable restored attachments ([#28871](https://github.com/vm0-ai/vm0/issues/28871)) ([16a3f22](https://github.com/vm0-ai/vm0/commit/16a3f2278db41669f27e3af909312f80429b782e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.357.2
    * @okouai/core bumped to 8.586.2

## [0.785.1](https://github.com/vm0-ai/vm0/compare/app-v0.785.0...app-v0.785.1) (2026-08-24)


### Bug Fixes

* **platform:** flatten the model picker category switch and tighten its header ([#28874](https://github.com/vm0-ai/vm0/issues/28874)) ([db4e11b](https://github.com/vm0-ai/vm0/commit/db4e11beb0b5c940370c5be93e81dbb2ef13536a))


### Refactoring

* **platform:** use setLoop for template URL refresh ([#28903](https://github.com/vm0-ai/vm0/issues/28903)) ([3cb549e](https://github.com/vm0-ai/vm0/commit/3cb549e3ebf297ffc2f8f3cecdd20962eb62a901))
* remove chat mark unread feature switch ([#28898](https://github.com/vm0-ai/vm0/issues/28898)) ([ea8fa6e](https://github.com/vm0-ai/vm0/commit/ea8fa6ee98f3bd1d0eb02959542bcbe1ae7fa31c))
* remove joggai built-in feature switch ([#28896](https://github.com/vm0-ai/vm0/issues/28896)) ([80a87fe](https://github.com/vm0-ai/vm0/commit/80a87fe81391786adb8448ea7c80bc4a13477c27))
* remove retired agent compose persistence plane ([#28880](https://github.com/vm0-ai/vm0/issues/28880)) ([7d91b6b](https://github.com/vm0-ai/vm0/commit/7d91b6bb470128e2a4598218a636692040a03f4e))
* remove saved billing credit purchase switch ([#28897](https://github.com/vm0-ai/vm0/issues/28897)) ([aba35fb](https://github.com/vm0-ai/vm0/commit/aba35fb74906723713fc01665389adf49681038c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.357.1
    * @okouai/core bumped to 8.586.1

## [0.785.0](https://github.com/vm0-ai/vm0/compare/app-v0.784.4...app-v0.785.0) (2026-08-24)


### Features

* accept legacy .ppt decks in template import ([#28870](https://github.com/vm0-ai/vm0/issues/28870)) ([f3cd82c](https://github.com/vm0-ai/vm0/commit/f3cd82c62633caa58f018aa6ee3cc68ab9a7349f))
* show runtime model routes in activity diagnostics ([#28866](https://github.com/vm0-ai/vm0/issues/28866)) ([f9e7acc](https://github.com/vm0-ai/vm0/commit/f9e7acc8a26b9bcf7fc13fd094a3acf05562015d))


### Refactoring

* **contracts:** neutralize permission grant and connector contract naming ([#28200](https://github.com/vm0-ai/vm0/issues/28200)) ([5e3518c](https://github.com/vm0-ai/vm0/commit/5e3518c53373cae28513d5565f91eca9d12c11b9))
* remove chatQuoteOnlyFeedback feature switch ([#28845](https://github.com/vm0-ai/vm0/issues/28845)) ([f35dd1d](https://github.com/vm0-ai/vm0/commit/f35dd1d89dd0274ec0b098de16cc91a1576714f6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.357.0
    * @okouai/core bumped to 8.586.0

## [0.784.4](https://github.com/vm0-ai/vm0/compare/app-v0.784.3...app-v0.784.4) (2026-08-24)


### Refactoring

* **platform:** rename the zero-page directories ([#28847](https://github.com/vm0-ai/vm0/issues/28847)) ([0f0ded9](https://github.com/vm0-ai/vm0/commit/0f0ded9b208cbeb41998c04f43db70ac1cf11d22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.356.2
    * @okouai/core bumped to 8.585.0

## [0.784.3](https://github.com/vm0-ai/vm0/compare/app-v0.784.2...app-v0.784.3) (2026-08-24)


### Bug Fixes

* **platform:** prevent blank uploaded template covers ([#28783](https://github.com/vm0-ai/vm0/issues/28783)) ([5d256d8](https://github.com/vm0-ai/vm0/commit/5d256d842772ae2446d684d752d6f20be73d1710))


### Refactoring

* **contracts:** neutralize custom connector and feature switch contract naming ([#28206](https://github.com/vm0-ai/vm0/issues/28206)) ([0610293](https://github.com/vm0-ai/vm0/commit/0610293ab1acdae01334925c81c79846c11a2009)), closes [#28190](https://github.com/vm0-ai/vm0/issues/28190)
* **core:** rename zeroDebug feature switch to okouDebug ([#28816](https://github.com/vm0-ai/vm0/issues/28816)) ([9d86a26](https://github.com/vm0-ai/vm0/commit/9d86a26650ef5c7ac400356fb9f0fc6c173611e6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.356.1
    * @okouai/core bumped to 8.584.2

## [0.784.2](https://github.com/vm0-ai/vm0/compare/app-v0.784.1...app-v0.784.2) (2026-08-24)


### Bug Fixes

* **platform:** label unmatched endpoints as other endpoints ([#28760](https://github.com/vm0-ai/vm0/issues/28760)) ([1f99095](https://github.com/vm0-ai/vm0/commit/1f99095cfeada9eed2bcde77af98725a1808e42e))
* **platform:** use semantic icons for debug diagnostics ([#28759](https://github.com/vm0-ai/vm0/issues/28759)) ([ffd7484](https://github.com/vm0-ai/vm0/commit/ffd748457aeedb16d51fee83a1b30858a02aae47))
* **platform:** use the Ideogram brand mark in the image model picker ([#28781](https://github.com/vm0-ai/vm0/issues/28781)) ([1c273db](https://github.com/vm0-ai/vm0/commit/1c273db0c7a64c28f78e45828d78b9c2a6ea3249))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.584.1

## [0.784.1](https://github.com/vm0-ai/vm0/compare/app-v0.784.0...app-v0.784.1) (2026-08-24)


### Bug Fixes

* align media model price badge with run model rows ([#28741](https://github.com/vm0-ai/vm0/issues/28741)) ([ba56392](https://github.com/vm0-ai/vm0/commit/ba56392f325975292ed67ddef0db6d7737c34671))
* **platform:** preserve cooldown diagnostics during refresh ([#28748](https://github.com/vm0-ai/vm0/issues/28748)) ([bec8623](https://github.com/vm0-ai/vm0/commit/bec862314a87002697cfcf89efb9ea94dc59af9c))

## [0.784.0](https://github.com/vm0-ai/vm0/compare/app-v0.783.1...app-v0.784.0) (2026-08-24)


### Features

* **platform:** collapse connector catalog diagnostics ([#28722](https://github.com/vm0-ai/vm0/issues/28722)) ([ae8ea3e](https://github.com/vm0-ai/vm0/commit/ae8ea3e3ae743af607374bd8168f0e65651cc2b5))
* **platform:** show managed model cooldown diagnostics ([#28733](https://github.com/vm0-ai/vm0/issues/28733)) ([f86c836](https://github.com/vm0-ai/vm0/commit/f86c836c2f5275ca97b288a757a3d5e118ca0566))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.356.0
    * @okouai/core bumped to 8.584.0

## [0.783.1](https://github.com/vm0-ai/vm0/compare/app-v0.783.0...app-v0.783.1) (2026-08-23)


### Bug Fixes

* prefetch uploaded template previews ([#28705](https://github.com/vm0-ai/vm0/issues/28705)) ([e17447c](https://github.com/vm0-ai/vm0/commit/e17447c69a398ee38598b00beeb791483482f841))


### Refactoring

* **api:** retire target-only connector mutations ([#28708](https://github.com/vm0-ai/vm0/issues/28708)) ([a600615](https://github.com/vm0-ai/vm0/commit/a6006156e747df605582c3aa2742806f58263658))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.355.1
    * @okouai/core bumped to 8.583.1

## [0.783.0](https://github.com/vm0-ai/vm0/compare/app-v0.782.2...app-v0.783.0) (2026-08-23)


### Features

* **platform:** offer nano banana 2 lite and price tiers for media models ([#28674](https://github.com/vm0-ai/vm0/issues/28674)) ([dc7962c](https://github.com/vm0-ai/vm0/commit/dc7962c9c51e8e74cab94eb39af89ab31e68fd4b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.355.0
    * @okouai/core bumped to 8.583.0

## [0.782.2](https://github.com/vm0-ai/vm0/compare/app-v0.782.1...app-v0.782.2) (2026-08-23)


### Bug Fixes

* polish uploaded presentation templates ([#28671](https://github.com/vm0-ai/vm0/issues/28671)) ([687ef27](https://github.com/vm0-ai/vm0/commit/687ef278ec5b6164e40d0e7ed48ba75e49a1b648))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.354.1
    * @okouai/core bumped to 8.582.1

## [0.782.1](https://github.com/vm0-ai/vm0/compare/app-v0.782.0...app-v0.782.1) (2026-08-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.354.0
    * @okouai/core bumped to 8.582.0

## [0.782.0](https://github.com/vm0-ai/vm0/compare/app-v0.781.1...app-v0.782.0) (2026-08-22)


### Features

* add flux.2 pro and ideogram 4 ([#28640](https://github.com/vm0-ai/vm0/issues/28640)) ([7022170](https://github.com/vm0-ai/vm0/commit/7022170536a28805f6cbcb7e625e84755552b898))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.353.0
    * @okouai/core bumped to 8.581.0

## [0.781.1](https://github.com/vm0-ai/vm0/compare/app-v0.781.0...app-v0.781.1) (2026-08-22)


### Refactoring

* **platform:** use explicit single-account connector operations ([#28638](https://github.com/vm0-ai/vm0/issues/28638)) ([e14046b](https://github.com/vm0-ai/vm0/commit/e14046b3e69fa6734a9424811d132dd8563e8f16))
* remove chat run continuation presentation ([#28641](https://github.com/vm0-ai/vm0/issues/28641)) ([4b46f97](https://github.com/vm0-ai/vm0/commit/4b46f9713160c1a2679ac87aa0c38ff5c86f5602))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.580.6

## [0.781.0](https://github.com/vm0-ai/vm0/compare/app-v0.780.4...app-v0.781.0) (2026-08-22)


### Features

* support workspace presentation templates ([#28596](https://github.com/vm0-ai/vm0/issues/28596)) ([f25dbbb](https://github.com/vm0-ai/vm0/commit/f25dbbbae2aae3546070a36eaeead062ec563ee7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.352.0
    * @okouai/core bumped to 8.580.5

## [0.780.4](https://github.com/vm0-ai/vm0/compare/app-v0.780.3...app-v0.780.4) (2026-08-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.351.0
    * @okouai/core bumped to 8.580.4

## [0.780.3](https://github.com/vm0-ai/vm0/compare/app-v0.780.2...app-v0.780.3) (2026-08-22)


### Refactoring

* **platform:** rename the zero client factory to a neutral api name ([#28615](https://github.com/vm0-ai/vm0/issues/28615)) ([8a6a043](https://github.com/vm0-ai/vm0/commit/8a6a043acd0725a1c799ec70f8c8590658341ac8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.350.2
    * @okouai/connectors bumped to 1.210.0
    * @okouai/core bumped to 8.580.3

## [0.780.2](https://github.com/vm0-ai/vm0/compare/app-v0.780.1...app-v0.780.2) (2026-08-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.350.1
    * @okouai/core bumped to 8.580.2

## [0.780.1](https://github.com/vm0-ai/vm0/compare/app-v0.780.0...app-v0.780.1) (2026-08-22)


### Bug Fixes

* **composer:** reconcile live dom before submission ([#28574](https://github.com/vm0-ai/vm0/issues/28574)) ([cf781f9](https://github.com/vm0-ai/vm0/commit/cf781f94c8bec7ac7521a02c8406eea866de793f))
* **platform:** bind chat actions to current thread ([#28595](https://github.com/vm0-ai/vm0/issues/28595)) ([bcbcba2](https://github.com/vm0-ai/vm0/commit/bcbcba26b2e7ad9c18a6d86fef17a5f47c009fa1))
* **platform:** keep the model picker checkmark in one column ([#28335](https://github.com/vm0-ai/vm0/issues/28335)) ([505d95b](https://github.com/vm0-ai/vm0/commit/505d95baf205ef262b0fafe715f204145d0506e1))
* **platform:** paginate personal usage records ([#28557](https://github.com/vm0-ai/vm0/issues/28557)) ([da68dc3](https://github.com/vm0-ai/vm0/commit/da68dc3b56b131f662d66b5aab1b38f2921f85c9))
* **platform:** put the growth entry back in the top-right corner ([#28563](https://github.com/vm0-ai/vm0/issues/28563)) ([2fc93d9](https://github.com/vm0-ai/vm0/commit/2fc93d965433d9766537e7f1b3e534b58785cb31))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.350.0
    * @okouai/core bumped to 8.580.1

## [0.780.0](https://github.com/vm0-ai/vm0/compare/app-v0.779.1...app-v0.780.0) (2026-08-21)


### Features

* add qwen image 3 and nano banana 2 lite built-in image models ([#28518](https://github.com/vm0-ai/vm0/issues/28518)) ([9691fc3](https://github.com/vm0-ai/vm0/commit/9691fc30b999724efd07d2d82c384c47ff59c150))
* **platform:** rebalance the pro and team plan highlight lists ([#28540](https://github.com/vm0-ai/vm0/issues/28540)) ([de72f0c](https://github.com/vm0-ai/vm0/commit/de72f0c0208fe1a1d0ec48695434f1dbc43d357c))


### Refactoring

* **api:** move web, uploads, voice-io and more off the brand namespace ([#28496](https://github.com/vm0-ai/vm0/issues/28496)) ([911553c](https://github.com/vm0-ai/vm0/commit/911553c29ebada5da274bdcaf647272e1f3aa8dd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.349.0
    * @okouai/core bumped to 8.580.0

## [0.779.1](https://github.com/vm0-ai/vm0/compare/app-v0.779.0...app-v0.779.1) (2026-08-21)


### Bug Fixes

* **platform:** bold the selected pinned agent label ([#28551](https://github.com/vm0-ai/vm0/issues/28551)) ([a9da8a4](https://github.com/vm0-ai/vm0/commit/a9da8a4bfaa152dea4a9591d6606c3e94108c301))


### Refactoring

* **run:** finish the version-independent runtime cutover ([#28517](https://github.com/vm0-ai/vm0/issues/28517)) ([d6a1f75](https://github.com/vm0-ai/vm0/commit/d6a1f753c2146b421c09ce8cd0cae59212d169f0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.348.0
    * @okouai/core bumped to 8.579.0

## [0.779.0](https://github.com/vm0-ai/vm0/compare/app-v0.778.1...app-v0.779.0) (2026-08-21)


### Features

* **composer:** offer one model per family in the media pickers ([#28510](https://github.com/vm0-ai/vm0/issues/28510)) ([3389b85](https://github.com/vm0-ai/vm0/commit/3389b85bbb3916d38a71661227ccfc1d02662e75))
* **onboarding:** refresh oauth workflow templates ([#28371](https://github.com/vm0-ai/vm0/issues/28371)) ([1b42df2](https://github.com/vm0-ai/vm0/commit/1b42df2a8b21728e74a365fc22143031440342db))
* **platform:** list the user's imported decks in the presentation picker ([#28533](https://github.com/vm0-ai/vm0/issues/28533)) ([e1901a6](https://github.com/vm0-ai/vm0/commit/e1901a6025ef826071a8d21851133536e37263c4))
* **platform:** turn the home invite button into a growth entry ([#28439](https://github.com/vm0-ai/vm0/issues/28439)) ([632fbb9](https://github.com/vm0-ai/vm0/commit/632fbb9f12b7886dafa5860c778245742e4ad689))


### Bug Fixes

* **platform:** narrow the model picker popover back to 260px ([#28542](https://github.com/vm0-ai/vm0/issues/28542)) ([787b8c7](https://github.com/vm0-ai/vm0/commit/787b8c7597206ed952f5fc69c31ec48a5d890a83))


### Refactoring

* **api:** move agents, workflows, and workflow automations off the brand namespace ([#28497](https://github.com/vm0-ai/vm0/issues/28497)) ([ee1f56f](https://github.com/vm0-ai/vm0/commit/ee1f56f9a4994b5b6978e6e8515fdbe9df9e6970))
* **api:** move desktop update routes off the brand namespace ([#28489](https://github.com/vm0-ai/vm0/issues/28489)) ([cef2269](https://github.com/vm0-ai/vm0/commit/cef2269fb823155ef359347544683ed3219149a9)), closes [#28465](https://github.com/vm0-ai/vm0/issues/28465)
* **api:** move org, model provider, and usage routes off the brand namespace ([#28492](https://github.com/vm0-ai/vm0/issues/28492)) ([a8b8a31](https://github.com/vm0-ai/vm0/commit/a8b8a311c4abaaa2892dca6ad7b4437cb2a617e0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.347.0
    * @okouai/core bumped to 8.578.0

## [0.778.1](https://github.com/vm0-ai/vm0/compare/app-v0.778.0...app-v0.778.1) (2026-08-21)


### Bug Fixes

* **platform:** keep deck import alive across the new-thread navigation ([#28491](https://github.com/vm0-ai/vm0/issues/28491)) ([67e9f2b](https://github.com/vm0-ai/vm0/commit/67e9f2bc40550d2a714964ee0135cc41e2616c75))


### Refactoring

* **api:** move artifact catalog, logs, and run reads off the brand namespace ([#28435](https://github.com/vm0-ai/vm0/issues/28435)) ([fa800f0](https://github.com/vm0-ai/vm0/commit/fa800f04ec58ad7835649b2acc6000b8538154c5))
* **api:** move chat threads, chat events, and shared threads off the brand namespace ([#28471](https://github.com/vm0-ai/vm0/issues/28471)) ([6c2036f](https://github.com/vm0-ai/vm0/commit/6c2036fa7e5f02e01cf163ab1a515364e8ec29d8))
* **api:** move connectors and catalog off the brand namespace ([#28490](https://github.com/vm0-ai/vm0/issues/28490)) ([942449c](https://github.com/vm0-ai/vm0/commit/942449c2866e51c0d6e7148fc0b4220d1c8feb80))
* **api:** move integrations off the brand namespace ([#28488](https://github.com/vm0-ai/vm0/issues/28488)) ([cafdde6](https://github.com/vm0-ai/vm0/commit/cafdde60bbdcf29e58a45a0c72ec457103cf8588))
* **api:** move slack, teams, and feishu connect routes off the brand namespace ([#28485](https://github.com/vm0-ai/vm0/issues/28485)) ([ae6999f](https://github.com/vm0-ai/vm0/commit/ae6999f9a1b4193cdf2bece16d0baba6cf343f30)), closes [#28464](https://github.com/vm0-ai/vm0/issues/28464)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.346.0
    * @okouai/core bumped to 8.577.0

## [0.778.0](https://github.com/vm0-ai/vm0/compare/app-v0.777.0...app-v0.778.0) (2026-08-21)


### Features

* **rebranding:** emit branded static asset urls ([#28446](https://github.com/vm0-ai/vm0/issues/28446)) ([3eb6c67](https://github.com/vm0-ai/vm0/commit/3eb6c679aef093e43d24dd3c625cb526cc461c7f))


### Refactoring

* **api:** move chat-thread, indicator and attribution routes off the brand namespace ([#28425](https://github.com/vm0-ai/vm0/issues/28425)) ([f0bf52e](https://github.com/vm0-ai/vm0/commit/f0bf52eb50e5f7bd30a4f3aa5eee00a5cf81d344))
* remove expired deployment compatibility ([#28452](https://github.com/vm0-ai/vm0/issues/28452)) ([cfc81f2](https://github.com/vm0-ai/vm0/commit/cfc81f2a5b5c833db1729ad889eae7b552e20dd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.345.0
    * @okouai/connectors bumped to 1.209.0
    * @okouai/core bumped to 8.576.0

## [0.777.0](https://github.com/vm0-ai/vm0/compare/app-v0.776.0...app-v0.777.0) (2026-08-20)


### Features

* **api:** add managed model fallback resolver ([#28301](https://github.com/vm0-ai/vm0/issues/28301)) ([745a08f](https://github.com/vm0-ai/vm0/commit/745a08fa51b6b0b51208fae1a02ec599664be115))


### Bug Fixes

* revise chat usage after late settlement ([#28378](https://github.com/vm0-ai/vm0/issues/28378)) ([21ca637](https://github.com/vm0-ai/vm0/commit/21ca637a2975b12d44aa1dce9d62633e89fb0556))


### Refactoring

* **api:** move user config and personal model provider routes off the brand namespace ([#28429](https://github.com/vm0-ai/vm0/issues/28429)) ([6ef5bd2](https://github.com/vm0-ai/vm0/commit/6ef5bd26a731fe5372c2fedd6dad7c173e1ff591))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.344.0
    * @okouai/connectors bumped to 1.208.0
    * @okouai/core bumped to 8.575.0

## [0.776.0](https://github.com/vm0-ai/vm0/compare/app-v0.775.1...app-v0.776.0) (2026-08-20)


### Features

* **host:** prepare okou public domains ([#28359](https://github.com/vm0-ai/vm0/issues/28359)) ([853415c](https://github.com/vm0-ai/vm0/commit/853415cbe56481d6e2c44c8cbd73ee50c6064902))
* **platform:** import a deck as a presentation template from the picker ([#28344](https://github.com/vm0-ai/vm0/issues/28344)) ([e7efc60](https://github.com/vm0-ai/vm0/commit/e7efc606a87a71da3e81eeabf62710af8f0617e7))
* point runs at the deck reverse-engineering guide ([#28362](https://github.com/vm0-ai/vm0/issues/28362)) ([8022cb6](https://github.com/vm0-ai/vm0/commit/8022cb61be52befefacfd44e1d758bd1a54f7584))


### Bug Fixes

* **platform:** fit seven models without scrolling ([#28260](https://github.com/vm0-ai/vm0/issues/28260)) ([98f9ac8](https://github.com/vm0-ai/vm0/commit/98f9ac831b6a64d31618ec6bdf22a6b95bbf2e5f))
* **platform:** localize workflow template copy ([#28360](https://github.com/vm0-ai/vm0/issues/28360)) ([b07bcba](https://github.com/vm0-ai/vm0/commit/b07bcbae9b26fa46c0f5a75e417ce9478ef50b77))
* **platform:** show pinned agent drag handle only while dragging ([#28320](https://github.com/vm0-ai/vm0/issues/28320)) ([f359c07](https://github.com/vm0-ai/vm0/commit/f359c07355b7fab1a1c959a0f7ac97ea9b1d5826))
* project support and VAPID contacts by public brand ([#28312](https://github.com/vm0-ai/vm0/issues/28312)) ([4d3848a](https://github.com/vm0-ai/vm0/commit/4d3848ad76a64ddc0c52d9497fb4886b94854fe9))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.343.0
    * @okouai/core bumped to 8.574.0

## [0.775.1](https://github.com/vm0-ai/vm0/compare/app-v0.775.0...app-v0.775.1) (2026-08-20)


### Bug Fixes

* **composer:** stop redundant feedback note dom writes during composition ([#28168](https://github.com/vm0-ai/vm0/issues/28168)) ([88b7464](https://github.com/vm0-ai/vm0/commit/88b74647cb42dce28d5032761654f31b8f78977a))


### Refactoring

* **platform:** drop the unused browser pptx renderer ([#28280](https://github.com/vm0-ai/vm0/issues/28280)) ([002d5c3](https://github.com/vm0-ai/vm0/commit/002d5c31fa8096a58dedf85b4d72f7e0b8b69f3e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.342.1
    * @okouai/core bumped to 8.573.1

## [0.775.0](https://github.com/vm0-ai/vm0/compare/app-v0.774.0...app-v0.775.0) (2026-08-20)


### Features

* **app:** replace home suggested prompts with entry cards ([#27987](https://github.com/vm0-ai/vm0/issues/27987)) ([67aadb6](https://github.com/vm0-ai/vm0/commit/67aadb6fcab723f39b3fc5744bf6f65c80d60095))
* collapse flux and seedream 5 image models into variant groups ([#28174](https://github.com/vm0-ai/vm0/issues/28174)) ([5018b97](https://github.com/vm0-ai/vm0/commit/5018b970a21976c98c72e57466e6e107d3a3fd9f))
* **platform:** make pinned agent reordering discoverable ([#28173](https://github.com/vm0-ai/vm0/issues/28173)) ([8493aa4](https://github.com/vm0-ai/vm0/commit/8493aa455c953d2e194e45d0e81253dd33941d5c))
* **platform:** show scheduled usage pack downgrades ([#28233](https://github.com/vm0-ai/vm0/issues/28233)) ([86dfac0](https://github.com/vm0-ai/vm0/commit/86dfac02563c42dedea8af7ab803baf9a62b0e07))
* **platform:** support unpin in the pin agent dialog ([#28149](https://github.com/vm0-ai/vm0/issues/28149)) ([5589af9](https://github.com/vm0-ai/vm0/commit/5589af9834e6b09b99e7ebf17b2763c4b255d77e))
* retire the gpt-image-1.5 and gpt-image-1-mini image models ([#28147](https://github.com/vm0-ai/vm0/issues/28147)) ([c28f7fc](https://github.com/vm0-ai/vm0/commit/c28f7fcd5ea6b0c690f698d8219b7b9834adfe07))
* simplify model picker trigger and category switch ([#28235](https://github.com/vm0-ai/vm0/issues/28235)) ([a102083](https://github.com/vm0-ai/vm0/commit/a1020834149c8aaa1afba14df8fbc0195abf49f5))


### Bug Fixes

* **app:** enforce production api origin contract ([#28105](https://github.com/vm0-ai/vm0/issues/28105)) ([20f1d4d](https://github.com/vm0-ai/vm0/commit/20f1d4d3c94064b5586431c732d9c61347eff13f))
* **billing:** stabilize shared subscription updates ([#28232](https://github.com/vm0-ai/vm0/issues/28232)) ([972eaff](https://github.com/vm0-ai/vm0/commit/972eaffad4ad62fadd5ff7a64d944f414fe74ac6))
* neutralize built-in model provider presentation ([#28171](https://github.com/vm0-ai/vm0/issues/28171)) ([b2142fb](https://github.com/vm0-ai/vm0/commit/b2142fb91324118fcfe529286c8c87c412609c43))
* **platform:** even out chat list column spacing ([#28151](https://github.com/vm0-ai/vm0/issues/28151)) ([16bcb44](https://github.com/vm0-ai/vm0/commit/16bcb4418bb59b0b67d7a5b722cbf49b3e65634b))
* **platform:** isolate sidebar thread scroll instances ([#28210](https://github.com/vm0-ai/vm0/issues/28210)) ([ee51723](https://github.com/vm0-ai/vm0/commit/ee5172391722babf277b658bd26f534ad9fbfe0b))
* **platform:** show exact connector catalog count ([#28226](https://github.com/vm0-ai/vm0/issues/28226)) ([3bbc265](https://github.com/vm0-ai/vm0/commit/3bbc265321226c3d1ce3b4df75558569c8b04162))


### Refactoring

* **contracts:** neutralize agent and team contract naming ([#28214](https://github.com/vm0-ai/vm0/issues/28214)) ([116eebb](https://github.com/vm0-ai/vm0/commit/116eebb7d10a996ec550aa88e26bd98a89711cff)), closes [#28186](https://github.com/vm0-ai/vm0/issues/28186)
* **contracts:** neutralize billing contract naming ([#28222](https://github.com/vm0-ai/vm0/issues/28222)) ([20ea434](https://github.com/vm0-ai/vm0/commit/20ea434f806fcac8132d8eaddb28ddaec156438c)), closes [#28208](https://github.com/vm0-ai/vm0/issues/28208)
* **contracts:** neutralize computer use telegram and gateway contract naming ([#28215](https://github.com/vm0-ai/vm0/issues/28215)) ([2c00002](https://github.com/vm0-ai/vm0/commit/2c000023fdf2cc2dbddc9318e36fb38b68fb0d5c)), closes [#28191](https://github.com/vm0-ai/vm0/issues/28191)
* **contracts:** neutralize connector catalog contract naming ([#28224](https://github.com/vm0-ai/vm0/issues/28224)) ([fff24fa](https://github.com/vm0-ai/vm0/commit/fff24fa789b95600f3b29d7b0d24e546bb1a7fd8)), closes [#28207](https://github.com/vm0-ai/vm0/issues/28207)
* **contracts:** neutralize workflow contract naming ([#28203](https://github.com/vm0-ai/vm0/issues/28203)) ([22084ad](https://github.com/vm0-ai/vm0/commit/22084adce51a62685ed1d94eb05d27da39e8ef5d)), closes [#28188](https://github.com/vm0-ai/vm0/issues/28188)
* remove chat smooth auto scroll feature switch ([#28244](https://github.com/vm0-ai/vm0/issues/28244)) ([36a269d](https://github.com/vm0-ai/vm0/commit/36a269dcdb698fb5afe7b7a6f92b78d98935a7c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.342.0
    * @okouai/core bumped to 8.573.0

## [0.774.0](https://github.com/vm0-ai/vm0/compare/app-v0.773.1...app-v0.774.0) (2026-08-19)


### Features

* collapse composer model controls into one entry point ([#28114](https://github.com/vm0-ai/vm0/issues/28114)) ([664e5e1](https://github.com/vm0-ai/vm0/commit/664e5e14477556d2c910bcd73304e527fdc1a89f))


### Bug Fixes

* **app:** refresh connector catalog diagnostics on debug entry ([#28130](https://github.com/vm0-ai/vm0/issues/28130)) ([b01ceb5](https://github.com/vm0-ai/vm0/commit/b01ceb574842aaeb171ec4f0cbe57e8492a0b9c9))


### Refactoring

* give custom model gateways their own provider types ([#28120](https://github.com/vm0-ai/vm0/issues/28120)) ([1de777f](https://github.com/vm0-ai/vm0/commit/1de777f7bc1e5df798ba384af30be07df2b23151))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.341.2
    * @okouai/core bumped to 8.572.1

## [0.773.1](https://github.com/vm0-ai/vm0/compare/app-v0.773.0...app-v0.773.1) (2026-08-19)


### Bug Fixes

* **platform:** keep virtual thread rows visible after refresh ([#28142](https://github.com/vm0-ai/vm0/issues/28142)) ([2776cb2](https://github.com/vm0-ai/vm0/commit/2776cb2fda7e4f5f9e28f2447a623d328a1f4c34))
* **platform:** prevent multipart completion abort race ([#28100](https://github.com/vm0-ai/vm0/issues/28100)) ([84edf6a](https://github.com/vm0-ai/vm0/commit/84edf6a1d268f0519a4ad1c95aa10981e1ad7e0c))
* **platform:** update connector count to 1100+ ([#28139](https://github.com/vm0-ai/vm0/issues/28139)) ([074baf3](https://github.com/vm0-ai/vm0/commit/074baf3683a19fff2e08004f53984c78e3ca35b6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.341.1
    * @okouai/core bumped to 8.572.0

## [0.773.0](https://github.com/vm0-ai/vm0/compare/app-v0.772.2...app-v0.773.0) (2026-08-19)


### Features

* **app:** add conversation search shortcut ([#28102](https://github.com/vm0-ai/vm0/issues/28102)) ([0c4f4cf](https://github.com/vm0-ai/vm0/commit/0c4f4cf200990d4199ffbbc565ac5e8ef757d2f8))
* **billing:** support custom main subscriptions ([#27764](https://github.com/vm0-ai/vm0/issues/27764)) ([fe3c377](https://github.com/vm0-ai/vm0/commit/fe3c377460349c7d9644a193cf30168e21f4c314))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.341.0
    * @okouai/core bumped to 8.571.0

## [0.772.2](https://github.com/vm0-ai/vm0/compare/app-v0.772.1...app-v0.772.2) (2026-08-19)


### Bug Fixes

* **composer:** flush pending ime dom changes before submit ([#28045](https://github.com/vm0-ai/vm0/issues/28045)) ([2ad0862](https://github.com/vm0-ai/vm0/commit/2ad08627c7599840af4c82103032edab250e5e4d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.570.2

## [0.772.1](https://github.com/vm0-ai/vm0/compare/app-v0.772.0...app-v0.772.1) (2026-08-19)


### Bug Fixes

* **app:** classify queued automation events by event type ([#28077](https://github.com/vm0-ai/vm0/issues/28077)) ([7eb0a85](https://github.com/vm0-ai/vm0/commit/7eb0a8546c218dd4cf0750799ac85f72fba63967)), closes [#28076](https://github.com/vm0-ai/vm0/issues/28076)


### Refactoring

* **chat:** remove inline thinking blocks feature switch ([#28067](https://github.com/vm0-ai/vm0/issues/28067)) ([399a46a](https://github.com/vm0-ai/vm0/commit/399a46ab821def13790639170c652d4455544744))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.340.1
    * @okouai/core bumped to 8.570.1

## [0.772.0](https://github.com/vm0-ai/vm0/compare/app-v0.771.0...app-v0.772.0) (2026-08-18)


### Features

* add byteplus seedream 5 image models ([#28064](https://github.com/vm0-ai/vm0/issues/28064)) ([a0f3faa](https://github.com/vm0-ai/vm0/commit/a0f3faaa9fb9cd5850d7b994d00284dc9598e587))


### Bug Fixes

* **app:** refresh members after billing changes ([#28062](https://github.com/vm0-ai/vm0/issues/28062)) ([2146cf5](https://github.com/vm0-ai/vm0/commit/2146cf518d8c7b94277ee51d2422a73a92a44d96))
* **platform:** refine thinking disclosure icons ([#28065](https://github.com/vm0-ai/vm0/issues/28065)) ([7816273](https://github.com/vm0-ai/vm0/commit/78162734d36c05e3fd7facd65e67ddf8ed95e94a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.340.0
    * @okouai/core bumped to 8.570.0

## [0.771.0](https://github.com/vm0-ai/vm0/compare/app-v0.770.0...app-v0.771.0) (2026-08-18)


### Features

* **app:** separate three-column pin and search ([#28042](https://github.com/vm0-ai/vm0/issues/28042)) ([aa64f44](https://github.com/vm0-ai/vm0/commit/aa64f44a5e65bb82229e26d1ff296e7560e43cc9))
* **app:** turn the pinned grid entry into an agent pin picker ([#28041](https://github.com/vm0-ai/vm0/issues/28041)) ([2d06fa7](https://github.com/vm0-ai/vm0/commit/2d06fa7bf5c534fda96972bfb093e76a7bea567f))


### Bug Fixes

* **app:** hide chat model brand icon in media picker ([#28048](https://github.com/vm0-ai/vm0/issues/28048)) ([b27e778](https://github.com/vm0-ai/vm0/commit/b27e7784df0073f81e327566541e6dec8e22cbb6))
* **platform:** defer settings until home route stabilizes ([#28043](https://github.com/vm0-ai/vm0/issues/28043)) ([d19e2bd](https://github.com/vm0-ai/vm0/commit/d19e2bd970ccbc3995f29fb59b4fd68f1eafd880))
* **platform:** separate progress from thinking blocks ([#28055](https://github.com/vm0-ai/vm0/issues/28055)) ([484697f](https://github.com/vm0-ai/vm0/commit/484697fee139c2e38298390b948b24c97e26bd5b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.339.2
    * @okouai/core bumped to 8.569.1

## [0.770.0](https://github.com/vm0-ai/vm0/compare/app-v0.769.0...app-v0.770.0) (2026-08-18)


### Features

* **app:** add new-chat image model defaults ([#27959](https://github.com/vm0-ai/vm0/issues/27959)) ([d4c0489](https://github.com/vm0-ai/vm0/commit/d4c048946bc46f692c7a868854adf7f456561219))
* render thinking blocks inline in chat ([#27923](https://github.com/vm0-ai/vm0/issues/27923)) ([960d256](https://github.com/vm0-ai/vm0/commit/960d25691194d9ec7bf4454eb7d6a0fc7580c4dc))


### Bug Fixes

* **platform:** use chat icon for mark unread ([#28018](https://github.com/vm0-ai/vm0/issues/28018)) ([5a6b34b](https://github.com/vm0-ai/vm0/commit/5a6b34b9f5a7f90c4b79d36505eee968092c3a7d))
* **ui:** show five pinned agents per row ([#27922](https://github.com/vm0-ai/vm0/issues/27922)) ([56a2dfa](https://github.com/vm0-ai/vm0/commit/56a2dfac6effac52303b286b3a8a42a98addd343))


### Refactoring

* **browser:** neutralize the browser contract and service naming ([#27999](https://github.com/vm0-ai/vm0/issues/27999)) ([53e70a5](https://github.com/vm0-ai/vm0/commit/53e70a57f49923a644f914fcd9ad7e0468d81ec7)), closes [#27988](https://github.com/vm0-ai/vm0/issues/27988)
* **connectors:** neutralize the user connectors contract declarations ([#28001](https://github.com/vm0-ai/vm0/issues/28001)) ([56cc9f8](https://github.com/vm0-ai/vm0/commit/56cc9f81029a44b98f1ffd9d264b88a9292470d6)), closes [#27992](https://github.com/vm0-ai/vm0/issues/27992)
* **contracts:** neutralize uploads goals and host contract naming ([#27934](https://github.com/vm0-ai/vm0/issues/27934)) ([3f5f274](https://github.com/vm0-ai/vm0/commit/3f5f274ad182f1162c6f0165de054b9ffcf9b077)), closes [#27911](https://github.com/vm0-ai/vm0/issues/27911)
* **contracts:** rename the org member route contract module ([#27954](https://github.com/vm0-ai/vm0/issues/27954)) ([66d5014](https://github.com/vm0-ai/vm0/commit/66d50149f552adf85e8625e2df14daf6c3520f06)), closes [#27942](https://github.com/vm0-ai/vm0/issues/27942)
* **contracts:** rename the run route contract module ([#27949](https://github.com/vm0-ai/vm0/issues/27949)) ([7404f55](https://github.com/vm0-ai/vm0/commit/7404f5565480aedb84833d9142430fecdc3f8c9f)), closes [#27943](https://github.com/vm0-ai/vm0/issues/27943)
* remove presentationArtifactViewport feature switch ([#28013](https://github.com/vm0-ai/vm0/issues/28013)) ([172743f](https://github.com/vm0-ai/vm0/commit/172743f2814636af0d7dc7dfce38058b03c18c52))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.339.1
    * @okouai/core bumped to 8.569.0

## [0.769.0](https://github.com/vm0-ai/vm0/compare/app-v0.768.0...app-v0.769.0) (2026-08-18)


### Features

* **chat:** add mark unread action ([#27886](https://github.com/vm0-ai/vm0/issues/27886)) ([e6e1e79](https://github.com/vm0-ai/vm0/commit/e6e1e79e3df60e0564b2186503faaf6f3cb8290c))


### Refactoring

* **contracts:** neutralize usage and model policy contract naming ([#27928](https://github.com/vm0-ai/vm0/issues/27928)) ([62ed800](https://github.com/vm0-ai/vm0/commit/62ed800549a54e26f9c04826864f804bc748b9c9)), closes [#27912](https://github.com/vm0-ai/vm0/issues/27912)
* **contracts:** rename the org route contract module ([#27950](https://github.com/vm0-ai/vm0/issues/27950)) ([91dc1e4](https://github.com/vm0-ai/vm0/commit/91dc1e4c0e9475ecc18edcda30c6a918b2eab0ee))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.339.0
    * @okouai/core bumped to 8.568.0

## [0.768.0](https://github.com/vm0-ai/vm0/compare/app-v0.767.1...app-v0.768.0) (2026-08-18)


### Features

* **app:** add image model selection to existing chats ([#27881](https://github.com/vm0-ai/vm0/issues/27881)) ([3dcb1f4](https://github.com/vm0-ai/vm0/commit/3dcb1f4fe316e0e77fc561684659f114365335d3))
* mark all chats read in three-column navigation ([#27885](https://github.com/vm0-ai/vm0/issues/27885)) ([8a84c70](https://github.com/vm0-ai/vm0/commit/8a84c70acaf8b38b2e254c02e95b789855bb5fb3))


### Bug Fixes

* pause automations when deleting chat threads ([#27880](https://github.com/vm0-ai/vm0/issues/27880)) ([039e1ec](https://github.com/vm0-ai/vm0/commit/039e1ecdab67a1ea7559919d3186c9d60a71b4c4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.338.3
    * @okouai/connectors bumped to 1.207.1
    * @okouai/core bumped to 8.567.0

## [0.767.1](https://github.com/vm0-ai/vm0/compare/app-v0.767.0...app-v0.767.1) (2026-08-18)


### Bug Fixes

* show selection toolbar for whole assistant paragraphs ([#27877](https://github.com/vm0-ai/vm0/issues/27877)) ([55f4021](https://github.com/vm0-ai/vm0/commit/55f40212167b6d9f87e9850d759330fbb9c336fe))


### Refactoring

* **feishu:** make generated connector integration-owned ([#27884](https://github.com/vm0-ai/vm0/issues/27884)) ([ac37534](https://github.com/vm0-ai/vm0/commit/ac37534f8228eed341a0dd86bfb31e28646f9001))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.338.2
    * @okouai/core bumped to 8.566.2

## [0.767.0](https://github.com/vm0-ai/vm0/compare/app-v0.766.2...app-v0.767.0) (2026-08-18)


### Features

* **platform:** report confirmed onboarding role ([#27852](https://github.com/vm0-ai/vm0/issues/27852)) ([c055abe](https://github.com/vm0-ai/vm0/commit/c055abe4fde9175c3a7bd6d0bcad93e0b768d70a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.338.1
    * @okouai/core bumped to 8.566.1

## [0.766.2](https://github.com/vm0-ai/vm0/compare/app-v0.766.1...app-v0.766.2) (2026-08-18)


### Bug Fixes

* **platform:** trust historical cross-brand action links ([#27827](https://github.com/vm0-ai/vm0/issues/27827)) ([a6aa776](https://github.com/vm0-ai/vm0/commit/a6aa7764f061ee74c1bd95b3658398bb64cd791b))
* **ui:** stabilize pinned agent loading layout ([#27790](https://github.com/vm0-ai/vm0/issues/27790)) ([0713c11](https://github.com/vm0-ai/vm0/commit/0713c1125844ed2b1af0467e709a404c7d032787))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.566.0

## [0.766.1](https://github.com/vm0-ai/vm0/compare/app-v0.766.0...app-v0.766.1) (2026-08-17)


### Bug Fixes

* **platform:** align the composer control row with the design system ([#27726](https://github.com/vm0-ai/vm0/issues/27726)) ([f1a3f02](https://github.com/vm0-ai/vm0/commit/f1a3f02daff088f8b65ea8fc4274c359be45fbd0))
* **platform:** pass credential id for personal model reconnect ([#27812](https://github.com/vm0-ai/vm0/issues/27812)) ([a172154](https://github.com/vm0-ai/vm0/commit/a1721545aff43ebc73d0e9d048a512d8777a36b8))

## [0.766.0](https://github.com/vm0-ai/vm0/compare/app-v0.765.2...app-v0.766.0) (2026-08-17)


### Features

* **api:** add thread and member image model preferences ([#27776](https://github.com/vm0-ai/vm0/issues/27776)) ([d3b0c0e](https://github.com/vm0-ai/vm0/commit/d3b0c0e020d2e79e5c89c56e9feaf462f0b5d0a6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.338.0
    * @okouai/core bumped to 8.565.3

## [0.765.2](https://github.com/vm0-ai/vm0/compare/app-v0.765.1...app-v0.765.2) (2026-08-17)


### Bug Fixes

* **platform:** create chat from three-column header ([#27769](https://github.com/vm0-ai/vm0/issues/27769)) ([5c1f9eb](https://github.com/vm0-ai/vm0/commit/5c1f9ebec70e9544dc296fe80fc49314991f39d0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.337.0
    * @okouai/connectors bumped to 1.207.0
    * @okouai/core bumped to 8.565.2

## [0.765.1](https://github.com/vm0-ai/vm0/compare/app-v0.765.0...app-v0.765.1) (2026-08-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.565.1

## [0.765.0](https://github.com/vm0-ai/vm0/compare/app-v0.764.0...app-v0.765.0) (2026-08-17)


### Features

* **db:** persist image model selection ([#27736](https://github.com/vm0-ai/vm0/issues/27736)) ([d28ca98](https://github.com/vm0-ai/vm0/commit/d28ca9819162ef98e5229f1413cb3d2686072f98)), closes [#27688](https://github.com/vm0-ai/vm0/issues/27688)


### Bug Fixes

* **app:** limit composer connector icons ([#27633](https://github.com/vm0-ai/vm0/issues/27633)) ([fc5b021](https://github.com/vm0-ai/vm0/commit/fc5b0211bb5d1605c588b8df49bae0460c9e0812))


### Refactoring

* **app:** generalize composer media-model panels ([#27742](https://github.com/vm0-ai/vm0/issues/27742)) ([ae9f378](https://github.com/vm0-ai/vm0/commit/ae9f378fb96552153ada9c037410f11abc9db8bc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.336.0
    * @okouai/core bumped to 8.565.0

## [0.764.0](https://github.com/vm0-ai/vm0/compare/app-v0.763.0...app-v0.764.0) (2026-08-17)


### Features

* **billing:** support one-time atom usage-pack grants ([#26948](https://github.com/vm0-ai/vm0/issues/26948)) ([5221f39](https://github.com/vm0-ai/vm0/commit/5221f393c5fc221c8b794948578a674a1b5144bf))


### Refactoring

* remove videoTemplateOptions feature switch ([#27706](https://github.com/vm0-ai/vm0/issues/27706)) ([dbb411f](https://github.com/vm0-ai/vm0/commit/dbb411f15a94a4fe20051f73d2b7a692fa8da77c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.335.0
    * @okouai/core bumped to 8.564.0

## [0.763.0](https://github.com/vm0-ai/vm0/compare/app-v0.762.1...app-v0.763.0) (2026-08-17)


### Features

* **api:** persist public brand for outbound delivery ([#27200](https://github.com/vm0-ai/vm0/issues/27200)) ([fa77b3e](https://github.com/vm0-ai/vm0/commit/fa77b3e80fae53c57168e8dc6d38e4b7a7d77c96))
* **platform:** attribute telemetry by public brand ([#27662](https://github.com/vm0-ai/vm0/issues/27662)) ([f251dd2](https://github.com/vm0-ai/vm0/commit/f251dd276eb7aa801a61d7f5559f1d801f22202e))


### Bug Fixes

* **platform:** allow lab access before onboarding ([#27702](https://github.com/vm0-ai/vm0/issues/27702)) ([085dbdb](https://github.com/vm0-ai/vm0/commit/085dbdb3656fce61c5502ce9487ab3956c230139))
* **platform:** reduce chat mode icon size ([#27678](https://github.com/vm0-ai/vm0/issues/27678)) ([76c9de2](https://github.com/vm0-ai/vm0/commit/76c9de22109166d1bdbd019a2ee2a91602aa3977))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.334.0
    * @okouai/core bumped to 8.563.0

## [0.762.1](https://github.com/vm0-ai/vm0/compare/app-v0.762.0...app-v0.762.1) (2026-08-17)


### Bug Fixes

* **billing:** align legacy migration notice ([#27640](https://github.com/vm0-ai/vm0/issues/27640)) ([ac57885](https://github.com/vm0-ai/vm0/commit/ac578856ee5c00b97659528a5ee1ccfd0e9aae80))

## [0.762.0](https://github.com/vm0-ai/vm0/compare/app-v0.761.0...app-v0.762.0) (2026-08-17)


### Features

* **composer:** offer new-chat video model as an explicit default ([#27648](https://github.com/vm0-ai/vm0/issues/27648)) ([57f9504](https://github.com/vm0-ai/vm0/commit/57f9504c4bd1b596dcc4b6b6fba97d5e5f3186d4))

## [0.761.0](https://github.com/vm0-ai/vm0/compare/app-v0.760.2...app-v0.761.0) (2026-08-17)


### Features

* **platform:** parameterize assistant brand copy ([#27214](https://github.com/vm0-ai/vm0/issues/27214)) ([205e9c5](https://github.com/vm0-ai/vm0/commit/205e9c5b56aec85022c7e46a5817d8143baddb63))


### Bug Fixes

* **platform:** brand standalone surfaces by hostname ([#27654](https://github.com/vm0-ai/vm0/issues/27654)) ([d68c64c](https://github.com/vm0-ai/vm0/commit/d68c64cf265108e8cc5c59bedec3a52d0a19f121))

## [0.760.2](https://github.com/vm0-ai/vm0/compare/app-v0.760.1...app-v0.760.2) (2026-08-17)


### Bug Fixes

* **billing:** unblock scheduled subscription transitions ([#27083](https://github.com/vm0-ai/vm0/issues/27083)) ([a9d6aaa](https://github.com/vm0-ai/vm0/commit/a9d6aaaedf36eff09108427c99ed5218dc5a955b))

## [0.760.1](https://github.com/vm0-ai/vm0/compare/app-v0.760.0...app-v0.760.1) (2026-08-17)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.11
    * @okouai/core bumped to 8.562.8

## [0.760.0](https://github.com/vm0-ai/vm0/compare/app-v0.759.2...app-v0.760.0) (2026-08-16)


### Features

* **app:** add desktop video model switch ([#27607](https://github.com/vm0-ai/vm0/issues/27607)) ([a5b77b8](https://github.com/vm0-ai/vm0/commit/a5b77b8ae22991012cb3b6c9da19d4dbd06fa469))


### Refactoring

* **identity:** switch integration ownership to user id ([#27618](https://github.com/vm0-ai/vm0/issues/27618)) ([1900732](https://github.com/vm0-ai/vm0/commit/1900732575de90a2e3a5169e819f6a9f60d025a2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.10
    * @okouai/core bumped to 8.562.7

## [0.759.2](https://github.com/vm0-ai/vm0/compare/app-v0.759.1...app-v0.759.2) (2026-08-16)


### Refactoring

* **api:** remove chat search identity fallbacks ([#27611](https://github.com/vm0-ai/vm0/issues/27611)) ([ae20072](https://github.com/vm0-ai/vm0/commit/ae200726ce6fe7a0e2b970844a695c59b1aacab3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.9
    * @okouai/core bumped to 8.562.6

## [0.759.1](https://github.com/vm0-ai/vm0/compare/app-v0.759.0...app-v0.759.1) (2026-08-16)


### Refactoring

* **compose:** remove retired compose list surface ([#27606](https://github.com/vm0-ai/vm0/issues/27606)) ([0679f11](https://github.com/vm0-ai/vm0/commit/0679f11c81fed8d6b3be5d8f9f666b654d54e8fd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.8
    * @okouai/core bumped to 8.562.5

## [0.759.0](https://github.com/vm0-ai/vm0/compare/app-v0.758.0...app-v0.759.0) (2026-08-16)


### Features

* **platform:** redesign member usage pack dialog ([#27509](https://github.com/vm0-ai/vm0/issues/27509)) ([1e15eb3](https://github.com/vm0-ai/vm0/commit/1e15eb365604726f8968a860826ba3d06fe8cc7b))


### Bug Fixes

* **billing:** align legacy conversion dialog flow ([#27504](https://github.com/vm0-ai/vm0/issues/27504)) ([1d47170](https://github.com/vm0-ai/vm0/commit/1d471702000bfd645bad9cf8a0caa6b37e92aa26))
* **billing:** align usage pack downgrade feedback ([#27503](https://github.com/vm0-ai/vm0/issues/27503)) ([ba7cd41](https://github.com/vm0-ai/vm0/commit/ba7cd416e693d66e8d0f9f943070cf1a7e462377))
* **platform:** align usage pack credit ledger ([#27496](https://github.com/vm0-ai/vm0/issues/27496)) ([fa50fe1](https://github.com/vm0-ai/vm0/commit/fa50fe1cb46f5a9056fc104ed301f6b04726657c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.7
    * @okouai/core bumped to 8.562.4

## [0.758.0](https://github.com/vm0-ai/vm0/compare/app-v0.757.0...app-v0.758.0) (2026-08-15)


### Features

* refine model policy table styling ([#27424](https://github.com/vm0-ai/vm0/issues/27424)) ([602e84d](https://github.com/vm0-ai/vm0/commit/602e84da53f7b5190807c71a248220a7cc2bc447))


### Bug Fixes

* **billing:** align credit purchase review ledger ([#27383](https://github.com/vm0-ai/vm0/issues/27383)) ([c67b974](https://github.com/vm0-ai/vm0/commit/c67b9746c582301f589ff06288f6b132dc544cb6))
* **billing:** simplify concurrency change flow ([#27334](https://github.com/vm0-ai/vm0/issues/27334)) ([ef762d4](https://github.com/vm0-ai/vm0/commit/ef762d49a54301ab4a9a2e2dec161de76f2d5ad0))
* **platform:** align credit balance bar radius ([#27423](https://github.com/vm0-ai/vm0/issues/27423)) ([5d96829](https://github.com/vm0-ai/vm0/commit/5d96829a0b7e91902596d176227558e8ab7f41d0))
* **ui:** wrap pinned agents in four-column grid ([#27361](https://github.com/vm0-ai/vm0/issues/27361)) ([775e3c6](https://github.com/vm0-ai/vm0/commit/775e3c6d3e28097316dd97c99f1667bd993b88a3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.6
    * @okouai/core bumped to 8.562.3

## [0.757.0](https://github.com/vm0-ai/vm0/compare/app-v0.756.0...app-v0.757.0) (2026-08-15)


### Features

* **platform:** add shared worker observability ([#27339](https://github.com/vm0-ai/vm0/issues/27339)) ([8b296fb](https://github.com/vm0-ai/vm0/commit/8b296fb865ae89f477b03ebb2135fee56a3f1e37))
* **platform:** show workflow visibility on hover ([#27358](https://github.com/vm0-ai/vm0/issues/27358)) ([14f5ba6](https://github.com/vm0-ai/vm0/commit/14f5ba6811d993bac077df5b87deeab7196eb61b))


### Bug Fixes

* assign a preset avatar to agents created without one ([#24922](https://github.com/vm0-ai/vm0/issues/24922)) ([2d35842](https://github.com/vm0-ai/vm0/commit/2d35842bcde8818dc5fadf7248067f11aec339b1))
* **billing:** clarify concurrency add-on hierarchy ([#27337](https://github.com/vm0-ai/vm0/issues/27337)) ([b21f350](https://github.com/vm0-ai/vm0/commit/b21f350720738c5b4a055fefc36dbacffcddd39c))
* **billing:** refine subscription comparison layout ([#27331](https://github.com/vm0-ai/vm0/issues/27331)) ([b9513ec](https://github.com/vm0-ai/vm0/commit/b9513ec914687e440815bf0ef101604e50baa641))
* **platform:** hide rejected automation replacements ([#27359](https://github.com/vm0-ai/vm0/issues/27359)) ([f2a10cf](https://github.com/vm0-ai/vm0/commit/f2a10cf9e76e53dd1b1cde98fe7d14633dfb12db))
* **platform:** simplify credit balance card ([#27341](https://github.com/vm0-ai/vm0/issues/27341)) ([29569ab](https://github.com/vm0-ai/vm0/commit/29569abdb4569516e69b7c649e265ee30da96477))
* **platform:** unify billing payment dialogs ([#27336](https://github.com/vm0-ai/vm0/issues/27336)) ([f5ad76b](https://github.com/vm0-ai/vm0/commit/f5ad76bc481e9a7f861342654f4ff46eef406bd9))


### Refactoring

* **chat:** remove chat event compatibility fallbacks ([#27335](https://github.com/vm0-ai/vm0/issues/27335)) ([6aa5065](https://github.com/vm0-ai/vm0/commit/6aa5065796c906a9e52d0fa2f292493f492e79fe))
* **platform:** refine models settings layout ([#27360](https://github.com/vm0-ai/vm0/issues/27360)) ([437bd29](https://github.com/vm0-ai/vm0/commit/437bd29f3db62b0b1ef97e505b1a0e99b986975c))
* **platform:** unify loops and timers ([#27354](https://github.com/vm0-ai/vm0/issues/27354)) ([018f4af](https://github.com/vm0-ai/vm0/commit/018f4aff7e99d7cbfe0dd20967c9df854fc69dfa))
* remove composer connector permissions feature switch ([#27357](https://github.com/vm0-ai/vm0/issues/27357)) ([c5a74f0](https://github.com/vm0-ai/vm0/commit/c5a74f01738e3a6340c96022107780c2b1fe474d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.5
    * @okouai/core bumped to 8.562.2

## [0.756.0](https://github.com/vm0-ai/vm0/compare/app-v0.755.0...app-v0.756.0) (2026-08-15)


### Features

* **billing:** move legacy migration steps into dialog ([#27309](https://github.com/vm0-ai/vm0/issues/27309)) ([12bc419](https://github.com/vm0-ai/vm0/commit/12bc419d8e7fe81b155fe7df72c854c7090c70f0))
* **platform:** name the shared worker okou core service ([#27324](https://github.com/vm0-ai/vm0/issues/27324)) ([e06cae5](https://github.com/vm0-ai/vm0/commit/e06cae5787dfccb6de5d30fcc7e484a1bd57cfe4))


### Bug Fixes

* **billing:** clarify scheduled usage pack downgrade ([#27323](https://github.com/vm0-ai/vm0/issues/27323)) ([574faa2](https://github.com/vm0-ai/vm0/commit/574faa2832d0e54b031fbd4babb827f9898ec4fa))
* **platform:** hide idle member package action ([#27313](https://github.com/vm0-ai/vm0/issues/27313)) ([60c7444](https://github.com/vm0-ai/vm0/commit/60c7444720e5fb1752e3b29d71b21a43b24ee488))


### Refactoring

* **chat:** remove platform response fallbacks ([#27316](https://github.com/vm0-ai/vm0/issues/27316)) ([b74d49f](https://github.com/vm0-ai/vm0/commit/b74d49f808b2409de8c7805879e2ffdb10c7c4fa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.4
    * @okouai/core bumped to 8.562.1

## [0.755.0](https://github.com/vm0-ai/vm0/compare/app-v0.754.1...app-v0.755.0) (2026-08-14)


### Features

* **platform:** add shared worker chat database facade ([#27270](https://github.com/vm0-ai/vm0/issues/27270)) ([8474271](https://github.com/vm0-ai/vm0/commit/8474271fa52d8874fa7b40f2cb90fdac08b54788))


### Refactoring

* remove expired deployment compatibility ([#27296](https://github.com/vm0-ai/vm0/issues/27296)) ([64196f0](https://github.com/vm0-ai/vm0/commit/64196f0525787984b6ca842f8692c186f2f3e9a2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.3
    * @okouai/core bumped to 8.562.0

## [0.754.1](https://github.com/vm0-ai/vm0/compare/app-v0.754.0...app-v0.754.1) (2026-08-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.2
    * @okouai/core bumped to 8.561.1

## [0.754.0](https://github.com/vm0-ai/vm0/compare/app-v0.753.2...app-v0.754.0) (2026-08-14)


### Features

* **chat:** smooth automatic tail scrolling ([#27290](https://github.com/vm0-ai/vm0/issues/27290)) ([f5352bd](https://github.com/vm0-ai/vm0/commit/f5352bd9d3079a713918f325480ac9ea0cdad806))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.1
    * @okouai/core bumped to 8.561.0

## [0.753.2](https://github.com/vm0-ai/vm0/compare/app-v0.753.1...app-v0.753.2) (2026-08-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.333.0
    * @okouai/core bumped to 8.560.5

## [0.753.1](https://github.com/vm0-ai/vm0/compare/app-v0.753.0...app-v0.753.1) (2026-08-14)


### Bug Fixes

* **platform:** catch up open chat threads after reconnect ([#27279](https://github.com/vm0-ai/vm0/issues/27279)) ([171027e](https://github.com/vm0-ai/vm0/commit/171027e9a020b474172440e8bd311b86859791c6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.332.1
    * @okouai/core bumped to 8.560.4

## [0.753.0](https://github.com/vm0-ai/vm0/compare/app-v0.752.0...app-v0.753.0) (2026-08-14)


### Features

* **billing:** make the usage pack review a step in the plan flow ([#27235](https://github.com/vm0-ai/vm0/issues/27235)) ([65c29e1](https://github.com/vm0-ai/vm0/commit/65c29e14e12d821a1313f8806b5e459604e58139))
* **chat:** negotiate chat event schema versions ([#26848](https://github.com/vm0-ai/vm0/issues/26848)) ([1065c81](https://github.com/vm0-ai/vm0/commit/1065c81ba4c4bc21dfa582f5fa955af93c862935))


### Bug Fixes

* **platform:** decouple foreground recovery from auth refresh ([#27230](https://github.com/vm0-ai/vm0/issues/27230)) ([1507816](https://github.com/vm0-ai/vm0/commit/15078161af87f9f368824019e03c82b6f859d040))
* **platform:** prevent mobile model icon clipping ([#27179](https://github.com/vm0-ai/vm0/issues/27179)) ([6f6706b](https://github.com/vm0-ai/vm0/commit/6f6706b1aa1ed55636c4ef35dea428e6799a9bc1))
* **platform:** skip markdown parsing for user messages ([#27273](https://github.com/vm0-ai/vm0/issues/27273)) ([92d2ebc](https://github.com/vm0-ai/vm0/commit/92d2ebc1d5fee336923330520dbf5cf002b46fda))


### Refactoring

* remove rolled-out automation feature switches ([#27256](https://github.com/vm0-ai/vm0/issues/27256)) ([91119e4](https://github.com/vm0-ai/vm0/commit/91119e4ff88250028c24e79d8b8045cc2c90f896))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.332.0
    * @okouai/core bumped to 8.560.3

## [0.752.0](https://github.com/vm0-ai/vm0/compare/app-v0.751.0...app-v0.752.0) (2026-08-14)


### Features

* **platform:** make the plan step comparable and fix its title bar ([#27154](https://github.com/vm0-ai/vm0/issues/27154)) ([f73e454](https://github.com/vm0-ai/vm0/commit/f73e454b9cb70f07de28eda0081c7cab6c8b2524))


### Refactoring

* **slack:** neutralize channels source shell ([#27231](https://github.com/vm0-ai/vm0/issues/27231)) ([bb501a7](https://github.com/vm0-ai/vm0/commit/bb501a7c5dbecf280e1bde08a931bd0b60726c3d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.331.1
    * @okouai/core bumped to 8.560.2

## [0.751.0](https://github.com/vm0-ai/vm0/compare/app-v0.750.1...app-v0.751.0) (2026-08-14)


### Features

* **app:** seed new chats from the member default video model ([#27151](https://github.com/vm0-ai/vm0/issues/27151)) ([c3e3236](https://github.com/vm0-ai/vm0/commit/c3e32367d57e7fce5f04d958ea5eb0fe6576a59a))


### Bug Fixes

* **chat:** allow sparse event sequences ([#27204](https://github.com/vm0-ai/vm0/issues/27204)) ([8914528](https://github.com/vm0-ai/vm0/commit/8914528927834320f56ed2d084f1e63b772172bd))


### Refactoring

* **platform:** use durable chat search identity ([#27215](https://github.com/vm0-ai/vm0/issues/27215)) ([9c4c233](https://github.com/vm0-ai/vm0/commit/9c4c233e1280088243affb048eb98aa03c68b520))
* **usage-record:** neutralize source naming ([#27207](https://github.com/vm0-ai/vm0/issues/27207)) ([e740534](https://github.com/vm0-ai/vm0/commit/e7405348093d0ac62b8545618f7dacd276ce9e07))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.331.0
    * @okouai/core bumped to 8.560.1

## [0.750.1](https://github.com/vm0-ai/vm0/compare/app-v0.750.0...app-v0.750.1) (2026-08-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/core bumped to 8.560.0

## [0.750.0](https://github.com/vm0-ai/vm0/compare/app-v0.749.1...app-v0.750.0) (2026-08-14)


### Features

* **platform:** add browser-native pptx renderer ([#26915](https://github.com/vm0-ai/vm0/issues/26915)) ([fabca5b](https://github.com/vm0-ai/vm0/commit/fabca5b24e8d10c455c2189ef6ac2182d8700a52))


### Bug Fixes

* **auth:** preserve okou brand through primary clerk handoff ([#27101](https://github.com/vm0-ai/vm0/issues/27101)) ([b1f8ea1](https://github.com/vm0-ai/vm0/commit/b1f8ea1a7b4c604f0773b91400d5c3e864b905db))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.330.9
    * @okouai/connectors bumped to 1.206.1
    * @okouai/core bumped to 8.559.13

## [0.749.1](https://github.com/vm0-ai/vm0/compare/app-v0.749.0...app-v0.749.1) (2026-08-14)


### Bug Fixes

* align first inline feedback item with composer padding ([#27156](https://github.com/vm0-ai/vm0/issues/27156)) ([acfcdcd](https://github.com/vm0-ai/vm0/commit/acfcdcd1cceada5ca6ce73058f61e425aec659b8)), closes [#27152](https://github.com/vm0-ai/vm0/issues/27152)
* **platform:** allow concurrency quantity input ([#27161](https://github.com/vm0-ai/vm0/issues/27161)) ([2116b15](https://github.com/vm0-ai/vm0/commit/2116b15a39b360b5a8261ea86513dd0d306b0b76))
* **platform:** fit presentation artifact previews ([#27081](https://github.com/vm0-ai/vm0/issues/27081)) ([d16bb8b](https://github.com/vm0-ai/vm0/commit/d16bb8b4cdccb028b777b343663272de143266f7))
* statically import mermaid ([#27155](https://github.com/vm0-ai/vm0/issues/27155)) ([3a08e43](https://github.com/vm0-ai/vm0/commit/3a08e43c8e67a86e8c3e6b87d5b6fea207ea9873))


### Refactoring

* **platform:** signal locator landing timer ([#27169](https://github.com/vm0-ai/vm0/issues/27169)) ([a45cf28](https://github.com/vm0-ai/vm0/commit/a45cf288c46041de6f093394063db6329554c056))
* **user-model-preference:** neutralize the api shell ([#27165](https://github.com/vm0-ai/vm0/issues/27165)) ([ae1a719](https://github.com/vm0-ai/vm0/commit/ae1a7197d8538d5da7032d1990e49ca0699641b0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.330.8
    * @okouai/core bumped to 8.559.12

## [0.749.0](https://github.com/vm0-ai/vm0/compare/app-v0.748.6...app-v0.749.0) (2026-08-14)


### Features

* **app:** show realtime status in debug sidebar ([#27117](https://github.com/vm0-ai/vm0/issues/27117)) ([6c489f4](https://github.com/vm0-ai/vm0/commit/6c489f476dc224b5580969035e13477fe600c457))


### Refactoring

* **attribution:** neutralize acquisition attribution api naming ([#27137](https://github.com/vm0-ai/vm0/issues/27137)) ([3fb152c](https://github.com/vm0-ai/vm0/commit/3fb152c18d8434a59d819cb4abaa008781eb7a7d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.330.7
    * @okouai/core bumped to 8.559.11

## [0.748.6](https://github.com/vm0-ai/vm0/compare/app-v0.748.5...app-v0.748.6) (2026-08-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.330.6
    * @okouai/core bumped to 8.559.10

## [0.748.5](https://github.com/vm0-ai/vm0/compare/app-v0.748.4...app-v0.748.5) (2026-08-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.330.5
    * @okouai/core bumped to 8.559.9

## [0.748.4](https://github.com/vm0-ai/vm0/compare/app-v0.748.3...app-v0.748.4) (2026-08-14)


### Bug Fixes

* **platform:** restore legal consent checkbox checkmark ([#27079](https://github.com/vm0-ai/vm0/issues/27079)) ([842687b](https://github.com/vm0-ai/vm0/commit/842687b59b279618c589d701657c1a8f37f3c49b))


### Refactoring

* **platform:** remove activity event route rollout fallback ([#27070](https://github.com/vm0-ai/vm0/issues/27070)) ([a2a40bd](https://github.com/vm0-ai/vm0/commit/a2a40bd33a9c6857317a5bec1c702573a99c4acc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.330.4
    * @okouai/core bumped to 8.559.8

## [0.748.3](https://github.com/vm0-ai/vm0/compare/app-v0.748.2...app-v0.748.3) (2026-08-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.330.3
    * @okouai/core bumped to 8.559.7

## [0.748.2](https://github.com/vm0-ai/vm0/compare/app-v0.748.1...app-v0.748.2) (2026-08-14)


### Bug Fixes

* **platform:** stabilize billing dialogs and pending changes ([#26959](https://github.com/vm0-ai/vm0/issues/26959)) ([4d05aff](https://github.com/vm0-ai/vm0/commit/4d05aff72171d0d72c4ca3f90b2063abd1d3d17d))


### Refactoring

* **queue-position:** neutralize api shell ([#27065](https://github.com/vm0-ai/vm0/issues/27065)) ([8a504ad](https://github.com/vm0-ai/vm0/commit/8a504ad7efba1fd5f3e9a6f1c423ec1780dec869))
* **user-preferences:** neutralize the user preferences api shell ([#27075](https://github.com/vm0-ai/vm0/issues/27075)) ([a99b31b](https://github.com/vm0-ai/vm0/commit/a99b31be509880d93d1e53bae60bbb849cbca916))
* **voice-io:** neutralize voice io naming ([#27071](https://github.com/vm0-ai/vm0/issues/27071)) ([28c0cb5](https://github.com/vm0-ai/vm0/commit/28c0cb5713c0ad7da688315236f4f48fec19cee7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.330.2
    * @okouai/core bumped to 8.559.6

## [0.748.1](https://github.com/vm0-ai/vm0/compare/app-v0.748.0...app-v0.748.1) (2026-08-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.330.1
    * @okouai/core bumped to 8.559.5

## [0.748.0](https://github.com/vm0-ai/vm0/compare/app-v0.747.3...app-v0.748.0) (2026-08-14)


### Features

* **billing:** move usage pack plan steps into a dialog ([#27011](https://github.com/vm0-ai/vm0/issues/27011)) ([fc23c4e](https://github.com/vm0-ai/vm0/commit/fc23c4e36d58cec92f1cb00a151c0b79117cbff2))


### Refactoring

* remove the payment method capability flag ([#27040](https://github.com/vm0-ai/vm0/issues/27040)) ([872357f](https://github.com/vm0-ai/vm0/commit/872357f87d420fafd549d029d2597fb77e33e71d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.330.0
    * @okouai/core bumped to 8.559.4

## [0.747.3](https://github.com/vm0-ai/vm0/compare/app-v0.747.2...app-v0.747.3) (2026-08-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.329.9
    * @okouai/connectors bumped to 1.206.0
    * @okouai/core bumped to 8.559.3

## [0.747.2](https://github.com/vm0-ai/vm0/compare/app-v0.747.1...app-v0.747.2) (2026-08-13)


### Refactoring

* **web-files:** neutralize private web file modules ([#27029](https://github.com/vm0-ai/vm0/issues/27029)) ([66e73ca](https://github.com/vm0-ai/vm0/commit/66e73cafc219d273a91aa383c5edbbb7e28ee465))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.329.8
    * @okouai/core bumped to 8.559.2

## [0.747.1](https://github.com/vm0-ai/vm0/compare/app-v0.747.0...app-v0.747.1) (2026-08-13)


### Refactoring

* **morning-brief:** neutralize manual trigger shell ([#27027](https://github.com/vm0-ai/vm0/issues/27027)) ([ed36ad6](https://github.com/vm0-ai/vm0/commit/ed36ad6fded5ea236b41ce87eb0af8b36aa5b048))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.329.7
    * @okouai/core bumped to 8.559.1

## [0.747.0](https://github.com/vm0-ai/vm0/compare/app-v0.746.0...app-v0.747.0) (2026-08-13)


### Features

* add conversation locator rail behind a feature switch ([#26052](https://github.com/vm0-ai/vm0/issues/26052)) ([f50df2d](https://github.com/vm0-ai/vm0/commit/f50df2d6786a4646ca110921e78ebd63eab63038))
* **chat:** stack every message a user sent back to back ([#27014](https://github.com/vm0-ai/vm0/issues/27014)) ([8e8586b](https://github.com/vm0-ai/vm0/commit/8e8586bf34fc335fe6d28ff4a4eb151d606db726))


### Bug Fixes

* **platform:** restore activity event log ([#27004](https://github.com/vm0-ai/vm0/issues/27004)) ([0ebee7b](https://github.com/vm0-ai/vm0/commit/0ebee7b8eeefbe07d638c86479a22dcea7dfa73e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.329.6
    * @okouai/core bumped to 8.559.0

## [0.746.0](https://github.com/vm0-ai/vm0/compare/app-v0.745.0...app-v0.746.0) (2026-08-13)


### Features

* **platform:** add realtime connection diagnostics ([#26995](https://github.com/vm0-ai/vm0/issues/26995)) ([a30413a](https://github.com/vm0-ai/vm0/commit/a30413a31b7186088360882aace86a60eaddec66))


### Bug Fixes

* **platform:** close realtime in hidden tabs ([#26964](https://github.com/vm0-ai/vm0/issues/26964)) ([410e2b2](https://github.com/vm0-ai/vm0/commit/410e2b250c133fb95ef925d91c856a064563c105))


### Refactoring

* **chat:** remove unified indicator api fallback ([#27006](https://github.com/vm0-ai/vm0/issues/27006)) ([2dde1fd](https://github.com/vm0-ai/vm0/commit/2dde1fd5a9484199da407cf1dc83815dfdc35add))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.329.5
    * @okouai/core bumped to 8.558.0

## [0.745.0](https://github.com/vm0-ai/vm0/compare/app-v0.744.0...app-v0.745.0) (2026-08-13)


### Features

* **chat:** roll out unified indicator api ([#26960](https://github.com/vm0-ai/vm0/issues/26960)) ([169409d](https://github.com/vm0-ai/vm0/commit/169409de2f824947ff3077e44b98e26d647f24b8))


### Bug Fixes

* **chat:** preserve unread agent actions during active runs ([#26975](https://github.com/vm0-ai/vm0/issues/26975)) ([08bef36](https://github.com/vm0-ai/vm0/commit/08bef367636c45e40fb5a5b78272c864a6bc9857))
* **platform:** refine forward composer modal layout ([#26958](https://github.com/vm0-ai/vm0/issues/26958)) ([b0e448b](https://github.com/vm0-ai/vm0/commit/b0e448b7b1eab1da02602b52be1168d934c18bfb))


### Refactoring

* **agent:** canonicalize agent draft naming ([#26979](https://github.com/vm0-ai/vm0/issues/26979)) ([5403d6a](https://github.com/vm0-ai/vm0/commit/5403d6ae1ef87b4343751789c063aa88dbdc18f4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.329.4
    * @okouai/core bumped to 8.557.0

## [0.744.0](https://github.com/vm0-ai/vm0/compare/app-v0.743.0...app-v0.744.0) (2026-08-13)


### Features

* **billing:** rebuild the package change review dialog as a ledger ([#26955](https://github.com/vm0-ai/vm0/issues/26955)) ([6f0e2f4](https://github.com/vm0-ai/vm0/commit/6f0e2f477208c8c5a9c5cc9f8e6c5ba590797fe5))
* **billing:** redesign plan selection as a single comparison panel ([#26829](https://github.com/vm0-ai/vm0/issues/26829)) ([41c0284](https://github.com/vm0-ai/vm0/commit/41c0284678bfb48f34ca4c5b14854b0ccd0e1302))


### Refactoring

* **model-provider:** neutralize device auth modules ([#26965](https://github.com/vm0-ai/vm0/issues/26965)) ([f11e0a1](https://github.com/vm0-ai/vm0/commit/f11e0a13759ab812f4cc328c2a9662e70f1bacc4))
* **org:** neutralize the organization logo vertical slice ([#26961](https://github.com/vm0-ai/vm0/issues/26961)) ([74e3061](https://github.com/vm0-ai/vm0/commit/74e30614ebaf1c2fad8cad2991bb783823b18882))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.329.3
    * @okouai/core bumped to 8.556.1

## [0.743.0](https://github.com/vm0-ai/vm0/compare/app-v0.742.1...app-v0.743.0) (2026-08-13)


### Features

* **app:** route Okou production API traffic ([#26856](https://github.com/vm0-ai/vm0/issues/26856)) ([b925ece](https://github.com/vm0-ai/vm0/commit/b925ece93dd63d7a746f341d265d74f4ead2311d))


### Bug Fixes

* **platform:** render 100 initial sidebar threads ([#26943](https://github.com/vm0-ai/vm0/issues/26943)) ([2defbb0](https://github.com/vm0-ai/vm0/commit/2defbb00fb242c909fdc71bd397e6fd7f6fd8f91))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.329.2
    * @okouai/core bumped to 8.556.0

## [0.742.1](https://github.com/vm0-ai/vm0/compare/app-v0.742.0...app-v0.742.1) (2026-08-13)


### Refactoring

* **core:** canonicalize seed modules and onboarding copy ([#26900](https://github.com/vm0-ai/vm0/issues/26900)) ([929d020](https://github.com/vm0-ai/vm0/commit/929d0207440b7cccb8051d17890d8096cbd96ea1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.329.1
    * @okouai/core bumped to 8.555.1

## [0.742.0](https://github.com/vm0-ai/vm0/compare/app-v0.741.0...app-v0.742.0) (2026-08-13)


### Features

* **api:** add member default video model ([#26841](https://github.com/vm0-ai/vm0/issues/26841)) ([4690e37](https://github.com/vm0-ai/vm0/commit/4690e379ae93f4103dbc41267d4a925a1bd45fb1))
* **api:** add per-thread video model endpoint ([#26831](https://github.com/vm0-ai/vm0/issues/26831)) ([d12287f](https://github.com/vm0-ai/vm0/commit/d12287ff2412e1f37fd531a8ea3ac373dc61a66b))
* **chat:** read a steer burst as one group ([#26804](https://github.com/vm0-ai/vm0/issues/26804)) ([6b22a4d](https://github.com/vm0-ai/vm0/commit/6b22a4d16d55fe367fd16df39b1fb26afedcbfee))
* confirm saved-billing credit purchases in app ([#26806](https://github.com/vm0-ai/vm0/issues/26806)) ([135585d](https://github.com/vm0-ai/vm0/commit/135585db4ea65e2c93cd37c7053012d268eedf86))


### Bug Fixes

* **chat:** delay thread skeleton reveal ([#26851](https://github.com/vm0-ai/vm0/issues/26851)) ([bc33b23](https://github.com/vm0-ai/vm0/commit/bc33b23ba996f3456a1ae5a6e792ef40be85a457))
* constrain forward composer and hide pending items ([#26850](https://github.com/vm0-ai/vm0/issues/26850)) ([1adf03b](https://github.com/vm0-ai/vm0/commit/1adf03bb247ae13d798e3d141d7b6a011fe41680))
* **platform:** improve image preview zoom ([#26800](https://github.com/vm0-ai/vm0/issues/26800)) ([d236683](https://github.com/vm0-ai/vm0/commit/d2366839222472627b234df0655fcbd0997b1efc))
* **ui:** show okou unread menu on row hover ([#26789](https://github.com/vm0-ai/vm0/issues/26789)) ([c3e7a11](https://github.com/vm0-ai/vm0/commit/c3e7a11864df21d619b1f419f4b9c206ed0b23a3))


### Refactoring

* **platform:** replace steer acknowledgement timer ([#26869](https://github.com/vm0-ai/vm0/issues/26869)) ([95d6272](https://github.com/vm0-ai/vm0/commit/95d6272344b27637758564420201e53a5e389755))
* remove sandbox presentation import pipeline ([#26646](https://github.com/vm0-ai/vm0/issues/26646)) ([54601f1](https://github.com/vm0-ai/vm0/commit/54601f1aedeb78825f2e8c63760b9c94b41009c0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.329.0
    * @okouai/core bumped to 8.555.0

## [0.741.0](https://github.com/vm0-ai/vm0/compare/app-v0.740.1...app-v0.741.0) (2026-08-13)


### Features

* **db:** add video model columns and thread event kind ([#26807](https://github.com/vm0-ai/vm0/issues/26807)) ([683a9e7](https://github.com/vm0-ai/vm0/commit/683a9e748792feba0ea6d7ed3eea1d1f63665a47))
* **platform:** add an illustrated empty state to credit usage ([#26827](https://github.com/vm0-ai/vm0/issues/26827)) ([e24bf3f](https://github.com/vm0-ai/vm0/commit/e24bf3f7eedf0d58e3264be6183cf8629f47b9fa))


### Bug Fixes

* **platform:** keep async card shells stable ([#26845](https://github.com/vm0-ai/vm0/issues/26845)) ([69a4586](https://github.com/vm0-ai/vm0/commit/69a458652b78451bdd39a81a37a1f6c57b328443))
* **platform:** recover realtime when network reconnects ([#26853](https://github.com/vm0-ai/vm0/issues/26853)) ([aeb263d](https://github.com/vm0-ai/vm0/commit/aeb263de89a21b1e0e2c09db12db4318a75ae7e4))
* restore block spacing between markdown card slots ([#26763](https://github.com/vm0-ai/vm0/issues/26763)) ([e4a6c19](https://github.com/vm0-ai/vm0/commit/e4a6c19cd2108f2a7845a9bbf02eae6634e78f55))


### Refactoring

* **platform:** remove org credits summary bar from credit usage ([#26818](https://github.com/vm0-ai/vm0/issues/26818)) ([6632970](https://github.com/vm0-ai/vm0/commit/663297089a86e4de2e507c35f3f1ff075075c042))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.328.0
    * @okouai/core bumped to 8.554.0

## [0.740.1](https://github.com/vm0-ai/vm0/compare/app-v0.740.0...app-v0.740.1) (2026-08-13)


### Refactoring

* rename workspace packages to [@okouai](https://github.com/okouai) ([#26817](https://github.com/vm0-ai/vm0/issues/26817)) ([ae9c867](https://github.com/vm0-ai/vm0/commit/ae9c8678eb06686dcaaeda2e923f487df8250e5d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.327.3
    * @okouai/connectors bumped to 1.205.2
    * @okouai/core bumped to 8.553.3

## [0.740.0](https://github.com/vm0-ai/vm0/compare/app-v0.739.1...app-v0.740.0) (2026-08-13)


### Features

* **composer:** split video template model and settings into two zones ([#26474](https://github.com/vm0-ai/vm0/issues/26474)) ([4bba7d8](https://github.com/vm0-ai/vm0/commit/4bba7d800d760142b0091f57ed6806e1ba04d15d))
* **platform:** gate the credit balance split behind usage pack plans ([#26753](https://github.com/vm0-ai/vm0/issues/26753)) ([c02a689](https://github.com/vm0-ai/vm0/commit/c02a689f128600eab8c8525849d21941e02d7203))


### Bug Fixes

* **billing:** merge concurrency into plan subscription ([#26393](https://github.com/vm0-ai/vm0/issues/26393)) ([837a57d](https://github.com/vm0-ai/vm0/commit/837a57d8c302bdc0f96bb010866d01da52736f73))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.327.2
    * @vm0/core bumped to 8.553.2

## [0.739.1](https://github.com/vm0-ai/vm0/compare/app-v0.739.0...app-v0.739.1) (2026-08-13)


### Bug Fixes

* **platform:** limit background sync to ten unread threads ([#26778](https://github.com/vm0-ai/vm0/issues/26778)) ([3d47aca](https://github.com/vm0-ai/vm0/commit/3d47aca154a0bcbb73a26d88fc10ed9156c1ee5d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.327.1
    * @vm0/core bumped to 8.553.1

## [0.739.0](https://github.com/vm0-ai/vm0/compare/app-v0.738.2...app-v0.739.0) (2026-08-13)


### Features

* **api:** retire chat event reads and force app upgrade ([#26755](https://github.com/vm0-ai/vm0/issues/26755)) ([7be323f](https://github.com/vm0-ai/vm0/commit/7be323f3f555183be738a3ee0fe158d3d4327e0a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.327.0
    * @vm0/core bumped to 8.553.0

## [0.738.2](https://github.com/vm0-ai/vm0/compare/app-v0.738.1...app-v0.738.2) (2026-08-13)


### Bug Fixes

* **app:** allow crawlers to observe noindex ([#26750](https://github.com/vm0-ai/vm0/issues/26750)) ([505aae7](https://github.com/vm0-ai/vm0/commit/505aae73170efd5b484599eb7d433f404f5c3d2f))


### Refactoring

* remove feedback location rollout compatibility ([#26752](https://github.com/vm0-ai/vm0/issues/26752)) ([4a65c75](https://github.com/vm0-ai/vm0/commit/4a65c75f8c3b2256b6dbbbb6a4150888436539b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.326.2
    * @vm0/core bumped to 8.552.2

## [0.738.1](https://github.com/vm0-ai/vm0/compare/app-v0.738.0...app-v0.738.1) (2026-08-12)


### Refactoring

* remove chat event snapshot read feature switch ([#26745](https://github.com/vm0-ai/vm0/issues/26745)) ([1a3b9d9](https://github.com/vm0-ai/vm0/commit/1a3b9d96818bd4ec7ba6a5a85158d3a126eec790))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.326.1
    * @vm0/core bumped to 8.552.1

## [0.738.0](https://github.com/vm0-ai/vm0/compare/app-v0.737.0...app-v0.738.0) (2026-08-12)


### Features

* add DeepSeek V4 Pro support ([#26737](https://github.com/vm0-ai/vm0/issues/26737)) ([3770acd](https://github.com/vm0-ai/vm0/commit/3770acda61dabb8be63f64b8a0dd853519b40700))


### Bug Fixes

* **platform:** align fast model picker icons ([#26712](https://github.com/vm0-ai/vm0/issues/26712)) ([4ce5d5f](https://github.com/vm0-ai/vm0/commit/4ce5d5f9a44622f6112d96ac0e08adf1b007fd08))
* preserve structured feedback when forwarding ([#26728](https://github.com/vm0-ai/vm0/issues/26728)) ([7dc2d91](https://github.com/vm0-ai/vm0/commit/7dc2d919cf2ce4c481ccbe5fe332f74e1417504d))


### Refactoring

* **connectors:** require auth mode in responses ([#26730](https://github.com/vm0-ai/vm0/issues/26730)) ([9c36796](https://github.com/vm0-ai/vm0/commit/9c36796b826d17cafa7e8a5ef57ac4424a2a653c))
* retire axiom-backed log surfaces ([#26689](https://github.com/vm0-ai/vm0/issues/26689)) ([c7266ba](https://github.com/vm0-ai/vm0/commit/c7266baadf3ccf5e624be2ee396c8656887cf6b8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.326.0
    * @vm0/core bumped to 8.552.0

## [0.737.0](https://github.com/vm0-ai/vm0/compare/app-v0.736.0...app-v0.737.0) (2026-08-12)


### Features

* acknowledge steered messages once per burst ([#26725](https://github.com/vm0-ai/vm0/issues/26725)) ([0576ffd](https://github.com/vm0-ai/vm0/commit/0576ffd5b998581aeebfbb4a700405016add88ba))
* **chat:** enable snapshot reads for all users ([#26718](https://github.com/vm0-ai/vm0/issues/26718)) ([72a4c1b](https://github.com/vm0-ai/vm0/commit/72a4c1b02eac7a392df03d309c817dc0b92bf90b))


### Bug Fixes

* **platform:** double thinking line hold time ([#26719](https://github.com/vm0-ai/vm0/issues/26719)) ([78b66a7](https://github.com/vm0-ai/vm0/commit/78b66a7f575ec36b6dc8546692aa46825720397a))


### Refactoring

* **connectors:** require tagged custom responses ([#26716](https://github.com/vm0-ai/vm0/issues/26716)) ([740c8c4](https://github.com/vm0-ai/vm0/commit/740c8c48851b8de77f55a1a8c0d3b422984a97f7))
* **pi:** persist sandbox sessions in native sqlite ([#26555](https://github.com/vm0-ai/vm0/issues/26555)) ([9ed505e](https://github.com/vm0-ai/vm0/commit/9ed505e1c567ff019d521fac167700c2b390cffe))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.325.0
    * @vm0/core bumped to 8.551.0

## [0.736.0](https://github.com/vm0-ai/vm0/compare/app-v0.735.1...app-v0.736.0) (2026-08-12)


### Features

* **platform:** split credit usage out of credit balance ([#26699](https://github.com/vm0-ai/vm0/issues/26699)) ([e718f76](https://github.com/vm0-ai/vm0/commit/e718f7630d7cbafa9de416288989abff721b870b))
* preserve feedback event ranges ([#26644](https://github.com/vm0-ai/vm0/issues/26644)) ([f29a9fb](https://github.com/vm0-ai/vm0/commit/f29a9fb27da979b0c05d31b6f4d2c9e2aca0a87b))


### Bug Fixes

* preserve dialog content through close animations ([#26698](https://github.com/vm0-ai/vm0/issues/26698)) ([10081dc](https://github.com/vm0-ai/vm0/commit/10081dc9755b8c0c533bad227ac836041379a752))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.324.0
    * @vm0/core bumped to 8.550.1

## [0.735.1](https://github.com/vm0-ai/vm0/compare/app-v0.735.0...app-v0.735.1) (2026-08-12)


### Bug Fixes

* **platform:** hide composer placeholder after whitespace input ([#26688](https://github.com/vm0-ai/vm0/issues/26688)) ([1c3edc4](https://github.com/vm0-ai/vm0/commit/1c3edc42f550750aa695a4f54c48bcba919d8136))
* refine fast model toggle interaction ([#26681](https://github.com/vm0-ai/vm0/issues/26681)) ([4693bf8](https://github.com/vm0-ai/vm0/commit/4693bf8a067640a1447f711b579ff86d8e14c0ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.550.0

## [0.735.0](https://github.com/vm0-ai/vm0/compare/app-v0.734.0...app-v0.735.0) (2026-08-12)


### Features

* add in-app paid member invitations ([#26567](https://github.com/vm0-ai/vm0/issues/26567)) ([f98cd50](https://github.com/vm0-ai/vm0/commit/f98cd507b249c8157d208f3b646cc4a60c83afb3))
* add unified zero indicators api ([#26568](https://github.com/vm0-ai/vm0/issues/26568)) ([ccd1f4f](https://github.com/vm0-ai/vm0/commit/ccd1f4f044abc8012f5f2f13e881135db29207ab))
* **desktop:** finalize okou application identity ([#26659](https://github.com/vm0-ai/vm0/issues/26659)) ([c605c1c](https://github.com/vm0-ai/vm0/commit/c605c1c09f2bdad29a98c3bb86602169085a3dc3))
* **workflow:** replace github-label-applied trigger with github-pull-request automation ([#26630](https://github.com/vm0-ai/vm0/issues/26630)) ([b759ef9](https://github.com/vm0-ai/vm0/commit/b759ef9ab529e6913547f8ed86ede565d3537352))


### Bug Fixes

* **chat:** preserve Fast mode during thread creation ([#26651](https://github.com/vm0-ai/vm0/issues/26651)) ([0ac86b0](https://github.com/vm0-ai/vm0/commit/0ac86b03292d267ae85685ed7abc27ed1a0ddb0c))
* flatten artifact cards and pin the artifacts kind filter ([#26547](https://github.com/vm0-ai/vm0/issues/26547)) ([b4a8e21](https://github.com/vm0-ai/vm0/commit/b4a8e21b6bfb38617acb8584a4d9e0e6b9f4ce78))
* **platform:** scope attachment and copy lifecycles to owners ([#26542](https://github.com/vm0-ai/vm0/issues/26542)) ([27e905f](https://github.com/vm0-ai/vm0/commit/27e905ff3a1fe48bdb0097a47c89a16f4a5f0fa8))
* **platform:** tailor voice input limit recovery by plan ([#26620](https://github.com/vm0-ai/vm0/issues/26620)) ([0443eba](https://github.com/vm0-ai/vm0/commit/0443eba04bce6fd8f33bde6bafab69a0605f2ea5))
* refresh concurrency limit after billing changes ([#26626](https://github.com/vm0-ai/vm0/issues/26626)) ([a216521](https://github.com/vm0-ai/vm0/commit/a216521cc41e41e7cb0125fe0e0537af414ddf4b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.323.0
    * @vm0/core bumped to 8.549.0

## [0.734.0](https://github.com/vm0-ai/vm0/compare/app-v0.733.0...app-v0.734.0) (2026-08-12)


### Features

* **protocol:** cut first-party clients over to okou ([#26549](https://github.com/vm0-ai/vm0/issues/26549)) ([8b1670c](https://github.com/vm0-ai/vm0/commit/8b1670c218fc1a1f326f720368eaa3a65b137ffa))


### Refactoring

* **platform:** scope markdown signal registries to their surfaces ([#26497](https://github.com/vm0-ai/vm0/issues/26497)) ([d22e940](https://github.com/vm0-ai/vm0/commit/d22e940ccfa5d74a5df5ea086c4df93e68276b05))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.322.0
    * @vm0/core bumped to 8.548.3

## [0.733.0](https://github.com/vm0-ai/vm0/compare/app-v0.732.1...app-v0.733.0) (2026-08-12)


### Features

* **ui:** add segment control and unify segmented controls ([#26543](https://github.com/vm0-ai/vm0/issues/26543)) ([43c5a04](https://github.com/vm0-ai/vm0/commit/43c5a0448b3eaed505d55dd62d8d250b68ea11d4))


### Refactoring

* **platform:** mermaid blob urls, code-block invalid fences, real parse in tests ([#26419](https://github.com/vm0-ai/vm0/issues/26419)) ([d1835f0](https://github.com/vm0-ai/vm0/commit/d1835f0a5731a9561b56a5f09839f2ff82ee42be))

## [0.732.1](https://github.com/vm0-ai/vm0/compare/app-v0.732.0...app-v0.732.1) (2026-08-12)


### Bug Fixes

* **chat:** keep skeleton through snapshot hydration ([#26535](https://github.com/vm0-ai/vm0/issues/26535)) ([868596b](https://github.com/vm0-ai/vm0/commit/868596b841b50b0762865d8520b0859fd7f379cb))


### CI

* run bench jobs on every pr commit ([#26427](https://github.com/vm0-ai/vm0/issues/26427)) ([d780bc4](https://github.com/vm0-ai/vm0/commit/d780bc4c02a2eb3372444a381fd2084f81534f6a))


### Refactoring

* **platform:** join mail part previews onto draft lists ([#26493](https://github.com/vm0-ai/vm0/issues/26493)) ([1151227](https://github.com/vm0-ai/vm0/commit/11512278bffa29c4767fa474cf053911ea4d9ccf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.321.2
    * @vm0/core bumped to 8.548.2

## [0.732.0](https://github.com/vm0-ai/vm0/compare/app-v0.731.1...app-v0.732.0) (2026-08-12)


### Features

* **platform:** default desktop downloads to okou ([#26524](https://github.com/vm0-ai/vm0/issues/26524)) ([a12e60e](https://github.com/vm0-ai/vm0/commit/a12e60ea0bfc84c0d9090a76bd00345414f3811c))


### Bug Fixes

* allow arbitrary file uploads in the composer ([#26511](https://github.com/vm0-ai/vm0/issues/26511)) ([aba11e7](https://github.com/vm0-ai/vm0/commit/aba11e781c8abb8ef86a863dfd5b81b88c2f8ee5))
* **platform:** keep invalid mermaid diagrams in fixed cards ([#26512](https://github.com/vm0-ai/vm0/issues/26512)) ([c6dd23f](https://github.com/vm0-ai/vm0/commit/c6dd23f97a9e057f791b32f094656d918b1bd9fe))
* **platform:** keep square thumbnail radius proportional across sizes ([#26525](https://github.com/vm0-ai/vm0/issues/26525)) ([1a41c87](https://github.com/vm0-ai/vm0/commit/1a41c87c6b561a004a67dba9dc9238f6dda1c5a1))


### Refactoring

* **connectors:** remove legacy credential compatibility ([#26523](https://github.com/vm0-ai/vm0/issues/26523)) ([acf5b6a](https://github.com/vm0-ai/vm0/commit/acf5b6ab1d7be0b0a27e27eba17652006e5f6224))
* **ui:** rely on portal ownership for floating layers ([#26482](https://github.com/vm0-ai/vm0/issues/26482)) ([f4ee0e5](https://github.com/vm0-ai/vm0/commit/f4ee0e505967bad1c767cdc37babe9fd23184a9d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.321.1
    * @vm0/core bumped to 8.548.1

## [0.731.1](https://github.com/vm0-ai/vm0/compare/app-v0.731.0...app-v0.731.1) (2026-08-12)


### Bug Fixes

* **chat:** bound initial thinking generation ([#26484](https://github.com/vm0-ai/vm0/issues/26484)) ([6944010](https://github.com/vm0-ai/vm0/commit/6944010dfadff1b652324e06f863ffef1c8e9a46))
* **realtime:** make user signals best effort ([#26495](https://github.com/vm0-ai/vm0/issues/26495)) ([6a6eb89](https://github.com/vm0-ai/vm0/commit/6a6eb89bf3a3e70bbf800de3d6944a06e276fc8c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.548.0

## [0.731.0](https://github.com/vm0-ai/vm0/compare/app-v0.730.4...app-v0.731.0) (2026-08-12)


### Features

* cut first-party cli producers over to okou ([#26491](https://github.com/vm0-ai/vm0/issues/26491)) ([33c4c03](https://github.com/vm0-ai/vm0/commit/33c4c034b421249e220bb0f586a514d44ed78655))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.321.0
    * @vm0/core bumped to 8.547.0

## [0.730.4](https://github.com/vm0-ai/vm0/compare/app-v0.730.3...app-v0.730.4) (2026-08-12)


### Bug Fixes

* show Fast details only on hover ([#26467](https://github.com/vm0-ai/vm0/issues/26467)) ([7df226c](https://github.com/vm0-ai/vm0/commit/7df226c0e92a8cad626254e6df4f3c301f5450a7))

## [0.730.3](https://github.com/vm0-ai/vm0/compare/app-v0.730.2...app-v0.730.3) (2026-08-12)


### Bug Fixes

* **platform:** align auth logo CORS mode ([#26455](https://github.com/vm0-ai/vm0/issues/26455)) ([244f84a](https://github.com/vm0-ai/vm0/commit/244f84aeefdd45ade7a6a3168a62eefab1a3bb4b))
* **platform:** restore artifact share and download actions ([#26454](https://github.com/vm0-ai/vm0/issues/26454)) ([390a702](https://github.com/vm0-ai/vm0/commit/390a702ac998e2de607aff8401a6c3eb92c8c5d1))

## [0.730.2](https://github.com/vm0-ai/vm0/compare/app-v0.730.1...app-v0.730.2) (2026-08-12)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.320.0
    * @vm0/core bumped to 8.546.4

## [0.730.1](https://github.com/vm0-ai/vm0/compare/app-v0.730.0...app-v0.730.1) (2026-08-12)


### Refactoring

* **chat:** remove canonical event rollout fallbacks ([#26344](https://github.com/vm0-ai/vm0/issues/26344)) ([1e4ba1e](https://github.com/vm0-ai/vm0/commit/1e4ba1e1bda5cc531916c47faedd969fd811f4a6))
* remove expired deployment compatibility ([#26424](https://github.com/vm0-ai/vm0/issues/26424)) ([dad4358](https://github.com/vm0-ai/vm0/commit/dad4358adcb9fa179bad39d26fc6e0612234d7a0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.319.1
    * @vm0/core bumped to 8.546.3

## [0.730.0](https://github.com/vm0-ai/vm0/compare/app-v0.729.1...app-v0.730.0) (2026-08-11)


### Features

* **runner:** enable durable active-input delivery ([#26392](https://github.com/vm0-ai/vm0/issues/26392)) ([6225b5e](https://github.com/vm0-ai/vm0/commit/6225b5e85da2833f011830d21498744893b2f625))


### Bug Fixes

* **billing:** refund subscriptions when deleting org ([#26374](https://github.com/vm0-ai/vm0/issues/26374)) ([bf23d8a](https://github.com/vm0-ai/vm0/commit/bf23d8a8f2593ad64f9fc7acfd118db334f8372e))
* refine fast mode toggle feedback ([#26405](https://github.com/vm0-ai/vm0/issues/26405)) ([1dd1fbf](https://github.com/vm0-ai/vm0/commit/1dd1fbfc8f82b7a9fc0a3cf2847492f6ad555040))


### Refactoring

* remove retired model rollout compatibility ([#26413](https://github.com/vm0-ai/vm0/issues/26413)) ([42dfddf](https://github.com/vm0-ai/vm0/commit/42dfddfd80d393d7794868c0469c8e843f09660f))


### Performance Improvements

* remove run and queue realtime signals ([#26417](https://github.com/vm0-ai/vm0/issues/26417)) ([55fe6cf](https://github.com/vm0-ai/vm0/commit/55fe6cf15d6a10e8bad41856b8bd30bdb7d7ba23))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.319.0
    * @vm0/core bumped to 8.546.2

## [0.729.1](https://github.com/vm0-ai/vm0/compare/app-v0.729.0...app-v0.729.1) (2026-08-11)


### Bug Fixes

* **api:** keep chat event cursors consistent on conflicts ([#26402](https://github.com/vm0-ai/vm0/issues/26402)) ([23c508e](https://github.com/vm0-ai/vm0/commit/23c508e72aa55f4b015924a8cd942085a109cb51))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.318.0
    * @vm0/core bumped to 8.546.1

## [0.729.0](https://github.com/vm0-ai/vm0/compare/app-v0.728.0...app-v0.729.0) (2026-08-11)


### Features

* **api:** add presentation template catalog and import pipeline ([#26301](https://github.com/vm0-ai/vm0/issues/26301)) ([e785873](https://github.com/vm0-ai/vm0/commit/e785873209e46f722ca1dd19398a66d2b3b0ed6f))
* **platform:** unify avatar and workspace logo thumbnails ([#26390](https://github.com/vm0-ai/vm0/issues/26390)) ([b9638a1](https://github.com/vm0-ai/vm0/commit/b9638a132cda52a2310398f3c8ab8570cb2abf70))


### Bug Fixes

* **platform:** recover chat state after foreground reconnect ([#26327](https://github.com/vm0-ai/vm0/issues/26327)) ([e1f971e](https://github.com/vm0-ai/vm0/commit/e1f971e308d9c899bcd458fe7012f0634a1f02ab))


### Refactoring

* **platform:** parse chat markdown into per-event hast trees ([#26360](https://github.com/vm0-ai/vm0/issues/26360)) ([86f0362](https://github.com/vm0-ai/vm0/commit/86f0362e6551e7daa10a0747ceaa38b7bd9aada4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.317.0
    * @vm0/core bumped to 8.546.0

## [0.728.0](https://github.com/vm0-ai/vm0/compare/app-v0.727.0...app-v0.728.0) (2026-08-11)


### Features

* migrate inactive retired run models ([#26394](https://github.com/vm0-ai/vm0/issues/26394)) ([afa90b2](https://github.com/vm0-ai/vm0/commit/afa90b2fbc7d94262c680b8c944d66bcb0199364))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.316.0
    * @vm0/core bumped to 8.545.2

## [0.727.0](https://github.com/vm0-ai/vm0/compare/app-v0.726.0...app-v0.727.0) (2026-08-11)


### Features

* migrate legacy subscriptions to usage pack plans ([#25529](https://github.com/vm0-ai/vm0/issues/25529)) ([1caa179](https://github.com/vm0-ai/vm0/commit/1caa179590bc228564dbd2a680c9bf3f4f28e88e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.315.0
    * @vm0/core bumped to 8.545.1

## [0.726.0](https://github.com/vm0-ai/vm0/compare/app-v0.725.0...app-v0.726.0) (2026-08-11)


### Features

* add fast mode toggle beside model picker ([#26331](https://github.com/vm0-ai/vm0/issues/26331)) ([d02441b](https://github.com/vm0-ai/vm0/commit/d02441b450a2af80d5a4a65b48a61f5ece530657))
* **billing:** gate member invitations by plan entitlement ([#26343](https://github.com/vm0-ai/vm0/issues/26343)) ([91e8b71](https://github.com/vm0-ai/vm0/commit/91e8b71aca03ba28501ed4be58f68c0f0b7375e9))
* **desktop:** add product identity observability ([#26377](https://github.com/vm0-ai/vm0/issues/26377)) ([7de4612](https://github.com/vm0-ai/vm0/commit/7de4612ec7d2cd6e09e561c49e3be7b0d2689315))
* migrate retired run model state ([#26338](https://github.com/vm0-ai/vm0/issues/26338)) ([eb9fc94](https://github.com/vm0-ai/vm0/commit/eb9fc9419a23a08a671a5d7c5707fb77dc0d4952))
* name the hovered emoji and tighten the picker section titles ([#26382](https://github.com/vm0-ai/vm0/issues/26382)) ([73a89c9](https://github.com/vm0-ai/vm0/commit/73a89c9f7b6e49b36e2d8bc622aafb64daba9823))


### Bug Fixes

* **chat:** download private attachments from signed urls ([#26367](https://github.com/vm0-ai/vm0/issues/26367)) ([9af59b1](https://github.com/vm0-ai/vm0/commit/9af59b1031d0c796c396f6fbd7e7dfce71193f38))
* simplify connector catalog count ([#26362](https://github.com/vm0-ai/vm0/issues/26362)) ([fbc46db](https://github.com/vm0-ai/vm0/commit/fbc46db2de3468aab2eae6b86455db58e0ee457a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.314.0
    * @vm0/core bumped to 8.545.0

## [0.725.0](https://github.com/vm0-ai/vm0/compare/app-v0.724.3...app-v0.725.0) (2026-08-11)


### Features

* add a category rail to the chat thread emoji picker ([#26342](https://github.com/vm0-ai/vm0/issues/26342)) ([8550bc5](https://github.com/vm0-ai/vm0/commit/8550bc57ab8f6fa0cf026b1a6cc1065b1b123c4a))


### Bug Fixes

* complete custom mcp ui and simplify firewall policies ([#26334](https://github.com/vm0-ai/vm0/issues/26334)) ([49329f0](https://github.com/vm0-ai/vm0/commit/49329f08831fa835504c760d6a8911bb9b3f32b9))


### Refactoring

* remove runless model annotation compatibility ([#26355](https://github.com/vm0-ai/vm0/issues/26355)) ([5ab99fa](https://github.com/vm0-ai/vm0/commit/5ab99fac14018b097a6921bb7901d17203511e9d))
* **ui:** move hand-rolled elements onto the shared component library ([#26316](https://github.com/vm0-ai/vm0/issues/26316)) ([41aea60](https://github.com/vm0-ai/vm0/commit/41aea606b40d5dacf02f0c250ad5d7f833998c3f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.313.1
    * @vm0/connectors bumped to 1.205.1
    * @vm0/core bumped to 8.544.0

## [0.724.3](https://github.com/vm0-ai/vm0/compare/app-v0.724.2...app-v0.724.3) (2026-08-11)


### Bug Fixes

* **chat:** load every attachment preview from a presigned url ([#26275](https://github.com/vm0-ai/vm0/issues/26275)) ([ace447c](https://github.com/vm0-ai/vm0/commit/ace447c68162104c6cbce047e6b6d08b09aebd5b))


### Refactoring

* **connectors:** remove legacy grant compatibility ([#26325](https://github.com/vm0-ai/vm0/issues/26325)) ([4133700](https://github.com/vm0-ai/vm0/commit/41337005f2f8a23dc065d2919f0cb0e1ef5f2fd7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.313.0
    * @vm0/core bumped to 8.543.0

## [0.724.2](https://github.com/vm0-ai/vm0/compare/app-v0.724.1...app-v0.724.2) (2026-08-11)


### Bug Fixes

* use signed urls for document previews ([#26293](https://github.com/vm0-ai/vm0/issues/26293)) ([f2ed156](https://github.com/vm0-ai/vm0/commit/f2ed156c69dceac9cbbc5557203174cc30effeec))


### Refactoring

* migrate ui primitives to base ui ([#26270](https://github.com/vm0-ai/vm0/issues/26270)) ([d128261](https://github.com/vm0-ai/vm0/commit/d128261abb465fb0af344643d03990e3d674cca4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.312.2
    * @vm0/core bumped to 8.542.3

## [0.724.1](https://github.com/vm0-ai/vm0/compare/app-v0.724.0...app-v0.724.1) (2026-08-11)


### Bug Fixes

* keep scroll-to-bottom button opaque on hover ([#26245](https://github.com/vm0-ai/vm0/issues/26245)) ([a14bc00](https://github.com/vm0-ai/vm0/commit/a14bc005dd0f49dc5ba7fdec5ad0d0f804c2a555))
* remove nested hover surface on the composer goal row ([#26299](https://github.com/vm0-ai/vm0/issues/26299)) ([1a73a68](https://github.com/vm0-ai/vm0/commit/1a73a688abf217a9c2d13570176d214856c86140))


### Documentation

* retire remaining workflow event wording ([#26294](https://github.com/vm0-ai/vm0/issues/26294)) ([b688bec](https://github.com/vm0-ai/vm0/commit/b688beca9b8a1be94e5bd0d46d38a0fa2ad0ee80))


### Refactoring

* **connectors:** use canonical custom connector grants ([#26250](https://github.com/vm0-ai/vm0/issues/26250)) ([ccf9418](https://github.com/vm0-ai/vm0/commit/ccf941825eba9b0eef085163584be1904b330887))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.312.1
    * @vm0/core bumped to 8.542.2

## [0.724.0](https://github.com/vm0-ai/vm0/compare/app-v0.723.5...app-v0.724.0) (2026-08-11)


### Features

* **connectors:** migrate custom connector clients ([#26255](https://github.com/vm0-ai/vm0/issues/26255)) ([46e42a4](https://github.com/vm0-ai/vm0/commit/46e42a42e816959e73a1eed74298bae5603d9dca))
* open a read-only spec dialog from sent video template chips ([#26224](https://github.com/vm0-ai/vm0/issues/26224)) ([897393d](https://github.com/vm0-ai/vm0/commit/897393d31bdc780094da4783d61d39e71af8ea01))
* **platform:** manage mcp custom connectors ([#26262](https://github.com/vm0-ai/vm0/issues/26262)) ([1eda100](https://github.com/vm0-ai/vm0/commit/1eda100054e9771618b991290eb2d800007c31d1))


### Bug Fixes

* **connectors:** hide custom agent access while unavailable ([#26263](https://github.com/vm0-ai/vm0/issues/26263)) ([1f44b73](https://github.com/vm0-ai/vm0/commit/1f44b73efdf034b94baba1cc5a1b9765ed5d7258))
* **platform:** overlap chat composer bottom gap with pwa safe-area inset ([#26248](https://github.com/vm0-ai/vm0/issues/26248)) ([d4330e2](https://github.com/vm0-ai/vm0/commit/d4330e2bc990c068b1f215922a980a155e094a64))


### Refactoring

* **connectors:** prepare canonical custom connector definitions ([#26246](https://github.com/vm0-ai/vm0/issues/26246)) ([d611058](https://github.com/vm0-ai/vm0/commit/d611058b8d41047649174462d08db1809f2ba067))
* drop legacy workflow trigger sources ([#26266](https://github.com/vm0-ai/vm0/issues/26266)) ([cd91f26](https://github.com/vm0-ai/vm0/commit/cd91f26cd5999609e43cc5187ef0b0e91f35c636))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.312.0
    * @vm0/core bumped to 8.542.1

## [0.723.5](https://github.com/vm0-ai/vm0/compare/app-v0.723.4...app-v0.723.5) (2026-08-11)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.311.0
    * @vm0/core bumped to 8.542.0

## [0.723.4](https://github.com/vm0-ai/vm0/compare/app-v0.723.3...app-v0.723.4) (2026-08-11)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.310.3
    * @vm0/core bumped to 8.541.3

## [0.723.3](https://github.com/vm0-ai/vm0/compare/app-v0.723.2...app-v0.723.3) (2026-08-11)


### Bug Fixes

* **app:** simplify personal provider account rows ([#26206](https://github.com/vm0-ai/vm0/issues/26206)) ([495a498](https://github.com/vm0-ai/vm0/commit/495a498d52c1a7af9d8c3d7011d82b9342808a41))
* persist paid acquisition attribution through billing ([#26204](https://github.com/vm0-ai/vm0/issues/26204)) ([ecef070](https://github.com/vm0-ai/vm0/commit/ecef070473330ffabf8a94ff26b6c62e1f65f3e1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.310.2
    * @vm0/core bumped to 8.541.2

## [0.723.2](https://github.com/vm0-ai/vm0/compare/app-v0.723.1...app-v0.723.2) (2026-08-10)


### Bug Fixes

* **platform:** restore chat scroll after react commit ([#26196](https://github.com/vm0-ai/vm0/issues/26196)) ([adcb5c8](https://github.com/vm0-ai/vm0/commit/adcb5c89538bcfc5adaca625b470ad846dad9847))


### Refactoring

* **chat:** cut over canonical event storage ([#26197](https://github.com/vm0-ai/vm0/issues/26197)) ([66d96a7](https://github.com/vm0-ai/vm0/commit/66d96a7b422554ce396927d9ff3ac0bc5cdbc3e3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.310.1
    * @vm0/core bumped to 8.541.1

## [0.723.1](https://github.com/vm0-ai/vm0/compare/app-v0.723.0...app-v0.723.1) (2026-08-10)


### Bug Fixes

* restore paid onboarding funnel telemetry ([#26201](https://github.com/vm0-ai/vm0/issues/26201)) ([e420f7d](https://github.com/vm0-ai/vm0/commit/e420f7d71751bddae9ca44b202b1985b6c77c4f0))


### Refactoring

* reduce fallback slop in ui helpers ([#26198](https://github.com/vm0-ai/vm0/issues/26198)) ([bc54305](https://github.com/vm0-ai/vm0/commit/bc54305c09f3ef75dab375bb866ec6c69d10ac4f))

## [0.723.0](https://github.com/vm0-ai/vm0/compare/app-v0.722.0...app-v0.723.0) (2026-08-10)


### Features

* add priority inheritance and gpt-5.6 fast billing ([#26147](https://github.com/vm0-ai/vm0/issues/26147)) ([3350fbb](https://github.com/vm0-ai/vm0/commit/3350fbbec7afa95483d0b051e6580fa969a50b10))


### Bug Fixes

* **onboarding:** preserve marketing entry contract ([#26181](https://github.com/vm0-ai/vm0/issues/26181)) ([99a33e8](https://github.com/vm0-ai/vm0/commit/99a33e82742003e99ff97e168a8c5059be6db36e))
* use shared button for account menu trigger ([#26188](https://github.com/vm0-ai/vm0/issues/26188)) ([b3b9698](https://github.com/vm0-ai/vm0/commit/b3b96986bef87df70de60a279bfbe20d33237773))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.310.0
    * @vm0/connectors bumped to 1.205.0
    * @vm0/core bumped to 8.541.0

## [0.722.0](https://github.com/vm0-ai/vm0/compare/app-v0.721.0...app-v0.722.0) (2026-08-10)


### Features

* support multiple personal subscription accounts ([#26166](https://github.com/vm0-ai/vm0/issues/26166)) ([74c3a15](https://github.com/vm0-ai/vm0/commit/74c3a157adb0c08b70911e43f3479b81d405e5e1))


### Bug Fixes

* **platform:** stabilize composer connector discovery ([#26174](https://github.com/vm0-ai/vm0/issues/26174)) ([9eb39fb](https://github.com/vm0-ai/vm0/commit/9eb39fbd41c5e801e6000b47a6b35414aeaefd72))


### Refactoring

* **chat:** backfill canonical event storage ([#26175](https://github.com/vm0-ai/vm0/issues/26175)) ([ec855a7](https://github.com/vm0-ai/vm0/commit/ec855a7283afd2701b2f2cc109135267e837a2a3))


### Performance Improvements

* **platform:** composite composer focus effects ([#26180](https://github.com/vm0-ai/vm0/issues/26180)) ([71e6018](https://github.com/vm0-ai/vm0/commit/71e60183229bfaf7e57f73babbacc5c5fe0d3295))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.309.0
    * @vm0/core bumped to 8.540.0

## [0.721.0](https://github.com/vm0-ai/vm0/compare/app-v0.720.0...app-v0.721.0) (2026-08-10)


### Features

* **connectors:** add streamable http mcp management ([#26124](https://github.com/vm0-ai/vm0/issues/26124)) ([78b7538](https://github.com/vm0-ai/vm0/commit/78b7538bbdf8a2ac3a754b791c51703257a0fd77))


### Refactoring

* remove insights and usage dashboards ([#26154](https://github.com/vm0-ai/vm0/issues/26154)) ([6deb1df](https://github.com/vm0-ai/vm0/commit/6deb1df698bde525de6d9b53a7b2557c932ed49a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.308.0
    * @vm0/connectors bumped to 1.204.6
    * @vm0/core bumped to 8.539.1

## [0.720.0](https://github.com/vm0-ai/vm0/compare/app-v0.719.1...app-v0.720.0) (2026-08-10)


### Features

* add bounded connector discovery ([#26142](https://github.com/vm0-ai/vm0/issues/26142)) ([16bf8c7](https://github.com/vm0-ai/vm0/commit/16bf8c7429e3ec81c3b3e489e212bf3c52ee0a03))
* **billing:** confirm concurrency changes in app ([#26116](https://github.com/vm0-ai/vm0/issues/26116)) ([b3be142](https://github.com/vm0-ai/vm0/commit/b3be1427c62066feebf8c0123111c9a418e4a153))


### Bug Fixes

* **app:** brand page metadata by hostname ([#26127](https://github.com/vm0-ai/vm0/issues/26127)) ([d9d6820](https://github.com/vm0-ai/vm0/commit/d9d6820c9417a5b7f27e6536aac3f3bdeee8d68a))
* **connectors:** separate custom connector selection from connection readiness ([#26125](https://github.com/vm0-ai/vm0/issues/26125)) ([31ae0cc](https://github.com/vm0-ai/vm0/commit/31ae0cc11b26d369cceb4b99acc3b121d1a2977b))
* **platform:** use lightning icon for fast mode ([#26138](https://github.com/vm0-ai/vm0/issues/26138)) ([85f24bf](https://github.com/vm0-ai/vm0/commit/85f24bfc9e2c95c2928c0d0b8eb4c93aec143f8d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.307.0
    * @vm0/connectors bumped to 1.204.5
    * @vm0/core bumped to 8.539.0

## [0.719.1](https://github.com/vm0-ai/vm0/compare/app-v0.719.0...app-v0.719.1) (2026-08-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.306.1
    * @vm0/core bumped to 8.538.2

## [0.719.0](https://github.com/vm0-ai/vm0/compare/app-v0.718.0...app-v0.719.0) (2026-08-10)


### Features

* **chat:** persist fast mode in user messages ([#26109](https://github.com/vm0-ai/vm0/issues/26109)) ([9ccbee2](https://github.com/vm0-ai/vm0/commit/9ccbee23ae65d2c8f5653678d2e4131fa0548a0e))
* require usage pack payment when inviting members ([#25527](https://github.com/vm0-ai/vm0/issues/25527)) ([070ff0e](https://github.com/vm0-ai/vm0/commit/070ff0ec08040bad52437e9b41dace350e806a62))


### Performance Improvements

* **platform:** eliminate idle animation paints ([#26123](https://github.com/vm0-ai/vm0/issues/26123)) ([9c2e984](https://github.com/vm0-ai/vm0/commit/9c2e984e8e4fe8f4d98dd9928bb8a73d64106fa8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.306.0
    * @vm0/core bumped to 8.538.1

## [0.718.0](https://github.com/vm0-ai/vm0/compare/app-v0.717.0...app-v0.718.0) (2026-08-10)


### Features

* animate connector catalog count ([#26083](https://github.com/vm0-ai/vm0/issues/26083)) ([78ab60d](https://github.com/vm0-ai/vm0/commit/78ab60d7622cf6174b4c1b206bf22cc0d9f6b190))


### Bug Fixes

* **app:** preserve sampled voice before silence timeout ([#26098](https://github.com/vm0-ai/vm0/issues/26098)) ([2b2af9f](https://github.com/vm0-ai/vm0/commit/2b2af9f050d8a74683caa416c8e6f5e97d589768))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.305.0
    * @vm0/core bumped to 8.538.0

## [0.717.0](https://github.com/vm0-ai/vm0/compare/app-v0.716.0...app-v0.717.0) (2026-08-10)


### Features

* manage usage pack plan and package changes ([#25510](https://github.com/vm0-ai/vm0/issues/25510)) ([88a39ab](https://github.com/vm0-ai/vm0/commit/88a39abb32bb47dacd02c308b23f5cb13d43a479))
* **runs:** accept unattended trigger sources ([#26024](https://github.com/vm0-ai/vm0/issues/26024)) ([2795cfb](https://github.com/vm0-ai/vm0/commit/2795cfb6432db3ebd3ff9cff04b06ed257e22c14))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.304.0
    * @vm0/core bumped to 8.537.0

## [0.716.0](https://github.com/vm0-ai/vm0/compare/app-v0.715.1...app-v0.716.0) (2026-08-10)


### Features

* **connectors:** add mcp-aware custom connector readers ([#26035](https://github.com/vm0-ai/vm0/issues/26035)) ([7fdc390](https://github.com/vm0-ai/vm0/commit/7fdc390989eacb3e45a7f0162ce5b7f2e8f9df34))
* persist user default model priority ([#26028](https://github.com/vm0-ai/vm0/issues/26028)) ([0b66242](https://github.com/vm0-ai/vm0/commit/0b66242b364fa14bc2691fb7b0ec8713c20ab003))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.303.0
    * @vm0/core bumped to 8.536.0

## [0.715.1](https://github.com/vm0-ai/vm0/compare/app-v0.715.0...app-v0.715.1) (2026-08-10)


### Bug Fixes

* **connectors:** align custom disconnect ownership ([#26020](https://github.com/vm0-ai/vm0/issues/26020)) ([f7b295a](https://github.com/vm0-ai/vm0/commit/f7b295ac04a89fd469df093b6f9ab4f9ecdd80d4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.302.0
    * @vm0/core bumped to 8.535.2

## [0.715.0](https://github.com/vm0-ai/vm0/compare/app-v0.714.6...app-v0.715.0) (2026-08-10)


### Features

* **platform:** move avatar voice controls into dialog header ([#25997](https://github.com/vm0-ai/vm0/issues/25997)) ([df5dd2a](https://github.com/vm0-ai/vm0/commit/df5dd2a71a3a354e68c2bb7abd4e7089ab7238a8))


### Bug Fixes

* **platform:** keep connectors stable across chat navigation ([#26014](https://github.com/vm0-ai/vm0/issues/26014)) ([f38dc9c](https://github.com/vm0-ai/vm0/commit/f38dc9cc3d27622a51d703def394a300b12a3df1))
* **ui:** put every icon on one stroke width and match paired icon colour ([#25995](https://github.com/vm0-ai/vm0/issues/25995)) ([3df271b](https://github.com/vm0-ai/vm0/commit/3df271b84226781c45da7e133c0e9343a1f5a727))

## [0.714.6](https://github.com/vm0-ai/vm0/compare/app-v0.714.5...app-v0.714.6) (2026-08-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.535.1

## [0.714.5](https://github.com/vm0-ai/vm0/compare/app-v0.714.4...app-v0.714.5) (2026-08-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.535.0

## [0.714.4](https://github.com/vm0-ai/vm0/compare/app-v0.714.3...app-v0.714.4) (2026-08-10)


### Refactoring

* **platform:** remove file-url rollout fallback ([#25955](https://github.com/vm0-ai/vm0/issues/25955)) ([de949a0](https://github.com/vm0-ai/vm0/commit/de949a07fb7ae6cd5bde1f1772da59dfe83add58))
* remove expired deployment compatibility ([#25965](https://github.com/vm0-ai/vm0/issues/25965)) ([21d6851](https://github.com/vm0-ai/vm0/commit/21d685177b914ac5b1ab27bca5d4ea64cd2d8f11))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.301.2
    * @vm0/core bumped to 8.534.2

## [0.714.3](https://github.com/vm0-ai/vm0/compare/app-v0.714.2...app-v0.714.3) (2026-08-09)


### Bug Fixes

* **platform:** carry chat card signals with rendered events ([#25908](https://github.com/vm0-ai/vm0/issues/25908)) ([88cf282](https://github.com/vm0-ai/vm0/commit/88cf282bbd66a627d3c0bba3e1ba0891ed8707cd))

## [0.714.2](https://github.com/vm0-ai/vm0/compare/app-v0.714.1...app-v0.714.2) (2026-08-09)


### Bug Fixes

* **platform:** avoid url.canparse for older ios safari ([#25945](https://github.com/vm0-ai/vm0/issues/25945)) ([51d80bb](https://github.com/vm0-ai/vm0/commit/51d80bbeb602d32c338c589de1e45cb9ad767b6a))

## [0.714.1](https://github.com/vm0-ai/vm0/compare/app-v0.714.0...app-v0.714.1) (2026-08-09)


### Refactoring

* **connectors:** remove legacy runtime compatibility ([#25941](https://github.com/vm0-ai/vm0/issues/25941)) ([e2cd0fe](https://github.com/vm0-ai/vm0/commit/e2cd0fe886dd0c903ba7322fabd93dca38d80ba0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.301.1
    * @vm0/core bumped to 8.534.1

## [0.714.0](https://github.com/vm0-ai/vm0/compare/app-v0.713.1...app-v0.714.0) (2026-08-09)


### Features

* persist and display runner reuse outcomes ([#25942](https://github.com/vm0-ai/vm0/issues/25942)) ([90f8d8f](https://github.com/vm0-ai/vm0/commit/90f8d8ffb713f7f99acd8377b8cba26a91504d0b))
* **platform:** show concurrency usage by member ([#25938](https://github.com/vm0-ai/vm0/issues/25938)) ([d78f3cc](https://github.com/vm0-ai/vm0/commit/d78f3cce54aaf0623c28a9249944bee476f93ac9))


### Bug Fixes

* **browser:** handle missing thread browser actions ([#25936](https://github.com/vm0-ai/vm0/issues/25936)) ([cb41699](https://github.com/vm0-ai/vm0/commit/cb41699af17a854d4df6319e8d35313a9d833fc1))


### Performance Improvements

* **platform:** avoid agent reload when opening picker ([#25939](https://github.com/vm0-ai/vm0/issues/25939)) ([07a502e](https://github.com/vm0-ai/vm0/commit/07a502e0915f1b9db2e0a8fe94f0ce9eae5d89b0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.301.0
    * @vm0/core bumped to 8.534.0

## [0.713.1](https://github.com/vm0-ai/vm0/compare/app-v0.713.0...app-v0.713.1) (2026-08-09)


### Bug Fixes

* **platform:** unify foreground auth recovery ([#25899](https://github.com/vm0-ai/vm0/issues/25899)) ([11cc612](https://github.com/vm0-ai/vm0/commit/11cc6121df522e77bbf196ebf3304686974b173c))


### Refactoring

* **platform:** remove activities list page ([#25926](https://github.com/vm0-ai/vm0/issues/25926)) ([3c74148](https://github.com/vm0-ai/vm0/commit/3c741482ff85826d17da0b84e62522b311e0825c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.533.3

## [0.713.0](https://github.com/vm0-ai/vm0/compare/app-v0.712.3...app-v0.713.0) (2026-08-09)


### Features

* unify conversation search results ([#25901](https://github.com/vm0-ai/vm0/issues/25901)) ([ce3cd5d](https://github.com/vm0-ai/vm0/commit/ce3cd5d2992214c49c0e98875949c9d4cf928b68))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.300.0
    * @vm0/core bumped to 8.533.2

## [0.712.3](https://github.com/vm0-ai/vm0/compare/app-v0.712.2...app-v0.712.3) (2026-08-09)


### Refactoring

* **pi:** replace handoff fallbacks with session polling ([#25906](https://github.com/vm0-ai/vm0/issues/25906)) ([66cbcad](https://github.com/vm0-ai/vm0/commit/66cbcada1c224b1c7541b6d7c90696d3733e53f8))
* **platform:** bound chat event pagination loops ([#25903](https://github.com/vm0-ai/vm0/issues/25903)) ([1bd9ecb](https://github.com/vm0-ai/vm0/commit/1bd9ecb60c8b4b98a06a954ee23a805ad56cb268))
* remove chatNextRunModelNotice feature switch ([#25907](https://github.com/vm0-ai/vm0/issues/25907)) ([9ba7b2b](https://github.com/vm0-ai/vm0/commit/9ba7b2bcfed524974d4c30bf193476a9b063cc58))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.299.1
    * @vm0/connectors bumped to 1.204.4
    * @vm0/core bumped to 8.533.1

## [0.712.2](https://github.com/vm0-ai/vm0/compare/app-v0.712.1...app-v0.712.2) (2026-08-09)


### Bug Fixes

* **platform:** keep agent chat default model cached ([#25896](https://github.com/vm0-ai/vm0/issues/25896)) ([e33b9fe](https://github.com/vm0-ai/vm0/commit/e33b9fe99ae576cd37d9f454b37e0041342a149e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.533.0

## [0.712.1](https://github.com/vm0-ai/vm0/compare/app-v0.712.0...app-v0.712.1) (2026-08-09)


### Bug Fixes

* **platform:** show model change before run reconciliation ([#25864](https://github.com/vm0-ai/vm0/issues/25864)) ([9535d4e](https://github.com/vm0-ai/vm0/commit/9535d4eafce5284585f87ad407c3908823c724d9))


### Refactoring

* **ui:** replace tabler icons with lucide ([#25852](https://github.com/vm0-ai/vm0/issues/25852)) ([ce0f2f7](https://github.com/vm0-ai/vm0/commit/ce0f2f7a14ec86850862cc7c98f1e4dd1dac191f))

## [0.712.0](https://github.com/vm0-ai/vm0/compare/app-v0.711.2...app-v0.712.0) (2026-08-09)


### Features

* **platform:** move default model action below composer ([#25855](https://github.com/vm0-ai/vm0/issues/25855)) ([35395b1](https://github.com/vm0-ai/vm0/commit/35395b15f172f92dfb94d2aa0477670317609654))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.299.0
    * @vm0/core bumped to 8.532.4

## [0.711.2](https://github.com/vm0-ai/vm0/compare/app-v0.711.1...app-v0.711.2) (2026-08-09)


### Bug Fixes

* align follow-up card rail with the composer edges ([#25849](https://github.com/vm0-ai/vm0/issues/25849)) ([3fcab9d](https://github.com/vm0-ai/vm0/commit/3fcab9dbe667e4fdac1fa4c2ada4db0c62d7274f))
* right align model change dividers ([#25851](https://github.com/vm0-ai/vm0/issues/25851)) ([89fa60b](https://github.com/vm0-ai/vm0/commit/89fa60b9dbb493d398ce10efcadf6960fb356fe8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.298.2
    * @vm0/core bumped to 8.532.3

## [0.711.1](https://github.com/vm0-ai/vm0/compare/app-v0.711.0...app-v0.711.1) (2026-08-08)


### Bug Fixes

* **connectors:** activate stable custom runtime targets ([#25806](https://github.com/vm0-ai/vm0/issues/25806)) ([d75c2d7](https://github.com/vm0-ai/vm0/commit/d75c2d70f930fe68299c3bb4d142927472fbbc48))


### Refactoring

* **chat:** finish post-contraction event cleanup ([#25818](https://github.com/vm0-ai/vm0/issues/25818)) ([83eab57](https://github.com/vm0-ai/vm0/commit/83eab57dd2f44588f200f101e0ae62e09063c8ef))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.298.1
    * @vm0/core bumped to 8.532.2

## [0.711.0](https://github.com/vm0-ai/vm0/compare/app-v0.710.0...app-v0.711.0) (2026-08-08)


### Features

* serve private chat attachments via presigned r2 urls ([#25825](https://github.com/vm0-ai/vm0/issues/25825)) ([77bd954](https://github.com/vm0-ai/vm0/commit/77bd95468d08df94b68643841055942ccb3c9c45))
* **web-chat:** gate follow-up card rail to mobile devices only ([#25829](https://github.com/vm0-ai/vm0/issues/25829)) ([a736ff9](https://github.com/vm0-ai/vm0/commit/a736ff9fb3044f303ce138a686840127c59a6235))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.298.0
    * @vm0/core bumped to 8.532.1

## [0.710.0](https://github.com/vm0-ai/vm0/compare/app-v0.709.0...app-v0.710.0) (2026-08-08)


### Features

* add responsive follow-up card rail ([#25816](https://github.com/vm0-ai/vm0/issues/25816)) ([e4643b0](https://github.com/vm0-ai/vm0/commit/e4643b020d395d6df91213bab809e283d5d4f092))


### Bug Fixes

* restore authenticated chat attachment flows ([#25815](https://github.com/vm0-ai/vm0/issues/25815)) ([08f3773](https://github.com/vm0-ai/vm0/commit/08f3773afa918104387414c2bcc82bc96236e955))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.297.1
    * @vm0/core bumped to 8.532.0

## [0.709.0](https://github.com/vm0-ai/vm0/compare/app-v0.708.2...app-v0.709.0) (2026-08-08)


### Features

* cold-start chat threads from r2 snapshots behind a switch ([#25802](https://github.com/vm0-ai/vm0/issues/25802)) ([8a9e38a](https://github.com/vm0-ai/vm0/commit/8a9e38afac1f74984d60dbea9dd61f35497c150f))
* include selected models in client chat messages ([#25809](https://github.com/vm0-ai/vm0/issues/25809)) ([ca9e914](https://github.com/vm0-ai/vm0/commit/ca9e9145c217556075496f346b7322a67eb1ada9))


### Bug Fixes

* **platform:** shorten next-run model notice ([#25808](https://github.com/vm0-ai/vm0/issues/25808)) ([64f308a](https://github.com/vm0-ai/vm0/commit/64f308a4fa564f0390a52233b5be8fba5234b777))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.297.0
    * @vm0/core bumped to 8.531.0

## [0.708.2](https://github.com/vm0-ai/vm0/compare/app-v0.708.1...app-v0.708.2) (2026-08-08)


### Bug Fixes

* **platform:** gate foreground catch-up on clerk recovery ([#25794](https://github.com/vm0-ai/vm0/issues/25794)) ([042faf4](https://github.com/vm0-ai/vm0/commit/042faf45c0c22f87022371e4861a6c56bae8631f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.296.2
    * @vm0/core bumped to 8.530.9

## [0.708.1](https://github.com/vm0-ai/vm0/compare/app-v0.708.0...app-v0.708.1) (2026-08-08)


### Bug Fixes

* **platform:** restore transient retry ownership ([#25797](https://github.com/vm0-ai/vm0/issues/25797)) ([875500a](https://github.com/vm0-ai/vm0/commit/875500abec2c0bf1a2bf7f71c8d0ff778cb83c2d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.296.1
    * @vm0/core bumped to 8.530.8

## [0.708.0](https://github.com/vm0-ai/vm0/compare/app-v0.707.2...app-v0.708.0) (2026-08-08)


### Features

* show model changes in chat history ([#25769](https://github.com/vm0-ai/vm0/issues/25769)) ([4abbd65](https://github.com/vm0-ai/vm0/commit/4abbd65dbe90c4105aad5db54c614653c7979dff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.296.0
    * @vm0/core bumped to 8.530.7

## [0.707.2](https://github.com/vm0-ai/vm0/compare/app-v0.707.1...app-v0.707.2) (2026-08-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.295.1
    * @vm0/core bumped to 8.530.6

## [0.707.1](https://github.com/vm0-ai/vm0/compare/app-v0.707.0...app-v0.707.1) (2026-08-08)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.295.0
    * @vm0/core bumped to 8.530.5

## [0.707.0](https://github.com/vm0-ai/vm0/compare/app-v0.706.4...app-v0.707.0) (2026-08-08)


### Features

* **ui:** unify hover, selected and pressed states behind one token ladder ([#25730](https://github.com/vm0-ai/vm0/issues/25730)) ([f8cf311](https://github.com/vm0-ai/vm0/commit/f8cf311a13c320a28bce328a4a1470636b2800c2))


### Bug Fixes

* **platform:** restore chat position after thread switches ([#25721](https://github.com/vm0-ai/vm0/issues/25721)) ([64502e2](https://github.com/vm0-ai/vm0/commit/64502e23db9e93672ae4f061bb289802c62922d4))


### Refactoring

* **chat:** cut over to the canonical chat-event contract ([#25768](https://github.com/vm0-ai/vm0/issues/25768)) ([057d1eb](https://github.com/vm0-ai/vm0/commit/057d1eb82aa00207347b5bbe1ec27fc817b90cbd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.294.4
    * @vm0/core bumped to 8.530.4

## [0.706.4](https://github.com/vm0-ai/vm0/compare/app-v0.706.3...app-v0.706.4) (2026-08-07)


### Refactoring

* pass abort signals explicitly ([#25740](https://github.com/vm0-ai/vm0/issues/25740)) ([8618bd0](https://github.com/vm0-ai/vm0/commit/8618bd0c05833cea17fc5191e5c6d2afe522a11f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.294.3
    * @vm0/connectors bumped to 1.204.3
    * @vm0/core bumped to 8.530.3

## [0.706.3](https://github.com/vm0-ai/vm0/compare/app-v0.706.2...app-v0.706.3) (2026-08-07)


### Refactoring

* **chat:** prepare content-based events ([#25748](https://github.com/vm0-ai/vm0/issues/25748)) ([aa5fd7b](https://github.com/vm0-ai/vm0/commit/aa5fd7b5da87a3fe21f45e54bae1d1fea9d56ab2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.294.2
    * @vm0/core bumped to 8.530.2

## [0.706.2](https://github.com/vm0-ai/vm0/compare/app-v0.706.1...app-v0.706.2) (2026-08-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.294.1
    * @vm0/core bumped to 8.530.1

## [0.706.1](https://github.com/vm0-ai/vm0/compare/app-v0.706.0...app-v0.706.1) (2026-08-07)


### Bug Fixes

* **platform:** wait for chat thread metadata before setup ([#25712](https://github.com/vm0-ai/vm0/issues/25712)) ([968decc](https://github.com/vm0-ai/vm0/commit/968decc5d046485395f52c6ed69724bea5eb0730))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.294.0
    * @vm0/core bumped to 8.530.0

## [0.706.0](https://github.com/vm0-ai/vm0/compare/app-v0.705.0...app-v0.706.0) (2026-08-07)


### Features

* **composer:** show every video parameter on inline and sent template chips ([#25715](https://github.com/vm0-ai/vm0/issues/25715)) ([313a02b](https://github.com/vm0-ai/vm0/commit/313a02ba3fa3bab6f4aa758ce3f00b07f85900f3))
* soften the dialog scrim and blur the backdrop ([#25719](https://github.com/vm0-ai/vm0/issues/25719)) ([2cde403](https://github.com/vm0-ai/vm0/commit/2cde403e644688352438534e7ca6289e40f9cf01))


### Refactoring

* **chat:** make user message parts canonical ([#25717](https://github.com/vm0-ai/vm0/issues/25717)) ([2020c27](https://github.com/vm0-ai/vm0/commit/2020c2720a08dc98f3159299bc9b6e1897351c60))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.293.1
    * @vm0/connectors bumped to 1.204.2
    * @vm0/core bumped to 8.529.1

## [0.705.0](https://github.com/vm0-ai/vm0/compare/app-v0.704.0...app-v0.705.0) (2026-08-07)


### Features

* **platform:** move avatar catalog filters into the dialog header row ([#25705](https://github.com/vm0-ai/vm0/issues/25705)) ([3e52c0d](https://github.com/vm0-ai/vm0/commit/3e52c0d2716cb0f632e4cc075eca19885b51b3de))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.293.0
    * @vm0/core bumped to 8.529.0

## [0.704.0](https://github.com/vm0-ai/vm0/compare/app-v0.703.2...app-v0.704.0) (2026-08-07)


### Features

* **platform:** add stripe invoice paid automation ui ([#25710](https://github.com/vm0-ai/vm0/issues/25710)) ([d06fa44](https://github.com/vm0-ai/vm0/commit/d06fa442830df8397740e1ef00eba1c77f686311))


### Bug Fixes

* make sent template chips static in chat history ([#25713](https://github.com/vm0-ai/vm0/issues/25713)) ([5c5fe3a](https://github.com/vm0-ai/vm0/commit/5c5fe3ab245ef388e263126e69a41facee045a2e))
* **platform:** make the shared thread page scrollable ([#25702](https://github.com/vm0-ai/vm0/issues/25702)) ([8021675](https://github.com/vm0-ai/vm0/commit/802167562a4cd38c64f9bec9e458f6ea58ba3ca2))


### Refactoring

* remove artifactSidebarInlineOpen feature switch ([#25691](https://github.com/vm0-ai/vm0/issues/25691)) ([276a21a](https://github.com/vm0-ai/vm0/commit/276a21acfecc092500a9a955918d0842d19d8507))
* remove cjk-friendly-markdown feature switch ([#25689](https://github.com/vm0-ai/vm0/issues/25689)) ([0638de8](https://github.com/vm0-ai/vm0/commit/0638de803c03b1a8baa75a718db06ec5b6ef580d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.292.0
    * @vm0/core bumped to 8.528.2

## [0.703.2](https://github.com/vm0-ai/vm0/compare/app-v0.703.1...app-v0.703.2) (2026-08-07)


### Refactoring

* **chat:** remove unread ids rollout compatibility ([#25694](https://github.com/vm0-ai/vm0/issues/25694)) ([6ba5a0c](https://github.com/vm0-ai/vm0/commit/6ba5a0cfd055ba88dcc87a0ee9b475d92d309641))
* remove the templatePickerGlobalSearch feature switch ([#25686](https://github.com/vm0-ai/vm0/issues/25686)) ([b427e71](https://github.com/vm0-ai/vm0/commit/b427e716c76ad5cfa9372ef09f52d622e6443b57))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.291.0
    * @vm0/core bumped to 8.528.1

## [0.703.1](https://github.com/vm0-ai/vm0/compare/app-v0.703.0...app-v0.703.1) (2026-08-07)


### Bug Fixes

* **platform:** make avatar filter toolbar opaque ([#25667](https://github.com/vm0-ai/vm0/issues/25667)) ([817d11f](https://github.com/vm0-ai/vm0/commit/817d11f18af82864a61a640fd29b21750a22f045))

## [0.703.0](https://github.com/vm0-ai/vm0/compare/app-v0.702.0...app-v0.703.0) (2026-08-07)


### Features

* **billing:** unify concurrency slot changes ([#25669](https://github.com/vm0-ai/vm0/issues/25669)) ([861ea6c](https://github.com/vm0-ai/vm0/commit/861ea6c027baf8449e1baeaf564cbb90e8e9a120))

## [0.702.0](https://github.com/vm0-ai/vm0/compare/app-v0.701.0...app-v0.702.0) (2026-08-07)


### Features

* **app:** let a video template chip set its generation parameters ([#25624](https://github.com/vm0-ai/vm0/issues/25624)) ([e670f1e](https://github.com/vm0-ai/vm0/commit/e670f1e45271154b726df0b3d84df1bb057b2d5b))


### Bug Fixes

* **platform:** suppress force-upgrade error toast ([#25643](https://github.com/vm0-ai/vm0/issues/25643)) ([3fb5512](https://github.com/vm0-ai/vm0/commit/3fb5512a08f462df9cb09de0d77254e9909ee385))
* restore the previous 3-block thinking indicator ([#25661](https://github.com/vm0-ai/vm0/issues/25661)) ([64fcd92](https://github.com/vm0-ai/vm0/commit/64fcd92e618c223b3bc6c7ccdf39bcad9eb016e5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.290.1
    * @vm0/core bumped to 8.528.0

## [0.701.0](https://github.com/vm0-ai/vm0/compare/app-v0.700.0...app-v0.701.0) (2026-08-07)


### Features

* **api:** carry user-chosen video parameters into the generation prompt ([#25613](https://github.com/vm0-ai/vm0/issues/25613)) ([9757fe0](https://github.com/vm0-ai/vm0/commit/9757fe07ba8fb32965ceec2fd85224eafad840f4))
* **automation:** ingest stripe invoice-paid events ([#25640](https://github.com/vm0-ai/vm0/issues/25640)) ([d046a1f](https://github.com/vm0-ai/vm0/commit/d046a1fa94647f2e21bb6519d4bc7b5687dcca70))


### Refactoring

* **platform:** disallow computed lifecycle signals ([#25651](https://github.com/vm0-ai/vm0/issues/25651)) ([34150c0](https://github.com/vm0-ai/vm0/commit/34150c0944654674d55c01e78db74e281923515f))
* remove aws connector feature switch ([#25601](https://github.com/vm0-ai/vm0/issues/25601)) ([2135473](https://github.com/vm0-ai/vm0/commit/213547353a9643da453811b77c7e9e81f26f6e3e))
* remove the structured prompt inline templates feature switch ([#25441](https://github.com/vm0-ai/vm0/issues/25441)) ([f890e58](https://github.com/vm0-ai/vm0/commit/f890e58986ddee61ab943182a4b0b84bda62e0be))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.290.0
    * @vm0/core bumped to 8.527.0

## [0.700.0](https://github.com/vm0-ai/vm0/compare/app-v0.699.1...app-v0.700.0) (2026-08-07)


### Features

* **billing:** reduce concurrency subscription quantity ([#25499](https://github.com/vm0-ai/vm0/issues/25499)) ([7372235](https://github.com/vm0-ai/vm0/commit/7372235b40a6ce826b31e1da6e779ae34651e3dd))
* replace agent thinking indicator with 3x3 ripple loader ([#25607](https://github.com/vm0-ai/vm0/issues/25607)) ([47c9970](https://github.com/vm0-ai/vm0/commit/47c9970938b8c44dcaba0f27da531c84d374d9da))


### Bug Fixes

* truncate long connector usernames in connector cards ([#25610](https://github.com/vm0-ai/vm0/issues/25610)) ([3ce7ca0](https://github.com/vm0-ai/vm0/commit/3ce7ca0a94d9178acfe97ca45ed25141e9703796))


### Refactoring

* remove ChatThreadUnifiedSearch feature switch ([#25600](https://github.com/vm0-ai/vm0/issues/25600)) ([3b6b0af](https://github.com/vm0-ai/vm0/commit/3b6b0af8818889df98b48d0713db9901b13b2e19))
* remove graduated client compatibility ([#25545](https://github.com/vm0-ai/vm0/issues/25545)) ([df2d6e9](https://github.com/vm0-ai/vm0/commit/df2d6e9a273f3d8b40f8409e79791891e46103a4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.289.0
    * @vm0/core bumped to 8.526.1

## [0.699.1](https://github.com/vm0-ai/vm0/compare/app-v0.699.0...app-v0.699.1) (2026-08-07)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.288.0
    * @vm0/connectors bumped to 1.204.1
    * @vm0/core bumped to 8.526.0

## [0.699.0](https://github.com/vm0-ai/vm0/compare/app-v0.698.1...app-v0.699.0) (2026-08-07)


### Features

* **automation:** add stripe invoice-paid binding ([#25303](https://github.com/vm0-ai/vm0/issues/25303)) ([b41a772](https://github.com/vm0-ai/vm0/commit/b41a7727d8cc3d8aa63f9e38672ebd6d5d105e4d))
* **chat:** prefetch unread and active thread events ([#25563](https://github.com/vm0-ai/vm0/issues/25563)) ([23af242](https://github.com/vm0-ai/vm0/commit/23af2422c1f9b4be544944e6cbddddc89dbeac95))


### Bug Fixes

* **platform:** preserve local edits during draft restore ([#25566](https://github.com/vm0-ai/vm0/issues/25566)) ([b6d4f07](https://github.com/vm0-ai/vm0/commit/b6d4f07a43a1a8c7f3747aed61aa83e0a454c63b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.287.0
    * @vm0/core bumped to 8.525.0

## [0.698.1](https://github.com/vm0-ai/vm0/compare/app-v0.698.0...app-v0.698.1) (2026-08-07)


### Refactoring

* remove retired compatibility contracts, routes, and schema fields ([#25540](https://github.com/vm0-ai/vm0/issues/25540)) ([67ce1c1](https://github.com/vm0-ai/vm0/commit/67ce1c11aa712b1933fd71e6653212b92996ff70))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.286.1
    * @vm0/core bumped to 8.524.7

## [0.698.0](https://github.com/vm0-ai/vm0/compare/app-v0.697.1...app-v0.698.0) (2026-08-07)


### Features

* **connectors:** support custom connector connect cards ([#25500](https://github.com/vm0-ai/vm0/issues/25500)) ([b3854b0](https://github.com/vm0-ai/vm0/commit/b3854b0164686b2d154138c1cf3c4ff0ca15c755))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.286.0
    * @vm0/core bumped to 8.524.6

## [0.697.1](https://github.com/vm0-ai/vm0/compare/app-v0.697.0...app-v0.697.1) (2026-08-07)


### Bug Fixes

* **deps:** patch js-yaml and mermaid vulnerabilities ([#25544](https://github.com/vm0-ai/vm0/issues/25544)) ([82952be](https://github.com/vm0-ai/vm0/commit/82952beef8d949ea9707b0b57d72a0180da7a932))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.285.0
    * @vm0/connectors bumped to 1.204.0
    * @vm0/core bumped to 8.524.5

## [0.697.0](https://github.com/vm0-ai/vm0/compare/app-v0.696.0...app-v0.697.0) (2026-08-06)


### Features

* **billing:** fulfill usage pack subscriptions ([#25493](https://github.com/vm0-ai/vm0/issues/25493)) ([10231ca](https://github.com/vm0-ai/vm0/commit/10231ca9eafbf86f01c81c8d58a62496ed7662e5))


### Bug Fixes

* **auth:** wait for Clerk session to settle ([#25496](https://github.com/vm0-ai/vm0/issues/25496)) ([b5fd894](https://github.com/vm0-ai/vm0/commit/b5fd894bacd6e2e5bb573375c3d177949aefe380))
* **chat:** preserve scroll across sharing transitions ([#25488](https://github.com/vm0-ai/vm0/issues/25488)) ([6074f15](https://github.com/vm0-ai/vm0/commit/6074f15ae400af62834bbe854b2634c28fa3df06))
* **platform:** render markdown emphasis that touches cjk punctuation ([#25503](https://github.com/vm0-ai/vm0/issues/25503)) ([e8d8a55](https://github.com/vm0-ai/vm0/commit/e8d8a550b4c801567369c764010ae62c5b372f75))


### Refactoring

* **artifacts:** remove catalog kind capability negotiation ([#25486](https://github.com/vm0-ai/vm0/issues/25486)) ([d244b68](https://github.com/vm0-ai/vm0/commit/d244b6862b82bbf56ff38a9462f4c6455c005fcd))
* **chat:** remove run model compatibility ([#25504](https://github.com/vm0-ai/vm0/issues/25504)) ([f49b915](https://github.com/vm0-ai/vm0/commit/f49b915ee8ed74693d6d81d3d277538331f5395e))
* remove chat thread sidebar auto-open feature switch ([#25495](https://github.com/vm0-ai/vm0/issues/25495)) ([f77001b](https://github.com/vm0-ai/vm0/commit/f77001be77e0361dce8f7506d24f0ad84b843996))
* remove customModelGateways feature switch ([#25492](https://github.com/vm0-ai/vm0/issues/25492)) ([89b8fdf](https://github.com/vm0-ai/vm0/commit/89b8fdf668d3fae06cac9fb2eb56924c7cffb78b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.284.0
    * @vm0/core bumped to 8.524.4

## [0.696.0](https://github.com/vm0-ai/vm0/compare/app-v0.695.0...app-v0.696.0) (2026-08-06)


### Features

* **chat:** persist run models in user messages ([#25467](https://github.com/vm0-ai/vm0/issues/25467)) ([64f785f](https://github.com/vm0-ai/vm0/commit/64f785f5b8a3a9bd6b802b079299bcde6b7d1100))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.283.0
    * @vm0/core bumped to 8.524.3

## [0.695.0](https://github.com/vm0-ai/vm0/compare/app-v0.694.1...app-v0.695.0) (2026-08-06)


### Features

* **billing:** update concurrency slots in existing subscription ([#25473](https://github.com/vm0-ai/vm0/issues/25473)) ([061b9ad](https://github.com/vm0-ai/vm0/commit/061b9ad443dc09738005ac3d9a8f6393449f361a))


### Bug Fixes

* **billing:** show checkout return toast after toaster mounts ([#25483](https://github.com/vm0-ai/vm0/issues/25483)) ([cbe9cd8](https://github.com/vm0-ai/vm0/commit/cbe9cd8f404bf339e2d4fdabe1b425f60bc9c879))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.282.0
    * @vm0/core bumped to 8.524.2

## [0.694.1](https://github.com/vm0-ai/vm0/compare/app-v0.694.0...app-v0.694.1) (2026-08-06)


### Refactoring

* remove custom connector feature switches ([#25449](https://github.com/vm0-ai/vm0/issues/25449)) ([f6d7788](https://github.com/vm0-ai/vm0/commit/f6d77883a45d704b34d0450105bf8693bdf36055))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.281.0
    * @vm0/core bumped to 8.524.1

## [0.694.0](https://github.com/vm0-ai/vm0/compare/app-v0.693.0...app-v0.694.0) (2026-08-06)


### Features

* **chat:** share selected conversation messages ([#25304](https://github.com/vm0-ai/vm0/issues/25304)) ([dcb3ace](https://github.com/vm0-ai/vm0/commit/dcb3acef66984b6f76c58ba04cc607bb119726c8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.280.0
    * @vm0/core bumped to 8.524.0

## [0.693.0](https://github.com/vm0-ai/vm0/compare/app-v0.692.0...app-v0.693.0) (2026-08-06)


### Features

* **billing:** add staged usage pack checkout ([#25419](https://github.com/vm0-ai/vm0/issues/25419)) ([877b7e6](https://github.com/vm0-ai/vm0/commit/877b7e672d0ff7db5076d5f4ea87262c2e34ff51))
* **chat:** steer runs near time budget ([#25384](https://github.com/vm0-ai/vm0/issues/25384)) ([c89e880](https://github.com/vm0-ai/vm0/commit/c89e880eb5d1d2d16abf1ddce921a961c78b2d31))


### Bug Fixes

* **app:** use primary Clerk portal on satellite ([#25435](https://github.com/vm0-ai/vm0/issues/25435)) ([4447a0e](https://github.com/vm0-ai/vm0/commit/4447a0e6344e4225c29ac263cfdfa4f576e948dd))
* **platform:** require complete flat artifact urls ([#25440](https://github.com/vm0-ai/vm0/issues/25440)) ([d851490](https://github.com/vm0-ai/vm0/commit/d85149058ba59c865bb6a45f5b4aac94e54bf460))


### Refactoring

* remove mermaidDiagrams feature switch ([#25430](https://github.com/vm0-ai/vm0/issues/25430)) ([b630d34](https://github.com/vm0-ai/vm0/commit/b630d3460cccae6015f58c9b041bc11330ce0e6a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.279.0
    * @vm0/core bumped to 8.523.0

## [0.692.0](https://github.com/vm0-ai/vm0/compare/app-v0.691.0...app-v0.692.0) (2026-08-06)


### Features

* **platform:** open mermaid diagrams in artifact sidebar ([#25385](https://github.com/vm0-ai/vm0/issues/25385)) ([be07422](https://github.com/vm0-ai/vm0/commit/be07422b14772efe47aee7c23e25f68a41bbf3da))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.278.0
    * @vm0/core bumped to 8.522.1

## [0.691.0](https://github.com/vm0-ai/vm0/compare/app-v0.690.0...app-v0.691.0) (2026-08-06)


### Features

* **platform:** add image canvas double-click zoom ([#25377](https://github.com/vm0-ai/vm0/issues/25377)) ([192e990](https://github.com/vm0-ai/vm0/commit/192e990f78f80b640172dad7b213c987a31e3fb6))


### Bug Fixes

* **platform:** restore short artifact previews ([#25395](https://github.com/vm0-ai/vm0/issues/25395)) ([b0dadd5](https://github.com/vm0-ai/vm0/commit/b0dadd54f83381466bb26481d1bc9ce521519d65))


### Refactoring

* remove chat steer feature switch ([#25369](https://github.com/vm0-ai/vm0/issues/25369)) ([7ef396a](https://github.com/vm0-ai/vm0/commit/7ef396a972b1937b2d345921d98bfca0051e3277))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.522.0

## [0.690.0](https://github.com/vm0-ai/vm0/compare/app-v0.689.0...app-v0.690.0) (2026-08-06)


### Features

* add managed translation command ([#25364](https://github.com/vm0-ai/vm0/issues/25364)) ([696da1d](https://github.com/vm0-ai/vm0/commit/696da1dce5263a45cea595da2622726df8410245))


### Bug Fixes

* neutralize non-allowlisted html tags at the markdown root ([#25355](https://github.com/vm0-ai/vm0/issues/25355)) ([c101465](https://github.com/vm0-ai/vm0/commit/c1014657a664620393beb2a047017755a87fa9cc))
* prevent oversized Stripe checkout return URLs ([#25376](https://github.com/vm0-ai/vm0/issues/25376)) ([f3fda2f](https://github.com/vm0-ai/vm0/commit/f3fda2f1fcfe78fd61380fe3751e4c80b606de93))
* stabilize browser fit resize lifecycle ([#25357](https://github.com/vm0-ai/vm0/issues/25357)) ([d24d8ca](https://github.com/vm0-ai/vm0/commit/d24d8ca1be3fc1021aac86dccdc9083c4d5c0dd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.277.0
    * @vm0/core bumped to 8.521.0

## [0.689.0](https://github.com/vm0-ai/vm0/compare/app-v0.688.0...app-v0.689.0) (2026-08-06)


### Features

* **platform:** add staged member usage pack pricing preview ([#25296](https://github.com/vm0-ai/vm0/issues/25296)) ([c8022f6](https://github.com/vm0-ai/vm0/commit/c8022f6a1e8ddc02426d2bca4750038f379a5d33))


### Bug Fixes

* **chat:** open avatar message templates at voice picker ([#25295](https://github.com/vm0-ai/vm0/issues/25295)) ([e2132fa](https://github.com/vm0-ai/vm0/commit/e2132faf7cac315a358ee9820bce050397071bba))


### Performance Improvements

* **python:** bound network log url serialization ([#25362](https://github.com/vm0-ai/vm0/issues/25362)) ([287c719](https://github.com/vm0-ai/vm0/commit/287c7195a97e4381ae8a15ce2555ec30c8a67177))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.276.0
    * @vm0/core bumped to 8.520.0

## [0.688.0](https://github.com/vm0-ai/vm0/compare/app-v0.687.0...app-v0.688.0) (2026-08-06)


### Features

* roll out the structured prompt inline templates switch to all users ([#25320](https://github.com/vm0-ai/vm0/issues/25320)) ([3eb8de7](https://github.com/vm0-ai/vm0/commit/3eb8de762355227d47fea1b30dab71b57a33a5ae))


### Bug Fixes

* open clerk account portal in a new tab ([#25331](https://github.com/vm0-ai/vm0/issues/25331)) ([44b0c91](https://github.com/vm0-ai/vm0/commit/44b0c919db78456c49fa04eec9b5e2a2c411acad))
* **platform:** center images in the full preview canvas ([#25321](https://github.com/vm0-ai/vm0/issues/25321)) ([7fbcfb6](https://github.com/vm0-ai/vm0/commit/7fbcfb6eb22f427a2bae51151b392f4c57b6f39d))


### Refactoring

* **api:** remove legacy artifacts list endpoint ([#25336](https://github.com/vm0-ai/vm0/issues/25336)) ([73629d3](https://github.com/vm0-ai/vm0/commit/73629d30c213ef9f39c7a9538ae6fb07cc6e582c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.275.1
    * @vm0/connectors bumped to 1.203.1
    * @vm0/core bumped to 8.519.0

## [0.687.0](https://github.com/vm0-ai/vm0/compare/app-v0.686.2...app-v0.687.0) (2026-08-06)


### Features

* roll out mermaidDiagrams to all users ([#25319](https://github.com/vm0-ai/vm0/issues/25319)) ([dae43ba](https://github.com/vm0-ai/vm0/commit/dae43ba457ac8d2da48eb2727132da06ce7a5894))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.518.0

## [0.686.2](https://github.com/vm0-ai/vm0/compare/app-v0.686.1...app-v0.686.2) (2026-08-06)


### Bug Fixes

* **auth:** skip sign-in redirects while app is hidden ([#25316](https://github.com/vm0-ai/vm0/issues/25316)) ([390c041](https://github.com/vm0-ai/vm0/commit/390c0417000ef7f78a7a460b9ef8c1be9776f452))

## [0.686.1](https://github.com/vm0-ai/vm0/compare/app-v0.686.0...app-v0.686.1) (2026-08-05)


### Refactoring

* reduce fallback slop in internal contracts ([#25314](https://github.com/vm0-ai/vm0/issues/25314)) ([ba302ae](https://github.com/vm0-ai/vm0/commit/ba302aec452be2be47ac292c4f96efcdb0d81325))

## [0.686.0](https://github.com/vm0-ai/vm0/compare/app-v0.685.4...app-v0.686.0) (2026-08-05)


### Features

* add google forms response trigger ([#25308](https://github.com/vm0-ai/vm0/issues/25308)) ([463f489](https://github.com/vm0-ai/vm0/commit/463f48920b56866b11363f5bf5f2ddd0dbe5529a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.275.0
    * @vm0/core bumped to 8.517.0

## [0.685.4](https://github.com/vm0-ai/vm0/compare/app-v0.685.3...app-v0.685.4) (2026-08-05)


### Bug Fixes

* show spinner while avatar preview loads ([#25248](https://github.com/vm0-ai/vm0/issues/25248)) ([cc19b03](https://github.com/vm0-ai/vm0/commit/cc19b0327bdf9d68981c316555ffcf8adca663f2))


### Refactoring

* remove zero browser feature switch ([#25289](https://github.com/vm0-ai/vm0/issues/25289)) ([3b859f1](https://github.com/vm0-ai/vm0/commit/3b859f1f8ed2886f2298c31d8042b7f413e6f8bd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.516.3

## [0.685.3](https://github.com/vm0-ai/vm0/compare/app-v0.685.2...app-v0.685.3) (2026-08-05)


### Refactoring

* **api:** stop projecting chat event trigger source ([#25278](https://github.com/vm0-ai/vm0/issues/25278)) ([de5898c](https://github.com/vm0-ai/vm0/commit/de5898c6a40f96535c6591ac320d8e8cf2cb35c3))
* **chat:** remove artifacts from completion events ([#25271](https://github.com/vm0-ai/vm0/issues/25271)) ([d10fe3f](https://github.com/vm0-ai/vm0/commit/d10fe3f32f119f2c3012fe6f34b88b170ba1a434))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.274.6
    * @vm0/core bumped to 8.516.2

## [0.685.2](https://github.com/vm0-ai/vm0/compare/app-v0.685.1...app-v0.685.2) (2026-08-05)


### Bug Fixes

* **chat:** show every message attachment above the bubble ([#25242](https://github.com/vm0-ai/vm0/issues/25242)) ([9668f00](https://github.com/vm0-ai/vm0/commit/9668f0006ebf5f7eeb47ce126592bf44087d03d9))
* persist automation trigger prompts in chat events ([#25249](https://github.com/vm0-ai/vm0/issues/25249)) ([26c99e1](https://github.com/vm0-ai/vm0/commit/26c99e14a4d7db973a64eee87d40080fa5be3baf))


### Refactoring

* **platform:** replace native timers with abortable signal timers ([#25250](https://github.com/vm0-ai/vm0/issues/25250)) ([e483222](https://github.com/vm0-ai/vm0/commit/e4832229c259f0a7c32718b142793054a9ef04fe))

## [0.685.1](https://github.com/vm0-ai/vm0/compare/app-v0.685.0...app-v0.685.1) (2026-08-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.274.5
    * @vm0/connectors bumped to 1.203.0
    * @vm0/core bumped to 8.516.1

## [0.685.0](https://github.com/vm0-ai/vm0/compare/app-v0.684.3...app-v0.685.0) (2026-08-05)


### Features

* **platform:** make default model selection explicit ([#25187](https://github.com/vm0-ai/vm0/issues/25187)) ([4b83c3d](https://github.com/vm0-ai/vm0/commit/4b83c3d2a01f2256fffe55e5bc0c447070fa5ca2))


### Bug Fixes

* preserve avatar catalog scroll during pagination ([#25213](https://github.com/vm0-ai/vm0/issues/25213)) ([c5dcca1](https://github.com/vm0-ai/vm0/commit/c5dcca1bacc986001ef3c734721ac3be54465927))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.274.4
    * @vm0/core bumped to 8.516.0

## [0.684.3](https://github.com/vm0-ai/vm0/compare/app-v0.684.2...app-v0.684.3) (2026-08-05)


### Refactoring

* add morning brief user message part ([#25174](https://github.com/vm0-ai/vm0/issues/25174)) ([a68b7b3](https://github.com/vm0-ai/vm0/commit/a68b7b3a97db1211a4e2f80411802f55108e191d))
* remove graduated feature switches ([#25128](https://github.com/vm0-ai/vm0/issues/25128)) ([c160b0e](https://github.com/vm0-ai/vm0/commit/c160b0e1a25a6c884a0021fc9caf61eab71e4561))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.274.3
    * @vm0/core bumped to 8.515.1

## [0.684.2](https://github.com/vm0-ai/vm0/compare/app-v0.684.1...app-v0.684.2) (2026-08-05)


### Bug Fixes

* stop the thinking indicator from scrolling mid-line ([#25097](https://github.com/vm0-ai/vm0/issues/25097)) ([032aeb3](https://github.com/vm0-ai/vm0/commit/032aeb3e8ca61c09f87bb9b460db46a778dd9482))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.274.2
    * @vm0/connectors bumped to 1.202.11
    * @vm0/core bumped to 8.515.0

## [0.684.1](https://github.com/vm0-ai/vm0/compare/app-v0.684.0...app-v0.684.1) (2026-08-05)


### Bug Fixes

* **auth:** retain organization across mobile token refresh ([#25152](https://github.com/vm0-ai/vm0/issues/25152)) ([bcd7eef](https://github.com/vm0-ai/vm0/commit/bcd7eef852b379d29fa3b344d1f7068c8ec52187))
* keep avatar selection borders consistent ([#25112](https://github.com/vm0-ai/vm0/issues/25112)) ([04dca55](https://github.com/vm0-ai/vm0/commit/04dca5523cdf579a0941b0b9a2a110f69363d43b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.274.1
    * @vm0/core bumped to 8.514.1

## [0.684.0](https://github.com/vm0-ai/vm0/compare/app-v0.683.2...app-v0.684.0) (2026-08-05)


### Features

* **platform:** show limited free model choices ([#25132](https://github.com/vm0-ai/vm0/issues/25132)) ([667807f](https://github.com/vm0-ai/vm0/commit/667807f9e39627bbe3c753371fdff06b321406ce))


### Bug Fixes

* **platform:** keep avatar artifact filter visible while loading ([#25126](https://github.com/vm0-ai/vm0/issues/25126)) ([41681df](https://github.com/vm0-ai/vm0/commit/41681df19b9bb6b2a631c17214c3bc734445457d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.274.0
    * @vm0/core bumped to 8.514.0

## [0.683.2](https://github.com/vm0-ai/vm0/compare/app-v0.683.1...app-v0.683.2) (2026-08-05)


### Refactoring

* stop mirroring org slugs ([#25129](https://github.com/vm0-ai/vm0/issues/25129)) ([2739047](https://github.com/vm0-ai/vm0/commit/2739047684009e2a300c88b0d1ce204b6b31fbf1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.273.2
    * @vm0/core bumped to 8.513.0

## [0.683.1](https://github.com/vm0-ai/vm0/compare/app-v0.683.0...app-v0.683.1) (2026-08-05)


### Refactoring

* decouple composer signals and remove internal re-exports ([#25054](https://github.com/vm0-ai/vm0/issues/25054)) ([a5d80a1](https://github.com/vm0-ai/vm0/commit/a5d80a1127cb7533ad763b1f5d22e9fa562afd03))
* **platform:** remove legacy permission agent reload ([#25096](https://github.com/vm0-ai/vm0/issues/25096)) ([5433a67](https://github.com/vm0-ai/vm0/commit/5433a6702f4e986d21f7b2f9b9e29c959d2b039e))
* remove zero chat messaging feature switch ([#25101](https://github.com/vm0-ai/vm0/issues/25101)) ([6a6cf24](https://github.com/vm0-ai/vm0/commit/6a6cf24df6b4beeba0d1a95f732c4f52c6b939aa))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.273.1
    * @vm0/connectors bumped to 1.202.10
    * @vm0/core bumped to 8.512.1

## [0.683.0](https://github.com/vm0-ai/vm0/compare/app-v0.682.0...app-v0.683.0) (2026-08-05)


### Features

* **core:** enable zero chat messaging globally ([#25093](https://github.com/vm0-ai/vm0/issues/25093)) ([76c4a9e](https://github.com/vm0-ai/vm0/commit/76c4a9edf14808ddab0a85c8f94ab61cf07c27b5))
* simplify models for limited free workspaces ([#25066](https://github.com/vm0-ai/vm0/issues/25066)) ([831de16](https://github.com/vm0-ai/vm0/commit/831de1612cb1a7012eafea8a85cfd4bededbf8e5))


### Bug Fixes

* fold completed work by user phase ([#25095](https://github.com/vm0-ai/vm0/issues/25095)) ([0d14c9b](https://github.com/vm0-ai/vm0/commit/0d14c9bf4f9f58eb3cda8cb7a88ed0d67364eb7a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.273.0
    * @vm0/connectors bumped to 1.202.9
    * @vm0/core bumped to 8.512.0

## [0.682.0](https://github.com/vm0-ai/vm0/compare/app-v0.681.1...app-v0.682.0) (2026-08-04)


### Features

* annotate cross-thread agent prompts and bound autonomous delegation depth ([#24934](https://github.com/vm0-ai/vm0/issues/24934)) ([2f2c72a](https://github.com/vm0-ai/vm0/commit/2f2c72af84481a07844bda1eb78fc73612cec3f2))


### Bug Fixes

* **attribution:** carry ga4 client ids into checkout ([#25081](https://github.com/vm0-ai/vm0/issues/25081)) ([926523f](https://github.com/vm0-ai/vm0/commit/926523f492ab51186ae8703d6cc541268aa52d57))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.272.0
    * @vm0/connectors bumped to 1.202.8
    * @vm0/core bumped to 8.511.0

## [0.681.1](https://github.com/vm0-ai/vm0/compare/app-v0.681.0...app-v0.681.1) (2026-08-04)


### Bug Fixes

* hide rejected goal continuations ([#25064](https://github.com/vm0-ai/vm0/issues/25064)) ([aa4e864](https://github.com/vm0-ai/vm0/commit/aa4e86432b43ba71197ed9967bb0926821f7f11d))


### Refactoring

* **api:** remove image recognition rollout compatibility ([#25060](https://github.com/vm0-ai/vm0/issues/25060)) ([84db44c](https://github.com/vm0-ai/vm0/commit/84db44c09aca6e780baf1bb839c2b49ca9e552b7))
* canonicalize deepseek model provider ([#25030](https://github.com/vm0-ai/vm0/issues/25030)) ([c19ea0f](https://github.com/vm0-ai/vm0/commit/c19ea0fa2d196143ab899db3953904c814e2b016))
* retire the zero org command group and unreachable secret and variable apis ([#25039](https://github.com/vm0-ai/vm0/issues/25039)) ([305ca0d](https://github.com/vm0-ai/vm0/commit/305ca0dc0a3a6b149c118b9d8559b233abfffef5)), closes [#25011](https://github.com/vm0-ai/vm0/issues/25011)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.271.0
    * @vm0/core bumped to 8.510.1

## [0.681.0](https://github.com/vm0-ai/vm0/compare/app-v0.680.0...app-v0.681.0) (2026-08-04)


### Features

* add avatar templates to chat composer ([#24959](https://github.com/vm0-ai/vm0/issues/24959)) ([702edfd](https://github.com/vm0-ai/vm0/commit/702edfd9634454d0f45a464051fceba966a15c4b))
* **api:** bill managed image tasks under task-scoped usage kinds ([#25033](https://github.com/vm0-ai/vm0/issues/25033)) ([6d5496f](https://github.com/vm0-ai/vm0/commit/6d5496f0ffaa221b611fa9461a839313fdeb553d))
* **chat:** add feature-gated inline steering ([#24941](https://github.com/vm0-ai/vm0/issues/24941)) ([f705e9d](https://github.com/vm0-ai/vm0/commit/f705e9d8d1a1038055d62839ce0bb3725edbd2e3))
* restore GitHub integration to works ([#25048](https://github.com/vm0-ai/vm0/issues/25048)) ([e760cc7](https://github.com/vm0-ai/vm0/commit/e760cc72816233e19d83d70d1e091e66d8f8c688))


### Refactoring

* **mail:** remove reply follow-up action ([#25007](https://github.com/vm0-ai/vm0/issues/25007)) ([a8d080b](https://github.com/vm0-ai/vm0/commit/a8d080b1e8a1ece731a7e40f63abc4348edd0221))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.270.0
    * @vm0/core bumped to 8.510.0

## [0.680.0](https://github.com/vm0-ai/vm0/compare/app-v0.679.3...app-v0.680.0) (2026-08-04)


### Features

* **platform:** give mermaid diagrams a fixed-size box ([#24950](https://github.com/vm0-ai/vm0/issues/24950)) ([ea09aa4](https://github.com/vm0-ai/vm0/commit/ea09aa4ce420a2353eadb24df09ab9cf7c598eb6))


### Refactoring

* stop showing org slugs and drop dead slug payloads ([#25008](https://github.com/vm0-ai/vm0/issues/25008)) ([9676511](https://github.com/vm0-ai/vm0/commit/9676511282db6694e300e1a8fa4a40bb5c5d1e41))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.269.2
    * @vm0/core bumped to 8.509.1

## [0.679.3](https://github.com/vm0-ai/vm0/compare/app-v0.679.2...app-v0.679.3) (2026-08-04)


### Bug Fixes

* **platform:** make browser session viewer full page ([#25006](https://github.com/vm0-ai/vm0/issues/25006)) ([00f8660](https://github.com/vm0-ai/vm0/commit/00f86603a3e5b4f03588057a47d9788ea5044b71))


### Refactoring

* **org:** confirm workspace deletion with a literal and drop the cli delete command ([#25002](https://github.com/vm0-ai/vm0/issues/25002)) ([1a21a62](https://github.com/vm0-ai/vm0/commit/1a21a628d642e86840ee3739ccb86fcbffd8dd02))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.269.1
    * @vm0/core bumped to 8.509.0

## [0.679.2](https://github.com/vm0-ai/vm0/compare/app-v0.679.1...app-v0.679.2) (2026-08-04)


### Bug Fixes

* **platform:** preserve connector access spacing ([#24960](https://github.com/vm0-ai/vm0/issues/24960)) ([02c3cc1](https://github.com/vm0-ai/vm0/commit/02c3cc1871bfa102c4749f18d29f955dc7861049))


### Refactoring

* **platform:** compose chat panels from shared event signals ([#24954](https://github.com/vm0-ai/vm0/issues/24954)) ([472b7bc](https://github.com/vm0-ai/vm0/commit/472b7bca63366d4fe90c519691dd1eb8b41cfd81))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.269.0
    * @vm0/core bumped to 8.508.2

## [0.679.1](https://github.com/vm0-ai/vm0/compare/app-v0.679.0...app-v0.679.1) (2026-08-04)


### Bug Fixes

* **platform:** wait for voice input before sending ([#24956](https://github.com/vm0-ai/vm0/issues/24956)) ([97e4fc1](https://github.com/vm0-ai/vm0/commit/97e4fc1f62553d20b7c577ec4a2910aa643f6d14))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.268.0
    * @vm0/core bumped to 8.508.1

## [0.679.0](https://github.com/vm0-ai/vm0/compare/app-v0.678.5...app-v0.679.0) (2026-08-04)


### Features

* refine browser sidebar lifecycle ([#24852](https://github.com/vm0-ai/vm0/issues/24852)) ([498ecb5](https://github.com/vm0-ai/vm0/commit/498ecb5e1da3c3ff517b6322403b6eb59e06fe91))


### Bug Fixes

* **platform:** simplify feishu bot setup guidance ([#24899](https://github.com/vm0-ai/vm0/issues/24899)) ([289ad2b](https://github.com/vm0-ai/vm0/commit/289ad2b41edca258efe24d66d8792f0b6b62dca5))


### Refactoring

* retire zero run trigger agent provenance ([#24929](https://github.com/vm0-ai/vm0/issues/24929)) ([6eb4009](https://github.com/vm0-ai/vm0/commit/6eb400938c00f60f3b4da0b356ac3ff5b8402061))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.267.0
    * @vm0/core bumped to 8.508.0

## [0.678.5](https://github.com/vm0-ai/vm0/compare/app-v0.678.4...app-v0.678.5) (2026-08-04)


### Bug Fixes

* **platform:** render mermaid diagrams only once their fence closes ([#24659](https://github.com/vm0-ai/vm0/issues/24659)) ([a91d7d7](https://github.com/vm0-ai/vm0/commit/a91d7d7caab8103c64556ddb78c650150784f161))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.266.1
    * @vm0/core bumped to 8.507.1

## [0.678.4](https://github.com/vm0-ai/vm0/compare/app-v0.678.3...app-v0.678.4) (2026-08-04)


### Bug Fixes

* **platform:** separate cloud browser from your computer in connector menu ([#24876](https://github.com/vm0-ai/vm0/issues/24876)) ([26bfa1f](https://github.com/vm0-ai/vm0/commit/26bfa1f35ea4976988ac1deacd55f13d6fa789e3))

## [0.678.3](https://github.com/vm0-ai/vm0/compare/app-v0.678.2...app-v0.678.3) (2026-08-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.507.0

## [0.678.2](https://github.com/vm0-ai/vm0/compare/app-v0.678.1...app-v0.678.2) (2026-08-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.266.0
    * @vm0/connectors bumped to 1.202.7
    * @vm0/core bumped to 8.506.1

## [0.678.1](https://github.com/vm0-ai/vm0/compare/app-v0.678.0...app-v0.678.1) (2026-08-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.265.1
    * @vm0/core bumped to 8.506.0

## [0.678.0](https://github.com/vm0-ai/vm0/compare/app-v0.677.1...app-v0.678.0) (2026-08-03)


### Features

* **chat:** steer queued messages into active runs ([#24768](https://github.com/vm0-ai/vm0/issues/24768)) ([20e5855](https://github.com/vm0-ai/vm0/commit/20e5855c729bea0db9f7f4a2e3914b2adf4c26dd))


### Bug Fixes

* **platform:** scope browser cards to chat threads ([#24793](https://github.com/vm0-ai/vm0/issues/24793)) ([9d6583b](https://github.com/vm0-ai/vm0/commit/9d6583bb41e9aef9c9bf20f7d77a85873b6cbee3))
* restrict run group ids to goals ([#24697](https://github.com/vm0-ai/vm0/issues/24697)) ([d7ef99d](https://github.com/vm0-ai/vm0/commit/d7ef99d9514f71434bf0239e3e9cd855328cfbd7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.265.0
    * @vm0/core bumped to 8.505.0

## [0.677.1](https://github.com/vm0-ai/vm0/compare/app-v0.677.0...app-v0.677.1) (2026-08-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.264.1
    * @vm0/core bumped to 8.504.1

## [0.677.0](https://github.com/vm0-ai/vm0/compare/app-v0.676.1...app-v0.677.0) (2026-08-03)


### Features

* **browser:** persist browser session screenshots ([#24667](https://github.com/vm0-ai/vm0/issues/24667)) ([3c8faad](https://github.com/vm0-ai/vm0/commit/3c8faadaeef149d2db77910b4a7d1b4547cd4d0d))
* **core:** enable custom connector features globally ([#24696](https://github.com/vm0-ai/vm0/issues/24696)) ([7ccc87b](https://github.com/vm0-ai/vm0/commit/7ccc87bcfb0e2f51e88dad0fbd64b3bd957ac088))
* **platform:** follow chat content growth back to the tail ([#24658](https://github.com/vm0-ai/vm0/issues/24658)) ([3ad2efd](https://github.com/vm0-ai/vm0/commit/3ad2efdfd149ace542f429bc112a9cbdcd2019fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.264.0
    * @vm0/core bumped to 8.504.0

## [0.676.1](https://github.com/vm0-ai/vm0/compare/app-v0.676.0...app-v0.676.1) (2026-08-03)


### Bug Fixes

* **platform:** allow feature-gated visual attachments ([#24642](https://github.com/vm0-ai/vm0/issues/24642)) ([cca8c69](https://github.com/vm0-ai/vm0/commit/cca8c692ecf4f074d9327064da6d1411c116cc59))
* **platform:** keep chat autoscroll following the tail after late growth ([#24651](https://github.com/vm0-ai/vm0/issues/24651)) ([8b17e1b](https://github.com/vm0-ai/vm0/commit/8b17e1b1014267bad15ba151db21e4458811902e))
* stabilize segmented voice transcription ([#24689](https://github.com/vm0-ai/vm0/issues/24689)) ([647e207](https://github.com/vm0-ai/vm0/commit/647e20737f71596b422653f5233396ba2043aea4))


### Refactoring

* remove graduated composer and slack switches ([#24692](https://github.com/vm0-ai/vm0/issues/24692)) ([6634fc0](https://github.com/vm0-ai/vm0/commit/6634fc03fc79cb0439b3242ffaaa1e4817774eb8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.263.1
    * @vm0/core bumped to 8.503.1

## [0.676.0](https://github.com/vm0-ai/vm0/compare/app-v0.675.13...app-v0.676.0) (2026-08-03)


### Features

* **feishu:** add managed connector permission controls ([#24344](https://github.com/vm0-ai/vm0/issues/24344)) ([49d167d](https://github.com/vm0-ai/vm0/commit/49d167da75e79c360fd4f7baf59032b49ba6776d))


### Bug Fixes

* allow overriding every feature switch ([#24632](https://github.com/vm0-ai/vm0/issues/24632)) ([d428036](https://github.com/vm0-ai/vm0/commit/d428036e06a2a2589129a3599d671f188b5a05c1))
* use redux themes for mermaid diagrams ([#24628](https://github.com/vm0-ai/vm0/issues/24628)) ([a0c056e](https://github.com/vm0-ai/vm0/commit/a0c056edafe7d25e77f344b08f44a3b5d8ad8336))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.263.0
    * @vm0/core bumped to 8.503.0

## [0.675.13](https://github.com/vm0-ai/vm0/compare/app-v0.675.12...app-v0.675.13) (2026-08-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.262.0
    * @vm0/core bumped to 8.502.9

## [0.675.12](https://github.com/vm0-ai/vm0/compare/app-v0.675.11...app-v0.675.12) (2026-08-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.261.8
    * @vm0/connectors bumped to 1.202.6
    * @vm0/core bumped to 8.502.8

## [0.675.11](https://github.com/vm0-ai/vm0/compare/app-v0.675.10...app-v0.675.11) (2026-08-02)


### Refactoring

* move chat composer state into signals ([#24441](https://github.com/vm0-ai/vm0/issues/24441)) ([d6647b7](https://github.com/vm0-ai/vm0/commit/d6647b76063b5897aa0901c0414f06d346f277c0))
* **runner:** treat invalid resume sessions as pre-reuse failures ([#24568](https://github.com/vm0-ai/vm0/issues/24568)) ([a3e789f](https://github.com/vm0-ai/vm0/commit/a3e789f626155acb7f3fe280aa4fe60f4579f103))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.261.7
    * @vm0/core bumped to 8.502.7

## [0.675.10](https://github.com/vm0-ai/vm0/compare/app-v0.675.9...app-v0.675.10) (2026-08-02)


### Bug Fixes

* accept distinct sandbox reuse result reasons ([#24556](https://github.com/vm0-ai/vm0/issues/24556)) ([a1bfbf8](https://github.com/vm0-ai/vm0/commit/a1bfbf883e98fca8a557cb1cf45d4bee85d0a552))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.261.6
    * @vm0/core bumped to 8.502.6

## [0.675.9](https://github.com/vm0-ai/vm0/compare/app-v0.675.8...app-v0.675.9) (2026-08-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.261.5
    * @vm0/core bumped to 8.502.5

## [0.675.8](https://github.com/vm0-ai/vm0/compare/app-v0.675.7...app-v0.675.8) (2026-08-02)


### Refactoring

* dual-write agentphone launch context ([#24523](https://github.com/vm0-ai/vm0/issues/24523)) ([16e456c](https://github.com/vm0-ai/vm0/commit/16e456c19e73b6816297f64cb70ef3b1fa56d80b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.261.4
    * @vm0/core bumped to 8.502.4

## [0.675.7](https://github.com/vm0-ai/vm0/compare/app-v0.675.6...app-v0.675.7) (2026-08-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.261.3
    * @vm0/connectors bumped to 1.202.5
    * @vm0/core bumped to 8.502.3

## [0.675.6](https://github.com/vm0-ai/vm0/compare/app-v0.675.5...app-v0.675.6) (2026-08-01)


### Bug Fixes

* **platform:** stack preference setting rows on narrow screens ([#24473](https://github.com/vm0-ai/vm0/issues/24473)) ([1e1657c](https://github.com/vm0-ai/vm0/commit/1e1657cb369ef4889c0fb68ae39a2cece4b40073))

## [0.675.5](https://github.com/vm0-ai/vm0/compare/app-v0.675.4...app-v0.675.5) (2026-08-01)


### Refactoring

* **connectors:** finish local slug terminology cleanup ([#24472](https://github.com/vm0-ai/vm0/issues/24472)) ([c3000d8](https://github.com/vm0-ai/vm0/commit/c3000d888cf153dc57208c91e69097bdea400a56))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.261.2
    * @vm0/connectors bumped to 1.202.4
    * @vm0/core bumped to 8.502.2

## [0.675.4](https://github.com/vm0-ai/vm0/compare/app-v0.675.3...app-v0.675.4) (2026-08-01)


### Refactoring

* **connectors:** finish slug terminology cleanup ([#24437](https://github.com/vm0-ai/vm0/issues/24437)) ([52f9935](https://github.com/vm0-ai/vm0/commit/52f99350a1d1e171054d8751e8da8b20b6f0ee15))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.261.1
    * @vm0/core bumped to 8.502.1

## [0.675.3](https://github.com/vm0-ai/vm0/compare/app-v0.675.2...app-v0.675.3) (2026-08-01)


### Bug Fixes

* trigger api platform and runner releases ([#24389](https://github.com/vm0-ai/vm0/issues/24389)) ([5e32b07](https://github.com/vm0-ai/vm0/commit/5e32b07956572689916ff1348deab37be627ab0f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/api-contracts bumped to 1.261.0
    * @vm0/core bumped to 8.502.0

## [0.675.2](https://github.com/vm0-ai/vm0/compare/app-v0.675.1...app-v0.675.2) (2026-08-01)


### Refactoring

* remove DeepSeek V4 Flash feature switch ([#24411](https://github.com/vm0-ai/vm0/issues/24411)) ([e589e06](https://github.com/vm0-ai/vm0/commit/e589e0624d057086451eccac56d20302f6754a5d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.501.1
