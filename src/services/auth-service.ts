import { AppEnv } from "../config/env";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import { hashPassword, verifyPassword } from "../core/passwords";
import {
  AccessTokenRecord,
  AuthPrincipal,
  DeviceSession,
  RefreshTokenRecord,
  StoredUser,
  User
} from "../domain/types";
import { MemoryState } from "./memory-state";
import { StateStore } from "./state-store";

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SeedUserInput {
  username: string;
  password: string;
  displayName: string;
  isAdmin?: boolean;
}

interface CreateUserInput {
  username: string;
  password: string;
  displayName?: string;
}

interface SessionBundle {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export class AuthService {
  constructor(
    private readonly state: MemoryState,
    private readonly env: AppEnv,
    private readonly stateStore: StateStore
  ) {}

  async ensureReady(): Promise<void> {
    const changed = this.seedUser({
      username: this.env.devAuthUsername,
      password: this.env.devAuthPassword,
      displayName: this.env.devAuthDisplayName,
      isAdmin: true
    });

    if (changed) {
      await this.stateStore.saveState(this.state);
    }
  }

  async upsertUser(input: SeedUserInput): Promise<User> {
    const changed = this.seedUser(input);
    if (changed) {
      await this.stateStore.saveState(this.state);
    }

    const userId = this.state.usersByUsername.get(input.username);
    if (!userId) {
      throw new Error("Corrupted auth state: missing user after upsert.");
    }

    const user = this.state.users.get(userId);
    if (!user) {
      throw new Error("Corrupted auth state: user index points to missing user.");
    }

    return this.toUser(user);
  }

  async createUser(actor: User, input: CreateUserInput): Promise<User> {
    this.assertAdmin(actor);

    if (this.state.usersByUsername.has(input.username)) {
      throw new AppError(409, "username_taken", "Username is already taken.");
    }

    const now = new Date().toISOString();
    const user: StoredUser = {
      id: createId("usr"),
      username: input.username,
      displayName: input.displayName ?? input.username,
      isAdmin: false,
      passwordHash: hashPassword(input.password),
      createdAt: now
    };

    this.state.users.set(user.id, user);
    this.state.usersByUsername.set(user.username, user.id);
    await this.stateStore.saveState(this.state);
    return this.toUser(user);
  }

  async updateDisplayName(userId: string, displayName: string): Promise<User> {
    const user = this.state.users.get(userId);
    if (!user || user.disabledAt) {
      throw new AppError(404, "user_not_found", "User was not found.");
    }

    if (user.displayName === displayName) {
      return this.toUser(user);
    }

    user.displayName = displayName;
    await this.stateStore.saveState(this.state);
    return this.toUser(user);
  }

  private seedUser(input: SeedUserInput): boolean {
    const existingUserId = this.state.usersByUsername.get(input.username);
    if (existingUserId) {
      const existing = this.state.users.get(existingUserId);
      if (!existing) {
        throw new Error("Corrupted auth state: username index points to missing user.");
      }

      const nextPasswordHash = hashPassword(input.password);
      const changed =
        existing.displayName !== input.displayName ||
        existing.passwordHash !== nextPasswordHash ||
        existing.isAdmin !== Boolean(input.isAdmin);

      existing.displayName = input.displayName;
      existing.passwordHash = nextPasswordHash;
      existing.isAdmin = Boolean(input.isAdmin);
      return changed;
    }

    const now = new Date().toISOString();
    const user: StoredUser = {
      id: createId("usr"),
      username: input.username,
      displayName: input.displayName,
      isAdmin: Boolean(input.isAdmin),
      passwordHash: hashPassword(input.password),
      createdAt: now
    };

    this.state.users.set(user.id, user);
    this.state.usersByUsername.set(user.username, user.id);
    return true;
  }

