import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";

import { ERROR_STATUS, ManagerError, type ErrorCode, type ErrorEnvelope } from "../../errors";
import { logError, logWarn } from "../../observability/log";

/** Errors at or above this status indicate a fault here rather than a bad request. */
const SERVER_ERROR_THRESHOLD = 500;

/**
 * The single place an exception becomes a response. Anything that is not a ManagerError and not
 * a framework HttpException is treated as a bug: it is logged in full and reported as
 * INTERNAL_ERROR with a generic message, so an unexpected failure cannot leak internals
 * through the envelope.
 *
 * Framework exceptions — an unmatched route, an unsupported method — keep Nest's own body.
 * They describe a routing mistake rather than a domain outcome, so they carry no `ErrorCode`
 * for the gateway to branch on.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const { status, body, code } = toResponse(exception);

    const context = { method: request.method, path: request.path, code, err: exception };
    if (status >= SERVER_ERROR_THRESHOLD) {
      logError("request.failed", context);
    } else {
      logWarn("request.rejected", context);
    }

    response.status(status).json(body);
  }
}

function toResponse(err: unknown): { status: number; body: unknown; code: string } {
  if (err instanceof ManagerError) {
    return { status: err.status, body: err.toEnvelope(), code: err.code };
  }
  if (err instanceof HttpException) {
    return { status: err.getStatus(), body: err.getResponse(), code: err.name };
  }
  return {
    status: ERROR_STATUS.INTERNAL_ERROR,
    body: envelope("INTERNAL_ERROR", "Unexpected error"),
    code: "INTERNAL_ERROR",
  };
}

function envelope(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}
