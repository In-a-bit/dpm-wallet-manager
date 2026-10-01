import { Inject, Injectable } from "@nestjs/common";
import { LessThan, Not, type Repository } from "typeorm";

import { DB } from "../../tokens";
import type { Db } from "../client";
import { UiSessionEntity } from "../entities";

export type UiSession = UiSessionEntity;

@Injectable()
export class UiSessionRepository {
  private readonly sessions: Repository<UiSessionEntity>;

  constructor(@Inject(DB) db: Db) {
    this.sessions = db.getRepository(UiSessionEntity);
  }

  async insert(session: UiSession): Promise<void> {
    await this.sessions.insert(session);
  }

  findByTokenHash(tokenHash: string): Promise<UiSession | null> {
    return this.sessions.findOneBy({ tokenHash });
  }

  async touch(id: string, at: string): Promise<void> {
    await this.sessions.update({ id }, { lastSeenAt: at });
  }

  async delete(id: string): Promise<void> {
    await this.sessions.delete({ id });
  }

  /** Every session of one user; with `keep`, all but that one (the browser changing a password). */
  async deleteForUser(userId: string, keep?: string): Promise<void> {
    await this.sessions.delete(keep ? { userId, id: Not(keep) } : { userId });
  }

  /** Housekeeping at boot; an expired row is already refused, this only keeps the table small. */
  async purgeExpired(now: string): Promise<number> {
    const result = await this.sessions.delete({ expiresAt: LessThan(now) });
    return result.affected ?? 0;
  }
}
