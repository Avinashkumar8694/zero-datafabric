/**
 * Secret redaction for connection / channel configs returned over the API.
 * Secret-looking keys (password, secret, token, api key, credentials, ...) are removed and reported as
 * `hasPassword` / `redactedKeys`; URI-like strings keep their shape but lose embedded credentials
 * (`postgres://user:***@host/db`, `?password=***`).
 */

const SECRET_KEY = /^(.*(pass(word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|certificate|sas).*|authorization|auth)$/i;
const URI_LIKE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/** Masks credentials embedded in a URI / connection string; leaves everything else intact. */
export function maskUri(value: string): string {
  if (!URI_LIKE.test(value)) return value;
  let out = value.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]*):([^@\s]*)@/i, (_m, scheme, user) => `${scheme}${user}:***@`);
  out = out.replace(/([?&;](?:password|pwd|pass|secret|token|api[_-]?key|access[_-]?key)=)[^&;\s]*/gi, '$1***');
  return out;
}

export interface Redacted { config: any; hasPassword: boolean; redactedKeys: string[] }

export function redactConfig(cfg: any): Redacted {
  const redactedKeys: string[] = [];
  const walk = (v: any, path: string): any => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEY.test(k) && val !== null && val !== undefined && val !== '') { redactedKeys.push(path ? `${path}.${k}` : k); continue; }
        out[k] = walk(val, path ? `${path}.${k}` : k);
      }
      return out;
    }
    if (typeof v === 'string') return maskUri(v);
    return v;
  };
  const config = walk(cfg && typeof cfg === 'object' ? cfg : {}, '');
  return { config, hasPassword: redactedKeys.length > 0, redactedKeys };
}
