import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, type State, type Table, type Row } from '@/lib/domain/schema';
import { mutateState, type Mutation } from './mutations';
import { fail } from './errors';

export interface Repository {
  userId: string;
  state(): Promise<State>;
  insert<K extends Table>(table: K, row: Row<K>): Promise<void>;
  update<K extends Table>(table: K, id: string, patch: Partial<Row<K>>): Promise<void>;
  mutate(action: Mutation, payload: Record<string, unknown>): Promise<unknown>;
  putFile(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  getFile(key: string): Promise<Uint8Array>;
}
function check(error: { code?: string; message?: string } | null) {
  if (!error) return;
  if (error.code === 'P0002') fail(404, 'not_found', 'Record not found');
  if (error.code === '23505') fail(409, 'duplicate', 'This record already exists');
  if (error.code === '42501') fail(403, 'forbidden', 'Access denied');
  if (['P0001', '23514', '23503', '22P02'].includes(error.code ?? ''))
    fail(
      422,
      'invalid_operation',
      'Invalid state, value, source, progress amount, or recommendation date',
    );
  fail(
    503,
    'database_unavailable',
    'Storage is unavailable. Check the database configuration and migration.',
  );
}
export class SupabaseRepository implements Repository {
  private client: SupabaseClient;
  constructor(
    public userId: string,
    client: SupabaseClient,
  ) {
    this.client = client;
  }
  async state(): Promise<State> {
    const state = emptyState();
    await Promise.all(
      (Object.keys(state) as Table[]).map(async (table) => {
        const rows: unknown[] = [];
        for (let offset = 0; ; offset += 1000) {
          const { data, error } = await this.client
            .from(table)
            .select('*')
            .eq('user_id', this.userId)
            .order(table === 'profiles' ? 'user_id' : 'id')
            .range(offset, offset + 999);
          check(error);
          rows.push(...(data ?? []));
          if ((data?.length ?? 0) < 1000) break;
          if (offset >= 19000)
            fail(
              413,
              'history_limit',
              'This history requires a paginated analytics worker. No partial analysis was generated.',
            );
        }
        Object.assign(state, { [table]: rows });
      }),
    );
    return state;
  }
  async insert<K extends Table>(table: K, row: Row<K>) {
    const { error } = await this.client.from(table).insert({ ...row, user_id: this.userId });
    check(error);
  }
  async update<K extends Table>(table: K, id: string, patch: Partial<Row<K>>) {
    const { data, error } = await this.client
      .from(table)
      .update({ ...patch, user_id: this.userId })
      .eq('user_id', this.userId)
      .eq('id', id)
      .select('id');
    check(error);
    if (!data?.length) fail(404, 'not_found', 'Record not found');
  }
  async mutate(action: Mutation, payload: Record<string, unknown>) {
    const { data, error } = await this.client.rpc('progresso_mutate', { action, payload });
    check(error);
    return data;
  }
  async putFile(key: string, bytes: Uint8Array, mime: string) {
    const { error } = await this.client.storage
      .from('health-uploads')
      .upload(key, bytes, { contentType: mime });
    check(error);
  }
  async getFile(key: string) {
    const { data, error } = await this.client.storage.from('health-uploads').download(key);
    check(error);
    if (!data) fail(404, 'not_found', 'File not found');
    return new Uint8Array(await data.arrayBuffer());
  }
}
export function supabaseClient(token?: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key)
    fail(503, 'setup_required', 'Configure Supabase, or explicitly enable local demo mode.');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
}
export const demoDirectory = () =>
  process.env.PROGRESSO_DEMO_DIR || path.join(process.cwd(), '.data');
const locks = new Map<string, Promise<unknown>>();
export class DemoRepository implements Repository {
  constructor(public userId: string) {
    if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('Invalid demo session');
  }
  private file() {
    return path.join(demoDirectory(), `${this.userId}.json`);
  }
  async initialize() {
    await mkdir(demoDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(this.file(), JSON.stringify(emptyState()), { flag: 'wx', mode: 0o600 });
  }
  async state(): Promise<State> {
    try {
      return JSON.parse(await readFile(this.file(), 'utf8'));
    } catch {
      return fail(401, 'session_expired', 'Start a new demo session');
    }
  }
  private async write<T>(fn: (state: State) => T): Promise<T> {
    const previous = locks.get(this.userId) ?? Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(async () => {
        const state = await this.state();
        const result = fn(state);
        const temporary = `${this.file()}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
        await rename(temporary, this.file());
        return result;
      });
    locks.set(this.userId, job);
    try {
      return await job;
    } finally {
      if (locks.get(this.userId) === job) locks.delete(this.userId);
    }
  }
  async insert<K extends Table>(table: K, row: Row<K>) {
    await this.write((state) => {
      if (row.user_id !== this.userId) fail(403, 'forbidden', 'Access denied');
      if (table === 'uploads') {
        const upload = row as Row<'uploads'>;
        if (state.uploads.some((u) => u.sha256 === upload.sha256 && u.kind === upload.kind))
          fail(409, 'duplicate', 'This upload already exists');
      }
      (state[table] as Row<K>[]).push(row);
    });
  }
  async update<K extends Table>(table: K, id: string, patch: Partial<Row<K>>) {
    await this.write((state) => {
      const row = (state[table] as { id?: string; user_id: string }[]).find((r) => r.id === id);
      if (!row) fail(404, 'not_found', 'Record not found');
      Object.assign(row, patch, { user_id: this.userId });
    });
  }
  async mutate(action: Mutation, payload: Record<string, unknown>) {
    return this.write((state) => mutateState(state, this.userId, action, payload));
  }
  private objectPath(key: string) {
    if (!key.startsWith(`${this.userId}/`) || key.includes('..'))
      fail(403, 'forbidden', 'Access denied');
    return path.join(demoDirectory(), 'uploads', key);
  }
  async putFile(key: string, bytes: Uint8Array) {
    const file = this.objectPath(key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode: 0o600 });
  }
  async getFile(key: string) {
    try {
      return new Uint8Array(await readFile(this.objectPath(key)));
    } catch {
      return fail(404, 'not_found', 'File not found');
    }
  }
}
