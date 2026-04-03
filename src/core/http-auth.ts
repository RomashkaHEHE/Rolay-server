import { FastifyInstance, FastifyRequest } from "fastify";

import { AppError } from "./errors";
import { AuthPrincipal } from "../domain/types";

export function getBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization) {
    throw new AppError(401, "unauthorized", "Missing bearer token.");
  }

  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new AppError(401, "unauthorized", "Malformed bearer token.");
  }

  return token;
}

export function requireAuth(
  app: FastifyInstance,
  request: FastifyRequest
): AuthPrincipal {
  const token = getBearerToken(request);
  return app.rolay.auth.authenticateAccessToken(token);
}
