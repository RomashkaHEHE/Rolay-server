import { FastifyPluginAsync, FastifyRequest } from "fastify";

import { AppError } from "../../core/errors";
import { requireAuth } from "../../core/http-auth";
import { asObject, requireString } from "../../core/validation";

const invitesRoutes: FastifyPluginAsync = async (app) => {
  const acceptInvite = async (request: FastifyRequest) => {
    const principal = requireAuth(app, request);
    const body = asObject(request.body);
    const workspace = await app.rolay.workspaces.acceptInvite(
      principal.user,
      requireString(body, "code")
    );

    return {
      workspace
    };
  };

  const getInvite = async (request: FastifyRequest) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    return {
      invite: app.rolay.workspaces.getInvite(
        principal.user,
        requireString(params, "workspaceId")
      )
    };
  };

  const updateInvite = async (request: FastifyRequest) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    const body = asObject(request.body);
    if (typeof body.enabled !== "boolean") {
      throw new AppError(400, "invalid_request", 'Field "enabled" must be a boolean.');
    }
    return {
      invite: await app.rolay.workspaces.updateInviteEnabled(
        principal.user,
        requireString(params, "workspaceId"),
        body.enabled
      )
    };
  };

  const regenerateInvite = async (request: FastifyRequest) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    return {
      invite: await app.rolay.workspaces.regenerateInvite(
        principal.user,
        requireString(params, "workspaceId")
      )
    };
  };

  app.post("/v1/invites/accept", async (request) => acceptInvite(request));
  app.post("/v1/rooms/join", async (request) => acceptInvite(request));

  app.get("/v1/workspaces/:workspaceId/invite", async (request) => getInvite(request));
  app.get("/v1/rooms/:workspaceId/invite", async (request) => getInvite(request));

  app.patch("/v1/workspaces/:workspaceId/invite", async (request) => updateInvite(request));
  app.patch("/v1/rooms/:workspaceId/invite", async (request) => updateInvite(request));

  app.post(
    "/v1/workspaces/:workspaceId/invite/regenerate",
    async (request) => regenerateInvite(request)
  );
  app.post(
    "/v1/rooms/:workspaceId/invite/regenerate",
    async (request) => regenerateInvite(request)
  );
};

export default invitesRoutes;
