import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import {
  addDays,
  dateSchema,
  idSchema,
  observationSchema,
  onboardingSchema,
  mealSchema,
  progressSchema,
  today,
  wellnessNotice,
  categories,
  type State,
  type Upload,
} from '@/lib/domain/schema';
import { summarize, trends, dailyMetrics } from '@/lib/domain/analytics';
import { proposeRecommendation } from '@/lib/domain/recommendations';
import { demoRecords } from '@/lib/domain/demo';
import { answerQuestion, medicalPattern } from '@/lib/domain/chat';
import { context, checkOrigin, startDemo, demoEnabled, rateLimit, boundedBody } from './context';
import { type Repository } from './repository';
import { ApiError, fail } from './errors';
import { validateFile } from './parsers';
import { chatAnswer, extract } from './ai';

const recordsInput = z.object({ records: z.array(observationSchema).min(1).max(2000) }).strict();
const analyzeInput = z
  .object({
    date: dateSchema,
    demo: z.boolean().default(false),
    consent: z.boolean().default(false),
  })
  .strict();
async function json(request: Request): Promise<unknown> {
  const bytes = await boundedBody(request, 1024 * 1024);
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return fail(400, 'invalid_json', 'Provide a valid JSON request body');
  }
}
function range(request: Request, state: State, windowDays = 28) {
  const params = new URL(request.url).searchParams;
  const date = today(state.profiles[0]?.timezone);
  const to = dateSchema.parse(params.get('to') ?? date);
  const from = dateSchema.parse(params.get('from') ?? addDays(to, 1 - windowDays));
  if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000)
    fail(422, 'invalid_range', 'Choose an ordered date range of at most 367 days');
  return { from, to };
}
function findUpload(state: State, id: string) {
  const upload = state.uploads.find((u) => u.id === idSchema.parse(id));
  if (!upload) fail(404, 'not_found', 'Upload not found');
  return upload;
}
// An extraction that never read the file: sample recognition, or manual entry
// without consent. Such an upload can be re-analyzed even after confirmation.
const unreadExtraction = (upload: Upload) =>
  upload.extraction?.mode === 'demo' || upload.extraction?.mode === 'manual';
