import { FastifyPluginAsync } from "fastify";

import { requireAuth } from "../../core/http-auth";
import { asObject, requireString } from "../../core/validation";

const drawingsRoutes: FastifyPluginAsync = async (app) => {
  app.post("/v1/drawings/:entryId/lease/acquire", async (request) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");

    return app.rolay.drawings.acquireLease(
      principal,
      requireString(params, "entryId")
    );
  });

  app.post("/v1/drawings/:entryId/lease/release", async (request) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");

    return app.rolay.drawings.releaseLease(
      principal,
      requireString(params, "entryId")
    );
  });

  app.post("/v1/drawings/:entryId/control-requests", async (request, reply) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    const result = await app.rolay.drawings.requestControl(
      principal,
      requireString(params, "entryId")
    );

    reply.status(201);
    return result;
  });

  app.post("/v1/drawings/:entryId/control-requests/:requestId/approve", async (request) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");

    return app.rolay.drawings.approveControlRequest(
      principal,
      requireString(params, "entryId"),
      requireString(params, "requestId")
    );
  });

  app.post("/v1/drawings/:entryId/control-requests/:requestId/deny", async (request) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");

    return app.rolay.drawings.denyControlRequest(
      principal,
      requireString(params, "entryId"),
      requireString(params, "requestId")
    );
  });
};

export default drawingsRoutes;
