import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import ts from "typescript";

import type {
  DiagnosticResult,
  DiagnosticSeverity,
  LanguageServiceAdapter,
  LocationResult,
  ReferenceQuery,
  SourceLocation,
  SourcePosition,
  SourceSymbol,
  SymbolQuery,
  SymbolResult,
  WorkspaceSymbolQuery,
} from "./language-service.js";

function diagnosticSeverity(category: ts.DiagnosticCategory): DiagnosticSeverity {
  switch (category) {
    case ts.DiagnosticCategory.Error: return "error";
    case ts.DiagnosticCategory.Warning: return "warning";
    case ts.DiagnosticCategory.Suggestion: return "hint";
    default: return "information";
  }
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isDependencyPath(root: string, target: string): boolean {
  return relative(root, target).split(/[\\/]/).includes("node_modules");
}

function realPathWithin(root: string, target: string): boolean {
  try {
    return isWithin(realpathSync(root), realpathSync(target));
  } catch {
    return false;
  }
}

function findConfigPath(workspaceRoot: string, fileName: string): string | undefined {
  let directory = dirname(fileName);
  while (isWithin(workspaceRoot, directory)) {
    const candidate = resolve(directory, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (directory === workspaceRoot) break;
    directory = dirname(directory);
  }
  return undefined;
}

export class TypeScriptLanguageService implements LanguageServiceAdapter {
  async diagnostics(query: SymbolQuery, signal?: AbortSignal): Promise<DiagnosticResult> {
    const { service, fileName, workspaceRoot, dispose } = this.openProject(query, signal);
    try {
      abortIfRequested(signal);
      const diagnostics = [
        ...service.getSyntacticDiagnostics(fileName),
        ...service.getSemanticDiagnostics(fileName),
      ];
      abortIfRequested(signal);
      const byDiagnostic = new Map<string, DiagnosticResult["diagnostics"][number]>();
      for (const diagnostic of diagnostics) {
        abortIfRequested(signal);
        if (!diagnostic.file || diagnostic.start === undefined || diagnostic.length === undefined) continue;
        const diagnosticFile = resolve(diagnostic.file.fileName);
        if (!isWithin(workspaceRoot, diagnosticFile) || isDependencyPath(workspaceRoot, diagnosticFile)) continue;
        const start = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        const end = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start + diagnostic.length);
        const normalized = {
          severity: diagnosticSeverity(diagnostic.category),
          code: diagnostic.code,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          file: relative(workspaceRoot, diagnosticFile).replaceAll("\\", "/"),
          line: start.line + 1,
          column: start.character + 1,
          endLine: end.line + 1,
          endColumn: end.character + 1,
        } as const;
        byDiagnostic.set(`${normalized.file}:${diagnostic.start}:${diagnostic.length}:${normalized.severity}:${normalized.code}:${normalized.message}`, normalized);
      }
      const normalized = [...byDiagnostic.values()];
      normalized.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0) || left.line - right.line || left.column - right.column || left.endLine - right.endLine || left.endColumn - right.endColumn || left.severity.localeCompare(right.severity) || left.code - right.code || left.message.localeCompare(right.message));
      return { diagnostics: normalized.slice(0, query.limit), truncated: normalized.length > query.limit };
    } finally {
      dispose();
    }
  }

  async findReferences(query: ReferenceQuery, signal?: AbortSignal): Promise<LocationResult> {
    const { service, fileName, workspaceRoot, dispose } = this.openProject(query, signal);
    try {
      const sourceFile = service.getProgram()?.getSourceFile(fileName);
      if (!sourceFile) throw new Error(`Source file is not part of the TypeScript project: ${query.file}`);
      const lineStarts = sourceFile.getLineStarts();
      if (query.line > lineStarts.length) throw new Error("Source position is outside the file");
      const lineStart = lineStarts[query.line - 1]!;
      const lineEnd = sourceFile.getLineEndOfPosition(lineStart);
      if (query.column - 1 > lineEnd - lineStart) throw new Error("Source position is outside the file");

      const position = sourceFile.getPositionOfLineAndCharacter(query.line - 1, query.column - 1);
      abortIfRequested(signal);
      const references = service.getReferencesAtPosition(fileName, position) ?? [];
      abortIfRequested(signal);
      const locations: SourceLocation[] = [];
      for (const reference of references) {
        abortIfRequested(signal);
        const referenceFile = resolve(reference.fileName);
        if (!isWithin(workspaceRoot, referenceFile) || isDependencyPath(workspaceRoot, referenceFile)) continue;
        const target = service.getProgram()?.getSourceFile(reference.fileName);
        if (!target) continue;
        const start = target.getLineAndCharacterOfPosition(reference.textSpan.start);
        const end = target.getLineAndCharacterOfPosition(reference.textSpan.start + reference.textSpan.length);
        locations.push({
          file: relative(workspaceRoot, referenceFile).replaceAll("\\", "/"),
          line: start.line + 1,
          column: start.character + 1,
          endLine: end.line + 1,
          endColumn: end.character + 1,
        });
      }
      locations.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0) || left.line - right.line || left.column - right.column || left.endLine - right.endLine || left.endColumn - right.endColumn);
      return { locations: locations.slice(0, query.limit), truncated: locations.length > query.limit };
    } finally {
      dispose();
    }
  }

  async workspaceSymbols(query: WorkspaceSymbolQuery, signal?: AbortSignal): Promise<SymbolResult> {
    abortIfRequested(signal);
    const workspaceRoot = resolve(query.workspaceRoot);
    const projectSources = query.file ? [query.file] : this.projectSources(workspaceRoot);
    const byLocation = new Map<string, SourceSymbol>();
    for (const file of projectSources) {
      const { service, dispose } = this.openProject({ workspaceRoot, file }, signal);
      try {
        abortIfRequested(signal);
        const items = service.getNavigateToItems(query.query, undefined, undefined, true, true);
        for (const item of items) {
          abortIfRequested(signal);
          const itemFile = resolve(item.fileName);
          if (!isWithin(workspaceRoot, itemFile) || isDependencyPath(workspaceRoot, itemFile)) continue;
          const sourceFile = service.getProgram()?.getSourceFile(item.fileName);
          if (!sourceFile) continue;
          const start = sourceFile.getLineAndCharacterOfPosition(item.textSpan.start);
          const end = sourceFile.getLineAndCharacterOfPosition(item.textSpan.start + item.textSpan.length);
          const symbol: SourceSymbol = {
            name: item.name,
            kind: item.kind,
            file: relative(workspaceRoot, itemFile).replaceAll("\\", "/"),
            line: start.line + 1,
            column: start.character + 1,
            endLine: end.line + 1,
            endColumn: end.character + 1,
          };
          byLocation.set(`${symbol.file}:${item.textSpan.start}:${item.textSpan.length}:${symbol.name}:${symbol.kind}`, symbol);
        }
      } finally {
        dispose();
      }
    }
    const symbols = [...byLocation.values()];
    symbols.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.name.localeCompare(right.name));
    return { symbols: symbols.slice(0, query.limit), truncated: symbols.length > query.limit };
  }

  async documentSymbols(query: SymbolQuery, signal?: AbortSignal): Promise<SymbolResult> {
    const { service, fileName, workspaceRoot, dispose } = this.openProject(query, signal);
    try {
      const sourceFile = service.getProgram()?.getSourceFile(fileName);
      if (!sourceFile) throw new Error(`Source file is not part of the TypeScript project: ${query.file}`);
      const tree = service.getNavigationTree(fileName);
      const symbols: Array<SourceSymbol & { position: number }> = [];

      const visit = (items: readonly ts.NavigationTree[]): void => {
        for (const item of items) {
          abortIfRequested(signal);
          if (item.spans[0] && item.kind !== ts.ScriptElementKind.moduleElement) {
            const span = item.spans[0];
            const start = sourceFile.getLineAndCharacterOfPosition(span.start);
            const end = sourceFile.getLineAndCharacterOfPosition(span.start + span.length);
            symbols.push({
              name: item.text,
              kind: item.kind,
              file: relative(workspaceRoot, fileName).replaceAll("\\", "/"),
              line: start.line + 1,
              column: start.character + 1,
              endLine: end.line + 1,
              endColumn: end.character + 1,
              position: span.start,
            });
          }
          if (item.childItems) visit(item.childItems);
        }
      };

      visit(tree.childItems ?? []);
      symbols.sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
      const truncated = symbols.length > query.limit;
      return { symbols: symbols.slice(0, query.limit).map(({ position: _position, ...symbol }) => symbol), truncated };
    } finally {
      dispose();
    }
  }

  async findDefinition(query: SourcePosition, signal?: AbortSignal): Promise<readonly SourceLocation[]> {
    const { service, fileName, workspaceRoot, dispose } = this.openProject(query, signal);
    try {
      const sourceFile = service.getProgram()?.getSourceFile(fileName);
      if (!sourceFile) throw new Error(`Source file is not part of the TypeScript project: ${query.file}`);
      const lineStarts = sourceFile.getLineStarts();
      if (query.line > lineStarts.length) throw new Error("Source position is outside the file");
      const lineStart = lineStarts[query.line - 1]!;
      const lineEnd = sourceFile.getLineEndOfPosition(lineStart);
      if (query.column - 1 > lineEnd - lineStart) throw new Error("Source position is outside the file");

      const position = sourceFile.getPositionOfLineAndCharacter(query.line - 1, query.column - 1);
      abortIfRequested(signal);
      const definitions = service.getDefinitionAtPosition(fileName, position) ?? [];
      abortIfRequested(signal);

      const locations: SourceLocation[] = [];
      for (const definition of definitions) {
        const definitionFile = resolve(definition.fileName);
        if (!isWithin(workspaceRoot, definitionFile) || isDependencyPath(workspaceRoot, definitionFile)) continue;
        const target = service.getProgram()?.getSourceFile(definition.fileName);
        if (!target) continue;
        const start = target.getLineAndCharacterOfPosition(definition.textSpan.start);
        const end = target.getLineAndCharacterOfPosition(definition.textSpan.start + definition.textSpan.length);
        locations.push({
          file: relative(workspaceRoot, definitionFile).replaceAll("\\", "/"),
          line: start.line + 1,
          column: start.character + 1,
          endLine: end.line + 1,
          endColumn: end.character + 1,
        });
      }
      return locations;
    } finally {
      dispose();
    }
  }

  private openProject(query: { workspaceRoot: string; file: string }, signal?: AbortSignal) {
    abortIfRequested(signal);
    const workspaceRoot = resolve(query.workspaceRoot);
    const fileName = resolve(workspaceRoot, query.file);
    if (!isWithin(workspaceRoot, fileName)) throw new Error("Source file is outside the workspace");
    if (!existsSync(fileName)) throw new Error(`Source file does not exist: ${query.file}`);
    if (!realPathWithin(workspaceRoot, fileName)) throw new Error("Source file resolves outside the workspace");

    const configPath = findConfigPath(workspaceRoot, fileName);
    if (!configPath || !realPathWithin(workspaceRoot, configPath)) {
      throw new Error(`No tsconfig.json found within workspace for ${query.file}`);
    }

    const configFile = ts.readConfigFile(configPath, (path) => readFileSync(path, "utf8"));
    if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
    const compilerLibRoot = realpathSync(dirname(ts.getDefaultLibFilePath({})));
    const canRead = (path: string): boolean => realPathWithin(workspaceRoot, path) || realPathWithin(compilerLibRoot, path);
    const parseHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      fileExists: (path) => canRead(path) && ts.sys.fileExists(path),
      readFile: (path) => canRead(path) ? ts.sys.readFile(path) : undefined,
      readDirectory: (path, extensions, excludes, includes, depth) => {
        if (!canRead(path)) return [];
        return ts.sys.readDirectory(path, extensions, excludes, includes, depth).filter((entry) => canRead(entry));
      },
    };
    const config = ts.parseJsonConfigFileContent(configFile.config, parseHost, dirname(configPath));
    if (config.errors.length > 0) {
      throw new Error(ts.flattenDiagnosticMessageText(config.errors[0]!.messageText, "\n"));
    }
    if (config.fileNames.some((name) => !realPathWithin(workspaceRoot, name))) {
      throw new Error("TypeScript project file is outside the workspace");
    }

    const versions = new Map(config.fileNames.map((name) => [name, "0"]));
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => config.options,
      getScriptFileNames: () => config.fileNames,
      getScriptVersion: (name) => versions.get(name) ?? "0",
      getScriptSnapshot: (name) => {
        if (!canRead(name) || !existsSync(name)) return undefined;
        return ts.ScriptSnapshot.fromString(readFileSync(name, "utf8"));
      },
      getCurrentDirectory: () => dirname(configPath),
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (path) => canRead(path) && ts.sys.fileExists(path),
      readFile: (path) => canRead(path) ? ts.sys.readFile(path) : undefined,
      readDirectory: (path, extensions, excludes, includes, depth) => {
        if (!canRead(path)) return [];
        return ts.sys.readDirectory(path, extensions, excludes, includes, depth).filter((entry) => canRead(entry));
      },
      directoryExists: (path) => canRead(path) && (ts.sys.directoryExists?.(path) ?? false),
      getDirectories: (path) => canRead(path) ? (ts.sys.getDirectories?.(path) ?? []).filter((entry) => canRead(resolve(path, entry))) : [],
    };

    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    return { service, fileName, workspaceRoot, dispose: () => service.dispose() };
  }

  private projectSources(workspaceRoot: string): string[] {
    const configs = ts.sys.readDirectory(workspaceRoot, [".json"], ["**/node_modules/**", "**/dist/**"], ["**/tsconfig.json"])
      .filter((path) => realPathWithin(workspaceRoot, path));
    const canRead = (path: string): boolean => realPathWithin(workspaceRoot, path);
    const parseHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      fileExists: (path) => canRead(path) && ts.sys.fileExists(path),
      readFile: (path) => canRead(path) ? ts.sys.readFile(path) : undefined,
      readDirectory: (path, extensions, excludes, includes, depth) => {
        if (!canRead(path)) return [];
        return ts.sys.readDirectory(path, extensions, excludes, includes, depth).filter((entry) => canRead(entry));
      },
    };
    const sources: string[] = [];
    for (const configPath of configs) {
      const configFile = ts.readConfigFile(configPath, (path) => canRead(path) ? readFileSync(path, "utf8") : undefined);
      if (configFile.error) continue;
      const parsed = ts.parseJsonConfigFileContent(configFile.config, parseHost, dirname(configPath));
      if (parsed.errors.length > 0 || parsed.fileNames.some((name) => !canRead(name))) continue;
      const source = parsed.fileNames.find((name) => realPathWithin(workspaceRoot, name));
      if (source) sources.push(relative(workspaceRoot, source));
    }
    if (sources.length === 0) throw new Error("No TypeScript projects found within workspace");
    return sources;
  }
}
