export { SQLITE_PRAGMAS, SCHEMA_VERSION, SCHEMA_NAME, DDL_STATEMENTS, DDL } from './ddl.ts'

export {
  assertNativeBindingAvailable,
  loadBetterSqlite3,
  nativeBindingPath,
  openDatabase,
  setNativePackageRoot,
} from './native.ts'

export { applyPragmas, closeAllIndexDbs, closeIndexDb, openIndexDb } from './db.ts'
export type { OpenIndexDbOptions } from './db.ts'

export { MIGRATIONS, applyMigrations, checksumOf, ensureMigrationsTable, readSchemaVersion } from './migrations.ts'
export type { Migration } from './migrations.ts'

export { createEmptyIndexDb, describeIndexDb, dropIndexDb, indexDbFiles } from './rebuild.ts'
export type { IndexDbStatus } from './rebuild.ts'

export { buildMatchQuery, searchMessages, segmentForFts } from './fts.ts'
export type { SearchHit, SearchOptions } from './fts.ts'

export { applyProjection, digestArgs, extractVisibleText, projectSession } from './project.ts'
export type {
  CheckpointRow,
  EventRow,
  FileChangeRow,
  LogIndexRow,
  MessageRow,
  ProjectedSession,
  ProjectionInput,
  SessionRow,
  SessionStatus,
  StepRow,
  ToolCallRow,
  ToolCallStatus,
  TurnRow,
} from './project.ts'

export { SessionIndexWriter } from './index-writer.ts'
export type { IndexWriterOptions } from './index-writer.ts'

export { rebuildIndex } from './index-rebuild.ts'
export type { RebuildOptions, RebuildReport, SkippedSession } from './index-rebuild.ts'
