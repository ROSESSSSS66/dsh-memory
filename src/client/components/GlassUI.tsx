import * as React from 'react';
import { CloseIcon } from './Icons.js';

export type GlassVariant = 'light' | 'dark';

export interface GlassThemeContextValue {
  variant: GlassVariant;
  setVariant: (v: GlassVariant) => void;
}

export const GlassThemeContext = React.createContext<GlassThemeContextValue>({
  variant: 'light',
  setVariant: () => {},
});

export const useGlassVariant = (explicitVariant?: GlassVariant): GlassVariant => {
  const ctx = React.useContext(GlassThemeContext);
  return explicitVariant ?? ctx.variant;
};

export function getGlassUtilityClasses(
  variant: GlassVariant,
  interactive = true
): string {
  if (variant === 'dark') {
    return interactive
      ? 'glass-base glass-dark glass-dark-hover transition-all duration-200'
      : 'glass-base glass-dark transition-all duration-200';
  }
  return interactive
    ? 'glass-base glass-light glass-light-hover transition-all duration-200'
    : 'glass-base glass-light transition-all duration-200';
}

/* ==========================================================================
   1. GlassCard
   ========================================================================== */
export interface GlassCardProps extends React.HTMLAttributes<HTMLElement> {
  variant?: GlassVariant;
  interactive?: boolean;
  active?: boolean;
  pinned?: boolean;
  candidate?: boolean;
  as?: React.ElementType;
}

export const GlassCard = React.forwardRef<HTMLElement, GlassCardProps>(
  (
    {
      variant,
      interactive = false,
      active = false,
      pinned = false,
      candidate = false,
      as: Component = 'div',
      className = '',
      children,
      ...rest
    },
    ref
  ) => {
    const resolvedVariant = useGlassVariant(variant);
    const glassCls = getGlassUtilityClasses(resolvedVariant, interactive);
    const stateCls = [
      active ? 'is-selected' : '',
      pinned ? 'is-pinned dshm-glass-card--pinned' : '',
      candidate ? 'is-candidate' : '',
      interactive ? 'is-interactive dshm-glass-card--interactive' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <Component
        ref={ref}
        className={`dshm-glass-card glass-card ${glassCls} ${stateCls} ${className}`.trim()}
        {...rest}
      >
        {children}
      </Component>
    );
  }
);
GlassCard.displayName = 'GlassCard';

/* ==========================================================================
   2. GlassButton
   ========================================================================== */
export interface GlassButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: GlassVariant | 'default' | 'primary' | 'danger' | 'success';
  intent?: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  icon?: React.ReactNode;
}

export const GlassButton = React.forwardRef<HTMLButtonElement, GlassButtonProps>(
  (
    {
      variant,
      intent,
      size = 'md',
      icon,
      className = '',
      type = 'button',
      children,
      ...rest
    },
    ref
  ) => {
    const themeVariant: GlassVariant | undefined =
      variant === 'light' || variant === 'dark' ? variant : undefined;
    const resolvedVariant = useGlassVariant(themeVariant);
    const glassCls = getGlassUtilityClasses(resolvedVariant, true);

    const effectiveIntent =
      intent ||
      (variant === 'primary'
        ? 'primary'
        : variant === 'danger'
          ? 'danger'
          : variant === 'success'
            ? 'success'
            : 'default');

    const intentCls =
      effectiveIntent === 'primary'
        ? 'glass-btn-primary dshm-btn-primary dshm-btn--primary'
        : effectiveIntent === 'success'
        ? 'glass-btn-success dshm-action-btn-approve dshm-btn--success'
        : effectiveIntent === 'warning'
        ? 'glass-btn-warning is-active-amber'
        : effectiveIntent === 'danger'
        ? 'glass-btn-danger is-danger dshm-btn--danger'
        : effectiveIntent === 'ghost'
        ? 'glass-btn-ghost dshm-btn-ghost'
        : 'glass-btn-default dshm-btn-secondary';

    const sizeCls =
      size === 'sm'
        ? 'h-7 px-2.5 text-xs rounded-lg dshm-btn--sm'
        : size === 'lg'
        ? 'h-10 px-4 text-sm rounded-xl'
        : size === 'icon'
        ? 'h-8 w-8 p-0 rounded-lg dshm-btn-icon-only'
        : 'h-8 px-3 text-xs rounded-lg';

    return (
      <button
        ref={ref}
        type={type}
        className={`glass-btn dshm-btn inline-flex items-center justify-center gap-1.5 font-medium select-none ${glassCls} ${intentCls} ${sizeCls} ${className}`.trim()}
        {...rest}
      >
        {icon}
        {children}
      </button>
    );
  }
);
GlassButton.displayName = 'GlassButton';

