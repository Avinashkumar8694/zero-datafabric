import {
  classifyHost, parseIPv4Loose, extractTargets, isHubTarget, assertSourceTargetsAllowed, assertSourceAllowed, assertSourceName,
  assertSafeWebhookUrl, assertWebhookResolvesSafe, NetGuardError, applyDockerAlias,
} from './net_guard';

const env = (o: Record<string, string> = {}): any => ({ DATABASE_URL: 'postgresql://fabric_admin:x@localhost:5434/datafabric', ...o });
const codeOf = (fn: () => any): string => { try { fn(); } catch (e: any) { return e.code || e.message; } return 'OK'; };
const codeOfAsync = async (fn: () => Promise<any>): Promise<string> => { try { await fn(); } catch (e: any) { return e.code || e.message; } return 'OK'; };

describe('classifyHost / parseIPv4Loose', () => {
  it.each([
    ['169.254.169.254', 'metadata'], ['169.254.0.1', 'metadata'], ['metadata.google.internal', 'metadata'], ['METADATA.GOOGLE.INTERNAL', 'metadata'],
    ['2852039166', 'metadata'], ['0xa9fea9fe', 'metadata'], ['0251.0376.0251.0376', 'metadata'], ['169.254.43518', 'metadata'], ['::ffff:169.254.169.254', 'metadata'],
    ['[fe80::1]', 'metadata'], ['fd00:ec2::254', 'metadata'], ['100.100.100.200', 'metadata'],
    ['localhost', 'loopback'], ['foo.localhost', 'loopback'], ['127.0.0.1', 'loopback'], ['127.1', 'loopback'], ['0.0.0.0', 'loopback'], ['::1', 'loopback'], ['[::1]', 'loopback'], ['::', 'loopback'], ['::ffff:127.0.0.1', 'loopback'], ['2130706433', 'loopback'],
    ['10.0.0.5', 'private'], ['172.16.5.4', 'private'], ['172.31.255.255', 'private'], ['192.168.1.1', 'private'], ['100.64.0.1', 'private'], ['fc00::1', 'private'], ['fd12:3456::1', 'private'],
    ['172.32.0.1', 'public'], ['8.8.8.8', 'public'], ['example.com', 'public'], ['db.internal.example.org', 'public'], ['2001:db8::1', 'public'],
  ])('%s -> %s', (host, cls) => { expect(classifyHost(host)).toBe(cls); });
  it('parses loose IPv4 forms', () => {
    expect(parseIPv4Loose('1.2.3.4')).toEqual([1, 2, 3, 4]);
    expect(parseIPv4Loose('0x7f.1')).toEqual([127, 0, 0, 1]);
    expect(parseIPv4Loose('256.1.1.1')).toBeNull();
    expect(parseIPv4Loose('example.com')).toBeNull();
    expect(parseIPv4Loose('1..2')).toBeNull();
  });
});

describe('extractTargets', () => {
  it('reads host/port, URLs, multi-host URIs, libpq strings and oracle descriptors', () => {
    expect(extractTargets({ host: 'a.example', port: 5432 })).toEqual([{ host: 'a.example', port: 5432 }]);
    expect(extractTargets({ connectionString: 'postgresql://u:p@db1:5433/x' })).toEqual([{ host: 'db1', port: 5433 }]);
    expect(extractTargets({ uri: 'mongodb://u:p@h1:27017,h2:27018/db' })).toEqual([{ host: 'h1', port: 27017 }, { host: 'h2', port: 27018 }]);
    expect(extractTargets({ connectionString: 'host=10.0.0.1 port=5432 dbname=x' })).toEqual([{ host: '10.0.0.1', port: 5432 }]);
    expect(extractTargets({ connectString: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=ora.example)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=x)))' }).map((t) => t.host)).toEqual(['ora.example']);
    expect(extractTargets({ connectString: 'ora.example:1521/svc' })).toEqual([{ host: 'ora.example', port: 1521 }]);
    expect(extractTargets({ connectionString: 'http://[::1]:9200' })).toEqual([{ host: '::1', port: 9200 }]);
    expect(extractTargets({ account: 'xy12345' }).map((t) => t.host)).toEqual(['xy12345.snowflakecomputing.com']);
    expect(extractTargets({ connectionString: 'postgresql://u@h/db?host=evil.example' }).map((t) => t.host)).toEqual(['h', 'evil.example']);
  });
  it('rejects unix sockets and unparseable strings', () => {
    expect(() => extractTargets({ connectionString: 'postgresql://u@/db?host=/var/run/postgresql' })).toThrow();
    expect(() => extractTargets({ connectionString: 'host=/var/run/postgresql dbname=x' })).toThrow();
    expect(() => extractTargets({ socketPath: '/tmp/s' })).toThrow();
    expect(() => extractTargets('nope' as any)).toThrow();
    expect(() => extractTargets({ connectionString: 'postgresql://' })).not.toThrow(); // no host: nothing to check
  });
});

