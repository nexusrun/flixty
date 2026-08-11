import axios from 'axios'

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET
const REDIRECT_URI = `${process.env.BASE_URL}/auth/linkedin/callback`
const BASE_SCOPES = ['w_member_social', 'openid', 'profile', 'email']
// LinkedIn rejects the entire OAuth request when organization scopes have not
// been approved for the app. Keep them opt-in until the LinkedIn organization
// posting product is enabled in the developer console.
const SCOPES = process.env.LINKEDIN_ENABLE_ORGANIZATIONS === 'true'
  ? [...BASE_SCOPES, 'w_organization_social', 'r_organization_social']
  : BASE_SCOPES

export function getAuthUrl(state) {
  const p = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI, scope: SCOPES.join(' '), state
  })
  return `https://www.linkedin.com/oauth/v2/authorization?${p}`
}

export async function exchangeCode(code) {
  const { data } = await axios.post(
    'https://www.linkedin.com/oauth/v2/accessToken',
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )
  return data
}

export async function getProfile(accessToken) {
  const { data } = await axios.get('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  return data
}

// Requires LinkedIn's organization posting products/scopes. An empty result
// is valid: many accounts only have permission to post to their own profile.
export async function getOrganizations(accessToken) {
  try {
    const { data } = await axios.get('https://api.linkedin.com/v2/organizationalEntityAcls', {
      params: {
        q: 'roleAssignee',
        role: 'ADMINISTRATOR',
        projection: '(elements*(organizationalTarget~(id,localizedName)))',
      },
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    return (data.elements || []).map(item => {
      const org = item['organizationalTarget~'] || {}
      return { id: String(org.id || item.organizationalTarget || ''), name: org.localizedName || 'LinkedIn organization', type: 'organization' }
    }).filter(item => item.id)
  } catch (e) {
    console.warn('[linkedin] organization list unavailable:', e.response?.data?.message || e.message)
    return []
  }
}

export async function postUpdate(accessToken, account, text) {
  const isOrganization = account?.type === 'organization'
  const id = typeof account === 'string' ? account : account?.id
  const { data } = await axios.post(
    'https://api.linkedin.com/v2/ugcPosts',
    {
      author: `urn:li:${isOrganization ? 'organization' : 'person'}:${id}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text },
          shareMediaCategory: 'NONE'
        }
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0'
      }
    }
  )
  return data
}
