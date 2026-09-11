/**
 * /export — the calling user's transactions for the current year, as a CSV
 * document sent into the chat.
 *
 * It used to write the file to the server's disk and reply with a server
 * path, which the user could never open — and on Vercel the filesystem is
 * read-only, so the write would fail outright.
 */

import { CsvExport, exportCSV } from '../../expense';

export async function handleExportCommand(userId: string): Promise<CsvExport> {
  return exportCSV(userId, new Date().getFullYear());
}
