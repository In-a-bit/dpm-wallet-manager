import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import type { Actor } from "../common/actor";
import type { UiUserRole, UiUserStatus } from "../db/entities";
import { UiSessionRepository } from "../db/repositories/ui-session.repo";
import { UiUserRepository, type UiUser, type UiUserChanges } from "../db/repositories/ui-user.repo";
import { ManagerError } from "../errors";
import { AuditLog } from "../observability/audit";
import { AuditAction, AuditOutcome } from "../observability/audit-action";
import { assertPasswordAcceptable, hashPassword } from "./password";
import type { UiUserDto } from "./dto/ui-user.dto";

export type NewUiUser = { username: string; password: string; role: UiUserRole };
export type UiUserUpdate = { role?: UiUserRole; status?: UiUserStatus; password?: string };

/** Admin UI accounts. Only an owner (or an admin key) reaches any of this. */
@Injectable()
export class UiUsersService {
  constructor(
    private readonly users: UiUserRepository,
    private readonly sessions: UiSessionRepository,
    private readonly audit: AuditLog,
  ) {}

  async list(): Promise<UiUserDto[]> {
    return (await this.users.list()).map(toView);
  }

  async create(input: NewUiUser, actor: Actor): Promise<UiUserDto> {
    const username = input.username.trim();
    assertPasswordAcceptable(input.password);
    if (await this.users.findByUsername(username)) throw usernameTaken(username);
    const user = await this.insertUnique(username, {
      id: randomUUID(),
      username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      status: "active",
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      createdByKeyId: actor.keyId,
      createdByUserId: actor.userId,
    });
    await this.record(actor, AuditAction.UserCreate, {
      userId: user.id,
      username,
      role: user.role,
    });
    return toView(user);
  }

  /**
   * Changes role, status or password. Refuses anything that would leave no active owner, and
   * signs the user out everywhere when their password is reset or their account disabled.
   */
  async update(id: string, change: UiUserUpdate, actor: Actor): Promise<UiUserDto> {
    const changes = await toChanges(change);
    const updated = await this.users.updateGuarded(id, changes, (current, otherOwners) => {
      if (otherOwners === 0 && losesOwnership(current, changes)) {
        void this.recordDenied(actor, current);
        throw new ManagerError(
          "LAST_OWNER",
          "This is the last active owner; make another user an owner first",
        );
      }
    });
    if (!updated) throw userNotFound(id);
    if (changes.passwordHash || changes.status === "disabled") {
      await this.sessions.deleteForUser(id);
    }
    await this.record(actor, AuditAction.UserUpdate, {
      userId: id,
      username: updated.username,
      ...(change.role ? { role: change.role } : {}),
      ...(change.status ? { status: change.status } : {}),
      ...(change.password ? { passwordReset: true } : {}),
    });
    return toView(updated);
  }

  /**
   * The check above answers the common case with a clear message; this catches two requests for
   * the same name racing past it, which the case-insensitive unique index decides.
   */
  private async insertUnique(username: string, user: UiUser): Promise<UiUser> {
    try {
      return await this.users.insert(user);
    } catch (err) {
      if (isUniqueViolation(err)) throw usernameTaken(username);
      throw err;
    }
  }

  /** Whether any active owner exists — the setup tool's question before offering "Create your login". */
  async hasActiveOwner(): Promise<boolean> {
    return (await this.users.countActiveOwners()) > 0;
  }

  private record(
    actor: Actor,
    action: AuditAction,
    detail: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({ actor, action, outcome: AuditOutcome.Success, detail });
  }

  private recordDenied(actor: Actor, target: UiUser): Promise<void> {
    return this.audit.record({
      actor,
      action: AuditAction.UserUpdate,
      outcome: AuditOutcome.Denied,
      detail: { userId: target.id, username: target.username, reason: "LAST_OWNER" },
    });
  }
}

export function toView(user: UiUser): UiUserDto {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    createdByKeyId: user.createdByKeyId,
    createdByUserId: user.createdByUserId,
  };
}

async function toChanges(change: UiUserUpdate): Promise<UiUserChanges> {
  const changes: UiUserChanges = {};
  if (change.role) changes.role = change.role;
  if (change.status) changes.status = change.status;
  if (change.password !== undefined) {
    assertPasswordAcceptable(change.password);
    changes.passwordHash = await hashPassword(change.password);
  }
  return changes;
}

/** Whether applying `changes` takes an active owner out of that set. */
function losesOwnership(current: UiUser, changes: UiUserChanges): boolean {
  const isActiveOwner = current.role === "owner" && current.status === "active";
  const staysOwner = (changes.role ?? current.role) === "owner";
  const staysActive = (changes.status ?? current.status) === "active";
  return isActiveOwner && !(staysOwner && staysActive);
}

/** Postgres' unique-violation code, which a username race arrives as. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return [err, (err as { driverError?: unknown } | null)?.driverError].some(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { code?: unknown }).code === UNIQUE_VIOLATION,
  );
}

function usernameTaken(username: string): ManagerError {
  return new ManagerError("USERNAME_TAKEN", `The username "${username}" is already taken`);
}

function userNotFound(id: string): ManagerError {
  return new ManagerError("UI_USER_NOT_FOUND", `No admin UI user with id "${id}"`);
}
