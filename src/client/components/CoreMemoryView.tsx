import * as React from 'react';
import type { CoreMemoryBlockUI } from '../types.js';
import { fetchCoreMemory, saveCoreMemory } from '../api.js';
import {
  UserIcon,
  BotIcon,
  CodeIcon,
  LayersIcon,
  CheckIcon,
  RefreshIcon,
  PlusIcon,
  EyeIcon,
  CopyIcon,
} from './Icons.js';
import { GlassCard, GlassButton, GlassInput, useGlassVariant } from './GlassUI.js';

interface CoreMemoryViewProps {
  onToast: (msg: string) => void;
  onInspect: (id: string) => void;
  onUpdated: () => void;
}

const BLOCK_META: Record<
  string,
  {
    title: string;
    subtitle: string;
    scopeLabel: string;
    placeholder: string;
    template: string;
    accentClass: string;
  }
> = {
  human: {
    title: 'HUMAN · 用户画像与开发习惯',
    subtitle: '跨所有工作区持久生效的开发者身份、技术栈偏好与沟通风格',
    scopeLabel: '用户全局 (User Scope)',
    placeholder:
      '记录您的核心偏好，例如：\n- 偏好使用 TypeScript 严格模式与函数式组件\n- 回复请保持简洁直接，直接给出根因与代码实现',
    template:
      '- 主力技术栈：TypeScript, Node.js, React\n- 代码规范：偏好高内聚低耦合、严格类型检查、零冗余依赖\n- 交互偏好：中文沟通，先给结论再给细节',
    accentClass: 'is-purple',
  },
  persona: {
    title: 'PERSONA · 助手角色与行为准则',
    subtitle: '定义 AI 编码搭档的思考范式、安全红线与执行纪律',
    scopeLabel: '全局通用 (Global Scope)',
    placeholder:
      '定义 AI 的核心准则，例如：\n- 修改代码前必须先运行或核对相关单元测试\n- 严禁未经允许删除生产数据或绕过安全校验',
    template:
      '- 角色定位：资深全栈架构师与结对编程专家\n- 执行准则：修改核心逻辑后必须通过 typecheck 与 vitest 验证\n- 安全红线：严禁硬编码敏感凭证，所有外部操作优先保证幂等性',
    accentClass: 'is-blue',
  },
  project: {
    title: 'PROJECT · 当前工作区架构与规范',
    subtitle: '当前项目专属的架构拓扑、构建测试命令与关键模块约定',
    scopeLabel: '当前工作区 (Workspace Scope)',
    placeholder:
      '记录当前项目核心上下文，例如：\n- 存储层采用内置 node:sqlite + FTS5 全文索引\n- 构建命令为 npm run build，全量检查为 npm run check',
    template:
      '- 项目架构：DSH 自进化长期记忆插件 (快环本地 FTS5 召回 + 慢环 LLM 蒸馏)\n- 常用命令：构建 `npm run build`，测试 `npm run check`，基准评测 `npm run eval`\n- 目录规范：`src/core` 存储内核，`src/retrieval` 多路召回，`src/evolution` 慢环演化，`src/client` Web UI',
    accentClass: 'is-emerald',
  },
};

