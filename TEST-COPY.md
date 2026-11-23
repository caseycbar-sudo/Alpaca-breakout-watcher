# Isolated Hub test copy

This is the source preparation for job #14. No test Worker, database or KV namespace
has been created. Cloudflare's approval review rejected both resource creation calls.

The production configuration and entrypoint are unchanged. `wrangler.test.jsonc`
selects a separate `driftline-hub-test` Worker, new D1 and OAuth KV, and a wrapper
that labels HTML as TEST and rejects `/api/radar`. The wrapper passes only storage,
assets and OAuth bindings to the app; AI and wake integrations cannot be invoked.
OAuth discovery and connector URLs use the test request origin. The test database
starts empty, with its own first-time setup and new grants. Do not copy production
authentication, account snapshots, scans, messages, secrets or database exports.

## Provisioning and review

1. After Cloudflare resource approval, create `driftline-trading-hub-test` D1 and
   `driftline-hub-test-oauth` KV. Replace the two UNPROVISIONED IDs in the test config.
2. Have an independent reviewer compare those bindings with the production config;
   both IDs must differ. Do this before any test jobs are run.
3. Apply the existing migrations using the test config and database name. Issue a
   new one-time setup code using the existing setup mechanism; keep credentials
   out of source, chat and logs. No production credentials may be reused.
4. Build/deploy only with `--config wrangler.test.jsonc`; confirm the Worker has
   no custom routes, schedules, AI, watcher token, wake endpoints or production bindings.
5. Use the distinct test hostname and `/mcp` connector address. Seed only synthetic
   jobs/messages after bindings are reviewed. Never point the watcher at this address.

## Acceptance still required

At desktop and phone widths, test job creation, acceptance, handoff, submit,
independent completion and history; stale draft recovery; chat Send with the
keyboard open/closed; safe areas; stale/offline/empty states and reduced motion.
Record actions and screenshots from the browser. Source/unit checks do not satisfy
these browser criteria. Delete only the exact named test resources after Casey no
longer needs the test copy; never target production resources.
