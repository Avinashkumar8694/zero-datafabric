/**
 * Multer wiring for manifest file uploads (`POST /api/metadata/diff|apply`): in-memory,
 * a single `file` part capped at `MANIFEST_MAX_BYTES`, and only JSON / YAML documents.
 * Routes use `manifestUploadSingle` instead of a bare `multer().single('file')`.
 */
import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { MANIFEST_MAX_BYTES } from './manifest_parser';

const ALLOWED_EXT = /\.(json|ya?ml)$/i;
const ALLOWED_MIME = new Set([
    'application/json', 'text/json', 'application/x-json',
    'application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml', 'application/vnd.yaml',
    'text/plain', 'application/octet-stream',
]);

export function isAcceptableManifestFile(filename: string, mimetype: string): boolean {
    return ALLOWED_EXT.test(filename || '') && ALLOWED_MIME.has(String(mimetype || '').toLowerCase().split(';')[0]!.trim());
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MANIFEST_MAX_BYTES, files: 1, fields: 10, parts: 12, fieldSize: 64 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (isAcceptableManifestFile(file.originalname, file.mimetype)) return cb(null, true);
        cb(Object.assign(new Error('Only .json, .yaml or .yml manifest files are accepted'), { code: 'UNSUPPORTED_MANIFEST_FILE' }));
    },
});

/** `upload.single('file')` with multer failures mapped to clean 4xx JSON responses. */
export function manifestUploadSingle(req: Request, res: Response, next: NextFunction) {
    upload.single('file')(req, res, (err: any) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'MANIFEST_TOO_LARGE', message: `Manifest exceeds the ${Math.floor(MANIFEST_MAX_BYTES / 1024 / 1024)} MB limit` });
        if (err.code === 'UNSUPPORTED_MANIFEST_FILE') return res.status(415).json({ error: 'UNSUPPORTED_MANIFEST_FILE', message: err.message });
        if (String(err.code || '').startsWith('LIMIT_')) return res.status(400).json({ error: 'INVALID_UPLOAD', message: err.message });
        return next(err);
    });
}
