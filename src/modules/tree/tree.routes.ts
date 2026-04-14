import { FastifyPluginAsync, FastifyReply } from "fastify";

import {
  attachTraceRequestId,
  definedTraceFields,
  logBlobTrace,
  logBlobTraceFailure
} from "../../core/blob-trace";
import { AppError } from "../../core/errors";
import { requireAuth } from "../../core/http-auth";
import {
  asArray,
  asObject,
  ensureNonNegativeInteger,
  optionalInteger,
  optionalString,
  requireEnumValue,
  requireString
} from "../../core/validation";
import {
  OperationPreconditions,
  TreeOperation,
  TreeOperationType,
  WorkspaceEvent
} from "../../domain/types";

const TREE_OPERATION_TYPES = [
  "create_folder",
  "create_markdown",
  "create_binary_placeholder",
  "rename_entry",
  "move_entry",
  "delete_entry",
  "restore_entry",
  "commit_blob_revision"
] as const;

function parseCursor(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    return ensureNonNegativeInteger(value, "cursor");
  }
  if (typeof value === "string" && value.trim() !== "") {
    const cursor = Number.parseInt(value, 10);
    return ensureNonNegativeInteger(cursor, "cursor");
  }

  throw new AppError(400, "invalid_request", 'Field "cursor" must be a non-negative integer.');
}

function parsePreconditions(value: unknown): OperationPreconditions | undefined {
  if (value === undefined) {
    return undefined;
  }

  const body = asObject(value, "Operation preconditions must be an object.");
  const preconditions: OperationPreconditions = {};
  const entryVersion = optionalInteger(body, "entryVersion");
  const path = optionalString(body, "path");

  if (entryVersion !== undefined) {
    preconditions.entryVersion = ensureNonNegativeInteger(entryVersion, "entryVersion");
  }
  if (path !== undefined) {
    preconditions.path = path;
  }

  return Object.keys(preconditions).length === 0 ? undefined : preconditions;
}

function parseOperation(value: unknown): TreeOperation {
  const body = asObject(value, "Each operation must be an object.");
  const operation: TreeOperation = {
    opId: requireString(body, "opId"),
    type: requireEnumValue(
      requireString(body, "type"),
      TREE_OPERATION_TYPES,
      "type"
    ) as TreeOperationType
  };

  const path = optionalString(body, "path");
  const entryId = optionalString(body, "entryId");
  const newPath = optionalString(body, "newPath");
  const hash = optionalString(body, "hash");
  const mimeType = optionalString(body, "mimeType");
  const sizeBytes = optionalInteger(body, "sizeBytes");
  const preconditions = parsePreconditions(body.preconditions);

  if (path !== undefined) {
    operation.path = path;
  }
  if (entryId !== undefined) {
    operation.entryId = entryId;
  }
  if (newPath !== undefined) {
    operation.newPath = newPath;
  }
  if (hash !== undefined) {
    operation.hash = hash;
  }
  if (mimeType !== undefined) {
    operation.mimeType = mimeType;
  }
  if (sizeBytes !== undefined) {
    operation.sizeBytes = ensureNonNegativeInteger(sizeBytes, "sizeBytes");
  }
  if (preconditions !== undefined) {
    operation.preconditions = preconditions;
  }

  return operation;
}

function writeEvent(reply: FastifyReply, event: WorkspaceEvent): void {
  reply.raw.write(`id: ${event.seq}\n`);
  reply.raw.write(`event: ${event.eventType}\n`);
  reply.raw.write(`data: ${JSON.stringify(event.payload)}\n\n`);
}

const treeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/workspaces/:workspaceId/tree", async (request) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    return app.rolay.workspaces.getTree(
      principal.user,
      requireString(params, "workspaceId")
    );
  });

  app.post("/v1/workspaces/:workspaceId/ops/batch", async (request, reply) => {
    attachTraceRequestId(reply, request.id);

    let workspaceId: string | undefined;
    let commitOperations: TreeOperation[] = [];

    try {
      const principal = requireAuth(app, request);
      const params = asObject(request.params, "Expected route params.");
      const body = asObject(request.body);
      const operations = asArray(body.operations, 'Field "operations" must be an array.');
      if (operations.length === 0) {
        throw new AppError(400, "invalid_request", 'Field "operations" must not be empty.');
      }

      workspaceId = requireString(params, "workspaceId");
      const parsedOperations = operations.map((operation) => parseOperation(operation));
      commitOperations = parsedOperations.filter(
        (operation) => operation.type === "commit_blob_revision"
      );

      const results = await app.rolay.workspaces.applyOperations(
        principal.user,
        workspaceId,
        requireString(body, "deviceId"),
        parsedOperations
      );

      if (results.some((result) => result.status === "conflict")) {
        reply.status(409);
      }

      const statusCode = reply.statusCode >= 400 ? reply.statusCode : 200;
      for (const operation of commitOperations) {
        const result = results.find((candidate) => candidate.opId === operation.opId);
        logBlobTrace(request.log, {
          phase: "commit-blob-revision",
          route: "/v1/workspaces/:workspaceId/ops/batch",
          requestId: request.id,
          statusCode,
          ...definedTraceFields({
            workspaceId,
            entryId: operation.entryId,
            hash: operation.hash,
            sizeBytes: operation.sizeBytes,
            storedBlobHash: result?.entry?.blob?.hash,
            operationStatus: result?.status,
            opId: operation.opId
          })
        });
      }

      return {
        results
      };
    } catch (error) {
      for (const operation of commitOperations) {
        logBlobTraceFailure(
          request.log,
          {
            phase: "commit-blob-revision",
            route: "/v1/workspaces/:workspaceId/ops/batch",
            requestId: request.id,
            ...definedTraceFields({
              workspaceId,
              entryId: operation.entryId,
              hash: operation.hash,
              sizeBytes: operation.sizeBytes,
              opId: operation.opId
            })
          },
          error
        );
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/events", async (request, reply) => {
    const principal = requireAuth(app, request);
    const params = asObject(request.params, "Expected route params.");
    const query = asObject(request.query ?? {});
    const workspaceId = requireString(params, "workspaceId");
    const cursor = parseCursor(query.cursor);

    let lastSentSeq = cursor;
    const sendEvent = (event: WorkspaceEvent): void => {
      if (event.seq <= lastSentSeq) {
        return;
      }
      lastSentSeq = event.seq;
      writeEvent(reply, event);
    };

    const stream = app.rolay.workspaces.openEventStream(
      principal.user,
      workspaceId,
      cursor,
      sendEvent
    );

    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.write(": connected\n\n");

    for (const event of stream.initialEvents) {
      sendEvent(event);
    }

    const keepAlive = setInterval(() => {
      reply.raw.write(": keepalive\n\n");
    }, 15_000);

    let closed = false;
    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(keepAlive);
      stream.unsubscribe();
    };

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);

    return reply;
  });
};

export default treeRoutes;
