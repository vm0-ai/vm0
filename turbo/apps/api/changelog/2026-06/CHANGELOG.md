# Changelog - 2026-06

[Current changelog](../../CHANGELOG.md)

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
