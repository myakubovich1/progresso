import { createHash, randomUUID } from 'node:crypto';
import type {
  State,
  Observation,
  HealthRecord,
  MealInput,
  Meal,
  Recommendation,
  Progress,
  Profile,
} from '@/lib/domain/schema';
import { fail } from './errors';
export type Mutation =
  'onboard' | 'records' | 'confirm_upload' | 'save_meal' | 'recommend' | 'progress' | 'seed';
export function fingerprint(r: Observation) {
  return createHash('md5')
    .update([r.date, r.metric, r.value, r.unit, r.source, String(r.is_demo)].join('|'))
    .digest('hex');
}
export function mutateState(
  state: State,
  userId: string,
  action: Mutation,
  payload: Record<string, unknown>,
): unknown {
  const created_at = new Date().toISOString();
  const meta = () => ({ id: randomUUID(), user_id: userId, created_at });
  if (action === 'onboard') {
    const { goals, ...profile } = payload;
    state.profiles = [
      { ...profile, user_id: userId, created_at, onboarding_completed: true } as Profile,
    ];
    state.goals = (goals as string[]).map((goal, i) => ({
      ...meta(),
      goal,
      priority: i + 1,
    })) as State['goals'];
    return { saved: true };
  }
  if (['records', 'confirm_upload', 'seed'].includes(action)) {
    const upload =
      action === 'confirm_upload'
        ? state.uploads.find((u) => u.id === payload.upload_id)
        : undefined;
    if (action === 'confirm_upload') {
      if (!upload) fail(404, 'not_found', 'Upload not found');
      if (upload.status === 'confirmed') return { already_confirmed: true };
      if (upload.status !== 'review' || upload.kind !== 'health')
        fail(409, 'not_ready', 'Upload is not ready for confirmation');
    }
    if (action === 'seed' && state.health_records.length) return { already_seeded: true };
    let inserted = 0;
    for (const input of payload.records as Observation[]) {
      const record = {
        ...input,
        is_demo: action === 'seed' || input.is_demo || upload?.extraction?.mode === 'demo',
      };
      const hash = fingerprint(record);
      if (state.health_records.some((r) => r.fingerprint === hash)) continue;
      state.health_records.push({
        ...record,
        ...meta(),
        fingerprint: hash,
        raw_upload_id: upload?.id ?? null,
        meal_id: null,
      });
      inserted++;
    }
    if (upload) upload.status = 'confirmed';
    return { inserted };
  }
  if (action === 'save_meal') {
    const input = payload as unknown as MealInput & { id?: string };
    const upload = input.raw_upload_id
      ? state.uploads.find((u) => u.id === input.raw_upload_id)
      : undefined;
    if (input.raw_upload_id && !upload) fail(404, 'not_found', 'Upload not found');
    if (upload && (upload.kind !== 'meal' || !['review', 'confirmed'].includes(upload.status)))
      fail(409, 'not_ready', 'Meal upload is not ready');
    const existing = input.id
      ? state.meals.find((m) => m.id === input.id)
      : state.meals.find((m) => m.raw_upload_id && m.raw_upload_id === input.raw_upload_id);
    if (input.id && !existing) fail(404, 'not_found', 'Meal not found');
    if (input.id && existing?.raw_upload_id !== input.raw_upload_id)
      fail(409, 'source_conflict', 'Cannot replace meal source');
    if (!input.id && existing) return existing;
    const totals = Object.fromEntries(
      ['calories', 'protein', 'carbs', 'fat'].map((key) => [
        key,
        Math.round(
          input.items.reduce((s, item) => s + item[key as 'calories'] * item.quantity, 0) * 10,
        ) / 10,
      ]),
    ) as Pick<Meal, 'calories' | 'protein' | 'carbs' | 'fat'>;
    const meal: Meal = {
      ...input,
      ...meta(),
      ...totals,
      id: existing?.id ?? randomUUID(),
      is_demo: input.is_demo || upload?.extraction?.mode === 'demo',
    };
    state.meals = [...state.meals.filter((m) => m.id !== meal.id), meal];
    state.health_records = state.health_records.filter((r) => r.meal_id !== meal.id);
    for (const metric of ['calories', 'protein', 'carbs', 'fat'] as const)
      state.health_records.push({
        ...meta(),
        date: meal.date,
        category: 'nutrition',
        metric,
        value: meal[metric],
        unit: metric === 'calories' ? 'kcal' : 'g',
        source: 'Meal estimate',
        confidence: 0.6,
        is_demo: meal.is_demo,
        meal_id: meal.id,
        raw_upload_id: meal.raw_upload_id,
        fingerprint: `${meal.id}:${metric}`,
      } as HealthRecord);
    if (upload) upload.status = 'confirmed';
    return meal;
  }
  if (action === 'recommend') {
    const active = state.recommendations.find((r) => r.status === 'active');
    if (active && active.ends_on >= String(payload.starts_on)) return active;
    if (active) active.status = 'dismissed';
    const rec = { ...payload, ...meta(), status: 'active' } as Recommendation;
    state.recommendations.push(rec);
    return rec;
  }
  if (action === 'progress') {
    const existing = state.recommendation_progress.find(
      (p) => p.idempotency_key === payload.idempotency_key,
    );
    if (existing) {
      if (existing.recommendation_id !== payload.recommendation_id)
        fail(409, 'idempotency_conflict', 'Idempotency key belongs to another recommendation');
      return existing;
    }
    const rec = state.recommendations.find((r) => r.id === payload.recommendation_id);
    if (!rec) fail(404, 'not_found', 'Recommendation not found');
    if (rec.status !== 'active') fail(409, 'inactive', 'Recommendation is no longer active');
    if (String(payload.date) < rec.starts_on || String(payload.date) > rec.ends_on)
      fail(422, 'invalid_date', 'Progress date is outside recommendation window');
    const total = state.recommendation_progress
      .filter((p) => p.recommendation_id === rec.id)
      .reduce((s, p) => s + p.amount, 0);
    if (total + Number(payload.amount) > rec.target)
      fail(422, 'target_exceeded', 'Progress exceeds target');
    const progress = { ...payload, ...meta() } as Progress;
    state.recommendation_progress.push(progress);
    if (total + progress.amount >= rec.target) rec.status = 'completed';
    return progress;
  }
  fail(400, 'invalid_operation', 'Unknown operation');
}
