import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const stemOf = file => basename(file).replace(/\.jsonl$/, '')
const isTime = value => typeof value === 'number' && Number.isFinite(value)

export const localDay = time => {
  const date = new Date(time)
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}
export const dayFile = (file, time) => join(dirname(file), stemOf(file) + '.' + localDay(time) + '.jsonl')
export const spanStart = row => [row.start, row.at, row.created, row.observed].find(isTime)
export const spanEnd = row => [row.end, row.to].find(isTime) ?? spanStart(row)

export function spanFiles(file, window = {}) {
  const dir = dirname(file), stem = stemOf(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp('^' + stem + '\\.(\\d{4}-\\d{2}-\\d{2})\\.jsonl$')
  const from = window.from === undefined ? '' : localDay(window.from), to = window.to === undefined ? '\uffff' : localDay(window.to)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => {
    const day = pattern.exec(name)?.[1]
    return day !== undefined && day >= from && day <= to
  }).sort().map(name => join(dir, name))
}

export function* forwardLines(file, size = 1 << 20) {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(size)
    let carry = Buffer.alloc(0), at = 0
    for (let n = readSync(fd, buffer, 0, size, at); n > 0; n = readSync(fd, buffer, 0, size, at)) {
      at += n
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, n)]) : buffer.subarray(0, n)
      let start = 0
      for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) { yield data.toString('utf8', start, end); start = end + 1 }
      carry = Buffer.from(data.subarray(start))
    }
    if (carry.length) yield carry.toString('utf8')
  } finally { closeSync(fd) }
}

export function* backwardChunks(file, size = 1 << 20) {
  const fd = openSync(file, 'r')
  try {
    let end = fstatSync(fd).size, carry = Buffer.alloc(0)
    while (end > 0) {
      const start = Math.max(0, end - size), buffer = Buffer.alloc(end - start)
      readSync(fd, buffer, 0, buffer.length, start)
      const data = carry.length ? Buffer.concat([buffer, carry]) : buffer
      const lines = []
      let last = data.length, newline = last > 0 ? data.lastIndexOf(10, last - 1) : -1
      while (newline >= 0) { lines.push(data.toString('utf8', newline + 1, last)); last = newline; newline = last > 0 ? data.lastIndexOf(10, last - 1) : -1 }
      carry = data.subarray(0, last)
      if (start === 0 && last > 0) { lines.push(carry.toString('utf8')); carry = Buffer.alloc(0) }
      end = start
      yield lines
    }
  } finally { closeSync(fd) }
}
