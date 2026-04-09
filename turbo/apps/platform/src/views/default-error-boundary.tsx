import type { ErrorInfo } from "react";

interface ErrorFallbackProps {
  error: Error;
  errorInfo: ErrorInfo;
}

export function DefaultErrorFallback({ error }: ErrorFallbackProps) {
  void error;

  return (
    <div className="flex h-screen items-center justify-center bg-white">
      <div className="flex flex-col items-center">
        <div className="mt-12">
          <div className="w-80 text-center text-base font-semibold text-gray-900">
            Oops! Something went sideways
          </div>

          <div className="mt-2 w-80 text-center text-sm text-gray-500">
            Give it another try or reach out{" "}
            <a
              href="mailto:support@vm0.ai"
              className="text-blue-500 hover:underline"
            >
              support
            </a>
            <br />
            We&apos;re here to help
          </div>
        </div>
      </div>
    </div>
  );
}
