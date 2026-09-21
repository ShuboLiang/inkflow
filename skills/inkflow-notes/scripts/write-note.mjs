#!/usr/bin/env node
// InkFlow 笔记写入脚本：Markdown → TipTap JSON → Supabase PostgREST。
// 用法：
//   node write-note.mjs --title "标题" 笔记.md [--folder 文件夹[/子文件夹]] [--tags 标签1,标签2] [--id <uuid>]
//   cat 笔记.md | node write-note.mjs --title "标题" --stdin
//
// 认证（二选一）：
//   1) INKFLOW_EMAIL + INKFLOW_PASSWORD   （邮箱密码登录）
//   2) INKFLOW_TOKEN + INKFLOW_USER_ID    （预签发的 access token，供自动化/测试）
// 其它环境变量：INKFLOW_URL（默认 https://kod.liangshubo.top，即部署好的线上服务）、INKFLOW_ANON_KEY（已内置默认值）

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, extname, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

// 网络等失败时打一行干净错误而非整段堆栈（顶层 await 的异常走 uncaughtException）
const cleanExit = (err) => {
  console.error('执行失败:', err instanceof Error ? err.message : err)
  process.exit(1)
}
process.on('unhandledRejection', cleanExit)
process.on('uncaughtException', cleanExit)

const SUPABASE_URL = (process.env.INKFLOW_URL || 'https://kod.liangshubo.top').replace(/\/$/, '')
// anon key 是公开密钥（浏览器包里也带着），非秘密
const ANON_KEY = process.env.INKFLOW_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg5NzQ3MzQ5LCJleHAiOjIxMDUxMDczNDl9.4JLhxMCKeW--vLgZLnb8LGUx4B51PTt56TPgEGF_ZX4'

// ---------- 参数解析 ----------
const args = process.argv.slice(2)
function opt(name) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const title = opt('title') || ''
const VALUE_FLAGS = new Set(['--title', '--folder', '--tags', '--id'])
const fileArg = args.find((a, i) => !a.startsWith('--') && (i === 0 || !VALUE_FLAGS.has(args[i - 1])))
const useStdin = args.includes('--stdin')
const dryRun = args.includes('--dry-run')
const loginOnly = args.includes('--login')
const findQuery = opt('find')
const folderPath = opt('folder') // 支持 a/b 多级；undefined = 更新时保留原文件夹
const tagsArg = opt('tags') // undefined = 更新时保留原标签；'' = 显式清空
const tags = (tagsArg || '').split(',').map((s) => s.trim()).filter(Boolean)
const noteId = opt('id') // 提供则更新已有笔记

if (loginOnly || findQuery !== undefined) {
  // --login / --find：不走写笔记主流程
} else if ((!fileArg && !useStdin) || (!title && !useStdin)) {
  console.error('用法: node write-note.mjs --title "标题" 笔记.md [--folder a/b] [--tags x,y] [--id uuid] [--dry-run]')
  console.error('   或: cat 笔记.md | node write-note.mjs --title "标题" --stdin [--folder a/b]')
  console.error('搜索笔记: node write-note.mjs --find "关键词"   （拿 id 用于 --id 更新）')
  console.error('首次配置认证: INKFLOW_EMAIL=x INKFLOW_PASSWORD=y node write-note.mjs --login')
  process.exit(1)
}

const mdText = loginOnly || findQuery !== undefined ? '' : useStdin || !fileArg ? readFileSync(0, 'utf8') : readFileSync(fileArg, 'utf8')
const mdDir = fileArg ? dirname(resolve(fileArg)) : process.cwd()



// 仅验证转换结果、不写库（调试/CI 用）：打印 TipTap JSON 后退出
if (dryRun) {
  console.log(JSON.stringify(await mdToDocDry(mdText)))
  process.exit(0)
}

