/**
 * electron-builder configuration
 * Docs: https://www.electron.build/configuration/configuration
 */
module.exports = {
  appId: 'com.yourcompany.weighbridge',
  productName: 'Weighbridge Manager',
  copyright: `Copyright © ${new Date().getFullYear()} Your Company`,

  directories: {
    output: 'release',
    buildResources: 'build',
  },

  files: [
    'electron/**/*',
    'backend/**/*',
    'dist/renderer/**/*',
    'package.json',
    '!**/*.{md,map}',
    '!**/node_modules/*/{CHANGELOG.md,README.md,README,readme.md,readme}',
    '!**/node_modules/*/{test,__tests__,tests,powered-test,example,examples}',
  ],

  extraResources: [
    { from: 'database', to: 'database', filter: ['**/*'] },
    { from: 'uploads', to: 'uploads', filter: ['**/*'] },
  ],

  asarUnpack: ['**/better-sqlite3/**/*'],

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: '${productName}-Setup-${version}.${ext}',
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Weighbridge Manager',
    perMachine: false,
    deleteAppDataOnUninstall: false,
  },

  mac: {
    target: ['dmg'],
    category: 'public.app-category.business',
  },

  linux: {
    target: ['AppImage', 'deb'],
    category: 'Office',
  },

  publish: null,
};
