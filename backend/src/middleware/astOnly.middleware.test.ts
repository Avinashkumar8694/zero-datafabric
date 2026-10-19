import { astOnly } from './astOnly.middleware';

const run = (body: any) => {
    const res: any = {
        statusCode: 200,
        payload: undefined,
        status(c: number) { this.statusCode = c; return this; },
        json(p: any) { this.payload = p; return this; },
    };
    const next = jest.fn();
    astOnly({ body } as any, res, next);
    return { res, next };
};

const expectRejected = (body: any) => {
    const { res, next } = run(body);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.payload.code).toBe('SQL_NOT_SUPPORTED');
    expect(typeof res.payload.error).toBe('string');
};

const expectAllowed = (body: any) => {
    const { res, next } = run(body);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
};

describe('astOnly middleware', () => {
    describe('rejects SQL text', () => {
        it.each(['sql', 'rawSql', 'nativeSql', 'rawQuery'])('top-level "%s" key', (key) => {
            expectRejected({ [key]: 'SELECT 1' });
        });

        it('rejects a string `query`', () => {
            expectRejected({ query: 'SELECT * FROM users' });
        });

        it('rejects `sql` inside a query object', () => {
            expectRejected({ query: { type: 'SELECT', table: 't', sql: 'SELECT 1' } });
        });

        it('rejects nested config.query.sql', () => {
            expectRejected({ name: 'x', config: { query: { sql: 'SELECT 1' } } });
        });

        it('rejects `sql` inside config', () => {
            expectRejected({ name: 'x', config: { sql: 'SELECT 1' } });
        });

        it('rejects a string config.query', () => {
            expectRejected({ name: 'x', config: { query: 'SELECT 1' } });
        });

        it.each(['RawSql', 'RAWSQL', 'NativeSQL', 'SQL', 'rawquery'])('is case-insensitive ("%s")', (key) => {
            expectRejected({ [key]: 'SELECT 1' });
        });

        it('rejects even when mixed with a valid AST', () => {
            expectRejected({ type: 'SELECT', table: 'users', rawSql: 'DROP TABLE users' });
        });
    });

    describe('allows AST and data payloads', () => {
        it('allows an AST SELECT', () => {
            expectAllowed({ type: 'SELECT', table: 'users', select: ['id'], filter: { id: 1 } });
        });

        it('allows an AST wrapped in an object `query`', () => {
            expectAllowed({ query: { type: 'SELECT', table: 'users' } });
        });

        it('allows config.query as an AST object', () => {
            expectAllowed({ name: 'x', config: { query: { type: 'SELECT', table: 'users' } } });
        });

        it('does NOT reject a column named `sql` inside insert row data', () => {
            expectAllowed({ resource: 'snippets', data: { id: 1, sql: 'SELECT 1', rawSql: 'x' } });
        });

        it('does NOT reject a column named `sql` inside an array of rows', () => {
            expectAllowed({ resource: 'snippets', data: [{ sql: 'a' }, { sql: 'b' }] });
        });

        it('does NOT reject `sql` in a filter value of an AST', () => {
            expectAllowed({ type: 'SELECT', table: 'snippets', filter: { sql: 'SELECT 1' } });
        });

        it('allows an empty object body', () => {
            expectAllowed({});
        });

        it('allows undefined / null bodies (GET requests)', () => {
            expectAllowed(undefined);
            expectAllowed(null);
        });

        it('allows array bodies without throwing', () => {
            expectAllowed([]);
            expectAllowed([{ type: 'SELECT', table: 'users' }]);
        });

        it('does not treat strings elsewhere as SQL', () => {
            expectAllowed({ name: 'SELECT 1', description: 'select * from users' });
        });
    });
});