describe('hub self-registration (T8)', () => {
  it.each([
    [{ host: 'localhost', port: 5434 }, true],
    [{ host: '127.0.0.1', port: 5434 }, true],
    [{ host: '[::1]', port: 5434 }, true],
    [{ host: '2130706433', port: 5434 }, true],
    [{ host: 'db', port: 5432 }, true],
    [{ host: 'datafabric-hub', port: 5432 }, true],
    [{ host: 'datafabric-hub', port: 5434 }, true],
    [{ host: 'localhost', port: 5436 }, false],
    [{ host: 'localhost', port: 5432 }, false],      // some other local postgres, not the configured hub port
    [{ host: 'datafabric-remote', port: 5432 }, false],
    [{ host: 'warehouse.example.com', port: 5432 }, false],
  ])('%j -> hub=%s', (t, hub) => { expect(isHubTarget(t as any, env())).toBe(hub); });

  it('uses DB_HOST / DB_PORT too', () => {
    const e = { DB_HOST: 'pg-fabric', DB_PORT: '6000' } as any;
    expect(isHubTarget({ host: 'pg-fabric', port: 6000 }, e)).toBe(true);
    expect(isHubTarget({ host: 'PG-FABRIC', port: 6000 }, e)).toBe(true);
    expect(isHubTarget({ host: 'pg-fabric', port: 5432 }, e)).toBe(false);
    expect(isHubTarget({ host: '127.0.0.1', port: 6000 }, e)).toBe(true);
  });

  it('is refused for members and admins unless admin AND ALLOW_HUB_SOURCE=true', () => {
    const cfg = { type: 'postgres', host: '127.0.0.1', port: 5434, dbName: 'datafabric' };
    expect(codeOf(() => assertSourceTargetsAllowed(cfg, { env: env() }))).toBe('HUB_SOURCE_NOT_ALLOWED');
    expect(codeOf(() => assertSourceTargetsAllowed(cfg, { isPlatformAdmin: true, env: env() }))).toBe('HUB_SOURCE_NOT_ALLOWED');
    expect(codeOf(() => assertSourceTargetsAllowed(cfg, { isPlatformAdmin: false, env: env({ ALLOW_HUB_SOURCE: 'true' }) }))).toBe('HUB_SOURCE_NOT_ALLOWED');
    expect(codeOf(() => assertSourceTargetsAllowed(cfg, { isPlatformAdmin: true, env: env({ ALLOW_HUB_SOURCE: 'true' }) }))).toBe('OK');
  });
  it('catches the docker alias rewrite (localhost:5434 -> datafabric-hub:5432) even when the hub is elsewhere', () => {
    expect(applyDockerAlias({ host: 'localhost', port: 5434 })).toEqual({ host: 'datafabric-hub', port: 5432 });
    expect(applyDockerAlias({ host: '127.0.0.1', port: 5436 })).toEqual({ host: 'datafabric-remote', port: 5432 });
    expect(codeOf(() => assertSourceTargetsAllowed({ host: 'localhost', port: 5434 }, { env: { DATABASE_URL: 'postgresql://u:p@127.0.0.1:55450/datafabric' } as any }))).toBe('HUB_SOURCE_NOT_ALLOWED');
  });
  it('catches connection strings', () => {
    expect(codeOf(() => assertSourceTargetsAllowed({ connectionString: 'postgresql://fabric_admin:x@127.0.0.1:5434/datafabric' }, { env: env() }))).toBe('HUB_SOURCE_NOT_ALLOWED');
    expect(codeOf(() => assertSourceTargetsAllowed({ connectionString: 'host=db port=5432 dbname=datafabric' }, { env: env() }))).toBe('HUB_SOURCE_NOT_ALLOWED');
    expect(codeOf(() => assertSourceTargetsAllowed({ connectionString: 'host=127.0.0.1 port=5434 dbname=datafabric user=a password=b' }, { env: env() }))).toBe('HUB_SOURCE_NOT_ALLOWED');
    expect(codeOf(() => assertSourceTargetsAllowed({ connectionString: "host='127.0.0.1' port='5434'" }, { env: env() }))).toBe('HUB_SOURCE_NOT_ALLOWED');
    expect(codeOf(() => assertSourceTargetsAllowed({ connectionString: 'host=127.0.0.1 port=5436 dbname=x' }, { env: env() }))).toBe('OK');
    expect(codeOf(() => assertSourceTargetsAllowed({ connectionString: 'postgresql://u:p@datafabric-remote:5432/w' }, { env: env() }))).toBe('OK');
  });
  it('resolves names: a public name pointing at the hub address is refused', async () => {
    const e = { DB_HOST: 'hub.internal', DB_PORT: '5432' } as any;
    const resolver = async (h: string) => (h === 'hub.internal' ? ['10.1.1.1'] : h === 'sneaky.example.com' ? ['10.1.1.1'] : ['93.184.216.34']);
    expect(await codeOfAsync(() => assertSourceAllowed({ host: 'sneaky.example.com', port: 5432 }, { env: e }, resolver))).toBe('HUB_SOURCE_NOT_ALLOWED');
    expect(await codeOfAsync(() => assertSourceAllowed({ host: 'other.example.com', port: 5432 }, { env: e }, resolver))).toBe('OK');
  });
});

