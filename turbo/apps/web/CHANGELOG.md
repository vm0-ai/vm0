# Changelog

## [0.4.1](https://github.com/vm0-ai/vm0/compare/web-v0.4.0...web-v0.4.1) (2025-11-20)


### Bug Fixes

* use production url for e2b webhook callbacks ([#100](https://github.com/vm0-ai/vm0/issues/100)) ([ead881d](https://github.com/vm0-ai/vm0/commit/ead881d89efbe33d0a2f656b230aa0aac2ba51e3))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/web-v0.3.0...web-v0.4.0) (2025-11-20)


### Features

* **ci:** add environment variables injection for e2b and minimax ([#97](https://github.com/vm0-ai/vm0/issues/97)) ([584ebcc](https://github.com/vm0-ai/vm0/commit/584ebcc92f9ef888921319d2944fa6106175c223))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/web-v0.2.0...web-v0.3.0) (2025-11-20)


### Features

* add CLI e2e device flow automation and production API fallback ([#73](https://github.com/vm0-ai/vm0/issues/73)) ([8eb2d21](https://github.com/vm0-ai/vm0/commit/8eb2d21e6a2f363f93575f85bde5081a2ff218a7))
* add device flow authentication for cli ([#39](https://github.com/vm0-ai/vm0/issues/39)) ([b6ae61c](https://github.com/vm0-ai/vm0/commit/b6ae61c4244b318e9a6d3969d1ab57bd3d47c873))
* add e2b api key configuration ([#41](https://github.com/vm0-ai/vm0/issues/41)) ([e4fd5ed](https://github.com/vm0-ai/vm0/commit/e4fd5edd85a30225f6efac9e26677d9a4ec59f77))
* add support for agent names in vm0 run command ([#71](https://github.com/vm0-ai/vm0/issues/71)) ([4842d80](https://github.com/vm0-ai/vm0/commit/4842d80f0ce24aec3683ff0e364fc9e22eb24177))
* implement CLI build and run commands ([#65](https://github.com/vm0-ai/vm0/issues/65)) ([c0b8d11](https://github.com/vm0-ai/vm0/commit/c0b8d114a8c6910bfce7c2e4e10a82509889a28f))
* implement event streaming for vm0 run command ([#92](https://github.com/vm0-ai/vm0/issues/92)) ([a551950](https://github.com/vm0-ai/vm0/commit/a5519501aa6e7b3b739e05a965d58868498dbdca))
* implement phase 1 database schema and api framework for agent configs ([#37](https://github.com/vm0-ai/vm0/issues/37)) ([f8a9b08](https://github.com/vm0-ai/vm0/commit/f8a9b0815c8b3c4b5063d8f1d84cea522006f79c))
* implement phase 1 database schema and api framework with integration tests ([#44](https://github.com/vm0-ai/vm0/issues/44)) ([d89e686](https://github.com/vm0-ai/vm0/commit/d89e686282b409149187c684371077387b91b31a))
* implement Phase 1.5 E2B Service Layer with Hello World ([#46](https://github.com/vm0-ai/vm0/issues/46)) ([7e5b639](https://github.com/vm0-ai/vm0/commit/7e5b6397c21222843de07ee5895e9f7c9c844038))
* implement webhook API for agent events ([#54](https://github.com/vm0-ai/vm0/issues/54)) ([ea55437](https://github.com/vm0-ai/vm0/commit/ea554376a3b0f2188d8ea53a15f02883fbd84f01))
* integrate Claude Code execution in E2B sandbox ([#58](https://github.com/vm0-ai/vm0/issues/58)) ([a8434d9](https://github.com/vm0-ai/vm0/commit/a8434d9fbf7d00b4854040227477d8d66a609266))
* integrate database storage with agent runtime API ([#49](https://github.com/vm0-ai/vm0/issues/49)) ([d743837](https://github.com/vm0-ai/vm0/commit/d743837224cc639791bae78c28cbe1c6cf742328))
* migrate authentication from api keys to bearer tokens ([#59](https://github.com/vm0-ai/vm0/issues/59)) ([87c887c](https://github.com/vm0-ai/vm0/commit/87c887cdf900010f8b71bf900b910abf8af60a69))


### Bug Fixes

* change agent_runtime_events.sequenceNumber from varchar to integer ([#55](https://github.com/vm0-ai/vm0/issues/55)) ([0b860e1](https://github.com/vm0-ai/vm0/commit/0b860e1a43ab0a1a7eb62223f8c787b2270ed05c))
* resolve E2B script loading error by pre-installing run-agent.sh in template ([#68](https://github.com/vm0-ai/vm0/issues/68)) ([0cc2bd3](https://github.com/vm0-ai/vm0/commit/0cc2bd3875bce658f3055290c1f1643b732ac24c))
* update webhook sequence numbers to use integer type ([#57](https://github.com/vm0-ai/vm0/issues/57)) ([d67380a](https://github.com/vm0-ai/vm0/commit/d67380afea6aed7e09e92bef9ff71fa41efec58e))
* use correct env var and auth header for webhook authentication ([#80](https://github.com/vm0-ai/vm0/issues/80)) ([b821df4](https://github.com/vm0-ai/vm0/commit/b821df4d412da54aa880dbd98d1b57567cf1b4e0))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/web-v0.1.0...web-v0.2.0) (2025-11-15)

### Features

- integrate clerk authentication for web app ([#15](https://github.com/vm0-ai/vm0/issues/15)) ([c855703](https://github.com/vm0-ai/vm0/commit/c8557031027ccc03d147f164bd03821962a71daa))

## [0.1.0](https://github.com/vm0-ai/vm0/compare/web-v0.0.1...web-v0.1.0) (2025-11-15)

### Features

- initial project setup from makita template ([e9c330a](https://github.com/vm0-ai/vm0/commit/e9c330a5952526d657f245e8db9522de553018b3))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @vm0/core bumped to 0.1.0

## [0.1.0](https://github.com/e7h4n/vm0/compare/web-v0.0.1...web-v0.1.0) (2025-08-30)

### Features

- add database migration support with postgres driver ([#24](https://github.com/e7h4n/vm0/issues/24)) ([3760efa](https://github.com/e7h4n/vm0/commit/3760efae5a3cb47a6dfa56e13507dcddb58b92b6))
- add t3-env for type-safe environment variable validation ([#5](https://github.com/e7h4n/vm0/issues/5)) ([10ac6ab](https://github.com/e7h4n/vm0/commit/10ac6ab67e654b6fa8aeef8e6c63649f003f5656))
- implement centralized API contract system ([#13](https://github.com/e7h4n/vm0/issues/13)) ([77bbbd9](https://github.com/e7h4n/vm0/commit/77bbbd913b52341a7720e9bb711d889253d9681a))
- implement lightweight service container for dependency management ([#18](https://github.com/e7h4n/vm0/issues/18)) ([ce6efe9](https://github.com/e7h4n/vm0/commit/ce6efe9df914c0e2bc8de3ccc7a0af114a2b4037))
- initial commit - app template with turborepo monorepo structure ([4123914](https://github.com/e7h4n/vm0/commit/41239143cdaea284f55a02c89fde348c2e3b53ff))

### Dependencies

- The following workspace dependencies were updated
  - dependencies
    - @vm0/core bumped to 0.1.0
