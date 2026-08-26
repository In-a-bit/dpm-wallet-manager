import { Inject, Injectable } from "@nestjs/common";
import type { EntityManager, Repository } from "typeorm";

import { DB } from "../../tokens";
import type { Db, Executor } from "../client";
import { PlatformSettingEntity } from "../entities";

/**
 * Settings that may never be changed once written. `mode` decides, for every order this service
 * ever signs, whose funds are spent; flipping it on a running install would not migrate anything,
 * it would just start routing new orders differently from the ones already on the book.
 */
export const WRITE_ONCE_KEYS = new Set(["mode"]);

@Injectable()
export class PlatformSettingsRepository {
  private readonly settings: Repository<PlatformSettingEntity>;

  constructor(@Inject(DB) private readonly db: Db) {
    this.settings = db.getRepository(PlatformSettingEntity);
  }

  async get(key: string): Promise<string | undefined> {
    const row = await this.settings.findOneBy({ key });
    return row?.value;
  }

  async all(): Promise<Record<string, string>> {
    const rows = await this.settings.find({ order: { key: "ASC" } });
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  /**
   * Writes `value` only if `key` has never been written, and returns whatever the database
   * actually holds afterwards.
   *
   * This is what makes a write-once setting immutable without a column constraint a key/value
   * table cannot express: there is no code path that updates one. `ON CONFLICT DO NOTHING`
   * makes it safe for two replicas booting at the same instant — one insert wins, and both then
   * read the same winning value and compare it against their own environment.
   */
  async burnOnce(key: string, value: string, now: string): Promise<string> {
    await this.repo(this.db.manager)
      .createQueryBuilder()
      .insert()
      .values({ key, value, createdAt: now, updatedAt: now })
      .orIgnore()
      .execute();
    const stored = await this.get(key);
    if (stored === undefined) {
      throw new Error(`platform setting "${key}" vanished immediately after being written`);
    }
    return stored;
  }

  /**
   * Upserts an ordinary setting. Refuses a write-once key outright rather than letting the caller
   * decide, so a future settings endpoint cannot become a way to change the custody mode.
   */
  async set(key: string, value: string, now: string, executor?: Executor): Promise<void> {
    if (WRITE_ONCE_KEYS.has(key)) {
      throw new Error(`platform setting "${key}" is write-once and cannot be updated`);
    }
    await this.repo(executor)
      .createQueryBuilder()
      .insert()
      .values({ key, value, createdAt: now, updatedAt: now })
      .orUpdate(["value", "updated_at"], ["key"])
      .execute();
  }

  /** When the value was first written — the burn timestamp for a write-once key. */
  async writtenAt(key: string): Promise<string | undefined> {
    const row = await this.settings.findOneBy({ key });
    return row?.createdAt;
  }

  private repo(executor?: Executor): Repository<PlatformSettingEntity> {
    return executor ? executor.getRepository(PlatformSettingEntity) : this.settings;
  }
}

export type { EntityManager };
