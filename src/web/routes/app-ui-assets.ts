import { readUiPluginArtifact } from "../../apps/ui-artifact-storage.js";

import type { FastifyInstance } from "fastify";

export async function registerAppUiAssetRoutes(app: FastifyInstance) {
  app.get("/apps/:slug/ui/plugin.js", async (request, reply) => {
    const slug = (request.params as { slug: string }).slug;
    try {
      const content = await readUiPluginArtifact(app.config, slug);
      reply.header("content-type", "application/javascript; charset=utf-8");
      reply.header("cache-control", "no-store");
      return reply.send(content);
    } catch {
      return reply.code(404).send({ message: "UI plugin artifact not found" });
    }
  });
}
