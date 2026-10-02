import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv } from "@/lib/csv";

describe("parseCsv", () => {
  it("parses plain rows with a trailing newline producing no ghost row", () => {
    expect(parseCsv("a,b\n1,2\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps the last row when the input lacks a trailing newline", () => {
    expect(parseCsv("a,b\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("supports quoted fields with embedded delimiters, quotes and newlines", () => {
    expect(parseCsv('a,b\n"1;000","say ""hi""","line\nbreak"', ",")).toEqual([
      ["a", "b"],
      ["1;000", 'say "hi"', "line\nbreak"],
    ]);
  });

  it("handles CRLF and lone CR line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r3,4", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("keeps empty cells and interior empty lines as data", () => {
    expect(parseCsv("a,,c\n\n1,,", ",")).toEqual([
      ["a", "", "c"],
      [""],
      ["1", "", ""],
    ]);
  });

  it("strips a UTF-8 BOM from the first header cell", () => {
    expect(parseCsv("\uFEFFFecha,Monto\n2026-01-02,100", ",")[0]).toEqual(["Fecha", "Monto"]);
  });

  it("treats a mid-field quote literally (lenient)", () => {
    expect(parseCsv('ab"cd,2', ",")).toEqual([['ab"cd', "2"]]);
  });
});

describe("detectDelimiter", () => {
  it("picks the most frequent candidate on the first line", () => {
    expect(detectDelimiter("a;b;c\n1,5;2\n")).toBe(";");
    expect(detectDelimiter("a,b,c\n")).toBe(",");
    expect(detectDelimiter("a\tb\tc\n")).toBe("\t");
  });

  it("defaults to comma on ties or empty input", () => {
    expect(detectDelimiter("a;b,c\n")).toBe(",");
    expect(detectDelimiter("only one column\n")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
  });

  it("ignores a leading BOM when counting", () => {
    expect(detectDelimiter("\uFEFFa;b\n")).toBe(";");
  });
});
