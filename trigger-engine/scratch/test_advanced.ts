import { Client } from 'pg';
import * as dotenv from 'dotenv';
import { TriggerTranspiler } from '../src/modules/triggers/trigger.transpiler';

dotenv.config();

async function testAdvancedWebhook() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://fabric_admin:fabric_password@localhost:5434/zero_datafabric'
    });

    try {
        await client.connect();
        console.log('Connected to database.');

        // 1. Setup Test Table
        await client.query(`DROP TABLE IF EXISTS public.test_advanced_table`);
        await client.query(`CREATE TABLE public.test_advanced_table (id SERIAL PRIMARY KEY, status TEXT, amount NUMERIC)`);
        console.log('Test table created.');

        // 2. Define Trigger with Shorthands and Stop Condition
        const trgDef = {
            name: 'test_unique_4002',
            event: 'AFTER_INSERT' as any,
            condition: { column: 'NEW.amount', operator: 'GT', value: 100 },
            execute: {
                type: 'WEBHOOK' as any,
                url: 'https://httpbin.org/post',
                method: 'POST',
                payload: {
                    msg: 'Shorthand Test Success!',
                    id_prefixed: '{{NEW.id}}',
                    amount_shorthand: '{{amount}}',
                    trigger: '{{triggerName}}'
                }
            },
            schedule: {
                type: 'FIXED' as any,
                every: 1,
                unit: 'MINUTE' as any,
                stopCondition: { column: 'status', operator: 'EQ', value: 'RESOLVED' }
            }
        };

        // 3. Register & Deploy
        await client.query(`DELETE FROM public.trigger_registry WHERE trigger_name = $1`, [trgDef.name]);
        await client.query(`
            INSERT INTO public.trigger_registry (tenant_id, trigger_name, schema_name, table_name, definition, status)
            VALUES ('default', $1, 'public', 'test_advanced_table', $2, 'ACTIVE')
        `, [trgDef.name, JSON.stringify(trgDef)]);

        const sqls = TriggerTranspiler.toSql(trgDef, 'public', 'test_advanced_table');
        for (const sql of sqls) {
            await client.query(sql);
        }
        console.log('Trigger deployed.');

        // 4. Fire the trigger
        console.log('Inserting row...');
        await client.query(`SET app.tenant_id = 'default'`);
        await client.query(`SET app.user_name = 'tester'`);
        await client.query(`INSERT INTO public.test_advanced_table (status, amount) VALUES ('PENDING', 999)`);

        // 5. Check first execution (should have shorthand resolved)
        console.log('Waiting for first execution...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const { rows: logs } = await client.query(`
            SELECT * FROM public.trigger_execution_logs WHERE trigger_name = $1 ORDER BY created_at DESC LIMIT 1
        `, [trgDef.name]);

        if (logs.length > 0) {
            console.log('First Log Details:');
            console.log(JSON.stringify(logs[0].detail.body, null, 2));
            const body = logs[0].detail.body;
            if (body.amount_shorthand === '999' && body.id_prefixed === '1') {
                console.log('✅ Shorthand and NEW. prefix resolution SUCCESSFUL!');
            } else {
                console.log('❌ Variable resolution FAILED!');
                console.log('Expected amount_shorthand: 999, got:', body.amount_shorthand);
            }
        }

        // 6. Test Stop Condition
        console.log('Updating row to RESOLVED to test stop condition...');
        await client.query(`UPDATE public.test_advanced_table SET status = 'RESOLVED' WHERE id = 1`);
        
        console.log('Waiting for next scheduled tick...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        const { rows: stopLogs } = await client.query(`
            SELECT * FROM public.trigger_execution_logs 
            WHERE trigger_name = $1 AND detail->>'msg' ILIKE '%Stop condition met%'
            ORDER BY created_at DESC LIMIT 1
        `, [trgDef.name]);

        if (stopLogs.length > 0) {
            console.log('✅ Stop Condition Test SUCCESSFUL!');
            console.log('Termination Message:', stopLogs[0].detail.msg);
        } else {
            console.log('❌ Stop Condition NOT detected in logs.');
        }

    } catch (err) {
        console.error('Test Error:', err);
    } finally {
        await client.end();
    }
}

testAdvancedWebhook();
