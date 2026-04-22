import { cloneValue } from "../core/clone";
import { AppError } from "../core/errors";
import {
  FileEntry,
  NoteContentVersionRecord,
  NoteReadStateNoteSnapshot,
  NoteReadStateRecord,
  NoteReadStateSnapshot,
  NoteReadStateUpdate,
  User
} from "../domain/types";
import {
  MemoryState,
  noteContentVersionKey,
  noteReadStateKey,
  StoredWorkspace
} from "./memory-state";
import { NotePresenceService } from "./note-presence-service";
import { StateStore } from "./state-store";

type NoteReadStateListener = (event: {
  type: "note.read-state.updated";
  payload: NoteReadStateUpdate;
}) => void;

export interface NoteReadStateStreamHandle {
  snapshot: NoteReadStateSnapshot;
  unsubscribe: () => void;
}

export class NoteReadStateService {
  private readonly workspaceListeners = new Map<
    string,
    Map<string, Set<NoteReadStateListener>>
  >();

  constructor(
    private readonly state: MemoryState,
    private readonly stateStore: StateStore,
    private readonly notePresence: NotePresenceService
  ) {}

  openStream(
    actor: User,
    workspaceId: string,
    listener: NoteReadStateListener
  ): NoteReadStateStreamHandle {
    const workspace = this.requireWorkspaceMember(actor, workspaceId);
    let workspaceListeners = this.workspaceListeners.get(workspaceId);
    if (!workspaceListeners) {
      workspaceListeners = new Map();
      this.workspaceListeners.set(workspaceId, workspaceListeners);
    }

    let userListeners = workspaceListeners.get(actor.id);
    if (!userListeners) {
      userListeners = new Set();
      workspaceListeners.set(actor.id, userListeners);
    }

    userListeners.add(listener);

    return {
      snapshot: this.getSnapshot(workspace, actor.id),
      unsubscribe: () => {
        userListeners?.delete(listener);
        if (userListeners && userListeners.size === 0) {
          workspaceListeners?.delete(actor.id);
        }
        this.pruneWorkspaceListeners(workspaceId);
      }
    };
  }

  async markRead(
    actor: User,
    workspaceId: string,
    entryId: string,
    requestedContentVersion: number
  ): Promise<NoteReadStateUpdate> {
    const workspace = this.requireWorkspaceMember(actor, workspaceId);
    this.requireMarkdownEntry(workspace, entryId);

    const contentVersion = this.getContentVersion(workspaceId, entryId);
    const currentLastRead = this.getLastReadContentVersion(workspaceId, entryId, actor.id);
    const nextLastRead = Math.max(
      currentLastRead,
      Math.min(requestedContentVersion, contentVersion)
    );

    if (nextLastRead !== currentLastRead) {
      this.setLastReadContentVersion(workspaceId, entryId, actor.id, nextLastRead);
      await this.stateStore.saveState(this.state);
    }

    const payload = this.buildUpdate(workspaceId, entryId, actor.id, contentVersion);
    this.emitToUser(workspaceId, actor.id, payload);
    return payload;
  }

  async handleMarkdownContentChanged(
    workspaceId: string,
    entryId: string
  ): Promise<NoteReadStateUpdate[]> {
    const workspace = this.requireWorkspace(workspaceId);
    this.requireMarkdownEntry(workspace, entryId);

    // Read state is anchored to persisted CRDT snapshots, not raw keystrokes. If multiple edits are
    // coalesced into one stored Yjs update, they intentionally advance the unread version only once.
    const nextContentVersion = this.bumpContentVersion(workspaceId, entryId);
    const updates: NoteReadStateUpdate[] = [];

    for (const membership of workspace.memberships.values()) {
      if (this.notePresence.hasActiveViewer(workspaceId, entryId, membership.userId)) {
        this.setLastReadContentVersion(
          workspaceId,
          entryId,
          membership.userId,
          nextContentVersion
        );
      }

      const payload = this.buildUpdate(
        workspaceId,
        entryId,
        membership.userId,
        nextContentVersion
      );
      updates.push(payload);
      this.emitToUser(workspaceId, membership.userId, payload);
    }

    await this.stateStore.saveState(this.state);
    return updates;
  }

  deleteWorkspaceState(workspaceId: string): void {
    for (const key of [...this.state.noteContentVersions.keys()]) {
      if (key.startsWith(`${workspaceId}:`)) {
        this.state.noteContentVersions.delete(key);
      }
    }

    for (const key of [...this.state.noteReadStates.keys()]) {
      if (key.startsWith(`${workspaceId}:`)) {
        this.state.noteReadStates.delete(key);
      }
    }

    this.workspaceListeners.delete(workspaceId);
  }

