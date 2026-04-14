import { AppEnv } from "../config/env";
import { AuthService } from "../services/auth-service";
import { DrawingService } from "../services/drawing-service";
import { FileService } from "../services/file-service";
import { MemoryState } from "../services/memory-state";
import { NotePresenceService } from "../services/note-presence-service";
import { SettingsEventsService } from "../services/settings-events-service";
import { createStateStore, StateStore } from "../services/state-store";
import { StorageService } from "../services/storage-service";
import { WorkspaceService } from "../services/workspace-service";

export interface RolayContext {
  env: AppEnv;
  state: MemoryState;
  stateStore: StateStore;
  auth: AuthService;
  workspaces: WorkspaceService;
  files: FileService;
  drawings: DrawingService;
  settingsEvents: SettingsEventsService;
  notePresence: NotePresenceService;
  storage: StorageService;
}

export async function createRolayContext(env: AppEnv): Promise<RolayContext> {
  const stateStore = createStateStore(env);
  const state = await stateStore.loadState();
  const storage = new StorageService(env);
  const settingsEvents = new SettingsEventsService(state);
  const notePresence = new NotePresenceService(state);
  const auth = new AuthService(state, env, stateStore, settingsEvents);
  const workspaces = new WorkspaceService(state, stateStore, settingsEvents);
  const files = new FileService(state, env, storage, stateStore);
  const drawings = new DrawingService(state, env, storage);

  await auth.ensureReady();

  return {
    env,
    state,
    stateStore,
    auth,
    workspaces,
    files,
    drawings,
    settingsEvents,
    notePresence,
    storage
  };
}

declare module "fastify" {
  interface FastifyInstance {
    rolay: RolayContext;
  }
}
