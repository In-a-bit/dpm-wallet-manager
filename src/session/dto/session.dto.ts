import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";

import { API_KEY_ROLES, type ApiKeyRole } from "../../db/entities";
import { UiUserDto } from "../../ui-users/dto/ui-user.dto";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../../ui-users/password";

export class LoginDto {
  @ApiProperty({ maxLength: 64, example: "alice" })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username!: string;

  @ApiProperty({ maxLength: MAX_PASSWORD_LENGTH, example: "correct horse battery" })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ maxLength: MAX_PASSWORD_LENGTH, example: "correct horse battery" })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PASSWORD_LENGTH)
  currentPassword!: string;

  /** At least 12 characters. */
  @ApiProperty({
    minLength: MIN_PASSWORD_LENGTH,
    maxLength: MAX_PASSWORD_LENGTH,
    example: "a new long passphrase",
  })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  newPassword!: string;
}

/** Who is signed in, and what they may do. */
export class SessionDto {
  @ApiProperty({ type: UiUserDto })
  user!: UiUserDto;

  /** The API role the user's UI role maps to; the same roles API keys carry. */
  @ApiProperty({ enum: API_KEY_ROLES, example: "admin" })
  actorRole!: ApiKeyRole;

  /** When the session ends at the latest; it also ends after 8 idle hours. */
  @ApiProperty({ format: "date-time" })
  expiresAt!: string;
}

export class LoggedOutDto {
  @ApiProperty({ example: true })
  loggedOut!: boolean;
}

export class PasswordChangedDto {
  @ApiProperty({ example: true })
  changed!: boolean;
}
