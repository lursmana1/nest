import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

function parseOrigins(value?: string) {
  // FRONTEND_ORIGIN can be:
  // - single origin: "https://myapp.com"
  // - multiple origins: "https://myapp.com,https://www.myapp.com,http://localhost:3000"
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Required behind Render/nginx so secure cookies and OAuth redirects work.
  app.set('trust proxy', 1);

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true, // optional: strips unknown fields
      forbidNonWhitelisted: false, // optional
    }),
  );

  const allowedOrigins = parseOrigins(process.env.FRONTEND_ORIGIN);

  app.enableCors({
    origin: (origin, callback) => {
      // allow server-to-server / Postman / curl (no Origin header)
      if (!origin) return callback(null, true);

      // allow localhost by default for dev
      const defaults = ['http://localhost:3000', 'http://localhost:3001'];

      if (allowedOrigins.includes(origin) || defaults.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: true,
  });

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;

  await app.listen(port);
}
void bootstrap();
