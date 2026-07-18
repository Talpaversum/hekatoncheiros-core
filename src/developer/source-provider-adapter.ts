import type { AppManifest } from "../apps/manifest-validator.js";
import { githubRequest, type GitHubRepository } from "../authors/github-provider.js";
import type { EnvConfig } from "../config/index.js";
import { HttpError } from "../shared/errors.js";

import { decryptDeveloperSecret } from "./connection-secret-store.js";
import { listGitRefs, readGitSource } from "./git-source-provider.js";
import { getGitHubInstallationToken } from "./github-app-provider.js";
import { validateRepositoryReference } from "./source-providers.js";

export type DiscoveredRepository = {
  id: string;
  full_name: string;
  namespace: string;
  private: boolean;
  default_ref: string;
};
export type DiscoveredRef = { name: string; type: "branch" | "tag"; revision: string };
export type RepositoryDiscovery = {
  supports_repository_discovery: boolean;
  items: DiscoveredRepository[];
};

type Connection = Record<string, unknown>;
const githubApiUrl = (config: EnvConfig) =>
  config.DEVELOPER_GITHUB_API_URL ?? "https://api.github.com";

function providerBaseUrl(connection: Connection) {
  const baseUrl = new URL(
    String(
      (connection["metadata_json"] as Record<string, unknown>)["base_url"] ?? "https://gitlab.com",
    ),
  );
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password) {
    throw new HttpError(400, "GitLab base URL must be credential-free HTTPS");
  }
  return baseUrl;
}

function validateManifestPath(manifestPath: string) {
  const segments = manifestPath.replaceAll("\\", "/").split("/");
  if (!manifestPath || manifestPath.startsWith("/") || segments.includes("..")) {
    throw new HttpError(400, "Manifest path must stay inside the repository");
  }
}

function storedCredential(connection: Connection, config: EnvConfig) {
  if (!connection["credential_ciphertext"]) return undefined;
  return decryptDeveloperSecret(
    {
      ciphertext: String(connection["credential_ciphertext"]),
      iv: String(connection["credential_iv"]),
      tag: String(connection["credential_tag"]),
    },
    config,
  );
}

async function githubToken(connection: Connection, config: EnvConfig) {
  if (connection["auth_method"] === "github_app") {
    const installationId = String(
      (connection["metadata_json"] as Record<string, unknown>)["installation_id"] ?? "",
    );
    return getGitHubInstallationToken(installationId, config);
  }
  const token = storedCredential(connection, config);
  if (!token) throw new HttpError(409, "GitHub credential is missing");
  return token;
}

