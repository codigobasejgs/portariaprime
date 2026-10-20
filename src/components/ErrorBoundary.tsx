import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<Props, State> {
  declare props: Readonly<Props>;
  declare state: Readonly<State>;
  declare setState: <K extends keyof State>(
    state: ((prevState: Readonly<State>, props: Readonly<Props>) => (Pick<State, K> | State | null)) | (Pick<State, K> | State | null),
    callback?: () => void
  ) => void;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary caught error]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[50vh] flex items-center justify-center p-6">
          <div role="alert" className="bg-surface border border-line rounded-2xl p-8 max-w-md w-full text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-danger-bg text-danger flex items-center justify-center mx-auto">
              <AlertTriangle className="w-8 h-8" aria-hidden />
            </div>
            <h1 className="text-lg font-semibold text-text">
              {this.props.fallbackTitle || 'Ocorreu um erro ao carregar esta tela'}
            </h1>
            <p className="text-sm text-muted">Recarregue a página. Se continuar, avise o administrador do condomínio.</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="min-h-11 px-6 rounded-xl bg-primary text-primary-fg font-semibold text-sm inline-flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Recarregar Página</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
