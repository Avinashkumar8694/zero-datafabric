import { wantsStream, streamNdjson } from './stream';

describe('stream helpers', () => {
  describe('wantsStream', () => {
    it('detects the flag in body, queryConfig, config, or query string', () => {
      expect(wantsStream({ body: { stream: true } })).toBe(true);
      expect(wantsStream({ body: { stream: 'true' } })).toBe(true);
      expect(wantsStream({ body: { queryConfig: { stream: true } } })).toBe(true);
      expect(wantsStream({ body: { config: { stream: '1' } } })).toBe(true);
      expect(wantsStream({ query: { stream: 'true' } })).toBe(true);
    });
    it('defaults to false', () => {
      expect(wantsStream({ body: {} })).toBe(false);
      expect(wantsStream({ body: { stream: false } })).toBe(false);
      expect(wantsStream({})).toBe(false);
    });
  });

  describe('streamNdjson', () => {
    // Minimal Express-response stub that records writes.
    const makeRes = () => {
      const headers: Record<string, string> = {};
      const chunks: string[] = [];
      return {
        headers, chunks, ended: false,
        setHeader(k: string, v: string) { headers[k] = v; },
        write(s: string) { chunks.push(s); return true; },
        end() { this.ended = true; },
      };
    };

    it('emits one line per row then a __meta__ trailer, and ends', () => {
      const res: any = makeRes();
      streamNdjson(res, [{ id: 1 }, { id: 2 }], { strategy: 'SINGLE_CONNECTOR', rowCount: 2 });
      const lines = res.chunks.join('').trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0])).toEqual({ id: 1 });
      expect(JSON.parse(lines[1])).toEqual({ id: 2 });
      const meta = JSON.parse(lines[2]).__meta__;
      expect(meta.streamed).toBe(true);
      expect(meta.rowCount).toBe(2);
      expect(meta.strategy).toBe('SINGLE_CONNECTOR');
      expect(res.ended).toBe(true);
      expect(res.headers['Content-Type']).toMatch(/application\/x-ndjson/);
    });

    it('handles an empty result (only the trailer)', () => {
      const res: any = makeRes();
      streamNdjson(res, [], { strategy: 'RAW_SQL' });
      const lines = res.chunks.join('').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).__meta__.rowCount).toBe(0);
    });
  });
});
