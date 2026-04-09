import { FastifyPluginAsync } from "fastify";
import { Readable } from "node:stream";

import { AppError } from "../../core/errors";
import { asObject, requireString } from "../../core/validation";

const storageRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(/^[^;]+(?:;.*)?$/, (_request, payload, done) => {
    done(null, payload);
  });

  app.put("/_storage/upload/:ticketId", async (request, reply) => {
    const params = asObject(request.params, "Expected route params.");
    const ticketId = requireString(params, "ticketId");

    const body = request.body;
    if (!(body instanceof Readable)) {
      throw new AppError(400, "invalid_request", "Upload body must be binary.");
    }

    const response = await app.rolay.files.uploadBlobContentByTicket(
      ticketId,
      body,
      typeof request.headers["content-type"] === "string"
        ? request.headers["content-type"]
        : undefined
    );

    reply.status(201);
    return response;
  });

  app.get("/_storage/download/:ticketId", async (request, reply) => {
    const params = asObject(request.params, "Expected route params.");
    const ticketId = requireString(params, "ticketId");
    const ticket = app.rolay.state.blobDownloadTickets.get(ticketId);
    if (!ticket || Date.parse(ticket.expiresAt) <= Date.now()) {
      if (ticket) {
        app.rolay.state.blobDownloadTickets.delete(ticketId);
      }
      throw new AppError(404, "download_ticket_not_found", "Download ticket not found.");
    }

    const blob = await app.rolay.storage.loadBlobStream(ticket.hash);
    if (!blob) {
      throw new AppError(404, "entry_not_found", "Blob payload not found.");
    }

    reply.header("Content-Type", blob.metadata.mimeType);
    reply.header("Content-Length", String(blob.metadata.sizeBytes));
    reply.header("Cache-Control", "private, max-age=60");
    reply.header("X-Rolay-Blob-Hash", blob.metadata.hash);
    app.rolay.state.blobDownloadTickets.delete(ticketId);
    await app.rolay.stateStore.saveState(app.rolay.state);
    return reply.send(blob.stream);
  });
};

export default storageRoutes;
