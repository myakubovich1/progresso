import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { normalizeObservation } from '@/lib/domain/normalize';
import {
  emptyState,
  observationSchema,
  mealSchema,
  addDays,
  type HealthRecord,
} from '@/lib/domain/schema';
import { dailyMetrics, trends } from '@/lib/domain/analytics';
import { proposeRecommendation } from '@/lib/domain/recommendations';
import { demoRecords, demoMeal } from '@/lib/domain/demo';
import { answerQuestion } from '@/lib/domain/chat';
import { parseStructured, validateFile } from '@/lib/server/parsers';
import { mutateState } from '@/lib/server/mutations';
const date = '2026-09-18';
const user = randomUUID();
function record(input: Record<string, unknown>): HealthRecord {
  return {
    ...normalizeObservation(input),
    id: randomUUID(),
    user_id: user,
    raw_upload_id: null,
    meal_id: null,
    fingerprint: randomUUID(),
    created_at: new Date().toISOString(),
  };
}
describe('normalization and parsing', () => {
  it('converts units and rejects invalid dates/values', () => {
    expect(
      normalizeObservation({ date, metric: 'weight', value: 150, unit: 'lbs' }).value,
    ).toBeCloseTo(68.039, 3);
    expect(normalizeObservation({ date, metric: 'sleep', value: 420, unit: 'minutes' }).value).toBe(
      7,
    );
    expect(() =>
      normalizeObservation({ date: '2026-02-30', metric: 'steps', value: 100 }),
    ).toThrow();
    expect(() => normalizeObservation({ date, metric: 'steps', value: '' })).toThrow();
    expect(() => normalizeObservation({ date, metric: 'steps', value: -1 })).toThrow();
    expect(() =>
      observationSchema.parse({
        ...normalizeObservation({ date, metric: 'steps', value: 100 }),
        category: 'sleep',
      }),
    ).toThrow();
  });
  it('reads long and wide CSV, JSON, and XML without AI', () => {
    expect(
      parseStructured('date,metric,value,unit\n2026-09-18,steps,"8,500",steps', 'csv').records[0]
        .value,
    ).toBe(8500);
    expect(
      parseStructured('date,sleep_hours,steps\n2026-09-18,7.5,8000', 'csv').records,
    ).toHaveLength(2);
    expect(
      parseStructured(JSON.stringify({ records: [{ date, metric: 'steps', value: 3 }] }), 'json')
        .records[0].value,
    ).toBe(3);
    expect(
      parseStructured(`<health><record date="${date}" metric="steps" value="42"/></health>`, 'xml')
        .records[0].value,
    ).toBe(42);
  });
  it('merges overlapping Apple sleep stages without counting in-bed time', () => {
    const xml =
      '<HealthData>' +
      [
        [
          'HKCategoryValueSleepAnalysisInBed',
          '2026-09-17 22:00:00 -0400',
          '2026-09-18 08:00:00 -0400',
        ],
        [
          'HKCategoryValueSleepAnalysisAsleepUnspecified',
          '2026-09-17 23:00:00 -0400',
          '2026-09-18 07:00:00 -0400',
        ],
        [
          'HKCategoryValueSleepAnalysisAsleepCore',
          '2026-09-17 23:00:00 -0400',
          '2026-09-18 03:00:00 -0400',
        ],
      ]
        .map(
          ([value, startDate, endDate]) =>
            `<Record type="HKCategoryTypeIdentifierSleepAnalysis" value="${value}" startDate="${startDate}" endDate="${endDate}"/>`,
        )
        .join('') +
      '</HealthData>';
    const rows = parseStructured(xml, 'xml').records;
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(8);
    expect(rows[0].date).toBe(date);
  });
  it('rejects XML entities, malformed input, spoofed files, and oversized files', () => {
    expect(() =>
      parseStructured('<!DOCTYPE a [<!ENTITY e SYSTEM "file:///etc/passwd">]><a>&e;</a>', 'xml'),
    ).toThrow();
    expect(() => parseStructured('{bad', 'json')).toThrow();
    expect(() => validateFile('x.png', new TextEncoder().encode('not an image'))).toThrow();
    expect(() => validateFile('x.csv', new Uint8Array(4194305))).toThrow();
  });
});
describe('grounded analytics', () => {
  it('does not double count overlapping sources, but adds meals', () => {
    const a = record({ date, metric: 'steps', value: 8000, source: 'Watch' }),
      b = record({ date, metric: 'steps', value: 8500, source: 'Manual' });
    expect(dailyMetrics([a, b])[0].value).toBe(8500);
    const c = record({ date, metric: 'protein', value: 30 }),
      d = record({ date, metric: 'protein', value: 40 });
    c.meal_id = randomUUID();
    d.meal_id = randomUUID();
    expect(dailyMetrics([c, d])[0].value).toBe(70);
  });
  it('never interprets absent cardio records as zero', () => {
    const rows = demoRecords(date)
      .filter((r) => r.metric !== 'cardio_minutes')
      .map((r) => record(r));
    expect(proposeRecommendation(rows, [], date).category).not.toBe('cardio');
    expect(proposeRecommendation([], [], date).category).toBe('other');
  });
  it('uses goal-aware recommendations and makes sparse trends explicit', () => {
    const rows = demoRecords(date).map((r) => record(r));
    expect(proposeRecommendation(rows, [], date).category).toBe('cardio');
    expect(
      trends([record({ date, metric: 'steps', value: 3000 })], addDays(date, -6), date)[0].change,
    ).toBeNull();
  });
  it('grounds chat and refuses unsupported causal/medical claims', () => {
    const state = emptyState();
    state.health_records = demoRecords(date).map((r) => record(r));
    const answer = answerQuestion('How has my sleep changed this month?', state, date);
    expect(answer.evidence.length).toBeGreaterThan(0);
    expect(answer.answer).toContain('recorded');
    expect(answerQuestion('What changed when I started running?', state, date).answer).toContain(
      'cannot establish',
    );
    expect(answerQuestion('Diagnose my blood pressure', state, date).answer).toContain(
      'qualified clinician',
    );
  });
});
describe('atomic demo mutations', () => {
  it('seeds idempotently and deduplicates repeated records', () => {
    const state = emptyState();
    mutateState(state, user, 'seed', { records: demoRecords(date) });
    const count = state.health_records.length;
    mutateState(state, user, 'seed', { records: demoRecords(date) });
    expect(state.health_records).toHaveLength(count);
    mutateState(state, user, 'records', { records: [state.health_records[0]] });
    expect(state.health_records).toHaveLength(count);
  });
  it('saves editable meal macros and replaces linked timeline values', () => {
    const state = emptyState();
    const input = demoMeal(date);
    const meal = mutateState(state, user, 'save_meal', input) as { id: string; protein: number };
    expect(meal.protein).toBe(43);
    expect(state.health_records).toHaveLength(4);
    input.items[0].quantity = 2;
    mutateState(state, user, 'save_meal', { ...input, id: meal.id });
    expect(state.health_records).toHaveLength(4);
    expect(state.meals[0].protein).toBe(80);
    expect(() =>
      mealSchema.parse({ ...input, items: [{ ...input.items[0], quantity: 100 }] }),
    ).toThrow();
  });
  it('tracks completion idempotently and rejects excess/future-window progress', () => {
    const state = emptyState();
    const rec = mutateState(
      state,
      user,
      'recommend',
      proposeRecommendation(
        demoRecords(date).map((r) => record(r)),
        [],
        date,
      ),
    ) as { id: string };
    const p = {
      recommendation_id: rec.id,
      amount: 1,
      date,
      note: '',
      idempotency_key: randomUUID(),
    };
    mutateState(state, user, 'progress', p);
    mutateState(state, user, 'progress', p);
    expect(state.recommendation_progress).toHaveLength(1);
    expect(() =>
      mutateState(state, user, 'progress', { ...p, amount: 2, idempotency_key: randomUUID() }),
    ).toThrow();
    mutateState(state, user, 'progress', { ...p, idempotency_key: randomUUID() });
    expect(state.recommendations[0].status).toBe('completed');
  });
});
