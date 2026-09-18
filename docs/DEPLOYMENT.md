# Deployment and verification

## App hosting

Use Node 24 LTS. `npm ci`, `npm run build`, and `npm start` produce/run the Next.js server. Deploy it to a Next.js-compatible Node host; do not use static export. Configure the public Supabase URL/key before building, and the optional AI key as a server secret. Never set demo mode on a public deployment. Run the migration once against the intended Supabase project and configure Auth origins.

## Before a real-user launch

- Exercise signup, email confirmation, login, logout, and token expiry against hosted Supabase.
- Use two separate real accounts to verify record, upload and file isolation over the deployed API.
- Upload each supported type, edit extracted values, confirm once and retry confirmation.
- Exercise actual Supabase Storage uploads/downloads and failed-upload recovery.
- With an AI key, test real screenshot/PDF/food recognition, refusals, invalid outputs, timeouts, and the consent gate. Mock provider tests are not live-provider verification.
- Verify progress retries, target completion, meal corrections and timezone boundaries.
- Add a shared rate limiter at the hosting/gateway layer. Current process-local limits are not a distributed spending cap.
- Establish deletion/export workflows, retention policy, backups and restore verification before accepting real sensitive histories. Account deletion cascades database rows, but Storage object cleanup must be handled separately; this release does not implement account deletion.
- Verify provider data handling and the privacy notice for your intended audience. Do not describe the app as clinically validated or automatically compliant with a health-data regime.

## Automated coverage

`npm test` includes deterministic domain tests, authenticated API flows, consent/provider mocks, and execution of the actual migration in PostgreSQL via PGlite. Auth and Storage schemas are stubbed solely to exercise policies locally; hosted Supabase Auth and Storage services are not emulated.

`npm run test:api` exercises a running local demo server using real HTTP requests. CI runs lint, TypeScript, tests and a production build on Node 24.

## Secrets

The application does not use a Supabase service-role key. `.env.local`, `.data`, uploaded health files, and build output are excluded from Git. Do not upload a populated `.data` directory to GitHub or a static host. Server errors expose request IDs and sanitized messages, not request bodies or provider responses.
