module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  roots: ["<rootDir>/src", "<rootDir>/test"],
  testRegex: ".*\\.(spec|e2e-spec)\\.ts$",
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.json",
        // The OpenAPI CLI plugin, which `nest build` applies but jest would otherwise skip.
        astTransformers: { before: ["<rootDir>/test/swagger-transformer.js"] },
      },
    ],
  },
  setupFiles: ["<rootDir>/test/jest-setup.ts"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.spec.ts", "!src/testing/**"],
  coverageDirectory: "./coverage",
  testEnvironment: "node",
  // Specs that boot the app create and migrate a database against a real server, which the
  // 5s default does not cover.
  testTimeout: 30000,
};
