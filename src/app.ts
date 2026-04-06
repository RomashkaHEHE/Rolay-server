import Fastify, {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions
} from "fastify";

import { AppEnv, readEnv } from "./config/env";
import { createRolayContext } from "./core/context";
import { isAppError } from "./core/errors";
import adminRoutes from "./modules/admin/admin.routes";
import authRoutes from "./modules/auth/auth.routes";
import filesRoutes from "./modules/files/files.routes";
import invitesRoutes from "./modules/invites/invites.routes";
import rootRoutes from "./modules/root/root.routes";
import settingsEventsRoutes from "./modules/settings-events/settings-events.routes";
import storageRoutes from "./modules/storage/storage.routes";
import systemRoutes from "./modules/system/system.routes";
import treeRoutes from "./modules/tree/tree.routes";
import workspacesRoutes from "./modules/workspaces/workspaces.routes";
import { RealtimeService } from "./services/realtime-service";

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      if (isAppError(error)) {
        reply.status(error.statusCode).send(error.toPayload());
        return;
      }

      requestLog(app, error);
      reply.status(500).send({
        error: {
          code: "internal_error",
          message: "Unexpected server error"
        }
      });
    }
  );
}

function requestLog(app: FastifyInstance, error: FastifyError): void {
  app.log.error(
    {
      err: error
    },
    "Unhandled application error"
  );
}

export async function buildApp(
  options: FastifyServerOptions & { env?: AppEnv } = {}
): Promise<FastifyInstance> {
  const { env: providedEnv, ...fastifyOptions } = options;
  const env = providedEnv ?? readEnv();
  const app = Fastify({
    logger: fastifyOptions.logger ?? { level: env.logLevel },
    ...fastifyOptions
  });

  app.decorate("rolay", await createRolayContext(env));
  const realtime = new RealtimeService(app.rolay.state, app.rolay.storage, env, app.log);

  app.addHook("onReady", async () => {
    await app.rolay.storage.ensureReady();
    await realtime.attach(app.server);
  });
  app.addHook("onClose", async () => {
    await realtime.close(app.server);
    await app.rolay.stateStore.close();
  });
  registerErrorHandler(app);

  await app.register(rootRoutes);
  await app.register(systemRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(invitesRoutes);
  await app.register(settingsEventsRoutes);
  await app.register(workspacesRoutes);
  await app.register(treeRoutes);
  await app.register(filesRoutes);
  await app.register(storageRoutes);

  await app.ready();
  return app;
}
