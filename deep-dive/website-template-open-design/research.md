# Website template / Open Design deep-dive

研究日期：2026-07-27（Asia/Shanghai）
仓库：`vm0-ai/vm0` 现状基线：`a83e05312bcbce673289958ecb8e684f130fd691`（`main`，工作树干净）

## 1. 研究阶段代码事实（实现前）

### Website picker catalog

- `turbo/packages/core/src/website-template-items.ts:15-18` 将 website picker 描述为由 vm0 私有 R2 package 支撑的 curated catalog。
- 当前 picker 有 11 个 `WEBSITE_TEMPLATE_ITEMS`，定义在同文件 `:20-175`：`black-slabs`、`blueprint-grid`、`coastal-hotel`、`dot-matrix`、`frame-stack`、`frosted-scatter`、`gallery-wall`、`glass-bloom`、`serif-stack`、`sticker-pop`、`warm-cards`。
- 这些 item 都带有 website picker id、`template:<slug>` / resource id、静态 preview URL、`target: "website"`。它们的描述集中在 editorial、hospitality、art-forward、glassmorphism、playful、brand studio 等网站表面，代码中没有 docs、blog、dashboard 或通用 HTML 的 picker item（同文件 `:20-175`）。
- Platform template picker 直接把 `WEBSITE_TEMPLATE_ITEMS` 赋给 website grid（`turbo/apps/platform/src/views/zero-page/zero-chat-composer.tsx:4699-4703`），website card 的选择会生成 `{ type: "website", selection: { websiteTemplateId: item.id } }`（同文件 `:4774-4777`、`:1045-1051`）。

### Registry and package separation

- 资源 registry 的上游仍然是 `nexu-io/open-design`，但 vm0 固定在 commit `3fb620af423534643677c7c6fae76be088fa770a`（`turbo/packages/core/src/resource-registry.ts:107-116`）。
- vm0 的 11 个 website package 被单独放在 `WEBSITE_TEMPLATE_PACKAGES`，注释明确写着它们是 private R2、pull-only resources，并且不放入 `RESOURCE_REGISTRY`；`WEBSITE_TEMPLATE_V2_PACKAGES` 也是同一 picker catalog 的 additive package（`turbo/packages/core/src/resource-registry.ts:3475-3589`）。
- `listTemplates("website")` 先按 `targets` 过滤通用 `RESOURCE_REGISTRY`，再追加上述 11 个 R2 package（`turbo/packages/core/src/resource-registry.ts:3802-3823`）。当前 `RESOURCE_REGISTRY` 中没有其他 `targets: ["website"]` 的 Open Design entry，因此 website target 列表实际只有这 11 个 R2 package。
- `selectResourceCandidates("website")` 使用同一个 website target 列表，并把 Open Design pinned repo、vm0-skills 和 private R2 archive 作为 registry-level sources 提供给 source-selection packet（`turbo/packages/core/src/resource-registry.ts:3847-3870`）。

## 2. Open Design website 模板被移除的历史

