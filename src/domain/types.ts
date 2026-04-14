export type GlobalRole = "admin" | "writer" | "reader";
export type WorkspaceRole = "owner" | "member";

export interface User {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  globalRole: GlobalRole;
}

export interface StoredUser extends User {
  passwordHash: string;
  createdAt: string;
  disabledAt?: string;
}

export interface DeviceSession {
  id: string;
  userId: string;
  deviceName: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface AccessTokenRecord {
  token: string;
  userId: string;
  deviceId: string;
  expiresAt: string;
}

export interface RefreshTokenRecord {
  token: string;
  userId: string;
  deviceId: string;
  expiresAt: string;
}

export interface Workspace {
  id: string;
  slug?: string;
  name: string;
}

export interface Membership {
  userId: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspaceInvite {
  code: string;
  enabled: boolean;
  updatedAt: string;
}

export type FileKind = "folder" | "markdown" | "binary";
export type ContentMode = "none" | "crdt" | "blob";

export interface BlobRevision {
  hash: string;
  sizeBytes: number;
  mimeType: string;
}

export interface BlobObject extends BlobRevision {
  createdAt: string;
}

export interface FileEntry {
  id: string;
  path: string;
  kind: FileKind;
  contentMode: ContentMode;
  entryVersion: number;
  docId?: string;
  mimeType?: string;
  blob?: BlobRevision;
  deleted: boolean;
  updatedAt: string;
}

export interface WorkspaceEvent {
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type SettingsEventScope =
  | "settings.stream"
  | "auth.me"
  | "rooms"
  | "room.members"
  | "room.invite"
  | "admin.users"
  | "admin.rooms"
  | "admin.room.members";

export interface SettingsEvent {
  eventId: number;
  type: string;
  occurredAt: string;
  scope: SettingsEventScope;
  payload: Record<string, unknown>;
}

export interface StoredSettingsEvent extends SettingsEvent {
  targetUserIds: string[];
  includeAdmins: boolean;
}

export interface OperationPreconditions {
  entryVersion?: number;
  path?: string;
}

export type TreeOperationType =
  | "create_folder"
  | "create_markdown"
  | "create_binary_placeholder"
  | "rename_entry"
  | "move_entry"
  | "delete_entry"
  | "restore_entry"
  | "commit_blob_revision";

export interface TreeOperation {
  opId: string;
  type: TreeOperationType;
  path?: string;
  entryId?: string;
  newPath?: string;
  hash?: string;
  sizeBytes?: number;
  mimeType?: string;
  preconditions?: OperationPreconditions;
}

export type OperationStatus = "applied" | "conflict" | "rejected";

export interface OperationResult {
  opId: string;
  status: OperationStatus;
  eventSeq?: number;
  reason?: string;
  entry?: FileEntry;
  serverEntry?: FileEntry;
  suggestedPath?: string;
}

export interface TreeSnapshot {
  workspace: Workspace;
  cursor: number;
  entries: FileEntry[];
}

export interface AuthPrincipal {
  user: User;
  device: DeviceSession;
  accessToken: AccessTokenRecord;
}

export interface CrdtTokenRecord {
  token: string;
  workspaceId: string;
  entryId: string;
  docId: string;
  userId: string;
  role: WorkspaceRole;
  expiresAt: string;
}

export interface BlobUploadTicketRecord {
  ticketId: string;
  workspaceId: string;
  entryId: string;
  userId: string;
  hash: string;
  sizeBytes: number;
  mimeType: string;
  expiresAt: string;
}

export interface BlobDownloadTicketRecord {
  ticketId: string;
  workspaceId: string;
  entryId: string;
  userId: string;
  hash: string;
  expiresAt: string;
}

export interface NotePresenceViewer {
  presenceId: string;
  userId: string;
  displayName: string;
  color: string | null;
  hasSelection: boolean;
}

export interface NotePresenceNoteSnapshot {
  entryId: string;
  viewers: NotePresenceViewer[];
}

export interface NotePresenceSnapshot {
  workspaceId: string;
  notes: NotePresenceNoteSnapshot[];
}

export interface NotePresenceUpdate {
  workspaceId: string;
  entryId: string;
  viewers: NotePresenceViewer[];
}
