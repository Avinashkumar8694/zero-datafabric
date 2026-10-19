export const TOKEN_SCOPES = ['query:read', 'data:read', 'data:write', 'metadata:read', 'metadata:write', 'triggers:read', 'triggers:write'] as const;
export type TokenScope = typeof TOKEN_SCOPES[number];
