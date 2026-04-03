import { AppError } from "./errors";

type JsonRecord = Record<string, unknown>;

export function asObject(value: unknown, message = "Expected JSON object."): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "invalid_request", message);
  }

  return value as JsonRecord;
}

export function requireString(
  object: JsonRecord,
  key: string,
  message?: string
): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(
      400,
      "invalid_request",
      message || `Field "${key}" must be a non-empty string.`
    );
  }

  return value;
}

export function optionalString(object: JsonRecord, key: string): string | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(400, "invalid_request", `Field "${key}" must be a string.`);
  }
  return value;
}

export function asArray(value: unknown, message = "Expected JSON array."): unknown[] {
  if (!Array.isArray(value)) {
    throw new AppError(400, "invalid_request", message);
  }

  return value;
}

export function optionalInteger(object: JsonRecord, key: string): number | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    throw new AppError(400, "invalid_request", `Field "${key}" must be an integer.`);
  }
  return value as number;
}

export function requireEnumValue<T extends string>(
  value: string,
  allowedValues: readonly T[],
  fieldName: string
): T {
  if (!allowedValues.includes(value as T)) {
    throw new AppError(
      400,
      "invalid_request",
      `Field "${fieldName}" must be one of: ${allowedValues.join(", ")}.`
    );
  }

  return value as T;
}

export function ensureNonNegativeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new AppError(
      400,
      "invalid_request",
      `Field "${fieldName}" must be a non-negative integer.`
    );
  }

  return value;
}

export function ensurePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError(
      400,
      "invalid_request",
      `Field "${fieldName}" must be a positive integer.`
    );
  }

  return value;
}

export function ensureDateTimeString(value: string, fieldName: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new AppError(
      400,
      "invalid_request",
      `Field "${fieldName}" must be a valid ISO-8601 datetime string.`
    );
  }

  return value;
}
