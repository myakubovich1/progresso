import {
  addDays,
  metricCatalog,
  type HealthRecord,
  type KnownMetric,
  type Evidence,
} from './schema';

// Daily totals from overlapping sources are not summed. Prefer a manual correction,
// then the most recent source. Meal macros ARE additive and kept separate from totals.
export function dailyMetrics(records: HealthRecord[]) {
  const groups = new Map<string, HealthRecord[]>();
  for (const r of records) {
    const key = `${r.date}:${r.metric}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()]
    .map((rows) => {
      const totals = rows.filter((r) => !r.meal_id);
      const preferred = [...totals].sort(
        (a, b) =>
          Number(b.source === 'Manual') - Number(a.source === 'Manual') ||
          b.created_at.localeCompare(a.created_at) ||
          b.id.localeCompare(a.id),
      )[0];
      const used = preferred ? [preferred] : rows;
      return {
        date: rows[0].date,
        metric: rows[0].metric,
        category: rows[0].category,
        value: used.reduce((s, r) => s + r.value, 0),
        unit: rows[0].unit,
        record_ids: used.map((r) => r.id),
        sources: [...new Set(rows.map((r) => r.source))],
        overlapping_sources: totals.length > 1,
        is_demo: used.some((r) => r.is_demo),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
export function summarize(records: HealthRecord[], from: string, to: string): Evidence[] {
  const daily = dailyMetrics(records.filter((r) => r.date >= from && r.date <= to));
  return [...new Set(daily.map((r) => r.metric))].map((metric) => {
    const rows = daily.filter((r) => r.metric === metric);
    const sum = rows.reduce((s, r) => s + r.value, 0);
    const totalMetric = metric === 'cardio_minutes' || metric === 'strength_minutes';
    return {
      metric,
      value: Math.round((totalMetric ? sum : sum / rows.length) * 10) / 10,
      unit: rows[0].unit,
      days: rows.length,
      record_ids: rows.flatMap((r) => r.record_ids),
    };
  });
}
export function trends(records: HealthRecord[], from: string, to: string) {
  const length = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const current = summarize(records, from, to);
  const previous = summarize(records, addDays(from, -length), addDays(from, -1));
  return current.map((c) => {
    const p = previous.find((v) => v.metric === c.metric);
    const comparable =
      c.days >= 3 &&
      !!p &&
      p.days >= 3 &&
      Math.min(c.days, p.days) / Math.max(c.days, p.days) >= 0.75;
    return {
      ...c,
      label: metricCatalog[c.metric as KnownMetric]?.label ?? c.metric,
      previous: p ?? null,
      change: comparable ? Math.round((c.value - p!.value) * 10) / 10 : null,
      comparable,
      coverage: `${c.days} of ${length} days`,
      points: dailyMetrics(records).filter(
        (r) => r.metric === c.metric && r.date >= from && r.date <= to,
      ),
    };
  });
}
