export type Environment = "development" | "production";

export interface Env {
  DB: D1Database;
  RECORDINGS: R2Bucket;
  ENVIRONMENT: Environment;
  MAX_RECORDING_BYTES: string;
  LOCAL_ADMIN_SECRET?: string;
  TOKEN_HASH_SECRET?: string;
}
