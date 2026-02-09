import dotenv from "dotenv";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  CORE_DATA_DIR: z.string().default("./core-data"),
  TENANCY_MODE: z.enum(["single", "db_per_tenant", "row_level"]).default("row_level"),
  JWT_ISSUER: z.string().default("hekatoncheiros-core"),
  JWT_AUDIENCE_USER: z.string().default("hc-user"),
  JWT_AUDIENCE_APP: z.string().default("hc-app"),
  JWT_SECRET: z.string().min(16),
  INSTALLER_TOKEN_SECRET: z.string().min(16),
  INSTALLER_TOKEN_ISSUER: z.string().default("hekatoncheiros-core-installer"),
  DEFAULT_TENANT_ID: z.string().default("tnt_default"),
  LICENSING_CLOCK_SKEW_SECONDS: z.coerce.number().int().nonnegative().default(600),
  LICENSING_CLOCK_SOFT_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(43200),
  OFFLINE_LICENSE_PUBLIC_KEYS_JSON: z.string().default("{}"),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadConfig(): EnvConfig {
  dotenv.config();
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }

  return parsed.data;
}
