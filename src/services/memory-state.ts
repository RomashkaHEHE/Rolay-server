import {
  AccessTokenRecord,
  BlobDownloadTicketRecord,
  BlobObject,
  BlobUploadTicketRecord,
  CrdtTokenRecord,
  DeviceSession,
  FileEntry,
  Membership,
  NoteContentVersionRecord,
  NoteReadStateRecord,
  OperationResult,
  RefreshTokenRecord,
  StoredSettingsEvent,
  StoredUser,
  Workspace,
  WorkspaceInvite,
  WorkspaceEvent
} from "../domain/types";
import { createInviteCode } from "../core/ids";

export type WorkspaceEventListener = (event: WorkspaceEvent) => void;
export type SettingsEventListener = (event: StoredSettingsEvent) => void;

export function noteContentVersionKey(workspaceId: string, entryId: string): string {
  return `${workspaceId}:${entryId}`;
}

export function noteReadStateKey(
  workspaceId: string,
  entryId: string,
  userId: string
): string {
  return `${workspaceId}:${entryId}:${userId}`;
}

export interface StoredWorkspaceSnapshot {
  workspace: Workspace;
  createdBy: string;
  createdAt: string;
  memberships: Membership[];
  invite?: WorkspaceInvite;
  invites?: Array<{ code: string }>;
  entries: FileEntry[];
  events: WorkspaceEvent[];
  nextEventSeq: number;
  opResults: OperationResult[];
}

export interface MemoryStateSnapshot {
  version: 1 | 2 | 3 | 4 | 5;
  users: StoredUser[];
  devices: DeviceSession[];
  accessTokens: AccessTokenRecord[];
  refreshTokens: RefreshTokenRecord[];
  workspaces: StoredWorkspaceSnapshot[];
  blobObjects: BlobObject[];
  crdtTokens: CrdtTokenRecord[];
  blobUploadTickets: BlobUploadTicketRecord[];
  blobDownloadTickets: BlobDownloadTicketRecord[];
  settingsEvents?: StoredSettingsEvent[];
  nextSettingsEventId?: number;
  noteContentVersions?: NoteContentVersionRecord[];
  noteReadStates?: NoteReadStateRecord[];
}

export interface StoredWorkspace {
  workspace: Workspace;
  createdBy: string;
  createdAt: string;
  memberships: Map<string, Membership>;
  invite: WorkspaceInvite;
  entries: Map<string, FileEntry>;
  events: WorkspaceEvent[];
  nextEventSeq: number;
  opResults: Map<string, OperationResult>;
  listeners: Set<WorkspaceEventListener>;
}

export class MemoryState {
  public readonly users = new Map<string, StoredUser>();
  public readonly usersByUsername = new Map<string, string>();
  public readonly devices = new Map<string, DeviceSession>();
  public readonly accessTokens = new Map<string, AccessTokenRecord>();
  public readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  public readonly workspaces = new Map<string, StoredWorkspace>();
  public readonly blobObjects = new Map<string, BlobObject>();
  public readonly crdtTokens = new Map<string, CrdtTokenRecord>();
  public readonly blobUploadTickets = new Map<string, BlobUploadTicketRecord>();
  public readonly blobDownloadTickets = new Map<string, BlobDownloadTicketRecord>();
  public readonly settingsEvents: StoredSettingsEvent[] = [];
  public nextSettingsEventId = 1;
  public readonly settingsListeners = new Set<SettingsEventListener>();
  public readonly noteContentVersions = new Map<string, NoteContentVersionRecord>();
  public readonly noteReadStates = new Map<string, NoteReadStateRecord>();

