import { validateHost, validatePort, validateName, validateLabels, WorkerError } from './worker-node.service';

const code = (fn: () => unknown) => { try { fn(); return null; } catch (e: any) { return e instanceof WorkerError ? e.code : 'OTHER'; } };

describe('worker input validation', () => {
  const OLD = process.env.ALLOW_LOOPBACK_WORKERS;
  afterEach(() => { if (OLD === undefined) delete process.env.ALLOW_LOOPBACK_WORKERS; else process.env.ALLOW_LOOPBACK_WORKERS = OLD; });

  it('accepts hostnames and routable IPv4', () => {
    expect(validateHost('Worker1.internal')).toBe('worker1.internal');
    expect(validateHost('10.0.0.5')).toBe('10.0.0.5');
    expect(validateHost('df-test-worker1')).toBe('df-test-worker1');
  });

  it.each([
    ['', 'empty'], ['http://evil', 'url'], ['a;drop table users', 'sql'], ['a b', 'space'], ['host:5432', 'port in host'],
    ['169.254.169.254', 'link-local metadata'], ['metadata.google.internal', 'metadata host'], ['0.0.0.0', 'any'],
    ['224.0.0.1', 'multicast'], ['999.1.1.1', 'bad ipv4'], ['-bad.example.com', 'leading dash'], ['x'.repeat(300), 'too long'],
  ])('rejects host %s (%s)', (h) => { expect(code(() => validateHost(h))).toBe('INVALID_WORKER'); });

  it('rejects non-string host', () => { expect(code(() => validateHost(123))).toBe('INVALID_WORKER'); expect(code(() => validateHost(null))).toBe('INVALID_WORKER'); });

  it('blocks loopback unless explicitly allowed', () => {
    delete process.env.ALLOW_LOOPBACK_WORKERS;
    expect(code(() => validateHost('127.0.0.1'))).toBe('INVALID_WORKER');
    expect(code(() => validateHost('localhost'))).toBe('INVALID_WORKER');
    process.env.ALLOW_LOOPBACK_WORKERS = 'true';
    expect(validateHost('localhost')).toBe('localhost');
    expect(validateHost('127.0.0.1')).toBe('127.0.0.1');
  });

  it('still blocks link-local when loopback is allowed', () => {
    process.env.ALLOW_LOOPBACK_WORKERS = 'true';
    expect(code(() => validateHost('169.254.1.1'))).toBe('INVALID_WORKER');
  });

  it('validates ports', () => {
    expect(validatePort(5432)).toBe(5432); expect(validatePort('6000')).toBe(6000);
    for (const p of [0, 65536, -1, 1.5, 'abc', '', null, undefined, NaN]) expect(code(() => validatePort(p))).toBe('INVALID_WORKER');
  });

  it('validates names', () => {
    expect(validateName(' Worker-1 ')).toBe('worker-1');
    for (const n of ['a', '1worker', 'wor ker', 'worker_1', 'w'.repeat(64), '', "x'; drop--", undefined]) expect(code(() => validateName(n))).toBe('INVALID_WORKER');
  });

  it('validates labels', () => {
    expect(validateLabels(undefined)).toEqual({});
    expect(validateLabels({ zone: 'a' })).toEqual({ zone: 'a' });
    expect(code(() => validateLabels([]))).toBe('INVALID_WORKER');
    expect(code(() => validateLabels({ 'bad key!': 'x' }))).toBe('INVALID_WORKER');
    expect(code(() => validateLabels({ k: 5 as any }))).toBe('INVALID_WORKER');
    expect(code(() => validateLabels(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']))))).toBe('INVALID_WORKER');
  });
});
