'use client';
import Link from 'next/link';
import { AuthGate } from './auth-panel';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, browserSupabase } from '@/lib/client/api';
import {
  addDays,
  today,
  goalNames,
  metricCatalog,
  type KnownMetric,
  type Observation,
  type Profile,
  type Recommendation,
  type Evidence,
  type Upload,
  type MealInput,
  type HealthRecord,
  type Meal,
} from '@/lib/domain/schema';
const tabs = ['Today', 'Upload', 'Timeline', 'Insights', 'Food', 'Ask Progresso'] as const;
type Tab = (typeof tabs)[number];
type Home = {
  profile: Profile | null;
  date: string;
  recommendation: Recommendation | null;
  completed: number;
  cards: { category: string; metrics: Evidence[] }[];
  notice: string;
};
type Day = {
  date: string;
  records: HealthRecord[];
  meals: Meal[];
  metrics: { metric: string; value: number }[];
};
type Insight = {
  next_step: Recommendation;
  strongest_areas: Evidence[];
  notice: string;
  medical_uploads: string[];
  trends: {
    metric: string;
    value: number;
    unit: string;
    coverage: string;
    points: { value: number }[];
  }[];
};
const label = (text: string) => text.replaceAll('_', ' ');
const blankItem = () => ({
  name: '',
  quantity: 1,
  serving: '1 serving',
  calories: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
});
export function ProgressoApp({ demo, configured }: { demo: boolean; configured: boolean }) {
  if (demo || !configured) return <Workspace demo={demo} configured={configured} />;
  return <AuthGate>{(id) => <Workspace key={id} demo={false} configured />}</AuthGate>;
}

