import { ValidationPipe } from "@nestjs/common";
import type { ValidationError } from "class-validator";

import { validationFailed } from "../../errors";

/**
 * The single validation policy for the whole app.
 *
 * `whitelist` without `forbidNonWhitelisted` reproduces what the zod schemas did: an unknown
 * property is stripped, not rejected. Turning the rejection on would 400 requests that are
 * accepted today.
 *
 * Implicit conversion stays off because several fields are deliberately type-strict — an
 * order's `side` admits the numbers 0 and 1 but not the string "0". Anything that genuinely
 * arrives as text, such as a query-string page size, converts through its own `@Transform`.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors: ValidationError[]) =>
      validationFailed("Request validation failed", { issues: flatten(errors) }),
  });
}

type Issue = { path: string; message: string };

/**
 * Flattens class-validator's tree into the flat `path`/`message` pairs the error envelope has
 * always carried, with nested properties joined by dots the way zod reported them.
 */
function flatten(errors: ValidationError[], parentPath = ""): Issue[] {
  return errors.flatMap((error) => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({ path, message }));
    const nested = error.children?.length ? flatten(error.children, path) : [];
    return [...own, ...nested];
  });
}
