import "dotenv/config";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SwaggerModule } from "@nestjs/swagger";

import { AppModule } from "./app.module";
import { BASE_PATH, configureApp } from "./app.setup";
import type { Config } from "./config";
import { logError, logInfo } from "./observability/log";
import { buildOpenApiDocument } from "./openapi";
import { installShutdownHandlers } from "./startup/shutdown";
import { CONFIG } from "./tokens";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get<Config>(CONFIG);
  configureApp(app, config);
  mountApiDocs(app);
  installShutdownHandlers(app);

  await app.listen(config.port);
  logInfo("listening", { port: config.port, mode: config.mode });
}

function mountApiDocs(app: NestExpressApplication): void {
  SwaggerModule.setup(`${BASE_PATH}/docs`, app, buildOpenApiDocument(app));
}

bootstrap().catch((err: unknown) => {
  // A boot failure must be loud and fatal: the mode check in particular decides where every
  // subsequent order's funds come from, and a container that cannot pass it must not serve.
  logError("startup.failed", { err });
  process.exit(1);
});
