import { z } from 'zod';

export const categories = [
  'sleep',
  'movement',
  'cardio',
  'strength',
  'nutrition',
  'recovery',
  'body_metrics',
  'other',
] as const;
export const goalNames = [
  'sleep',
  'fitness',
  'weight_loss',
  'muscle_gain',
  'energy',
  'cardio',
  'general_health',
] as const;
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Use a real calendar date (YYYY-MM-DD)');
export const idSchema = z.string().uuid();
export const metricCatalog = {
  sleep_duration: { category: 'sleep', unit: 'h', max: 24, label: 'Sleep' },
  steps: { category: 'movement', unit: 'steps', max: 200000, label: 'Steps' },
  cardio_minutes: { category: 'cardio', unit: 'min', max: 1440, label: 'Cardio' },
  strength_minutes: { category: 'strength', unit: 'min', max: 1440, label: 'Strength' },
  calories: { category: 'nutrition', unit: 'kcal', max: 30000, label: 'Calories' },
  protein: { category: 'nutrition', unit: 'g', max: 2000, label: 'Protein' },
  carbs: { category: 'nutrition', unit: 'g', max: 5000, label: 'Carbohydrates' },
  fat: { category: 'nutrition', unit: 'g', max: 2000, label: 'Fat' },
  weight: { category: 'body_metrics', unit: 'kg', max: 700, label: 'Weight' },
  resting_heart_rate: { category: 'recovery', unit: 'bpm', max: 300, label: 'Resting heart rate' },
  hrv: { category: 'recovery', unit: 'ms', max: 1000, label: 'Heart rate variability' },
  recovery_score: { category: 'recovery', unit: '%', max: 100, label: 'Recovery' },
} as const;
export type KnownMetric = keyof typeof metricCatalog;
export const observationSchema = z
  .object({
    date: dateSchema,
    category: z.enum(categories),
    metric: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9_]*$/),
    value: z.number().finite().min(0).max(1e9),
    unit: z.string().trim().min(1).max(24),
    source: z.string().trim().min(1).max(120),
    confidence: z.number().min(0).max(1),
    is_demo: z.boolean().default(false),
  })
  .strict()
  .superRefine((r, ctx) => {
    const spec = metricCatalog[r.metric as KnownMetric];
    if (spec && (r.unit !== spec.unit || r.category !== spec.category || r.value > spec.max)) {
      ctx.addIssue({
        code: 'custom',
        message: `${r.metric} requires ${spec.category}, ${spec.unit}, and value 0–${spec.max}`,
      });
    }
    if (!spec && r.category !== 'other')
      ctx.addIssue({ code: 'custom', message: 'Unrecognized metrics must use the other category' });
  });
export type Observation = z.infer<typeof observationSchema>;
export type HealthRecord = Observation & {
  id: string;
  user_id: string;
  raw_upload_id: string | null;
  meal_id: string | null;
  fingerprint: string;
  created_at: string;
};
export const onboardingSchema = z
  .object({
    display_name: z.string().trim().min(1).max(80),
    age_range: z.enum(['18-24', '25-34', '35-44', '45-54', '55-64', '65+']),
    height_cm: z.number().min(50).max(280).nullable().default(null),
    weight_kg: z.number().min(20).max(700).nullable().default(null),
    activity_level: z.enum(['sedentary', 'light', 'moderate', 'active', 'very_active']),
    preferred_units: z.enum(['metric', 'imperial']),
    timezone: z
      .string()
      .max(80)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }),
    goals: z
      .array(z.enum(goalNames))
      .min(1)
      .max(7)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export type Profile = Omit<z.infer<typeof onboardingSchema>, 'goals'> & {
  user_id: string;
  onboarding_completed: boolean;
  created_at: string;
};
export type Goal = {
  id: string;
  user_id: string;
  goal: (typeof goalNames)[number];
  priority: number;
  created_at: string;
};
export const mealItemSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    quantity: z.number().positive().max(100),
    serving: z.string().trim().min(1).max(80),
    calories: z.number().min(0).max(10000),
    protein: z.number().min(0).max(1000),
    carbs: z.number().min(0).max(1000),
    fat: z.number().min(0).max(1000),
  })
  .strict();
export const mealSchema = z
  .object({
    date: dateSchema,
    name: z.string().trim().min(1).max(120),
    items: z.array(mealItemSchema).min(1).max(30),
    raw_upload_id: idSchema.nullable().default(null),
    is_demo: z.boolean().default(false),
  })
  .strict()
  .superRefine((meal, ctx) => {
    for (const key of ['calories', 'protein', 'carbs', 'fat'] as const) {
      if (meal.items.reduce((sum, i) => sum + i[key] * i.quantity, 0) > metricCatalog[key].max) {
        ctx.addIssue({ code: 'custom', message: `Meal total ${key} is outside supported range` });
      }
    }
  });
export type MealInput = z.infer<typeof mealSchema>;
export type Meal = MealInput & {
  id: string;
  user_id: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  created_at: string;
};
export type Extraction = {
  records: Observation[];
  meal: MealInput | null;
  mode: 'parsed' | 'ai' | 'demo' | 'manual';
  source: string;
  warnings: string[];
  medical: boolean;
};
export type Upload = {
  id: string;
  user_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  kind: 'health' | 'meal';
  status: 'pending' | 'review' | 'confirmed' | 'failed';
  extraction: Extraction | null;
  error: string | null;
  created_at: string;
};
export type Evidence = {
  metric: string;
  value: number;
  unit: string;
  days: number;
  record_ids: string[];
};
export type Recommendation = {
  id: string;
  user_id: string;
  category: (typeof categories)[number];
  title: string;
  why: string;
  target: number;
  progress_unit: string;
  evidence: Evidence[];
  starts_on: string;
  ends_on: string;
  status: 'active' | 'completed' | 'dismissed';
  is_demo: boolean;
  created_at: string;
};
export const progressSchema = z
  .object({
    amount: z.number().positive().max(10000),
    date: dateSchema,
    note: z.string().trim().max(500).default(''),
    idempotency_key: idSchema,
  })
  .strict();
export type Progress = z.infer<typeof progressSchema> & {
  id: string;
  user_id: string;
  recommendation_id: string;
  created_at: string;
};
export type State = {
  profiles: Profile[];
  goals: Goal[];
  uploads: Upload[];
  health_records: HealthRecord[];
  meals: Meal[];
  recommendations: Recommendation[];
  recommendation_progress: Progress[];
};
export type Table = keyof State;
export type Row<K extends Table> = State[K][number];
export const emptyState = (): State => ({
  profiles: [],
  goals: [],
  uploads: [],
  health_records: [],
  meals: [],
  recommendations: [],
  recommendation_progress: [],
});
export function today(timezone = 'UTC', now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const wellnessNotice =
  'Wellness and fitness guidance, not medical advice. Discuss medical findings or concerning symptoms with a qualified clinician.';
