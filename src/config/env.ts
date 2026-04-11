export interface AppEnv {
  host: string;
  port: number;
  logLevel: string;
  stateDriver: "memory" | "postgres";
  postgresUrl: string | undefined;
  postgresStateKey: string;
  devAuthUsername: string;
  devAuthPassword: string;
  devAuthDisplayName: string;
  publicBaseUrl: string;
  crdtProvider: string;
  crdtWsUrl: string;
  crdtTokenTtlSeconds: number;
  drawingWsUrl: string;
  drawingTokenTtlSeconds: number;
  drawingLeaseTtlSeconds: number;
  drawingSnapshotStoreDebounceMs: number;
  drawingPointerStaleMs: number;
  blobTicketTtlSeconds: number;
  blobUploadBaseUrl: string;
  blobDownloadBaseUrl: string;
  storageDriver: "local" | "minio";
  localDataDir: string;
  minioEndpoint: string;
  minioPort: number;
  minioUseSSL: boolean;
  minioAccessKey: string;
  minioSecretKey: string;
  minioBucket: string;
  minioRegion: string | undefined;
  minioPrefix: string;
  crdtStoreDebounceMs: number;
  crdtStoreMaxDebounceMs: number;
}

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) {
    return 3000;
  }

  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }

  return port;
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number, fieldName: string): number {
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid ${fieldName} value: ${rawValue}`);
  }

  return parsedValue;
}

function parseEnumValue<T extends string>(
  rawValue: string | undefined,
  fallback: T,
  allowedValues: readonly T[],
  fieldName: string
): T {
  if (!rawValue) {
    return fallback;
  }

  if (!allowedValues.includes(rawValue as T)) {
    throw new Error(`Invalid ${fieldName} value: ${rawValue}`);
  }

  return rawValue as T;
}

function parseBoolean(rawValue: string | undefined, fallback: boolean, fieldName: string): boolean {
  if (!rawValue) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  throw new Error(`Invalid ${fieldName} value: ${rawValue}`);
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function normalizeObjectPrefix(prefix: string | undefined): string {
  const normalized = (prefix || "rolay").trim().replace(/^\/+|\/+$/g, "");
  return normalized || "rolay";
}

function deriveWsUrl(publicBaseUrl: string): string {
  if (publicBaseUrl.startsWith("https://")) {
    return `${publicBaseUrl.replace("https://", "wss://")}/v1/crdt`;
  }
  if (publicBaseUrl.startsWith("http://")) {
    return `${publicBaseUrl.replace("http://", "ws://")}/v1/crdt`;
  }

  throw new Error(`Cannot derive CRDT websocket URL from PUBLIC_BASE_URL: ${publicBaseUrl}`);
}

function deriveDrawingWsUrl(publicBaseUrl: string): string {
  if (publicBaseUrl.startsWith("https://")) {
    return `${publicBaseUrl.replace("https://", "wss://")}/v1/drawings`;
  }
  if (publicBaseUrl.startsWith("http://")) {
    return `${publicBaseUrl.replace("http://", "ws://")}/v1/drawings`;
  }

  throw new Error(`Cannot derive drawing websocket URL from PUBLIC_BASE_URL: ${publicBaseUrl}`);
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const port = parsePort(source.PORT);
  const publicBaseUrl = normalizeBaseUrl(
    source.PUBLIC_BASE_URL || `http://localhost:${port}`
  );
  const stateDriver = parseEnumValue(
    source.STATE_DRIVER,
    "memory",
    ["memory", "postgres"],
    "STATE_DRIVER"
  );
  const storageDriver = parseEnumValue(
    source.STORAGE_DRIVER,
    "local",
    ["local", "minio"],
    "STORAGE_DRIVER"
  );
  const postgresUrl = source.POSTGRES_URL?.trim();
  if (stateDriver === "postgres" && !postgresUrl) {
    throw new Error("POSTGRES_URL is required when STATE_DRIVER=postgres.");
  }

  return {
    host: source.HOST || "0.0.0.0",
    port,
    logLevel: source.LOG_LEVEL || "info",
    stateDriver,
    postgresUrl: postgresUrl || undefined,
    postgresStateKey: source.POSTGRES_STATE_KEY || "default",
    devAuthUsername: source.DEV_AUTH_USERNAME || "dev",
    devAuthPassword: source.DEV_AUTH_PASSWORD || "dev-password",
    devAuthDisplayName: source.DEV_AUTH_DISPLAY_NAME || "Development User",
    publicBaseUrl,
    crdtProvider: source.CRDT_PROVIDER || "yjs-hocuspocus",
    crdtWsUrl: normalizeBaseUrl(source.CRDT_WS_URL || deriveWsUrl(publicBaseUrl)),
    crdtTokenTtlSeconds: parsePositiveInteger(
      source.CRDT_TOKEN_TTL_SECONDS,
      300,
      "CRDT_TOKEN_TTL_SECONDS"
    ),
    drawingWsUrl: normalizeBaseUrl(
      source.DRAWING_WS_URL || deriveDrawingWsUrl(publicBaseUrl)
    ),
    drawingTokenTtlSeconds: parsePositiveInteger(
      source.DRAWING_TOKEN_TTL_SECONDS,
      300,
      "DRAWING_TOKEN_TTL_SECONDS"
    ),
    drawingLeaseTtlSeconds: parsePositiveInteger(
      source.DRAWING_LEASE_TTL_SECONDS,
      30,
      "DRAWING_LEASE_TTL_SECONDS"
    ),
    drawingSnapshotStoreDebounceMs: parsePositiveInteger(
      source.DRAWING_SNAPSHOT_STORE_DEBOUNCE_MS,
      1000,
      "DRAWING_SNAPSHOT_STORE_DEBOUNCE_MS"
    ),
    drawingPointerStaleMs: parsePositiveInteger(
      source.DRAWING_POINTER_STALE_MS,
      5000,
      "DRAWING_POINTER_STALE_MS"
    ),
    crdtStoreDebounceMs: parsePositiveInteger(
      source.CRDT_STORE_DEBOUNCE_MS,
      1000,
      "CRDT_STORE_DEBOUNCE_MS"
    ),
    crdtStoreMaxDebounceMs: parsePositiveInteger(
      source.CRDT_STORE_MAX_DEBOUNCE_MS,
      5000,
      "CRDT_STORE_MAX_DEBOUNCE_MS"
    ),
    blobTicketTtlSeconds: parsePositiveInteger(
      source.BLOB_TICKET_TTL_SECONDS,
      900,
      "BLOB_TICKET_TTL_SECONDS"
    ),
    blobUploadBaseUrl: normalizeBaseUrl(
      source.BLOB_UPLOAD_BASE_URL || `${publicBaseUrl}/_storage/upload`
    ),
    blobDownloadBaseUrl: normalizeBaseUrl(
      source.BLOB_DOWNLOAD_BASE_URL || `${publicBaseUrl}/_storage/download`
    ),
    storageDriver,
    localDataDir: source.LOCAL_DATA_DIR || ".rolay-data",
    minioEndpoint: source.MINIO_ENDPOINT || "localhost",
    minioPort: parsePositiveInteger(source.MINIO_PORT, 9000, "MINIO_PORT"),
    minioUseSSL: parseBoolean(source.MINIO_USE_SSL, false, "MINIO_USE_SSL"),
    minioAccessKey: source.MINIO_ACCESS_KEY || "minioadmin",
    minioSecretKey: source.MINIO_SECRET_KEY || "minioadmin",
    minioBucket: source.MINIO_BUCKET || "rolay",
    minioRegion: source.MINIO_REGION || undefined,
    minioPrefix: normalizeObjectPrefix(source.MINIO_PREFIX)
  };
}
