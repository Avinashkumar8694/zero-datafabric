import express from 'express';
import path from 'path';
import fs from 'fs';
import { marked } from 'marked';

dotenv.config();

const app = express();
const PORT = process.env.UI_PORT || 3001;

const DOC_LIST = [
  { id: 'how-to-guide.md', title: 'How-To Developer Guide' },
  { id: 'creating-analytics.md', title: 'Creating Analytics & Widgets' },
  { id: 'crud-create.md', title: 'API: Create (Insert)' },
  { id: 'crud-read.md', title: 'API: Read (Fetch)' },
  { id: 'crud-update.md', title: 'API: Update' },
  { id: 'crud-delete.md', title: 'API: Delete' },
  { id: 'complex-crud-examples.md', title: 'Complex CRUD Scenarios' },
  { id: 'queries-cookbook.md', title: 'Queries Cookbook' },
  { id: 'manifests-cookbook.md', title: 'Manifests Cookbook' },
  { id: 'schema-specification.md', title: 'Schema Specification' },
  { id: 'type-and-enum-reference.md', title: 'Type & Enum Reference' },
  { id: 'api-overview.md', title: 'API Overview' },
  { id: 'concepts.md', title: 'Core Concepts' },
  { id: 'query-language.md', title: 'AST Query Language' },
  { id: 'recursive-and-window-queries.md', title: 'Recursive & Windowing' },
  { id: 'metadata-manifests.md', title: 'Metadata & Manifests' },
  { id: 'connectors.md', title: 'Data Source Connectors' },
  { id: 'sync-and-cdc.md', title: 'Sync & CDC Pipelines' },
  { id: 'replication.md', title: 'Downstream Replication' },
  { id: 'triggers-api.md', title: 'Event Triggers API' },
  { id: 'data-crud-api.md', title: 'Data CRUD Operations' },
  { id: 'governance-api.md', title: 'Data Governance' },
  { id: 'analytics-api.md', title: 'Analytics Engine' },
  { id: 'saved-analytics-api.md', title: 'Saved Analytics' },
  { id: 'admin-api.md', title: 'Administration API' },
  { id: 'authentication-and-tenancy.md', title: 'Security & Tenancy' },
  { id: 'observability-api.md', title: 'Observability & Metrics' },
  { id: 'streaming-responses.md', title: 'Streaming Responses' },
  { id: 'README.md', title: 'Developer Getting Started' }
];

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// UI Routes
app.get('/', (req, res) => {
  res.render('index', { title: 'Zero Data Fabric - Home' });
});

app.get('/login', (req, res) => {
  res.render('login', { title: 'Zero Data Fabric - Login' });
});

app.get('/logout', (req, res) => {
  res.render('logout', { title: 'Zero Data Fabric - Logout' });
});

app.get('/dashboard', (req, res) => {
  res.render('dashboard', { title: 'Zero Data Fabric - Dashboard' });
});

app.get('/tenants', (req, res) => {
  res.render('tenants', { title: 'Zero Data Fabric - Tenants' });
});

app.get('/connections', (req, res) => {
  res.render('connections', { title: 'Zero Data Fabric - Connections' });
});

app.get('/replication', (req, res) => {
  res.render('replication', { title: 'Zero Data Fabric - Replication' });
});

app.get('/workbench', (req, res) => {
  res.render('workbench', { title: 'Zero Data Fabric - Workbench' });
});

app.get('/workbench/docs', async (req, res) => {
  const docParam = (req.query.doc as string) || 'how-to-guide.md';
  const activeDoc = DOC_LIST.find(d => d.id === docParam) || DOC_LIST[0];

  try {
    const docPath = path.join(__dirname, 'views', '../../../developer_docs', activeDoc.id);
    const markdown = fs.readFileSync(docPath, 'utf8');
    const htmlContent = await marked.parse(markdown);

    res.render('workbench_docs', {
      title: `Zero Data Fabric - Docs: ${activeDoc.title}`,
      htmlContent,
      currentDoc: activeDoc.id,
      docList: DOC_LIST
    });
  } catch (error) {
    console.error('Error loading markdown doc:', error);
    res.status(500).send('Error loading documentation file');
  }
});

app.get('/iam', (req, res) => {
  res.render('iam', { title: 'Zero Data Fabric - IAM' });
});

app.get('/audit', (req, res) => {
  res.render('audit', { title: 'Zero Data Fabric - Audit Logs' });
});

app.get('/triggers', (req, res) => {
  res.render('triggers', { title: 'Zero Data Fabric - Trigger Control Plane' });
});

app.get('/catalog', (req, res) => {
  res.render('catalog', { title: 'Zero Data Fabric - Discovery Catalog' });
});

app.get('/metadata', (req, res) => {
  res.render('metadata', { title: 'Zero Data Fabric - Metadata Orchestration' });
});

app.get('/analytics', (req, res) => {
  res.render('analytics', { title: 'Zero Data Fabric - Analytics Dashboard' });
});

app.get('/analytics/custom', (req, res) => {
  res.render('custom_analytics', { title: 'Zero Data Fabric - Custom Analytics' });
});
// Back-compat: the old saved-analytics path now serves the custom analytics page.
app.get('/analytics/saved', (req, res) => {
  res.render('custom_analytics', { title: 'Zero Data Fabric - Custom Analytics' });
});

app.get('/settings', (req, res) => {
  res.render('settings', { title: 'Zero Data Fabric - Settings' });
});

app.listen(PORT, () => {
  console.log(`Data Fabric Management UI (EJS) listening on port ${PORT}`);
});
