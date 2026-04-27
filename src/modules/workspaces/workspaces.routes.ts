import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { AppError } from "../../core/errors";
import { requireAuth } from "../../core/http-auth";
import { asObject, optionalString, requireString } from "../../core/validation";

function requireBoolean(object: Record<string, unknown>, key: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new AppError(400, "invalid_request", `Field "${key}" must be a boolean.`);
  }

  return value;
}

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

  // Keep both route families live while the product vocabulary is "room" but older sync code and
  // parts of the protocol still use "workspaceId" as the stable identifier.
  app.get("/v1/workspaces/:workspaceId/members", getWorkspaceMembers);
  app.get("/v1/rooms/:workspaceId/members", getWorkspaceMembers);

  const getWorkspacePublication = async (request: FastifyRequest) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    return {
      publication: app.rolay.workspaces.getPublication(
        principal.user,
        requireString(params, "workspaceId")
      )
    };
  };

  const updateWorkspacePublication = async (request: FastifyRequest) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    const body = asObject(request.body);
    return {
      publication: await app.rolay.workspaces.updatePublicationEnabled(
        principal.user,
        requireString(params, "workspaceId"),
        requireBoolean(body, "enabled")
      )
    };
  };

  app.get("/v1/workspaces/:workspaceId/publication", getWorkspacePublication);
  app.get("/v1/rooms/:workspaceId/publication", getWorkspacePublication);
  app.patch("/v1/workspaces/:workspaceId/publication", updateWorkspacePublication);
  app.patch("/v1/rooms/:workspaceId/publication", updateWorkspacePublication);

  app.post("/v1/workspaces", async (request, reply) => {
    return createWorkspace(request, reply);
  });

  app.post("/v1/rooms", async (request, reply) => {
    return createWorkspace(request, reply);
  });
};

export default workspacesRoutes;
