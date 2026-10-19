import express from 'express';
import path from 'path';
import fs from 'fs';
import { marked } from 'marked';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.UI_PORT || 3006;

const INTEGRATION_DOC_GROUPS = [
    {
        label: 'Getting Started',
        docs: [
            { id: 'README.md', title: 'Developer Getting Started' },
            { id: 'how-to-guide.md', title: 'How-To Developer Guide' },
            { id: 'concepts.md', title: 'Core Concepts' },
            { id: 'api-overview.md', title: 'API Overview' },
            { id: 'rules-and-guidelines.md', title: 'Rules & Design Guidelines' },
        ]
    },
    {
        label: 'Authentication & Tenancy',
        docs: [
            { id: 'authentication-and-tenancy.md', title: 'Authentication & Tenancy' },
        ]
    },
    {
        label: 'Data CRUD Operations',
        docs: [
            { id: 'crud-api.md', title: 'CRUD API Overview' },
            { id: 'crud-create.md', title: 'API: Create (Insert)' },
            { id: 'crud-read.md', title: 'API: Read (Fetch)' },
            { id: 'crud-update.md', title: 'API: Update' },
            { id: 'crud-delete.md', title: 'API: Delete' },
            { id: 'data-crud-api.md', title: 'Data CRUD Operations' },
            { id: 'complex-crud-examples.md', title: 'Complex CRUD Scenarios' },
        ]
    },
    {
        label: 'Query & Analytics',
        docs: [
            { id: 'query-language.md', title: 'AST Query Language' },
            { id: 'analytics-api.md', title: 'Analytics Engine' },
            { id: 'saved-analytics-api.md', title: 'Saved Analytics' },
            { id: 'creating-analytics.md', title: 'Creating Analytics & Widgets' },
            { id: 'polyglot-integration-examples.md', title: 'Polyglot Integration (SQL/Mongo/ES)' },
            { id: 'recursive-and-window-queries.md', title: 'Recursive & Windowing' },
            { id: 'queries-cookbook.md', title: 'Queries Cookbook' },
        ]
    },
    {
        label: 'Governance & Security',
        docs: [
            { id: 'governance-and-security.md', title: 'Data Governance & RLS' },
            { id: 'governance-api.md', title: 'Data Governance API' },
            { id: 'create-policy.md', title: 'Provision: RLS & Masking Policies' },
        ]
    },
    {
        label: 'Events & Streaming',
        docs: [
            { id: 'event-triggers-and-webhooks.md', title: 'Event Triggers & Webhooks' },
            { id: 'triggers-api.md', title: 'Event Triggers API' },
            { id: 'observability-and-streaming.md', title: 'Observability & Streaming' },
            { id: 'observability-api.md', title: 'Observability & Metrics' },
            { id: 'streaming-responses.md', title: 'Streaming Responses' },
        ]
    },
    {
        label: 'Schema & Metadata',
        docs: [
            { id: 'manifests-cookbook.md', title: 'Manifests Cookbook' },
            { id: 'metadata-manifests.md', title: 'Metadata & Manifests' },
            { id: 'schema-specification.md', title: 'Schema Specification' },
            { id: 'type-and-enum-reference.md', title: 'Type & Enum Reference' },
            { id: 'connectors.md', title: 'Data Source Connectors' },
            { id: 'create-view.md', title: 'Provision: Views & MViews' },
            { id: 'create-recursion.md', title: 'Provision: Recursive Views' },
            { id: 'create-sequence.md', title: 'Provision: Sequences' },
            { id: 'create-function-and-sequence-usage.md', title: 'Provision: Functions & Sequences' },
        ]
    },
    {
        label: 'Replication & CDC',
        docs: [
            { id: 'replication.md', title: 'Downstream Replication' },
            { id: 'sync-and-cdc.md', title: 'Sync & CDC Pipelines' },
        ]
    },
];

const DOC_LIST = INTEGRATION_DOC_GROUPS.flatMap(group => group.docs.map(doc => ({ id: doc.id, title: doc.title })));

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

app.get('/settings', (req, res) => {
  res.render('settings', { title: 'Zero Data Fabric - Settings' });
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

app.get('/integration-guide', async (req, res) => {
    const docParam = (req.query.doc as string) || 'how-to-guide.md';

    try {
        res.render('integration_guide', {
            title: 'Zero Data Fabric - Integration Guide',
            currentDoc: docParam,
            currentTitle: 'Loading...',
            docGroups: INTEGRATION_DOC_GROUPS
        });
    } catch (error) {
        console.error('Error loading integration guide:', error);
        res.status(500).send('Error loading integration guide');
    }
});

app.get('/workbench/docs', async (req, res) => {
    const docParam = (req.query.doc as string) || 'how-to-guide.md';
    const activeDoc = DOC_LIST.find(d => d.id === docParam) || DOC_LIST[0]!;

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

app.get('/plans', (req, res) => {
  res.render('plans', { title: 'Zero Data Fabric - Subscription Plans' });
});

app.listen(PORT, () => {
  console.log(`Data Fabric Management UI (EJS) listening on port ${PORT}`);
});
