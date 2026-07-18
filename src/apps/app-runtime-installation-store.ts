import { getPool } from "../db/pool.js";

export type AppRuntimeInstallation = {
  app_id: string;
  runtime_type: "compose" | "dockerfile";
  compose_project: string;
  service_name: string;
  package_sha256: string | null;
  created_at: string;
  updated_at: string;
};

function mapRow(row: Record<string, unknown>): AppRuntimeInstallation {
  return {
    app_id: String(row["app_id"]),
    runtime_type: row["runtime_type"] === "dockerfile" ? "dockerfile" : "compose",
    compose_project: String(row["compose_project"]),
    service_name: String(row["service_name"]),
    package_sha256: (row["package_sha256"] as string | null) ?? null,
    created_at: new Date(String(row["created_at"])).toISOString(),
    updated_at: new Date(String(row["updated_at"])).toISOString(),
  };
}

export async function getAppRuntimeInstallation(
  appId: string,
): Promise<AppRuntimeInstallation | null> {
  const result = await getPool().query(
    `select app_id, runtime_type, compose_project, service_name, package_sha256,
            created_at, updated_at
       from core.app_runtime_installations
      where app_id = $1`,
    [appId],
  );

  return result.rowCount ? mapRow(result.rows[0]) : null;
}

export async function listAppRuntimeInstallations(): Promise<AppRuntimeInstallation[]> {
  const result = await getPool().query(
    `select app_id, runtime_type, compose_project, service_name, package_sha256,
            created_at, updated_at
       from core.app_runtime_installations
      order by app_id`,
  );
  return result.rows.map(mapRow);
}

export async function upsertComposeAppRuntimeInstallation(input: {
  appId: string;
  composeProject: string;
  serviceName: string;
  packageSha256: string | null;
}): Promise<AppRuntimeInstallation> {
  const result = await getPool().query(
    `insert into core.app_runtime_installations (
       app_id, runtime_type, compose_project, service_name, package_sha256
     ) values ($1, 'compose', $2, $3, $4)
     on conflict (app_id) do update set
       runtime_type = 'compose',
       compose_project = excluded.compose_project,
       service_name = excluded.service_name,
       package_sha256 = excluded.package_sha256,
       updated_at = now()
     returning app_id, runtime_type, compose_project, service_name, package_sha256,
               created_at, updated_at`,
    [input.appId, input.composeProject, input.serviceName, input.packageSha256],
  );

  return mapRow(result.rows[0]);
}

export async function upsertDeveloperAppRuntimeInstallation(input: {
  appId: string;
  runtimeType: "compose" | "dockerfile";
  runtimeIdentity: string;
  serviceName: string;
  revision: string | null;
}) {
  const result = await getPool().query(
    `insert into core.app_runtime_installations(app_id,runtime_type,compose_project,service_name,package_sha256)
     values($1,$2,$3,$4,$5)
     on conflict(app_id) do update set runtime_type=excluded.runtime_type,compose_project=excluded.compose_project,
       service_name=excluded.service_name,package_sha256=excluded.package_sha256,updated_at=now()
     returning app_id,runtime_type,compose_project,service_name,package_sha256,created_at,updated_at`,
    [input.appId, input.runtimeType, input.runtimeIdentity, input.serviceName, input.revision],
  );
  return mapRow(result.rows[0]);
}
