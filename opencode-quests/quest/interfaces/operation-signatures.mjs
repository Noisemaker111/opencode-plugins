import { questOperations } from '../operations.mjs'

const scalar = type => (Array.isArray(type) ? type.join('|') : (type ?? 'any'))
const BRIEF_DEPTH = 2

export function renderType(schema, depth = Infinity) {
  if (!schema || typeof schema !== 'object') return 'any'
  if (Array.isArray(schema.anyOf)) return [...new Set(schema.anyOf.map(option => renderType(option, depth)))].join('|')
  if (Array.isArray(schema.enum)) return schema.enum.map(value => String(value)).join('|')
  if (schema.type === 'array') return '[' + renderType(schema.items, depth) + ']'
  if (schema.type === 'object' || schema.properties) return renderObject(schema, depth)
  return scalar(schema.type)
}

function renderObject(schema, depth) {
  if (depth <= 0 && Object.keys(schema.properties ?? {}).length) return '{...}'
  const required = new Set(schema.required ?? [])
  const fields = Object.entries(schema.properties ?? {}).map(([name, value]) => name + (required.has(name) ? '' : '?') + ':' + renderType(value, depth - 1))
  if (!fields.length && schema.additionalProperties && typeof schema.additionalProperties === 'object') return '{<name>:' + renderType(schema.additionalProperties, depth - 1) + '}'
  return '{' + fields.join(', ') + '}'
}

export function operationSignature(name, input, depth = BRIEF_DEPTH) {
  return name + '(' + renderObject(input ?? {}, depth).slice(1, -1) + ')'
}

export function questSignatureLines(operations = questOperations) {
  return Object.entries(operations).map(([name, operation]) => operationSignature(name, operation.input))
}
