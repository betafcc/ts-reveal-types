import * as vscode from "vscode"
import * as ts from "typescript"
import * as prettier from "prettier"

export async function activate(context: vscode.ExtensionContext) {
  // normal import complains lack of esModuleInterop, but if I allow it, it breaks other stuff
  const debounce = await import("lodash.debounce")

  const contentMap = new Map<string, string>()
  const subscription = {
    sourceChange: null as null | vscode.Disposable,
    activeTextEditor: null as null | vscode.Disposable,
    changeVisibleTextEditors: null as null | vscode.Disposable,
  }

  const outputChangeEmitter = new vscode.EventEmitter<vscode.Uri>()

  const subscribeSourceChange = () =>
    vscode.workspace.onDidChangeTextDocument(
      debounce(async event => {
        const uri = event.document.uri
        if (!contentMap.has(uri.path)) return

        contentMap.set(uri.path, revealTypes(event.document.fileName, event.document.getText()))
        outputChangeEmitter.fire(uri.with({ scheme: "ts-reveal-types" }))
      }, 1000)
    )

  const subscribeActiveTextEditorChange = () =>
    vscode.window.onDidChangeActiveTextEditor(async event => {
      if (!event?.document || !contentMap.has(event.document.uri.path)) {
        subscription.sourceChange?.dispose()
        subscription.sourceChange = null
      } else if (subscription.sourceChange === null) {
        subscription.sourceChange = subscribeSourceChange()
      }
    })

  const subscribeChangeVisibleTextEditors = () =>
    vscode.window.onDidChangeVisibleTextEditors(async () => {
      const stillOpen = new Set(vscode.workspace.textDocuments.map(doc => doc.uri.path))

      for (const path of contentMap.keys()) if (!stillOpen.has(path)) contentMap.delete(path)

      if (contentMap.size === 0) {
        subscription.activeTextEditor?.dispose()
        subscription.activeTextEditor = null

        subscription.changeVisibleTextEditors?.dispose()
        subscription.changeVisibleTextEditors = null

        subscription.sourceChange?.dispose()
        subscription.sourceChange = null
      }
    })

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("ts-reveal-types", {
      onDidChange: outputChangeEmitter.event,
      provideTextDocumentContent(uri) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return contentMap.get(uri.path)!
      },
    }),

    vscode.commands.registerTextEditorCommand("ts-reveal-types.revealTypes", async editor => {
      const uri = editor.document.uri
      if (contentMap.has(uri.path)) return

      if (subscription.sourceChange === null) subscription.sourceChange = subscribeSourceChange()
      if (subscription.activeTextEditor === null) subscription.activeTextEditor = subscribeActiveTextEditorChange()
      if (subscription.changeVisibleTextEditors === null)
        subscription.changeVisibleTextEditors = subscribeChangeVisibleTextEditors()

      contentMap.set(uri.path, revealTypes(editor.document.fileName, editor.document.getText()))

      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(uri.with({ scheme: "ts-reveal-types" })),
        {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false,
          preserveFocus: true,
        }
      )
    })
  )
}

const revealTypes = (fileName: string, sourceCode: string) => {
  // Create a compiler host that serves a virtual copy of the file,
  // so the command can work with changes on editor instead of on disk
  const sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const compilerHost = ts.createCompilerHost({}, true)
  const originalGetSourceFile = compilerHost.getSourceFile
  compilerHost.getSourceFile = (requested, ...args) =>
    requested === fileName ? sourceFile : originalGetSourceFile.call(compilerHost, requested, ...args)

  const program = ts.createProgram([fileName], {}, compilerHost)
  const checker = program.getTypeChecker()

  const typeDeclarations = sourceFile
    .getChildren()
    .flatMap(c => c.getChildren())
    .filter(ts.isTypeAliasDeclaration)
    .map(
      c =>
        c.getText().slice(0, c.getText().lastIndexOf(c.type.getText())) +
        checker.typeToString(
          checker.getTypeAtLocation(c.type),
          undefined,
          ts.TypeFormatFlags.InTypeAlias | ts.TypeFormatFlags.NoTruncation
        )
    )

  return prettier.format(typeDeclarations.join("\n\n"), {
    parser: "typescript",
    semi: false,
  })
}

// const transformUri = (uri: vscode.Uri) =>
//   uri.with({
//     scheme: "ts-reveal-types",
//     path: uri.path.replace(/(.ts){0,1}$/, '.d.ts')
//   })
