import { randomBytes, randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createInviteCode(): string {
  return randomBytes(9).toString("base64url");
}
