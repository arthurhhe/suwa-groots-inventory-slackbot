// Re-runs every live check against the configured accounts. Run with: npm run doctor
// Optional: DOCTOR_OTHER_ITEM_ID=<item id of an unrelated file> to confirm it is refused.

import { loadEnvFile } from "./lib/env";
import * as checks from "./lib/checks";

async function main(): Promise<void> {
  loadEnvFile();
  const results = [
    await checks.checkSlack(),
    await checks.checkAnthropic(),
    await checks.checkRedis(),
    await checks.checkMicrosoftToken(),
    await checks.checkWorkbookReadable(),
    await checks.checkWorkbookLayout(),
  ];
  if (process.env.DOCTOR_OTHER_ITEM_ID) {
    results.push(await checks.checkSingleFileScope(process.env.DOCTOR_OTHER_ITEM_ID));
  }
  const ok = checks.printResults(results);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
});
