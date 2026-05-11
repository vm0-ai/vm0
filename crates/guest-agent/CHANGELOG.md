# Changelog

## [0.30.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.29.1...guest-agent-v0.30.0) (2026-05-11)


### Features

* enable Codex memory mounting ([#12651](https://github.com/vm0-ai/vm0/issues/12651)) ([3646b72](https://github.com/vm0-ai/vm0/commit/3646b72ccafa675ff53895f797a99a1e754fd82e))

## [0.29.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.29.0...guest-agent-v0.29.1) (2026-05-09)


### Bug Fixes

* **guest-agent:** gate claude code event handling ([#12327](https://github.com/vm0-ai/vm0/issues/12327)) ([94a7634](https://github.com/vm0-ai/vm0/commit/94a7634254d9445f04bb3456d5c28e67bd15e189))

## [0.29.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.4...guest-agent-v0.29.0) (2026-05-09)


### Features

* **guest-agent:** record last event to cli exit metric ([#12272](https://github.com/vm0-ai/vm0/issues/12272)) ([dce7e82](https://github.com/vm0-ai/vm0/commit/dce7e82908b8bf8f5aff511a7995c0f8e20e66a5))

## [0.28.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.3...guest-agent-v0.28.4) (2026-05-09)

## [0.28.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.2...guest-agent-v0.28.3) (2026-05-08)


### Bug Fixes

* **cli:** drain terminal run events ([#12154](https://github.com/vm0-ai/vm0/issues/12154)) ([1795a3c](https://github.com/vm0-ai/vm0/commit/1795a3c1a08f1337aa47ce95495bcac472a11d83))

## [0.28.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.1...guest-agent-v0.28.2) (2026-05-08)


### Bug Fixes

* restore codex sessions as jsonl ([#12137](https://github.com/vm0-ai/vm0/issues/12137)) ([ab3dc5b](https://github.com/vm0-ai/vm0/commit/ab3dc5b5f35105709cc22d7caf9e571c59ec5a39))

## [0.28.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.28.0...guest-agent-v0.28.1) (2026-05-07)


### Bug Fixes

* preserve real codex stderr through complete + telemetry pipelines ([#12082](https://github.com/vm0-ai/vm0/issues/12082)) ([748c737](https://github.com/vm0-ai/vm0/commit/748c737a1622716107888dcd228c4eccb29bc6c1))

## [0.28.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.27.1...guest-agent-v0.28.0) (2026-05-07)


### Features

* pass codex append prompt as developer instructions ([#12063](https://github.com/vm0-ai/vm0/issues/12063)) ([8fb02a3](https://github.com/vm0-ai/vm0/commit/8fb02a3feab159db1fe5dfd35a50c481d267193b))


### Bug Fixes

* use lowercase codex auth mode ([#12075](https://github.com/vm0-ai/vm0/issues/12075)) ([0a1770e](https://github.com/vm0-ai/vm0/commit/0a1770e7b9cd27c298351c611b274c054dad8cd4))

## [0.27.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.27.0...guest-agent-v0.27.1) (2026-05-06)


### Bug Fixes

* **guest-agent:** checkpoint recoverable abnormal exits ([#11984](https://github.com/vm0-ai/vm0/issues/11984)) ([f4621f4](https://github.com/vm0-ai/vm0/commit/f4621f40f47229f364e0f82a2ca3b4a49b15b15c))


### Refactoring

* **guest-agent:** initialize http client explicitly ([#11966](https://github.com/vm0-ai/vm0/issues/11966)) ([d0984f2](https://github.com/vm0-ai/vm0/commit/d0984f2d66307cfd54320e117723e7a3cfdd77ab))
* rename chatgpt-oauth-token to codex-oauth-token ([#11990](https://github.com/vm0-ai/vm0/issues/11990)) ([0659786](https://github.com/vm0-ai/vm0/commit/06597865f129656105438bc99d4d308b6c9942b7))

## [0.27.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.5...guest-agent-v0.27.0) (2026-05-06)


### Features

* **guest-agent:** bootstrap codex chatgpt-oauth mode via fabricated auth.json ([#11881](https://github.com/vm0-ai/vm0/issues/11881)) ([d7f8127](https://github.com/vm0-ai/vm0/commit/d7f81275af55020f7de7d54a432e2d80b6a62902))

## [0.26.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.4...guest-agent-v0.26.5) (2026-05-05)

## [0.26.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.3...guest-agent-v0.26.4) (2026-05-03)


### Documentation

* document guest agent error variants ([#11735](https://github.com/vm0-ai/vm0/issues/11735)) ([5582bd2](https://github.com/vm0-ai/vm0/commit/5582bd29e15032f24f1f755a407c7824a276356d))

## [0.26.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.2...guest-agent-v0.26.3) (2026-05-03)


### Bug Fixes

* **guest-agent:** escalate forced CLI termination ([#11698](https://github.com/vm0-ai/vm0/issues/11698)) ([ad07a39](https://github.com/vm0-ai/vm0/commit/ad07a39afca3122eb73bd9092a48cbdd07d33766))


### Documentation

* **guest-agent:** document artifact env fields ([#11700](https://github.com/vm0-ai/vm0/issues/11700)) ([4fa1127](https://github.com/vm0-ai/vm0/commit/4fa1127ab2e5c189609a05e49abfd9130c6b2df8))
* **guest-agent:** document env accessors ([#11713](https://github.com/vm0-ai/vm0/issues/11713)) ([cd72661](https://github.com/vm0-ai/vm0/commit/cd726614df33729c72f601e73357ee31b3fa948e))

## [0.26.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.1...guest-agent-v0.26.2) (2026-05-01)


### Refactoring

* remove redundant createRuntimeRef ([#11668](https://github.com/vm0-ai/vm0/issues/11668)) ([f70aca2](https://github.com/vm0-ai/vm0/commit/f70aca26197cc09b2083496dfdad75287d448635))

## [0.26.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.26.0...guest-agent-v0.26.1) (2026-04-29)


### Bug Fixes

* **guest-agent:** disable claude background tasks ([#11533](https://github.com/vm0-ai/vm0/issues/11533)) ([1d85fa1](https://github.com/vm0-ai/vm0/commit/1d85fa121e26773eb1cf44b8d3f57cbf7e62c687))

## [0.26.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.25.0...guest-agent-v0.26.0) (2026-04-29)


### Features

* **api-contracts:** add rust dto generation for storage webhooks ([#11450](https://github.com/vm0-ai/vm0/issues/11450)) ([5e42002](https://github.com/vm0-ai/vm0/commit/5e42002fa5ed4aede5e0e4399913d8e0c6f51f8d))

## [0.25.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.8...guest-agent-v0.25.0) (2026-04-28)


### Features

* **guest-agent:** codex command path + framework dispatch ([#11423](https://github.com/vm0-ai/vm0/issues/11423)) ([520e73c](https://github.com/vm0-ai/vm0/commit/520e73c1e0a1d15cddd096bd3f0f7c0746605e05))
* **guest-agent:** codex session resume + checkpoint scan ([#11430](https://github.com/vm0-ai/vm0/issues/11430)) ([fd267b5](https://github.com/vm0-ai/vm0/commit/fd267b568eb9ae86b9f55d8357e486ed67285486))

## [0.24.8](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.7...guest-agent-v0.24.8) (2026-04-28)


### Refactoring

* deduplicate guest-agent http retries ([#11368](https://github.com/vm0-ai/vm0/issues/11368)) ([8c230e1](https://github.com/vm0-ai/vm0/commit/8c230e15592fd65892932a8b1bbffcc67562dfa1))

## [0.24.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.6...guest-agent-v0.24.7) (2026-04-27)


### Refactoring

* centralize guest system log path ([#11246](https://github.com/vm0-ai/vm0/issues/11246)) ([b93fc42](https://github.com/vm0-ai/vm0/commit/b93fc42833815fd843f073044b4e872505812025))

## [0.24.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.5...guest-agent-v0.24.6) (2026-04-27)

## [0.24.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.4...guest-agent-v0.24.5) (2026-04-27)


### Bug Fixes

* **guest-agent:** build artifact archives in-process ([#11216](https://github.com/vm0-ai/vm0/issues/11216)) ([d84a024](https://github.com/vm0-ai/vm0/commit/d84a0246d700a713c508ae5bee995131054127f9))
* **guest-agent:** delay initial telemetry tick ([#11235](https://github.com/vm0-ai/vm0/issues/11235)) ([fb8c855](https://github.com/vm0-ai/vm0/commit/fb8c855026c6fb160604f52846af7453db5f85f5))

## [0.24.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.3...guest-agent-v0.24.4) (2026-04-26)


### Bug Fixes

* **guest-agent:** reduce streaming upload allocations ([#11156](https://github.com/vm0-ai/vm0/issues/11156)) ([53cc666](https://github.com/vm0-ai/vm0/commit/53cc6663c89c41a50a754e34237ccf3eb61b0f27))
* stabilize run stdout event visibility ([#11149](https://github.com/vm0-ai/vm0/issues/11149)) ([479c57e](https://github.com/vm0-ai/vm0/commit/479c57e06f22ef706e3be087a21c4a7588bbea38))

## [0.24.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.2...guest-agent-v0.24.3) (2026-04-25)


### Refactoring

* **guest-agent:** serialize telemetry uploads via single-writer actor ([#11100](https://github.com/vm0-ai/vm0/issues/11100)) ([1a0a747](https://github.com/vm0-ai/vm0/commit/1a0a747d479e73676a87bb1cdeffaf844ebde3f4))

## [0.24.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.1...guest-agent-v0.24.2) (2026-04-24)


### Refactoring

* **guest-agent:** replace telemetry bool flag with an upload-mode enum ([#11030](https://github.com/vm0-ai/vm0/issues/11030)) ([93bbb5f](https://github.com/vm0-ai/vm0/commit/93bbb5fdf5c90d8b4fa04b986a4ae4d25143abfc))

## [0.24.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.24.0...guest-agent-v0.24.1) (2026-04-24)


### Bug Fixes

* **guest-agent:** align telemetry reads to newline boundary ([#11026](https://github.com/vm0-ai/vm0/issues/11026)) ([df5532c](https://github.com/vm0-ai/vm0/commit/df5532cadc03d52337bbccbba519f1ea20702e78))


### Performance Improvements

* **guest-agent:** skip vas snapshot for unchanged artifacts (part 2 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10989](https://github.com/vm0-ai/vm0/issues/10989)) ([4d4b18e](https://github.com/vm0-ai/vm0/commit/4d4b18ede0f7f13c767cb8d50726d9ea1e69c780))

## [0.24.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.23.1...guest-agent-v0.24.0) (2026-04-24)


### Features

* thread storage id from web to guest-agent (part 1 of [#10967](https://github.com/vm0-ai/vm0/issues/10967)) ([#10978](https://github.com/vm0-ai/vm0/issues/10978)) ([85f2193](https://github.com/vm0-ai/vm0/commit/85f219383d3cf7b81ca6f41358276d5388acb8c0))

## [0.23.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.23.0...guest-agent-v0.23.1) (2026-04-24)


### Performance Improvements

* **guest-agent:** parallelize session history upload and artifact snapshot ([#10962](https://github.com/vm0-ai/vm0/issues/10962)) ([27718e3](https://github.com/vm0-ai/vm0/commit/27718e39c2ff1870502dae16d72fc711c13a2cf0))

## [0.23.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.3...guest-agent-v0.23.0) (2026-04-24)


### Features

* **guest-agent:** emit mount path in artifact snapshots ([#10924](https://github.com/vm0-ai/vm0/issues/10924)) ([0db3944](https://github.com/vm0-ai/vm0/commit/0db3944a3291367d1324eba0a9101036ec58927f)), closes [#10911](https://github.com/vm0-ai/vm0/issues/10911) [#10906](https://github.com/vm0-ai/vm0/issues/10906)

## [0.22.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.2...guest-agent-v0.22.3) (2026-04-23)


### Bug Fixes

* **guest-agent:** reap cli process group after type=result ([#10879](https://github.com/vm0-ai/vm0/issues/10879)) ([#10897](https://github.com/vm0-ai/vm0/issues/10897)) ([1ac27f9](https://github.com/vm0-ai/vm0/commit/1ac27f9884d00d01ef072bef59c4b5389c053d1a))

## [0.22.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.1...guest-agent-v0.22.2) (2026-04-23)


### Performance Improvements

* **runner:** post /complete from guest-agent after checkpoint lands ([#10787](https://github.com/vm0-ai/vm0/issues/10787)) ([69e00f0](https://github.com/vm0-ai/vm0/commit/69e00f0540348aaab547b13c7533bd97af88ad23))

## [0.22.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.22.0...guest-agent-v0.22.1) (2026-04-22)


### Refactoring

* drop residual memory plumbing, legacy snapshot columns, and vm0 memory cli ([#10707](https://github.com/vm0-ai/vm0/issues/10707)) ([08f3ce8](https://github.com/vm0-ai/vm0/commit/08f3ce81273faf8ea7e2e4df67b69e774bcb963e))
* emit memory as artifacts[] entry and delete guest-agent symlink bootstrap ([#10700](https://github.com/vm0-ai/vm0/issues/10700)) ([e3f0120](https://github.com/vm0-ai/vm0/commit/e3f0120fbd90d9b9fb750e13440a9f21ea809d3a))
* **guest-agent:** simplify checkpoint session-read error handling ([#10710](https://github.com/vm0-ai/vm0/issues/10710)) ([ad9ee70](https://github.com/vm0-ai/vm0/commit/ad9ee701531c25c4ad3e7285e5a5a0d07d9d1431))

## [0.22.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.7...guest-agent-v0.22.0) (2026-04-22)


### Features

* multi-mount artifact backend + checkpoint schema ([#10629](https://github.com/vm0-ai/vm0/issues/10629)) ([0f8af96](https://github.com/vm0-ai/vm0/commit/0f8af96cd55dedd89534ff430765cc34661a55fc))

## [0.21.7](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.6...guest-agent-v0.21.7) (2026-04-22)


### Bug Fixes

* skip auto-focus on touch devices in ZeroChatComposer ([#10496](https://github.com/vm0-ai/vm0/issues/10496)) ([2c90017](https://github.com/vm0-ai/vm0/commit/2c90017ef46dae13b52426038025e22bb9cc9f88))

## [0.21.6](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.5...guest-agent-v0.21.6) (2026-04-21)


### Bug Fixes

* **guest-agent:** bump stuck tool timeout from 60s to 180s ([#10453](https://github.com/vm0-ai/vm0/issues/10453)) ([ef2e832](https://github.com/vm0-ai/vm0/commit/ef2e832e15813203614c4a754dc67e3033fdb4bb)), closes [#10450](https://github.com/vm0-ai/vm0/issues/10450)

## [0.21.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.4...guest-agent-v0.21.5) (2026-04-19)


### Bug Fixes

* **guest-agent:** fail fast on empty session id before checkpoint ([#10147](https://github.com/vm0-ai/vm0/issues/10147)) ([42746f0](https://github.com/vm0-ai/vm0/commit/42746f0899575f43a1d9ec411c50feda29c24be6))
* **guest-agent:** record per-op durations for checkpoint session reads ([#10141](https://github.com/vm0-ai/vm0/issues/10141)) ([10d5a57](https://github.com/vm0-ai/vm0/commit/10d5a572e7cce65a0ac65fc3776626a1849ea6ff))

## [0.21.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.3...guest-agent-v0.21.4) (2026-04-18)


### Performance Improvements

* **guest-agent:** parallelize final telemetry upload with checkpoint ([#9894](https://github.com/vm0-ai/vm0/issues/9894)) ([d799d98](https://github.com/vm0-ai/vm0/commit/d799d981f153f4d09cabe60faae8fbc30e4732d3))
* **guest-agent:** skip storages api when memory unchanged since boot ([#9921](https://github.com/vm0-ai/vm0/issues/9921)) ([e33ec2c](https://github.com/vm0-ai/vm0/commit/e33ec2c6faf747b3d1e6c68796d35f501c4bc218))

## [0.21.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.2...guest-agent-v0.21.3) (2026-04-17)


### Bug Fixes

* **guest-agent:** mask substring secrets with aho-corasick leftmost-longest ([#9808](https://github.com/vm0-ai/vm0/issues/9808)) ([f1bcd8e](https://github.com/vm0-ai/vm0/commit/f1bcd8e1c61880d22e83f3cdf328318810f4123f))

## [0.21.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.1...guest-agent-v0.21.2) (2026-04-13)


### Performance Improvements

* **guest-agent:** stream artifact upload instead of buffering entire file ([#9043](https://github.com/vm0-ai/vm0/issues/9043)) ([fb0506b](https://github.com/vm0-ai/vm0/commit/fb0506b3df97f90fc8d01e2e522c0e44aad6c856))

## [0.21.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.21.0...guest-agent-v0.21.1) (2026-04-12)


### Bug Fixes

* **guest-agent:** add stdout drain deadline to prevent hanging on orphaned pipes ([#8980](https://github.com/vm0-ai/vm0/issues/8980)) ([8c7b8f1](https://github.com/vm0-ai/vm0/commit/8c7b8f15ea74fd95542568f15f6f0d0f7a9a0812))
* **guest-agent:** terminate heartbeat loop after consecutive failures ([#8992](https://github.com/vm0-ai/vm0/issues/8992)) ([1c6b658](https://github.com/vm0-ai/vm0/commit/1c6b6588ed2c6e0ccebd2ed30dd28ff09a2ed873))

## [0.21.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.20.0...guest-agent-v0.21.0) (2026-04-10)


### Features

* **runner:** pass feature switch states through execution context ([#8778](https://github.com/vm0-ai/vm0/issues/8778)) ([edbe85c](https://github.com/vm0-ai/vm0/commit/edbe85ca3f0fb81821aeeb609a0a700fcbd137e8))


### Bug Fixes

* **runner:** address feature switch review findings ([#8801](https://github.com/vm0-ai/vm0/issues/8801)) ([ae7eaba](https://github.com/vm0-ai/vm0/commit/ae7eabad66b72d38d16a4a01b97437bd5d962b3b))

## [0.20.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.5...guest-agent-v0.20.0) (2026-04-09)


### Features

* **phone:** add webhook signature verification for call_ended events ([#8624](https://github.com/vm0-ai/vm0/issues/8624)) ([528e8a4](https://github.com/vm0-ai/vm0/commit/528e8a45c50588c98eb49b996f7846af56437842))

## [0.19.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.4...guest-agent-v0.19.5) (2026-04-08)


### Bug Fixes

* **checkpoint:** use presigned url for session history upload ([#8445](https://github.com/vm0-ai/vm0/issues/8445)) ([4a019bb](https://github.com/vm0-ai/vm0/commit/4a019bb53dc2323e2981f74d02e78f4eaf2e185c))

## [0.19.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.3...guest-agent-v0.19.4) (2026-03-31)


### Bug Fixes

* **guest-agent:** use explicit file list for tar to match manifest ([#7311](https://github.com/vm0-ai/vm0/issues/7311)) ([448f019](https://github.com/vm0-ai/vm0/commit/448f019d2ad0f2e061d6e924e31567dc02f36bfd))

## [0.19.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.2...guest-agent-v0.19.3) (2026-03-29)


### Bug Fixes

* **crates:** update sha2/hmac usage for digest 0.11 compatibility ([#7101](https://github.com/vm0-ai/vm0/issues/7101)) ([cbded46](https://github.com/vm0-ai/vm0/commit/cbded46e78c8d3ed060e96f79f15cd38ee1cf9dc))

## [0.19.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.1...guest-agent-v0.19.2) (2026-03-23)


### Bug Fixes

* use file_type() in walk_dir to avoid following symlinks ([#6184](https://github.com/vm0-ai/vm0/issues/6184)) ([b173f34](https://github.com/vm0-ai/vm0/commit/b173f34e8ed4edaf6bc169c8e18c9462c6aaa789))

## [0.19.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.19.0...guest-agent-v0.19.1) (2026-03-21)


### Bug Fixes

* **guest-agent:** add -- separator to prevent variadic flags from swallowing prompt ([#5789](https://github.com/vm0-ai/vm0/issues/5789)) ([b9b2fab](https://github.com/vm0-ai/vm0/commit/b9b2fabe509046af54776cb540b71deee0653c11))

## [0.19.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.18.0...guest-agent-v0.19.0) (2026-03-20)


### Features

* support --settings flag for vm0 run ([#5663](https://github.com/vm0-ai/vm0/issues/5663)) ([#5753](https://github.com/vm0-ai/vm0/issues/5753)) ([d0aad87](https://github.com/vm0-ai/vm0/commit/d0aad87539c31ae4664d41b1cca46b556b3de66e))
* support --tools cli parameter across full pipeline ([#5752](https://github.com/vm0-ai/vm0/issues/5752)) ([b0cf364](https://github.com/vm0-ai/vm0/commit/b0cf364a8598dcd36ed1a6ffffdb8c1e03d1841c))

## [0.18.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.17.0...guest-agent-v0.18.0) (2026-03-19)


### Features

* add storage version lineage table for artifact/memory parent tracking ([#5501](https://github.com/vm0-ai/vm0/issues/5501)) ([c2b3115](https://github.com/vm0-ai/vm0/commit/c2b311506f65889215730b27a4ad0d244c651747))
* **runner:** pass disallowed tools from execution context to claude cli ([#5577](https://github.com/vm0-ai/vm0/issues/5577)) ([cdc557a](https://github.com/vm0-ai/vm0/commit/cdc557a4ccb873b37b5df3cc3eb550d6f0849e79)), closes [#5564](https://github.com/vm0-ai/vm0/issues/5564)

## [0.17.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.4...guest-agent-v0.17.0) (2026-03-18)


### Features

* add append-system-prompt support to runner and guest-agent ([#5384](https://github.com/vm0-ai/vm0/issues/5384)) ([37aaa76](https://github.com/vm0-ai/vm0/commit/37aaa76b7acdf8c24f2928590de54317870c3a21)), closes [#5375](https://github.com/vm0-ai/vm0/issues/5375)

## [0.16.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.3...guest-agent-v0.16.4) (2026-03-17)


### Refactoring

* **rust:** replace inline crate:: paths with top-level use imports ([#5061](https://github.com/vm0-ai/vm0/issues/5061)) ([149aaa0](https://github.com/vm0-ai/vm0/commit/149aaa09ca2bf69ffb1bc35471ba813e5884e534)), closes [#5038](https://github.com/vm0-ai/vm0/issues/5038)

## [0.16.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.2...guest-agent-v0.16.3) (2026-03-15)


### Bug Fixes

* **guest-agent:** add stuck-tool watchdog for claude code network tool hang ([#4833](https://github.com/vm0-ai/vm0/issues/4833)) ([7b71fa7](https://github.com/vm0-ai/vm0/commit/7b71fa78f9d7155f08059118391416ecf785027f)), closes [#4785](https://github.com/vm0-ai/vm0/issues/4785)

## [0.16.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.1...guest-agent-v0.16.2) (2026-03-12)


### Bug Fixes

* add explicit file size limits to storage upload handlers ([#4586](https://github.com/vm0-ai/vm0/issues/4586)) ([d899fdb](https://github.com/vm0-ai/vm0/commit/d899fdbc23a30b5e586fa0755a22f0c4d6826d8b)), closes [#4576](https://github.com/vm0-ai/vm0/issues/4576)

## [0.16.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.16.0...guest-agent-v0.16.1) (2026-03-10)


### Bug Fixes

* skip retry on non-retriable 4xx errors in guest-agent ([#4121](https://github.com/vm0-ai/vm0/issues/4121)) ([713b5df](https://github.com/vm0-ai/vm0/commit/713b5df9ee89a7f893bae3940c7895dd3f24b4d7))

## [0.16.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.15.1...guest-agent-v0.16.0) (2026-03-08)


### Features

* **sandbox:** symlink vm0 memory to claude code auto-memory path ([#3928](https://github.com/vm0-ai/vm0/issues/3928)) ([9aaf0e4](https://github.com/vm0-ai/vm0/commit/9aaf0e4fc8a3b530693e939307b86e9db6514fef))


### Bug Fixes

* **guest-agent:** switch cpu measurement to delta-based tracking ([#3918](https://github.com/vm0-ai/vm0/issues/3918)) ([7adfee2](https://github.com/vm0-ai/vm0/commit/7adfee2664f408fe0b3a51e41aeafcf6293d7477))

## [0.15.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.15.0...guest-agent-v0.15.1) (2026-03-07)


### Bug Fixes

* use correct storage type in memory dedup path and propagate checkpoint errors ([#3906](https://github.com/vm0-ai/vm0/issues/3906)) ([9abe586](https://github.com/vm0-ai/vm0/commit/9abe586d92126cef4fc9f7c2fa4319c7448e86dd))

## [0.15.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.14.1...guest-agent-v0.15.0) (2026-03-07)


### Features

* add --memory flag for agent long-term memory ([#3424](https://github.com/vm0-ai/vm0/issues/3424)) ([9e0279f](https://github.com/vm0-ai/vm0/commit/9e0279f618efe5396dda9e1aaac43a72bba70bfe))


### Bug Fixes

* **guest-agent:** decouple event sending from stdout reading loop ([#3884](https://github.com/vm0-ai/vm0/issues/3884)) ([c27e8a1](https://github.com/vm0-ai/vm0/commit/c27e8a1daf8447b317aba356d127fdc9405a84d0))

## [0.14.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.14.0...guest-agent-v0.14.1) (2026-03-07)


### Bug Fixes

* **guest-agent:** defer event sends during stdout drain to prevent drops ([#3859](https://github.com/vm0-ai/vm0/issues/3859)) ([843fda1](https://github.com/vm0-ai/vm0/commit/843fda1a212d53ea424c2d28a09e8d7b09c2a5a7))

## [0.14.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.13.0...guest-agent-v0.14.0) (2026-03-04)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.13.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.3...guest-agent-v0.13.0) (2026-03-03)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.2...guest-agent-v0.12.3) (2026-03-02)


### Bug Fixes

* **guest-agent:** detect cli process exit to prevent hanging on orphaned pipes ([#3409](https://github.com/vm0-ai/vm0/issues/3409)) ([2381c50](https://github.com/vm0-ai/vm0/commit/2381c50ef76c889e8ab03ee37c994950fd0bd9e3))
* **guest-agent:** only set claude-specific env vars for claude-code cli ([#3416](https://github.com/vm0-ai/vm0/issues/3416)) ([df3f92c](https://github.com/vm0-ai/vm0/commit/df3f92cff9611b017b04d6adfc5a1d43d36376ee))


### Performance Improvements

* **guest-agent:** disable non-essential cli network traffic on startup ([#3407](https://github.com/vm0-ai/vm0/issues/3407)) ([4b45f77](https://github.com/vm0-ai/vm0/commit/4b45f773632adbb1d3323eeab7e7a4c95506842b))

## [0.12.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.1...guest-agent-v0.12.2) (2026-03-02)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.12.0...guest-agent-v0.12.1) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.12.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.11.0...guest-agent-v0.12.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.11.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.10.0...guest-agent-v0.11.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.10.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.9.0...guest-agent-v0.10.0) (2026-03-01)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.9.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.5...guest-agent-v0.9.0) (2026-03-01)


### Performance Improvements

* **guest-agent:** pre-warm dns cache before cli spawn ([#3298](https://github.com/vm0-ai/vm0/issues/3298)) ([b3e3fb2](https://github.com/vm0-ai/vm0/commit/b3e3fb268df1e3a3570070d81be3c6506277ed2d))

## [0.8.5](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.4...guest-agent-v0.8.5) (2026-02-28)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.4](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.3...guest-agent-v0.8.4) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.3](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.2...guest-agent-v0.8.3) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.2](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.1...guest-agent-v0.8.2) (2026-02-27)


### Miscellaneous Chores

* **guest-agent:** Synchronize runner-guest versions

## [0.8.1](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.8.0...guest-agent-v0.8.1) (2026-02-26)


### Performance Improvements

* **sandbox-fc:** enable v8 compile cache for faster cli cold start ([#3267](https://github.com/vm0-ai/vm0/issues/3267)) ([6f1c8be](https://github.com/vm0-ai/vm0/commit/6f1c8be89cd5c7168326b5fa822d26eb2f9fa824))

## [0.8.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.7.0...guest-agent-v0.8.0) (2026-02-25)


### Features

* add intermediate e2e telemetry metrics for cli cold-start diagnosis ([#3251](https://github.com/vm0-ai/vm0/issues/3251)) ([82121a9](https://github.com/vm0-ai/vm0/commit/82121a93edcca096cacc787283edbc7275b88f42)), closes [#3250](https://github.com/vm0-ai/vm0/issues/3250)

## [0.7.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.6.0...guest-agent-v0.7.0) (2026-02-25)


### Features

* **guest-agent:** add api_to_cli_init telemetry metric ([#3245](https://github.com/vm0-ai/vm0/issues/3245)) ([b1f78b6](https://github.com/vm0-ai/vm0/commit/b1f78b63fbf1da80dd37ee92c3602319cfd1ecdc)), closes [#3244](https://github.com/vm0-ai/vm0/issues/3244)

## [0.6.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.5.0...guest-agent-v0.6.0) (2026-02-23)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.5.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.4.0...guest-agent-v0.5.0) (2026-02-23)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.4.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.3.0...guest-agent-v0.4.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.3.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.2.0...guest-agent-v0.3.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))

## [0.2.0](https://github.com/vm0-ai/vm0/compare/guest-agent-v0.1.0...guest-agent-v0.2.0) (2026-02-22)


### Features

* **guest-agent:** implement rust guest-agent crate ([#2759](https://github.com/vm0-ai/vm0/issues/2759)) ([8a91042](https://github.com/vm0-ai/vm0/commit/8a910429b6adb47c86659638e69f5a6d024e4851))
* **guest-mock-claude:** add rust mock-claude binary for firecracker vms ([#2783](https://github.com/vm0-ai/vm0/issues/2783)) ([d06b37a](https://github.com/vm0-ai/vm0/commit/d06b37a3c19449f049c83cf32b690bf40c6f77a5))


### Bug Fixes

* **crates:** remove dead code and fix type inconsistency ([#2826](https://github.com/vm0-ai/vm0/issues/2826)) ([63b19d5](https://github.com/vm0-ai/vm0/commit/63b19d57ed29dfbf8c1b3c79a43bc1ebf6a94d96))
* **guest-agent:** add tests and document review followup items ([#2775](https://github.com/vm0-ai/vm0/issues/2775)) ([4c85ea2](https://github.com/vm0-ai/vm0/commit/4c85ea2a731047c6ec459718362aa22a71ab3673))
* **guest-agent:** skip api calls in local provider mode ([#3164](https://github.com/vm0-ai/vm0/issues/3164)) ([6d6d7cd](https://github.com/vm0-ai/vm0/commit/6d6d7cd1423fa59a69ba651a4d32763bca8cfffe))
* **runner:** make runner sole reporter of job completion ([#2852](https://github.com/vm0-ai/vm0/issues/2852)) ([807e2f9](https://github.com/vm0-ai/vm0/commit/807e2f9489ff4780eb3ff235d0eac2baae1b37d1))
