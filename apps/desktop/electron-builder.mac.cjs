const packageJson = require('./package.json');
const { loadGoogleOAuthMetadata } = require('./build/googleOAuthMetadata.cjs');

const googleOAuthMetadata = loadGoogleOAuthMetadata();
if (!googleOAuthMetadata.googleOAuthClientId || !googleOAuthMetadata.googleOAuthClientSecret) {
  throw new Error('macOS Stable requires Desktop OAuth config (.google_oauth_client.json or SKILLCUE_GOOGLE_OAUTH_CONFIG)');
}

module.exports = {
  ...packageJson.build,
  extraMetadata: {
    ...(packageJson.build.extraMetadata ?? {}),
    accountApiUrl: process.env.SKILLCUE_ACCOUNT_API_URL?.trim() || 'https://skill-cue.ru/account',
    ...googleOAuthMetadata,
  },
};
