/**
 * T11 — connection secrets are never returned: not to members, and not to owners either (list responses carry
 * `hasPassword: true` instead). Credentials embedded in connection strings are masked.
 */
import { app, request, mkTenant, mkSource, auth, suffix, cleanupAll, TestTenant } from './harness';
import { redactConfig, maskUri } from '../../utils/redact';

jest.setTimeout(60000);

describe('Isolation: connection secret redaction', () => {
  const s = suffix();
  let T: TestTenant;
  const config = {
    host: 'db.invalid', port: 5432, user: 'svc', database: 'app',
    password: 'S3CR3T-PASSWORD', pass: 'S3CR3T-PASS', apiKey: 'S3CR3T-APIKEY', accessToken: 'S3CR3T-TOKEN', secretAccessKey: 'S3CR3T-AWS',
    connectionString: 'postgres://svc:S3CR3T-IN-URI@db.invalid:5432/app?sslmode=require&password=S3CR3T-QS',
    uri: 'mongodb+srv://u:S3CR3T-MONGO@cluster.invalid/db',
    nested: { credentials: { password: 'S3CR3T-NESTED' }, note: 'keep me' },
    authSource: 'admin',
  };
  beforeAll(async () => {
    T = await mkTenant(`isocs_${s}`);
    await mkSource(T, 'with_secrets', config);
  });
  afterAll(async () => { await cleanupAll(); });

  for (const who of ['owner', 'member'] as const) {
    it(`${who}: list response contains no secret anywhere, only hasPassword + masked URIs`, async () => {
      const r = await request(app).get('/api/admin/connections').set(auth(T[who].token));
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.body);
      expect(text).not.toMatch(/S3CR3T/);
      const row = r.body.find((x: any) => x.name === 'with_secrets');
      expect(row.hasPassword).toBe(true);
      expect(row.config.host).toBe('db.invalid');
      expect(row.config.user).toBe('svc');
      expect(row.config.authSource).toBe('admin');
      expect(row.config.nested.note).toBe('keep me');
      expect(row.config.connectionString).toContain('svc:***@db.invalid');
      expect(row.config.password).toBeUndefined();
    });
  }

  it('metadata/export/other catalog endpoints do not leak source configs either', async () => {
    for (const path of ['/api/metadata/sources', '/api/metadata/export', '/api/admin/catalog']) {
      const r = await request(app).get(path).set(auth(T.member.token));
      expect(JSON.stringify(r.body)).not.toMatch(/S3CR3T/);
    }
  });

  it('notification channel secrets are visible to the owner only', async () => {
    const cfg = { url: 'https://hooks.invalid/x', token: 'S3CR3T-HOOK' };
    const mk = await request(app).post('/api/admin/notification-channels').set(auth(T.owner.token)).send({ channelType: 'WEBHOOK', name: 'ch', config: cfg });
    expect(mk.status).toBe(200);
    const member = await request(app).get('/api/admin/notification-channels').set(auth(T.member.token));
    expect(JSON.stringify(member.body)).not.toMatch(/S3CR3T/);
    const owner = await request(app).get('/api/admin/notification-channels').set(auth(T.owner.token));
    expect(JSON.stringify(owner.body)).toContain('S3CR3T-HOOK');
  });

  describe('redactConfig / maskUri (unit)', () => {
    it('removes secret keys, masks URIs, keeps the rest', () => {
      const r = redactConfig(config);
      expect(r.hasPassword).toBe(true);
      expect(r.redactedKeys).toEqual(expect.arrayContaining(['password', 'pass', 'apiKey', 'accessToken', 'secretAccessKey', 'nested.credentials']));
      expect(JSON.stringify(r.config)).not.toMatch(/S3CR3T/);
    });
    it('masks userinfo and password-like query parameters only', () => {
      expect(maskUri('postgres://u:p@h:1/d')).toBe('postgres://u:***@h:1/d');
      expect(maskUri('postgres://h/d?password=abc&x=1')).toBe('postgres://h/d?password=***&x=1');
      expect(maskUri('not a uri')).toBe('not a uri');
      expect(redactConfig({ host: 'h' }).hasPassword).toBe(false);
    });
  });
});
