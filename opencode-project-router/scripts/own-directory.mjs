export const ownDirectoryEnvironment = (environment = process.env) =>
  Object.fromEntries(Object.entries(environment).filter(([name]) => !/^(OLD)?PWD$/i.test(name)))
