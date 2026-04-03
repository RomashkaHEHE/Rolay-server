export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toPayload(): ErrorPayload {
    const error: ErrorPayload["error"] = {
      code: this.code,
      message: this.message
    };

    if (this.details !== undefined) {
      error.details = this.details;
    }

    return {
      error
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
