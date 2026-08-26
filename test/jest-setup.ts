// Nest's DI, class-transformer and class-validator all read design-time type metadata,
// which only exists once this polyfill has been loaded.
import "reflect-metadata";

// Tests reach a real Postgres, so TEST_DATABASE_URL has to be readable without exporting it
// by hand. Existing environment variables win, which is what lets CI point elsewhere.
import "dotenv/config";
