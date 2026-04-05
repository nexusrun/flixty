import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'

const router = Router()

const PLATFORM_RULES = {
  x:         { name: 'X/Twitter',  limit: 280,   tone: 'punchy, conversational, hook in the first line, max 2 hashtags' },
  linkedin:  { name: 'LinkedIn',   limit: 3000,  tone: 'professional, insightful, thought leadership, end with a question' },
  facebook:  { name: 'Facebook',   limit: 63206, tone: 'friendly, storytelling, encourage comments and shares' },
  instagram: { name: 'Instagram',  limit: 2200,  tone: 'visual, aspirational, 5-10 hashtags at the end' },
  tiktok:    { name: 'TikTok',     limit: 150,   tone: 'energetic hook, trendy, very short, 2-3 hashtags' },
  youtube:   { name: 'YouTube',    limit: 5000,  tone: 'engaging, SEO-optimised title on the first line, then a detailed description with timestamps and relevant keywords' },
}

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set in .env')
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
}

async function streamToSSE(res, messages, systemPrompt) {
  const client = getClient()
  const stream = client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages,
  })

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
    }
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

// POST /api/ai/generate  — write a brand-new post from a topic
router.post('/generate', async (req, res) => {
  const { topic, tone, platform, keywords } = req.body
  if (!topic?.trim()) return res.status(400).json({ error: 'topic is required' })

  const p = PLATFORM_RULES[platform] || PLATFORM_RULES.linkedin

  sseHeaders(res)
  try {
    await streamToSSE(res, [{
      role: 'user',
      content: [
        `Write a high-performing ${p.name} post about: ${topic.trim()}`,
        tone     ? `\nDesired tone: ${tone}` : '',
        keywords ? `\nKeywords/phrases to include: ${keywords}` : '',
      ].join('')
    }],
    `You are an expert social media marketer who writes viral, high-engagement posts.
Platform: ${p.name} (max ${p.limit} characters)
Tone guidelines: ${p.tone}
Output ONLY the post text. No labels, no explanations, no quotes around it.`)
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`)
    res.end()
  }
})

// POST /api/ai/improve  — rewrite/enhance existing text
router.post('/improve', async (req, res) => {
  const { text, instruction, platform } = req.body
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' })

  const p = PLATFORM_RULES[platform] || PLATFORM_RULES.linkedin

  sseHeaders(res)
  try {
    await streamToSSE(res, [{
      role: 'user',
      content: `Improve this ${p.name} post${instruction ? ` (focus: ${instruction})` : ''}. Make it more engaging, clearer, and optimised for reach.\n\n---\n${text.trim()}\n---`
    }],
    `You are an expert social media copywriter.
Platform: ${p.name} (max ${p.limit} characters)
Tone guidelines: ${p.tone}
Output ONLY the improved post text. No explanations, no labels.`)
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`)
    res.end()
  }
})

// POST /api/ai/adapt  — rewrite for a specific target platform
router.post('/adapt', async (req, res) => {
  const { text, targetPlatform } = req.body
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' })

  const p = PLATFORM_RULES[targetPlatform]
  if (!p) return res.status(400).json({ error: `Unknown platform: ${targetPlatform}` })

  sseHeaders(res)
  try {
    await streamToSSE(res, [{
      role: 'user',
      content: `Adapt this post for ${p.name} (max ${p.limit} characters). Keep the core message but change format, length, tone and hashtags to suit the platform.\n\n---\n${text.trim()}\n---`
    }],
    `You are an expert multi-platform social media strategist.
Target platform: ${p.name}
Tone guidelines: ${p.tone}
Output ONLY the adapted post text. No explanations, no labels.`)
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`)
    res.end()
  }
})

// POST /api/ai/hashtags  — suggest relevant hashtags (non-streaming, fast)
router.post('/hashtags', async (req, res) => {
  const { text, platform, count = 10 } = req.body
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' })

  const client = getClient()
  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `Suggest ${count} relevant hashtags for this ${platform || 'social media'} post.
Return ONLY a JSON array of hashtag strings (e.g. ["#marketing","#brand"]).
No explanations, no markdown code blocks — just the raw array.

Post:
${text.trim()}`
      }]
    })

    const raw = response.content.find(b => b.type === 'text')?.text ?? '[]'
    const match = raw.match(/\[[\s\S]*\]/)
    const hashtags = match ? JSON.parse(match[0]) : []
    res.json({ hashtags })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
