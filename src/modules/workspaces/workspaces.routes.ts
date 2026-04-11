import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requireAuth } from "../../core/http-auth";
import { asObject, optionalString, requireString } from "../../core/validation";

const workspacesRoutes: FastifyPluginAsync = async (app) => {
  const listWorkspaces = async (request: FastifyRequest) => {
    const principal = requireAuth(app, request);
    return {
      workspaces: app.rolay.workspaces.listUserWorkspaces(principal.user)
    };
  };

  const createWorkspace = async (request: FastifyRequest, reply: FastifyReply) => {
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
  };

  app.get("/v1/workspaces", listWorkspaces);
  app.get("/v1/rooms", listWorkspaces);

  const getWorkspaceMembers = async (request: FastifyRequest) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    return {
      members: app.rolay.workspaces.getWorkspaceMembers(
        principal.user,
        requireString(params, "workspaceId")
      )
    };
  };

  app.get("/v1/workspaces/:workspaceId/members", getWorkspaceMembers);
  app.get("/v1/rooms/:workspaceId/members", getWorkspaceMembers);

  app.post("/v1/workspaces", async (request, reply) => {
    return createWorkspace(request, reply);
  });

  app.post("/v1/rooms", async (request, reply) => {
    return createWorkspace(request, reply);
  });
};

export default workspacesRoutes;