describe('SSRF (T: test-connection)', () => {
  it.each(['169.254.169.254', 'metadata.google.internal', '2852039166', '[fe80::1]', '::ffff:169.254.169.254'])('always blocks %s', (host) => {
    expect(codeOf(() => assertSourceTargetsAllowed({ host, port: 80 }, { env: env() }))).toBe('SSRF_BLOCKED');
    expect(codeOf(() => assertSourceTargetsAllowed({ host, port: 80 }, { isPlatformAdmin: true, env: env({ ALLOW_HUB_SOURCE: 'true', ALLOW_PRIVATE_SOURCES: 'true' }) }))).toBe('SSRF_BLOCKED');
  });
  it('blocks metadata in URLs and connection strings too', () => {
    expect(codeOf(() => assertSourceTargetsAllowed({ connectionString: 'http://169.254.169.254/latest/meta-data' }, { env: env() }))).toBe('SSRF_BLOCKED');
    expect(codeOf(() => assertSourceTargetsAllowed({ uri: 'mongodb://169.254.169.254:27017/x' }, { env: env() }))).toBe('SSRF_BLOCKED');
    expect(codeOf(() => assertSourceTargetsAllowed({ connectionString: 'postgresql://u@h/db?host=169.254.169.254' }, { env: env() }))).toBe('SSRF_BLOCKED');
  });
  it('private/loopback allowed by default, refused when ALLOW_PRIVATE_SOURCES=false', () => {
    expect(codeOf(() => assertSourceTargetsAllowed({ host: '10.0.0.5', port: 5432 }, { env: env() }))).toBe('OK');
    expect(codeOf(() => assertSourceTargetsAllowed({ host: '10.0.0.5', port: 5432 }, { env: env({ ALLOW_PRIVATE_SOURCES: 'false' }) }))).toBe('PRIVATE_TARGET_BLOCKED');
    expect(codeOf(() => assertSourceTargetsAllowed({ host: 'localhost', port: 5436 }, { env: env({ ALLOW_PRIVATE_SOURCES: 'false' }) }))).toBe('PRIVATE_TARGET_BLOCKED');
    expect(codeOf(() => assertSourceTargetsAllowed({ host: 'warehouse.example.com', port: 5432 }, { env: env({ ALLOW_PRIVATE_SOURCES: 'false' }) }))).toBe('OK');
  });
  it('a public name that resolves to metadata is blocked', async () => {
    const resolver = async () => ['169.254.169.254'];
    expect(await codeOfAsync(() => assertSourceAllowed({ host: 'rebind.example.com', port: 80 }, { env: env() }, resolver))).toBe('SSRF_BLOCKED');
    const priv = async () => ['10.0.0.9'];
    expect(await codeOfAsync(() => assertSourceAllowed({ host: 'x.example.com', port: 80 }, { env: env({ ALLOW_PRIVATE_SOURCES: 'false' }) }, priv))).toBe('PRIVATE_TARGET_BLOCKED');
    expect(await codeOfAsync(() => assertSourceAllowed({ host: 'x.example.com', port: 80 }, { env: env() }, async () => { throw new Error('ENOTFOUND'); }))).toBe('OK');
  });
});

