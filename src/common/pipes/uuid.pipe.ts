import { Injectable, type PipeTransform } from "@nestjs/common";

import { validationFailed } from "../../errors";

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Validates a path parameter that is an id.
 *
 * Without it a malformed id reaches a `uuid`-typed column and Postgres raises a syntax error,
 * which surfaces as a 500. A caller's typo is a 400.
 */
@Injectable()
export class IsUuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!UUID.test(value.trim())) throw validationFailed(`"${value}" is not a valid id`);
    return value.trim().toLowerCase();
  }
}
