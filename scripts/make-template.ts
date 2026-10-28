// Writes a starter workbook in the layout the bot expects. Run with: npm run make-template
// Upload the result to OneDrive for Business or SharePoint, then run npm run setup.

import ExcelJS from "exceljs";
import path from "node:path";

async function main(): Promise<void> {
  const out = path.join(process.cwd(), "inventory-template.xlsx");
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Inventory");

  sheet.getCell("A1").value = "low-inventory-slack-ids-to-tag: @your-handle";
  sheet.getRow(2).values = ["Item", "Threshold", "West Coast", "East Coast", "Southwest"];
  sheet.getRow(2).font = { bold: true };
  sheet.addRow(["Bolts", 10, 50, 12, 30]);
  sheet.addRow(["Widgets", 5, 20, 7, 9]);
  sheet.getColumn(1).width = 28;
  sheet.getRow(2).eachCell((cell) => (cell.border = { bottom: { style: "thin" } }));

  await wb.xlsx.writeFile(out);
  console.log(`Wrote ${out}`);
  console.log("Upload it to OneDrive for Business or SharePoint, then edit A1 to name the people to tag.");
}

main().catch((err) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
});
