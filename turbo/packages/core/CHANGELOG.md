# Changelog

## [1.0.0](https://github.com/vm0-ai/vm0/compare/core-v0.8.0...core-v1.0.0) (2025-12-22)


### ⚠ BREAKING CHANGES

* Users must update volume mounts from /home/user/.config/claude to /home/user/.claude in their vm0.yaml files.

### Features

* **image:** support @vm0/claude-code format for system images ([#655](https://github.com/vm0-ai/vm0/issues/655)) ([1ddd99f](https://github.com/vm0-ai/vm0/commit/1ddd99fa1b640956244dfd463e6eda6a942e8416))


### Code Refactoring

* remove CLAUDE_CONFIG_DIR override and use ~/.claude default ([#656](https://github.com/vm0-ai/vm0/issues/656)) ([bb009a0](https://github.com/vm0-ai/vm0/commit/bb009a0edbda1a8064a396991ee51f3ea9f38a1f))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/core-v0.7.0...core-v0.8.0) (2025-12-21)


### Features

* **image:** add versioning support with tag syntax ([#643](https://github.com/vm0-ai/vm0/issues/643)) ([761ce57](https://github.com/vm0-ai/vm0/commit/761ce5791aca56e96739db7513fd4e5a83065717))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/core-v0.6.0...core-v0.7.0) (2025-12-20)


### Features

* add scope/namespace system for resource isolation ([#636](https://github.com/vm0-ai/vm0/issues/636)) ([1369059](https://github.com/vm0-ai/vm0/commit/1369059e3e3d7a82aca3f00e59dd2f2814dab0e4))
* **cli:** make --artifact-name optional for vm0 run command ([#640](https://github.com/vm0-ai/vm0/issues/640)) ([6895cfe](https://github.com/vm0-ai/vm0/commit/6895cfe6411b48b23b49d9c5a500fdd0aa746fd0))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/core-v0.5.1...core-v0.6.0) (2025-12-17)


### Features

* **cli:** add beta_system_prompt and beta_system_skills support for agent compose ([#565](https://github.com/vm0-ai/vm0/issues/565)) ([b6388d9](https://github.com/vm0-ai/vm0/commit/b6388d9b9511bf7a6407dc2d17a6a81f85e8d3eb))

## [0.5.1](https://github.com/vm0-ai/vm0/compare/core-v0.5.0...core-v0.5.1) (2025-12-13)


### Bug Fixes

* **cli:** revert system_prompt and system_skills feature ([#540](https://github.com/vm0-ai/vm0/issues/540)) ([b2254fe](https://github.com/vm0-ai/vm0/commit/b2254fec128a641106aa1db67faac938e39e3b3b))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/core-v0.4.0...core-v0.5.0) (2025-12-12)


### Features

* **cli:** add --secrets parameter for passing secrets via CLI ([#512](https://github.com/vm0-ai/vm0/issues/512)) ([7972bf4](https://github.com/vm0-ai/vm0/commit/7972bf4f82f76112f99ebf8068c133e953a4ae20))
* **cli:** add system_prompt and system_skills support for agent compose ([#513](https://github.com/vm0-ai/vm0/issues/513)) ([5079a4a](https://github.com/vm0-ai/vm0/commit/5079a4a9d7a41617e53b22c7ea9e666cf4838f08))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/core-v0.3.0...core-v0.4.0) (2025-12-12)


### Features

* **web:** add generic proxy endpoint for sandbox requests ([#503](https://github.com/vm0-ai/vm0/issues/503)) ([36eda65](https://github.com/vm0-ai/vm0/commit/36eda650e853a62e2269380a777e305505e50702))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/core-v0.2.0...core-v0.3.0) (2025-12-10)


### Features

* **api:** add storages contract and standardize error responses ([#465](https://github.com/vm0-ai/vm0/issues/465)) ([8fa72f4](https://github.com/vm0-ai/vm0/commit/8fa72f461adf28f5f1a5c8e285e02b2416b475bf))
* **api:** complete ts-rest migration for images and cron routes ([#474](https://github.com/vm0-ai/vm0/issues/474)) ([fdf8657](https://github.com/vm0-ai/vm0/commit/fdf86578bd70bb850058ac1eceac3f900e1a8d51))
* **api:** migrate /api/agent/composes routes to ts-rest contract-first architecture ([#458](https://github.com/vm0-ai/vm0/issues/458)) ([4a066d2](https://github.com/vm0-ai/vm0/commit/4a066d2489c4e05ecb4626d0c03694bd683299d9))
* **api:** migrate /api/agent/runs to ts-rest contract-first architecture ([#463](https://github.com/vm0-ai/vm0/issues/463)) ([2f160ec](https://github.com/vm0-ai/vm0/commit/2f160ecbdae67f2a7d8346c6ee393a9dfd0e2e79))
* **api:** migrate /api/agent/sessions to ts-rest contract-first architecture ([#464](https://github.com/vm0-ai/vm0/issues/464)) ([03f32cb](https://github.com/vm0-ai/vm0/commit/03f32cbe506b009d452bfc2b3595c793265b64fb))
* **api:** migrate /api/secrets to ts-rest contract-first architecture ([#453](https://github.com/vm0-ai/vm0/issues/453)) ([27fd2fa](https://github.com/vm0-ai/vm0/commit/27fd2fa1cf0f5c7b3b6b227c547d59d56f13b9de))
* **api:** migrate webhooks and auth routes to ts-rest contracts ([#468](https://github.com/vm0-ai/vm0/issues/468)) ([08c38aa](https://github.com/vm0-ai/vm0/commit/08c38aa399bc776d6ef391ae5bfdd7da1d5d5b7c))
* **observability:** implement sandbox telemetry collection and storage ([#466](https://github.com/vm0-ai/vm0/issues/466)) ([8fe6748](https://github.com/vm0-ai/vm0/commit/8fe674887d84fba9f35838e7ebbdb288967feae4))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/core-v0.1.0...core-v0.2.0) (2025-12-03)


### Features

* add unified environment variable syntax ([#362](https://github.com/vm0-ai/vm0/issues/362)) ([e218dd7](https://github.com/vm0-ai/vm0/commit/e218dd76ddd4b7e6508725570b0cd7ee7d769f56))

## [0.1.0](https://github.com/vm0-ai/vm0/compare/core-v0.0.1...core-v0.1.0) (2025-11-15)


### Features

* initial project setup from makita template ([e9c330a](https://github.com/vm0-ai/vm0/commit/e9c330a5952526d657f245e8db9522de553018b3))

## [0.1.0](https://github.com/e7h4n/vm0/compare/core-v0.0.1...core-v0.1.0) (2025-08-30)


### Features

* implement centralized API contract system ([#13](https://github.com/e7h4n/vm0/issues/13)) ([77bbbd9](https://github.com/e7h4n/vm0/commit/77bbbd913b52341a7720e9bb711d889253d9681a))
* initial commit - app template with turborepo monorepo structure ([4123914](https://github.com/e7h4n/vm0/commit/41239143cdaea284f55a02c89fde348c2e3b53ff))

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
