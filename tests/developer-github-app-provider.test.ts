import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetGitHubInstallationToken } from "../src/developer/github-app-provider.js";
import { createDeveloperSourceProvider } from "../src/developer/source-provider-adapter.js";

const installationId = "42001";

afterEach(() => {
  forgetGitHubInstallationToken(installationId);
  vi.unstubAllGlobals();
});

describe("GitHub App developer source provider", () => {
  it("caches a short-lived installation token and discovers accessible private repositories and refs", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const privateKeyPem = await exportPKCS8(privateKey);
    const requests: Array<{ path: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(init?.headers);
      requests.push({
        path: `${url.pathname}${url.search}`,
        authorization: headers.get("authorization"),
      });
      if (url.pathname.endsWith("/access_tokens")) {
        expect(headers.get("authorization")).toMatch(/^Bearer eyJ/);
        return Response.json({
          token: "installation-secret",
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
      }
      expect(headers.get("authorization")).toBe("Bearer installation-secret");
      if (url.pathname === "/installation/repositories") {
        return Response.json({
          repositories: [
            {
              id: 7,
              full_name: "private-org/private-app",
              private: true,
              default_branch: "trunk",
              html_url: "https://github.example/private-org/private-app",
            },
          ],
        });
      }
      if (url.pathname.endsWith("/branches")) {
        return Response.json([{ name: "trunk", commit: { sha: "branch-sha" } }]);
      }
      if (url.pathname.endsWith("/tags")) {
        return Response.json([{ name: "v1.0.0", commit: { sha: "tag-sha" } }]);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      DEVELOPER_GITHUB_APP_ID: "1234",
      DEVELOPER_GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      DEVELOPER_GITHUB_API_URL: "https://github.example",
    } as never;
    const provider = createDeveloperSourceProvider(
      {
        provider: "github",
        auth_method: "github_app",
        metadata_json: { installation_id: installationId },
      },
      config,
    );

    await expect(provider.repositories()).resolves.toEqual({
      supports_repository_discovery: true,
      items: [
        {
          id: "7",
          full_name: "private-org/private-app",
          namespace: "private-org",
          private: true,
          default_ref: "trunk",
        },
      ],
    });
    await expect(provider.refs("private-org/private-app")).resolves.toEqual([
      { name: "trunk", type: "branch", revision: "branch-sha" },
      { name: "v1.0.0", type: "tag", revision: "tag-sha" },
    ]);

    expect(requests.filter((request) => request.path.endsWith("/access_tokens"))).toHaveLength(1);
    expect(JSON.stringify(await provider.repositories())).not.toContain("installation-secret");
  });
});
