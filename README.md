# Progresso

**Most health apps give you data. We give you actionable next steps.**

Progresso connects confirmed health records, a personal timeline, editable meal estimates, and one evidence-backed wellness action. This repository contains the Next.js application, its backend, Supabase migration, a local demo, and regression tests.

## Run locally without credentials

Use Node **24 LTS** (or Node 22.12+).

```sh
npm ci
npm run dev:demo
```

Open http://localhost:3000 and select **Explore sample history**. Complete onboarding to generate a recommendation. Each browser receives a separate opaque, HTTP-only session and 28 days of clearly labeled synthetic history. Data and uploaded files persist in `.data/`, which is ignored by Git.

Demo mode is explicitly enabled by `PROGRESSO_DEMO_MODE=true`; missing Supabase credentials never silently activate it. It only serves localhost and is disabled on Vercel. Its file store and request limiter are for a **single local Node process**, not public hosting or multi-instance deployment. Use synthetic files while exploring the demo.

## Connect Supabase

1. Create a Supabase project. Run the entire `supabase/migrations/202609180001_progresso.sql` file in its SQL editor, or apply it through the Supabase CLI migration workflow.
2. Copy `.env.example` to `.env.local`.
3. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the legacy public anon key is supported too). Keep `PROGRESSO_DEMO_MODE=false`.
4. Enable email/password authentication. Configure the Auth Site URL and allowed redirect URLs for your localhost and deployed origins. Email verification remains controlled by your Supabase project.
5. Run `npm run dev`. Create and confirm an account, then sign in. Real accounts start with **empty histories**, never synthetic measurements.
6. Optional: set `OPENAI_API_KEY` and `OPENAI_MODEL` (default `gpt-4.1-mini`) for image/PDF extraction and meal-photo recognition. The user must consent to sending each file for analysis. No AI key is required for CSV/JSON/XML, manual logging, recommendations, timeline, progress, or grounded search.

The migration creates `profiles`, `goals`, `uploads`, `health_records`, `meals`, `recommendations`, `recommendation_progress`, the transactional `progresso_mutate` function, and the private `health-uploads` storage bucket. **No service-role key is needed or used.**

## Structure

```text
src/app/                  Next.js App Router, layout and styles
src/app/api/[...path]/     Thin HTTP route adapter
src/components/           Working frontend for exercising the core flows
src/lib/client/           Supabase browser auth and typed API helper
src/lib/domain/           Schemas, unit normalization, analytics, recommendation rules, search
src/lib/server/           Verified authentication, repositories, transactions, parsers, AI, API
supabase/migrations/      Database schema, ownership policies, private storage, atomic writes
public/samples/           Small supported import examples
scripts/                  Live HTTP smoke test
tests/                   Domain, API, AI adapter, and real PostgreSQL migration tests
```

The server-only boundary prevents secret-bearing modules from being imported by client components. The frontend consumes the same API available to other clients; it does not use elevated database access.

See [API contracts](docs/API.md), [architecture decisions](docs/ARCHITECTURE.md), and [deployment verification](docs/DEPLOYMENT.md).

## What works

- Goal-prioritized onboarding with timezone and canonical metric units.
- Private uploads with metadata, file signatures and size validation, source tracking, extraction review, corrections, and explicit confirmation.
- Actual CSV/JSON/XML parsing and a bounded Apple Health XML subset; optional structured vision/PDF extraction.
- Explicit sample recognition and manual fallback, never fabricated "real" extraction when vision is unavailable.
- Day/week/month timeline, daily aggregation, date-range trends, evidence references, and coverage reporting.
- One active, goal-aware behavioral recommendation; progress with idempotency keys, date windows, and completion.
- Meal recognition/manual entry, editable servings and nutrients, and atomic macro records on the timeline.
- Ask Progresso: deterministic grounded search over confirmed records. It answers supported questions about trends, focus and logging consistency; unsupported causal/medical questions are explicitly bounded. **It is not an open-ended LLM chat.**
- Minimal responsive light/dark interface for the core flow. This is a backend-first implementation, with the frontend kept separate for further design work.

## Verify

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

`npm test` exercises the **actual SQL migration** in embedded PostgreSQL (PGlite), using lightweight Auth/Storage schema stubs. It checks RLS with two authenticated users and an anonymous role, cross-owner foreign keys, storage policies, confirmation rollback and idempotent transactions. This does not replace testing against hosted Supabase Auth and Storage.

For a live HTTP smoke test, run `npm run dev:demo` in another terminal:

```sh
npm run test:api
# Alternate port:
PROGRESSO_BASE_URL=http://localhost:3001 npm run test:api
```

## Deliberate boundaries

Files are limited to 4 MB and structured imports to 2,000 rows/values per request. Apple Health ZIP archives, direct HealthKit/wearable sync, arbitrary vendor schemas, long-running import jobs, and clinical interpretation are not implemented. Split large exports or use the sample normalized format. Missing measurements are never interpreted as zero.

Structured imports run deterministic parsers rather than spending AI tokens re-reading numeric exports. Known metrics use canonical units. Unknown numeric metrics stay in `other` and do not drive exercise recommendations. Daily totals from overlapping sources are not summed; manual corrections win, otherwise the latest record wins. Nutrition daily totals take precedence over meal sums to avoid counting the same intake twice. Source records remain visible.

AI confidence and meal nutrients are estimates. Provider processing requires consent; `store:false` disables Responses API response storage but is **not a claim of zero provider retention**. Health data is excluded from application error logs.

A live Supabase project and live AI credentials must be configured and exercised before calling those integrations production-verified. The local demo and mock AI tests do not establish that.