  async login(username: string, password: string, deviceName: string): Promise<SessionBundle> {
    const userId = this.state.usersByUsername.get(username);
    if (!userId) {
      throw new AppError(401, "invalid_credentials", "Invalid username or password.");
    }

    const user = this.state.users.get(userId);
    if (!user || user.disabledAt) {
      throw new AppError(401, "invalid_credentials", "Invalid username or password.");
    }
    if (!verifyPassword(password, user.passwordHash)) {
      throw new AppError(401, "invalid_credentials", "Invalid username or password.");
    }

    const device = this.createDeviceSession(user.id, deviceName);
    const session = this.issueSession(user, device);
    await this.stateStore.saveState(this.state);
    return session;
  }

  async refresh(refreshToken: string): Promise<SessionBundle> {
    const record = this.state.refreshTokens.get(refreshToken);
    if (!record || this.isExpired(record.expiresAt)) {
      if (record) {
        this.state.refreshTokens.delete(refreshToken);
      }
      throw new AppError(401, "invalid_refresh_token", "Refresh token is invalid or expired.");
    }

    const user = this.state.users.get(record.userId);
    const device = this.state.devices.get(record.deviceId);
    if (!user || !device || user.disabledAt) {
      throw new AppError(401, "invalid_refresh_token", "Refresh token is invalid or expired.");
    }

    this.state.refreshTokens.delete(refreshToken);
    this.revokeAccessTokensForDevice(record.deviceId);
    device.lastSeenAt = new Date().toISOString();

    const session = this.issueSession(user, device);
    await this.stateStore.saveState(this.state);
    return session;
  }

  authenticateAccessToken(token: string): AuthPrincipal {
    const access = this.state.accessTokens.get(token);
    if (!access || this.isExpired(access.expiresAt)) {
      if (access) {
        this.state.accessTokens.delete(token);
      }
      throw new AppError(401, "invalid_access_token", "Access token is invalid or expired.");
    }

    const user = this.state.users.get(access.userId);
    const device = this.state.devices.get(access.deviceId);
    if (!user || !device || user.disabledAt) {
      throw new AppError(401, "invalid_access_token", "Access token is invalid or expired.");
    }

    device.lastSeenAt = new Date().toISOString();
    return {
      user: this.toUser(user),
      device,
      accessToken: access
    };
  }

  private issueSession(user: StoredUser, device: DeviceSession): SessionBundle {
    const accessToken = this.createAccessToken(user.id, device.id);
    const refreshToken = this.createRefreshToken(user.id, device.id);

    this.state.accessTokens.set(accessToken.token, accessToken);
    this.state.refreshTokens.set(refreshToken.token, refreshToken);

    return {
      accessToken: accessToken.token,
      refreshToken: refreshToken.token,
      user: this.toUser(user)
    };
  }

  private createDeviceSession(userId: string, deviceName: string): DeviceSession {
    const now = new Date().toISOString();
    const session: DeviceSession = {
      id: createId("dev"),
      userId,
      deviceName,
      createdAt: now,
      lastSeenAt: now
    };
    this.state.devices.set(session.id, session);
    return session;
  }

  private createAccessToken(userId: string, deviceId: string): AccessTokenRecord {
    return {
      token: createOpaqueToken(),
      userId,
      deviceId,
      expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString()
    };
  }

  private createRefreshToken(userId: string, deviceId: string): RefreshTokenRecord {
    return {
      token: createOpaqueToken(),
      userId,
      deviceId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString()
    };
  }

  private revokeAccessTokensForDevice(deviceId: string): void {
    for (const [token, record] of this.state.accessTokens.entries()) {
      if (record.deviceId === deviceId) {
        this.state.accessTokens.delete(token);
      }
    }
  }

  private isExpired(expiresAt: string): boolean {
    return Date.parse(expiresAt) <= Date.now();
  }

  private assertAdmin(user: User): void {
    if (!user.isAdmin) {
      throw new AppError(403, "forbidden", "Admin access is required.");
    }
  }

  private toUser(user: StoredUser): User {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      isAdmin: user.isAdmin
    };
  }
}
