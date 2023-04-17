import * as vscode from "vscode"
import * as ts from "typescript"
import * as prettier from "prettier"
import { debounce } from "lodash"

type AnyKey = string | number | symbol

class TwoKeysRecord<KA extends AnyKey, KB extends AnyKey, V> {
  static create() {
    return new this({}, {})
  }

  constructor(readonly left: Record<KA, { right: KB; value: V }>, readonly right: Record<KB, { left: KA; value: V }>) {}

  set(left: KA, right: KB, value: V) {
    this.left[left] = { right, value }
    this.right[right] = { left, value }
  }

  delete(key: { left: KA } | { right: KB } | { left: KA; right: KB }) {
    if ("left" in key) {
      delete this.right[this.left[key.left].right]
      delete this.left[key.left]
    } else if ("right" in key) {
      delete this.left[this.right[key.right].left]
      delete this.right[key.right]
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const targetEmitter = new vscode.EventEmitter<vscode.Uri>()
  // TwoKeysRecord<source Uri, target Uri, target content>
  const docs: TwoKeysRecord<string, string, string> = TwoKeysRecord.create()
  const subs = {
    source: null as null | vscode.Disposable,
    active: null as null | vscode.Disposable,
    visible: null as null | vscode.Disposable,
  }

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("ts-reveal-types.revealTypes", async editor => {
      const source = editor.document.uri.toString()

      if (source in docs.left) return

      const target = transformUri(editor.document.uri).toString()

      docs.set(source, target, reveal(editor.document))

      if (subs.source === null) subs.source = onSource()
      if (subs.active === null) subs.active = onActive()
      if (subs.visible === null) subs.visible = onTab()

      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.parse(target)), {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: true,
      })
    })
  )

  const onSource = () =>
    vscode.workspace.onDidChangeTextDocument(
      debounce(async (event: vscode.TextDocumentChangeEvent) => {
        const source = event.document.uri.toString()
        if (!(source in docs.left)) return

        docs.set(source, docs.left[source].right, reveal(event.document))

        targetEmitter.fire(vscode.Uri.parse(docs.left[source].right))
      }, 1000)
    )

  const onActive = () =>
    vscode.window.onDidChangeActiveTextEditor(async event => {
      const source = event?.document.uri.toString()

      if (!source || !(source in docs.left)) {
        subs.source?.dispose()
        subs.source = null
      } else if (subs.source === null) {
        subs.source = onSource()
      }
    })

  const onTab = () =>
    "tabGroups" in vscode.window && "onDidChangeTabs" in vscode.window.tabGroups
      ? vscode.window.tabGroups.onDidChangeTabs(async event => {
          for (const tab of event.closed) {
            if (tab.input instanceof vscode.TabInputText) {
              const target = tab.input.uri.toString()
              if (target in docs.right) docs.delete({ right: target })
            }
          }

          if (Object.keys(docs.right).length === 0) {
            subs.active?.dispose()
            subs.active = null
            subs.visible?.dispose()
            subs.visible = null
            subs.source?.dispose()
            subs.source = null
          }
        })
      : {
          dispose: () => null,
        }

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("ts-reveal-types", {
      onDidChange: targetEmitter.event,
      provideTextDocumentContent(uri) {
        return docs.right[uri.toString()].value
      },
    })
  )
}

const reveal = (doc: vscode.TextDocument) => revealFromSource(doc.fileName, doc.getText())

const revealFromSource = (fileName: string, sourceCode: string) => {
  // Create a compiler host that serves a virtual copy of the file,
  // so it works with content on editor instead of on disk
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

const transformUri = (uri: vscode.Uri) =>
  uri.with({
    scheme: "ts-reveal-types",
    path: uri.path.replace(/(.tsx?){0,1}$/, ".d.ts"),
  })
