import { Router } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { findAccessToken } from '../lib/mcpOAuth/store.js'
import { appBaseUrl } from '../lib/mcpOAuth/urls.js'
import { registerTools } from '../lib/mcp/tools.js'

const router = Router()

async function requireBearerToken(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  const resourceMetadataUrl = `${appBaseUrl()}/.well-known/oauth-protected-resource`

  if (!token) {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`)
    return res.status(401).json({ error: 'unauthorized', error_description: 'Missing bearer token' })
  }

  const entry = await findAccessToken(token)
  if (!entry) {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`)
    return res.status(401).json({ error: 'invalid_token' })
  }

  req.mcpUserId = entry.userId
  next()
}

function getServer(userId) {
  const server = new McpServer({ name: 'flixty', version: '1.0.0' })
  registerTools(server, userId)
  return server
}

router.post('/mcp', requireBearerToken, async (req, res) => {
  try {
    const server = getServer(req.mcpUserId)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
    res.on('close', () => {
      transport.close()
      server.close()
    })
  } catch (e) {
    console.error('[mcp] request failed:', e.message)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  }
})

router.get('/mcp', requireBearerToken, (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }))
})

router.delete('/mcp', requireBearerToken, (_req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }))
})

export default router
