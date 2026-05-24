
## 2026-02-06 - pkg Binary Build Issue

### Problem
The `@yao-pkg/pkg` tool cannot properly bundle the Express API because:
1. The API uses ES modules (`"type": "module"`)
2. pkg has limited ESM support
3. Entry point `/snapshot/.../dist/index.js` not found in bundled binary

### Attempted Fixes
- Updated pkg config to include `scripts: ["dist/**/*.js"]`
- Added assets for Prisma client
- Tried node18 target (instead of node20)

### Root Cause
pkg doesn't fully support ES modules. The API would need to be refactored to CommonJS or bundled with a tool like esbuild first.

### Workaround Options
1. **Bundle with esbuild first** - Compile ESM to CJS before pkg
2. **Use Node.js directly** - Ship Node.js runtime + API code instead of single binary
3. **Docker sidecar** - Use Docker container for API instead of pkg binary

### Impact
- Desktop app binary builds successfully ✅
- Sidecar binaries compile but don't run ❌
- App launches but API sidecar fails to start

### Status: BLOCKED
Requires architectural decision on sidecar strategy.
