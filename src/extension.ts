import * as vscode from "vscode"
import * as ts from "typescript"
import * as prettier from "prettier"

export const activate = (context: vscode.ExtensionContext) => {
  const state = {
    content: "",
    changeTextSub: null as vscode.Disposable | null,
    changeActiveSub: null as vscode.Disposable | null,
  }

  const resultUri = vscode.Uri.parse(
    "ts-reveal-types://authority/revealed.d.ts"
  )

  const onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>()

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("ts-reveal-types", {
      onDidChange: onDidChangeEmitter.event,
      provideTextDocumentContent: () => state.content,
    }),

    vscode.commands.registerCommand("ts-reveal-types.yourCommand", async () => {
      // vscode.window.showInformationMessage("called command")

      // normal import complains lack of esModuleInterop, but if I allow it, it breaks other stuff
      const debounce = await import("lodash.debounce")

      const targetEditor = vscode.window.activeTextEditor
      if (!targetEditor) {
        vscode.window.showWarningMessage("No active editor to analyse")
        return
      }

      state.content = analyze(
        targetEditor.document.fileName,
        targetEditor.document.getText()
      )
      onDidChangeEmitter.fire(resultUri)

      const outputDoc = await vscode.workspace.openTextDocument(resultUri)
      await vscode.window.showTextDocument(outputDoc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: true,
      })

      const subscribe = () =>
        vscode.workspace.onDidChangeTextDocument(
          debounce(event => {
            // vscode.window.showInformationMessage("changed text document")

            if (
              event.document === vscode.window.activeTextEditor?.document &&
              event.document.languageId === "typescript"
            ) {
              state.content = analyze(
                targetEditor.document.fileName,
                targetEditor.document.getText()
              )
              onDidChangeEmitter.fire(resultUri)
            }
          }, 1000)
        )

      state.changeTextSub = subscribe()

      state.changeActiveSub = vscode.window.onDidChangeActiveTextEditor(
        editor => {
          // vscode.window.showInformationMessage("changed active text editor")

          if (editor?.document === targetEditor.document) {
            state.changeTextSub?.dispose()
            state.changeTextSub = subscribe()
          } else {
            state.changeTextSub?.dispose()
            state.changeTextSub = null
          }
        }
      )

      const changeVisibleSub = vscode.window.onDidChangeVisibleTextEditors(
        () => {
          vscode.window.showInformationMessage("changed visible text editors")

          // when either the ouput document or the target document is closed, dispose the subscriptions
          if (targetEditor.document.isClosed || outputDoc.isClosed) {
            // vscode.window.showInformationMessage("disposing subscriptions")
            state.changeTextSub?.dispose()
            state.changeTextSub = null
            state.changeActiveSub?.dispose()
            state.changeActiveSub = null
            changeVisibleSub.dispose()
          }
        }
      )
    })
  )
}

const analyze = (fileName: string, sourceCode: string) => {
  // Create a compiler host that serves a virtual copy of the file,
  // so the command can work with content on editor instead of on disk
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )

  const compilerHost = ts.createCompilerHost({}, true)
  const originalGetSourceFile = compilerHost.getSourceFile
  compilerHost.getSourceFile = (requested, ...args) =>
    requested === fileName
      ? sourceFile
      : originalGetSourceFile.call(compilerHost, requested, ...args)

  const program = ts.createProgram([fileName], {}, compilerHost)
  const checker = program.getTypeChecker()

  return prettier.format(
    getTypeDeclarations(
      program.getSourceFile(fileName)!,
      checker
    ).join("\n\n"),
    {
      parser: "typescript",
      semi: false,
    }
  )
}

const getTypeDeclarations = (
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
) =>
  sourceFile
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
