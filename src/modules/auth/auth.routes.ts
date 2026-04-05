import { FastifyPluginAsync } from "fastify";

import { requireAuth } from "../../core/http-auth";
import { asObject, requireString } from "../../core/validation";

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

  app.patch("/v1/auth/me/password", async (request) => {
    const principal = requireAuth(app, request);
    const body = asObject(request.body);
    const session = await app.rolay.auth.changePassword(
      principal,
      requireString(body, "currentPassword"),
      requireString(body, "newPassword")
    );

    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: session.user
    };
  });
};

export default authRoutes;
