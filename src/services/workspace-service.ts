import { cloneValue } from "../core/clone";
import { AppError } from "../core/errors";
import { normalizeSha256Hash } from "../core/hashes";
import { createId, createInviteCode } from "../core/ids";
import { normalizePath, suggestConflictPath } from "../core/paths";
import {
  FileEntry,
  Membership,
  OperationPreconditions,
  OperationResult,
  TreeOperation,
  TreeSnapshot,
  User,
  Workspace,
  WorkspaceEvent,
  WorkspaceInvite,
  WorkspaceRole
} from "../domain/types";
import { MemoryState, StoredWorkspace, WorkspaceEventListener } from "./memory-state";
import { SettingsEventsService } from "./settings-events-service";
import { StateStore } from "./state-store";

export interface EventStreamHandle {
  initialEvents: WorkspaceEvent[];
  unsubscribe: () => void;
}

interface WorkspaceListItem {
  workspace: Workspace;
  membershipRole: WorkspaceRole;
  createdAt: string;
  memberCount: number;
  inviteEnabled: boolean;
}

interface WorkspaceAdminListItem extends WorkspaceListItem {
  ownerCount: number;
}

interface WorkspaceMemberRecord {
  user: User;
  role: WorkspaceRole;
  joinedAt: string;
}

interface WorkspaceInviteView {
  workspaceId: string;
  code: string;
  enabled: boolean;
  updatedAt: string;
}

interface WorkspaceMemberMutationResult {
  workspace: Workspace;
  user: User;
  membership: Membership;
}

export class WorkspaceService {
  constructor(
    private readonly state: MemoryState,
    private readonly stateStore: StateStore,
    private readonly settingsEvents: SettingsEventsService
  ) {}

  listUserWorkspaces(actor: User): WorkspaceListItem[] {
    return [...this.state.workspaces.values()]
      .filter((workspace) => workspace.memberships.has(actor.id))
      .map((workspace) => {
        const membership = workspace.memberships.get(actor.id);
        if (!membership) {
          throw new Error("Corrupted workspace membership state.");
        }

        return {
          workspace: cloneValue(workspace.workspace),
          membershipRole: membership.role,
          createdAt: workspace.createdAt,
          memberCount: workspace.memberships.size,
          inviteEnabled: workspace.invite.enabled
        };
      })
      .sort((left, right) => left.workspace.name.localeCompare(right.workspace.name));
  }

  listAllWorkspaces(actor: User): WorkspaceAdminListItem[] {
    this.assertAdmin(actor);
    return [...this.state.workspaces.values()]
      .map((workspace) => ({
        workspace: cloneValue(workspace.workspace),
        membershipRole: workspace.memberships.get(workspace.createdBy)?.role ?? "owner",
        createdAt: workspace.createdAt,
        memberCount: workspace.memberships.size,
        inviteEnabled: workspace.invite.enabled,
        ownerCount: [...workspace.memberships.values()].filter(
          (membership) => membership.role === "owner"
        ).length
      }))
      .sort((left, right) => left.workspace.name.localeCompare(right.workspace.name));
  }

  async createWorkspace(actor: User, name: string, _slug?: string): Promise<Workspace> {
    this.assertCanCreateWorkspace(actor);

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: createId("ws"),
      name
    };

    const membership: Membership = {
      userId: actor.id,
      role: "owner",
      joinedAt: now
    };

    const record: StoredWorkspace = {
      workspace,
      createdBy: actor.id,
      createdAt: now,
      invite: {
        code: createInviteCode(),
        enabled: true,
        updatedAt: now
      },
      memberships: new Map([[actor.id, membership]]),
      entries: new Map(),
      events: [],
      nextEventSeq: 1,
      opResults: new Map(),
      listeners: new Set()
    };

