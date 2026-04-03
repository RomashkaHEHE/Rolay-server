import { AppEnv } from "../config/env";
import { AuthService } from "../services/auth-service";
import { FileService } from "../services/file-service";
import { MemoryState } from "../services/memory-state";
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
  storage: StorageService;
}

export async function createRolayContext(env: AppEnv): Promise<RolayContext> {
  const stateStore = createStateStore(env);
  const state = await stateStore.loadState();
  const storage = new StorageService(env);
  const auth = new AuthService(state, env, stateStore);
  const workspaces = new WorkspaceService(state, stateStore);
  const files = new FileService(state, env, storage, stateStore);

  await auth.ensureReady();

  return {
    env,
    state,
    stateStore,
    auth,
    workspaces,
    files,
    storage
  };
}

declare module "fastify" {
  interface FastifyInstance {
    rolay: RolayContext;
  }
}