async function gitlabRequest<T>(connection: Connection, config: EnvConfig, path: string) {
  const token = storedCredential(connection, config);
  if (!token) throw new HttpError(409, "GitLab credential is missing");
  const baseUrl = providerBaseUrl(connection);
  const response = await fetch(new URL(path, baseUrl), {
    headers:
      connection["auth_method"] === "oauth"
        ? { authorization: `Bearer ${token}` }
        : { "private-token": token },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new HttpError(
      response.status === 401 ? 400 : 502,
      `GitLab request failed (${response.status})`,
    );
  return response.json() as Promise<T>;
}

async function gitlabText(connection: Connection, config: EnvConfig, path: string) {
  const token = storedCredential(connection, config);
  if (!token) throw new HttpError(409, "GitLab credential is missing");
  const baseUrl = providerBaseUrl(connection);
  const response = await fetch(new URL(path, baseUrl), {
    headers:
      connection["auth_method"] === "oauth"
        ? { authorization: `Bearer ${token}` }
        : { "private-token": token },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new HttpError(
      response.status === 401 ? 400 : 502,
      `GitLab request failed (${response.status})`,
    );
  return response.text();
}

export function createDeveloperSourceProvider(connection: Connection, config: EnvConfig) {
  const provider = String(connection["provider"]);
  return {
    async repositories(): Promise<RepositoryDiscovery> {
      if (provider === "github") {
        const token = await githubToken(connection, config);
        const payload =
          connection["auth_method"] === "github_app"
            ? await githubRequest<{ repositories: GitHubRepository[] }>(
                token,
                "/installation/repositories?per_page=100",
                githubApiUrl(config),
              )
            : {
                repositories: await githubRequest<GitHubRepository[]>(
                  token,
                  "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
                  githubApiUrl(config),
                ),
              };
        return {
          supports_repository_discovery: true,
          items: payload.repositories.map((item) => ({
            id: String(item.id),
            full_name: item.full_name,
            namespace: item.full_name.split("/")[0] ?? "",
            private: item.private,
            default_ref: item.default_branch,
          })),
        };
      }
      if (provider === "gitlab") {
        const projects = await gitlabRequest<
          Array<{
            id: number;
            path_with_namespace: string;
            namespace?: { full_path?: string };
            visibility: string;
            default_branch?: string;
          }>
        >(
          connection,
          config,
          "/api/v4/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at",
        );
        return {
          supports_repository_discovery: true,
          items: projects.map((item) => ({
            id: String(item.id),
            full_name: item.path_with_namespace,
            namespace: item.namespace?.full_path ?? item.path_with_namespace.split("/")[0] ?? "",
            private: item.visibility !== "public",
            default_ref: item.default_branch ?? "main",
          })),
        };
      }
      return { supports_repository_discovery: false, items: [] };
    },
    async refs(repository: string): Promise<DiscoveredRef[]> {
      if (provider === "github") {
        validateRepositoryReference("github", repository);
        const token = await githubToken(connection, config);
        const [branches, tags] = await Promise.all([
          githubRequest<Array<{ name: string; commit: { sha: string } }>>(
            token,
            `/repos/${repository}/branches?per_page=100`,
            githubApiUrl(config),
          ),
          githubRequest<Array<{ name: string; commit: { sha: string } }>>(
            token,
            `/repos/${repository}/tags?per_page=100`,
            githubApiUrl(config),
          ),
        ]);
        return [
          ...branches.map((item) => ({
            name: item.name,
            type: "branch" as const,
            revision: item.commit.sha,
          })),
          ...tags.map((item) => ({
            name: item.name,
            type: "tag" as const,
            revision: item.commit.sha,
          })),
        ];
      }
      if (provider === "gitlab") {
        validateRepositoryReference("gitlab", repository);
        const encoded = encodeURIComponent(repository);
        const [branches, tags] = await Promise.all([
          gitlabRequest<Array<{ name: string; commit: { id: string } }>>(
            connection,
            config,
            `/api/v4/projects/${encoded}/repository/branches?per_page=100`,
          ),
          gitlabRequest<Array<{ name: string; commit: { id: string } }>>(
            connection,
            config,
            `/api/v4/projects/${encoded}/repository/tags?per_page=100`,
          ),
        ]);
        return [
          ...branches.map((item) => ({
            name: item.name,
            type: "branch" as const,
            revision: item.commit.id,
          })),
          ...tags.map((item) => ({
            name: item.name,
            type: "tag" as const,
            revision: item.commit.id,
          })),
        ];
      }
      if (provider === "git") {
        validateRepositoryReference("git", repository);
        return listGitRefs({
          repository,
          authMethod: String(connection["auth_method"]),
          credential: storedCredential(connection, config),
        });
      }
      return [];
    },
    async source(
      repository: string,
      ref: string,
      manifestPath: string,
    ): Promise<{ revision: string; manifest: AppManifest }> {
      validateManifestPath(manifestPath);
      if (provider === "github") {
        validateRepositoryReference("github", repository);
        const token = await githubToken(connection, config);
        const encodedPath = manifestPath.split("/").map(encodeURIComponent).join("/");
        const [file, commit] = await Promise.all([
          githubRequest<{ type: string; encoding?: string; content?: string }>(
            token,
            `/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
            githubApiUrl(config),
          ),
          githubRequest<{ sha: string }>(
            token,
            `/repos/${repository}/commits/${encodeURIComponent(ref)}`,
            githubApiUrl(config),
          ),
        ]);
        if (file.type !== "file" || file.encoding !== "base64" || !file.content)
          throw new HttpError(400, "Manifest path is not a readable file");
        return {
          revision: commit.sha,
          manifest: JSON.parse(
            Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"),
          ) as AppManifest,
        };
      }
      if (provider === "gitlab") {
        validateRepositoryReference("gitlab", repository);
        const encodedRepository = encodeURIComponent(repository);
        const encodedPath = encodeURIComponent(manifestPath);
        const [raw, commit] = await Promise.all([
          gitlabText(
            connection,
            config,
            `/api/v4/projects/${encodedRepository}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`,
          ),
          gitlabRequest<{ id: string }>(
            connection,
            config,
            `/api/v4/projects/${encodedRepository}/repository/commits/${encodeURIComponent(ref)}`,
          ),
        ]);
        return { revision: commit.id, manifest: JSON.parse(raw) as AppManifest };
      }
      if (provider === "git") {
        validateRepositoryReference("git", repository);
        return readGitSource({
          repository,
          branch: ref,
          manifestPath,
          authMethod: String(connection["auth_method"]),
          credential: storedCredential(connection, config),
        });
      }
      throw new HttpError(409, "This provider does not expose repository source");
    },
  };
}
