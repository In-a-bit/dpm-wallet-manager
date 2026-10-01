import crypto, { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import type { Actor } from "../common/actor";
import { UI_ROLE_TO_API_ROLE } from "../db/entities";
import { UiSessionRepository, type UiSession } from "../db/repositories/ui-session.repo";
import { UiUserRepository, type UiUser } from "../db/repositories/ui-user.repo";
import { ManagerError, unauthorized, validationFailed } from "../errors";
import { AuditLog } from "../observability/audit";
import { AuditAction, AuditOutcome } from "../observability/audit-action";
import {
  assertPasswordAcceptable,
  burnPasswordCheck,
  hashPassword,
  verifyPassword,
} from "../ui-users/password";
import { LoginThrottle } from "./login-throttle";

/** A session ends this long after its last request. */
export const IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
/** And this long after sign-in, however active it is. */
export const ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most this often, so the hot path is not a write path. */
const TOUCH_INTERVAL_MS = 60 * 1000;
const TOKEN_BYTES = 32;

export type RequestContext = { ip: string | null; userAgent: string | null };

export type SignedIn = { token: string; session: UiSession; user: UiUser };

/**
 * Admin UI sign-in. A session is a random token in an HttpOnly cookie, stored here only as its
 * SHA-256, and checked against the database on every request — so disabling a user or changing a
 * password takes effect on their very next click.
 */
@Injectable()
export class SessionService {
  private readonly throttle = new LoginThrottle();

  constructor(
    private readonly users: UiUserRepository,
    private readonly sessions: UiSessionRepository,
    private readonly audit: AuditLog,
  ) {}

  async login(username: string, password: string, context: RequestContext): Promise<SignedIn> {
    this.assertNotLockedOut(username, context.ip);
    const user = await this.checkCredentials(username, password);
    if (!user) {
      this.throttle.recordFailure(username, context.ip);
      await this.recordLogin(undefined, AuditOutcome.Denied, { username }, context);
      throw unauthorized("Wrong username or password");
    }
    this.throttle.recordSuccess(username, context.ip);
    const signedIn = await this.open(user, context);
    await this.recordLogin(toActor(user), AuditOutcome.Success, {}, context);
    return signedIn;
  }

  /** The user and session behind a cookie token, or undefined when it no longer signs anyone in. */
  async authenticate(token: string): Promise<{ user: UiUser; session: UiSession } | undefined> {
    const session = await this.sessions.findByTokenHash(hashToken(token));
    if (!session) return undefined;
    const now = Date.now();
    if (isExpired(session, now)) {
      await this.sessions.delete(session.id);
      return undefined;
    }
    const user = await this.users.findById(session.userId);
    if (!user || user.status !== "active") {
      await this.sessions.delete(session.id);
      return undefined;
    }
    if (now - Date.parse(session.lastSeenAt) > TOUCH_INTERVAL_MS) {
      void this.sessions.touch(session.id, new Date(now).toISOString()).catch(() => undefined);
    }
    return { user, session };
  }

  async logout(token: string, context: RequestContext): Promise<void> {
    const found = await this.authenticate(token);
    if (!found) return;
    await this.sessions.delete(found.session.id);
    await this.audit.record({
      actor: toActor(found.user),
      action: AuditAction.SessionLogout,
      outcome: AuditOutcome.Success,
      ip: context.ip,
    });
  }

  /**
   * Changes the signed-in user's own password, and signs out every other browser they have — the
   * usual reason to change a password is believing someone else knows it.
   */
  async changePassword(
    actor: Actor,
    sessionToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const found = await this.authenticate(sessionToken);
    if (!found || found.user.id !== actor.userId) throw unauthorized("Sign in again");
    if (!(await verifyPassword(currentPassword, found.user.passwordHash))) {
      throw validationFailed("The current password is not right");
    }
    assertPasswordAcceptable(newPassword);
    await this.users.setPasswordHash(found.user.id, await hashPassword(newPassword));
    await this.sessions.deleteForUser(found.user.id, found.session.id);
    await this.audit.record({
      actor,
      action: AuditAction.SessionPassword,
      outcome: AuditOutcome.Success,
    });
  }

  /** Called when an account is disabled or its password reset by an owner. */
  endAllSessions(userId: string): Promise<void> {
    return this.sessions.deleteForUser(userId);
  }

  purgeExpired(): Promise<number> {
    return this.sessions.purgeExpired(new Date().toISOString());
  }

  private assertNotLockedOut(username: string, ip: string | null): void {
    const waitMs = this.throttle.retryAfterMs(username, ip);
    if (waitMs === 0) return;
    throw new ManagerError(
      "RATE_LIMITED",
      `Too many failed sign-ins. Try again in ${Math.ceil(waitMs / 60_000)} minutes.`,
    );
  }

  /**
   * The user, or undefined for any reason a sign-in fails. Every failure takes the same time and
   * gives the same answer, so a guesser cannot learn which usernames exist.
   */
  private async checkCredentials(username: string, password: string): Promise<UiUser | undefined> {
    const user = await this.users.findByUsername(username.trim());
    if (!user) {
      await burnPasswordCheck(password);
      return undefined;
    }
    const valid = await verifyPassword(password, user.passwordHash);
    return valid && user.status === "active" ? user : undefined;
  }

  private async open(user: UiUser, context: RequestContext): Promise<SignedIn> {
    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const now = new Date();
    const session: UiSession = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      userId: user.id,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS).toISOString(),
      ip: context.ip,
      userAgent: context.userAgent?.slice(0, 300) ?? null,
    };
    await this.sessions.insert(session);
    await this.users.recordLogin(user.id, now.toISOString());
    return { token, session, user: { ...user, lastLoginAt: now.toISOString() } };
  }

  private recordLogin(
    actor: Actor | undefined,
    outcome: AuditOutcome,
    detail: Record<string, unknown>,
    context: RequestContext,
  ): Promise<void> {
    return this.audit.record({
      actor,
      action: AuditAction.SessionLogin,
      outcome,
      detail,
      ip: context.ip,
    });
  }
}

/** The actor a signed-in user acts as: their UI role mapped onto the API roles the guards know. */
export function toActor(user: UiUser): Actor {
  return {
    keyId: null,
    userId: user.id,
    username: user.username,
    role: UI_ROLE_TO_API_ROLE[user.role],
    prefix: `user:${user.username}`,
    name: user.username,
  };
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isExpired(session: UiSession, now: number): boolean {
  return (
    now >= Date.parse(session.expiresAt) || now - Date.parse(session.lastSeenAt) >= IDLE_TIMEOUT_MS
  );
}
