import 'server-only';
import { parse } from 'csv-parse/sync';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { normalizeObservation } from '@/lib/domain/normalize';
import type { Observation } from '@/lib/domain/schema';
import { fail } from './errors';
const MAX_ROWS = 2000;
const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
function groupSamples(rows: Observation[], additive: Set<string>) {
  const map = new Map<string, Observation[]>();
  for (const row of rows) {
    const k = `${row.date}|${row.metric}|${row.source}|${row.unit}`;
    map.set(k, [...(map.get(k) ?? []), row]);
  }
  return [...map.values()].map((group) => ({
    ...group[group.length - 1],
    value:
      Math.round(
        (additive.has(group[0].metric)
          ? group.reduce((s, r) => s + r.value, 0)
          : group[0].metric === 'weight'
            ? group[group.length - 1].value
            : group.reduce((s, r) => s + r.value, 0) / group.length) * 1000,
      ) / 1000,
  }));
}
export function parseStructured(
  text: string,
  extension: string,
): { records: Observation[]; warnings: string[] } {
  const warnings: string[] = [];
  let rows: Record<string, unknown>[] = [];
  let apple = false;
  const sleep: { start: number; end: number; date: string; source: string }[] = [];
  try {
    if (extension === 'csv') {
      rows = parse(text, {
        columns: (headers: string[]) => headers.map((h) => h.trim().toLowerCase()),
        bom: true,
        skip_empty_lines: true,
        trim: true,
        max_record_size: 20000,
        to: MAX_ROWS + 1,
      });
    } else if (extension === 'json') {
      const value = JSON.parse(text);
      rows = Array.isArray(value) ? value : value.records;
      if (!Array.isArray(rows))
        fail(422, 'invalid_format', 'JSON must be an array or an object with a records array');
    } else {
      if (/<!DOCTYPE|<!ENTITY/i.test(text))
        fail(422, 'unsafe_xml', 'XML entities and document type declarations are not accepted');
      if (XMLValidator.validate(text) !== true)
        fail(422, 'invalid_xml', 'The XML file is malformed');
      const doc = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '',
        processEntities: false,
      }).parse(text);
      apple = !!doc.HealthData;
      rows = apple
        ? asArray(doc.HealthData.Record)
        : asArray(doc.health?.record ?? doc.records?.record);
      if (apple) {
        for (const w of asArray<Record<string, unknown>>(doc.HealthData.Workout)) {
          const type = String(w.workoutActivityType ?? '');
          const strength = /StrengthTraining/.test(type);
          if (
            !strength &&
            !/Running|Cycling|Swimming|Rowing|Elliptical|Walking|Hiking/.test(type)
          ) {
            warnings.push(`Unsupported workout type: ${type.slice(0, 80)}`);
            continue;
          }
          rows.push({
            date: w.startDate,
            metric: strength ? 'strength_minutes' : 'cardio_minutes',
            value: w.duration,
            unit: w.durationUnit ?? 'min',
            source: w.sourceName ?? 'Apple Health',
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error;
    fail(
      422,
      'invalid_format',
      'Could not parse this file. Use a valid CSV, JSON, or XML file matching the documented format.',
    );
  }
  if (rows.length > MAX_ROWS)
    fail(
      413,
      'too_many_records',
      `Import at most ${MAX_ROWS} rows at a time. Split larger exports.`,
    );
  const records: Observation[] = [];
  let rejected = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      rejected++;
      continue;
    }
    if (apple && String(row.type).includes('SleepAnalysis')) {
      if (!/Asleep/.test(String(row.value))) continue;
      const start = Date.parse(String(row.startDate).replace(/ ([+-]\d{4})$/, '$1'));
      const end = Date.parse(String(row.endDate).replace(/ ([+-]\d{4})$/, '$1'));
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        end - start > 86400000
      ) {
        rejected++;
        continue;
      }
      sleep.push({
        start,
        end,
        date: String(row.endDate).slice(0, 10),
        source: String(row.sourceName ?? 'Apple Health'),
      });
      continue;
    }
    const expanded =
      row.metric || row.type
        ? [row]
        : Object.entries(row)
            .filter(([key]) => !['date', 'source', 'unit', 'confidence', 'is_demo'].includes(key))
            .map(([metric, value]) => ({
              date: row.date,
              source: row.source,
              is_demo: row.is_demo,
              metric,
              value,
            }));
    for (const entry of expanded) {
      try {
        records.push(normalizeObservation(entry, apple ? 'Apple Health' : 'Imported file'));
      } catch {
        rejected++;
      }
    }
  }
  // Merge overlapping sleep stages and parent "asleep" intervals, grouped by wake date and source.
  const groups = new Map<string, typeof sleep>();
  for (const interval of sleep) {
    const k = `${interval.date}|${interval.source}`;
    groups.set(k, [...(groups.get(k) ?? []), interval]);
  }
  for (const intervals of groups.values()) {
    intervals.sort((a, b) => a.start - b.start);
    let duration = 0;
    let end = 0;
    for (const interval of intervals) {
      duration += Math.max(0, interval.end - Math.max(end, interval.start));
      end = Math.max(end, interval.end);
    }
    try {
      records.push(
        normalizeObservation({
          date: intervals[0].date,
          metric: 'sleep_duration',
          value: duration / 3600000,
          unit: 'h',
          source: intervals[0].source,
        }),
      );
    } catch {
      rejected++;
    }
  }
  if (rejected)
    warnings.push(
      `${rejected} unsupported or invalid values were skipped. Review the source file before confirming.`,
    );
  if (!records.length)
    fail(
      422,
      'no_records',
      'No supported records found. Include date, metric and value columns, or enter the data manually.',
    );
  if (records.length > MAX_ROWS)
    fail(413, 'too_many_records', `Import at most ${MAX_ROWS} extracted values at a time.`);
  const result = apple
    ? groupSamples(
        records,
        new Set([
          'steps',
          'cardio_minutes',
          'strength_minutes',
          'calories',
          'protein',
          'carbs',
          'fat',
        ]),
      )
    : records;
  // Revalidate after summing to reject impossible daily totals.
  return { records: result.map((r) => normalizeObservation(r)), warnings };
}
export function validateFile(
  filename: string,
  bytes: Uint8Array,
): { extension: string; mime: string } {
  if (!bytes.length || bytes.length > 4 * 1024 * 1024)
    fail(413, 'invalid_size', 'Files must be between 1 byte and 4 MB');
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  const hex = Buffer.from(bytes.slice(0, 12)).toString('hex');
  const text = Buffer.from(bytes.slice(0, 12)).toString('ascii');
  const types: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    pdf: 'application/pdf',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
  };
  if (!types[extension])
    fail(415, 'unsupported_type', 'Use JPG, PNG, WebP, PDF, CSV, JSON, or XML');
  const valid =
    extension === 'png'
      ? hex.startsWith('89504e470d0a1a0a')
      : ['jpg', 'jpeg'].includes(extension)
        ? hex.startsWith('ffd8ff')
        : extension === 'webp'
          ? text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP'
          : extension === 'pdf'
            ? text.startsWith('%PDF-')
            : !bytes.includes(0);
  if (!valid) fail(415, 'invalid_file', 'The file content does not match its extension');
  return { extension, mime: types[extension] };
}
