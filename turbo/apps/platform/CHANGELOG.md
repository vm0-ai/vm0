# Changelog

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
