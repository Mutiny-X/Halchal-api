import { webcrypto } from "node:crypto";

// @nestjs/schedule reads the global `crypto.randomUUID()` (the Web Crypto
// API global) at module-init time. That global isn't defined by default on
// Node 18 (only turned on without a flag starting in Node 19) — Railway
// currently runs Node 18.20.5, which crashed the app on every boot with
// "ReferenceError: crypto is not defined" the moment ScheduleModule
// initialized. Polyfill it before AppModule (and therefore ScheduleModule)
// loads below, rather than depending on a Railway Node-version bump.
if (!globalThis.crypto) {
  (globalThis as unknown as { crypto: typeof webcrypto }).crypto = webcrypto;
}

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { join } from "node:path";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module";
// force restart: pick up updated INSTAGRAM_OAUTH_SCOPES from .env

/** The websites allowed to call the API. Never "any website": with nothing
 * configured (local development only — production refuses to start without
 * CORS_ORIGINS) it is the local portal. */
function corsOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // Railway puts one proxy in front of the app. Without this every request
  // looks like it comes from that proxy, so rate limits (sign-in attempts
  // included) were shared by all users instead of counted per person.
  app.set("trust proxy", 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.enableCors({
    origin: corsOrigins(),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useStaticAssets(join(process.cwd(), "uploads"), {
    prefix: "/uploads",
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Halchal API")
    .setDescription("Creator + brand platform API")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, document);

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  app.get(Logger).log(`API listening on http://localhost:${port}`);
  app.get(Logger).log(`OpenAPI docs at http://localhost:${port}/docs`);
}

bootstrap();
