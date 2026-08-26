import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional } from "class-validator";

import { IsLabel } from "../../common/validation/decorators";

export class CreatePlatformWalletDto {
  /** Defaults to "Master wallet" or "Operations wallet". Only ever cosmetic. */
  @ApiPropertyOptional({ maxLength: 200, example: "Treasury" })
  @IsOptional()
  @IsLabel()
  label?: string;
}
