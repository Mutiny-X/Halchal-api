import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { buildWithdrawalWorkbook, parseResultWorkbook, type SheetRow } from "./withdrawal-sheet";

function row(overrides: Partial<SheetRow> = {}): SheetRow {
  return {
    withdrawalId: "wd-1",
    requestedAt: new Date("2026-10-08T10:00:00Z"),
    creatorName: "Ravi Kumar",
    creatorPhone: "+919876543210",
    creatorEmail: "ravi@example.com",
    accountHolderName: "Ravi Kumar",
    methodType: "bank",
    account: "001234567890123456",
    ifscCode: "HDFC0001234",
    bankName: "HDFC Bank",
    panNumber: "ABCPV1234D",
    netPaise: 4_750_00,
    ...overrides,
  };
}

async function load(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

/** Plays the accounts team: fills the result columns on the Payments sheet. */
async function fill(
  buffer: Buffer,
  fills: Array<{ paid?: string; utr?: string; remarks?: string; amount?: number; id?: string }>,
): Promise<Buffer> {
  const wb = await load(buffer);
  const ws = wb.getWorksheet("Payments")!;
  fills.forEach((f, i) => {
    const r = ws.getRow(i + 2);
    if (f.id !== undefined) r.getCell(1).value = f.id;
    if (f.amount !== undefined) r.getCell(12).value = f.amount;
    if (f.paid !== undefined) r.getCell(13).value = f.paid;
    if (f.utr !== undefined) r.getCell(14).value = f.utr;
    if (f.remarks !== undefined) r.getCell(16).value = f.remarks;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("buildWithdrawalWorkbook", () => {
  it("writes one row per withdrawal with the details accounts needs", async () => {
    const buf = await buildWithdrawalWorkbook([row(), row({ withdrawalId: "wd-2", methodType: "upi", account: "ravi@okhdfc" })], "t");
    const ws = (await load(buf)).getWorksheet("Payments")!;
    expect(ws.rowCount).toBe(3);
    expect(ws.getRow(1).getCell(1).value).toBe("Withdrawal ID");
    expect(ws.getRow(2).getCell(1).value).toBe("wd-1");
    expect(ws.getRow(2).getCell(3).value).toBe("Ravi Kumar");
    expect(ws.getRow(2).getCell(9).value).toBe("HDFC0001234");
    expect(ws.getRow(2).getCell(11).value).toBe("ABCPV1234D");
    expect(ws.getRow(3).getCell(7).value).toBe("UPI");
    expect(ws.getRow(3).getCell(8).value).toBe("ravi@okhdfc");
  });

  it("writes the net amount in rupees", async () => {
    const buf = await buildWithdrawalWorkbook([row({ netPaise: 4_750_00 })], "t");
    const ws = (await load(buf)).getWorksheet("Payments")!;
    expect(ws.getRow(2).getCell(12).value).toBe(4750);
  });

  it("keeps a long account number with leading zeros as text", async () => {
    const buf = await buildWithdrawalWorkbook([row({ account: "001234567890123456" })], "t");
    const cell = (await load(buf)).getWorksheet("Payments")!.getRow(2).getCell(8);
    expect(typeof cell.value).toBe("string");
    expect(cell.value).toBe("001234567890123456");
  });

  it("leaves the result columns blank for accounts to fill", async () => {
    const buf = await buildWithdrawalWorkbook([row()], "t");
    const ws = (await load(buf)).getWorksheet("Payments")!;
    for (const col of [13, 14, 15, 16]) {
      expect(ws.getRow(2).getCell(col).value ?? "").toBe("");
    }
  });

  it("includes instructions for the accounts team", async () => {
    const buf = await buildWithdrawalWorkbook([row()], "Batch title");
    const info = (await load(buf)).getWorksheet("Read me")!;
    expect(String(info.getCell("A1").value)).toBe("Batch title");
    expect(info.getCell("A5").value).toMatch(/Withdrawal ID as the payment reference/);
  });
});

describe("parseResultWorkbook", () => {
  it("round-trips an untouched sheet as all-skipped", async () => {
    const buf = await buildWithdrawalWorkbook([row(), row({ withdrawalId: "wd-2" })], "t");
    const parsed = await parseResultWorkbook(buf);
    expect(parsed.map((p) => p.outcome)).toEqual(["skip", "skip"]);
  });

  it("reads paid rows with their UTR", async () => {
    const buf = await fill(await buildWithdrawalWorkbook([row()], "t"), [{ paid: "Y", utr: "UTR123456" }]);
    const [p] = await parseResultWorkbook(buf);
    expect(p).toMatchObject({ withdrawalId: "wd-1", outcome: "paid", utr: "UTR123456", amountRupees: 4750 });
  });

  it("is case- and wording-tolerant for Y/N", async () => {
    const buf = await fill(
      await buildWithdrawalWorkbook([row({ withdrawalId: "a" }), row({ withdrawalId: "b" }), row({ withdrawalId: "c" })], "t"),
      [
        { paid: "yes", utr: "U1" },
        { paid: " N ", remarks: "Account closed" },
        { paid: "Paid", utr: "U3" },
      ],
    );
    const parsed = await parseResultWorkbook(buf);
    expect(parsed.map((p) => p.outcome)).toEqual(["paid", "failed", "paid"]);
    expect(parsed[1].remarks).toBe("Account closed");
  });

  it("flags 'paid' with no UTR instead of accepting it", async () => {
    const buf = await fill(await buildWithdrawalWorkbook([row()], "t"), [{ paid: "Y" }]);
    const [p] = await parseResultWorkbook(buf);
    expect(p.outcome).toBe("invalid");
    expect(p.message).toMatch(/UTR/);
  });

  it("flags 'not paid' with no remarks instead of accepting it", async () => {
    const buf = await fill(await buildWithdrawalWorkbook([row()], "t"), [{ paid: "N" }]);
    const [p] = await parseResultWorkbook(buf);
    expect(p.outcome).toBe("invalid");
    expect(p.message).toMatch(/why/);
  });

  it("flags values it doesn't understand", async () => {
    const buf = await fill(await buildWithdrawalWorkbook([row()], "t"), [{ paid: "maybe", utr: "U1" }]);
    const [p] = await parseResultWorkbook(buf);
    expect(p.outcome).toBe("invalid");
  });

  it("flags a withdrawal ID that appears twice", async () => {
    const buf = await fill(
      await buildWithdrawalWorkbook([row({ withdrawalId: "dup" }), row({ withdrawalId: "dup2" })], "t"),
      [{ paid: "Y", utr: "U1" }, { id: "dup", paid: "Y", utr: "U2" }],
    );
    const parsed = await parseResultWorkbook(buf);
    expect(parsed[0].outcome).toBe("paid");
    expect(parsed[1].outcome).toBe("invalid");
    expect(parsed[1].message).toMatch(/more than once/);
  });

  it("finds columns by header text, not position", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Whatever");
    ws.addRow(["Remarks", "UTR / reference", "Paid? (Y/N)", "Withdrawal ID"]);
    ws.addRow(["", "UTR9", "Y", "wd-9"]);
    const parsed = await parseResultWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ withdrawalId: "wd-9", outcome: "paid", utr: "UTR9" });
  });

  it("rejects a file that isn't a payment sheet", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Sheet1").addRow(["Name", "Age"]);
    await expect(parseResultWorkbook(Buffer.from(await wb.xlsx.writeBuffer()))).rejects.toThrow(/Withdrawal ID/);
  });

  it("ignores blank trailing rows", async () => {
    const buf = await fill(await buildWithdrawalWorkbook([row()], "t"), [{ paid: "Y", utr: "U1" }]);
    const wb = await load(buf);
    wb.getWorksheet("Payments")!.getRow(10).getCell(3).value = "stray text";
    const parsed = await parseResultWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(parsed).toHaveLength(1);
  });
});
