import Ajv from 'ajv'

const ajv = new Ajv({ strict: false, allErrors: true, verbose: true })
const at = path => path ? path.slice(1).replace(/\/(\d+)(?=\/|$)/g, '[$1]').replaceAll('/', '.') : 'input'

function describe(error) {
  const field = at(error.instancePath)
  if (error.keyword === 'additionalProperties') return `${field} has no field "${error.params.additionalProperty}"; allowed: ${Object.keys(error.parentSchema.properties ?? {}).join(', ')}`
  if (error.keyword === 'required') return `${field} is missing required field "${error.params.missingProperty}"`
  if (error.keyword === 'enum') return `${field} must be one of ${error.params.allowedValues.map(value => JSON.stringify(value)).join(', ')}`
  if (error.keyword === 'minProperties' && !error.instancePath) return 'name at least one change besides id'
  return `${field} ${error.message}`
}

export function operationValidator(schema) {
  const check = ajv.compile(schema)
  return value => {
    if (check(value)) return
    const problems = [...new Set(check.errors.filter(error => error.keyword !== 'anyOf').map(describe))]
    return problems.join('; ')
  }
}
