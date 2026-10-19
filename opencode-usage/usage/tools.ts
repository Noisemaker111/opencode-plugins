import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import { usageOperations } from "./operations"

const validator = new AjvJsonSchemaValidator()
export const usageTools = usageOperations.map(operation => {
  const validate = validator.getValidator(operation.input)
  return { ...operation, execute: async (input: unknown, context?: { sessionID?: string }) => {
    const checked = validate(input)
    if (!checked.valid) throw new Error(`Invalid ${operation.name} input: ${checked.errorMessage}`)
    return operation.execute(checked.data, context)
  } }
})

export async function callUsage(name: string, input: unknown = {}, context?: { sessionID?: string }) {
  const operation = usageTools.find(operation => operation.name === name)
  if (!operation) throw new Error(`Unknown Usage operation: ${name}`)
  return operation.execute(input, context)
}
