import { ManifestParser, ManifestInputError, MANIFEST_MAX_BYTES } from './manifest_parser';
import { isAcceptableManifestFile } from './manifest_upload';
import { validateManifestDocument } from './manifest_validator';

const json = (o: any) => JSON.stringify(o);
const MIN = { version: '4.0', schemas: [{ name: 'sales', resources: [] }] };

describe('ManifestParser', () => {
  it('parses JSON, YAML, a Markdown fenced block and a Buffer', () => {
    expect(ManifestParser.parse(json(MIN)).schemas[0].name).toBe('sales');
    expect(ManifestParser.parse('version: "4.0"\nschemas:\n  - name: sales\n    resources: []\n').schemas[0].name).toBe('sales');
    expect(ManifestParser.parse('# doc\n```json\n' + json(MIN) + '\n```\n').version).toBe('4.0');
    expect(ManifestParser.parse(Buffer.from(json(MIN))).version).toBe('4.0');
  });

  it('normalises the legacy flat shape and uses a non-reserved default schema name', () => {
    const m = ManifestParser.parse(json({ version: '4.0', resources: [] }));
    expect(m.schemas[0].name).toBe('default');
    const n = ManifestParser.parse(json({ version: '4.0', namespace: 'x', schemas: [{ name: 's', tables: [{ name: 't', columns: [] }], enums: [{ name: 'e', values: ['a'] }] }] }));
    expect(n.schemas[0].resources.map((r: any) => r.type).sort()).toEqual(['ENUM', 'TABLE']);
  });

  it('enforces the size cap (default 5 MB)', () => {
    expect(MANIFEST_MAX_BYTES).toBe(5 * 1024 * 1024);
    const big = json({ version: '4.0', schemas: [], pad: 'x'.repeat(MANIFEST_MAX_BYTES + 1) });
    try { ManifestParser.parse(big); throw new Error('no throw'); } catch (e: any) { expect(e).toBeInstanceOf(ManifestInputError); expect(e.status).toBe(413); expect(e.code).toBe('MANIFEST_TOO_LARGE'); }
  });

  describe('YAML safety', () => {
    it('rejects anchors / aliases (billion-laughs shapes included)', () => {
      expect(() => ManifestParser.parse('version: "4.0"\nschemas:\n  - &a {name: sales, resources: []}\n  - *a\n')).toThrow(/aliases/);
      const lol = ['a: &a [x,x,x,x,x,x,x,x,x]', 'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]', 'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]', 'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]', 'version: "4.0"', 'schemas: *d'].join('\n');
      expect(() => ManifestParser.parse(lol)).toThrow(/aliases/);
    });
    it.each(['!!js/function "function(){}"', '!!python/object/apply:os.system ["id"]', '!<tag:evil> x', '!!binary aGk='])('rejects custom / non-core tags: %s', (tag) => {
      expect(() => ManifestParser.parse(`version: "4.0"\nschemas: []\nx: ${tag}\n`)).toThrow();
    });
    it('does not process merge keys', () => {
      const m = ManifestParser.parse('base: {a: 1}\nversion: "4.0"\nschemas: []\nm:\n  <<: {a: 2}\n');
      expect(m.m['<<']).toBeDefined();
    });
  });

  describe('prototype pollution', () => {
    it.each(['__proto__', 'constructor', 'prototype'])('rejects %s keys in JSON and YAML', (k) => {
      expect(() => ManifestParser.parse(`{"version":"4.0","schemas":[],"${k}":{"polluted":true}}`)).toThrow(/not allowed/);
      expect(() => ManifestParser.parse(`version: "4.0"\nschemas: []\n${k}:\n  polluted: true\n`)).toThrow(/not allowed/);
      expect(({} as any).polluted).toBeUndefined();
    });
  });

  it.each(['', 'hello', '42', 'null', '[]', '[1,2]', '{', 'version: [', '"just a string"'])('rejects non-object / malformed input %j', (bad) => {
    expect(() => ManifestParser.parse(bad)).toThrow();
  });
  it('rejects NUL bytes', () => { expect(() => ManifestParser.parse(json(MIN) + '\u0000')).toThrow(); });

  it('unknown top-level keys are rejected by the validator with a list', () => {
    const m = ManifestParser.parse(json({ ...MIN, evil: 1, another: 2 }));
    expect(() => validateManifestDocument(m, { tenantId: 'acme' })).toThrow(/evil, another|another, evil/);
  });
});

describe('manifest upload filter', () => {
  it.each([['m.json', 'application/json', true], ['m.yaml', 'application/x-yaml', true], ['m.yml', 'text/yaml', true], ['m.JSON', 'application/octet-stream', true],
    ['m.exe', 'application/octet-stream', false], ['m.sql', 'text/plain', false], ['m.json.exe', 'application/json', false], ['m.json', 'image/png', false], ['m', 'application/json', false], ['m.md', 'text/markdown', false]])
  ('%s (%s) -> %s', (name, mime, ok) => { expect(isAcceptableManifestFile(name as string, mime as string)).toBe(ok); });
});
