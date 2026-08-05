// The authorization server and the MCP resource are both served from the
// same origin (mcp.<domain> subdomains aren't available on NexusAI's
// managed .nexusai.run domains — those are reserved), so this is just one
// helper computing BASE_URL, kept as its own module since several files
// need it consistently.

export function appBaseUrl() {
  return (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
}
