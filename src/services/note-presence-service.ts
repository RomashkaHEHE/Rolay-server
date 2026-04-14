import { cloneValue } from "../core/clone";
import { AppError } from "../core/errors";
import {
  NotePresenceSnapshot,
  NotePresenceUpdate,
  NotePresenceViewer,
  User
} from "../domain/types";
import { MemoryState } from "./memory-state";

interface RealtimePresenceContext {
  workspaceId: string;
  entryId: string;
}

interface AwarenessUserState {
  userId?: unknown;
  id?: unknown;
  displayName?: unknown;
  color?: unknown;
}

interface AwarenessViewerState {
  workspaceId?: unknown;
  entryId?: unknown;
  active?: unknown;
}

interface AwarenessStateRecord {
  clientId?: unknown;
  user?: AwarenessUserState;
  viewer?: AwarenessViewerState;
  selection?: unknown;
  [key: string | number]: unknown;
}

type NotePresenceListener = (event: {
  type: "note.presence.updated";
  payload: NotePresenceUpdate;
}) => void;

export interface NotePresenceStreamHandle {
  snapshot: NotePresenceSnapshot;
  unsubscribe: () => void;
}

export class NotePresenceService {
  private readonly workspaceListeners = new Map<string, Set<NotePresenceListener>>();
  private readonly workspaceNotes = new Map<string, Map<string, NotePresenceViewer[]>>();

  constructor(private readonly state: MemoryState) {}

  openStream(actor: User, workspaceId: string, listener: NotePresenceListener): NotePresenceStreamHandle {
    this.assertWorkspaceMember(actor, workspaceId);

    let listeners = this.workspaceListeners.get(workspaceId);
    if (!listeners) {
      listeners = new Set();
      this.workspaceListeners.set(workspaceId, listeners);
    }

    listeners.add(listener);

    return {
      snapshot: this.getSnapshot(workspaceId),
      unsubscribe: () => {
        listeners?.delete(listener);
        this.pruneWorkspace(workspaceId);
      }
    };
  }

  reconcileAwareness(
    context: RealtimePresenceContext,
    states: Array<Record<string | number, unknown>>
  ): void {
    if (!this.isActiveMarkdownEntry(context.workspaceId, context.entryId)) {
      this.replaceViewers(context.workspaceId, context.entryId, []);
      return;
    }

    // Hocuspocus gives us the full awareness state for the current markdown document on every
    // update, so note presence can stay purely ephemeral: replace one note's viewer list instead
    // of replaying diffs or persisting session records.
    const viewers = states
      .map((state) => this.toViewer(context, state))
      .filter((viewer): viewer is NotePresenceViewer => viewer !== null)
      .sort((left, right) => {
        if (left.displayName !== right.displayName) {
          return left.displayName.localeCompare(right.displayName);
        }

        return left.presenceId.localeCompare(right.presenceId);
      });

    this.replaceViewers(context.workspaceId, context.entryId, viewers);
  }

  clearDocumentPresence(documentName: string): void {
    const documentContext = this.findDocumentContext(documentName);
    if (!documentContext) {
      return;
    }

    this.replaceViewers(documentContext.workspaceId, documentContext.entryId, []);
  }

  private getSnapshot(workspaceId: string): NotePresenceSnapshot {
    const workspace = this.requireWorkspace(workspaceId);
    const notes = [...(this.workspaceNotes.get(workspaceId)?.entries() ?? [])]
      .filter(([entryId, viewers]) => viewers.length > 0 && this.isActiveMarkdownEntry(workspaceId, entryId))
      .sort(([leftEntryId], [rightEntryId]) => {
        const leftEntry = workspace.entries.get(leftEntryId);
        const rightEntry = workspace.entries.get(rightEntryId);
        if (leftEntry && rightEntry && leftEntry.path !== rightEntry.path) {
          return leftEntry.path.localeCompare(rightEntry.path);
        }

        return leftEntryId.localeCompare(rightEntryId);
      })
      .map(([entryId, viewers]) => ({
        entryId,
        viewers: cloneValue(viewers)
      }));

    return {
      workspaceId,
      notes
    };
  }

