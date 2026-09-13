const fs = require('node:fs');
const path = require('node:path');

// Installed-app credentials are public-client metadata, NOT server/API keys.
// Google still requires client_secret for this desktop client; PKCE and verified
// user identity provide authorization. Never load a web/service-account secret.
function loadGoogleOAuthMetadata(env = process.env) {
  const filename = env.SKILLCUE_GOOGLE_OAUTH_CONFIG
    || path.resolve(__dirname, '../../..', '.google_oauth_client.json');
  let installed;
  if (fs.existsSync(filename)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch { throw new Error('Cannot read Desktop OAuth config'); }
    if (!parsed.installed || parsed.web) throw new Error('Desktop OAuth config required; web credentials are not supported');
    installed = parsed.installed;
    if (!installed.client_id || !installed.client_secret) throw new Error('Desktop OAuth config incomplete');
  } else if (env.SKILLCUE_GOOGLE_OAUTH_CONFIG) {
    throw new Error('Desktop OAuth config file not found');
  }
  const clientId = env.SKILLCUE_GOOGLE_OAUTH_CLIENT_ID || installed?.client_id;
  const clientSecret = env.SKILLCUE_GOOGLE_OAUTH_CLIENT_SECRET || installed?.client_secret;
  if (installed && clientId !== installed.client_id) throw new Error('Desktop OAuth client ID does not match local config');
  if (!clientId && !clientSecret) return {};
  if (!clientId || !clientSecret) throw new Error('Desktop OAuth config incomplete: client ID and client secret are required');
  return { googleOAuthClientId: clientId, googleOAuthClientSecret: clientSecret };
}

module.exports = { loadGoogleOAuthMetadata };
