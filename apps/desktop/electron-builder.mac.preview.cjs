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
  dmg: {
    ...stableConfig.dmg,
    backgroundColor: '#f2f9f7',
    title: 'Установка SkillCue ${version}',
    iconSize: 80,
    iconTextSize: 13,
    window: { width: 560, height: 360 },
    contents: [
      { x: 145, y: 105, type: 'file' },
      { x: 415, y: 105, type: 'link', path: '/Applications', name: 'Программы' },
      { x: 145, y: 265, type: 'file', path: 'build/mac-install/help.html', name: 'Первый запуск.html' },
      { x: 415, y: 265, type: 'link', path: '/System/Library/PreferencePanes/Security.prefPane', name: 'Настройки безопасности' },
    ],
  },
};
