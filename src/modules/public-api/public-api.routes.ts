import { FastifyPluginAsync, FastifyReply } from "fastify";

import { AppError } from "../../core/errors";
import {
  asObject,
  ensureNonNegativeInteger,
  requireString
} from "../../core/validation";
import {
  PublicViewerPresenceSnapshot,
  PublicViewerPresenceUpdate,
  WorkspaceEvent
} from "../../domain/types";

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  return Array.isArray(value) ? value.at(-1) : undefined;
}

function parseCursor(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    return ensureNonNegativeInteger(value, "cursor");
  }
  if (typeof value === "string" && value.trim() !== "") {
    return ensureNonNegativeInteger(Number.parseInt(value, 10), "cursor");
  }

  throw new AppError(400, "invalid_request", 'Field "cursor" must be a non-negative integer.');
}

function writeEvent(reply: FastifyReply, event: WorkspaceEvent): void {
  reply.raw.write(`id: ${event.seq}\n`);
  reply.raw.write(`event: ${event.eventType}\n`);
  reply.raw.write(`data: ${JSON.stringify(event.payload)}\n\n`);
}

function writeLiveEvent(
  reply: FastifyReply,
  event: "public.note-viewers.snapshot" | "public.note-viewers.updated",
  payload: PublicViewerPresenceSnapshot | PublicViewerPresenceUpdate
): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const publicApiRoutes: FastifyPluginAsync = async (app) => {
  app.get("/public/api/rooms", async () => ({
    rooms: app.rolay.publicAccess.listPublicRooms()
  }));

  app.get("/public/api/rooms/:workspaceId/manifest", async (request) => {
    const params = asObject(request.params, "Expected route params.");
    return app.rolay.publicAccess.getManifest(requireString(params, "workspaceId"));
  });

  app.post("/public/api/rooms/:workspaceId/markdown/:entryId/crdt-token", async (request) => {
    const params = asObject(request.params, "Expected route params.");
    return app.rolay.publicAccess.createPublicCrdtToken(
      requireString(params, "workspaceId"),
      requireString(params, "entryId")
    );
  });

  app.get("/public/api/rooms/:workspaceId/files/:entryId/blob/content", async (request, reply) => {
    const params = asObject(request.params, "Expected route params.");
    const query = asObject(request.query ?? {});
    const blob = await app.rolay.publicAccess.getBlobContent(
      requireString(params, "workspaceId"),
      requireString(params, "entryId"),
      requireString(query, "hash"),
      getHeaderValue(request.headers.range)
    );

    reply.header("Content-Type", blob.mimeType);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Length", String(blob.contentLength));
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("X-Rolay-Blob-Hash", blob.hash);
    if (blob.partial) {
      reply.status(206);
      reply.header(
        "Content-Range",
        `bytes ${blob.startOffset}-${blob.endOffset}/${blob.sizeBytes}`
      );
    }

    return reply.send(blob.stream);
  });

  app.get("/public/api/rooms/:workspaceId/events", async (request, reply) => {
    const params = asObject(request.params, "Expected route params.");
    const query = asObject(request.query ?? {});
    const workspaceId = requireString(params, "workspaceId");
    const cursor = parseCursor(query.cursor);

    let lastSentSeq = cursor;
    let cleanup = (): void => {};
    const sendEvent = (event: WorkspaceEvent): void => {
      if (event.seq <= lastSentSeq) {
        return;
      }
      lastSentSeq = event.seq;
      writeEvent(reply, event);
      if (
        event.eventType === "room.publication.updated" &&
        (event.payload.publication as { enabled?: unknown } | undefined)?.enabled === false
      ) {
        cleanup();
      }
    };

    const stream = app.rolay.publicAccess.openEventStream(workspaceId, cursor, sendEvent);
    const viewerStream = app.rolay.publicViewerPresence.openStream(workspaceId, (event) => {
      writeLiveEvent(reply, event.type, event.payload);
    });

    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.write(": connected\n\n");

    const keepAlive = setInterval(() => {
      reply.raw.write(": keepalive\n\n");
    }, 15_000);

    let closed = false;
    cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(keepAlive);
      stream.unsubscribe();
      viewerStream.unsubscribe();
      reply.raw.end();
    };

    writeLiveEvent(reply, "public.note-viewers.snapshot", viewerStream.snapshot);
    for (const event of stream.initialEvents) {
      sendEvent(event);
    }

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);

    return reply;
  });
};

export default publicApiRoutes;
