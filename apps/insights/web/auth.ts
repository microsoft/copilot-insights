import type * as Msal from '@azure/msal-browser';
import type { PublicAuthConfig } from '../lib/types.ts';

declare global {
  var msal: typeof Msal;
}

type ProductionConfig = Extract<PublicAuthConfig, { mode: 'production' }>;

let config: PublicAuthConfig | undefined;
let client: Msal.PublicClientApplication | undefined;

function requireSignIn(message: string) {
  document.getElementById('main')!.hidden = true;
  document.getElementById('auth-panel')!.hidden = false;
  document.getElementById('auth-message')!.textContent = message;
  (document.getElementById('review-dialog') as HTMLDialogElement).close();
}

async function token() {
  if (config?.mode === 'local') return null;
  const account = client?.getActiveAccount();
  if (!account) throw new Error('Sign in with an assigned Insights admin account.');
  try {
    return (await client!.acquireTokenSilent({ account, scopes: [(config as ProductionConfig).scope] })).accessToken;
  } catch {
    requireSignIn('Your sign-in needs attention. Sign in again; no cached reports are displayed.');
    throw new Error('Sign in again to read reports.');
  }
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const accessToken = await token();
  const headers = new Headers(options.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(path, { ...options, headers, redirect: 'error' });
  if (config?.mode === 'production' && [401, 403].includes(response.status)) {
    const body = await response.clone().json().catch(() => ({}));
    if (response.status === 401 || body.error?.code === 'role-required') {
      requireSignIn(response.status === 403 ? 'Access denied. An administrator must assign the Insights.Admin app role. Azure subscription RBAC does not grant access.'
        : 'Sign in with an access token for this Insights API.');
    }
  }
  return response;
}

export async function initializeAuth(): Promise<{ mode: PublicAuthConfig['mode']; ready: boolean }> {
  const response = await fetch('/api/auth-config', { redirect: 'error' });
  if (!response.ok) throw new Error('The authentication configuration is unavailable.');
  config = await response.json() as PublicAuthConfig;
  if (config.mode === 'local') {
    document.getElementById('main')!.hidden = false;
    document.getElementById('auth-panel')!.hidden = true;
    return { mode: 'local', ready: true };
  }
  if (config.mode !== 'production') throw new Error('Unsupported authentication mode.');
  document.getElementById('environment-label')!.textContent = 'Entra-protected';
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/msal-browser.min.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('The sign-in library could not load.'));
    document.head.append(script);
  });
  client = new globalThis.msal.PublicClientApplication({
    auth: { clientId: config.clientId, authority: config.authority, redirectUri: config.redirectUri, postLogoutRedirectUri: location.origin },
    cache: { cacheLocation: 'sessionStorage' },
    system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback() {} } },
  });
  await client.initialize();
  const redirect = await client.handleRedirectPromise();
  if (redirect?.account) client.setActiveAccount(redirect.account);
  document.getElementById('sign-in-button')!.hidden = false;
  document.getElementById('sign-in-button')!.addEventListener('click', () => {
    void client!.loginRedirect({ scopes: [(config as ProductionConfig).scope], prompt: 'select_account', redirectStartPage: location.href }).catch(() => requireSignIn('Sign-in could not start. Check the registered redirect URI and tenant configuration.'));
  });
  document.getElementById('sign-out-button')!.addEventListener('click', () => {
    requireSignIn('Signing out…');
    void client!.logoutRedirect().catch(() => requireSignIn('Sign-out could not finish. Close this browser tab.'));
  });
  if (!client.getActiveAccount()) {
    requireSignIn('Sign in with an assigned Insights admin account to view reports and review evidence.');
    return { mode: 'production', ready: false };
  }
  const check = await apiFetch('/api/organizations');
  if (!check.ok) return { mode: 'production', ready: false };
  document.getElementById('sign-out-button')!.hidden = false;
  document.getElementById('main')!.hidden = false;
  document.getElementById('auth-panel')!.hidden = true;
  return { mode: 'production', ready: true };
}
