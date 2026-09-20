// InkFlow all-in-one 网关：静态前端 + 反向代理（无第三方依赖，Node 原生）。
// 路由:
//   /            -> /srv/web 静态文件（hash 路由，index.html 兜底）
//   /auth/v1/    -> gotrue (127.0.0.1:9999)
//   /rest/v1/    -> PostgREST (127.0.0.1:3000)
//   /storage/v1/ -> storage-api (127.0.0.1:5000)
//   /realtime/v1/ -> realtime (127.0.0.1:4000)，WebSocket upgrade 原样管道转发
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

const WEB_ROOT = process.env.WEB_ROOT || '/srv/web'
const PORT = Number(process.env.GATEWAY_PORT || 8080)
const ROUTES = [
  { prefix: '/auth/v1/', port: 9999 },
  { prefix: '/rest/v1/', port: 3000 },
  { prefix: '/storage/v1/', port: 5000 },
  { prefix: '/realtime/v1/', port: 4000, upstreamPrefix: '/socket', hostRewrite: 'realtime-dev.supabase-realtime' },
]

// 上游服务都裸跑在根路径（gotrue 的 /signup、postgrest 的 /notes、storage 的 /object），
// 网关剥掉 /auth/v1 等前缀再转发（与 supabase 官方网关 Kong 的 strip_path 行为一致）。
// realtime 例外：官方 Kong 映射是 /realtime/v1/* -> /socket/*，upstreamPrefix 就是这个 /socket
function upstreamPath(reqUrl, route) {
  return (route.upstreamPrefix ?? '') + reqUrl.slice(route.prefix.length - 1) || '/'
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8',
}

function findRoute(pathname) {
  return ROUTES.find((r) => pathname.startsWith(r.prefix))
}

function hopByHopCleanup(headers) {
  const h = { ...headers }
  delete h.host
  delete h.connection
  delete h['keep-alive']
  delete h['transfer-encoding']
  delete h['upgrade']
  return h
}

function proxy(req, res, route) {
  const up = http.request(
    { host: '127.0.0.1', port: route.port, path: upstreamPath(req.url, route), method: req.method, headers: hopByHopCleanup(req.headers) },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers)
      ur.pipe(res)
    },
  )
  up.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'upstream unavailable' }))
    } else {
      res.destroy()
    }
  })
  req.pipe(up)
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    return res.end()
  }
  let p = decodeURIComponent(url.pathname)
  if (p.endsWith('/')) p += 'index.html'
  let file = path.join(WEB_ROOT, p)
  try {
    if (!fs.statSync(file).isFile()) file = path.join(WEB_ROOT, 'index.html')
  } catch {
    file = path.join(WEB_ROOT, 'index.html')
  }
  const ext = path.extname(file).toLowerCase()
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' }
  if (url.pathname.startsWith('/assets/')) {
    headers['cache-control'] = 'public, max-age=31536000, immutable'
  } else {
    headers['cache-control'] = 'no-cache'
  }
  const size = fs.statSync(file).size
  headers['content-length'] = size

  // Range 支持（PDF/大文件按段加载的场景）
  const range = req.headers.range
  const m = range && /^bytes=(\d+)-(\d*)$/.exec(range)
  if (m) {
    const start = Number(m[1])
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      return res.end()
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, { ...headers, 'accept-ranges': 'bytes' })
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(file).pipe(res)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://internal')
  const route = findRoute(url.pathname)
  if (route) return proxy(req, res, route)
  return serveStatic(req, res, url)
})

// WebSocket：升级请求按原始字节管道转发到对应上游
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://internal')
  const route = findRoute(url.pathname)
  if (!route) return socket.destroy()
  const up = net.connect(route.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${upstreamPath(req.url, route)} HTTP/1.1`]
    for (const [k, v] of Object.entries(req.headers)) {
      lines.push(route.hostRewrite && k.toLowerCase() === 'host' ? `${k}: ${route.hostRewrite}` : `${k}: ${v}`)
    }
    up.write(lines.join('\r\n') + '\r\n\r\n')
    if (head?.length) up.write(head)
    socket.pipe(up).pipe(socket)
  })
  up.on('error', () => socket.destroy())
  socket.on('error', () => up.destroy())
})

server.listen(PORT, () => console.log(`[gateway] listening on :${PORT}`))