- PR [#22275](https://github.com/vm0-ai/vm0/pull/22275) 的 merge commit 是 `1a9361fcf35bf7e70b96f676f0820d38f0832f74`，合并时间为 2026-07-21 11:50（北京时间附近；GitHub 返回的 merge 时间为 `2026-07-21T03:50:21Z`）。标题是 `refactor: retire open design website templates`。
- PR body 明确记录：
  - 删除 12 个唯一 target 为 `website` 的 Open Design registry templates；
  - 从 6 个 mixed-use Open Design templates 中移除 `website` target，同时保留它们的其他 target；
  - 保留 11 个 vm0 private R2 website packages 作为唯一 website template candidates；
  - 更新 CLI help、source-selection output 和 coverage。
- 被删除的 12 个 website-only entry（来自 `1a9361fcf3^:turbo/packages/core/src/resource-registry.ts`）是：
  - `template:web-prototype-taste-editorial`
  - `template:blog-post`
  - `template:dating-web`
  - `template:email-marketing`
  - `template:kami-landing`
  - `template:open-design-landing`
  - `template:pricing-page`
  - `template:saas-landing`
  - `template:waitlist-page`
  - `template:web-prototype`
  - `template:web-prototype-taste-brutalist`
  - `template:web-prototype-taste-soft`
- 被移除 website target、但 entry 仍保留其他用途的 6 个 entry 是：`template:critique`、`template:digital-eguide`、`template:gamified-app`、`template:live-artifact`、`template:tweaks`、`template:wireframe-sketch`。
- 该 PR 的 CLI 测试把原来接受 `--template saas-landing` 改成拒绝，并断言 stderr 包含 `Unknown template for website`；无显式模板的 website source-selection 测试从断言 `template:web-prototype-taste-editorial` 改成断言 `template:black-slabs` 且不包含前者（`turbo/apps/cli/src/commands/zero/generate/__tests__/website.test.ts:36-98`）。
- Core 测试当前明确断言 `listTemplates("website")` 的结果必须精确等于 11 个 `WEBSITE_TEMPLATE_ITEMS` 的 template id，并命名为“不暴露 Open Design website registry entries”（`turbo/packages/core/src/__tests__/website-template-items.spec.ts:77-138`）。

## 3. 上游 Open Design 资源仍然存在

在 Open Design pinned commit `3fb620af423534643677c7c6fae76be088fa770a` 的 tree 中，上述 12 个目录仍存在并含有相应的 `SKILL.md` / example 或模板资源；例如 `design-templates/web-prototype/SKILL.md`、`design-templates/open-design-landing/SKILL.md` 和三个 `web-prototype-taste-*` 目录均可从该 commit 读取。

与当前需求直接相关的上游 metadata / skill 事实：

- `template:web-prototype` 的 `SKILL.md` 将自身描述为 “General-purpose desktop web prototype”，声明在没有更具体 skill 匹配时，默认用于 landing / marketing / docs / SaaS page；triggers 包括 `prototype`、`mockup`、`landing`、`single page`、`marketing page`、`homepage`。它要求读取 `assets/template.html` 和 `references/layouts.md`，复制 seed 生成单文件 HTML。
- `template:web-prototype-taste-editorial` 明确面向 Notion/Linear marketing site 或 premium documentation surface，并列出 clean、editorial、premium SaaS、documentation、knowledge product 等触发语义。
- `template:web-prototype-taste-brutalist` 明确面向 editorial、newspaper、agency portfolio、Swiss design、manifesto site 等语义。
- `template:web-prototype-taste-soft` 明确面向 Apple-like、Linear-tier、premium consumer、calm SaaS、agency finish 等语义。
- `template:open-design-landing` 的 metadata 将其归类为 `brand-page` / `web` / `marketing`，并将 landing page、editorial site、magazine layout、hero collage 等列为 triggers；其输出是带资源的 standalone HTML 或其他声明的输出形态。
- `template:blog-post`、`template:pricing-page`、`template:email-marketing`、`template:waitlist-page`、`template:digital-eguide` 等也在 pinned Open Design tree 中保留了各自的专用内容结构。

## 4. 未选模板时的实际执行链路

### CLI `zero generate website`

- `turbo/apps/cli/src/commands/zero/generate/website.ts:28-40`：没有传 `--template` 时，详情文本只写 `Selected template: agent decides`；没有在此处写入某个固定模板 id。
- `turbo/apps/cli/src/commands/zero/generate/website.ts:137-147`：只有用户传 `--template` 时才解析并校验 template；校验要求 entry 的 `targets` 包含 `website`。
- `turbo/apps/cli/src/commands/zero/generate/website.ts:149-168`：website 命令把 prompt、`agent decides` 状态和以下规则放入 HTML authoring packet：首屏是可用 website；marketing site 首屏显示产品或 offer；app/tool surface 优先 dense、scannable、task-focused UI；响应式检查 desktop/mobile。
- `turbo/apps/cli/src/commands/zero/shared/html-artifact-authoring.ts:155-183`：packet 的 Stage 1 要求当前 agent 从候选 slice 中选择一个 template、skills 和可选 design system；要求只使用 packet 内 id，且 prompt 是最高优先级信号。selection schema 包含 `template` 和 `rationale`，但当前实现不在代码中生成选择结果。
- `turbo/apps/cli/src/commands/zero/shared/html-artifact-authoring.ts:185-190`：entry 的 `source.path` 若没有自己的 repo/ref，就回退到 registry-level source；Open Design entry 因此可通过 `nexu-io/open-design@3fb620...` 解析，R2 package 则走 `zero resource pull`。
- 因此，当前 CLI 的“未选模板”行为是：输出 website 候选列表并把选择工作交给 agent；代码没有一个固定的 `web-prototype` 或其他模板默认值。

### Chat 中的 generation template

- `turbo/apps/api/src/signals/routes/thread-generation-template.ts:4-23` 明确规定 generation-template prompt 是 one-shot，只来自当前消息附加的 selection；没有附加 template 时直接返回空字符串，follow-up 也不会继承 thread-level default。
- `turbo/apps/api/src/signals/routes/generation-template-prompt.ts:85-110`：没有 generation template 时返回 `{ status: "resolved", prompt: "" }`。
- 显式选择 website picker item 时，API 只通过 `findWebsiteTemplateItem` 查找 picker catalog，然后解析对应 R2 package（同文件 `:187-206`）；生成的上下文要求 pull private R2 package，并明确写着不要用 generic Open Design website template 替代已选 built-in package（同文件 `:209-233`）。
- 当前 web chat 的全局 agent tools prompt 规定：有 attached generation template 时遵循其资源；没有 attached generation template 时，生成 website 等支持的内容要先运行 `zero generate -h`，再运行对应类型命令（`turbo/apps/api/src/signals/services/zero-runs-create.service.ts:396-399`）。这个全局 prompt 没有给出 website-specific 默认 template id。

## 5. 附件截图记录

附件 `07b25f34-3889-445f-8a7f-a642cdae83cf` 是一张聊天截图。可见文字包括：

- Ming：website 也有这个问题，“有限脚本生成视觉，但是失去了大模型的智能”；
- Bingjie：website template 更多适用 landing page，并表示这种请求应让 agent 去其他通用模板中找；
- Ming：同意；
- Bingjie：landing page 模板更多是 marketing 表达，也覆盖有落地页需求的人。

## 6. 研究结论（实现前）

- 代码历史清楚区分了两层 catalog：面向 UI 的 11 个 vm0 R2 website picker package，以及面向 agent source selection 的 Open Design registry。
- “恢复之前的 Open Design template”在历史代码层面至少对应两组变化：12 个被删除的 website-only entry，以及 6 个仍存在但被移除 `website` target 的 mixed-use entry。历史 PR 将这两组一起归为 retire Open Design website templates。
- 本文只记录代码、历史 commit、上游 pinned source、运行链路和截图事实；研究阶段未修改生产代码，也未执行实现或测试变更。

## 7. 已确认的实现边界

- 恢复全部 `12 + 6` 个 Open Design website target；它们进入 CLI/agent 的通用 website registry，不进入 UI 的 11 个 vm0 R2 website picker item。
- 未显式选择模板时，landing page、marketing、官网、品牌/产品官网和产品发布页选择 vm0 built-in website template；文档、博客、dashboard、app/tool、email、通用 prototype 等其他 HTML/website 请求选择匹配意图的 Open Design template；意图不明确时优先 Open Design。
- 显式选择模板时保留用户选择，不套用上述默认分流规则。
