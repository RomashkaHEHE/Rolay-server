import { cloneValue } from "../core/clone";
import { AppError } from "../core/errors";
import { createId, createInviteCode } from "../core/ids";
import { createSlug, normalizePath, suggestConflictPath } from "../core/paths";
import {
  FileEntry,
  Invite,
  InviteRole,
  Membership,
  OperationPreconditions,
  OperationResult,
  TreeOperation,
  TreeSnapshot,
  User,
  Workspace,
  WorkspaceEvent,
  WorkspaceRole
} from "../domain/types";
import { MemoryState, StoredWorkspace, WorkspaceEventListener } from "./memory-state";
import { StateStore } from "./state-store";

export interface EventStreamHandle {
  initialEvents: WorkspaceEvent[];
  unsubscribe: () => void;
}

export class WorkspaceService {
  constructor(
    private readonly state: MemoryState,
    private readonly stateStore: StateStore
  ) {}

  async createWorkspace(actor: User, name: string, slug?: string): Promise<Workspace> {
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: createId("ws"),
      name
    };
    workspace.slug = slug ? createSlug(slug) : createSlug(name);

    const membership: Membership = {
      userId: actor.id,
      role: "owner",
      joinedAt: now
    };

    const record: StoredWorkspace = {
      workspace,
      createdBy: actor.id,
      createdAt: now,
      memberships: new Map([[actor.id, membership]]),
      invites: new Map(),
      entries: new Map(),
      events: [],
      nextEventSeq: 1,
      opResults: new Map(),
      listeners: new Set()
    };

    this.state.workspaces.set(workspace.id, record);
    await this.stateStore.saveState(this.state);
    return cloneValue(workspace);
  }

  async createInvite(
    actor: User,
    workspaceId: string,
    role: InviteRole,
    expiresAt?: string,
    maxUses?: number
  ): Promise<Invite> {
    const workspace = this.requireWorkspace(workspaceId);
    this.assertRole(workspace, actor.id, "owner");

    const invite: Invite = {
      id: createId("inv"),
      workspaceId,
      code: createInviteCode(),
      role,
      usedCount: 0
    };
    if (expiresAt !== undefined) {
      invite.expiresAt = expiresAt;
    }
    if (maxUses !== undefined) {
      invite.maxUses = maxUses;
    }

    workspace.invites.set(invite.id, invite);
    this.state.invitesByCode.set(invite.code, invite);
    await this.stateStore.saveState(this.state);
    return cloneValue(invite);
  }

  async acceptInvite(actor: User, code: string): Promise<Workspace> {
    const invite = this.state.invitesByCode.get(code);
    if (!invite) {
      throw new AppError(404, "invite_not_found", "Invite not found.");
    }
    if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) {
      throw new AppError(400, "invite_expired", "Invite has expired.");
    }
    if (invite.maxUses !== undefined && invite.usedCount >= invite.maxUses) {
      throw new AppError(400, "invite_exhausted", "Invite has no remaining uses.");
    }

    const workspace = this.requireWorkspace(invite.workspaceId);
    if (!workspace.memberships.has(actor.id)) {
      workspace.memberships.set(actor.id, {
        userId: actor.id,
        role: invite.role,
        joinedAt: new Date().toISOString()
      });
      invite.usedCount += 1;
      this.publishEvent(workspace, "workspace.member.joined", {
        userId: actor.id,
        role: invite.role
      });
      await this.stateStore.saveState(this.state);
    }

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

    entry.blob = {
      hash: operation.hash,
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

  private assertRole(
    workspace: StoredWorkspace,
    userId: string,
    requiredRole: WorkspaceRole
  ): Membership {
    const membership = this.assertMember(workspace, userId);
    if (requiredRole === "owner" && membership.role !== "owner") {
      throw new AppError(403, "forbidden", "Owner access is required.");
    }
    return membership;
  }

  private assertCanEdit(workspace: StoredWorkspace, userId: string): Membership {
    const membership = this.assertMember(workspace, userId);
    if (membership.role === "viewer") {
      throw new AppError(403, "forbidden", "Editor access is required.");
    }
    return membership;
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
}
