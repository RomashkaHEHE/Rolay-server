import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Client as MinioClient, type ClientOptions as MinioClientOptions } from "minio";

import { AppEnv } from "../config/env";
import { AppError } from "../core/errors";
import { BlobObject } from "../domain/types";

interface StoredBlobMetadata {
  hash: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
}

interface StorageBackend {
  ensureReady(): Promise<void>;
  loadDocument(docId: string): Promise<Uint8Array | null>;
  storeDocument(docId: string, state: Uint8Array): Promise<void>;
  hasBlob(hash: string): Promise<boolean>;
  storeBlob(hash: string, payload: Buffer, mimeType: string): Promise<BlobObject>;
  storeBlobFromFile(
    hash: string,
    filePath: string,
    mimeType: string,
    sizeBytes: number
  ): Promise<BlobObject>;
  loadBlob(hash: string): Promise<{ metadata: BlobObject; payload: Buffer } | null>;
  loadBlobStream(hash: string): Promise<{ metadata: BlobObject; stream: Readable } | null>;
}

interface ActiveUploadRecord {
  ticketId: string;
  stagingPath: string;
  controller: AbortController;
}

function hashDigest(hash: string): string {
  return hash.replace(/^sha256:/, "").replace(/[^A-Za-z0-9_-]/g, "_");
}

function verifyBlobHash(hash: string, payload: Buffer): void {
  const digest = createHash("sha256").update(payload).digest("base64");
  const normalizedHash = `sha256:${digest}`;
  if (normalizedHash !== hash) {
    throw new Error(`Blob hash mismatch: expected ${hash}, got ${normalizedHash}`);
  }
}

function buildBlobMetadata(hash: string, payload: Buffer, mimeType: string): StoredBlobMetadata {
  verifyBlobHash(hash, payload);
  return {
    hash,
    sizeBytes: payload.byteLength,
    mimeType,
    createdAt: new Date().toISOString()
  };
}

function buildVerifiedBlobMetadata(
  hash: string,
  sizeBytes: number,
  mimeType: string
): StoredBlobMetadata {
  return {
    hash,
    sizeBytes,
    mimeType,
    createdAt: new Date().toISOString()
  };
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const statusCode =
    "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;

  return (
    code === "ENOENT" ||
    code === "NoSuchKey" ||
    code === "NotFound" ||
    code === "NoSuchBucket" ||
    statusCode === 404
  );
}

function isAbortLikeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const name = "name" in error ? (error as { name?: unknown }).name : undefined;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;

  return (
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    code === "ECONNRESET" ||
    code === "ERR_STREAM_PREMATURE_CLOSE"
  );
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
      continue;
    }

    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

class LocalStorageBackend implements StorageBackend {
  private readonly rootDir: string;
  private readonly documentsDir: string;
  private readonly blobsDir: string;
  private readyPromise: Promise<void> | undefined;

  constructor(env: AppEnv) {
    this.rootDir = path.resolve(env.localDataDir);
    this.documentsDir = path.join(this.rootDir, "documents");
    this.blobsDir = path.join(this.rootDir, "blobs");
  }

