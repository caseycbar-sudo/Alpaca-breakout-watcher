import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Every test file starts from the real schema, including rules version 1.
await applyD1Migrations((env as any).DB, (env as any).TEST_MIGRATIONS);
