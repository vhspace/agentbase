import type { ErrorCode } from "./types.js";

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = STATUS_CODES[code] ?? 500;
  }

  toGraphQL() {
    return {
      errorType: this.code,
      message: this.message,
      extensions: { code: this.code },
    };
  }
}

const STATUS_CODES: Record<ErrorCode, number> = {
  AUTH_FAILED: 401,
  REPLAY_DETECTED: 401,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
};
