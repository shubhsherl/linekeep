export type Environment = "development" | "production";

export interface Env {
  DB: D1Database;
  RECORDINGS: R2Bucket;
  ENVIRONMENT: Environment;
  MAX_RECORDING_BYTES: string;
  LOCAL_ADMIN_SECRET?: string;
  TOKEN_HASH_SECRET?: string;
  CALL_SUMMARY_ENABLED?: string;
  EMAIL_IDS?: string;
  RECORDING_RETENTION_DAYS?: string;
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
  MAILGUN_FROM_EMAIL?: string;
  MAILGUN_REGION?: string;
}