describe('assertSourceName', () => {
  it.each(['Remote_Warehouse', 'a', 'Activity-Mongo', 'Audit Test Source', 'x'.repeat(48)])('accepts %s', (n) => { expect(assertSourceName(n)).toBe(n); });
  it.each(['', 'x'.repeat(49), '1abc', 'trailing ', ' leading', 'a\nb', 'a.b', 'a"b', "a'b", 'a;b', '../x', 'ünï', 'a\u0000', null, 5, {}])('rejects %j', (n) => { expect(codeOf(() => assertSourceName(n))).toBe('INVALID_SOURCE_NAME'); });
});

describe('assertSafeWebhookUrl', () => {
  const e = (o: Record<string, string> = {}) => ({ env: o as any });
  it('accepts public http(s) URLs', () => {
    expect(assertSafeWebhookUrl('https://hooks.example.com/a?b=1', e())).toBe('https://hooks.example.com/a?b=1');
    expect(assertSafeWebhookUrl('http://8.8.8.8:8080/x', e())).toContain('8.8.8.8');
  });
  it.each(['ftp://x.example.com/a', 'file:///etc/passwd', 'gopher://x', 'javascript:alert(1)', 'data:text/plain,hi', '//x.example.com', 'x.example.com', '', ' ', 'http://', 'http://user:pw@x.example.com/', 'http://user@x.example.com/', 'https://x.example.com/\u0000', 'http://x.example.com/a b', 'http://x.example.com\\@evil'])('rejects %j', (u) => {
    expect(() => assertSafeWebhookUrl(u, e())).toThrow(NetGuardError);
  });
  it.each(['http://169.254.169.254/latest/meta-data', 'http://metadata.google.internal/computeMetadata/v1/', 'http://[fe80::1]/', 'http://2852039166/', 'http://0xa9fea9fe/', 'http://[::ffff:169.254.169.254]/'])('always blocks metadata target %s', (u) => {
    expect(codeOf(() => assertSafeWebhookUrl(u, e()))).toBe('SSRF_BLOCKED');
    expect(codeOf(() => assertSafeWebhookUrl(u, e({ ALLOW_PRIVATE_WEBHOOKS: 'true' })))).toBe('SSRF_BLOCKED');
  });
  it.each(['http://localhost:8080/', 'http://127.0.0.1/', 'http://[::1]/', 'http://10.0.0.1/', 'http://192.168.0.10/x', 'http://172.20.0.2/', 'http://db:5432/', 'http://datafabric-hub/', 'http://0.0.0.0/'])('blocks loopback/private %s unless ALLOW_PRIVATE_WEBHOOKS=true', (u) => {
    expect(codeOf(() => assertSafeWebhookUrl(u, e()))).toBe('PRIVATE_TARGET_BLOCKED');
    expect(codeOf(() => assertSafeWebhookUrl(u, e({ ALLOW_PRIVATE_WEBHOOKS: 'true' })))).toBe('OK');
  });
  it('rejects overlong URLs', () => { expect(() => assertSafeWebhookUrl('https://x.example.com/' + 'a'.repeat(2100), e())).toThrow(); });
  it('re-checks resolved addresses at execution time', async () => {
    expect(await codeOfAsync(() => assertWebhookResolvesSafe('https://rebind.example.com/', e(), async () => ['169.254.169.254']))).toBe('SSRF_BLOCKED');
    expect(await codeOfAsync(() => assertWebhookResolvesSafe('https://rebind.example.com/', e(), async () => ['127.0.0.1']))).toBe('PRIVATE_TARGET_BLOCKED');
    expect(await codeOfAsync(() => assertWebhookResolvesSafe('https://ok.example.com/', e(), async () => ['93.184.216.34']))).toBe('OK');
    expect(await codeOfAsync(() => assertWebhookResolvesSafe('https://gone.example.com/', e(), async () => { throw new Error('x'); }))).toBe('WEBHOOK_UNRESOLVABLE');
  });
});
