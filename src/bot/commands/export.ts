/**
 * /export command handler
 */

import { exportCSV } from '../../expense';

export async function handleExportCommand(): Promise<string> {
  const filePath = await exportCSV(new Date().getFullYear());
  return `CSV export created: ${filePath}`;
}
