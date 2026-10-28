import { rmSync } from "node:fs";
import { DATA_DIR, startServer, stopServer } from "./embedded-pg";

const commands = {
  async start() {
    await startServer();
    console.log("Embedded Postgres ready on localhost:54329 (retails_dev, retails_test)");
  },
  async stop() {
    await stopServer();
    console.log("Embedded Postgres stopped");
  },
  async reset() {
    await stopServer();
    rmSync(DATA_DIR, { recursive: true, force: true });
    await startServer();
    console.log("Embedded Postgres reset: fresh retails_dev and retails_test");
  },
} as const;

const name = process.argv[2] as keyof typeof commands | undefined;
if (!name || !(name in commands)) {
  console.error("Usage: tsx scripts/db.ts <start|stop|reset>");
  process.exit(1);
}
commands[name]().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
