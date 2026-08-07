import { testOverride } from "./singleton";

type ErrorReporter = (error: unknown) => void;

const { get: getErrorReporter, set: setErrorReporter } =
  testOverride<ErrorReporter>(() => {
    return () => {};
  });

export function configureErrorReporter(reporter: ErrorReporter): void {
  setErrorReporter(reporter);
}

export function captureException(error: unknown): void {
  getErrorReporter()(error);
}
