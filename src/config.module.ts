import { Global, Module } from "@nestjs/common";

import { loadConfig, type Config } from "./config";
import { deriveSecrets, type Secrets } from "./crypto/secrets";
import { CONFIG, SECRETS } from "./tokens";

/**
 * Parses the environment once and hands the result to everything else. Global, because config and
 * the secrets derived from it are needed in every feature module.
 *
 * A parse failure throws here, during module construction, so the process dies before it binds.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): Config => loadConfig() },
    {
      provide: SECRETS,
      useFactory: (config: Config): Secrets => deriveSecrets(config.masterKey),
      inject: [CONFIG],
    },
  ],
  exports: [CONFIG, SECRETS],
})
export class AppConfigModule {}
