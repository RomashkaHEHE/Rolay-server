import { FastifyPluginAsync } from "fastify";
import { Readable } from "node:stream";

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

  app.post("/v1/files/:entryId/blob/upload-ticket", async (request) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    const body = asObject(request.body);
    const sizeBytes = optionalInteger(body, "sizeBytes");

    return app.rolay.files.createBlobUploadTicket(
      principal.user,
      requireString(params, "entryId"),
      requireString(body, "hash"),
      ensureNonNegativeInteger(
        sizeBytes ?? Number.NaN,
        "sizeBytes"
      ),
      requireString(body, "mimeType")
    );
  });

  app.post("/v1/files/:entryId/blob/download-ticket", async (request) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");

    return app.rolay.files.createBlobDownloadTicket(
      principal.user,
      requireString(params, "entryId")
    );
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

    rawUploadApp.put("/v1/files/:entryId/blob/uploads/:uploadId/content", async (request) => {
      const principal = requireAuth(rawUploadApp, request);
      const params = asObject(request.params, "Expected route params.");
      const body = request.body;

      if (!(body instanceof Readable)) {
        throw new AppError(400, "invalid_request", "Upload body must be binary.");
      }

      return rawUploadApp.rolay.files.uploadBlobContent(
        principal.user,
        requireString(params, "entryId"),
        requireString(params, "uploadId"),
        body,
        typeof request.headers["content-type"] === "string"
          ? request.headers["content-type"]
          : undefined
      );
    });
  });
};

export default filesRoutes;
