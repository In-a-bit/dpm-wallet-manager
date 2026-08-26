import { Injectable } from "@nestjs/common";

import { AuditRepository, type AuditFilter, type AuditPage } from "../db/repositories/audit.repo";
import type { Actor } from "../common/actor";
import { logError, logInfo, redact } from "./log";
import type { AuditAction, AuditOutcome } from "./audit-action";

export type AuditRecord = {
  actor?: Actor | undefined;
  walletId?: string | null;
  action: AuditAction;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
  requestId?: string | null;
  ip?: string | null;
};

/**
 * The one writer of the audit trail. Every privileged action goes through here, allowed or
 * denied, so "what happened, who asked, and was it permitted" has a single answer.
 *
 * Details pass through the log redactor before they are stored: this table is readable over the
 * API, and an API key or a signature that reached a row could not be recalled.
 */
@Injectable()
export class AuditLog {
  constructor(private readonly events: AuditRepository) {}

  async record(record: AuditRecord): Promise<void> {
    const detail = record.detail ? (redact(record.detail) as Record<string, unknown>) : null;
    try {
      await this.events.insert({
        actorKeyId: record.actor?.keyId ?? null,
        actorRole: record.actor?.role ?? null,
        walletId: record.walletId ?? null,
        action: record.action,
        outcome: record.outcome,
        detail,
        requestId: record.requestId ?? null,
        ip: record.ip ?? null,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      // A failed audit write must not swallow the action's own result, but it must be loud: the
      // trail having a hole is itself the incident.
      logError("audit.write_failed", { action: record.action, err });
      return;
    }
    logInfo("audit", {
      action: record.action,
      outcome: record.outcome,
      actorKeyId: record.actor?.keyId,
      walletId: record.walletId,
      ...detail,
    });
  }

  query(filter: AuditFilter, limit: number, offset: number): Promise<AuditPage> {
    return this.events.query(filter, limit, offset);
  }
}