async function analyzeUpload(
  repo: Repository,
  upload: Upload,
  options: z.infer<typeof analyzeInput>,
) {
  if (upload.status === 'confirmed' && !unreadExtraction(upload))
    fail(409, 'already_confirmed', 'Confirmed uploads cannot be reanalyzed');
  try {
    const bytes = await repo.getFile(upload.storage_path);
    const { extension, mime } = validateFile(upload.filename, bytes);
    const extraction = await extract({
      bytes,
      filename: upload.filename,
      extension,
      mime,
      kind: upload.kind,
      ...options,
    });
    const updated = { ...upload, status: 'review' as const, extraction, error: null };
    await repo.update('uploads', upload.id, { status: 'review', extraction, error: null });
    return updated;
  } catch (error) {
    await repo.update('uploads', upload.id, {
      status: 'failed',
      error:
        error instanceof ApiError
          ? error.message
          : 'Analysis failed. Retry or enter values manually.',
    });
    throw error;
  }
}
async function dispatch(request: NextRequest, segments: string[]) {
  const path = segments.join('/');
  const method = request.method;
  if (method !== 'GET') checkOrigin(request);
  if (path === 'health' && method === 'GET')
    return {
      service: 'Progresso',
      mode: demoEnabled() ? 'demo' : 'supabase',
      configured:
        demoEnabled() ||
        !!(
          process.env.NEXT_PUBLIC_SUPABASE_URL &&
          (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
        ),
      vision_available: !!process.env.OPENAI_API_KEY,
    };
  if (path === 'demo/session' && method === 'POST') {
    rateLimit('demo-sessions', 20);
    const { token, repo } = await startDemo(request);
    await repo.mutate('seed', { records: demoRecords(today()) });
    const response = NextResponse.json(
      { data: { user_id: repo.userId, mode: 'demo', seeded: true } },
      { status: 201 },
    );
    response.cookies.set('progresso_demo', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: new URL(request.url).protocol === 'https:',
      path: '/',
      maxAge: 86400 * 7,
    });
    return response;
  }
  const { repo, mode } = await context(request);
  rateLimit(`${repo.userId}:all`, 120);
  if (method !== 'GET') rateLimit(`${repo.userId}:write`, 40);
  if (path === 'onboarding' && method === 'POST')
    return repo.mutate('onboard', onboardingSchema.parse(await json(request)));
  if (path === 'demo/seed' && method === 'POST') {
    if (mode !== 'demo')
      fail(403, 'demo_only', 'Sample history is only enabled in local demo mode');
    return repo.mutate('seed', { records: demoRecords(today()) });
  }
  const state = await repo.state();
  const date = today(state.profiles[0]?.timezone);
  if (path === 'profile' && method === 'GET')
    return {
      profile: state.profiles[0] ?? null,
      goals: state.goals.sort((a, b) => a.priority - b.priority),
      mode,
    };
  if (path === 'home' && method === 'GET') {
    const recommendation =
      state.recommendations.find((r) => r.status === 'active' && r.ends_on >= date) ??
      [...state.recommendations]
        .filter((r) => r.ends_on >= date)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ??
      null;
    const progress = state.recommendation_progress.filter(
      (p) => p.recommendation_id === recommendation?.id,
    );
    const summary = summarize(state.health_records, addDays(date, -6), date);
    return {
      profile: state.profiles[0] ?? null,
      goals: state.goals,
      mode,
      date,
      recommendation,
      progress,
      completed: progress.reduce((s, p) => s + p.amount, 0),
      cards: categories
        .filter((c) => !['other', 'body_metrics'].includes(c))
        .map((category) => ({
          category,
          metrics: summary.filter(
            (s) => state.health_records.find((r) => r.metric === s.metric)?.category === category,
          ),
        })),
      notice: wellnessNotice,
    };
  }
  if (path === 'records' && method === 'GET') {
    const { from, to } = range(request, state);
    return {
      records: state.health_records.filter((r) => r.date >= from && r.date <= to),
      from,
      to,
    };
  }
  if (path === 'records' && method === 'POST') {
    const input = recordsInput.parse(await json(request));
    return repo.mutate('records', {
      records: input.records.map((r) => ({ ...r, source: 'Manual', confidence: 1 })),
    });
  }
  if (path === 'timeline' && method === 'GET') {
    const view = z
      .enum(['day', 'week', 'month'])
      .parse(request.nextUrl.searchParams.get('view') ?? 'month');
    const { from, to } = range(request, state, view === 'day' ? 1 : view === 'week' ? 7 : 28);
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const records = state.health_records.filter((r) => r.date === d);
      days.push({
        date: d,
        records,
        metrics: dailyMetrics(records),
        meals: state.meals.filter((m) => m.date === d),
        uploads: state.uploads.filter((u) => records.some((r) => r.raw_upload_id === u.id)),
      });
    }
    return { view, from, to, days, trends: trends(state.health_records, from, to) };
  }
  if (path === 'insights' && method === 'GET') {
    const metrics = summarize(state.health_records, addDays(date, -6), date);
    const proposed = proposeRecommendation(state.health_records, state.goals, date);
    return {
      next_step: proposed,
      strongest_areas: metrics.filter(
        (m) =>
          m.days >= 4 &&
          ((m.metric === 'steps' && m.value >= 6000) ||
            (m.metric === 'sleep_duration' && m.value >= 7) ||
            (m.metric === 'strength_minutes' && m.value >= 60)),
      ),
      trends: trends(state.health_records, addDays(date, -6), date),
      medical_uploads: state.uploads.filter((u) => u.extraction?.medical).map((u) => u.id),
      notice: wellnessNotice,
    };
  }
  if (path === 'recommendations' && method === 'GET')
    return { recommendations: state.recommendations, progress: state.recommendation_progress };
  if (path === 'recommendations' && method === 'POST') {
    if (!state.profiles[0])
      fail(409, 'onboarding_required', 'Choose your goals before generating a recommendation');
    return repo.mutate('recommend', proposeRecommendation(state.health_records, state.goals, date));
  }
  if (
    segments[0] === 'recommendations' &&
    segments[2] === 'progress' &&
    segments.length === 3 &&
    method === 'POST'
  ) {
    const input = progressSchema.parse(await json(request));
    if (input.date > date)
      fail(422, 'future_progress', 'Progress cannot be recorded in the future');
    return repo.mutate('progress', { ...input, recommendation_id: idSchema.parse(segments[1]) });
  }
  if (segments[0] === 'recommendations' && segments.length === 2 && method === 'PATCH') {
    const input = z
      .object({ status: z.literal('dismissed') })
      .strict()
      .parse(await json(request));
    await repo.update('recommendations', idSchema.parse(segments[1]), input);
    return { dismissed: true };
  }
  if (path === 'uploads' && method === 'GET')
    return { uploads: state.uploads.sort((a, b) => b.created_at.localeCompare(a.created_at)) };
  if (path === 'uploads' && method === 'POST') {
    rateLimit(`${repo.userId}:analysis`, 10);
    const bytes = await boundedBody(request, 4 * 1024 * 1024 + 65536);
    let form: FormData;
    try {
      form = await new Request(request.url, {
        method: 'POST',
        headers: { 'Content-Type': request.headers.get('content-type') ?? '' },
        body: bytes,
      }).formData();
    } catch {
      fail(400, 'invalid_form', 'Provide multipart form data with a file');
    }
    const file = form.get('file');
    if (!(file instanceof File)) fail(422, 'file_required', 'Choose a file to upload');
    const content = new Uint8Array(await file.arrayBuffer());
    const { mime } = validateFile(file.name, content);
    const kind = z.enum(['health', 'meal']).parse(form.get('kind') ?? 'health');
    if (kind === 'meal' && !mime.startsWith('image/'))
      fail(415, 'image_required', 'Choose a JPG, PNG, or WebP meal photo');
    const options = analyzeInput.parse({
      date: form.get('date') ?? date,
      demo: form.get('demo') === 'true',
      consent: form.get('consent') === 'true',
    });
    const hash = createHash('sha256').update(content).digest('hex');
    const existing = state.uploads.find((u) => u.sha256 === hash && u.kind === kind);
    if (existing) {
      if (!options.demo && options.consent && existing.status === 'confirmed' && unreadExtraction(existing)) {
        // The same file was previously confirmed using sample recognition or
        // manual entry. Re-analyze the stored upload now that the user asked
        // for a real AI read of the file. Report it as a fresh analysis so the
        // client does not trigger a second AI call for the same request.
        return { upload: await analyzeUpload(repo, existing, options), duplicate: false };
      }
      if (existing.status === 'failed') {
        // A failed storage write must be recoverable with the same file hash.
        const storage_path = `${repo.userId}/${randomUUID()}`;
        await repo.putFile(storage_path, content, mime);
        await repo.update('uploads', existing.id, { storage_path, status: 'pending', error: null });
        return {
          upload: await analyzeUpload(
            repo,
            { ...existing, storage_path, status: 'pending' },
            options,
          ),
          duplicate: false,
        };
      }
      return { upload: existing, duplicate: true };
    }
    const id = randomUUID();
    const upload: Upload = {
      id,
      user_id: repo.userId,
      filename: file.name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(-180),
      mime_type: mime,
      size_bytes: file.size,
      sha256: hash,
      storage_path: `${repo.userId}/${id}`,
      kind,
      status: 'pending',
      extraction: null,
      error: null,
      created_at: new Date().toISOString(),
    };
    await repo.insert('uploads', upload);
    try {
      await repo.putFile(upload.storage_path, content, mime);
    } catch (error) {
      await repo.update('uploads', id, {
        status: 'failed',
        error: 'File storage failed. Upload the file again after checking storage configuration.',
      });
      throw error;
    }
    return { upload: await analyzeUpload(repo, upload, options), duplicate: false };
  }
  if (segments[0] === 'uploads' && segments.length >= 2) {
    const upload = findUpload(state, segments[1]);
    if (segments.length === 2 && method === 'GET') return { upload };
    if (segments[2] === 'file' && segments.length === 3 && method === 'GET')
      return new NextResponse(Buffer.from(await repo.getFile(upload.storage_path)), {
        headers: {
          'Content-Type': upload.mime_type,
          'Content-Disposition': `attachment; filename="${upload.filename.replaceAll('"', '_')}"`,
          'Cache-Control': 'private, no-store',
        },
      });
    if (segments[2] === 'analyze' && segments.length === 3 && method === 'POST') {
      rateLimit(`${repo.userId}:analysis`, 10);
      return { upload: await analyzeUpload(repo, upload, analyzeInput.parse(await json(request))) };
    }
    if (segments[2] === 'confirm' && segments.length === 3 && method === 'POST') {
      const input = recordsInput.parse(await json(request));
      return repo.mutate('confirm_upload', { ...input, upload_id: upload.id });
    }
  }
  if (path === 'meals' && method === 'GET') {
    const { from, to } = range(request, state);
    return { meals: state.meals.filter((m) => m.date >= from && m.date <= to) };
  }
  if (path === 'meals' && method === 'POST')
    return repo.mutate('save_meal', mealSchema.parse(await json(request)));
  if (segments[0] === 'meals' && segments.length === 2 && method === 'PATCH')
    return repo.mutate('save_meal', {
      ...mealSchema.parse(await json(request)),
      id: idSchema.parse(segments[1]),
    });
  if (path === 'chat' && method === 'POST') {
    const input = z
      .object({
        question: z.string().trim().min(1).max(1000),
        from: dateSchema.optional(),
        to: dateSchema.optional(),
      })
      .strict()
      .parse(await json(request));
    if (
      input.from &&
      input.to &&
      (input.from > input.to || Date.parse(input.to) - Date.parse(input.from) > 366 * 86400000)
    )
      fail(422, 'invalid_range', 'Choose an ordered date range of at most 367 days');
    // Medical topics always get the deterministic clinician referral, AI or not.
    if (medicalPattern.test(input.question))
      return answerQuestion(input.question, state, date, input.from, input.to);
    const to = input.to ?? date;
    const from = input.from ?? addDays(to, -27);
    const records = state.health_records.filter((r) => r.date >= from && r.date <= to);
    const chatTrends = trends(state.health_records, from, to);
    const active = state.recommendations.find((r) => r.status === 'active' && r.ends_on >= date);
    const ai = await chatAnswer({
      question: input.question,
      date,
      from,
      to,
      trends: chatTrends.map((t) => ({
        metric: t.metric,
        value: t.value,
        unit: t.unit,
        coverage: t.coverage,
      })),
      logged_days: new Set(records.map((r) => r.date)).size,
      goals: state.goals.map((g) => g.goal),
      recommendation: active ? { title: active.title, why: active.why } : null,
      sample_data: records.some((r) => r.is_demo),
    });
    if (ai !== null)
      return {
        answer: ai,
        evidence: chatTrends,
        contains_demo_data: records.some((r) => r.is_demo),
        mode: 'ai_chat',
        from,
        to,
        notice: wellnessNotice,
      };
    return answerQuestion(input.question, state, date, input.from, input.to);
  }
  fail(404, 'not_found', 'Endpoint not found');
}
export async function handleApi(request: NextRequest, segments: string[]) {
  const requestId = randomUUID();
  try {
    const result = await dispatch(request, segments);
    const response = result instanceof NextResponse ? result : NextResponse.json({ data: result });
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Request-Id', requestId);
    return response;
  } catch (error) {
    const status = error instanceof ZodError ? 422 : error instanceof ApiError ? error.status : 500;
    const code =
      error instanceof ZodError
        ? 'validation_error'
        : error instanceof ApiError
          ? error.code
          : 'internal_error';
    const message =
      error instanceof ZodError
        ? 'Check the submitted fields'
        : error instanceof ApiError
          ? error.message
          : 'The request could not be completed';
    // Deliberately never log request bodies, files, provider errors, or health values.
    if (status === 500) console.error('Progresso request failed', { requestId, code });
    return NextResponse.json(
      {
        error: {
          code,
          message,
          request_id: requestId,
          ...(error instanceof ZodError
            ? { fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }
            : {}),
        },
      },
      {
        status,
        headers: {
          'Cache-Control': 'private, no-store',
          'X-Request-Id': requestId,
          ...(status === 429 ? { 'Retry-After': '60' } : {}),
        },
      },
    );
  }
}
