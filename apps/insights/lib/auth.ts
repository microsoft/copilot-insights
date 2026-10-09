import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AppError } from './errors.ts';
import type { PublicAuthConfig } from './types.ts';

export type Permission = 'admin' | 'publisher' | 'review';

export interface AuthConfig {
  mode: string;
  publicOrigin?: string;
  tenantId?: string;
  audience?: string;
  clientId?: string;
}

interface ProtectedResource {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
}

interface AccessClaims extends JWTPayload {
  tid?: string;
  ver?: string;
  oid?: string;
  azp?: string;
  scp?: unknown;
  idtyp?: unknown;
  roles?: unknown;
}

type Authenticate = (request: IncomingMessage, permission?: Permission) => Promise<{ ownerId: string }>;

export type Authorization =
  | { mode: 'local'; publicOrigin: null; publicConfig: PublicAuthConfig; protectedResource?: undefined; challenge?: undefined; authenticate: Authenticate }
  | { mode: 'production'; publicOrigin: string; publicConfig: PublicAuthConfig; protectedResource: ProtectedResource;
    challenge(permission?: Permission): string; authenticate: Authenticate };

const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const ADMIN_ROLE = 'Insights.Admin';
export const PUBLISHER_ROLE = 'Insights.Publisher';
export const ADMIN_SCOPE = 'Insights.Read';
export const PUBLISHER_SCOPE = 'Context.Publish';

export function authConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode = environment.INSIGHTS_MODE ?? (environment.NODE_ENV === 'production' ? undefined : 'local');
  if (!mode) throw new AppError('auth-configuration', 'Set INSIGHTS_MODE explicitly. Production requires Entra configuration; local mode must only be published on loopback.');
  return {
    mode,
    publicOrigin: environment.INSIGHTS_PUBLIC_ORIGIN,
    tenantId: environment.INSIGHTS_ENTRA_TENANT_ID,
    audience: environment.INSIGHTS_ENTRA_AUDIENCE,
    clientId: environment.INSIGHTS_ENTRA_CLIENT_ID,
  };
}

export function createAuthorization(config: AuthConfig = { mode: 'local' },
  { keyResolver, clock = Date.now }: { keyResolver?: JWTVerifyGetKey; clock?: () => number } = {}): Authorization {
  if (!['local', 'production'].includes(config.mode)) throw new AppError('auth-configuration', 'INSIGHTS_MODE must be local or production.');
  if (config.mode === 'local') return {
    mode: 'local', publicOrigin: null,
    publicConfig: { mode: 'local' },
    authenticate: async () => ({ ownerId: 'local' }),
  };
  const { tenantId, audience, clientId } = config;
  let origin: URL | undefined;
  try { origin = new URL(config.publicOrigin as string); } catch {}
  if (!origin || origin.protocol !== 'https:' || origin.origin !== config.publicOrigin
    || origin.username || origin.password || ![tenantId, audience, clientId].every((value) => typeof value === 'string' && guid.test(value))
    || audience === clientId) {
    throw new AppError('auth-configuration', 'Production requires an HTTPS public origin, a tenant GUID, and separate API audience and browser client GUIDs.');
  }
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const authority = `https://login.microsoftonline.com/${tenantId}`;
  const keys: JWTVerifyGetKey = keyResolver ?? createRemoteJWKSet(new URL(`${authority}/discovery/v2.0/keys`), { timeoutDuration: 5000 });
  const scope = `api://${audience}/${ADMIN_SCOPE}`;
  return {
    mode: 'production', publicOrigin: origin.origin,
    publicConfig: { mode: 'production', authority, clientId: clientId as string, scope, redirectUri: `${origin.origin}/auth/redirect.html` },
    protectedResource: {
      resource: `${origin.origin}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: [scope],
      bearer_methods_supported: ['header'],
      resource_name: 'Copilot Insights admin reports',
    },
    challenge(permission: Permission = 'admin') {
      return permission === 'publisher' ? `Bearer scope="api://${audience}/${PUBLISHER_SCOPE}"`
        : `Bearer resource_metadata="${origin.origin}/.well-known/oauth-protected-resource/mcp", scope="${scope}"`;
    },
    async authenticate(request: IncomingMessage, permission: Permission = 'admin') {
      const match = /^Bearer ([A-Za-z0-9._-]+)$/i.exec(request.headers.authorization ?? '');
      if (!match) throw new AppError('authentication-required', 'Sign in with an access token for this Insights API.', 401);
      let claims: AccessClaims;
      try {
        const verified = await jwtVerify<AccessClaims>(match[1], keys, {
          issuer, audience, algorithms: ['RS256'], currentDate: new Date(clock()), clockTolerance: 5,
          requiredClaims: ['exp', 'iat', 'iss', 'aud', 'tid', 'oid', 'ver'],
        });
        claims = verified.payload;
        if (claims.tid !== tenantId || claims.ver !== '2.0' || !guid.test(claims.oid ?? '')
          || !guid.test(claims.azp ?? '') || claims.iat! > clock() / 1000 + 5
          || (claims.scp !== undefined && typeof claims.scp !== 'string')
          || (typeof claims.scp !== 'string' && claims.idtyp !== 'app')) throw new Error('Not an API access token');
      } catch {
        throw new AppError('invalid-access-token', 'The access token is invalid, expired, or issued for another API or tenant.', 401);
      }
      const requiredRole = permission === 'publisher' ? PUBLISHER_ROLE : ADMIN_ROLE;
      const requiredScope = permission === 'publisher' ? PUBLISHER_SCOPE : ADMIN_SCOPE;
      const requiresDelegated = permission === 'publisher' || permission === 'review';
      if (!Array.isArray(claims.roles) || !claims.roles.includes(requiredRole)
        || (requiresDelegated && (typeof claims.scp !== 'string' || claims.idtyp === 'app'))
        || (typeof claims.scp === 'string' && !claims.scp.split(' ').includes(requiredScope))) {
        throw new AppError('role-required', `This operation requires the ${requiredRole} app role and the corresponding API permission. Azure subscription roles do not grant access.`, 403);
      }
      return { ownerId: `${claims.tid}:${claims.oid}` };
    },
  };
}
