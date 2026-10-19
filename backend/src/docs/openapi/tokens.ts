/** Developer API token management (`/api/developer/tokens`). JWT session only. */
import { OpDef, ex, jsonBody, pp, ref, refArray } from './shared';

const TAG = 'Developer Tokens';

const tokenExample = {
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  name: 'etl-pipeline',
  prefix: 'a1b2c3d4',
  scopes: ['query:read', 'data:read', 'data:write'],
  expiresAt: '2027-01-17T09:30:00.000Z',
  createdAt: '2026-10-19T09:30:00.000Z',
  token: 'dft_a1b2c3d4_9f8e7d6c5b4a39281706f5e4d3c2b1a0',
};

export const tokenOps: OpDef[] = [
  {
    method: 'post',
    path: '/api/developer/tokens',
    tag: TAG,
    summary: 'Mint a developer API token',
    description:
      'Creates a tenant-scoped API token (default lifetime 90 days, max 25 active tokens per user) for machine-to-machine access. The token is bound to the caller\'s tenant and carries the requested scopes. ' +
      '**The full `token` value (`dft_<prefix>_<secret>`) is returned only in this response** - only its SHA-256 hash is stored. Use it as `x-api-key: dft_...` or `Authorization: Bearer dft_...`.\n\n' +
      'Available scopes: `query:read`, `data:read`, `data:write`, `metadata:read`, `metadata:write`, `triggers:read`, `triggers:write` (see `GET /api/developer/tokens/scopes`). `admin:*` scopes are never grantable.',
    auth: 'session',
    tenantHeader: false,
    body: jsonBody(ref('CreateDeveloperTokenRequest'), {
      readOnlyAnalytics: ex('Read-only analytics token (30 days)', { name: 'bi-dashboard', scopes: ['query:read'], expiresInDays: 30 }),
      etl: ex('ETL pipeline (90 days)', { name: 'etl-pipeline', scopes: ['query:read', 'data:read', 'data:write'], expiresInDays: 90 }),
      ci: ex('CI manifest deploys', { name: 'ci-manifests', scopes: ['metadata:read', 'metadata:write'], expiresInDays: 365 }),
    }),
    responses: {
      '201': { description: 'Token created. `token` is shown once.', schema: ref('CreatedDeveloperToken'), example: tokenExample },
    },
    errors: {
      '400': { description: 'Invalid name, empty/unknown scopes, expiresInDays outside 1-365, or no tenant selected on the session.', codes: ['INVALID_TOKEN', 'INVALID_SCOPE', 'TENANT_REQUIRED'], message: 'scopes must be a non-empty subset of: query:read, data:read, data:write, metadata:read, metadata:write, triggers:read, triggers:write' },
      '403': { description: 'Called with a developer API token instead of a user session.', code: 'TOKEN_FROM_TOKEN', message: 'API tokens cannot create other tokens; sign in with a user session' },
      '409': { description: 'Maximum of 25 active tokens per user reached.', code: 'TOKEN_LIMIT', message: 'at most 25 active tokens per user' },
    },
  },
  {
    method: 'get',
    path: '/api/developer/tokens',
    tag: TAG,
    summary: 'List developer API tokens',
    description: 'Lists the caller\'s tokens (including revoked and expired ones) with usage metadata. The secret is never returned.',
    auth: 'session',
    tenantHeader: false,
    responses: {
      '200': {
        description: 'Token metadata.',
        schema: refArray('DeveloperToken'),
        example: [
          { id: tokenExample.id, name: 'etl-pipeline', prefix: 'a1b2c3d4', scopes: tokenExample.scopes, expiresAt: tokenExample.expiresAt, lastUsedAt: '2026-10-19T08:12:44.000Z', revokedAt: null, createdAt: '2026-10-19T06:30:00.000Z' },
        ],
      },
    },
  },
  {
    method: 'get',
    path: '/api/developer/tokens/scopes',
    tag: TAG,
    summary: 'List grantable scopes',
    description: 'Returns the scopes that can be requested when minting a token.',
    auth: 'session',
    tenantHeader: false,
    responses: {
      '200': {
        description: 'Grantable scopes.',
        schema: ref('DeveloperScopes'),
        example: { scopes: ['query:read', 'data:read', 'data:write', 'metadata:read', 'metadata:write', 'triggers:read', 'triggers:write'] },
      },
    },
  },
  {
    method: 'delete',
    path: '/api/developer/tokens/{id}',
    tag: TAG,
    summary: 'Revoke a developer API token',
    description: 'Revokes the token immediately; subsequent calls with it return `401 TOKEN_REVOKED`. The record stays in the listing with `revokedAt` set. Revoking an already revoked token is idempotent. Returns 204 with no body.',
    auth: 'session',
    tenantHeader: false,
    params: [pp('id', 'Token id (uuid) from the listing.', tokenExample.id)],
    responses: {
      '204': { description: 'Token revoked. No body.' },
    },
    errors: { '404': { description: 'Unknown token id (or not owned by the caller).', code: 'TOKEN_NOT_FOUND', message: 'token not found' } },
  },
];

export const tokenTags = [
  {
    name: TAG,
    description:
      'Mint, list and revoke tenant-scoped API tokens (`dft_<prefix>_<secret>`). All three calls require a **JWT session**; a developer token cannot manage tokens. Scopes: `query:read data:read data:write metadata:read metadata:write triggers:read triggers:write`.',
  },
];
