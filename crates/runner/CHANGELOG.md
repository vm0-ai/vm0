# Changelog

## [0.79.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.4...runner-rs-v0.79.5) (2026-04-14)

## [0.79.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.3...runner-rs-v0.79.4) (2026-04-14)


### Bug Fixes

* kill child process on error paths to prevent orphans ([#9267](https://github.com/vm0-ai/vm0/issues/9267)) ([16b1686](https://github.com/vm0-ai/vm0/commit/16b1686449c1913184dba9c93195baff74d107b8))
* **runner:** invalidate image cache and skip remote cache on deploy ([#9300](https://github.com/vm0-ai/vm0/issues/9300)) ([67ce548](https://github.com/vm0-ai/vm0/commit/67ce548f3f7a5feff97ba7f882562f5bfef200c6))


### Refactoring

* **runner:** deduplicate guest state restore in executor ([#9289](https://github.com/vm0-ai/vm0/issues/9289)) ([fea8ef2](https://github.com/vm0-ai/vm0/commit/fea8ef2055cec702bd72bf488f711c4bafc20754))

## [0.79.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.2...runner-rs-v0.79.3) (2026-04-14)

## [0.79.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.1...runner-rs-v0.79.2) (2026-04-14)


### Bug Fixes

* **runner:** add --protect-version flag to prevent gc from deleting deployed version ([#9260](https://github.com/vm0-ai/vm0/issues/9260)) ([40de60a](https://github.com/vm0-ai/vm0/commit/40de60afd78b0806d08650f80a5b2269b86df661))

## [0.79.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.79.0...runner-rs-v0.79.1) (2026-04-14)


### Bug Fixes

* **runner:** retry dnsmasq startup on port conflict ([#9257](https://github.com/vm0-ai/vm0/issues/9257)) ([3db33df](https://github.com/vm0-ai/vm0/commit/3db33df21828764734f5f0b2b30dbc6ee5303745)), closes [#9250](https://github.com/vm0-ai/vm0/issues/9250)

## [0.79.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.3...runner-rs-v0.79.0) (2026-04-14)


### Features

* **runner:** per-job mitmproxy proxy log files ([#9239](https://github.com/vm0-ai/vm0/issues/9239)) ([1ea7fa4](https://github.com/vm0-ai/vm0/commit/1ea7fa4d2efc1418dc3ac3e6364793f35b8d0ff6)), closes [#9227](https://github.com/vm0-ai/vm0/issues/9227)


### Bug Fixes

* **runner:** harden mitmproxy usage report flush during shutdown ([#9234](https://github.com/vm0-ai/vm0/issues/9234)) ([08e65c7](https://github.com/vm0-ai/vm0/commit/08e65c76b45358b387a48078320ceb5f19c19e32)), closes [#9228](https://github.com/vm0-ai/vm0/issues/9228)

## [0.78.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.2...runner-rs-v0.78.3) (2026-04-14)


### Bug Fixes

* **runner:** switch log timestamps from elapsed-since-startup to wall-clock utc ([#9232](https://github.com/vm0-ai/vm0/issues/9232)) ([216f251](https://github.com/vm0-ai/vm0/commit/216f251989445c06e0b0b9e3335370bd2622cbd5))
* **runner:** use proper url parsing for .test tld check in doctor ([#9237](https://github.com/vm0-ai/vm0/issues/9237)) ([6f5dd87](https://github.com/vm0-ai/vm0/commit/6f5dd8707f850a4d1b0766ce3bd9b0ab83b0ca78))

## [0.78.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.1...runner-rs-v0.78.2) (2026-04-13)


### Refactoring

* **runner:** surface r2 gc pagination invariant violations as errors ([#9200](https://github.com/vm0-ai/vm0/issues/9200)) ([186405a](https://github.com/vm0-ai/vm0/commit/186405af8df8ceeba22cee0295e7cc6657d7d652))

## [0.78.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.78.0...runner-rs-v0.78.1) (2026-04-13)


### Bug Fixes

* **runner:** validate image_hash to prevent path traversal ([#9178](https://github.com/vm0-ai/vm0/issues/9178)) ([2e4d3e2](https://github.com/vm0-ai/vm0/commit/2e4d3e2adce1076161346f244ad00b8f8d308353))

## [0.78.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.77.1...runner-rs-v0.78.0) (2026-04-13)


### Features

* **runner:** inflate sandbox balloon when parked in idle pool ([#9118](https://github.com/vm0-ai/vm0/issues/9118)) ([628032d](https://github.com/vm0-ai/vm0/commit/628032dbf3543d3387b6559263c31ee273f24986))


### Bug Fixes

* **runner:** validate --runner-dirname to prevent path traversal ([#9134](https://github.com/vm0-ai/vm0/issues/9134)) ([b511508](https://github.com/vm0-ai/vm0/commit/b51150884503ecc81e3180737ea11ca12b46f127))


### Performance Improvements

* **runner:** cache built images on r2 ([#9120](https://github.com/vm0-ai/vm0/issues/9120)) ([bf2f2cd](https://github.com/vm0-ai/vm0/commit/bf2f2cdeb2956cee5fc5f7466e147d1c4351d3d0))

## [0.77.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.77.0...runner-rs-v0.77.1) (2026-04-13)


### Bug Fixes

* **runner:** validate --group name to prevent path traversal ([#9104](https://github.com/vm0-ai/vm0/issues/9104)) ([b7e75dc](https://github.com/vm0-ai/vm0/commit/b7e75dc2f74419c441c6e62eda3db1bd3cf93f87)), closes [#9099](https://github.com/vm0-ai/vm0/issues/9099)

## [0.77.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.4...runner-rs-v0.77.0) (2026-04-13)


### Features

* **runner:** require --force for service stop/uninstall with active jobs ([#9093](https://github.com/vm0-ai/vm0/issues/9093)) ([399164e](https://github.com/vm0-ai/vm0/commit/399164e015d366fec791f1df7542387bb4c7c703))

## [0.76.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.3...runner-rs-v0.76.4) (2026-04-13)


### Bug Fixes

* **runner:** shell-quote exec arguments before joining ([#9052](https://github.com/vm0-ai/vm0/issues/9052)) ([44e0d4d](https://github.com/vm0-ai/vm0/commit/44e0d4d0c29146259acce856c3d6642a90441f6c))


### Refactoring

* use proxy-reported usage as billing source of truth ([#9064](https://github.com/vm0-ai/vm0/issues/9064)) ([b655964](https://github.com/vm0-ai/vm0/commit/b65596423f8655117ebd67c38731eb5f35c332b7))

## [0.76.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.2...runner-rs-v0.76.3) (2026-04-13)

## [0.76.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.1...runner-rs-v0.76.2) (2026-04-12)


### Bug Fixes

* log directory iteration errors in gc instead of silently swallowing ([#9036](https://github.com/vm0-ai/vm0/issues/9036)) ([da6af3c](https://github.com/vm0-ai/vm0/commit/da6af3c67e7beaf4e9fdef5d28958f09cba62e56))

## [0.76.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.76.0...runner-rs-v0.76.1) (2026-04-12)


### Bug Fixes

* **runner:** abort stdout drain task on wait_exit timeout or crash ([#9021](https://github.com/vm0-ai/vm0/issues/9021)) ([d6b021e](https://github.com/vm0-ai/vm0/commit/d6b021e5f97b432006e969efd45f3b29debb4909)), closes [#8970](https://github.com/vm0-ai/vm0/issues/8970)

## [0.76.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.75.2...runner-rs-v0.76.0) (2026-04-12)


### Features

* add feature flag to control sandbox reuse logic ([#8987](https://github.com/vm0-ai/vm0/issues/8987)) ([e77a8a0](https://github.com/vm0-ai/vm0/commit/e77a8a0c2974d91786f11d7119d87ba8fe07a6dd))


### Bug Fixes

* **runner:** add cached field to storage manifest for correct cleanup preservation ([#8993](https://github.com/vm0-ai/vm0/issues/8993)) ([d9db456](https://github.com/vm0-ai/vm0/commit/d9db4569ef6f86fdf46063d65a9aad34ca7a6b2a)), closes [#8982](https://github.com/vm0-ai/vm0/issues/8982)
* **runner:** add upper-bound validation for profile resource limits ([#9015](https://github.com/vm0-ai/vm0/issues/9015)) ([d774aca](https://github.com/vm0-ai/vm0/commit/d774aca8bb1fa71635fdb15692378e634edc2d10)), closes [#9009](https://github.com/vm0-ai/vm0/issues/9009)

## [0.75.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.75.1...runner-rs-v0.75.2) (2026-04-11)


### Bug Fixes

* **runner:** add drop impl to kmsg handle to prevent task leak on early return ([#8958](https://github.com/vm0-ai/vm0/issues/8958)) ([64c26e6](https://github.com/vm0-ai/vm0/commit/64c26e6adf0785f74ff9217bfde1267a721d3b83))

## [0.75.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.75.0...runner-rs-v0.75.1) (2026-04-11)


### Bug Fixes

* align mitmproxy permission matching with frontend contract ([#8943](https://github.com/vm0-ai/vm0/issues/8943)) ([e4273a0](https://github.com/vm0-ai/vm0/commit/e4273a0fa8b7a06ffd1ef208ed15bd164e15bf31))

## [0.75.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.74.2...runner-rs-v0.75.0) (2026-04-10)


### Features

* **credit:** record anthropic message id in proxy_credit_usage ([#8919](https://github.com/vm0-ai/vm0/issues/8919)) ([7bfe376](https://github.com/vm0-ai/vm0/commit/7bfe376274a4702cb116c90c9fa816307fee6f02)), closes [#8909](https://github.com/vm0-ai/vm0/issues/8909)


### Refactoring

* **mitm-addon:** extract shared api request builder for platform calls ([#8913](https://github.com/vm0-ai/vm0/issues/8913)) ([dd9a683](https://github.com/vm0-ai/vm0/commit/dd9a68382a4f012ab532838e4bdce931fab13cb8)), closes [#8885](https://github.com/vm0-ai/vm0/issues/8885)
* **runner:** unify rootfs and snapshot into single image artifact ([#8821](https://github.com/vm0-ai/vm0/issues/8821)) ([a549299](https://github.com/vm0-ai/vm0/commit/a549299c1c10179b49783288e869f82739b58033))

## [0.74.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.74.1...runner-rs-v0.74.2) (2026-04-10)


### Bug Fixes

* **mitm-addon:** decompress sse stream before usage extraction ([#8903](https://github.com/vm0-ai/vm0/issues/8903)) ([28fd00c](https://github.com/vm0-ai/vm0/commit/28fd00ce66339d0b50854628dd4b5049a5b02ce5))
* **mitm-addon:** replace --quiet with flow_detail=0 + termlog_verbosity=warn ([#8896](https://github.com/vm0-ai/vm0/issues/8896)) ([7d95d9c](https://github.com/vm0-ai/vm0/commit/7d95d9cb6672d579b7b76710b899c0a79a53607a)), closes [#8882](https://github.com/vm0-ai/vm0/issues/8882)
* **runner:** drop discover future before shutdown to prevent mutex deadlock ([#8898](https://github.com/vm0-ai/vm0/issues/8898)) ([54460c1](https://github.com/vm0-ai/vm0/commit/54460c11249d009b06e50ced82ce45b5086932c5))

## [0.74.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.74.0...runner-rs-v0.74.1) (2026-04-10)


### Refactoring

* **firewalls:** cache graphql field coverage check per api entry ([#8839](https://github.com/vm0-ai/vm0/issues/8839)) ([f716aef](https://github.com/vm0-ai/vm0/commit/f716aefcfd219856adf314b1fa836771760624f5)), closes [#8816](https://github.com/vm0-ai/vm0/issues/8816)

## [0.74.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.73.0...runner-rs-v0.74.0) (2026-04-10)


### Features

* **firewalls:** include denied permission names in firewall block response ([#8815](https://github.com/vm0-ai/vm0/issues/8815)) ([b276ebf](https://github.com/vm0-ai/vm0/commit/b276ebfc0b06bf816d6b3ba250e400ba574182b0))

## [0.73.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.72.1...runner-rs-v0.73.0) (2026-04-10)


### Features

* **runner:** clean stale files on vm reuse before downloading storages ([#8800](https://github.com/vm0-ai/vm0/issues/8800)) ([4725751](https://github.com/vm0-ai/vm0/commit/4725751f5ff9b6f4b7b1c1294b6efbc48bc005b1)), closes [#8757](https://github.com/vm0-ai/vm0/issues/8757)
* **runner:** pass feature switch states through execution context ([#8778](https://github.com/vm0-ai/vm0/issues/8778)) ([edbe85c](https://github.com/vm0-ai/vm0/commit/edbe85ca3f0fb81821aeeb609a0a700fcbd137e8))


### Bug Fixes

* **runner:** pin discover future to prevent heartbeat cancellation ([#8747](https://github.com/vm0-ai/vm0/issues/8747)) ([#8783](https://github.com/vm0-ai/vm0/issues/8783)) ([31603cd](https://github.com/vm0-ai/vm0/commit/31603cd3db27475a94d2cdd2f4272e8cc5ed403b))
* **runner:** prevent message_delta from overwriting proxy usage with zeros ([#8805](https://github.com/vm0-ai/vm0/issues/8805)) ([3e143a4](https://github.com/vm0-ai/vm0/commit/3e143a476b31ae972fb3079316a3c28855ac79e5)), closes [#8796](https://github.com/vm0-ai/vm0/issues/8796)
* **runner:** prevent proxy billing data loss from error flows and shutdown ([#8772](https://github.com/vm0-ai/vm0/issues/8772)) ([4fd963d](https://github.com/vm0-ai/vm0/commit/4fd963d88add04850674522f635e2540dbad3953))

## [0.72.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.72.0...runner-rs-v0.72.1) (2026-04-10)

## [0.72.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.71.0...runner-rs-v0.72.0) (2026-04-09)


### Features

* **firewalls:** add deny and ask lists to granted permissions schema ([#8719](https://github.com/vm0-ai/vm0/issues/8719)) ([5a02f38](https://github.com/vm0-ai/vm0/commit/5a02f389160a6cbf961656798fe353ca029c2ece))
* **runner:** read guest session id for first-run vm parking ([#8731](https://github.com/vm0-ai/vm0/issues/8731)) ([9bdcda9](https://github.com/vm0-ai/vm0/commit/9bdcda9c5e2bb5af853696c19661862ab0f000b6))


### Refactoring

* **firewalls:** change allow-unknown from boolean to policy value ([#8733](https://github.com/vm0-ai/vm0/issues/8733)) ([4e2bea3](https://github.com/vm0-ai/vm0/commit/4e2bea3758707b157bf28162ee815da2129c5f32))
* **firewalls:** rename granted-permissions to network-policies ([#8740](https://github.com/vm0-ai/vm0/issues/8740)) ([2ad2c5c](https://github.com/vm0-ai/vm0/commit/2ad2c5ce175d98304adcb5a43770df3d9d5ee9d2)), closes [#8738](https://github.com/vm0-ai/vm0/issues/8738)


### Performance Improvements

* **runner:** skip storage re-download when artifact version unchanged ([#8743](https://github.com/vm0-ai/vm0/issues/8743)) ([8b8175c](https://github.com/vm0-ai/vm0/commit/8b8175c72da3b5e71911fe072aa5c70bba0e0e46))

## [0.71.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.70.2...runner-rs-v0.71.0) (2026-04-09)


### Features

* **firewalls:** add granted permissions for three-level matching ([#8621](https://github.com/vm0-ai/vm0/issues/8621)) ([534ec85](https://github.com/vm0-ai/vm0/commit/534ec85c209f52c7388bd9819b72017bb8be6cd9))

## [0.70.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.70.1...runner-rs-v0.70.2) (2026-04-09)

## [0.70.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.70.0...runner-rs-v0.70.1) (2026-04-09)


### Bug Fixes

* **firewalls:** skip __typename in graphql field coverage check ([#8642](https://github.com/vm0-ai/vm0/issues/8642)) ([306f85b](https://github.com/vm0-ai/vm0/commit/306f85b60edec8b2dec1823c67f85b4554956369))
* **runner:** clean up residual transient systemd units before service start ([#8645](https://github.com/vm0-ai/vm0/issues/8645)) ([a14b1db](https://github.com/vm0-ai/vm0/commit/a14b1db39b56657b0108475f6da95827345f0152)), closes [#8640](https://github.com/vm0-ai/vm0/issues/8640)

## [0.70.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.69.0...runner-rs-v0.70.0) (2026-04-09)


### Features

* **billing:** add proxy-side usage extraction for billing verification ([#8581](https://github.com/vm0-ai/vm0/issues/8581)) ([87f5049](https://github.com/vm0-ai/vm0/commit/87f5049ab3eb8e4aaa26537f412b628d0f687bc6))
* **firewalls:** support comma-separated field values in graphql rules ([#8549](https://github.com/vm0-ai/vm0/issues/8549)) ([e9cda88](https://github.com/vm0-ai/vm0/commit/e9cda88fbb87f4df7a47922e2e63b2c55f7e2de2))


### Bug Fixes

* **firewalls:** require all graphql fields to be covered by permissions ([#8599](https://github.com/vm0-ai/vm0/issues/8599)) ([7f8c21b](https://github.com/vm0-ai/vm0/commit/7f8c21b4a0d77a19e05fe18175f9b77fd4949ce6))
* **runner:** send immediate heartbeat after vm park and exclude idle vms from running count ([#8626](https://github.com/vm0-ai/vm0/issues/8626)) ([71d340d](https://github.com/vm0-ai/vm0/commit/71d340d540f546ef008671830aca970eaf00158d))

## [0.69.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.68.0...runner-rs-v0.69.0) (2026-04-08)


### Features

* **firewall:** add graphql field path parser with nested selection support ([#8520](https://github.com/vm0-ai/vm0/issues/8520)) ([7665bee](https://github.com/vm0-ai/vm0/commit/7665bee9864a351c1298e42066a2fe7019c0bcec))


### Refactoring

* **proxy:** replace blind streaming with buffered stream callback ([#8514](https://github.com/vm0-ai/vm0/issues/8514)) ([552cd0c](https://github.com/vm0-ai/vm0/commit/552cd0ceb3de240f97c0ffa5013e7da32b80857b))

## [0.68.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.67.1...runner-rs-v0.68.0) (2026-04-08)


### Features

* **firewalls:** add graphql field modifier for rule matching ([#8476](https://github.com/vm0-ai/vm0/issues/8476)) ([82b2049](https://github.com/vm0-ai/vm0/commit/82b20493e48325cbc75ecc431a74e8254096e46a))
* **platform:** capture response headers and mark binary bodies in network logs ([#8481](https://github.com/vm0-ai/vm0/issues/8481)) ([6a778f8](https://github.com/vm0-ai/vm0/commit/6a778f8ebbd88e2bd95a4d79a5e4ed1e4c3f4f26))
* **runner:** add smart dispatch with session affinity and targeted ably push ([#8474](https://github.com/vm0-ai/vm0/issues/8474)) ([65dbe3a](https://github.com/vm0-ai/vm0/commit/65dbe3af2795aa2730a3df28e84e3572fc8a46cc)), closes [#8368](https://github.com/vm0-ai/vm0/issues/8368)


### Bug Fixes

* **proxy:** remove firewall terminology from error responses ([#8486](https://github.com/vm0-ai/vm0/issues/8486)) ([a8292d5](https://github.com/vm0-ai/vm0/commit/a8292d585528abecfb03d7bfa15ca33e31b319cb)), closes [#8483](https://github.com/vm0-ai/vm0/issues/8483)
* **slack:** skip channel context fetch for dm conversations ([#8475](https://github.com/vm0-ai/vm0/issues/8475)) ([07a3321](https://github.com/vm0-ai/vm0/commit/07a33216d0a47047b341a0784324cb71b596a7f4))

## [0.67.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.67.0...runner-rs-v0.67.1) (2026-04-08)

## [0.67.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.66.0...runner-rs-v0.67.0) (2026-04-07)


### Features

* **runner:** add runner state reporting via heartbeat ([#8367](https://github.com/vm0-ai/vm0/issues/8367)) ([#8380](https://github.com/vm0-ai/vm0/issues/8380)) ([2dea967](https://github.com/vm0-ai/vm0/commit/2dea96701d28d963e74816908517519d1b55c939))

## [0.66.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.65.1...runner-rs-v0.66.0) (2026-04-07)


### Features

* **proxy:** add opt-in http body capture to mitmproxy addon ([#8349](https://github.com/vm0-ai/vm0/issues/8349)) ([95709fb](https://github.com/vm0-ai/vm0/commit/95709fb721befedd489025c39124b3663226d3f9))

## [0.65.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.65.0...runner-rs-v0.65.1) (2026-04-07)


### Bug Fixes

* **runner:** clean up stale guest log files on keep-alive vm reuse ([#8308](https://github.com/vm0-ai/vm0/issues/8308)) ([#8333](https://github.com/vm0-ai/vm0/issues/8333)) ([775f09b](https://github.com/vm0-ai/vm0/commit/775f09b0577fe17d1cbc39e58ba93d45277be60a))

## [0.65.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.64.0...runner-rs-v0.65.0) (2026-04-07)


### Features

* **runner:** keep-alive sandbox across conversation turns ([#8314](https://github.com/vm0-ai/vm0/issues/8314)) ([867a830](https://github.com/vm0-ai/vm0/commit/867a83056cd893988780aed3d8d6d49836e12e29))

## [0.64.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.63.1...runner-rs-v0.64.0) (2026-04-07)


### Features

* **gc:** add orphaned workspace cleanup to runner gc ([#8272](https://github.com/vm0-ai/vm0/issues/8272)) ([5614af3](https://github.com/vm0-ai/vm0/commit/5614af3febcd7a49a0f84aa8023c9a56046346bd))

## [0.63.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.63.0...runner-rs-v0.63.1) (2026-04-06)


### Refactoring

* **nbd:** deduplicate nbds_max, add concurrent test and bitmap assertion ([#8228](https://github.com/vm0-ai/vm0/issues/8228)) ([c0b98df](https://github.com/vm0-ai/vm0/commit/c0b98df3eb69ec81b26373d23d093a9526839752))

## [0.63.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.62.2...runner-rs-v0.63.0) (2026-04-06)


### Features

* **crates:** add guest-reseed for post-snapshot entropy injection ([#8215](https://github.com/vm0-ai/vm0/issues/8215)) ([c9a9005](https://github.com/vm0-ai/vm0/commit/c9a9005a05398f787d7e9dbe2f591b51b44bbab9))

## [0.62.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.62.1...runner-rs-v0.62.2) (2026-04-06)


### Bug Fixes

* **runner:** flush tokio file in drain_stdout_to_file to prevent data loss ([#8216](https://github.com/vm0-ai/vm0/issues/8216)) ([b19f692](https://github.com/vm0-ai/vm0/commit/b19f692c39046a3c0614e0c1c23de82b5af9a8b7))

## [0.62.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.62.0...runner-rs-v0.62.1) (2026-04-04)


### Bug Fixes

* add dnsmasq to system dependency check and doctor diagnostics ([#8065](https://github.com/vm0-ai/vm0/issues/8065)) ([6a7a0f8](https://github.com/vm0-ai/vm0/commit/6a7a0f8fa8939671d7b4d678df4aea49dd7fcbbe))


### Performance Improvements

* **runner:** replace docker build with debootstrap for rootfs creation ([#8042](https://github.com/vm0-ai/vm0/issues/8042)) ([41e932a](https://github.com/vm0-ai/vm0/commit/41e932aacb06a8a10234b1eb5219f90e84135917))

## [0.62.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.4...runner-rs-v0.62.0) (2026-04-03)


### Features

* add dns proxy for sandbox vms using dnsmasq ([#8020](https://github.com/vm0-ai/vm0/issues/8020)) ([5699f8d](https://github.com/vm0-ai/vm0/commit/5699f8dbb9008422dfe1753a2b127a6f9c100f59))


### Bug Fixes

* inject /etc/hosts and fix postgresql socket dir in sandbox rootfs ([#8012](https://github.com/vm0-ai/vm0/issues/8012)) ([6ba0f2f](https://github.com/vm0-ai/vm0/commit/6ba0f2fff333c57c85c90d1a7dad57dcc65f338b))

## [0.61.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.3...runner-rs-v0.61.4) (2026-04-03)


### Bug Fixes

* ensure python, java, and rust trust proxy ca in sandbox rootfs ([#7890](https://github.com/vm0-ai/vm0/issues/7890)) ([c697dca](https://github.com/vm0-ai/vm0/commit/c697dca25e38610ff83629c326170b110bfa678f))

## [0.61.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.2...runner-rs-v0.61.3) (2026-04-03)


### Performance Improvements

* **runner:** consolidate dockerfile apt-get update calls ([#7858](https://github.com/vm0-ai/vm0/issues/7858)) ([ab41e8e](https://github.com/vm0-ai/vm0/commit/ab41e8ecf8c21b45f701ffbe8260ec6fcf2af5cc))

## [0.61.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.1...runner-rs-v0.61.2) (2026-04-03)


### Refactoring

* centralize /etc/environment in build-rootfs.sh ([#7825](https://github.com/vm0-ai/vm0/issues/7825)) ([fbe263b](https://github.com/vm0-ai/vm0/commit/fbe263bcdbb5eac69be6583711589be82830af32))

## [0.61.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.61.0...runner-rs-v0.61.1) (2026-04-03)


### Bug Fixes

* **runner:** warn instead of failing when gc cannot remove snapshot ([#7808](https://github.com/vm0-ai/vm0/issues/7808)) ([c349213](https://github.com/vm0-ai/vm0/commit/c349213828a6ebe80a116e5a75b265dca4168f18))

## [0.61.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.60.0...runner-rs-v0.61.0) (2026-04-03)


### Features

* upgrade sandbox rootfs to ubuntu 24.04 with expanded runtime support ([#7741](https://github.com/vm0-ai/vm0/issues/7741)) ([8f8eba2](https://github.com/vm0-ai/vm0/commit/8f8eba24ef811741525b4040f6955e23d0fa99b3))


### Bug Fixes

* **runner:** also write tz to /etc/environment for system-wide inheritance ([#7762](https://github.com/vm0-ai/vm0/issues/7762)) ([70fb861](https://github.com/vm0-ai/vm0/commit/70fb861daef84cd7085ccd7259d3386cf15371b4)), closes [#7744](https://github.com/vm0-ai/vm0/issues/7744)

## [0.60.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.59.1...runner-rs-v0.60.0) (2026-04-02)


### Features

* **runner:** log rootfs logical and disk size after build ([#7784](https://github.com/vm0-ai/vm0/issues/7784)) ([225cca9](https://github.com/vm0-ai/vm0/commit/225cca9aba32163c13e866ca8bc4c77d53b25506))
* support graphql operation-level firewall rules ([#7719](https://github.com/vm0-ai/vm0/issues/7719)) ([ff23d7f](https://github.com/vm0-ai/vm0/commit/ff23d7f8717ee7fcb39546a1c8e20d8a091f9df4))

## [0.59.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.59.0...runner-rs-v0.59.1) (2026-04-02)

## [0.59.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.58.0...runner-rs-v0.59.0) (2026-04-02)


### Features

* **runner:** sync system timezone files in guest before agent start ([#7716](https://github.com/vm0-ai/vm0/issues/7716)) ([64e2484](https://github.com/vm0-ai/vm0/commit/64e2484503a0061955335dbe3a77b4caa3e98638))

## [0.58.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.57.0...runner-rs-v0.58.0) (2026-04-02)


### Features

* **runner:** increase default vm resources and add configurable disk size ([#7691](https://github.com/vm0-ai/vm0/issues/7691)) ([b928eb1](https://github.com/vm0-ai/vm0/commit/b928eb1a51e7759ba87c52577f323e0004bd4c8f))


### Refactoring

* split mitm_addon.py into focused modules with build.rs auto-scan ([#7688](https://github.com/vm0-ai/vm0/issues/7688)) ([aed758d](https://github.com/vm0-ai/vm0/commit/aed758dc817024a874531fbc2d99b2a58ffdded2)), closes [#7671](https://github.com/vm0-ai/vm0/issues/7671)

## [0.57.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.3...runner-rs-v0.57.0) (2026-04-02)


### Features

* add auth.base url rewriting for webhook-url firewall connectors ([#7618](https://github.com/vm0-ai/vm0/issues/7618)) ([55585ac](https://github.com/vm0-ai/vm0/commit/55585ac37db6938508ca957f83725389157c55da))

## [0.56.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.2...runner-rs-v0.56.3) (2026-04-02)

## [0.56.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.1...runner-rs-v0.56.2) (2026-04-01)


### Bug Fixes

* **nbd-cow:** guard disconnect against device index recycling by other runners ([#7581](https://github.com/vm0-ai/vm0/issues/7581)) ([ed9e572](https://github.com/vm0-ai/vm0/commit/ed9e572a80514236aada53eb68b2e9ad069ec7d2))

## [0.56.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.56.0...runner-rs-v0.56.1) (2026-04-01)


### Bug Fixes

* **nbd-cow:** advertise flush/trim flags and harden i/o paths ([#7539](https://github.com/vm0-ai/vm0/issues/7539)) ([6410e3e](https://github.com/vm0-ai/vm0/commit/6410e3ebc7652ba6f2da8edf14928346e70b7fb2))


### Refactoring

* rename experimental firewalls to firewalls ([#7553](https://github.com/vm0-ai/vm0/issues/7553)) ([e3c35a9](https://github.com/vm0-ai/vm0/commit/e3c35a95bd0dbfd1d68aef910db6089e38d6a0bb))

## [0.56.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.55.0...runner-rs-v0.56.0) (2026-04-01)


### Features

* **sandbox-fc:** replace dm-snapshot with nbd-cow ([#7406](https://github.com/vm0-ai/vm0/issues/7406)) ([bc60c4b](https://github.com/vm0-ai/vm0/commit/bc60c4b01eaac368f7434d367784855b0b50479b))

## [0.55.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.54.0...runner-rs-v0.55.0) (2026-04-01)


### Features

* **runner:** run runner as root, remove all sudo wrappers ([#7443](https://github.com/vm0-ai/vm0/issues/7443)) ([66e9af9](https://github.com/vm0-ai/vm0/commit/66e9af9846cfdc044ec4203b04e784bbc5ea305d))

## [0.54.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.53.0...runner-rs-v0.54.0) (2026-04-01)


### Features

* **firewalls:** support vars templates in firewall auth headers ([#7445](https://github.com/vm0-ai/vm0/issues/7445)) ([c06b9a0](https://github.com/vm0-ai/vm0/commit/c06b9a027bf1ae757b2f09393fee658d891bcf5f))

## [0.53.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.52.2...runner-rs-v0.53.0) (2026-03-31)


### Features

* **runner:** add xurl cli to rootfs ([#7397](https://github.com/vm0-ai/vm0/issues/7397)) ([1474ef3](https://github.com/vm0-ai/vm0/commit/1474ef34cb060a96d5af47e3aae7d626a4b5e319)), closes [#7124](https://github.com/vm0-ai/vm0/issues/7124)

## [0.52.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.52.1...runner-rs-v0.52.2) (2026-03-31)


### Bug Fixes

* **firewalls:** replace placeholder tokens with realistic fill pattern ([#7332](https://github.com/vm0-ai/vm0/issues/7332)) ([237916e](https://github.com/vm0-ai/vm0/commit/237916e4d424b924ed8ac603d20da4813b969b40))

## [0.52.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.52.0...runner-rs-v0.52.1) (2026-03-31)

## [0.52.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.51.1...runner-rs-v0.52.0) (2026-03-31)


### Features

* **firewalls:** support path and host parameter matching in base urls ([#7256](https://github.com/vm0-ai/vm0/issues/7256)) ([d9d3a15](https://github.com/vm0-ai/vm0/commit/d9d3a15fc91c5db88a18730b5d8d8aea67238c95))


### Bug Fixes

* **mitm:** add network logging to error() hook for connection failures ([#7300](https://github.com/vm0-ai/vm0/issues/7300)) ([6fec94a](https://github.com/vm0-ai/vm0/commit/6fec94a9f4fef7994477fdd53f87f82147d5be03))
* **mitm:** add per-key lock to coalesce concurrent firewall header fetches ([#7264](https://github.com/vm0-ai/vm0/issues/7264)) ([ab4787c](https://github.com/vm0-ai/vm0/commit/ab4787cb659b362592d4f8b5bd2f5aeb053d219b))

## [0.51.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.51.0...runner-rs-v0.51.1) (2026-03-30)

## [0.51.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.50.2...runner-rs-v0.51.0) (2026-03-30)


### Features

* **sandbox:** add sandbox-mock crate for testing ([#7177](https://github.com/vm0-ai/vm0/issues/7177)) ([d643020](https://github.com/vm0-ai/vm0/commit/d643020b2ac0059996ebeaef128b79945d9e072c))

## [0.50.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.50.1...runner-rs-v0.50.2) (2026-03-30)


### Refactoring

* **sandbox:** introduce runtime provider trait and consolidate sandbox-fc construction ([#7173](https://github.com/vm0-ai/vm0/issues/7173)) ([6cb7c3c](https://github.com/vm0-ai/vm0/commit/6cb7c3c8ed57b4d7eb949986046d68226dc0672a)), closes [#7119](https://github.com/vm0-ai/vm0/issues/7119)

## [0.50.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.50.0...runner-rs-v0.50.1) (2026-03-30)


### Refactoring

* **sandbox:** introduce sandbox control trait and decouple exec/kill from sandbox-fc ([#7150](https://github.com/vm0-ai/vm0/issues/7150)) ([4615d15](https://github.com/vm0-ai/vm0/commit/4615d1571c6dbc2ba249070654112d390e83a395)), closes [#7122](https://github.com/vm0-ai/vm0/issues/7122)
* **sandbox:** introduce sandbox runtime trait and internalize shared resources ([#7125](https://github.com/vm0-ai/vm0/issues/7125)) ([43a2ba0](https://github.com/vm0-ai/vm0/commit/43a2ba0d6ee9df1022e6238913597dd4d1c11e2a))
* **sandbox:** introduce snapshot provider trait and decouple snapshot operations ([#7142](https://github.com/vm0-ai/vm0/issues/7142)) ([9a864bf](https://github.com/vm0-ai/vm0/commit/9a864bfd4ec551ead8115f4fdb30df7c5570b5fe))

## [0.50.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.49.0...runner-rs-v0.50.0) (2026-03-29)


### Features

* **sandbox-fc:** add cow pool to pre-warm dm-snapshot resources ([#7116](https://github.com/vm0-ai/vm0/issues/7116)) ([c841e61](https://github.com/vm0-ai/vm0/commit/c841e61bfc653d143cd6a022f03ca638b2bf5a42))

## [0.49.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.48.2...runner-rs-v0.49.0) (2026-03-29)


### Features

* **guest-init:** use kernel root= boot arg instead of pivot_root ([#7106](https://github.com/vm0-ai/vm0/issues/7106)) ([b373849](https://github.com/vm0-ai/vm0/commit/b373849cb331296ae7665704edd400548d67c2a5))
* **runner:** detect orphan firecracker processes with --name filter ([#7113](https://github.com/vm0-ai/vm0/issues/7113)) ([8fcfc79](https://github.com/vm0-ai/vm0/commit/8fcfc79a812f273fd2ea2b2b9febffe3ab34b858))
* **runner:** detect orphaned dm-snapshot and loop devices in doctor ([#7107](https://github.com/vm0-ai/vm0/issues/7107)) ([c76a18f](https://github.com/vm0-ai/vm0/commit/c76a18f60a4538d410ac4976329c97f7b5d52448))
* **sandbox-fc:** replace guest-side overlayfs with host-side dm-snapshot cow ([#6521](https://github.com/vm0-ai/vm0/issues/6521)) ([8f6a118](https://github.com/vm0-ai/vm0/commit/8f6a1185bfd6dd4604687662f3d03be6076ea71f))


### Bug Fixes

* **crates:** update sha2/hmac usage for digest 0.11 compatibility ([#7101](https://github.com/vm0-ai/vm0/issues/7101)) ([cbded46](https://github.com/vm0-ai/vm0/commit/cbded46e78c8d3ed060e96f79f15cd38ee1cf9dc))

## [0.48.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.48.1...runner-rs-v0.48.2) (2026-03-26)

## [0.48.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.48.0...runner-rs-v0.48.1) (2026-03-26)


### Bug Fixes

* redact sandbox token in logs via secret values list ([#6838](https://github.com/vm0-ai/vm0/issues/6838)) ([56e0c1f](https://github.com/vm0-ai/vm0/commit/56e0c1f319c391dabac9088e7bccc3ff467ec33f))

## [0.48.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.47.0...runner-rs-v0.48.0) (2026-03-25)


### Features

* install @googleworkspace/cli in docker image ([#6751](https://github.com/vm0-ai/vm0/issues/6751)) ([32a45c3](https://github.com/vm0-ai/vm0/commit/32a45c3f2c56a587f001b55d545e02c2823c80ab))

## [0.47.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.46.0...runner-rs-v0.47.0) (2026-03-25)


### Features

* **runner:** add cache version seeds to rootfs and snapshot hash computation ([#6769](https://github.com/vm0-ai/vm0/issues/6769)) ([59b4ce5](https://github.com/vm0-ai/vm0/commit/59b4ce5fbf80f027e89374239e6e36ce4997a656))


### Bug Fixes

* **runner:** add rerun-if-changed for embedded files in build.rs ([#6758](https://github.com/vm0-ai/vm0/issues/6758)) ([814d66c](https://github.com/vm0-ai/vm0/commit/814d66cc1d9601ea1a92342fc9697ec7694e4569))

## [0.46.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.8...runner-rs-v0.46.0) (2026-03-25)


### Features

* **runner:** detect host-side cgroup oom kill of firecracker process ([#6630](https://github.com/vm0-ai/vm0/issues/6630)) ([34fa116](https://github.com/vm0-ai/vm0/commit/34fa11698b8e1c83f2cb93d82e281c099d114a49))

## [0.45.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.7...runner-rs-v0.45.8) (2026-03-25)


### Bug Fixes

* remove hardcoded memorymax=2g from runner systemd service ([#6632](https://github.com/vm0-ai/vm0/issues/6632)) ([c091eb7](https://github.com/vm0-ai/vm0/commit/c091eb7f6e71098a05dc5da0aadde69ebceace83)), closes [#6631](https://github.com/vm0-ai/vm0/issues/6631)

## [0.45.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.6...runner-rs-v0.45.7) (2026-03-25)


### Refactoring

* remove experimental_capabilities and make vm0_token injection unconditional ([#6573](https://github.com/vm0-ai/vm0/issues/6573)) ([#6579](https://github.com/vm0-ai/vm0/issues/6579)) ([1fb7df0](https://github.com/vm0-ai/vm0/commit/1fb7df0201d70223d486c91b536cad93a78c23a3))

## [0.45.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.5...runner-rs-v0.45.6) (2026-03-24)


### Refactoring

* unify agent identity fields across all zero api endpoints ([#6302](https://github.com/vm0-ai/vm0/issues/6302)) ([83a0e5d](https://github.com/vm0-ai/vm0/commit/83a0e5d5b5981b709b1dd8e8e318946b6330d2c7))

## [0.45.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.4...runner-rs-v0.45.5) (2026-03-23)


### Bug Fixes

* **runner:** skip proxy warning for stopped/draining runners in doctor ([#6233](https://github.com/vm0-ai/vm0/issues/6233)) ([7da7c00](https://github.com/vm0-ai/vm0/commit/7da7c00e5271e751dd37f8d3ee6d7da9a76407b8)), closes [#6198](https://github.com/vm0-ai/vm0/issues/6198)
* **runner:** stop kmsg monitor on shutdown to prevent process hang ([#6206](https://github.com/vm0-ai/vm0/issues/6206)) ([f871fb1](https://github.com/vm0-ai/vm0/commit/f871fb1cda90e45773226896926f92911a123975)), closes [#6197](https://github.com/vm0-ai/vm0/issues/6197)

## [0.45.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.3...runner-rs-v0.45.4) (2026-03-23)

## [0.45.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.2...runner-rs-v0.45.3) (2026-03-23)

## [0.45.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.1...runner-rs-v0.45.2) (2026-03-23)


### Refactoring

* **runner:** remove stale dead_code allows from execution context ([#6148](https://github.com/vm0-ai/vm0/issues/6148)) ([c053ce6](https://github.com/vm0-ai/vm0/commit/c053ce6e7594d901fa511d4f4341ce8709ad88e8))

## [0.45.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.45.0...runner-rs-v0.45.1) (2026-03-23)


### Bug Fixes

* add missing libc dependency to runner crate ([#6092](https://github.com/vm0-ai/vm0/issues/6092)) ([5ba363c](https://github.com/vm0-ai/vm0/commit/5ba363c94e1fb094c339fc4982f93880f52b6503))
* unify pr and mq job-ref and add job-level concurrency groups ([#6086](https://github.com/vm0-ai/vm0/issues/6086)) ([e25f45a](https://github.com/vm0-ai/vm0/commit/e25f45aa5cbcde73a3cf850b67df550a8626885c))

## [0.45.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.44.1...runner-rs-v0.45.0) (2026-03-23)


### Features

* **runner:** add cancel support to local provider via .cancel files ([#6048](https://github.com/vm0-ai/vm0/issues/6048)) ([d065887](https://github.com/vm0-ai/vm0/commit/d065887510d08b06d138a8d3dba30984e5aa4da9))

## [0.44.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.44.0...runner-rs-v0.44.1) (2026-03-23)


### Refactoring

* **runner:** move `runner submit` under `runner local` subcommand ([#5990](https://github.com/vm0-ai/vm0/issues/5990)) ([568fb4c](https://github.com/vm0-ai/vm0/commit/568fb4ce73fa05f6dd0eee05c47c76ffe21e5c5e))

## [0.44.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.43.0...runner-rs-v0.44.0) (2026-03-22)


### Features

* **runner:** add job cancellation via ably real-time notifications ([#5949](https://github.com/vm0-ai/vm0/issues/5949)) ([e157f92](https://github.com/vm0-ai/vm0/commit/e157f925312c50ff8de62e986d7bc7afac0a3d53)), closes [#5762](https://github.com/vm0-ai/vm0/issues/5762)

## [0.43.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.42.1...runner-rs-v0.43.0) (2026-03-21)


### Features

* add tcp connection logging and network log type field ([#5786](https://github.com/vm0-ai/vm0/issues/5786)) ([12d6ddb](https://github.com/vm0-ai/vm0/commit/12d6ddbefa61a83e7e50e6ae4e5fc904b6965678)), closes [#5592](https://github.com/vm0-ai/vm0/issues/5592)

## [0.42.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.42.0...runner-rs-v0.42.1) (2026-03-21)

## [0.42.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.41.0...runner-rs-v0.42.0) (2026-03-20)


### Features

* **runner:** add sentry panic reporting for crash observability ([#5747](https://github.com/vm0-ai/vm0/issues/5747)) ([0e28602](https://github.com/vm0-ai/vm0/commit/0e28602620d8e6e87e5801a587d48829910becd5)), closes [#5680](https://github.com/vm0-ai/vm0/issues/5680)
* support --settings flag for vm0 run ([#5663](https://github.com/vm0-ai/vm0/issues/5663)) ([#5753](https://github.com/vm0-ai/vm0/issues/5753)) ([d0aad87](https://github.com/vm0-ai/vm0/commit/d0aad87539c31ae4664d41b1cca46b556b3de66e))
* support --tools cli parameter across full pipeline ([#5752](https://github.com/vm0-ai/vm0/issues/5752)) ([b0cf364](https://github.com/vm0-ai/vm0/commit/b0cf364a8598dcd36ed1a6ffffdb8c1e03d1841c))


### Refactoring

* separate auth error from firewall action in network logs ([#5756](https://github.com/vm0-ai/vm0/issues/5756)) ([7b56aed](https://github.com/vm0-ai/vm0/commit/7b56aedb93ba323a4076af6ca19fb43a520aa6e1)), closes [#5754](https://github.com/vm0-ai/vm0/issues/5754)

## [0.41.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.40.0...runner-rs-v0.41.0) (2026-03-20)


### Features

* add firewall fields to network logs and improve action handling ([#5745](https://github.com/vm0-ai/vm0/issues/5745)) ([ff2d271](https://github.com/vm0-ai/vm0/commit/ff2d271d7040f6367dd19a7f0e6f21fdd35a19c1))

## [0.40.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.39.0...runner-rs-v0.40.0) (2026-03-20)


### Features

* **vsock:** add real-time stdout streaming from guest to host ([#5574](https://github.com/vm0-ai/vm0/issues/5574)) ([2afc093](https://github.com/vm0-ai/vm0/commit/2afc0930657f6bbf1e1f4947383345d33de46819))


### Performance Improvements

* **mitm-addon:** use asyncio.to_thread for blocking firewall auth requests ([#5638](https://github.com/vm0-ai/vm0/issues/5638)) ([e7a29b9](https://github.com/vm0-ai/vm0/commit/e7a29b9f94692400fd9ac592cefd30640b116199)), closes [#5635](https://github.com/vm0-ai/vm0/issues/5635)

## [0.39.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.38.1...runner-rs-v0.39.0) (2026-03-19)


### Features

* add disallowed_tools to vm0.yaml schema and server pipeline ([#5576](https://github.com/vm0-ai/vm0/issues/5576)) ([6ac49d7](https://github.com/vm0-ai/vm0/commit/6ac49d7434b456e01df4d3fa6bf918923b07b2f5))
* add zero agents rest api and remove compose jobs ([#5594](https://github.com/vm0-ai/vm0/issues/5594)) ([8e428bb](https://github.com/vm0-ai/vm0/commit/8e428bb40c663b50bb481928f708e004601ee1af))
* **runner:** pass disallowed tools from execution context to claude cli ([#5577](https://github.com/vm0-ai/vm0/issues/5577)) ([cdc557a](https://github.com/vm0-ai/vm0/commit/cdc557a4ccb873b37b5df3cc3eb550d6f0849e79)), closes [#5564](https://github.com/vm0-ai/vm0/issues/5564)


### Bug Fixes

* override mitmproxy bundled certificate store with system ca bundle ([#5529](https://github.com/vm0-ai/vm0/issues/5529)) ([b4e665f](https://github.com/vm0-ai/vm0/commit/b4e665f1f34e2d51c9dc9bbc45e8df3ffba3a603)), closes [#5524](https://github.com/vm0-ai/vm0/issues/5524)
* register vm in proxy before sandbox start to prevent missing network logs ([#5537](https://github.com/vm0-ai/vm0/issues/5537)) ([ebe67ba](https://github.com/vm0-ai/vm0/commit/ebe67ba9c895cd11915511c4c7d120916c78f5a7)), closes [#5535](https://github.com/vm0-ai/vm0/issues/5535)
* **runner:** add user-agent to mitmproxy firewall auth requests ([#5632](https://github.com/vm0-ai/vm0/issues/5632)) ([a9d25c9](https://github.com/vm0-ai/vm0/commit/a9d25c9ea81d9a61a167f3210c8d83e926a8859a)), closes [#5630](https://github.com/vm0-ai/vm0/issues/5630)
* **runner:** include runner log files in gc cleanup ([#5559](https://github.com/vm0-ai/vm0/issues/5559)) ([19f2985](https://github.com/vm0-ai/vm0/commit/19f29853615887101bb8dd0d8e5dff6da679fb0c)), closes [#5555](https://github.com/vm0-ai/vm0/issues/5555)
* **runner:** remove duplicate disallowed_tools field in execution context ([#5608](https://github.com/vm0-ai/vm0/issues/5608)) ([efed47a](https://github.com/vm0-ai/vm0/commit/efed47aaff3d010763a3af1120de8326cb37e2b8))


### Refactoring

* merge browser profile into default, install chromium in base rootfs ([#5568](https://github.com/vm0-ai/vm0/issues/5568)) ([e014dd1](https://github.com/vm0-ai/vm0/commit/e014dd1d9778d739b66844f2d67871ba61af9107)), closes [#5554](https://github.com/vm0-ai/vm0/issues/5554)

## [0.38.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.38.0...runner-rs-v0.38.1) (2026-03-19)


### Refactoring

* **sandbox:** remove dead use_proxy field from sandbox config ([#5483](https://github.com/vm0-ai/vm0/issues/5483)) ([97c8db8](https://github.com/vm0-ai/vm0/commit/97c8db89235175ba41f45817413b671c3d39fe3e)), closes [#5481](https://github.com/vm0-ai/vm0/issues/5481)

## [0.38.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.37.0...runner-rs-v0.38.0) (2026-03-19)


### Features

* **runner:** always register vms in proxy for network logging ([#5465](https://github.com/vm0-ai/vm0/issues/5465)) ([5508b23](https://github.com/vm0-ai/vm0/commit/5508b2326891cd4294a12ed392dc7e296611462d))

## [0.37.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.36.0...runner-rs-v0.37.0) (2026-03-19)


### Features

* inject agent identity env vars and add whoami command ([#5461](https://github.com/vm0-ai/vm0/issues/5461)) ([76ceb92](https://github.com/vm0-ai/vm0/commit/76ceb92d5559ed2987abbacc24fcf422ebad2753))

## [0.36.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.35.0...runner-rs-v0.36.0) (2026-03-19)


### Features

* **runner:** add vm0/browser profile with dockerfile and ci integration ([#5311](https://github.com/vm0-ai/vm0/issues/5311)) ([a6b6077](https://github.com/vm0-ai/vm0/commit/a6b6077eb2e8a83f48bed456e4ee7d5e3323c192))


### Bug Fixes

* **sandbox-fc:** use per-profile overlay directories to prevent cross-deletion ([#5413](https://github.com/vm0-ai/vm0/issues/5413)) ([a5c1a56](https://github.com/vm0-ai/vm0/commit/a5c1a56e0cbbf7ce305bf34414981ef3a08f2841)), closes [#5405](https://github.com/vm0-ai/vm0/issues/5405)

## [0.35.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.34.0...runner-rs-v0.35.0) (2026-03-18)


### Features

* add append-system-prompt support to runner and guest-agent ([#5384](https://github.com/vm0-ai/vm0/issues/5384)) ([37aaa76](https://github.com/vm0-ai/vm0/commit/37aaa76b7acdf8c24f2928590de54317870c3a21)), closes [#5375](https://github.com/vm0-ai/vm0/issues/5375)

## [0.34.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.33.0...runner-rs-v0.34.0) (2026-03-18)


### Features

* **runner:** add minimum age protection to runner gc ([#5347](https://github.com/vm0-ai/vm0/issues/5347)) ([e7cc167](https://github.com/vm0-ai/vm0/commit/e7cc167f44b64dc3b866c8de78b7e36fae1e503b)), closes [#5345](https://github.com/vm0-ai/vm0/issues/5345)

## [0.33.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.32.0...runner-rs-v0.33.0) (2026-03-18)


### Features

* **runner:** add profile support to local provider and submit command ([#5234](https://github.com/vm0-ai/vm0/issues/5234)) ([296dc94](https://github.com/vm0-ai/vm0/commit/296dc94707b5de7ca8113893b48c445765d69e37))

## [0.32.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.3...runner-rs-v0.32.0) (2026-03-17)


### Features

* **runner:** profile-aware discovery, budget reservation, and per-profile factory ([#5224](https://github.com/vm0-ai/vm0/issues/5224)) ([05e3803](https://github.com/vm0-ai/vm0/commit/05e3803c7566ec70be92c1e313fa1c58d2b6c779))

## [0.31.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.2...runner-rs-v0.31.3) (2026-03-17)


### Refactoring

* **sandbox-fc:** replace target-size pool pre-warming with fixed buffer ([#5191](https://github.com/vm0-ai/vm0/issues/5191)) ([4ce60ac](https://github.com/vm0-ai/vm0/commit/4ce60ac8c1c5b0f60dae8169d71135b11ee3b968))

## [0.31.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.1...runner-rs-v0.31.2) (2026-03-17)

## [0.31.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.31.0...runner-rs-v0.31.1) (2026-03-17)

## [0.31.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.30.0...runner-rs-v0.31.0) (2026-03-17)


### Features

* **runner:** add experimental profile passthrough from compose to runner ([#5100](https://github.com/vm0-ai/vm0/issues/5100)) ([5eb8dd4](https://github.com/vm0-ai/vm0/commit/5eb8dd44baaa24ea40baf2804ec022a3d006528a)), closes [#5037](https://github.com/vm0-ai/vm0/issues/5037)

## [0.30.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.3...runner-rs-v0.30.0) (2026-03-17)


### Features

* support {param*} wildcard for zero-or-more path segments ([#5114](https://github.com/vm0-ai/vm0/issues/5114)) ([408c637](https://github.com/vm0-ai/vm0/commit/408c637b37ed74ce20c9ac48b778f1a363dbe842))

## [0.29.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.2...runner-rs-v0.29.3) (2026-03-17)


### Bug Fixes

* {param+} path matching should require one or more segments ([#5106](https://github.com/vm0-ai/vm0/issues/5106)) ([b05ecd5](https://github.com/vm0-ai/vm0/commit/b05ecd5599e6c9a09232cdcef097f53d8d15161e))

## [0.29.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.1...runner-rs-v0.29.2) (2026-03-17)


### Refactoring

* **rust:** replace inline crate:: paths with top-level use imports ([#5061](https://github.com/vm0-ai/vm0/issues/5061)) ([149aaa0](https://github.com/vm0-ai/vm0/commit/149aaa09ca2bf69ffb1bc35471ba813e5884e534)), closes [#5038](https://github.com/vm0-ai/vm0/issues/5038)

## [0.29.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.29.0...runner-rs-v0.29.1) (2026-03-16)


### Bug Fixes

* return detailed json error on firewall 403 responses ([#5053](https://github.com/vm0-ai/vm0/issues/5053)) ([285cc4c](https://github.com/vm0-ai/vm0/commit/285cc4c6b79366fe6aedaeaeff4291a3fc584f1e))


### Refactoring

* align experimental_capabilities with resource model ([#5063](https://github.com/vm0-ai/vm0/issues/5063)) ([9d025ce](https://github.com/vm0-ai/vm0/commit/9d025ce6e43570242af0604181adb3047fe81370))
* rename firewall array fields to plural form ([#5034](https://github.com/vm0-ai/vm0/issues/5034)) ([79bd167](https://github.com/vm0-ai/vm0/commit/79bd1675288e6a5a92acb6ef9c199099b9dd11bf))

## [0.29.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.28.2...runner-rs-v0.29.0) (2026-03-16)


### Features

* **runner:** add profile definitions and multi-profile build pipeline ([#4952](https://github.com/vm0-ai/vm0/issues/4952)) ([0263ddd](https://github.com/vm0-ai/vm0/commit/0263ddd26ff25bf3c3e82ca66242b5bfa73e2466)), closes [#4941](https://github.com/vm0-ai/vm0/issues/4941)

## [0.28.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.28.1...runner-rs-v0.28.2) (2026-03-16)


### Refactoring

* **runner:** decouple ca generation from rootfs build ([#4968](https://github.com/vm0-ai/vm0/issues/4968)) ([0ef9a58](https://github.com/vm0-ai/vm0/commit/0ef9a5895005b46fa3ce209e1155a2b9703d2893)), closes [#4962](https://github.com/vm0-ai/vm0/issues/4962)

## [0.28.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.28.0...runner-rs-v0.28.1) (2026-03-16)


### Refactoring

* merge volume/artifact/memory capabilities into storage:read and storage:write ([#4959](https://github.com/vm0-ai/vm0/issues/4959)) ([cc0c3b4](https://github.com/vm0-ai/vm0/commit/cc0c3b40c3c6a5a8a6167a46531fb1db16191341)), closes [#4956](https://github.com/vm0-ai/vm0/issues/4956)

## [0.28.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.27.0...runner-rs-v0.28.0) (2026-03-16)


### Features

* **runner:** replace semaphore with resource-budget concurrency control ([#4928](https://github.com/vm0-ai/vm0/issues/4928)) ([48f674f](https://github.com/vm0-ai/vm0/commit/48f674fad4a567d9d8158b0e3fde65535366a71b))

## [0.27.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.26.2...runner-rs-v0.27.0) (2026-03-16)


### Features

* conditionally inject cli env vars in sandbox when capabilities present ([#4902](https://github.com/vm0-ai/vm0/issues/4902)) ([4b89998](https://github.com/vm0-ai/vm0/commit/4b899988768c0edc9781fb1ffefedec90de044e5)), closes [#4899](https://github.com/vm0-ai/vm0/issues/4899)


### Refactoring

* rename service to firewall across entire codebase ([#4877](https://github.com/vm0-ai/vm0/issues/4877)) ([#4895](https://github.com/vm0-ai/vm0/issues/4895)) ([d40192b](https://github.com/vm0-ai/vm0/commit/d40192b6df5672d525dd39b9215a167ba42a3722))

## [0.26.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.26.1...runner-rs-v0.26.2) (2026-03-16)


### Refactoring

* **services:** unify secret template syntax to ${{ }} ([#4862](https://github.com/vm0-ai/vm0/issues/4862)) ([607e8e9](https://github.com/vm0-ai/vm0/commit/607e8e9be8eb83b60895898686ca94f711f6debb)), closes [#4806](https://github.com/vm0-ai/vm0/issues/4806)

## [0.26.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.26.0...runner-rs-v0.26.1) (2026-03-15)

## [0.26.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.25.0...runner-rs-v0.26.0) (2026-03-15)


### Features

* **services:** add oauth token refresh and ttl caching to auth endpoint ([#4802](https://github.com/vm0-ai/vm0/issues/4802)) ([eab1747](https://github.com/vm0-ai/vm0/commit/eab17475db94fbbc8e5a4d8317851fb09fef28a9))

## [0.25.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.24.1...runner-rs-v0.25.0) (2026-03-14)


### Features

* **runner:** plumb secret-connector map from build to proxy addon ([#4764](https://github.com/vm0-ai/vm0/issues/4764)) ([dcde11d](https://github.com/vm0-ai/vm0/commit/dcde11dd12a1484e4050370848e51f8bd4a14946))

## [0.24.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.24.0...runner-rs-v0.24.1) (2026-03-14)


### Bug Fixes

* **services:** allow same permission name across different api_entries ([#4754](https://github.com/vm0-ai/vm0/issues/4754)) ([2b84536](https://github.com/vm0-ai/vm0/commit/2b845369ead0589dfc6e26dded933b75f94f2ab0))

## [0.24.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.23.0...runner-rs-v0.24.0) (2026-03-13)


### Features

* **services:** permission-based request matching in mitm_addon ([#4721](https://github.com/vm0-ai/vm0/issues/4721)) ([98267dd](https://github.com/vm0-ai/vm0/commit/98267ddeb6d01e7b9b1c4599ead7a9c173b67130))


### Refactoring

* change experimental services from flat apis to nested service entries ([#4711](https://github.com/vm0-ai/vm0/issues/4711)) ([a7dbfc8](https://github.com/vm0-ai/vm0/commit/a7dbfc8a18e65350ef701628f1b3e6ed6837d282))
* eliminate remaining scope references ([#4703](https://github.com/vm0-ai/vm0/issues/4703)) ([fd85a3b](https://github.com/vm0-ai/vm0/commit/fd85a3b6b4f4fe10eb0ff36a1f5140888d9a57f1))
* rename remaining scope references to org in contracts ([#4695](https://github.com/vm0-ai/vm0/issues/4695)) ([9d4a05e](https://github.com/vm0-ai/vm0/commit/9d4a05e89cd28a98f3496149bdaf5f19e93207eb)), closes [#4688](https://github.com/vm0-ai/vm0/issues/4688)

## [0.23.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.8...runner-rs-v0.23.0) (2026-03-13)


### Features

* **services:** add permission type definitions ([#4659](https://github.com/vm0-ai/vm0/issues/4659)) ([5c7e96a](https://github.com/vm0-ai/vm0/commit/5c7e96ab41040602ca40a55fd966e2ba2b5dab7d))

## [0.22.8](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.7...runner-rs-v0.22.8) (2026-03-12)


### Refactoring

* reorder mitm-addon request handling to enforce firewall before services ([#4625](https://github.com/vm0-ai/vm0/issues/4625)) ([28ea3a5](https://github.com/vm0-ai/vm0/commit/28ea3a50e5598c293cb920cbe67ded089829d653)), closes [#4624](https://github.com/vm0-ai/vm0/issues/4624)
* **services:** addon encrypted-secrets passthrough and auth endpoint rewrite ([#4613](https://github.com/vm0-ai/vm0/issues/4613)) ([3f19c4c](https://github.com/vm0-ai/vm0/commit/3f19c4c87102a69aeb75ed2f3102904c9479d7e9))

## [0.22.7](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.6...runner-rs-v0.22.7) (2026-03-12)


### Refactoring

* **services:** forward encryptedSecrets through proxy registry ([#4604](https://github.com/vm0-ai/vm0/issues/4604)) ([21ca7a1](https://github.com/vm0-ai/vm0/commit/21ca7a138f7633c2204ae38a82ce6b1a9c9c1193))

## [0.22.6](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.5...runner-rs-v0.22.6) (2026-03-12)


### Refactoring

* remove experimental_mitm and always enable mitm when proxy is active ([#4568](https://github.com/vm0-ai/vm0/issues/4568)) ([34e1257](https://github.com/vm0-ai/vm0/commit/34e1257a96ceb70a50c07fa258a442c940b5ef95))
* remove sni mode dead code from network logging ([#4592](https://github.com/vm0-ai/vm0/issues/4592)) ([20a55a8](https://github.com/vm0-ai/vm0/commit/20a55a8cc7cfd5284b072ec945c23185a58d1d8f))
* **runner:** rename secrets variable to match field name ([#4588](https://github.com/vm0-ai/vm0/issues/4588)) ([5a1413d](https://github.com/vm0-ai/vm0/commit/5a1413dabecf8a3c5966c7c860cb6a93f9f21ad6))
* **services:** pass encrypted-secrets blob in claim response to runner ([#4599](https://github.com/vm0-ai/vm0/issues/4599)) ([ffdfe6e](https://github.com/vm0-ai/vm0/commit/ffdfe6e617cceb1823e700f3754aa55dde3d5def))

## [0.22.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.4...runner-rs-v0.22.5) (2026-03-12)


### Refactoring

* remove proxy rewrite endpoint and seal secrets ([#4539](https://github.com/vm0-ai/vm0/issues/4539)) ([f7af830](https://github.com/vm0-ai/vm0/commit/f7af8301f67b87f4615dad8e9b8a00adb449aeba))

## [0.22.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.3...runner-rs-v0.22.4) (2026-03-12)


### Refactoring

* remove balloon_reclaim flag and enable balloon reclaim unconditionally ([#4473](https://github.com/vm0-ai/vm0/issues/4473)) ([b386091](https://github.com/vm0-ai/vm0/commit/b38609140426569f3fe0c3cc3e56bf81ee477583))
* remove secret names from execution context ([#4489](https://github.com/vm0-ai/vm0/issues/4489)) ([bc70477](https://github.com/vm0-ai/vm0/commit/bc704775200d97dac742f730cb93350609636006))
* **runner:** stop injecting vars directly as environment variables ([#4482](https://github.com/vm0-ai/vm0/issues/4482)) ([c47674a](https://github.com/vm0-ai/vm0/commit/c47674acb4d22d929b7d98c237947192e89b1f61))

## [0.22.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.2...runner-rs-v0.22.3) (2026-03-11)


### Bug Fixes

* **runner:** log response headers in network logs for zlib error debugging ([#4400](https://github.com/vm0-ai/vm0/issues/4400)) ([47207fa](https://github.com/vm0-ai/vm0/commit/47207fa18c72b204219a9171418ed5dc21f19e8e))


### Refactoring

* decouple service proxy config from connector concept ([#4388](https://github.com/vm0-ai/vm0/issues/4388)) ([b970b33](https://github.com/vm0-ai/vm0/commit/b970b33d97fc4f1cf825215e4b94ed182110c31f))

## [0.22.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.1...runner-rs-v0.22.2) (2026-03-11)


### Bug Fixes

* **mitm-addon:** stream all responses to prevent zlib error ([#4350](https://github.com/vm0-ai/vm0/issues/4350)) ([fd72f46](https://github.com/vm0-ai/vm0/commit/fd72f46af290c13cba9f655995265eb6269776ac))

## [0.22.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.22.0...runner-rs-v0.22.1) (2026-03-11)


### Bug Fixes

* enable selective streaming in mitm proxy to avoid zliberror ([#4223](https://github.com/vm0-ai/vm0/issues/4223)) ([9d89bd3](https://github.com/vm0-ai/vm0/commit/9d89bd3c3a3f39f54a319bd81b040bd4081206aa))

## [0.22.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.21.1...runner-rs-v0.22.0) (2026-03-10)


### Features

* **connectors:** implement proxy-side auth header injection for experimental connectors ([#4072](https://github.com/vm0-ai/vm0/issues/4072)) ([dabc986](https://github.com/vm0-ai/vm0/commit/dabc986158c0d98068a06599724da3307a4904f7))


### Bug Fixes

* remove overly broad "killed process" pattern from oom detection ([#4127](https://github.com/vm0-ai/vm0/issues/4127)) ([42b8acf](https://github.com/vm0-ai/vm0/commit/42b8acf959b9d29909e7944f0048320f3215843a))
* remove overly broad killed process pattern from oom detection ([#4147](https://github.com/vm0-ai/vm0/issues/4147)) ([8766dd9](https://github.com/vm0-ai/vm0/commit/8766dd98ba36113be183d666ec661e99177406b5))

## [0.21.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.21.0...runner-rs-v0.21.1) (2026-03-10)

## [0.21.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.4...runner-rs-v0.21.0) (2026-03-09)


### Features

* **connectors:** add experimental connectors data pipeline ([#4048](https://github.com/vm0-ai/vm0/issues/4048)) ([f3ad976](https://github.com/vm0-ai/vm0/commit/f3ad976c82d86300636b545aa8b5b23c6ebfc744))

## [0.20.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.3...runner-rs-v0.20.4) (2026-03-09)


### Bug Fixes

* ensure system env vars take precedence over user-provided variables ([#3921](https://github.com/vm0-ai/vm0/issues/3921)) ([fcfa1f2](https://github.com/vm0-ai/vm0/commit/fcfa1f2ac77f31648dd655c61cc3030518400df1))

## [0.20.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.2...runner-rs-v0.20.3) (2026-03-09)


### Bug Fixes

* **storage:** unify memory storage auto-creation with artifact pattern ([#3944](https://github.com/vm0-ai/vm0/issues/3944)) ([e2af883](https://github.com/vm0-ai/vm0/commit/e2af88330c3bf305c1586ffd4315dff19a4e7504))


### Refactoring

* **runner:** make runner doctor tolerant of transient states ([#3943](https://github.com/vm0-ai/vm0/issues/3943)) ([f0c0dbf](https://github.com/vm0-ai/vm0/commit/f0c0dbfbcc3581ba8f1e157b871358dfe5632fab))

## [0.20.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.1...runner-rs-v0.20.2) (2026-03-08)

## [0.20.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.20.0...runner-rs-v0.20.1) (2026-03-07)


### Bug Fixes

* **runner:** use proper shell escaping in executor guest commands ([#3902](https://github.com/vm0-ai/vm0/issues/3902)) ([f5b5031](https://github.com/vm0-ai/vm0/commit/f5b5031be43a8fe814da676c472d586fb25ce29e))
* use correct storage type in memory dedup path and propagate checkpoint errors ([#3906](https://github.com/vm0-ai/vm0/issues/3906)) ([9abe586](https://github.com/vm0-ai/vm0/commit/9abe586d92126cef4fc9f7c2fa4319c7448e86dd))

## [0.20.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.4...runner-rs-v0.20.0) (2026-03-07)


### Features

* add --memory flag for agent long-term memory ([#3424](https://github.com/vm0-ai/vm0/issues/3424)) ([9e0279f](https://github.com/vm0-ai/vm0/commit/9e0279f618efe5396dda9e1aaac43a72bba70bfe))


### Bug Fixes

* **guest-init:** set correct env vars for sudo and user sessions ([#3892](https://github.com/vm0-ai/vm0/issues/3892)) ([a1f46e3](https://github.com/vm0-ai/vm0/commit/a1f46e3204f6f897f793118f97a3731d2b370bb3))

## [0.19.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.3...runner-rs-v0.19.4) (2026-03-07)

## [0.19.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.2...runner-rs-v0.19.3) (2026-03-06)

## [0.19.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.1...runner-rs-v0.19.2) (2026-03-06)

## [0.19.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.19.0...runner-rs-v0.19.1) (2026-03-06)

## [0.19.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.18.0...runner-rs-v0.19.0) (2026-03-05)


### Features

* **runner:** balloon reclaim with per-tick inflate cap and full ci test ([#3711](https://github.com/vm0-ai/vm0/issues/3711)) ([7f7efc2](https://github.com/vm0-ai/vm0/commit/7f7efc2f845686899c62ce20cbf992cc9cc5c7df))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.17.0...runner-rs-v0.18.0) (2026-03-05)


### Features

* **sandbox-fc:** add per-sandbox balloon memory reclaim controller ([#3700](https://github.com/vm0-ai/vm0/issues/3700)) ([10f121b](https://github.com/vm0-ai/vm0/commit/10f121bc06e87f23a48af9b4b971faacef620442)), closes [#3697](https://github.com/vm0-ai/vm0/issues/3697)


### Bug Fixes

* set api start time inside create-run for e2e telemetry ([#3707](https://github.com/vm0-ai/vm0/issues/3707)) ([e902696](https://github.com/vm0-ai/vm0/commit/e902696adb72414e5b248552379ee59c9cbbabd0)), closes [#3706](https://github.com/vm0-ai/vm0/issues/3706)

## [0.17.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.16.0...runner-rs-v0.17.0) (2026-03-05)


### Features

* **sandbox-fc:** enable balloon stats and add runtime balloon api ([#3694](https://github.com/vm0-ai/vm0/issues/3694)) ([b5918d6](https://github.com/vm0-ai/vm0/commit/b5918d6e7f7c82f79693b725bad2b5c547016655)), closes [#3688](https://github.com/vm0-ai/vm0/issues/3688)
* **sandbox-fc:** enable virtio-balloon with deflate_on_oom as safety net ([#3679](https://github.com/vm0-ai/vm0/issues/3679)) ([2ce2b62](https://github.com/vm0-ai/vm0/commit/2ce2b62c991a9e4bc077438630eb21267b618dc2)), closes [#3666](https://github.com/vm0-ai/vm0/issues/3666)

## [0.16.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.15.1...runner-rs-v0.16.0) (2026-03-05)


### Features

* **runner:** add concurrency-factor parameter for cpu overcommit ([#3669](https://github.com/vm0-ai/vm0/issues/3669)) ([528afa4](https://github.com/vm0-ai/vm0/commit/528afa4c9d6670abcfef0ce412ba12568e196295))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.15.0...runner-rs-v0.15.1) (2026-03-04)


### Bug Fixes

* **runner:** remove trigger comment and bump for release ([#3654](https://github.com/vm0-ai/vm0/issues/3654)) ([fadb62c](https://github.com/vm0-ai/vm0/commit/fadb62c3b89cd978c280fe046b23b708cdad4db4))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.14.0...runner-rs-v0.15.0) (2026-03-04)


### Features

* **runner:** add --name filter to runner doctor ([#3615](https://github.com/vm0-ai/vm0/issues/3615)) ([4e8597c](https://github.com/vm0-ai/vm0/commit/4e8597cf8f0f1f6339841abcb066590768bef84a))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.13.0...runner-rs-v0.14.0) (2026-03-04)


### Features

* **runner:** auto-calculate max_concurrent from host resources ([#3528](https://github.com/vm0-ai/vm0/issues/3528)) ([eee7ead](https://github.com/vm0-ai/vm0/commit/eee7ead8925bfdfd51269b116041a745df0564a6))

## [0.13.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.3...runner-rs-v0.13.0) (2026-03-03)


### Features

* **runner:** add exec command for live vm debugging ([#3502](https://github.com/vm0-ai/vm0/issues/3502)) ([0453c3b](https://github.com/vm0-ai/vm0/commit/0453c3bd7a32f9b9e2760ff30e4aea192a9b0836))

## [0.12.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.2...runner-rs-v0.12.3) (2026-03-02)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.12.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.1...runner-rs-v0.12.2) (2026-03-02)


### Performance Improvements

* **sandbox-fc:** use full cli invocation for snapshot pre-warm ([#3395](https://github.com/vm0-ai/vm0/issues/3395)) ([318deaa](https://github.com/vm0-ai/vm0/commit/318deaa20216059e92c1702a10ef0203c98af00e))

## [0.12.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.12.0...runner-rs-v0.12.1) (2026-03-01)


### Performance Improvements

* **runner:** prefetch snapshot memory.bin via sequential read ([#3373](https://github.com/vm0-ai/vm0/issues/3373)) ([21289eb](https://github.com/vm0-ai/vm0/commit/21289ebcff774e6c763a350dbb57be23f1ebeed8)), closes [#3342](https://github.com/vm0-ai/vm0/issues/3342)

## [0.12.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.11.0...runner-rs-v0.12.0) (2026-03-01)


### Features

* **runner:** add --env flag to benchmark command ([#3335](https://github.com/vm0-ai/vm0/issues/3335)) ([25683a5](https://github.com/vm0-ai/vm0/commit/25683a5049ae80a3644a065d4f401f8ca1887052))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.10.0...runner-rs-v0.11.0) (2026-03-01)


### Features

* **runner:** copy guest system log to host after job ([#3329](https://github.com/vm0-ai/vm0/issues/3329)) ([e1fc90b](https://github.com/vm0-ai/vm0/commit/e1fc90ba7f5f8b555a93028e05086ffac6c3c003))
* **runner:** redirect guest-download output to system log file ([#3328](https://github.com/vm0-ai/vm0/issues/3328)) ([68ba78d](https://github.com/vm0-ai/vm0/commit/68ba78dcb0e931aae14c74d1cd809b4f6d5924d1))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.9.0...runner-rs-v0.10.0) (2026-03-01)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.9.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.5...runner-rs-v0.9.0) (2026-03-01)


### Features

* **runner:** embed guest binaries via build.rs ([#3319](https://github.com/vm0-ai/vm0/issues/3319)) ([acacb39](https://github.com/vm0-ai/vm0/commit/acacb39e6861d04853f148be090367f6de0e8f8a))

## [0.8.5](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.4...runner-rs-v0.8.5) (2026-02-28)


### Bug Fixes

* **runner:** deterministic active_run_ids order in status.json ([#3290](https://github.com/vm0-ai/vm0/issues/3290)) ([b87e8a2](https://github.com/vm0-ai/vm0/commit/b87e8a28d6bd1e8adf1d7ce9dfc133c2aa8f9893))

## [0.8.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.3...runner-rs-v0.8.4) (2026-02-27)


### Performance Improvements

* **rootfs:** install claude code as standalone binary for faster cold-start ([#3278](https://github.com/vm0-ai/vm0/issues/3278)) ([e8cbefa](https://github.com/vm0-ai/vm0/commit/e8cbefad6e5d3f6ea91d0eefd07baac743db8ab1))

## [0.8.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.2...runner-rs-v0.8.3) (2026-02-27)


### Performance Improvements

* **sandbox-fc:** pre-warm real claude execution path instead of --help ([#3272](https://github.com/vm0-ai/vm0/issues/3272)) ([5d95121](https://github.com/vm0-ai/vm0/commit/5d95121b69e9ac5dbe76cb0859cc90b4b48a3743)), closes [#3258](https://github.com/vm0-ai/vm0/issues/3258)

## [0.8.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.1...runner-rs-v0.8.2) (2026-02-27)


### Bug Fixes

* **sandbox-fc:** use deterministic mac on tap devices for snapshot arp stability ([#3269](https://github.com/vm0-ai/vm0/issues/3269)) ([4c73c27](https://github.com/vm0-ai/vm0/commit/4c73c275ae6ae6bb3fbea6b5ee93ee5b0b761418)), closes [#3268](https://github.com/vm0-ai/vm0/issues/3268)

## [0.8.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.8.0...runner-rs-v0.8.1) (2026-02-26)


### Bug Fixes

* **sandbox-fc:** remove double su wrapper from prewarm script ([#3265](https://github.com/vm0-ai/vm0/issues/3265)) ([3df62d1](https://github.com/vm0-ai/vm0/commit/3df62d1b9be9310e5112f3423edce504295f1775))


### Performance Improvements

* **sandbox-fc:** enable v8 compile cache for faster cli cold start ([#3267](https://github.com/vm0-ai/vm0/issues/3267)) ([6f1c8be](https://github.com/vm0-ai/vm0/commit/6f1c8be89cd5c7168326b5fa822d26eb2f9fa824))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.7.0...runner-rs-v0.8.0) (2026-02-25)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.7.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.4...runner-rs-v0.7.0) (2026-02-25)


### Miscellaneous Chores

* **runner-rs:** Synchronize runner-guest versions

## [0.3.4](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.3...runner-rs-v0.3.4) (2026-02-23)


### Performance Improvements

* **sandbox-fc:** pre-warm claude and codex in snapshot ([#3232](https://github.com/vm0-ai/vm0/issues/3232)) ([5534465](https://github.com/vm0-ai/vm0/commit/553446505f92aa30b1ac38b396f9238a6ff4c9ac))

## [0.3.3](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.2...runner-rs-v0.3.3) (2026-02-23)

## [0.3.2](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.1...runner-rs-v0.3.2) (2026-02-23)

## [0.3.1](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.3.0...runner-rs-v0.3.1) (2026-02-22)

## [0.3.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.2.0...runner-rs-v0.3.0) (2026-02-22)


### Features

* **runner:** extend gc to clean up old deployment versions ([#3201](https://github.com/vm0-ai/vm0/issues/3201)) ([09f2d1c](https://github.com/vm0-ai/vm0/commit/09f2d1cabac6089daf4bb2365abb88d95e1065c4))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/runner-rs-v0.1.0...runner-rs-v0.2.0) (2026-02-22)


### Features

* allow users to set timezone preference for sandbox and scheduling ([#2866](https://github.com/vm0-ai/vm0/issues/2866)) ([89437c7](https://github.com/vm0-ai/vm0/commit/89437c733b4e34eee46009b20c99f455c5963289))
* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **runner:** add --dry-run flag to rootfs, snapshot, and build commands ([#3169](https://github.com/vm0-ai/vm0/issues/3169)) ([62b62e3](https://github.com/vm0-ai/vm0/commit/62b62e3cf2931ae14a67ed8d481f702131a4e323)), closes [#3168](https://github.com/vm0-ai/vm0/issues/3168)
* **runner:** add --env flag to runner service start/install ([#3112](https://github.com/vm0-ai/vm0/issues/3112)) ([d2f8ec8](https://github.com/vm0-ai/vm0/commit/d2f8ec85ca4591ac4f4aa12ffebc073bd1f6ed9f))
* **runner:** add `runner doctor` command for runtime health diagnostics ([#3138](https://github.com/vm0-ai/vm0/issues/3138)) ([e075414](https://github.com/vm0-ai/vm0/commit/e075414291d0aa313af2f903f2f46d75ab0f92b8))
* **runner:** add `runner gc` command to clean up unused rootfs and snapshots ([#3128](https://github.com/vm0-ai/vm0/issues/3128)) ([d4e6235](https://github.com/vm0-ai/vm0/commit/d4e6235c40a63d4f1411ce982ab1800d905d6fe7))
* **runner:** add `setup` command to download firecracker and kernel ([#2825](https://github.com/vm0-ai/vm0/issues/2825)) ([f5ba977](https://github.com/vm0-ai/vm0/commit/f5ba9773e0c4ed54c56cad26d30abc3dafa1bfda))
* **runner:** add ably realtime subscription to start command ([#3048](https://github.com/vm0-ai/vm0/issues/3048)) ([553ba2d](https://github.com/vm0-ai/vm0/commit/553ba2d1727466fd30683a4dd690036df995d7e9))
* **runner:** add benchmark subcommand for single-shot vm execution ([#2982](https://github.com/vm0-ai/vm0/issues/2982)) ([a4ee02a](https://github.com/vm0-ai/vm0/commit/a4ee02ad56e2c86b6a4bbbc9f03fa6ebe99c474c))
* **runner:** add build command combining rootfs + snapshot ([#2914](https://github.com/vm0-ai/vm0/issues/2914)) ([305c038](https://github.com/vm0-ai/vm0/commit/305c03867368a44f30d2421e9f23490ec91e960f))
* **runner:** add build-rootfs command to replace bash script ([#2858](https://github.com/vm0-ai/vm0/issues/2858)) ([3a298f6](https://github.com/vm0-ai/vm0/commit/3a298f6a29941e14e062cfb4301ea112c69ccad4))
* **runner:** add execution telemetry for sandbox operations ([#3068](https://github.com/vm0-ai/vm0/issues/3068)) ([4e7fbb3](https://github.com/vm0-ai/vm0/commit/4e7fbb3545f1d548a8e6345d120b560a0a3439a2))
* **runner:** add firewall rules and seal secrets to proxy registry ([#3028](https://github.com/vm0-ai/vm0/issues/3028)) ([752f9b5](https://github.com/vm0-ai/vm0/commit/752f9b549447dde65c23bd81bcc9e805796d441d))
* **runner:** add kill command to terminate running sandboxes ([#3153](https://github.com/vm0-ai/vm0/issues/3153)) ([26d4e7d](https://github.com/vm0-ai/vm0/commit/26d4e7d1763eaa55166e243ecc96052ceba15c7c))
* **runner:** add local job provider and submit command ([#3158](https://github.com/vm0-ai/vm0/issues/3158)) ([4d300cb](https://github.com/vm0-ai/vm0/commit/4d300cb95baa0713866d7332a050e4b5b32c6ac1))
* **runner:** add mitmproxy integration to benchmark command ([#3027](https://github.com/vm0-ai/vm0/issues/3027)) ([7dab1cd](https://github.com/vm0-ai/vm0/commit/7dab1cd38f8c4e58fbdca98890b5a3b21bf53e9e))
* **runner:** add proxy support to start command ([#3045](https://github.com/vm0-ai/vm0/issues/3045)) ([5a7016f](https://github.com/vm0-ai/vm0/commit/5a7016f20e698c616728d42bca481c8c87338623))
* **runner:** add runner.yaml config file generated by build ([#2935](https://github.com/vm0-ai/vm0/issues/2935)) ([9b9577a](https://github.com/vm0-ai/vm0/commit/9b9577a3197b72f64866ff12769fa919c252a347))
* **runner:** add service subcommand for systemd lifecycle management ([#3098](https://github.com/vm0-ai/vm0/issues/3098)) ([9686c65](https://github.com/vm0-ai/vm0/commit/9686c659797f53c58333903968a4b3b62d3523ef))
* **runner:** add snapshot subcommand with content-addressable caching ([#2903](https://github.com/vm0-ai/vm0/issues/2903)) ([c00ab8d](https://github.com/vm0-ai/vm0/commit/c00ab8d387bcdca0917ed1efd13a870c032adf44))
* **runner:** add version flag to cli ([#3038](https://github.com/vm0-ai/vm0/issues/3038)) ([0afc49a](https://github.com/vm0-ai/vm0/commit/0afc49a163e76d6f999fb9c94ff3067109f0ff8e))
* **runner:** auto-restart mitmproxy on crash ([#3083](https://github.com/vm0-ai/vm0/issues/3083)) ([2261025](https://github.com/vm0-ai/vm0/commit/2261025f85537333b76299903748be96c5c9dfb5))
* **runner:** detect oom kills and return clear error message ([#3093](https://github.com/vm0-ai/vm0/issues/3093)) ([38718c9](https://github.com/vm0-ai/vm0/commit/38718c9a00485e33a623954778e41cdfda89ec0f))
* **runner:** download and install mitmdump in setup command ([#2838](https://github.com/vm0-ai/vm0/issues/2838)) ([d171672](https://github.com/vm0-ai/vm0/commit/d171672409b0cdd1b850dc3db07d1ecbc5592364))
* **runner:** gc stale network log files older than 7 days ([#3137](https://github.com/vm0-ai/vm0/issues/3137)) ([43bb9c1](https://github.com/vm0-ai/vm0/commit/43bb9c1ec457b208005333bcdd570c2860fbc429))
* **runner:** implement rust runner crate for job polling and execution ([#2722](https://github.com/vm0-ai/vm0/issues/2722)) ([38b494e](https://github.com/vm0-ai/vm0/commit/38b494e563f0c87486419a36df265fe5c0d8c032))
* **runner:** log snapshot file sizes (logical and disk) ([#2997](https://github.com/vm0-ai/vm0/issues/2997)) ([671cbad](https://github.com/vm0-ai/vm0/commit/671cbad4d55594dbc5df4858fa6acbfffcbee57b))
* **runner:** replace socket-based local provider with file queue ([#3166](https://github.com/vm0-ai/vm0/issues/3166)) ([658c007](https://github.com/vm0-ai/vm0/commit/658c007f30a633934d4d691791b46361ddf236fc))
* **runner:** upload mitmproxy network logs to telemetry endpoint ([#3071](https://github.com/vm0-ai/vm0/issues/3071)) ([80023b0](https://github.com/vm0-ai/vm0/commit/80023b0f627d6b3b57bd1aa9a46cd4244118710e))
* **runner:** use service install/drain in ci upgrade test ([#3167](https://github.com/vm0-ai/vm0/issues/3167)) ([4ebb1d7](https://github.com/vm0-ai/vm0/commit/4ebb1d73afd5405cdbe21d0c4aa88280606f386b))
* **runner:** write logs to file in addition to stderr ([#3101](https://github.com/vm0-ai/vm0/issues/3101)) ([fa4000b](https://github.com/vm0-ai/vm0/commit/fa4000bec7db04abcc040076121c43caecbf3354))
* **sandbox-fc:** per-sandbox proxy control with dual-queue netns pool ([#3035](https://github.com/vm0-ai/vm0/issues/3035)) ([deda648](https://github.com/vm0-ai/vm0/commit/deda64875625f49f4a72513d2b286dba12be0986)), closes [#3033](https://github.com/vm0-ai/vm0/issues/3033)
* **vsock:** add environment variable support to exec/spawn_watch ([#2736](https://github.com/vm0-ai/vm0/issues/2736)) ([6f93486](https://github.com/vm0-ai/vm0/commit/6f9348601ae5736e20a8c32a2064ac394a70e70b))
* **vsock:** add sudo flag to exec/spawn_watch protocol ([#2985](https://github.com/vm0-ai/vm0/issues/2985)) ([9c42331](https://github.com/vm0-ai/vm0/commit/9c423314a07f8de0f1b92ea3adca4efa4c6de987)), closes [#2984](https://github.com/vm0-ai/vm0/issues/2984)


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **crates:** use system tls certificates instead of bundled webpki-roots ([#2824](https://github.com/vm0-ai/vm0/issues/2824)) ([aa95e93](https://github.com/vm0-ai/vm0/commit/aa95e9328dc99d77215d30e8545de11211a12792))
* **runner:** add exclusive lock on base_dir to prevent silent data corruption ([#3126](https://github.com/vm0-ai/vm0/issues/3126)) ([61ac8b7](https://github.com/vm0-ai/vm0/commit/61ac8b7e9121465d934f77c9dd8fb47acbc883ab)), closes [#3125](https://github.com/vm0-ai/vm0/issues/3125)
* **runner:** add flock to prevent concurrent rootfs/snapshot builds ([#2980](https://github.com/vm0-ai/vm0/issues/2980)) ([96a8559](https://github.com/vm0-ai/vm0/commit/96a8559f03ebebc0833af97d7bfe5c3c1562cb24))
* **runner:** add path validation and ci hash guards ([#3161](https://github.com/vm0-ai/vm0/issues/3161)) ([c5313ff](https://github.com/vm0-ai/vm0/commit/c5313ffdaee030c5fb3d48b950c8d7b6e36e90ae))
* **runner:** clean up request_start_times on flow error in mitm-addon ([#3076](https://github.com/vm0-ai/vm0/issues/3076)) ([a6e8cb1](https://github.com/vm0-ai/vm0/commit/a6e8cb1d9b9dece53f66aea35b8c32627bf4270e)), closes [#3073](https://github.com/vm0-ai/vm0/issues/3073)
* **runner:** exclude network log upload from cleanup telemetry metric ([#3075](https://github.com/vm0-ai/vm0/issues/3075)) ([5b1beb1](https://github.com/vm0-ai/vm0/commit/5b1beb1a06cf19ebc67ba435a03ada529ef47f22)), closes [#3072](https://github.com/vm0-ai/vm0/issues/3072)
* **runner:** forward mock-claude env var to guest ([#3089](https://github.com/vm0-ai/vm0/issues/3089)) ([2978851](https://github.com/vm0-ai/vm0/commit/297885167fb36a2fcd1b3a5566a4c00bf4a571cb)), closes [#3088](https://github.com/vm0-ai/vm0/issues/3088)
* **runner:** gc removes unused lock files with safe inode recheck ([#3132](https://github.com/vm0-ai/vm0/issues/3132)) ([1e9d234](https://github.com/vm0-ai/vm0/commit/1e9d2345cb3209ade7b8f17f221f3621e9915172)), closes [#3131](https://github.com/vm0-ai/vm0/issues/3131)
* **runner:** prevent vm process leak on executor task panic ([#3079](https://github.com/vm0-ai/vm0/issues/3079)) ([6677bb5](https://github.com/vm0-ai/vm0/commit/6677bb55aa95096988c634879b23a775c9d63352)), closes [#3078](https://github.com/vm0-ai/vm0/issues/3078)
* **runner:** re-establish ably subscription after fatal error ([#3077](https://github.com/vm0-ai/vm0/issues/3077)) ([be681ca](https://github.com/vm0-ai/vm0/commit/be681cada26167aa8ebe1809edb326621902085b)), closes [#3074](https://github.com/vm0-ai/vm0/issues/3074)
* **runner:** sanitize runner name used in log file prefix ([#3103](https://github.com/vm0-ai/vm0/issues/3103)) ([b028b89](https://github.com/vm0-ai/vm0/commit/b028b89440019c077c0a0fc8cfced3178f74d797))
* **runner:** set node ca certs env var for mitm mode ([#3091](https://github.com/vm0-ai/vm0/issues/3091)) ([8626d58](https://github.com/vm0-ai/vm0/commit/8626d58b203a6fdbabea21aa21cb228ddc9cff78))
* **runner:** sort gc artifacts by last-used time instead of creation time ([#3130](https://github.com/vm0-ai/vm0/issues/3130)) ([42efcb2](https://github.com/vm0-ai/vm0/commit/42efcb29da6ef4d96fe6fb640953354f12bda516))
* **runner:** use run_id as sandbox_id instead of random uuid ([#3151](https://github.com/vm0-ai/vm0/issues/3151)) ([3e13c72](https://github.com/vm0-ai/vm0/commit/3e13c727b7a972c76b0f96c56e59ef2e65eca864))
* **runner:** walk ppid chain for orphan detection instead of checking immediate parent ([#3154](https://github.com/vm0-ai/vm0/issues/3154)) ([c377a54](https://github.com/vm0-ai/vm0/commit/c377a544643cd1908b32e505d533448ed73bc98c))
* **sandbox-fc:** move runtime sockets to /run/vm0 to fix sun_path limit ([#2951](https://github.com/vm0-ai/vm0/issues/2951)) ([#2966](https://github.com/vm0-ai/vm0/issues/2966)) ([4b91e0d](https://github.com/vm0-ai/vm0/commit/4b91e0d9ad2f677475afd768f95f19af852c9b46))


### Performance Improvements

* **sandbox-fc:** include prewarm script in snapshot hash computation ([#3004](https://github.com/vm0-ai/vm0/issues/3004)) ([3c27ac0](https://github.com/vm0-ai/vm0/commit/3c27ac0b4ffb8ab487fbea71cf62bf9681f31b0f)), closes [#3002](https://github.com/vm0-ai/vm0/issues/3002)
