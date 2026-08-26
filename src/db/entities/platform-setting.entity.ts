import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/**
 * Platform-wide settings as key/value rows, so a new setting is an insert rather than a
 * migration. `mode` is the first of them.
 *
 * There is deliberately no per-setting column and no typed union here: values are text, parsed
 * at the edge by whoever reads them, which is what lets an operational toggle be added without
 * touching this file.
 */
@Entity("platform_settings")
export class PlatformSettingEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index("platform_settings_key", { unique: true })
  @Column("text")
  key!: string;

  @Column("text")
  value!: string;

  /** For a write-once key such as `mode`, this is the moment it was burned in. */
  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;

  @Column("timestamptz", { name: "updated_at", transformer: isoTimestamp })
  updatedAt!: string;
}