export const CoreMemoryView: React.FC<CoreMemoryViewProps> = ({
  onToast,
  onInspect,
  onUpdated,
}) => {
  const variant = useGlassVariant();
  const [blocks, setBlocks] = React.useState<CoreMemoryBlockUI[]>([]);
  const [totalTokens, setTotalTokens] = React.useState(0);
  const [stableBudget, setStableBudget] = React.useState(600);
  const [loading, setLoading] = React.useState(true);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [appendInputs, setAppendInputs] = React.useState<Record<string, string>>({});
  const [savingBlock, setSavingBlock] = React.useState<string | null>(null);

  // Custom block creation
  const [newBlockName, setNewBlockName] = React.useState('');
  const [isAddingCustom, setIsAddingCustom] = React.useState(false);

  const loadCore = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchCoreMemory();
      setBlocks(res.blocks);
      setTotalTokens(res.totalTokens);
      setStableBudget(res.stableBudgetTokens || 600);
      const nextDrafts: Record<string, string> = {};
      for (const b of res.blocks) {
        nextDrafts[b.block] = b.content;
      }
      setDrafts(nextDrafts);
    } catch (err: any) {
      onToast(err?.message || '加载核心记忆块失败');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  React.useEffect(() => {
    loadCore();
  }, [loadCore]);

  const handleSaveBlock = async (blockName: string) => {
    const text = (drafts[blockName] || '').trim();
    if (!text) {
      onToast('核心记忆块内容不能为空');
      return;
    }
    setSavingBlock(blockName);
    try {
      await saveCoreMemory({ block: blockName, content: text, mode: 'set' });
      onToast(`核心记忆块 [${blockName.toUpperCase()}] 已更新并固化至 System Prompt！`);
      await loadCore();
      onUpdated();
    } catch (err: any) {
      onToast(err?.message || '保存失败');
    } finally {
      setSavingBlock(null);
    }
  };

  const handleAppendBlock = async (blockName: string) => {
    const line = (appendInputs[blockName] || '').trim();
    if (!line) return;
    setSavingBlock(blockName);
    try {
      await saveCoreMemory({ block: blockName, content: line, mode: 'append' });
      setAppendInputs((prev) => ({ ...prev, [blockName]: '' }));
      onToast(`已向 [${blockName.toUpperCase()}] 追加新条目！`);
      await loadCore();
      onUpdated();
    } catch (err: any) {
      onToast(err?.message || '追加失败');
    } finally {
      setSavingBlock(null);
    }
  };

  const handleCreateCustomBlock = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = newBlockName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!cleanName) {
      onToast('块名称仅支持英文字母、数字、下划线或连字符');
      return;
    }
    setSavingBlock(cleanName);
    try {
      await saveCoreMemory({
        block: cleanName,
        content: `- [${cleanName.toUpperCase()}] 核心上下文初始化`,
        mode: 'set',
      });
      setNewBlockName('');
      setIsAddingCustom(false);
      onToast(`已创建自定义核心记忆块 [${cleanName.toUpperCase()}]`);
      await loadCore();
      onUpdated();
    } catch (err: any) {
      onToast(err?.message || '创建失败');
    } finally {
      setSavingBlock(null);
    }
  };

  const budgetPct = Math.min(100, Math.round((totalTokens / Math.max(1, stableBudget)) * 100));

  if (loading) {
    return (
      <GlassCard variant={variant} interactive={false} className="dshm-loading-state">
        <div className="dshm-spin">
          <RefreshIcon size={22} />
        </div>
        <span>正在同步 Letta/MemGPT 核心记忆工作台…</span>
      </GlassCard>
    );
  }

  return (
    <div className="dshm-core-container">
      {/* Top Banner & Token Gauge */}
      <GlassCard variant={variant} interactive={false} className="dshm-core-banner">
        <div className="dshm-core-banner-left">
          <div className="dshm-core-banner-title-row">
            <h2 className="dshm-section-heading">🧠 核心记忆工作台 (Letta / MemGPT Scratchpad)</h2>
            <span className="dshm-tag dshm-badge-pinned">System Prompt 稳定层常驻</span>
          </div>
          <p className="dshm-core-banner-desc">
            核心记忆块以最高优先级（<code>pinned=1, importance=10</code>）常驻于系统提示词顶部，通过固定排序命中大模型 Prefix Cache，实现零延迟背景感知。
          </p>
        </div>

        <div className="dshm-core-banner-right">
          <div className="dshm-core-gauge">
            <div className="dshm-core-gauge-top">
              <span>稳定层 Token 占用</span>
              <strong>
                {totalTokens} / {stableBudget} tok ({budgetPct}%)
              </strong>
            </div>
            <div className="dshm-stat-progress">
              <div
                className={`dshm-stat-progress-bar ${
                  budgetPct > 85 ? 'is-danger' : 'is-blue'
                }`}
                style={{ width: `${budgetPct}%` }}
              />
            </div>
          </div>

          <GlassButton
            type="button"
            variant={variant}
            className="dshm-btn dshm-btn-secondary"
            onClick={() => setIsAddingCustom(!isAddingCustom)}
          >
            <PlusIcon size={13} />
            <span>自定义块</span>
          </GlassButton>
        </div>
      </GlassCard>

      {/* Custom Block Creator */}
      {isAddingCustom && (
        <GlassCard
          as="form"
          variant={variant}
          interactive={false}
          className="dshm-core-custom-form"
          onSubmit={handleCreateCustomBlock as any}
        >
          <span className="dshm-form-label">新建核心槽位块 (slot: core:&lt;name&gt;)：</span>
          <GlassInput
            type="text"
            variant={variant}
            className="dshm-form-input dshm-core-custom-input"
            placeholder="例如 architecture 或 conventions"
            value={newBlockName}
            onChange={(e) => setNewBlockName(e.target.value)}
            required
          />
          <GlassButton
            type="submit"
            variant={variant}
            intent="primary"
            className="dshm-btn dshm-btn-primary"
          >
            创建并初始化
          </GlassButton>
          <GlassButton
            type="button"
            variant={variant}
            className="dshm-btn dshm-btn-secondary"
            onClick={() => setIsAddingCustom(false)}
          >
            取消
          </GlassButton>
        </GlassCard>
      )}

      {/* Core Memory Blocks Grid */}
      <div className="dshm-core-grid">
        {blocks.map((b) => {
          const meta = BLOCK_META[b.block] || {
            title: `${b.block.toUpperCase()} · 自定义核心记忆块`,
            subtitle: `绑定槽位 core:${b.block} 的常驻上下文`,
            scopeLabel: '工作区作用域',
            placeholder: '输入常驻核心记忆内容…',
            template: `- [${b.block.toUpperCase()}] 关键约束与说明`,
            accentClass: 'is-indigo',
          };

          const currentDraft = drafts[b.block] ?? '';
          const isDirty = currentDraft.trim() !== (b.content || '').trim();
          const isSaving = savingBlock === b.block;

          return (
            <GlassCard
              key={b.block}
              variant={variant}
              interactive={false}
              className={`dshm-core-card ${meta.accentClass}`}
            >
              <div className="dshm-core-card-header">
                <div className="dshm-core-card-title-group">
                  <div className={`dshm-core-icon ${meta.accentClass}`}>
                    {b.block === 'human' ? (
                      <UserIcon size={16} />
                    ) : b.block === 'persona' ? (
                      <BotIcon size={16} />
                    ) : b.block === 'project' ? (
                      <CodeIcon size={16} />
                    ) : (
                      <LayersIcon size={16} />
                    )}
                  </div>
                  <div>
                    <div className="dshm-core-card-title-row">
                      <h3>{meta.title}</h3>
                      <span className="dshm-tag dshm-tag-slot">core:{b.block}</span>
                      {b.version > 0 && (
                        <span className="dshm-badge-version">v{b.version}</span>
                      )}
                    </div>
                    <p className="dshm-core-card-subtitle">{meta.subtitle}</p>
                  </div>
                </div>

                <div className="dshm-core-card-meta">
                  <span className="dshm-tag dshm-tag-scope">{meta.scopeLabel}</span>
                  <span className="dshm-metric-pill">
                    <strong>{b.tokens || 0}</strong> tok
                  </span>
                  {b.id && (
                    <GlassButton
                      type="button"
                      variant={variant}
                      size="icon"
                      className="dshm-action-btn"
                      onClick={() => onInspect(b.id)}
                      title="查看历史版本快照与演化记录"
                    >
                      <EyeIcon size={13} />
                    </GlassButton>
                  )}
                  {currentDraft && (
                    <GlassButton
                      type="button"
                      variant={variant}
                      size="icon"
                      className="dshm-action-btn"
                      onClick={() => {
                        navigator.clipboard
                          .writeText(currentDraft)
                          .then(() => onToast('已复制该核心块内容'));
                      }}
                      title="复制内容"
                    >
                      <CopyIcon size={13} />
                    </GlassButton>
                  )}
                </div>
              </div>

              <div className="dshm-core-card-body">
                <textarea
                  className="glass-input dshm-form-textarea dshm-core-textarea glass-base glass-light glass-light-focus"
                  rows={5}
                  placeholder={meta.placeholder}
                  value={currentDraft}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [b.block]: e.target.value }))
                  }
                />

                {/* Quick Append Bar */}
                <div className="dshm-core-append-row">
                  <GlassInput
                    type="text"
                    variant={variant}
                    className="dshm-form-input"
                    placeholder={`向 [${b.block.toUpperCase()}] 快速追加单行要点 (回车直接追加)…`}
                    value={appendInputs[b.block] || ''}
                    onChange={(e) =>
                      setAppendInputs((prev) => ({ ...prev, [b.block]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAppendBlock(b.block);
                      }
                    }}
                  />
                  <GlassButton
                    type="button"
                    variant={variant}
                    className="dshm-btn dshm-btn-secondary"
                    disabled={!appendInputs[b.block]?.trim() || isSaving}
                    onClick={() => handleAppendBlock(b.block)}
                  >
                    <PlusIcon size={13} />
                    <span>追加</span>
                  </GlassButton>
                </div>
              </div>

              <div className="dshm-core-card-footer">
                <div className="dshm-core-footer-left">
                  {!currentDraft.trim() && (
                    <GlassButton
                      type="button"
                      variant={variant}
                      className="dshm-btn dshm-btn-ghost"
                      onClick={() =>
                        setDrafts((prev) => ({ ...prev, [b.block]: meta.template }))
                      }
                    >
                      填入推荐模板
                    </GlassButton>
                  )}
                  {b.updated_at > 0 && (
                    <span className="dshm-core-updated">
                      最后更新: {new Date(b.updated_at).toLocaleString()}
                    </span>
                  )}
                </div>

                <div className="dshm-core-footer-right">
                  {isDirty && b.content && (
                    <GlassButton
                      type="button"
                      variant={variant}
                      className="dshm-btn dshm-btn-secondary"
                      onClick={() =>
                        setDrafts((prev) => ({ ...prev, [b.block]: b.content }))
                      }
                    >
                      还原修改
                    </GlassButton>
                  )}
                  <GlassButton
                    type="button"
                    variant={variant}
                    intent="primary"
                    className="dshm-btn dshm-btn-primary"
                    disabled={isSaving || !currentDraft.trim() || (!isDirty && !!b.id)}
                    onClick={() => handleSaveBlock(b.block)}
                  >
                    <CheckIcon size={13} />
                    <span>
                      {isSaving ? '保存中…' : b.id ? '保存修订' : '初始化激活'}
                    </span>
                  </GlassButton>
                </div>
              </div>
            </GlassCard>
          );
        })}
      </div>
    </div>
  );
};
