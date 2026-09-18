import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { demoMeal, demoRecords } from '@/lib/domain/demo';
const db = new PGlite();
const alice = '11111111-1111-4111-a111-111111111111';
const bob = '22222222-2222-4222-a222-222222222222';
async function asUser(id: string) {
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false);`,
  );
}
async function mutate(action: string, payload: unknown) {
  return (
    await db.query<{ value: unknown }>('select public.progresso_mutate($1,$2::jsonb) as value', [
      action,
      JSON.stringify(payload),
    ])
  ).rows[0].value;
}
beforeAll(async () => {
  await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
 create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema public,auth,storage to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;grant select,insert,delete on storage.objects to authenticated;
 create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
 insert into auth.users values('${alice}'),('${bob}');`);
  await db.exec(await readFile('supabase/migrations/202609180001_progresso.sql', 'utf8'));
});
afterAll(() => db.close());
it('applies the actual migration and enforces owner-only reads and writes', async () => {
  await asUser(alice);
  await mutate('records', { records: demoRecords('2026-09-18').slice(0, 2) });
  expect((await db.query('select * from public.health_records')).rows).toHaveLength(2);
  await asUser(bob);
  expect((await db.query('select * from public.health_records')).rows).toHaveLength(0);
  await expect(
    db.query("insert into public.goals(user_id,goal,priority) values($1,'sleep',1)", [alice]),
  ).rejects.toThrow();
  await db.exec('reset role;set role anon;');
  await expect(db.query('select * from public.health_records')).rejects.toThrow();
});
it('prevents cross-user upload references and storage access', async () => {
  const uploadId = randomUUID();
  await asUser(alice);
  await db.query(
    "insert into public.uploads(id,user_id,filename,mime_type,size_bytes,sha256,storage_path,kind,status) values($1,$2,'a.csv','text/csv',10,$3,$4,'health','review')",
    [uploadId, alice, 'a'.repeat(64), `${alice}/${uploadId}`],
  );
  await db.query("insert into storage.objects(bucket_id,name) values('health-uploads',$1)", [
    `${alice}/${uploadId}`,
  ]);
  await asUser(bob);
  expect((await db.query('select * from storage.objects')).rows).toHaveLength(0);
  await expect(
    db.query("insert into storage.objects(bucket_id,name) values('health-uploads',$1)", [
      `${alice}/stolen`,
    ]),
  ).rejects.toThrow();
  await expect(
    mutate('confirm_upload', {
      upload_id: uploadId,
      records: demoRecords('2026-09-18').slice(0, 1),
    }),
  ).rejects.toThrow();
  await expect(
    db.query(
      "insert into public.health_records(user_id,date,category,metric,value,unit,source,confidence,raw_upload_id,fingerprint) values($1,'2026-09-18','movement','steps',1,'steps','x',1,$2,'evil')",
      [bob, uploadId],
    ),
  ).rejects.toThrow();
  await asUser(alice);
  await mutate('confirm_upload', {
    upload_id: uploadId,
    records: demoRecords('2026-09-18').slice(0, 1),
  });
  expect(
    await mutate('confirm_upload', {
      upload_id: uploadId,
      records: demoRecords('2026-09-18').slice(0, 1),
    }),
  ).toEqual({ already_confirmed: true });
});
it('rolls back an entire confirmation if any record is invalid', async () => {
  await asUser(bob);
  const id = randomUUID();
  await db.query(
    "insert into public.uploads(id,user_id,filename,mime_type,size_bytes,sha256,storage_path,kind,status) values($1,$2,'b.csv','text/csv',10,$3,$4,'health','review')",
    [id, bob, 'b'.repeat(64), `${bob}/${id}`],
  );
  const rows = demoRecords('2026-09-18').slice(0, 2);
  rows[1].value = -1;
  await expect(mutate('confirm_upload', { upload_id: id, records: rows })).rejects.toThrow();
  expect((await db.query('select * from public.health_records')).rows).toHaveLength(0);
  expect(
    (await db.query<{ status: string }>('select status from public.uploads where id=$1', [id]))
      .rows[0].status,
  ).toBe('review');
});
it('saves meals and corrections atomically and prevents macro double counting', async () => {
  await asUser(bob);
  const input = demoMeal('2026-09-18');
  const meal = (await mutate('save_meal', input)) as { id: string; protein: number };
  expect(Number(meal.protein)).toBe(43);
  input.items[0].quantity = 2;
  await mutate('save_meal', { ...input, id: meal.id });
  expect(
    (await db.query('select * from public.health_records where meal_id=$1', [meal.id])).rows,
  ).toHaveLength(4);
  expect(
    Number(
      (
        await db.query<{ protein: number }>('select protein from public.meals where id=$1', [
          meal.id,
        ])
      ).rows[0].protein,
    ),
  ).toBe(80);
});
it('serializes recommendation activation and retries progress without duplicates', async () => {
  await asUser(alice);
  const rec = (await mutate('recommend', {
    category: 'cardio',
    title: 'Two sessions',
    why: 'Recorded low cardio',
    target: 2,
    progress_unit: 'sessions',
    evidence: [],
    starts_on: '2026-09-18',
    ends_on: '2026-09-24',
    is_demo: false,
  })) as { id: string };
  const p = {
    recommendation_id: rec.id,
    amount: 1,
    date: '2026-09-18',
    note: '',
    idempotency_key: randomUUID(),
  };
  await mutate('progress', p);
  await mutate('progress', p);
  expect((await db.query('select * from public.recommendation_progress')).rows).toHaveLength(1);
  await expect(
    mutate('progress', { ...p, amount: 3, idempotency_key: randomUUID() }),
  ).rejects.toThrow();
  await mutate('progress', { ...p, idempotency_key: randomUUID() });
  expect(
    (
      await db.query<{ status: string }>('select status from public.recommendations where id=$1', [
        rec.id,
      ])
    ).rows[0].status,
  ).toBe('completed');
});
