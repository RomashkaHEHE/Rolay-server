import { createHash } from "node:crypto";

import { FastifyPluginAsync } from "fastify";

import { AppError } from "../../core/errors";
import { asObject, requireString } from "../../core/validation";

function isExpired(expiresAt: string): boolean {
  return Date.parse(expiresAt) <= Date.now();
}

const storageRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(/^[^;]+(?:;.*)?$/, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.put("/_storage/upload/:ticketId", async (request, reply) => {
    const params = asObject(request.params, "Expected route params.");
    const ticketId = requireString(params, "ticketId");
    const ticket = app.rolay.state.blobUploadTickets.get(ticketId);
    if (!ticket || isExpired(ticket.expiresAt)) {
      if (ticket) {
        app.rolay.state.blobUploadTickets.delete(ticketId);
      }
      throw new AppError(404, "upload_ticket_not_found", "Upload ticket not found.");
    }

    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new AppError(400, "invalid_request", "Upload body must be binary.");
    }
    if (body.byteLength !== ticket.sizeBytes) {
      throw new AppError(400, "payload_too_large", "Blob size does not match upload ticket.");
    }

    const requestContentType = request.headers["content-type"];
    if (
      typeof requestContentType === "string" &&
      requestContentType !== "" &&
      requestContentType !== ticket.mimeType
    ) {
      throw new AppError(400, "invalid_request", "Blob mimeType does not match upload ticket.");
    }

    const calculatedHash = `sha256:${createHash("sha256").update(body).digest("base64")}`;
    if (calculatedHash !== ticket.hash) {
      throw new AppError(400, "blob_hash_mismatch", "Uploaded blob hash does not match ticket.");
    }

    const storedBlob = await app.rolay.storage.storeBlob(ticket.hash, body, ticket.mimeType);
    app.rolay.state.blobObjects.set(storedBlob.hash, storedBlob);
    app.rolay.state.blobUploadTickets.delete(ticketId);
    await app.rolay.stateStore.saveState(app.rolay.state);

    reply.status(201);
    return {
      ok: true,
      hash: storedBlob.hash
    };
  });

  app.get("/_storage/download/:ticketId", async (request, reply) => {
    const params = asObject(request.params, "Expected route params.");
    const ticketId = requireString(params, "ticketId");
    const ticket = app.rolay.state.blobDownloadTickets.get(ticketId);
    if (!ticket || isExpired(ticket.expiresAt)) {
      if (ticket) {
        app.rolay.state.blobDownloadTickets.delete(ticketId);
      }
      throw new AppError(404, "download_ticket_not_found", "Download ticket not found.");
    }

    const blob = await app.rolay.storage.loadBlob(ticket.hash);
    if (!blob) {
      throw new AppError(404, "entry_not_found", "Blob payload not found.");
    }

    reply.header("Content-Type", blob.metadata.mimeType);
    reply.header("Content-Length", String(blob.payload.byteLength));
    reply.header("Cache-Control", "private, max-age=60");
    app.rolay.state.blobDownloadTickets.delete(ticketId);
    await app.rolay.stateStore.saveState(app.rolay.state);
    return reply.send(blob.payload);
  });
};

export default storageRoutes;