    this.state.workspaces.set(workspace.id, record);
    await this.stateStore.saveState(this.state);
    this.settingsEvents.publishRoomCreated(workspace.id);
    this.settingsEvents.publishAdminRoomMembersUpdated(workspace.id);
    return cloneValue(workspace);
  }

  getWorkspaceMembers(actor: User, workspaceId: string): WorkspaceMemberRecord[] {
    const workspace = this.requireWorkspace(workspaceId);
    this.assertCanInspectWorkspace(workspace, actor);

    return [...workspace.memberships.values()]
      .map((membership) => {
        const user = this.state.users.get(membership.userId);
        if (!user || user.disabledAt) {
          throw new Error("Corrupted workspace state: membership points to missing user.");
        }

        return {
          user: this.toUser(user),
          role: membership.role,
          joinedAt: membership.joinedAt
        };
      })
      .sort((left, right) => {
        if (left.role !== right.role) {
          return left.role === "owner" ? -1 : 1;
        }

        return left.user.username.localeCompare(right.user.username);
      });
  }

  getInvite(actor: User, workspaceId: string): WorkspaceInviteView {
    const workspace = this.requireWorkspace(workspaceId);
    this.assertCanManageWorkspace(workspace, actor);
    return this.toInviteView(workspace.workspace.id, workspace.invite);
  }

  async updateInviteEnabled(
    actor: User,
    workspaceId: string,
    enabled: boolean
  ): Promise<WorkspaceInviteView> {
    const workspace = this.requireWorkspace(workspaceId);
    this.assertCanManageWorkspace(workspace, actor);

    if (workspace.invite.enabled === enabled) {
      return this.toInviteView(workspace.workspace.id, workspace.invite);
    }

    workspace.invite.enabled = enabled;
    workspace.invite.updatedAt = new Date().toISOString();
    this.publishEvent(workspace, "workspace.invite.updated", {
      code: workspace.invite.code,
      enabled: workspace.invite.enabled
    });
    await this.stateStore.saveState(this.state);
    this.settingsEvents.publishRoomUpdated(workspaceId);
    this.settingsEvents.publishRoomInviteUpdated(workspaceId);
    return this.toInviteView(workspace.workspace.id, workspace.invite);
  }

  async regenerateInvite(actor: User, workspaceId: string): Promise<WorkspaceInviteView> {
    const workspace = this.requireWorkspace(workspaceId);
    this.assertCanManageWorkspace(workspace, actor);

    workspace.invite.code = createInviteCode();
    workspace.invite.updatedAt = new Date().toISOString();
    this.publishEvent(workspace, "workspace.invite.regenerated", {
      code: workspace.invite.code,
      enabled: workspace.invite.enabled
    });
    await this.stateStore.saveState(this.state);
    this.settingsEvents.publishRoomInviteUpdated(workspaceId);
    return this.toInviteView(workspace.workspace.id, workspace.invite);
  }

  async acceptInvite(actor: User, code: string): Promise<Workspace> {
    const workspace = [...this.state.workspaces.values()].find(
      (candidate) => candidate.invite.code === code
    );
    if (!workspace) {
      throw new AppError(404, "invite_not_found", "Invite not found.");
    }
    if (!workspace.invite.enabled) {
      throw new AppError(403, "invite_disabled", "Invite is disabled.");
    }

    if (!workspace.memberships.has(actor.id)) {
      const membership: Membership = {
        userId: actor.id,
        role: "member",
        joinedAt: new Date().toISOString()
      };
      workspace.memberships.set(actor.id, membership);
      this.publishEvent(workspace, "workspace.member.joined", {
        userId: actor.id,
        role: membership.role
      });
      await this.stateStore.saveState(this.state);
      this.settingsEvents.publishRoomMembershipChanged(
        workspace.workspace.id,
        actor.id,
        membership.role
      );
      this.settingsEvents.publishRoomUpdated(workspace.workspace.id);
      this.settingsEvents.publishAdminRoomMembersUpdated(workspace.workspace.id);
    }

    return cloneValue(workspace.workspace);
  }

  async addMemberByUsername(
    actor: User,
    workspaceId: string,
    username: string,
    role: WorkspaceRole = "member"
  ): Promise<WorkspaceMemberMutationResult> {
    const workspace = this.requireWorkspace(workspaceId);
    this.assertCanManageWorkspace(workspace, actor);

    const targetUserId = this.state.usersByUsername.get(username);
    if (!targetUserId) {
      throw new AppError(404, "user_not_found", "User was not found.");
    }

    const user = this.state.users.get(targetUserId);
    if (!user || user.disabledAt) {
      throw new AppError(404, "user_not_found", "User was not found.");
    }

    const existingMembership = workspace.memberships.get(user.id);
    if (existingMembership) {
      if (existingMembership.role !== role) {
        existingMembership.role = role;
        this.publishEvent(workspace, "workspace.member.role_updated", {
          userId: user.id,
          role
        });
        await this.stateStore.saveState(this.state);
        this.settingsEvents.publishRoomMembershipChanged(workspaceId, user.id, role);
        this.settingsEvents.publishAdminRoomMembersUpdated(workspaceId);
      }

      return {
        workspace: cloneValue(workspace.workspace),
        user: this.toUser(user),
        membership: cloneValue(existingMembership)
      };
    }

    const membership: Membership = {
      userId: user.id,
      role,
      joinedAt: new Date().toISOString()
    };
    workspace.memberships.set(user.id, membership);
    this.publishEvent(workspace, "workspace.member.joined", {
      userId: user.id,
      role
    });
    await this.stateStore.saveState(this.state);
    this.settingsEvents.publishRoomMembershipChanged(workspaceId, user.id, role);
    this.settingsEvents.publishRoomUpdated(workspaceId);
    this.settingsEvents.publishAdminRoomMembersUpdated(workspaceId);

    return {
      workspace: cloneValue(workspace.workspace),
      user: this.toUser(user),
      membership: cloneValue(membership)
    };
  }

  async deleteWorkspace(actor: User, workspaceId: string): Promise<Workspace> {
    const workspace = this.requireWorkspace(workspaceId);
    this.assertCanManageWorkspace(workspace, actor);
    this.settingsEvents.publishRoomDeleted(workspace);
    this.dropWorkspaceState(workspaceId);
    await this.stateStore.saveState(this.state);
    return cloneValue(workspace.workspace);
  }

  getTree(actor: User, workspaceId: string): TreeSnapshot {
    const workspace = this.requireWorkspace(workspaceId);
    this.assertMember(workspace, actor.id);

    const entries = [...workspace.entries.values()]
      .map((entry) => cloneValue(entry))
      .sort((left, right) => left.path.localeCompare(right.path));

    return {
      workspace: cloneValue(workspace.workspace),
      cursor: this.currentCursor(workspace),
      entries
    };
  }

  async applyOperations(
    actor: User,
    workspaceId: string,
    _deviceId: string,
    operations: TreeOperation[]
  ): Promise<OperationResult[]> {
    const workspace = this.requireWorkspace(workspaceId);
    this.assertCanEdit(workspace, actor.id);

    const results: OperationResult[] = [];
    let didMutate = false;

    for (const operation of operations) {
      const existing = workspace.opResults.get(operation.opId);
      if (existing) {
        results.push(cloneValue(existing));
        continue;
      }

      const result = this.applyOperation(workspace, operation);
      workspace.opResults.set(operation.opId, cloneValue(result));
      results.push(result);
      didMutate = true;
    }

    if (didMutate) {
      await this.stateStore.saveState(this.state);
    }

    return results.map((result) => cloneValue(result));
  }

  listEventsSince(actor: User, workspaceId: string, cursor = 0): WorkspaceEvent[] {
    const workspace = this.requireWorkspace(workspaceId);
    this.assertMember(workspace, actor.id);
    return workspace.events
      .filter((event) => event.seq > cursor)
      .map((event) => cloneValue(event));
  }

  openEventStream(
    actor: User,
    workspaceId: string,
    cursor: number,
    listener: WorkspaceEventListener
  ): EventStreamHandle {
    const workspace = this.requireWorkspace(workspaceId);
    this.assertMember(workspace, actor.id);

    workspace.listeners.add(listener);
    return {
      initialEvents: workspace.events
        .filter((event) => event.seq > cursor)
        .map((event) => cloneValue(event)),
      unsubscribe: () => {
        workspace.listeners.delete(listener);
      }
    };
  }

  private applyOperation(
    workspace: StoredWorkspace,
    operation: TreeOperation
  ): OperationResult {
    switch (operation.type) {
      case "create_folder":
        return this.createEntry(workspace, operation, "folder", "none");
      case "create_markdown":
        return this.createEntry(workspace, operation, "markdown", "crdt");
      case "create_binary_placeholder":
        return this.createEntry(workspace, operation, "binary", "blob");
      case "rename_entry":
      case "move_entry":
        return this.moveEntry(workspace, operation);
      case "delete_entry":
        return this.setDeleted(workspace, operation, true);
      case "restore_entry":
        return this.setDeleted(workspace, operation, false);
      case "commit_blob_revision":
        return this.commitBlobRevision(workspace, operation);
      default:
        return {
          opId: operation.opId,
          status: "rejected",
          reason: "invalid_operation"
        };
    }
  }

  private createEntry(
    workspace: StoredWorkspace,
    operation: TreeOperation,
    kind: FileEntry["kind"],
    contentMode: FileEntry["contentMode"]
  ): OperationResult {
    if (!operation.path) {
      throw new AppError(400, "invalid_operation", "Create operation requires path.");
    }

    const path = normalizePath(operation.path);
    const blockingAncestor = this.findBlockingAncestorEntry(workspace, path);
    if (blockingAncestor) {
      return {
        opId: operation.opId,
        status: "conflict",
        reason: "invalid_parent",
        serverEntry: cloneValue(blockingAncestor)
      };
    }

    const existing = this.findActiveEntryByPath(workspace, path);
    if (existing) {
      return {
        opId: operation.opId,
        status: "conflict",
        reason: "path_already_exists",
        serverEntry: cloneValue(existing),
        suggestedPath: this.findAvailableConflictPath(workspace, path)
      };
    }

    const entry: FileEntry = {
      id: createId("fil"),
      path,
      kind,
      contentMode,
      entryVersion: 0,
      deleted: false,
      updatedAt: new Date().toISOString()
    };

    if (kind === "markdown") {
      entry.docId = createId("doc");
    }

    workspace.entries.set(entry.id, entry);
    const eventSeq = this.publishEvent(workspace, "tree.entry.created", {
      entryId: entry.id,
      path: entry.path,
      kind: entry.kind,
      contentMode: entry.contentMode
    });

    return {
      opId: operation.opId,
      status: "applied",
      eventSeq,
      entry: cloneValue(entry)
    };
  }

  private moveEntry(workspace: StoredWorkspace, operation: TreeOperation): OperationResult {
    if (!operation.entryId || !operation.newPath) {
      throw new AppError(
        400,
        "invalid_operation",
        "Rename/move operation requires entryId and newPath."
      );
    }

    const entry = workspace.entries.get(operation.entryId);
    if (!entry) {
      return {
        opId: operation.opId,
        status: "rejected",
        reason: "entry_not_found"
      };
    }

    const preconditionFailure = this.checkPreconditions(entry, operation.preconditions);
    if (preconditionFailure) {
      return {
        opId: operation.opId,
        status: "conflict",
        reason: preconditionFailure,
        serverEntry: cloneValue(entry)
      };
    }

    const newPath = normalizePath(operation.newPath);
    if (newPath === entry.path) {
      return {
        opId: operation.opId,
        status: "applied",
        entry: cloneValue(entry)
      };
    }
    if (entry.kind === "folder" && newPath.startsWith(`${entry.path}/`)) {
      return {
        opId: operation.opId,
        status: "conflict",
        reason: "invalid_target_path",
        serverEntry: cloneValue(entry)
      };
    }

    const affectedEntries = this.collectAffectedEntries(workspace, entry);
    const affectedIds = new Set(affectedEntries.map((candidate) => candidate.id));
    const nextPaths = new Map<string, string>();

    for (const candidate of affectedEntries) {
      const candidatePath =
        candidate.id === entry.id
          ? newPath
          : this.rewritePathPrefix(candidate.path, entry.path, newPath);
      const blockingAncestor = this.findBlockingAncestorEntry(
        workspace,
        candidatePath,
        affectedIds
      );
      if (blockingAncestor) {
        return {
          opId: operation.opId,
          status: "conflict",
          reason: "invalid_parent",
          serverEntry: cloneValue(blockingAncestor)
        };
      }

      const collision = this.findActiveEntryByPath(workspace, candidatePath, affectedIds);
      if (collision) {
        return {
          opId: operation.opId,
          status: "conflict",
          reason: "path_already_exists",
          serverEntry: cloneValue(collision),
          suggestedPath: this.findAvailableConflictPath(workspace, newPath, affectedIds)
        };
      }

      nextPaths.set(candidate.id, candidatePath);
    }

    const updatedAt = new Date().toISOString();
    for (const candidate of affectedEntries) {
      const nextPath = nextPaths.get(candidate.id);
      if (!nextPath) {
        continue;
      }

      candidate.path = nextPath;
      candidate.entryVersion += 1;
      candidate.updatedAt = updatedAt;
    }

    const eventSeq = this.publishEvent(workspace, "tree.entry.updated", {
      entryId: entry.id,
      path: entry.path,
      entryVersion: entry.entryVersion,
      affectedEntries: affectedEntries.map((candidate) => ({
        entryId: candidate.id,
        path: candidate.path
      }))
    });

    return {
      opId: operation.opId,
      status: "applied",
      eventSeq,
      entry: cloneValue(entry)
    };
  }

  private setDeleted(
    workspace: StoredWorkspace,
    operation: TreeOperation,
    deleted: boolean
  ): OperationResult {
    if (!operation.entryId) {
      throw new AppError(400, "invalid_operation", "Delete/restore requires entryId.");
    }

    const entry = workspace.entries.get(operation.entryId);
    if (!entry) {
      return {
        opId: operation.opId,
        status: "rejected",
        reason: "entry_not_found"
      };
    }

    const preconditionFailure = this.checkPreconditions(entry, operation.preconditions);
    if (preconditionFailure) {
      return {
        opId: operation.opId,
        status: "conflict",
        reason: preconditionFailure,
        serverEntry: cloneValue(entry)
      };
    }

    const affectedEntries = this.collectAffectedEntries(workspace, entry);
    const affectedIds = new Set(affectedEntries.map((candidate) => candidate.id));

    if (!deleted) {
      for (const candidate of affectedEntries) {
        const blockingAncestor = this.findBlockingAncestorEntry(
          workspace,
          candidate.path,
          affectedIds
        );
        if (blockingAncestor) {
          return {
            opId: operation.opId,
            status: "conflict",
            reason: "invalid_parent",
            serverEntry: cloneValue(blockingAncestor)
          };
        }

        const collision = this.findActiveEntryByPath(workspace, candidate.path, affectedIds);
        if (collision) {
          return {
            opId: operation.opId,
            status: "conflict",
            reason: "path_already_exists",
            serverEntry: cloneValue(collision),
            suggestedPath: this.findAvailableConflictPath(workspace, entry.path, affectedIds)
          };
        }
      }
    }

    const changedEntries = affectedEntries.filter(
      (candidate) => candidate.deleted !== deleted
    );
    if (changedEntries.length === 0) {
      return {
        opId: operation.opId,
        status: "applied",
        entry: cloneValue(entry)
      };
    }

    const updatedAt = new Date().toISOString();
    for (const candidate of changedEntries) {
      candidate.deleted = deleted;
      candidate.entryVersion += 1;
      candidate.updatedAt = updatedAt;
    }

    const eventSeq = this.publishEvent(
      workspace,
      deleted ? "tree.entry.deleted" : "tree.entry.restored",
      {
        entryId: entry.id,
        path: entry.path,
        entryVersion: entry.entryVersion,
        affectedEntryIds: changedEntries.map((candidate) => candidate.id)
      }
    );

    return {
      opId: operation.opId,
      status: "applied",
      eventSeq,
      entry: cloneValue(entry)
    };
  }

  private commitBlobRevision(
    workspace: StoredWorkspace,
    operation: TreeOperation
  ): OperationResult {
    if (
      !operation.entryId ||
      !operation.hash ||
      operation.sizeBytes === undefined ||
      !operation.mimeType
    ) {
      throw new AppError(
        400,
        "invalid_operation",
        "Blob revision commit requires entryId, hash, sizeBytes, and mimeType."
      );
    }

    const entry = workspace.entries.get(operation.entryId);
    if (!entry) {
      return {
        opId: operation.opId,
        status: "rejected",
        reason: "entry_not_found"
      };
    }
    if (entry.kind !== "binary" || entry.deleted) {
      return {
        opId: operation.opId,
        status: "rejected",
        reason: "invalid_operation"
      };
    }

    const preconditionFailure = this.checkPreconditions(entry, operation.preconditions);
    if (preconditionFailure) {
      return {
        opId: operation.opId,
        status: "conflict",
        reason: preconditionFailure,
        serverEntry: cloneValue(entry)
      };
    }

    let normalizedHash: string;
    try {
      normalizedHash = normalizeSha256Hash(operation.hash);
    } catch {
      throw new AppError(
        400,
        "invalid_operation",
        'Blob revision commit requires a valid "sha256:<digest>" hash.'
      );
    }

    entry.blob = {
      hash: normalizedHash,
      sizeBytes: operation.sizeBytes,
      mimeType: operation.mimeType
    };
    entry.mimeType = operation.mimeType;
    entry.entryVersion += 1;
    entry.updatedAt = new Date().toISOString();
    this.state.blobObjects.set(entry.blob.hash, {
      hash: entry.blob.hash,
      sizeBytes: entry.blob.sizeBytes,
      mimeType: entry.blob.mimeType,
      createdAt: entry.updatedAt
    });

    const eventSeq = this.publishEvent(workspace, "blob.revision.committed", {
      entryId: entry.id,
      path: entry.path,
      hash: entry.blob.hash,
      sizeBytes: entry.blob.sizeBytes,
      mimeType: entry.blob.mimeType,
      entryVersion: entry.entryVersion
    });

    return {
      opId: operation.opId,
      status: "applied",
      eventSeq,
      entry: cloneValue(entry)
    };
  }

  private collectAffectedEntries(
    workspace: StoredWorkspace,
    rootEntry: FileEntry
  ): FileEntry[] {
    if (rootEntry.kind !== "folder") {
      return [rootEntry];
    }

    const prefix = `${rootEntry.path}/`;
    const entries: FileEntry[] = [rootEntry];

    for (const candidate of workspace.entries.values()) {
      if (candidate.id === rootEntry.id) {
        continue;
      }
      if (candidate.path.startsWith(prefix)) {
        entries.push(candidate);
      }
    }

    entries.sort((left, right) => left.path.length - right.path.length);
    return entries;
  }

  private rewritePathPrefix(
    path: string,
    currentPrefix: string,
    newPrefix: string
  ): string {
    if (path === currentPrefix) {
      return newPrefix;
    }

    return `${newPrefix}${path.slice(currentPrefix.length)}`;
  }

  private checkPreconditions(
    entry: FileEntry,
    preconditions?: OperationPreconditions
  ): string | undefined {
    if (!preconditions) {
      return undefined;
    }

    if (
      preconditions.entryVersion !== undefined &&
      preconditions.entryVersion !== entry.entryVersion
    ) {
      return "entry_version_mismatch";
    }
    if (preconditions.path !== undefined) {
      const expectedPath = normalizePath(preconditions.path);
      if (expectedPath !== entry.path) {
        return "path_mismatch";
      }
    }

    return undefined;
  }

  private currentCursor(workspace: StoredWorkspace): number {
    const lastEvent = workspace.events.at(-1);
    return lastEvent ? lastEvent.seq : 0;
  }

  private publishEvent(
    workspace: StoredWorkspace,
    eventType: string,
    payload: Record<string, unknown>
  ): number {
    // These are room-local ordered events for tree and file sync. Settings/admin UI uses a
    // completely separate SSE stream with different payload shapes and cursor IDs.
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

    return event.seq;
  }

  private requireWorkspace(workspaceId: string): StoredWorkspace {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace) {
      throw new AppError(404, "workspace_not_found", "Workspace not found.");
    }
    return workspace;
  }

  private assertMember(workspace: StoredWorkspace, userId: string): Membership {
    const membership = workspace.memberships.get(userId);
    if (!membership) {
      throw new AppError(403, "forbidden", "User is not a workspace member.");
    }
    return membership;
  }

  private assertCanCreateWorkspace(actor: User): void {
    if (actor.isAdmin || actor.globalRole === "admin" || actor.globalRole === "writer") {
      return;
    }

    throw new AppError(
      403,
      "forbidden",
      "Writer or admin access is required to create rooms."
    );
  }

  private assertCanInspectWorkspace(workspace: StoredWorkspace, actor: User): void {
    if (actor.isAdmin) {
      return;
    }

    this.assertMember(workspace, actor.id);
  }

  private assertCanManageWorkspace(workspace: StoredWorkspace, actor: User): Membership | undefined {
    if (actor.isAdmin) {
      return undefined;
    }

    const membership = this.assertMember(workspace, actor.id);
    if (membership.role !== "owner") {
      throw new AppError(403, "forbidden", "Owner access is required.");
    }

    return membership;
  }

  private assertCanEdit(workspace: StoredWorkspace, userId: string): Membership {
    return this.assertMember(workspace, userId);
  }

  private assertAdmin(actor: User): void {
    if (!actor.isAdmin || actor.globalRole !== "admin") {
      throw new AppError(403, "forbidden", "Admin access is required.");
    }
  }

  private findActiveEntryByPath(
    workspace: StoredWorkspace,
    path: string,
    excludedIds = new Set<string>()
  ): FileEntry | undefined {
    for (const entry of workspace.entries.values()) {
      if (excludedIds.has(entry.id)) {
        continue;
      }
      if (!entry.deleted && entry.path === path) {
        return entry;
      }
    }
    return undefined;
  }

  private findBlockingAncestorEntry(
    workspace: StoredWorkspace,
    path: string,
    excludedIds = new Set<string>()
  ): FileEntry | undefined {
    const segments = path.split("/");
    if (segments.length < 2) {
      return undefined;
    }

    for (let index = 1; index < segments.length; index += 1) {
      const ancestorPath = segments.slice(0, index).join("/");
      const ancestor = this.findActiveEntryByPath(workspace, ancestorPath, excludedIds);
      if (ancestor && ancestor.kind !== "folder") {
        return ancestor;
      }
    }

    return undefined;
  }

  private findAvailableConflictPath(
    workspace: StoredWorkspace,
    desiredPath: string,
    excludedIds = new Set<string>()
  ): string {
    let ordinal = 1;
    let candidate = suggestConflictPath(desiredPath, ordinal);

    while (
      this.findActiveEntryByPath(workspace, candidate, excludedIds) ||
      this.findBlockingAncestorEntry(workspace, candidate, excludedIds)
    ) {
      ordinal += 1;
      candidate = suggestConflictPath(desiredPath, ordinal);
    }

    return candidate;
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

  private toInviteView(workspaceId: string, invite: WorkspaceInvite): WorkspaceInviteView {
    return {
      workspaceId,
      code: invite.code,
      enabled: invite.enabled,
      updatedAt: invite.updatedAt
    };
  }

  private toUser(user: {
    id: string;
    username: string;
    displayName: string;
    isAdmin: boolean;
    globalRole: User["globalRole"];
  }): User {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
      globalRole: user.globalRole
    };
  }
}
