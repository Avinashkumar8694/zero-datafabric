import { QueryEngineService } from '../src/modules/query-engine/query-engine.service';

async function test() {
    const config: any = {
        type: 'SELECT',
        table: 'users',
        select: ['id'],
        filter: { status: 'ACTIVE' }
    };
    const { sql, params } = await QueryEngineService.generateSql('test', config, true);
    console.log('SQL:', sql);
    console.log('Params:', params);
}

test().catch(console.error);
