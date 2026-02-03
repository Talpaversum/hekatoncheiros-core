import dotenv from "dotenv";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  TENANCY_MODE: z.enum(["single", "db_per_tenant", "row_level"]).default("row_level"),
  JWT_ISSUER: z.string().default("hekatoncheiros-core"),
  JWT_AUDIENCE_USER: z.string().default("hc-user"),
  JWT_AUDIENCE_APP: z.string().default("hc-app"),
  JWT_SECRET: z.string().min(16),
  DEFAULT_TENANT_ID: z.string().default("tnt_default"),
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
