import { applyDecorators } from "@nestjs/common";
import { Transform, type TransformFnParams } from "class-transformer";
import {
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  registerDecorator,
  type ValidationOptions,
} from "class-validator";
import { getAddress, isAddress } from "viem";

/**
 * The validation vocabulary shared across the DTOs, kept deliberately identical to dpm-wallet's
 * (`src/common/validation/decorators.ts`) so a value this service accepts is a value the upstream
 * accepts. Several of these normalise as well as check, and the handlers depend on the normalised
 * form — an address reaches a policy comparison already checksummed, for instance.
 */

const DECIMAL_AMOUNT = /^\d+(\.\d{1,18})?$/;
const CONDITION_ID = /^0x[0-9a-fA-F]{64}$/;
const ORDER_HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_DIGITS = /^\d+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(([+-]\d{2}(:?\d{2})?)|Z)$/;

const EXTERNAL_ID_MAX_LENGTH = 128;
const LABEL_MAX_LENGTH = 200;

/**
 * Accepts any casing and normalises to a checksummed address, so a handler never has to think
 * about which form the caller sent. An unparseable value is left alone for the validator to
 * report rather than blowing up inside `getAddress`.
 */
export function IsEvmAddress(options?: ValidationOptions) {
  return applyDecorators(
    transformValue((value) => (isParseableAddress(value) ? getAddress(value) : value)),
    customValidator("isEvmAddress", isParseableAddress, "must be a 20-byte hex address", options),
  );
}

/** Strips surrounding whitespace, so a stray space cannot fork an identifier. */
export function Trimmed() {
  return transformValue(trimmed);
}

export function IsUuid(options?: ValidationOptions) {
  return applyDecorators(
    Trimmed(),
    IsString(options),
    Matches(UUID, { message: "must be a UUID", ...options }),
  );
}

/** The caller's own identifier for a wallet. */
export function IsExternalId(options?: ValidationOptions) {
  return applyDecorators(
    Trimmed(),
    IsString(options),
    MinLength(1, options),
    MaxLength(EXTERNAL_ID_MAX_LENGTH, options),
  );
}

export function IsLabel(options?: ValidationOptions) {
  return applyDecorators(
    Trimmed(),
    IsString(options),
    MinLength(1, options),
    MaxLength(LABEL_MAX_LENGTH, options),
  );
}

/** A USDC-style decimal amount, e.g. "10" or "10.25". Range checks belong to the SDK upstream. */
export function IsDecimalAmount(options?: ValidationOptions) {
  return applyDecorators(
    Trimmed(),
    IsString(options),
    Matches(DECIMAL_AMOUNT, { message: "must be a positive decimal amount", ...options }),
  );
}

export function IsConditionId(options?: ValidationOptions) {
  return applyDecorators(
    IsString(options),
    Matches(CONDITION_ID, { message: "must be a 32-byte hex condition id", ...options }),
  );
}

export function IsOrderHash(options?: ValidationOptions) {
  return applyDecorators(
    IsString(options),
    Matches(ORDER_HASH, { message: "must be a 32-byte hex order hash", ...options }),
  );
}

export function IsCtfTokenId(options?: ValidationOptions) {
  return applyDecorators(
    Trimmed(),
    IsString(options),
    Matches(DECIMAL_DIGITS, { message: "must be a decimal CTF token id", ...options }),
  );
}

export function IsIsoTimestamp(options?: ValidationOptions) {
  return applyDecorators(
    Trimmed(),
    IsString(options),
    Matches(ISO_TIMESTAMP, { message: "must be an ISO 8601 timestamp with an offset", ...options }),
  );
}

/**
 * A page size or offset arriving as a query string.
 *
 * An omitted parameter is covered by the property's own initializer, because class-transformer
 * only runs a `@Transform` for keys the request actually carried. `defaultValue` here catches the
 * empty-string case, `?limit=`, which does arrive as a key.
 */
export function IsPageNumber(
  defaultValue: number,
  bounds: { min: number; max?: number },
  options?: ValidationOptions,
) {
  return applyDecorators(
    transformValue((value) => (value === undefined || value === "" ? defaultValue : Number(value))),
    IsInt(options),
    Min(bounds.min, options),
    ...(bounds.max === undefined ? [] : [Max(bounds.max, options)]),
  );
}

/** class-transformer types the incoming value as `any`; every transform above sees `unknown`. */
function transformValue(transform: (value: unknown) => unknown) {
  return Transform((params: TransformFnParams): unknown => transform(params.value as unknown));
}

function isParseableAddress(value: unknown): value is string {
  return typeof value === "string" && isAddress(value, { strict: false });
}

function trimmed(value: unknown): unknown {
  return typeof value === "string" ? value.trim() : value;
}

function customValidator(
  name: string,
  validate: (value: unknown) => boolean,
  message: string,
  options?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) =>
    registerDecorator({
      name,
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: { validate, defaultMessage: () => message },
    });
}
