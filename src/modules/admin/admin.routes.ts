import { FastifyPluginAsync } from "fastify";

import { requireAdmin } from "../../core/http-auth";
import {
  asObject,
  optionalString,
  requireEnumValue,
  requireString
} from "../../core/validation";
import { GlobalRole, WorkspaceRole } from "../../domain/types";

const MANAGED_USER_ROLES = ["writer", "reader"] as const;
const WORKSPACE_MEMBER_ROLES = ["owner", "member"] as const;

const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/admin/users", async (request) => {
    const principal = requireAdmin(app, request);
    return {
      users: app.rolay.auth.listUsers(principal.user)
    };
  });

  app.post("/v1/admin/users", async (request, reply) => {
    const principal = requireAdmin(app, request);
    const body = asObject(request.body);
    const displayName = optionalString(body, "displayName");
    const globalRole = requireEnumValue(
      optionalString(body, "globalRole") ?? "reader",
      MANAGED_USER_ROLES,
      "globalRole"
    ) as GlobalRole;

    const user = await app.rolay.auth.createUser(principal.user, {
      username: requireString(body, "username"),
      password: requireString(body, "password"),
      globalRole,
      ...(displayName !== undefined ? { displayName } : {})
    });

    reply.status(201);
    return {
      user
    };
  });

  app.delete("/v1/admin/users/:userId", async (request) => {
    const principal = requireAdmin(app, request);
    const params = asObject(request.params, "Expected route params.");
    const user = await app.rolay.auth.deleteUser(
      principal.user,
      requireString(params, "userId")
    );

    return {
      user
    };
  });

  app.get("/v1/admin/workspaces", async (request) => {
    const principal = requireAdmin(app, request);
    return {
      workspaces: app.rolay.workspaces.listAllWorkspaces(principal.user)
    };
  });

  app.get("/v1/admin/workspaces/:workspaceId/members", async (request) => {
    const principal = requireAdmin(app, request);
    const params = asObject(request.params, "Expected route params.");
    return {
      members: app.rolay.workspaces.getWorkspaceMembers(
        principal.user,
        requireString(params, "workspaceId")
      )
    };
  });

  app.post("/v1/admin/workspaces/:workspaceId/members", async (request) => {
    const principal = requireAdmin(app, request);
    const params = asObject(request.params, "Expected route params.");
    const body = asObject(request.body);
    const role = requireEnumValue(
      optionalString(body, "role") ?? "member",
      WORKSPACE_MEMBER_ROLES,
      "role"
    ) as WorkspaceRole;

    const result = await app.rolay.workspaces.addMemberByUsername(
      principal.user,
      requireString(params, "workspaceId"),
      requireString(body, "username"),
      role
    );

    return result;
  });

  app.delete("/v1/admin/workspaces/:workspaceId", async (request) => {
    const principal = requireAdmin(app, request);
    const params = asObject(request.params, "Expected route params.");
    const workspace = await app.rolay.workspaces.deleteWorkspace(
      principal.user,
      requireString(params, "workspaceId")
    );

    return {
      workspace
    };
  });
};

export default adminRoutes;
