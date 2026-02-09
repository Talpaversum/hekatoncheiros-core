import { buildApp } from "./app.js";
import { migrateDatabase } from "./db/migrate.js";
import { ensurePlatformInstanceId } from "./licensing/platform-instance-service.js";

async function start() {
  await migrateDatabase({ closePool: false });
  await ensurePlatformInstanceId();

  const app = await buildApp();
  const port = app.config.PORT;
  const host = "0.0.0.0";

  await app.listen({ port, host });
  app.log.info(`Server listening on ${host}:${port}`);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
