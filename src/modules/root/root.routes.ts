import { FastifyPluginAsync } from "fastify";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const publicWebRoot = path.resolve(process.cwd(), "public-web", "dist");
const fallbackHtml = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rolay Public Notes</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #10130f; color: #f3f0df; font: 16px system-ui, sans-serif; }
      main { max-width: 560px; padding: 32px; text-align: center; }
      code { color: #9fd18b; }
    </style>
  </head>
  <body>
    <main>
      <h1>Rolay Public Notes</h1>
      <p>Public web assets are not built yet. Run <code>npm run build:web</code> or use the production Docker image.</p>
    </main>
  </body>
</html>`;

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

const rootRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (_request, reply) => {
    const indexPath = path.join(publicWebRoot, "index.html");
    reply.header("Cache-Control", "no-cache");
    reply.type("text/html; charset=utf-8");
    if (await fileExists(indexPath)) {
      return reply.send(createReadStream(indexPath));
    }

    return reply.send(fallbackHtml);
  });

  app.get("/assets/*", async (request, reply) => {
    const params = request.params as { "*": string };
    const requestedPath = params["*"] ?? "";
    const assetPath = path.resolve(publicWebRoot, "assets", requestedPath);
    const assetsRoot = path.resolve(publicWebRoot, "assets");
    if (!assetPath.startsWith(`${assetsRoot}${path.sep}`) || !(await fileExists(assetPath))) {
      reply.status(404);
      return {
        error: {
          code: "not_found",
          message: "Asset not found."
        }
      };
    }

    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type(contentTypeFor(assetPath));
    return reply.send(createReadStream(assetPath));
  });
};

export default rootRoutes;