  private toViewer(
    context: RealtimePresenceContext,
    state: AwarenessStateRecord
  ): NotePresenceViewer | null {
    if (typeof state.clientId !== "number") {
      return null;
    }

    if (!state.user || typeof state.user !== "object") {
      return null;
    }

    const viewerState =
      state.viewer && typeof state.viewer === "object" ? state.viewer : undefined;
    if (viewerState && viewerState.active === false) {
      return null;
    }
    if (
      viewerState &&
      typeof viewerState.workspaceId === "string" &&
      viewerState.workspaceId !== context.workspaceId
    ) {
      return null;
    }
    if (
      viewerState &&
      typeof viewerState.entryId === "string" &&
      viewerState.entryId !== context.entryId
    ) {
      return null;
    }

    const userId =
      typeof state.user.userId === "string"
        ? state.user.userId
        : typeof state.user.id === "string"
          ? state.user.id
          : undefined;
    if (!userId) {
      return null;
    }

    const storedUser = this.state.users.get(userId);
    const displayName =
      typeof state.user.displayName === "string" && state.user.displayName.trim() !== ""
        ? state.user.displayName
        : storedUser?.displayName ?? storedUser?.username ?? userId;
    const color =
      typeof state.user.color === "string" && state.user.color.trim() !== ""
        ? state.user.color
        : null;

    return {
      // Presence is intentionally not deduplicated by userId. Multiple devices/windows of the same
      // account should still render as separate live viewers for the note.
      presenceId: `presence:${context.workspaceId}:${context.entryId}:${state.clientId}`,
      userId,
      displayName,
      color,
      hasSelection: this.hasSelection(state.selection)
    };
  }

  private hasSelection(selection: unknown): boolean {
    if (!selection || typeof selection !== "object") {
      return false;
    }

    const record = selection as Record<string, unknown>;
    return record.anchor !== undefined || record.head !== undefined;
  }

  private replaceViewers(
    workspaceId: string,
    entryId: string,
    viewers: NotePresenceViewer[]
  ): void {
    const currentNotes = this.workspaceNotes.get(workspaceId) ?? new Map<string, NotePresenceViewer[]>();
    const previousViewers = currentNotes.get(entryId) ?? [];
    if (this.sameViewers(previousViewers, viewers)) {
      return;
    }

    if (viewers.length === 0) {
      currentNotes.delete(entryId);
    } else {
      currentNotes.set(entryId, cloneValue(viewers));
    }

    if (currentNotes.size === 0) {
      this.workspaceNotes.delete(workspaceId);
    } else {
      this.workspaceNotes.set(workspaceId, currentNotes);
    }

    const listeners = this.workspaceListeners.get(workspaceId);
    if (!listeners || listeners.size === 0) {
      this.pruneWorkspace(workspaceId);
      return;
    }

    const payload: NotePresenceUpdate = {
      workspaceId,
      entryId,
      viewers: cloneValue(viewers)
    };

    for (const listener of listeners) {
      listener({
        type: "note.presence.updated",
        payload
      });
    }
  }

  private sameViewers(left: NotePresenceViewer[], right: NotePresenceViewer[]): boolean {
    if (left.length !== right.length) {
      return false;
    }

    return JSON.stringify(left) === JSON.stringify(right);
  }

  private pruneWorkspace(workspaceId: string): void {
    const listeners = this.workspaceListeners.get(workspaceId);
    if (listeners && listeners.size === 0) {
      this.workspaceListeners.delete(workspaceId);
    }

    const notes = this.workspaceNotes.get(workspaceId);
    if (notes && notes.size === 0) {
      this.workspaceNotes.delete(workspaceId);
    }
  }

  private findDocumentContext(documentName: string): RealtimePresenceContext | null {
    for (const workspace of this.state.workspaces.values()) {
      for (const entry of workspace.entries.values()) {
        if (
          entry.docId === documentName &&
          entry.kind === "markdown" &&
          !entry.deleted
        ) {
          return {
            workspaceId: workspace.workspace.id,
            entryId: entry.id
          };
        }
      }
    }

    return null;
  }

  private isActiveMarkdownEntry(workspaceId: string, entryId: string): boolean {
    const workspace = this.state.workspaces.get(workspaceId);
    const entry = workspace?.entries.get(entryId);
    return Boolean(entry && !entry.deleted && entry.kind === "markdown" && entry.docId);
  }

  private assertWorkspaceMember(actor: User, workspaceId: string): void {
    const workspace = this.requireWorkspace(workspaceId);
    if (!workspace.memberships.has(actor.id)) {
      throw new AppError(403, "forbidden", "User is not a workspace member.");
    }
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace) {
      throw new AppError(404, "workspace_not_found", "Workspace was not found.");
    }

    return workspace;
  }
}
