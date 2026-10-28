/** Reported as `serverInfo` to MCP clients and by `GET /healthz`. */
export const SERVER_NAME = 'openlinear';
export const SERVER_TITLE = 'OpenLinear';
export const SERVER_VERSION = '2.0.0';

/** Sent as `User-Agent` on every request to the OpenLinear API. */
export const USER_AGENT = `openlinear-mcp/${SERVER_VERSION}`;
