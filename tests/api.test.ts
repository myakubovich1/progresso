import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { handleApi } from '@/lib/server/api';
import { today } from '@/lib/domain/schema';
let directory: string;
let alice = '';
let bob = '';
async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = alice,
  headers: Record<string, string> = {},
) {
  const req = new NextRequest(`http://localhost/api/${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...headers,
      ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const response = await handleApi(req, path.split('?')[0].split('/'));
  return { response, ...(await response.json()) };
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'progresso-api-'));
  vi.stubEnv('PROGRESSO_DEMO_MODE', 'true');
  vi.stubEnv('PROGRESSO_DEMO_DIR', directory);
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('VERCEL', '');
  for (const user of ['alice', 'bob']) {
    const { response } = await call('demo/session', 'POST', undefined, '');
    const cookie = `progresso_demo=${response.cookies.get('progresso_demo')?.value}`;
    if (user === 'alice') alice = cookie;
    else bob = cookie;
  }
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
it('rejects unauthenticated access and cross-site writes', async () => {
  expect((await call('home', 'GET', undefined, '')).response.status).toBe(401);
  expect(
    (await call('home', 'GET', undefined, 'progresso_demo=' + 'a'.repeat(64))).response.status,
  ).toBe(401);
  expect(
    (await call('onboarding', 'POST', {}, alice, { origin: 'https://attacker.example' })).response
      .status,
  ).toBe(403);
});
it('runs onboard → upload → edit/confirm → timeline → recommendation → meal → progress → chat', async () => {
  const profile = {
    display_name: 'Alex',
    age_range: '25-34',
    activity_level: 'moderate',
    preferred_units: 'metric',
    timezone: 'UTC',
    goals: ['cardio', 'energy'],
  };
  expect(
    (await call('onboarding', 'POST', { ...profile, user_id: randomUUID() })).response.status,
  ).toBe(422);
  expect((await call('onboarding', 'POST', profile)).response.status).toBe(200);
  const file = new File(
    [`date,metric,value,unit\n${today()},sleep_duration,7.75,h`],
    'health.csv',
    { type: 'text/csv' },
  );
  const form = new FormData();
  form.append('file', file);
  const uploaded = await call('uploads', 'POST', form);
  expect(uploaded.response.status).toBe(200);
  const upload = uploaded.data.upload;
  expect(upload.status).toBe('review');
  expect(upload.extraction.mode).toBe('parsed');
  expect((await call(`uploads/${upload.id}`, 'GET', undefined, bob)).response.status).toBe(404);
  expect((await call('uploads', 'POST', form)).data.duplicate).toBe(true);
  upload.extraction.records[0].value = 7.8;
  expect(
    (await call(`uploads/${upload.id}/confirm`, 'POST', { records: upload.extraction.records }))
      .data.inserted,
  ).toBe(1);
  expect(
    (await call(`uploads/${upload.id}/confirm`, 'POST', { records: upload.extraction.records }))
      .data.already_confirmed,
  ).toBe(true);
  const timeline = await call(`timeline?from=${today()}&to=${today()}&view=day`);
  expect(timeline.data.days[0].records.some((r: { value: number }) => r.value === 7.8)).toBe(true);
  const rec = (await call('recommendations', 'POST', {})).data;
  expect(rec.category).toBe('cardio');
  expect(rec.target).toBe(2);
  const meal = (
    await call('meals', 'POST', {
      date: today(),
      name: 'Yogurt',
      items: [
        {
          name: 'Greek yogurt',
          quantity: 2,
          serving: '100 g',
          calories: 60,
          protein: 10,
          carbs: 4,
          fat: 0,
        },
      ],
    })
  ).data;
  expect(meal.protein).toBe(20);
  const p = {
    amount: 1,
    date: today(),
    note: 'A comfortable session',
    idempotency_key: randomUUID(),
  };
  expect((await call(`recommendations/${rec.id}/progress`, 'POST', p)).response.status).toBe(200);
  expect((await call(`recommendations/${rec.id}/progress`, 'POST', p)).response.status).toBe(200);
  expect((await call('home')).data.completed).toBe(1);
  const answer = await call('chat', 'POST', { question: 'How has my sleep changed this month?' });
  expect(answer.data.evidence.length).toBeGreaterThan(0);
  expect(answer.response.headers.get('cache-control')).toContain('no-store');
});
it('requires explicit demo recognition and keeps samples marked after confirmation', async () => {
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const form = new FormData();
  form.append('file', new File([image], 'sleep.png', { type: 'image/png' }));
  let result = await call('uploads', 'POST', form);
  expect(result.data.upload.extraction.mode).toBe('manual');
  expect(result.data.upload.extraction.records).toHaveLength(0);
  const id = result.data.upload.id;
  result = await call(`uploads/${id}/analyze`, 'POST', { date: today(), demo: true });
  expect(result.data.upload.extraction.mode).toBe('demo');
  const rows = result.data.upload.extraction.records.map((r: Record<string, unknown>) => ({
    ...r,
    is_demo: false,
  }));
  await call(`uploads/${id}/confirm`, 'POST', { records: rows });
  const records = (await call('records')).data.records.filter(
    (r: { raw_upload_id: string }) => r.raw_upload_id === id,
  );
  expect(records.length).toBeGreaterThan(0);
  expect(records.every((r: { is_demo: boolean }) => r.is_demo)).toBe(true);
});
it('retains failed upload metadata, rejects spoofed files, and bounds date windows', async () => {
  const form = new FormData();
  form.append('file', new File(['bad csv'], 'broken.csv'));
  expect((await call('uploads', 'POST', form)).response.status).toBe(422);
  expect(
    (await call('uploads')).data.uploads.some((u: { status: string }) => u.status === 'failed'),
  ).toBe(true);
  const fake = new FormData();
  fake.append('file', new File(['not a png'], 'fake.png'));
  expect((await call('uploads', 'POST', fake)).response.status).toBe(415);
  expect((await call('timeline?from=2026-09-20&to=2026-09-01')).response.status).toBe(422);
});
