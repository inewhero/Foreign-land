# Internet deployment status

Target: `main` -> GitHub Pages at `/Foreign-land/`, with a Supabase backend.
Status: migration planned; the existing Express/SQLite application on this branch is not yet a working Pages application. Do not start data collection from Pages until the acceptance checks below pass.

The `lan` branch is the independently runnable Windows release. Download its `lan-v*` assets from https://github.com/inewhero/Foreign-land/releases.

## Required project configuration

Connect the Supabase MCP plugin and select the target project (project ref/URL). No Supabase tools or project configuration were available in the implementation session. GitHub authentication was verified. Never place a service-role key in browser configuration or source control.

## Approved implementation design

- Preserve the participant interface and eight acknowledgement commands using an HTTP transport adapter to one Supabase Edge Function.
- Replace local-bootstrap with explicit authenticated researcher room creation. Never return administrator credentials from a public bootstrap endpoint.
- Store subjects, assessment sessions, rooms, trials, consent signatures, events and audit records in Postgres. Enable RLS; sensitive tables are not directly readable by participants.
- Persist the pending trial, prediction, server deadlines, state version and last-seen time. Edge memory cannot own experimental state.
- Atomically commit a choice, score, sequence cursor and audit record. Duplicate round submissions return the original result. Use room locking for allocation and session creation, participant locking for trials, with a consistent lock order.
- Keep hidden guardian actions and signatures out of participant snapshots. Hash administrator/resume tokens; send authentication in headers. Export CSV using authenticated requests and Blob downloads.
- Configure Vite base `/Foreign-land/`; use `?view=admin` to avoid GitHub Pages deep-link 404s. QR links include the repository base path.
- Publish Pages only after backend configuration and migration verification. A static frontend alone cannot host Express, SQLite or Socket.IO.

## Acceptance before enabling Pages

Two participants complete a block; cold-start/reconnect restores the same pending trial; concurrent duplicate choice commits yield one row; prediction and timeout retries are idempotent; consent/signature and exports round-trip; pause/force controls and next-wave recovery work; anonymous and cross-participant access fail; browser assets contain no secrets. Verify these against the selected Supabase project and run database security advisors.

## Interpretation of existing simulations

The checkpoint power results are fast Gaussian change-score simulations calibrated using recovery correlations, not repeated trial-level Stan fits. Correlation-derived measurement error assumes unbiased additive errors. The existing composite-null thresholds were calibrated and evaluated on the same simulations, so the reported <=5% rate is not independent validation. Do not treat these results as cloud-backend or definitive scientific acceptance.
