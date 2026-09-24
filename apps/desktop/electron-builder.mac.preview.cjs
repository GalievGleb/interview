const stableConfig = require('./electron-builder.mac.cjs');

// Free test distribution: make the entire bundle's code signature internally
// valid. Gatekeeper still requires the user to approve this unnotarized build.
module.exports = {
  ...stableConfig,
  afterPack: 'build/signMacPreview.cjs',
  directories: {
    ...stableConfig.directories,
    output: 'release-preview',
  },
  mac: {
    ...stableConfig.mac,
    // electron-builder 25 treats "-" as a keychain identity name, so the
    // afterPack hook applies the ad-hoc signature explicitly.
    identity: null,
    hardenedRuntime: true,
    artifactName: 'SkillCue-macOS-${arch}-${version}-preview.${ext}',
    entitlements: 'build/entitlements.mac.preview.plist',
    entitlementsInherit: 'build/entitlements.mac.preview.plist',
    notarize: false,
  },
};