// ---------- 认证 ----------
// token 缓存在 ~/.inkflow/auth.json（按服务地址分键）：首次邮箱密码登录后持久化，
// access_token 过期自动用 refresh_token 续期，此后不再需要提供密码。
// INKFLOW_TOKEN 显式提供时优先使用且不读写缓存（自动化/测试场景）。
const AUTH_DIR = resolve(homedir(), '.inkflow')
const AUTH_FILE = resolve(AUTH_DIR, 'auth.json')

function readAuthCache() {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveAuthCache(entry) {
  const all = readAuthCache()
  all[SUPABASE_URL] = entry
  try {
    mkdirSync(AUTH_DIR, { recursive: true })
    writeFileSync(AUTH_FILE, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
  } catch (err) {
    console.error('警告: token 缓存写入失败（本次仍正常运行）:', err.message)
  }
}

async function passwordLogin(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    console.error('登录失败:', res.status, await res.text())
    process.exit(1)
  }
  return res.json()
}

function cacheableAuth(data) {
  return {
    user_id: data.user?.id,
    email: data.user?.email,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // expires_in 是秒数；提前 60s 视为过期，避免边界上拿到将失效的 token
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600) - 60,
  }
}

let token = process.env.INKFLOW_TOKEN
let userId = process.env.INKFLOW_USER_ID
let authFrom = ''

if (!token) {
  const cached = readAuthCache()[SUPABASE_URL]
  const now = Math.floor(Date.now() / 1000)
  if (cached?.access_token && cached.expires_at > now) {
    token = cached.access_token
    userId = cached.user_id
    authFrom = `token 缓存 (${AUTH_FILE})`
  } else if (cached?.refresh_token) {
    // 过期续期：refresh_token 一次一换（gotrue 轮换），失败则回落到密码登录
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: cached.refresh_token }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      const entry = cacheableAuth(await res.json())
      saveAuthCache(entry)
      token = entry.access_token
      userId = entry.user_id
      authFrom = 'refresh_token 续期'
    } catch {
      // refresh 失效（长期未用被服务端吊销等），继续走密码
    }
  }
}

if (!token) {
  const email = process.env.INKFLOW_EMAIL
  const password = process.env.INKFLOW_PASSWORD
  if (!email || !password) {
    console.error('缺少认证。两种方式任选：')
    console.error('  1) 首次配置（登录一次后缓存到 ~/.inkflow/auth.json，之后免密）：')
    console.error('     INKFLOW_EMAIL=你的邮箱 INKFLOW_PASSWORD=你的密码 node scripts/write-note.mjs --login')
    console.error('  2) 显式 token：INKFLOW_TOKEN=<access_token> INKFLOW_USER_ID=<uuid>')
    process.exit(1)
  }
  const entry = cacheableAuth(await passwordLogin(email, password))
  saveAuthCache(entry)
  token = entry.access_token
  userId = entry.user_id
  authFrom = '邮箱密码登录（已缓存，下次免密）'
}

if (loginOnly) {
  console.log(`登录成功，token 已缓存到 ${AUTH_FILE}`)
  console.log(`user_id: ${userId}`)
  console.log('之后调用本脚本无需再提供邮箱密码；token 过期会自动续期。')
}

