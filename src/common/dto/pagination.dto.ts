import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

import { IsPageNumber } from "../validation/decorators";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The page window every list endpoint takes. The initializers cover an omitted parameter, which
 * class-transformer never runs a `@Transform` for.
 */
export class PaginationDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT })
  @IsPageNumber(DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT })
  limit: number = DEFAULT_LIMIT;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsPageNumber(0, { min: 0 })
  offset: number = 0;
}

/**
 * Pagination plus the keyset alternative to `offset`. A `cursor` is the `nextCursor` of the
 * previous page; when it is sent `offset` is ignored and `total` is not computed.
 */
export class CursorPaginationDto extends PaginationDto {
  @ApiPropertyOptional({
    description:
      "Resume after the page that returned this `nextCursor`. Stable while newer rows arrive, " +
      "unlike `offset`, which is deprecated. Omits `total` from the response.",
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
