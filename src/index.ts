import { buildApp } from "./app";
import { readEnv } from "./config/env";

async function main(): Promise<void> {
  const env = readEnv();
  const app = await buildApp({
    env,
    logger: {
      level: env.logLevel
    }
  });

  try {
    await app.listen({
      host: env.host,
      port: env.port
    });
  } catch (error) {
    app.log.error({ err: error }, "Failed to start Rolay server");
    process.exitCode = 1;
  }
}

void main();
