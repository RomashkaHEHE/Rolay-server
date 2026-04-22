import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requireAuth } from "../../core/http-auth";
import {
  asObject,
  ensureNonNegativeInteger,
  optionalInteger,
  requireString
} from "../../core/validation";
import {
  NoteReadStateSnapshot,
  NoteReadStateUpdate
} from "../../domain/types";

function writeEvent(
  reply: FastifyReply,
  event: "read-state.snapshot" | "note.read-state.updated",
  payload: NoteReadStateSnapshot | NoteReadStateUpdate
): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const noteReadStateRoutes: FastifyPluginAsync = async (app) => {
  const streamHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    const workspaceId = requireString(params, "workspaceId");
    const stream = app.rolay.noteReadState.openStream(
      principal.user,
      workspaceId,
      (event) => {
        writeEvent(reply, event.type, event.payload);
      }
    );

    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.write(": connected\n\n");
    writeEvent(reply, "read-state.snapshot", stream.snapshot);

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

  app.get("/v1/workspaces/:workspaceId/note-read-state/events", streamHandler);
  app.get("/v1/rooms/:workspaceId/note-read-state/events", streamHandler);

  app.post("/v1/workspaces/:workspaceId/notes/:entryId/read", async (request) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    const body = asObject(request.body);
    const requestedContentVersion = ensureNonNegativeInteger(
      optionalInteger(body, "contentVersion") ?? Number.NaN,
      "contentVersion"
    );

    return app.rolay.noteReadState.markRead(
      principal.user,
      requireString(params, "workspaceId"),
      requireString(params, "entryId"),
      requestedContentVersion
    );
  });
};

export default noteReadStateRoutes;
