import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function productionTypeScriptFiles(root: string): Array<string> {
  const files: Array<string> = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...productionTypeScriptFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(fullPath)
    }
  }
  return files
}

function operationalJavaScriptFiles(root: string): Array<string> {
  const files: Array<string> = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...operationalJavaScriptFiles(fullPath))
    } else if (
      entry.isFile()
      && /\.(?:cjs|js|mjs)$/.test(entry.name)
      && !/\.test\.(?:cjs|js|mjs)$/.test(entry.name)
    ) {
      files.push(fullPath)
    }
  }
  return files
}

const RUNTIME_DESTINATION_INDEX = new Map<string, number>([
  ['createWriteStream', 0],
  ['appendFileSync', 0],
  ['appendFile', 0],
  ['writeFileSync', 0],
  ['writeFile', 0],
  ['truncateSync', 0],
  ['truncate', 0],
  ['openSync', 0],
  ['open', 0],
  ['renameSync', 1],
  ['rename', 1],
  ['copyFileSync', 1],
  ['copyFile', 1],
])
const FILE_HANDLE_WRITE_METHODS = new Set(['appendFile', 'truncate', 'write', 'writeFile'])
const RUNTIME_PARAMETER = /(?:runtime.*(?:file|path)|(?:file|path).*runtime)/i

function isExecutableFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
}

function bindingIdentifierNames(name: ts.BindingName): Array<string> {
  if (ts.isIdentifier(name)) return [name.text]
  const names: Array<string> = []
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    names.push(...bindingIdentifierNames(element.name))
  }
  return names
}

