import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";

import { CreatePayoutMethodDto } from "./payout.dto";

describe("CreatePayoutMethodDto", () => {
  it("requires a valid IFSC code for bank accounts", async () => {
    const dto = plainToInstance(CreatePayoutMethodDto, {
      type: "bank",
      label: "HDFC Bank",
      accountHolderName: "Ravi Kumar",
      account: "1234567890",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "ifscCode")).toBe(true);
  });

  it("accepts a well-formed IFSC code for bank accounts", async () => {
    const dto = plainToInstance(CreatePayoutMethodDto, {
      type: "bank",
      label: "HDFC Bank",
      accountHolderName: "Ravi Kumar",
      account: "1234567890",
      ifscCode: "HDFC0001234",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "ifscCode")).toBe(false);
  });

  it("rejects a malformed IFSC code", async () => {
    const dto = plainToInstance(CreatePayoutMethodDto, {
      type: "bank",
      label: "HDFC Bank",
      accountHolderName: "Ravi Kumar",
      account: "1234567890",
      ifscCode: "not-an-ifsc",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "ifscCode")).toBe(true);
  });

  it("does not require an IFSC code for UPI methods", async () => {
    const dto = plainToInstance(CreatePayoutMethodDto, {
      type: "upi",
      label: "Personal UPI",
      accountHolderName: "Ravi Kumar",
      account: "ravi@upi",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "ifscCode")).toBe(false);
  });

  it("requires a valid PAN for bank accounts", async () => {
    const dto = plainToInstance(CreatePayoutMethodDto, {
      type: "bank",
      label: "HDFC Bank",
      accountHolderName: "Ravi Kumar",
      account: "1234567890",
      ifscCode: "HDFC0001234",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "panNumber")).toBe(true);
  });

  it("accepts a well-formed PAN for bank accounts", async () => {
    const dto = plainToInstance(CreatePayoutMethodDto, {
      type: "bank",
      label: "HDFC Bank",
      accountHolderName: "Ravi Kumar",
      account: "1234567890",
      ifscCode: "HDFC0001234",
      panNumber: "ABCPV1234D",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "panNumber")).toBe(false);
  });

  it("rejects a malformed PAN", async () => {
    const dto = plainToInstance(CreatePayoutMethodDto, {
      type: "bank",
      label: "HDFC Bank",
      accountHolderName: "Ravi Kumar",
      account: "1234567890",
      ifscCode: "HDFC0001234",
      panNumber: "not-a-pan",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "panNumber")).toBe(true);
  });

  it("does not require a PAN for UPI methods", async () => {
    const dto = plainToInstance(CreatePayoutMethodDto, {
      type: "upi",
      label: "Personal UPI",
      accountHolderName: "Ravi Kumar",
      account: "ravi@upi",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "panNumber")).toBe(false);
  });

  it("requires a bank account number to be digits only", async () => {
    const make = (account: string) =>
      plainToInstance(CreatePayoutMethodDto, {
        type: "bank",
        label: "HDFC Bank",
        accountHolderName: "Ravi Kumar",
        account,
        ifscCode: "HDFC0001234",
        panNumber: "ABCPV1234D",
      });
    expect((await validate(make("12345678901"))).some((e) => e.property === "account")).toBe(false);
    expect((await validate(make("12AB5678901"))).some((e) => e.property === "account")).toBe(true);
    expect((await validate(make("12345"))).some((e) => e.property === "account")).toBe(true);
  });

  it("requires a UPI ID to look like name@bank", async () => {
    const make = (account: string) =>
      plainToInstance(CreatePayoutMethodDto, {
        type: "upi",
        label: "Personal UPI",
        accountHolderName: "Ravi Kumar",
        account,
      });
    expect((await validate(make("ravi.kumar-1@okhdfcbank"))).some((e) => e.property === "account")).toBe(false);
    expect((await validate(make("abcd"))).some((e) => e.property === "account")).toBe(true);
    expect((await validate(make("ravi@"))).some((e) => e.property === "account")).toBe(true);
    expect((await validate(make("@upi"))).some((e) => e.property === "account")).toBe(true);
  });

  it("requires an account holder name", async () => {
    const dto = plainToInstance(CreatePayoutMethodDto, {
      type: "upi",
      label: "Personal UPI",
      accountHolderName: "",
      account: "ravi@upi",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "accountHolderName")).toBe(true);
  });
});
