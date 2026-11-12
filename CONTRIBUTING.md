# 代码贡献与分支合并规范 (Branching & Contribution Guidelines)

本规范旨在保障 `dsh-memory` 仓库主分支（`main`）的绝对稳定与代码质量。**后续所有代码修改均禁止直接推送至 `main` 分支，必须采用“分支开发 -> 本地自测 -> 发起 PR -> 审查审核 -> 合并入主支”的标准流程。**

---

## 1. 核心研发原则 (Core Principles)

1. **主分支受保护（Protected Main）**：`main` 分支始终保持可发布、测试全通（100% Pass）的生产可用状态。
2. **特性隔离（Feature Branching）**：一个任务或 Bug 对应一个独立特性分支，生命周期短，合并后即清理。
3. **门禁前置（Quality Gate First）**：提交 PR 前必须在本地通过类型检查、单元与验收测试及打包构建。
4. **审核才合并（Review Before Merge）**：至少需要通过代码审查（Code Review）与 GitHub Actions CI 自动化门禁后，才允许合入 `main`。

---

## 2. 分支命名规范 (Branch Naming)

分支名称统一遵循 `<type>/<short-description>` 格式（全小写，短横线分隔）：

| 分支前缀 | 适用场景 | 示例 |
|---|---|---|
| `feat/` | 新功能、新模块开发 | `feat/visual-dashboard-v2`、`feat/core-memory-pin` |
| `fix/` | 缺陷与 Bug 修复 | `fix/sqlite-busy-timeout`、`fix/token-budget-overflow` |
| `refactor/`| 代码重构（不改变现有行为） | `refactor/retrieval-fusion`、`refactor/writer-pipeline` |
| `docs/` | 文档优化、说明变更 | `docs/workflow-rules`、`docs/api-reference` |
| `test/` | 测试用例增补、基准评测更新 | `test/stress-10k-memories`、`test/edge-case-privacy` |
| `chore/` | 构建配置、依赖更新、工程脚本 | `chore/upgrade-tsup`、`chore/github-actions-ci` |

---

## 3. 标准开发与推送全流程 (Standard Step-by-Step Workflow)

### 步骤 1：同步主分支并创建特性分支
```bash
# 切换到主分支并拉取远端最新提交
git checkout main
git pull origin main

# 基于最新 main 创建属于你的特性分支
git checkout -b feat/your-feature-name
```

### 步骤 2：本地开发与质量门禁验证
在编码过程中或准备提交前，**必须**在本地依次通过三大质量门禁：
```bash
# 1. 静态类型检查
npm run typecheck

# 2. 全量单元测试与验收测试
npm test

# 3. 完整构建打包验证
npm run build
```

### 步骤 3：提交代码 (Commit Convention)
提交信息采用行业标准 Conventional Commits：
```bash
git add .
git commit -m "feat(web): add interactive memory timeline visualizer"
```
常用类别：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf`。

### 步骤 4：推送到远端特性分支
```bash
# 首次推送设置跟踪上游
git push -u origin feat/your-feature-name
```

### 步骤 5：在 GitHub 发起 Pull Request (PR)
1. 访问 GitHub 仓库页面，点击 **Compare & pull request**。
2. 基础分支（base）选择 `main`，对比分支（compare）选择你的特性分支。
3. 按照预置的 **PR 模板** 完整填写：
   - 变更概述
   - 关联任务/Issue
   - 质量门禁自测核对清单
   - 审核注意点

### 步骤 6：代码审核与 CI 验证 (Review & CI)
1. **自动化门禁**：GitHub Actions（`CI & Quality Gate`）将自动运行全量 Typecheck、Vitest 验收套件与 Build 构建，确保所有测试全绿通过。
2. **人工审查**：由团队负责人或 Reviewer 进行代码走查，提出修改意见。若有需修改项，在本地同一分支修改后直接 push，PR 将自动联动更新。

### 步骤 7：合并入主分支与清理分支
- 审核批准（Approved）且 CI 绿标后，推荐使用 **Squash and Merge** 或 **Rebase and Merge** 合并入 `main`，保持主分支历史线性整洁。
- 合并后及时删除远端特性分支，并同步本地环境：
  ```bash
  git checkout main
  git pull origin main
  git branch -d feat/your-feature-name
  ```

---

## 4. GitHub 仓库端保护规则配置指南 (Repository Admin Setup)

建议仓库管理员在 GitHub 仓库中开启强制保护，以在系统层面彻底防止误推：

1. 打开 GitHub 仓库设置：`https://github.com/ROSESSSSS66/dsh-memory/settings`
2. 左侧导航选择 **Branches** -> 点击 **Add branch protection rule**
3. 在 **Branch name pattern** 中输入：`main`
4. 勾选以下核心保护项：
   - [x] **Require a pull request before merging**
     - [x] *Require approvals* (建议设为 1，至少 1 人审核通过才可合入)
     - [x] *Dismiss stale pull request approvals when new commits are pushed* (有新代码推入时自动重置审核)
   - [x] **Require status checks to pass before merging**
     - 勾选由 CI 工作流提供的状态门禁（如 `Typecheck, Test & Build`）
     - [x] *Require branches to be up to date before merging* (合并前分支需与目标分支最新提交对齐)
   - [x] **Do not allow bypassing the above settings** (禁止管理员自身绕过规则，杜绝任何直推)
5. 点击 **Create** / **Save changes** 保存规则。
