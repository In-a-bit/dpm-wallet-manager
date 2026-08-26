import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";

import { ERROR_DESCRIPTIONS, ERROR_STATUS, type ErrorCode } from "../../errors";
import { ErrorResponseDto } from "../dto/error-response.dto";

/**
 * Documents the errors an endpoint can return, by naming their codes.
 *
 * The status and the description come from `errors.ts`, so a route says only *which* failures it
 * has — never what they mean or what they return. Several codes share a status (403 covers
 * `FORBIDDEN`, `EXTERNAL_TRANSFER_FORBIDDEN` and both master-wallet refusals), and OpenAPI allows
 * one response per status, so codes are grouped and listed together in that status' description.
 */
export function ApiErrors(...codes: ErrorCode[]) {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }

  return applyDecorators(
    ...[...byStatus.entries()]
      .sort(([left], [right]) => left - right)
      .map(([status, group]) =>
        ApiResponse({
          status,
          description: group
            .map((code) => `**\`${code}\`** — ${ERROR_DESCRIPTIONS[code]}`)
            .join("\n\n"),
          type: ErrorResponseDto,
        }),
      ),
  );
}
