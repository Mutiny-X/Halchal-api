import { describe, expect, it } from "vitest";

import { csvEscape, hyperlinkFormula, profileUrlFor, sanitizeCsvText } from "./campaign-report.service";

describe("csvEscape", () => {
  it("leaves a plain value untouched", () => {
    expect(csvEscape("Hyderabad")).toBe("Hyderabad");
    expect(csvEscape("42.50")).toBe("42.50");
  });

  it("quotes and doubles internal quotes when the value contains a comma, quote, or newline", () => {
    expect(csvEscape("Rao, Creator")).toBe('"Rao, Creator"');
    expect(csvEscape('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("wraps a creator name that legitimately contains a comma in quotes, so a CSV reader treats it as one field", () => {
    // Unquoted, "Entertainment, Reloaded" would be read as two columns by
    // Excel/Sheets — this is the exact case the quoting exists for.
    expect(csvEscape("Entertainment, Reloaded")).toBe('"Entertainment, Reloaded"');
  });
});

describe("hyperlinkFormula", () => {
  it("wraps an http(s) URL in a HYPERLINK formula", () => {
    expect(hyperlinkFormula("https://www.instagram.com/capdt/")).toBe(
      '=HYPERLINK("https://www.instagram.com/capdt/","https://www.instagram.com/capdt/")',
    );
  });

  it("doubles internal quotes so they can't break out of the formula's string arguments", () => {
    const result = hyperlinkFormula('https://example.com/?q="x"');
    expect(result).toBe('=HYPERLINK("https://example.com/?q=""x""","https://example.com/?q=""x""")');
  });

  it("passes through empty or non-URL values unchanged, never building formula syntax for them", () => {
    expect(hyperlinkFormula("")).toBe("");
    expect(hyperlinkFormula("not a url")).toBe("not a url");
  });

  it("never turns a formula-injection attempt into a live formula — the defense this exists for", () => {
    // A creator-submitted "post link" is free text; if something like this
    // ever reached this function, it must come back completely inert.
    const malicious = '=cmd|\'/c calc\'!A1';
    expect(hyperlinkFormula(malicious)).toBe(malicious);
  });
});

describe("sanitizeCsvText", () => {
  it("leaves ordinary creator names untouched", () => {
    expect(sanitizeCsvText("Pragnatej")).toBe("Pragnatej");
    expect(sanitizeCsvText("Entertainment Reloaded")).toBe("Entertainment Reloaded");
  });

  it("prefixes a leading formula-trigger character with a single quote", () => {
    expect(sanitizeCsvText("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(sanitizeCsvText("+1234")).toBe("'+1234");
    expect(sanitizeCsvText("-SUM(A1:A9)")).toBe("'-SUM(A1:A9)");
    expect(sanitizeCsvText("@SUM(1+1)")).toBe("'@SUM(1+1)");
  });

  it("only checks the first character — a = appearing later is harmless and left alone", () => {
    expect(sanitizeCsvText("Team = Winners")).toBe("Team = Winners");
  });
});

describe("profileUrlFor", () => {
  it("builds an Instagram profile URL by default", () => {
    expect(profileUrlFor("instagram", "capdt")).toBe("https://www.instagram.com/capdt/");
  });

  it("builds a YouTube handle URL", () => {
    expect(profileUrlFor("youtube", "halchalcreators")).toBe("https://www.youtube.com/@halchalcreators");
  });

  it("builds a Twitter/X profile URL", () => {
    expect(profileUrlFor("twitter", "halchal")).toBe("https://twitter.com/halchal");
  });
});
