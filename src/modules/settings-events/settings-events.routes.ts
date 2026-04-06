import { FastifyPluginAsync, FastifyReply } from "fastify";

import { AppError } from "../../core/errors";
import { requireAuth } from "../../core/http-auth";
import { asObject, ensureNonNegativeInteger } from "../../core/validation";
import { SettingsEvent } from "../../domain/types";

function parseCursor(queryValue: unknown, lastEventIdHeader: string | string[] | undefined): number | undefined {
  const headerValue =
    typeof lastEventIdHeader === "string"
      ? lastEventIdHeader
      : Array.isArray(lastEventIdHeader)
        ? lastEventIdHeader.at(-1)
        : undefined;

  const rawValue = queryValue ?? headerValue;
  if (rawValue === undefined || rawValue === "") {
    return undefined;
  }

  if (typeof rawValue === "number") {
    return ensureNonNegativeInteger(rawValue, "cursor");
  }

  if (typeof rawValue === "string" && rawValue.trim() !== "") {
    const cursor = Number.parseInt(rawValue, 10);
    return ensureNonNegativeInteger(cursor, "cursor");
  }

  throw new AppError(400, "invalid_request", 'Field "cursor" must be a non-negative integer.');
}

function writeEvent(reply: FastifyReply, event: SettingsEvent): void {
  reply.raw.write(`id: ${event.eventId}\n`);
  reply.raw.write(`event: ${event.type}\n`);
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

const settingsEventsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/events/settings", async (request, reply) => {
    const principal = requireAuth(app, request);
    const query = asObject(request.query ?? {});
    const cursor = parseCursor(query.cursor, request.headers["last-event-id"]);

    let lastSentEventId = cursor ?? -1;
    const sendEvent = (event: SettingsEvent): void => {
      if (event.eventId <= lastSentEventId) {
        return;
      }

      lastSentEventId = event.eventId;
      writeEvent(reply, event);
    };

    const stream = app.rolay.settingsEvents.openStream(
      principal.user,
      cursor,
      sendEvent
    );

    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.write(": connected\n\n");

    if (cursor === undefined) {
      const currentCursor = app.rolay.settingsEvents.currentCursor();
      sendEvent({
        eventId: currentCursor,
        type: "stream.ready",
        occurredAt: new Date().toISOString(),
        scope: "settings.stream",
        payload: {
          cursor: currentCursor
        }
      });
    } else {
      for (const event of stream.initialEvents) {
        sendEvent(event);
      }
    }

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
  });
};

export default settingsEventsRoutes;
