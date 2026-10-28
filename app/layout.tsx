export const metadata = {
  title: "Inventory Slack Bot",
  description: "Updates the inventory workbook from Slack and posts low-stock alerts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
