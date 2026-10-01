import { Column, Entity, PrimaryColumn } from "typeorm";

import type { ApiKeyRole } from "./api-key.entity";
import { isoTimestamp } from "../iso-timestamp";

/** The roles a person signed in to the admin UI can hold. */
export const UI_USER_ROLES = ["owner", "operator", "viewer"] as const;
export type UiUserRole = (typeof UI_USER_ROLES)[number];

export const UI_USER_STATUSES = ["active", "disabled"] as const;
export type UiUserStatus = (typeof UI_USER_STATUSES)[number];

/**
 * What a signed-in person may do, expressed as the API role the guards already understand. A UI
 * user is never more powerful than an API key of the matching role.
 */
export const UI_ROLE_TO_API_ROLE: Record<UiUserRole, ApiKeyRole> = {
  owner: "admin",
  operator: "operator",
  viewer: "readonly",
};

/**
 * A person who signs in to the admin UI with a username and password.
 *
 * Usernames are unique case-insensitively (a functional index in the migration), so "Alice" and
 * "alice" cannot be two accounts an auditor has to tell apart. The password is stored only as a
 * scrypt hash; see `src/ui-users/password.ts`.
 */
@Entity("ui_users")
export class UiUserEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column("text")
  username!: string;

  /** `scrypt$<N>$<r>$<p>$<salt>$<hash>`, base64url salt and hash. */
  @Column("text", { name: "password_hash" })
  passwordHash!: string;

  @Column("text")
  role!: UiUserRole;

  @Column("text")
  status!: UiUserStatus;

  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;

  @Column("timestamptz", { name: "last_login_at", nullable: true, transformer: isoTimestamp })
  lastLoginAt!: string | null;

  /** Set when an API key created the account — the setup tool creating the first owner. */
  @Column("uuid", { name: "created_by_key_id", nullable: true })
  createdByKeyId!: string | null;

  @Column("uuid", { name: "created_by_user_id", nullable: true })
  createdByUserId!: string | null;
}
