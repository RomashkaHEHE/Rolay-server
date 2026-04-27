import { Client } from "pg";

import { AppEnv } from "../config/env";
import { MemoryState, MemoryStateSnapshot } from "./memory-state";

export interface StateStore {
  loadState(): Promise<MemoryState>;
  saveState(state: MemoryState): Promise<void>;
  close(): Promise<void>;
}

class MemoryStateStore implements StateStore {
  async loadState(): Promise<MemoryState> {
    return new MemoryState();
  }

  async saveState(_state: MemoryState): Promise<void> {}

  async close(): Promise<void> {}
}

class PostgresStateStore implements StateStore {
  private readonly client: Client;
  private readyPromise: Promise<void> | undefined;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private readonly env: AppEnv) {
    if (!env.postgresUrl) {
      throw new Error("POSTGRES_URL is required when STATE_DRIVER=postgres.");
    }

    this.client = new Client({
      connectionString: env.postgresUrl
    });
  }

  async loadState(): Promise<MemoryState> {
    await this.ensureReady();
    const result = await this.client.query<{ payload: MemoryStateSnapshot | string }>(
      `
        SELECT payload
        FROM rolay_state_snapshots
        WHERE state_key = $1
      `,
      [this.env.postgresStateKey]
    );

    const payload = result.rows[0]?.payload;
    if (!payload) {
      return new MemoryState();
    }

    const snapshot =
      typeof payload === "string"
        ? (JSON.parse(payload) as MemoryStateSnapshot)
        : payload;

    return MemoryState.fromSnapshot(snapshot);
  }

  async saveState(state: MemoryState): Promise<void> {
    const snapshot = state.toSnapshot();
    const payload = JSON.stringify(snapshot);

    const operation = this.saveChain.then(async () => {
      await this.ensureReady();
      // v1 intentionally persists one canonical snapshot row per deployment key. This keeps the
      // operational model simple for a single small server at the cost of relational query power.
      await this.client.query(
        `
          INSERT INTO rolay_state_snapshots (state_key, version, payload, updated_at)
          VALUES ($1, $2, $3::jsonb, NOW())
          ON CONFLICT (state_key)
          DO UPDATE SET
            version = EXCLUDED.version,
            payload = EXCLUDED.payload,
            updated_at = NOW()
        `,
        [this.env.postgresStateKey, snapshot.version, payload]
      );
    });

    this.saveChain = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    await this.saveChain.catch(() => undefined);

    if (!this.readyPromise) {
      return;
    }

    await this.readyPromise.catch(() => undefined);
    this.readyPromise = undefined;
    await this.client.end();
  }

  private async ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.initialize();
    }

    await this.readyPromise;
  }

  private async initialize(): Promise<void> {
    await this.client.connect();
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS rolay_state_snapshots (
        state_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
}

export function createStateStore(env: AppEnv): StateStore {
  if (env.stateDriver === "postgres") {
    return new PostgresStateStore(env);
  }

  return new MemoryStateStore();
}
