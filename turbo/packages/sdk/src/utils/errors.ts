/**
 * SDK error classes
 */

export class VM0Error extends Error {
  constructor(
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'VM0Error';
  }
}

export class APIError extends VM0Error {
  constructor(
    message: string,
    public statusCode: number,
    code?: string
  ) {
    super(message, code);
    this.name = 'APIError';
  }
}

export class TimeoutError extends VM0Error {
  constructor(message = 'Operation timed out') {
    super(message, 'TIMEOUT');
    this.name = 'TimeoutError';
  }
}

export class RuntimeError extends VM0Error {
  constructor(message: string) {
    super(message, 'RUNTIME_ERROR');
    this.name = 'RuntimeError';
  }
}
