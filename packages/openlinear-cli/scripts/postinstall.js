// npm postinstall: fetch and verify the OpenLinear AppImage on Linux x64.
// A missing or unreachable artifact never fails the install (the user can run
// `openlinear install` later); only a checksum mismatch does.

const { IntegrityError, install, releasesPageUrl } = require('../lib/installer');
const packageJson = require('../package.json');

install({ version: packageJson.version })
  .then((result) => {
    console.log(result.message);
    if (result.status !== 'installed' && result.status !== 'skipped') {
      console.log('Run `openlinear install` once the release is available.');
    }
  })
  .catch((error) => {
    if (error instanceof IntegrityError) {
      console.error(`OpenLinear: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.warn(`OpenLinear: could not download the AppImage (${error.message}).`);
    console.warn(`Run \`openlinear install\` later, or download it from ${releasesPageUrl()}.`);
  });
