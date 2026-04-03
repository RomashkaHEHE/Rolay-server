import { FastifyPluginAsync } from "fastify";

import { requireAuth } from "../../core/http-auth";
import {
  asObject,
  ensureNonNegativeInteger,
  optionalInteger,
  optionalString,
  requireString
} from "../../core/validation";

const filesRoutes: FastifyPluginAsync = async (app) => {
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
};

export default filesRoutes;
