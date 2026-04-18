# React Performance Patterns

This document records React re-render anti-patterns discovered through CPU profiling in this codebase, along with their root causes and fixes.

---

## 背景：如何识别过度重渲染

CPU profile 中出现大量 `renderWithHooksAgain` 样本，说明组件在同一个 render pass 内被迫重新执行。触发原因是 `useSyncExternalStore` 在 render 过程中检测到 snapshot 已变化，React 会立即重跑该组件的 render 函数。

---

## Anti-Pattern 1：在大型组件顶层订阅多个异步信号

### 问题

一个父组件（如 `ZeroSidebar`）在顶层同时订阅多个异步信号：

```tsx
// ❌ 每个异步信号解析时，整个大组件都重渲染一次
export function ZeroSidebar() {
  const displayNameLoadable = useLastLoadable(currentChatAgentDisplayName$);
  const subagentsLoadable = useLastLoadable(subagents$);
  const defaultDisplayName = useLastResolved(defaultAgentName$);
  const features = useLastResolved(featureSwitch$);
  const slackScopeMismatch = useLastResolved(slackOrgScopeMismatch$);
  const currentChatAgentId = useResolved(currentChatAgentId$); // 2 次 Promise 转换 → 4 次重渲染
  // ...
  // 大量 JSX，每次重渲染都完整执行
}
```

### 为什么有害

- 每个异步信号解析都触发整个组件重渲染，包括所有 nav 项的重新计算和完整 DOM 协调
- 使用 `useResolved`（keepLastResolved=false）的信号每次 Promise 转换产生 2 次渲染；经过多跳 async computed 链的信号会有更多转换次数
- 渲染次数 = Σ (每个信号的 Promise 转换次数 × 每次转换的渲染倍数)

### 修复：让叶子节点直接订阅

将异步订阅下沉到只需要该数据的最小子组件：

```tsx
// ✅ 每个组件只订阅自己需要的信号

function ChatThreadsSectionWithKey() {
  const currentChatAgentId = useResolved(currentChatAgentId$);
  return <ChatThreadsSection key={currentChatAgentId} />;
}

function ManagePinnedAgentsDialogContainer() {
  const displayNameLoadable = useLastLoadable(currentChatAgentDisplayName$);
  const subagentsLoadable = useLastLoadable(subagents$);
  const [pinLoadable, save] = useLoadableSet(updatePinnedAgentIds$);
  // ...仅渲染 dialog，不影响 nav
}

function SidebarNavContent() {
  const features = useLastResolved(featureSwitch$);
  const defaultDisplayName = useLastResolved(defaultAgentName$);
  const slackScopeMismatch = useLastResolved(slackOrgScopeMismatch$);
  // ...渲染 nav 内容
}

export function ZeroSidebar() {
  // 零异步订阅，页面加载只渲染 1 次
  return (
    <VM0ClerkProvider>
      <SidebarNavContent />
      <ManagePinnedAgentsDialogContainer />
      <BillingDialog />
    </VM0ClerkProvider>
  );
}
```

---

## Anti-Pattern 2：对 async computed 链使用 `useResolved`（keepLastResolved=false）

### 问题

`useResolved` 内部使用 `useLoadable`（keepLastResolved=false），每次 Promise 转换触发 2 次渲染（loading → hasData），而非 1 次。当信号依赖另一个 async computed 时，Promise 转换次数会叠加：

```tsx
// agent-chat.ts
export const currentChatAgentId$ = computed(async (get) => {
  return get(internalChatAgentId$) ?? (await get(defaultAgentId$));
  // defaultAgentId$ 本身也是 async → 2 次 Promise 转换
});

// 视图层
const currentChatAgentId = useResolved(currentChatAgentId$);
// 结果：2 次转换 × 2 渲染/次 = 4 次额外重渲染
```

### 修复：优先使用 `useLastResolved`

如果组件只需要"最近一次解析的值"而不需要感知 loading 状态，用 `useLastResolved`（keepLastResolved=true）：

```tsx
// ✅ 每次 Promise 转换只触发 1 次渲染，且不会在 loading 时闪回 undefined
const defaultDisplayName = useLastResolved(defaultAgentName$) ?? "Zero";
```

只有在**需要感知 loading 状态**（如显示 skeleton）时才使用 `useLoadable` / `useResolved`。

---

## Anti-Pattern 3：通过 props 传递异步派生数据（prop drilling）

### 问题

父组件订阅异步信号，然后将解析结果作为 props 逐层传递：

```tsx
// ❌ 父组件承担了不属于它的订阅，每次异步更新父组件都重渲染
export function ZeroSidebar() {
  const displayName  = useLastResolved(currentChatAgentDisplayName$);
  const subagents    = useLastResolved(subagents$);
  const savingPinned = ...; // from useLoadableSet

  return (
    <ManagePinnedAgentsDialog
      displayName={displayName}
      subagents={subagents}
      saving={savingPinned}
      // ...
    />
  );
}
```

### 为什么有害

- 父组件为了给子组件传数据而订阅了它本身不需要的信号
- 每次这些信号更新，整个父组件树重渲染，即使父组件自己的 UI 没有变化

### 修复：子组件直接订阅所需信号

```tsx
// ✅ dialog 容器自己订阅，父组件零 props 传递
function ManagePinnedAgentsDialogContainer() {
  const displayNameLoadable = useLastLoadable(currentChatAgentDisplayName$);
  const subagentsLoadable   = useLastLoadable(subagents$);
  const [pinLoadable, save] = useLoadableSet(updatePinnedAgentIds$);
  // ...
  return <ManagePinnedAgentsDialog ... />;
}
```

---

## 验证方法

### 受控实验：逐步减少订阅，观察渲染次数

在组件顶部添加渲染计数器，用测试逐步移除订阅，确认每个信号对渲染次数的贡献：

```tsx
let _renderCount = 0;
export function getTestRenderCount() {
  return _renderCount;
}

export function ZeroSidebar() {
  _renderCount++;
  // ...
}
```

### CPU Profile 分析

- `renderWithHooksAgain` 样本密集 → 存在过度重渲染
- `analyze-batching.mjs`：确认多个信号更新是否在同一个 React work loop 内批处理
- `analyze-rewind-cause.mjs`：定位触发 `renderWithHooksAgain` 的具体 snapshot 函数
- `dump-rewind-chains.mjs`：查看完整调用链，确认重渲染的来源

### React 批处理确认

多个信号在同一微任务内更新时，React 会批处理为一次 `renderRootSync`。可通过分析 CPU profile 确认：1318 次 `renderWithHooksAgain` 样本分布在仅 11 个 `renderRootSync` 实例中，说明批处理正常工作。

---

## 渲染次数公式

对于订阅了 N 个异步信号的组件，页面加载时的额外渲染次数为：

```
额外渲染次数 = Σ (signal_i 的 Promise 转换次数 × 渲染倍数_i)

渲染倍数：
  useLastResolved / useLastLoadable  → 1 次/转换（keepLastResolved=true）
  useResolved / useLoadable          → 2 次/转换（keepLastResolved=false）

Promise 转换次数：
  直接 async computed               → 通常 1 次
  依赖另一个 async computed 的链    → 转换次数叠加（如 currentChatAgentId$ 经过两跳 → 2 次）
```
