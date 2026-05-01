# Changelog

## [0.20.6](https://github.com/vm0-ai/vm0/compare/guest-download-v0.20.5...guest-download-v0.20.6) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.20.5](https://github.com/vm0-ai/vm0/compare/guest-download-v0.20.4...guest-download-v0.20.5) (2026-04-29)


### Refactoring

* split runner storage manifest boundaries ([#11487](https://github.com/vm0-ai/vm0/issues/11487)) ([7bfc3f8](https://github.com/vm0-ai/vm0/commit/7bfc3f86717495cf2ed8d72c796fb1e3b6a98f30))

## [0.20.4](https://github.com/vm0-ai/vm0/compare/guest-download-v0.20.3...guest-download-v0.20.4) (2026-04-27)


### Refactoring

* centralize guest system log path ([#11246](https://github.com/vm0-ai/vm0/issues/11246)) ([b93fc42](https://github.com/vm0-ai/vm0/commit/b93fc42833815fd843f073044b4e872505812025))

## [0.20.3](https://github.com/vm0-ai/vm0/compare/guest-download-v0.20.2...guest-download-v0.20.3) (2026-04-27)

## [0.20.2](https://github.com/vm0-ai/vm0/compare/guest-download-v0.20.1...guest-download-v0.20.2) (2026-04-26)

## [0.20.1](https://github.com/vm0-ai/vm0/compare/guest-download-v0.20.0...guest-download-v0.20.1) (2026-04-23)


### Bug Fixes

* **guest-download:** don't delete staged tarball after extraction ([#10903](https://github.com/vm0-ai/vm0/issues/10903)) ([1b38788](https://github.com/vm0-ai/vm0/commit/1b3878889784e4e77d64dec23b086f641df92433))

## [0.20.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.19.1...guest-download-v0.20.0) (2026-04-23)


### Features

* **guest-download:** support file:// urls for host-staged tarballs ([#10812](https://github.com/vm0-ai/vm0/issues/10812)) ([1f5c542](https://github.com/vm0-ai/vm0/commit/1f5c542e62ff5b29e382540cbed5e0c5c11bb410)), closes [#10805](https://github.com/vm0-ai/vm0/issues/10805)

## [0.19.1](https://github.com/vm0-ai/vm0/compare/guest-download-v0.19.0...guest-download-v0.19.1) (2026-04-22)


### Refactoring

* drop residual memory plumbing, legacy snapshot columns, and vm0 memory cli ([#10707](https://github.com/vm0-ai/vm0/issues/10707)) ([08f3ce8](https://github.com/vm0-ai/vm0/commit/08f3ce81273faf8ea7e2e4df67b69e774bcb963e))
* emit memory as artifacts[] entry and delete guest-agent symlink bootstrap ([#10700](https://github.com/vm0-ai/vm0/issues/10700)) ([e3f0120](https://github.com/vm0-ai/vm0/commit/e3f0120fbd90d9b9fb750e13440a9f21ea809d3a))

## [0.19.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.18.3...guest-download-v0.19.0) (2026-04-22)


### Features

* multi-mount artifact backend + checkpoint schema ([#10629](https://github.com/vm0-ai/vm0/issues/10629)) ([0f8af96](https://github.com/vm0-ai/vm0/commit/0f8af96cd55dedd89534ff430765cc34661a55fc))

## [0.18.3](https://github.com/vm0-ai/vm0/compare/guest-download-v0.18.2...guest-download-v0.18.3) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.18.2](https://github.com/vm0-ai/vm0/compare/guest-download-v0.18.1...guest-download-v0.18.2) (2026-04-12)


### Bug Fixes

* **runner:** add cached field to storage manifest for correct cleanup preservation ([#8993](https://github.com/vm0-ai/vm0/issues/8993)) ([d9db456](https://github.com/vm0-ai/vm0/commit/d9db4569ef6f86fdf46063d65a9aad34ca7a6b2a)), closes [#8982](https://github.com/vm0-ai/vm0/issues/8982)

## [0.18.1](https://github.com/vm0-ai/vm0/compare/guest-download-v0.18.0...guest-download-v0.18.1) (2026-04-10)


### Bug Fixes

* **guest-download:** pre-create target directories before parallel downloads ([#8823](https://github.com/vm0-ai/vm0/issues/8823)) ([6a7d48d](https://github.com/vm0-ai/vm0/commit/6a7d48dd6465677872ce921b4de01fd8b5f1c68c))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.17.1...guest-download-v0.18.0) (2026-04-10)


### Features

* **runner:** clean stale files on vm reuse before downloading storages ([#8800](https://github.com/vm0-ai/vm0/issues/8800)) ([4725751](https://github.com/vm0-ai/vm0/commit/4725751f5ff9b6f4b7b1c1294b6efbc48bc005b1)), closes [#8757](https://github.com/vm0-ai/vm0/issues/8757)

## [0.17.1](https://github.com/vm0-ai/vm0/compare/guest-download-v0.17.0...guest-download-v0.17.1) (2026-04-10)


### Bug Fixes

* **guest-download:** remove pre-extraction remove_dir_all to fix parallel race ([#8755](https://github.com/vm0-ai/vm0/issues/8755)) ([ede79e4](https://github.com/vm0-ai/vm0/commit/ede79e420f62288655b8c687789fbb0e3ab6444e))

## [0.17.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.16.0...guest-download-v0.17.0) (2026-04-09)


### Features

* **runner:** read guest session id for first-run vm parking ([#8731](https://github.com/vm0-ai/vm0/issues/8731)) ([9bdcda9](https://github.com/vm0-ai/vm0/commit/9bdcda9c5e2bb5af853696c19661862ab0f000b6))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.15.2...guest-download-v0.16.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.15.2](https://github.com/vm0-ai/vm0/compare/guest-download-v0.15.1...guest-download-v0.15.2) (2026-03-23)


### Bug Fixes

* prevent symlink path traversal in guest-download tar extraction ([#6160](https://github.com/vm0-ai/vm0/issues/6160)) ([06375dc](https://github.com/vm0-ai/vm0/commit/06375dc978e7795806c32f6fb1f38592893a9976))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/guest-download-v0.15.0...guest-download-v0.15.1) (2026-03-09)


### Bug Fixes

* **guest-download:** record 404 with allow_404 as telemetry success ([#4024](https://github.com/vm0-ai/vm0/issues/4024)) ([56a7f33](https://github.com/vm0-ai/vm0/commit/56a7f333584e0e1ba2c77c634aec788d47125278)), closes [#3986](https://github.com/vm0-ai/vm0/issues/3986)

## [0.15.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.14.0...guest-download-v0.15.0) (2026-03-07)


### Features

* add --memory flag for agent long-term memory ([#3424](https://github.com/vm0-ai/vm0/issues/3424)) ([9e0279f](https://github.com/vm0-ai/vm0/commit/9e0279f618efe5396dda9e1aaac43a72bba70bfe))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.13.0...guest-download-v0.14.0) (2026-03-04)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.13.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.12.3...guest-download-v0.13.0) (2026-03-03)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.12.3](https://github.com/vm0-ai/vm0/compare/guest-download-v0.12.2...guest-download-v0.12.3) (2026-03-02)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.12.2](https://github.com/vm0-ai/vm0/compare/guest-download-v0.12.1...guest-download-v0.12.2) (2026-03-02)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.12.1](https://github.com/vm0-ai/vm0/compare/guest-download-v0.12.0...guest-download-v0.12.1) (2026-03-01)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.12.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.11.0...guest-download-v0.12.0) (2026-03-01)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.11.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.10.0...guest-download-v0.11.0) (2026-03-01)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.10.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.9.0...guest-download-v0.10.0) (2026-03-01)


### Features

* **guest-download:** log download url ([#3323](https://github.com/vm0-ai/vm0/issues/3323)) ([78a6a26](https://github.com/vm0-ai/vm0/commit/78a6a26df02ae3c8ed5b9d3243edbe125f52db30))

## [0.9.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.8.5...guest-download-v0.9.0) (2026-03-01)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.8.5](https://github.com/vm0-ai/vm0/compare/guest-download-v0.8.4...guest-download-v0.8.5) (2026-02-28)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.8.4](https://github.com/vm0-ai/vm0/compare/guest-download-v0.8.3...guest-download-v0.8.4) (2026-02-27)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.8.3](https://github.com/vm0-ai/vm0/compare/guest-download-v0.8.2...guest-download-v0.8.3) (2026-02-27)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.8.2](https://github.com/vm0-ai/vm0/compare/guest-download-v0.8.1...guest-download-v0.8.2) (2026-02-27)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.8.1](https://github.com/vm0-ai/vm0/compare/guest-download-v0.8.0...guest-download-v0.8.1) (2026-02-26)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.8.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.7.0...guest-download-v0.8.0) (2026-02-25)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.7.0](https://github.com/vm0-ai/vm0/compare/guest-download-v0.1.5...guest-download-v0.7.0) (2026-02-25)


### Miscellaneous Chores

* **guest-download:** Synchronize runner-guest versions

## [0.1.5](https://github.com/vm0-ai/vm0/compare/guest-download-v0.1.4...guest-download-v0.1.5) (2026-02-23)


### Bug Fixes

* **guest-download:** only treat 404 as non-fatal for artifact downloads ([#2900](https://github.com/vm0-ai/vm0/issues/2900)) ([8711a0f](https://github.com/vm0-ai/vm0/commit/8711a0f5cfad3ac0fa8eda31ff74d48e3fbcde6e))
* **guest-download:** retry on 429 rate limiting ([#2911](https://github.com/vm0-ai/vm0/issues/2911)) ([8913f1d](https://github.com/vm0-ai/vm0/commit/8913f1d0da2d36cbbf286fab12a6bef6ff4d14aa)), closes [#2905](https://github.com/vm0-ai/vm0/issues/2905)
* **guest-download:** skip retry on 4xx errors and log failed url ([#2846](https://github.com/vm0-ai/vm0/issues/2846)) ([8579be9](https://github.com/vm0-ai/vm0/commit/8579be91fa132202f4d0b7361e3fe602fc538e3d))
* **guest-download:** use is_valid_url for artifact and preserve panic info ([#2827](https://github.com/vm0-ai/vm0/issues/2827)) ([55e6b66](https://github.com/vm0-ai/vm0/commit/55e6b660e28f5c7e6744cc2850f884eba2e9296b))

## [0.1.4](https://github.com/vm0-ai/vm0/compare/guest-download-v0.1.3...guest-download-v0.1.4) (2026-02-23)


### Bug Fixes

* **guest-download:** only treat 404 as non-fatal for artifact downloads ([#2900](https://github.com/vm0-ai/vm0/issues/2900)) ([8711a0f](https://github.com/vm0-ai/vm0/commit/8711a0f5cfad3ac0fa8eda31ff74d48e3fbcde6e))
* **guest-download:** retry on 429 rate limiting ([#2911](https://github.com/vm0-ai/vm0/issues/2911)) ([8913f1d](https://github.com/vm0-ai/vm0/commit/8913f1d0da2d36cbbf286fab12a6bef6ff4d14aa)), closes [#2905](https://github.com/vm0-ai/vm0/issues/2905)
* **guest-download:** skip retry on 4xx errors and log failed url ([#2846](https://github.com/vm0-ai/vm0/issues/2846)) ([8579be9](https://github.com/vm0-ai/vm0/commit/8579be91fa132202f4d0b7361e3fe602fc538e3d))
* **guest-download:** use is_valid_url for artifact and preserve panic info ([#2827](https://github.com/vm0-ai/vm0/issues/2827)) ([55e6b66](https://github.com/vm0-ai/vm0/commit/55e6b660e28f5c7e6744cc2850f884eba2e9296b))

## [0.1.3](https://github.com/vm0-ai/vm0/compare/guest-download-v0.1.2...guest-download-v0.1.3) (2026-02-22)


### Bug Fixes

* **guest-download:** only treat 404 as non-fatal for artifact downloads ([#2900](https://github.com/vm0-ai/vm0/issues/2900)) ([8711a0f](https://github.com/vm0-ai/vm0/commit/8711a0f5cfad3ac0fa8eda31ff74d48e3fbcde6e))
* **guest-download:** retry on 429 rate limiting ([#2911](https://github.com/vm0-ai/vm0/issues/2911)) ([8913f1d](https://github.com/vm0-ai/vm0/commit/8913f1d0da2d36cbbf286fab12a6bef6ff4d14aa)), closes [#2905](https://github.com/vm0-ai/vm0/issues/2905)
* **guest-download:** skip retry on 4xx errors and log failed url ([#2846](https://github.com/vm0-ai/vm0/issues/2846)) ([8579be9](https://github.com/vm0-ai/vm0/commit/8579be91fa132202f4d0b7361e3fe602fc538e3d))
* **guest-download:** use is_valid_url for artifact and preserve panic info ([#2827](https://github.com/vm0-ai/vm0/issues/2827)) ([55e6b66](https://github.com/vm0-ai/vm0/commit/55e6b660e28f5c7e6744cc2850f884eba2e9296b))

## [0.1.2](https://github.com/vm0-ai/vm0/compare/guest-download-v0.1.1...guest-download-v0.1.2) (2026-02-22)


### Bug Fixes

* **guest-download:** only treat 404 as non-fatal for artifact downloads ([#2900](https://github.com/vm0-ai/vm0/issues/2900)) ([8711a0f](https://github.com/vm0-ai/vm0/commit/8711a0f5cfad3ac0fa8eda31ff74d48e3fbcde6e))
* **guest-download:** retry on 429 rate limiting ([#2911](https://github.com/vm0-ai/vm0/issues/2911)) ([8913f1d](https://github.com/vm0-ai/vm0/commit/8913f1d0da2d36cbbf286fab12a6bef6ff4d14aa)), closes [#2905](https://github.com/vm0-ai/vm0/issues/2905)
* **guest-download:** skip retry on 4xx errors and log failed url ([#2846](https://github.com/vm0-ai/vm0/issues/2846)) ([8579be9](https://github.com/vm0-ai/vm0/commit/8579be91fa132202f4d0b7361e3fe602fc538e3d))
* **guest-download:** use is_valid_url for artifact and preserve panic info ([#2827](https://github.com/vm0-ai/vm0/issues/2827)) ([55e6b66](https://github.com/vm0-ai/vm0/commit/55e6b660e28f5c7e6744cc2850f884eba2e9296b))

## [0.1.1](https://github.com/vm0-ai/vm0/compare/guest-download-v0.1.0...guest-download-v0.1.1) (2026-02-22)


### Bug Fixes

* **guest-download:** only treat 404 as non-fatal for artifact downloads ([#2900](https://github.com/vm0-ai/vm0/issues/2900)) ([8711a0f](https://github.com/vm0-ai/vm0/commit/8711a0f5cfad3ac0fa8eda31ff74d48e3fbcde6e))
* **guest-download:** retry on 429 rate limiting ([#2911](https://github.com/vm0-ai/vm0/issues/2911)) ([8913f1d](https://github.com/vm0-ai/vm0/commit/8913f1d0da2d36cbbf286fab12a6bef6ff4d14aa)), closes [#2905](https://github.com/vm0-ai/vm0/issues/2905)
* **guest-download:** skip retry on 4xx errors and log failed url ([#2846](https://github.com/vm0-ai/vm0/issues/2846)) ([8579be9](https://github.com/vm0-ai/vm0/commit/8579be91fa132202f4d0b7361e3fe602fc538e3d))
* **guest-download:** use is_valid_url for artifact and preserve panic info ([#2827](https://github.com/vm0-ai/vm0/issues/2827)) ([55e6b66](https://github.com/vm0-ai/vm0/commit/55e6b660e28f5c7e6744cc2850f884eba2e9296b))
