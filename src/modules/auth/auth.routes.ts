import { FastifyPluginAsync } from "fastify";

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
};

export default authRoutes;
