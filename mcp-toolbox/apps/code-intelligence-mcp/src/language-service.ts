export interface SourcePosition {
  workspaceRoot: string;
  file: string;
  line: number;
  column: number;
}

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface SymbolQuery {
  workspaceRoot: string;
  file: string;
  limit: number;
}

export interface SourceSymbol extends SourceLocation {
  name: string;
  kind: string;
}

export interface SymbolResult {
  symbols: readonly SourceSymbol[];
  truncated: boolean;
}

export interface WorkspaceSymbolQuery {
  workspaceRoot: string;
  file?: string;
  query: string;
  limit: number;
}

export interface ReferenceQuery extends SourcePosition {
  limit: number;
}

export interface LocationResult {
  locations: readonly SourceLocation[];
  truncated: boolean;
}

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface SourceDiagnostic extends SourceLocation {
  severity: DiagnosticSeverity;
  code: number;
  message: string;
}

export interface DiagnosticResult {
  diagnostics: readonly SourceDiagnostic[];
  truncated: boolean;
}

export interface LanguageServiceAdapter {
  findDefinition(query: SourcePosition, signal?: AbortSignal): Promise<readonly SourceLocation[]>;
  documentSymbols(query: SymbolQuery, signal?: AbortSignal): Promise<SymbolResult>;
  workspaceSymbols(query: WorkspaceSymbolQuery, signal?: AbortSignal): Promise<SymbolResult>;
  findReferences(query: ReferenceQuery, signal?: AbortSignal): Promise<LocationResult>;
  diagnostics(query: SymbolQuery, signal?: AbortSignal): Promise<DiagnosticResult>;
}
