import { OAuth2Client } from 'google-auth-library';
import { Config, config as defaultConfig } from '../config';

// Google OAuth 2.0 authorization-code flow. The ID token returned by the exchange
// is verified server-side (signature, audience, issuer, expiry) before we trust
// anything in it — never decoded-and-trusted.

export interface GoogleIdentity {
  googleSub: string; // Google's stable user id
  email: string;
  name: string;
}

export function oauthClient(config: Config = defaultConfig): OAuth2Client {
  return new OAuth2Client({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.oauthRedirectUrl,
  });
}

export function buildAuthUrl(state: string, config: Config = defaultConfig): string {
  return oauthClient(config).generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
  });
}

export async function exchangeCodeForIdentity(
  code: string,
  config: Config = defaultConfig,
): Promise<GoogleIdentity> {
  const client = oauthClient(config);
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error('Google did not return an id_token');

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.googleClientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub) throw new Error('Google id_token has no subject');

  return {
    googleSub: payload.sub,
    email: payload.email ?? '',
    name: payload.name ?? payload.email ?? '',
  };
}
