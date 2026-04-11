import { cloneValue } from "../core/clone";
import { AppEnv } from "../config/env";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import { hashPassword, verifyPassword } from "../core/passwords";
import {
  AccessTokenRecord,
  AuthPrincipal,
  DeviceSession,
  GlobalRole,
  RefreshTokenRecord,
  StoredUser,
  User,
  WorkspaceEvent
} from "../domain/types";
import { MemoryState, StoredWorkspace } from "./memory-state";
import { SettingsEventsService } from "./settings-events-service";
import { StateStore } from "./state-store";

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SeedUserInput {
  username: string;
  password: string;
  displayName: string;
  globalRole?: GlobalRole;
  isAdmin?: boolean;
}

interface CreateUserInput {
  username: string;
  password: string;
  displayName?: string;
  globalRole?: GlobalRole;
}

interface ManagedUserRecord extends User {
  createdAt: string;
  disabledAt?: string;
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
    private readonly stateStore: StateStore,
    private readonly settingsEvents: SettingsEventsService
  ) {}

  async ensureReady(): Promise<void> {
    const changed = this.seedUser({
      username: this.env.devAuthUsername,
      password: this.env.devAuthPassword,
      displayName: this.env.devAuthDisplayName,
      globalRole: "admin",
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

    const globalRole = this.normalizeManagedUserRole(input.globalRole);
    const now = new Date().toISOString();
    const user: StoredUser = {
      id: createId("usr"),
      username: input.username,
      displayName: input.displayName ?? input.username,
      isAdmin: false,
      globalRole,
      passwordHash: hashPassword(input.password),
      createdAt: now
    };

    this.state.users.set(user.id, user);
    this.state.usersByUsername.set(user.username, user.id);
    await this.stateStore.saveState(this.state);
    this.settingsEvents.publishAdminUserCreated(user.id);
    return this.toUser(user);
  }

  listUsers(actor: User): ManagedUserRecord[] {
    this.assertAdmin(actor);
    return [...this.state.users.values()]
      .map((user) => this.toManagedUser(user))
      .sort((left, right) => left.username.localeCompare(right.username));
  }

  async deleteUser(actor: User, userId: string): Promise<ManagedUserRecord> {
    this.assertAdmin(actor);
    const user = this.state.users.get(userId);
    if (!user || user.disabledAt) {
      throw new AppError(404, "user_not_found", "User was not found.");
    }
    if (user.isAdmin) {
      throw new AppError(
        400,
        "cannot_delete_admin_user",
        "Deleting admin users is not supported."
      );
    }

    this.settingsEvents.publishAdminUserDeleted(user);
    this.revokeAllSessionsForUser(userId);
    this.dropEphemeralUserTickets(userId);
    this.removeUserFromWorkspaces(userId);
    this.state.users.delete(userId);
    this.state.usersByUsername.delete(user.username);
    await this.stateStore.saveState(this.state);
    return this.toManagedUser(user);
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
    this.settingsEvents.publishAuthMeUpdated(userId);
    this.settingsEvents.publishAdminUserUpdated(userId);
    return this.toUser(user);
  }

  async changePassword(
    principal: AuthPrincipal,
    currentPassword: string,
    newPassword: string
  ): Promise<SessionBundle> {
    const user = this.state.users.get(principal.user.id);
    if (!user || user.disabledAt) {
      throw new AppError(404, "user_not_found", "User was not found.");
    }
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      throw new AppError(401, "invalid_current_password", "Current password is incorrect.");
    }

    const nextPasswordHash = hashPassword(newPassword);
    if (nextPasswordHash === user.passwordHash) {
      throw new AppError(
        400,
        "password_unchanged",
        "New password must be different from the current password."
      );
    }

    user.passwordHash = nextPasswordHash;
    this.revokeAllSessionsForUser(user.id);

    const device = this.createDeviceSession(user.id, principal.device.deviceName);
    const session = this.issueSession(user, device);
    await this.stateStore.saveState(this.state);
    return session;
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

  private seedUser(input: SeedUserInput): boolean {
    const normalizedRole = this.normalizeSeedRole(input);
    const normalizedIsAdmin = normalizedRole === "admin" || Boolean(input.isAdmin);
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
        existing.isAdmin !== normalizedIsAdmin ||
        existing.globalRole !== normalizedRole;

      existing.displayName = input.displayName;
      existing.passwordHash = nextPasswordHash;
      existing.isAdmin = normalizedIsAdmin;
      existing.globalRole = normalizedRole;
      return changed;
    }

    const now = new Date().toISOString();
    const user: StoredUser = {
      id: createId("usr"),
      username: input.username,
      displayName: input.displayName,
      isAdmin: normalizedIsAdmin,
      globalRole: normalizedRole,
      passwordHash: hashPassword(input.password),
      createdAt: now
    };

    this.state.users.set(user.id, user);
    this.state.usersByUsername.set(user.username, user.id);
    return true;
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

  private revokeAllSessionsForUser(userId: string): void {
    const deviceIds = new Set<string>();

    for (const [deviceId, device] of this.state.devices.entries()) {
      if (device.userId === userId) {
        deviceIds.add(deviceId);
        this.state.devices.delete(deviceId);
      }
    }

    for (const [token, record] of this.state.accessTokens.entries()) {
      if (record.userId === userId || deviceIds.has(record.deviceId)) {
        this.state.accessTokens.delete(token);
      }
    }

    for (const [token, record] of this.state.refreshTokens.entries()) {
      if (record.userId === userId || deviceIds.has(record.deviceId)) {
        this.state.refreshTokens.delete(token);
      }
    }
  }

  private dropEphemeralUserTickets(userId: string): void {
    for (const [token, record] of this.state.crdtTokens.entries()) {
      if (record.userId === userId) {
        this.state.crdtTokens.delete(token);
      }
    }

    for (const [ticketId, record] of this.state.blobUploadTickets.entries()) {
      if (record.userId === userId) {
        this.state.blobUploadTickets.delete(ticketId);
      }
    }

    for (const [ticketId, record] of this.state.blobDownloadTickets.entries()) {
      if (record.userId === userId) {
        this.state.blobDownloadTickets.delete(ticketId);
      }
    }
  }

  private removeUserFromWorkspaces(userId: string): void {
    for (const [workspaceId, workspace] of [...this.state.workspaces.entries()]) {
      const membership = workspace.memberships.get(userId);
      if (!membership) {
        continue;
      }

      workspace.memberships.delete(userId);
      this.publishWorkspaceEvent(workspace, "workspace.member.left", {
        userId
      });
      this.settingsEvents.publishRoomUpdated(workspaceId);
      this.settingsEvents.publishRoomMembersUpdated(workspaceId);
      this.settingsEvents.publishAdminRoomMembersUpdated(workspaceId);

      if (workspace.memberships.size === 0) {
        this.settingsEvents.publishRoomDeleted(workspace);
        this.dropWorkspaceState(workspaceId);
        continue;
      }

      if (membership.role === "owner" && !this.hasOwner(workspace)) {
        const promotedMember = [...workspace.memberships.values()].sort((left, right) =>
          left.joinedAt.localeCompare(right.joinedAt)
        )[0];

        if (promotedMember) {
          promotedMember.role = "owner";
          this.publishWorkspaceEvent(workspace, "workspace.member.role_updated", {
            userId: promotedMember.userId,
            role: promotedMember.role
          });
          this.settingsEvents.publishRoomMembershipChanged(
            workspaceId,
            promotedMember.userId,
            promotedMember.role
          );
          this.settingsEvents.publishRoomMembersUpdated(workspaceId);
        }
      }
    }
  }

  private dropWorkspaceState(workspaceId: string): void {
    this.state.workspaces.delete(workspaceId);

    for (const [token, record] of this.state.crdtTokens.entries()) {
      if (record.workspaceId === workspaceId) {
        this.state.crdtTokens.delete(token);
      }
    }

    for (const [ticketId, record] of this.state.blobUploadTickets.entries()) {
      if (record.workspaceId === workspaceId) {
        this.state.blobUploadTickets.delete(ticketId);
      }
    }

    for (const [ticketId, record] of this.state.blobDownloadTickets.entries()) {
      if (record.workspaceId === workspaceId) {
        this.state.blobDownloadTickets.delete(ticketId);
      }
    }
  }

  private hasOwner(workspace: StoredWorkspace): boolean {
    return [...workspace.memberships.values()].some((membership) => membership.role === "owner");
  }

  private publishWorkspaceEvent(
    workspace: StoredWorkspace,
    eventType: string,
    payload: Record<string, unknown>
  ): void {
    const event: WorkspaceEvent = {
      seq: workspace.nextEventSeq,
      eventType,
      payload,
      createdAt: new Date().toISOString()
    };

    workspace.nextEventSeq += 1;
    workspace.events.push(event);
    for (const listener of workspace.listeners) {
      listener(cloneValue(event));
    }
  }

  private normalizeSeedRole(input: SeedUserInput): GlobalRole {
    if (input.isAdmin || input.globalRole === "admin") {
      return "admin";
    }

    return input.globalRole ?? "reader";
  }

  private normalizeManagedUserRole(role: GlobalRole | undefined): GlobalRole {
    if (!role) {
      return "reader";
    }
    if (role === "admin") {
      throw new AppError(
        400,
        "invalid_role",
        "Creating additional admin users is not supported."
      );
    }

    return role;
  }

  private isExpired(expiresAt: string): boolean {
    return Date.parse(expiresAt) <= Date.now();
  }

  private assertAdmin(user: User): void {
    if (!user.isAdmin || user.globalRole !== "admin") {
      throw new AppError(403, "forbidden", "Admin access is required.");
    }
  }

  private toUser(user: StoredUser): User {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
      globalRole: user.globalRole
    };
  }

  private toManagedUser(user: StoredUser): ManagedUserRecord {
    return {
      ...this.toUser(user),
      createdAt: user.createdAt,
      ...(user.disabledAt !== undefined ? { disabledAt: user.disabledAt } : {})
    };
  }
}
