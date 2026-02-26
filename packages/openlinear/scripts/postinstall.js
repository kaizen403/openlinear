const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const packageJson = require('../package.json');

const platform = process.platform;
const arch = process.arch;

if (platform !== 'linux' || arch !== 'x64') {
  console.log('OpenLinear installer currently supports Linux x64 only.');
  process.exit(0);
}

const baseUrl = process.env.OPENLINEAR_RELEASE_BASE_URL ||
  `https://github.com/kaizen403/openlinear/releases/download/v${packageJson.version}`;
const fileName = `openlinear-${packageJson.version}-x86_64.AppImage`;
const downloadUrl = `${baseUrl}/${fileName}`;

const installDir = path.join(os.homedir(), '.openlinear');
const targetPath = path.join(installDir, 'openlinear.AppImage');

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(destination);
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(resolve);
      });
      fileStream.on('error', (err) => {
        fileStream.close();
        reject(err);
      });
    });

    request.on('error', reject);
  });
}

async function main() {
  try {
    fs.mkdirSync(installDir, { recursive: true });
    await download(downloadUrl, targetPath);
    fs.chmodSync(targetPath, 0o755);
    console.log(`OpenLinear AppImage downloaded to ${targetPath}`);
  } catch (error) {
    console.error(`Failed to download OpenLinear AppImage: ${error.message}`);
  }
}

main();
