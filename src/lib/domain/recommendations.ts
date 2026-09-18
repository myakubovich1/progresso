import { addDays, type Goal, type HealthRecord, type Recommendation } from './schema';
import { summarize } from './analytics';

export function proposeRecommendation(
  records: HealthRecord[],
  goals: Goal[],
  date: string,
): Omit<Recommendation, 'id' | 'user_id' | 'created_at' | 'status'> {
  const evidence = summarize(records, addDays(date, -6), date);
  const find = (metric: string) => evidence.find((e) => e.metric === metric);
  const sleep = find('sleep_duration'),
    cardio = find('cardio_minutes'),
    steps = find('steps'),
    strength = find('strength_minutes');
  const base = {
    starts_on: date,
    ends_on: addDays(date, 6),
    is_demo: records.some((r) => r.is_demo && r.date >= addDays(date, -6) && r.date <= date),
  };
  const candidates: {
    goal: string[];
    score: number;
    rec: Omit<Recommendation, 'id' | 'user_id' | 'created_at' | 'status' | keyof typeof base>;
  }[] = [];
  if (sleep && sleep.days >= 4 && sleep.value < 7)
    candidates.push({
      goal: ['sleep', 'energy', 'general_health'],
      score: 70,
      rec: {
        category: 'sleep',
        title: 'Try a consistent wind-down time on four evenings this week.',
        why: `Your recorded sleep averaged ${sleep.value} hours across ${sleep.days} days. A repeatable evening routine is a manageable habit to try; see how you feel afterward.`,
        target: 4,
        progress_unit: 'evenings',
        evidence: [sleep],
      },
    });
  if (cardio && cardio.days >= 4 && cardio.value < 60)
    candidates.push({
      goal: ['cardio', 'fitness', 'energy', 'general_health'],
      score: 60,
      rec: {
        category: 'cardio',
        title: 'Plan two 20-minute cardio sessions at a comfortable effort this week.',
        why: `You logged ${cardio.value} cardio minutes across ${cardio.days} days. ${strength && strength.value > 0 ? `You also logged ${strength.value} strength-training minutes. ` : ''}If these records reflect your week and this activity suits you, try two manageable sessions.`,
        target: 2,
        progress_unit: 'sessions',
        evidence: [cardio, ...(strength ? [strength] : [])],
      },
    });
  if (steps && steps.days >= 4 && steps.value < 6000)
    candidates.push({
      goal: ['fitness', 'energy', 'weight_loss', 'general_health'],
      score: 50,
      rec: {
        category: 'movement',
        title: 'Make time for a short walk on three days this week.',
        why: `You averaged ${steps.value} recorded steps across ${steps.days} days. A short walk is a small, trackable addition if it fits your abilities and routine.`,
        target: 3,
        progress_unit: 'walks',
        evidence: [steps],
      },
    });
  if (strength && strength.days >= 4 && strength.value < 30)
    candidates.push({
      goal: ['muscle_gain', 'fitness'],
      score: 50,
      rec: {
        category: 'strength',
        title: 'Schedule one familiar strength session this week.',
        why: `You recorded ${strength.value} strength minutes across ${strength.days} days. Start with a familiar routine appropriate to your experience.`,
        target: 1,
        progress_unit: 'sessions',
        evidence: [strength],
      },
    });
  for (const c of candidates) {
    const match = goals.find((g) => c.goal.includes(g.goal));
    if (match) c.score += 40 / match.priority;
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) return { ...base, ...candidates[0].rec };
  return {
    ...base,
    category: 'other',
    title: 'Log your sleep and activity on three days this week.',
    why: "There isn't enough consistent evidence of a specific actionable gap. Add records and how you feel; missing data is not treated as inactivity.",
    target: 3,
    progress_unit: 'days',
    evidence: evidence.slice(0, 3),
  };
}