function Workspace({ demo, configured }: { demo: boolean; configured: boolean }) {
  const [tab, setTab] = useState<Tab>('Today');
  const [home, setHome] = useState<Home | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [rows, setRows] = useState<Observation[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [sample, setSample] = useState(false);
  const [consent, setConsent] = useState(false);
  const [anchor, setAnchor] = useState(today());
  const [view, setView] = useState<'day' | 'week' | 'month'>('month');
  const [days, setDays] = useState<Day[]>([]);
  const [selected, setSelected] = useState(today());
  const [insight, setInsight] = useState<Insight | null>(null);
  const [meal, setMeal] = useState<MealInput>({
    date: today(),
    name: '',
    items: [blankItem()],
    raw_upload_id: null,
    is_demo: false,
  });
  const [mealHistory, setMealHistory] = useState<Meal[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{
    answer: string;
    evidence: Evidence[];
    contains_demo_data?: boolean;
  } | null>(null);
  const request = useCallback(
    <T,>(path: string, method = 'GET', body?: unknown) =>
      api<T>(
        path,
        {
          method,
          body:
            body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
        },
        demo,
      ),
    [demo],
  );
  const load = useCallback(async () => {
    const h = await request<Home>('home');
    setHome(h);
    return h;
  }, [request]);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    if (!demo && !configured) {
      setTimeout(() => setChecking(false), 0);
      return;
    }
    request<Home>('home')
      .then((h) => {
        if (active) setHome(h);
      })
      .catch((e) => {
        if (active && !demo)
          setError(e instanceof Error ? e.message : 'We could not load your space.');
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [request, demo, configured]);
  useEffect(() => {
    if (!home) return;
    let active = true;
    const from =
      view === 'month'
        ? `${anchor.slice(0, 7)}-01`
        : view === 'week'
          ? addDays(anchor, -6)
          : anchor;
    const to =
      view === 'month'
        ? addDays(
            `${anchor.slice(0, 7)}-${new Date(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 0).getDate()}`,
            0,
          )
        : anchor;
    if (tab === 'Timeline')
      request<{ days: Day[] }>(`timeline?from=${from}&to=${to}&view=${view}`)
        .then((v) => {
          if (active) setDays(v.days);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    if (tab === 'Insights')
      request<Insight>('insights')
        .then((v) => {
          if (active) setInsight(v);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    if (tab === 'Food')
      request<{ meals: Meal[] }>('meals')
        .then((v) => {
          if (active) setMealHistory(v.meals);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [tab, anchor, view, request, home]);
  const ensureRec = async () => {
    await request('recommendations', 'POST', {});
    await load();
  };
  const analyze = (kind: 'health' | 'meal') =>
    run(async () => {
      if (!file) throw new Error('Choose a file first.');
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind);
      form.append('demo', String(sample));
      form.append('consent', String(consent));
      form.append('date', meal.date);
      const result = await request<{ upload: Upload; duplicate: boolean }>('uploads', 'POST', form);
      let u = result.upload;
      if (result.duplicate && u.status !== 'confirmed') {
        u = (
          await request<{ upload: Upload }>(`uploads/${u.id}/analyze`, 'POST', {
            date: meal.date,
            demo: sample,
            consent,
          })
        ).upload;
      }
      setUpload(u);
      if (kind === 'health') {
        setRows(u.extraction?.records ?? []);
      } else {
        setMeal(
          u.extraction?.meal
            ? { ...u.extraction.meal, raw_upload_id: u.id }
            : {
                date: meal.date,
                name: '',
                items: [blankItem()],
                raw_upload_id: u.id,
                is_demo: false,
              },
        );
      }
    });
  const date = home?.date ?? today();
  const newRow = (): Observation => ({
    date,
    category: 'movement',
    metric: 'steps',
    value: 0,
    unit: 'steps',
    source: 'Manual',
    confidence: 1,
    is_demo: false,
  });
  if (checking)
    return (
      <main className="welcome">
        <span className="brand">
          progresso<span>↗</span>
        </span>
        <p>Opening your space…</p>
      </main>
    );
  if (!home)
    return (
      <main className="welcome">
        <div className="welcome-copy">
          <span className="brand">
            progresso<span>↗</span>
          </span>
          <p className="eyebrow">A LITTLE BETTER, EVERY DAY</p>
          <h1>
            Your health.
            <br />
            <em>A clear next step.</em>
          </h1>
          <p className="lede">
            Most health apps give you data.
            <br />
            We give you actionable next steps.
          </p>
          <div className="welcome-note">Your history, connected. Your progress, personal.</div>
        </div>
        <section className="login panel">
          <span className="eyebrow">YOUR SPACE TO GROW</span>
          <h2>Make room for progress.</h2>
          {demo ? (
            <>
              <p>Explore a private local demo with 28 days of clearly labeled sample history.</p>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await request('demo/session', 'POST');
                    await load();
                  })
                }
              >
                Explore sample history ↗
              </button>
            </>
          ) : configured ? (
            <>
              <p>We couldn’t open your space. Please check your connection and try again.</p>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await load();
                  })
                }
              >
                Try again
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const { error } = await browserSupabase().auth.signOut({ scope: 'local' });
                    if (error) throw error;
                  })
                }
              >
                Back to sign in
              </button>
            </>
          ) : (
            <p>
              The app needs its connection configured before sign-in is available. Follow the
              repository setup guide to connect your project or start the local demo.
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      </main>
    );
  return (
    <div className="app-shell">
      <aside>
        <Link className="brand" href="/">
          progresso<span>↗</span>
        </Link>
        <p className="nav-label">YOUR DAILY DIRECTION</p>
        <nav>
          {tabs.map((name, i) => (
            <button
              key={name}
              className={tab === name ? 'nav active' : 'nav'}
              onClick={() => {
                setTab(name);
                setError('');
                setFile(null);
                setUpload(null);
              }}
            >
              <span className="nav-icon">{['◉', '↥', '▦', '↗', '◌', '✧'][i]}</span>
              {name}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="avatar">{home.profile?.display_name[0] ?? 'P'}</span>
          <div>
            {home.profile?.display_name ?? 'Your space'}
            <small>{demo ? 'Sample history · local demo' : 'Personal workspace'}</small>
          </div>
        </div>
        {!demo && (
          <button
            className="text-button"
            onClick={() =>
              run(async () => {
                const { error } = await browserSupabase().auth.signOut({ scope: 'local' });
                if (error) throw error;
                // AuthGate unmounts this entire workspace, clearing all user-specific state.
              })
            }
          >
            Sign out
          </button>
        )}
      </aside>
      <main className="workspace">
        <header>
          <div>
            <span className="eyebrow">
              {new Date(date + 'T12:00:00').toLocaleDateString('en', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}
            </span>
            <h1>
              {tab === 'Today'
                ? `A little better, ${home.profile?.display_name.split(' ')[0] ?? 'every day'}.`
                : tab}
            </h1>
          </div>
          <span className="status-dot">{demo ? 'Demo workspace' : 'Your private space'}</span>
        </header>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {busy && (
          <p className="working" role="status">
            Working…
          </p>
        )}
        {!home.profile ? (
          <Onboarding
            busy={busy}
            onSave={(data) =>
              run(async () => {
                await request('onboarding', 'POST', data);
                await ensureRec();
              })
            }
          />
        ) : (
          <>
            {tab === 'Today' && (
              <>
                <section className="next-card">
                  <div className="next-copy">
                    <span className="eyebrow">YOUR NEXT STEP</span>
                    <h2>{home.recommendation?.title ?? 'Find your next manageable step.'}</h2>
                    <p>
                      {home.recommendation?.why ??
                        'Use your goals and confirmed history to choose one thing to focus on.'}
                    </p>
                    {home.recommendation ? (
                      <>
                        <div className="progress-label">
                          <span>
                            {home.completed} of {home.recommendation.target}{' '}
                            {home.recommendation.progress_unit}
                          </span>
                          <span>
                            {home.recommendation.status === 'completed' ? 'Completed' : 'This week'}
                          </span>
                        </div>
                        <progress value={home.completed} max={home.recommendation.target} />
                        <button
                          disabled={busy || home.recommendation.status !== 'active'}
                          onClick={() =>
                            run(async () => {
                              const r = home.recommendation!;
                              await request(`recommendations/${r.id}/progress`, 'POST', {
                                amount: Math.min(1, r.target - home.completed),
                                date,
                                note: '',
                                idempotency_key: crypto.randomUUID(),
                              });
                              await load();
                            })
                          }
                        >
                          {home.recommendation.status === 'completed'
                            ? 'Step completed'
                            : 'Mark progress'}{' '}
                          ↗
                        </button>
                      </>
                    ) : (
                      <button disabled={busy} onClick={() => run(ensureRec)}>
                        Find my next step ↗
                      </button>
                    )}
                  </div>
                  <div className="orbit" aria-hidden="true">
                    <span>
                      one step
                      <br />
                      <strong>forward.</strong>
                    </span>
                  </div>
                </section>
                <div className="section-title">
                  <h2>Your week, at a glance</h2>
                  <span>Last 7 days · recorded data</span>
                </div>
                <div className="metric-grid">
                  {home.cards.map((card) => (
                    <section className="metric-card" key={card.category}>
                      <span className="eyebrow">{label(card.category)}</span>
                      <strong>
                        {card.metrics[0]?.value.toLocaleString() ?? '—'}{' '}
                        <small>{card.metrics[0]?.unit ?? ''}</small>
                      </strong>
                      <p>
                        {card.metrics[0]
                          ? `${card.metrics[0].days} days recorded`
                          : 'No records yet'}
                      </p>
                    </section>
                  ))}
                </div>
                {home.recommendation && (
                  <section className="panel">
                    <h3>Why this?</h3>
                    <p>{home.recommendation.why}</p>
                    <div className="chips">
                      {home.recommendation.evidence.map((e) => (
                        <span key={e.metric}>
                          {label(e.metric)} · {e.value} {e.unit}
                        </span>
                      ))}
                    </div>
                    {home.recommendation.is_demo && (
                      <p className="muted">This recommendation includes sample data.</p>
                    )}
                  </section>
                )}
              </>
            )}
            {tab === 'Upload' && (
              <>
                <section className="panel">
                  <h2>Bring your history together.</h2>
                  <p>
                    Screenshots, exports, or a simple entry. Review every value before it becomes
                    part of your timeline.
                  </p>
                  <FilePicker
                    file={file}
                    onFile={setFile}
                    sample={sample}
                    setSample={setSample}
                    consent={consent}
                    setConsent={setConsent}
                  />
                  <div className="actions">
                    <button disabled={busy || !file} onClick={() => analyze('health')}>
                      Read this file ↗
                    </button>
                    <button
                      className="secondary"
                      onClick={() => {
                        setUpload(null);
                        setRows([newRow()]);
                      }}
                    >
                      Enter manually
                    </button>
                  </div>
                </section>
                {upload && (
                  <section className="panel">
                    <h3>{upload.filename}</h3>
                    <p>
                      {upload.status === 'confirmed'
                        ? 'This file has already been confirmed.'
                        : `Review mode: ${upload.extraction?.mode ?? upload.status}`}
                    </p>
                    {upload.extraction?.warnings.map((w) => (
                      <p className="notice" key={w}>
                        {w}
                      </p>
                    ))}
                    {upload.extraction?.medical && (
                      <p className="notice">
                        Discuss medical or concerning findings with a qualified clinician. Progresso
                        does not interpret or diagnose them.
                      </p>
                    )}
                  </section>
                )}
                {(rows.length > 0 || upload?.status === 'review') && (
                  <section className="panel">
                    <h3>Review your values</h3>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Metric</th>
                            <th>Value</th>
                            <th>Unit</th>
                            <th>Source / confidence</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={i}>
                              <td>
                                <input
                                  aria-label={`Date ${i + 1}`}
                                  type="date"
                                  value={r.date}
                                  onChange={(e) =>
                                    setRows(
                                      rows.map((x, j) =>
                                        i === j ? { ...x, date: e.target.value } : x,
                                      ),
                                    )
                                  }
                                />
                              </td>
                              <td>{label(r.metric)}</td>
                              <td>
                                <input
                                  aria-label={`Value ${i + 1}`}
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={r.value}
                                  onChange={(e) =>
                                    setRows(
                                      rows.map((x, j) =>
                                        i === j ? { ...x, value: Number(e.target.value) } : x,
                                      ),
                                    )
                                  }
                                />
                              </td>
                              <td>{r.unit}</td>
                              <td>
                                {r.source}
                                <small>
                                  {Math.round(r.confidence * 100)}% extraction confidence
                                  {r.is_demo ? ' · sample' : ''}
                                </small>
                              </td>
                              <td>
                                <button
                                  className="text-button"
                                  aria-label={`Remove value ${i + 1}`}
                                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                                >
                                  ×
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <ManualRow onAdd={(r) => setRows([...rows, r])} date={date} />
                    <button
                      disabled={busy || !rows.length || upload?.status === 'confirmed'}
                      onClick={() =>
                        run(async () => {
                          await request(
                            upload ? `uploads/${upload.id}/confirm` : 'records',
                            'POST',
                            { records: rows },
                          );
                          setRows([]);
                          setUpload(null);
                          await ensureRec();
                          setTab('Timeline');
                        })
                      }
                    >
                      Confirm & add to timeline ↗
                    </button>
                  </section>
                )}
              </>
            )}
            {tab === 'Timeline' && (
              <>
                <div className="toolbar">
                  <div className="segmented">
                    {(['day', 'week', 'month'] as const).map((v) => (
                      <button
                        key={v}
                        className={view === v ? 'chosen' : ''}
                        onClick={() => setView(v)}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                  <input
                    aria-label="Timeline date"
                    type="date"
                    value={anchor}
                    onChange={(e) => {
                      if (e.target.value) {
                        setAnchor(e.target.value);
                        setSelected(e.target.value);
                      }
                    }}
                  />
                </div>
                <section className="panel">
                  <div className={`calendar ${view === 'day' ? 'single' : ''}`}>
                    {days.map((day) => (
                      <button
                        className={selected === day.date ? 'calendar-day selected' : 'calendar-day'}
                        key={day.date}
                        onClick={() => setSelected(day.date)}
                      >
                        <span>
                          {new Date(day.date + 'T12:00:00').toLocaleDateString('en', {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                        <strong>
                          {day.records.length ? `${day.records.length} records` : 'No entries'}
                        </strong>
                        <div className="dots">
                          {[...new Set(day.records.map((r) => r.category))].slice(0, 5).map((c) => (
                            <i key={c} title={c} />
                          ))}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
                <section className="panel">
                  <h2>{selected}</h2>
                  {days.find((d) => d.date === selected)?.records.length ? (
                    <div className="record-list">
                      {days
                        .find((d) => d.date === selected)!
                        .records.map((r) => (
                          <div key={r.id}>
                            <span>
                              {label(r.metric)}
                              <small>
                                {r.source}
                                {r.is_demo ? ' · sample' : ''}
                              </small>
                            </span>
                            <strong>
                              {r.value} {r.unit}
                            </strong>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p>No entries for this date. Add data to begin your history.</p>
                  )}
                </section>
              </>
            )}
            {tab === 'Insights' && insight && (
              <>
                <section className="panel">
                  <span className="eyebrow">ONE ACTION TO CONSIDER</span>
                  <h2>{insight.next_step.title}</h2>
                  <p>{insight.next_step.why}</p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        if (home.recommendation?.status === 'active')
                          await request(`recommendations/${home.recommendation.id}`, 'PATCH', {
                            status: 'dismissed',
                          });
                        await ensureRec();
                        setTab('Today');
                      })
                    }
                  >
                    Make this my focus ↗
                  </button>
                </section>
                <div className="metric-grid">
                  {insight.trends.map((t) => (
                    <section className="metric-card" key={t.metric}>
                      <span className="eyebrow">{label(t.metric)}</span>
                      <strong>
                        {t.value} <small>{t.unit}</small>
                      </strong>
                      <Sparkline values={t.points.map((p) => p.value)} />
                      <p>{t.coverage}</p>
                    </section>
                  ))}
                </div>
                <section className="panel">
                  <h3>Your strongest recorded areas</h3>
                  {insight.strongest_areas.length ? (
                    insight.strongest_areas.map((e) => (
                      <p key={e.metric}>
                        {label(e.metric)} · {e.value} {e.unit}, across {e.days} days
                      </p>
                    ))
                  ) : (
                    <p>Keep logging. There isn’t enough consistent history to compare areas yet.</p>
                  )}
                  {insight.medical_uploads.length > 0 && (
                    <p className="notice">
                      Some uploads contain medical findings. Discuss them with a qualified
                      clinician.
                    </p>
                  )}
                </section>
              </>
            )}
            {tab === 'Food' && (
              <>
                <section className="panel">
                  <h2>A little more awareness, one meal at a time.</h2>
                  <p>
                    Take a photo or enter your meal. Portions and nutrients are editable estimates.
                  </p>
                  <FilePicker
                    imageOnly
                    file={file}
                    onFile={setFile}
                    sample={sample}
                    setSample={setSample}
                    consent={consent}
                    setConsent={setConsent}
                  />
                  <button disabled={busy || !file} onClick={() => analyze('meal')}>
                    Review meal photo ↗
                  </button>
                  {upload?.extraction?.warnings.map((w) => (
                    <p className="notice" key={w}>
                      {w}
                    </p>
                  ))}
                </section>
                <form
                  className="panel"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await request('meals', 'POST', meal);
                      setMeal({
                        date,
                        name: '',
                        items: [blankItem()],
                        raw_upload_id: null,
                        is_demo: false,
                      });
                      setUpload(null);
                      await load();
                    });
                  }}
                >
                  <div className="form-grid">
                    <label>
                      Meal name
                      <input
                        required
                        value={meal.name}
                        onChange={(e) => setMeal({ ...meal, name: e.target.value })}
                      />
                    </label>
                    <label>
                      Date
                      <input
                        type="date"
                        required
                        value={meal.date}
                        onChange={(e) => setMeal({ ...meal, date: e.target.value })}
                      />
                    </label>
                  </div>
                  {meal.is_demo && (
                    <p className="notice">
                      Sample recognition. These foods were not identified from your photo.
                    </p>
                  )}
                  <p className="muted">
                    Enter nutrients per serving. Quantity multiplies each nutrient.
                  </p>
                  {meal.items.map((item, i) => (
                    <div className="meal-row" key={i}>
                      {(
                        [
                          'name',
                          'serving',
                          'quantity',
                          'calories',
                          'protein',
                          'carbs',
                          'fat',
                        ] as const
                      ).map((key) => (
                        <label key={key}>
                          {label(key)}
                          <input
                            required
                            type={key === 'name' || key === 'serving' ? 'text' : 'number'}
                            min={key === 'quantity' ? 0.01 : 0}
                            step="any"
                            value={item[key]}
                            onChange={(e) =>
                              setMeal({
                                ...meal,
                                items: meal.items.map((x, j) =>
                                  j === i
                                    ? {
                                        ...x,
                                        [key]:
                                          key === 'name' || key === 'serving'
                                            ? e.target.value
                                            : Number(e.target.value),
                                      }
                                    : x,
                                ),
                              })
                            }
                          />
                        </label>
                      ))}
                    </div>
                  ))}
                  <div className="actions">
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => setMeal({ ...meal, items: [...meal.items, blankItem()] })}
                    >
                      + Add food
                    </button>
                    <button disabled={busy}>Save meal to timeline ↗</button>
                  </div>
                </form>
                <section className="panel">
                  <h3>Your recent meals</h3>
                  {mealHistory.length ? (
                    mealHistory.map((m) => (
                      <div className="meal-history" key={m.id}>
                        <span>
                          {m.name}
                          <small>
                            {m.date}
                            {m.is_demo ? ' · sample' : ''}
                          </small>
                        </span>
                        <strong>
                          {m.calories} kcal · {m.protein}g protein
                        </strong>
                      </div>
                    ))
                  ) : (
                    <p>No meals logged yet.</p>
                  )}
                </section>
              </>
            )}
            {tab === 'Ask Progresso' && (
              <section className="panel ask">
                <span className="eyebrow">A CONVERSATION WITH YOUR HISTORY</span>
                <h2>What would you like to understand?</h2>
                <div className="chips">
                  {[
                    'How has my sleep changed this month?',
                    'What should I focus on next?',
                    'What are my best weeks?',
                  ].map((q) => (
                    <button className="secondary" key={q} onClick={() => setQuestion(q)}>
                      {q}
                    </button>
                  ))}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      setAnswer(await request('chat', 'POST', { question }));
                    });
                  }}
                >
                  <label>
                    Your question
                    <textarea
                      required
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      placeholder="Ask about your recorded sleep, movement, or progress…"
                    />
                  </label>
                  <button disabled={busy}>Ask Progresso ↗</button>
                </form>
                {answer && (
                  <div className="answer">
                    <h3>From your records</h3>
                    <p>{answer.answer}</p>
                    {answer.contains_demo_data && (
                      <p className="muted">This answer includes sample history.</p>
                    )}
                    {answer.evidence.map((e, i) => (
                      <p className="muted" key={i}>
                        {label(e.metric)} · {e.value} {e.unit} · {e.days} days ·{' '}
                        {e.record_ids.length} supporting records
                      </p>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
        <footer>
          Most health apps give you data. We give you actionable next steps.
          <small>{home.notice}</small>
        </footer>
      </main>
    </div>
  );
}
function Onboarding({ busy, onSave }: { busy: boolean; onSave: (data: unknown) => void }) {
  const [goals, setGoals] = useState<string[]>(['general_health']);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    onSave({
      display_name: f.get('name'),
      age_range: f.get('age'),
      activity_level: f.get('activity'),
      preferred_units: f.get('units'),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      goals,
      height_cm: f.get('height') ? Number(f.get('height')) : null,
      weight_kg: f.get('weight') ? Number(f.get('weight')) : null,
    });
  };
  return (
    <form className="panel onboarding" onSubmit={submit}>
      <span className="eyebrow">LET’S MAKE THIS PERSONAL</span>
      <h2>What does better look like for you?</h2>
      <p>Choose your goals in priority order. We’ll focus on one manageable step at a time.</p>
      <div className="chips">
        {goalNames.map((g) => (
          <button
            className={goals.includes(g) ? 'goal chosen' : 'goal'}
            type="button"
            key={g}
            onClick={() =>
              setGoals(goals.includes(g) ? goals.filter((x) => x !== g) : [...goals, g])
            }
          >
            {label(g)} {goals.includes(g) ? `· ${goals.indexOf(g) + 1}` : '+'}
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label>
          First name
          <input name="name" required maxLength={80} placeholder="Your name" />
        </label>
        <label>
          Age range
          <select name="age">
            {['18-24', '25-34', '35-44', '45-54', '55-64', '65+'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          Activity level
          <select name="activity">
            {['sedentary', 'light', 'moderate', 'active', 'very_active'].map((x) => (
              <option value={x} key={x}>
                {label(x)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Preferred units
          <select name="units">
            <option value="metric">Metric</option>
            <option value="imperial">Imperial</option>
          </select>
        </label>
        <label>
          Height in cm · optional
          <input name="height" type="number" min={50} max={280} step="any" />
        </label>
        <label>
          Weight in kg · optional
          <input name="weight" type="number" min={20} max={700} step="any" />
        </label>
      </div>
      <button disabled={busy || !goals.length}>Find my direction ↗</button>
    </form>
  );
}
function FilePicker({
  file,
  onFile,
  sample,
  setSample,
  consent,
  setConsent,
  imageOnly = false,
}: {
  file: File | null;
  onFile: (f: File | null) => void;
  sample: boolean;
  setSample: (v: boolean) => void;
  consent: boolean;
  setConsent: (v: boolean) => void;
  imageOnly?: boolean;
}) {
  return (
    <>
      <label className="dropzone">
        <span>↥</span>
        <strong>
          {file?.name ?? (imageOnly ? 'Choose or take a meal photo' : 'Choose your health data')}
        </strong>
        <small>{imageOnly ? 'JPG, PNG, WebP' : 'Images, PDF, CSV, JSON, XML'} · up to 4 MB</small>
        <input
          type="file"
          accept={
            imageOnly
              ? 'image/jpeg,image/png,image/webp'
              : '.jpg,.jpeg,.png,.webp,.pdf,.csv,.json,.xml'
          }
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        Allow this file to be sent to the AI provider for analysis.
      </label>
      <label className="check">
        <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} />
        Use sample recognition instead of reading this file.
      </label>
    </>
  );
}
function ManualRow({ onAdd, date }: { onAdd: (r: Observation) => void; date: string }) {
  const [metric, setMetric] = useState<KnownMetric>('steps');
  const [value, setValue] = useState('');
  return (
    <div className="manual-row">
      <label>
        Metric
        <select value={metric} onChange={(e) => setMetric(e.target.value as KnownMetric)}>
          {Object.entries(metricCatalog).map(([key, m]) => (
            <option key={key} value={key}>
              {m.label} ({m.unit})
            </option>
          ))}
        </select>
      </label>
      <label>
        Value
        <input
          type="number"
          min={0}
          step="any"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button
        className="secondary"
        disabled={!value}
        onClick={() => {
          const spec = metricCatalog[metric];
          onAdd({
            date,
            metric,
            value: Number(value),
            unit: spec.unit,
            category: spec.category,
            source: 'Manual',
            confidence: 1,
            is_demo: false,
          });
          setValue('');
        }}
      >
        + Add value
      </button>
    </div>
  );
}
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values),
    max = Math.max(...values);
  return (
    <svg className="sparkline" viewBox="0 0 200 50" role="img" aria-label="Recorded metric trend">
      <polyline
        points={values
          .map(
            (v, i) =>
              `${(i * 200) / (values.length - 1)},${45 - ((v - min) / (max - min || 1)) * 40}`,
          )
          .join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
