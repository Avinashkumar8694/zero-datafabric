export class ManifestParser {
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
