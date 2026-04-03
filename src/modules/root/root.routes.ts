import { FastifyPluginAsync } from "fastify";

const rootRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async () => ({
    service: "rolay-server",
    status: "bootstrapped",
    documents: {
      architecture: "docs/architecture.md",
      protocol: "docs/protocol.md",
      conflictResolution: "docs/conflict-resolution.md",
      deploy: "docs/deploy.md",
      openapi: "openapi.yaml"
    }
  }));
};

export default rootRoutes;
