import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-[#0f1117] p-6 text-white">
          <h1 className="mb-2 text-xl font-bold text-red-400">Ошибка загрузки</h1>
          <pre className="max-w-lg overflow-auto rounded bg-black/50 p-4 text-sm text-gray-300">
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
