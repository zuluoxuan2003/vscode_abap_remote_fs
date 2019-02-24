import { fromUri } from "../adt/AdtServer"
import {
  FileSystemError,
  FileChangeType,
  FileSystemProvider,
  EventEmitter,
  FileChangeEvent,
  Event,
  Uri,
  Disposable,
  FileStat,
  FileType
} from "vscode"
import { log } from "../logger"

export class FsProvider implements FileSystemProvider {
  private pEventEmitter = new EventEmitter<FileChangeEvent[]>()
  // tslint:disable-next-line:member-ordering
  public readonly onDidChangeFile: Event<FileChangeEvent[]> = this.pEventEmitter
    .event

  public watch(
    uri: Uri,
    options: { recursive: boolean; excludes: string[] }
  ): Disposable {
    return new Disposable(() => undefined)
  }

  public async stat(uri: Uri): Promise<FileStat> {
    // no .* files allowed here, no need to log that
    if (uri.path.match(/(^\.)|(\/\.)/)) throw FileSystemError.FileNotFound(uri)
    try {
      const server = fromUri(uri)
      if (uri.path === "/") {
        return server.findNode(uri)
      }
      return await server.stat(uri)
    } catch (e) {
      log(`Error in stat of ${uri.toString()}\n${e.toString()}`)
      throw e
    }
  }

  public async readDirectory(uri: Uri): Promise<Array<[string, FileType]>> {
    try {
      const server = fromUri(uri)
      const dir = server.findNode(uri)
      await server.refreshDirIfNeeded(dir)
      const contents = [...dir].map(
        ([name, node]) => [name, node.type] as [string, FileType]
      )
      return contents
    } catch (e) {
      log(`Error reading directory ${uri.toString()}\n${e.toString()}`)
      throw e
    }
  }

  public createDirectory(uri: Uri): void | Thenable<void> {
    throw FileSystemError.NoPermissions(
      "Not a real filesystem, directory creation is not supported"
    )
  }

  public async readFile(uri: Uri): Promise<Uint8Array> {
    const server = fromUri(uri)
    const file = await server.findNodePromise(uri)

    try {
      if (file && !file.isFolder) return await file.fetchContents(server.client)
    } catch (error) {
      log(`Error reading file ${uri.toString()}\n${error.toString()}`)
    }
    throw FileSystemError.Unavailable(uri)
  }

  public async writeFile(
    uri: Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    try {
      const server = fromUri(uri)
      const file = server.findNode(uri)
      if (!file && options.create)
        throw FileSystemError.NoPermissions(
          "Not a real filesystem, file creation is not supported"
        )
      if (!file) throw FileSystemError.FileNotFound(uri)
      await server.saveFile(file, content)
      this.pEventEmitter.fire([{ type: FileChangeType.Changed, uri }])
    } catch (e) {
      log(`Error writing file ${uri.toString()}\n${e.toString()}`)
      throw e
    }
  }

  public async delete(uri: Uri, options: { recursive: boolean }) {
    try {
      const server = fromUri(uri)
      await server.delete(uri)
    } catch (e) {
      log(`Error deleting file ${uri.toString()}\n${e.toString()}`)
      throw e
    }
  }

  public rename(
    oldUri: Uri,
    newUri: Uri,
    options: { overwrite: boolean }
  ): void | Thenable<void> {
    throw new Error("Method not implemented.")
  }
}