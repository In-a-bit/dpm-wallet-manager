const transformer = require("@nestjs/swagger/plugin");

/**
 * Runs the OpenAPI CLI plugin during `ts-jest` compilation.
 *
 * `nest build` applies the plugin on its own, but jest compiles in memory and would otherwise see
 * the untransformed source — so `test/openapi.e2e-spec.ts`, which asserts the generated document
 * is complete, would be checking an empty schema and passing for the wrong reason.
 *
 * The options must mirror `nest-cli.json`, and `version` must be bumped whenever they change:
 * ts-jest caches transformed output keyed by it, and will not otherwise notice.
 */
module.exports.name = "nestjs-swagger-transformer";
module.exports.version = 2;

module.exports.factory = (cs) =>
  transformer.before(
    {
      introspectComments: true,
      classValidatorShim: true,
      dtoFileNameSuffix: [".dto.ts"],
      controllerFileNameSuffix: [".controller.ts"],
      // A route's JSDoc is prose, not a one-liner: it belongs in `description`, and each
      // `@ApiOperation` supplies its own short `summary`.
      controllerKeyOfComment: "description",
    },
    cs.program,
  );
