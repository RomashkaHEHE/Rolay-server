import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { Client as MinioClient, type ClientOptions as MinioClientOptions } from "minio";

import { AppEnv } from "../config/env";
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
  loadBlob(hash: string): Promise<{ metadata: BlobObject; payload: Buffer } | null>;
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

  constructor(env: AppEnv) {
    this.backend =
      env.storageDriver === "minio"
        ? new MinioStorageBackend(env)
        : new LocalStorageBackend(env);
  }

  async ensureReady(): Promise<void> {
    await this.backend.ensureReady();
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

  async loadBlob(hash: string): Promise<{ metadata: BlobObject; payload: Buffer } | null> {
    return this.backend.loadBlob(hash);
  }
}
