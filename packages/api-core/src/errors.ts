export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

export class HttpError extends AppError {
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(statusCode, code, message, details);
    this.name = "HttpError";
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export interface PrismaKnownError {
  code: string;
  meta?: Record<string, unknown>;
}

export function mapPrismaError(err: unknown): AppError | null {
  if (!err || typeof err !== "object" || !("code" in err)) return null;
  const code = String((err as PrismaKnownError).code);
  if (code === "P2002") {
    return new HttpError(409, "CONFLICT", "A unique constraint was violated", (err as PrismaKnownError).meta);
  }
  if (code === "P2025") {
    return new HttpError(404, "NOT_FOUND", "Record not found");
  }
  if (code === "P2003") {
    return new HttpError(409, "FOREIGN_KEY", "Related record is missing", (err as PrismaKnownError).meta);
  }
  return null;
}
