# Changelog

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