  async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = Promise.all([
        fs.mkdir(this.documentsDir, { recursive: true }),
        fs.mkdir(this.blobsDir, { recursive: true })
      ]).then(() => undefined);
    }

    await this.readyPromise;
  }

  async loadDocument(docId: string): Promise<Uint8Array | null> {
    await this.ensureReady();

    try {
      return await fs.readFile(this.documentPath(docId));
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async storeDocument(docId: string, state: Uint8Array): Promise<void> {
    await this.ensureReady();
    await fs.writeFile(this.documentPath(docId), state);
  }

  async hasBlob(hash: string): Promise<boolean> {
    await this.ensureReady();

    try {
      await fs.access(this.blobBinaryPath(hash));
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async storeBlob(hash: string, payload: Buffer, mimeType: string): Promise<BlobObject> {
    await this.ensureReady();
    const metadata = buildBlobMetadata(hash, payload, mimeType);

    await fs.mkdir(path.dirname(this.blobBinaryPath(hash)), { recursive: true });
    await fs.writeFile(this.blobBinaryPath(hash), payload);
    await fs.writeFile(this.blobMetadataPath(hash), JSON.stringify(metadata, null, 2));

    return metadata;
  }

  async storeBlobFromFile(
    hash: string,
    filePath: string,
    mimeType: string,
    sizeBytes: number
  ): Promise<BlobObject> {
    await this.ensureReady();
    const metadata = buildVerifiedBlobMetadata(hash, sizeBytes, mimeType);

    await fs.mkdir(path.dirname(this.blobBinaryPath(hash)), { recursive: true });
    await fs.rm(this.blobBinaryPath(hash), { force: true });
    await fs.rename(filePath, this.blobBinaryPath(hash));
    await fs.writeFile(this.blobMetadataPath(hash), JSON.stringify(metadata, null, 2));

    return metadata;
  }

  async loadBlob(hash: string): Promise<{ metadata: BlobObject; payload: Buffer } | null> {
    await this.ensureReady();

    try {
      const [payload, metadataRaw] = await Promise.all([
        fs.readFile(this.blobBinaryPath(hash)),
        fs.readFile(this.blobMetadataPath(hash), "utf8")
      ]);

      return {
        payload,
        metadata: JSON.parse(metadataRaw) as BlobObject
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async loadBlobStream(hash: string): Promise<{ metadata: BlobObject; stream: Readable } | null> {
    await this.ensureReady();

    try {
      const metadataRaw = await fs.readFile(this.blobMetadataPath(hash), "utf8");
      return {
        metadata: JSON.parse(metadataRaw) as BlobObject,
        stream: createReadStream(this.blobBinaryPath(hash))
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private documentPath(docId: string): string {
    return path.join(this.documentsDir, `${docId}.bin`);
  }

  private blobBinaryPath(hash: string): string {
    const digest = hashDigest(hash);
    return path.join(this.blobsDir, digest.slice(0, 2), `${digest}.bin`);
  }

  private blobMetadataPath(hash: string): string {
    const digest = hashDigest(hash);
    return path.join(this.blobsDir, digest.slice(0, 2), `${digest}.json`);
  }
}

class MinioStorageBackend implements StorageBackend {
  private readonly client: MinioClient;
  private readonly bucket: string;
  private readonly region: string | undefined;
  private readonly prefix: string;
  private readyPromise: Promise<void> | undefined;

  constructor(env: AppEnv) {
    const clientOptions: MinioClientOptions = {
      endPoint: env.minioEndpoint,
      port: env.minioPort,
      useSSL: env.minioUseSSL,
      accessKey: env.minioAccessKey,
      secretKey: env.minioSecretKey
    };
    if (env.minioRegion) {
      clientOptions.region = env.minioRegion;
    }

    this.client = new MinioClient(clientOptions);
    this.bucket = env.minioBucket;
    this.region = env.minioRegion;
    this.prefix = env.minioPrefix;
  }

  async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.initialize();
    }

    await this.readyPromise;
  }

  async loadDocument(docId: string): Promise<Uint8Array | null> {
    await this.ensureReady();
    return this.getObjectBuffer(this.documentObjectName(docId));
  }

  async storeDocument(docId: string, state: Uint8Array): Promise<void> {
    await this.ensureReady();
    const payload = Buffer.from(state);
    await this.client.putObject(
      this.bucket,
      this.documentObjectName(docId),
      payload,
      payload.byteLength,
      {
        "Content-Type": "application/octet-stream"
      }
    );
  }

  async hasBlob(hash: string): Promise<boolean> {
    await this.ensureReady();

    try {
      await this.client.statObject(this.bucket, this.blobBinaryObjectName(hash));
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async storeBlob(hash: string, payload: Buffer, mimeType: string): Promise<BlobObject> {
    await this.ensureReady();
    const metadata = buildBlobMetadata(hash, payload, mimeType);
    const metadataPayload = Buffer.from(JSON.stringify(metadata, null, 2));

    await Promise.all([
      this.client.putObject(
        this.bucket,
        this.blobBinaryObjectName(hash),
        payload,
        payload.byteLength,
        {
          "Content-Type": mimeType
        }
      ),
      this.client.putObject(
        this.bucket,
        this.blobMetadataObjectName(hash),
        metadataPayload,
        metadataPayload.byteLength,
        {
          "Content-Type": "application/json"
        }
      )
    ]);

    return metadata;
  }

  async storeBlobFromFile(
    hash: string,
    filePath: string,
    mimeType: string,
    sizeBytes: number
  ): Promise<BlobObject> {
    await this.ensureReady();
    const metadata = buildVerifiedBlobMetadata(hash, sizeBytes, mimeType);
    const metadataPayload = Buffer.from(JSON.stringify(metadata, null, 2));

    await Promise.all([
      this.client.putObject(
        this.bucket,
        this.blobBinaryObjectName(hash),
        createReadStream(filePath),
        sizeBytes,
        {
          "Content-Type": mimeType
        }
      ),
      this.client.putObject(
        this.bucket,
        this.blobMetadataObjectName(hash),
        metadataPayload,
        metadataPayload.byteLength,
        {
          "Content-Type": "application/json"
        }
      )
    ]);

    return metadata;
  }

  async loadBlob(hash: string): Promise<{ metadata: BlobObject; payload: Buffer } | null> {
    await this.ensureReady();

    const [payload, metadataRaw] = await Promise.all([
      this.getObjectBuffer(this.blobBinaryObjectName(hash)),
      this.getObjectBuffer(this.blobMetadataObjectName(hash))
    ]);

    if (!payload || !metadataRaw) {
      return null;
    }

    return {
      payload,
      metadata: JSON.parse(metadataRaw.toString("utf8")) as BlobObject
    };
  }

  async loadBlobStream(hash: string): Promise<{ metadata: BlobObject; stream: Readable } | null> {
    await this.ensureReady();

    const metadataRaw = await this.getObjectBuffer(this.blobMetadataObjectName(hash));
    if (!metadataRaw) {
      return null;
    }

    try {
      const stream = await this.client.getObject(this.bucket, this.blobBinaryObjectName(hash));
      return {
        metadata: JSON.parse(metadataRaw.toString("utf8")) as BlobObject,
        stream
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (exists) {
      return;
    }

    if (this.region) {
      await this.client.makeBucket(this.bucket, this.region);
      return;
    }

    await this.client.makeBucket(this.bucket);
  }

  private async getObjectBuffer(objectName: string): Promise<Buffer | null> {
    try {
      const stream = await this.client.getObject(this.bucket, objectName);
      return await streamToBuffer(stream);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private documentObjectName(docId: string): string {
    return this.objectName("documents", `${docId}.bin`);
  }

  private blobBinaryObjectName(hash: string): string {
    const digest = hashDigest(hash);
    return this.objectName("blobs", digest.slice(0, 2), `${digest}.bin`);
  }

  private blobMetadataObjectName(hash: string): string {
    const digest = hashDigest(hash);
    return this.objectName("blobs", digest.slice(0, 2), `${digest}.json`);
  }

  private objectName(...segments: string[]): string {
    return [this.prefix, ...segments].filter((segment) => segment.length > 0).join("/");
  }
}

export class StorageService {
  private readonly backend: StorageBackend;
  private readonly uploadsDir: string;
  private readonly activeUploads = new Map<string, ActiveUploadRecord>();
  private readyPromise: Promise<void> | undefined;

  constructor(env: AppEnv) {
    this.backend =
      env.storageDriver === "minio"
        ? new MinioStorageBackend(env)
        : new LocalStorageBackend(env);
    this.uploadsDir = path.resolve(env.localDataDir, "uploads");
  }

  async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        await this.backend.ensureReady();
        await fs.mkdir(this.uploadsDir, { recursive: true });
        await this.cleanupStagingDirectory();
      })();
    }

    await this.readyPromise;
  }

  async loadDocument(docId: string): Promise<Uint8Array | null> {
    return this.backend.loadDocument(docId);
  }

  async storeDocument(docId: string, state: Uint8Array): Promise<void> {
    await this.backend.storeDocument(docId, state);
  }

  async hasBlob(hash: string): Promise<boolean> {
    return this.backend.hasBlob(hash);
  }

  async storeBlob(hash: string, payload: Buffer, mimeType: string): Promise<BlobObject> {
    return this.backend.storeBlob(hash, payload, mimeType);
  }

  async storeBlobUpload(
    uploadId: string,
    hash: string,
    payload: Readable,
    mimeType: string,
    sizeBytes: number
  ): Promise<BlobObject> {
    await this.ensureReady();

    const stagingPath = path.join(this.uploadsDir, `${uploadId}.part`);
    await fs.rm(stagingPath, { force: true });

    // Binary uploads are staged first and only become visible after commit_blob_revision updates
    // the room tree. Other users should never observe partial file content.
    const controller = new AbortController();
    this.activeUploads.set(uploadId, {
      ticketId: uploadId,
      stagingPath,
      controller
    });

    let receivedBytes = 0;
    const digest = createHash("sha256");
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.byteLength;
        if (receivedBytes > sizeBytes) {
          callback(
            new AppError(400, "payload_too_large", "Blob size does not match upload ticket.")
          );
          return;
        }

        digest.update(buffer);
        callback(null, buffer);
      }
    });

    try {
      await pipeline(payload, counter, createWriteStream(stagingPath), {
        signal: controller.signal
      });

      if (receivedBytes !== sizeBytes) {
        throw new AppError(
          400,
          "payload_too_large",
          "Blob size does not match upload ticket.",
          {
            expectedSizeBytes: sizeBytes,
            receivedSizeBytes: receivedBytes
          }
        );
      }

      const calculatedHash = `sha256:${digest.digest("base64")}`;
      if (calculatedHash !== hash) {
        throw new AppError(
          400,
          "blob_hash_mismatch",
          "Uploaded blob hash does not match ticket.",
          {
            expectedHash: hash,
            actualHash: calculatedHash,
            receivedSizeBytes: receivedBytes
          }
        );
      }

      return await this.backend.storeBlobFromFile(hash, stagingPath, mimeType, sizeBytes);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new AppError(409, "upload_canceled", "Upload was canceled.");
      }
      if (isAbortLikeError(error)) {
        throw new AppError(400, "upload_incomplete", "Upload did not complete.");
      }
      throw error;
    } finally {
      this.activeUploads.delete(uploadId);
      await fs.rm(stagingPath, { force: true });
    }
  }

  async cancelActiveUpload(uploadId: string): Promise<boolean> {
    const activeUpload = this.activeUploads.get(uploadId);
    if (!activeUpload) {
      return false;
    }

    // Abort the streaming pipeline and let the caller remove the logical upload ticket from app
    // state. Both pieces are needed for a clean cancel.
    activeUpload.controller.abort();
    await fs.rm(activeUpload.stagingPath, { force: true });
    return true;
  }

  async loadBlob(hash: string): Promise<{ metadata: BlobObject; payload: Buffer } | null> {
    return this.backend.loadBlob(hash);
  }

  async loadBlobStream(hash: string): Promise<{ metadata: BlobObject; stream: Readable } | null> {
    return this.backend.loadBlobStream(hash);
  }

  private async cleanupStagingDirectory(): Promise<void> {
    const entries = await fs.readdir(this.uploadsDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".part"))
        .map((entry) => fs.rm(path.join(this.uploadsDir, entry.name), { force: true }))
    );
  }
}
