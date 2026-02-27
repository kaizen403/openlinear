#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appImagePath = path.join(os.homedir(), '.openlinear', 'openlinear.AppImage');

if (!fs.existsSync(appImagePath)) {
  console.error('OpenLinear AppImage not found.');
  console.error('Run: npm install -g @kaizen403/openlinear to download it.');
  process.exit(1);
}

const child = spawn(appImagePath, process.argv.slice(2), {
  stdio: 'inherit'
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
