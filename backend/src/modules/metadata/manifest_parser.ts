/**
 * Manifest ingestion: parses raw manifest input (plain JSON or Markdown
 * containing a fenced ```json block) into the normalized shape consumed by
 * `MetadataOrchestrator` and `DiffEngine` — a document with a top-level
 * `schemas` array, regardless of how the source manifest was authored.
 */

/**
 * Parses and normalizes a raw metadata manifest document.
 * @class
 * @hideconstructor
 */
export class ManifestParser {
    /**
     * Parses a manifest from either raw JSON text or Markdown containing a
     * fenced ```json code block, then normalizes legacy (v4.0 "flat") shape
     * — a root-level `resources` array with no `schemas` — into the current
     * `schemas: [{ name, resources }]` shape expected downstream.
     * @param content Raw manifest content: a JSON string, or Markdown embedding one ```json block.
     * @returns The parsed manifest object (untyped), normalized to always carry a `schemas` array when it declared root-level `resources`.
     * @throws {Error} If `content` is neither valid JSON nor Markdown containing a valid ```json block.
     */
    static parse(content: string): any {
        let manifest: any;
        try {
            manifest = JSON.parse(content);
        } catch {
            const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch && jsonMatch[1]) {
                try {
                    manifest = JSON.parse(jsonMatch[1]);
                } catch (err: any) {
                    throw new Error(`Failed to parse JSON within Markdown: ${err.message}`);
                }
            } else {
                throw new Error('Manifest format not recognized. Provide valid JSON or Markdown with ```json blocks.');
            }
        }

        // Industrial Normalization (v4.0 Spec)
        // If manifest has root-level resources (even if empty) but no schemas, wrap them.
        if (manifest && manifest.resources !== undefined && !manifest.schemas) {
            manifest.schemas = [
                {
                    name: manifest.namespace || 'public',
                    resources: manifest.resources
                }
            ];
            // We don't necessarily need to delete it, but let's keep it clean
            delete manifest.resources;
        }

        return manifest;
    }
}