/* ==========================================================================
   3. GlassInput & GlassSelect & GlassBadge
   ========================================================================== */
export interface GlassInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  variant?: GlassVariant;
  leftIcon?: React.ReactNode;
  rightSlot?: React.ReactNode;
  wrapperClassName?: string;
}

export const GlassInput = React.forwardRef<HTMLInputElement, GlassInputProps>(
  (
    {
      variant,
      leftIcon,
      rightSlot,
      wrapperClassName = '',
      className = '',
      ...rest
    },
    ref
  ) => {
    const resolvedVariant = useGlassVariant(variant);
    const glassCls = getGlassUtilityClasses(resolvedVariant, true);
    const focusCls =
      resolvedVariant === 'dark' ? 'glass-dark-focus' : 'glass-light-focus';

    if (leftIcon || rightSlot) {
      return (
        <div
          className={`glass-input-wrapper dshm-search-box relative flex items-center ${wrapperClassName}`.trim()}
        >
          {leftIcon && <span className="dshm-search-icon">{leftIcon}</span>}
          <input
            ref={ref}
            className={`glass-input dshm-input dshm-input--search dshm-search-input ${glassCls} ${focusCls} ${
              leftIcon ? 'has-left-icon' : ''
            } ${rightSlot ? 'has-right-slot' : ''} ${className}`.trim()}
            {...rest}
          />
          {rightSlot}
        </div>
      );
    }

    return (
      <input
        ref={ref}
        className={`glass-input dshm-input dshm-form-input ${glassCls} ${focusCls} ${className}`.trim()}
        {...rest}
      />
    );
  }
);
GlassInput.displayName = 'GlassInput';

export interface GlassSelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  variant?: GlassVariant;
}

export const GlassSelect = React.forwardRef<HTMLSelectElement, GlassSelectProps>(
  ({ className = '', children, ...rest }, ref) => {
    return (
      <select
        ref={ref}
        className={`dshm-select ${className}`.trim()}
        {...rest}
      >
        {children}
      </select>
    );
  }
);
GlassSelect.displayName = 'GlassSelect';

export type GlassBadgeVariant =
  | 'accent'
  | 'purple'
  | 'cyan'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'neutral';

export interface GlassBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: GlassBadgeVariant;
}

export const GlassBadge: React.FC<GlassBadgeProps> = ({
  variant = 'neutral',
  className = '',
  children,
  ...rest
}) => {
  return (
    <span
      className={`dshm-badge dshm-badge--${variant} ${className}`.trim()}
      {...rest}
    >
      {children}
    </span>
  );
};

/* ==========================================================================
   4. GlassModal
   ========================================================================== */
export interface GlassModalProps {
  open?: boolean;
  isOpen?: boolean;
  onClose: () => void;
  variant?: GlassVariant;
  title?: React.ReactNode;
  headerLeft?: React.ReactNode;
  headerActions?: React.ReactNode;
  subHeader?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'md' | 'lg' | 'xl';
  className?: string;
  bodyClassName?: string;
  footerClassName?: string;
  children: React.ReactNode;
}

