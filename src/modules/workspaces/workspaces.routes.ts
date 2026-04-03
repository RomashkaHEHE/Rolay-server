import { FastifyPluginAsync } from "fastify";

import { requireAuth } from "../../core/http-auth";
import { asObject, optionalString, requireString } from "../../core/validation";

const workspacesRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/workspaces", async (request, reply) => {
    const principal = requireAuth(app, request);
    const body = asObject(request.body);
    const workspace = await app.rolay.workspaces.createWorkspace(
      principal.user,
      requireString(body, "name"),
      optionalString(body, "slug")
    );

    reply.status(201);
    return {
      workspace
    };
  });
};

export default workspacesRoutes;
