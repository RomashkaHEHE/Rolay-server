import { FastifyPluginAsync } from "fastify";

import { requireAdmin, requireAuth } from "../../core/http-auth";
import { asObject, optionalString, requireString } from "../../core/validation";

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/auth/login", async (request) => {
    const body = asObject(request.body);
    const session = await app.rolay.auth.login(
      requireString(body, "username"),
      requireString(body, "password"),
      requireString(body, "deviceName")
    );

    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: session.user
    };
  });

  app.post("/v1/auth/refresh", async (request) => {
    const body = asObject(request.body);
    const session = await app.rolay.auth.refresh(requireString(body, "refreshToken"));

    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken
    };
  });

  app.get("/v1/auth/me", async (request) => {
    const principal = requireAuth(app, request);
    return {
      user: principal.user
    };
  });

  app.patch("/v1/auth/me/profile", async (request) => {
    const principal = requireAuth(app, request);
    const body = asObject(request.body);
    const user = await app.rolay.auth.updateDisplayName(
      principal.user.id,
      requireString(body, "displayName")
    );

    return {
      user
    };
  });

  app.post("/v1/admin/users", async (request, reply) => {
    const principal = requireAdmin(app, request);
    const body = asObject(request.body);
    const displayName = optionalString(body, "displayName");
    const user = await app.rolay.auth.createUser(principal.user, {
      username: requireString(body, "username"),
      password: requireString(body, "password"),
      ...(displayName !== undefined ? { displayName } : {})
    });

    reply.status(201);
    return {
      user
    };
  });
};

export default authRoutes;
