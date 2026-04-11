import { cloneValue } from "../core/clone";
import {
  SettingsEvent,
  SettingsEventScope,
  StoredSettingsEvent,
  User,
  WorkspaceRole
} from "../domain/types";
import { MemoryState, SettingsEventListener, StoredWorkspace } from "./memory-state";

export interface SettingsEventStreamHandle {
  initialEvents: SettingsEvent[];
  unsubscribe: () => void;
}

interface ManagedUserRecord {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  globalRole: User["globalRole"];
  createdAt: string;
  disabledAt?: string;
}

interface RoomListItem {
  workspace: {
    id: string;
    name: string;
  };
  membershipRole: WorkspaceRole;
  createdAt: string;
  memberCount: number;
  inviteEnabled: boolean;
}

interface AdminRoomListItem extends RoomListItem {
  ownerCount: number;
}

interface RoomMemberRecord {
  user: User;
  role: WorkspaceRole;
  joinedAt: string;
}

interface InviteView {
  workspaceId: string;
  code: string;
  enabled: boolean;
  updatedAt: string;
}

interface PublishEventInput {
  type: string;
  scope: SettingsEventScope;
  payload: Record<string, unknown>;
  targetUserIds?: string[];
  includeAdmins?: boolean;
}

function isAdmin(user: User): boolean {
  return user.isAdmin && user.globalRole === "admin";
}

export class SettingsEventsService {
  constructor(private readonly state: MemoryState) {}

  currentCursor(): number {
    return this.state.nextSettingsEventId - 1;
  }

  listEventsSince(actor: User, cursor: number): SettingsEvent[] {
    return this.state.settingsEvents
      .filter((event) => event.eventId > cursor)
      .filter((event) => this.isVisible(event, actor))
      .map((event) => this.toPublicEvent(event));
  }

  openStream(
    actor: User,
    cursor: number | undefined,
    listener: (event: SettingsEvent) => void
  ): SettingsEventStreamHandle {
    // This SSE stream is for settings/admin UI, not for room tree sync. Its payloads are already
    // shaped like UI snapshots so clients can patch stores directly without refetching by default.
    const wrappedListener: SettingsEventListener = (event) => {
      if (!this.isVisible(event, actor)) {
        return;
      }

      listener(this.toPublicEvent(event));
    };

    this.state.settingsListeners.add(wrappedListener);
    return {
      initialEvents:
        cursor === undefined ? [] : this.listEventsSince(actor, cursor),
      unsubscribe: () => {
        this.state.settingsListeners.delete(wrappedListener);
      }
    };
  }

  publishAuthMeUpdated(userId: string): void {
    const user = this.state.users.get(userId);
    if (!user || user.disabledAt) {
      return;
    }

    this.publishEvent({
      type: "auth.me.updated",
      scope: "auth.me",
      payload: {
        user: this.toUser(user)
      },
      targetUserIds: [userId]
    });
  }

  publishAdminUserCreated(userId: string): void {
    const user = this.state.users.get(userId);
    if (!user || user.disabledAt) {
      return;
    }

    this.publishEvent({
      type: "admin.user.created",
      scope: "admin.users",
      payload: {
        user: this.toManagedUser(user)
      },
      includeAdmins: true
    });
  }

  publishAdminUserUpdated(userId: string): void {
    const user = this.state.users.get(userId);
    if (!user || user.disabledAt) {
      return;
    }

    this.publishEvent({
      type: "admin.user.updated",
      scope: "admin.users",
      payload: {
        user: this.toManagedUser(user)
      },
      includeAdmins: true
    });
  }

  publishAdminUserDeleted(user: {
    id: string;
    username: string;
    displayName: string;
    isAdmin: boolean;
    globalRole: User["globalRole"];
    createdAt: string;
    disabledAt?: string;
  }): void {
    this.publishEvent({
      type: "admin.user.deleted",
      scope: "admin.users",
      payload: {
        userId: user.id
      },
      includeAdmins: true
    });
  }

  publishRoomCreated(workspaceId: string): void {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace) {
      return;
    }

    for (const membership of workspace.memberships.values()) {
      const member = this.state.users.get(membership.userId);
      if (!member || member.disabledAt || isAdmin(member)) {
        continue;
      }

      this.publishEvent({
        type: "room.created",
        scope: "rooms",
        payload: {
          room: this.toUserRoomListItem(workspace, member.id)
        },
        targetUserIds: [member.id]
      });
    }

