# Changelog

## [9.27.2](https://github.com/vm0-ai/vm0/compare/cli-v9.27.1...cli-v9.27.2) (2026-02-09)


### Bug Fixes

* **cli:** add homebrew arm64 path detection for auto-upgrade ([#2648](https://github.com/vm0-ai/vm0/issues/2648)) ([870c74a](https://github.com/vm0-ai/vm0/commit/870c74ac3f8aae4cab08adbcea4dcc0c26ae0393)), closes [#2637](https://github.com/vm0-ai/vm0/issues/2637)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.5.1

## [9.27.1](https://github.com/vm0-ai/vm0/compare/cli-v9.27.0...cli-v9.27.1) (2026-02-09)


### Bug Fixes

* **cli:** remove client-side env validation from cook command ([#2626](https://github.com/vm0-ai/vm0/issues/2626)) ([7d8c4c8](https://github.com/vm0-ai/vm0/commit/7d8c4c890fe96e1ca38f08a7a4dbfa5687997224))

## [9.27.0](https://github.com/vm0-ai/vm0/compare/cli-v9.26.0...cli-v9.27.0) (2026-02-09)


### Features

* **cli:** add dashboard command with guided help ([#2574](https://github.com/vm0-ai/vm0/issues/2574)) ([4e1d37a](https://github.com/vm0-ai/vm0/commit/4e1d37ad35046bb8d4cfbcec3e7028415e2339e5))

## [9.26.0](https://github.com/vm0-ai/vm0/compare/cli-v9.25.0...cli-v9.26.0) (2026-02-09)


### Features

* **cli:** add --json flag and deprecate --porcelain ([#2613](https://github.com/vm0-ai/vm0/issues/2613)) ([f4fcdb1](https://github.com/vm0-ai/vm0/commit/f4fcdb19b1766386fc89fc69d0f82901fb06db26))
* **cli:** show connector-derived secret names in secret list ([#2602](https://github.com/vm0-ai/vm0/issues/2602)) ([877a318](https://github.com/vm0-ai/vm0/commit/877a31858cf10b7d3d6060d6e10e606c22cd2a83)), closes [#2601](https://github.com/vm0-ai/vm0/issues/2601)


### Bug Fixes

* **cli:** align error symbols, color semantics, and message formatting with design guideline ([#2615](https://github.com/vm0-ai/vm0/issues/2615)) ([1e70bc2](https://github.com/vm0-ai/vm0/commit/1e70bc23b917c9b8f5132b11029941030e17d4c1))
* **cli:** route error messages and hints to stderr across all commands ([#2614](https://github.com/vm0-ai/vm0/issues/2614)) ([4d7d406](https://github.com/vm0-ai/vm0/commit/4d7d406481f86ab39d17333b9ac550b943b6ea8f))
* **cli:** route error messages to stderr in init command ([#2612](https://github.com/vm0-ai/vm0/issues/2612)) ([93af64e](https://github.com/vm0-ai/vm0/commit/93af64efbe0c8b891e8387ec21089508c02adcf4))
* **cli:** route error messages to stderr per CLI design guideline ([#2609](https://github.com/vm0-ai/vm0/issues/2609)) ([a993299](https://github.com/vm0-ai/vm0/commit/a993299c2705bf945d7309cf5c42148c38cd1a29))
* **cli:** route run-failed output to stderr ([#2610](https://github.com/vm0-ai/vm0/issues/2610)) ([97e1081](https://github.com/vm0-ai/vm0/commit/97e1081e72c1b44501450c106e3bb6a94a6abd39))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.5.0

## [9.25.0](https://github.com/vm0-ai/vm0/compare/cli-v9.24.1...cli-v9.25.0) (2026-02-07)


### Features

* **cli:** add connector list and disconnect commands ([#2570](https://github.com/vm0-ai/vm0/issues/2570)) ([aec1120](https://github.com/vm0-ai/vm0/commit/aec1120600d0ab0709803f643038493ecc6f8bb9))
* **cli:** add connector status command for detailed connector view ([#2582](https://github.com/vm0-ai/vm0/issues/2582)) ([c342888](https://github.com/vm0-ai/vm0/commit/c342888a913edb0d7e382bc4b76b91e136decf6b)), closes [#2571](https://github.com/vm0-ai/vm0/issues/2571)


### Bug Fixes

* **cli:** remove session code display from connector connect ([#2569](https://github.com/vm0-ai/vm0/issues/2569)) ([2a8fae3](https://github.com/vm0-ai/vm0/commit/2a8fae30b90764d089140fde15cbf3df021c7563))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.4.2

## [9.24.1](https://github.com/vm0-ai/vm0/compare/cli-v9.24.0...cli-v9.24.1) (2026-02-07)


### Bug Fixes

* **schedule:** validate secrets/vars against platform tables ([#2558](https://github.com/vm0-ai/vm0/issues/2558)) ([f19d550](https://github.com/vm0-ai/vm0/commit/f19d5506e61f16536bf163e5884266d31326fe40))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.4.1

## [9.24.0](https://github.com/vm0-ai/vm0/compare/cli-v9.23.0...cli-v9.24.0) (2026-02-07)


### Features

* **connector:** implement github oauth connector with cli support ([#2446](https://github.com/vm0-ai/vm0/issues/2446)) ([c12c97a](https://github.com/vm0-ai/vm0/commit/c12c97a2af0b74d8bdfd452e2cbe7000f9e24f34))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.4.0

## [9.23.0](https://github.com/vm0-ai/vm0/compare/cli-v9.22.0...cli-v9.23.0) (2026-02-07)


### Features

* **web:** add server-side github compose api ([#2473](https://github.com/vm0-ai/vm0/issues/2473)) ([9ab1f23](https://github.com/vm0-ai/vm0/commit/9ab1f2344f11086fd0f4c30036d04c72fab61b68))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.3.0

## [9.22.0](https://github.com/vm0-ai/vm0/compare/cli-v9.21.0...cli-v9.22.0) (2026-02-06)


### Features

* **cli:** add --porcelain option to compose command ([#2494](https://github.com/vm0-ai/vm0/issues/2494)) ([f5f5a3f](https://github.com/vm0-ai/vm0/commit/f5f5a3fad10cff2a2cc7e962d40062f9c004fd88))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.2.2

## [9.21.0](https://github.com/vm0-ai/vm0/compare/cli-v9.20.2...cli-v9.21.0) (2026-02-06)


### Features

* **cli:** add interactive mode and --body flag for secret set command ([#2441](https://github.com/vm0-ai/vm0/issues/2441)) ([8d75b85](https://github.com/vm0-ai/vm0/commit/8d75b85bbe7a2c29b586ac832f040d4c073ee2ce))
* **cli:** integrate sentry for error monitoring ([#2416](https://github.com/vm0-ai/vm0/issues/2416)) ([d6b2937](https://github.com/vm0-ai/vm0/commit/d6b29374bd6842e6e531b11c207a231cb1bce539))


### Bug Fixes

* **cli:** map 401/403 responses to user-friendly error messages ([#2475](https://github.com/vm0-ai/vm0/issues/2475)) ([ed384fb](https://github.com/vm0-ai/vm0/commit/ed384fb109c32046335f789f42974261d8c05fec))
* **cli:** support repository root GitHub URLs in vm0 compose ([#2427](https://github.com/vm0-ai/vm0/issues/2427)) ([6c0ba38](https://github.com/vm0-ai/vm0/commit/6c0ba385bdca8a63d1bff03840d0595150d78cd4)), closes [#2423](https://github.com/vm0-ai/vm0/issues/2423)
* **core:** handle trailing slashes in GitHub URL parsing ([#2459](https://github.com/vm0-ai/vm0/issues/2459)) ([10226c7](https://github.com/vm0-ai/vm0/commit/10226c74372cfd3a9e9f08295ad086c41e80acc7)), closes [#2455](https://github.com/vm0-ai/vm0/issues/2455)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.2.1

## [9.20.2](https://github.com/vm0-ai/vm0/compare/cli-v9.20.1...cli-v9.20.2) (2026-02-05)


### Bug Fixes

* **dev:** change pre-commit hooks to serial execution ([#2422](https://github.com/vm0-ai/vm0/issues/2422)) ([2505c13](https://github.com/vm0-ai/vm0/commit/2505c13d11bb38376b3e6343a051a7814b011a61))

## [9.20.1](https://github.com/vm0-ai/vm0/compare/cli-v9.20.0...cli-v9.20.1) (2026-02-05)


### Bug Fixes

* **cli:** normalize agent name to lowercase before uploading instructions ([#2417](https://github.com/vm0-ai/vm0/issues/2417)) ([afb1a9c](https://github.com/vm0-ai/vm0/commit/afb1a9cb07fe2aeef4b139ff79a1179351ff35c8)), closes [#2414](https://github.com/vm0-ai/vm0/issues/2414)

## [9.20.0](https://github.com/vm0-ai/vm0/compare/cli-v9.19.0...cli-v9.20.0) (2026-02-05)


### Features

* **cli:** mark agent sharing as experimental with safety flag ([#2393](https://github.com/vm0-ai/vm0/issues/2393)) ([0fe6188](https://github.com/vm0-ai/vm0/commit/0fe6188e8420a504a5afa4ce6794e3e769e9f63a))
* **cli:** support github url for vm0 compose command ([#2402](https://github.com/vm0-ai/vm0/issues/2402)) ([4df7b65](https://github.com/vm0-ai/vm0/commit/4df7b65f5cef16be99693213ad59c3bc91252f27))

## [9.19.0](https://github.com/vm0-ai/vm0/compare/cli-v9.18.0...cli-v9.19.0) (2026-02-05)


### Features

* **agent:** add agent sharing with acl-based access control ([#2377](https://github.com/vm0-ai/vm0/issues/2377)) ([d3f63c6](https://github.com/vm0-ai/vm0/commit/d3f63c61b08a93bf9cbffda51ff77f389e18316b))

## [9.18.0](https://github.com/vm0-ai/vm0/compare/cli-v9.17.2...cli-v9.18.0) (2026-02-04)


### Features

* **cli:** add vm0 variable command for server-side variable storage ([#2344](https://github.com/vm0-ai/vm0/issues/2344)) ([6831866](https://github.com/vm0-ai/vm0/commit/6831866c271e5b711fa979c1deef56c1ab9bd2a4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.2.0

## [9.17.2](https://github.com/vm0-ai/vm0/compare/cli-v9.17.1...cli-v9.17.2) (2026-02-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.1.0

## [9.17.1](https://github.com/vm0-ai/vm0/compare/cli-v9.17.0...cli-v9.17.1) (2026-02-04)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 8.0.0

## [9.17.0](https://github.com/vm0-ai/vm0/compare/cli-v9.16.0...cli-v9.17.0) (2026-02-04)


### Features

* **cli:** default to vm0.yaml when compose is called without arguments ([#2292](https://github.com/vm0-ai/vm0/issues/2292)) ([f928631](https://github.com/vm0-ai/vm0/commit/f9286315b25fc7265564b9b6a8819666e8c9790c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.15.0

## [9.16.0](https://github.com/vm0-ai/vm0/compare/cli-v9.15.2...cli-v9.16.0) (2026-02-04)


### Features

* **model-provider:** add deepseek api key support and simplify provider labels ([#2276](https://github.com/vm0-ai/vm0/issues/2276)) ([1fcd190](https://github.com/vm0-ai/vm0/commit/1fcd190fe8d95dc141001f911442b8f2b592c7d0)), closes [#2262](https://github.com/vm0-ai/vm0/issues/2262)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.14.0

## [9.15.2](https://github.com/vm0-ai/vm0/compare/cli-v9.15.1...cli-v9.15.2) (2026-02-04)


### Bug Fixes

* **cli:** remove shell option from claude command spawn ([#2273](https://github.com/vm0-ai/vm0/issues/2273)) ([b462f41](https://github.com/vm0-ai/vm0/commit/b462f418b97d6caf9ee63914d568975632eda134))

## [9.15.1](https://github.com/vm0-ai/vm0/compare/cli-v9.15.0...cli-v9.15.1) (2026-02-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.13.0

## [9.15.0](https://github.com/vm0-ai/vm0/compare/cli-v9.14.1...cli-v9.15.0) (2026-02-03)


### Features

* **model-provider:** add aws bedrock support with multi-auth provider architecture ([#2214](https://github.com/vm0-ai/vm0/issues/2214)) ([8009acf](https://github.com/vm0-ai/vm0/commit/8009acf84785e70aaf63f47e23358184d6058c22))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.12.0

## [9.14.1](https://github.com/vm0-ai/vm0/compare/cli-v9.14.0...cli-v9.14.1) (2026-02-03)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.11.0

## [9.14.0](https://github.com/vm0-ai/vm0/compare/cli-v9.13.1...cli-v9.14.0) (2026-02-03)


### Features

* **cli:** add agent clone command to download compose configuration ([#2209](https://github.com/vm0-ai/vm0/issues/2209)) ([14da2a5](https://github.com/vm0-ai/vm0/commit/14da2a57097a41ceb87724625033f4f18289fc8f))
* **cli:** add prompt to set model provider as default after setup ([#2203](https://github.com/vm0-ai/vm0/issues/2203)) ([87d260f](https://github.com/vm0-ai/vm0/commit/87d260fcae6389a4ddfffb3c391eeb5bce52990b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.10.0

## [9.13.1](https://github.com/vm0-ai/vm0/compare/cli-v9.13.0...cli-v9.13.1) (2026-02-03)


### Bug Fixes

* **cli:** add auto option in onboard model selection for openrouter ([#2189](https://github.com/vm0-ai/vm0/issues/2189)) ([c783333](https://github.com/vm0-ai/vm0/commit/c783333ff063b79aa3b62a577b46daf7326f5068))

## [9.13.0](https://github.com/vm0-ai/vm0/compare/cli-v9.12.0...cli-v9.13.0) (2026-02-03)


### Features

* **cli:** improve model-provider setup ux with configuration status ([#2182](https://github.com/vm0-ai/vm0/issues/2182)) ([6c6617d](https://github.com/vm0-ai/vm0/commit/6c6617d5014ae86861df99488e64b577ee94ef26))
* **core:** add openrouter-api-key model provider with auto routing ([#2151](https://github.com/vm0-ai/vm0/issues/2151)) ([861d7dc](https://github.com/vm0-ai/vm0/commit/861d7dcee779d4d0082e3b9f7deed67e1d429c02))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.9.0

## [9.12.0](https://github.com/vm0-ai/vm0/compare/cli-v9.11.0...cli-v9.12.0) (2026-02-02)


### Features

* **cli:** add silent auto-upgrade for compose and run commands ([#2120](https://github.com/vm0-ai/vm0/issues/2120)) ([891a7c4](https://github.com/vm0-ai/vm0/commit/891a7c4aa3f231af67ad5a6cbe8065ff481e6b87))

## [9.11.0](https://github.com/vm0-ai/vm0/compare/cli-v9.10.0...cli-v9.11.0) (2026-02-02)


### Features

* add moonshot-api-key provider with credential mapping and model selection ([#2110](https://github.com/vm0-ai/vm0/issues/2110)) ([88f8f9d](https://github.com/vm0-ai/vm0/commit/88f8f9d369529752eac68eec426153d8b82ab5fc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.8.0

## [9.10.0](https://github.com/vm0-ai/vm0/compare/cli-v9.9.2...cli-v9.10.0) (2026-02-02)


### Features

* **cli:** update marketplace when setup-claude runs on existing install ([#2117](https://github.com/vm0-ai/vm0/issues/2117)) ([a1c1810](https://github.com/vm0-ai/vm0/commit/a1c1810fc4edf214f00e1704d6aa969510bf4856)), closes [#2113](https://github.com/vm0-ai/vm0/issues/2113)


### Bug Fixes

* **cli:** show helpful hints when concurrent run limit is reached ([#2122](https://github.com/vm0-ai/vm0/issues/2122)) ([47c7dfa](https://github.com/vm0-ai/vm0/commit/47c7dfa4996ea615b0e14b0a22fd909774ccde87))

## [9.9.2](https://github.com/vm0-ai/vm0/compare/cli-v9.9.1...cli-v9.9.2) (2026-02-02)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.7.0

## [9.9.1](https://github.com/vm0-ai/vm0/compare/cli-v9.9.0...cli-v9.9.1) (2026-02-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.6.1

## [9.9.0](https://github.com/vm0-ai/vm0/compare/cli-v9.8.0...cli-v9.9.0) (2026-02-01)


### Features

* **cli:** release onboard banner update ([#2084](https://github.com/vm0-ai/vm0/issues/2084)) ([402820c](https://github.com/vm0-ai/vm0/commit/402820cbeabed134c3a757d4c8400037fce4c427))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.6.0

## [9.8.0](https://github.com/vm0-ai/vm0/compare/cli-v9.7.1...cli-v9.8.0) (2026-01-31)


### Features

* **cli:** add platform url output to logs command ([#2064](https://github.com/vm0-ai/vm0/issues/2064)) ([de6e1cb](https://github.com/vm0-ai/vm0/commit/de6e1cb4c24c7b3ea0788b4c41e0d0f20b8bbffd))

## [9.7.1](https://github.com/vm0-ai/vm0/compare/cli-v9.7.0...cli-v9.7.1) (2026-01-31)


### Bug Fixes

* **cli:** align todo list output with other tool formats ([#2050](https://github.com/vm0-ai/vm0/issues/2050)) ([b983655](https://github.com/vm0-ai/vm0/commit/b98365578c5516fbc2876591d60ad794d3b73b30))

## [9.7.0](https://github.com/vm0-ai/vm0/compare/cli-v9.6.2...cli-v9.7.0) (2026-01-31)


### Features

* **cli:** add grouped tool output and verbose mode for run commands ([#2007](https://github.com/vm0-ai/vm0/issues/2007)) ([4b29edc](https://github.com/vm0-ai/vm0/commit/4b29edc5b7b120ca8244c46439f4e9cf33c900c5))

## [9.6.2](https://github.com/vm0-ai/vm0/compare/cli-v9.6.1...cli-v9.6.2) (2026-01-31)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.5.0

## [9.6.1](https://github.com/vm0-ai/vm0/compare/cli-v9.6.0...cli-v9.6.1) (2026-01-31)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.4.2

## [9.6.0](https://github.com/vm0-ai/vm0/compare/cli-v9.5.1...cli-v9.6.0) (2026-01-31)


### Features

* **cli:** add claude plugin tip to init next steps ([#1963](https://github.com/vm0-ai/vm0/issues/1963)) ([850f590](https://github.com/vm0-ai/vm0/commit/850f590e103d2c112c3af20c55b18a2f97e12b1d))


### Bug Fixes

* **cli:** show correct next steps when skipping claude plugin in onboard ([#1965](https://github.com/vm0-ai/vm0/issues/1965)) ([519ff16](https://github.com/vm0-ai/vm0/commit/519ff16b8b0f76df0c0fef8f37743008f72a8358))

## [9.5.1](https://github.com/vm0-ai/vm0/compare/cli-v9.5.0...cli-v9.5.1) (2026-01-30)


### Bug Fixes

* **cli:** preserve color output in nested vm0 run from cook ([#1943](https://github.com/vm0-ai/vm0/issues/1943)) ([0ff302e](https://github.com/vm0-ai/vm0/commit/0ff302ef66ae9a310c4247b4cd0dd989a56727a9))
* **contracts:** use c.nobody() for 204 responses ([#1910](https://github.com/vm0-ai/vm0/issues/1910)) ([9ba5354](https://github.com/vm0-ai/vm0/commit/9ba5354aa76182540a398ced5e5e968d6c9878e2)), closes [#1902](https://github.com/vm0-ai/vm0/issues/1902)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.4.1

## [9.5.0](https://github.com/vm0-ai/vm0/compare/cli-v9.4.1...cli-v9.5.0) (2026-01-30)


### Features

* **cli:** add ascii art banner with orange gradient to onboard command ([#1880](https://github.com/vm0-ai/vm0/issues/1880)) ([749f057](https://github.com/vm0-ai/vm0/commit/749f0577801dd8022053a35c5e2cb91bdd36334d)), closes [#1878](https://github.com/vm0-ai/vm0/issues/1878)
* **cli:** implement progressive step reveal for onboard flow ([#1887](https://github.com/vm0-ai/vm0/issues/1887)) ([c153f41](https://github.com/vm0-ai/vm0/commit/c153f41fd2d9fb298554b29f92fa03428125bcef)), closes [#1886](https://github.com/vm0-ai/vm0/issues/1886)

## [9.4.1](https://github.com/vm0-ai/vm0/compare/cli-v9.4.0...cli-v9.4.1) (2026-01-29)


### Bug Fixes

* **web:** kill e2b sandbox when cancelling runs ([#1840](https://github.com/vm0-ai/vm0/issues/1840)) ([2af5ac7](https://github.com/vm0-ai/vm0/commit/2af5ac70ea95ec9b13364c922c14b717dedc9ae1))

## [9.4.0](https://github.com/vm0-ai/vm0/compare/cli-v9.3.1...cli-v9.4.0) (2026-01-29)


### Features

* **cli:** add `vm0 run list` and `vm0 run kill` commands ([#1826](https://github.com/vm0-ai/vm0/issues/1826)) ([7b42a47](https://github.com/vm0-ai/vm0/commit/7b42a47bba2da1bfe5ac59c9ce01b242e9c8524f))
* **cli:** replace embedded vm0-agent-builder with dynamic vm0-cli skill ([#1829](https://github.com/vm0-ai/vm0/issues/1829)) ([9fee458](https://github.com/vm0-ai/vm0/commit/9fee458e618964a31c9653d9fe18548a24a7b210))
* **cli:** show helpful hints when concurrent run limit exceeded ([#1839](https://github.com/vm0-ai/vm0/issues/1839)) ([99bce67](https://github.com/vm0-ai/vm0/commit/99bce67632334228ea51cabf3e857a8bbd2cc1b0))
* **cli:** use claude plugin marketplace for skill installation ([#1834](https://github.com/vm0-ai/vm0/issues/1834)) ([043a213](https://github.com/vm0-ai/vm0/commit/043a213d6f297b08f7c85a7f765b5e5dd5d6748f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.4.0

## [9.3.1](https://github.com/vm0-ai/vm0/compare/cli-v9.3.0...cli-v9.3.1) (2026-01-29)


### Bug Fixes

* **cli:** remove unnecessary confirmation prompt in onboard command ([#1820](https://github.com/vm0-ai/vm0/issues/1820)) ([71b8c7a](https://github.com/vm0-ai/vm0/commit/71b8c7afccb5e9a837d3c70d0f9719b1400f6967))

## [9.3.0](https://github.com/vm0-ai/vm0/compare/cli-v9.2.1...cli-v9.3.0) (2026-01-28)


### Features

* **cli:** redesign onboard command with interactive flow ([#1799](https://github.com/vm0-ai/vm0/issues/1799)) ([29ecbc0](https://github.com/vm0-ai/vm0/commit/29ecbc016e8de3cf0fa9e32ee9e36c3c71ba4b3a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.3.0

## [9.2.1](https://github.com/vm0-ai/vm0/compare/cli-v9.2.0...cli-v9.2.1) (2026-01-28)


### Bug Fixes

* **cli:** include cd instruction in onboard next step message ([#1791](https://github.com/vm0-ai/vm0/issues/1791)) ([126e8b7](https://github.com/vm0-ai/vm0/commit/126e8b7f2b2fce23427a6480ccd7d9255377fd95))

## [9.2.0](https://github.com/vm0-ai/vm0/compare/cli-v9.1.0...cli-v9.2.0) (2026-01-28)


### Features

* **cli:** auto-install cli globally in watch mode ([#1776](https://github.com/vm0-ai/vm0/issues/1776)) ([afc06fc](https://github.com/vm0-ai/vm0/commit/afc06fc21d616e2f924204076bb01bc294bf20ec))
* **cli:** improve onboard flow to call model-provider setup directly ([#1774](https://github.com/vm0-ai/vm0/issues/1774)) ([5097b45](https://github.com/vm0-ai/vm0/commit/5097b45b865a0b59c68b23a88f5a974b29693012))


### Bug Fixes

* **cli:** change npm link command from global to local installation ([#1779](https://github.com/vm0-ai/vm0/issues/1779)) ([83f0e38](https://github.com/vm0-ai/vm0/commit/83f0e38d40ca81ebc044b49b6876ef163ba41372))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.2.0

## [9.1.0](https://github.com/vm0-ai/vm0/compare/cli-v9.0.0...cli-v9.1.0) (2026-01-28)


### Features

* **cli:** add enable prompt and --enable flag to schedule setup ([#1736](https://github.com/vm0-ai/vm0/issues/1736)) ([43f35b8](https://github.com/vm0-ai/vm0/commit/43f35b8489b8e55b4198616923572c552e85a04a))
* **cli:** add vm0 onboard and setup-claude commands ([#1733](https://github.com/vm0-ai/vm0/issues/1733)) ([ee1c63f](https://github.com/vm0-ai/vm0/commit/ee1c63f2b238cc45835a19d2c9e982236187b1f1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.1.0

## [9.0.0](https://github.com/vm0-ai/vm0/compare/cli-v8.1.1...cli-v9.0.0) (2026-01-27)


### ⚠ BREAKING CHANGES

* **api:** All Public API v1 endpoints now use camelCase field names instead of snake_case. This affects request bodies, response bodies, and query parameters.

### Code Refactoring

* **api:** migrate public API v1 from snake_case to camelCase ([#1730](https://github.com/vm0-ai/vm0/issues/1730)) ([5dfcc28](https://github.com/vm0-ai/vm0/commit/5dfcc28597991f408a33bbd565b6619f47d6b92c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 7.0.0

## [8.1.1](https://github.com/vm0-ai/vm0/compare/cli-v8.1.0...cli-v8.1.1) (2026-01-27)


### Bug Fixes

* **cli:** add default msw handler for /api/scope endpoint ([#1709](https://github.com/vm0-ai/vm0/issues/1709)) ([c1ec2b3](https://github.com/vm0-ai/vm0/commit/c1ec2b3988977f63a9c067298b296dd9417eb184))
* **cli:** fix schedule setup secrets not sent for new schedules ([#1716](https://github.com/vm0-ai/vm0/issues/1716)) ([7d141b1](https://github.com/vm0-ai/vm0/commit/7d141b176edfc754930a46713f2dfbece210b0b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.3.0

## [8.1.0](https://github.com/vm0-ai/vm0/compare/cli-v8.0.2...cli-v8.1.0) (2026-01-27)


### Features

* **docs:** trigger release for documentation updates ([#1697](https://github.com/vm0-ai/vm0/issues/1697)) ([c078287](https://github.com/vm0-ai/vm0/commit/c078287de06336abd3157fcaa056bdedcb47838d))


### Bug Fixes

* **schedule:** reject enabling past one-time schedules and default to disabled ([#1690](https://github.com/vm0-ai/vm0/issues/1690)) ([601fb06](https://github.com/vm0-ai/vm0/commit/601fb0653f71e1a1aae105a627110dd7979baa19))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.2.0

## [8.0.2](https://github.com/vm0-ai/vm0/compare/cli-v8.0.1...cli-v8.0.2) (2026-01-27)


### Bug Fixes

* preserve existing secrets when updating schedule ([#1682](https://github.com/vm0-ai/vm0/issues/1682)) ([4a6150a](https://github.com/vm0-ai/vm0/commit/4a6150a6b0b126e0bb2a58899e4eab8c68fa7007)), closes [#1679](https://github.com/vm0-ai/vm0/issues/1679)

## [8.0.1](https://github.com/vm0-ai/vm0/compare/cli-v8.0.0...cli-v8.0.1) (2026-01-26)


### Bug Fixes

* **cli:** vm0 agent status now displays environment variables correctly ([#1661](https://github.com/vm0-ai/vm0/issues/1661)) ([e67bac6](https://github.com/vm0-ai/vm0/commit/e67bac6904d4ce97b6243222ab14ea7e5dc93e38))
* **schedule:** validate required secrets/vars before schedule creation ([#1659](https://github.com/vm0-ai/vm0/issues/1659)) ([0c7908e](https://github.com/vm0-ai/vm0/commit/0c7908e0c673b741e7d4497326d9ed81151a9f14)), closes [#1650](https://github.com/vm0-ai/vm0/issues/1650)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.1.0

## [8.0.0](https://github.com/vm0-ai/vm0/compare/cli-v7.1.1...cli-v8.0.0) (2026-01-26)


### ⚠ BREAKING CHANGES

* The CLI no longer implicitly loads `.env` files from the current directory. Users must now explicitly specify `--env-file <path>` to load environment variables from a file.
* **cli:** All schedule commands now require agent name instead of schedule name. The schedule.yaml file is no longer used.
* The vm0 setup-github command has been removed. Users who need GitHub Actions workflows should set them up manually.

### Features

* **cli:** redesign schedule commands to be agent-centric ([#1633](https://github.com/vm0-ai/vm0/issues/1633)) ([ad70674](https://github.com/vm0-ai/vm0/commit/ad706745bc4bdb268014c404f53bd6bd8a32e255))
* remove setup-github command ([#1628](https://github.com/vm0-ai/vm0/issues/1628)) ([d82410e](https://github.com/vm0-ai/vm0/commit/d82410edd74e97a3218e30e6b185cd04a853fb91)), closes [#1625](https://github.com/vm0-ai/vm0/issues/1625)
* replace implicit .env loading with explicit --env-file flag ([#1637](https://github.com/vm0-ai/vm0/issues/1637)) ([a94e9ac](https://github.com/vm0-ai/vm0/commit/a94e9ac420458c46c275c2163e32dd7dc1f7774e))

## [7.1.1](https://github.com/vm0-ai/vm0/compare/cli-v7.1.0...cli-v7.1.1) (2026-01-24)


### Bug Fixes

* **cli:** refactor runner-validation tests to use it.each for isolation ([#1618](https://github.com/vm0-ai/vm0/issues/1618)) ([6259210](https://github.com/vm0-ai/vm0/commit/62592102cf3741b8db7637cdc95c492b7f8584da))

## [7.1.0](https://github.com/vm0-ai/vm0/compare/cli-v7.0.2...cli-v7.1.0) (2026-01-24)


### Features

* **cli:** improve cook command help text ([#1616](https://github.com/vm0-ai/vm0/issues/1616)) ([a294c49](https://github.com/vm0-ai/vm0/commit/a294c49a06da83a381c3034d95250afd05397075))

## [7.0.2](https://github.com/vm0-ai/vm0/compare/cli-v7.0.1...cli-v7.0.2) (2026-01-24)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.0.1

## [7.0.1](https://github.com/vm0-ai/vm0/compare/cli-v7.0.0...cli-v7.0.1) (2026-01-24)


### Bug Fixes

* **cli:** remove color from [tool_result] and [result] labels ([#1601](https://github.com/vm0-ai/vm0/issues/1601)) ([de84f7d](https://github.com/vm0-ai/vm0/commit/de84f7db63e41385828a75b35f070774d8add943)), closes [#1595](https://github.com/vm0-ai/vm0/issues/1595)

## [7.0.0](https://github.com/vm0-ai/vm0/compare/cli-v6.4.1...cli-v7.0.0) (2026-01-24)


### ⚠ BREAKING CHANGES

* The experimental_secrets and experimental_vars fields have been removed from the agent compose schema. Users must migrate to the environment syntax with ${{ secrets.X }} and ${{ vars.X }} patterns.

### Features

* **cli:** rename experimental-credential to credential ([#1582](https://github.com/vm0-ai/vm0/issues/1582)) ([499e605](https://github.com/vm0-ai/vm0/commit/499e605c046f7f048c96f3ca6d8b257189aca40c))


### Miscellaneous Chores

* remove experimental_secrets/vars syntax sugar ([#1588](https://github.com/vm0-ai/vm0/issues/1588)) ([7960555](https://github.com/vm0-ai/vm0/commit/79605555ec153c21a689d0b15e61ab40e05ad073))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 6.0.0

## [6.4.1](https://github.com/vm0-ai/vm0/compare/cli-v6.4.0...cli-v6.4.1) (2026-01-23)


### Bug Fixes

* unify terminology from llm to model provider ([#1580](https://github.com/vm0-ai/vm0/issues/1580)) ([dfe6a2c](https://github.com/vm0-ai/vm0/commit/dfe6a2c99f9b8a0de02cb3afc902ae2eb57cefd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.5.0

## [6.4.0](https://github.com/vm0-ai/vm0/compare/cli-v6.3.1...cli-v6.4.0) (2026-01-23)


### Features

* **cli:** add help text for credential acquisition in model-provider setup ([#1562](https://github.com/vm0-ai/vm0/issues/1562)) ([3230f08](https://github.com/vm0-ai/vm0/commit/3230f0872227319519e473ecc53b053d4673f03a)), closes [#1558](https://github.com/vm0-ai/vm0/issues/1558)
* **cli:** add ls alias and remove --json from credential list ([#1563](https://github.com/vm0-ai/vm0/issues/1563)) ([bfd7dfb](https://github.com/vm0-ai/vm0/commit/bfd7dfb9cb6e10f6be08a4d743d89a906de942fc)), closes [#1560](https://github.com/vm0-ai/vm0/issues/1560)
* **cli:** improve vm0 init onboarding with model-provider setup ([#1571](https://github.com/vm0-ai/vm0/issues/1571)) ([e4e4c23](https://github.com/vm0-ai/vm0/commit/e4e4c23c7d5681965f573e1795b360b5cc3d07b1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.4.0

## [6.3.1](https://github.com/vm0-ai/vm0/compare/cli-v6.3.0...cli-v6.3.1) (2026-01-23)


### Bug Fixes

* **cli:** correct sequence gap detection to expect 1-based events ([#1526](https://github.com/vm0-ai/vm0/issues/1526)) ([1a4c2cd](https://github.com/vm0-ai/vm0/commit/1a4c2cdb97f6571de087c5414b6477fd698dfefd)), closes [#1525](https://github.com/vm0-ai/vm0/issues/1525)
* **cli:** detect bun/yarn package managers and show manual upgrade instructions ([#1534](https://github.com/vm0-ai/vm0/issues/1534)) ([805ef7a](https://github.com/vm0-ai/vm0/commit/805ef7a80f74a65b6afedae1a3ff631df0684a30))
* **cli:** resolve schedule by name globally for delete/enable/disable/status ([#1498](https://github.com/vm0-ai/vm0/issues/1498)) ([48d6275](https://github.com/vm0-ai/vm0/commit/48d62750589aac639d3e5120c2fd6114d5a34fea))


### Performance Improvements

* **e2e:** simplify model-provider tests to happy path only ([#1523](https://github.com/vm0-ai/vm0/issues/1523)) ([d58092b](https://github.com/vm0-ai/vm0/commit/d58092b9040684bfa57db1c0e5597e5421b29f6f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.3.1

## [6.3.0](https://github.com/vm0-ai/vm0/compare/cli-v6.2.1...cli-v6.3.0) (2026-01-22)


### Features

* add cyclomatic complexity checking to eslint ([#1502](https://github.com/vm0-ai/vm0/issues/1502)) ([d3b2859](https://github.com/vm0-ai/vm0/commit/d3b2859ca7374964c78fc5a4f0a76566c01551e3))
* **cli:** add --no-auto-update flag to vm0 cook command ([#1495](https://github.com/vm0-ai/vm0/issues/1495)) ([e3fdf4d](https://github.com/vm0-ai/vm0/commit/e3fdf4dd4947b6c1dd5cd617636a530dc3521e95)), closes [#1492](https://github.com/vm0-ai/vm0/issues/1492)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.3.0

## [6.2.1](https://github.com/vm0-ai/vm0/compare/cli-v6.2.0...cli-v6.2.1) (2026-01-22)


### Bug Fixes

* **cli:** update description to accurately reflect VM0's purpose ([#1483](https://github.com/vm0-ai/vm0/issues/1483)) ([dd7f41e](https://github.com/vm0-ai/vm0/commit/dd7f41ef3f0f3679ca5e86812b14588ecdfae17f))

## [6.2.0](https://github.com/vm0-ai/vm0/compare/cli-v6.1.0...cli-v6.2.0) (2026-01-22)


### Features

* **run:** integrate model provider with vm0 run command ([#1472](https://github.com/vm0-ai/vm0/issues/1472)) ([74c0a4c](https://github.com/vm0-ai/vm0/commit/74c0a4cfbc10683359065249dfbd9b8e282c2b84))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.2.0

## [6.1.0](https://github.com/vm0-ai/vm0/compare/cli-v6.0.0...cli-v6.1.0) (2026-01-21)


### Features

* add model provider entity and CLI commands ([#1452](https://github.com/vm0-ai/vm0/issues/1452)) ([86900d2](https://github.com/vm0-ai/vm0/commit/86900d2aa26420e1b940c039a87755c3feda531b))


### Bug Fixes

* **cli:** hide --debug-no-mock-claude option from help output ([#1459](https://github.com/vm0-ai/vm0/issues/1459)) ([a0dd095](https://github.com/vm0-ai/vm0/commit/a0dd095f879aaae993092d3405489be9c1f2b8cd)), closes [#1458](https://github.com/vm0-ai/vm0/issues/1458)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.1.0

## [6.0.0](https://github.com/vm0-ai/vm0/compare/cli-v5.10.0...cli-v6.0.0) (2026-01-21)


### ⚠ BREAKING CHANGES

* The `provider` field in vm0.yaml has been renamed to `framework`. Users must update their vm0.yaml files to use `framework` instead of `provider`.

### Features

* rename provider to framework in vm0.yaml configuration ([#1430](https://github.com/vm0-ai/vm0/issues/1430)) ([e2a242e](https://github.com/vm0-ai/vm0/commit/e2a242ef2b9c337b29dc992524abf6ebf2181804))


### Bug Fixes

* use message.name instead of data.type for realtime event handling ([#1434](https://github.com/vm0-ai/vm0/issues/1434)) ([50e368e](https://github.com/vm0-ai/vm0/commit/50e368e37ae885d3b7011ad5fa3cae9f69d64e2f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 5.0.0

## [5.10.0](https://github.com/vm0-ai/vm0/compare/cli-v5.9.1...cli-v5.10.0) (2026-01-21)


### Features

* **cli:** add experimental realtime event streaming with ably ([#1383](https://github.com/vm0-ai/vm0/issues/1383)) ([a37b177](https://github.com/vm0-ai/vm0/commit/a37b1776819c9c1653f214a513c206032e37af01))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.9.0

## [5.9.1](https://github.com/vm0-ai/vm0/compare/cli-v5.9.0...cli-v5.9.1) (2026-01-20)


### Bug Fixes

* update credential hint messages to use experimental-credential command ([#1348](https://github.com/vm0-ai/vm0/issues/1348)) ([3ac009a](https://github.com/vm0-ai/vm0/commit/3ac009a7db9af2dddc567d116c7e7f13628c1866))

## [5.9.0](https://github.com/vm0-ai/vm0/compare/cli-v5.8.0...cli-v5.9.0) (2026-01-20)


### Features

* **credentials:** add persistent credential management for third-party services ([#1303](https://github.com/vm0-ai/vm0/issues/1303)) ([ceff78a](https://github.com/vm0-ai/vm0/commit/ceff78a8285454f69ee3c25190c305795c6b327f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.8.0

## [5.8.0](https://github.com/vm0-ai/vm0/compare/cli-v5.7.2...cli-v5.8.0) (2026-01-20)


### Features

* add --debug-no-mock-claude flag for real Claude E2E tests ([#1324](https://github.com/vm0-ai/vm0/issues/1324)) ([f75cdb5](https://github.com/vm0-ai/vm0/commit/f75cdb5cc5f27b5979f4d8f882af5fdfdce9c07c))
* **cli:** add usage command to view daily run statistics ([#1301](https://github.com/vm0-ai/vm0/issues/1301)) ([1aaeaf1](https://github.com/vm0-ai/vm0/commit/1aaeaf1fed3fd07afaef8668bb92b09a7e9b3cdc))
* **cli:** rename `vm0 agents` command to `vm0 agent` ([#1299](https://github.com/vm0-ai/vm0/issues/1299)) ([9074358](https://github.com/vm0-ai/vm0/commit/907435824b3210f07bddc59aea1f011112e4d314)), closes [#1297](https://github.com/vm0-ai/vm0/issues/1297)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.7.0

## [5.7.2](https://github.com/vm0-ai/vm0/compare/cli-v5.7.1...cli-v5.7.2) (2026-01-19)


### Bug Fixes

* **cli:** simplify comment in index.ts ([#1323](https://github.com/vm0-ai/vm0/issues/1323)) ([604df37](https://github.com/vm0-ai/vm0/commit/604df37402ae2e0d11cfc852c94ef0275d46881a))

## [5.7.1](https://github.com/vm0-ai/vm0/compare/cli-v5.7.0...cli-v5.7.1) (2026-01-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.6.1

## [5.7.0](https://github.com/vm0-ai/vm0/compare/cli-v5.6.0...cli-v5.7.0) (2026-01-15)


### Features

* **cli:** auto-detect schedule name from schedule.yaml ([#1253](https://github.com/vm0-ai/vm0/issues/1253)) ([1509a08](https://github.com/vm0-ai/vm0/commit/1509a0847fc6ab32e23b30e892ac51101f76e92a)), closes [#1251](https://github.com/vm0-ai/vm0/issues/1251)

## [5.6.0](https://github.com/vm0-ai/vm0/compare/cli-v5.5.0...cli-v5.6.0) (2026-01-15)


### Features

* **cli:** improve schedule deploy output format for better readability ([#1249](https://github.com/vm0-ai/vm0/issues/1249)) ([ea92c39](https://github.com/vm0-ai/vm0/commit/ea92c395c16f8ca3c9b6a1502aa788d7d84731e0)), closes [#1247](https://github.com/vm0-ai/vm0/issues/1247)


### Bug Fixes

* **cli:** improve schedule date prompt tab completion ([#1248](https://github.com/vm0-ai/vm0/issues/1248)) ([be9d59d](https://github.com/vm0-ai/vm0/commit/be9d59d315ddc674b75f8975b9d308cce1979720))

## [5.5.0](https://github.com/vm0-ai/vm0/compare/cli-v5.4.0...cli-v5.5.0) (2026-01-15)


### Features

* **cli:** improve schedule status UX with local timezone and full run IDs ([#1245](https://github.com/vm0-ai/vm0/issues/1245)) ([ed167c2](https://github.com/vm0-ai/vm0/commit/ed167c23aa7118ca8137da34fa8365a6d36f6660)), closes [#1237](https://github.com/vm0-ai/vm0/issues/1237)

## [5.4.0](https://github.com/vm0-ai/vm0/compare/cli-v5.3.2...cli-v5.4.0) (2026-01-14)


### Features

* **schedule:** add api endpoint to view schedule run history ([#1204](https://github.com/vm0-ai/vm0/issues/1204)) ([c53f1a6](https://github.com/vm0-ai/vm0/commit/c53f1a664ecbf460727217364f62089eff1cc408))
* **schedule:** improve one-time schedule UX with contextual date hint ([#1200](https://github.com/vm0-ai/vm0/issues/1200)) ([09228a4](https://github.com/vm0-ai/vm0/commit/09228a41762635444c0ef4e906316a93769d772e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.6.0

## [5.3.2](https://github.com/vm0-ai/vm0/compare/cli-v5.3.1...cli-v5.3.2) (2026-01-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.5.0

## [5.3.1](https://github.com/vm0-ai/vm0/compare/cli-v5.3.0...cli-v5.3.1) (2026-01-14)


### Bug Fixes

* **schedule:** improve init wizard UX with default prompt and better messages ([#1194](https://github.com/vm0-ai/vm0/issues/1194)) ([1aeb7b6](https://github.com/vm0-ai/vm0/commit/1aeb7b600c15f747471ec693cf502c73507f2cee))

## [5.3.0](https://github.com/vm0-ai/vm0/compare/cli-v5.2.0...cli-v5.3.0) (2026-01-14)


### Features

* **schedule:** add vm0 schedule init interactive wizard ([#1189](https://github.com/vm0-ai/vm0/issues/1189)) ([586f022](https://github.com/vm0-ai/vm0/commit/586f022f997a6f36a99e49ffe4df1ebe01b29681))

## [5.2.0](https://github.com/vm0-ai/vm0/compare/cli-v5.1.3...cli-v5.2.0) (2026-01-14)


### Features

* **schedule:** add vm0 schedule command for automated agent runs ([#1105](https://github.com/vm0-ai/vm0/issues/1105)) ([ecdc2c5](https://github.com/vm0-ai/vm0/commit/ecdc2c5c01ea1340aefdc8ea20407fce1c264a34))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.4.0

## [5.1.3](https://github.com/vm0-ai/vm0/compare/cli-v5.1.2...cli-v5.1.3) (2026-01-13)


### Bug Fixes

* **cli:** quote version parameter to prevent scientific notation parsing ([#1155](https://github.com/vm0-ai/vm0/issues/1155)) ([792dbc1](https://github.com/vm0-ai/vm0/commit/792dbc15714fe788d9ae519dd7be0e8061046506))
* **docs:** trigger production deployment for cli reference updates ([#1173](https://github.com/vm0-ai/vm0/issues/1173)) ([57baf42](https://github.com/vm0-ai/vm0/commit/57baf42d83a19652c9db2881e48f50fd1a0054e6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.3.0

## [5.1.2](https://github.com/vm0-ai/vm0/compare/cli-v5.1.1...cli-v5.1.2) (2026-01-13)


### Bug Fixes

* **docs:** trigger production deployment for quick start updates ([#1142](https://github.com/vm0-ai/vm0/issues/1142)) ([f8fb029](https://github.com/vm0-ai/vm0/commit/f8fb029227bfc5151a5af30154a0cfb4bc28b480)), closes [#1118](https://github.com/vm0-ai/vm0/issues/1118)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.2.1

## [5.1.1](https://github.com/vm0-ai/vm0/compare/cli-v5.1.0...cli-v5.1.1) (2026-01-12)


### Bug Fixes

* limit lint concurrency to prevent OOM ([#1096](https://github.com/vm0-ai/vm0/issues/1096)) ([a3c7dde](https://github.com/vm0-ai/vm0/commit/a3c7dde4f74f50bb2d1a925393f7f430699e3980))

## [5.1.0](https://github.com/vm0-ai/vm0/compare/cli-v5.0.2...cli-v5.1.0) (2026-01-12)


### Features

* **lifecycle:** add postCreateCommand hook and hardcode working_dir ([#1077](https://github.com/vm0-ai/vm0/issues/1077)) ([86f7077](https://github.com/vm0-ai/vm0/commit/86f70777701d2d8715edec620e804c9ceeea0bad))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.2.0

## [5.0.2](https://github.com/vm0-ai/vm0/compare/cli-v5.0.1...cli-v5.0.2) (2026-01-11)


### Bug Fixes

* **runner:** support SNI-only mode network logs in experimental_firewall ([#1088](https://github.com/vm0-ai/vm0/issues/1088)) ([c8308ef](https://github.com/vm0-ai/vm0/commit/c8308ef3490b03069b2a65253ab2209c9ba30eac)), closes [#1063](https://github.com/vm0-ai/vm0/issues/1063)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.1.1

## [5.0.1](https://github.com/vm0-ai/vm0/compare/cli-v5.0.0...cli-v5.0.1) (2026-01-10)


### Bug Fixes

* **cli:** update network logs error message to reference experimental_runner ([#1066](https://github.com/vm0-ai/vm0/issues/1066)) ([3013ba2](https://github.com/vm0-ai/vm0/commit/3013ba2d13887e415c67501236dd58205f159da4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.1.0

## [5.0.0](https://github.com/vm0-ai/vm0/compare/cli-v4.38.2...cli-v5.0.0) (2026-01-10)


### ⚠ BREAKING CHANGES

* experimental_network_security field removed from agent compose schema

### Code Refactoring

* remove deprecated experimental_network_security feature ([#1057](https://github.com/vm0-ai/vm0/issues/1057)) ([457864b](https://github.com/vm0-ai/vm0/commit/457864bcea4665b302f9f0df265233aa3f9270d5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 4.0.0

## [4.38.2](https://github.com/vm0-ai/vm0/compare/cli-v4.38.1...cli-v4.38.2) (2026-01-10)


### Bug Fixes

* disable DTS generation in watch mode to prevent memory crashes ([#1048](https://github.com/vm0-ai/vm0/issues/1048)) ([a26bc34](https://github.com/vm0-ai/vm0/commit/a26bc34ace19fc6d6dec5d3300f5551a6ddf4b60)), closes [#1041](https://github.com/vm0-ai/vm0/issues/1041)

## [4.38.1](https://github.com/vm0-ai/vm0/compare/cli-v4.38.0...cli-v4.38.1) (2026-01-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.4.0

## [4.38.0](https://github.com/vm0-ai/vm0/compare/cli-v4.37.0...cli-v4.38.0) (2026-01-09)


### Features

* **cli:** add vm0 agents list and inspect commands ([#1003](https://github.com/vm0-ai/vm0/issues/1003)) ([a214d3b](https://github.com/vm0-ai/vm0/commit/a214d3b08e5cb78d27033dc6b5e23601993472bc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.3.0

## [4.37.0](https://github.com/vm0-ai/vm0/compare/cli-v4.36.1...cli-v4.37.0) (2026-01-09)


### Features

* **runner:** move network security proxy to runner host level ([#964](https://github.com/vm0-ai/vm0/issues/964)) ([6a77a51](https://github.com/vm0-ai/vm0/commit/6a77a51f8bec551b3ff8dec278456a2a53cd3aac))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.2.0

## [4.36.1](https://github.com/vm0-ai/vm0/compare/cli-v4.36.0...cli-v4.36.1) (2026-01-09)


### Bug Fixes

* **docs:** trigger release for documentation updates ([#993](https://github.com/vm0-ai/vm0/issues/993)) ([1f3e2be](https://github.com/vm0-ai/vm0/commit/1f3e2be18c74219b2954c0d98a6456bf35b055ca))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.1.1

## [4.36.0](https://github.com/vm0-ai/vm0/compare/cli-v4.35.3...cli-v4.36.0) (2026-01-08)


### Features

* replace custom image building with apps-based image selection ([#963](https://github.com/vm0-ai/vm0/issues/963)) ([231f9b0](https://github.com/vm0-ai/vm0/commit/231f9b0890b07baaa618be58a7da14cc52b0ec7d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.1.0

## [4.35.3](https://github.com/vm0-ai/vm0/compare/cli-v4.35.2...cli-v4.35.3) (2026-01-06)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.0.2

## [4.35.2](https://github.com/vm0-ai/vm0/compare/cli-v4.35.1...cli-v4.35.2) (2026-01-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.0.1

## [4.35.1](https://github.com/vm0-ai/vm0/compare/cli-v4.35.0...cli-v4.35.1) (2026-01-05)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 3.0.0

## [4.35.0](https://github.com/vm0-ai/vm0/compare/cli-v4.34.0...cli-v4.35.0) (2026-01-04)


### Features

* **cli:** setup-github respects git root directory when run from subdirectory ([#897](https://github.com/vm0-ai/vm0/issues/897)) ([d5bae12](https://github.com/vm0-ai/vm0/commit/d5bae12875e2ce2318681c7eeda3f9296f0a21b4))

## [4.34.0](https://github.com/vm0-ai/vm0/compare/cli-v4.33.0...cli-v4.34.0) (2026-01-04)


### Features

* **docs:** trigger release for product philosophy page ([#884](https://github.com/vm0-ai/vm0/issues/884)) ([45ec3a2](https://github.com/vm0-ai/vm0/commit/45ec3a296b4d4ac01b4ac1f0536692d1626c7551))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.6.0

## [4.33.0](https://github.com/vm0-ai/vm0/compare/cli-v4.32.0...cli-v4.33.0) (2025-12-31)


### Features

* load secrets from env vars for run continue/resume ([#846](https://github.com/vm0-ai/vm0/issues/846)) ([2d8ae98](https://github.com/vm0-ai/vm0/commit/2d8ae9837463d44846326bd5eca925026ccc3c4c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.5.0

## [4.32.0](https://github.com/vm0-ai/vm0/compare/cli-v4.31.1...cli-v4.32.0) (2025-12-30)


### Features

* **cli:** add artifact/volume list and clone commands with interactive prompts ([#800](https://github.com/vm0-ai/vm0/issues/800)) ([3a95d22](https://github.com/vm0-ai/vm0/commit/3a95d224fb9f38de92db5fd97e75c6968d7daed5))
* **cli:** smart secret confirmation - only prompt for new secrets ([#814](https://github.com/vm0-ai/vm0/issues/814)) ([cdef21e](https://github.com/vm0-ai/vm0/commit/cdef21ec5facb35de73c509edd98a429cd8190ce))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.4.0

## [4.31.1](https://github.com/vm0-ai/vm0/compare/cli-v4.31.0...cli-v4.31.1) (2025-12-30)


### Bug Fixes

* **cli:** inherit TTY for compose command in cook workflow ([#809](https://github.com/vm0-ai/vm0/issues/809)) ([0b46ac9](https://github.com/vm0-ai/vm0/commit/0b46ac9acd1d874ab3add859451602ab1b7c4508))

## [4.31.0](https://github.com/vm0-ai/vm0/compare/cli-v4.30.0...cli-v4.31.0) (2025-12-30)


### Features

* **cli:** parse vm0_secrets and vm0_vars from skill frontmatter during compose ([#804](https://github.com/vm0-ai/vm0/issues/804)) ([52f2cbe](https://github.com/vm0-ai/vm0/commit/52f2cbe8194c815accd624a69d769055a750e0a3))
* separate secrets from vars in checkpoint/session system ([#803](https://github.com/vm0-ai/vm0/issues/803)) ([538b4e5](https://github.com/vm0-ai/vm0/commit/538b4e56d9300905cf06f6fdd41143639615efcd))

## [4.30.0](https://github.com/vm0-ai/vm0/compare/cli-v4.29.1...cli-v4.30.0) (2025-12-30)


### Features

* **cli:** replace --limit with --tail and --head flags for logs command ([#797](https://github.com/vm0-ai/vm0/issues/797)) ([bc5aa0e](https://github.com/vm0-ai/vm0/commit/bc5aa0ebdb3e5d8195a76197ed79df099610a257))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.3.0

## [4.29.1](https://github.com/vm0-ai/vm0/compare/cli-v4.29.0...cli-v4.29.1) (2025-12-29)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.2.0

## [4.29.0](https://github.com/vm0-ai/vm0/compare/cli-v4.28.0...cli-v4.29.0) (2025-12-27)


### Features

* **cli:** add setup-github command for github actions workflow initialization ([#773](https://github.com/vm0-ai/vm0/issues/773)) ([8357e72](https://github.com/vm0-ai/vm0/commit/8357e721b6ef06d172c37267e80fa643b05c5f46))

## [4.28.0](https://github.com/vm0-ai/vm0/compare/cli-v4.27.0...cli-v4.28.0) (2025-12-26)


### Features

* add scope support to agent compose ([#764](https://github.com/vm0-ai/vm0/issues/764)) ([79e8103](https://github.com/vm0-ai/vm0/commit/79e8103327dde0db6562d13dcaab0c36bb070ee6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.1.0

## [4.27.0](https://github.com/vm0-ai/vm0/compare/cli-v4.26.1...cli-v4.27.0) (2025-12-26)


### Features

* **cli:** add experimental_secrets and experimental_vars shorthand ([#759](https://github.com/vm0-ai/vm0/issues/759)) ([c4b864e](https://github.com/vm0-ai/vm0/commit/c4b864edfdd03f7b106a9968483be662ca785ec5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 2.0.0

## [4.26.1](https://github.com/vm0-ai/vm0/compare/cli-v4.26.0...cli-v4.26.1) (2025-12-25)


### Bug Fixes

* **cli:** default to production images when NODE_ENV is not set ([#748](https://github.com/vm0-ai/vm0/issues/748)) ([d50d873](https://github.com/vm0-ai/vm0/commit/d50d873ffa2d8b99c81f65d96ec27905e7e1ff10))

## [4.26.0](https://github.com/vm0-ai/vm0/compare/cli-v4.25.0...cli-v4.26.0) (2025-12-25)


### Features

* **cli:** forward vm0 logs options in vm0 cook logs ([#739](https://github.com/vm0-ai/vm0/issues/739)) ([7e71450](https://github.com/vm0-ai/vm0/commit/7e7145045fc6a2e4fe852fe1f7f69e692c98baaa))


### Bug Fixes

* **cli:** use ppid to isolate cook state per terminal ([#743](https://github.com/vm0-ai/vm0/issues/743)) ([a52b7d3](https://github.com/vm0-ai/vm0/commit/a52b7d3f71d2395df293cd4912b0776f7d3da21e))

## [4.25.0](https://github.com/vm0-ai/vm0/compare/cli-v4.24.0...cli-v4.25.0) (2025-12-25)


### Features

* **cli:** add vm0 init command to initialize project files ([#737](https://github.com/vm0-ai/vm0/issues/737)) ([3fbc4a3](https://github.com/vm0-ai/vm0/commit/3fbc4a32f91c85db6d1670cd9603c689004f8188))

## [4.24.0](https://github.com/vm0-ai/vm0/compare/cli-v4.23.0...cli-v4.24.0) (2025-12-25)


### Features

* **cli:** implement vm0 cook continue/resume/logs subcommands ([#734](https://github.com/vm0-ai/vm0/issues/734)) ([85fb337](https://github.com/vm0-ai/vm0/commit/85fb337144e50aad4701ce3868a9405b92a310eb))

## [4.23.0](https://github.com/vm0-ai/vm0/compare/cli-v4.22.0...cli-v4.23.0) (2025-12-25)


### Features

* **cli:** show tutorial-style manual commands in vm0 cook output ([#725](https://github.com/vm0-ai/vm0/issues/725)) ([57c65e4](https://github.com/vm0-ai/vm0/commit/57c65e4d6749c4476e38ec8fc093b330dfd0e7ef))

## [4.22.0](https://github.com/vm0-ai/vm0/compare/cli-v4.21.2...cli-v4.22.0) (2025-12-25)


### Features

* remove unused sessions API and migrate session history to R2 ([#718](https://github.com/vm0-ai/vm0/issues/718)) ([a5cd85d](https://github.com/vm0-ai/vm0/commit/a5cd85d2f9f2c513ab88f90359dd21414a36e24b))


### Bug Fixes

* **cli:** suppress dotenv promotional messages ([#722](https://github.com/vm0-ai/vm0/issues/722)) ([2ba6806](https://github.com/vm0-ai/vm0/commit/2ba680656b773972ece6680a68d7a50f9d5b7cbf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.5.0

## [4.21.2](https://github.com/vm0-ai/vm0/compare/cli-v4.21.1...cli-v4.21.2) (2025-12-25)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.4.0

## [4.21.1](https://github.com/vm0-ai/vm0/compare/cli-v4.21.0...cli-v4.21.1) (2025-12-23)


### Bug Fixes

* return provider in events APIs for correct rendering ([#697](https://github.com/vm0-ai/vm0/issues/697)) ([c72c9d7](https://github.com/vm0-ai/vm0/commit/c72c9d7d90792ffffde7f92737dfdbe022052a99))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.3.1

## [4.21.0](https://github.com/vm0-ai/vm0/compare/cli-v4.20.0...cli-v4.21.0) (2025-12-23)


### Features

* add codex support alongside claude code ([#637](https://github.com/vm0-ai/vm0/issues/637)) ([db42ad7](https://github.com/vm0-ai/vm0/commit/db42ad79db60a026e97257c4c752fcec35afbbd8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.3.0

## [4.20.0](https://github.com/vm0-ai/vm0/compare/cli-v4.19.0...cli-v4.20.0) (2025-12-23)


### Features

* **cli:** promote beta features to stable and add image auto-config ([#689](https://github.com/vm0-ai/vm0/issues/689)) ([76161b2](https://github.com/vm0-ai/vm0/commit/76161b2d6a982fafc9eb6fdf731d9b485f263b21))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.2.0

## [4.19.0](https://github.com/vm0-ai/vm0/compare/cli-v4.18.0...cli-v4.19.0) (2025-12-23)


### Features

* **cli:** add Dockerfile pre-validation in vm0 image build ([#683](https://github.com/vm0-ai/vm0/issues/683)) ([1e25a37](https://github.com/vm0-ai/vm0/commit/1e25a3798f5abfca1a4754fded91d062e027a766))

## [4.18.0](https://github.com/vm0-ai/vm0/compare/cli-v4.17.0...cli-v4.18.0) (2025-12-22)


### Features

* **image:** enforce lowercase image names for Docker compatibility ([#662](https://github.com/vm0-ai/vm0/issues/662)) ([7a6f5ff](https://github.com/vm0-ai/vm0/commit/7a6f5fffb0d517d853e2bd272534a868b0875837))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.1.0

## [4.17.0](https://github.com/vm0-ai/vm0/compare/cli-v4.16.1...cli-v4.17.0) (2025-12-22)


### Features

* **image:** support @vm0/claude-code format for system images ([#655](https://github.com/vm0-ai/vm0/issues/655)) ([1ddd99f](https://github.com/vm0-ai/vm0/commit/1ddd99fa1b640956244dfd463e6eda6a942e8416))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 1.0.0

## [4.16.1](https://github.com/vm0-ai/vm0/compare/cli-v4.16.0...cli-v4.16.1) (2025-12-21)


### Bug Fixes

* sandbox calls commit on deduplication to update HEAD ([#650](https://github.com/vm0-ai/vm0/issues/650)) ([51da31a](https://github.com/vm0-ai/vm0/commit/51da31a7bae1e431d7f3fd8b8cc04f0e951603f7))

## [4.16.0](https://github.com/vm0-ai/vm0/compare/cli-v4.15.0...cli-v4.16.0) (2025-12-21)


### Features

* **image:** add versioning support with tag syntax ([#643](https://github.com/vm0-ai/vm0/issues/643)) ([761ce57](https://github.com/vm0-ai/vm0/commit/761ce5791aca56e96739db7513fd4e5a83065717))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.8.0

## [4.15.0](https://github.com/vm0-ai/vm0/compare/cli-v4.14.1...cli-v4.15.0) (2025-12-20)


### Features

* add scope/namespace system for resource isolation ([#636](https://github.com/vm0-ai/vm0/issues/636)) ([1369059](https://github.com/vm0-ai/vm0/commit/1369059e3e3d7a82aca3f00e59dd2f2814dab0e4))
* **cli:** make --artifact-name optional for vm0 run command ([#640](https://github.com/vm0-ai/vm0/issues/640)) ([6895cfe](https://github.com/vm0-ai/vm0/commit/6895cfe6411b48b23b49d9c5a500fdd0aa746fd0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.7.0

## [4.14.1](https://github.com/vm0-ai/vm0/compare/cli-v4.14.0...cli-v4.14.1) (2025-12-19)


### Bug Fixes

* **cli:** call commit even when version exists to update HEAD ([#627](https://github.com/vm0-ai/vm0/issues/627)) ([acae00b](https://github.com/vm0-ai/vm0/commit/acae00b6ee1fc296eb950a555137f12a67059b49))

## [4.14.0](https://github.com/vm0-ai/vm0/compare/cli-v4.13.1...cli-v4.14.0) (2025-12-19)


### Features

* **cli:** add status command for volume and artifact ([#624](https://github.com/vm0-ai/vm0/issues/624)) ([a586930](https://github.com/vm0-ai/vm0/commit/a586930b44c66442f850e5ea2b6d2244c2049018))

## [4.13.1](https://github.com/vm0-ai/vm0/compare/cli-v4.13.0...cli-v4.13.1) (2025-12-19)


### Bug Fixes

* **storage:** allow empty artifact push to update remote HEAD ([#618](https://github.com/vm0-ai/vm0/issues/618)) ([93352c4](https://github.com/vm0-ai/vm0/commit/93352c4ac03c5a4861edb1d94e188efb17195694))

## [4.13.0](https://github.com/vm0-ai/vm0/compare/cli-v4.12.0...cli-v4.13.0) (2025-12-19)


### Features

* **api:** add direct S3 upload endpoints for large file support ([#595](https://github.com/vm0-ai/vm0/issues/595)) ([5eb11d0](https://github.com/vm0-ai/vm0/commit/5eb11d05c12ee55064dd946a1c99f3a19aaf96e9))
* **cli:** improve setup-token output with human-readable format ([#610](https://github.com/vm0-ai/vm0/issues/610)) ([46ca67d](https://github.com/vm0-ai/vm0/commit/46ca67d4a08f8113d662a9cc398d0ae16b2e2846))
* **cli:** support pnpm in auto-upgrade feature ([#612](https://github.com/vm0-ai/vm0/issues/612)) ([a7ed12f](https://github.com/vm0-ai/vm0/commit/a7ed12faaf6b24821a3083e68471a1c9a061a281))

## [4.12.0](https://github.com/vm0-ai/vm0/compare/cli-v4.11.0...cli-v4.12.0) (2025-12-19)


### Features

* **cli:** add setup-token command for CI/CD token export ([#605](https://github.com/vm0-ai/vm0/issues/605)) ([c2a9aec](https://github.com/vm0-ai/vm0/commit/c2a9aec4494695f0f26839c5dbc34c142d8c73ad))

## [4.11.0](https://github.com/vm0-ai/vm0/compare/cli-v4.10.0...cli-v4.11.0) (2025-12-18)


### Features

* **cli:** add auto-upgrade check for cook command ([#598](https://github.com/vm0-ai/vm0/issues/598)) ([e388796](https://github.com/vm0-ai/vm0/commit/e388796a7ba8c9f755d3bd7886a6227907614ea5))

## [4.10.0](https://github.com/vm0-ai/vm0/compare/cli-v4.9.0...cli-v4.10.0) (2025-12-18)


### Features

* **cli:** add system logs tip on run failure ([#587](https://github.com/vm0-ai/vm0/issues/587)) ([90491d6](https://github.com/vm0-ai/vm0/commit/90491d6ecf587b6bf654afe9c1205b161cb6f7de))
* **cli:** auto-generate .env file for missing variables in vm0 cook ([#584](https://github.com/vm0-ai/vm0/issues/584)) ([5b150cf](https://github.com/vm0-ai/vm0/commit/5b150cfb195892be6ca3ab688bc66657780c9853))

## [4.9.0](https://github.com/vm0-ai/vm0/compare/cli-v4.8.1...cli-v4.9.0) (2025-12-17)


### Features

* **storage:** skip S3 upload/download for empty artifacts ([#575](https://github.com/vm0-ai/vm0/issues/575)) ([bd75e53](https://github.com/vm0-ai/vm0/commit/bd75e53f28019fa262f98adede304c99556d999d))

## [4.8.1](https://github.com/vm0-ai/vm0/compare/cli-v4.8.0...cli-v4.8.1) (2025-12-17)


### Bug Fixes

* **cli:** fix error message display in artifact/volume pull commands ([#570](https://github.com/vm0-ai/vm0/issues/570)) ([56af5c7](https://github.com/vm0-ai/vm0/commit/56af5c7d43edf0dae9b580b09cce87ed514afc3a))

## [4.8.0](https://github.com/vm0-ai/vm0/compare/cli-v4.7.1...cli-v4.8.0) (2025-12-17)


### Features

* **cli:** add beta_system_prompt and beta_system_skills support for agent compose ([#565](https://github.com/vm0-ai/vm0/issues/565)) ([b6388d9](https://github.com/vm0-ai/vm0/commit/b6388d9b9511bf7a6407dc2d17a6a81f85e8d3eb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.6.0

## [4.7.1](https://github.com/vm0-ai/vm0/compare/cli-v4.7.0...cli-v4.7.1) (2025-12-13)


### Bug Fixes

* **cli:** revert system_prompt and system_skills feature ([#540](https://github.com/vm0-ai/vm0/issues/540)) ([b2254fe](https://github.com/vm0-ai/vm0/commit/b2254fec128a641106aa1db67faac938e39e3b3b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.5.1

## [4.7.0](https://github.com/vm0-ai/vm0/compare/cli-v4.6.0...cli-v4.7.0) (2025-12-12)


### Features

* **cli:** add --secrets parameter for passing secrets via CLI ([#512](https://github.com/vm0-ai/vm0/issues/512)) ([7972bf4](https://github.com/vm0-ai/vm0/commit/7972bf4f82f76112f99ebf8068c133e953a4ae20))
* **cli:** add system_prompt and system_skills support for agent compose ([#513](https://github.com/vm0-ai/vm0/issues/513)) ([5079a4a](https://github.com/vm0-ai/vm0/commit/5079a4a9d7a41617e53b22c7ea9e666cf4838f08))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.5.0

## [4.6.0](https://github.com/vm0-ai/vm0/compare/cli-v4.5.2...cli-v4.6.0) (2025-12-12)


### Features

* **web:** add generic proxy endpoint for sandbox requests ([#503](https://github.com/vm0-ai/vm0/issues/503)) ([36eda65](https://github.com/vm0-ai/vm0/commit/36eda650e853a62e2269380a777e305505e50702))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.4.0

## [4.5.2](https://github.com/vm0-ai/vm0/compare/cli-v4.5.1...cli-v4.5.2) (2025-12-11)


### Bug Fixes

* **cli:** align logs timestamp format with metrics output ([#498](https://github.com/vm0-ai/vm0/issues/498)) ([b20a7c4](https://github.com/vm0-ai/vm0/commit/b20a7c4f11dbd6622fce2e9ea3596f90f91a27e3))

## [4.5.1](https://github.com/vm0-ai/vm0/compare/cli-v4.5.0...cli-v4.5.1) (2025-12-11)


### Bug Fixes

* **cli:** handle run preparation failures immediately ([#496](https://github.com/vm0-ai/vm0/issues/496)) ([72917c5](https://github.com/vm0-ai/vm0/commit/72917c5c665c797dbda09b1b9278db0ef8e2afb8))

## [4.5.0](https://github.com/vm0-ai/vm0/compare/cli-v4.4.0...cli-v4.5.0) (2025-12-11)


### Features

* **cli:** add timestamp display for vm0 logs --agent ([#489](https://github.com/vm0-ai/vm0/issues/489)) ([862b3e2](https://github.com/vm0-ai/vm0/commit/862b3e248f4f934aca67636b586c40e747fa10de))
* **cli:** show logs command hint when run starts ([#480](https://github.com/vm0-ai/vm0/issues/480)) ([3b12cd0](https://github.com/vm0-ai/vm0/commit/3b12cd06fd77f48f893419ddd80d3a09db81a98b))

## [4.4.0](https://github.com/vm0-ai/vm0/compare/cli-v4.3.0...cli-v4.4.0) (2025-12-10)


### Features

* **storage:** support same name for volume and artifact with type isolation ([#477](https://github.com/vm0-ai/vm0/issues/477)) ([c7ad149](https://github.com/vm0-ai/vm0/commit/c7ad149716eae4c3ab33650c3fbcd47b881944eb))

## [4.3.0](https://github.com/vm0-ai/vm0/compare/cli-v4.2.0...cli-v4.3.0) (2025-12-10)


### Features

* **api:** migrate /api/secrets to ts-rest contract-first architecture ([#453](https://github.com/vm0-ai/vm0/issues/453)) ([27fd2fa](https://github.com/vm0-ai/vm0/commit/27fd2fa1cf0f5c7b3b6b227c547d59d56f13b9de))
* **observability:** implement sandbox telemetry collection and storage ([#466](https://github.com/vm0-ai/vm0/issues/466)) ([8fe6748](https://github.com/vm0-ai/vm0/commit/8fe674887d84fba9f35838e7ebbdb288967feae4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.3.0

## [4.2.0](https://github.com/vm0-ai/vm0/compare/cli-v4.1.0...cli-v4.2.0) (2025-12-08)


### Features

* **image:** add E2B template deletion and improve error handling ([#427](https://github.com/vm0-ai/vm0/issues/427)) ([5630899](https://github.com/vm0-ai/vm0/commit/5630899d74a223f2e6e1185b5ae620971927b61e))

## [4.1.0](https://github.com/vm0-ai/vm0/compare/cli-v4.0.0...cli-v4.1.0) (2025-12-08)


### Features

* add vm0 image build command for custom Dockerfile support ([#408](https://github.com/vm0-ai/vm0/issues/408)) ([66953a2](https://github.com/vm0-ai/vm0/commit/66953a22c4fce93d60ef8a176b58df555ce504a0))

## [4.0.0](https://github.com/vm0-ai/vm0/compare/cli-v3.9.0...cli-v4.0.0) (2025-12-06)


### ⚠ BREAKING CHANGES

* **cli:** Users must now use `vm0 compose` instead of `vm0 build`

### Features

* **cli:** remove timeout option and detect sandbox termination via events API ([#417](https://github.com/vm0-ai/vm0/issues/417)) ([72fd836](https://github.com/vm0-ai/vm0/commit/72fd836f018e14719f1c9c47ceb11096c66228b2))
* **cli:** rename build command to compose ([#410](https://github.com/vm0-ai/vm0/issues/410)) ([0df242d](https://github.com/vm0-ai/vm0/commit/0df242d35352100af10dcc96fd61895b9ca9e318))

## [3.9.0](https://github.com/vm0-ai/vm0/compare/cli-v3.8.2...cli-v3.9.0) (2025-12-06)


### Features

* **cli:** support timeout=0 for no timeout in run and cook commands ([#399](https://github.com/vm0-ai/vm0/issues/399)) ([bb94811](https://github.com/vm0-ai/vm0/commit/bb948111c8e6f9cccd339586fe311f4336d07c37))

## [3.8.2](https://github.com/vm0-ai/vm0/compare/cli-v3.8.1...cli-v3.8.2) (2025-12-04)


### Bug Fixes

* **cli:** render object values as json instead of string coercion ([#383](https://github.com/vm0-ai/vm0/issues/383)) ([30aaaae](https://github.com/vm0-ai/vm0/commit/30aaaaeb1a3e4ddc5d98cc497d819c66b05d8d31))

## [3.8.1](https://github.com/vm0-ai/vm0/compare/cli-v3.8.0...cli-v3.8.1) (2025-12-04)


### Bug Fixes

* **cli:** change timeout to interval-based instead of total runtime ([#380](https://github.com/vm0-ai/vm0/issues/380)) ([c47d3b4](https://github.com/vm0-ai/vm0/commit/c47d3b4667029673ca66c8c35dfe6c238efb91b9))

## [3.8.0](https://github.com/vm0-ai/vm0/compare/cli-v3.7.0...cli-v3.8.0) (2025-12-04)


### Features

* **cli:** add next steps hints after vm0 run completes ([#378](https://github.com/vm0-ai/vm0/issues/378)) ([90a0a2b](https://github.com/vm0-ai/vm0/commit/90a0a2b447dfb945ffbdd1938792e0d2981aa214))

## [3.7.0](https://github.com/vm0-ai/vm0/compare/cli-v3.6.0...cli-v3.7.0) (2025-12-04)


### Features

* **cli:** auto-pull artifact after cook command when version changes ([#377](https://github.com/vm0-ai/vm0/issues/377)) ([1bb3b7d](https://github.com/vm0-ai/vm0/commit/1bb3b7d690c77c20827e1ec49d845e2cf3cd3e26))

## [3.6.0](https://github.com/vm0-ai/vm0/compare/cli-v3.5.0...cli-v3.6.0) (2025-12-03)


### Features

* **cli:** add cook command for one-click agent preparation ([#371](https://github.com/vm0-ai/vm0/issues/371)) ([8ef6415](https://github.com/vm0-ai/vm0/commit/8ef6415d9b5368db381eecbec27089e1c315a9a9))

## [3.5.0](https://github.com/vm0-ai/vm0/compare/cli-v3.4.0...cli-v3.5.0) (2025-12-03)


### Features

* add unified environment variable syntax ([#362](https://github.com/vm0-ai/vm0/issues/362)) ([e218dd7](https://github.com/vm0-ai/vm0/commit/e218dd76ddd4b7e6508725570b0cd7ee7d769f56))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.2.0

## [3.4.0](https://github.com/vm0-ai/vm0/compare/cli-v3.3.0...cli-v3.4.0) (2025-12-03)


### Features

* **cli:** support compose version specifier in vm0 run command ([#365](https://github.com/vm0-ai/vm0/issues/365)) ([7df7623](https://github.com/vm0-ai/vm0/commit/7df7623f9a2f32e5aa264bb17e348a97124e332e))

## [3.3.0](https://github.com/vm0-ai/vm0/compare/cli-v3.2.2...cli-v3.3.0) (2025-12-02)


### Features

* add immutable versioning for agent composes ([#355](https://github.com/vm0-ai/vm0/issues/355)) ([10f3000](https://github.com/vm0-ai/vm0/commit/10f300049e74e902a93444b469350a4f3d13c72d))

## [3.2.2](https://github.com/vm0-ai/vm0/compare/cli-v3.2.1...cli-v3.2.2) (2025-12-02)


### Bug Fixes

* start elapsed time calculation from command invocation ([#353](https://github.com/vm0-ai/vm0/issues/353)) ([6dd48a1](https://github.com/vm0-ai/vm0/commit/6dd48a1c65f00d46e3eaf6a5a751b52b91f5103c))

## [3.2.1](https://github.com/vm0-ai/vm0/compare/cli-v3.2.0...cli-v3.2.1) (2025-12-02)


### Bug Fixes

* use client receive time for event elapsed calculation ([#350](https://github.com/vm0-ai/vm0/issues/350)) ([6549a9c](https://github.com/vm0-ai/vm0/commit/6549a9cd8d474c1f898b112397f31dcd9713734a))

## [3.2.0](https://github.com/vm0-ai/vm0/compare/cli-v3.1.0...cli-v3.2.0) (2025-12-02)


### Features

* capture stderr for detailed error messages in vm0_error ([#348](https://github.com/vm0-ai/vm0/issues/348)) ([e961a6f](https://github.com/vm0-ai/vm0/commit/e961a6f1d0edbaab2fcfd065ca7cf1158e3f34c6))

## [3.1.0](https://github.com/vm0-ai/vm0/compare/cli-v3.0.0...cli-v3.1.0) (2025-12-02)


### Features

* **cli:** add --verbose flag and elapsed time display for run command ([#341](https://github.com/vm0-ai/vm0/issues/341)) ([3122e1d](https://github.com/vm0-ai/vm0/commit/3122e1d47c500c529e40652ce5059d1a9be6f8c0))

## [3.0.0](https://github.com/vm0-ai/vm0/compare/cli-v2.0.0...cli-v3.0.0) (2025-12-01)


### ⚠ BREAKING CHANGES

* Existing agent.yaml files need to be migrated from: ```yaml agents:   - name: "my-agent"     image: "..." ``` to: ```yaml agents:   my-agent:     image: "..." ```

### Code Refactoring

* change agents from array to dictionary in agent.yaml ([#334](https://github.com/vm0-ai/vm0/issues/334)) ([c21a1d0](https://github.com/vm0-ai/vm0/commit/c21a1d09d36e93fdb3cba36ee16c536a8a69a960))

## [2.0.0](https://github.com/vm0-ai/vm0/compare/cli-v1.16.0...cli-v2.0.0) (2025-12-01)


### ⚠ BREAKING CHANGES

* CLI and API now use tar.gz format exclusively. Clients must be updated to send/receive tar.gz instead of zip.

### Code Refactoring

* unify compression stack to tar.gz ([#331](https://github.com/vm0-ai/vm0/issues/331)) ([0745967](https://github.com/vm0-ai/vm0/commit/07459676b1385d30223ec63d16b2190857b70a2b))

## [1.16.0](https://github.com/vm0-ai/vm0/compare/cli-v1.15.0...cli-v1.16.0) (2025-11-30)


### Features

* add --force flag to artifact push command ([#323](https://github.com/vm0-ai/vm0/issues/323)) ([aa5eb6a](https://github.com/vm0-ai/vm0/commit/aa5eb6aceeab4113a23d6809a38a7ceb369c58dd))

## [1.15.0](https://github.com/vm0-ai/vm0/compare/cli-v1.14.0...cli-v1.15.0) (2025-11-30)


### Features

* **cli:** add --force flag to volume push command ([#321](https://github.com/vm0-ai/vm0/issues/321)) ([9e42c86](https://github.com/vm0-ai/vm0/commit/9e42c86fd6eec99062911b0e367bf27de89eabcb))

## [1.14.0](https://github.com/vm0-ai/vm0/compare/cli-v1.13.0...cli-v1.14.0) (2025-11-30)


### Features

* tar.gz streaming with content-addressable blob storage ([#311](https://github.com/vm0-ai/vm0/issues/311)) ([d271acb](https://github.com/vm0-ai/vm0/commit/d271acb1ce5b641dda20e64199f9c26b3e013bff))

## [1.13.0](https://github.com/vm0-ai/vm0/compare/cli-v1.12.0...cli-v1.13.0) (2025-11-29)


### Features

* support empty artifact and volume push ([#296](https://github.com/vm0-ai/vm0/issues/296)) ([d1449e9](https://github.com/vm0-ai/vm0/commit/d1449e9cc691d28cc9a69f622d9bf5fe5076ec3d))

## [1.12.0](https://github.com/vm0-ai/vm0/compare/cli-v1.11.0...cli-v1.12.0) (2025-11-28)


### Features

* use content-based sha-256 hash for storage version ids ([#289](https://github.com/vm0-ai/vm0/issues/289)) ([69eb252](https://github.com/vm0-ai/vm0/commit/69eb252d85883f4cb9943613142f6feafbe947b6))

## [1.11.0](https://github.com/vm0-ai/vm0/compare/cli-v1.10.0...cli-v1.11.0) (2025-11-28)


### Features

* enhance vm0 run output with complete execution context ([#283](https://github.com/vm0-ai/vm0/issues/283)) ([5f4eeb6](https://github.com/vm0-ai/vm0/commit/5f4eeb624522f109f4afb916b374cf005528d5cc))

## [1.10.0](https://github.com/vm0-ai/vm0/compare/cli-v1.9.0...cli-v1.10.0) (2025-11-28)


### Features

* unify agent run API with volume version override support ([#258](https://github.com/vm0-ai/vm0/issues/258)) ([7a5260e](https://github.com/vm0-ai/vm0/commit/7a5260e573dbd42ef084e30d739d7a7773ec65c5))

## [1.9.0](https://github.com/vm0-ai/vm0/compare/cli-v1.8.1...cli-v1.9.0) (2025-11-28)


### Features

* **cli:** increase default timeout from 60 to 120 seconds ([#267](https://github.com/vm0-ai/vm0/issues/267)) ([359fc7d](https://github.com/vm0-ai/vm0/commit/359fc7d47ce3b7729e7b11631a1953a1041c64f3))


### Bug Fixes

* **cli:** read version from package.json instead of hardcoded value ([#268](https://github.com/vm0-ai/vm0/issues/268)) ([ca36a01](https://github.com/vm0-ai/vm0/commit/ca36a0125ccd5d0f7d2aa8048d6f52ae3dbb17bc))

## [1.8.1](https://github.com/vm0-ai/vm0/compare/cli-v1.8.0...cli-v1.8.1) (2025-11-28)


### Bug Fixes

* **cli:** add repository field for npm provenance verification ([#264](https://github.com/vm0-ai/vm0/issues/264)) ([c6d058c](https://github.com/vm0-ai/vm0/commit/c6d058c50899e1d904f58b2f51dc5f8b92ee8369))
* use lowercase in error message to match accepted format ([#263](https://github.com/vm0-ai/vm0/issues/263)) ([e88e454](https://github.com/vm0-ai/vm0/commit/e88e454e0d9a6f036327919a3cd5ced78168af47))

## [1.8.0](https://github.com/vm0-ai/vm0/compare/cli-v1.7.0...cli-v1.8.0) (2025-11-27)


### Features

* introduce Agent Session concept and refactor vm0 run CLI ([#243](https://github.com/vm0-ai/vm0/issues/243)) ([2211c97](https://github.com/vm0-ai/vm0/commit/2211c972d5ee295a9f84780dd938c27ebec40ff7))

## [1.7.0](https://github.com/vm0-ai/vm0/compare/cli-v1.6.0...cli-v1.7.0) (2025-11-27)


### Features

* **cli:** add version selection support for volume and artifact pull ([#223](https://github.com/vm0-ai/vm0/issues/223)) ([7981119](https://github.com/vm0-ai/vm0/commit/7981119217f138b912773808a98e85725c7f4752))
* **config:** restructure agent.yaml format and artifact handling ([#224](https://github.com/vm0-ai/vm0/issues/224)) ([b60d92e](https://github.com/vm0-ai/vm0/commit/b60d92ef1e97aef54fc9a39b6c13e09aa593b928))
* remove git driver and rename vm0 to VAS ([#230](https://github.com/vm0-ai/vm0/issues/230)) ([0c5bdad](https://github.com/vm0-ai/vm0/commit/0c5bdadf09a0d281d42a90951e5e89bc5e47550b))


### Bug Fixes

* **cli:** remove local files not present in remote during pull ([#225](https://github.com/vm0-ai/vm0/issues/225)) ([90ddd24](https://github.com/vm0-ai/vm0/commit/90ddd2402346385c185dfc3ef93903802c9c9408))

## [1.6.0](https://github.com/vm0-ai/vm0/compare/cli-v1.5.0...cli-v1.6.0) (2025-11-26)


### Features

* **cli:** add --timeout flag to vm0 run command ([#216](https://github.com/vm0-ai/vm0/issues/216)) ([0b37418](https://github.com/vm0-ai/vm0/commit/0b37418e94c9403238d5489bed5a6fbcebcafed7))


### Bug Fixes

* fail fast when vm0 artifact configured but no artifact key provided ([#214](https://github.com/vm0-ai/vm0/issues/214)) ([bebcedc](https://github.com/vm0-ai/vm0/commit/bebcedcf21111611607c9b8dc352a539dc2ed473))

## [1.5.0](https://github.com/vm0-ai/vm0/compare/cli-v1.4.0...cli-v1.5.0) (2025-11-26)


### Features

* replace dynamic_volumes with artifact concept ([#210](https://github.com/vm0-ai/vm0/issues/210)) ([5cc831c](https://github.com/vm0-ai/vm0/commit/5cc831c81041ae8f80c425d68b9491354eaafa2b))

## [1.4.0](https://github.com/vm0-ai/vm0/compare/cli-v1.3.1...cli-v1.4.0) (2025-11-25)


### Features

* add version management to vm0 volumes ([#182](https://github.com/vm0-ai/vm0/issues/182)) ([96677de](https://github.com/vm0-ai/vm0/commit/96677de998ca22f7e441c4b38d44c1dd47bac64c))

## [1.3.1](https://github.com/vm0-ai/vm0/compare/cli-v1.3.0...cli-v1.3.1) (2025-11-24)


### Bug Fixes

* improve checkpoint resume debugging for git volumes ([#176](https://github.com/vm0-ai/vm0/issues/176)) ([#178](https://github.com/vm0-ai/vm0/issues/178)) ([228bab2](https://github.com/vm0-ai/vm0/commit/228bab2bb0fea624ee31ee99267d3179154ba2d0))

## [1.3.0](https://github.com/vm0-ai/vm0/compare/cli-v1.2.0...cli-v1.3.0) (2025-11-24)


### Features

* implement vm0 managed volumes (simple MVP - full upload/download) ([#172](https://github.com/vm0-ai/vm0/issues/172)) ([ce2f717](https://github.com/vm0-ai/vm0/commit/ce2f717ae1c05c806a9a2f5cd1febd57ad7be1ce))


### Bug Fixes

* remove all eslint suppression comments and use vi.stubEnv for tests ([#171](https://github.com/vm0-ai/vm0/issues/171)) ([e210c7c](https://github.com/vm0-ai/vm0/commit/e210c7c0df82e045b3e9103b0bd6dabc28567c12))

## [1.2.0](https://github.com/vm0-ai/vm0/compare/cli-v1.1.0...cli-v1.2.0) (2025-11-23)


### Features

* add validation for environment and template variables before execution ([#164](https://github.com/vm0-ai/vm0/issues/164)) ([a197eba](https://github.com/vm0-ai/vm0/commit/a197eba8ee189e37317e80fd720d1a8df64a863a))

## [1.1.0](https://github.com/vm0-ai/vm0/compare/cli-v1.0.0...cli-v1.1.0) (2025-11-22)


### Features

* enable runtime script transfer for dynamic agent execution ([#139](https://github.com/vm0-ai/vm0/issues/139)) ([77383f0](https://github.com/vm0-ai/vm0/commit/77383f077bc38fc64b7cb566275c6c2e23f21481))
* implement checkpoint resume functionality ([#156](https://github.com/vm0-ai/vm0/issues/156)) ([304f672](https://github.com/vm0-ai/vm0/commit/304f672dd800a5d9d2b18001438ff67260019efe))
* implement VM0 system events for run lifecycle management ([#154](https://github.com/vm0-ai/vm0/issues/154)) ([8e2ff1d](https://github.com/vm0-ai/vm0/commit/8e2ff1d6f8370225b3e6085a56e3bb8eb680a755))

## [1.0.0](https://github.com/vm0-ai/vm0/compare/cli-v0.3.0...cli-v1.0.0) (2025-11-20)


### ⚠ BREAKING CHANGES

* CLI no longer recognizes API_HOST environment variable. Users must update to use VM0_API_URL instead.

### Features

* standardize api url environment variable to vm0_api_url ([#110](https://github.com/vm0-ai/vm0/issues/110)) ([f4b9fab](https://github.com/vm0-ai/vm0/commit/f4b9fabeeeb44cb27960335e38bcd7180f18ed84))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/cli-v0.2.0...cli-v0.3.0) (2025-11-20)


### Features

* add CLI e2e device flow automation and production API fallback ([#73](https://github.com/vm0-ai/vm0/issues/73)) ([8eb2d21](https://github.com/vm0-ai/vm0/commit/8eb2d21e6a2f363f93575f85bde5081a2ff218a7))
* add device flow authentication for cli ([#39](https://github.com/vm0-ai/vm0/issues/39)) ([b6ae61c](https://github.com/vm0-ai/vm0/commit/b6ae61c4244b318e9a6d3969d1ab57bd3d47c873))
* add support for agent names in vm0 run command ([#71](https://github.com/vm0-ai/vm0/issues/71)) ([4842d80](https://github.com/vm0-ai/vm0/commit/4842d80f0ce24aec3683ff0e364fc9e22eb24177))
* implement CLI build and run commands ([#65](https://github.com/vm0-ai/vm0/issues/65)) ([c0b8d11](https://github.com/vm0-ai/vm0/commit/c0b8d114a8c6910bfce7c2e4e10a82509889a28f))
* implement event streaming for vm0 run command ([#92](https://github.com/vm0-ai/vm0/issues/92)) ([a551950](https://github.com/vm0-ai/vm0/commit/a5519501aa6e7b3b739e05a965d58868498dbdca))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/cli-v0.1.0...cli-v0.2.0) (2025-11-17)


### Features

* add cli ci/cd pipeline with npm oidc publishing ([#29](https://github.com/vm0-ai/vm0/issues/29)) ([a46585a](https://github.com/vm0-ai/vm0/commit/a46585a73c26ece8a0cac4b50fdb7816b047382c))
* initial project setup from makita template ([e9c330a](https://github.com/vm0-ai/vm0/commit/e9c330a5952526d657f245e8db9522de553018b3))


### Bug Fixes

* replace remaining makita references in eslint configs and e2e tests ([70489e4](https://github.com/vm0-ai/vm0/commit/70489e495b9f9e12000722eeaf416355f699823c))

## [0.1.0](https://github.com/vm0-ai/vm0/compare/vm0-cli-v0.0.1...vm0-cli-v0.1.0) (2025-11-15)


### Features

* initial project setup from makita template ([e9c330a](https://github.com/vm0-ai/vm0/commit/e9c330a5952526d657f245e8db9522de553018b3))


### Bug Fixes

* replace remaining makita references in eslint configs and e2e tests ([70489e4](https://github.com/vm0-ai/vm0/commit/70489e495b9f9e12000722eeaf416355f699823c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.1.0

## [0.1.0](https://github.com/e7h4n/vm0/compare/vm0-cli-v0.0.1...vm0-cli-v0.1.0) (2025-08-30)


### Features

* initial commit - app template with turborepo monorepo structure ([4123914](https://github.com/e7h4n/vm0/commit/41239143cdaea284f55a02c89fde348c2e3b53ff))


### Bug Fixes

* cli e2e ([78276d7](https://github.com/e7h4n/vm0/commit/78276d78308b5a8aec85cb9ce4d137299ff0587d))
* cli package ([4ab79ab](https://github.com/e7h4n/vm0/commit/4ab79ab22e35966956080f2652f29692392bb041))
* update remaining @vm0/cli references to vm0-cli ([bd8a106](https://github.com/e7h4n/vm0/commit/bd8a106f36b95d8dcf1369e8831071f63f3ec80c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @vm0/core bumped to 0.1.0

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
