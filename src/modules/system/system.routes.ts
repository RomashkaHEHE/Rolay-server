import { FastifyPluginAsync } from "fastify";

const systemRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ready", async () => ({
    ok: true,
    service: "rolay-server"
  }));
};

export default systemRoutes;