    this.publishAdminRoomEvent("room.created", workspace);
  }

  publishRoomUpdated(workspaceId: string): void {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace) {
      return;
    }

    for (const membership of workspace.memberships.values()) {
      const member = this.state.users.get(membership.userId);
      if (!member || member.disabledAt || isAdmin(member)) {
        continue;
      }

      this.publishEvent({
        type: "room.updated",
        scope: "rooms",
        payload: {
          room: this.toUserRoomListItem(workspace, member.id)
        },
        targetUserIds: [member.id]
      });
    }

    this.publishAdminRoomEvent("room.updated", workspace);
  }

  publishRoomDeleted(workspace: StoredWorkspace): void {
    const memberUserIds = [...workspace.memberships.keys()];

    for (const userId of memberUserIds) {
      const member = this.state.users.get(userId);
      if (!member || member.disabledAt || isAdmin(member)) {
        continue;
      }

      this.publishEvent({
        type: "room.deleted",
        scope: "rooms",
        payload: {
          workspaceId: workspace.workspace.id
        },
        targetUserIds: [userId]
      });
    }

    this.publishEvent({
      type: "room.deleted",
      scope: "admin.rooms",
      payload: {
        workspaceId: workspace.workspace.id
      },
      includeAdmins: true
    });
  }

  publishRoomMembershipChanged(
    workspaceId: string,
    userId: string,
    membershipRole: WorkspaceRole | null
  ): void {
    const workspace = this.state.workspaces.get(workspaceId);
    const room =
      workspace && membershipRole !== null
        ? this.toUserRoomListItem(workspace, userId)
        : null;

    this.publishEvent({
      type: "room.membership.changed",
      scope: "rooms",
      payload: {
        workspaceId,
        userId,
        membershipRole,
        room
      },
      targetUserIds: [userId]
    });
  }

  publishRoomInviteUpdated(workspaceId: string): void {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace) {
      return;
    }

    const ownerIds = [...workspace.memberships.values()]
      .filter((membership) => membership.role === "owner")
      .map((membership) => membership.userId);

    this.publishEvent({
      type: "room.invite.updated",
      scope: "room.invite",
      payload: {
        invite: this.toInviteView(workspace)
      },
      targetUserIds: ownerIds,
      includeAdmins: true
    });
  }

  publishRoomMembersUpdated(workspaceId: string): void {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace) {
      return;
    }

    // Room members UI benefits from full snapshots here: the client can replace the visible list
    // directly instead of replaying join/leave diffs and worrying about missed intermediate events.
    this.publishEvent({
      type: "room.members.updated",
      scope: "room.members",
      payload: {
        workspaceId,
        members: this.toRoomMembers(workspace)
      },
      targetUserIds: [...workspace.memberships.keys()]
    });
  }

  publishAdminRoomMembersUpdated(workspaceId: string): void {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace) {
      return;
    }

    this.publishEvent({
      type: "admin.room.members.updated",
      scope: "admin.room.members",
      payload: {
        workspaceId,
        members: this.toRoomMembers(workspace)
      },
      includeAdmins: true
    });
  }

  private publishAdminRoomEvent(type: "room.created" | "room.updated", workspace: StoredWorkspace): void {
    this.publishEvent({
      type,
      scope: "admin.rooms",
      payload: {
        room: this.toAdminRoomListItem(workspace)
      },
      includeAdmins: true
    });
  }

  private publishEvent(input: PublishEventInput): number {
    // Settings events have their own global cursor space. Do not mix these IDs with workspace
    // event seq values from /v1/workspaces/{workspaceId}/events.
    const event: StoredSettingsEvent = {
      eventId: this.state.nextSettingsEventId,
      type: input.type,
      occurredAt: new Date().toISOString(),
      scope: input.scope,
      payload: input.payload,
      targetUserIds: [...(input.targetUserIds ?? [])],
      includeAdmins: Boolean(input.includeAdmins)
    };

    this.state.nextSettingsEventId += 1;
    this.state.settingsEvents.push(event);

    for (const listener of this.state.settingsListeners) {
      listener(cloneValue(event));
    }

    return event.eventId;
  }

  private isVisible(event: StoredSettingsEvent, actor: User): boolean {
    if (event.targetUserIds.includes(actor.id)) {
      return true;
    }

    return event.includeAdmins && isAdmin(actor);
  }

  private toPublicEvent(event: StoredSettingsEvent): SettingsEvent {
    return {
      eventId: event.eventId,
      type: event.type,
      occurredAt: event.occurredAt,
      scope: event.scope,
      payload: cloneValue(event.payload)
    };
  }

  private toUserRoomListItem(workspace: StoredWorkspace, userId: string): RoomListItem {
    const membership = workspace.memberships.get(userId);
    if (!membership) {
      throw new Error("Corrupted settings event state: missing membership.");
    }

    return {
      workspace: cloneValue(workspace.workspace),
      membershipRole: membership.role,
      createdAt: workspace.createdAt,
      memberCount: workspace.memberships.size,
      inviteEnabled: workspace.invite.enabled
    };
  }

  private toAdminRoomListItem(workspace: StoredWorkspace): AdminRoomListItem {
    return {
      workspace: cloneValue(workspace.workspace),
      membershipRole: workspace.memberships.get(workspace.createdBy)?.role ?? "owner",
      createdAt: workspace.createdAt,
      memberCount: workspace.memberships.size,
      inviteEnabled: workspace.invite.enabled,
      ownerCount: [...workspace.memberships.values()].filter(
        (membership) => membership.role === "owner"
      ).length
    };
  }

  private toInviteView(workspace: StoredWorkspace): InviteView {
    return {
      workspaceId: workspace.workspace.id,
      code: workspace.invite.code,
      enabled: workspace.invite.enabled,
      updatedAt: workspace.invite.updatedAt
    };
  }

  private toRoomMembers(workspace: StoredWorkspace): RoomMemberRecord[] {
    return [...workspace.memberships.values()]
      .map((membership) => {
        const user = this.state.users.get(membership.userId);
        if (!user || user.disabledAt) {
          throw new Error("Corrupted settings event state: missing workspace user.");
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

  private toManagedUser(user: {
    id: string;
    username: string;
    displayName: string;
    isAdmin: boolean;
    globalRole: User["globalRole"];
    createdAt: string;
    disabledAt?: string;
  }): ManagedUserRecord {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
      globalRole: user.globalRole,
      createdAt: user.createdAt,
      ...(user.disabledAt !== undefined ? { disabledAt: user.disabledAt } : {})
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
