import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { marked } from 'marked';

const DEVELOPER_DOCS_DIR = path.join(__dirname, '..', '..', '..', 'developer_docs');

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

export function getDeveloperDocsList(_req: Request, res: Response) {
    try {
        res.json({ groups: INTEGRATION_DOC_GROUPS });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
}

export async function getDeveloperDoc(req: Request, res: Response) {
    try {
        const docId = String(req.params.id || '');
        if (!docId) {
            return res.status(400).json({ error: 'Document ID is required' });
        }
        const safeId = path.basename(docId);
        const docPath = path.join(DEVELOPER_DOCS_DIR, safeId);

        if (!fs.existsSync(docPath)) {
            return res.status(404).json({ error: 'Document not found' });
        }

        const markdown = fs.readFileSync(docPath, 'utf8');
        const htmlContent = await marked.parse(markdown);

        const allDocs = INTEGRATION_DOC_GROUPS.flatMap(g => g.docs.map(d => ({ ...d, group: g.label })));
        const doc = allDocs.find(d => d.id === safeId);

        res.json({
            id: safeId,
            title: doc?.title || safeId,
            group: doc?.group || '',
            htmlContent
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
}
