import { RouterError } from './host'
export function repositoryURL(input: string) {
  if (typeof input !== 'string' || input.length > 2000 || /[\s\x00-\x1f\x7f\\?#]/.test(input)) throw new RouterError('INVALID_REMOTE', 'Use a credential-free HTTPS or SSH repository URL')
  const scp = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+)$/.exec(input)
  let url: URL
  try { url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : input) } catch { throw new RouterError('INVALID_REMOTE', 'Use an HTTPS or SSH repository URL') }
  if (!['https:', 'ssh:'].includes(url.protocol) || url.password || (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) || url.port || !url.hostname || !/^[A-Za-z0-9._/-]+$/.test(url.pathname) || url.pathname.includes('..') || url.pathname.includes('//')) throw new RouterError('INVALID_REMOTE', 'Credential-bearing or ambiguous repository URL rejected')
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  const name = path.split('/').at(-1)!
  if (!path.includes('/') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) || /[. ]$/.test(name)) throw new RouterError('INVALID_REMOTE', 'Repository path or basename is invalid')
  return { identity: url.hostname.toLowerCase() + '/' + path, name, url: `${url.protocol}//${url.protocol === 'ssh:' ? 'git@' : ''}${url.hostname.toLowerCase()}/${path}.git` }
}