const headers = { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

// ---------- --find：搜索笔记（标题/正文/标签），输出更新所需的 id ----------
if (findQuery !== undefined) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/notes?select=id,title,content,folder_id,tags,updated_at&deleted_at=is.null&order=updated_at.desc&limit=500`,
    { headers },
  )
  if (!res.ok) {
    console.error('查询笔记失败:', res.status, await res.text())
    process.exit(1)
  }
  const rows = await res.json()
  // 文件夹 id → 路径（a/b），一次拉全量在本地拼
  const fres = await fetch(`${SUPABASE_URL}/rest/v1/folders?select=id,name,parent_id&limit=1000`, { headers })
  const folders = fres.ok ? await fres.json() : []
  const byId = new Map(folders.map((f) => [f.id, f]))
  const pathOf = (id) => {
    const names = []
    let cur = id ? byId.get(id) : null
    while (cur) {
      names.unshift(cur.name)
      cur = cur.parent_id ? byId.get(cur.parent_id) : null
    }
    return names.join('/') || '(无文件夹)'
  }
  // TipTap doc 深度优先取第一段纯文本做摘要
  const firstText = (node, depth = 0) => {
    if (!node || depth > 8) return ''
    if (node.type === 'text') return node.text || ''
    for (const c of node.content ?? []) {
      const t = firstText(c, depth + 1)
      if (t) return t
    }
    return ''
  }
  const q = String(findQuery).toLowerCase()
  const hits = rows.filter(
    (r) =>
      (r.title || '').toLowerCase().includes(q) ||
      JSON.stringify(r.content ?? {}).toLowerCase().includes(q) ||
      (r.tags ?? []).some((t) => String(t).toLowerCase().includes(q)),
  )
  if (!hits.length) {
    console.log(`没有匹配「${findQuery}」的笔记`)
  } else {
    console.log(`匹配 ${hits.length} 篇（按更新时间倒序，最多显示 20）：`)
    for (const h of hits.slice(0, 20)) {
      const summary = firstText(h.content).replace(/\s+/g, ' ').slice(0, 50)
      console.log(`${h.id} | ${h.title || '(无标题)'} | ${pathOf(h.folder_id)} | ${h.updated_at.slice(0, 16)} | ${summary}`)
    }
    if (hits.length > 20) console.log(`…另有 ${hits.length - 20} 篇未显示`)
    console.log('更新某篇: node write-note.mjs --title "新标题" 内容.md --id <上面的 uuid>')
  }
}

// ---------- 图片上传（本地路径 → images 公共桶） ----------
async function uploadImage(localPath) {
  const abs = resolve(mdDir, localPath)
  if (!existsSync(abs)) {
    console.error(`警告: 图片不存在，保留原路径: ${localPath}`)
    return localPath
  }
  const buf = readFileSync(abs)
  const ext = (extname(abs).slice(1) || 'png').toLowerCase()
  const IMG_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp',
  }
  const mime = IMG_MIME[ext] || 'image/png'
  const name = `${randomUUID()}.${ext === 'jpg' ? 'jpg' : ext}`
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/images/${name}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': mime, 'x-upsert': 'true' },
    body: buf,
  })
  if (!res.ok) {
    console.error(`图片上传失败 ${localPath}:`, res.status, await res.text())
    process.exit(1)
  }
  return `${SUPABASE_URL}/storage/v1/object/public/images/${name}`
}

// ---------- Markdown → TipTap JSON（常用语法子集，与编辑器 schema 一致） ----------
// 支持: #/##/### 标题、**粗体**、*斜体*、`行内代码`、```代码块、-/* 无序列表、1. 有序列表、
//       - [ ]/- [x] 待办清单、GFM 表格（首行表头）、> 引用、$行内公式$、$$块级公式$$、
//       ![图](路径)、[链接](url)、{{文字}}/{{色名:文字}} 文字颜色、==高亮==/==色名:高亮==
function parseInline(s) {
  const TEXT_HEX = { 红: '#c92a2a', 橙: '#d9480f', 绿: '#2b8a3e', 青: '#1f6f6b', 蓝: '#1971c2', 紫: '#862e9c', 灰: '#495057' }
  const MARK_HEX = { 黄: '#fff3bf', 红: '#ffe3e3', 橙: '#ffe8cc', 绿: '#d3f9d8', 青: '#c5f6fa', 蓝: '#dbe4ff', 紫: '#f3d9fa' }
  const nodes = []
  let last = 0
  const re = /\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<!\$)\$([^$\n]+)\$(?!\$)|\{\{(?:(红|橙|绿|青|蓝|紫|灰)[:：])?([^{}]+)\}\}|==(?:(黄|红|橙|绿|青|蓝|紫)[:：])?([^=]+)==/g
  let m
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) nodes.push({ type: 'text', text: s.slice(last, m.index) })
    if (m[1] !== undefined) nodes.push({ type: 'text', marks: [{ type: 'bold' }], text: m[1] })
    else if (m[2] !== undefined) nodes.push({ type: 'text', marks: [{ type: 'italic' }], text: m[2] })
    else if (m[3] !== undefined) nodes.push({ type: 'text', marks: [{ type: 'code' }], text: m[3] })
    else if (m[4] !== undefined)
      nodes.push({ type: 'text', marks: [{ type: 'link', attrs: { href: m[5] } }], text: m[4] })
    else if (m[6] !== undefined)
      nodes.push({ type: 'inlineMath', attrs: { latex: m[6] } })
    else if (m[7] !== undefined || m[8] !== undefined)
      // 文字颜色：{{文字}} 默认红，{{蓝:文字}} 指定色（色名同编辑器色板）
      nodes.push({
        type: 'text',
        marks: [{ type: 'textStyle', attrs: { color: TEXT_HEX[m[7]] ?? '#c92a2a' } }],
        text: m[8],
      })
    else if (m[9] !== undefined || m[10] !== undefined)
      // 荧光高亮：==文字== 默认黄，==红:文字== 指定底色
      nodes.push({
        type: 'text',
        marks: [{ type: 'highlight', attrs: { color: MARK_HEX[m[9]] ?? '#fff3bf' } }],
        text: m[10],
      })
    last = m.index + m[0].length
  }
  if (last < s.length) nodes.push({ type: 'text', text: s.slice(last) })
  return nodes.length ? nodes : undefined
}

function para(text) {
  return { type: 'paragraph', content: parseInline(text) }
}

async function mdToDoc(md, dry = false) {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const content = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (/^```/.test(line)) {
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++ // 跳过闭合 ```
      content.push({ type: 'codeBlock', attrs: { language: null }, content: buf.length ? [{ type: 'text', text: buf.join('\n') }] : undefined })
      continue
    }

    // 块级公式：$$…$$ 单行，或 $$ 独占行的多行形式
    const single = /^\s*\$\$([^$]+)\$\$\s*$/.exec(line)
    if (single) {
      content.push({ type: 'blockMath', attrs: { latex: single[1].trim() } })
      i++
      continue
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      const buf = []
      i++
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) buf.push(lines[i++])
      i++
      const latex = buf.join('\n').trim()
      if (latex) content.push({ type: 'blockMath', attrs: { latex } })
      continue
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      content.push({ type: 'heading', attrs: { level: h[1].length }, content: parseInline(h[2]) })
      i++
      continue
    }

    // 独占一行的图片 → image 块节点（本地路径自动上传 Storage）
    const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line.trim())
    if (img) {
      let src = img[2]
      if (!dry && !/^https?:\/\//.test(src) && !src.startsWith('data:')) src = await uploadImage(src)
      content.push({ type: 'image', attrs: { src, alt: img[1] || null, title: null } })
      i++
      continue
    }

    if (/^\s*$/.test(line)) {
      i++
      continue
    }

    // GFM 表格：| 开头的行 + --- 分隔行，首行为表头
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s\-:|]+\|?\s*$/.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      const splitRow = (l) =>
        l
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim())
      const headerCells = splitRow(line)
      i += 2
      const bodyRows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        bodyRows.push(splitRow(lines[i]))
        i++
      }
      const cellNode = (type, t) => ({ type, content: [para(t || ' ')] })
      content.push({
        type: 'table',
        content: [
          { type: 'tableRow', content: headerCells.map((c) => cellNode('tableHeader', c)) },
          ...bodyRows.map((r) => ({ type: 'tableRow', content: r.map((c) => cellNode('tableCell', c)) })),
        ],
      })
      continue
    }

    // 待办清单：- [ ] / - [x]
    const taskRe = /^\s*[-*]\s+\[([ xX])\]\s+/
    if (taskRe.test(line)) {
      const items = []
      while (i < lines.length && taskRe.test(lines[i])) {
        const tm = taskRe.exec(lines[i])
        items.push({
          type: 'taskItem',
          attrs: { checked: tm[1] !== ' ' },
          content: [para(lines[i].replace(taskRe, ''))],
        })
        i++
      }
      content.push({ type: 'taskList', content: items })
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push({ type: 'listItem', content: [para(lines[i].replace(/^\s*[-*]\s+/, ''))] })
        i++
      }
      content.push({ type: 'bulletList', content: items })
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push({ type: 'listItem', content: [para(lines[i].replace(/^\s*\d+\.\s+/, ''))] })
        i++
      }
      content.push({ type: 'orderedList', attrs: { start: 1 }, content: items })
      continue
    }

    if (/^>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      content.push({ type: 'blockquote', content: [para(buf.join(' '))] })
      continue
    }

    content.push(para(line))
    i++
  }
  return { type: 'doc', content }
}

// dry-run：图片保持原路径不上传，仅输出转换后的文档 JSON
async function mdToDocDry(md) {
  return mdToDoc(md, true)
}

// ---------- 文件夹解析（a/b 多级，不存在则逐级创建） ----------
async function resolveFolder(path) {
  if (!path) return null
  let parentId = null
  for (const name of path.split('/').map((s) => s.trim()).filter(Boolean)) {
    const parentFilter = parentId === null ? 'parent_id=is.null' : `parent_id=eq.${parentId}`
    const find = await fetch(
      `${SUPABASE_URL}/rest/v1/folders?select=id&name=eq.${encodeURIComponent(name)}&${parentFilter}&limit=1`,
      { headers },
    )
    if (!find.ok) throw new Error(`查询文件夹失败: ${find.status} ${await find.text()}`)
    const found = await find.json()
    if (found.length) {
      parentId = found[0].id
      continue
    }
    const create = await fetch(`${SUPABASE_URL}/rest/v1/folders`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({ name, parent_id: parentId, user_id: userId }),
    })
    if (!create.ok) throw new Error(`创建文件夹失败: ${create.status} ${await create.text()}`)
    parentId = (await create.json())[0].id
  }
  return parentId
}



// process.exit 在 Windows 上与 libuv 清理竞态会触发断言崩溃，
// --login/--find 分支靠这个条件让模块自然结束
if (!loginOnly && findQuery === undefined) {
  // ---------- 写入笔记 ----------
  const content = await mdToDoc(mdText)
  const folderId = await resolveFolder(folderPath)
  const now = new Date().toISOString()

  let result
  if (noteId) {
    // 更新已有笔记：version + 1（与客户端 LWW 冲突逻辑一致）
    const cur = await fetch(`${SUPABASE_URL}/rest/v1/notes?id=eq.${noteId}&select=version`, { headers })
    if (!cur.ok) throw new Error(`查询笔记失败: ${cur.status} ${await cur.text()}`)
    const rows = await cur.json()
    if (!rows.length) throw new Error(`笔记 ${noteId} 不存在`)
    const res = await fetch(`${SUPABASE_URL}/rest/v1/notes?id=eq.${noteId}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      // 只覆盖显式提供的字段：没传 --folder/--tags/--title 时保留原值，
      // 避免更新正文时把笔记悄悄移出文件夹、清空标签或标题
      body: JSON.stringify({
        ...(title ? { title } : {}),
        content,
        ...(folderPath !== undefined ? { folder_id: folderId } : {}),
        ...(tagsArg !== undefined ? { tags } : {}),
        version: rows[0].version + 1,
        updated_at: now,
        deleted_at: null,
      }),
    })
    if (!res.ok) throw new Error(`更新笔记失败: ${res.status} ${await res.text()}`)
    result = (await res.json())[0]
  } else {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/notes`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        id: randomUUID(),
        user_id: userId,
        title,
        content,
        tags,
        folder_id: folderId,
        version: 1,
        updated_at: now,
      }),
    })
    if (!res.ok) throw new Error(`创建笔记失败: ${res.status} ${await res.text()}`)
    result = (await res.json())[0]
  }

  console.log(JSON.stringify({ id: result.id, title: result.title, folder_id: result.folder_id, updated_at: result.updated_at }))

}
