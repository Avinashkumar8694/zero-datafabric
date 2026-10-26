/**
 * Manifest ingestion: parses raw manifest input (JSON, YAML, or Markdown
 * containing a fenced ```json block) into the normalized shape consumed by
 * `MetadataOrchestrator` and `DiffEngine` — a document with a top-level
 * `schemas` array, regardless of how the source manifest was authored.
 *
 * Parsing is deliberately defensive because manifests come from uploads:
 *  - size cap (`MANIFEST_MAX_BYTES`, default 5 MB, env `MANIFEST_MAX_UPLOAD_BYTES`);
 *  - YAML is parsed with the JSON (core) schema only: custom/unknown tags are errors,
 *    anchors/aliases (any shared node) are rejected, so nothing can expand or execute;
 *  - `__proto__` / `constructor` / `prototype` keys are refused (also re-checked by the validator);
 *  - validation (identifiers, types, expressions, unknown keys, tenant confinement)
 *    lives in `manifest_validator.ts` and is run by the orchestrator on every path.
 */

/** Hard ceiling for an uploaded / posted manifest document. */
export const MANIFEST_MAX_BYTES: number = (() => {
    const n = Number(process.env.MANIFEST_MAX_UPLOAD_BYTES);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5 * 1024 * 1024;
})();

export class ManifestInputError extends Error {
    constructor(public code: string, message: string, public status = 400) {
        super(message);
    }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Rejects shared nodes (YAML anchors/aliases) and prototype-pollution keys; bounded depth/size. */
function assertPlainTree(root: any) {
    const seen = new WeakSet<object>();
    let nodes = 0;
    const walk = (n: any, depth: number) => {
        if (n === null || typeof n !== 'object') return;
        if (depth > 40) throw new ManifestInputError('MANIFEST_TOO_DEEP', 'Manifest is nested too deeply');
        if (++nodes > 500_000) throw new ManifestInputError('MANIFEST_TOO_LARGE', 'Manifest has too many nodes', 413);
        if (seen.has(n)) throw new ManifestInputError('YAML_ALIASES_NOT_ALLOWED', 'YAML anchors/aliases are not supported in manifests');
        seen.add(n);
        if (Array.isArray(n)) { for (const v of n) walk(v, depth + 1); return; }
        const proto = Object.getPrototypeOf(n);
        if (proto !== Object.prototype && proto !== null) throw new ManifestInputError('INVALID_MANIFEST', 'Manifest contains non-plain objects');
        for (const k of Object.getOwnPropertyNames(n)) {
            if (FORBIDDEN_KEYS.has(k)) throw new ManifestInputError('FORBIDDEN_KEY', `Manifest key "${k}" is not allowed`);
            walk((n as any)[k], depth + 1);
        }
    };
    walk(root, 0);
}

function parseYaml(text: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require('js-yaml');
    // JSON_SCHEMA: null/bool/int/float/str/seq/map only — no !!js/*, !!binary, !!timestamp, merge keys.
    return yaml.load(text, { schema: yaml.JSON_SCHEMA, json: false });
}

/**
 * Parses and normalizes a raw metadata manifest document.
 * @class
 * @hideconstructor
 */
export class ManifestParser {
    /**
     * Parses a manifest from raw JSON/YAML text, or Markdown embedding one ```json
     * block, then normalizes legacy (v4.0 "flat") shape — a root-level `resources`
     * array with no `schemas` — into the current `schemas: [( name, resources )]`
     * shape expected downstream.
     * @param content Raw manifest content (string or uploaded Buffer).
     * @returns The parsed manifest object (untyped), normalized to always carry a `schemas` array when it declared root-level `resources`.
     * @throws {ManifestInputError} If the input is too large, is neither JSON/YAML nor Markdown with a ```json block, or contains aliases / unsafe keys.
     */
    static parse(content: string | Buffer): any {
        const raw = Buffer.isBuffer(content) ? content.toString('utf8') : content;
        if (typeof raw !== 'string') throw new ManifestInputError('INVALID_MANIFEST', 'Manifest content must be text');
        if (Buffer.byteLength(raw, 'utf8') > MANIFEST_MAX_BYTES) {
            throw new ManifestInputError('MANIFEST_TOO_LARGE', `Manifest exceeds the ${Math.floor(MANIFEST_MAX_BYTES / 1024 / 1024)} MB limit`, 413);
        }
        if (raw.includes('\0')) throw new ManifestInputError('INVALID_MANIFEST', 'Manifest contains NUL bytes');
        const text = raw.replace(/^﻿/, '');

        let manifest: any;
        const trimmed = text.trim();
        const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
        try {
            manifest = JSON.parse(text);
        } catch (jsonErr: any) {
            const fenced = text.match(/```json\r?\n([\s\S]*?)\r?\n```/);
            if (fenced && fenced[1]) {
                try {
                    manifest = JSON.parse(fenced[1]);
                } catch (err: any) {
                    throw new ManifestInputError('INVALID_MANIFEST', `Failed to parse JSON within Markdown: ${err.message}`);
                }
            } else if (!looksJson) {
                try {
                    manifest = parseYaml(text);
                } catch (err: any) {
                    throw new ManifestInputError('INVALID_MANIFEST', `Manifest format not recognized. Provide valid JSON or YAML (${String(err.message).split('\n')[0]}).`);
                }
            } else {
                throw new ManifestInputError('INVALID_MANIFEST', `Manifest is not valid JSON: ${jsonErr.message}`);
            }
        }
        if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
            throw new ManifestInputError('INVALID_MANIFEST', 'Manifest must be a JSON/YAML object');
        }
        assertPlainTree(manifest);
        return this.normalize(manifest);
    }

    /** Legacy-shape normalization. Tolerates malformed input (the validator reports the problems). */
    static normalize(manifest: any): any {
        // Industrial Normalization (v4.0 Spec)
        // If manifest has root-level resources (even if empty) but no schemas, wrap them.
        if (manifest && manifest.resources !== undefined && !manifest.schemas) {
            manifest.schemas = [
                {
                    name: manifest.namespace || 'default',
                    resources: manifest.resources
                }
            ];
            delete manifest.resources;
        }

        // Dynamic Heterogeneous Engine Routing Override (e.g. Activity_Mongo)
        const overrideSource = process.env.FABRIC_TARGET_SOURCE_OVERRIDE;
        if (overrideSource && manifest && typeof manifest === 'object') {
            manifest.targetSource = overrideSource;
            if (Array.isArray(manifest.schemas)) {
                for (const schema of manifest.schemas) {
                    if (schema && typeof schema === 'object') {
                        schema.targetSource = overrideSource;
                    }
                }
            }
        }

        // Normalize legacy tables/views/functions under schema level
        if (manifest && Array.isArray(manifest.schemas)) {
            for (const schema of manifest.schemas) {
                if (!schema || typeof schema !== 'object') continue;
                if (!schema.resources) {
                    schema.resources = [];
                    const fold = (key: string, type: string) => {
                        if (Array.isArray(schema[key])) {
                            for (const item of schema[key]) {
                                if (item && typeof item === 'object') schema.resources.push({ ...item, type });
                            }
                        }
                    };
                    fold('enums', 'ENUM');
                    fold('sequences', 'SEQUENCE');
                    fold('functions', 'FUNCTION');
                    fold('procedures', 'PROCEDURE');
                    fold('tables', 'TABLE');
                    fold('views', 'VIEW');
                }
            }
        }

        return manifest;
    }
}
