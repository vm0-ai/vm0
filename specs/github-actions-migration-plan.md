# GitHub Actions 迁移计划

## 迁移原则
1. **渐进式改进** - 小步快跑，每次改进都可以独立验证
2. **保持稳定性** - 确保 CI/CD 持续可用
3. **先易后难** - 从简单改进开始，逐步增加复杂度
4. **可回滚** - 每个改进都应该可以快速回滚

## 阶段划分

### 🎯 Phase 1: Quick Wins (立即可做)
**目标**: 快速改进，无需大改动
**时间**: 1-2 小时
**收益**: 减少 20-30% CI 时间

#### 1.1 优化依赖安装和缓存
- [ ] 添加 pnpm store 缓存
- [ ] 缓存 node_modules
- [ ] 缓存 turbo build 输出

#### 1.2 并行化独立任务
- [ ] lint 和 test 并行运行
- [ ] build-web 和 build-docs 并行运行

#### 1.3 优化 checkout 和初始化
- [ ] 使用 `fetch-depth: 1` (除非需要历史)
- [ ] 跳过不必要的 submodules

### 🚀 Phase 2: Change Detection (本周末)
**目标**: 实现基础的变更检测
**时间**: 3-4 小时
**收益**: 减少 40-50% CI 时间

#### 2.1 实现简单的变更检测
- [ ] 检测 web app 变更
- [ ] 检测 docs app 变更
- [ ] 基于变更跳过不必要的构建

#### 2.2 条件化部署
- [ ] 只部署有变更的应用
- [ ] 优化 PR 预览部署

### 📦 Phase 3: Containerization (下周)
**目标**: 创建统一的 CI 环境
**时间**: 1-2 天
**收益**: 更快的启动时间，一致的环境

#### 3.1 创建工具链镜像
- [ ] 基础镜像 (Node.js 22, pnpm)
- [ ] 预装常用工具
- [ ] 推送到 GitHub Container Registry

#### 3.2 迁移到容器化 CI
- [ ] 更新 workflows 使用容器
- [ ] 测试和调优

### 🔧 Phase 4: Advanced Optimizations (下下周)
**目标**: 进一步优化和增强
**时间**: 2-3 天
**收益**: 更好的可维护性和扩展性

#### 4.1 高级变更检测
- [ ] 使用 turbo-ignore
- [ ] 支持 monorepo 依赖图分析

#### 4.2 改进部署流程
- [ ] 合并 build 和 deploy
- [ ] 减少 artifact 使用

## 立即实施计划 (Phase 1)

### Step 1: 添加缓存 (30分钟)

```yaml
# .github/workflows/turbo.yml
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 添加 pnpm 缓存
      - name: Setup pnpm cache
        uses: actions/cache@v3
        with:
          path: ~/.pnpm-store
          key: ${{ runner.os }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: |
            ${{ runner.os }}-pnpm-

      # 添加 turbo 缓存
      - name: Setup turbo cache
        uses: actions/cache@v3
        with:
          path: turbo/.turbo
          key: ${{ runner.os }}-turbo-${{ github.sha }}
          restore-keys: |
            ${{ runner.os }}-turbo-
```

### Step 2: 并行化任务 (20分钟)

当前:
```
lint -> test -> build -> deploy
```

优化后:
```
┌─> lint ─┐
│         ├─> deploy
├─> test ─┘
│
└─> build ─┘
```

### Step 3: 简单的变更检测 (1小时)

```yaml
jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      web: ${{ steps.changes.outputs.web }}
      docs: ${{ steps.changes.outputs.docs }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - name: Detect changes
        id: changes
        run: |
          # 检测 web 应用变更
          if git diff --quiet HEAD^ HEAD -- turbo/apps/web turbo/packages; then
            echo "web=false" >> $GITHUB_OUTPUT
          else
            echo "web=true" >> $GITHUB_OUTPUT
          fi

          # 检测 docs 应用变更
          if git diff --quiet HEAD^ HEAD -- turbo/apps/docs turbo/packages; then
            echo "docs=false" >> $GITHUB_OUTPUT
          else
            echo "docs=true" >> $GITHUB_OUTPUT
          fi

  build-web:
    needs: detect-changes
    if: needs.detect-changes.outputs.web == 'true'
    # ... rest of job
```

## 实施顺序建议

### 今天可以做的 (1-2小时)
1. **添加缓存** ✅
   - pnpm store 缓存
   - turbo 缓存
   - 立即见效，减少安装时间

2. **优化 checkout** ✅
   - 设置 `fetch-depth: 1`
   - 移除不必要的 submodules

3. **调整任务依赖** ✅
   - 让 lint 和 test 并行
   - 独立的 build 任务并行

### 本周末 (3-4小时)
1. **实现基础变更检测**
   - 简单的 git diff 检测
   - 条件化 build 和 deploy

2. **优化部署条件**
   - 只在需要时创建数据库分支
   - 只部署变更的应用

### 下周 (1-2天)
1. **创建 Docker 镜像**
   - 包含所有依赖的基础镜像
   - 推送到 GHCR

2. **迁移到容器化**
   - 更新所有 workflows
   - 测试和验证

## 预期效果

### 性能提升
- **Phase 1**: -30% CI 时间 (从 ~5分钟 到 ~3.5分钟)
- **Phase 2**: -50% CI 时间 (从 ~3.5分钟 到 ~2.5分钟)
- **Phase 3**: -60% CI 时间 (从 ~2.5分钟 到 ~2分钟)

### 成本节省
- **当前**: ~2000-3000 分钟/月
- **Phase 1 后**: ~1400-2100 分钟/月
- **Phase 2 后**: ~1000-1500 分钟/月
- **Phase 3 后**: ~800-1200 分钟/月

## 开始实施的命令

```bash
# 1. 切换到新分支
git checkout -b ci/phase1-quick-wins

# 2. 实施改进
# ... 编辑 workflow 文件 ...

# 3. 测试
git add .
git commit -m "ci: add caching and parallelize independent jobs"
git push -u origin ci/phase1-quick-wins

# 4. 创建 PR
gh pr create --title "ci: phase 1 - quick wins for CI optimization"
```

## 风险管理

### 低风险改进 (Phase 1)
- 缓存不会影响构建正确性
- 并行化只影响执行顺序
- 容易回滚

### 中等风险 (Phase 2)
- 变更检测可能漏检
- 需要充分测试
- 保留 bypass 选项

### 较高风险 (Phase 3)
- 容器环境可能有兼容性问题
- 需要维护 Docker 镜像
- 需要更多测试