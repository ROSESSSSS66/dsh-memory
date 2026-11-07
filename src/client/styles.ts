export const MEMORY_STYLES = `
/* ============================================================================
 * DSH Long-Term Memory — v0.6.0 Autonomous Studio UI
 * Reference: Nwflower/dsh-claude-style (docs/STYLE.md)
 *
 * Principles from dsh-claude-style:
 * 1. Host & skin token inheritance (--dsw-alias-*, --dsh-claude-*) with warm
 *    Claude dark (#191919) and Claude light (#ffffff) fallbacks.
 * 2. Accent (--dsw-alias-brand-primary, #d97757) stays under ~10% of elements.
 * 3. 1px outlines (--dsw-alias-border-l1), 0.5px internal separators
 *    (--dsh-claude-divider), 4 / 8 / 12 / 16px radius ladder.
 * 4. Editorial serif display title, Sans UI chrome, Mono tabular-nums figures.
 * 5. Claude Code Studio 3x2 metric panel + Process-Column expandable rows.
 * ============================================================================ */

.dshm-root {
  --dshm-canvas: var(--dsh-claude-canvas, var(--dsw-alias-bg-base, #191919));
  --dshm-panel: var(--dsw-alias-bg-layer-1, #212121);
  --dshm-card: var(--dsh-claude-card, var(--dsw-alias-bg-overlay, #232323));
  --dshm-tile: var(--dsw-specific-input-major, #141414);
  --dshm-chip: var(--dsh-claude-chip, var(--dsw-specific-selector, #282828));
  --dshm-hover: var(--dsh-claude-hover-bg, var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06)));
  --dshm-hover-solid: var(--dsw-alias-interactive-bg-hover-solid, #323232);

  --dshm-border-1: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.09));
  --dshm-border-2: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.18));
  --dshm-divider: var(--dsh-claude-divider, rgba(255, 255, 255, 0.06));

  --dshm-ink-1: var(--dsw-alias-label-primary, #fdfdfd);
  --dshm-ink-2: var(--dsw-alias-label-secondary, #beb6b8);
  --dshm-ink-3: var(--dsw-alias-label-tertiary, #9c9395);
  --dshm-ink-4: var(--dsw-alias-label-caption, #776f71);

  --dshm-accent: var(--dsw-alias-brand-primary, #d97757);
  --dshm-accent-hover: var(--dsw-alias-button-primary-hover, #eb9170);
  --dshm-accent-tint: var(--dsw-alias-state-business-tertiary, rgba(217, 119, 87, 0.14));
  --dshm-data-blue: var(--dsh-claude-data-ink, #3b6ecf);
  --dshm-valley-green: var(--dsh-claude-meter-valley, #8cbf96);
  --dshm-peak-amber: var(--dsh-claude-meter-peak, #e2a45f);
  --dshm-danger: #e06c75;

  --dshm-font-serif: var(--dsh-claude-font-serif, Georgia, "Noto Serif SC", "Source Han Serif SC", serif);
  --dshm-font-sans: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  --dshm-font-code: var(--dsh-claude-font-code, var(--ds-font-family-code, "JetBrains Mono", Consolas, monospace));

  --dshm-timing: var(--dsh-claude-timing-feedback, 120ms ease);

  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--dshm-canvas);
  color: var(--dshm-ink-1);
  color-scheme: dark;
  font-family: var(--dshm-font-sans);
  font-size: 13px;
  line-height: 1.5;
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
}

/* Light scheme fallback when host is in light mode and dsh-claude-style tokens are unset */
:root:not([data-ds-dark-theme]) .dshm-root {
  color-scheme: light;
  --dshm-canvas: var(--dsh-claude-canvas, var(--dsw-alias-bg-base, #ffffff));
  --dshm-panel: var(--dsh-claude-sidebar-canvas, var(--dsw-alias-bg-layer-1, #fafafa));
  --dshm-card: var(--dsh-claude-card, var(--dsw-alias-bg-overlay, #ffffff));
  --dshm-tile: var(--dsh-claude-table-head, #f4f4f4);
  --dshm-chip: var(--dsh-claude-chip, #f9f9f9);
  --dshm-hover: var(--dsh-claude-hover-bg, rgba(6, 6, 6, 0.05));
  --dshm-hover-solid: var(--dsw-alias-interactive-bg-hover-solid, #f4f4f4);

  --dshm-border-1: var(--dsw-alias-border-l1, #e9e9e9);
  --dshm-border-2: var(--dsw-alias-border-l2, #dedede);
  --dshm-divider: var(--dsh-claude-divider, rgba(22, 22, 22, 0.05));

  --dshm-ink-1: var(--dsw-alias-label-primary, #161616);
  --dshm-ink-2: var(--dsw-alias-label-secondary, #70686a);
  --dshm-ink-3: var(--dsw-alias-label-tertiary, #91888a);
  --dshm-ink-4: var(--dsw-alias-label-caption, #b2acad);

  --dshm-valley-green: var(--dsh-claude-meter-valley, #3d7550);
  --dshm-peak-amber: var(--dsh-claude-meter-peak, #a4621d);
  --dshm-danger: #c93b48;
}

.dshm-root *,
.dshm-root *::before,
.dshm-root *::after {
  box-sizing: border-box;
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

/* ── 1. Top Studio Header (Only the Single Model Config Button) ── */
.dshm-studio-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  user-select: none;
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

/* The ONLY Button in the Entire App: 模型配置 */
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

/* ── 2. Claude Studio 3x2 Telemetry Panel (STYLE.md §Home layouts) ── */
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
  gap: 12px;
  font-size: 12px;
  color: var(--dshm-ink-2);
}

.dshm-usage-head-title {
  font-weight: 600;
  color: var(--dshm-ink-1);
  letter-spacing: 0.01em;
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

/* ── 3. Section Group Header (STYLE.md .dsh-claude-settings-group) ── */
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
  gap: 10px;
}

.dshm-filter-input {
  width: 176px;
  height: 26px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid var(--dshm-border-1);
  background: var(--dshm-tile);
  color: var(--dshm-ink-1);
  font-family: var(--dshm-font-sans);
  font-size: 11.5px;
  outline: none;
  transition: border-color var(--dshm-timing), width var(--dshm-timing);
}

.dshm-filter-input::placeholder {
  color: var(--dshm-ink-4);
}

.dshm-filter-input:focus {
  width: 220px;
  border-color: var(--dshm-border-2);
}

.dshm-doctor-note {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--dshm-ink-3);
  padding-top: 6px;
  border-top: 0.5px solid var(--dshm-divider);
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

/* ── 4. Core Memory 3-Column Strip ── */
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
}

.dshm-core-card-tok {
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
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

/* ── 5. Claude Code Process-Column List (STYLE.md §Process rows) ── */
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
  gap: 12px;
  font-family: var(--dshm-font-code);
  font-size: 11px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
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

/* Static Job Log Row */
.dshm-job-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
  padding: 6px 14px;
  border-top: 0.5px solid var(--dshm-divider);
  font-size: 12px;
  color: var(--dshm-ink-2);
  font-variant-numeric: tabular-nums;
}

.dshm-job-row:first-child {
  border-top: none;
}

/* ── 6. Claude Settings Sheet Modal (Auto-Save, Zero Extra Buttons) ── */
.dshm-backdrop,
.dshm-root .dshm-backdrop {
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
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
.dshm-root .dshm-backdrop .dshm-sheet,
body[data-dsh-claude-style] .dshm-root .dshm-backdrop .dshm-sheet {
  width: min(520px, calc(100vw - 40px)) !important;
  max-width: 520px !important;
  min-width: min(320px, calc(100vw - 40px));
  max-height: min(86vh, 680px) !important;
  margin: auto !important;
  flex: 0 0 auto !important;
  overflow-y: auto;
  background: var(--dshm-card);
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
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dshm-ink-3);
  cursor: pointer;
  user-select: none;
  font-size: 16px;
  line-height: 1;
  transition: background-color var(--dshm-timing), color var(--dshm-timing);
}

.dshm-sheet-close:hover {
  background: var(--dshm-hover);
  color: var(--dshm-ink-1);
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
}

.dshm-settings-label {
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--dshm-ink-1);
}

.dshm-settings-desc {
  font-size: 11.5px;
  color: var(--dshm-ink-3);
  line-height: 1.45;
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
  outline: none;
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

.dshm-sheet-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 10px;
  border-top: 0.5px solid var(--dshm-divider);
  font-size: 11.5px;
  color: var(--dshm-ink-3);
  font-variant-numeric: tabular-nums;
}
`;