  static fromSnapshot(snapshot?: MemoryStateSnapshot): MemoryState {
    const state = new MemoryState();
    if (!snapshot) {
      return state;
    }

    for (const user of snapshot.users) {
      const normalizedUser: StoredUser = {
        ...user,
        isAdmin: Boolean(user.isAdmin)
      };
      state.users.set(normalizedUser.id, normalizedUser);
      state.usersByUsername.set(normalizedUser.username, normalizedUser.id);
    }

    for (const device of snapshot.devices) {
      state.devices.set(device.id, device);
    }

    for (const accessToken of snapshot.accessTokens) {
      state.accessTokens.set(accessToken.token, accessToken);
    }

    for (const refreshToken of snapshot.refreshTokens) {
      state.refreshTokens.set(refreshToken.token, refreshToken);
    }

    for (const workspaceSnapshot of snapshot.workspaces) {
      const legacyInviteCode = workspaceSnapshot.invites?.[0]?.code;
      const workspace: StoredWorkspace = {
        workspace: workspaceSnapshot.workspace,
        createdBy: workspaceSnapshot.createdBy,
        createdAt: workspaceSnapshot.createdAt,
        memberships: new Map(
          workspaceSnapshot.memberships.map((membership) => [membership.userId, membership])
        ),
        invite: workspaceSnapshot.invite ?? {
          code: legacyInviteCode ?? createInviteCode(),
          enabled: true,
          updatedAt: workspaceSnapshot.createdAt
        },
        entries: new Map(
          workspaceSnapshot.entries.map((entry) => [entry.id, entry])
        ),
        events: [...workspaceSnapshot.events],
        nextEventSeq: workspaceSnapshot.nextEventSeq,
        opResults: new Map(
          workspaceSnapshot.opResults.map((result) => [result.opId, result])
        ),
        listeners: new Set()
      };

      state.workspaces.set(workspace.workspace.id, workspace);
    }

    for (const blobObject of snapshot.blobObjects) {
      state.blobObjects.set(blobObject.hash, blobObject);
    }

    for (const crdtToken of snapshot.crdtTokens) {
      state.crdtTokens.set(crdtToken.token, crdtToken);
    }

    for (const uploadTicket of snapshot.blobUploadTickets) {
      state.blobUploadTickets.set(uploadTicket.ticketId, {
        ...uploadTicket,
        uploadedBytes: uploadTicket.uploadedBytes ?? 0
      });
    }

    for (const downloadTicket of snapshot.blobDownloadTickets) {
      state.blobDownloadTickets.set(downloadTicket.ticketId, downloadTicket);
    }

    for (const contentVersion of snapshot.noteContentVersions ?? []) {
      state.noteContentVersions.set(
        noteContentVersionKey(contentVersion.workspaceId, contentVersion.entryId),
        contentVersion
      );
    }

    for (const readState of snapshot.noteReadStates ?? []) {
      state.noteReadStates.set(
        noteReadStateKey(readState.workspaceId, readState.entryId, readState.userId),
        readState
      );
    }

    state.settingsEvents.push(...(snapshot.settingsEvents ?? []));
    state.nextSettingsEventId =
      snapshot.nextSettingsEventId ??
      ((snapshot.settingsEvents?.at(-1)?.eventId ?? 0) + 1);

    return state;
  }

  toSnapshot(): MemoryStateSnapshot {
    return {
      version: 5,
      users: [...this.users.values()].map((user) => ({
        ...user,
        isAdmin: Boolean(user.isAdmin)
      })),
      devices: [...this.devices.values()],
      accessTokens: [...this.accessTokens.values()],
      refreshTokens: [...this.refreshTokens.values()],
      workspaces: [...this.workspaces.values()].map((workspace) => ({
        workspace: workspace.workspace,
        createdBy: workspace.createdBy,
        createdAt: workspace.createdAt,
        memberships: [...workspace.memberships.values()],
        invite: workspace.invite,
        entries: [...workspace.entries.values()],
        events: [...workspace.events],
        nextEventSeq: workspace.nextEventSeq,
        opResults: [...workspace.opResults.values()]
      })),
      blobObjects: [...this.blobObjects.values()],
      crdtTokens: [...this.crdtTokens.values()],
      blobUploadTickets: [...this.blobUploadTickets.values()],
      blobDownloadTickets: [...this.blobDownloadTickets.values()],
      settingsEvents: [...this.settingsEvents],
      nextSettingsEventId: this.nextSettingsEventId,
      noteContentVersions: [...this.noteContentVersions.values()],
      noteReadStates: [...this.noteReadStates.values()]
    };
  }
}