function runtimeWriterFindings(file: string): Array<string> {
  const source = fs.readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.ts') || file.endsWith('.tsx') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  )
  const findings = new Set<string>()
  const approvedHelperFiles = new Set([
    path.resolve(process.cwd(), 'src', 'server', 'swarm-foundation.ts'),
    path.resolve(process.cwd(), 'electron', 'server-bundle.cjs'),
  ])

  const functionIndex = new Map<string, Array<ts.FunctionLikeDeclaration>>()
  function indexFunctions(node: ts.Node): void {
    let name: string | null = null
    let fn: ts.FunctionLikeDeclaration | null = null
    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text
      fn = node
    } else if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && isExecutableFunctionLike(node.initializer)
    ) {
      name = node.name.text
      fn = node.initializer
    }
    if (name !== null && fn !== null) {
      const known = functionIndex.get(name) ?? []
      known.push(fn)
      functionIndex.set(name, known)
    }
    ts.forEachChild(node, indexFunctions)
  }
  indexFunctions(sourceFile)

  function isFsModule(expression: ts.Expression): boolean {
    const text = expression.getText(sourceFile)
    return /(?:from\s*)?["'](?:node:)?fs(?:\/promises)?["']/.test(text)
      || /require\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/.test(text)
  }

  function writerMethodFromExpression(
    expression: ts.Expression,
    aliases: ReadonlyMap<string, string>,
    statics: ReadonlyMap<string, string>,
  ): string | null {
    if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? null
    if (
      ts.isParenthesizedExpression(expression)
      || ts.isAwaitExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression)
    ) {
      return writerMethodFromExpression(expression.expression, aliases, statics)
    }
    if (ts.isPropertyAccessExpression(expression)) {
      if (RUNTIME_DESTINATION_INDEX.has(expression.name.text)) return expression.name.text
      return writerMethodFromExpression(expression.expression, aliases, statics)
    }
    if (ts.isElementAccessExpression(expression)) {
      const computed = staticStringValue(expression.argumentExpression, statics)
      if (computed !== null && RUNTIME_DESTINATION_INDEX.has(computed)) return computed
      return writerMethodFromExpression(expression.expression, aliases, statics)
    }

    let discovered: string | null = null
    ts.forEachChild(expression, (child) => {
      if (discovered === null && ts.isExpression(child)) {
        discovered = writerMethodFromExpression(child, aliases, statics)
      }
    })
    return discovered
  }

  function staticStringValue(
    expression: ts.Expression,
    statics: ReadonlyMap<string, string>,
  ): string | null {
    if (ts.isStringLiteralLike(expression)) return expression.text
    if (ts.isIdentifier(expression)) return statics.get(expression.text) ?? null
    if (
      ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression)
    ) {
      return staticStringValue(expression.expression, statics)
    }
    if (
      ts.isBinaryExpression(expression)
      && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = staticStringValue(expression.left, statics)
      const right = staticStringValue(expression.right, statics)
      return left === null || right === null ? null : left + right
    }
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text
      for (const span of expression.templateSpans) {
        const substitution = staticStringValue(span.expression, statics)
        if (substitution === null) return null
        value += substitution + span.literal.text
      }
      return value
    }
    return null
  }

  function expressionIsRuntimeTarget(
    expression: ts.Expression,
    runtimeTargets: ReadonlySet<string>,
    statics: ReadonlyMap<string, string>,
  ): boolean {
    // Path-taint semantics: a value is a runtime target only when it is (or is
    // built from) the runtime.json filesystem path. Values READ from the file
    // (JSON.parse, readFileSync results, property lookups on parsed content)
    // must not taint, or memory/markdown writers downstream become false
    // positives.
    const staticValue = staticStringValue(expression, statics)
    if (staticValue !== null && staticValue.includes('runtime.json')) return true
    if (ts.isIdentifier(expression)) return runtimeTargets.has(expression.text)
    if (
      ts.isParenthesizedExpression(expression)
      || ts.isAwaitExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression)
    ) {
      return expressionIsRuntimeTarget(expression.expression, runtimeTargets, statics)
    }
    if (
      ts.isBinaryExpression(expression)
      && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      return expressionIsRuntimeTarget(expression.left, runtimeTargets, statics)
        || expressionIsRuntimeTarget(expression.right, runtimeTargets, statics)
    }
    if (ts.isConditionalExpression(expression)) {
      return expressionIsRuntimeTarget(expression.whenTrue, runtimeTargets, statics)
        || expressionIsRuntimeTarget(expression.whenFalse, runtimeTargets, statics)
    }
    if (ts.isTemplateExpression(expression)) {
      if (expression.head.text.includes('runtime.json')) return true
      return expression.templateSpans.some(
        (span) =>
          span.literal.text.includes('runtime.json')
          || expressionIsRuntimeTarget(span.expression, runtimeTargets, statics),
      )
    }
    if (ts.isCallExpression(expression)) {
      // Only path-construction calls propagate path taint; reads and parses cut it.
      const callee = expression.expression.getText(sourceFile)
      if (!/(?:^|\.)(?:join|resolve|normalize|format)$/.test(callee)) return false
      return expression.arguments.some(
        (argument) => expressionIsRuntimeTarget(argument, runtimeTargets, statics),
      )
    }
    if (ts.isPropertyAccessExpression(expression)) {
      // Content lookups (parsed.cwd) never carry path taint; only properties
      // that are themselves runtime-path-shaped remain suspicious.
      return RUNTIME_PARAMETER.test(expression.name.text)
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.some(
        (property) =>
          ts.isPropertyAssignment(property)
          && expressionIsRuntimeTarget(property.initializer, runtimeTargets, statics),
      )
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.some(
        (element) =>
          ts.isExpression(element)
          && expressionIsRuntimeTarget(element, runtimeTargets, statics),
      )
    }
    return false
  }

  function isReadonlyOpen(
    method: string,
    call: ts.CallExpression,
    statics: ReadonlyMap<string, string>,
  ): boolean {
    if (method !== 'open' && method !== 'openSync') return false
    if (call.arguments.length < 2) return false
    const flags = staticStringValue(call.arguments[1], statics)
    return flags !== null && /^rs?$/.test(flags)
  }

  function approvedHelperContains(node: ts.Node): boolean {
    if (!approvedHelperFiles.has(path.resolve(file))) return false
    const parentOf = (current: ts.Node): ts.Node | undefined =>
      (current as unknown as { parent?: ts.Node }).parent
    let current: ts.Node | undefined = node
    do {
      if (
        ts.isFunctionDeclaration(current)
        && current.name?.text === 'writeSwarmRuntimeJsonAtomic'
      ) {
        return true
      }
      current = parentOf(current)
    } while (current)
    return false
  }

  function scopeLabel(scope: ts.SourceFile | ts.FunctionLikeDeclaration): string {
    if (ts.isSourceFile(scope)) return '<top-level>'
    if ('name' in scope && scope.name && ts.isIdentifier(scope.name)) return scope.name.text
    const line = sourceFile.getLineAndCharacterOfPosition(scope.getStart(sourceFile)).line + 1
    return `<function@${line}>`
  }

  const scannedInterprocedural = new Set<ts.FunctionLikeDeclaration>()

  function scanScope(
    scope: ts.SourceFile | ts.FunctionLikeDeclaration,
    inheritedWriterAliases: ReadonlyMap<string, string>,
    inheritedRuntimeTargets: ReadonlySet<string>,
    inheritedStatics: ReadonlyMap<string, string>,
    taintedParameterIndexes: ReadonlySet<number> = new Set(),
  ): void {
    const writerAliases = new Map(inheritedWriterAliases)
    const fsNamespaces = new Set<string>()
    const runtimeTargets = new Set(inheritedRuntimeTargets)
    const statics = new Map(inheritedStatics)
    const fileHandles = new Set<string>()
    const bindings: Array<{ name: string; initializer: ts.Expression }> = []
    const assignments: Array<{ name: string; initializer: ts.Expression }> = []
    const destructuredTargets: Array<{ names: Array<string>; initializer: ts.Expression }> = []
    const calls: Array<ts.CallExpression> = []
    const childScopes: Array<ts.FunctionLikeDeclaration> = []

    if (!ts.isSourceFile(scope)) {
      scope.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) return
        if (RUNTIME_PARAMETER.test(parameter.name.text) || taintedParameterIndexes.has(index)) {
          runtimeTargets.add(parameter.name.text)
        }
      })
    }

    function collect(current: ts.Node): void {
      if (current !== scope && isExecutableFunctionLike(current)) {
        childScopes.push(current)
        return
      }
      if (ts.isImportDeclaration(current) && isFsModule(current.moduleSpecifier)) {
        const clause = current.importClause
        if (clause?.name) fsNamespaces.add(clause.name.text)
        const bindingsNode = clause?.namedBindings
        if (bindingsNode && ts.isNamespaceImport(bindingsNode)) {
          fsNamespaces.add(bindingsNode.name.text)
        } else if (bindingsNode && ts.isNamedImports(bindingsNode)) {
          for (const element of bindingsNode.elements) {
            const imported = element.propertyName?.text ?? element.name.text
            if (RUNTIME_DESTINATION_INDEX.has(imported)) {
              writerAliases.set(element.name.text, imported)
            }
          }
        }
      }
      if (ts.isVariableDeclaration(current) && current.initializer) {
        if (ts.isIdentifier(current.name)) {
          bindings.push({ name: current.name.text, initializer: current.initializer })
          if (isFsModule(current.initializer)) fsNamespaces.add(current.name.text)
        } else if (ts.isObjectBindingPattern(current.name)) {
          const fromFs = isFsModule(current.initializer)
            || (ts.isIdentifier(current.initializer) && fsNamespaces.has(current.initializer.text))
          for (const element of current.name.elements) {
            if (!ts.isIdentifier(element.name)) continue
            const imported = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text
            if (fromFs && RUNTIME_DESTINATION_INDEX.has(imported)) {
              writerAliases.set(element.name.text, imported)
            }
          }
          destructuredTargets.push({
            names: bindingIdentifierNames(current.name),
            initializer: current.initializer,
          })
        } else if (ts.isArrayBindingPattern(current.name)) {
          destructuredTargets.push({
            names: bindingIdentifierNames(current.name),
            initializer: current.initializer,
          })
        }
      }
      if (
        ts.isBinaryExpression(current)
        && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(current.left)
      ) {
        assignments.push({ name: current.left.text, initializer: current.right })
      }
      if (ts.isCallExpression(current)) calls.push(current)
      ts.forEachChild(current, collect)
    }
    collect(scope)

    let changed = true
    while (changed) {
      changed = false
      for (const binding of [...bindings, ...assignments]) {
        if (
          !runtimeTargets.has(binding.name)
          && expressionIsRuntimeTarget(binding.initializer, runtimeTargets, statics)
        ) {
          runtimeTargets.add(binding.name)
          changed = true
        }
        if (!writerAliases.has(binding.name)) {
          const method = writerMethodFromExpression(binding.initializer, writerAliases, statics)
          if (method !== null) {
            writerAliases.set(binding.name, method)
            changed = true
          }
        }
        if (
          !fsNamespaces.has(binding.name)
          && ts.isIdentifier(binding.initializer)
          && fsNamespaces.has(binding.initializer.text)
        ) {
          fsNamespaces.add(binding.name)
          changed = true
        }
        if (!statics.has(binding.name)) {
          const value = staticStringValue(binding.initializer, statics)
          if (value !== null) {
            statics.set(binding.name, value)
            changed = true
          }
        }
      }
      for (const target of destructuredTargets) {
        if (!expressionIsRuntimeTarget(target.initializer, runtimeTargets, statics)) continue
        for (const name of target.names) {
          if (!runtimeTargets.has(name)) {
            runtimeTargets.add(name)
            changed = true
          }
        }
      }
      for (const binding of [...bindings, ...assignments]) {
        let initializer: ts.Expression = binding.initializer
        if (ts.isAwaitExpression(initializer)) initializer = initializer.expression
        if (!ts.isCallExpression(initializer)) continue
        const method = writerMethodFromExpression(initializer.expression, writerAliases, statics)
        if (method !== 'open' && method !== 'openSync') continue
        if (
          initializer.arguments.length > 0
          && expressionIsRuntimeTarget(initializer.arguments[0], runtimeTargets, statics)
          && !isReadonlyOpen(method, initializer, statics)
          && !fileHandles.has(binding.name)
        ) {
          fileHandles.add(binding.name)
          runtimeTargets.add(binding.name)
          changed = true
        }
      }
    }

    for (const call of calls) {
      if (approvedHelperContains(call)) continue
      const method = writerMethodFromExpression(call.expression, writerAliases, statics)
      if (method !== null) {
        const destinationIndex = RUNTIME_DESTINATION_INDEX.get(method) ?? -1
        if (
          destinationIndex >= 0
          && call.arguments.length > destinationIndex
          && expressionIsRuntimeTarget(call.arguments[destinationIndex], runtimeTargets, statics)
          && !isReadonlyOpen(method, call, statics)
        ) {
          const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1
          findings.add(`${scopeLabel(scope)}:${method}:${line}`)
          continue
        }
      }
      if (ts.isPropertyAccessExpression(call.expression)) {
        const receiver = call.expression.expression
        if (
          ts.isIdentifier(receiver)
          && fileHandles.has(receiver.text)
          && FILE_HANDLE_WRITE_METHODS.has(call.expression.name.text)
        ) {
          const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1
          findings.add(`${scopeLabel(scope)}:FileHandle.${call.expression.name.text}:${line}`)
          continue
        }
      }
      // Interprocedural propagation: a locally defined function receiving a
      // runtime-tainted argument is rescanned with that parameter tainted.
      if (ts.isIdentifier(call.expression) && functionIndex.has(call.expression.text)) {
        const taintedIndexes = new Set<number>()
        call.arguments.forEach((argument, index) => {
          if (expressionIsRuntimeTarget(argument, runtimeTargets, statics)) {
            taintedIndexes.add(index)
          }
        })
        if (taintedIndexes.size > 0) {
          for (const callee of functionIndex.get(call.expression.text) ?? []) {
            if (scannedInterprocedural.has(callee)) continue
            scannedInterprocedural.add(callee)
            scanScope(callee, writerAliases, new Set(), statics, taintedIndexes)
          }
        }
      }
    }

    for (const childScope of childScopes) {
      scanScope(childScope, writerAliases, runtimeTargets, statics)
    }
  }

  scanScope(sourceFile, new Map(), new Set(), new Map())
  return [...findings].sort()
}

