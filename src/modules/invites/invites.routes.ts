import { FastifyPluginAsync } from "fastify";

import { requireAuth } from "../../core/http-auth";
import {
  asObject,
  ensureDateTimeString,
  ensurePositiveInteger,
  optionalInteger,
  optionalString,
  requireEnumValue,
  requireString
} from "../../core/validation";
import { InviteRole } from "../../domain/types";

const INVITE_ROLES = ["editor", "viewer"] as const;

const invitesRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/invites/accept", async (request) => {
    const principal = requireAuth(app, request);
    const body = asObject(request.body);
    const workspace = await app.rolay.workspaces.acceptInvite(
      principal.user,
      requireString(body, "code")
    );

    return {
      workspace
    };
  });

  app.post("/v1/workspaces/:workspaceId/invites", async (request, reply) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    const body = asObject(request.body);
    const role = requireEnumValue(
      optionalString(body, "role") ?? "editor",
      INVITE_ROLES,
      "role"
    );
    const expiresAt = optionalString(body, "expiresAt");
    const maxUses = optionalInteger(body, "maxUses");

    if (expiresAt !== undefined) {
      ensureDateTimeString(expiresAt, "expiresAt");
    }
    if (maxUses !== undefined) {
      ensurePositiveInteger(maxUses, "maxUses");
    }

    const invite = await app.rolay.workspaces.createInvite(
      principal.user,
      requireString(params, "workspaceId"),
      role as InviteRole,
      expiresAt,
      maxUses
    );

    reply.status(201);
    return {
      invite
    };
  });
};

export default invitesRoutes;
