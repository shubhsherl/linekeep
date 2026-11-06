export type Environment = "development" | "production";

export interface Env {
  DB: D1Database;
  RECORDINGS: R2Bucket;
  ENVIRONMENT: Environment;
  MAX_RECORDING_BYTES: string;
  LOCAL_ADMIN_SECRET?: string;
  TOKEN_HASH_SECRET?: string;
  CALL_SUMMARY_ENABLED?: string;
  /** IST "HH:MM" the daily summary is sent (rounded down to :00/:30); unset means 18:00. */
  CALL_SUMMARY_SEND_TIME?: string;
  EMAIL_IDS?: string;
  RECORDING_RETENTION_DAYS?: string;
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
  MAILGUN_FROM_EMAIL?: string;
  MAILGUN_REGION?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_WABA_ID?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_GRAPH_VERSION?: string;
  /** The Meta app id; informational (shown in Config), not needed to send. */
  WHATSAPP_APP_ID?: string;
  /** JSON key of the Firebase service account that sends push notifications; unset turns push off. */
  FCM_SERVICE_ACCOUNT?: string;
  /** The Firebase app's public client identifiers as JSON {apiKey, appId, projectId, senderId}; handed to enrolled phones. */
  FIREBASE_CLIENT_CONFIG?: string;
}
