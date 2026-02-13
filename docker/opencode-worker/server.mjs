import { createOpencodeServer } from '@opencode-ai/sdk';

const port = parseInt(process.env.OPENCODE_PORT || '4096');
const server = await createOpencodeServer({ hostname: '0.0.0.0', port });
console.log(`OpenCode server running at ${server.url}`);

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });

setInterval(() => {}, 60000);
