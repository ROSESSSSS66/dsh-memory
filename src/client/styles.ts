const STYLE_ID = 'dsh-memory-ui-styles-v7-glassmorphism';

export function ensureMemoryStyle(): void {
  if (typeof document === 'undefined') return;
  const legacy = document.querySelectorAll?.('style[id^="dsh-memory-ui-style"]');
  if (legacy) {
    legacy.forEach((el) => {
      if (el.id !== STYLE_ID) el.parentNode?.removeChild(el);
    });
  }
  const existing = document.getElementById(STYLE_ID);
  if (existing) {
    if (existing.textContent !== MEMORY_CSS) existing.textContent = MEMORY_CSS;
    return;
  }
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = MEMORY_CSS;
  document.head.appendChild(style);
}

export const MEMORY_CSS = `
/* ============================================================================
 * 1. DSH Glassmorphism Design Tokens & Root Theme Variables
 *    Fixes the white-on-white contrast bug by anchoring all surfaces to
 *    translucent glass layers over a deep ambient dark canvas.
 * ============================================================================ */
.dshm-root,
.dshm-root[data-glass-variant="light"] {
  --dshm-bg-canvas: #090d16;
  --dshm-glass-bg: rgba(255, 255, 255, 0.1);
  --dshm-glass-bg-hover: rgba(255, 255, 255, 0.18);
  --dshm-glass-bg-elevated: rgba(255, 255, 255, 0.13);
  --dshm-glass-input-bg: rgba(255, 255, 255, 0.1);
  --dshm-glass-input-hover: rgba(255, 255, 255, 0.16);
  --dshm-glass-border: rgba(255, 255, 255, 0.18);
  --dshm-glass-border-hover: rgba(255, 255, 255, 0.3);
  --dshm-glass-highlight: inset 0 1px 0 0 rgba(255, 255, 255, 0.22);
  --dshm-glass-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.32), inset 0 1px 0 0 rgba(255, 255, 255, 0.18);

  --dshm-text-primary: #f8fafc;
  --dshm-text-secondary: #cbd5e1;
  --dshm-text-muted: #94a3b8;

  --dshm-brand: #4d6bfe;
  --dshm-brand-hover: #637efe;
  --dshm-brand-soft: rgba(77, 107, 254, 0.22);
  --dshm-brand-border: rgba(116, 141, 255, 0.45);
  --dshm-brand-text: #93abff;

  --dshm-success: #10b981;
  --dshm-success-soft: rgba(16, 185, 129, 0.2);
  --dshm-warning: #f59e0b;
  --dshm-warning-soft: rgba(245, 158, 11, 0.2);
  --dshm-danger: #f43f5e;
  --dshm-danger-soft: rgba(244, 63, 94, 0.2);
  --dshm-purple: #a855f7;
  --dshm-purple-soft: rgba(168, 85, 247, 0.2);
  --dshm-cyan: #06b6d4;
  --dshm-cyan-soft: rgba(6, 182, 212, 0.2);

  --dshm-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --dshm-font-mono: "JetBrains Mono", "Fira Code", "SFMono-Regular", Consolas, monospace;
}

/* Black-based Dark Glass Variant */
.dshm-root[data-glass-variant="dark"] {
  --dshm-bg-canvas: #06080f;
  --dshm-glass-bg: rgba(0, 0, 0, 0.38);
  --dshm-glass-bg-hover: rgba(0, 0, 0, 0.54);
  --dshm-glass-bg-elevated: rgba(10, 14, 24, 0.55);
  --dshm-glass-input-bg: rgba(0, 0, 0, 0.36);
  --dshm-glass-input-hover: rgba(0, 0, 0, 0.5);
  --dshm-glass-border: rgba(255, 255, 255, 0.18);
  --dshm-glass-border-hover: rgba(255, 255, 255, 0.28);
  --dshm-glass-highlight: inset 0 1px 0 0 rgba(255, 255, 255, 0.12);
  --dshm-glass-shadow: 0 10px 36px 0 rgba(0, 0, 0, 0.52), inset 0 1px 0 0 rgba(255, 255, 255, 0.12);
}

/* ============================================================================
 * 2. Tailwind CSS Utility Classes & Custom Glassmorphism Utility Classes
 *    (@layer utilities equivalent for standalone/bundled client CSS)
 *    - backdrop-filter: blur(16px)
 *    - background: rgba(255,255,255,0.1)
 *    - border: 1px solid rgba(255,255,255,0.18)
 *    - hover increases background opacity
 *    - Light Glass (.glass-light) & Dark Glass (.glass-dark) variants
 * ============================================================================ */

.glass-base {
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.18);
  transition: background-color 0.2s cubic-bezier(0.16, 1, 0.3, 1),
              background 0.2s cubic-bezier(0.16, 1, 0.3, 1),
              border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1),
              box-shadow 0.2s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

/* White-based Light Glass Variant (.glass-light) */
.glass-light {
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.28), inset 0 1px 0 0 rgba(255, 255, 255, 0.2);
  color: #f8fafc;
}

.glass-light-hover:hover {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.3);
  box-shadow: 0 12px 36px 0 rgba(0, 0, 0, 0.36), inset 0 1px 0 0 rgba(255, 255, 255, 0.28);
}

.glass-light-focus:focus,
.glass-light-focus:focus-within {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(116, 141, 255, 0.65);
  box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.25), inset 0 1px 0 0 rgba(255, 255, 255, 0.25);
}

/* Black-based Dark Glass Variant (.glass-dark) */
.glass-dark {
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  background: rgba(0, 0, 0, 0.36);
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 10px 36px 0 rgba(0, 0, 0, 0.48), inset 0 1px 0 0 rgba(255, 255, 255, 0.12);
  color: #f8fafc;
}

.glass-dark-hover:hover {
  background: rgba(0, 0, 0, 0.54);
  border-color: rgba(255, 255, 255, 0.28);
  box-shadow: 0 14px 40px 0 rgba(0, 0, 0, 0.58), inset 0 1px 0 0 rgba(255, 255, 255, 0.18);
}

.glass-dark-focus:focus,
.glass-dark-focus:focus-within {
  background: rgba(0, 0, 0, 0.54);
  border-color: rgba(116, 141, 255, 0.65);
  box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.28), inset 0 1px 0 0 rgba(255, 255, 255, 0.16);
}

/* GlassButton Intent Variants (retaining blur(16px) & border rgba(255,255,255,0.18)) */
.glass-btn {
  cursor: pointer;
}
.glass-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.glass-btn.glass-btn-primary,
.dshm-btn-primary {
  background: linear-gradient(135deg, rgba(77, 107, 254, 0.68), rgba(99, 102, 241, 0.58));
  border: 1px solid rgba(255, 255, 255, 0.26);
  color: #ffffff;
  font-weight: 600;
}
.glass-btn.glass-btn-primary:hover:not(:disabled),
.dshm-btn-primary:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(77, 107, 254, 0.88), rgba(99, 102, 241, 0.78));
  border-color: rgba(255, 255, 255, 0.42);
  box-shadow: 0 6px 20px rgba(77, 107, 254, 0.38);
}

.glass-btn.glass-btn-success,
.dshm-action-btn-approve {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 600;
  background: rgba(16, 185, 129, 0.22);
  border: 1px solid rgba(16, 185, 129, 0.42);
  color: #6ee7b7;
  cursor: pointer;
  transition: all 0.18s ease;
}
.glass-btn.glass-btn-success:hover:not(:disabled),
.dshm-action-btn-approve:hover:not(:disabled) {
  background: rgba(16, 185, 129, 0.38);
  border-color: rgba(16, 185, 129, 0.62);
  color: #ecfdf5;
}

.glass-btn.glass-btn-warning,
.is-active-amber {
  background: rgba(245, 158, 11, 0.24) !important;
  border-color: rgba(245, 158, 11, 0.48) !important;
  color: #fde68a !important;
}
.glass-btn.glass-btn-warning:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.38) !important;
}

.glass-btn.glass-btn-danger,
.dshm-action-btn.is-danger {
  background: rgba(244, 63, 94, 0.2);
  border-color: rgba(244, 63, 94, 0.4);
  color: #fda4af;
}
.glass-btn.glass-btn-danger:hover:not(:disabled),
.dshm-action-btn.is-danger:hover:not(:disabled) {
  background: rgba(244, 63, 94, 0.36);
  border-color: rgba(244, 63, 94, 0.6);
  color: #fff1f2;
}

.glass-btn.glass-btn-ghost,
.dshm-btn-ghost {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.12);
  color: var(--dshm-text-secondary);
}
.glass-btn.glass-btn-ghost:hover:not(:disabled),
.dshm-btn-ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
  color: #ffffff;
}

/* Tailwind CSS Utility Classes used by GlassCard, GlassButton, GlassInput, GlassModal, GlassNavbar */
.relative { position: relative; }
.fixed { position: fixed; }
.inset-0 { top: 0; right: 0; bottom: 0; left: 0; }
.z-\\[9999\\] { z-index: 9999; }
.flex { display: flex; }
.inline-flex { display: inline-flex; }
.flex-col { flex-direction: column; }
.flex-wrap { flex-wrap: wrap; }
.items-center { align-items: center; }
.justify-center { justify-content: center; }
.justify-between { justify-content: space-between; }
.gap-1\\.5 { gap: 6px; }
.gap-3 { gap: 12px; }
.h-7 { height: 28px; }
.h-8 { height: 32px; }
.h-10 { height: 40px; }
.w-8 { width: 32px; }
.w-full { width: 100%; }
.max-w-lg { max-width: 540px; width: 100%; }
.max-w-xl { max-width: 640px; width: 100%; }
.max-w-2xl { max-width: 780px; width: 100%; }
.max-h-\\[86vh\\] { max-height: 86vh; }
.p-0 { padding: 0; }
.p-1\\.5 { padding: 6px; }
.p-4 { padding: 16px; }
.p-5 { padding: 20px; }
.px-2\\.5 { padding-left: 10px; padding-right: 10px; }
.py-1 { padding-top: 4px; padding-bottom: 4px; }
.px-3 { padding-left: 12px; padding-right: 12px; }
.py-1\\.5 { padding-top: 6px; padding-bottom: 6px; }
.px-3\\.5 { padding-left: 14px; padding-right: 14px; }
.py-2 { padding-top: 8px; padding-bottom: 8px; }
.px-4 { padding-left: 16px; padding-right: 16px; }
.py-3 { padding-top: 12px; padding-bottom: 12px; }
.pl-8 { padding-left: 32px; }
.pr-8 { padding-right: 32px; }
.overflow-hidden { overflow: hidden; }
.rounded-lg { border-radius: 8px; }
.rounded-xl { border-radius: 12px; }
.rounded-2xl { border-radius: 16px; }
.text-\\[11px\\] { font-size: 11px; }
.text-xs { font-size: 12px; }
.text-sm { font-size: 13px; }
.font-medium { font-weight: 500; }
.text-white { color: #ffffff; }
.text-slate-100 { color: #f1f5f9; }
.placeholder-slate-400::placeholder,
.placeholder\\:text-slate-400::placeholder { color: #94a3b8; }
.outline-none { outline: none; }
.resize-y { resize: vertical; }
.cursor-pointer { cursor: pointer; }
.select-none { user-select: none; }
.transition-all { transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
.duration-200 { transition-duration: 200ms; }
.shadow-glass { box-shadow: var(--dshm-glass-shadow); }
.shadow-glass-lg { box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55), inset 0 1px 0 0 rgba(255, 255, 255, 0.22); }
.disabled\\:opacity-45:disabled { opacity: 0.45; }
.disabled\\:cursor-not-allowed:disabled { cursor: not-allowed; }

/* ============================================================================
 * 3. Root Layout & Ambient Glassmorphism Background
 * ============================================================================ */
.dshm-root {
  position: relative;
  min-height: 100%;
  width: 100%;
  box-sizing: border-box;
  background-color: var(--dshm-bg-canvas);
  background-image:
    radial-gradient(circle at 12% 10%, rgba(77, 107, 254, 0.26) 0%, transparent 42%),
    radial-gradient(circle at 86% 16%, rgba(168, 85, 247, 0.22) 0%, transparent 40%),
    radial-gradient(circle at 50% 88%, rgba(16, 185, 129, 0.15) 0%, transparent 46%);
  color: var(--dshm-text-primary);
  font-family: var(--dshm-font-sans);
  font-size: 13px;
  line-height: 1.5;
  overflow-x: hidden;
  padding: 18px 22px 48px;
}

.dshm-root *,
.dshm-root *::before,
.dshm-root *::after {
  box-sizing: border-box;
}

.dshm-ambient-orb {
  position: fixed;
  border-radius: 9999px;
  filter: blur(80px);
  pointer-events: none;
  z-index: 0;
  opacity: 0.55;
}
.dshm-ambient-orb.is-orb-1 {
  width: 340px;
  height: 340px;
  top: -80px;
  left: -60px;
  background: radial-gradient(circle, rgba(77, 107, 254, 0.45), transparent 70%);
}
.dshm-ambient-orb.is-orb-2 {
  width: 320px;
  height: 320px;
  top: 15%;
  right: -80px;
  background: radial-gradient(circle, rgba(168, 85, 247, 0.38), transparent 70%);
}
.dshm-ambient-orb.is-orb-3 {
  width: 300px;
  height: 300px;
  bottom: -90px;
  left: 32%;
  background: radial-gradient(circle, rgba(6, 182, 212, 0.28), transparent 70%);
}

.dshm-container {
  position: relative;
  z-index: 1;
  max-width: 1360px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Fix Windows <select><option> white-on-white dropdown issue */
.dshm-root select option {
  background-color: #111827;
  color: #f8fafc;
}

/* ============================================================================
 * 4. GlassInput Inner Wrapper & Slots
 * ============================================================================ */
.glass-input-wrapper,
.dshm-search-box {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.dshm-search-icon {
  position: absolute;
  left: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dshm-text-muted);
  pointer-events: none;
  z-index: 2;
}

.glass-input {
  color: var(--dshm-text-primary);
  font-family: inherit;
  padding: 7px 12px;
}

.glass-input.has-left-icon {
  padding-left: 32px;
}

.glass-input.has-right-slot {
  padding-right: 34px;
}

.dshm-kbd-hint {
  position: absolute;
  right: 9px;
  padding: 1px 6px;
  border-radius: 5px;
  font-family: var(--dshm-font-mono);
  font-size: 10.5px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: var(--dshm-text-muted);
  pointer-events: none;
}

.dshm-search-clear {
  position: absolute;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  border: none;
  background: rgba(255, 255, 255, 0.14);
  color: var(--dshm-text-secondary);
  cursor: pointer;
}
.dshm-search-clear:hover {
  background: rgba(255, 255, 255, 0.26);
  color: #ffffff;
}

/* ============================================================================
 * 5. GlassNavbar Header & Workspace Navigation (MemoryHeader.tsx)
 * ============================================================================ */
.glass-navbar.dshm-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dshm-header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.dshm-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dshm-brand-icon {
  width: 38px;
  height: 38px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #93abff;
  flex-shrink: 0;
}

.dshm-header-titles {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dshm-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--dshm-text-primary);
}

.dshm-subtitle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
}

.dshm-dot-online {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #10b981;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.8);
  display: inline-block;
}

.dshm-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  display: inline-block;
}
.dshm-pill-dot-green {
  background: #10b981;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.75);
}
.dshm-pill-dot-yellow {
  background: #f59e0b;
}
.dshm-pill-dot-gray {
  background: #94a3b8;
}

.dshm-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.glass-navbar-tabs.dshm-nav-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px;
  border-radius: 12px;
}

.glass-nav-item.dshm-nav-item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 13px;
  border-radius: 9px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dshm-text-secondary);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
}

.glass-nav-item.dshm-nav-item.is-active {
  background: rgba(77, 107, 254, 0.28);
  border-color: rgba(116, 141, 255, 0.5);
  color: #ffffff;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
}

.dshm-nav-badge,
.dshm-tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 17px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.14);
  color: var(--dshm-text-primary);
}

.dshm-nav-badge.is-warm,
.dshm-tab-badge.is-warm {
  background: rgba(245, 158, 11, 0.28);
  border: 1px solid rgba(245, 158, 11, 0.5);
  color: #fde68a;
}

/* ============================================================================
 * 6. Top 4 Bento Stat Cards (StatCards.tsx)
 * ============================================================================ */
.dshm-stats-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 1024px) {
  .dshm-stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 600px) {
  .dshm-stats-grid {
    grid-template-columns: 1fr;
  }
}

.dshm-stat-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 14px;
}

.dshm-stat-card.is-clickable {
  cursor: pointer;
}

.dshm-stat-top,
.dshm-stat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.dshm-stat-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--dshm-text-secondary);
}

.dshm-stat-icon-wrapper {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.16);
}
.dshm-icon-blue {
  background: rgba(77, 107, 254, 0.22);
  color: #93abff;
}
.dshm-icon-purple {
  background: rgba(168, 85, 247, 0.22);
  color: #d8b4fe;
}
.dshm-icon-emerald {
  background: rgba(16, 185, 129, 0.22);
  color: #6ee7b7;
}
.dshm-icon-indigo {
  background: rgba(99, 102, 241, 0.22);
  color: #a5b4fc;
}
.dshm-icon-amber {
  background: rgba(245, 158, 11, 0.22);
  color: #fcd34d;
}

.dshm-stat-value-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.dshm-stat-value {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--dshm-text-primary);
}

.dshm-stat-unit {
  font-size: 12px;
  font-weight: 500;
  color: var(--dshm-text-muted);
}

.dshm-stat-subpill,
.dshm-stat-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: var(--dshm-text-secondary);
}

.dshm-stat-subpill.is-clickable-pill:hover {
  background: rgba(77, 107, 254, 0.26);
  border-color: rgba(116, 141, 255, 0.5);
  color: #ffffff;
}

.dshm-stat-progress {
  width: 100%;
  height: 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}

.dshm-stat-progress-bar {
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s ease;
}
.dshm-stat-progress-bar.is-blue {
  background: linear-gradient(90deg, #4d6bfe, #818cf8);
}
.dshm-stat-progress-bar.is-purple {
  background: linear-gradient(90deg, #a855f7, #ec4899);
}
.dshm-stat-progress-bar.is-emerald,
.dshm-stat-progress-bar.is-safe {
  background: linear-gradient(90deg, #10b981, #34d399);
}
.dshm-stat-progress-bar.is-indigo {
  background: linear-gradient(90deg, #6366f1, #38bdf8);
}
.dshm-stat-progress-bar.is-danger {
  background: linear-gradient(90deg, #f43f5e, #fb923c);
}

.dshm-stat-desc,
.dshm-stat-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
  flex-wrap: wrap;
}

.dshm-stat-link {
  cursor: pointer;
  transition: color 0.15s ease;
}
.dshm-stat-link:hover {
  color: #ffffff;
  text-decoration: underline;
}
.dshm-stat-link.is-highlight-amber {
  color: #fde68a;
  font-weight: 600;
}

/* ============================================================================
 * 7. FilterToolbar (FilterToolbar.tsx)
 * ============================================================================ */
.dshm-toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 14px;
}

.dshm-toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.dshm-toolbar-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-segmented-group,
.dshm-segmented-control {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.26);
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.dshm-segment-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--dshm-text-secondary);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.dshm-segment-btn:hover {
  color: var(--dshm-text-primary);
}
.dshm-segment-btn.is-active {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
  font-weight: 600;
}

.dshm-sort-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.dshm-sort-icon {
  position: absolute;
  left: 9px;
  display: inline-flex;
  color: var(--dshm-text-muted);
  pointer-events: none;
}

.dshm-sort-select,
.dshm-form-select {
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  background: var(--dshm-glass-input-bg);
  border: 1px solid var(--dshm-glass-border);
  border-radius: 8px;
  padding: 6px 10px;
  color: var(--dshm-text-primary);
  font-size: 12px;
  outline: none;
  cursor: pointer;
  transition: all 0.18s ease;
}

.dshm-sort-wrapper .dshm-sort-select {
  padding-left: 26px;
}

.dshm-sort-select:hover,
.dshm-form-select:hover {
  background: var(--dshm-glass-input-hover);
  border-color: var(--dshm-glass-border-hover);
}

.dshm-tabs-control {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dshm-tab-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: var(--dshm-text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.18s ease;
}

.dshm-tab-item:hover {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.24);
  color: var(--dshm-text-primary);
}

.dshm-tab-item.is-active {
  background: rgba(77, 107, 254, 0.28);
  border-color: rgba(116, 141, 255, 0.52);
  color: #ffffff;
  font-weight: 600;
}

.dshm-type-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  display: inline-block;
}
.dshm-type-dot.is-preference { background: #a855f7; }
.dshm-type-dot.is-semantic { background: #10b981; }
.dshm-type-dot.is-procedural { background: #38bdf8; }
.dshm-type-dot.is-experience { background: #f43f5e; }

.dshm-filter-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dshm-chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.08);
  color: var(--dshm-text-secondary);
  font-size: 11.5px;
  cursor: pointer;
  transition: all 0.16s ease;
}

.dshm-chip-btn:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
}

.dshm-chip-btn.is-active {
  background: rgba(77, 107, 254, 0.28);
  border-color: rgba(116, 141, 255, 0.52);
  color: #ffffff;
}

.is-active-cyan {
  background: rgba(6, 182, 212, 0.24) !important;
  border-color: rgba(6, 182, 212, 0.48) !important;
  color: #a5f3fc !important;
}

/* ============================================================================
 * 8. Memory Cards & Compact List (MemoryCard.tsx)
 * ============================================================================ */
.dshm-card-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 12px;
}

@media (max-width: 640px) {
  .dshm-card-list {
    grid-template-columns: 1fr;
  }
}

.dshm-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 14px;
}

.dshm-card.is-pinned {
  border-color: rgba(116, 141, 255, 0.45);
}

.dshm-card.is-selected {
  border-color: rgba(77, 107, 254, 0.72);
  box-shadow: 0 0 0 2px rgba(77, 107, 254, 0.28), var(--dshm-glass-shadow);
}

.dshm-card-header,
.dshm-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.dshm-card-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dshm-checkbox-label {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}

.dshm-checkbox {
  width: 14px;
  height: 14px;
  accent-color: var(--dshm-brand);
  cursor: pointer;
}

/* Semantic Tags & Badges */
.dshm-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.1);
  color: var(--dshm-text-primary);
  white-space: nowrap;
}

.dshm-tag-preference,
.dshm-tag.is-purple {
  background: rgba(168, 85, 247, 0.22);
  border-color: rgba(168, 85, 247, 0.42);
  color: #e9d5ff;
}

.dshm-tag-fact,
.dshm-tag.is-emerald {
  background: rgba(16, 185, 129, 0.22);
  border-color: rgba(16, 185, 129, 0.42);
  color: #a7f3d0;
}

.dshm-tag-procedure,
.dshm-tag.is-blue {
  background: rgba(56, 189, 248, 0.22);
  border-color: rgba(56, 189, 248, 0.42);
  color: #bae6fd;
}

.dshm-tag-episodic,
.dshm-tag-failure,
.dshm-tag.is-danger {
  background: rgba(244, 63, 94, 0.22);
  border-color: rgba(244, 63, 94, 0.42);
  color: #fecdd3;
}

.dshm-tag-slot {
  font-family: var(--dshm-font-mono);
  font-size: 10.5px;
  background: rgba(99, 102, 241, 0.2);
  border-color: rgba(99, 102, 241, 0.38);
  color: #c7d2fe;
}

.dshm-tag-scope {
  background: rgba(255, 255, 255, 0.09);
  border-color: rgba(255, 255, 255, 0.16);
  color: var(--dshm-text-secondary);
}

.dshm-badge-pinned {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(77, 107, 254, 0.26);
  border: 1px solid rgba(116, 141, 255, 0.48);
  color: #bfd0ff;
}

.dshm-badge-frozen {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(6, 182, 212, 0.24);
  border: 1px solid rgba(6, 182, 212, 0.45);
  color: #a5f3fc;
}

.dshm-badge-candidate {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(245, 158, 11, 0.24);
  border: 1px solid rgba(245, 158, 11, 0.45);
  color: #fde68a;
}

.dshm-badge-archived,
.dshm-badge-superseded {
  background: rgba(148, 163, 184, 0.18);
  border-color: rgba(148, 163, 184, 0.32);
  color: #cbd5e1;
}

.dshm-badge-importance {
  background: rgba(245, 158, 11, 0.2);
  border-color: rgba(245, 158, 11, 0.4);
  color: #fde68a;
}

.dshm-badge-version {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 6px;
  font-family: var(--dshm-font-mono);
  font-size: 10.5px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: var(--dshm-text-secondary);
}

.dshm-card-id {
  font-family: var(--dshm-font-mono);
  font-size: 10.5px;
  color: var(--dshm-text-muted);
}

.dshm-card-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.dshm-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.08);
  color: var(--dshm-text-secondary);
  cursor: pointer;
  transition: all 0.16s ease;
}

.dshm-action-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  border-color: rgba(255, 255, 255, 0.3);
  color: #ffffff;
}

.dshm-action-btn.is-active {
  background: rgba(77, 107, 254, 0.28);
  border-color: rgba(116, 141, 255, 0.52);
  color: #ffffff;
}

.dshm-action-btn-restore {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 7px;
  font-size: 11px;
  border: 1px solid rgba(77, 107, 254, 0.45);
  background: rgba(77, 107, 254, 0.22);
  color: #bfd0ff;
  cursor: pointer;
}

.dshm-card-content {
  font-size: 13px;
  line-height: 1.58;
  color: var(--dshm-text-primary);
  word-break: break-word;
  white-space: pre-wrap;
  cursor: pointer;
}

.dshm-card-summary {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
  padding: 6px 9px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.22);
  border-left: 2px solid var(--dshm-brand);
  cursor: pointer;
}

.dshm-summary-prefix {
  font-size: 10.5px;
  font-weight: 600;
  color: #93abff;
  flex-shrink: 0;
}

.dshm-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.dshm-card-footer-left,
.dshm-card-footer-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--dshm-text-muted);
}

.dshm-metric-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: var(--dshm-text-secondary);
}

.dshm-metric-pill.is-clickable-metric {
  cursor: pointer;
}
.dshm-metric-pill.is-clickable-metric:hover {
  background: rgba(255, 255, 255, 0.16);
}

.dshm-metric-pill strong {
  color: var(--dshm-text-primary);
}

.dshm-mini-bar {
  width: 28px;
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
  display: inline-block;
}
.dshm-mini-bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
}
.dshm-mini-bar-fill.is-blue { background: #6366f1; }
.dshm-mini-bar-fill.is-emerald { background: #10b981; }

.dshm-text-emerald { color: #6ee7b7 !important; }
.dshm-text-purple { color: #d8b4fe !important; }
.dshm-text-danger { color: #fda4af !important; }
.dshm-text-muted { color: var(--dshm-text-muted) !important; }

.dshm-source-badge {
  padding: 1px 6px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--dshm-text-muted);
}

/* Compact Table View */
.dshm-compact-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dshm-compact-thead {
  display: grid;
  grid-template-columns: 240px 1fr 250px;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--dshm-text-secondary);
}

.dshm-compact-row {
  display: grid;
  grid-template-columns: 240px 1fr 250px;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  border-radius: 10px;
  cursor: pointer;
}

@media (max-width: 900px) {
  .dshm-compact-thead { display: none; }
  .dshm-compact-row {
    grid-template-columns: 1fr;
    gap: 8px;
  }
}

.dshm-compact-left {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}

.dshm-compact-body {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--dshm-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dshm-compact-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.dshm-compact-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.dshm-compact-meta,
.dshm-compact-time {
  font-size: 11px;
  color: var(--dshm-text-secondary);
  white-space: nowrap;
}

/* ============================================================================
 * 9. Empty State, Loading State & Toast
 * ============================================================================ */
.dshm-loading-state,
.dshm-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 48px 24px;
  text-align: center;
  border-radius: 16px;
  color: var(--dshm-text-secondary);
}

.dshm-empty-icon {
  font-size: 32px;
  line-height: 1;
}

.dshm-empty-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--dshm-text-primary);
}

.dshm-empty-desc {
  margin: 0;
  max-width: 460px;
  font-size: 12.5px;
  color: var(--dshm-text-secondary);
}

.dshm-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  top: auto !important;
  left: auto !important;
  bottom: 24px !important;
  right: 24px !important;
  width: fit-content !important;
  max-width: min(520px, calc(100vw - 48px)) !important;
  height: auto !important;
  min-height: 0 !important;
  transform: none !important;
  z-index: 100000 !important;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 12px;
  font-size: 12.5px;
  font-weight: 500;
  color: #ffffff;
  animation: dshm-fade-up 0.22s ease;
}

@keyframes dshm-fade-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.dshm-spin {
  display: inline-flex;
  animation: dshm-spin-anim 1s linear infinite;
}
@keyframes dshm-spin-anim {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ============================================================================
 * 10. GlassModal & Form Elements (NewMemory, Backup, LLMConfig, Detail Modals)
 * ============================================================================ */
.glass-modal-backdrop.dshm-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  background: rgba(3, 6, 14, 0.72);
}

.glass-modal.dshm-modal {
  display: flex;
  flex-direction: column;
  max-height: 88vh;
  overflow: hidden;
  border-radius: 18px;
}

/* Give modals a slightly deeper translucent glass backing so text is crisp */
.dshm-root[data-glass-variant="light"] .glass-modal.dshm-modal {
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.22);
}
.dshm-root[data-glass-variant="dark"] .glass-modal.dshm-modal {
  background: rgba(6, 9, 18, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.glass-modal-header.dshm-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
}

.dshm-modal-header-left,
.dshm-modal-header-actions,
.dshm-detail-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-modal-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--dshm-text-primary);
}

.glass-modal-body.dshm-modal-body {
  padding: 18px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.glass-modal-footer.dshm-modal-footer,
.dshm-modal-footer-split {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.14);
}

.dshm-modal-footer-split {
  justify-content: space-between;
  flex-wrap: wrap;
}

.dshm-detail-footer-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-detail-stack,
.dshm-backup-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dshm-alert-error {
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(244, 63, 94, 0.2);
  border: 1px solid rgba(244, 63, 94, 0.42);
  color: #fecdd3;
  font-size: 12px;
}

.dshm-form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dshm-form-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.dshm-col-third {
  flex: 1 1 150px;
}

.dshm-col-half {
  flex: 1 1 220px;
}

.dshm-form-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--dshm-text-secondary);
}

.dshm-required {
  color: #fb7185;
}

.dshm-form-hint,
.dshm-form-hint-inline {
  font-size: 11px;
  color: var(--dshm-text-muted);
  font-weight: 400;
}

.dshm-form-textarea {
  width: 100%;
  min-height: 92px;
  padding: 10px 12px;
  border-radius: 10px;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  background: var(--dshm-glass-input-bg);
  border: 1px solid var(--dshm-glass-border);
  color: var(--dshm-text-primary);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.55;
  outline: none;
  resize: vertical;
}
.dshm-form-textarea:focus {
  border-color: rgba(116, 141, 255, 0.65);
  box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.25);
}
.dshm-form-textarea.is-mono {
  font-family: var(--dshm-font-mono);
  font-size: 11.5px;
}

/* Switch & Consent Card */
.dshm-consent-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.dshm-consent-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dshm-consent-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dshm-consent-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dshm-text-primary);
}

.dshm-consent-desc {
  margin: 0;
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
}

.dshm-switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
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
  inset: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.24);
  transition: 0.2s;
}
.dshm-slider::before {
  position: absolute;
  content: "";
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  border-radius: 50%;
  background: #ffffff;
  transition: 0.2s;
}
.dshm-switch input:checked + .dshm-slider {
  background: var(--dshm-brand);
  border-color: rgba(255, 255, 255, 0.35);
}
.dshm-switch input:checked + .dshm-slider::before {
  transform: translateX(18px);
}

/* LLMConfigModal Specific Styles */
.dshm-config-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dshm-config-icon-badge {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(77, 107, 254, 0.22);
  border: 1px solid rgba(116, 141, 255, 0.4);
  color: #93abff;
}

.dshm-config-header-desc {
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
}

.dshm-config-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.dshm-config-section-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--dshm-text-primary);
}

.dshm-presets-grid,
.dshm-protocol-tabs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
}

.dshm-preset-card,
.dshm-protocol-tab {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.08);
  color: var(--dshm-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.16s ease;
}

.dshm-protocol-tab {
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.dshm-preset-card:hover,
.dshm-protocol-tab:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #ffffff;
}

.dshm-preset-card-active,
.dshm-protocol-tab-active {
  background: rgba(77, 107, 254, 0.26);
  border-color: rgba(116, 141, 255, 0.55);
  color: #ffffff;
}

.dshm-preset-tag {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  background: rgba(77, 107, 254, 0.28);
  color: #bfd0ff;
}

.dshm-proto-code {
  font-family: var(--dshm-font-mono);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dshm-text-primary);
}

.dshm-proto-desc {
  font-size: 10.5px;
  color: var(--dshm-text-muted);
}

.dshm-badge-has-key {
  margin-left: auto;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  background: rgba(16, 185, 129, 0.2);
  color: #6ee7b7;
}

.dshm-input-with-action {
  position: relative;
  display: flex;
  align-items: center;
}

.dshm-input-action-btn {
  position: absolute;
  right: 8px;
  border: none;
  background: transparent;
  color: var(--dshm-text-secondary);
  cursor: pointer;
  display: inline-flex;
  padding: 4px;
}

.dshm-config-test-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.dshm-test-box-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.dshm-test-hint {
  font-size: 11.5px;
  color: var(--dshm-text-muted);
}

.dshm-test-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
}
.dshm-test-badge-ok {
  background: rgba(16, 185, 129, 0.2);
  border: 1px solid rgba(16, 185, 129, 0.4);
  color: #a7f3d0;
}
.dshm-test-badge-err {
  background: rgba(244, 63, 94, 0.2);
  border: 1px solid rgba(244, 63, 94, 0.4);
  color: #fecdd3;
}

/* BackupModal Specific Styles */
.dshm-modal-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

.dshm-modal-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dshm-text-secondary);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.dshm-modal-tab.is-active {
  color: #ffffff;
  border-bottom-color: var(--dshm-brand);
}

.dshm-export-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 600px) {
  .dshm-export-grid { grid-template-columns: 1fr; }
}

.dshm-export-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
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

.dshm-export-card-info h4 {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 700;
  color: var(--dshm-text-primary);
}
.dshm-export-card-info p {
  margin: 0;
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
}

.dshm-backup-footer-right,
.dshm-backup-file-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.dshm-backup-file-row {
  justify-content: flex-start;
}

.dshm-hidden-input {
  display: none;
}

/* MemoryDetailModal Specific Styles */
.dshm-detail-meta-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

@media (max-width: 680px) {
  .dshm-detail-meta-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.dshm-meta-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dshm-meta-key {
  font-size: 11px;
  color: var(--dshm-text-muted);
}

.dshm-meta-val {
  font-size: 12px;
  font-weight: 600;
  color: var(--dshm-text-primary);
}
.dshm-meta-val.is-mono {
  font-family: var(--dshm-font-mono);
  font-size: 11.5px;
}

.dshm-detail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dshm-detail-section h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--dshm-text-primary);
}

.dshm-detail-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.dshm-detail-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dshm-detail-content-box {
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.14);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.dshm-edit-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.dshm-edit-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dshm-relation-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dshm-relation-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: var(--dshm-text-primary);
  font-size: 11.5px;
  cursor: pointer;
}

.dshm-relation-type {
  color: #93abff;
  font-weight: 600;
}

.dshm-version-list,
.dshm-source-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dshm-version-card,
.dshm-source-card {
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.12);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dshm-version-header,
.dshm-source-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
}

.dshm-version-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--dshm-text-secondary);
}

.dshm-version-reason {
  font-size: 11.5px;
  color: #a5b4fc;
}

.dshm-version-snapshot,
.dshm-source-excerpt {
  margin: 0;
  font-family: var(--dshm-font-mono);
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ============================================================================
 * 11. CoreMemoryView (CoreMemoryView.tsx)
 * ============================================================================ */
.dshm-core-container {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dshm-core-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 14px;
  padding: 16px 18px;
  border-radius: 14px;
}

.dshm-core-banner-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 720px;
}

.dshm-core-banner-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.dshm-section-heading {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--dshm-text-primary);
}

.dshm-core-banner-desc {
  margin: 0;
  font-size: 12px;
  color: var(--dshm-text-secondary);
}

.dshm-core-banner-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.dshm-core-gauge {
  min-width: 210px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.dshm-core-gauge-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
}

.dshm-core-custom-form {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-radius: 12px;
}

.dshm-core-custom-input {
  max-width: 260px;
}

.dshm-core-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: 14px;
}

.dshm-core-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  border-radius: 14px;
}

.dshm-core-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.dshm-core-card-title-group {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.dshm-core-icon {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.18);
  flex-shrink: 0;
}
.dshm-core-icon.is-purple { background: rgba(168, 85, 247, 0.22); color: #e9d5ff; }
.dshm-core-icon.is-blue { background: rgba(56, 189, 248, 0.22); color: #bae6fd; }
.dshm-core-icon.is-emerald { background: rgba(16, 185, 129, 0.22); color: #a7f3d0; }
.dshm-core-icon.is-indigo { background: rgba(99, 102, 241, 0.22); color: #c7d2fe; }

.dshm-core-card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-core-card-title-row h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--dshm-text-primary);
}

.dshm-core-card-subtitle {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
}

.dshm-core-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dshm-core-card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dshm-core-append-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dshm-core-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.dshm-core-footer-left,
.dshm-core-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dshm-core-updated {
  font-size: 11px;
  color: var(--dshm-text-muted);
}

/* ============================================================================
 * 12. RecallSandboxView & EvolutionView Shared Panels
 * ============================================================================ */
.dshm-sandbox-container,
.dshm-evo-container {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dshm-evo-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px;
  border-radius: 14px;
}

.dshm-evo-panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.dshm-evo-panel-title-group,
.dshm-evo-title-group {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.dshm-evo-panel-title,
.dshm-evo-title-row h3,
.dshm-evo-title-group h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--dshm-text-primary);
}

.dshm-evo-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-evo-panel-subtitle,
.dshm-evo-subtitle {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
}

.dshm-evo-panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* Context Meter Bar in RecallSandboxView */
.dshm-ctx-meter {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dshm-ctx-bar-track {
  width: 100%;
  height: 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  display: flex;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.dshm-ctx-bar-seg.is-stable {
  background: linear-gradient(90deg, #6366f1, #a855f7);
}
.dshm-ctx-bar-seg.is-dynamic {
  background: linear-gradient(90deg, #10b981, #38bdf8);
}

.dshm-ctx-legend {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
}

.dshm-ctx-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dshm-ctx-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  display: inline-block;
}
.dshm-ctx-dot.is-stable { background: #818cf8; }
.dshm-ctx-dot.is-dynamic { background: #34d399; }
.dshm-ctx-dot.is-free { background: rgba(255, 255, 255, 0.25); }

.dshm-sandbox-grid,
.dshm-evo-two-col {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

@media (max-width: 960px) {
  .dshm-sandbox-grid,
  .dshm-evo-two-col {
    grid-template-columns: 1fr;
  }
}

.dshm-sandbox-search-form {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dshm-sandbox-presets {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dshm-sandbox-preset-label {
  font-size: 11.5px;
  color: var(--dshm-text-muted);
}

.dshm-plan-box {
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.24);
  border: 1px solid rgba(255, 255, 255, 0.12);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dshm-plan-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11.5px;
}

.dshm-plan-label {
  color: var(--dshm-text-muted);
}

.dshm-plan-tokens {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.dshm-token-chip {
  padding: 1px 6px;
  border-radius: 5px;
  font-family: var(--dshm-font-mono);
  font-size: 11px;
  background: rgba(255, 255, 255, 0.1);
  color: #e2e8f0;
}

.dshm-sandbox-hit-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dshm-sandbox-hit-card {
  padding: 10px 12px;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
}

.dshm-sandbox-hit-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-hit-rank {
  font-family: var(--dshm-font-mono);
  font-size: 11px;
  font-weight: 700;
  color: #93abff;
}

.dshm-hit-channels {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.dshm-channel-hit-pill {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.12);
  color: var(--dshm-text-primary);
}
.dshm-channel-hit-pill.is-blue { background: rgba(56, 189, 248, 0.22); color: #bae6fd; }
.dshm-channel-hit-pill.is-purple { background: rgba(168, 85, 247, 0.22); color: #e9d5ff; }
.dshm-channel-hit-pill.is-emerald { background: rgba(16, 185, 129, 0.22); color: #a7f3d0; }
.dshm-channel-hit-pill.is-amber { background: rgba(245, 158, 11, 0.22); color: #fde68a; }
.dshm-channel-hit-pill.is-cyan { background: rgba(6, 182, 212, 0.22); color: #a5f3fc; }

.dshm-sandbox-hit-content {
  font-size: 12.5px;
  color: var(--dshm-text-primary);
  white-space: pre-wrap;
}

.dshm-prompt-preview-code {
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.14);
  font-family: var(--dshm-font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: #e2e8f0;
  max-height: 360px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Data Table in RecallSandboxView */
.dshm-table-container {
  width: 100%;
  overflow-x: auto;
}

.dshm-data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.dshm-data-table th {
  text-align: left;
  padding: 8px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--dshm-text-muted);
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
}

.dshm-data-table td {
  padding: 9px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--dshm-text-primary);
}

.dshm-table-row {
  cursor: pointer;
  transition: background 0.15s ease;
}
.dshm-table-row:hover {
  background: rgba(255, 255, 255, 0.08);
}

.dshm-td-mono {
  font-family: var(--dshm-font-mono);
  font-size: 11px;
}

.dshm-td-sub {
  font-size: 10.5px;
  color: var(--dshm-text-muted);
}

.dshm-td-clamp {
  max-width: 360px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dshm-audit-outcome {
  display: inline-flex;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.dshm-audit-outcome.is-positive { background: rgba(16, 185, 129, 0.22); color: #6ee7b7; }
.dshm-audit-outcome.is-ok { background: rgba(56, 189, 248, 0.22); color: #bae6fd; }
.dshm-audit-outcome.is-negative { background: rgba(244, 63, 94, 0.22); color: #fda4af; }
.dshm-audit-outcome.is-warn { background: rgba(245, 158, 11, 0.22); color: #fde68a; }
.dshm-audit-outcome.is-neutral { background: rgba(255, 255, 255, 0.1); color: var(--dshm-text-secondary); }

/* EvolutionView Specific Styles */
.dshm-evo-empty {
  padding: 24px 16px;
  text-align: center;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.18);
  border: 1px dashed rgba(255, 255, 255, 0.16);
  color: var(--dshm-text-secondary);
  font-size: 12.5px;
}

.dshm-proposal-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dshm-proposal-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 12px;
}

.dshm-proposal-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-proposal-badges,
.dshm-proposal-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dshm-proposal-reason {
  font-size: 12px;
  color: var(--dshm-text-secondary);
}

.dshm-proposal-diff {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 640px) {
  .dshm-proposal-diff { grid-template-columns: 1fr; }
}

.dshm-diff-box {
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
}
.dshm-diff-box.is-old {
  background: rgba(244, 63, 94, 0.12);
  border: 1px solid rgba(244, 63, 94, 0.3);
}
.dshm-diff-box.is-new {
  background: rgba(16, 185, 129, 0.12);
  border: 1px solid rgba(16, 185, 129, 0.3);
}
.dshm-diff-label {
  display: block;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--dshm-text-muted);
  margin-bottom: 4px;
}

.dshm-strat-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dshm-strat-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
@media (max-width: 600px) {
  .dshm-strat-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

.dshm-strat-kpi {
  padding: 8px 10px;
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.12);
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--dshm-text-secondary);
}
.dshm-strat-kpi strong {
  font-size: 13.5px;
  color: var(--dshm-text-primary);
}

.dshm-strat-subhead {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--dshm-text-secondary);
  margin-bottom: 6px;
}

.dshm-strat-weights {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dshm-weight-row {
  display: grid;
  grid-template-columns: 185px 1fr 42px;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}

.dshm-weight-label {
  color: var(--dshm-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dshm-weight-bar-track {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}

.dshm-weight-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #4d6bfe, #a855f7);
}

.dshm-weight-val {
  text-align: right;
  font-family: var(--dshm-font-mono);
  font-size: 11px;
  color: var(--dshm-text-primary);
}

.dshm-channel-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dshm-strat-ver-list,
.dshm-jobs-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dshm-strat-ver-row,
.dshm-job-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 12px;
}

.dshm-job-left,
.dshm-job-right,
.dshm-eval-controls,
.dshm-maint-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dshm-eval-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.dshm-eval-metric-card {
  padding: 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.12);
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  color: var(--dshm-text-secondary);
}

.dshm-eval-metric-card strong {
  font-size: 18px;
  color: var(--dshm-text-primary);
}
.dshm-eval-metric-card strong.is-emerald { color: #6ee7b7; }
.dshm-eval-metric-card strong.is-blue { color: #93abff; }
.dshm-eval-metric-card strong.is-purple { color: #d8b4fe; }
.dshm-eval-metric-card strong.is-danger { color: #fda4af; }

/* ============================================================================
 * 13. GraphView (GraphView.tsx) & Floating BatchBar (BatchBar.tsx)
 * ============================================================================ */
.dshm-graph-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dshm-graph-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 14px;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  background: var(--dshm-glass-bg);
  border: 1px solid var(--dshm-glass-border);
  box-shadow: var(--dshm-glass-shadow);
}

.dshm-graph-pills,
.dshm-graph-right-controls,
.dshm-graph-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dshm-graph-pill,
.dshm-graph-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.08);
  color: var(--dshm-text-secondary);
  font-size: 11.5px;
  cursor: pointer;
  transition: all 0.16s ease;
}

.dshm-graph-pill:hover,
.dshm-graph-btn:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
}

.dshm-graph-pill.is-active {
  background: rgba(77, 107, 254, 0.28);
  border-color: rgba(116, 141, 255, 0.52);
  color: #ffffff;
  font-weight: 600;
}

.dshm-graph-search {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 8px;
  background: var(--dshm-glass-input-bg);
  border: 1px solid var(--dshm-glass-border);
  color: var(--dshm-text-secondary);
}

.dshm-graph-search input {
  background: transparent;
  border: none;
  outline: none;
  color: var(--dshm-text-primary);
  font-size: 12px;
  width: 140px;
}

.dshm-graph-viewport {
  position: relative;
  height: 560px;
  border-radius: 16px;
  overflow: hidden;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  background: var(--dshm-glass-bg);
  border: 1px solid var(--dshm-glass-border);
  box-shadow: var(--dshm-glass-shadow);
}

.dshm-graph-status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--dshm-text-secondary);
  font-size: 13px;
}

.dshm-graph-tooltip {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 280px;
  padding: 12px 14px;
  border-radius: 12px;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  background: rgba(10, 14, 24, 0.84);
  border: 1px solid rgba(255, 255, 255, 0.22);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
}

.dshm-tooltip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.dshm-tooltip-body {
  color: var(--dshm-text-primary);
  line-height: 1.5;
  word-break: break-word;
}

.dshm-tooltip-metrics {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dshm-text-secondary);
}

.dshm-neighbor-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.08);
  color: var(--dshm-text-primary);
  font-size: 11px;
  cursor: pointer;
}

/* BatchBar */
.dshm-batch-bar {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9000;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 16px;
  border-radius: 14px;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  background: rgba(10, 14, 24, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.22);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
}

.dshm-batch-info,
.dshm-batch-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dshm-batch-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dshm-brand);
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
}

.dshm-batch-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.1);
  color: #f8fafc;
  font-size: 11.5px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.dshm-batch-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}
`;
