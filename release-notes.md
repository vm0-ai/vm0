:robot: I have created a release *beep* *boop*
---


<details><summary>api-contracts: 1.363.0</summary>

## [1.363.0](https://github.com/vm0-ai/vm0/compare/api-contracts-v1.362.0...api-contracts-v1.363.0) (2026-08-25)


### Features

* add flux.2 pro and ideogram 4 ([#28640](https://github.com/vm0-ai/vm0/issues/28640)) ([7022170](https://github.com/vm0-ai/vm0/commit/7022170536a28805f6cbcb7e625e84755552b898))
* add qwen image 3 and nano banana 2 lite built-in image models ([#28518](https://github.com/vm0-ai/vm0/issues/28518)) ([9691fc3](https://github.com/vm0-ai/vm0/commit/9691fc30b999724efd07d2d82c384c47ff59c150))
* **agentphone:** decouple provider identity from public brand ([#28953](https://github.com/vm0-ai/vm0/issues/28953)) ([e7fcd06](https://github.com/vm0-ai/vm0/commit/e7fcd06ba2647f55d8a83e7e94be2ed066b74a97))
* annotate an attached image in the composer ([#28976](https://github.com/vm0-ai/vm0/issues/28976)) ([19096b6](https://github.com/vm0-ai/vm0/commit/19096b6c2ef65e8d885cbadbf0f6f7cc81ef4508))
* **api:** add explicit single-account connector intent ([#28597](https://github.com/vm0-ai/vm0/issues/28597)) ([67b73e4](https://github.com/vm0-ai/vm0/commit/67b73e43e2b58ca976542aadd4ade39848df4055))
* **api:** add managed model fallback resolver ([#28301](https://github.com/vm0-ai/vm0/issues/28301)) ([745a08f](https://github.com/vm0-ai/vm0/commit/745a08fa51b6b0b51208fae1a02ec599664be115))
* **api:** add managed model provider failure endpoint ([#28451](https://github.com/vm0-ai/vm0/issues/28451)) ([238a43a](https://github.com/vm0-ai/vm0/commit/238a43a6dc281b65e06a212fbd5203d82b5f5cf6))
* **api:** add managed socialkit service ([#28343](https://github.com/vm0-ai/vm0/issues/28343)) ([94f6768](https://github.com/vm0-ai/vm0/commit/94f67682a19fd19310449075a7cf9bcf40e5a52f))
* **api:** add safe single-account connector disconnect ([#28598](https://github.com/vm0-ai/vm0/issues/28598)) ([a231b7b](https://github.com/vm0-ai/vm0/commit/a231b7b09db3abe563358dafac2ccaa2b2cb26d0))
* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))
* **api:** persist explicit thread connector account overrides ([#28355](https://github.com/vm0-ai/vm0/issues/28355)) ([772de1c](https://github.com/vm0-ai/vm0/commit/772de1c01b70948fb41c07e3db4e5c6e7a01cada))
* **api:** publish an analysed deck as a presentation template ([#28298](https://github.com/vm0-ai/vm0/issues/28298)) ([2080670](https://github.com/vm0-ai/vm0/commit/20806707e9adbcd9bd87043976d8327dc36a4f69))
* **artifacts:** emit branded cdn urls ([#28411](https://github.com/vm0-ai/vm0/issues/28411)) ([9dd558f](https://github.com/vm0-ai/vm0/commit/9dd558f3043a5ffdf72627fa367ae8750be3e86d))
* **banking:** add chat-based mastercard connect flow ([#28832](https://github.com/vm0-ai/vm0/issues/28832)) ([faf1021](https://github.com/vm0-ai/vm0/commit/faf10210ffc1a956a1c3f077e3410bcc27ae4cb8))
* **connectors:** enable multi-account lifecycle ([#28519](https://github.com/vm0-ai/vm0/issues/28519)) ([c5926f2](https://github.com/vm0-ai/vm0/commit/c5926f2a383dded86f8e67d9fc413817879fa75c))
* **feishu:** preserve host-derived public branding ([#28935](https://github.com/vm0-ai/vm0/issues/28935)) ([bbb60c7](https://github.com/vm0-ai/vm0/commit/bbb60c70fb46dcc1ca6a15694de0770edba98c95))
* **github:** preserve public brand across app ingress ([#28942](https://github.com/vm0-ai/vm0/issues/28942)) ([3d4bdf6](https://github.com/vm0-ai/vm0/commit/3d4bdf623e7694804ea244ce5eed0557c4c567f4))
* let staff cancel built-in model cooldowns ([#29142](https://github.com/vm0-ai/vm0/issues/29142)) ([d0ab9d6](https://github.com/vm0-ai/vm0/commit/d0ab9d6c8534491a06878c9d705f726e440cb4c5)), closes [#29121](https://github.com/vm0-ai/vm0/issues/29121)
* **platform:** add multi-account connector settings ([#28904](https://github.com/vm0-ai/vm0/issues/28904)) ([e8d0c2a](https://github.com/vm0-ai/vm0/commit/e8d0c2acb679ccd23b218a694aaf1a6893f97791))
* **platform:** offer nano banana 2 lite and price tiers for media models ([#28674](https://github.com/vm0-ai/vm0/issues/28674)) ([dc7962c](https://github.com/vm0-ai/vm0/commit/dc7962c9c51e8e74cab94eb39af89ab31e68fd4b))
* **platform:** show managed model cooldown diagnostics ([#28733](https://github.com/vm0-ai/vm0/issues/28733)) ([f86c836](https://github.com/vm0-ai/vm0/commit/f86c836c2f5275ca97b288a757a3d5e118ca0566))
* show runtime model routes in activity diagnostics ([#28866](https://github.com/vm0-ai/vm0/issues/28866)) ([f9e7acc](https://github.com/vm0-ai/vm0/commit/f9e7acc8a26b9bcf7fc13fd094a3acf05562015d))
* **slack:** migrate official app to okou ([#28795](https://github.com/vm0-ai/vm0/issues/28795)) ([57d1a9f](https://github.com/vm0-ai/vm0/commit/57d1a9f500272b2b8214462fcbc640528103dd8f))
* **social:** add managed socialkit pagination and usage billing ([#29180](https://github.com/vm0-ai/vm0/issues/29180)) ([72a60ca](https://github.com/vm0-ai/vm0/commit/72a60ca0aa52e611cc544eb4d7062581fc498106))
* support workspace presentation templates ([#28596](https://github.com/vm0-ai/vm0/issues/28596)) ([f25dbbb](https://github.com/vm0-ai/vm0/commit/f25dbbbae2aae3546070a36eaeead062ec563ee7))
* **teams:** separate provider identity from public brand ([#28938](https://github.com/vm0-ai/vm0/issues/28938)) ([6e717c5](https://github.com/vm0-ai/vm0/commit/6e717c58fad35281b0e30e296ea135ed9487d363))
* **telegram:** support dual-brand ingress ([#28945](https://github.com/vm0-ai/vm0/issues/28945)) ([c5f6b87](https://github.com/vm0-ai/vm0/commit/c5f6b87adc0ba25a73bddd595d5740360fd32d0d))


### Bug Fixes

* **api-contracts:** declare billing checkout preview in the okou namespace ([#28353](https://github.com/vm0-ai/vm0/issues/28353)) ([6bc9e94](https://github.com/vm0-ai/vm0/commit/6bc9e94e3d332dd05abe27ad88e70455abc3f34c)), closes [#28350](https://github.com/vm0-ai/vm0/issues/28350)
* **api:** disable unsupported openrouter deepseek apply patch ([#28656](https://github.com/vm0-ai/vm0/issues/28656)) ([4cffdec](https://github.com/vm0-ai/vm0/commit/4cffdec2f1d080c2147ca134d80eabf65de023ea))
* **api:** harden usage pack purchase billing ([#28304](https://github.com/vm0-ai/vm0/issues/28304)) ([17ba3cd](https://github.com/vm0-ai/vm0/commit/17ba3cdfd57c8c980dedab902c2ed49ed51d0a4f))
* **billing:** support fully discounted usage pack purchases ([#28392](https://github.com/vm0-ai/vm0/issues/28392)) ([618645c](https://github.com/vm0-ai/vm0/commit/618645c51eae8aa9df3ac3766f770a45d94d3390))
* **connectors:** handle removed catalog references ([#28450](https://github.com/vm0-ai/vm0/issues/28450)) ([17d96ad](https://github.com/vm0-ai/vm0/commit/17d96ad7f324571e121833ed6c6e15b13258158f))
* **connectors:** simplify multi-account settings interactions ([#29094](https://github.com/vm0-ai/vm0/issues/29094)) ([023b916](https://github.com/vm0-ai/vm0/commit/023b916626ff1488f54ed6c5d10658fbf0f34e7c))
* **guest:** isolate managed claude config from user home ([#28324](https://github.com/vm0-ai/vm0/issues/28324)) ([c6a20ba](https://github.com/vm0-ai/vm0/commit/c6a20babf5f75ffac7ac97f69c570ba1ddb2ef23))
* handle revoked claude code oauth tokens ([#29181](https://github.com/vm0-ai/vm0/issues/29181)) ([fefb3c9](https://github.com/vm0-ai/vm0/commit/fefb3c9a1a46d6239f9646b2280054e1ee133687))
* prefetch uploaded template previews ([#28705](https://github.com/vm0-ai/vm0/issues/28705)) ([e17447c](https://github.com/vm0-ai/vm0/commit/e17447c69a398ee38598b00beeb791483482f841))
* **rebranding:** neutralize agent-facing brand copy ([#29167](https://github.com/vm0-ai/vm0/issues/29167)) ([d1a4cc6](https://github.com/vm0-ai/vm0/commit/d1a4cc63dfc912c36e636315772d9353ee190334))
* revise chat usage after late settlement ([#28378](https://github.com/vm0-ai/vm0/issues/28378)) ([21ca637](https://github.com/vm0-ai/vm0/commit/21ca637a2975b12d44aa1dce9d62633e89fb0556))
* **runner:** bound firewall catalog response bodies ([#28399](https://github.com/vm0-ai/vm0/issues/28399)) ([1732568](https://github.com/vm0-ai/vm0/commit/17325687f4950e089ce565d1e33737b5822b19be))
* sync workspace presentation templates without picker flicker ([#29054](https://github.com/vm0-ai/vm0/issues/29054)) ([0309fcb](https://github.com/vm0-ai/vm0/commit/0309fcb9dd1c15a3c7138df003cc28d10286e1de))
* **usage:** bound model usage quantities ([#28351](https://github.com/vm0-ai/vm0/issues/28351)) ([d91265c](https://github.com/vm0-ai/vm0/commit/d91265c8761b3c40eb7e91a8ac6bcfaa0bdad4f8))


### Refactoring

* **api:** make connector authorization state writers explicit ([#28731](https://github.com/vm0-ai/vm0/issues/28731)) ([7e2222b](https://github.com/vm0-ai/vm0/commit/7e2222b56632c337a62328b924315e530df98f8e))
* **api:** migrate the late branded contracts and guard the namespace ([#28577](https://github.com/vm0-ai/vm0/issues/28577)) ([d568056](https://github.com/vm0-ai/vm0/commit/d5680566144451411311656dd5a3c6c0bb312f02))
* **api:** move agents, workflows, and workflow automations off the brand namespace ([#28497](https://github.com/vm0-ai/vm0/issues/28497)) ([ee1f56f](https://github.com/vm0-ai/vm0/commit/ee1f56f9a4994b5b6978e6e8515fdbe9df9e6970))
* **api:** move artifact catalog, logs, and run reads off the brand namespace ([#28435](https://github.com/vm0-ai/vm0/issues/28435)) ([fa800f0](https://github.com/vm0-ai/vm0/commit/fa800f04ec58ad7835649b2acc6000b8538154c5))
* **api:** move browser, finance, seo, and mcp connector routes off /api/okou ([#28433](https://github.com/vm0-ai/vm0/issues/28433)) ([1e4bdf3](https://github.com/vm0-ai/vm0/commit/1e4bdf3432ab0e27ae70da59abacdf4d74c14b60))
* **api:** move built-in-generations and image-io off the brand namespace ([#28432](https://github.com/vm0-ai/vm0/issues/28432)) ([d1c6c7c](https://github.com/vm0-ai/vm0/commit/d1c6c7c9d2b29af4c95949661fd9bcbd5359df54))
* **api:** move chat threads, chat events, and shared threads off the brand namespace ([#28471](https://github.com/vm0-ai/vm0/issues/28471)) ([6c2036f](https://github.com/vm0-ai/vm0/commit/6c2036fa7e5f02e01cf163ab1a515364e8ec29d8))
* **api:** move chat-thread, indicator and attribution routes off the brand namespace ([#28425](https://github.com/vm0-ai/vm0/issues/28425)) ([f0bf52e](https://github.com/vm0-ai/vm0/commit/f0bf52eb50e5f7bd30a4f3aa5eee00a5cf81d344))
* **api:** move computer-use off the brand namespace ([#28487](https://github.com/vm0-ai/vm0/issues/28487)) ([5edd3c9](https://github.com/vm0-ai/vm0/commit/5edd3c9c01c0a781cb4bd8d05b4de3c55faa06a8))
* **api:** move connectors and catalog off the brand namespace ([#28490](https://github.com/vm0-ai/vm0/issues/28490)) ([942449c](https://github.com/vm0-ai/vm0/commit/942449c2866e51c0d6e7148fc0b4220d1c8feb80))
* **api:** move desktop update routes off the brand namespace ([#28489](https://github.com/vm0-ai/vm0/issues/28489)) ([cef2269](https://github.com/vm0-ai/vm0/commit/cef2269fb823155ef359347544683ed3219149a9)), closes [#28465](https://github.com/vm0-ai/vm0/issues/28465)
* **api:** move host and goal routes off the brand namespace ([#28431](https://github.com/vm0-ai/vm0/issues/28431)) ([f4adc23](https://github.com/vm0-ai/vm0/commit/f4adc23a09b8e8d3f813964a85f0fe5523c52c5c))
* **api:** move integrations off the brand namespace ([#28488](https://github.com/vm0-ai/vm0/issues/28488)) ([cafdde6](https://github.com/vm0-ai/vm0/commit/cafdde60bbdcf29e58a45a0c72ec457103cf8588))
* **api:** move org, model provider, and usage routes off the brand namespace ([#28492](https://github.com/vm0-ai/vm0/issues/28492)) ([a8b8a31](https://github.com/vm0-ai/vm0/commit/a8b8a311c4abaaa2892dca6ad7b4437cb2a617e0))
* **api:** move slack, teams, and feishu connect routes off the brand namespace ([#28485](https://github.com/vm0-ai/vm0/issues/28485)) ([ae6999f](https://github.com/vm0-ai/vm0/commit/ae6999f9a1b4193cdf2bece16d0baba6cf343f30)), closes [#28464](https://github.com/vm0-ai/vm0/issues/28464)
* **api:** move the billing routes off the brand namespace ([#28486](https://github.com/vm0-ai/vm0/issues/28486)) ([464d080](https://github.com/vm0-ai/vm0/commit/464d080b5888e272579e09f338c0c72df3388a6c))
* **api:** move the last branded contract paths off the brand namespace ([#28604](https://github.com/vm0-ai/vm0/issues/28604)) ([81f42fe](https://github.com/vm0-ai/vm0/commit/81f42fee5695da5f2546606aba9fce5f84b9ca26)), closes [#28600](https://github.com/vm0-ai/vm0/issues/28600)
* **api:** move the last four download-file contracts off the brand namespace ([#28984](https://github.com/vm0-ai/vm0/issues/28984)) ([ea6d065](https://github.com/vm0-ai/vm0/commit/ea6d0652ca55fe6b43ed4dba16d364ce058aa72a))
* **api:** move user config and personal model provider routes off the brand namespace ([#28429](https://github.com/vm0-ai/vm0/issues/28429)) ([6ef5bd2](https://github.com/vm0-ai/vm0/commit/6ef5bd26a731fe5372c2fedd6dad7c173e1ff591))
* **api:** move web-search, scrape, recognize and translate off the brand namespace ([#28427](https://github.com/vm0-ai/vm0/issues/28427)) ([c8a9733](https://github.com/vm0-ai/vm0/commit/c8a9733a23590ae1513816b344e0e3e7da89d5c0))
* **api:** move web, uploads, voice-io and more off the brand namespace ([#28496](https://github.com/vm0-ai/vm0/issues/28496)) ([911553c](https://github.com/vm0-ai/vm0/commit/911553c29ebada5da274bdcaf647272e1f3aa8dd))
* **api:** rename zero run vocabulary to agent run ([#28689](https://github.com/vm0-ai/vm0/issues/28689)) ([b8bed84](https://github.com/vm0-ai/vm0/commit/b8bed84d2ffb5210d63541c2f90b3cc75bd877ab))
* **api:** retire target-only connector mutations ([#28708](https://github.com/vm0-ai/vm0/issues/28708)) ([a600615](https://github.com/vm0-ai/vm0/commit/a6006156e747df605582c3aa2742806f58263658))
* **contracts:** neutralize custom connector and feature switch contract naming ([#28206](https://github.com/vm0-ai/vm0/issues/28206)) ([0610293](https://github.com/vm0-ai/vm0/commit/0610293ab1acdae01334925c81c79846c11a2009)), closes [#28190](https://github.com/vm0-ai/vm0/issues/28190)
* **contracts:** neutralize permission grant and connector contract naming ([#28200](https://github.com/vm0-ai/vm0/issues/28200)) ([5e3518c](https://github.com/vm0-ai/vm0/commit/5e3518c53373cae28513d5565f91eca9d12c11b9))
* **db:** drop the presentation template status and error columns ([#28515](https://github.com/vm0-ai/vm0/issues/28515)) ([53b6214](https://github.com/vm0-ai/vm0/commit/53b6214b0ee5426414f6f6fa5eb428b4c169b380))
* **db:** expand built-in model cooldown storage ([#28960](https://github.com/vm0-ai/vm0/issues/28960)) ([60d9f18](https://github.com/vm0-ai/vm0/commit/60d9f18bcfdda3bfced447349c2bc78daa0bb336))
* **feishu:** move the console-independent feishu routes off the brand namespace ([#28554](https://github.com/vm0-ai/vm0/issues/28554)) ([f777da2](https://github.com/vm0-ai/vm0/commit/f777da2eef71f94707c3e284743427068295fb8d))
* **github:** remove the dead oauth connect callback route ([#28352](https://github.com/vm0-ai/vm0/issues/28352)) ([a998483](https://github.com/vm0-ai/vm0/commit/a998483595a415683f079a4a97d718c256237652))
* **maps:** move the maps routes off the brand namespace ([#28426](https://github.com/vm0-ai/vm0/issues/28426)) ([3fbbed5](https://github.com/vm0-ai/vm0/commit/3fbbed5759ab8feb027af247513a5507fa0fcb00))
* migrate built-in model terminology ([#29079](https://github.com/vm0-ai/vm0/issues/29079)) ([4de6522](https://github.com/vm0-ai/vm0/commit/4de65229d749c81d2b27b5fdc15320e3da5d91ce))
* **rebranding:** remove expired rollout fallbacks ([#28511](https://github.com/vm0-ai/vm0/issues/28511)) ([bc28080](https://github.com/vm0-ai/vm0/commit/bc2808047690c0e691eaa7c65f6e5c64c893a996))
* remove expired deployment compatibility ([#28452](https://github.com/vm0-ai/vm0/issues/28452)) ([cfc81f2](https://github.com/vm0-ai/vm0/commit/cfc81f2a5b5c833db1729ad889eae7b552e20dd3))
* remove retired agent compose persistence plane ([#28880](https://github.com/vm0-ai/vm0/issues/28880)) ([7d91b6b](https://github.com/vm0-ai/vm0/commit/7d91b6bb470128e2a4598218a636692040a03f4e))
* **run:** finish the version-independent runtime cutover ([#28517](https://github.com/vm0-ai/vm0/issues/28517)) ([d6a1f75](https://github.com/vm0-ai/vm0/commit/d6a1f753c2146b421c09ce8cd0cae59212d169f0))
* **runner:** generate firewall cache contract constants ([#28842](https://github.com/vm0-ai/vm0/issues/28842)) ([04a15da](https://github.com/vm0-ai/vm0/commit/04a15daa1c14a7196038fa573ebf2be2ec49791f))
* **runner:** migrate status to sandbox terminology ([#29010](https://github.com/vm0-ai/vm0/issues/29010)) ([6bead98](https://github.com/vm0-ai/vm0/commit/6bead98eb35336befe162e76e862da608d1fb1b6))
* **runtime:** add a trusted platform environment channel ([#28970](https://github.com/vm0-ai/vm0/issues/28970)) ([7d6e40b](https://github.com/vm0-ai/vm0/commit/7d6e40b7a8da820582587d96479f4da9f02932b6))
* **rust:** generate pi runtime config dtos ([#28928](https://github.com/vm0-ai/vm0/issues/28928)) ([1ae995e](https://github.com/vm0-ai/vm0/commit/1ae995e88763e37f6659581dea03f8aa97c840ad))
* **teams:** move the teams routes off the brand namespace ([#28553](https://github.com/vm0-ai/vm0/issues/28553)) ([7cadbba](https://github.com/vm0-ai/vm0/commit/7cadbba2aa63e8e91a88fd25c4762cf5458042bf)), closes [#28545](https://github.com/vm0-ai/vm0/issues/28545)
* **weather:** move the weather routes off the brand namespace ([#28413](https://github.com/vm0-ai/vm0/issues/28413)) ([0386bee](https://github.com/vm0-ai/vm0/commit/0386beebc6a31d1f25b6ba50d47d8aff84dd7dfb))


### Performance Improvements

* **api:** serve scoped connector runtime from exact-identity projections ([#28513](https://github.com/vm0-ai/vm0/issues/28513)) ([dae3148](https://github.com/vm0-ai/vm0/commit/dae3148d93667fcf1ae828f0f2ef0150ee02a822))
* **runner:** attribute pre-spawn concurrency ([#28839](https://github.com/vm0-ai/vm0/issues/28839)) ([5e11ce3](https://github.com/vm0-ai/vm0/commit/5e11ce3b6aedbd502c94dd07ff68a5209cb4e101))
</details>

<details><summary>app: 0.793.0</summary>

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
</details>

<details><summary>cli: 9.285.0</summary>

## [9.285.0](https://github.com/vm0-ai/vm0/compare/cli-v9.284.0...cli-v9.285.0) (2026-08-25)


### Features

* add flux.2 pro and ideogram 4 ([#28640](https://github.com/vm0-ai/vm0/issues/28640)) ([7022170](https://github.com/vm0-ai/vm0/commit/7022170536a28805f6cbcb7e625e84755552b898))
* add qwen image 3 and nano banana 2 lite built-in image models ([#28518](https://github.com/vm0-ai/vm0/issues/28518)) ([9691fc3](https://github.com/vm0-ai/vm0/commit/9691fc30b999724efd07d2d82c384c47ff59c150))
* **api:** add managed socialkit service ([#28343](https://github.com/vm0-ai/vm0/issues/28343)) ([94f6768](https://github.com/vm0-ai/vm0/commit/94f67682a19fd19310449075a7cf9bcf40e5a52f))
* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))
* **api:** publish an analysed deck as a presentation template ([#28298](https://github.com/vm0-ai/vm0/issues/28298)) ([2080670](https://github.com/vm0-ai/vm0/commit/20806707e9adbcd9bd87043976d8327dc36a4f69))
* **banking:** add chat-based mastercard connect flow ([#28832](https://github.com/vm0-ai/vm0/issues/28832)) ([faf1021](https://github.com/vm0-ai/vm0/commit/faf10210ffc1a956a1c3f077e3410bcc27ae4cb8))
* **cli:** centralize presentation image batches ([#28702](https://github.com/vm0-ai/vm0/issues/28702)) ([20d4d4a](https://github.com/vm0-ai/vm0/commit/20d4d4ab952501195939c64236dab143bbbdd159))
* **presentation:** switch built-in decks to the latest template archives ([#28645](https://github.com/vm0-ai/vm0/issues/28645)) ([7c4a3a9](https://github.com/vm0-ai/vm0/commit/7c4a3a9fc7a1608f4033c8d20866c30f9510be66))
* pull presentation reverse-template from r2 ([#29043](https://github.com/vm0-ai/vm0/issues/29043)) ([5da72eb](https://github.com/vm0-ai/vm0/commit/5da72eb706544d50731cab880c4d006979b63afe))
* **rebranding:** emit branded static asset urls ([#28446](https://github.com/vm0-ai/vm0/issues/28446)) ([3eb6c67](https://github.com/vm0-ai/vm0/commit/3eb6c679aef093e43d24dd3c625cb526cc461c7f))
* serve direct-html website templates behind the latest switch ([#29053](https://github.com/vm0-ai/vm0/issues/29053)) ([508d9ec](https://github.com/vm0-ai/vm0/commit/508d9eca8eeb05694499d28d6f8114f2f336b69a))
* **social:** add managed socialkit pagination and usage billing ([#29180](https://github.com/vm0-ai/vm0/issues/29180)) ([72a60ca](https://github.com/vm0-ai/vm0/commit/72a60ca0aa52e611cc544eb4d7062581fc498106))


### Bug Fixes

* **cli:** name the actual default video model in help text ([#29139](https://github.com/vm0-ai/vm0/issues/29139)) ([f143071](https://github.com/vm0-ai/vm0/commit/f1430712cbf1e56db0d590b8d7796ad8896cd72e))
* **rebranding:** neutralize agent-facing brand copy ([#29167](https://github.com/vm0-ai/vm0/issues/29167)) ([d1a4cc6](https://github.com/vm0-ai/vm0/commit/d1a4cc63dfc912c36e636315772d9353ee190334))


### Refactoring

* **api:** migrate the late branded contracts and guard the namespace ([#28577](https://github.com/vm0-ai/vm0/issues/28577)) ([d568056](https://github.com/vm0-ai/vm0/commit/d5680566144451411311656dd5a3c6c0bb312f02))
* **api:** move agents, workflows, and workflow automations off the brand namespace ([#28497](https://github.com/vm0-ai/vm0/issues/28497)) ([ee1f56f](https://github.com/vm0-ai/vm0/commit/ee1f56f9a4994b5b6978e6e8515fdbe9df9e6970))
* **api:** move browser, finance, seo, and mcp connector routes off /api/okou ([#28433](https://github.com/vm0-ai/vm0/issues/28433)) ([1e4bdf3](https://github.com/vm0-ai/vm0/commit/1e4bdf3432ab0e27ae70da59abacdf4d74c14b60))
* **api:** move built-in-generations and image-io off the brand namespace ([#28432](https://github.com/vm0-ai/vm0/issues/28432)) ([d1c6c7c](https://github.com/vm0-ai/vm0/commit/d1c6c7c9d2b29af4c95949661fd9bcbd5359df54))
* **api:** move chat threads, chat events, and shared threads off the brand namespace ([#28471](https://github.com/vm0-ai/vm0/issues/28471)) ([6c2036f](https://github.com/vm0-ai/vm0/commit/6c2036fa7e5f02e01cf163ab1a515364e8ec29d8))
* **api:** move computer-use off the brand namespace ([#28487](https://github.com/vm0-ai/vm0/issues/28487)) ([5edd3c9](https://github.com/vm0-ai/vm0/commit/5edd3c9c01c0a781cb4bd8d05b4de3c55faa06a8))
* **api:** move connectors and catalog off the brand namespace ([#28490](https://github.com/vm0-ai/vm0/issues/28490)) ([942449c](https://github.com/vm0-ai/vm0/commit/942449c2866e51c0d6e7148fc0b4220d1c8feb80))
* **api:** move host and goal routes off the brand namespace ([#28431](https://github.com/vm0-ai/vm0/issues/28431)) ([f4adc23](https://github.com/vm0-ai/vm0/commit/f4adc23a09b8e8d3f813964a85f0fe5523c52c5c))
* **api:** move integrations off the brand namespace ([#28488](https://github.com/vm0-ai/vm0/issues/28488)) ([cafdde6](https://github.com/vm0-ai/vm0/commit/cafdde60bbdcf29e58a45a0c72ec457103cf8588))
* **api:** move org, model provider, and usage routes off the brand namespace ([#28492](https://github.com/vm0-ai/vm0/issues/28492)) ([a8b8a31](https://github.com/vm0-ai/vm0/commit/a8b8a311c4abaaa2892dca6ad7b4437cb2a617e0))
* **api:** move the billing routes off the brand namespace ([#28486](https://github.com/vm0-ai/vm0/issues/28486)) ([464d080](https://github.com/vm0-ai/vm0/commit/464d080b5888e272579e09f338c0c72df3388a6c))
* **api:** move the last four download-file contracts off the brand namespace ([#28984](https://github.com/vm0-ai/vm0/issues/28984)) ([ea6d065](https://github.com/vm0-ai/vm0/commit/ea6d0652ca55fe6b43ed4dba16d364ce058aa72a))
* **api:** move web-search, scrape, recognize and translate off the brand namespace ([#28427](https://github.com/vm0-ai/vm0/issues/28427)) ([c8a9733](https://github.com/vm0-ai/vm0/commit/c8a9733a23590ae1513816b344e0e3e7da89d5c0))
* **api:** move web, uploads, voice-io and more off the brand namespace ([#28496](https://github.com/vm0-ai/vm0/issues/28496)) ([911553c](https://github.com/vm0-ai/vm0/commit/911553c29ebada5da274bdcaf647272e1f3aa8dd))
* **auth:** retire the zero token scope and rename the token vocabulary ([#28706](https://github.com/vm0-ai/vm0/issues/28706)) ([5ad6301](https://github.com/vm0-ai/vm0/commit/5ad630103e0c047b49046f21301dd2732a42753e)), closes [#28695](https://github.com/vm0-ai/vm0/issues/28695)
* **cli:** rename the default agent-browser session to okou-browser ([#28782](https://github.com/vm0-ai/vm0/issues/28782)) ([0cb14a5](https://github.com/vm0-ai/vm0/commit/0cb14a5d591853d29d092a99dbe3f5999aa019ea)), closes [#28779](https://github.com/vm0-ai/vm0/issues/28779)
* **cli:** send explicit single-account connector intent ([#28649](https://github.com/vm0-ai/vm0/issues/28649)) ([2e57b84](https://github.com/vm0-ai/vm0/commit/2e57b840cfaa6a362ff6ebcdaaf5b79c921e8f72))
* **contracts:** neutralize custom connector and feature switch contract naming ([#28206](https://github.com/vm0-ai/vm0/issues/28206)) ([0610293](https://github.com/vm0-ai/vm0/commit/0610293ab1acdae01334925c81c79846c11a2009)), closes [#28190](https://github.com/vm0-ai/vm0/issues/28190)
* **contracts:** neutralize permission grant and connector contract naming ([#28200](https://github.com/vm0-ai/vm0/issues/28200)) ([5e3518c](https://github.com/vm0-ai/vm0/commit/5e3518c53373cae28513d5565f91eca9d12c11b9))
* **db:** drop the presentation template status and error columns ([#28515](https://github.com/vm0-ai/vm0/issues/28515)) ([53b6214](https://github.com/vm0-ai/vm0/commit/53b6214b0ee5426414f6f6fa5eb428b4c169b380))
* **e2e:** remove the unreachable zero app url fallback ([#28767](https://github.com/vm0-ai/vm0/issues/28767)) ([a3e46ba](https://github.com/vm0-ai/vm0/commit/a3e46baa221564941ff1ae94ae329e7f66f2531e))
* **maps:** move the maps routes off the brand namespace ([#28426](https://github.com/vm0-ai/vm0/issues/28426)) ([3fbbed5](https://github.com/vm0-ai/vm0/commit/3fbbed5759ab8feb027af247513a5507fa0fcb00))
* migrate built-in model terminology ([#29079](https://github.com/vm0-ai/vm0/issues/29079)) ([4de6522](https://github.com/vm0-ai/vm0/commit/4de65229d749c81d2b27b5fdc15320e3da5d91ce))
* **weather:** move the weather routes off the brand namespace ([#28413](https://github.com/vm0-ai/vm0/issues/28413)) ([0386bee](https://github.com/vm0-ai/vm0/commit/0386beebc6a31d1f25b6ba50d47d8aff84dd7dfb))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @okouai/api-contracts bumped to 1.363.0
    * @okouai/core bumped to 8.590.0
</details>

<details><summary>core: 8.590.0</summary>

## [8.590.0](https://github.com/vm0-ai/vm0/compare/core-v8.589.0...core-v8.590.0) (2026-08-25)


### Features

* accept legacy .ppt decks in template import ([#28870](https://github.com/vm0-ai/vm0/issues/28870)) ([f3cd82c](https://github.com/vm0-ai/vm0/commit/f3cd82c62633caa58f018aa6ee3cc68ab9a7349f))
* add flux.2 pro and ideogram 4 ([#28640](https://github.com/vm0-ai/vm0/issues/28640)) ([7022170](https://github.com/vm0-ai/vm0/commit/7022170536a28805f6cbcb7e625e84755552b898))
* add qwen image 3 and nano banana 2 lite built-in image models ([#28518](https://github.com/vm0-ai/vm0/issues/28518)) ([9691fc3](https://github.com/vm0-ai/vm0/commit/9691fc30b999724efd07d2d82c384c47ff59c150))
* annotate an attached image in the composer ([#28976](https://github.com/vm0-ai/vm0/issues/28976)) ([19096b6](https://github.com/vm0-ai/vm0/commit/19096b6c2ef65e8d885cbadbf0f6f7cc81ef4508))
* **api:** add managed model fallback resolver ([#28301](https://github.com/vm0-ai/vm0/issues/28301)) ([745a08f](https://github.com/vm0-ai/vm0/commit/745a08fa51b6b0b51208fae1a02ec599664be115))
* **api:** add managed socialkit service ([#28343](https://github.com/vm0-ai/vm0/issues/28343)) ([94f6768](https://github.com/vm0-ai/vm0/commit/94f67682a19fd19310449075a7cf9bcf40e5a52f))
* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))
* **api:** publish an analysed deck as a presentation template ([#28298](https://github.com/vm0-ai/vm0/issues/28298)) ([2080670](https://github.com/vm0-ai/vm0/commit/20806707e9adbcd9bd87043976d8327dc36a4f69))
* **api:** resolve a user's own presentation template for a generation run ([#28536](https://github.com/vm0-ai/vm0/issues/28536)) ([1db3d99](https://github.com/vm0-ai/vm0/commit/1db3d99c96b5a2fa8fec2324d644f073a9622912))
* **cli:** centralize presentation image batches ([#28702](https://github.com/vm0-ai/vm0/issues/28702)) ([20d4d4a](https://github.com/vm0-ai/vm0/commit/20d4d4ab952501195939c64236dab143bbbdd159))
* **composer:** offer one model per family in the media pickers ([#28510](https://github.com/vm0-ai/vm0/issues/28510)) ([3389b85](https://github.com/vm0-ai/vm0/commit/3389b85bbb3916d38a71661227ccfc1d02662e75))
* **connectors:** enable box oauth ([#28507](https://github.com/vm0-ai/vm0/issues/28507)) ([59784c7](https://github.com/vm0-ai/vm0/commit/59784c714a10f3e66ee4208fda67ea744cb5241f))
* **core:** enable usage pack plans for staff ([#28503](https://github.com/vm0-ai/vm0/issues/28503)) ([14a9a65](https://github.com/vm0-ai/vm0/commit/14a9a653f13e028a63e8bfe439fbf9a6c53361c0))
* **core:** roll out usage pack plans ([#28771](https://github.com/vm0-ai/vm0/issues/28771)) ([f83844e](https://github.com/vm0-ai/vm0/commit/f83844e5aaafee2c8ad6c2f8048c90483a144fa2))
* enable built-in model fallback for staff ([#29171](https://github.com/vm0-ai/vm0/issues/29171)) ([9157d91](https://github.com/vm0-ai/vm0/commit/9157d91f4337262a3eb505d6a96082836ecfe0f7))
* **host:** prepare okou public domains ([#28359](https://github.com/vm0-ai/vm0/issues/28359)) ([853415c](https://github.com/vm0-ai/vm0/commit/853415cbe56481d6e2c44c8cbd73ee50c6064902))
* **platform:** add multi-account connector settings ([#28904](https://github.com/vm0-ai/vm0/issues/28904)) ([e8d0c2a](https://github.com/vm0-ai/vm0/commit/e8d0c2acb679ccd23b218a694aaf1a6893f97791))
* **platform:** offer nano banana 2 lite and price tiers for media models ([#28674](https://github.com/vm0-ai/vm0/issues/28674)) ([dc7962c](https://github.com/vm0-ai/vm0/commit/dc7962c9c51e8e74cab94eb39af89ab31e68fd4b))
* **platform:** turn the home invite button into a growth entry ([#28439](https://github.com/vm0-ai/vm0/issues/28439)) ([632fbb9](https://github.com/vm0-ai/vm0/commit/632fbb9f12b7886dafa5860c778245742e4ad689))
* point runs at the deck reverse-engineering guide ([#28362](https://github.com/vm0-ai/vm0/issues/28362)) ([8022cb6](https://github.com/vm0-ai/vm0/commit/8022cb61be52befefacfd44e1d758bd1a54f7584))
* **presentation:** refresh the built-in template archives to 71ff2fb ([#28728](https://github.com/vm0-ai/vm0/issues/28728)) ([6053443](https://github.com/vm0-ai/vm0/commit/605344368e64757a5ac2ce9fe113d2a20fd2369c))
* **presentation:** switch built-in decks to the latest template archives ([#28645](https://github.com/vm0-ai/vm0/issues/28645)) ([7c4a3a9](https://github.com/vm0-ai/vm0/commit/7c4a3a9fc7a1608f4033c8d20866c30f9510be66))
* pull presentation reverse-template from r2 ([#29043](https://github.com/vm0-ai/vm0/issues/29043)) ([5da72eb](https://github.com/vm0-ai/vm0/commit/5da72eb706544d50731cab880c4d006979b63afe))
* **rebranding:** emit branded static asset urls ([#28446](https://github.com/vm0-ai/vm0/issues/28446)) ([3eb6c67](https://github.com/vm0-ai/vm0/commit/3eb6c679aef093e43d24dd3c625cb526cc461c7f))
* roll out chat quote-only feedback to all users ([#28840](https://github.com/vm0-ai/vm0/issues/28840)) ([3408fba](https://github.com/vm0-ai/vm0/commit/3408fba40437b19dd5a9432b80627425630180bd))
* roll out image and video model selection to all users ([#29042](https://github.com/vm0-ai/vm0/issues/29042)) ([9c61cec](https://github.com/vm0-ai/vm0/commit/9c61cecb5a6f5a4dfcaa045910a4646d1576f5fe))
* serve direct-html website templates behind the latest switch ([#29053](https://github.com/vm0-ai/vm0/issues/29053)) ([508d9ec](https://github.com/vm0-ai/vm0/commit/508d9eca8eeb05694499d28d6f8114f2f336b69a))


### Bug Fixes

* **cli:** name the actual default video model in help text ([#29139](https://github.com/vm0-ai/vm0/issues/29139)) ([f143071](https://github.com/vm0-ai/vm0/commit/f1430712cbf1e56db0d590b8d7796ad8896cd72e))
* **composer:** keep the feedback note chrome outside the editable flow ([#29037](https://github.com/vm0-ai/vm0/issues/29037)) ([05d6dcc](https://github.com/vm0-ai/vm0/commit/05d6dcca4a00acbac33b98d031790da594a0e7a1))
* **composer:** rebuild the quote block on native prosemirror machinery ([#29137](https://github.com/vm0-ai/vm0/issues/29137)) ([626a055](https://github.com/vm0-ai/vm0/commit/626a055c38c9dfd936d5011c875fcd39a82c91b2))
* **composer:** reconcile live dom before submission ([#28574](https://github.com/vm0-ai/vm0/issues/28574)) ([cf781f9](https://github.com/vm0-ai/vm0/commit/cf781f94c8bec7ac7521a02c8406eea866de793f))
* **core:** make workflow template guidance brand-neutral ([#28778](https://github.com/vm0-ai/vm0/issues/28778)) ([a5f429a](https://github.com/vm0-ai/vm0/commit/a5f429a9063785caf6f52a0e95980cfb59bcdf81))
* **platform:** remove unavailable restored attachments ([#28871](https://github.com/vm0-ai/vm0/issues/28871)) ([16a3f22](https://github.com/vm0-ai/vm0/commit/16a3f2278db41669f27e3af909312f80429b782e))
* **rebranding:** neutralize agent-facing brand copy ([#29167](https://github.com/vm0-ai/vm0/issues/29167)) ([d1a4cc6](https://github.com/vm0-ai/vm0/commit/d1a4cc63dfc912c36e636315772d9353ee190334))
* **video:** default to a video model the picker offers ([#29045](https://github.com/vm0-ai/vm0/issues/29045)) ([33a6dba](https://github.com/vm0-ai/vm0/commit/33a6dba91522f57fc231773833d1cac9ad88a2e4))


### Refactoring

* **api:** move org, model provider, and usage routes off the brand namespace ([#28492](https://github.com/vm0-ai/vm0/issues/28492)) ([a8b8a31](https://github.com/vm0-ai/vm0/commit/a8b8a311c4abaaa2892dca6ad7b4437cb2a617e0))
* **api:** retire target-only connector mutations ([#28708](https://github.com/vm0-ai/vm0/issues/28708)) ([a600615](https://github.com/vm0-ai/vm0/commit/a6006156e747df605582c3aa2742806f58263658))
* **contracts:** neutralize custom connector and feature switch contract naming ([#28206](https://github.com/vm0-ai/vm0/issues/28206)) ([0610293](https://github.com/vm0-ai/vm0/commit/0610293ab1acdae01334925c81c79846c11a2009)), closes [#28190](https://github.com/vm0-ai/vm0/issues/28190)
* **contracts:** neutralize permission grant and connector contract naming ([#28200](https://github.com/vm0-ai/vm0/issues/28200)) ([5e3518c](https://github.com/vm0-ai/vm0/commit/5e3518c53373cae28513d5565f91eca9d12c11b9))
* **core:** rename zeroDebug feature switch to okouDebug ([#28816](https://github.com/vm0-ai/vm0/issues/28816)) ([9d86a26](https://github.com/vm0-ai/vm0/commit/9d86a26650ef5c7ac400356fb9f0fc6c173611e6))
* migrate built-in model terminology ([#29079](https://github.com/vm0-ai/vm0/issues/29079)) ([4de6522](https://github.com/vm0-ai/vm0/commit/4de65229d749c81d2b27b5fdc15320e3da5d91ce))
* **platform:** remove restored attachment validation switch ([#29130](https://github.com/vm0-ai/vm0/issues/29130)) ([c57004f](https://github.com/vm0-ai/vm0/commit/c57004f83e9a556554afc6d063e6dc91425f6f4d))
* remove chat mark unread feature switch ([#28898](https://github.com/vm0-ai/vm0/issues/28898)) ([ea8fa6e](https://github.com/vm0-ai/vm0/commit/ea8fa6ee98f3bd1d0eb02959542bcbe1ae7fa31c))
* remove chat run continuation presentation ([#28641](https://github.com/vm0-ai/vm0/issues/28641)) ([4b46f97](https://github.com/vm0-ai/vm0/commit/4b46f9713160c1a2679ac87aa0c38ff5c86f5602))
* remove chatQuoteOnlyFeedback feature switch ([#28845](https://github.com/vm0-ai/vm0/issues/28845)) ([f35dd1d](https://github.com/vm0-ai/vm0/commit/f35dd1d89dd0274ec0b098de16cc91a1576714f6))
* remove home start cards feature switch ([#29044](https://github.com/vm0-ai/vm0/issues/29044)) ([6f777ef](https://github.com/vm0-ai/vm0/commit/6f777ef3e3560c76b4924fb05801ec8937b6800a))
* remove joggai built-in feature switch ([#28896](https://github.com/vm0-ai/vm0/issues/28896)) ([80a87fe](https://github.com/vm0-ai/vm0/commit/80a87fe81391786adb8448ea7c80bc4a13477c27))
* remove retired agent compose persistence plane ([#28880](https://github.com/vm0-ai/vm0/issues/28880)) ([7d91b6b](https://github.com/vm0-ai/vm0/commit/7d91b6bb470128e2a4598218a636692040a03f4e))
* remove saved billing credit purchase switch ([#28897](https://github.com/vm0-ai/vm0/issues/28897)) ([aba35fb](https://github.com/vm0-ai/vm0/commit/aba35fb74906723713fc01665389adf49681038c))
* remove the composer submit dom reconcile switch ([#29144](https://github.com/vm0-ai/vm0/issues/29144)) ([1704de4](https://github.com/vm0-ai/vm0/commit/1704de411b2d0f47e395492668ef24348312f11e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.363.0
</details>

<details><summary>db: 1.223.0</summary>

## [1.223.0](https://github.com/vm0-ai/vm0/compare/db-v1.222.0...db-v1.223.0) (2026-08-25)


### Features

* add flux.2 pro and ideogram 4 ([#28640](https://github.com/vm0-ai/vm0/issues/28640)) ([7022170](https://github.com/vm0-ai/vm0/commit/7022170536a28805f6cbcb7e625e84755552b898))
* add qwen image 3 and nano banana 2 lite built-in image models ([#28518](https://github.com/vm0-ai/vm0/issues/28518)) ([9691fc3](https://github.com/vm0-ai/vm0/commit/9691fc30b999724efd07d2d82c384c47ff59c150))
* **agentphone:** decouple provider identity from public brand ([#28953](https://github.com/vm0-ai/vm0/issues/28953)) ([e7fcd06](https://github.com/vm0-ai/vm0/commit/e7fcd06ba2647f55d8a83e7e94be2ed066b74a97))
* **api:** add explicit single-account connector intent ([#28597](https://github.com/vm0-ai/vm0/issues/28597)) ([67b73e4](https://github.com/vm0-ai/vm0/commit/67b73e43e2b58ca976542aadd4ade39848df4055))
* **api:** add managed model fallback resolver ([#28301](https://github.com/vm0-ai/vm0/issues/28301)) ([745a08f](https://github.com/vm0-ai/vm0/commit/745a08fa51b6b0b51208fae1a02ec599664be115))
* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))
* **api:** persist explicit thread connector account overrides ([#28355](https://github.com/vm0-ai/vm0/issues/28355)) ([772de1c](https://github.com/vm0-ai/vm0/commit/772de1c01b70948fb41c07e3db4e5c6e7a01cada))
* **artifacts:** emit branded cdn urls ([#28411](https://github.com/vm0-ai/vm0/issues/28411)) ([9dd558f](https://github.com/vm0-ai/vm0/commit/9dd558f3043a5ffdf72627fa367ae8750be3e86d))
* **banking:** add chat-based mastercard connect flow ([#28832](https://github.com/vm0-ai/vm0/issues/28832)) ([faf1021](https://github.com/vm0-ai/vm0/commit/faf10210ffc1a956a1c3f077e3410bcc27ae4cb8))
* **connectors:** enable multi-account lifecycle ([#28519](https://github.com/vm0-ai/vm0/issues/28519)) ([c5926f2](https://github.com/vm0-ai/vm0/commit/c5926f2a383dded86f8e67d9fc413817879fa75c))
* **feishu:** preserve host-derived public branding ([#28935](https://github.com/vm0-ai/vm0/issues/28935)) ([bbb60c7](https://github.com/vm0-ai/vm0/commit/bbb60c70fb46dcc1ca6a15694de0770edba98c95))
* **github:** preserve public brand across app ingress ([#28942](https://github.com/vm0-ai/vm0/issues/28942)) ([3d4bdf6](https://github.com/vm0-ai/vm0/commit/3d4bdf623e7694804ea244ce5eed0557c4c567f4))
* **host:** emit branded hosted site urls ([#28387](https://github.com/vm0-ai/vm0/issues/28387)) ([d098306](https://github.com/vm0-ai/vm0/commit/d09830659571868c9e79cd9c9e7e501661bd05d7))
* **host:** prepare okou public domains ([#28359](https://github.com/vm0-ai/vm0/issues/28359)) ([853415c](https://github.com/vm0-ai/vm0/commit/853415cbe56481d6e2c44c8cbd73ee50c6064902))
* **presentation:** switch built-in decks to the latest template archives ([#28645](https://github.com/vm0-ai/vm0/issues/28645)) ([7c4a3a9](https://github.com/vm0-ai/vm0/commit/7c4a3a9fc7a1608f4033c8d20866c30f9510be66))
* **slack:** migrate official app to okou ([#28795](https://github.com/vm0-ai/vm0/issues/28795)) ([57d1a9f](https://github.com/vm0-ai/vm0/commit/57d1a9f500272b2b8214462fcbc640528103dd8f))
* support workspace presentation templates ([#28596](https://github.com/vm0-ai/vm0/issues/28596)) ([f25dbbb](https://github.com/vm0-ai/vm0/commit/f25dbbbae2aae3546070a36eaeead062ec563ee7))
* **teams:** separate provider identity from public brand ([#28938](https://github.com/vm0-ai/vm0/issues/28938)) ([6e717c5](https://github.com/vm0-ai/vm0/commit/6e717c58fad35281b0e30e296ea135ed9487d363))
* **telegram:** support dual-brand ingress ([#28945](https://github.com/vm0-ai/vm0/issues/28945)) ([c5f6b87](https://github.com/vm0-ai/vm0/commit/c5f6b87adc0ba25a73bddd595d5740360fd32d0d))


### Bug Fixes

* **api:** harden usage pack purchase billing ([#28304](https://github.com/vm0-ai/vm0/issues/28304)) ([17ba3cd](https://github.com/vm0-ai/vm0/commit/17ba3cdfd57c8c980dedab902c2ed49ed51d0a4f))
* **db:** align checkpoint storage reference semantics ([#28437](https://github.com/vm0-ai/vm0/issues/28437)) ([b5aae06](https://github.com/vm0-ai/vm0/commit/b5aae066f4ef8cba13f72b8899301f144411f7df))
* **db:** bound checkpoint storage preflight plan ([#28317](https://github.com/vm0-ai/vm0/issues/28317)) ([e13bf6e](https://github.com/vm0-ai/vm0/commit/e13bf6eb5b798fca84ff496a9f3af86545092413))
* **db:** bound stage 8 migration scans ([#29047](https://github.com/vm0-ai/vm0/issues/29047)) ([a2ae5e2](https://github.com/vm0-ai/vm0/commit/a2ae5e2700fe16fe448121a5020d680be93f20cd))
* **db:** bound stage 8 production migration ([#28987](https://github.com/vm0-ai/vm0/issues/28987)) ([d0fcdff](https://github.com/vm0-ai/vm0/commit/d0fcdffc1a2d5bfdb5725fba6ad6560ab3b350c3))
* **db:** converge absent-target canonical agent bridge ([#28654](https://github.com/vm0-ai/vm0/issues/28654)) ([3cabfd6](https://github.com/vm0-ai/vm0/commit/3cabfd6ca28609350e803381cf90dca0bd2140cd))
* **db:** permit canonical chat event reference backfill ([#28606](https://github.com/vm0-ai/vm0/issues/28606)) ([fe5638b](https://github.com/vm0-ai/vm0/commit/fe5638b1d9368d5b8db6f3109199138f63f9d73b))
* **db:** preserve deleted snapshot anchors ([#28637](https://github.com/vm0-ai/vm0/issues/28637)) ([94a5f91](https://github.com/vm0-ai/vm0/commit/94a5f915bf66cada3fb6b82e76c89e808eccf89c))
* **db:** stream checkpoint storage preflight ([#28409](https://github.com/vm0-ai/vm0/issues/28409)) ([27d3cfc](https://github.com/vm0-ai/vm0/commit/27d3cfc71dadbd1f3a3aed485c6e559ca4495b37))
* **db:** use native keyset for search agent backfill ([#28621](https://github.com/vm0-ai/vm0/issues/28621)) ([745776a](https://github.com/vm0-ai/vm0/commit/745776ac5819823144bb60eb3f4ad1ab3f90fa71))


### CI

* remove ad hoc production validation workflows ([#28505](https://github.com/vm0-ai/vm0/issues/28505)) ([305fe06](https://github.com/vm0-ai/vm0/commit/305fe0682c5abf01cee484a9fa062594d1adac84))


### Refactoring

* **agent:** make canonical agent writes authoritative ([#28721](https://github.com/vm0-ai/vm0/issues/28721)) ([64660cf](https://github.com/vm0-ai/vm0/commit/64660cfe57097da7209d0182e132158374292ac8))
* **agent:** seal legacy schema absence ([#28784](https://github.com/vm0-ai/vm0/issues/28784)) ([d6fd49a](https://github.com/vm0-ai/vm0/commit/d6fd49a9ac5815697d586e72759f93448a789e6c))
* **api:** cut agent reads to canonical data plane ([#28683](https://github.com/vm0-ai/vm0/issues/28683)) ([0e009c5](https://github.com/vm0-ai/vm0/commit/0e009c54ef67a38400dd464d5a0a3b551612826a))
* **api:** rename zero run vocabulary to agent run ([#28689](https://github.com/vm0-ai/vm0/issues/28689)) ([b8bed84](https://github.com/vm0-ai/vm0/commit/b8bed84d2ffb5210d63541c2f90b3cc75bd877ab))
* **api:** switch agent run model key reads to canonical column ([#28740](https://github.com/vm0-ai/vm0/issues/28740)) ([371ada0](https://github.com/vm0-ai/vm0/commit/371ada08e22d7380a72be8613a306390df0a4bdf))
* **contracts:** neutralize custom connector and feature switch contract naming ([#28206](https://github.com/vm0-ai/vm0/issues/28206)) ([0610293](https://github.com/vm0-ai/vm0/commit/0610293ab1acdae01334925c81c79846c11a2009)), closes [#28190](https://github.com/vm0-ai/vm0/issues/28190)
* **core:** rename zeroDebug feature switch to okouDebug ([#28816](https://github.com/vm0-ai/vm0/issues/28816)) ([9d86a26](https://github.com/vm0-ai/vm0/commit/9d86a26650ef5c7ac400356fb9f0fc6c173611e6))
* **db:** add built_in_model_keys compatibility relation ([#28454](https://github.com/vm0-ai/vm0/issues/28454)) ([16e5aef](https://github.com/vm0-ai/vm0/commit/16e5aef8ebd28fbb3f027e3722a67e59e973cc15))
* **db:** add canonical agents data plane ([#28603](https://github.com/vm0-ai/vm0/issues/28603)) ([e682443](https://github.com/vm0-ai/vm0/commit/e68244397f7ba6850468ebd9dc48cc1188138f0e))
* **db:** backfill agent run built-in model key ids ([#28719](https://github.com/vm0-ai/vm0/issues/28719)) ([bcb7317](https://github.com/vm0-ai/vm0/commit/bcb73172f981155a5139e308704ffe4ddd7b2573))
* **db:** bridge agent run built-in model key ([#28691](https://github.com/vm0-ai/vm0/issues/28691)) ([9d66e10](https://github.com/vm0-ai/vm0/commit/9d66e1063659395968913764247f6985f3c20f7f))
* **db:** contract legacy agent run model key column and bridge ([#28776](https://github.com/vm0-ai/vm0/issues/28776)) ([9e1fe0f](https://github.com/vm0-ai/vm0/commit/9e1fe0f3eb53e30182ef8bf88b71ef0176dda822))
* **db:** contract legacy built-in model key relation ([#28602](https://github.com/vm0-ai/vm0/issues/28602)) ([d527174](https://github.com/vm0-ai/vm0/commit/d527174e4bf471ad127da9f18854f50cb2865ef7))
* **db:** drop the presentation template status and error columns ([#28515](https://github.com/vm0-ai/vm0/issues/28515)) ([53b6214](https://github.com/vm0-ai/vm0/commit/53b6214b0ee5426414f6f6fa5eb428b4c169b380))
* **db:** expand built-in model cooldown storage ([#28960](https://github.com/vm0-ai/vm0/issues/28960)) ([60d9f18](https://github.com/vm0-ai/vm0/commit/60d9f18bcfdda3bfced447349c2bc78daa0bb336))
* **db:** switch built-in model keys physical relation ([#28499](https://github.com/vm0-ai/vm0/issues/28499)) ([b51e846](https://github.com/vm0-ai/vm0/commit/b51e846fb56c816bbcc936243391779d6aba02f2))
* migrate built-in model terminology ([#29079](https://github.com/vm0-ai/vm0/issues/29079)) ([4de6522](https://github.com/vm0-ai/vm0/commit/4de65229d749c81d2b27b5fdc15320e3da5d91ce))
* **rebranding:** remove expired rollout fallbacks ([#28511](https://github.com/vm0-ai/vm0/issues/28511)) ([bc28080](https://github.com/vm0-ai/vm0/commit/bc2808047690c0e691eaa7c65f6e5c64c893a996))
* remove expired deployment compatibility ([#29111](https://github.com/vm0-ai/vm0/issues/29111)) ([d751eed](https://github.com/vm0-ai/vm0/commit/d751eed41c0d0d8e99c7d83337f78b72214e2c48))
* remove retired agent compose persistence plane ([#28880](https://github.com/vm0-ai/vm0/issues/28880)) ([7d91b6b](https://github.com/vm0-ai/vm0/commit/7d91b6bb470128e2a4598218a636692040a03f4e))
* **run:** finish the version-independent runtime cutover ([#28517](https://github.com/vm0-ai/vm0/issues/28517)) ([d6a1f75](https://github.com/vm0-ai/vm0/commit/d6a1f753c2146b421c09ce8cd0cae59212d169f0))


### Performance Improvements

* **api:** read attested connector projection payloads ([#28699](https://github.com/vm0-ai/vm0/issues/28699)) ([f40d5ea](https://github.com/vm0-ai/vm0/commit/f40d5ea90b2fc4649cd336d083ce9d97573fb9ed))
* **api:** serve scoped connector runtime from exact-identity projections ([#28513](https://github.com/vm0-ai/vm0/issues/28513)) ([dae3148](https://github.com/vm0-ai/vm0/commit/dae3148d93667fcf1ae828f0f2ef0150ee02a822))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.363.0
    * @okouai/core bumped to 8.590.0
</details>

<details><summary>desktop: 0.38.81</summary>

## [0.38.81](https://github.com/vm0-ai/vm0/compare/desktop-v0.38.80...desktop-v0.38.81) (2026-08-25)


### Refactoring

* **api:** move computer-use off the brand namespace ([#28487](https://github.com/vm0-ai/vm0/issues/28487)) ([5edd3c9](https://github.com/vm0-ai/vm0/commit/5edd3c9c01c0a781cb4bd8d05b4de3c55faa06a8))
* **api:** move desktop update routes off the brand namespace ([#28489](https://github.com/vm0-ai/vm0/issues/28489)) ([cef2269](https://github.com/vm0-ai/vm0/commit/cef2269fb823155ef359347544683ed3219149a9)), closes [#28465](https://github.com/vm0-ai/vm0/issues/28465)
* **api:** move org, model provider, and usage routes off the brand namespace ([#28492](https://github.com/vm0-ai/vm0/issues/28492)) ([a8b8a31](https://github.com/vm0-ai/vm0/commit/a8b8a311c4abaaa2892dca6ad7b4437cb2a617e0))
* **core:** rename zeroDebug feature switch to okouDebug ([#28816](https://github.com/vm0-ai/vm0/issues/28816)) ([9d86a26](https://github.com/vm0-ai/vm0/commit/9d86a26650ef5c7ac400356fb9f0fc6c173611e6))
* **desktop:** dual-read notarization api credential aliases ([#29102](https://github.com/vm0-ai/vm0/issues/29102)) ([5862b50](https://github.com/vm0-ai/vm0/commit/5862b5099ea14459ec1e5b8775825ec64e226346))
* **desktop:** dual-read notarization keychain aliases ([#29195](https://github.com/vm0-ai/vm0/issues/29195)) ([8e28456](https://github.com/vm0-ai/vm0/commit/8e284563b736d1d9df9f81efffe40dc403cb0e3a)), closes [#29189](https://github.com/vm0-ai/vm0/issues/29189) [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **desktop:** dual-read product and platform environment aliases ([#29105](https://github.com/vm0-ai/vm0/issues/29105)) ([7dec03f](https://github.com/vm0-ai/vm0/commit/7dec03fddb922deb901cede8703dde5e7c9e450e))
* **desktop:** dual-read signing identity aliases ([#29176](https://github.com/vm0-ai/vm0/issues/29176)) ([0921d61](https://github.com/vm0-ai/vm0/commit/0921d618b6daf04c515322bc24c2027bee77e387)), closes [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **desktop:** rename native helper Sentry environment keys ([#29089](https://github.com/vm0-ai/vm0/issues/29089)) ([8011fe5](https://github.com/vm0-ai/vm0/commit/8011fe5283f6d570e911284c67ec47a9acc89302))
* **desktop:** rename notarization toggle environment key ([#29188](https://github.com/vm0-ai/vm0/issues/29188)) ([4069e2a](https://github.com/vm0-ai/vm0/commit/4069e2a30f8dc2b9beaccaeda44edc1116b5de70))
* **desktop:** rename packaged smoke app path environment key ([#29100](https://github.com/vm0-ai/vm0/issues/29100)) ([421c50e](https://github.com/vm0-ai/vm0/commit/421c50efb1593716ff76d367da2067ed1af5b6b9))
* **desktop:** rename unsigned-build signing bypass environment key ([#29093](https://github.com/vm0-ai/vm0/issues/29093)) ([7a50ad0](https://github.com/vm0-ai/vm0/commit/7a50ad0d95dd7665de73c7d0bc2165eebec92af2))
* **desktop:** switch notarization api writer to okou aliases ([#29106](https://github.com/vm0-ai/vm0/issues/29106)) ([5d0e3bf](https://github.com/vm0-ai/vm0/commit/5d0e3bf7ce6a27d403518696c225572272ccde5e))
* **desktop:** switch product and platform writers to okou aliases ([#29145](https://github.com/vm0-ai/vm0/issues/29145)) ([dd70d1f](https://github.com/vm0-ai/vm0/commit/dd70d1f9e8010405efe856cfadb439e170dc6c5b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.363.0
</details>

<details><summary>api: 1.487.0</summary>

## [1.487.0](https://github.com/vm0-ai/vm0/compare/api-v1.486.0...api-v1.487.0) (2026-08-25)


### Features

* add flux.2 pro and ideogram 4 ([#28640](https://github.com/vm0-ai/vm0/issues/28640)) ([7022170](https://github.com/vm0-ai/vm0/commit/7022170536a28805f6cbcb7e625e84755552b898))
* add qwen image 3 and nano banana 2 lite built-in image models ([#28518](https://github.com/vm0-ai/vm0/issues/28518)) ([9691fc3](https://github.com/vm0-ai/vm0/commit/9691fc30b999724efd07d2d82c384c47ff59c150))
* **agentphone:** decouple provider identity from public brand ([#28953](https://github.com/vm0-ai/vm0/issues/28953)) ([e7fcd06](https://github.com/vm0-ai/vm0/commit/e7fcd06ba2647f55d8a83e7e94be2ed066b74a97))
* **api:** add explicit single-account connector intent ([#28597](https://github.com/vm0-ai/vm0/issues/28597)) ([67b73e4](https://github.com/vm0-ai/vm0/commit/67b73e43e2b58ca976542aadd4ade39848df4055))
* **api:** add managed model fallback resolver ([#28301](https://github.com/vm0-ai/vm0/issues/28301)) ([745a08f](https://github.com/vm0-ai/vm0/commit/745a08fa51b6b0b51208fae1a02ec599664be115))
* **api:** add managed model provider failure endpoint ([#28451](https://github.com/vm0-ai/vm0/issues/28451)) ([238a43a](https://github.com/vm0-ai/vm0/commit/238a43a6dc281b65e06a212fbd5203d82b5f5cf6))
* **api:** add managed socialkit service ([#28343](https://github.com/vm0-ai/vm0/issues/28343)) ([94f6768](https://github.com/vm0-ai/vm0/commit/94f67682a19fd19310449075a7cf9bcf40e5a52f))
* **api:** add safe single-account connector disconnect ([#28598](https://github.com/vm0-ai/vm0/issues/28598)) ([a231b7b](https://github.com/vm0-ai/vm0/commit/a231b7b09db3abe563358dafac2ccaa2b2cb26d0))
* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))
* **api:** lengthen managed provider cooldowns ([#28814](https://github.com/vm0-ai/vm0/issues/28814)) ([25eb71e](https://github.com/vm0-ai/vm0/commit/25eb71ef51473cc3f53e35b72fd2a053baf7cd9d))
* **api:** persist explicit thread connector account overrides ([#28355](https://github.com/vm0-ai/vm0/issues/28355)) ([772de1c](https://github.com/vm0-ai/vm0/commit/772de1c01b70948fb41c07e3db4e5c6e7a01cada))
* **api:** pin chat thread media models at creation ([#28291](https://github.com/vm0-ai/vm0/issues/28291)) ([3b8a560](https://github.com/vm0-ai/vm0/commit/3b8a5602cdcd899bdb80f7a8176b784296eb2300))
* **api:** publish an analysed deck as a presentation template ([#28298](https://github.com/vm0-ai/vm0/issues/28298)) ([2080670](https://github.com/vm0-ai/vm0/commit/20806707e9adbcd9bd87043976d8327dc36a4f69))
* **api:** register legacy branded paths for migrated neutral routes ([#28404](https://github.com/vm0-ai/vm0/issues/28404)) ([43505eb](https://github.com/vm0-ai/vm0/commit/43505eb7a0d12173f29529580a0a6e54c68a56fc))
* **api:** resolve a user's own presentation template for a generation run ([#28536](https://github.com/vm0-ai/vm0/issues/28536)) ([1db3d99](https://github.com/vm0-ai/vm0/commit/1db3d99c96b5a2fa8fec2324d644f073a9622912))
* **artifacts:** emit branded cdn urls ([#28411](https://github.com/vm0-ai/vm0/issues/28411)) ([9dd558f](https://github.com/vm0-ai/vm0/commit/9dd558f3043a5ffdf72627fa367ae8750be3e86d))
* **banking:** add chat-based mastercard connect flow ([#28832](https://github.com/vm0-ai/vm0/issues/28832)) ([faf1021](https://github.com/vm0-ai/vm0/commit/faf10210ffc1a956a1c3f077e3410bcc27ae4cb8))
* **cli:** centralize presentation image batches ([#28702](https://github.com/vm0-ai/vm0/issues/28702)) ([20d4d4a](https://github.com/vm0-ai/vm0/commit/20d4d4ab952501195939c64236dab143bbbdd159))
* **composer:** offer one model per family in the media pickers ([#28510](https://github.com/vm0-ai/vm0/issues/28510)) ([3389b85](https://github.com/vm0-ai/vm0/commit/3389b85bbb3916d38a71661227ccfc1d02662e75))
* **connectors:** enable direct okou oauth callback for cloudflare ([#28424](https://github.com/vm0-ai/vm0/issues/28424)) ([0a63071](https://github.com/vm0-ai/vm0/commit/0a63071d1a98f7d2e52c89af64185123da81fdaa))
* **connectors:** enable direct okou oauth callback for notion ([#28434](https://github.com/vm0-ai/vm0/issues/28434)) ([fa9916f](https://github.com/vm0-ai/vm0/commit/fa9916f3b0784d2f5f0e064e3077d117c80b8085))
* **connectors:** enable direct okou oauth callbacks for four providers ([#28616](https://github.com/vm0-ai/vm0/issues/28616)) ([ced2d38](https://github.com/vm0-ai/vm0/commit/ced2d38e547693fa58789d69ed4a55d280e99ec9))
* **connectors:** enable multi-account lifecycle ([#28519](https://github.com/vm0-ai/vm0/issues/28519)) ([c5926f2](https://github.com/vm0-ai/vm0/commit/c5926f2a383dded86f8e67d9fc413817879fa75c))
* **connectors:** route ready oauth callbacks directly to okou ([#28408](https://github.com/vm0-ai/vm0/issues/28408)) ([5beedda](https://github.com/vm0-ai/vm0/commit/5beedda00ed8e28df54f293b0190fb7592756f73))
* **core:** enable usage pack plans for staff ([#28503](https://github.com/vm0-ai/vm0/issues/28503)) ([14a9a65](https://github.com/vm0-ai/vm0/commit/14a9a653f13e028a63e8bfe439fbf9a6c53361c0))
* **core:** roll out usage pack plans ([#28771](https://github.com/vm0-ai/vm0/issues/28771)) ([f83844e](https://github.com/vm0-ai/vm0/commit/f83844e5aaafee2c8ad6c2f8048c90483a144fa2))
* **feishu:** preserve host-derived public branding ([#28935](https://github.com/vm0-ai/vm0/issues/28935)) ([bbb60c7](https://github.com/vm0-ai/vm0/commit/bbb60c70fb46dcc1ca6a15694de0770edba98c95))
* **github:** preserve public brand across app ingress ([#28942](https://github.com/vm0-ai/vm0/issues/28942)) ([3d4bdf6](https://github.com/vm0-ai/vm0/commit/3d4bdf623e7694804ea244ce5eed0557c4c567f4))
* **host:** emit branded hosted site urls ([#28387](https://github.com/vm0-ai/vm0/issues/28387)) ([d098306](https://github.com/vm0-ai/vm0/commit/d09830659571868c9e79cd9c9e7e501661bd05d7))
* let staff cancel built-in model cooldowns ([#29142](https://github.com/vm0-ai/vm0/issues/29142)) ([d0ab9d6](https://github.com/vm0-ai/vm0/commit/d0ab9d6c8534491a06878c9d705f726e440cb4c5)), closes [#29121](https://github.com/vm0-ai/vm0/issues/29121)
* **platform:** add multi-account connector settings ([#28904](https://github.com/vm0-ai/vm0/issues/28904)) ([e8d0c2a](https://github.com/vm0-ai/vm0/commit/e8d0c2acb679ccd23b218a694aaf1a6893f97791))
* **platform:** show managed model cooldown diagnostics ([#28733](https://github.com/vm0-ai/vm0/issues/28733)) ([f86c836](https://github.com/vm0-ai/vm0/commit/f86c836c2f5275ca97b288a757a3d5e118ca0566))
* point runs at the deck reverse-engineering guide ([#28362](https://github.com/vm0-ai/vm0/issues/28362)) ([8022cb6](https://github.com/vm0-ai/vm0/commit/8022cb61be52befefacfd44e1d758bd1a54f7584))
* **presentation:** refresh the built-in template archives to 71ff2fb ([#28728](https://github.com/vm0-ai/vm0/issues/28728)) ([6053443](https://github.com/vm0-ai/vm0/commit/605344368e64757a5ac2ce9fe113d2a20fd2369c))
* **presentation:** switch built-in decks to the latest template archives ([#28645](https://github.com/vm0-ai/vm0/issues/28645)) ([7c4a3a9](https://github.com/vm0-ai/vm0/commit/7c4a3a9fc7a1608f4033c8d20866c30f9510be66))
* pull presentation reverse-template from r2 ([#29043](https://github.com/vm0-ai/vm0/issues/29043)) ([5da72eb](https://github.com/vm0-ai/vm0/commit/5da72eb706544d50731cab880c4d006979b63afe))
* **rebranding:** emit branded static asset urls ([#28446](https://github.com/vm0-ai/vm0/issues/28446)) ([3eb6c67](https://github.com/vm0-ai/vm0/commit/3eb6c679aef093e43d24dd3c625cb526cc461c7f))
* roll out image and video model selection to all users ([#29042](https://github.com/vm0-ai/vm0/issues/29042)) ([9c61cec](https://github.com/vm0-ai/vm0/commit/9c61cecb5a6f5a4dfcaa045910a4646d1576f5fe))
* serve direct-html website templates behind the latest switch ([#29053](https://github.com/vm0-ai/vm0/issues/29053)) ([508d9ec](https://github.com/vm0-ai/vm0/commit/508d9eca8eeb05694499d28d6f8114f2f336b69a))
* show runtime model routes in activity diagnostics ([#28866](https://github.com/vm0-ai/vm0/issues/28866)) ([f9e7acc](https://github.com/vm0-ai/vm0/commit/f9e7acc8a26b9bcf7fc13fd094a3acf05562015d))
* **slack:** migrate official app to okou ([#28795](https://github.com/vm0-ai/vm0/issues/28795)) ([57d1a9f](https://github.com/vm0-ai/vm0/commit/57d1a9f500272b2b8214462fcbc640528103dd8f))
* **social:** add managed socialkit pagination and usage billing ([#29180](https://github.com/vm0-ai/vm0/issues/29180)) ([72a60ca](https://github.com/vm0-ai/vm0/commit/72a60ca0aa52e611cc544eb4d7062581fc498106))
* support workspace presentation templates ([#28596](https://github.com/vm0-ai/vm0/issues/28596)) ([f25dbbb](https://github.com/vm0-ai/vm0/commit/f25dbbbae2aae3546070a36eaeead062ec563ee7))
* **teams:** separate provider identity from public brand ([#28938](https://github.com/vm0-ai/vm0/issues/28938)) ([6e717c5](https://github.com/vm0-ai/vm0/commit/6e717c58fad35281b0e30e296ea135ed9487d363))
* **telegram:** support dual-brand ingress ([#28945](https://github.com/vm0-ai/vm0/issues/28945)) ([c5f6b87](https://github.com/vm0-ai/vm0/commit/c5f6b87adc0ba25a73bddd595d5740360fd32d0d))


### Bug Fixes

* align paid concurrency with plan endings ([#28370](https://github.com/vm0-ai/vm0/issues/28370)) ([4fbaafa](https://github.com/vm0-ai/vm0/commit/4fbaafa3586cdbe6f08a23f6adc198f81cd8d68b))
* **api:** attribute direct axiom ingest failures ([#28321](https://github.com/vm0-ai/vm0/issues/28321)) ([84f2574](https://github.com/vm0-ai/vm0/commit/84f25749ee37387489a1a72b02324ef07c13e38c))
* **api:** centralize clerk backend api read retries ([#28282](https://github.com/vm0-ai/vm0/issues/28282)) ([fa029e5](https://github.com/vm0-ai/vm0/commit/fa029e5286f7d28e8f9d6be234b9c5468847b6b5))
* **api:** disable unsupported openrouter deepseek apply patch ([#28656](https://github.com/vm0-ai/vm0/issues/28656)) ([4cffdec](https://github.com/vm0-ai/vm0/commit/4cffdec2f1d080c2147ca134d80eabf65de023ea))
* **api:** harden usage pack purchase billing ([#28304](https://github.com/vm0-ai/vm0/issues/28304)) ([17ba3cd](https://github.com/vm0-ai/vm0/commit/17ba3cdfd57c8c980dedab902c2ed49ed51d0a4f))
* **api:** let fetch set google drive upload content length ([#29138](https://github.com/vm0-ai/vm0/issues/29138)) ([30807be](https://github.com/vm0-ai/vm0/commit/30807be2837a5a34fa78c2e9d5e02e9672e5bcaa))
* **api:** refresh codex token before reset credit ([#28856](https://github.com/vm0-ai/vm0/issues/28856)) ([1367deb](https://github.com/vm0-ai/vm0/commit/1367deb14cffd2953625045b512cfd426eaf7543))
* **api:** refresh codex tokens before subscription usage ([#28828](https://github.com/vm0-ai/vm0/issues/28828)) ([46e6e2e](https://github.com/vm0-ai/vm0/commit/46e6e2e08da5d64ea83b500865e2280ab9338e60))
* **api:** remove redundant axiom reduction log ([#28786](https://github.com/vm0-ai/vm0/issues/28786)) ([4371cb2](https://github.com/vm0-ai/vm0/commit/4371cb2d8a3d939ca8d473d88567fd2ef8b5235f))
* **api:** restrict connector resolution warnings ([#28863](https://github.com/vm0-ai/vm0/issues/28863)) ([b54cf0b](https://github.com/vm0-ai/vm0/commit/b54cf0bf1bd4f52bc3925b5bbbe9cfd57a130279))
* **api:** share clerk read context across pagination ([#28375](https://github.com/vm0-ai/vm0/issues/28375)) ([7b4ddaf](https://github.com/vm0-ai/vm0/commit/7b4ddaf58a670d8183e5cf7f8e1fc10dbfab43df))
* **api:** stop logging expected unknown connector misses ([#28803](https://github.com/vm0-ai/vm0/issues/28803)) ([e7897f5](https://github.com/vm0-ai/vm0/commit/e7897f5a93a4687edfda96433a350005955510e1))
* **automation:** defer run-finished events until goals stop ([#28410](https://github.com/vm0-ai/vm0/issues/28410)) ([d393d05](https://github.com/vm0-ai/vm0/commit/d393d054e17c215a6635b1e6eb598c41b6297235))
* **billing:** harden usage pack reconciliation ([#28578](https://github.com/vm0-ai/vm0/issues/28578)) ([4cd666c](https://github.com/vm0-ai/vm0/commit/4cd666c384d6200e703bd6f247d85f791af07b28))
* **billing:** support fully discounted usage pack purchases ([#28392](https://github.com/vm0-ai/vm0/issues/28392)) ([618645c](https://github.com/vm0-ai/vm0/commit/618645c51eae8aa9df3ac3766f770a45d94d3390))
* **cli:** restore release-please version bookkeeping ([#28718](https://github.com/vm0-ai/vm0/issues/28718)) ([9385ba6](https://github.com/vm0-ai/vm0/commit/9385ba6a6d2e931dd1a078555cc3fed699db4aae))
* **connectors:** handle removed catalog references ([#28450](https://github.com/vm0-ai/vm0/issues/28450)) ([17d96ad](https://github.com/vm0-ai/vm0/commit/17d96ad7f324571e121833ed6c6e15b13258158f))
* **connectors:** simplify multi-account settings interactions ([#29094](https://github.com/vm0-ai/vm0/issues/29094)) ([023b916](https://github.com/vm0-ai/vm0/commit/023b916626ff1488f54ed6c5d10658fbf0f34e7c))
* **core:** make workflow template guidance brand-neutral ([#28778](https://github.com/vm0-ai/vm0/issues/28778)) ([a5f429a](https://github.com/vm0-ai/vm0/commit/a5f429a9063785caf6f52a0e95980cfb59bcdf81))
* **guest:** isolate managed claude config from user home ([#28324](https://github.com/vm0-ai/vm0/issues/28324)) ([c6a20ba](https://github.com/vm0-ai/vm0/commit/c6a20babf5f75ffac7ac97f69c570ba1ddb2ef23))
* handle revoked claude code oauth tokens ([#29181](https://github.com/vm0-ai/vm0/issues/29181)) ([fefb3c9](https://github.com/vm0-ai/vm0/commit/fefb3c9a1a46d6239f9646b2280054e1ee133687))
* log successful stripe reconciliation at debug level ([#28811](https://github.com/vm0-ai/vm0/issues/28811)) ([398a0d6](https://github.com/vm0-ai/vm0/commit/398a0d62fdbd6538c5825727326a3a794d96d0de))
* polish uploaded presentation templates ([#28671](https://github.com/vm0-ai/vm0/issues/28671)) ([687ef27](https://github.com/vm0-ai/vm0/commit/687ef278ec5b6164e40d0e7ed48ba75e49a1b648))
* prefetch uploaded template previews ([#28705](https://github.com/vm0-ai/vm0/issues/28705)) ([e17447c](https://github.com/vm0-ai/vm0/commit/e17447c69a398ee38598b00beeb791483482f841))
* **rebranding:** neutralize agent-facing brand copy ([#29167](https://github.com/vm0-ai/vm0/issues/29167)) ([d1a4cc6](https://github.com/vm0-ai/vm0/commit/d1a4cc63dfc912c36e636315772d9353ee190334))
* **rebranding:** neutralize built-in model copy ([#28552](https://github.com/vm0-ai/vm0/issues/28552)) ([73e0185](https://github.com/vm0-ai/vm0/commit/73e01850d99402125c4ea9f12eb4af6dc9d0f953))
* revise chat usage after late settlement ([#28378](https://github.com/vm0-ai/vm0/issues/28378)) ([21ca637](https://github.com/vm0-ai/vm0/commit/21ca637a2975b12d44aa1dce9d62633e89fb0556))
* **runner:** bound firewall catalog response bodies ([#28399](https://github.com/vm0-ai/vm0/issues/28399)) ([1732568](https://github.com/vm0-ai/vm0/commit/17325687f4950e089ce565d1e33737b5822b19be))
* sync workspace presentation templates without picker flicker ([#29054](https://github.com/vm0-ai/vm0/issues/29054)) ([0309fcb](https://github.com/vm0-ai/vm0/commit/0309fcb9dd1c15a3c7138df003cc28d10286e1de))
* **usage:** bound model usage quantities ([#28351](https://github.com/vm0-ai/vm0/issues/28351)) ([d91265c](https://github.com/vm0-ai/vm0/commit/d91265c8761b3c40eb7e91a8ac6bcfaa0bdad4f8))
* **video:** default to a video model the picker offers ([#29045](https://github.com/vm0-ai/vm0/issues/29045)) ([33a6dba](https://github.com/vm0-ai/vm0/commit/33a6dba91522f57fc231773833d1cac9ad88a2e4))


### Documentation

* **api:** align test descriptions with the agent vocabulary ([#28792](https://github.com/vm0-ai/vm0/issues/28792)) ([e38158d](https://github.com/vm0-ai/vm0/commit/e38158d0bc1d56b3c7379eecb2ca9962e3f273b8)), closes [#28785](https://github.com/vm0-ai/vm0/issues/28785)
* drop dead apps/web paths from apps/api provenance comments ([#28774](https://github.com/vm0-ai/vm0/issues/28774)) ([03e7ddf](https://github.com/vm0-ai/vm0/commit/03e7ddf6fa650ddfc687636d593647c6dac69503)), closes [#28772](https://github.com/vm0-ai/vm0/issues/28772)


### Refactoring

* **agent:** make canonical agent writes authoritative ([#28721](https://github.com/vm0-ai/vm0/issues/28721)) ([64660cf](https://github.com/vm0-ai/vm0/commit/64660cfe57097da7209d0182e132158374292ac8))
* **agent:** seal legacy schema absence ([#28784](https://github.com/vm0-ai/vm0/issues/28784)) ([d6fd49a](https://github.com/vm0-ai/vm0/commit/d6fd49a9ac5815697d586e72759f93448a789e6c))
* **api:** cut agent reads to canonical data plane ([#28683](https://github.com/vm0-ai/vm0/issues/28683)) ([0e009c5](https://github.com/vm0-ai/vm0/commit/0e009c54ef67a38400dd464d5a0a3b551612826a))
* **api:** drop the branded compatibility row for uploads/prepare ([#28978](https://github.com/vm0-ai/vm0/issues/28978)) ([65517f9](https://github.com/vm0-ai/vm0/commit/65517f9335cb31efb0c75e1c5e71e04ac734d1ed))
* **api:** drop the branded compatibility rows whose producers cut over ([#28939](https://github.com/vm0-ai/vm0/issues/28939)) ([89e2bf6](https://github.com/vm0-ai/vm0/commit/89e2bf6c74a385eb9f8fb5b660625a8093248ba3))
* **api:** drop the branded compatibility rows with no traffic ([#28715](https://github.com/vm0-ai/vm0/issues/28715)) ([7a04e16](https://github.com/vm0-ai/vm0/commit/7a04e1681278369627f0b9521bbdaf13e64f84fb))
* **api:** drop the branded compatibility rows with no traffic in the window ([#28941](https://github.com/vm0-ai/vm0/issues/28941)) ([6baa556](https://github.com/vm0-ai/vm0/commit/6baa55638a677520cc6119b94c6d3837c2376130))
* **api:** drop the drained branded compatibility rows ([#28716](https://github.com/vm0-ai/vm0/issues/28716)) ([46c9745](https://github.com/vm0-ai/vm0/commit/46c9745b079615add81fc3484bb950e876755552))
* **api:** dual-read machine secret environment aliases ([#29021](https://github.com/vm0-ai/vm0/issues/29021)) ([b7fe9d4](https://github.com/vm0-ai/vm0/commit/b7fe9d4bb6efed9d7b6a60517962eb67651c4abb))
* **api:** dual-read preview job reference aliases ([#29048](https://github.com/vm0-ai/vm0/issues/29048)) ([7700bfb](https://github.com/vm0-ai/vm0/commit/7700bfb122d984153432b7d309f7334336028566))
* **api:** dual-write codex service-tier environment aliases ([#29168](https://github.com/vm0-ai/vm0/issues/29168)) ([0cc5d7e](https://github.com/vm0-ai/vm0/commit/0cc5d7e5753fbcc6eb6132f33758ad0bac0c6730)), closes [#28914](https://github.com/vm0-ai/vm0/issues/28914)
* **api:** dual-write preview job reference aliases ([#29140](https://github.com/vm0-ai/vm0/issues/29140)) ([f4cc406](https://github.com/vm0-ai/vm0/commit/f4cc4066ea21b4158d75d104b737750ce90392a3))
* **api:** isolate connector singleton compatibility ([#28658](https://github.com/vm0-ai/vm0/issues/28658)) ([1a822c0](https://github.com/vm0-ai/vm0/commit/1a822c0580d12bc6c4b2001a76c61e7bd203b9e5))
* **api:** make connector authorization state writers explicit ([#28731](https://github.com/vm0-ai/vm0/issues/28731)) ([7e2222b](https://github.com/vm0-ai/vm0/commit/7e2222b56632c337a62328b924315e530df98f8e))
* **api:** migrate the late branded contracts and guard the namespace ([#28577](https://github.com/vm0-ai/vm0/issues/28577)) ([d568056](https://github.com/vm0-ai/vm0/commit/d5680566144451411311656dd5a3c6c0bb312f02))
* **api:** move agents, workflows, and workflow automations off the brand namespace ([#28497](https://github.com/vm0-ai/vm0/issues/28497)) ([ee1f56f](https://github.com/vm0-ai/vm0/commit/ee1f56f9a4994b5b6978e6e8515fdbe9df9e6970))
* **api:** move artifact catalog, logs, and run reads off the brand namespace ([#28435](https://github.com/vm0-ai/vm0/issues/28435)) ([fa800f0](https://github.com/vm0-ai/vm0/commit/fa800f04ec58ad7835649b2acc6000b8538154c5))
* **api:** move browser, finance, seo, and mcp connector routes off /api/okou ([#28433](https://github.com/vm0-ai/vm0/issues/28433)) ([1e4bdf3](https://github.com/vm0-ai/vm0/commit/1e4bdf3432ab0e27ae70da59abacdf4d74c14b60))
* **api:** move built-in-generations and image-io off the brand namespace ([#28432](https://github.com/vm0-ai/vm0/issues/28432)) ([d1c6c7c](https://github.com/vm0-ai/vm0/commit/d1c6c7c9d2b29af4c95949661fd9bcbd5359df54))
* **api:** move chat threads, chat events, and shared threads off the brand namespace ([#28471](https://github.com/vm0-ai/vm0/issues/28471)) ([6c2036f](https://github.com/vm0-ai/vm0/commit/6c2036fa7e5f02e01cf163ab1a515364e8ec29d8))
* **api:** move chat-thread, indicator and attribution routes off the brand namespace ([#28425](https://github.com/vm0-ai/vm0/issues/28425)) ([f0bf52e](https://github.com/vm0-ai/vm0/commit/f0bf52eb50e5f7bd30a4f3aa5eee00a5cf81d344))
* **api:** move computer-use off the brand namespace ([#28487](https://github.com/vm0-ai/vm0/issues/28487)) ([5edd3c9](https://github.com/vm0-ai/vm0/commit/5edd3c9c01c0a781cb4bd8d05b4de3c55faa06a8))
* **api:** move connectors and catalog off the brand namespace ([#28490](https://github.com/vm0-ai/vm0/issues/28490)) ([942449c](https://github.com/vm0-ai/vm0/commit/942449c2866e51c0d6e7148fc0b4220d1c8feb80))
* **api:** move desktop update routes off the brand namespace ([#28489](https://github.com/vm0-ai/vm0/issues/28489)) ([cef2269](https://github.com/vm0-ai/vm0/commit/cef2269fb823155ef359347544683ed3219149a9)), closes [#28465](https://github.com/vm0-ai/vm0/issues/28465)
* **api:** move host and goal routes off the brand namespace ([#28431](https://github.com/vm0-ai/vm0/issues/28431)) ([f4adc23](https://github.com/vm0-ai/vm0/commit/f4adc23a09b8e8d3f813964a85f0fe5523c52c5c))
* **api:** move integrations off the brand namespace ([#28488](https://github.com/vm0-ai/vm0/issues/28488)) ([cafdde6](https://github.com/vm0-ai/vm0/commit/cafdde60bbdcf29e58a45a0c72ec457103cf8588))
* **api:** move org, model provider, and usage routes off the brand namespace ([#28492](https://github.com/vm0-ai/vm0/issues/28492)) ([a8b8a31](https://github.com/vm0-ai/vm0/commit/a8b8a311c4abaaa2892dca6ad7b4437cb2a617e0))
* **api:** move slack, teams, and feishu connect routes off the brand namespace ([#28485](https://github.com/vm0-ai/vm0/issues/28485)) ([ae6999f](https://github.com/vm0-ai/vm0/commit/ae6999f9a1b4193cdf2bece16d0baba6cf343f30)), closes [#28464](https://github.com/vm0-ai/vm0/issues/28464)
* **api:** move the billing routes off the brand namespace ([#28486](https://github.com/vm0-ai/vm0/issues/28486)) ([464d080](https://github.com/vm0-ai/vm0/commit/464d080b5888e272579e09f338c0c72df3388a6c))
* **api:** move the last branded contract paths off the brand namespace ([#28604](https://github.com/vm0-ai/vm0/issues/28604)) ([81f42fe](https://github.com/vm0-ai/vm0/commit/81f42fee5695da5f2546606aba9fce5f84b9ca26)), closes [#28600](https://github.com/vm0-ai/vm0/issues/28600)
* **api:** move the last four download-file contracts off the brand namespace ([#28984](https://github.com/vm0-ai/vm0/issues/28984)) ([ea6d065](https://github.com/vm0-ai/vm0/commit/ea6d0652ca55fe6b43ed4dba16d364ce058aa72a))
* **api:** move user config and personal model provider routes off the brand namespace ([#28429](https://github.com/vm0-ai/vm0/issues/28429)) ([6ef5bd2](https://github.com/vm0-ai/vm0/commit/6ef5bd26a731fe5372c2fedd6dad7c173e1ff591))
* **api:** move web-search, scrape, recognize and translate off the brand namespace ([#28427](https://github.com/vm0-ai/vm0/issues/28427)) ([c8a9733](https://github.com/vm0-ai/vm0/commit/c8a9733a23590ae1513816b344e0e3e7da89d5c0))
* **api:** move web, uploads, voice-io and more off the brand namespace ([#28496](https://github.com/vm0-ai/vm0/issues/28496)) ([911553c](https://github.com/vm0-ai/vm0/commit/911553c29ebada5da274bdcaf647272e1f3aa8dd))
* **api:** narrow the legacy zero paths to the six still in use ([#28704](https://github.com/vm0-ai/vm0/issues/28704)) ([40c3bbb](https://github.com/vm0-ai/vm0/commit/40c3bbbe575c8226113493454431d6c139a13f36)), closes [#28701](https://github.com/vm0-ai/vm0/issues/28701)
* **api:** remove source-less connector credential fallback ([#28682](https://github.com/vm0-ai/vm0/issues/28682)) ([46497bd](https://github.com/vm0-ai/vm0/commit/46497bd2c2628a5b56f1ad68e1c1b9edfe27caf9))
* **api:** rename zero run vocabulary to agent run ([#28689](https://github.com/vm0-ai/vm0/issues/28689)) ([b8bed84](https://github.com/vm0-ai/vm0/commit/b8bed84d2ffb5210d63541c2f90b3cc75bd877ab))
* **api:** replace the blanket zero alias with an explicit compatibility table ([#28361](https://github.com/vm0-ai/vm0/issues/28361)) ([483d891](https://github.com/vm0-ai/vm0/commit/483d891afd08db289fe3a357cda62ee6f908b103))
* **api:** require persisted connector account mutation intent ([#28791](https://github.com/vm0-ai/vm0/issues/28791)) ([40a5bd4](https://github.com/vm0-ai/vm0/commit/40a5bd4165d4046db27f3f68e79bc47c6404cee5))
* **api:** retire target-only connector mutations ([#28708](https://github.com/vm0-ai/vm0/issues/28708)) ([a600615](https://github.com/vm0-ai/vm0/commit/a6006156e747df605582c3aa2742806f58263658))
* **api:** switch agent run model key reads to canonical column ([#28740](https://github.com/vm0-ai/vm0/issues/28740)) ([371ada0](https://github.com/vm0-ai/vm0/commit/371ada08e22d7380a72be8613a306390df0a4bdf))
* **auth:** rename the remaining zero capability helpers ([#28762](https://github.com/vm0-ai/vm0/issues/28762)) ([29b67a4](https://github.com/vm0-ai/vm0/commit/29b67a4f49360d77b2a9f4a05b5132f69aa615de)), closes [#28761](https://github.com/vm0-ai/vm0/issues/28761)
* **auth:** rename the zero token type to agent ([#28755](https://github.com/vm0-ai/vm0/issues/28755)) ([d95079d](https://github.com/vm0-ai/vm0/commit/d95079d894b290d602e2c62f7dff7da26527cccf)), closes [#28746](https://github.com/vm0-ai/vm0/issues/28746)
* **auth:** retire the zero token scope and rename the token vocabulary ([#28706](https://github.com/vm0-ai/vm0/issues/28706)) ([5ad6301](https://github.com/vm0-ai/vm0/commit/5ad630103e0c047b49046f21301dd2732a42753e)), closes [#28695](https://github.com/vm0-ai/vm0/issues/28695)
* clean up public brand rollout fallbacks ([#28804](https://github.com/vm0-ai/vm0/issues/28804)) ([4eb7221](https://github.com/vm0-ai/vm0/commit/4eb72219ad77a7f47692861ae20dbb274c02bbfb))
* **contracts:** neutralize custom connector and feature switch contract naming ([#28206](https://github.com/vm0-ai/vm0/issues/28206)) ([0610293](https://github.com/vm0-ai/vm0/commit/0610293ab1acdae01334925c81c79846c11a2009)), closes [#28190](https://github.com/vm0-ai/vm0/issues/28190)
* **contracts:** neutralize permission grant and connector contract naming ([#28200](https://github.com/vm0-ai/vm0/issues/28200)) ([5e3518c](https://github.com/vm0-ai/vm0/commit/5e3518c53373cae28513d5565f91eca9d12c11b9))
* **core:** rename zeroDebug feature switch to okouDebug ([#28816](https://github.com/vm0-ai/vm0/issues/28816)) ([9d86a26](https://github.com/vm0-ai/vm0/commit/9d86a26650ef5c7ac400356fb9f0fc6c173611e6))
* **db:** add canonical agents data plane ([#28603](https://github.com/vm0-ai/vm0/issues/28603)) ([e682443](https://github.com/vm0-ai/vm0/commit/e68244397f7ba6850468ebd9dc48cc1188138f0e))
* **db:** bridge agent run built-in model key ([#28691](https://github.com/vm0-ai/vm0/issues/28691)) ([9d66e10](https://github.com/vm0-ai/vm0/commit/9d66e1063659395968913764247f6985f3c20f7f))
* **db:** drop the presentation template status and error columns ([#28515](https://github.com/vm0-ai/vm0/issues/28515)) ([53b6214](https://github.com/vm0-ai/vm0/commit/53b6214b0ee5426414f6f6fa5eb428b4c169b380))
* **db:** expand built-in model cooldown storage ([#28960](https://github.com/vm0-ai/vm0/issues/28960)) ([60d9f18](https://github.com/vm0-ai/vm0/commit/60d9f18bcfdda3bfced447349c2bc78daa0bb336))
* **env:** drop the drained capability token fallbacks ([#28367](https://github.com/vm0-ai/vm0/issues/28367)) ([178b4dd](https://github.com/vm0-ai/vm0/commit/178b4dd144ce2d11c6d28ea467b18a6d25ed2439)), closes [#28365](https://github.com/vm0-ai/vm0/issues/28365)
* **env:** drop the remaining usage-pack price fallbacks ([#28775](https://github.com/vm0-ai/vm0/issues/28775)) ([df5580a](https://github.com/vm0-ai/vm0/commit/df5580afe6aa4bb51412c82e7c9fbc69f59a3bb0))
* **env:** drop the unreachable price fallbacks ([#28763](https://github.com/vm0-ai/vm0/issues/28763)) ([01d023d](https://github.com/vm0-ai/vm0/commit/01d023d267d70e8f42ead04c0c5db69f569cf09a)), closes [#28758](https://github.com/vm0-ai/vm0/issues/28758)
* **feishu:** emit the final webhook events path ([#28341](https://github.com/vm0-ai/vm0/issues/28341)) ([bc50564](https://github.com/vm0-ai/vm0/commit/bc50564204d21893361d05ee23468b6de3a99fef)), closes [#28338](https://github.com/vm0-ai/vm0/issues/28338)
* **feishu:** move the console-independent feishu routes off the brand namespace ([#28554](https://github.com/vm0-ai/vm0/issues/28554)) ([f777da2](https://github.com/vm0-ai/vm0/commit/f777da2eef71f94707c3e284743427068295fb8d))
* **feishu:** require public brand in oauth state ([#29166](https://github.com/vm0-ai/vm0/issues/29166)) ([f66362e](https://github.com/vm0-ai/vm0/commit/f66362edb5503609b1b121bd8aecd8d41d5db551))
* **github:** remove the dead oauth connect callback route ([#28352](https://github.com/vm0-ai/vm0/issues/28352)) ([a998483](https://github.com/vm0-ai/vm0/commit/a998483595a415683f079a4a97d718c256237652))
* **maps:** move the maps routes off the brand namespace ([#28426](https://github.com/vm0-ai/vm0/issues/28426)) ([3fbbed5](https://github.com/vm0-ai/vm0/commit/3fbbed5759ab8feb027af247513a5507fa0fcb00))
* migrate built-in model terminology ([#29079](https://github.com/vm0-ai/vm0/issues/29079)) ([4de6522](https://github.com/vm0-ai/vm0/commit/4de65229d749c81d2b27b5fdc15320e3da5d91ce))
* **platform:** rename the zero client factory to a neutral api name ([#28615](https://github.com/vm0-ai/vm0/issues/28615)) ([8a6a043](https://github.com/vm0-ai/vm0/commit/8a6a043acd0725a1c799ec70f8c8590658341ac8))
* **rebranding:** remove expired rollout fallbacks ([#28511](https://github.com/vm0-ai/vm0/issues/28511)) ([bc28080](https://github.com/vm0-ai/vm0/commit/bc2808047690c0e691eaa7c65f6e5c64c893a996))
* remove expired deployment compatibility ([#28452](https://github.com/vm0-ai/vm0/issues/28452)) ([cfc81f2](https://github.com/vm0-ai/vm0/commit/cfc81f2a5b5c833db1729ad889eae7b552e20dd3))
* remove expired deployment compatibility ([#28599](https://github.com/vm0-ai/vm0/issues/28599)) ([b820443](https://github.com/vm0-ai/vm0/commit/b820443bb6ddfae7e5997bf677fb76c461320798))
* remove expired deployment compatibility ([#28737](https://github.com/vm0-ai/vm0/issues/28737)) ([0cc15e9](https://github.com/vm0-ai/vm0/commit/0cc15e956208123c66769827f83d827f73f781ab))
* remove joggai built-in feature switch ([#28896](https://github.com/vm0-ai/vm0/issues/28896)) ([80a87fe](https://github.com/vm0-ai/vm0/commit/80a87fe81391786adb8448ea7c80bc4a13477c27))
* remove retired agent compose persistence plane ([#28880](https://github.com/vm0-ai/vm0/issues/28880)) ([7d91b6b](https://github.com/vm0-ai/vm0/commit/7d91b6bb470128e2a4598218a636692040a03f4e))
* remove saved billing credit purchase switch ([#28897](https://github.com/vm0-ai/vm0/issues/28897)) ([aba35fb](https://github.com/vm0-ai/vm0/commit/aba35fb74906723713fc01665389adf49681038c))
* **run:** finish the version-independent runtime cutover ([#28517](https://github.com/vm0-ai/vm0/issues/28517)) ([d6a1f75](https://github.com/vm0-ai/vm0/commit/d6a1f753c2146b421c09ce8cd0cae59212d169f0))
* **runtime:** add a trusted platform environment channel ([#28970](https://github.com/vm0-ai/vm0/issues/28970)) ([7d6e40b](https://github.com/vm0-ai/vm0/commit/7d6e40b7a8da820582587d96479f4da9f02932b6))
* **runtime:** reserve okou namespace in cloud execution ([#29040](https://github.com/vm0-ai/vm0/issues/29040)) ([233bc7e](https://github.com/vm0-ai/vm0/commit/233bc7eb29e9c03b4391e91f1fe15ce48d576de6))
* **teams:** move the teams routes off the brand namespace ([#28553](https://github.com/vm0-ai/vm0/issues/28553)) ([7cadbba](https://github.com/vm0-ai/vm0/commit/7cadbba2aa63e8e91a88fd25c4762cf5458042bf)), closes [#28545](https://github.com/vm0-ai/vm0/issues/28545)
* **weather:** move the weather routes off the brand namespace ([#28413](https://github.com/vm0-ai/vm0/issues/28413)) ([0386bee](https://github.com/vm0-ai/vm0/commit/0386beebc6a31d1f25b6ba50d47d8aff84dd7dfb))


### Performance Improvements

* **api:** attribute connector projection row latency ([#28635](https://github.com/vm0-ai/vm0/issues/28635)) ([d7440ff](https://github.com/vm0-ai/vm0/commit/d7440ff8031ddd144d35ea735410b02db5c5cb0b))
* **api:** attribute connector projection validation ([#28663](https://github.com/vm0-ai/vm0/issues/28663)) ([fdd69c0](https://github.com/vm0-ai/vm0/commit/fdd69c02efe454ea42ff14bbf19c49ad32fd1470))
* **api:** attribute dispatch timing to process residency ([#28622](https://github.com/vm0-ai/vm0/issues/28622)) ([086ce06](https://github.com/vm0-ai/vm0/commit/086ce0661645e03c574e416f43cb1d81eeffa85f))
* **api:** attribute queued promotion lock contention ([#28780](https://github.com/vm0-ai/vm0/issues/28780)) ([35b7d28](https://github.com/vm0-ai/vm0/commit/35b7d28e5f301eb4acd091b74394f81b0aad163e))
* **api:** read attested connector projection payloads ([#28699](https://github.com/vm0-ai/vm0/issues/28699)) ([f40d5ea](https://github.com/vm0-ai/vm0/commit/f40d5ea90b2fc4649cd336d083ce9d97573fb9ed))
* **api:** remove speculative queue scan lock ([#28436](https://github.com/vm0-ai/vm0/issues/28436)) ([bd31c7c](https://github.com/vm0-ai/vm0/commit/bd31c7c0fc420ee55e3df8d4a2ab28e9c2a2a708))
* **api:** resolve v2 attachments by exact key ([#29050](https://github.com/vm0-ai/vm0/issues/29050)) ([ef9166e](https://github.com/vm0-ai/vm0/commit/ef9166edd6be99903b357294c8179206111330fe))
* **api:** serve scoped connector runtime from exact-identity projections ([#28513](https://github.com/vm0-ai/vm0/issues/28513)) ([dae3148](https://github.com/vm0-ai/vm0/commit/dae3148d93667fcf1ae828f0f2ef0150ee02a822))
* **runner:** attribute pre-spawn concurrency ([#28839](https://github.com/vm0-ai/vm0/issues/28839)) ([5e11ce3](https://github.com/vm0-ai/vm0/commit/5e11ce3b6aedbd502c94dd07ff68a5209cb4e101))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @okouai/api-contracts bumped to 1.363.0
    * @okouai/core bumped to 8.590.0
    * @okouai/db bumped to 1.223.0
</details>

<details><summary>ably-subscriber: 1.0.18</summary>

## [1.0.18](https://github.com/vm0-ai/vm0/compare/ably-subscriber-v1.0.17...ably-subscriber-v1.0.18) (2026-08-25)


### Bug Fixes

* **ably-subscriber:** bound token exchange responses ([#29218](https://github.com/vm0-ai/vm0/issues/29218)) ([723cae9](https://github.com/vm0-ai/vm0/commit/723cae9fffd97b08f325c577e95d789bc2979bfb))
</details>

<details><summary>guest-agent: 0.77.0</summary>

## [0.77.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.76.0...guest-agent-v0.77.0) (2026-08-25)


### Features

* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))


### Bug Fixes

* **events:** preserve timeout and connect observations ([#28397](https://github.com/vm0-ai/vm0/issues/28397)) ([c3d536e](https://github.com/vm0-ai/vm0/commit/c3d536eab61fca8e2006a7664a982b993537db00))
* **guest-agent:** classify mid-response failures ([#28393](https://github.com/vm0-ai/vm0/issues/28393)) ([4ca21bd](https://github.com/vm0-ai/vm0/commit/4ca21bdbe47a2ce99f34c343b074f83c45775483))
* **guest-agent:** ignore task notification results ([#28534](https://github.com/vm0-ai/vm0/issues/28534)) ([db3e953](https://github.com/vm0-ai/vm0/commit/db3e95327b14181d74456de8f00120bd1e186be0))
* **guest-agent:** keep claude appended prompts out of argv ([#28838](https://github.com/vm0-ai/vm0/issues/28838)) ([0bd96d6](https://github.com/vm0-ai/vm0/commit/0bd96d69d6b9121e37232080a35111550f709424))
* **guest-agent:** mask sandbox operation telemetry ([#28512](https://github.com/vm0-ai/vm0/issues/28512)) ([d81bf2d](https://github.com/vm0-ai/vm0/commit/d81bf2d0505e96a7e76efc5365c2275e271dca2f))
* **guest-agent:** redact multiline secrets in telemetry ([#28514](https://github.com/vm0-ai/vm0/issues/28514)) ([484c288](https://github.com/vm0-ai/vm0/commit/484c28853522c09be3eca6e9aa21726169dc0665))
* **guest-agent:** reject artifact roots with linked ancestors ([#28899](https://github.com/vm0-ai/vm0/issues/28899)) ([8923a95](https://github.com/vm0-ai/vm0/commit/8923a95def24f40702c333043b48b7c3cd83600d))
* **guest:** isolate managed claude config from user home ([#28324](https://github.com/vm0-ai/vm0/issues/28324)) ([c6a20ba](https://github.com/vm0-ai/vm0/commit/c6a20babf5f75ffac7ac97f69c570ba1ddb2ef23))
* handle revoked claude code oauth tokens ([#29181](https://github.com/vm0-ai/vm0/issues/29181)) ([fefb3c9](https://github.com/vm0-ai/vm0/commit/fefb3c9a1a46d6239f9646b2280054e1ee133687))
* **runner:** isolate shell tool oom cleanup ([#28391](https://github.com/vm0-ai/vm0/issues/28391)) ([ffb0332](https://github.com/vm0-ai/vm0/commit/ffb03327e60854d4e5e541b34a2f3423cfcee6f2))


### Documentation

* **rust:** document guest event preparation and posting boundaries ([#28918](https://github.com/vm0-ai/vm0/issues/28918)) ([4aaa4ee](https://github.com/vm0-ai/vm0/commit/4aaa4ee66ba3a54473ee1d34c3ef12e861894234))


### Refactoring

* **guest-agent:** dual-read api token environment aliases ([#29062](https://github.com/vm0-ai/vm0/issues/29062)) ([1f21af7](https://github.com/vm0-ai/vm0/commit/1f21af778ef9513a49ee40de8e6176aba08e80ac))
* **guest-agent:** dual-read codex service-tier environment aliases ([#29038](https://github.com/vm0-ai/vm0/issues/29038)) ([dc84c21](https://github.com/vm0-ai/vm0/commit/dc84c21c569fc9919321c27ee2af32209d319ee7))
* **runtime:** dual-read cgroup placement environment aliases ([#29081](https://github.com/vm0-ai/vm0/issues/29081)) ([7beb4d5](https://github.com/vm0-ai/vm0/commit/7beb4d545bef801b7dd0bd2c107829869cd022ed))
* **runtime:** dual-read guest runtime directory aliases ([#29101](https://github.com/vm0-ai/vm0/issues/29101)) ([3bb5b28](https://github.com/vm0-ai/vm0/commit/3bb5b2807090c3cf48650b917ccca00bdb44f370))
* **runtime:** dual-read private payload file env aliases ([#29082](https://github.com/vm0-ai/vm0/issues/29082)) ([e400e00](https://github.com/vm0-ai/vm0/commit/e400e0058cd63cc18b478ad807da42f9b5bb5e74))
* **runtime:** dual-read process-control environment aliases ([#29071](https://github.com/vm0-ai/vm0/issues/29071)) ([c9cde49](https://github.com/vm0-ai/vm0/commit/c9cde495a4ba6f43c409476a68733bdade8cb99c))
* **runtime:** dual-read resume session environment aliases ([#29069](https://github.com/vm0-ai/vm0/issues/29069)) ([6dd54e9](https://github.com/vm0-ai/vm0/commit/6dd54e909a8607421344e758adcb887f72f8f0de))
* **runtime:** dual-read run metadata env aliases ([#29022](https://github.com/vm0-ai/vm0/issues/29022)) ([928d53b](https://github.com/vm0-ai/vm0/commit/928d53b17819c1c82f76da3aa8e4e672c69431d1))


### Performance Improvements

* **guest-agent:** bound reuse cleanup memory ([#28593](https://github.com/vm0-ai/vm0/issues/28593)) ([23ac7ce](https://github.com/vm0-ai/vm0/commit/23ac7ce52340901becc277fa521dd649b8d23d59))
* **guest-agent:** buffer transcript writes ([#28881](https://github.com/vm0-ai/vm0/issues/28881)) ([a401186](https://github.com/vm0-ai/vm0/commit/a401186650c98a904bf4d4f435868f91239d20d1))
* **guest-agent:** retain compact pi terminal state ([#29179](https://github.com/vm0-ai/vm0/issues/29179)) ([6e5f64e](https://github.com/vm0-ai/vm0/commit/6e5f64ecdc9d0c0024ecd62fab55b9baccdf1fda))
* **rust:** bound generic codex completed-item fields ([#28876](https://github.com/vm0-ai/vm0/issues/28876)) ([b13d3d2](https://github.com/vm0-ai/vm0/commit/b13d3d21e2630ac4472083988f4ca2766fa1b3e1))
</details>

<details><summary>guest-download: 0.23.22</summary>

## [0.23.22](https://github.com/vm0-ai/vm0/compare/guest-download-v0.23.21...guest-download-v0.23.22) (2026-08-25)


### Performance Improvements

* **guest-download:** release slots during retry backoff ([#29216](https://github.com/vm0-ai/vm0/issues/29216)) ([974d5e6](https://github.com/vm0-ai/vm0/commit/974d5e6cbe8387297c0fafb089ed5f7245ee6469))
</details>

<details><summary>guest-init: 0.16.186</summary>

## [0.16.186](https://github.com/vm0-ai/vm0/compare/guest-init-v0.16.185...guest-init-v0.16.186) (2026-08-25)
</details>

<details><summary>runner-rs: 0.173.0</summary>

## [0.173.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.172.0...runner-rs-v0.173.0) (2026-08-25)


### Features

* **api:** add strict pi api first-turn handoff ([#28664](https://github.com/vm0-ai/vm0/issues/28664)) ([4bc9ef0](https://github.com/vm0-ai/vm0/commit/4bc9ef063e244a3f3af8dbc9ab94fd173208b93c))
* **runner:** report trusted model provider failures ([#28532](https://github.com/vm0-ai/vm0/issues/28532)) ([95a6ecd](https://github.com/vm0-ai/vm0/commit/95a6ecd44582d3bedf35b97f6874a01f2d7c6a34))


### Bug Fixes

* **events:** preserve timeout and connect observations ([#28397](https://github.com/vm0-ai/vm0/issues/28397)) ([c3d536e](https://github.com/vm0-ai/vm0/commit/c3d536eab61fca8e2006a7664a982b993537db00))
* **guest-agent:** classify mid-response failures ([#28393](https://github.com/vm0-ai/vm0/issues/28393)) ([4ca21bd](https://github.com/vm0-ai/vm0/commit/4ca21bdbe47a2ce99f34c343b074f83c45775483))
* **guest-agent:** keep claude appended prompts out of argv ([#28838](https://github.com/vm0-ai/vm0/issues/28838)) ([0bd96d6](https://github.com/vm0-ai/vm0/commit/0bd96d69d6b9121e37232080a35111550f709424))
* **guest:** isolate managed claude config from user home ([#28324](https://github.com/vm0-ai/vm0/issues/28324)) ([c6a20ba](https://github.com/vm0-ai/vm0/commit/c6a20babf5f75ffac7ac97f69c570ba1ddb2ef23))
* **python:** bound request header name work ([#28342](https://github.com/vm0-ai/vm0/issues/28342)) ([ffcd0fa](https://github.com/vm0-ai/vm0/commit/ffcd0fa83312ab7f20ed517ba717ee01721fca28))
* **python:** clamp managed provider retry-after delays ([#28652](https://github.com/vm0-ai/vm0/issues/28652)) ([525dd58](https://github.com/vm0-ai/vm0/commit/525dd588b1cef082c5ced8e419e07e73c469b1de))
* **python:** classify openrouter 500 responses by body ([#28644](https://github.com/vm0-ai/vm0/issues/28644)) ([16bd0b2](https://github.com/vm0-ai/vm0/commit/16bd0b2bca552eee731b7d53cfedf5475b9b5bf3))
* **python:** drain retained diagnostics after webhook shutdown ([#28981](https://github.com/vm0-ai/vm0/issues/28981)) ([6eae21b](https://github.com/vm0-ai/vm0/commit/6eae21bde1096293028cf6a6d1161a2e0e6ae7dd))
* **python:** lint unbound metadata mutation calls ([#29124](https://github.com/vm0-ai/vm0/issues/29124)) ([c906c06](https://github.com/vm0-ai/vm0/commit/c906c067e2ba16777e0a1d5b1a9ce815f4196f3f))
* **python:** reject negative x response counts ([#28985](https://github.com/vm0-ai/vm0/issues/28985)) ([f6d0ec2](https://github.com/vm0-ai/vm0/commit/f6d0ec2054fa004fffef60619afd1466eac61876))
* **python:** reject oversized firewall auth expiries ([#28390](https://github.com/vm0-ai/vm0/issues/28390)) ([424cefa](https://github.com/vm0-ai/vm0/commit/424cefa243b6045847ac53cfc6bc831ae4187311))
* **python:** retain multiple prewarm response ids ([#28401](https://github.com/vm0-ai/vm0/issues/28401)) ([dbc7222](https://github.com/vm0-ai/vm0/commit/dbc722260de69a3124d8981e6cb3bb1b56c1ef25))
* **python:** share model response classification ([#28633](https://github.com/vm0-ai/vm0/issues/28633)) ([e129ab0](https://github.com/vm0-ai/vm0/commit/e129ab06050e0c71da083fe3afdeb0c294a75c81))
* **python:** track nested break exits in metadata linter ([#28907](https://github.com/vm0-ai/vm0/issues/28907)) ([93164bb](https://github.com/vm0-ai/vm0/commit/93164bb7165f8ce5978c8b2be5de832cee61b87c))
* **runner:** bound firewall catalog response bodies ([#28399](https://github.com/vm0-ai/vm0/issues/28399)) ([1732568](https://github.com/vm0-ai/vm0/commit/17325687f4950e089ce565d1e33737b5822b19be))
* **runner:** continue cleanup after bounded stop errors ([#28947](https://github.com/vm0-ai/vm0/issues/28947)) ([4b0161f](https://github.com/vm0-ai/vm0/commit/4b0161f361f512444e8a532cf9bdac8d1f13e8da))
* **runner:** defer connector diagnostics until upstream auth errors ([#28445](https://github.com/vm0-ai/vm0/issues/28445)) ([ff31fcd](https://github.com/vm0-ai/vm0/commit/ff31fcdb6195ce9ab0c5f8977156c446e6ad2117))
* **runner:** guard connector runtime publications ([#28495](https://github.com/vm0-ai/vm0/issues/28495)) ([641136f](https://github.com/vm0-ai/vm0/commit/641136ff637c4436f6f55871faee2647c675edf2))
* **runner:** isolate shell tool oom cleanup ([#28391](https://github.com/vm0-ai/vm0/issues/28391)) ([ffb0332](https://github.com/vm0-ai/vm0/commit/ffb03327e60854d4e5e541b34a2f3423cfcee6f2))
* **runner:** keep cancellation waits off ably supervisor loop ([#29184](https://github.com/vm0-ai/vm0/issues/29184)) ([4639a0d](https://github.com/vm0-ai/vm0/commit/4639a0d109bf50975c9e74db3c1ea5d547bf4c09))
* **runner:** log execution time limit at info ([#28750](https://github.com/vm0-ai/vm0/issues/28750)) ([9823447](https://github.com/vm0-ai/vm0/commit/9823447ca397e8ea7d15de12d6de725091987a6c))
* **runner:** prevent pid reuse during mitmdump cleanup ([#28834](https://github.com/vm0-ai/vm0/issues/28834)) ([504690c](https://github.com/vm0-ai/vm0/commit/504690c1a68d03e074fabb20eb02db2bcdacbbc9))
* **runner:** reconcile stale drain override cleanup ([#28363](https://github.com/vm0-ai/vm0/issues/28363)) ([6e631e3](https://github.com/vm0-ai/vm0/commit/6e631e340efd2084a5a174487e901d0982ddd4fb))
* **runner:** recover evicted websocket usage pricing ([#28584](https://github.com/vm0-ai/vm0/issues/28584)) ([6d677e5](https://github.com/vm0-ai/vm0/commit/6d677e500ee8f952a1350db74336ae0e8de5581b))
* **runner:** recover mitmdump startup port collisions ([#28846](https://github.com/vm0-ai/vm0/issues/28846)) ([9aa1984](https://github.com/vm0-ai/vm0/commit/9aa198463d2b731ce69f12b75487b9ca7a82db31))
* **runner:** treat reuse capacity rejection as informational ([#28789](https://github.com/vm0-ai/vm0/issues/28789)) ([13456e3](https://github.com/vm0-ai/vm0/commit/13456e3bb2cc1bdd3cbb10df49bb7dc4ccbcd087))
* **rust:** align mock codex rollout paths ([#28692](https://github.com/vm0-ai/vm0/issues/28692)) ([59ecfdb](https://github.com/vm0-ai/vm0/commit/59ecfdbbf4a1402dc5fc85ee460ef88cb0a26e55))
* **usage:** bound model usage quantities ([#28351](https://github.com/vm0-ai/vm0/issues/28351)) ([d91265c](https://github.com/vm0-ai/vm0/commit/d91265c8761b3c40eb7e91a8ac6bcfaa0bdad4f8))


### Documentation

* **python:** clarify model-provider failure shutdown delivery semantics ([#28843](https://github.com/vm0-ai/vm0/issues/28843)) ([8924f63](https://github.com/vm0-ai/vm0/commit/8924f63dade934b3caa6d5629013447a6c70fc3c))
* **python:** define invalid registry sandbox diagnostic contract ([#29219](https://github.com/vm0-ai/vm0/issues/29219)) ([1722111](https://github.com/vm0-ai/vm0/commit/1722111341447bb9d708a86d2ded7f28ff1be2fe))
* **python:** define proxy registry unavailability reason contract ([#29156](https://github.com/vm0-ai/vm0/issues/29156)) ([c31a72a](https://github.com/vm0-ai/vm0/commit/c31a72a0c68e5435179097d73e498b60b6de0bd4))
* **python:** define the shared model http failure evidence contract ([#29123](https://github.com/vm0-ai/vm0/issues/29123)) ([2adbb0f](https://github.com/vm0-ai/vm0/commit/2adbb0f7abcc40a9ef6a5e6f35b583dc519b3728))
* **python:** distinguish expired firewall auth entries from eviction ([#28867](https://github.com/vm0-ai/vm0/issues/28867)) ([5d67c3c](https://github.com/vm0-ai/vm0/commit/5d67c3ce28a43d15f13b20c37ba0c27238a1a93b))
* **python:** document percent-decoded host contract ([#28901](https://github.com/vm0-ai/vm0/issues/28901)) ([be56585](https://github.com/vm0-ai/vm0/commit/be565851b852545c7cf90ac30707dc9ff8bb1ef8))
* **python:** document provider timing store locking and retention contract ([#28394](https://github.com/vm0-ai/vm0/issues/28394)) ([7bbaf7d](https://github.com/vm0-ai/vm0/commit/7bbaf7d410c1b7ac0b7d21ede9a08973c367861b))
* **python:** document selective JSON duplicate-key semantics ([#29007](https://github.com/vm0-ai/vm0/issues/29007)) ([0a05d54](https://github.com/vm0-ai/vm0/commit/0a05d54320d3ffc8494fc28bcbdddb4e9651cd2d))
* **runner:** document host directory trust modes ([#28403](https://github.com/vm0-ai/vm0/issues/28403)) ([7ab2b8c](https://github.com/vm0-ai/vm0/commit/7ab2b8c355988177272860bb04d9a6b86f21d8cb))
* **runner:** document wait-running stdout contract ([#29003](https://github.com/vm0-ai/vm0/issues/29003)) ([1c98e0a](https://github.com/vm0-ai/vm0/commit/1c98e0a5dfe057e981593970cb04716f38cb7401))
* **runner:** remove retired compose contract reference ([#29013](https://github.com/vm0-ai/vm0/issues/29013)) ([8e85227](https://github.com/vm0-ai/vm0/commit/8e852273c1d008c8a8a4d7fe08b92c2cc73ee200))
* **rust:** document drain override cleanup invariants ([#29227](https://github.com/vm0-ai/vm0/issues/29227)) ([37e2220](https://github.com/vm0-ai/vm0/commit/37e222072b498e3c097652c86fb1b2e4905046a5))
* **rust:** document session history probe telemetry semantics ([#28581](https://github.com/vm0-ai/vm0/issues/28581)) ([79f3c94](https://github.com/vm0-ai/vm0/commit/79f3c94be735383764b6ce464326865cbb6d7e73))
* **rust:** document session-history CPU pool invariants ([#29025](https://github.com/vm0-ai/vm0/issues/29025)) ([21a07e5](https://github.com/vm0-ai/vm0/commit/21a07e53497f3b1d89ffd0fdbb330f8c8652529a))


### Refactoring

* **python:** centralize buffered auth body framing ([#28752](https://github.com/vm0-ai/vm0/issues/28752)) ([91c4e5d](https://github.com/vm0-ai/vm0/commit/91c4e5d91fb3ae3cd6caf6853df81f22ec68328e))
* **python:** centralize client peer validation ([#28868](https://github.com/vm0-ai/vm0/issues/28868)) ([038fa22](https://github.com/vm0-ai/vm0/commit/038fa226f3e035d75dec571e98656e37ad7754ec))
* **python:** centralize openai responses event taxonomy ([#28530](https://github.com/vm0-ai/vm0/issues/28530)) ([1a9c18b](https://github.com/vm0-ai/vm0/commit/1a9c18b0756c1439d83640dc1177f4e585e4544c))
* **python:** centralize streaming encoding capabilities ([#28526](https://github.com/vm0-ai/vm0/issues/28526)) ([4928434](https://github.com/vm0-ai/vm0/commit/4928434db79ca61bc8db5c058d67c26071c7993f))
* **python:** centralize websocket handshake header parsing ([#28405](https://github.com/vm0-ai/vm0/issues/28405)) ([d4ea49c](https://github.com/vm0-ai/vm0/commit/d4ea49c389eb40a43521cfea74a9118072d8d1c7))
* **python:** consolidate model-provider flow metadata setup ([#29126](https://github.com/vm0-ai/vm0/issues/29126)) ([82bb2ab](https://github.com/vm0-ai/vm0/commit/82bb2abf5bb68c9962f40352ad39bb68c670d27c))
* **python:** reuse shared usage-event assertions ([#29170](https://github.com/vm0-ai/vm0/issues/29170)) ([eb0b817](https://github.com/vm0-ai/vm0/commit/eb0b817c4a6ddbf23025d46a4e9e5f28a084029c))
* **runner:** centralize gc lock probes ([#28493](https://github.com/vm0-ai/vm0/issues/28493)) ([14a8359](https://github.com/vm0-ai/vm0/commit/14a83594b6f01730b6a53561cac801f686d1fcbd))
* **runner:** centralize idle sandbox activation ([#28630](https://github.com/vm0-ai/vm0/issues/28630)) ([f1ac1d9](https://github.com/vm0-ai/vm0/commit/f1ac1d991d29248de4f55cdfad38962d0e711a78))
* **runner:** centralize procfs process generation ([#28576](https://github.com/vm0-ai/vm0/issues/28576)) ([e35d103](https://github.com/vm0-ai/vm0/commit/e35d1031e8ffcb860e317a4b101831a4d72cdade))
* **runner:** consolidate mock provider operation gates ([#29203](https://github.com/vm0-ai/vm0/issues/29203)) ([e76130d](https://github.com/vm0-ai/vm0/commit/e76130d84211d65eb2ed29cae1d1b33ea1ae016a))
* **runner:** dual-read and dual-write mitmdump runtime markers ([#29030](https://github.com/vm0-ai/vm0/issues/29030)) ([29b82dd](https://github.com/vm0-ai/vm0/commit/29b82dd28d8693471db0a7a00800be0830650ae3))
* **runner:** dual-read canonical host tuning environment aliases ([#28964](https://github.com/vm0-ai/vm0/issues/28964)) ([88cf421](https://github.com/vm0-ai/vm0/commit/88cf42132c3150a1f116d888049f083010fd598f))
* **runner:** dual-read runner token environment aliases ([#28977](https://github.com/vm0-ai/vm0/issues/28977)) ([a9164f6](https://github.com/vm0-ai/vm0/commit/a9164f6aa4129610eb268c90773879b4d4af4b17))
* **runner:** generate firewall cache contract constants ([#28842](https://github.com/vm0-ai/vm0/issues/28842)) ([04a15da](https://github.com/vm0-ai/vm0/commit/04a15daa1c14a7196038fa573ebf2be2ec49791f))
* **runner:** migrate status to sandbox terminology ([#29010](https://github.com/vm0-ai/vm0/issues/29010)) ([6bead98](https://github.com/vm0-ai/vm0/commit/6bead98eb35336befe162e76e862da608d1fb1b6))
* **runner:** reject reserved OKOU keys in local user environment ([#28971](https://github.com/vm0-ai/vm0/issues/28971)) ([3bff5c4](https://github.com/vm0-ai/vm0/commit/3bff5c4998d0a692212ef2abc44513e09c0ba3f1))
* **runner:** remove legacy idle status mirror ([#29072](https://github.com/vm0-ai/vm0/issues/29072)) ([3677fcf](https://github.com/vm0-ai/vm0/commit/3677fcf6f9a4fb92105e5c97d15b92775e6236e0))
* **runner:** rename embedded mitm credential key ([#28952](https://github.com/vm0-ai/vm0/issues/28952)) ([fecae1b](https://github.com/vm0-ai/vm0/commit/fecae1b8917fc01eec9afe9b4395b002ea016c5c))
* **runner:** rename private codex cleanup environment keys ([#28959](https://github.com/vm0-ai/vm0/issues/28959)) ([4e8fec7](https://github.com/vm0-ai/vm0/commit/4e8fec7512e82f44ddc683d30f7014a600fea002)), closes [#28922](https://github.com/vm0-ai/vm0/issues/28922)
* **runner:** rename proxy registry and mitm-addon sandbox contract ([#28967](https://github.com/vm0-ai/vm0/issues/28967)) ([cdc2220](https://github.com/vm0-ai/vm0/commit/cdc2220859e38b82058424e3b7cd05d846cfb2ca))
* **runtime:** add a trusted platform environment channel ([#28970](https://github.com/vm0-ai/vm0/issues/28970)) ([7d6e40b](https://github.com/vm0-ai/vm0/commit/7d6e40b7a8da820582587d96479f4da9f02932b6))
* **runtime:** dual-read guest runtime directory aliases ([#29101](https://github.com/vm0-ai/vm0/issues/29101)) ([3bb5b28](https://github.com/vm0-ai/vm0/commit/3bb5b2807090c3cf48650b917ccca00bdb44f370))
* **runtime:** dual-read private payload file env aliases ([#29082](https://github.com/vm0-ai/vm0/issues/29082)) ([e400e00](https://github.com/vm0-ai/vm0/commit/e400e0058cd63cc18b478ad807da42f9b5bb5e74))
* **runtime:** dual-read resume session environment aliases ([#29069](https://github.com/vm0-ai/vm0/issues/29069)) ([6dd54e9](https://github.com/vm0-ai/vm0/commit/6dd54e909a8607421344e758adcb887f72f8f0de))
* **runtime:** dual-read run metadata env aliases ([#29022](https://github.com/vm0-ai/vm0/issues/29022)) ([928d53b](https://github.com/vm0-ai/vm0/commit/928d53b17819c1c82f76da3aa8e4e672c69431d1))
* **runtime:** reserve okou namespace in cloud execution ([#29040](https://github.com/vm0-ai/vm0/issues/29040)) ([233bc7e](https://github.com/vm0-ai/vm0/commit/233bc7eb29e9c03b4391e91f1fe15ce48d576de6))
* **rust:** enforce exec-control payload limit parity ([#28825](https://github.com/vm0-ai/vm0/issues/28825)) ([6202aee](https://github.com/vm0-ai/vm0/commit/6202aeed5db6e25b6fb845267a20dc4503dfbb79))
* **rust:** generate pi runtime config dtos ([#28928](https://github.com/vm0-ai/vm0/issues/28928)) ([1ae995e](https://github.com/vm0-ai/vm0/commit/1ae995e88763e37f6659581dea03f8aa97c840ad))


### Performance Improvements

* **mitm-addon:** reuse chat completions extractor across sse events ([#28629](https://github.com/vm0-ai/vm0/issues/28629)) ([3ca0aea](https://github.com/vm0-ai/vm0/commit/3ca0aea8b5ff3ed249064c7422f18bd16e5fa290))
* **mitm-addon:** reuse x unicode label classification ([#28983](https://github.com/vm0-ai/vm0/issues/28983)) ([49fd493](https://github.com/vm0-ai/vm0/commit/49fd493137938781ddadd667ad2707a426d7b8cc))
* **python:** avoid duplicate responses sse probes ([#28851](https://github.com/vm0-ai/vm0/issues/28851)) ([85adf1e](https://github.com/vm0-ai/vm0/commit/85adf1eab49d6af3342cdc897c48f675d5fc32c3))
* **python:** reduce x tld redirect test shutdown latency ([#28865](https://github.com/vm0-ai/vm0/issues/28865)) ([b18d95a](https://github.com/vm0-ai/vm0/commit/b18d95ac8f2a043d9cc8a38ea419824ba93876b5))
* **python:** resolve jsonl flush paths once per watcher ([#28349](https://github.com/vm0-ai/vm0/issues/28349)) ([7e730de](https://github.com/vm0-ai/vm0/commit/7e730dec29d40eaf539ad17362bfdaf1f4540e25))
* **python:** share model http response parsing ([#28822](https://github.com/vm0-ai/vm0/issues/28822)) ([242af40](https://github.com/vm0-ai/vm0/commit/242af400b657a717258692557e93d1d19aec280e))
* **python:** share responses websocket parsing ([#28757](https://github.com/vm0-ai/vm0/issues/28757)) ([8671c2b](https://github.com/vm0-ai/vm0/commit/8671c2bc617aeb0e4aab3318b992524d437e1929))
* **python:** skip irrelevant websocket client parsing ([#29127](https://github.com/vm0-ai/vm0/issues/29127)) ([2131e63](https://github.com/vm0-ai/vm0/commit/2131e63052fd57131942d4f76522ff3d09da3f7e))
* **runner:** attribute pre-spawn concurrency ([#28839](https://github.com/vm0-ai/vm0/issues/28839)) ([5e11ce3](https://github.com/vm0-ai/vm0/commit/5e11ce3b6aedbd502c94dd07ff68a5209cb4e101))
* **runner:** bound burst pre-spawn concurrency ([#28882](https://github.com/vm0-ai/vm0/issues/28882)) ([97bcd42](https://github.com/vm0-ai/vm0/commit/97bcd42706fb53c60d6dd101fb69a96362bc6b14))
* **runner:** bound command output capture ([#28909](https://github.com/vm0-ai/vm0/issues/28909)) ([5279ac7](https://github.com/vm0-ai/vm0/commit/5279ac7a4707242d4566127133fc72dde43179d6))
* **runner:** bound local queue job reads ([#28395](https://github.com/vm0-ai/vm0/issues/28395)) ([bf6499b](https://github.com/vm0-ai/vm0/commit/bf6499bebd8d138a75f1bae1547e96178b50c750))
* **runner:** coordinate routine cache gc per host ([#28373](https://github.com/vm0-ai/vm0/issues/28373)) ([ab154d5](https://github.com/vm0-ai/vm0/commit/ab154d56a6545cbd716661d9c57e407d6838bfb5))
* **runner:** reduce workspace cache path allocations ([#28498](https://github.com/vm0-ai/vm0/issues/28498)) ([d08a325](https://github.com/vm0-ai/vm0/commit/d08a3255808888a2962d1ba9737f5f2a1ddff43f))
* **runner:** skip codex cleanup in fresh sandboxes ([#29183](https://github.com/vm0-ai/vm0/issues/29183)) ([126fc49](https://github.com/vm0-ai/vm0/commit/126fc499fb949f47f8b3be823f2e120ab0b4f46f))
* **runner:** specialize guest storage manifest invocation ([#28734](https://github.com/vm0-ai/vm0/issues/28734)) ([0255e57](https://github.com/vm0-ai/vm0/commit/0255e57603d27fe97ac342c97af98921dabf2ae9))
</details>

<details><summary>vsock-guest: 0.19.105</summary>

## [0.19.105](https://github.com/vm0-ai/vm0/compare/vsock-guest-v0.19.104...vsock-guest-v0.19.105) (2026-08-25)


### Bug Fixes

* **runner:** isolate shell tool oom cleanup ([#28391](https://github.com/vm0-ai/vm0/issues/28391)) ([ffb0332](https://github.com/vm0-ai/vm0/commit/ffb03327e60854d4e5e541b34a2f3423cfcee6f2))
* **runner:** wake placement workers during shutdown ([#29132](https://github.com/vm0-ai/vm0/issues/29132)) ([385c1aa](https://github.com/vm0-ai/vm0/commit/385c1aa78a479fd2938596cee1b9e769bb5e017a))


### Refactoring

* **runtime:** dual-read cgroup placement environment aliases ([#29081](https://github.com/vm0-ai/vm0/issues/29081)) ([7beb4d5](https://github.com/vm0-ai/vm0/commit/7beb4d545bef801b7dd0bd2c107829869cd022ed))
* **runtime:** dual-read guest runtime directory aliases ([#29101](https://github.com/vm0-ai/vm0/issues/29101)) ([3bb5b28](https://github.com/vm0-ai/vm0/commit/3bb5b2807090c3cf48650b917ccca00bdb44f370))
* **runtime:** dual-read process-control environment aliases ([#29071](https://github.com/vm0-ai/vm0/issues/29071)) ([c9cde49](https://github.com/vm0-ai/vm0/commit/c9cde495a4ba6f43c409476a68733bdade8cb99c))
* **rust:** enforce exec-control payload limit parity ([#28825](https://github.com/vm0-ai/vm0/issues/28825)) ([6202aee](https://github.com/vm0-ai/vm0/commit/6202aeed5db6e25b6fb845267a20dc4503dfbb79))


### Performance Improvements

* **runner:** specialize guest storage manifest invocation ([#28734](https://github.com/vm0-ai/vm0/issues/28734)) ([0255e57](https://github.com/vm0-ai/vm0/commit/0255e57603d27fe97ac342c97af98921dabf2ae9))
</details>

<details><summary>vsock-test: 0.9.236</summary>

## [0.9.236](https://github.com/vm0-ai/vm0/compare/vsock-test-v0.9.235...vsock-test-v0.9.236) (2026-08-25)
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).