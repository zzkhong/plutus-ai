/**
 * /export command handler
 */

import { exportCSV } from '../../expense';

export async function handleExportCommand(userId: string): Promise<string> {
  const filePath = await exportCSV(userId, new Date().getFullYear());
  return `CSV export created: ${filePath}`;
}
