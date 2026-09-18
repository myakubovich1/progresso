import { observationSchema, metricCatalog, type KnownMetric, type Observation } from './schema';

const aliases: Record<string, KnownMetric> = {
  sleep: 'sleep_duration',
  sleep_hours: 'sleep_duration',
  sleep_duration: 'sleep_duration',
  steps: 'steps',
  step_count: 'steps',
  hkquantitytypeidentifierstepcount: 'steps',
  cardio: 'cardio_minutes',
  cardio_minutes: 'cardio_minutes',
  running: 'cardio_minutes',
  strength: 'strength_minutes',
  strength_minutes: 'strength_minutes',
  calories: 'calories',
  energy: 'calories',
  dietary_energy: 'calories',
  hkquantitytypeidentifierdietaryenergyconsumed: 'calories',
  protein: 'protein',
  hkquantitytypeidentifierdietaryprotein: 'protein',
  carbs: 'carbs',
  carbohydrates: 'carbs',
  hkquantitytypeidentifierdietarycarbohydrates: 'carbs',
  fat: 'fat',
  hkquantitytypeidentifierdietaryfattotal: 'fat',
  weight: 'weight',
  body_mass: 'weight',
  hkquantitytypeidentifierbodymass: 'weight',
  resting_heart_rate: 'resting_heart_rate',
  resting_hr: 'resting_heart_rate',
  hkquantitytypeidentifierrestingheartrate: 'resting_heart_rate',
  hrv: 'hrv',
  hkquantitytypeidentifierheartratevariabilitysdnn: 'hrv',
  recovery_score: 'recovery_score',
};
export function normalizeObservation(
  input: Record<string, unknown>,
  source = 'Imported file',
): Observation {
  const rawMetric = String(input.metric ?? input.type ?? '')
    .toLowerCase()
    .replace(/[ -]/g, '_');
  const metric = aliases[rawMetric] ?? rawMetric;
  const spec = metricCatalog[metric as KnownMetric];
  if (input.value === undefined || input.value === null || String(input.value).trim() === '')
    throw new Error('Missing numeric value');
  let value =
    typeof input.value === 'number' ? input.value : Number(String(input.value).replace(/,/g, ''));
  let unit = String(input.unit ?? spec?.unit ?? 'unknown').toLowerCase();
  if (metric === 'weight' && ['lb', 'lbs'].includes(unit)) {
    value *= 0.45359237;
    unit = 'kg';
  }
  if (metric === 'sleep_duration' && ['min', 'minutes'].includes(unit)) {
    value /= 60;
    unit = 'h';
  }
  if (metric.endsWith('_minutes') && ['h', 'hours'].includes(unit)) {
    value *= 60;
    unit = 'min';
  }
  if (metric.endsWith('_minutes') && ['s', 'sec'].includes(unit)) {
    value /= 60;
    unit = 'min';
  }
  unit =
    (
      {
        hours: 'h',
        hour: 'h',
        minutes: 'min',
        count: 'steps',
        'count/min': 'bpm',
        percent: '%',
        grams: 'g',
      } as Record<string, string>
    )[unit] ?? unit;
  return observationSchema.parse({
    date: String(input.date ?? input.startDate ?? '').slice(0, 10),
    category: spec?.category ?? 'other',
    metric,
    value: Math.round(value * 1000) / 1000,
    unit,
    source: String(input.source ?? input.sourceName ?? source),
    confidence: input.confidence === undefined ? 1 : Number(input.confidence),
    is_demo: input.is_demo === true || input.is_demo === 'true',
  });
}