export const GlassModal: React.FC<GlassModalProps> = ({
  open,
  isOpen,
  onClose,
  variant,
  title,
  headerLeft,
  headerActions,
  subHeader,
  footer,
  size = 'md',
  className = '',
  bodyClassName = '',
  footerClassName = '',
  children,
}) => {
  const resolvedVariant = useGlassVariant(variant);
  const glassCls = getGlassUtilityClasses(resolvedVariant, false);

  const visible = open !== undefined ? open : (isOpen ?? true);
  if (!visible) return null;

  const sizeCls =
    size === 'xl'
      ? 'dshm-modal--lg dshm-modal-detail max-w-2xl'
      : size === 'lg'
      ? 'dshm-modal--lg dshm-modal-config max-w-xl'
      : 'max-w-lg';

  return (
    <div className="glass-modal-backdrop dshm-modal-backdrop" onClick={onClose}>
      <div
        className={`glass-modal dshm-modal rounded-2xl shadow-glass-lg ${glassCls} ${sizeCls} ${className}`.trim()}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="glass-modal-header dshm-modal-header">
          <div className="dshm-modal-header-left">
            {headerLeft || (
              <h2 className="dshm-modal-title">{title}</h2>
            )}
          </div>
          <div className="dshm-modal-header-actions">
            {headerActions}
            <button
              type="button"
              className={`dshm-modal-close dshm-action-btn ${getGlassUtilityClasses(resolvedVariant, true)}`}
              onClick={onClose}
              title="关闭"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        </div>

        {subHeader}

        <div className={`glass-modal-body dshm-modal-body ${bodyClassName}`.trim()}>
          {children}
        </div>

        {footer && (
          <div className={`glass-modal-footer dshm-modal-footer ${footerClassName}`.trim()}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

/* ==========================================================================
   5. GlassNavbar
   ========================================================================== */
export interface GlassNavItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  badgeWarm?: boolean;
}

export interface GlassNavbarProps {
  variant?: GlassVariant;
  brandIcon?: React.ReactNode;
  title?: React.ReactNode;
  versionBadge?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  items?: GlassNavItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
  className?: string;
  children?: React.ReactNode;
}

export const GlassNavbar: React.FC<GlassNavbarProps> = ({
  variant,
  brandIcon,
  title,
  versionBadge,
  subtitle,
  actions,
  items = [],
  activeKey,
  onSelect,
  className = '',
  children,
}) => {
  const resolvedVariant = useGlassVariant(variant);
  const glassBarCls = getGlassUtilityClasses(resolvedVariant, false);
  const glassItemHoverCls =
    resolvedVariant === 'dark' ? 'glass-dark-hover' : 'glass-light-hover';

  return (
    <header className={`glass-navbar dshm-header ${className}`.trim()}>
      {(brandIcon || title || actions) && (
        <div className="dshm-header-top">
          <div className="dshm-header-left">
            {brandIcon && (
              <div className={`dshm-brand-icon ${getGlassUtilityClasses(resolvedVariant, true)}`}>
                {brandIcon}
              </div>
            )}
            <div className="dshm-header-titles">
              <div className="dshm-title-row">
                {typeof title === 'string' ? (
                  <h1 className="dshm-title">{title}</h1>
                ) : (
                  title
                )}
                {versionBadge}
              </div>
              {subtitle && <div className="dshm-subtitle">{subtitle}</div>}
            </div>
          </div>

          {actions && <div className="dshm-header-actions">{actions}</div>}
        </div>
      )}

      {items.length > 0 && (
        <nav
          className={`glass-navbar-tabs dshm-nav-bar rounded-xl p-1.5 ${glassBarCls}`}
          aria-label="主导航栏"
        >
          {items.map((item) => {
            const isActive = item.key === activeKey;
            return (
              <button
                key={item.key}
                type="button"
                className={`glass-nav-item dshm-nav-item rounded-lg px-3.5 py-1.5 text-xs font-medium transition-all duration-200 ${glassItemHoverCls} ${
                  isActive ? 'is-active' : ''
                }`}
                onClick={() => onSelect?.(item.key)}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.badge !== undefined && item.badge !== null && (
                  <span
                    className={`dshm-nav-badge ${item.badgeWarm ? 'is-warm' : ''}`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      )}

      {children}
    </header>
  );
};
