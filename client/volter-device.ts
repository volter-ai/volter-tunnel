/**
 * Signing a person in with Volter from a terminal (RFC 8628, the device
 * authorization grant): the CLI asks the issuer for a code, the person confirms
 * it in any browser, and the CLI receives an access token whose audience is the
 * relay it is signing up to. The CLI is a public client of the issuer (no
 * secret); on id.volter.ai it is `volter-tunnel`. Another issuer (a World's
 * twin) names its client through VOLTER_CLIENT_ID.
 */
export const VOLTER_ISSUER = 'https://id.volter.ai';
const CLIENT_IDS: Record<string, string> = { 'https://id.volter.ai': 'ntMGlOZZNdmQhfWVjxGVeisHFXmjjxEW' };
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export async function volterDeviceSignIn(opts: {
  issuer?: string;
  audience: string;
  clientId?: string;
  say?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const issuer = new URL(opts.issuer ?? VOLTER_ISSUER).origin;
  const clientId = opts.clientId ?? CLIENT_IDS[issuer];
  if (!clientId) throw new Error(`volter-tunnel is not registered with the identity service at ${issuer}; set VOLTER_CLIENT_ID`);
  const say = opts.say ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const discovery = (await (await fetch(new URL('/.well-known/openid-configuration', issuer))).json()) as {
    device_authorization_endpoint?: string;
    token_endpoint?: string;
  };
  if (!discovery.device_authorization_endpoint || !discovery.token_endpoint) throw new Error(`${issuer} does not offer the device grant`);
  const form = (fields: Record<string, string>): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
  const started = await fetch(discovery.device_authorization_endpoint, form({ client_id: clientId, scope: 'openid profile email offline_access', resource: opts.audience }));
  const device = (await started.json().catch(() => ({}))) as Record<string, string | number | undefined>;
  if (!started.ok || !device.device_code) throw new Error(`the identity service refused the sign-in: ${device.error_description ?? device.error ?? started.status}`);
  say(`Sign in with Volter: open ${device.verification_uri_complete ?? device.verification_uri}`);
  say(`and confirm the code ${device.user_code}.`);
  let interval = Math.max(1, Number(device.interval ?? 5)) * 1000;
  const deadline = Date.now() + Number(device.expires_in ?? 600) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const polled = await fetch(discovery.token_endpoint, form({ grant_type: GRANT, device_code: String(device.device_code), client_id: clientId }));
    const answer = (await polled.json().catch(() => ({}))) as Record<string, string | undefined>;
    if (polled.ok && answer.access_token) return answer.access_token;
    if (answer.error === 'authorization_pending') continue;
    if (answer.error === 'slow_down') { interval += 5000; continue; }
    throw new Error(`sign-in did not complete: ${answer.error_description ?? answer.error ?? polled.status}`);
  }
  throw new Error('the sign-in code expired before it was confirmed');
}
