# Migration Consistency Testing

这套脚本用于确保 Drizzle schema 定义与实际的 migration 文件保持一致，防止手写 migration 与 schema 定义产生偏差。

## 核心脚本

### 1. `test-migration-consistency-schema.ts` (推荐使用)

**主要的一致性测试脚本**，验证 migration 文件与 schema 定义是否一致。

**工作原理：**

1. 创建测试数据库，运行现有的 migrations
2. 从 Drizzle schema 重新生成 migrations，创建新的测试数据库
3. 对比两个数据库的 schema
4. 如果原始 schema 不完全一致，运行规范化对比（忽略良性差异）

**运行方式：**

```bash
cd turbo/apps/web
pnpm tsx scripts/test-migration-consistency-schema.ts
```

**成功标准：**

- ✅ Schemas 功能上等价（即使存在列顺序、CHECK 约束名称等良性差异）
- ❌ 存在功能性差异（列类型、索引定义、外键约束等）

**输出示例：**

```
✅ SUCCESS: Schemas are functionally equivalent!
   Differences are cosmetic (column order, CHECK constraint names).
   These benign differences do not affect database behavior.
```

### 2. `compare-schemas-normalized.ts`

**规范化的 schema 比较工具**，只关注功能性差异，忽略良性差异。

**忽略的差异：**

- ✅ 列顺序 (`ordinal_position`)
- ✅ CHECK 约束名称（PostgreSQL 基于 OID 自动生成）
- ✅ 其他内部命名差异

**关注的差异：**

- ❌ 表的存在性
- ❌ 列的数据类型、nullable、默认值
- ❌ 索引定义
- ❌ 主键、外键、唯一约束

**运行方式：**

```bash
# 使用默认的测试数据库
pnpm tsx scripts/compare-schemas-normalized.ts

# 或指定自定义数据库
DB1_URL=postgresql://postgres@localhost/db1 \
DB2_URL=postgresql://postgres@localhost/db2 \
pnpm tsx scripts/compare-schemas-normalized.ts
```

**输出示例：**

```
🔍 Normalized Schema Comparison

Comparing:
  DB1 (existing):  localhost:5432/migration_test_existing
  DB2 (generated): localhost:5432/migration_test_generated

=== 1. Comparing Table Columns ===
✅ No functional column differences

=== 2. Comparing Indexes ===
✅ No index differences

=== 3. Comparing Constraints (excluding CHECK) ===
✅ No constraint differences

=== Summary ===
Found 0 functional differences
✅ Schemas are functionally equivalent!
```

### 3. `detailed-schema-diff.ts`

**详细的 schema 差异分析工具**，显示所有差异（包括良性差异）。

用于调试和深入分析 schema 差异的具体细节。

**运行方式：**

```bash
pnpm tsx scripts/detailed-schema-diff.ts
```

**输出内容：**

- 所有列的差异（包括位置变化）
- 所有索引的差异
- 所有约束的差异（包括 CHECK 约束）

## 使用场景

### 场景 1: 日常开发 - 验证 schema 一致性

在修改 Drizzle schema 或手写 migration 后，运行测试验证一致性：

```bash
pnpm tsx scripts/test-migration-consistency-schema.ts
```

如果测试通过，说明 schema 和 migrations 功能上是一致的。

### 场景 2: 调试 - 查看详细差异

当测试失败时，想了解具体有哪些差异：

```bash
# 先运行主测试（会保留测试数据库）
pnpm tsx scripts/test-migration-consistency-schema.ts

# 然后运行详细对比
pnpm tsx scripts/detailed-schema-diff.ts
```

### 场景 3: 对齐 - 让现有数据库匹配 schema

如果发现历史 migrations 与当前 schema 有偏差，可以：

1. 查看详细差异：

   ```bash
   pnpm tsx scripts/detailed-schema-diff.ts
   ```

2. 根据差异修改 Drizzle schema 文件，使其匹配现有数据库

3. 创建对齐 migration（参考 `0088_align_schema_with_drizzle.sql`）

4. 重新运行测试验证

## 良性差异 vs 功能性差异

### 良性差异（可以忽略）

这些差异不影响数据库功能，是 PostgreSQL 内部实现细节：

