// Generate secrets and JWT keys for self-hosted Supabase.
// Usage: node scripts/generate-keys.mjs
// Prints values to paste into supabase/docker/.env
import { createHmac, randomBytes } from 'node:crypto'

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const sign = (payload, secret) => {
  const header = { alg: 'HS256', typ: 'JWT' }
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = createHmac('sha256', secret).update(data).digest()
  return `${data}.${b64url(sig)}`
}

const jwtSecret = randomBytes(32).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const exp = now + 10 * 365 * 24 * 3600 // 10 years

const anonKey = sign({ role: 'anon', iss: 'supabase', iat: now, exp }, jwtSecret)
const serviceRoleKey = sign({ role: 'service_role', iss: 'supabase', iat: now, exp }, jwtSecret)

console.log(`POSTGRES_PASSWORD=${randomBytes(24).toString('base64url')}`)
console.log(`JWT_SECRET=${jwtSecret}`)
console.log(`ANON_KEY=${anonKey}`)
console.log(`SERVICE_ROLE_KEY=${serviceRoleKey}`)
console.log(`DASHBOARD_USERNAME=supabase`)
console.log(`DASHBOARD_PASSWORD=${randomBytes(16).toString('base64url')}`)
console.log(`SECRET_KEY_BASE=${randomBytes(48).toString('base64url')}`)
console.log(`VAULT_ENC_KEY=${randomBytes(16).toString('base64url')}`)
console.log(`PG_META_CRYPTO_KEY=${randomBytes(24).toString('base64url')}`)
console.log(`LOGFLARE_PUBLIC_ACCESS_TOKEN=${randomBytes(24).toString('base64url')}`)
console.log(`LOGFLARE_PRIVATE_ACCESS_TOKEN=${randomBytes(24).toString('base64url')}`)