describe('runtime.json writer hardening', () => {
  it('routes every production runtime.json write through the atomic 0600 helper', () => {
    const sourceRoot = path.join(process.cwd(), 'src')
    const helperPath = path.join(sourceRoot, 'server', 'swarm-foundation.ts')
    const unsafeWriters = productionTypeScriptFiles(sourceRoot)
      .filter((file) => file !== helperPath)
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8')
        return /writeFileSync\(\s*runtimePath/.test(source)
          || /renameSync\([^,]+,\s*runtimePath/.test(source)
          || /writeJsonAtomic\(\s*runtimePath/.test(source)
      })
      .map((file) => path.relative(process.cwd(), file))
      .sort()

    expect(unsafeWriters).toEqual([])
  })

  it('detects adversarial runtime-writer aliases and scope shapes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-writer-guard-'))
    const unsafeFixtures: Array<[string, string]> = [
      [
        'named-import-alias',
        `import { writeFileSync as save } from 'node:fs'
const stateFile = path.join(profilePath, 'runtime.json')
save(stateFile, '{}')\n`,
      ],
      [
        'destructured-require',
        `const { writeFileSync: save } = require('node:fs')
const stateFile = path.join(profilePath, 'runtime.json')
save(stateFile, '{}')\n`,
      ],
      [
        'local-writer-alias',
        `import fs from 'node:fs'
const save = fs.writeFileSync
function unsafe(profilePath) {
  const stateFile = path.join(profilePath, 'runtime.json')
  save(stateFile, '{}')
}\n`,
      ],
      [
        'arrow-function',
        `const unsafe = (profilePath) => {
  const stateFile = path.join(profilePath, 'runtime.json')
  fs.writeFileSync(stateFile, '{}')
}\n`,
      ],
      [
        'class-method',
        `class Unsafe {
  save(profilePath) {
    const stateFile = path.join(profilePath, 'runtime.json')
    fs.writeFileSync(stateFile, '{}')
  }
}\n`,
      ],
      [
        'fs-promises',
        `async function unsafe(profilePath) {
  const stateFile = path.join(profilePath, 'runtime.json')
  await fs.promises.writeFile(stateFile, '{}')
}\n`,
      ],
      [
        'write-stream',
        `function unsafe(profilePath) {
  const stateFile = path.join(profilePath, 'runtime.json')
  fs.createWriteStream(stateFile)
}\n`,
      ],
      [
        'reassigned-destination',
        `function unsafe(profilePath) {
  let destination
  destination = path.join(profilePath, 'runtime.json')
  fs.writeFileSync(destination, '{}')
}\n`,
      ],
      [
        'wrapped-destination',
        `function unsafe(profilePath) {
  const stateFile = path.join(profilePath, 'runtime.json')
  fs.writeFileSync(path.resolve(stateFile), '{}')
}\n`,
      ],
      [
        'computed-destination',
        `function unsafe(profilePath) {
  const fileName = 'runtime' + '.json'
  const stateFile = path.join(profilePath, fileName)
  fs.writeFileSync(stateFile, '{}')
}\n`,
      ],
      [
        'file-handle',
        `async function unsafe(profilePath) {
  const stateFile = path.join(profilePath, 'runtime.json')
  const handle = await fs.promises.open(stateFile, 'w')
  await handle.writeFile('{}')
}\n`,
      ],
      [
        'helper-prefix-bypass',
        `function writeSwarmRuntimeJsonAtomicUnsafe(profilePath) {
  const stateFile = path.join(profilePath, 'runtime.json')
  fs.writeFileSync(stateFile, '{}')
}\n`,
      ],
      [
        'namespace-destructured-alias',
        `import fs from 'node:fs'
const { writeFileSync: save } = fs
function unsafe(profilePath) {
  const stateFile = path.join(profilePath, 'runtime.json')
  save(stateFile, '{}')
}\n`,
      ],
      [
        'computed-writer-method',
        `function unsafe(profilePath) {
  const stateFile = path.join(profilePath, 'runtime.json')
  fs['write' + 'FileSync'](stateFile, '{}')
}\n`,
      ],
      [
        'fragmented-destination',
        `function unsafe(profilePath) {
  const base = 'runtime'
  const extension = '.json'
  const fileName = base + extension
  const stateFile = path.join(profilePath, fileName)
  fs.writeFileSync(stateFile, '{}')
}\n`,
      ],
      [
        'array-destructured-target',
        `function unsafe(profilePath) {
  const [stateFile] = [path.join(profilePath, 'runtime.json')]
  fs.writeFileSync(stateFile, '{}')
}\n`,
      ],
      [
        'stream-wrapper-interprocedural',
        `function openStream(outputPath) {
  return fs.createWriteStream(outputPath)
}
function unsafe(profilePath) {
  const stateFile = path.join(profilePath, 'runtime.json')
  openStream(stateFile).write('{}')
}\n`,
      ],
      [
        'file-handle-wrapper-interprocedural',
        `async function openTarget(destinationPath) {
  const handle = await fs.promises.open(destinationPath, 'w')
  await handle.writeFile('{}')
}
async function unsafe(profilePath) {
  const stateFile = path.join(profilePath, 'runtime.json')
  await openTarget(stateFile)
}\n`,
      ],
    ]

    try {
      for (const [name, source] of unsafeFixtures) {
        const fixturePath = path.join(tempDir, `${name}.mjs`)
        fs.writeFileSync(fixturePath, source)
        expect(runtimeWriterFindings(fixturePath), name).not.toEqual([])
      }

      const safePath = path.join(tempDir, 'safe.mjs')
      fs.writeFileSync(
        safePath,
        `function writeSafe(profilePath) {
  const stateFile = path.join(profilePath, 'runtime.json')
  writeSwarmRuntimeJsonAtomic(stateFile, {})
}\n`,
      )
      expect(runtimeWriterFindings(safePath)).toEqual([])
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true })
    }
  })

  it('ships no direct runtime.json writers in source, operational scripts, or Electron artifacts', () => {
    const sourceRoot = path.join(process.cwd(), 'src')
    const scriptsRoot = path.join(process.cwd(), 'scripts')
    const electronRoot = path.join(process.cwd(), 'electron')
    const bundlePath = path.join(electronRoot, 'server-bundle.cjs')
    const files = [
      ...productionTypeScriptFiles(sourceRoot),
      ...operationalJavaScriptFiles(scriptsRoot),
      ...operationalJavaScriptFiles(electronRoot),
    ]
    const findings = files.flatMap((file) =>
      runtimeWriterFindings(file).map(
        (finding) => `${path.relative(process.cwd(), file)}:${finding}`,
      ),
    )

    expect(fs.readFileSync(bundlePath, 'utf8')).toContain('writeSwarmRuntimeJsonAtomic')
    expect(findings).toEqual([])
  }, 30_000)
})