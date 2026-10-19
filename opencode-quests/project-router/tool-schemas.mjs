const string = { type: 'string', minLength: 1, maxLength: 2000 }
export const selectors = { type: 'array', minItems: 1, maxItems: 10, items: string }
export const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
export const projectResolveInput = schema({ selectors, discussion: { type: 'boolean' }, request: string })
export const projectAliasInput = schema({ alias: { type: 'string', minLength: 1, maxLength: 80 }, directory: string, forget: { type: 'boolean' } }, ['alias'])
export const projectToolInputs = { project_resolve: projectResolveInput, project_alias: projectAliasInput }
