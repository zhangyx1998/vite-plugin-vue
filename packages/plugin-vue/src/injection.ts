import type { Node } from '@babel/types'
import { parse } from '@babel/parser'

type NodeMatcher = (node: Node) => any
type NodeRewriter = (script: string) => string

// Generator to traverse all nesting AST blocks
function* traverseAst(node: Node, matcher: NodeMatcher): Generator<Node> {
  // Skip non-searchable properties.
  if (typeof node !== 'object' || node == null) return
  // First yield the node itself if matched
  const match = matcher(node)
  if (match) yield match
  // Iterate into object properties.
  for (const value of Object.values(node)) {
    // Then yield any children that matches
    for (const match of traverseAst(value, matcher)) yield match
  }
}

function matchFunctionCall(identifier: string): NodeMatcher {
  return (node) =>
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === identifier &&
    node
}

export function matchExportDefault(): NodeMatcher {
  return (node) => node.type === 'ExportDefaultDeclaration' && node.declaration
}

// Generates a rewriter that rewrites given expression
// as an IIFE that assigns additional properties and
// executes the original expression.
export function rewriteAsIIFE(
  props: [string, string][],
  hooks: ((expr: string) => string | string[])[],
): NodeRewriter {
  // Lazy wrapping to avoid redundant statements
  if (!props.length && !hooks.length) {
    return (expr) => expr
  }
  // Prepare JSON-like object literal
  const propsToAssign = props
    .map(([key, value]) => [JSON.stringify(key), value].join(': '))
    .join(', ')
  // NodeRewriter that applies to all matched blocks
  return (expr) =>
    [
      '(() => {',
      `const sfc_main = /*#__PURE__*/ Object.assign(${expr}, { ${propsToAssign} })`,
      ...hooks.map((f) => f('sfc_main')),
      'return sfc_main',
      `})()`,
    ]
      .flat(Infinity)
      .join('\n')
}

interface InsertionContext {
  start: number
  end: number
}

function transformScript(
  script: string,
  matcher: NodeMatcher,
  rewriter: NodeRewriter,
): [number, string] {
  const insertions: InsertionContext[] = []
  // Identify and store all insertion points
  const ast = parse(script, { sourceType: 'module' })
  for (const node of traverseAst(ast.program, matcher)) {
    const { start, end } = node as InsertionContext
    insertions.push({ start, end })
  }
  const count = insertions.length
  // Sort the insertion points by start position (descending)
  insertions.sort((a, b) => b.start - a.start)
  // Ensure that the insertion points are not interlacing
  for (let i = 0; i < insertions.length - 1; i++) {
    const prior = insertions[i + 1],
      later = insertions[i]
    if (later.start < prior.end && later.end > prior.start) {
      throw new Error(
        `Interlacing insertion points: ${JSON.stringify([
          insertions[i + 1],
          insertions[i],
        ])}`,
      )
    }
  }
  // Rewrite original script
  while (insertions.length) {
    // Get next rightmost insertion point
    const insertion = insertions.shift() as InsertionContext
    // Get new content
    const { start, end } = insertion
    const content = script.slice(start, end)
    const replacement = rewriter(content)
    // Compute relative delta offset
    const delta = replacement.length - content.length
    // Update other insertion points that encloses this one
    for (const other of insertions) {
      // Array sort guarantees other.start <= start
      if (other.end >= end) {
        other.end += delta
      } else {
        break
      }
    }
    // Apply replacement
    script = [script.slice(0, start), replacement, script.slice(end)].join('')
  }
  return [count, script]
}

export default function injectIntoComponent(
  script: string,
  props: [string, string][],
  hooks: ((expr: string) => string | string[])[],
): string {
  let numInjections: number, injectedScript: string
  const rewriter = rewriteAsIIFE(props, hooks) as NodeRewriter
  // 1. try to rewrite defineProps() function calls
  //    into IIFE statements
  ;[numInjections, injectedScript] = transformScript(
    script,
    matchFunctionCall('defineComponent'),
    rewriter,
  )
  if (numInjections) {
    return injectedScript
  }
  // 2. defineComponent() cannot be found in context
  //    fall back to rewrite export default statement
  ;[numInjections, injectedScript] = transformScript(
    script,
    matchExportDefault(),
    rewriter,
  )
  if (numInjections) {
    return injectedScript
  }
  // 3. export default not exsit.
  //    fall back to generating new export default statement
  return `export default ${rewriter('{}')}`
}
