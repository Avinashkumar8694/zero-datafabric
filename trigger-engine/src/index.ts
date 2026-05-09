import express from 'express';
import cors from 'cors';
import { TriggerTranspiler } from './modules/triggers/trigger.transpiler';

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

app.listen(PORT, () => {
    console.log(`[TriggerEngine] Microservice running on port ${PORT}`);
});
