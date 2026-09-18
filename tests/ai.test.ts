import { afterEach, expect, it, vi } from 'vitest';
import { extract } from '@/lib/server/ai';
const input = {
  bytes: Buffer.from('89504e470d0a1a0a', 'hex'),
  filename: 'health.png',
  extension: 'png',
  mime: 'image/png',
  kind: 'health' as const,
  date: '2026-09-18',
  demo: false,
  consent: true,
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('does not send files without consent', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'test');
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  expect((await extract({ ...input, consent: false })).mode).toBe('manual');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('uses a server-only key, disables response storage, and validates extraction', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'test');
  const extraction = {
    source: 'Watch',
    records: [
      {
        date: input.date,
        category: 'sleep',
        metric: 'sleep_duration',
        value: 420,
        unit: 'min',
        source: 'Watch',
        confidence: 0.9,
      },
    ],
    meal: null,
    warnings: [],
    medical: false,
  };
  const mock = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(extraction) }] }],
        }),
        { status: 200 },
      ),
    );
  vi.stubGlobal('fetch', mock);
  const result = await extract(input);
  expect(result.records[0].value).toBe(7);
  expect(result.mode).toBe('ai');
  const body = JSON.parse(mock.mock.calls[0][1].body);
  expect(body.store).toBe(false);
  expect(body.text.format.strict).toBe(true);
});
it('fails closed on provider errors and invalid values', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'test');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
  await expect(extract(input)).rejects.toThrow('provider is unavailable');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [{ content: [{ type: 'output_text', text: '{"made_up":true}' }] }],
          }),
        ),
      ),
  );
  await expect(extract(input)).rejects.toThrow('validated');
});
