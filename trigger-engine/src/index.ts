import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { TriggerTranspiler } from './modules/triggers/trigger.transpiler';
import { TriggerWorker } from './modules/triggers/trigger.worker';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 4001;

app.post('/api/trig-engine/transpile', (req, res) => {
    try {
        const { trigger, schemaName, tableName } = req.body;
        if (!trigger || !schemaName || !tableName) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        const sql = TriggerTranspiler.toSql(trigger, schemaName, tableName);
        return res.json({ sql });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/trig-engine/health', (req, res) => {
  res.json({ status: 'UP', worker: 'ACTIVE' });
});

app.post('/api/trig-engine/jobs/run-once', async (req, res) => {
  try {
    await TriggerWorker.runOnce();
    res.json({ status: 'OK' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
    console.log(`[TriggerEngine] Microservice running on port ${PORT}`);
    TriggerWorker.start(Number(process.env.TRIGGER_POLL_INTERVAL_MS || 1500));
});
