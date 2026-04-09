function escapeCell(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows) {
  const header = ["timestamp", "site", "category", "action", "country"];
  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        escapeCell(row.timestamp),
        escapeCell(row.site),
        escapeCell(row.category),
        escapeCell(row.action),
        escapeCell(row.country),
      ].join(",")
    );
  }

  return lines.join("\n");
}

module.exports = { toCsv };
