import type { ErrorInfo } from "react";

interface ErrorFallbackProps {
  error: Error;
  errorInfo: ErrorInfo;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function DefaultErrorFallback(_props: ErrorFallbackProps) {
  return (
    <div className="flex h-screen items-center justify-center bg-white">
      <div className="flex flex-col items-center">
        <div className="mt-12">
          <div className="w-80 text-center text-base font-semibold text-gray-900">
            Oops! Something went sideways
          </div>

          <div className="mt-2 w-80 text-center text-sm text-gray-500">
            Give it another try or reach out—we&apos;re here to help.
          </div>
        </div>
      </div>
    </div>
  );
}
