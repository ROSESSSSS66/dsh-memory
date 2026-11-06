export const MEMORY_STYLE_ID = 'dsh-memory-ui-style';

export const memoryCss = `
/* ==========================================================================
   Apple-Inspired Clean & Premium Design System for DSH Long-Term Memory
   ========================================================================== */

/* Root Container & Apple Typography */
.dshm-root {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  background-color: var(--dsw-alias-bg-layer-1, #0f0f12);
  color: var(--dsw-alias-label-primary, #f5f5f7);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Segoe UI", Roboto, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  padding: 28px clamp(20px, 3.8vw, 48px) 56px;
}

.dshm-container {
  width: 100%;
  max-width: 1040px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/* ==========================================================================
   Header Area & App Identity
   ========================================================================== */
.dshm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding-bottom: 4px;
}

.dshm-header-left {
  display: flex;
  align-items: center;
  gap: 15px;
}

.dshm-brand-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: linear-gradient(145deg, #3b82f6 0%, #1d4ed8 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 16px rgba(37, 99, 235, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.3);
  color: #ffffff;
  flex-shrink: 0;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.dshm-brand-icon:hover {
  transform: scale(1.04);
}

.dshm-header-titles {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dshm-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dshm-title {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  line-height: 28px;
  letter-spacing: -0.02em;
  color: var(--dsw-alias-label-primary, #ffffff);
}

.dshm-badge-version {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 9999px;
  background: rgba(10, 132, 255, 0.12);
  color: #60a5fa;
  border: 0.5px solid rgba(10, 132, 255, 0.25);
  letter-spacing: -0.01em;
}

.dshm-subtitle {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  display: flex;
  align-items: center;
  gap: 7px;
  letter-spacing: -0.01em;
}

.dshm-dot-online {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #34c759;
  box-shadow: 0 0 8px rgba(52, 199, 89, 0.6);
  display: inline-block;
}

.dshm-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ==========================================================================
   Apple-Style Buttons & Interactive Pills
   ========================================================================== */
.dshm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  white-space: nowrap;
  user-select: none;
  font-family: inherit;
  outline: none;
}

.dshm-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none !important;
}

.dshm-btn-primary {
  background: linear-gradient(180deg, #0a84ff 0%, #0071e3 100%);
  color: #ffffff;
  border: 0.5px solid rgba(255, 255, 255, 0.15);
  box-shadow: 0 2px 6px rgba(0, 113, 227, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}

.dshm-btn-primary:hover:not(:disabled) {
  filter: brightness(1.08);
  transform: translateY(-0.5px);
  box-shadow: 0 4px 12px rgba(0, 113, 227, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.3);
}

.dshm-btn-primary:active:not(:disabled) {
  filter: brightness(0.95);
  transform: translateY(0);
}

.dshm-btn-secondary {
  background: rgba(255, 255, 255, 0.06);
  color: var(--dsw-alias-label-primary, #e2e8f0);
  border: 0.5px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.dshm-btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.11);
  border-color: rgba(255, 255, 255, 0.18);
  color: #ffffff;
}

.dshm-btn-icon-only {
  width: 32px;
  padding: 0;
}

/* Apple Dynamic Island Toast */
.dshm-toast {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(24, 24, 27, 0.88);
  backdrop-filter: blur(28px) saturate(200%);
  -webkit-backdrop-filter: blur(28px) saturate(200%);
  border: 0.5px solid rgba(255, 255, 255, 0.16);
  color: #ffffff;
  padding: 8px 18px;
  border-radius: 9999px;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.14);
  font-size: 13px;
  font-weight: 500;
  z-index: 99999;
  display: flex;
  align-items: center;
  gap: 8px;
  animation: appleSpringIn 0.32s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.dshm-toast-icon {
  font-size: 14px;
}

.dshm-toast-text {
  letter-spacing: -0.01em;
}

/* Header Status Pill */
.dshm-llm-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  outline: none;
  border: 0.5px solid transparent;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  background: transparent;
  font-family: inherit;
}

.dshm-llm-pill-active {
  background: rgba(52, 199, 89, 0.12);
  color: #34c759;
  border-color: rgba(52, 199, 89, 0.28);
}
.dshm-llm-pill-active:hover {
  background: rgba(52, 199, 89, 0.2);
  border-color: rgba(52, 199, 89, 0.4);
}

.dshm-llm-pill-warning {
  background: rgba(255, 159, 10, 0.12);
  color: #ff9f0a;
  border-color: rgba(255, 159, 10, 0.28);
}
.dshm-llm-pill-warning:hover {
  background: rgba(255, 159, 10, 0.2);
  border-color: rgba(255, 159, 10, 0.45);
}

.dshm-llm-pill-neutral {
  background: rgba(255, 255, 255, 0.06);
  color: var(--dsw-alias-label-secondary, #94a3b8);
  border-color: rgba(255, 255, 255, 0.1);
}
.dshm-llm-pill-neutral:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--dsw-alias-label-primary, #ffffff);
}

.dshm-pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dshm-pill-dot-green {
  background-color: #34c759;
  box-shadow: 0 0 6px #34c759;
}
.dshm-pill-dot-yellow {
  background-color: #ff9f0a;
  box-shadow: 0 0 6px #ff9f0a;
}
.dshm-pill-dot-gray {
  background-color: #71717a;
}

.dshm-pill-text {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ==========================================================================
   Apple-Style Glass Stat Tiles
   ========================================================================== */
.dshm-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 14px;
}

.dshm-stat-card {
  background: rgba(255, 255, 255, 0.035);
  backdrop-filter: blur(20px) saturate(190%);
  -webkit-backdrop-filter: blur(20px) saturate(190%);
  border: 0.5px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow: 0 2px 12px -2px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  position: relative;
  overflow: hidden;
}

.dshm-stat-card:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.16);
  transform: translateY(-1.5px);
  box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.dshm-stat-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dshm-stat-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  letter-spacing: -0.01em;
}

.dshm-stat-icon-wrapper {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s ease;
}

.dshm-icon-indigo {
  background: rgba(99, 102, 241, 0.14);
  color: #818cf8;
}
.dshm-icon-amber {
  background: rgba(245, 158, 11, 0.14);
  color: #fbbf24;
}
.dshm-icon-blue {
  background: rgba(10, 132, 255, 0.14);
  color: #60a5fa;
}
.dshm-icon-emerald {
  background: rgba(52, 199, 89, 0.14);
  color: #34c759;
}

.dshm-stat-value {
  font-size: 26px;
  font-weight: 600;
  line-height: 30px;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  color: var(--dsw-alias-label-primary, #ffffff);
}

.dshm-stat-unit {
  font-size: 13px;
  font-weight: normal;
  letter-spacing: normal;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  margin-left: 4px;
}

.dshm-stat-desc {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  display: flex;
  align-items: center;
  gap: 6px;
}

.dshm-stat-progress {
  width: 100%;
  height: 4px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
  margin-top: 3px;
}

.dshm-stat-progress-bar {
  height: 100%;
  border-radius: 9999px;
  transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

/* ==========================================================================
   Filter Toolbar & macOS Segmented Controls
   ========================================================================== */
.dshm-toolbar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: rgba(255, 255, 255, 0.03);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border: 0.5px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 12px 14px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.dshm-toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

/* macOS Spotlight-Style Search Box */
.dshm-search-box {
  flex: 1 1 280px;
  position: relative;
  display: flex;
  align-items: center;
}

.dshm-search-icon {
  position: absolute;
  left: 10px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  pointer-events: none;
  display: flex;
  align-items: center;
}

.dshm-search-input {
  width: 100%;
  height: 32px;
  background: rgba(0, 0, 0, 0.22);
  border: 0.5px solid rgba(255, 255, 255, 0.09);
  border-radius: 9px;
  padding: 0 28px 0 32px;
  font-size: 13px;
  color: var(--dsw-alias-label-primary, #ffffff);
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.dshm-search-input:focus {
  border-color: #0a84ff;
  box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.22);
  background: rgba(0, 0, 0, 0.3);
}

.dshm-search-clear {
  position: absolute;
  right: 8px;
  background: transparent;
  border: none;
  color: var(--dsw-alias-label-tertiary, #64748b);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}

.dshm-search-clear:hover {
  color: #ffffff;
}

/* macOS Native Segmented Control */
.dshm-segmented-group {
  display: inline-flex;
  align-items: center;
}

.dshm-segmented-control {
  display: inline-flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.26);
  padding: 2px;
  border-radius: 9px;
  border: 0.5px solid rgba(255, 255, 255, 0.06);
  gap: 2px;
}

.dshm-segment-btn {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 7px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  user-select: none;
  outline: none;
}

.dshm-segment-btn:hover {
  color: #ffffff;
}

.dshm-segment-btn.is-active {
  background: rgba(255, 255, 255, 0.13);
  color: #ffffff;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25), inset 0 0.5px 0 rgba(255, 255, 255, 0.15);
}

/* Lower Row Category Tabs */
.dshm-tabs-control {
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.26);
  padding: 2px;
  border-radius: 9px;
  border: 0.5px solid rgba(255, 255, 255, 0.06);
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
}

.dshm-tabs-control::-webkit-scrollbar {
  display: none;
}

.dshm-tab-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  white-space: nowrap;
  user-select: none;
  outline: none;
}

.dshm-tab-item:hover {
  color: #ffffff;
}

.dshm-tab-item.is-active {
  background: rgba(255, 255, 255, 0.13);
  color: #ffffff;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25), inset 0 0.5px 0 rgba(255, 255, 255, 0.15);
}

.dshm-tab-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  font-variant-numeric: tabular-nums;
}

.dshm-tab-badge.is-warm {
  background: rgba(245, 158, 11, 0.22);
  color: #fbbf24;
}

/* Filter Chips (Pinned / Frozen) */
.dshm-filter-chips {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dshm-chip-btn {
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 0.5px solid rgba(255, 255, 255, 0.09);
  background: rgba(255, 255, 255, 0.04);
  color: var(--dsw-alias-label-secondary, #94a3b8);
  font-size: 12px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  transition: all 0.16s ease;
  outline: none;
}

.dshm-chip-btn:hover {
  background: rgba(255, 255, 255, 0.09);
  color: #ffffff;
}

.dshm-chip-btn.is-active {
  background: rgba(255, 255, 255, 0.14);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.22);
}

/* Legacy fallback classes */
.dshm-tabs { display: flex; align-items: center; gap: 4px; }
.dshm-tab-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 7px; font-size: 12px; color: #94a3b8; background: transparent; border: none; cursor: pointer; }
.dshm-tab-btn.is-active { background: rgba(255, 255, 255, 0.13); color: #fff; font-weight: 600; }
.dshm-tab-count { font-size: 10px; padding: 1px 5px; border-radius: 9999px; background: rgba(255,255,255,0.08); }
.dshm-status-pills { display: flex; align-items: center; gap: 6px; }
.dshm-pill-btn { height: 26px; padding: 0 10px; font-size: 12px; border-radius: 7px; border: 0.5px solid rgba(255,255,255,0.1); background: transparent; color: #94a3b8; cursor: pointer; }
.dshm-pill-btn.is-active { background: rgba(255,255,255,0.14); color: #fff; }

/* ==========================================================================
   Apple-Style Memory Cards List
   ========================================================================== */
.dshm-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dshm-card {
  background: rgba(255, 255, 255, 0.035);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 0.5px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.18s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.18s ease;
  position: relative;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.dshm-card:hover {
  border-color: rgba(255, 255, 255, 0.18);
  transform: translateY(-1.5px);
  box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.dshm-card.is-pinned {
  border-color: rgba(245, 158, 11, 0.32);
  background: rgba(245, 158, 11, 0.025);
}

.dshm-card.is-candidate {
  border-color: rgba(249, 115, 22, 0.32);
  background: rgba(249, 115, 22, 0.025);
}

.dshm-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.dshm-card-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/* Subtle Apple Tag Pills */
.dshm-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  line-height: 14px;
  padding: 2px 7px;
  border-radius: 6px;
  letter-spacing: -0.01em;
}

.dshm-tag-preference {
  background: rgba(168, 85, 247, 0.12);
  color: #c084fc;
  border: 0.5px solid rgba(168, 85, 247, 0.25);
}

.dshm-tag-procedure {
  background: rgba(56, 189, 248, 0.12);
  color: #38bdf8;
  border: 0.5px solid rgba(56, 189, 248, 0.25);
}

.dshm-tag-fact {
  background: rgba(52, 199, 89, 0.12);
  color: #34c759;
  border: 0.5px solid rgba(52, 199, 89, 0.25);
}

.dshm-tag-semantic {
  background: rgba(148, 163, 184, 0.12);
  color: #94a3b8;
  border: 0.5px solid rgba(148, 163, 184, 0.25);
}

.dshm-tag-scope {
  background: rgba(255, 255, 255, 0.05);
  color: var(--dsw-alias-label-secondary, #94a3b8);
  border: 0.5px solid rgba(255, 255, 255, 0.08);
}

.dshm-tag-slot {
  background: rgba(99, 102, 241, 0.12);
  color: #a5b4fc;
  border: 0.5px solid rgba(99, 102, 241, 0.25);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.dshm-badge-pinned {
  background: rgba(245, 158, 11, 0.14);
  color: #fbbf24;
  border: 0.5px solid rgba(245, 158, 11, 0.28);
}

.dshm-badge-frozen {
  background: rgba(14, 165, 233, 0.14);
  color: #38bdf8;
  border: 0.5px solid rgba(14, 165, 233, 0.28);
}

.dshm-badge-candidate {
  background: rgba(249, 115, 22, 0.14);
  color: #fb923c;
  border: 0.5px solid rgba(249, 115, 22, 0.28);
}

.dshm-card-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  opacity: 0.8;
}

/* Card Actions */
.dshm-card-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.dshm-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 0.5px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.04);
  color: var(--dsw-alias-label-secondary, #94a3b8);
  cursor: pointer;
  transition: all 0.16s ease;
  outline: none;
}

.dshm-action-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.15);
  color: #ffffff;
  transform: translateY(-0.5px);
}

.dshm-action-btn.is-active {
  color: #fbbf24;
  background: rgba(245, 158, 11, 0.16);
  border-color: rgba(245, 158, 11, 0.32);
}

.dshm-action-btn.is-danger:hover {
  color: #f43f5e;
  background: rgba(244, 63, 94, 0.16);
  border-color: rgba(244, 63, 94, 0.32);
}

.dshm-action-btn-approve {
  height: 28px;
  padding: 0 10px;
  background: rgba(52, 199, 89, 0.14);
  color: #34c759;
  border: 0.5px solid rgba(52, 199, 89, 0.3);
  border-radius: 7px;
  font-size: 12px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  transition: all 0.16s ease;
}

.dshm-action-btn-approve:hover {
  background: rgba(52, 199, 89, 0.24);
  border-color: rgba(52, 199, 89, 0.45);
}

/* Card Body & Typography */
.dshm-card-content {
  font-size: 14px;
  line-height: 1.62;
  color: var(--dsw-alias-label-primary, #ffffff);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  letter-spacing: -0.01em;
}

.dshm-card-summary {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  line-height: 1.45;
  margin-top: -3px;
}

/* Card Footer Meta */
.dshm-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  padding-top: 6px;
  border-top: 0.5px solid rgba(255, 255, 255, 0.05);
  flex-wrap: wrap;
}

.dshm-card-footer-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dshm-card-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dshm-metric-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.035);
  border: 0.5px solid rgba(255, 255, 255, 0.06);
}

/* ==========================================================================
   Apple-Style Empty State
   ========================================================================== */
.dshm-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 68px 24px;
  text-align: center;
  background: rgba(255, 255, 255, 0.025);
  border: 0.5px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
}

.dshm-empty-icon {
  font-size: 38px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  margin-bottom: 4px;
}

.dshm-empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #ffffff);
  margin: 0;
  letter-spacing: -0.015em;
}

.dshm-empty-desc {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  max-width: 380px;
  margin: 0;
  line-height: 1.55;
}

/* ==========================================================================
   Apple Sheet / Modal Dialogs
   ========================================================================== */
.dshm-modal-overlay,
.dshm-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  animation: dshmFadeIn 0.18s ease-out;
}

.dshm-modal {
  background: rgba(26, 26, 30, 0.94);
  backdrop-filter: blur(40px) saturate(200%);
  -webkit-backdrop-filter: blur(40px) saturate(200%);
  border: 0.5px solid rgba(255, 255, 255, 0.14);
  border-radius: 18px;
  width: 100%;
  max-width: 620px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 28px 70px -10px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.12);
  animation: appleModalIn 0.24s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
}

.dshm-modal-config {
  max-width: 680px;
}

.dshm-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px;
  border-bottom: 0.5px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.02);
}

.dshm-modal-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary, #ffffff);
}

.dshm-modal-body {
  padding: 22px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dshm-modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 22px;
  border-top: 0.5px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.02);
}

/* Modal Form Fields */
.dshm-form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dshm-form-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #ffffff);
  letter-spacing: -0.01em;
}

.dshm-form-input, .dshm-form-textarea, .dshm-form-select {
  width: 100%;
  background: rgba(0, 0, 0, 0.28);
  border: 0.5px solid rgba(255, 255, 255, 0.1);
  border-radius: 9px;
  padding: 9px 12px;
  font-size: 13px;
  color: var(--dsw-alias-label-primary, #ffffff);
  box-sizing: border-box;
  outline: none;
  font-family: inherit;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.dshm-form-input:focus, .dshm-form-textarea:focus, .dshm-form-select:focus {
  border-color: #0a84ff;
  box-shadow: 0 0 0 3px rgba(10, 132, 255, 0.22);
  background: rgba(0, 0, 0, 0.36);
}

.dshm-form-textarea {
  min-height: 120px;
  resize: vertical;
  line-height: 1.55;
}

.dshm-form-row {
  display: flex;
  gap: 12px;
  width: 100%;
}

.dshm-col-half { flex: 1; }
.dshm-col-third { flex: 1; }

.dshm-required {
  color: #ff453a;
  margin-left: 2px;
}

.dshm-form-hint {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #64748b);
  line-height: 1.45;
}

.dshm-badge-has-key {
  margin-left: 8px;
  font-size: 11px;
  font-weight: normal;
  color: #34c759;
  background: rgba(52, 199, 89, 0.12);
  padding: 1px 7px;
  border-radius: 4px;
}

.dshm-input-with-action {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.dshm-input-action-btn {
  position: absolute;
  right: 8px;
  background: transparent;
  border: none;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5px;
  border-radius: 5px;
  transition: all 0.15s ease;
}

.dshm-input-action-btn:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.08);
}

/* ==========================================================================
   Config Modal Sections & Presets
   ========================================================================== */
.dshm-config-title-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dshm-config-icon-badge {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(145deg, #0a84ff 0%, #0071e3 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  box-shadow: 0 4px 12px rgba(10, 132, 255, 0.35);
  flex-shrink: 0;
}

.dshm-config-header-desc {
  display: block;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  margin-top: 2px;
}

.dshm-config-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: rgba(255, 255, 255, 0.025);
  border: 0.5px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 14px 16px;
}

.dshm-config-section-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary, #ffffff);
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Apple-Style Presets Grid */
.dshm-presets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.dshm-preset-card {
  background: rgba(255, 255, 255, 0.04);
  border: 0.5px solid rgba(255, 255, 255, 0.09);
  border-radius: 10px;
  padding: 11px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  text-align: left;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  font-family: inherit;
  outline: none;
}

.dshm-preset-card:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(10, 132, 255, 0.5);
  transform: translateY(-0.5px);
}

.dshm-preset-card-active {
  background: rgba(10, 132, 255, 0.12);
  border-color: #0a84ff;
  box-shadow: 0 0 0 1px #0a84ff, 0 4px 12px rgba(10, 132, 255, 0.2);
}

.dshm-preset-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #ffffff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.01em;
}

.dshm-preset-tag {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 5px;
  background: rgba(10, 132, 255, 0.2);
  color: #93c5fd;
  flex-shrink: 0;
}

/* Protocol Selector Tabs (macOS Segmented) */
.dshm-protocol-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  width: 100%;
}

.dshm-protocol-tab {
  background: rgba(0, 0, 0, 0.24);
  border: 0.5px solid rgba(255, 255, 255, 0.08);
  border-radius: 9px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  font-family: inherit;
  outline: none;
}

.dshm-protocol-tab:hover {
  border-color: rgba(10, 132, 255, 0.5);
  background: rgba(10, 132, 255, 0.08);
}

.dshm-protocol-tab-active {
  border-color: #0a84ff;
  background: rgba(10, 132, 255, 0.15);
  box-shadow: 0 0 0 1px #0a84ff;
}

.dshm-proto-code {
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #ffffff);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.dshm-proto-desc {
  font-size: 10px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
}

/* LLM Test Box */
.dshm-config-test-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: rgba(10, 132, 255, 0.05);
  border: 0.5px solid rgba(10, 132, 255, 0.2);
  border-radius: 12px;
  padding: 11px 15px;
  flex-wrap: wrap;
}

.dshm-test-box-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dshm-test-hint {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
}

.dshm-test-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 500;
}

.dshm-test-badge-ok {
  background: rgba(52, 199, 89, 0.15);
  color: #34c759;
  border: 0.5px solid rgba(52, 199, 89, 0.3);
}

.dshm-test-badge-err {
  background: rgba(255, 69, 58, 0.15);
  color: #ff453a;
  border: 0.5px solid rgba(255, 69, 58, 0.3);
}

/* Consent Card & iOS-Style Switch */
.dshm-consent-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: rgba(0, 0, 0, 0.2);
  border: 0.5px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 13px 15px;
}

.dshm-consent-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dshm-consent-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #60a5fa;
}

.dshm-consent-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary, #ffffff);
}

.dshm-consent-desc {
  margin: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  line-height: 1.45;
}

/* Apple iOS Toggle Switch */
.dshm-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
}

.dshm-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.dshm-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(255, 255, 255, 0.16);
  transition: all 0.24s cubic-bezier(0.16, 1, 0.3, 1);
  border-radius: 24px;
  border: 0.5px solid rgba(255, 255, 255, 0.1);
}

.dshm-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 2.5px;
  bottom: 2.5px;
  background-color: #ffffff;
  transition: all 0.24s cubic-bezier(0.16, 1, 0.3, 1);
  border-radius: 50%;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);
}

input:checked + .dshm-slider {
  background-color: #34c759;
  border-color: #34c759;
}

input:checked + .dshm-slider:before {
  transform: translateX(20px);
}

/* ==========================================================================
   Smooth Apple Animations
   ========================================================================== */
@keyframes appleModalIn {
  from {
    transform: scale(0.96) translateY(6px);
    opacity: 0;
  }
  to {
    transform: scale(1) translateY(0);
    opacity: 1;
  }
}

@keyframes appleSpringIn {
  from {
    transform: translate(-50%, -12px) scale(0.95);
    opacity: 0;
  }
  to {
    transform: translate(-50%, 0) scale(1);
    opacity: 1;
  }
}

@keyframes dshmFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes dshmScaleIn {
  from { transform: scale(0.97); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

.dshm-spin {
  animation: dshmSpin 1s linear infinite;
}

@keyframes dshmSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ==========================================================================
   View Mode Segmented Control
   ========================================================================== */
.dshm-segmented-view {
  background: rgba(255, 255, 255, 0.06);
  padding: 3px;
  border-radius: 9px;
  border: 0.5px solid rgba(255, 255, 255, 0.08);
}

/* ==========================================================================
   Clickable Stat Cards & Stat Links
   ========================================================================== */
.dshm-stat-card.is-clickable {
  cursor: pointer;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.2s ease, box-shadow 0.2s ease;
}
.dshm-stat-card.is-clickable:hover {
  transform: translateY(-2px);
  border-color: rgba(59, 130, 246, 0.35);
  box-shadow: 0 10px 24px -6px rgba(0, 0, 0, 0.3);
}

.dshm-stat-link {
  cursor: pointer;
  border-radius: 4px;
  padding: 1px 4px;
  transition: background 0.15s ease, color 0.15s ease;
}
.dshm-stat-link:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--dsw-alias-label-primary, #ffffff);
}

/* ==========================================================================
   Sort Select Dropdown
   ========================================================================== */
.dshm-sort-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.dshm-sort-icon {
  position: absolute;
  left: 10px;
  pointer-events: none;
  color: var(--dsw-alias-label-tertiary, #94a3b8);
  display: flex;
  align-items: center;
}

.dshm-sort-select {
  appearance: none;
  -webkit-appearance: none;
  background: rgba(255, 255, 255, 0.05);
  border: 0.5px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary, #cbd5e1);
  font-size: 12px;
  padding: 6px 14px 6px 28px;
  cursor: pointer;
  outline: none;
  font-family: inherit;
  transition: all 0.18s ease;
}
.dshm-sort-select:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
  color: var(--dsw-alias-label-primary, #ffffff);
}
.dshm-sort-select:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
}

/* ==========================================================================
   Card Checkbox & Selection State
   ========================================================================== */
.dshm-checkbox-label {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  margin-right: 2px;
}

.dshm-checkbox {
  appearance: none;
  -webkit-appearance: none;
  width: 15px;
  height: 15px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.05);
  cursor: pointer;
  outline: none;
  position: relative;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}
.dshm-checkbox:checked {
  background: #3b82f6;
  border-color: #3b82f6;
}
.dshm-checkbox:checked::after {
  content: "";
  position: absolute;
  top: 1.5px;
  left: 4.5px;
  width: 4px;
  height: 8px;
  border: solid #ffffff;
  border-width: 0 1.8px 1.8px 0;
  transform: rotate(45deg);
}

.dshm-card.is-selected {
  border-color: rgba(59, 130, 246, 0.55) !important;
  background: linear-gradient(180deg, rgba(59, 130, 246, 0.08) 0%, rgba(24, 24, 27, 0.75) 100%) !important;
  box-shadow: 0 4px 20px rgba(59, 130, 246, 0.15) !important;
}

/* ==========================================================================
   Floating Batch Actions Bar
   ========================================================================== */
.dshm-batch-bar {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: rgba(18, 18, 24, 0.88);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border: 0.5px solid rgba(255, 255, 255, 0.16);
  border-radius: 14px;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.12);
  animation: appleSpringIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  color: #ffffff;
  max-width: 90vw;
  flex-wrap: wrap;
}

.dshm-batch-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.01em;
}

.dshm-batch-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: #3b82f6;
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
}

.dshm-batch-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dshm-batch-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  background: rgba(255, 255, 255, 0.08);
  border: 0.5px solid rgba(255, 255, 255, 0.12);
  color: var(--dsw-alias-label-primary, #ffffff);
  cursor: pointer;
  outline: none;
  font-family: inherit;
  transition: all 0.18s ease;
}
.dshm-batch-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.24);
  transform: translateY(-1px);
}
.dshm-batch-btn:active {
  transform: translateY(0);
}

.dshm-batch-btn-primary {
  background: #2563eb;
  border-color: #3b82f6;
  color: #ffffff;
}
.dshm-batch-btn-primary:hover {
  background: #1d4ed8;
}

.dshm-batch-btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--dsw-alias-label-secondary, #94a3b8);
}
.dshm-batch-btn-ghost:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}

.dshm-batch-divider {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.14);
  margin: 0 4px;
}

/* ==========================================================================
   Obsidian-Style Knowledge Graph View
   ========================================================================== */
.dshm-graph-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}

.dshm-graph-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--dsw-alias-bg-layer-2, #18181b);
  border: 0.5px solid var(--dsw-alias-border, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  flex-wrap: wrap;
}

.dshm-graph-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dshm-graph-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: 11.5px;
  font-weight: 500;
  background: rgba(255, 255, 255, 0.04);
  border: 0.5px solid rgba(255, 255, 255, 0.08);
  color: var(--dsw-alias-label-secondary, #94a3b8);
  cursor: pointer;
  outline: none;
  font-family: inherit;
  transition: all 0.16s ease;
}
.dshm-graph-pill:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--dsw-alias-label-primary, #ffffff);
}
.dshm-graph-pill.is-active {
  background: rgba(59, 130, 246, 0.15);
  border-color: rgba(59, 130, 246, 0.4);
  color: #60a5fa;
}

.dshm-graph-search {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 0.5px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary, #94a3b8);
}
.dshm-graph-search input {
  background: transparent;
  border: none;
  outline: none;
  font-size: 11.5px;
  color: var(--dsw-alias-label-primary, #ffffff);
  width: 140px;
  font-family: inherit;
}
.dshm-graph-search button {
  background: transparent;
  border: none;
  outline: none;
  color: var(--dsw-alias-label-tertiary, #64748b);
  cursor: pointer;
  padding: 0;
  display: flex;
}

.dshm-graph-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.dshm-graph-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.06);
  border: 0.5px solid rgba(255, 255, 255, 0.1);
  color: var(--dsw-alias-label-secondary, #94a3b8);
  cursor: pointer;
  outline: none;
  font-family: inherit;
  transition: all 0.15s ease;
}
.dshm-graph-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #ffffff;
}

.dshm-graph-viewport {
  position: relative;
  width: 100%;
  height: 580px;
  background: radial-gradient(circle at center, #181820 0%, #0d0d12 100%);
  border: 0.5px solid var(--dsw-alias-border, rgba(255, 255, 255, 0.1));
  border-radius: 16px;
  overflow: hidden;
  user-select: none;
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.4);
}

.dshm-graph-status {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  font-size: 13px;
}

.dshm-graph-tooltip {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 260px;
  padding: 12px 14px;
  background: rgba(24, 24, 32, 0.88);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 0.5px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: appleModalIn 0.2s ease;
  z-index: 10;
}

.dshm-tooltip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dshm-tooltip-conn {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #94a3b8);
}

.dshm-tooltip-body {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary, #ffffff);
  word-break: break-word;
}

.dshm-tooltip-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: #60a5fa;
  cursor: pointer;
  padding-top: 4px;
  border-top: 0.5px solid rgba(255, 255, 255, 0.08);
}
.dshm-tooltip-footer:hover {
  text-decoration: underline;
}

.dshm-graph-legend {
  position: absolute;
  bottom: 12px;
  left: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #94a3b8);
  background: rgba(15, 15, 20, 0.7);
  padding: 6px 12px;
  border-radius: 8px;
  backdrop-filter: blur(12px);
  border: 0.5px solid rgba(255, 255, 255, 0.06);
  flex-wrap: wrap;
}

.dshm-legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
}

.dshm-legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.dshm-legend-divider {
  opacity: 0.3;
}

/* ==========================================================================
   Backup & Import/Export Modal Styles
   ========================================================================== */
.dshm-modal-tabs {
  display: flex;
  border-bottom: 0.5px solid rgba(255, 255, 255, 0.1);
  padding: 0 18px;
  gap: 16px;
}

.dshm-modal-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 4px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--dsw-alias-label-secondary, #94a3b8);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.18s ease;
}
.dshm-modal-tab:hover {
  color: var(--dsw-alias-label-primary, #ffffff);
}
.dshm-modal-tab.is-active {
  color: #3b82f6;
  border-bottom-color: #3b82f6;
}

.dshm-export-grid {
  display: grid;
  grid-templateColumns: 1fr 1fr;
  gap: 12px;
}

.dshm-export-card {
  display: flex;
  gap: 12px;
  padding: 14px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #18181b);
  border: 0.5px solid var(--dsw-alias-border, rgba(255, 255, 255, 0.08));
  transition: all 0.2s ease;
}
.dshm-export-card:hover {
  border-color: rgba(59, 130, 246, 0.4);
  background: rgba(59, 130, 246, 0.05);
  transform: translateY(-1px);
}

.dshm-export-card-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.dshm-export-card-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dshm-export-card-info h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #ffffff);
}
.dshm-export-card-info p {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary, #94a3b8);
}
`;


export function ensureMemoryStyle() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  if (document.getElementById(MEMORY_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MEMORY_STYLE_ID;
  style.textContent = memoryCss;
  (document.head || document.documentElement)?.appendChild?.(style);
}
