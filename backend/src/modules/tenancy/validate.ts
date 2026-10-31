/**
 * Tiny strict validator for settings objects: unknown keys are rejected, every field is
 * type- and range-checked. Used by the system and workspace settings services.
 */
export class SettingsError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export type FieldSpec =
  | { type: 'boolean' }
  | { type: 'int'; min: number; max: number }
  | { type: 'string'; maxLen: number; pattern?: RegExp; nullable?: boolean; enum?: readonly string[] }
  | { type: 'stringList'; maxItems: number; maxLen: number; item?: (v: string) => boolean; allowed?: readonly string[] };

export type SectionSpec = Record<string, FieldSpec>;

const bad = (field: string, msg: string): never => { throw new SettingsError(400, 'INVALID_SETTINGS', `${field}: ${msg}`); };

/** Validates a (partial) section body and returns a clean copy containing only known, valid keys. */
export function validateSection(spec: SectionSpec, body: unknown, section: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SettingsError(400, 'INVALID_SETTINGS', `${section}: body must be an object`);
  const out: Record<string, unknown> = {};
  const unknown = Object.keys(body as object).filter(k => !Object.prototype.hasOwnProperty.call(spec, k));
  if (unknown.length) throw new SettingsError(400, 'UNKNOWN_SETTINGS', `${section}: unknown setting(s): ${unknown.join(', ')}`);
  for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
    const f = spec[key]!; const name = `${section}.${key}`;
    switch (f.type) {
      case 'boolean':
        if (typeof raw !== 'boolean') bad(name, 'must be a boolean');
        out[key] = raw; break;
      case 'int':
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < f.min || raw > f.max) bad(name, `must be an integer between ${f.min} and ${f.max}`);
        out[key] = raw; break;
      case 'string':
        if (raw === null && f.nullable) { out[key] = null; break; }
        if (typeof raw !== 'string' || raw.length > f.maxLen || raw.includes('\0')) bad(name, `must be a string up to ${f.maxLen} characters`);
        if (f.pattern && !f.pattern.test(raw as string)) bad(name, 'has an invalid format');
        if (f.enum && !f.enum.includes(raw as string)) bad(name, `must be one of: ${f.enum.join(', ')}`);
        out[key] = (raw as string).trim(); break;
      case 'stringList': {
        if (!Array.isArray(raw) || raw.length > f.maxItems) bad(name, `must be a list of at most ${f.maxItems} strings`);
        const list = raw as unknown[];
        for (const v of list) {
          if (typeof v !== 'string' || !v || v.length > f.maxLen || v.includes('\0')) bad(name, `entries must be non-empty strings up to ${f.maxLen} characters`);
          if (f.item && !f.item(v as string)) bad(name, `invalid entry "${String(v).slice(0, 40)}"`);
          if (f.allowed && !f.allowed.includes(v as string)) bad(name, `entry "${String(v).slice(0, 40)}" is not allowed`);
        }
        out[key] = [...new Set(list as string[])]; break;
      }
    }
  }
  return out;
}
