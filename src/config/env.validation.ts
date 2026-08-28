import { Logger } from '@nestjs/common';

type Env = Record<string, unknown>;

/** Without these the app cannot serve a single authenticated request. */
const ALWAYS_REQUIRED = ['JWT_SECRET'] as const;

/** Safe to default locally, but a silent fallback in production hides outages. */
const PRODUCTION_REQUIRED = ['DATABASE_URL', 'FRONTEND_ORIGIN'] as const;

/** Missing values disable the feature rather than the app — warn, don't fail. */
const FEATURE_GROUPS: Record<string, string[]> = {
  'S3 uploads': [
    'AWS_REGION',
    'AWS_S3_BUCKET',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
  ],
  'Google OAuth': ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  'Question sync (Gemini)': ['GEMINI_API_KEY'],
};

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Fail fast at boot instead of surfacing a missing secret as a 500 later.
 * Wired into ConfigModule.forRoot({ validate }).
 */
export function validateEnv(config: Env): Env {
  const isProduction = config.NODE_ENV === 'production';
  const problems: string[] = [];

  for (const key of ALWAYS_REQUIRED) {
    if (isBlank(config[key])) problems.push(`${key} is required`);
  }

  if (isProduction) {
    for (const key of PRODUCTION_REQUIRED) {
      if (isBlank(config[key])) {
        problems.push(`${key} is required when NODE_ENV=production`);
      }
    }
    if (config.DB_SYNCHRONIZE === 'true') {
      problems.push(
        'DB_SYNCHRONIZE must not be "true" in production — TypeORM sync can drop columns',
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}`,
    );
  }

  const disabled = Object.entries(FEATURE_GROUPS)
    .filter(([, keys]) => keys.some((key) => isBlank(config[key])))
    .map(([feature]) => feature);

  if (disabled.length > 0) {
    new Logger('Config').warn(
      `Disabled — missing environment variables: ${disabled.join(', ')}`,
    );
  }

  return config;
}
