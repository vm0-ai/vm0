import { Component, type ErrorInfo, type ReactNode } from "react";
import { Sentry } from "../lib/sentry.ts";
import { logger } from "../signals/log.ts";
import { DefaultErrorFallback } from "./default-error-boundary.tsx";

interface ErrorFallbackProps {
  error: Error;
  errorInfo: ErrorInfo;
  sentryEventId?: string;
}

interface Props {
  children?: ReactNode;
  fallback?: (props: ErrorFallbackProps) => ReactNode;
  captureSentryEvent?: (error: Error) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  sentryEventId: string | undefined;
}

const L = logger("React");

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    sentryEventId: undefined,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    L.error("Uncaught error:", error, errorInfo);
    const eventId = Sentry.captureException(error, {
      extra: { componentStack: errorInfo.componentStack },
    });
    this.setState({ errorInfo, sentryEventId: eventId });
  }

  public render() {
    if (this.state.hasError && this.state.error && this.state.errorInfo) {
      const fallbackProps: ErrorFallbackProps = {
        error: this.state.error,
        errorInfo: this.state.errorInfo,
        sentryEventId: this.state.sentryEventId,
      };

      if (this.props.fallback) {
        return this.props.fallback(fallbackProps);
      }

      return <DefaultErrorFallback {...fallbackProps} />;
    }

    return this.props.children;
  }
}
