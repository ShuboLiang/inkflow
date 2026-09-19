#!/usr/bin/env node
// InkFlow 笔记写入脚本：Markdown → TipTap JSON → Supabase PostgREST。
// 用法：
//   node write-note.mjs --title "标题" 笔记.md [--folder 文件夹[/子文件夹]] [--tags 标签1,标签2] [--id <uuid>]
//   cat 笔记.md | node write-note.mjs --title "标题" --stdin
//
// 认证（二选一）：
//   1) INKFLOW_EMAIL + INKFLOW_PASSWORD   （邮箱密码登录）
//   2) INKFLOW_TOKEN + INKFLOW_USER_ID    （预签发的 access token，供自动化/测试）
// 其它环境变量：INKFLOW_URL（默认 http://localhost:8000）、INKFLOW_ANON_KEY（已内置默认值）

import { readFileSync, existsSync } from 'node:fs'
import { basename, extname, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const SUPABASE_URL = (process.env.INKFLOW_URL || 'http://localhost:8000').replace(/\/$/, '')
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
const folderPath = opt('folder') // 支持 a/b 多级
const tags = (opt('tags') || '').split(',').map((s) => s.trim()).filter(Boolean)
const noteId = opt('id') // 提供则更新已有笔记

if ((!fileArg && !useStdin) || (!title && !useStdin)) {
  console.error('用法: node write-note.mjs --title "标题" 笔记.md [--folder a/b] [--tags x,y] [--id uuid]')
  console.error('   或: cat 笔记.md | node write-note.mjs --title "标题" --stdin [--folder a/b]')
  process.exit(1)
}

const mdText = useStdin || !fileArg ? readFileSync(0, 'utf8') : readFileSync(fileArg, 'utf8')
const mdDir = fileArg ? dirname(resolve(fileArg)) : process.cwd()

// ---------- 认证 ----------
let token = process.env.INKFLOW_TOKEN
let userId = process.env.INKFLOW_USER_ID
if (!token) {
  const email = process.env.INKFLOW_EMAIL
  const password = process.env.INKFLOW_PASSWORD
  if (!email || !password) {
    console.error('缺少认证：设置 INKFLOW_EMAIL+INKFLOW_PASSWORD，或 INKFLOW_TOKEN+INKFLOW_USER_ID')
    process.exit(1)
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    console.error('登录失败:', res.status, await res.text())
    process.exit(1)
  }
  const data = await res.json()
  token = data.access_token
  userId = data.user.id
}

const headers = { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

// ---------- 图片上传（本地路径 → images 公共桶） ----------
async function uploadImage(localPath) {
  const abs = resolve(mdDir, localPath)
  if (!existsSync(abs)) {
    console.error(`警告: 图片不存在，保留原路径: ${localPath}`)
    return localPath
  }
  const buf = readFileSync(abs)
  const ext = (extname(abs).slice(1) || 'png').toLowerCase()
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
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
//       > 引用、$行内公式$、$$块级公式$$、![图](路径)、[链接](url)
function parseInline(s) {
  const nodes = []
  let last = 0
  const re = /\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<!\$)\$([^$\n]+)\$(?!\$)/g
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
    last = m.index + m[0].length
  }
  if (last < s.length) nodes.push({ type: 'text', text: s.slice(last) })
  return nodes.length ? nodes : undefined
}

const para = (text) => ({ type: 'paragraph', content: parseInline(text) })

async function mdToDoc(md) {
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
      if (!/^https?:\/\//.test(src) && !src.startsWith('data:')) src = await uploadImage(src)
      content.push({ type: 'image', attrs: { src, alt: img[1] || null, title: null } })
      i++
      continue
    }

    if (/^\s*$/.test(line)) {
      i++
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
    body: JSON.stringify({
      title,
      content,
      tags,
      folder_id: folderId,
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
