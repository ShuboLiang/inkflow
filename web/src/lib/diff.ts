export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged'
  text: string
  oldLineNumber?: number
  newLineNumber?: number
}

export interface DiffResult {
  lines: DiffLine[]
  addedCount: number
  removedCount: number
}

/**
 * 高性能带前缀/后缀修剪的 LCS 逐行差异比对算法
 */
export function computeLineDiff(oldText: string, newText: string): DiffResult {
  if (oldText === newText) {
    if (!oldText) return { lines: [], addedCount: 0, removedCount: 0 }
    const sameLines = oldText.split('\n').map((text, idx) => ({
      type: 'unchanged' as const,
      text,
      oldLineNumber: idx + 1,
      newLineNumber: idx + 1,
    }))
    return { lines: sameLines, addedCount: 0, removedCount: 0 }
  }

  const a = oldText.length > 0 ? oldText.split('\n') : []
  const b = newText.length > 0 ? newText.split('\n') : []

  // 1. 快速修剪相同的前缀
  let prefix = 0
  const maxPrefix = Math.min(a.length, b.length)
  while (prefix < maxPrefix && a[prefix] === b[prefix]) {
    prefix++
  }

  // 2. 快速修剪相同的后缀
  let suffix = 0
  const maxSuffix = Math.min(a.length - prefix, b.length - prefix)
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix++
  }

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)

  const n = midA.length
  const m = midB.length

  // 中间差异部分的 LCS 动态规划矩阵
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (midA[i - 1] === midB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // 回溯还原差异
  const midLines: { type: 'added' | 'removed' | 'unchanged'; text: string }[] = []
  let i = n
  let j = m

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && midA[i - 1] === midB[j - 1]) {
      midLines.push({ type: 'unchanged', text: midA[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      midLines.push({ type: 'added', text: midB[j - 1] })
      j--
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      midLines.push({ type: 'removed', text: midA[i - 1] })
      i--
    }
  }

  midLines.reverse()

  // 拼接前缀 + 中间差异 + 后缀，并生成精确的行号
  const resultLines: DiffLine[] = []
  let curOldLine = 0
  let curNewLine = 0
  let addedCount = 0
  let removedCount = 0

  // 相同前缀
  for (let p = 0; p < prefix; p++) {
    curOldLine++
    curNewLine++
    resultLines.push({
      type: 'unchanged',
      text: a[p],
      oldLineNumber: curOldLine,
      newLineNumber: curNewLine,
    })
  }

  // 中间差异
  for (const item of midLines) {
    if (item.type === 'unchanged') {
      curOldLine++
      curNewLine++
      resultLines.push({
        type: 'unchanged',
        text: item.text,
        oldLineNumber: curOldLine,
        newLineNumber: curNewLine,
      })
    } else if (item.type === 'removed') {
      curOldLine++
      removedCount++
      resultLines.push({
        type: 'removed',
        text: item.text,
        oldLineNumber: curOldLine,
      })
    } else if (item.type === 'added') {
      curNewLine++
      addedCount++
      resultLines.push({
        type: 'added',
        text: item.text,
        newLineNumber: curNewLine,
      })
    }
  }

  // 相同后缀
  for (let s = a.length - suffix; s < a.length; s++) {
    curOldLine++
    curNewLine++
    resultLines.push({
      type: 'unchanged',
      text: a[s],
      oldLineNumber: curOldLine,
      newLineNumber: curNewLine,
    })
  }

  return {
    lines: resultLines,
    addedCount,
    removedCount,
  }
}
