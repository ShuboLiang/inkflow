// 由 JWT_SECRET 派生 anon / service_role 密钥（与 supabase 自托管 key 同格式），
// 前端匿名密钥在容器启动时注入静态产物，无需打包期知道密钥。
import crypto from 'node:crypto'

const secret = process.env.JWT_SECRET
if (!secret) {
  console.error('JWT_SECRET missing')
  process.exit(1)
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (payload) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' })
  const p = b64(payload)
  return h + '.' + p + '.' + crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url')
}
const now = Math.floor(Date.now() / 1000)
const exp = now + 10 * 365 * 86400
console.log(
  sign({ role: 'anon', iss: 'supabase', iat: now, exp }) +
    ' ' +
    sign({ role: 'service_role', iss: 'supabase', iat: now, exp }),
)
