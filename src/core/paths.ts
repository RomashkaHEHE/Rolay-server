import { AppError } from "./errors";

function ensureRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").trim();
  if (!normalized) {
    throw new AppError(400, "invalid_operation", "Path must not be empty.");
  }
  if (normalized.startsWith("/")) {
    throw new AppError(400, "invalid_operation", "Path must be relative.");
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new AppError(400, "invalid_operation", "Path must not be empty.");
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new AppError(
        400,
        "invalid_operation",
        "Path must not contain dot segments."
      );
    }
  }

  return segments.join("/");
}

export function normalizePath(path: string): string {
  return ensureRelativePath(path);
}

export function normalizeOptionalPath(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }

  return normalizePath(path);
}

export function createSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "workspace";
}

export function suggestConflictPath(path: string, ordinal: number): string {
  const safeOrdinal = Math.max(1, ordinal);
  const slashIndex = path.lastIndexOf("/");
  const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
  const leaf = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const dotIndex = leaf.lastIndexOf(".");

  if (dotIndex <= 0) {
    return `${directory}${leaf} (conflict ${safeOrdinal})`;
  }

  const basename = leaf.slice(0, dotIndex);
  const extension = leaf.slice(dotIndex);
  return `${directory}${basename} (conflict ${safeOrdinal})${extension}`;
}
