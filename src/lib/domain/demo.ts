import { addDays, type Observation, type MealInput } from './schema';
export function demoRecords(date: string): Observation[] {
  const records: Observation[] = [];
  for (let i = 27; i >= 0; i--) {
    const day = addDays(date, -i);
    const base = { date: day, source: 'Progresso sample history', confidence: 1, is_demo: true };
    records.push({
      ...base,
      category: 'sleep',
      metric: 'sleep_duration',
      value: Math.round((7.3 + Math.sin(i * 1.7) * 0.5) * 10) / 10,
      unit: 'h',
    });
    records.push({
      ...base,
      category: 'movement',
      metric: 'steps',
      value: 7200 + ((i * 379) % 3400),
      unit: 'steps',
    });
    records.push({
      ...base,
      category: 'cardio',
      metric: 'cardio_minutes',
      value: i % 6 === 0 ? 15 : 0,
      unit: 'min',
    });
    records.push({
      ...base,
      category: 'strength',
      metric: 'strength_minutes',
      value: i % 3 === 0 ? 45 : 0,
      unit: 'min',
    });
    records.push({
      ...base,
      category: 'recovery',
      metric: 'resting_heart_rate',
      value: 58 + (i % 5),
      unit: 'bpm',
    });
    records.push({
      ...base,
      category: 'nutrition',
      metric: 'protein',
      value: 100 + (i % 7) * 5,
      unit: 'g',
    });
  }
  return records;
}
export function demoMeal(date: string): MealInput {
  return {
    date,
    name: 'Sample chicken grain bowl',
    raw_upload_id: null,
    is_demo: true,
    items: [
      {
        name: 'Grilled chicken',
        quantity: 1,
        serving: '120 g',
        calories: 198,
        protein: 37,
        carbs: 0,
        fat: 4.3,
      },
      {
        name: 'Cooked brown rice',
        quantity: 1,
        serving: '150 g',
        calories: 185,
        protein: 4,
        carbs: 38,
        fat: 1.5,
      },
      {
        name: 'Mixed vegetables',
        quantity: 1,
        serving: '100 g',
        calories: 45,
        protein: 2,
        carbs: 9,
        fat: 0.4,
      },
    ],
  };
}
