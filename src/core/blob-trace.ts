import { FastifyBaseLogger } from "fastify";

import { AppError } from "./errors";

interface BlobTraceFields {
  phase: string;
  route: string;
  requestId: string;
  workspaceId?: string;
  entryId?: string;
  uploadId?: string;
  hash?: string;
  sizeBytes?: number;
  contentRange?: string;
  receivedOffset?: number;
  startOffset?: number;
  endOffset?: number;
  storedBlobHash?: string;
  statusCode: number;
  complete?: boolean;
  alreadyExists?: boolean;
  operationStatus?: string;
  opId?: string;
  errorCode?: string;
  errorDetails?: unknown;
}

type TraceDefinedFields<T extends Record<string, unknown>> = {
  [K in keyof T]?: Exclude<T[K], undefined>;
};

export function definedTraceFields<T extends Record<string, unknown>>(
  fields: T
): TraceDefinedFields<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as TraceDefinedFields<T>;
}

export function attachTraceRequestId(
  reply: { header: (name: string, value: string) => unknown },
  requestId: string
): void {
  reply.header("X-Rolay-Request-Id", requestId);
}

export function parseUploadContentRange(
  headerValue: string | undefined
): Pick<BlobTraceFields, "contentRange" | "receivedOffset" | "startOffset" | "endOffset"> {
  if (!headerValue || headerValue.trim() === "") {
    return {};
  }

  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(headerValue.trim());
  if (!match) {
    return {
      contentRange: headerValue
    };
  }

  const startOffset = Number.parseInt(match[1]!, 10);
  const endOffset = Number.parseInt(match[2]!, 10);

  return {
    contentRange: headerValue,
    receivedOffset: startOffset,
    startOffset,
    endOffset
  };
}

export function formatDownloadContentRange(
  partial: boolean,
  startOffset: number,
  endOffset: number,
  sizeBytes: number
): string | undefined {
  if (!partial) {
    return undefined;
  }

  return `bytes ${startOffset}-${endOffset}/${sizeBytes}`;
}

export function logBlobTrace(
  logger: FastifyBaseLogger,
  fields: BlobTraceFields
): void {
  logger.info(
    {
      trace: "blob-transfer",
      ...fields
    },
    "Blob transfer trace"
  );
}

export function logBlobTraceFailure(
  logger: FastifyBaseLogger,
  fields: Omit<BlobTraceFields, "statusCode">,
  error: unknown
): void {
  const statusCode = error instanceof AppError ? error.statusCode : 500;
  const payload = {
    trace: "blob-transfer",
    ...fields,
    statusCode,
    ...(error instanceof AppError
      ? {
          errorCode: error.code,
          errorDetails: error.details
        }
      : {})
  };

  if (statusCode >= 500) {
    logger.error(
      {
        ...payload,
        err: error
      },
      "Blob transfer trace"
    );
    return;
  }

  logger.warn(payload, "Blob transfer trace");
}
