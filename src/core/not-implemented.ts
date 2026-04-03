import { FastifyReply, FastifyRequest } from "fastify";

import { AppError } from "./errors";

export function replyNotImplemented(
  request: FastifyRequest,
  _reply: FastifyReply
): never {
  throw new AppError(
    501,
    "not_implemented",
    `Route ${request.method} ${request.routeOptions.url} is scaffolded but not implemented yet.`
  );
}
