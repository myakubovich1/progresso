import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = process.env.PROGRESSO_BASE_URL || 'http://localhost:3000';
let cookie = '';
async function call(route, method = 'GET', body) {
  const response = await fetch(`${base}/api/${route}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const data = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(data)}`);
  return data.data;
}
const status = await call('health');
assert.equal(status.mode, 'demo', 'Start the server using npm run dev:demo');
await call('demo/session', 'POST');
await call('onboarding', 'POST', {
  display_name: 'Smoke test',
  age_range: '25-34',
  activity_level: 'moderate',
  preferred_units: 'metric',
  timezone: 'UTC',
  goals: ['cardio'],
});
const date = new Date().toISOString().slice(0, 10);
const form = new FormData();
form.append(
  'file',
  new File([`date,metric,value,unit\n${date},steps,9999,steps`], 'smoke.csv', { type: 'text/csv' }),
);
const { upload } = await call('uploads', 'POST', form);
assert.equal(upload.extraction.mode, 'parsed');
await call(`uploads/${upload.id}/confirm`, 'POST', { records: upload.extraction.records });
assert.equal(
  (await call(`uploads/${upload.id}/confirm`, 'POST', { records: upload.extraction.records }))
    .already_confirmed,
  true,
);
const timeline = await call(`timeline?from=${date}&to=${date}&view=day`);
assert.ok(timeline.days[0].records.some((r) => r.value === 9999));
const rec = await call('recommendations', 'POST', {});
assert.equal(rec.category, 'cardio');
await call(`recommendations/${rec.id}/progress`, 'POST', {
  date,
  amount: 1,
  note: 'Completed',
  idempotency_key: randomUUID(),
});
const meal = await call('meals', 'POST', {
  date,
  name: 'Oats',
  items: [
    { name: 'Oats', quantity: 2, serving: '40g', calories: 150, protein: 5, carbs: 27, fat: 3 },
  ],
});
assert.equal(meal.calories, 300);
const answer = await call('chat', 'POST', { question: 'How has my sleep changed this month?' });
assert.ok(answer.evidence.length > 0);
assert.equal((await call('home')).completed, 1);
const aliceCookie = cookie;
await call('demo/session', 'POST');
const denied = await fetch(`${base}/api/uploads/${upload.id}`, { headers: { cookie } });
assert.equal(denied.status, 404);
const file = await fetch(`${base}/api/uploads/${upload.id}/file`, {
  headers: { cookie: aliceCookie },
});
assert.equal(file.status, 200);
assert.ok((await file.text()).includes('9999'));
console.log(
  'PASS: live HTTP onboarding, upload, confirmation retry, timeline, recommendations, progress, meals, grounded search, private download, and cross-session isolation.',
);
