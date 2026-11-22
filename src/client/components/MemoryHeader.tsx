import React from 'react';
import { getMessages } from '../i18n.js';
import type { UiLocale, WorkspaceOption } from '../types.js';

export interface MemoryHeaderProps {
  onOpenConfig: () => void;
  configBtnRef?: React.RefObject<HTMLButtonElement | null>;
  llmConfigured: boolean;
  llmModelName?: string;
  healthGrade?: string;
  healthScore?: number;
  strategyVersion?: number;
  locale: UiLocale;
  loading?: boolean;
  offline?: boolean;
  workspaces?: WorkspaceOption[];
  selectedWorkspaceId?: string;
  onSelectWorkspace?: (workspaceId: string) => void;
}

function formatWorkspaceLabel(ws: WorkspaceOption, countLabel: (n: number) => string): string {
  const base = ws.path
    ? ws.path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || ws.workspaceId
    : ws.workspaceId;
  return `${base} (${countLabel(ws.activeMemories)})`;
}

export function MemoryHeader({
  onOpenConfig,
  configBtnRef,
  llmConfigured,
  llmModelName,
  healthGrade,
  healthScore,
  strategyVersion,
  locale,
  loading = false,
  offline = false,
  workspaces,
  selectedWorkspaceId = '',
  onSelectWorkspace,
}: MemoryHeaderProps) {
  const t = getMessages(locale);

  const statusText = offline
    ? t.header.offline
    : loading
      ? t.header.loading
      : t.header.running;

  const dotClass = offline
    ? 'dshm-status-dot dshm-status-dot--offline'
    : loading
      ? 'dshm-status-dot dshm-status-dot--loading'
      : 'dshm-status-dot';

  const showWorkspaceSelector = Boolean(
    workspaces && workspaces.length > 1 && onSelectWorkspace
  );

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
          <h1 className="dshm-studio-title">{t.header.title}</h1>
        </div>

        <div className="dshm-studio-meta">
          <span className={dotClass} aria-hidden="true" />
          <span>{statusText}</span>
          {!offline && healthGrade ? (
            <>
              <span className="dshm-meta-sep" aria-hidden="true" />
              <span>{t.header.health(healthGrade, healthScore)}</span>
            </>
          ) : null}
          {!offline && strategyVersion !== undefined ? (
            <>
              <span className="dshm-meta-sep" aria-hidden="true" />
              <span>{t.header.strategy(strategyVersion)}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="dshm-header-actions">
        {showWorkspaceSelector && workspaces && onSelectWorkspace ? (
          <select
            className="dshm-ws-select"
            aria-label={t.header.workspaceLabel}
            value={selectedWorkspaceId}
            onChange={(e) => onSelectWorkspace(e.target.value)}
          >
            {!selectedWorkspaceId ? (
              <option value="">{t.header.defaultWorkspace}</option>
            ) : null}
            {workspaces.map((ws) => (
              <option key={ws.workspaceId} value={ws.workspaceId}>
                {formatWorkspaceLabel(ws, t.header.workspaceCount)}
              </option>
            ))}
          </select>
        ) : null}

        <button
          ref={configBtnRef}
          type="button"
          className="dshm-config-btn"
          onClick={onOpenConfig}
          title={
            llmConfigured
              ? t.header.configReadyTitle(llmModelName || t.header.dshHostLabel)
              : t.header.configUnsetTitle
          }
        >
          <span
            className="dshm-config-btn-dot"
            aria-hidden="true"
            style={{
              background: llmConfigured
                ? 'var(--dshm-valley-green)'
                : 'var(--dshm-accent)',
            }}
          />
          <span>{t.header.configButton}</span>
          {llmModelName ? (
            <span className="dshm-config-btn-model">{llmModelName}</span>
          ) : null}
        </button>
      </div>
    </header>
  );
}
