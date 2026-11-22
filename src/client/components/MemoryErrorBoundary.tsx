import React from 'react';
import { getMessages } from '../i18n.js';
import { MEMORY_STYLES } from '../styles.js';
import type { UiLocale } from '../types.js';

export interface MemoryErrorBoundaryProps {
  locale: UiLocale;
  children?: React.ReactNode;
}

interface MemoryErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class MemoryErrorBoundary extends React.Component<
  MemoryErrorBoundaryProps,
  MemoryErrorBoundaryState
> {
  constructor(props: MemoryErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: '',
    };
  }

  static getDerivedStateFromError(error: unknown): MemoryErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : String(error ?? ''),
    };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('[dsh-memory] UI render error:', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, errorMessage: '' });
  };

  override render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const t = getMessages(this.props.locale);

    return (
      <div className="dshm-root">
        <style href="dsh-memory-studio" precedence="default">
          {MEMORY_STYLES}
        </style>
        <div className="dshm-error-boundary" role="alert">
          <div className="dshm-error-card">
            <h2 className="dshm-error-title">{t.errorBoundary.title}</h2>
            <p className="dshm-error-desc">{t.errorBoundary.description}</p>
            {this.state.errorMessage ? (
              <p className="dshm-error-detail">{this.state.errorMessage}</p>
            ) : null}
            <button
              type="button"
              className="dshm-error-retry"
              onClick={this.handleReset}
            >
              {t.errorBoundary.retry}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
