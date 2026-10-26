/**
 * Express API Server for demo-example-one
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const TestRunner = require('./runner');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5050;
let lastRunResults = null;
let isRunning = false;

app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'demo-example-one',
    timestamp: new Date().toISOString(),
    engineUrl: process.env.DF_API_URL || 'http://127.0.0.1:4000/api'
  });
});

app.get('/api/manifests', (req, res) => {
  const manifestsDir = path.join(__dirname, 'manifests');
  try {
    const files = fs.readdirSync(manifestsDir).filter(f => f.endsWith('.json')).sort();
    const manifestSummaries = files.map(file => {
      const content = JSON.parse(fs.readFileSync(path.join(manifestsDir, file), 'utf8'));
      const resources = content.schemas?.[0]?.resources || [];
      return {
        file,
        step: file.split('-')[0],
        namespace: content.namespace,
        resourceCount: resources.length,
        tables: resources.filter(r => r.type === 'TABLE').map(t => t.name),
        enums: resources.filter(r => r.type === 'ENUM').map(e => e.name)
      };
    });
    res.json({ manifests: manifestSummaries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test/status', (req, res) => {
  res.json({
    isRunning,
    lastRunAt: lastRunResults ? new Date(Date.now() - (lastRunResults.durationMs || 0)).toISOString() : null,
    summary: lastRunResults ? {
      status: lastRunResults.status,
      passed: lastRunResults.passed,
      failed: lastRunResults.failed,
      totalAssertions: lastRunResults.totalAssertions,
      durationMs: lastRunResults.durationMs
    } : null
  });
});

app.post('/api/test/run', async (req, res) => {
  if (isRunning) {
    return res.status(409).json({ error: 'A test run is already in progress' });
  }

  isRunning = true;
  try {
    const runner = new TestRunner();
    lastRunResults = await runner.runAll();
    isRunning = false;
    res.json(lastRunResults);
  } catch (err) {
    isRunning = false;
    res.status(500).json({
      status: 'FAILED',
      error: err.message,
      results: runner ? runner.results : []
    });
  }
});

app.get('/api/test/report', (req, res) => {
  if (!lastRunResults) {
    return res.status(404).json({ error: 'No test has been executed yet. Call POST /api/test/run first.' });
  }
  res.json(lastRunResults);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Demo Example One API running on http://127.0.0.1:${PORT}`);
    console.log(`Trigger tests via POST http://127.0.0.1:${PORT}/api/test/run`);
  });
}

module.exports = app;
