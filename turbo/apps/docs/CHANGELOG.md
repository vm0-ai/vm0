# Changelog

## [2.32.0](https://github.com/vm0-ai/vm0/compare/docs-v2.31.1...docs-v2.32.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [2.31.1](https://github.com/vm0-ai/vm0/compare/docs-v2.31.0...docs-v2.31.1) (2026-04-06)


### Bug Fixes

* **docs:** fix flaky check-types by reordering fumadocs-mdx and next typegen ([#8209](https://github.com/vm0-ai/vm0/issues/8209)) ([4cd72da](https://github.com/vm0-ai/vm0/commit/4cd72dae0168c68aa53f5dcf3bc34462c5abad4e))

## [2.31.0](https://github.com/vm0-ai/vm0/compare/docs-v2.30.1...docs-v2.31.0) (2026-04-01)


### Features

* **docs:** remove stale --check-env and --model-provider from cli docs ([#7578](https://github.com/vm0-ai/vm0/issues/7578)) ([22189ae](https://github.com/vm0-ai/vm0/commit/22189ae7a44dded541dc9fa0da19375ba71d8935)), closes [#7576](https://github.com/vm0-ai/vm0/issues/7576)

## [2.30.1](https://github.com/vm0-ai/vm0/compare/docs-v2.30.0...docs-v2.30.1) (2026-03-31)


### Refactoring

* **e2e:** replace fixed test accounts with ephemeral per-job-ref accounts ([#7250](https://github.com/vm0-ai/vm0/issues/7250)) ([d2b6f20](https://github.com/vm0-ai/vm0/commit/d2b6f20b33812a7cdada8a84d2063b048d98f920))

## [2.30.0](https://github.com/vm0-ai/vm0/compare/docs-v2.29.2...docs-v2.30.0) (2026-03-27)


### Features

* update og images with zero branding ([#7048](https://github.com/vm0-ai/vm0/issues/7048)) ([f31e98d](https://github.com/vm0-ai/vm0/commit/f31e98d5d26a270d1a887164a95adf5802004935))

## [2.29.2](https://github.com/vm0-ai/vm0/compare/docs-v2.29.1...docs-v2.29.2) (2026-03-26)


### Refactoring

* rename instagram secret to instagram_token ([#6959](https://github.com/vm0-ai/vm0/issues/6959)) ([07687e7](https://github.com/vm0-ai/vm0/commit/07687e7a1ab947201cba7f53da0a9221e8e2e1dc))

## [2.29.1](https://github.com/vm0-ai/vm0/compare/docs-v2.29.0...docs-v2.29.1) (2026-03-25)


### Bug Fixes

* rename x connector env var from x_access_token to x_token ([#6676](https://github.com/vm0-ai/vm0/issues/6676)) ([24d9a8e](https://github.com/vm0-ai/vm0/commit/24d9a8e6047d3d258c92e4dce3813c3759474f5f))

## [2.29.0](https://github.com/vm0-ai/vm0/compare/docs-v2.28.3...docs-v2.29.0) (2026-03-25)


### Features

* **docs:** rewrite capabilities documentation for zero token system ([#6576](https://github.com/vm0-ai/vm0/issues/6576)) ([4b9f277](https://github.com/vm0-ai/vm0/commit/4b9f277de7e6208ed80582783017c45c67cd52d8))


### Refactoring

* remove experimental_capabilities and make vm0_token injection unconditional ([#6573](https://github.com/vm0-ai/vm0/issues/6573)) ([#6579](https://github.com/vm0-ai/vm0/issues/6579)) ([1fb7df0](https://github.com/vm0-ai/vm0/commit/1fb7df0201d70223d486c91b536cad93a78c23a3))

## [2.28.3](https://github.com/vm0-ai/vm0/compare/docs-v2.28.2...docs-v2.28.3) (2026-03-23)


### Refactoring

* remove unused vm0 setup-claude command ([#6083](https://github.com/vm0-ai/vm0/issues/6083)) ([5f499a2](https://github.com/vm0-ai/vm0/commit/5f499a2f50f7d9c4c2c83c8e1e4e71a2c880d295))
* remove unused vm0 usage CLI command ([#6084](https://github.com/vm0-ai/vm0/issues/6084)) ([5b95e85](https://github.com/vm0-ai/vm0/commit/5b95e85d7e16e0faf1cde04b02931ebb1d41c626))

## [2.28.2](https://github.com/vm0-ai/vm0/compare/docs-v2.28.1...docs-v2.28.2) (2026-03-22)


### Refactoring

* make plausible analytics config environment-driven ([#5985](https://github.com/vm0-ai/vm0/issues/5985)) ([7ec3011](https://github.com/vm0-ai/vm0/commit/7ec3011f04eb0ae66e328012fdd2a28af8ebe01d))

## [2.28.1](https://github.com/vm0-ai/vm0/compare/docs-v2.28.0...docs-v2.28.1) (2026-03-20)


### Bug Fixes

* **docker:** grant non-root users access to chromium and sync lockfile ([#5636](https://github.com/vm0-ai/vm0/issues/5636)) ([d645321](https://github.com/vm0-ai/vm0/commit/d645321fc62a30cabb275e52524845d33835816d))

## [2.28.0](https://github.com/vm0-ai/vm0/compare/docs-v2.27.0...docs-v2.28.0) (2026-03-19)


### Features

* add disallowed_tools to vm0.yaml schema and server pipeline ([#5576](https://github.com/vm0-ai/vm0/issues/5576)) ([6ac49d7](https://github.com/vm0-ai/vm0/commit/6ac49d7434b456e01df4d3fa6bf918923b07b2f5))


### Refactoring

* move disallowed_tools from vm0.yaml to run-time parameter ([#5625](https://github.com/vm0-ai/vm0/issues/5625)) ([63b431c](https://github.com/vm0-ai/vm0/commit/63b431c86fb4548c51a5b2b02bc9887a04d7dfa4)), closes [#5614](https://github.com/vm0-ai/vm0/issues/5614)

## [2.27.0](https://github.com/vm0-ai/vm0/compare/docs-v2.26.0...docs-v2.27.0) (2026-03-19)


### Features

* block agent deletion for sandbox tokens ([#5427](https://github.com/vm0-ai/vm0/issues/5427)) ([4baf5bb](https://github.com/vm0-ai/vm0/commit/4baf5bba8b63d97dc4bb7cc76253d00ce8fe204d)), closes [#5425](https://github.com/vm0-ai/vm0/issues/5425)

## [2.26.0](https://github.com/vm0-ai/vm0/compare/docs-v2.25.0...docs-v2.26.0) (2026-03-18)


### Features

* **docs:** update model provider references from user-level to org-level commands ([#5325](https://github.com/vm0-ai/vm0/issues/5325)) ([d3afc0e](https://github.com/vm0-ai/vm0/commit/d3afc0e145539f679a7a39d2bb550c34d223a50b)), closes [#5323](https://github.com/vm0-ai/vm0/issues/5323)

## [2.25.0](https://github.com/vm0-ai/vm0/compare/docs-v2.24.0...docs-v2.25.0) (2026-03-18)


### Features

* **platform:** add member onboarding flow and welcome animation ([#5060](https://github.com/vm0-ai/vm0/issues/5060)) ([de6b1e1](https://github.com/vm0-ai/vm0/commit/de6b1e1cf9467bf1171fd67b5ebbc560373322a2))

## [2.24.0](https://github.com/vm0-ai/vm0/compare/docs-v2.23.0...docs-v2.24.0) (2026-03-17)


### Features

* **docs:** remove non-existent --message option from volume/artifact push docs ([#5177](https://github.com/vm0-ai/vm0/issues/5177)) ([ea10d28](https://github.com/vm0-ai/vm0/commit/ea10d28e2d6e02c3ca327a7c39c825ca00624573)), closes [#5174](https://github.com/vm0-ai/vm0/issues/5174)
* **docs:** update outdated date in schedule one-time example ([#5189](https://github.com/vm0-ai/vm0/issues/5189)) ([1eb9233](https://github.com/vm0-ai/vm0/commit/1eb9233955c4bc4671dfab351101b889798dd310))

## [2.23.0](https://github.com/vm0-ai/vm0/compare/docs-v2.22.3...docs-v2.23.0) (2026-03-17)


### Features

* **docs:** add missing --memory option to vm0 run documentation ([#5178](https://github.com/vm0-ai/vm0/issues/5178)) ([4e97bed](https://github.com/vm0-ai/vm0/commit/4e97bed9316793567b809631b3621e96f52ec03c)), closes [#5175](https://github.com/vm0-ai/vm0/issues/5175)
* **docs:** document vm0 logs search subcommand ([#5186](https://github.com/vm0-ai/vm0/issues/5186)) ([5af7dd8](https://github.com/vm0-ai/vm0/commit/5af7dd8561105da5975c6426c1cd5ae62be8c1e5)), closes [#5183](https://github.com/vm0-ai/vm0/issues/5183)
* **docs:** remove empty best-practices directory ([#5188](https://github.com/vm0-ai/vm0/issues/5188)) ([15ef3e9](https://github.com/vm0-ai/vm0/commit/15ef3e92ca616e8e0f3221e970f639fb99f47f66))


### Documentation

* fix vm0 secret set syntax to use --body flag ([#5176](https://github.com/vm0-ai/vm0/issues/5176)) ([f8049a7](https://github.com/vm0-ai/vm0/commit/f8049a7e5279c2a9d38620dbb67d7d2cb8dda1c9)), closes [#5173](https://github.com/vm0-ai/vm0/issues/5173)

## [2.22.3](https://github.com/vm0-ai/vm0/compare/docs-v2.22.2...docs-v2.22.3) (2026-03-17)


### Refactoring

* **platform:** remove /zero prefix from all platform routes ([#5155](https://github.com/vm0-ai/vm0/issues/5155)) ([228b4dd](https://github.com/vm0-ai/vm0/commit/228b4dd81efe36be51606f695057bf20c4aba034))

## [2.22.2](https://github.com/vm0-ai/vm0/compare/docs-v2.22.1...docs-v2.22.2) (2026-03-17)


### Bug Fixes

* remove personal org concept from org leave and use commands ([#5147](https://github.com/vm0-ai/vm0/issues/5147)) ([314540b](https://github.com/vm0-ai/vm0/commit/314540bcf03897975c0cd1e830b627f8fce13aec))

## [2.22.1](https://github.com/vm0-ai/vm0/compare/docs-v2.22.0...docs-v2.22.1) (2026-03-17)


### Refactoring

* remove deprecated capability aliases ([#5135](https://github.com/vm0-ai/vm0/issues/5135)) ([c2680d3](https://github.com/vm0-ai/vm0/commit/c2680d3d06da36cda2c139b232641931c44f4400)), closes [#5130](https://github.com/vm0-ai/vm0/issues/5130)

## [2.22.0](https://github.com/vm0-ai/vm0/compare/docs-v2.21.1...docs-v2.22.0) (2026-03-17)


### Features

* **docs:** add documentation for experimental_capabilities in vm0.yaml ([#5107](https://github.com/vm0-ai/vm0/issues/5107)) ([5fb1c3b](https://github.com/vm0-ai/vm0/commit/5fb1c3bd5bdc3e90f0fe32b4977e5c6a937eb182))

## [2.21.1](https://github.com/vm0-ai/vm0/compare/docs-v2.21.0...docs-v2.21.1) (2026-03-17)


### Refactoring

* remove all non-zero platform pages and feature flag ([#5095](https://github.com/vm0-ai/vm0/issues/5095)) ([fa7f011](https://github.com/vm0-ai/vm0/commit/fa7f01187b84d7046b150f46f217c191d5ad5670))

## [2.21.0](https://github.com/vm0-ai/vm0/compare/docs-v2.20.0...docs-v2.21.0) (2026-03-17)


### Features

* **docs:** clarify openrouter default model behavior ([#5058](https://github.com/vm0-ai/vm0/issues/5058)) ([424cfc1](https://github.com/vm0-ai/vm0/commit/424cfc14bc9ad5ac324ec637f0f10dc7074e7386))

## [2.20.0](https://github.com/vm0-ai/vm0/compare/docs-v2.19.0...docs-v2.20.0) (2026-03-16)


### Features

* improve zero page with markdown theming, avatar overrides, and navigation ([#5065](https://github.com/vm0-ai/vm0/issues/5065)) ([5ca5a04](https://github.com/vm0-ai/vm0/commit/5ca5a0441b1019516b7a64baa8ca695863581686))

## [2.19.0](https://github.com/vm0-ai/vm0/compare/docs-v2.18.1...docs-v2.19.0) (2026-03-16)


### Features

* **docs:** add claude 4.6 series models to openrouter available models ([#5056](https://github.com/vm0-ai/vm0/issues/5056)) ([f7330c3](https://github.com/vm0-ai/vm0/commit/f7330c38507c7fce49d99a8ee8d366b80acb78c4)), closes [#5041](https://github.com/vm0-ai/vm0/issues/5041)
* **docs:** add vm0 memory command documentation ([#5057](https://github.com/vm0-ai/vm0/issues/5057)) ([3c51ceb](https://github.com/vm0-ai/vm0/commit/3c51ceb5954635ff6e2e8f07df4033228e3fd395)), closes [#5043](https://github.com/vm0-ai/vm0/issues/5043)
* **docs:** add vm0 run queue to cli reference ([#5054](https://github.com/vm0-ai/vm0/issues/5054)) ([54c697a](https://github.com/vm0-ai/vm0/commit/54c697aca13effff999fa53c3853eb93e55817f6))
* **docs:** remove connector references from strava and intervals.icu skill pages ([#5059](https://github.com/vm0-ai/vm0/issues/5059)) ([74f5042](https://github.com/vm0-ai/vm0/commit/74f504204dabd492ebc16876503114db31a30a6f)), closes [#5044](https://github.com/vm0-ai/vm0/issues/5044)
* **docs:** remove non-existent vm0 org create from cli reference ([#5050](https://github.com/vm0-ai/vm0/issues/5050)) ([1a5ce49](https://github.com/vm0-ai/vm0/commit/1a5ce49f0d2c5a0d48581661441dac0e6d8e3322)), closes [#5039](https://github.com/vm0-ai/vm0/issues/5039)
* **docs:** update azure foundry example model id ([#5052](https://github.com/vm0-ai/vm0/issues/5052)) ([06e689c](https://github.com/vm0-ai/vm0/commit/06e689c7b15cc212598eb262e5b7bb44031b0aaf)), closes [#5042](https://github.com/vm0-ai/vm0/issues/5042)
* **docs:** update claude model version examples to current models ([#5055](https://github.com/vm0-ai/vm0/issues/5055)) ([3e8de20](https://github.com/vm0-ai/vm0/commit/3e8de2006efe5d7f8695f4e6045a158d72e40145)), closes [#5040](https://github.com/vm0-ai/vm0/issues/5040)

## [2.18.1](https://github.com/vm0-ai/vm0/compare/docs-v2.18.0...docs-v2.18.1) (2026-03-16)


### Refactoring

* remove cli sharing commands and docs references ([#4878](https://github.com/vm0-ai/vm0/issues/4878)) ([6171c65](https://github.com/vm0-ai/vm0/commit/6171c650c49761c6ded657fc04ecf070e9dd56b1)), closes [#4874](https://github.com/vm0-ai/vm0/issues/4874)

## [2.18.0](https://github.com/vm0-ai/vm0/compare/docs-v2.17.1...docs-v2.18.0) (2026-03-16)


### Features

* add model provider tracking and org-scoped logs/schedules ([#4909](https://github.com/vm0-ai/vm0/issues/4909)) ([dc0de67](https://github.com/vm0-ai/vm0/commit/dc0de673b2e78eec803a3051148f1947dc292945))


### Refactoring

* improve zero onboarding post-completion navigation ([#4908](https://github.com/vm0-ai/vm0/issues/4908)) ([c3d95b8](https://github.com/vm0-ai/vm0/commit/c3d95b884fcece0a3a73d8128469e6f81a7cc650))

## [2.17.1](https://github.com/vm0-ai/vm0/compare/docs-v2.17.0...docs-v2.17.1) (2026-03-13)


### Refactoring

* eliminate remaining scope references ([#4703](https://github.com/vm0-ai/vm0/issues/4703)) ([fd85a3b](https://github.com/vm0-ai/vm0/commit/fd85a3b6b4f4fe10eb0ff36a1f5140888d9a57f1))
* rename remaining scope references to org in contracts ([#4695](https://github.com/vm0-ai/vm0/issues/4695)) ([9d4a05e](https://github.com/vm0-ai/vm0/commit/9d4a05e89cd28a98f3496149bdaf5f19e93207eb)), closes [#4688](https://github.com/vm0-ai/vm0/issues/4688)

## [2.17.0](https://github.com/vm0-ai/vm0/compare/docs-v2.16.5...docs-v2.17.0) (2026-03-13)


### Features

* **docs:** upgrade fumadocs to v16 and next.js to v16 ([#4677](https://github.com/vm0-ai/vm0/issues/4677)) ([5a6c22f](https://github.com/vm0-ai/vm0/commit/5a6c22f7435bc3d4ddad0fbbaa10a6528b1b4858)), closes [#4671](https://github.com/vm0-ai/vm0/issues/4671)

## [2.16.5](https://github.com/vm0-ai/vm0/compare/docs-v2.16.4...docs-v2.16.5) (2026-03-12)


### Refactoring

* **cli:** rename `vm0 scope` command to `vm0 org` ([#4614](https://github.com/vm0-ai/vm0/issues/4614)) ([8b80a2f](https://github.com/vm0-ai/vm0/commit/8b80a2f80b33301a94cc1da640aeca773b5f1928))

## [2.16.4](https://github.com/vm0-ai/vm0/compare/docs-v2.16.3...docs-v2.16.4) (2026-03-12)


### Refactoring

* remove experimental_mitm and always enable mitm when proxy is active ([#4568](https://github.com/vm0-ai/vm0/issues/4568)) ([34e1257](https://github.com/vm0-ai/vm0/commit/34e1257a96ceb70a50c07fa258a442c940b5ef95))

## [2.16.3](https://github.com/vm0-ai/vm0/compare/docs-v2.16.2...docs-v2.16.3) (2026-03-12)


### Refactoring

* remove proxy rewrite endpoint and seal secrets ([#4539](https://github.com/vm0-ai/vm0/issues/4539)) ([f7af830](https://github.com/vm0-ai/vm0/commit/f7af8301f67b87f4615dad8e9b8a00adb449aeba))

## [2.16.2](https://github.com/vm0-ai/vm0/compare/docs-v2.16.1...docs-v2.16.2) (2026-03-11)


### Bug Fixes

* resolve 6 high dependency vulnerabilities ([#4428](https://github.com/vm0-ai/vm0/issues/4428)) ([052a1e6](https://github.com/vm0-ai/vm0/commit/052a1e6eba0205a3b3a67ef5be6cdeab727a1765)), closes [#4392](https://github.com/vm0-ai/vm0/issues/4392)

## [2.16.1](https://github.com/vm0-ai/vm0/compare/docs-v2.16.0...docs-v2.16.1) (2026-03-11)


### Refactoring

* standardize connector secret names to use token convention ([#4385](https://github.com/vm0-ai/vm0/issues/4385)) ([470101f](https://github.com/vm0-ai/vm0/commit/470101f7612e95e8826653b33df819cf0de49b26))

## [2.16.0](https://github.com/vm0-ai/vm0/compare/docs-v2.15.1...docs-v2.16.0) (2026-03-11)


### Features

* add clickup skill to platform, web, and docs ([#4364](https://github.com/vm0-ai/vm0/issues/4364)) ([6410f37](https://github.com/vm0-ai/vm0/commit/6410f37478b130e54ddfd6cc7397ea9ea6555e81))


### Refactoring

* rename skill references from dev.to/fal.ai to devto/fal ([#4347](https://github.com/vm0-ai/vm0/issues/4347)) ([0b86ca4](https://github.com/vm0-ai/vm0/commit/0b86ca4e3a8aa9ec153c4c15f495450cab027be1))

## [2.15.1](https://github.com/vm0-ai/vm0/compare/docs-v2.15.0...docs-v2.15.1) (2026-03-09)


### Refactoring

* remove self-hosting feature and restore saas-only mode ([#4051](https://github.com/vm0-ai/vm0/issues/4051)) ([5dcac9d](https://github.com/vm0-ai/vm0/commit/5dcac9d3374e78eb263d180faef9ee2909e34dcb))

## [2.15.0](https://github.com/vm0-ai/vm0/compare/docs-v2.14.0...docs-v2.15.0) (2026-03-05)


### Features

* **docs:** add 12 new skill pages and fix naming inconsistencies ([#3740](https://github.com/vm0-ai/vm0/issues/3740)) ([0e1e0ef](https://github.com/vm0-ai/vm0/commit/0e1e0ef5d01359fc1963d75cdf54929b1e23d64b))
* **docs:** add missing environment variables to self-hosting docs ([#3733](https://github.com/vm0-ai/vm0/issues/3733)) ([26d0d3b](https://github.com/vm0-ai/vm0/commit/26d0d3b19005d9234890db133447fc2e3fb421f6))
* **docs:** add missing log command flags to debugging docs ([#3730](https://github.com/vm0-ai/vm0/issues/3730)) ([2cbf9aa](https://github.com/vm0-ai/vm0/commit/2cbf9aadf59aad5bc59757444ee48b36df3c10a0))
* **docs:** add missing options to run-agent documentation ([#3728](https://github.com/vm0-ai/vm0/issues/3728)) ([035a2dd](https://github.com/vm0-ai/vm0/commit/035a2dd38de7c45fbc00283bc6c2a35bf1db7f22))
* **docs:** add process.env fallback and bare skill name syntax ([#3742](https://github.com/vm0-ai/vm0/issues/3742)) ([c300299](https://github.com/vm0-ai/vm0/commit/c300299dbd2020fd9d911cf196e55e7cba8e353a))
* **docs:** fix agent-skills index categorization and skill count ([#3735](https://github.com/vm0-ai/vm0/issues/3735)) ([c2edacb](https://github.com/vm0-ai/vm0/commit/c2edacbf6e994058fd6ad947f09a05ca16bca020))
* **docs:** fix broken internal links and add missing usage cards ([#3726](https://github.com/vm0-ai/vm0/issues/3726)) ([8443784](https://github.com/vm0-ai/vm0/commit/8443784d55a8a718a4bfe768376652113ca695d7))
* **docs:** update CLI reference with missing commands and options ([#3729](https://github.com/vm0-ai/vm0/issues/3729)) ([0f87f88](https://github.com/vm0-ai/vm0/commit/0f87f884a57b748f821b374f4566ce87250db6c2))
* **docs:** update configuration reference with missing fields and fixes ([#3732](https://github.com/vm0-ai/vm0/issues/3732)) ([ac032fb](https://github.com/vm0-ai/vm0/commit/ac032fbf1c8fa61255f0caae831297f0181b8b2f))
* **docs:** update schedule-agent page to match actual cli options ([#3731](https://github.com/vm0-ai/vm0/issues/3731)) ([bf313d1](https://github.com/vm0-ai/vm0/commit/bf313d195c01a34c5781fbb482cb954b76a51ffa))
* **docs:** update z.ai model list with glm-5 and fix casing ([#3727](https://github.com/vm0-ai/vm0/issues/3727)) ([2d84d3c](https://github.com/vm0-ai/vm0/commit/2d84d3c8b35bd03fe83cce335ba76f4805fe235d))

## [2.14.0](https://github.com/vm0-ai/vm0/compare/docs-v2.13.0...docs-v2.14.0) (2026-03-03)


### Features

* **docs:** remove apps field reference from agent anatomy page ([#3479](https://github.com/vm0-ai/vm0/issues/3479)) ([8da5878](https://github.com/vm0-ai/vm0/commit/8da5878599607d61733dceff66666ff25ca8a498))
* **docs:** remove remaining public api v1 references ([#3469](https://github.com/vm0-ai/vm0/issues/3469)) ([d956347](https://github.com/vm0-ai/vm0/commit/d956347feeb87ffb828eedc01e5fc650e074fa9d))

## [2.13.0](https://github.com/vm0-ai/vm0/compare/docs-v2.12.0...docs-v2.13.0) (2026-02-12)


### Features

* **self-host:** add docker compose setup ([#2853](https://github.com/vm0-ai/vm0/issues/2853)) ([bd757fd](https://github.com/vm0-ai/vm0/commit/bd757fd21385dca449e82f6880bc5265dcf1b80d))

## [2.12.0](https://github.com/vm0-ai/vm0/compare/docs-v2.11.0...docs-v2.12.0) (2026-02-12)


### Features

* **docs:** update slack docs and rename ecosystem to integrations ([#2917](https://github.com/vm0-ai/vm0/issues/2917)) ([fe90cd9](https://github.com/vm0-ai/vm0/commit/fe90cd90aa92291fd3f277ca324dd9f43d76b6ac))

## [2.11.0](https://github.com/vm0-ai/vm0/compare/docs-v2.10.1...docs-v2.11.0) (2026-02-10)


### Features

* **docs:** add ecosystem section with slack integration guide ([#2635](https://github.com/vm0-ai/vm0/issues/2635)) ([3a0d45a](https://github.com/vm0-ai/vm0/commit/3a0d45a84e8bc834bb409d39d109e2dd7ef3a844))

## [2.10.1](https://github.com/vm0-ai/vm0/compare/docs-v2.10.0...docs-v2.10.1) (2026-02-06)


### Bug Fixes

* **docs:** update aws bedrock setup guide url ([#2495](https://github.com/vm0-ai/vm0/issues/2495)) ([8026a4a](https://github.com/vm0-ai/vm0/commit/8026a4a185ebea25738d580ebe8cda5ea067d59e))

## [2.10.0](https://github.com/vm0-ai/vm0/compare/docs-v2.9.0...docs-v2.10.0) (2026-02-05)


### Features

* **docs:** refine product philosophy content ([#2399](https://github.com/vm0-ai/vm0/issues/2399)) ([63da522](https://github.com/vm0-ai/vm0/commit/63da5221b8ab9a7076644b34bf17de8b93e6d179))

## [2.9.0](https://github.com/vm0-ai/vm0/compare/docs-v2.8.0...docs-v2.9.0) (2026-02-05)


### Features

* **docs:** update environment variables documentation to reflect current implementation ([#2379](https://github.com/vm0-ai/vm0/issues/2379)) ([f937d73](https://github.com/vm0-ai/vm0/commit/f937d735d7c2fa45a709997cfbe1370d5fb0bbc8))

## [2.8.0](https://github.com/vm0-ai/vm0/compare/docs-v2.7.0...docs-v2.8.0) (2026-02-04)


### Features

* **docs:** rewrite model provider documentation ([#2348](https://github.com/vm0-ai/vm0/issues/2348)) ([32d1517](https://github.com/vm0-ai/vm0/commit/32d1517e3ada7ffb873c92caaafefb59a10d7cca))

## [2.7.0](https://github.com/vm0-ai/vm0/compare/docs-v2.6.0...docs-v2.7.0) (2026-02-03)


### Features

* **docs:** add vibe coder quick start guide ([#2264](https://github.com/vm0-ai/vm0/issues/2264)) ([6cd2131](https://github.com/vm0-ai/vm0/commit/6cd21319aed6424e3888320a9c94aa4dcb28fdc3))

## [2.6.0](https://github.com/vm0-ai/vm0/compare/docs-v2.5.0...docs-v2.6.0) (2026-02-02)


### Features

* **platform:** add plausible analytics integration ([#2150](https://github.com/vm0-ai/vm0/issues/2150)) ([10dae9b](https://github.com/vm0-ai/vm0/commit/10dae9bc2b3e7ec9e8d0544c3b87b05092768920))

## [2.5.0](https://github.com/vm0-ai/vm0/compare/docs-v2.4.0...docs-v2.5.0) (2026-02-01)


### Features

* **cli:** release onboard banner update ([#2084](https://github.com/vm0-ai/vm0/issues/2084)) ([402820c](https://github.com/vm0-ai/vm0/commit/402820cbeabed134c3a757d4c8400037fce4c427))

## [2.4.0](https://github.com/vm0-ai/vm0/compare/docs-v2.3.0...docs-v2.4.0) (2026-01-31)


### Features

* **docs:** add vm0 run list and kill commands to cli reference ([#1974](https://github.com/vm0-ai/vm0/issues/1974)) ([1f92009](https://github.com/vm0-ai/vm0/commit/1f9200928715eef8b990f1bed21c5b892f0aadfb))
* **docs:** move codex documentation to experimental section ([#1979](https://github.com/vm0-ai/vm0/issues/1979)) ([0edf624](https://github.com/vm0-ai/vm0/commit/0edf624fc614e8df1e439f8225c7a8fbbb9cac47))

## [2.3.0](https://github.com/vm0-ai/vm0/compare/docs-v2.2.0...docs-v2.3.0) (2026-01-30)


### Features

* **seo:** enhance seo and social sharing for vm0.ai and docs.vm0.ai ([#1939](https://github.com/vm0-ai/vm0/issues/1939)) ([761fecb](https://github.com/vm0-ai/vm0/commit/761fecb9d3afdbe50b3b8d7b568bc40926db14cf))

## [2.2.0](https://github.com/vm0-ai/vm0/compare/docs-v2.1.1...docs-v2.2.0) (2026-01-29)


### Features

* **cli:** replace embedded vm0-agent-builder with dynamic vm0-cli skill ([#1829](https://github.com/vm0-ai/vm0/issues/1829)) ([9fee458](https://github.com/vm0-ai/vm0/commit/9fee458e618964a31c9653d9fe18548a24a7b210))

## [2.1.1](https://github.com/vm0-ai/vm0/compare/docs-v2.1.0...docs-v2.1.1) (2026-01-28)


### Bug Fixes

* **api:** remove unimplemented filters and fix docs gaps ([#1775](https://github.com/vm0-ai/vm0/issues/1775)) ([ca4a728](https://github.com/vm0-ai/vm0/commit/ca4a72839895235e0b873374909fc4a8de80607a))

## [2.1.0](https://github.com/vm0-ai/vm0/compare/docs-v2.0.0...docs-v2.1.0) (2026-01-28)


### Features

* **cli:** add enable prompt and --enable flag to schedule setup ([#1736](https://github.com/vm0-ai/vm0/issues/1736)) ([43f35b8](https://github.com/vm0-ai/vm0/commit/43f35b8489b8e55b4198616923572c552e85a04a))
* **docs:** fix volume version field requirement in vm0.yaml reference ([#1760](https://github.com/vm0-ai/vm0/issues/1760)) ([6663961](https://github.com/vm0-ai/vm0/commit/6663961abfa9698398695c418ef3eb6fabc73bc8))
* **docs:** rename integration to agent skills and add skills documentation ([#1750](https://github.com/vm0-ai/vm0/issues/1750)) ([6305911](https://github.com/vm0-ai/vm0/commit/63059115b21a1bf3b36579dac9646271c7354d19)), closes [#1748](https://github.com/vm0-ai/vm0/issues/1748)
* **docs:** update cli reference documentation to match current implementation ([#1757](https://github.com/vm0-ai/vm0/issues/1757)) ([4a3146f](https://github.com/vm0-ai/vm0/commit/4a3146fb0d4c66b52cfc786286ba96cdcfcb95f9))
* **platform:** add pagination and search to logs page ([#1751](https://github.com/vm0-ai/vm0/issues/1751)) ([e6b4b1b](https://github.com/vm0-ai/vm0/commit/e6b4b1bdc1f9c10ddab6d67fbc77bef7b294f4c7))

## [2.0.0](https://github.com/vm0-ai/vm0/compare/docs-v1.1.2...docs-v2.0.0) (2026-01-27)


### ⚠ BREAKING CHANGES

* **api:** All Public API v1 endpoints now use camelCase field names instead of snake_case. This affects request bodies, response bodies, and query parameters.

### Bug Fixes

* **docs:** update model-selection documentation for model-provider system ([#1734](https://github.com/vm0-ai/vm0/issues/1734)) ([a49f792](https://github.com/vm0-ai/vm0/commit/a49f792c1a00c89314b5b09e2d5872ddcceebd83)), closes [#1732](https://github.com/vm0-ai/vm0/issues/1732)


### Code Refactoring

* **api:** migrate public API v1 from snake_case to camelCase ([#1730](https://github.com/vm0-ai/vm0/issues/1730)) ([5dfcc28](https://github.com/vm0-ai/vm0/commit/5dfcc28597991f408a33bbd565b6619f47d6b92c))

## [1.1.2](https://github.com/vm0-ai/vm0/compare/docs-v1.1.1...docs-v1.1.2) (2026-01-27)


### Bug Fixes

* **docs:** update scheduling documentation with vm0 schedule command ([#1721](https://github.com/vm0-ai/vm0/issues/1721)) ([b7489e8](https://github.com/vm0-ai/vm0/commit/b7489e81b04e34d11877070cc57e9e95aaf36e33)), closes [#1720](https://github.com/vm0-ai/vm0/issues/1720)

## [1.1.1](https://github.com/vm0-ai/vm0/compare/docs-v1.1.0...docs-v1.1.1) (2026-01-27)


### Bug Fixes

* **docs:** update environment variables to include credentials and fix env-file ([#1714](https://github.com/vm0-ai/vm0/issues/1714)) ([57b91bb](https://github.com/vm0-ai/vm0/commit/57b91bb7d1c26fa63c78b77de26ac9d75b9eafc3)), closes [#1713](https://github.com/vm0-ai/vm0/issues/1713)

## [1.1.0](https://github.com/vm0-ai/vm0/compare/docs-v1.0.0...docs-v1.1.0) (2026-01-27)


### Features

* **docs:** trigger release for documentation updates ([#1697](https://github.com/vm0-ai/vm0/issues/1697)) ([c078287](https://github.com/vm0-ai/vm0/commit/c078287de06336abd3157fcaa056bdedcb47838d))

## [1.0.0](https://github.com/vm0-ai/vm0/compare/docs-v0.21.0...docs-v1.0.0) (2026-01-26)


### ⚠ BREAKING CHANGES

* The vm0 setup-github command has been removed. Users who need GitHub Actions workflows should set them up manually.

### Features

* remove setup-github command ([#1628](https://github.com/vm0-ai/vm0/issues/1628)) ([d82410e](https://github.com/vm0-ai/vm0/commit/d82410edd74e97a3218e30e6b185cd04a853fb91)), closes [#1625](https://github.com/vm0-ai/vm0/issues/1625)

## [0.21.0](https://github.com/vm0-ai/vm0/compare/docs-v0.20.1...docs-v0.21.0) (2026-01-24)


### Features

* **cli:** rename experimental-credential to credential ([#1582](https://github.com/vm0-ai/vm0/issues/1582)) ([499e605](https://github.com/vm0-ai/vm0/commit/499e605c046f7f048c96f3ca6d8b257189aca40c))

## [0.20.1](https://github.com/vm0-ai/vm0/compare/docs-v0.20.0...docs-v0.20.1) (2026-01-23)


### Bug Fixes

* unify terminology from llm to model provider ([#1580](https://github.com/vm0-ai/vm0/issues/1580)) ([dfe6a2c](https://github.com/vm0-ai/vm0/commit/dfe6a2c99f9b8a0de02cb3afc902ae2eb57cefd3))

## [0.20.0](https://github.com/vm0-ai/vm0/compare/docs-v0.19.0...docs-v0.20.0) (2026-01-23)


### Features

* **cli:** improve vm0 init onboarding with model-provider setup ([#1571](https://github.com/vm0-ai/vm0/issues/1571)) ([e4e4c23](https://github.com/vm0-ai/vm0/commit/e4e4c23c7d5681965f573e1795b360b5cc3d07b1))

## [0.19.0](https://github.com/vm0-ai/vm0/compare/docs-v0.18.0...docs-v0.19.0) (2026-01-20)


### Features

* **cli:** rename `vm0 agents` command to `vm0 agent` ([#1299](https://github.com/vm0-ai/vm0/issues/1299)) ([9074358](https://github.com/vm0-ai/vm0/commit/907435824b3210f07bddc59aea1f011112e4d314)), closes [#1297](https://github.com/vm0-ai/vm0/issues/1297)

## [0.18.0](https://github.com/vm0-ai/vm0/compare/docs-v0.17.0...docs-v0.18.0) (2026-01-19)


### Features

* **web:** add instatus status widget to landing page ([#1313](https://github.com/vm0-ai/vm0/issues/1313)) ([be54222](https://github.com/vm0-ai/vm0/commit/be54222b5f11951e1d370da1b63940548867ca58))

## [0.17.0](https://github.com/vm0-ai/vm0/compare/docs-v0.16.3...docs-v0.17.0) (2026-01-15)


### Features

* **docs:** add anthropic api key as optional authentication method ([#1246](https://github.com/vm0-ai/vm0/issues/1246)) ([364ae6d](https://github.com/vm0-ai/vm0/commit/364ae6dba10faa2f80a541011cfb596358f247ac))

## [0.16.3](https://github.com/vm0-ai/vm0/compare/docs-v0.16.2...docs-v0.16.3) (2026-01-13)


### Bug Fixes

* **docs:** trigger production deployment for cli reference updates ([#1173](https://github.com/vm0-ai/vm0/issues/1173)) ([57baf42](https://github.com/vm0-ai/vm0/commit/57baf42d83a19652c9db2881e48f50fd1a0054e6))

## [0.16.2](https://github.com/vm0-ai/vm0/compare/docs-v0.16.1...docs-v0.16.2) (2026-01-13)


### Bug Fixes

* **docs:** trigger production deployment for quick start updates ([#1142](https://github.com/vm0-ai/vm0/issues/1142)) ([f8fb029](https://github.com/vm0-ai/vm0/commit/f8fb029227bfc5151a5af30154a0cfb4bc28b480)), closes [#1118](https://github.com/vm0-ai/vm0/issues/1118)

## [0.16.1](https://github.com/vm0-ai/vm0/compare/docs-v0.16.0...docs-v0.16.1) (2026-01-13)


### Bug Fixes

* **docs:** trigger production deployment for quick start updates ([#1142](https://github.com/vm0-ai/vm0/issues/1142)) ([f8fb029](https://github.com/vm0-ai/vm0/commit/f8fb029227bfc5151a5af30154a0cfb4bc28b480)), closes [#1118](https://github.com/vm0-ai/vm0/issues/1118)

## [0.16.0](https://github.com/vm0-ai/vm0/compare/docs-v0.15.0...docs-v0.16.0) (2026-01-12)


### Features

* optimize skills metadata and documentation ([#1114](https://github.com/vm0-ai/vm0/issues/1114)) ([5babe6e](https://github.com/vm0-ai/vm0/commit/5babe6e74feb42b47db5a21457bda030fb6c7f14))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/docs-v0.14.0...docs-v0.15.0) (2026-01-11)


### Features

* **docs:** add essential SEO configuration ([#1086](https://github.com/vm0-ai/vm0/issues/1086)) ([d6293a1](https://github.com/vm0-ai/vm0/commit/d6293a1fc8a62b8beb5056ac390c2be3b1d1b436)), closes [#1084](https://github.com/vm0-ai/vm0/issues/1084)

## [0.14.0](https://github.com/vm0-ai/vm0/compare/docs-v0.13.10...docs-v0.14.0) (2026-01-10)


### Features

* **docs:** add vm0 public api v1 reference documentation ([#1046](https://github.com/vm0-ai/vm0/issues/1046)) ([5bc813c](https://github.com/vm0-ai/vm0/commit/5bc813cf2dd1c6b9d4ec1567808ab4e175c04e4f))

## [0.13.10](https://github.com/vm0-ai/vm0/compare/docs-v0.13.9...docs-v0.13.10) (2026-01-09)


### Bug Fixes

* **docs:** trigger release for documentation updates ([#993](https://github.com/vm0-ai/vm0/issues/993)) ([1f3e2be](https://github.com/vm0-ai/vm0/commit/1f3e2be18c74219b2954c0d98a6456bf35b055ca))

## [0.13.9](https://github.com/vm0-ai/vm0/compare/docs-v0.13.8...docs-v0.13.9) (2026-01-04)


### Bug Fixes

* **docs:** remove plausibletracker to test automatic spa tracking ([#907](https://github.com/vm0-ai/vm0/issues/907)) ([5609fd1](https://github.com/vm0-ai/vm0/commit/5609fd1b21fa08673b880bc0ee6266a8afdc7673))

## [0.13.8](https://github.com/vm0-ai/vm0/compare/docs-v0.13.7...docs-v0.13.8) (2026-01-04)


### Bug Fixes

* **docs:** use sessionstorage to persist tracking state across remounts ([#905](https://github.com/vm0-ai/vm0/issues/905)) ([7e1b755](https://github.com/vm0-ai/vm0/commit/7e1b75595380ca2498ac4711f1559a04066a37e2))

## [0.13.7](https://github.com/vm0-ai/vm0/compare/docs-v0.13.6...docs-v0.13.7) (2026-01-04)


### Bug Fixes

* **docs:** prevent duplicate pageview on initial page load ([#903](https://github.com/vm0-ai/vm0/issues/903)) ([6304303](https://github.com/vm0-ai/vm0/commit/6304303c414696ba454f7417772b99d635057a00))

## [0.13.6](https://github.com/vm0-ai/vm0/compare/docs-v0.13.5...docs-v0.13.6) (2026-01-04)


### Bug Fixes

* **docs:** remove data-domain to prevent duplicate pageview tracking ([#902](https://github.com/vm0-ai/vm0/issues/902)) ([d07ac1e](https://github.com/vm0-ai/vm0/commit/d07ac1e8a289479bb921105ab91d3e6796128ce6))

## [0.13.5](https://github.com/vm0-ai/vm0/compare/docs-v0.13.4...docs-v0.13.5) (2026-01-04)


### Bug Fixes

* **docs:** prevent plausible duplicate visitor counting ([#898](https://github.com/vm0-ai/vm0/issues/898)) ([0d183ce](https://github.com/vm0-ai/vm0/commit/0d183ce52875f22b954b27448699071030340bd6))

## [0.13.4](https://github.com/vm0-ai/vm0/compare/docs-v0.13.3...docs-v0.13.4) (2026-01-04)


### Bug Fixes

* **docs:** remove plausible.init call to prevent duplicate counting ([#895](https://github.com/vm0-ai/vm0/issues/895)) ([f5ae5d2](https://github.com/vm0-ai/vm0/commit/f5ae5d224ddc4758671ac245e9ac31a87cef8cf9))

## [0.13.3](https://github.com/vm0-ai/vm0/compare/docs-v0.13.2...docs-v0.13.3) (2026-01-04)


### Bug Fixes

* **docs:** add plausible initialization script ([#893](https://github.com/vm0-ai/vm0/issues/893)) ([ed5eb8d](https://github.com/vm0-ai/vm0/commit/ed5eb8d50a2dfcace1174dcf30ab23705a9a68ce))

## [0.13.2](https://github.com/vm0-ai/vm0/compare/docs-v0.13.1...docs-v0.13.2) (2026-01-04)


### Bug Fixes

* **docs:** add function type check for plausible ([#891](https://github.com/vm0-ai/vm0/issues/891)) ([e69ef91](https://github.com/vm0-ai/vm0/commit/e69ef91c9cc7aa0c2d0fe7199699b62013a75927))

## [0.13.1](https://github.com/vm0-ai/vm0/compare/docs-v0.13.0...docs-v0.13.1) (2026-01-04)


### Bug Fixes

* **docs:** skip plausible tracking on initial render ([#888](https://github.com/vm0-ai/vm0/issues/888)) ([ddb11ba](https://github.com/vm0-ai/vm0/commit/ddb11bad167b66563f0fc0b4f12a68aff12f1dea))

## [0.13.0](https://github.com/vm0-ai/vm0/compare/docs-v0.12.0...docs-v0.13.0) (2026-01-04)


### Features

* **docs:** add client-side route tracking for plausible analytics ([#886](https://github.com/vm0-ai/vm0/issues/886)) ([66a4b2a](https://github.com/vm0-ai/vm0/commit/66a4b2a108f9cae937e34cc40af39af4d5af77e3))

## [0.12.0](https://github.com/vm0-ai/vm0/compare/docs-v0.11.2...docs-v0.12.0) (2026-01-04)


### Features

* **docs:** trigger release for product philosophy page ([#884](https://github.com/vm0-ai/vm0/issues/884)) ([45ec3a2](https://github.com/vm0-ai/vm0/commit/45ec3a296b4d4ac01b4ac1f0536692d1626c7551))

## [0.11.2](https://github.com/vm0-ai/vm0/compare/docs-v0.11.1...docs-v0.11.2) (2026-01-04)


### Bug Fixes

* **docs:** use custom Plausible script to match main site ([#878](https://github.com/vm0-ai/vm0/issues/878)) ([be10efe](https://github.com/vm0-ai/vm0/commit/be10efe0bd40e0d2047478174342f133e5b40b31))

## [0.11.1](https://github.com/vm0-ai/vm0/compare/docs-v0.11.0...docs-v0.11.1) (2026-01-04)


### Bug Fixes

* **docs:** change Plausible domain to vm0.ai for unified tracking ([#876](https://github.com/vm0-ai/vm0/issues/876)) ([07d80af](https://github.com/vm0-ai/vm0/commit/07d80af8adf9951ac7e90624cfc49fd5eb263203))

## [0.11.0](https://github.com/vm0-ai/vm0/compare/docs-v0.10.0...docs-v0.11.0) (2026-01-04)


### Features

* add docs analytics and update main site sitemap ([#856](https://github.com/vm0-ai/vm0/issues/856)) ([1c870cd](https://github.com/vm0-ai/vm0/commit/1c870cd44b68a460e55a3248f09003e69ca0ec89))

## [0.10.0](https://github.com/vm0-ai/vm0/compare/docs-v0.9.0...docs-v0.10.0) (2026-01-02)


### Features

* **docs:** add best practices for long-running agents ([#860](https://github.com/vm0-ai/vm0/issues/860)) ([7de2c56](https://github.com/vm0-ai/vm0/commit/7de2c56dfac3e3547d3cd6a4fa0b8c69e36800d2))

## [0.9.0](https://github.com/vm0-ai/vm0/compare/docs-v0.8.0...docs-v0.9.0) (2026-01-01)


### Features

* **docs:** add claude model selection guide as first vendor ([#861](https://github.com/vm0-ai/vm0/issues/861)) ([671c673](https://github.com/vm0-ai/vm0/commit/671c673b5945be439568be261a163b97998fb0d2))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/docs-v0.7.0...docs-v0.8.0) (2025-12-31)


### Features

* **docs:** add deep research agent tutorial series ([#858](https://github.com/vm0-ai/vm0/issues/858)) ([aa53665](https://github.com/vm0-ai/vm0/commit/aa5366513054e5eb33c1e92f69bd7c0956e5e940))

## [0.7.0](https://github.com/vm0-ai/vm0/compare/docs-v0.6.0...docs-v0.7.0) (2025-12-31)


### Features

* **docs:** add api key instructions and reorder providers ([#844](https://github.com/vm0-ai/vm0/issues/844)) ([c156419](https://github.com/vm0-ai/vm0/commit/c1564190c2bf70e9c4949119bdfbe4efe0ba6586))

## [0.6.0](https://github.com/vm0-ai/vm0/compare/docs-v0.5.1...docs-v0.6.0) (2025-12-31)


### Features

* **docs:** highlight skills field in skills.mdx example ([#839](https://github.com/vm0-ai/vm0/issues/839)) ([756fe2f](https://github.com/vm0-ai/vm0/commit/756fe2f9ad0f92f1094fd0aad150e9900ed48295))

## [0.5.1](https://github.com/vm0-ai/vm0/compare/docs-v0.5.0...docs-v0.5.1) (2025-12-31)


### Bug Fixes

* **docs:** align homepage structure with sidebar navigation ([#836](https://github.com/vm0-ai/vm0/issues/836)) ([f112352](https://github.com/vm0-ai/vm0/commit/f112352e0f6569e8f5a435588ba5be04937e3ed6))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/docs-v0.4.1...docs-v0.5.0) (2025-12-31)


### Features

* **docs:** add codex provider info to model selection ([#832](https://github.com/vm0-ai/vm0/issues/832)) ([c0aabb7](https://github.com/vm0-ai/vm0/commit/c0aabb74d37226bdccf855ec33f7d614c50e678b))


### Bug Fixes

* **docs:** fix yaml formatting in volume.mdx ([#835](https://github.com/vm0-ai/vm0/issues/835)) ([30d2c6c](https://github.com/vm0-ai/vm0/commit/30d2c6ca17925c19d5da390692d3f0cce036d05a))

## [0.4.1](https://github.com/vm0-ai/vm0/compare/docs-v0.4.0...docs-v0.4.1) (2025-12-30)


### Bug Fixes

* **docs:** correct model selection link path ([#826](https://github.com/vm0-ai/vm0/issues/826)) ([b72c364](https://github.com/vm0-ai/vm0/commit/b72c364b76cc22a0b0441df8f4f6f608345d66f6))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/docs-v0.3.0...docs-v0.4.0) (2025-12-30)


### Features

* **docs:** flatten quick-start out of introduction folder ([#823](https://github.com/vm0-ai/vm0/issues/823)) ([eb91ce1](https://github.com/vm0-ai/vm0/commit/eb91ce1a68e211dbbcdca6a842a39fce2449c87e))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/docs-v0.2.0...docs-v0.3.0) (2025-12-30)


### Features

* **docs:** restructure documentation with hierarchical navigation ([#811](https://github.com/vm0-ai/vm0/issues/811)) ([5ae6926](https://github.com/vm0-ai/vm0/commit/5ae69267c07d94c3b191be2c95cc8c94fc6a4f75))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/docs-v0.1.4...docs-v0.2.0) (2025-12-30)


### Features

* **docs:** update getting started description ([#807](https://github.com/vm0-ai/vm0/issues/807)) ([42698fd](https://github.com/vm0-ai/vm0/commit/42698fd65eac91a451efe34e02055b3fb0183959))

## [0.1.4](https://github.com/vm0-ai/vm0/compare/docs-v0.1.3...docs-v0.1.4) (2025-12-13)


### Bug Fixes

* **cli:** revert system_prompt and system_skills feature ([#540](https://github.com/vm0-ai/vm0/issues/540)) ([b2254fe](https://github.com/vm0-ai/vm0/commit/b2254fec128a641106aa1db67faac938e39e3b3b))

## [0.1.3](https://github.com/vm0-ai/vm0/compare/docs-v0.1.2...docs-v0.1.3) (2025-12-05)


### Bug Fixes

* patch critical react server components security vulnerability ([#397](https://github.com/vm0-ai/vm0/issues/397)) ([c5d6bb5](https://github.com/vm0-ai/vm0/commit/c5d6bb51e4bb74ed235b687e9fb369e31ca47d8e))

## [0.1.2](https://github.com/vm0-ai/vm0/compare/docs-v0.1.1...docs-v0.1.2) (2025-11-24)


### Bug Fixes

* remove all eslint suppression comments and use vi.stubEnv for tests ([#171](https://github.com/vm0-ai/vm0/issues/171)) ([e210c7c](https://github.com/vm0-ai/vm0/commit/e210c7c0df82e045b3e9103b0bd6dabc28567c12))

## [0.1.1](https://github.com/vm0-ai/vm0/compare/docs-v0.1.0...docs-v0.1.1) (2025-11-15)


### Bug Fixes

* align docs dev port with caddy proxy configuration ([#25](https://github.com/vm0-ai/vm0/issues/25)) ([28a1b74](https://github.com/vm0-ai/vm0/commit/28a1b749b7267446ac4ee0d89c0f4dd49e1f1cff))

## [0.1.0](https://github.com/vm0-ai/vm0/compare/docs-v0.0.1...docs-v0.1.0) (2025-11-15)


### Features

* initial project setup from makita template ([e9c330a](https://github.com/vm0-ai/vm0/commit/e9c330a5952526d657f245e8db9522de553018b3))

## 1.0.0 (2025-08-30)


### Features

* implement centralized API contract system ([#13](https://github.com/e7h4n/vm0/issues/13)) ([77bbbd9](https://github.com/e7h4n/vm0/commit/77bbbd913b52341a7720e9bb711d889253d9681a))
* initial commit - app template with turborepo monorepo structure ([4123914](https://github.com/e7h4n/vm0/commit/41239143cdaea284f55a02c89fde348c2e3b53ff))
* integrate Fumadocs for documentation site ([#6](https://github.com/e7h4n/vm0/issues/6)) ([918978a](https://github.com/e7h4n/vm0/commit/918978af3d201e5c15b34c525a5406d46ccc66ab))


### Bug Fixes

* resolve vercel build issues for docs app and update CI for multi-project deployments ([#9](https://github.com/e7h4n/vm0/issues/9)) ([5e1b20b](https://github.com/e7h4n/vm0/commit/5e1b20ba8776542e5c51bb37a2e36c5feed4856d))

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