1. **列顺序**
   - PostgreSQL 不关心列的物理顺序
   - 修复需要 DROP/RECREATE 整个表（生产环境不可行）

   ```
   ~ agent_composes.created_at:
     Position: 4 → 6
   ```

2. **CHECK 约束名称**
   - PostgreSQL 根据内部 OID 自动生成
   - 每个数据库实例的名称都不同

   ```
   + 2200_25453_1_not_null on agent_compose_versions (CHECK)
   - 2200_22693_1_not_null on agent_compose_versions (CHECK)
   ```

3. **约束命名的细微差异**
   - 只要约束定义相同，名称不同不影响功能

### 功能性差异（必须修复）

这些差异会影响数据库行为：

1. **列类型不同**

   ```
   ~ storage_versions.id:
     data_type: uuid → varchar(64)
   ```

2. **索引定义不同**

   ```
   ~ idx_agent_runs_user_created:
     Old: CREATE INDEX ... (user_id, created_at DESC)
     New: CREATE INDEX ... (user_id, created_at DESC NULLS LAST)
   ```

3. **缺失的索引**

   ```
   + idx_agent_runs_status_heartbeat
   ```

4. **外键约束不同**

   ```
   - storages_head_version_id_storage_versions_id_fk (missing)
   ```

5. **默认值不同**
   ```
   ~ agent_composes.name:
     column_default: NULL → ''
   ```

## 最佳实践

1. **优先使用 Drizzle 生成 migrations**

   ```bash
   pnpm drizzle-kit generate
   ```

2. **修改 schema 后立即测试**

   ```bash
   pnpm tsx scripts/test-migration-consistency-schema.ts
   ```

3. **手写 migration 时要小心**
   - 只在必要时手写（如复杂的数据迁移）
   - 手写后立即运行测试验证
   - 考虑同步更新 Drizzle schema

4. **定期运行测试**
   - 在 CI/CD 中添加此测试
   - 每次 PR 都验证一致性

5. **遇到差异时的处理流程**
   ```
   测试失败
     ↓
   运行 detailed-schema-diff.ts 查看详细差异
     ↓
   区分良性差异 vs 功能性差异
     ↓
   如果只有良性差异 → 测试应该通过（使用规范化比较）
   如果有功能性差异 → 修复 schema 或 migrations
     ↓
   重新测试直到通过
   ```

## 故障排查

### 问题：测试失败但看起来 schema 应该是一致的

**可能原因：**

- 测试数据库没有正确清理
- Drizzle meta 文件过期

**解决方案：**

```bash
# 手动清理测试数据库
psql -U postgres -c "DROP DATABASE IF EXISTS migration_test_existing"
psql -U postgres -c "DROP DATABASE IF EXISTS migration_test_generated"

# 重新运行测试
pnpm tsx scripts/test-migration-consistency-schema.ts
```

### 问题：规范化比较报告了意外的差异

**解决方案：**

```bash
# 查看详细差异
pnpm tsx scripts/detailed-schema-diff.ts

# 手动连接测试数据库检查
psql -U postgres -d migration_test_existing
\d table_name
```

### 问题：drizzle-kit generate 失败

**可能原因：**

- Schema 文件有语法错误
- 循环引用问题

**解决方案：**

```bash
# 检查 TypeScript 错误
pnpm check-types

# 查看 drizzle-kit 详细输出
pnpm drizzle-kit generate --verbose
```

## 相关文件

- `0088_align_schema_with_drizzle.sql` - Schema 对齐 migration，用于修复历史差异
- `meta/_journal.json` - Drizzle migration 元数据
- `.schema-existing.sql` - 测试时生成的现有 schema dump
- `.schema-generated.sql` - 测试时生成的重新生成 schema dump
- `.schema-diff.txt` - 原始 diff 输出

## CI/CD 集成

在 GitHub Actions 中添加测试：

```yaml
- name: Test Migration Consistency
  run: |
    cd turbo/apps/web
    pnpm tsx scripts/test-migration-consistency-schema.ts
```

测试通过条件：

- Exit code = 0（schemas 功能上等价）
- Exit code = 1（有功能性差异，需要修复）
