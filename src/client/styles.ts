export const MEMORY_STYLES = `
/* ============================================================================
 * DSH Long-Term Memory — v0.11.0 Autonomous Studio UI
 * Reference: Nwflower/dsh-claude-style (docs/STYLE.md)
 *
 * Principles:
 * 1. Host & skin token inheritance (--dsw-alias-*, --dsh-claude-*) with warm
 *    Claude dark (#191919) and Claude light (#ffffff) fallbacks.
 * 2. WCAG AA contrast >= 4.5:1 for all text tokens in both light and dark modes.
 * 3. Accent (--dsw-alias-brand-primary, #d97757) stays restrained (<10%).
 * 4. Shared token scope on .dshm-root and .dshm-portal-root for body portals.
 * 5. High-contrast :focus-visible rings and prefers-reduced-motion support.
 * ============================================================================ */

.dshm-root,
.dshm-portal-root {
  --dshm-canvas: var(--dsh-claude-canvas, var(--dsw-alias-bg-base, #191919));
  --dshm-panel: var(--dsw-alias-bg-layer-1, #212121);
  --dshm-card: var(--dsh-claude-card, var(--dsw-alias-bg-overlay, #232323));
  --dshm-tile: var(--dsw-specific-input-major, #141414);
  --dshm-chip: var(--dsh-claude-chip, var(--dsw-specific-selector, #282828));
  --dshm-hover: var(--dsh-claude-hover-bg, var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06)));
  --dshm-hover-solid: var(--dsw-alias-interactive-bg-hover-solid, #323232);

  --dshm-border-1: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
  --dshm-border-2: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.2));
  --dshm-divider: var(--dsh-claude-divider, rgba(255, 255, 255, 0.07));

  --dshm-ink-1: var(--dsw-alias-label-primary, #fdfdfd);
  --dshm-ink-2: var(--dsw-alias-label-secondary, #beb6b8);
  --dshm-ink-3: var(--dsw-alias-label-tertiary, #a59d9f);
  --dshm-ink-4: var(--dsw-alias-label-caption, #968e90);

  --dshm-accent: var(--dsw-alias-brand-primary, #d97757);
  --dshm-accent-hover: var(--dsw-alias-button-primary-hover, #eb9170);
  --dshm-accent-tint: var(--dsw-alias-state-business-tertiary, rgba(217, 119, 87, 0.14));
  --dshm-data-blue: var(--dsh-claude-data-ink, #5b8def);
  --dshm-valley-green: var(--dsh-claude-meter-valley, #8cbf96);
  --dshm-peak-amber: var(--dsh-claude-meter-peak, #e2a45f);
  --dshm-danger: #f07b84;
  --dshm-danger-tint: rgba(240, 123, 132, 0.12);

  --dshm-font-serif: var(--dsh-claude-font-serif, Georgia, "Noto Serif SC", "Source Han Serif SC", serif);
  --dshm-font-sans: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  --dshm-font-code: var(--dsh-claude-font-code, var(--ds-font-family-code, "JetBrains Mono", Consolas, monospace));

  --dshm-timing: var(--dsh-claude-timing-feedback, 120ms ease);

  color: var(--dshm-ink-1);
  color-scheme: dark;
  font-family: var(--dshm-font-sans);
  font-size: 13px;
  line-height: 1.5;
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
}

.dshm-root {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--dshm-canvas);
}

/* Light scheme fallback when host is in light mode */
:root:not([data-ds-dark-theme]) .dshm-root,
:root[data-ds-dark-theme="false"] .dshm-root,
:root:not([data-ds-dark-theme]) .dshm-portal-root,
:root[data-ds-dark-theme="false"] .dshm-portal-root {
  color-scheme: light;
  --dshm-canvas: var(--dsh-claude-canvas, var(--dsw-alias-bg-base, #ffffff));
  --dshm-panel: var(--dsh-claude-sidebar-canvas, var(--dsw-alias-bg-layer-1, #fafafa));
  --dshm-card: var(--dsh-claude-card, var(--dsw-alias-bg-overlay, #ffffff));
  --dshm-tile: var(--dsh-claude-table-head, #f4f4f4);
  --dshm-chip: var(--dsh-claude-chip, #f5f5f5);
  --dshm-hover: var(--dsh-claude-hover-bg, rgba(6, 6, 6, 0.05));
  --dshm-hover-solid: var(--dsw-alias-interactive-bg-hover-solid, #efefef);

  --dshm-border-1: var(--dsw-alias-border-l1, #e4e4e4);
  --dshm-border-2: var(--dsw-alias-border-l2, #cccccc);
  --dshm-divider: var(--dsh-claude-divider, rgba(22, 22, 22, 0.08));

  --dshm-ink-1: var(--dsw-alias-label-primary, #161616);
  --dshm-ink-2: var(--dsw-alias-label-secondary, #4d4749);
  --dshm-ink-3: var(--dsw-alias-label-tertiary, #5f595b);
  --dshm-ink-4: var(--dsw-alias-label-caption, #6b6466);

  --dshm-data-blue: var(--dsh-claude-data-ink, #2d5bb9);
  --dshm-valley-green: var(--dsh-claude-meter-valley, #2e6742);
  --dshm-peak-amber: var(--dsh-claude-meter-peak, #8f5314);
  --dshm-danger: #b52b38;
  --dshm-danger-tint: rgba(181, 43, 56, 0.08);
}

.dshm-root *,
.dshm-root *::before,
.dshm-root *::after,
.dshm-portal-root *,
.dshm-portal-root *::before,
.dshm-portal-root *::after {
  box-sizing: border-box;
}

/* High-contrast keyboard focus ring */
.dshm-root button:focus-visible,
.dshm-root input:focus-visible,
.dshm-root select:focus-visible,
.dshm-root summary:focus-visible,
.dshm-root [tabindex]:focus-visible,
.dshm-portal-root button:focus-visible,
.dshm-portal-root input:focus-visible,
.dshm-portal-root select:focus-visible,
.dshm-portal-root summary:focus-visible,
.dshm-portal-root [tabindex]:focus-visible {
  outline: 2px solid var(--dshm-accent);
  outline-offset: 2px;
}

/* Studio Centered Column */
.dshm-studio {
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 28px 56px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

@media (max-width: 640px) {
  .dshm-studio {
    padding: 20px 16px 40px;
    gap: 20px;
  }
}

/* ── 1. Top Studio Header ── */
.dshm-studio-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.dshm-brand-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.dshm-brand-line {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dshm-brand-mark {
  width: 20px;
  height: 20px;
  color: var(--dshm-accent);
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.dshm-studio-title {
  margin: 0;
  font-family: var(--dshm-font-serif);
  font-size: 22px;
  font-weight: 500;
  line-height: 1.25;
  letter-spacing: -0.015em;
  color: var(--dshm-ink-1);
}

.dshm-studio-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
}

.dshm-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dshm-valley-green);
  display: inline-block;
  flex: none;
  animation: dshmBreathe var(--dsh-claude-period-status-breathe, 1800ms) ease-in-out infinite;
}

.dshm-status-dot--loading {
  background: var(--dshm-peak-amber);
}

.dshm-status-dot--offline {
  background: var(--dshm-danger);
  animation: none;
}

@keyframes dshmBreathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.42; }
}

.dshm-meta-sep {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: var(--dshm-ink-4);
  display: inline-block;
}

.dshm-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-ws-select {
  height: 32px;
  max-width: 190px;
  padding: 0 9px;
  border-radius: 8px;
  border: 1px solid var(--dshm-border-1);
  background: var(--dshm-panel);
  color: var(--dshm-ink-2);
  font-family: var(--dshm-font-sans);
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--dshm-timing), background-color var(--dshm-timing);
}

.dshm-ws-select:hover {
  border-color: var(--dshm-border-2);
  background: var(--dshm-card);
}

.dshm-ws-select option {
  background: var(--dshm-card);
  color: var(--dshm-ink-1);
}

/* The Single Primary Action Button: Model Settings */
.dshm-config-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--dshm-border-1);
  background: var(--dshm-card);
  color: var(--dshm-ink-1);
  font-family: var(--dshm-font-sans);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition:
    background-color var(--dshm-timing),
    border-color var(--dshm-timing);
}

.dshm-config-btn:hover {
  background: var(--dshm-hover-solid);
  border-color: var(--dshm-border-2);
}

.dshm-config-btn:active {
  transform: translateY(0.5px);
}

.dshm-config-btn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.dshm-config-btn-model {
  color: var(--dshm-ink-3);
  font-family: var(--dshm-font-code);
  font-size: 11.5px;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Offline / Degraded Banner ── */
.dshm-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px;
  border-radius: 8px;
  border: 1px solid var(--dshm-border-2);
  background: var(--dshm-panel);
  flex-wrap: wrap;
}

.dshm-banner--offline {
  border-color: var(--dshm-danger);
  background: var(--dshm-danger-tint);
}

.dshm-banner-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dshm-banner-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dshm-ink-1);
}

.dshm-banner-detail {
  font-size: 11.5px;
  color: var(--dshm-ink-2);
}

.dshm-banner-retry {
  appearance: none;
  height: 28px;
  padding: 0 11px;
  border-radius: 6px;
  border: 1px solid var(--dshm-border-2);
  background: var(--dshm-card);
  color: var(--dshm-ink-1);
  font-family: var(--dshm-font-sans);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  flex: none;
  transition: background-color var(--dshm-timing);
}

.dshm-banner-retry:hover {
  background: var(--dshm-hover-solid);
}

/* ── 2. Claude Studio 3x2 Telemetry Panel ── */
.dshm-usage-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--dshm-border-1);
  background: var(--dshm-panel);
}

.dshm-usage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--dshm-ink-2);
}

.dshm-usage-head-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-usage-head-title {
  font-weight: 600;
  color: var(--dshm-ink-1);
  letter-spacing: 0.01em;
}

.dshm-repair-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--dshm-accent);
  background: var(--dshm-accent-tint);
  color: var(--dshm-ink-1);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.dshm-usage-head-caption {
  color: var(--dshm-ink-3);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.dshm-stat-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

@media (max-width: 640px) {
  .dshm-stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.dshm-stat-tile {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 11px 13px;
  border-radius: 8px;
  background: var(--dshm-tile);
  border: 0.5px solid var(--dshm-divider);
  min-width: 0;
}

.dshm-stat-tile-label {
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dshm-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dshm-stat-tile-value-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}

.dshm-stat-tile-value {
  font-family: var(--dshm-font-code);
  font-size: 17px;
  font-weight: 600;
  line-height: 22px;
  color: var(--dshm-ink-1);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dshm-stat-tile-sub {
  font-size: 11px;
  color: var(--dshm-ink-4);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Context Budget Yardstick Bar */
.dshm-yardstick {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
}

.dshm-yardstick-bar {
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: var(--dshm-tile);
  display: flex;
  overflow: hidden;
}

.dshm-yardstick-seg-stable {
  height: 100%;
  background: var(--dshm-accent);
  transition: width 240ms ease;
}

.dshm-yardstick-seg-dynamic {
  height: 100%;
  background: var(--dshm-data-blue);
  transition: width 240ms ease;
}

.dshm-yardstick-legend {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
}

.dshm-doctor-note {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--dshm-ink-3);
  padding-top: 6px;
  border-top: 0.5px solid var(--dshm-divider);
}

/* ── 3. Section Group Header ── */
.dshm-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dshm-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 4px;
}

.dshm-section-head-right {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.dshm-filter-input {
  width: 184px;
  height: 28px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid var(--dshm-border-1);
  background: var(--dshm-tile);
  color: var(--dshm-ink-1);
  font-family: var(--dshm-font-sans);
  font-size: 12px;
  transition: border-color var(--dshm-timing), width var(--dshm-timing);
}

.dshm-filter-input::placeholder {
  color: var(--dshm-ink-4);
}

.dshm-filter-input:focus {
  width: 228px;
  border-color: var(--dshm-border-2);
}

.dshm-section-label {
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  letter-spacing: 0.03em;
  color: var(--dshm-ink-2);
}

.dshm-section-sub {
  font-size: 11.5px;
  color: var(--dshm-ink-4);
  font-variant-numeric: tabular-nums;
}

/* ── 4. Core Memory Grid ── */
.dshm-core-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 720px) {
  .dshm-core-grid {
    grid-template-columns: 1fr;
  }
}

.dshm-core-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--dshm-border-1);
  background: var(--dshm-card);
  min-width: 0;
}

.dshm-core-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 0.5px solid var(--dshm-divider);
}

.dshm-core-card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--dshm-ink-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dshm-core-card-tok {
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
  flex: none;
}

.dshm-core-card-body {
  font-size: 12px;
  line-height: 1.55;
  color: var(--dshm-ink-2);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 112px;
  overflow-y: auto;
}

/* ── 5. Epistemic Insights (Hindsight + OpenViking Read-Only Collapsible) ── */
.dshm-insights-details {
  border: 1px solid var(--dshm-border-1);
  border-radius: 10px;
  background: var(--dshm-panel);
  overflow: hidden;
}

.dshm-insights-summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px;
  cursor: pointer;
  user-select: none;
  transition: background-color var(--dshm-timing);
}

.dshm-insights-summary::-webkit-details-marker {
  display: none;
}

.dshm-insights-summary:hover {
  background: var(--dshm-hover);
}

.dshm-insights-summary-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.dshm-insights-summary-right {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
  flex: none;
}

.dshm-insights-details[open] > .dshm-insights-summary .dshm-process-chevron {
  transform: rotate(90deg);
  color: var(--dshm-ink-2);
}

.dshm-insights-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px;
  border-top: 0.5px solid var(--dshm-divider);
  background: var(--dshm-card);
}

.dshm-insights-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dshm-insights-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.dshm-insights-block-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dshm-ink-2);
  letter-spacing: 0.02em;
}

.dshm-insights-uri {
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
}

.dshm-network-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

@media (max-width: 640px) {
  .dshm-network-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.dshm-network-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 11px;
  border-radius: 8px;
  background: var(--dshm-tile);
  border: 0.5px solid var(--dshm-divider);
}

.dshm-network-label {
  font-family: var(--dshm-font-code);
  font-size: 10.5px;
  color: var(--dshm-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dshm-network-count {
  font-family: var(--dshm-font-code);
  font-size: 16px;
  font-weight: 600;
  color: var(--dshm-ink-1);
  font-variant-numeric: tabular-nums;
}

.dshm-network-bar {
  width: 100%;
  height: 3px;
  border-radius: 2px;
  background: var(--dshm-chip);
  overflow: hidden;
}

.dshm-network-bar-fill {
  height: 100%;
  background: var(--dshm-accent);
  border-radius: 2px;
  transition: width 240ms ease;
}

.dshm-model-list {
  display: flex;
  flex-direction: column;
  border: 0.5px solid var(--dshm-divider);
  border-radius: 8px;
  background: var(--dshm-panel);
  overflow: hidden;
}

.dshm-model-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 9px 12px;
  border-top: 0.5px solid var(--dshm-divider);
}

.dshm-model-item:first-child {
  border-top: none;
}

.dshm-model-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-model-badge {
  font-family: var(--dshm-font-code);
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dshm-chip);
  color: var(--dshm-ink-2);
  text-transform: uppercase;
}

.dshm-model-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
}

.dshm-model-summary {
  font-size: 12.5px;
  color: var(--dshm-ink-1);
  line-height: 1.5;
}

.dshm-model-uri {
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-4);
  word-break: break-all;
}

.dshm-viking-tree {
  display: flex;
  flex-direction: column;
  border: 0.5px solid var(--dshm-divider);
  border-radius: 8px;
  background: var(--dshm-panel);
  overflow: hidden;
}

.dshm-viking-cat {
  border-top: 0.5px solid var(--dshm-divider);
}

.dshm-viking-cat:first-child {
  border-top: none;
}

.dshm-viking-cat-summary,
.dshm-viking-cat-static {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 32px;
  padding: 6px 12px;
  font-size: 12px;
}

.dshm-viking-cat-summary {
  cursor: pointer;
  user-select: none;
  transition: background-color var(--dshm-timing);
}

.dshm-viking-cat-summary::-webkit-details-marker {
  display: none;
}

.dshm-viking-cat-summary:hover {
  background: var(--dshm-hover);
}

.dshm-viking-cat[open] > .dshm-viking-cat-summary .dshm-process-chevron {
  transform: rotate(90deg);
  color: var(--dshm-ink-2);
}

.dshm-viking-cat-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.dshm-viking-cat-name {
  font-weight: 500;
  color: var(--dshm-ink-1);
  flex: none;
}

.dshm-viking-cat-uri {
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dshm-viking-cat-count {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--dshm-font-code);
  font-size: 11.5px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
  flex: none;
}

.dshm-viking-samples {
  margin: 0;
  padding: 8px 14px 10px 26px;
  border-top: 0.5px solid var(--dshm-divider);
  background: var(--dshm-tile);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dshm-viking-sample {
  font-size: 12px;
  color: var(--dshm-ink-2);
  line-height: 1.45;
}

.dshm-insights-empty {
  font-size: 12px;
  color: var(--dshm-ink-3);
  padding: 6px 2px;
}

/* ── 6. Active Memories Process-Column List ── */
.dshm-process-card {
  border: 1px solid var(--dshm-border-1);
  border-radius: 8px;
  background: var(--dshm-card);
  overflow: hidden;
}

.dshm-process-item {
  margin: 0;
  border-top: 0.5px solid var(--dshm-divider);
}

.dshm-process-item:first-child {
  border-top: none;
}

.dshm-process-summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 38px;
  padding: 8px 14px;
  cursor: pointer;
  user-select: none;
  transition: background-color var(--dshm-timing);
}

.dshm-process-summary::-webkit-details-marker {
  display: none;
}

.dshm-process-summary:hover {
  background: var(--dshm-hover);
}

.dshm-process-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.dshm-process-kind {
  flex: none;
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
  width: 68px;
}

.dshm-process-kind[data-pinned="1"] {
  color: var(--dshm-accent);
}

.dshm-process-title {
  color: var(--dshm-ink-1);
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.dshm-process-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  font-size: 11.5px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
}

.dshm-process-slot {
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dshm-tile);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dshm-process-chevron {
  display: inline-block;
  color: var(--dshm-ink-4);
  font-size: 12px;
  line-height: 1;
  transition: transform var(--dshm-timing);
}

.dshm-process-item[open] .dshm-process-chevron {
  transform: rotate(90deg);
  color: var(--dshm-ink-2);
}

.dshm-process-details {
  padding: 10px 14px 14px 92px;
  border-top: 0.5px solid var(--dshm-divider);
  background: var(--dshm-panel);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

@media (max-width: 640px) {
  .dshm-process-details {
    padding-left: 14px;
  }
}

.dshm-process-content {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--dshm-ink-1);
  white-space: pre-wrap;
  word-break: break-word;
}

.dshm-process-meta-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
}

.dshm-meta-chip {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--dshm-tile);
  color: var(--dshm-ink-2);
  border: 0.5px solid var(--dshm-divider);
}

/* Empty State */
.dshm-empty-box {
  padding: 28px 20px;
  border-radius: 8px;
  border: 1px solid var(--dshm-border-1);
  background: var(--dshm-card);
  color: var(--dshm-ink-3);
  font-size: 12.5px;
  text-align: center;
  line-height: 1.6;
}

/* Subtle Load-More Pagination Control */
.dshm-load-more-row {
  display: flex;
  justify-content: center;
  padding: 8px 14px;
  border-top: 0.5px solid var(--dshm-divider);
  background: var(--dshm-panel);
}

.dshm-load-more-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--dshm-ink-2);
  font-family: var(--dshm-font-sans);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color var(--dshm-timing), color var(--dshm-timing);
}

.dshm-load-more-btn:hover:not(:disabled) {
  background: var(--dshm-hover);
  color: var(--dshm-ink-1);
}

.dshm-load-more-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* ── 7. Slow-Loop Job Log Rows ── */
.dshm-job-item {
  display: flex;
  flex-direction: column;
  border-top: 0.5px solid var(--dshm-divider);
}

.dshm-job-item:first-child {
  border-top: none;
}

.dshm-job-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
  padding: 6px 14px;
  font-size: 12px;
  color: var(--dshm-ink-2);
  font-variant-numeric: tabular-nums;
}

.dshm-job-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.dshm-job-kind {
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
  width: 84px;
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dshm-job-key {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dshm-ink-2);
  min-width: 0;
}

.dshm-job-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  font-size: 11.5px;
}

.dshm-job-attempts {
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
}

.dshm-job-time {
  color: var(--dshm-ink-4);
}

.dshm-job-error {
  padding: 0 14px 8px 108px;
  font-family: var(--dshm-font-code);
  font-size: 11px;
  line-height: 1.45;
  color: var(--dshm-danger);
  word-break: break-word;
}

@media (max-width: 640px) {
  .dshm-job-error {
    padding-left: 14px;
  }
}

/* ── 8. Claude Settings Sheet Modal (Portal + Full WCAG AA) ── */
.dshm-backdrop,
.dshm-portal-root .dshm-backdrop {
  position: fixed !important;
  inset: 0 !important;
  max-width: none !important;
  max-height: none !important;
  z-index: var(--dsh-claude-layer-takeover, var(--dsh-claude-layer-float, 99999)) !important;
  background: rgba(0, 0, 0, 0.56);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 20px !important;
  box-sizing: border-box !important;
  animation: dshmFade 150ms ease-out;
}

@keyframes dshmFade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.dshm-sheet,
.dshm-portal-root .dshm-backdrop .dshm-sheet,
body[data-dsh-claude-style] .dshm-portal-root .dshm-backdrop .dshm-sheet {
  width: min(540px, calc(100% - 8px)) !important;
  max-width: 540px !important;
  min-width: min(300px, calc(100% - 8px));
  max-height: min(88vh, 720px) !important;
  margin: auto !important;
  flex: 0 0 auto !important;
  overflow-y: auto;
  background: var(--dshm-card);
  color: var(--dshm-ink-1);
  border: 1px solid var(--dshm-border-2);
  border-radius: 12px;
  box-shadow: var(--dsw-alias-shadow-lv2, 0 12px 36px rgba(0, 0, 0, 0.42));
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-sizing: border-box !important;
  animation: dshmSheetIn var(--dsh-claude-duration-open, 220ms) var(--dsh-claude-ease-settle, cubic-bezier(0.22, 1, 0.36, 1));
}

@keyframes dshmSheetIn {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.dshm-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 0.5px solid var(--dshm-divider);
}

.dshm-sheet-title {
  margin: 0;
  font-family: var(--dshm-font-serif);
  font-size: 16px;
  font-weight: 500;
  color: var(--dshm-ink-1);
}

.dshm-sheet-close {
  appearance: none;
  border: none;
  background: transparent;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dshm-ink-3);
  cursor: pointer;
  user-select: none;
  font-size: 18px;
  line-height: 1;
  transition: background-color var(--dshm-timing), color var(--dshm-timing);
}

.dshm-sheet-close:hover {
  background: var(--dshm-hover);
  color: var(--dshm-ink-1);
}

.dshm-sheet-form {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dshm-settings-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 0;
  border-top: 0.5px solid var(--dshm-divider);
}

.dshm-settings-row:first-of-type {
  border-top: none;
  padding-top: 2px;
}

.dshm-settings-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 20px;
  flex-wrap: wrap;
}

.dshm-settings-label {
  font-size: 12.5px;
  font-weight: 500;
  line-height: 18px;
  color: var(--dshm-ink-1);
}

.dshm-settings-desc {
  font-size: 11.5px;
  color: var(--dshm-ink-3);
  line-height: 1.45;
}

.dshm-field-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  align-items: end;
}

.dshm-field-grid-ratio {
  display: grid;
  grid-template-columns: 1.5fr 1fr;
  gap: 10px;
  align-items: end;
}

.dshm-field-grid-key {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 10px;
  align-items: end;
}

@media (max-width: 520px) {
  .dshm-field-grid-2,
  .dshm-field-grid-ratio,
  .dshm-field-grid-key {
    grid-template-columns: 1fr;
  }
}

.dshm-field-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.dshm-field-input,
.dshm-field-select {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--dshm-border-1);
  background: var(--dshm-tile);
  color: var(--dshm-ink-1);
  font-family: var(--dshm-font-sans);
  font-size: 12.5px;
  box-sizing: border-box;
  transition: border-color var(--dshm-timing);
}

.dshm-field-select option {
  background: var(--dshm-card);
  color: var(--dshm-ink-1);
}

.dshm-field-input--mono {
  font-family: var(--dshm-font-code);
  font-size: 12px;
}

.dshm-field-input:focus,
.dshm-field-select:focus {
  border-color: var(--dshm-border-2);
}

/* Explicit Privacy Consent Toggle Row */
.dshm-consent-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dshm-border-1);
  background: var(--dshm-panel);
}

.dshm-consent-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.dshm-consent-checkbox {
  width: 18px;
  height: 18px;
  margin: 2px 0 0;
  accent-color: var(--dshm-accent);
  cursor: pointer;
  flex: none;
}

.dshm-key-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-family: var(--dshm-font-code);
  color: var(--dshm-valley-green);
}

.dshm-key-status--clearing {
  color: var(--dshm-peak-amber);
}

.dshm-key-action-btn {
  appearance: none;
  border: 1px solid var(--dshm-border-1);
  background: var(--dshm-panel);
  color: var(--dshm-ink-2);
  font-family: var(--dshm-font-sans);
  font-size: 11px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color var(--dshm-timing), color var(--dshm-timing);
}

.dshm-key-action-btn:hover {
  background: var(--dshm-hover-solid);
  color: var(--dshm-ink-1);
}

/* Collapsible Remote Embedding Section inside Modal */
.dshm-modal-details {
  border: 1px solid var(--dshm-border-1);
  border-radius: 8px;
  background: var(--dshm-panel);
  margin-top: 6px;
  overflow: hidden;
}

.dshm-modal-details-summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--dshm-ink-1);
}

.dshm-modal-details-summary::-webkit-details-marker {
  display: none;
}

.dshm-modal-details-summary:hover {
  background: var(--dshm-hover);
}

.dshm-modal-details[open] > .dshm-modal-details-summary .dshm-process-chevron {
  transform: rotate(90deg);
}

.dshm-modal-details-badge {
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
}

.dshm-modal-details-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  border-top: 0.5px solid var(--dshm-divider);
}

.dshm-sheet-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 12px;
  margin-top: 4px;
  border-top: 0.5px solid var(--dshm-divider);
  font-size: 11.5px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
}

.dshm-sheet-status {
  min-width: 0;
  flex: 1 1 200px;
  word-break: break-word;
}

.dshm-sheet-foot-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.dshm-sheet-hint {
  color: var(--dshm-ink-4);
  font-size: 11px;
}

.dshm-sheet-save-btn {
  appearance: none;
  height: 30px;
  padding: 0 13px;
  border-radius: 6px;
  border: 1px solid var(--dshm-accent);
  background: var(--dshm-accent);
  color: #ffffff;
  font-family: var(--dshm-font-sans);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--dshm-timing), opacity var(--dshm-timing);
}

.dshm-sheet-save-btn:hover:not(:disabled) {
  background: var(--dshm-accent-hover);
  border-color: var(--dshm-accent-hover);
}

.dshm-sheet-save-btn:disabled {
  opacity: 0.65;
  cursor: wait;
}

/* ── 9. Error Boundary Fallback ── */
.dshm-error-boundary {
  max-width: 560px;
  margin: 48px auto;
  padding: 0 20px;
}

.dshm-error-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px;
  border-radius: 10px;
  border: 1px solid var(--dshm-border-2);
  background: var(--dshm-card);
}

.dshm-error-title {
  margin: 0;
  font-family: var(--dshm-font-serif);
  font-size: 17px;
  font-weight: 500;
  color: var(--dshm-ink-1);
}

.dshm-error-desc {
  margin: 0;
  font-size: 12.5px;
  color: var(--dshm-ink-2);
}

.dshm-error-detail {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--dshm-tile);
  color: var(--dshm-danger);
  font-family: var(--dshm-font-code);
  font-size: 11.5px;
  word-break: break-word;
}

.dshm-error-retry {
  align-self: flex-start;
  appearance: none;
  height: 30px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid var(--dshm-border-2);
  background: var(--dshm-panel);
  color: var(--dshm-ink-1);
  font-family: var(--dshm-font-sans);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.dshm-error-retry:hover {
  background: var(--dshm-hover-solid);
}

/* ── 10. Reduced Motion Support ── */
@media (prefers-reduced-motion: reduce) {
  .dshm-status-dot,
  .dshm-backdrop,
  .dshm-sheet {
    animation: none !important;
  }

  .dshm-root *,
  .dshm-portal-root * {
    transition-duration: 0.01ms !important;
  }
}
`;
