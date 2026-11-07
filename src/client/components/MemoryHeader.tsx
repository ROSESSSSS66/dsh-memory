import React from 'react';

export interface MemoryHeaderProps {
  onOpenConfig: () => void;
  llmConfigured: boolean;
  llmModelName?: string;
  healthGrade?: string;
  healthScore?: number;
  strategyVersion?: number;
}

export function MemoryHeader({
  onOpenConfig,
  llmConfigured,
  llmModelName,
  healthGrade,
  healthScore,
  strategyVersion,
}: MemoryHeaderProps) {
  return (
    <header className="dshm-studio-header">
      <div className="dshm-brand-col">
        <div className="dshm-brand-line">
          <span className="dshm-brand-mark" aria-hidden="true">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2.5v19" />
              <path d="M4.5 7l15 10" />
              <path d="M19.5 7l-15 10" />
              <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <h1 className="dshm-studio-title">长期记忆</h1>
        </div>

        <div className="dshm-studio-meta">
          <span className="dshm-status-dot" />
          <span>全自动闭环运行中</span>
          {healthGrade && (
            <>
              <span className="dshm-meta-sep" />
              <span>
                健康度 {healthGrade}
                {healthScore !== undefined ? ` (${healthScore})` : ''}
              </span>
            </>
          )}
          <span className="dshm-meta-sep" />
          <span>策略 v{strategyVersion ?? 1}</span>
        </div>
      </div>

      <button
        type="button"
        className="dshm-config-btn"
        onClick={onOpenConfig}
        title={
          llmConfigured
            ? `后台进化模型已就绪: ${llmModelName || 'Default'}`
            : '配置后台慢环进化模型'
        }
      >
        <span
          className="dshm-config-btn-dot"
          style={{
            background: llmConfigured
              ? 'var(--dshm-valley-green)'
              : 'var(--dshm-accent)',
          }}
        />
        <span>模型配置</span>
        {llmModelName ? (
          <span className="dshm-config-btn-model">{llmModelName}</span>
        ) : null}
      </button>
    </header>
  );
}
