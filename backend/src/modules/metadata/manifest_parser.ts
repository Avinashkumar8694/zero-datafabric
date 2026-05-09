export class ManifestParser {
    static parse(content: string): any {
        try {
            // 1. Try direct JSON parse
            return JSON.parse(content);
        } catch {
            // 2. Try extracting from Markdown code blocks
            const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch && jsonMatch[1]) {
                try {
                    return JSON.parse(jsonMatch[1]);
                } catch (err: any) {
                    throw new Error(`Failed to parse JSON within Markdown: ${err.message}`);
                }
            }
            throw new Error('Manifest format not recognized. Provide valid JSON or Markdown with ```json blocks.');
        }
    }
}
