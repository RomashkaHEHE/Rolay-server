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
import { requireAuth } from "../../core/http-auth";
import {
  asArray,
  asObject,
  ensureNonNegativeInteger,
  optionalInteger,
  optionalString,
  requireString
} from "../../core/validation";

function parseEntryIds(value: unknown): string[] {
  return asArray(value, 'Field "entryIds" must be an array.').map((entryId) => {
    if (typeof entryId !== "string" || entryId.trim() === "") {
      throw new AppError(
        400,
        "invalid_request",
        'Field "entryIds" must contain non-empty strings.'
      );
    }

    return entryId;
  });
}

function parseIncludeState(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new AppError(400, "invalid_request", 'Field "includeState" must be a boolean.');
  }

  return value;
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  return Array.isArray(value) ? value.at(-1) : undefined;
}

const filesRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/workspaces/:workspaceId/markdown/bootstrap", async (request) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    const body = request.body === undefined ? {} : asObject(request.body);
    const entryIds = body.entryIds === undefined ? undefined : parseEntryIds(body.entryIds);
    const includeState = parseIncludeState(body.includeState);

    return app.rolay.files.bootstrapMarkdownDocuments(
      principal.user,
      requireString(params, "workspaceId"),
      entryIds,
      includeState === undefined ? {} : { includeState }
    );
  });

  app.post("/v1/files/:entryId/crdt-token", async (request) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");

    return app.rolay.files.createCrdtToken(
      principal.user,
      requireString(params, "entryId")
    );
  });

  app.post("/v1/files/:entryId/blob/upload-ticket", async (request, reply) => {
    attachTraceRequestId(reply, request.id);

    let entryId: string | undefined;
    let workspaceId: string | undefined;
    let hash: string | undefined;
    let sizeBytes: number | undefined;
    let uploadId: string | undefined;

    try {
      const principal = requireAuth(app, request);
      const params = asObject(request.params, "Expected route params.");
      const body = asObject(request.body);
      entryId = requireString(params, "entryId");
      hash = requireString(body, "hash");
      const parsedSizeBytes = optionalInteger(body, "sizeBytes");
      sizeBytes = ensureNonNegativeInteger(
        parsedSizeBytes ?? Number.NaN,
        "sizeBytes"
      );
      const traceContext = app.rolay.files.getBlobEntryTraceContext(principal.user, entryId);
      workspaceId = traceContext.workspaceId;

      const response = await app.rolay.files.createBlobUploadTicket(
        principal.user,
        entryId,
        hash,
        sizeBytes,
        requireString(body, "mimeType")
      );
      uploadId = response.uploadId;

      logBlobTrace(request.log, {
        phase: "upload-ticket",
        route: "/v1/files/:entryId/blob/upload-ticket",
        requestId: request.id,
        statusCode: 200,
        ...definedTraceFields({
          workspaceId,
          entryId,
          uploadId,
          hash: response.hash ?? hash,
          sizeBytes: response.sizeBytes ?? sizeBytes,
          alreadyExists: response.alreadyExists
        })
      });

      return response;
    } catch (error) {
      logBlobTraceFailure(
        request.log,
        {
          phase: "upload-ticket",
          route: "/v1/files/:entryId/blob/upload-ticket",
          requestId: request.id,
          ...definedTraceFields({
            workspaceId,
            entryId,
            uploadId,
            hash,
            sizeBytes
          })
        },
        error
      );
      throw error;
    }
  });

  app.post("/v1/files/:entryId/blob/download-ticket", async (request, reply) => {
    attachTraceRequestId(reply, request.id);

    let entryId: string | undefined;
    let workspaceId: string | undefined;
    let hash: string | undefined;
    let sizeBytes: number | undefined;

    try {
      const principal = requireAuth(app, request);
      const params = asObject(request.params, "Expected route params.");
      entryId = requireString(params, "entryId");
      const traceContext = app.rolay.files.getBlobEntryTraceContext(principal.user, entryId);
      workspaceId = traceContext.workspaceId;

      const response = await app.rolay.files.createBlobDownloadTicket(
        principal.user,
        entryId
      );
      hash = response.hash;
      sizeBytes = response.sizeBytes;

      logBlobTrace(request.log, {
        phase: "download-ticket",
        route: "/v1/files/:entryId/blob/download-ticket",
        requestId: request.id,
        statusCode: 200,
        ...definedTraceFields({
          workspaceId,
          entryId,
          hash,
          sizeBytes
        })
      });

      return response;
    } catch (error) {
      logBlobTraceFailure(
        request.log,
        {
          phase: "download-ticket",
          route: "/v1/files/:entryId/blob/download-ticket",
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

  app.get("/v1/files/:entryId/blob/content", async (request, reply) => {
    attachTraceRequestId(reply, request.id);

    let entryId: string | undefined;
    let workspaceId: string | undefined;
    let hash: string | undefined;
    let sizeBytes: number | undefined;

    try {
      const principal = requireAuth(app, request);
      const params = asObject(request.params, "Expected route params.");
      entryId = requireString(params, "entryId");
      const traceContext = app.rolay.files.getBlobEntryTraceContext(principal.user, entryId);
      workspaceId = traceContext.workspaceId;
      const blob = await app.rolay.files.getBlobContent(
        principal.user,
        entryId,
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
        phase: "blob-content-get",
        route: "/v1/files/:entryId/blob/content",
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
          phase: "blob-content-get",
          route: "/v1/files/:entryId/blob/content",
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

  app.delete("/v1/files/:entryId/blob/uploads/:uploadId", async (request) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");

    return app.rolay.files.cancelBlobUpload(
      principal.user,
      requireString(params, "entryId"),
      requireString(params, "uploadId")
    );
  });

  await app.register(async (rawUploadApp) => {
    rawUploadApp.addContentTypeParser(/^[^;]+(?:;.*)?$/, (_request, payload, done) => {
      done(null, payload);
    });

    rawUploadApp.put("/v1/files/:entryId/blob/uploads/:uploadId/content", async (request, reply) => {
      attachTraceRequestId(reply, request.id);

      let entryId: string | undefined;
      let workspaceId: string | undefined;
      let uploadId: string | undefined;
      let hash: string | undefined;
      let sizeBytes: number | undefined;
      const contentRange = getHeaderValue(request.headers["content-range"]);
      const rangeTrace = parseUploadContentRange(contentRange);

      try {
        const principal = requireAuth(rawUploadApp, request);
        const params = asObject(request.params, "Expected route params.");
        const body = request.body;

        if (!(body instanceof Readable)) {
          throw new AppError(400, "invalid_request", "Upload body must be binary.");
        }

        entryId = requireString(params, "entryId");
        uploadId = requireString(params, "uploadId");
        const traceContext = rawUploadApp.rolay.files.getBlobUploadTraceContext(uploadId);
        workspaceId = traceContext.workspaceId;
        hash = traceContext.hash;
        sizeBytes = traceContext.sizeBytes;

        const response = await rawUploadApp.rolay.files.uploadBlobContent(
          principal.user,
          entryId,
          uploadId,
          body,
          getHeaderValue(request.headers["content-type"]),
          contentRange
        );

        logBlobTrace(request.log, {
          phase: "upload-content",
          route: "/v1/files/:entryId/blob/uploads/:uploadId/content",
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
            phase: "upload-content",
            route: "/v1/files/:entryId/blob/uploads/:uploadId/content",
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
  });
};

export default filesRoutes;
