// Minimal ESM loader hooks so the tests can import the TypeScript sources
// directly with Node's built-in type stripping - no bundler needed.
//
//  * extensionless relative imports ("./engine") resolve to ".ts"
//  * ".css" imports (main.ts imports the stylesheet) become empty modules
export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
  const hasExtension = /\.[cm]?[jt]sx?$/.test(specifier)
  if (isRelative && !hasExtension && !specifier.endsWith('.css') && !specifier.endsWith('.json')) {
    try {
      return await nextResolve(`${specifier}.ts`, context)
    } catch {
      // fall through to the default resolution
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {}', shortCircuit: true }
  }
  return nextLoad(url, context)
}
