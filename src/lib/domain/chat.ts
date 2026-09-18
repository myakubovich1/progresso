import { addDays, wellnessNotice, type State } from './schema';
import { summarize, trends } from './analytics';
import { proposeRecommendation } from './recommendations';

// Deterministic retrieval prevents fabricated medical advice or untraceable numbers.
// A future language layer can paraphrase this evidence packet without changing facts.
export function answerQuestion(
  question: string,
  state: State,
  date: string,
  from?: string,
  to?: string,
) {
  const q = question.toLowerCase();
  if (
    /diagnos|disease|medicat|blood pressure|chest pain|faint|symptom|glucose|lab result|concerning|abnormal/.test(
      q,
    )
  )
    return {
      answer: `Progresso cannot interpret medical findings or diagnose conditions. Please discuss these findings or symptoms with a qualified clinician.`,
      evidence: [],
      mode: 'grounded_search',
      notice: wellnessNotice,
    };
  const end = to ?? date;
  const start = from ?? (q.includes('month') ? `${date.slice(0, 7)}-01` : addDays(end, -6));
  const records = state.health_records.filter((r) => r.date <= end);
  const base = {
    mode: 'grounded_search',
    from: start,
    to: end,
    notice: wellnessNotice,
    contains_demo_data: records.some((r) => r.is_demo && r.date >= start),
  };
  if (!records.length)
    return {
      ...base,
      answer: 'There are no confirmed records yet. Add data before asking about trends.',
      evidence: [],
    };
  if (/what changed|started running|since.*run|caus/.test(q))
    return {
      ...base,
      answer:
        'I cannot establish when you started running or attribute a change to it from these records alone. Choose explicit before/after date ranges and compare the recorded trends; an association would not prove causation.',
      evidence: [],
    };
  if (/focus|next|improve/.test(q)) {
    const rec =
      state.recommendations.find((r) => r.status === 'active' && r.ends_on >= date) ??
      proposeRecommendation(records, state.goals, date);
    return { ...base, answer: `${rec.title} Why this? ${rec.why}`, evidence: rec.evidence };
  }
  if (/best week|healthiest/.test(q)) {
    const weeks = Array.from({ length: 4 }, (_, i) => {
      const to = addDays(date, -i * 7);
      const from = addDays(to, -6);
      const rows = records.filter((r) => r.date >= from && r.date <= to);
      return { from, to, days: new Set(rows.map((r) => r.date)).size, rows };
    }).sort((a, b) => b.days - a.days);
    const best = weeks[0];
    return {
      ...base,
      answer: `Your most consistently logged seven-day period among the last four was ${best.from} to ${best.to}, with records on ${best.days} days. Logging coverage does not establish your healthiest week.`,
      evidence: summarize(best.rows, best.from, best.to),
    };
  }
  const metric = /sleep/.test(q)
    ? 'sleep_duration'
    : /step|walk|movement/.test(q)
      ? 'steps'
      : /cardio|run/.test(q)
        ? 'cardio_minutes'
        : /strength/.test(q)
          ? 'strength_minutes'
          : /protein/.test(q)
            ? 'protein'
            : /weight/.test(q)
              ? 'weight'
              : null;
  if (!metric)
    return {
      ...base,
      answer:
        'I can search your recorded sleep, steps, cardio, strength, protein, weight, logging consistency, or current focus. Ask about one of those metrics and optionally choose a date range.',
      evidence: [],
    };
  const trend = trends(records, start, end).find((t) => t.metric === metric);
  if (!trend)
    return {
      ...base,
      answer: `There are no confirmed ${metric.replaceAll('_', ' ')} records for ${start} to ${end}. Missing entries are not treated as zero.`,
      evidence: [],
    };
  const aggregate = metric.endsWith('_minutes') ? 'total' : 'daily average';
  return {
    ...base,
    answer: `Your recorded ${trend.label.toLowerCase()} ${aggregate} was ${trend.value} ${trend.unit} from ${start} to ${end}, covering ${trend.coverage}. ${trend.comparable ? `That is ${Math.abs(trend.change!)} ${trend.unit} ${trend.change! < 0 ? 'lower' : 'higher'} than the preceding equal-length period.` : 'There is not enough comparable coverage in the preceding period to state a reliable change.'}`,
    evidence: [trend, ...(trend.previous ? [trend.previous] : [])],
  };
}
