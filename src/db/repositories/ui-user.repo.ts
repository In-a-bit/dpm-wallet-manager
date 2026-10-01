import { Inject, Injectable } from "@nestjs/common";
import type { Repository } from "typeorm";

import { DB } from "../../tokens";
import type { Db, Executor } from "../client";
import { UiUserEntity, type UiUserRole, type UiUserStatus } from "../entities";

export type UiUser = UiUserEntity;

export type UiUserChanges = Partial<Pick<UiUser, "role" | "status" | "passwordHash">>;

/**
 * Serialises every change that could leave the install without an active owner, so two owners
 * demoting each other at the same moment cannot both pass the "someone else is still an owner"
 * check. Transaction-scoped: released at commit or rollback.
 */
const OWNER_LOCK = "SELECT pg_advisory_xact_lock(hashtext('dpmm.ui_users.owner'))";

@Injectable()
export class UiUserRepository {
  private readonly users: Repository<UiUserEntity>;

  constructor(@Inject(DB) private readonly db: Db) {
    this.users = db.getRepository(UiUserEntity);
  }

  async insert(user: UiUser): Promise<UiUser> {
    await this.users.insert(user);
    return user;
  }

  findById(id: string): Promise<UiUser | null> {
    return this.users.findOneBy({ id });
  }

  findByUsername(username: string): Promise<UiUser | null> {
    return this.users
      .createQueryBuilder("u")
      .where("lower(u.username) = lower(:username)", { username })
      .getOne();
  }

  list(): Promise<UiUser[]> {
    return this.users.find({ order: { createdAt: "ASC" } });
  }

  countActiveOwners(executor: Executor = this.db.manager): Promise<number> {
    return executor.getRepository(UiUserEntity).countBy({ role: "owner", status: "active" });
  }

  async setPasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.users.update({ id }, { passwordHash });
  }

  async recordLogin(id: string, at: string): Promise<void> {
    await this.users.update({ id }, { lastLoginAt: at });
  }

  /**
   * Applies `changes` unless `allowed` says no, inside the owner lock. `allowed` sees the row as
   * it is now and the number of other active owners, which is what the last-owner rule needs.
   */
  updateGuarded(
    id: string,
    changes: UiUserChanges,
    allowed: (current: UiUser, otherActiveOwners: number) => void,
  ): Promise<UiUser | null> {
    return this.db.transaction(async (tx) => {
      await tx.query(OWNER_LOCK);
      const repo = tx.getRepository(UiUserEntity);
      const current = await repo.findOneBy({ id });
      if (!current) return null;
      const owners = await this.countActiveOwners(tx);
      const isActiveOwner = current.role === "owner" && current.status === "active";
      allowed(current, owners - (isActiveOwner ? 1 : 0));
      await repo.update({ id }, changes);
      return { ...current, ...changes };
    });
  }
}

export type { UiUserRole, UiUserStatus };
