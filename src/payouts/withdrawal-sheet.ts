import ExcelJS from "exceljs";

/** The payment sheet handed to the accounts team, and the parser for the
 * sheet they hand back. Rows are keyed by "Withdrawal ID" on the way back, so
 * the layout can be tweaked without breaking import as long as that header and
 * the result headers keep their names. */

export type SheetRow = {
  withdrawalId: string;
  requestedAt: Date;
  creatorName: string;
  creatorPhone: string;
  creatorEmail: string;
  accountHolderName: string;
  methodType: string;
  /** Full account number or UPI ID (already decrypted by the caller). */
  account: string;
  ifscCode: string;
  bankName: string;
  panNumber: string;
  netPaise: number;
};

const H = {
  id: "Withdrawal ID",
  requested: "Requested on",
  name: "Creator name",
  phone: "Creator phone",
  email: "Creator email",
  holder: "Account holder name",
  method: "Method",
  account: "Account number / UPI ID",
  ifsc: "IFSC",
  bank: "Bank name",
  pan: "PAN",
  amount: "Amount to pay (₹)",
  paid: "Paid? (Y/N)",
  utr: "UTR / reference",
  paidDate: "Paid date",
  remarks: "Remarks",
} as const;

export const RESULT_HEADERS = { id: H.id, amount: H.amount, paid: H.paid, utr: H.utr, remarks: H.remarks };

