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

      const totalBytes = parseInt(response.headers['content-length'], 10);
      let downloadedBytes = 0;
      let lastPrintedPercentage = -1;

      console.log(`\x1b[36m==>\x1b[0m Downloading OpenLinear AppImage (~${(totalBytes / 1024 / 1024).toFixed(1)} MB)...`);
      
      // Simple progress tracking
      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (!isNaN(totalBytes)) {
          const percentage = Math.floor((downloadedBytes / totalBytes) * 100);
          // Only print every 10% to avoid spamming the console
          if (percentage % 10 === 0 && percentage !== lastPrintedPercentage) {
            process.stdout.write(`\r\x1b[36m==>\x1b[0m Progress: ${percentage}%`);
            lastPrintedPercentage = percentage;
          }
        }
      });

      const fileStream = fs.createWriteStream(destination);
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        process.stdout.write(`\r\x1b[36m==>\x1b[0m Progress: 100%\n`);
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
    console.log(`\n\x1b[32m✓\x1b[0m OpenLinear AppImage successfully installed to ${targetPath}`);
    console.log(`\x1b[32m✓\x1b[0m You can now run \x1b[1mopenlinear\x1b[0m in your terminal.`);
  } catch (error) {
    console.error(`\n\x1b[31m✗\x1b[0m Failed to download OpenLinear AppImage: ${error.message}`);
  }
}

main();
