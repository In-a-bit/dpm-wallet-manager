import { applyDecorators, SetMetadata } from "@nestjs/common";

import type { ApiKeyRole } from "../../db/entities";
import { ApiErrors } from "./api-errors.decorator";

export const ROLES_KEY = "dpmm:roles";

/**
 * Restricts a route to a role. `admin` is a superset of `operator`, so `@Roles("operator")`
 * admits both and `@Roles("admin")` admits only admin keys.
 *
 * Absent, a route admits any authenticated key — which is the right default for reads.
 *
 * It also documents the 403 it can cause, so the enforcement and its OpenAPI description cannot
 * drift apart: a route that gains a role restriction gains the documented failure with it.
 */
export const Roles = (...roles: ApiKeyRole[]) =>
  applyDecorators(SetMetadata(ROLES_KEY, roles), ApiErrors("FORBIDDEN"));
