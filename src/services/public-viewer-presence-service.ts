import { cloneValue } from "../core/clone";
import {
  PublicViewerPresenceSnapshot,
  PublicViewerPresenceUpdate
} from "../domain/types";
import { MemoryState } from "./memory-state";

interface PublicViewerRecord {
  presenceId: string;
  workspaceId: string;
  entryId: string;
}

type PublicViewerPresenceListener = (event: {
  type: "public.note-viewers.updated";
  payload: PublicViewerPresenceUpdate;
}) => void;

export interface PublicViewerPresenceStreamHandle {
  snapshot: PublicViewerPresenceSnapshot;
  unsubscribe: () => void;
}

export class PublicViewerPresenceService {
  private readonly workspaceListeners = new Map<string, Set<PublicViewerPresenceListener>>();
  private readonly workspaceNotes = new Map<string, Map<string, Map<string, PublicViewerRecord>>>();
  private readonly recordsByPresenceId = new Map<string, PublicViewerRecord>();

  constructor(private readonly state: MemoryState) {}

  registerViewer(record: PublicViewerRecord): void {
    if (!this.isPublicMarkdownEntry(record.workspaceId, record.entryId)) {
      return;
    }

    // Public visitors are intentionally counted separately from authenticated awareness presence:
    // the plugin can show the audience size without treating anonymous readers as collaborators.
    const previous = this.recordsByPresenceId.get(record.presenceId);
    if (previous) {
      this.unregisterViewer(record.presenceId);
    }

    let notes = this.workspaceNotes.get(record.workspaceId);
    if (!notes) {
      notes = new Map();
      this.workspaceNotes.set(record.workspaceId, notes);
    }

    let viewers = notes.get(record.entryId);
    if (!viewers) {
      viewers = new Map();
      notes.set(record.entryId, viewers);
    }

    viewers.set(record.presenceId, cloneValue(record));
    this.recordsByPresenceId.set(record.presenceId, cloneValue(record));
    this.emitUpdate(record.workspaceId, record.entryId);
  }

  unregisterViewer(presenceId: string): void {
    const record = this.recordsByPresenceId.get(presenceId);
    if (!record) {
      return;
    }

    this.recordsByPresenceId.delete(presenceId);
    const notes = this.workspaceNotes.get(record.workspaceId);
    const viewers = notes?.get(record.entryId);
    viewers?.delete(presenceId);

    if (viewers && viewers.size === 0) {
      notes?.delete(record.entryId);
    }
    if (notes && notes.size === 0) {
      this.workspaceNotes.delete(record.workspaceId);
    }

    this.emitUpdate(record.workspaceId, record.entryId);
  }

  getCount(workspaceId: string, entryId: string): number {
    if (!this.isPublicMarkdownEntry(workspaceId, entryId)) {
      return 0;
    }

    return this.workspaceNotes.get(workspaceId)?.get(entryId)?.size ?? 0;
  }

  getSnapshot(workspaceId: string): PublicViewerPresenceSnapshot {
    const workspace = this.state.workspaces.get(workspaceId);
    const notes = [...(this.workspaceNotes.get(workspaceId)?.entries() ?? [])]
      .filter(
        ([entryId, viewers]) =>
          viewers.size > 0 && this.isPublicMarkdownEntry(workspaceId, entryId)
      )
      .sort(([leftEntryId], [rightEntryId]) => {
        const leftEntry = workspace?.entries.get(leftEntryId);
        const rightEntry = workspace?.entries.get(rightEntryId);
        if (leftEntry && rightEntry && leftEntry.path !== rightEntry.path) {
          return leftEntry.path.localeCompare(rightEntry.path);
        }

        return leftEntryId.localeCompare(rightEntryId);
      })
      .map(([entryId, viewers]) => ({
        entryId,
        anonymousViewerCount: viewers.size
      }));

    return {
      workspaceId,
      notes
    };
  }

  openStream(
    workspaceId: string,
    listener: PublicViewerPresenceListener
  ): PublicViewerPresenceStreamHandle {
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
        if (listeners?.size === 0) {
          this.workspaceListeners.delete(workspaceId);
        }
      }
    };
  }

  private emitUpdate(workspaceId: string, entryId: string): void {
    const listeners = this.workspaceListeners.get(workspaceId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    const payload: PublicViewerPresenceUpdate = {
      workspaceId,
      entryId,
      anonymousViewerCount: this.getCount(workspaceId, entryId)
    };

    for (const listener of listeners) {
      listener({
        type: "public.note-viewers.updated",
        payload
      });
    }
  }

  private isPublicMarkdownEntry(workspaceId: string, entryId: string): boolean {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace?.publication.enabled) {
      return false;
    }

    const entry = workspace.entries.get(entryId);
    return Boolean(entry && !entry.deleted && entry.kind === "markdown" && entry.docId);
  }
}
