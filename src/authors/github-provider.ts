export type GitHubIdentity = { login: string; id: number; avatar_url?: string };
export type GitHubRepository = { id: number; full_name: string; private: boolean; default_branch: string; html_url: string; permissions?: Record<string, boolean> };

async function githubRequest<T>(token: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, "https://api.github.com"), {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "hekatoncheiros-core",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const message = response.status === 401 ? "GitHub credential is invalid or revoked" : response.status === 403 ? "GitHub denied repository access" : `GitHub request failed (${response.status})`;
    throw Object.assign(new Error(message), { statusCode: response.status === 401 ? 400 : 502 });
  }
  return response.json() as Promise<T>;
}

export function verifyGitHubConnection(token: string) {
  return githubRequest<GitHubIdentity>(token, "/user");
}

export function listGitHubRepositories(token: string) {
  return githubRequest<GitHubRepository[]>(token, "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member");
}

export async function getGitHubRevision(token: string, repository: string, branch: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw Object.assign(new Error("Invalid GitHub repository name"), { statusCode: 400 });
  const result = await githubRequest<{ sha: string }>(token, `/repos/${repository}/commits/${encodeURIComponent(branch)}`);
  return result.sha;
}

export async function readGitHubFile(token: string, repository: string, branch: string, filePath: string): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw Object.assign(new Error("Invalid GitHub repository name"), { statusCode: 400 });
  if (!branch.trim() || !filePath.trim() || filePath.startsWith("/") || filePath.split("/").includes("..")) {
    throw Object.assign(new Error("Invalid repository branch or manifest path"), { statusCode: 400 });
  }
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const result = await githubRequest<{ type: string; encoding?: string; content?: string }>(token, `/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`);
  if (result.type !== "file" || result.encoding !== "base64" || typeof result.content !== "string") throw Object.assign(new Error("Manifest path is not a readable file"), { statusCode: 400 });
  return Buffer.from(result.content.replace(/\s/g, ""), "base64").toString("utf8");
}
