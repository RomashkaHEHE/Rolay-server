import { FastifyPluginAsync } from "fastify";
import { Readable } from "node:stream";

import {
  attachTraceRequestId,
  definedTraceFields,
  formatDownloadContentRange,
  logBlobTrace,
  logBlobTraceFailure,
  parseUploadContentRange
} from "../../core/blob-trace";
import { AppError } from "../../core/errors";
import { asObject, requireString } from "../../core/validation";

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  return Array.isArray(value) ? value.at(-1) : undefined;
}

const storageRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(/^[^;]+(?:;.*)?$/, (_request, payload, done) => {
    done(null, payload);
  });

  app.put("/_storage/upload/:ticketId", async (request, reply) => {
    attachTraceRequestId(reply, request.id);

    let workspaceId: string | undefined;
    let entryId: string | undefined;
    let uploadId: string | undefined;
    let hash: string | undefined;
    let sizeBytes: number | undefined;
    const contentRange = getHeaderValue(request.headers["content-range"]);
    const rangeTrace = parseUploadContentRange(contentRange);

    try {
      const params = asObject(request.params, "Expected route params.");
      uploadId = requireString(params, "ticketId");

      const body = request.body;
      if (!(body instanceof Readable)) {
        throw new AppError(400, "invalid_request", "Upload body must be binary.");
      }

      const traceContext = app.rolay.files.getBlobUploadTraceContext(uploadId);
      workspaceId = traceContext.workspaceId;
      entryId = traceContext.entryId;
      hash = traceContext.hash;
      sizeBytes = traceContext.sizeBytes;

      const response = await app.rolay.files.uploadBlobContentByTicket(
        uploadId,
        body,
        getHeaderValue(request.headers["content-type"]),
        contentRange
      );

      logBlobTrace(request.log, {
        phase: "storage-upload-content",
        route: "/_storage/upload/:ticketId",
        requestId: request.id,
        statusCode: 200,
        ...definedTraceFields({
          workspaceId,
          entryId,
          uploadId,
          hash,
          sizeBytes,
          ...rangeTrace,
          storedBlobHash: response.hash,
          complete: response.complete
        })
      });

      return response;
    } catch (error) {
      logBlobTraceFailure(
        request.log,
        {
          phase: "storage-upload-content",
          route: "/_storage/upload/:ticketId",
          requestId: request.id,
          ...definedTraceFields({
            workspaceId,
            entryId,
            uploadId,
            hash,
            sizeBytes,
            ...rangeTrace
          })
        },
        error
      );
      throw error;
    }
  });

  app.get("/_storage/download/:ticketId", async (request, reply) => {
    attachTraceRequestId(reply, request.id);

    let workspaceId: string | undefined;
    let entryId: string | undefined;
    let hash: string | undefined;
    let sizeBytes: number | undefined;

    try {
      const params = asObject(request.params, "Expected route params.");
      const ticketId = requireString(params, "ticketId");
      const traceContext = await app.rolay.files.getBlobDownloadTicketTraceContext(ticketId);
      workspaceId = traceContext.workspaceId;
      entryId = traceContext.entryId;
      hash = traceContext.hash;

      const blob = await app.rolay.files.getBlobContentByDownloadTicket(
        ticketId,
        getHeaderValue(request.headers.range)
      );

      reply.header("Content-Type", blob.mimeType);
      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Length", String(blob.contentLength));
      reply.header("Cache-Control", "private, max-age=60");
      reply.header("X-Rolay-Blob-Hash", blob.hash);
      if (blob.partial) {
        reply.status(206);
        reply.header(
          "Content-Range",
          `bytes ${blob.startOffset}-${blob.endOffset}/${blob.sizeBytes}`
        );
      }

      hash = blob.hash;
      sizeBytes = blob.sizeBytes;
      logBlobTrace(request.log, {
        phase: "storage-download-content",
        route: "/_storage/download/:ticketId",
        requestId: request.id,
        statusCode: blob.partial ? 206 : 200,
        ...definedTraceFields({
          workspaceId,
          entryId,
          hash,
          sizeBytes,
          contentRange: formatDownloadContentRange(
            blob.partial,
            blob.startOffset,
            blob.endOffset,
            blob.sizeBytes
          ),
          startOffset: blob.startOffset,
          endOffset: blob.endOffset
        })
      });

      return reply.send(blob.stream);
    } catch (error) {
      logBlobTraceFailure(
        request.log,
        {
          phase: "storage-download-content",
          route: "/_storage/download/:ticketId",
          requestId: request.id,
          ...definedTraceFields({
            workspaceId,
            entryId,
            hash,
            sizeBytes
          })
        },
        error
      );
      throw error;
    }
  });
};

export default storageRoutes;
