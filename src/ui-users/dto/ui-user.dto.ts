import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

import { IsUsername } from "../../common/validation/decorators";
import {
  UI_USER_ROLES,
  UI_USER_STATUSES,
  type UiUserRole,
  type UiUserStatus,
} from "../../db/entities";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../password";

/**
 * A person who signs in to the admin UI. `owner` acts as an admin key, `operator` as an operator
 * key, and `viewer` as a readonly key.
 */
export class UiUserDto {
  @ApiProperty({ format: "uuid", example: "5d3b8a3e-1c2f-4d5e-9a6b-7c8d9e0f1a2b" })
  id!: string;

  @ApiProperty({ example: "alice" })
  username!: string;

  @ApiProperty({ enum: UI_USER_ROLES, example: "owner" })
  role!: UiUserRole;

  /** A disabled user cannot sign in, and is signed out the moment they are disabled. */
  @ApiProperty({ enum: UI_USER_STATUSES, example: "active" })
  status!: UiUserStatus;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  lastLoginAt!: string | null;

  /** The API key that created the account — the setup tool, for the first owner. */
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  createdByKeyId!: string | null;

  /** The admin UI user who created the account, when one did. */
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  createdByUserId!: string | null;
}

export class UiUserPageDto {
  @ApiProperty({ type: [UiUserDto] })
  items!: UiUserDto[];

  @ApiProperty({ example: 2 })
  total!: number;
}

export class CreateUiUserDto {
  /** Unique, case-insensitively. 3-64 letters, digits, `.`, `_`, `-` or `@`. */
  @ApiProperty({ pattern: "^[A-Za-z0-9._@-]{3,64}$", example: "alice" })
  @IsUsername()
  username!: string;

  /** At least 12 characters. Stored only as a scrypt hash. */
  @ApiProperty({
    minLength: MIN_PASSWORD_LENGTH,
    maxLength: MAX_PASSWORD_LENGTH,
    example: "correct horse battery",
  })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;

  @ApiProperty({ enum: UI_USER_ROLES, example: "viewer" })
  @IsIn([...UI_USER_ROLES])
  role!: UiUserRole;
}

export class UpdateUiUserDto {
  @ApiPropertyOptional({ enum: UI_USER_ROLES, example: "operator" })
  @IsOptional()
  @IsIn([...UI_USER_ROLES])
  role?: UiUserRole;

  /** `disabled` signs the user out everywhere and stops them signing in. */
  @ApiPropertyOptional({ enum: UI_USER_STATUSES, example: "disabled" })
  @IsOptional()
  @IsIn([...UI_USER_STATUSES])
  status?: UiUserStatus;

  /** A new password, set by an owner. Signs the user out everywhere. */
  @ApiPropertyOptional({
    minLength: MIN_PASSWORD_LENGTH,
    maxLength: MAX_PASSWORD_LENGTH,
    example: "a new long passphrase",
  })
  @IsOptional()
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  password?: string;
}