  deleteUserState(userId: string): void {
    for (const [key, record] of this.state.noteReadStates.entries()) {
      if (record.userId === userId) {
        this.state.noteReadStates.delete(key);
      }
    }

    for (const workspaceListeners of this.workspaceListeners.values()) {
      workspaceListeners.delete(userId);
    }

    for (const workspaceId of [...this.workspaceListeners.keys()]) {
      this.pruneWorkspaceListeners(workspaceId);
    }
  }

  private getSnapshot(
    workspace: StoredWorkspace,
    userId: string
  ): NoteReadStateSnapshot {
    const notes = [...workspace.entries.values()]
      .filter((entry) => !entry.deleted && entry.kind === "markdown" && !!entry.docId)
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => this.buildSnapshotItem(workspace.workspace.id, entry.id, userId));

    return {
      workspaceId: workspace.workspace.id,
      notes
    };
  }

  private emitToUser(
    workspaceId: string,
    userId: string,
    payload: NoteReadStateUpdate
  ): void {
    const listeners = this.workspaceListeners.get(workspaceId)?.get(userId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      listener({
        type: "note.read-state.updated",
        payload: cloneValue(payload)
      });
    }
  }

  private buildUpdate(
    workspaceId: string,
    entryId: string,
    userId: string,
    contentVersionOverride?: number
  ): NoteReadStateUpdate {
    const contentVersion =
      contentVersionOverride ?? this.getContentVersion(workspaceId, entryId);
    const lastReadContentVersion = this.getLastReadContentVersion(
      workspaceId,
      entryId,
      userId
    );

    return {
      workspaceId,
      entryId,
      contentVersion,
      lastReadContentVersion,
      unread: contentVersion > lastReadContentVersion
    };
  }

  private buildSnapshotItem(
    workspaceId: string,
    entryId: string,
    userId: string
  ): NoteReadStateNoteSnapshot {
    const update = this.buildUpdate(workspaceId, entryId, userId);

    return {
      entryId: update.entryId,
      contentVersion: update.contentVersion,
      lastReadContentVersion: update.lastReadContentVersion,
      unread: update.unread
    };
  }

  private bumpContentVersion(workspaceId: string, entryId: string): number {
    const key = noteContentVersionKey(workspaceId, entryId);
    const current = this.state.noteContentVersions.get(key)?.contentVersion ?? 0;
    const next: NoteContentVersionRecord = {
      workspaceId,
      entryId,
      contentVersion: current + 1
    };

    this.state.noteContentVersions.set(key, next);
    return next.contentVersion;
  }

  private getContentVersion(workspaceId: string, entryId: string): number {
    return (
      this.state.noteContentVersions.get(noteContentVersionKey(workspaceId, entryId))
        ?.contentVersion ?? 0
    );
  }

  private getLastReadContentVersion(
    workspaceId: string,
    entryId: string,
    userId: string
  ): number {
    return (
      this.state.noteReadStates.get(noteReadStateKey(workspaceId, entryId, userId))
        ?.lastReadContentVersion ?? 0
    );
  }

  private setLastReadContentVersion(
    workspaceId: string,
    entryId: string,
    userId: string,
    lastReadContentVersion: number
  ): void {
    const key = noteReadStateKey(workspaceId, entryId, userId);
    const nextRecord: NoteReadStateRecord = {
      workspaceId,
      entryId,
      userId,
      lastReadContentVersion
    };

    this.state.noteReadStates.set(key, nextRecord);
  }

  private pruneWorkspaceListeners(workspaceId: string): void {
    const workspaceListeners = this.workspaceListeners.get(workspaceId);
    if (!workspaceListeners || workspaceListeners.size > 0) {
      return;
    }

    this.workspaceListeners.delete(workspaceId);
  }

  private requireWorkspace(workspaceId: string): StoredWorkspace {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace) {
      throw new AppError(404, "workspace_not_found", "Workspace was not found.");
    }

    return workspace;
  }

  private requireWorkspaceMember(actor: User, workspaceId: string): StoredWorkspace {
    const workspace = this.requireWorkspace(workspaceId);
    if (!workspace.memberships.has(actor.id)) {
      throw new AppError(403, "forbidden", "User is not a workspace member.");
    }

    return workspace;
  }

  private requireMarkdownEntry(workspace: StoredWorkspace, entryId: string): FileEntry {
    const entry = workspace.entries.get(entryId);
    if (!entry || entry.deleted) {
      throw new AppError(404, "entry_not_found", "Markdown entry not found.");
    }
    if (entry.kind !== "markdown" || !entry.docId) {
      throw new AppError(
        400,
        "unsupported_entry_kind",
        "Only markdown entries support note read state.",
        {
          entryKind: entry.kind
        }
      );
    }

    return entry;
  }
}
