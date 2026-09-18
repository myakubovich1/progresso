# API contracts

All routes live under `/api`. Successful JSON responses are `{ "data": ... }`; errors are `{ "error": { "code", "message", "request_id", "fields"? } }`. Responses are private and `no-store`. Clients must check HTTP status, not merely JSON presence.

## Authentication

Production: send `Authorization: Bearer <Supabase access token>` on every private request. The backend verifies the token with `auth.getUser(token)` and performs database/storage operations using that same token. User IDs are never taken from request bodies. Login, signup and logout use the normal Supabase browser SDK (`src/lib/client/api.ts`).

Local demo: `POST /api/demo/session` creates an HTTP-only, SameSite=Strict cookie and seeds an isolated local history. Each new session is a new workspace. Browsers send this cookie automatically. This endpoint is disabled outside explicitly enabled local demo mode.

| Method | Route                                       | Input / behavior                                                                         |
| ------ | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/health`                                   | Public runtime/configuration capabilities; no credentials or health values               |
| POST   | `/demo/session`                             | Local demo only; sets cookie and seeds sample history                                    |
| POST   | `/demo/seed`                                | Local demo only; idempotent, does not overwrite existing history                         |
| GET    | `/profile`                                  | Profile, prioritized goals, persistence mode                                             |
| POST   | `/onboarding`                               | Atomic profile and goal replacement                                                      |
| GET    | `/home`                                     | Current recommendation, recorded progress, six category summaries                        |
| GET    | `/records?from=&to=`                        | Confirmed normalized records in date range                                               |
| POST   | `/records`                                  | `{records:[...]}`; manual records, source becomes `Manual`                               |
| GET    | `/uploads`                                  | Upload metadata and review/failed/confirmed states                                       |
| POST   | `/uploads`                                  | Multipart `file`, `kind=health\|meal`, `date`, `consent=true\|false`, `demo=true\|false` |
| GET    | `/uploads/:id`                              | Owned upload and extracted draft                                                         |
| GET    | `/uploads/:id/file`                         | Authenticated private file download                                                      |
| POST   | `/uploads/:id/analyze`                      | `{date, consent?, demo?}`; reanalyze unconfirmed uploads                                 |
| POST   | `/uploads/:id/confirm`                      | `{records:[...]}`; validated, edited values; atomic and idempotent                       |
| GET    | `/timeline?from=&to=&view=day\|week\|month` | Days, source records, meals, daily metrics and trends                                    |
| GET    | `/insights`                                 | Candidate next step, strongest recorded areas, trends, medical upload IDs                |
| GET    | `/recommendations`                          | Recommendation history and progress events                                               |
| POST   | `/recommendations`                          | Generate an action from confirmed history; preserves an active unexpired action          |
| PATCH  | `/recommendations/:id`                      | `{status:"dismissed"}` to release the current focus                                      |
| POST   | `/recommendations/:id/progress`             | `{amount,date,note?,idempotency_key}`                                                    |
| GET    | `/meals?from=&to=`                          | Meal history                                                                             |
| POST   | `/meals`                                    | Confirm/manual-log meal; computes totals and four timeline records atomically            |
| PATCH  | `/meals/:id`                                | Correct meal; replaces its linked macros rather than adding duplicates                   |
| POST   | `/chat`                                     | `{question,from?,to?}`; grounded answer with evidence and mode                           |

Date ranges must be ordered and at most 367 days. Record/meal list requests default to the last 28 days. Choose explicit ranges for timeline navigation. History fetching is bounded to 20,000 rows per table; larger histories return an explicit limit error rather than silently analyzing a subset.

## Onboarding

```json
{
  "display_name": "Alex",
  "age_range": "25-34",
  "height_cm": null,
  "weight_kg": null,
  "activity_level": "moderate",
  "preferred_units": "metric",
  "timezone": "America/New_York",
  "goals": ["cardio", "energy"]
}
```

Goal array order defines priority. Goals: `sleep`, `fitness`, `weight_loss`, `muscle_gain`, `energy`, `cardio`, `general_health`. Age bands begin at 18. Activity levels: `sedentary`, `light`, `moderate`, `active`, `very_active`. Units: `metric`, `imperial`; stored height/weight are always cm/kg.

## Health records and extraction review

```json
{
  "records": [
    {
      "date": "2026-09-18",
      "category": "sleep",
      "metric": "sleep_duration",
      "value": 7.5,
      "unit": "h",
      "source": "Apple Health",
      "confidence": 0.95,
      "is_demo": false
    }
  ]
}
```

Categories: `sleep`, `movement`, `cardio`, `strength`, `nutrition`, `recovery`, `body_metrics`, `other`. Canonical units and ranges are exported by `metricCatalog` in `src/lib/domain/schema.ts`.

Normalized CSV accepts `date,metric,value,unit,source` headers. Wide CSV accepts `date,sleep_hours,steps,...`. JSON accepts an array or `{records:[...]}`. Generic XML accepts `<health><record date="..." metric="..." value="..." unit="..." /></health>`. Apple Health XML supports step count, dietary energy/macros, body mass, resting heart rate, HRV, sleep intervals and selected cardio/strength workout types. Unsupported values are counted in review warnings.

Uploads stay drafts until confirmation. Malformed files leave a failed metadata row for inspection. No values from a failed extraction are committed. Demo mode provenance is forced at confirmation even if a client submits `is_demo:false`. A repeated upload with the same content hash and kind returns the existing upload and `duplicate:true`.

## Meal example

```json
{
  "date": "2026-09-18",
  "name": "Greek yogurt",
  "raw_upload_id": null,
  "is_demo": false,
  "items": [
    {
      "name": "Plain Greek yogurt",
      "serving": "100 g",
      "quantity": 2,
      "calories": 60,
      "protein": 10,
      "carbs": 4,
      "fat": 0
    }
  ]
}
```

Nutrients are **per serving**. Quantity multiplies them: the above produces 120 kcal and 20 g protein. Photo estimates use the exact same correction/save contract. `raw_upload_id` must reference the current user's meal upload and cannot be changed when correcting a meal. Repeated confirmation of one photo returns its existing meal.

## Recommendation progress

```json
{
  "amount": 1,
  "date": "2026-09-18",
  "note": "Completed one comfortable session",
  "idempotency_key": "912e43be-c91b-4ea8-87a0-5660874da52d"
}
```

Generate a UUID once per intended progress event; reuse it on retries. Progress cannot exceed the target or fall outside the action's date window. Dates after the user's local today are rejected. Completing the target marks the recommendation completed in the same transaction.
