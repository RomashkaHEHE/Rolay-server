import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requireAuth } from "../../core/http-auth";
import { asObject, requireString } from "../../core/validation";
import { NotePresenceSnapshot, NotePresenceUpdate } from "../../domain/types";

function writeEvent(
  reply: FastifyReply,
  event: "presence.snapshot" | "note.presence.updated",
  payload: NotePresenceSnapshot | NotePresenceUpdate
): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const notePresenceRoutes: FastifyPluginAsync = async (app) => {
  const streamHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    const workspaceId = requireString(params, "workspaceId");
    const stream = app.rolay.notePresence.openStream(principal.user, workspaceId, (event) => {
      writeEvent(reply, event.type, event.payload);
    });

    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.write(": connected\n\n");
    // Unlike tree/settings streams, note presence is intentionally live-only and always starts
    // from a fresh snapshot instead of a resumable cursor.
    writeEvent(reply, "presence.snapshot", stream.snapshot);

    const keepAlive = setInterval(() => {
      reply.raw.write("event: ping\n");
      reply.raw.write('data: {}\n\n');
    }, 15_000);

    let closed = false;
    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(keepAlive);
      stream.unsubscribe();
    };

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
    return reply;
  };

  app.get("/v1/workspaces/:workspaceId/note-presence/events", streamHandler);
  app.get("/v1/rooms/:workspaceId/note-presence/events", streamHandler);
};

export default notePresenceRoutes;
