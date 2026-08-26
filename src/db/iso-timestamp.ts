import type { ValueTransformer } from "typeorm";

/**
 * Keeps `timestamptz` columns as ISO 8601 strings on both sides of the boundary.
 *
 * The service mints timestamps with `new Date().toISOString()` and the audit trail filters on
 * them as strings, which only holds for a single, explicit zone. Converting once here stops
 * `Date` objects the driver would otherwise hand back from reaching responses and comparisons,
 * where they would serialise differently and compare by reference.
 */
export const isoTimestamp: ValueTransformer = {
  to: (value: string) => value,
  from: (value: Date | string) => (value instanceof Date ? value.toISOString() : value),
};
