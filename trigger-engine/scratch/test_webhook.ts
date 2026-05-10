import { Client } from 'pg';
import * as dotenv from 'dotenv';
import { TriggerTranspiler } from '../src/modules/triggers/trigger.transpiler';

dotenv.config();

async function testWebhookTrigger() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://fabric_admin:fabric_password@localhost:5434/zero_datafabric'
    });

    try {
        await client.connect();
        console.log('Connected to database.');

        // 1. Setup Test Table
        await client.query(`DROP TABLE IF EXISTS public.test_webhook_table`);
        await client.query(`CREATE TABLE public.test_webhook_table (id SERIAL PRIMARY KEY, status TEXT, amount NUMERIC)`);
        console.log('Test table created.');

        // 2. Define Trigger
        const trgDef = {
            name: 'test_webhook_alert',
            event: 'AFTER_INSERT' as any,
            condition: { column: 'NEW.amount', operator: 'GT', value: 100 },
            execute: {
                type: 'WEBHOOK' as any,
                url: 'https://httpbin.org/post',
                method: 'POST',
                payload: {
                    msg: 'High value transaction detected!',
                    id: '{{newRow.id}}',
                    value: '{{newRow.amount}}'
                }
            }
        };

        // 3. Register Trigger
        await client.query(`DELETE FROM public.trigger_registry WHERE trigger_name = $1`, [trgDef.name]);
        await client.query(`
            INSERT INTO public.trigger_registry (tenant_id, trigger_name, schema_name, table_name, definition, status)
            VALUES ('default', $1, 'public', 'test_webhook_table', $2, 'ACTIVE')
        `, [trgDef.name, JSON.stringify(trgDef)]);
        console.log('Trigger registered in metadata.');

        // 4. Create Physical Trigger
        const sqls = TriggerTranspiler.toSql(trgDef, 'public', 'test_webhook_table');
        for (const sql of sqls) {
            await client.query(sql);
        }
        console.log('Physical trigger and function created in DB.');

        // 5. Trigger the event
        console.log('Setting session variables and inserting row to fire trigger...');
        await client.query(`SET app.tenant_id = 'default'`);
        await client.query(`SET app.user_name = 'test_user'`);
        await client.query(`INSERT INTO public.test_webhook_table (status, amount) VALUES ('PENDING', 500)`);

        // 6. Monitor Logs
        console.log('Waiting for Trigger Engine to process job...');
        for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const { rows } = await client.query(`
                SELECT * FROM public.trigger_execution_logs 
                WHERE trigger_name = $1 
                ORDER BY created_at DESC LIMIT 1
            `, [trgDef.name]);

            if (rows.length > 0) {
                console.log('Log entry found:');
                console.log(JSON.stringify(rows[0], null, 2));
                if (rows[0].status === 'SUCCESS') {
                    console.log('✅ Webhook Trigger Test SUCCESSFUL!');
                    return;
                } else {
                    console.log('❌ Webhook Trigger Test FAILED in execution.');
                    return;
                }
            }
            console.log(`Still waiting... (${i+1}/10)`);
        }

        console.log('⏳ Timeout waiting for trigger execution.');

    } catch (err) {
        console.error('Error during test:', err);
    } finally {
        await client.end();
    }
}

testWebhookTrigger();
