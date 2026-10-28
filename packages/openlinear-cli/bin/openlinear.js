#!/usr/bin/env node

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IntegrityError, install, releasesPageUrl } = require('../lib/installer');
const packageJson = require('../package.json');

const appImagePath = path.join(os.homedir(), '.openlinear', 'openlinear.AppImage');
const args = process.argv.slice(2);

const ops = require('../lib/ops');

if (ops.isOpsCommand(args[0], args[1])) {
  // W20 operations commands (issues, runs, export, insights, knowledge),
  // also with a leading --json (`openlinear --json whoami`).
  ops.main(args).then((code) => {
    process.exitCode = code;
  });
} else if (args[0] === 'install') {
  // Explicit install: also works from a source checkout.
  install({ version: packageJson.version, ignoreWorkspace: true })
    .then((result) => {
      console.log(result.message);
      process.exitCode = result.status === 'installed' ? 0 : 1;
    })
    .catch((error) => {
      console.error(`OpenLinear: ${error.message}`);
      process.exitCode = error instanceof IntegrityError ? 2 : 1;
    });
} else if (!fs.existsSync(appImagePath)) {
  console.error('OpenLinear is not installed for this user.');
  if (process.platform === 'linux' && process.arch === 'x64') {
    console.error('Run `openlinear install` to download and verify the AppImage.');
  } else {
    console.error(`Download the desktop app for ${process.platform}/${process.arch} from ${releasesPageUrl()}.`);
  }
  process.exitCode = 1;
} else {
  const child = spawn(appImagePath, args, { stdio: 'inherit' });
  child.on('error', (error) => {
    console.error(`OpenLinear: failed to start ${appImagePath}: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 0;
  });
}