export async function buildWithdrawalWorkbook(rows: SheetRow[], title: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Halchal";
  wb.created = new Date();
  const ws = wb.addWorksheet("Payments", { views: [{ state: "frozen", ySplit: 1 }] });

  ws.columns = [
    { header: H.id, key: "id", width: 28 },
    { header: H.requested, key: "requested", width: 18 },
    { header: H.name, key: "name", width: 24 },
    { header: H.phone, key: "phone", width: 16 },
    { header: H.email, key: "email", width: 26 },
    { header: H.holder, key: "holder", width: 26 },
    { header: H.method, key: "method", width: 10 },
    { header: H.account, key: "account", width: 26, style: { numFmt: "@" } },
    { header: H.ifsc, key: "ifsc", width: 14 },
    { header: H.bank, key: "bank", width: 20 },
    { header: H.pan, key: "pan", width: 14 },
    { header: H.amount, key: "amount", width: 18, style: { numFmt: "#,##0.00" } },
    { header: H.paid, key: "paid", width: 12 },
    { header: H.utr, key: "utr", width: 22 },
    { header: H.paidDate, key: "paidDate", width: 14 },
    { header: H.remarks, key: "remarks", width: 28 },
  ];

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle" };
  header.eachCell((cell, col) => {
    // Columns the accounts team fills in stand out from the pre-filled ones.
    const fillIn = col >= 13;
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: fillIn ? "FFFFF2CC" : "FFEDEDED" },
    };
  });

  for (const r of rows) {
    ws.addRow({
      id: r.withdrawalId,
      requested: r.requestedAt,
      name: r.creatorName,
      phone: r.creatorPhone,
      email: r.creatorEmail,
      holder: r.accountHolderName,
      method: r.methodType === "upi" ? "UPI" : "Bank",
      // Written as a string so long account numbers never become 1.23E+15.
      account: String(r.account),
      ifsc: r.ifscCode,
      bank: r.bankName,
      pan: r.panNumber,
      amount: r.netPaise / 100,
      paid: "",
      utr: "",
      paidDate: "",
      remarks: "",
    });
  }
  ws.getColumn("requested").numFmt = "dd-mmm-yyyy";

  for (let i = 2; i <= rows.length + 1; i += 1) {
    ws.getCell(`M${i}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"Y,N"'],
    };
    ws.getCell(`H${i}`).numFmt = "@";
  }

  const info = wb.addWorksheet("Read me");
  info.getColumn(1).width = 100;
  [
    title,
    `Rows: ${rows.length}   Total to pay: ₹${(rows.reduce((s, r) => s + r.netPaise, 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
    "",
    "For the accounts team:",
    "• Pay each row the 'Amount to pay' to the account shown. Use the Withdrawal ID as the payment reference.",
    "• After paying, fill 'Paid? (Y/N)' with Y and enter the bank UTR / reference.",
    "• If a payment could not be made, enter N and explain why in 'Remarks' — the creator is refunded automatically.",
    "• Do not change the Withdrawal ID or the amount. Delete this file once the batch is fully paid.",
    "• This file contains bank details. Do not forward or share it.",
  ].forEach((line, i) => {
    const cell = info.getCell(`A${i + 1}`);
    cell.value = line;
    if (i === 0 || i === 3) cell.font = { bold: true };
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export type ParsedResultRow = {
  rowNumber: number;
  withdrawalId: string;
  outcome: "paid" | "failed" | "skip" | "invalid";
  utr?: string;
  remarks?: string;
  amountRupees?: number;
  message?: string;
};

const PAID_VALUES = new Set(["y", "yes", "paid"]);
const FAILED_VALUES = new Set(["n", "no", "failed", "fail"]);

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((t) => t.text).join("").trim();
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("result" in value && value.result !== undefined) return String(value.result).trim();
    if (value instanceof Date) return value.toISOString();
    return "";
  }
  return String(value).trim();
}

/** Reads a returned sheet. Throws if the sheet has no 'Withdrawal ID' header.
 * Never trusts the order of columns — everything is found by header text. */
export async function parseResultWorkbook(buffer: Buffer): Promise<ParsedResultRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const ws = wb.getWorksheet("Payments") ?? wb.worksheets[0];
  if (!ws) throw new Error("The file has no worksheets.");

  const cols = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => {
    cols.set(cellText(cell.value).toLowerCase(), col);
  });
  const idCol = cols.get(H.id.toLowerCase());
  const paidCol = cols.get(H.paid.toLowerCase());
  if (!idCol || !paidCol) {
    throw new Error(`The file must have '${H.id}' and '${H.paid}' columns.`);
  }
  const utrCol = cols.get(H.utr.toLowerCase());
  const remarksCol = cols.get(H.remarks.toLowerCase());
  const amountCol = cols.get(H.amount.toLowerCase());

  const rows: ParsedResultRow[] = [];
  const seen = new Set<string>();
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const withdrawalId = cellText(row.getCell(idCol).value);
    if (!withdrawalId) continue; // blank trailing row

    if (seen.has(withdrawalId)) {
      rows.push({ rowNumber: r, withdrawalId, outcome: "invalid", message: "Withdrawal ID appears more than once." });
      continue;
    }
    seen.add(withdrawalId);

    const paidText = cellText(row.getCell(paidCol).value).toLowerCase();
    const utr = utrCol ? cellText(row.getCell(utrCol).value) : "";
    const remarks = remarksCol ? cellText(row.getCell(remarksCol).value) : "";
    const amountRaw = amountCol ? row.getCell(amountCol).value : null;
    const amountRupees =
      amountRaw === null || amountRaw === undefined || amountRaw === ""
        ? undefined
        : Number(typeof amountRaw === "object" ? cellText(amountRaw) : amountRaw);

    if (paidText === "") {
      rows.push({ rowNumber: r, withdrawalId, outcome: "skip" });
    } else if (PAID_VALUES.has(paidText)) {
      if (!utr) {
        rows.push({ rowNumber: r, withdrawalId, outcome: "invalid", message: "Marked paid but the UTR / reference is empty." });
      } else {
        rows.push({ rowNumber: r, withdrawalId, outcome: "paid", utr, amountRupees });
      }
    } else if (FAILED_VALUES.has(paidText)) {
      if (!remarks) {
        rows.push({ rowNumber: r, withdrawalId, outcome: "invalid", message: "Marked not paid but the remarks are empty — say why." });
      } else {
        rows.push({ rowNumber: r, withdrawalId, outcome: "failed", remarks, amountRupees });
      }
    } else {
      rows.push({ rowNumber: r, withdrawalId, outcome: "invalid", message: `Unrecognised value '${paidText}' in '${H.paid}' — use Y or N.` });
    }
  }
  return rows;
}
