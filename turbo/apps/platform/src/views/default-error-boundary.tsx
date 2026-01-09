import type { ErrorInfo } from "react";

interface ErrorFallbackProps {
  error: Error;
  errorInfo: ErrorInfo;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function DefaultErrorFallback(_: ErrorFallbackProps) {
  return (
    <div className="flex h-screen items-center justify-center bg-white">
      <div className="flex flex-col items-center">
        <div className="mt-12">
          <div className="w-80 text-center text-base font-semibold text-gray-900">
            Something went wrong.
          </div>

          <div className="mt-2 w-80 text-center text-sm text-gray-500">
            Please try again or get in touch with our team for further help.
          </div>
        </div>
      </div>
    </div>
  );
}
