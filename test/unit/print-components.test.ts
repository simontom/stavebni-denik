/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PrintCoverPage,
  PrintProjectData,
} from "@/app/print/project/[id]/_components/PrintCoverPage";
import { PrintDailyRecord } from "@/app/print/project/[id]/_components/PrintDailyRecord";
import type { ProjectExportDay } from "@/server/services/reports";
import React from "react";

const mockProjectData: PrintProjectData = {
  name: "Test Project",
  address: "Test Address 123",
  cadastralArea: "Test Area",
  parcelNumbers: "123/4",
  builder: "Test Builder",
  contractor: "Test Contractor",
  siteManagerName: "Manager Name",
};

const mockProjectDataWithOptional: PrintProjectData = {
  ...mockProjectData,
  permitNumber: "P-123",
  contractNumber: "C-123",
  contractDate: new Date("2023-01-01"),
  designDocVersion: "v1",
  designDocDate: new Date("2023-01-01"),
  tdsName: "TDS Name",
  bozpName: "BOZP Name",
  designerName: "Designer Name",
};

const baseDay: ProjectExportDay = {
  id: "test-id-1",
  sequenceNumber: 1,
  date: new Date("2023-01-01"),
  isControlDay: false,
  authorName: "Author",
  signedByName: null,
  signedAt: null,
  acknowledgedByName: null,
  lockedAt: null,
  weather: {
    summary: "Slunečno",
    tempMinC: null,
    tempMaxC: null,
    precipitationMm: null,
    windMaxKmh: null,
    source: "MANUAL" as any,
    fetchedAt: "2023-01-01T12:00:00Z",
    date: "2023-01-01",
    weatherCode: 0,
  },
  workers: [],
  constructionObj: "",
  workDescription: "",
  materialsIn: "",
  machinery: "",
  testsAndChecks: "",
  safetyNotes: "",
  defects: "",
  otherNotes: "",
  remarks: [],
  materials: [],
  addenda: [],
  photos: [],
};

const fullDay: ProjectExportDay = {
  ...baseDay,
  isControlDay: true,
  signedByName: "Signer",
  signedAt: new Date("2023-01-01T12:00:00Z"),
  acknowledgedByName: "Ack",
  weather: {
    summary: "Slunečno",
    tempMinC: 10,
    tempMaxC: 20,
    precipitationMm: 0,
    windMaxKmh: 5,
    source: "MANUAL" as any,
    fetchedAt: "2023-01-01T12:00:00Z",
    date: "2023-01-01",
    weatherCode: 0,
  },
  workers: [
    { trade: "Zedník", count: 2 },
    { trade: "Tesař", count: 1 },
  ],
  constructionObj: "SO 01",
  workDescription: "Zdění",
  materialsIn: "Cihly",
  machinery: "Míchačka",
  testsAndChecks: "Zkouška pevnosti",
  safetyNotes: "Školení BOZP",
  defects: "Žádné",
  otherNotes: "Poznámka",
  remarks: [
    {
      id: "1",
      authorName: "Rem",
      isOfficial: true,
      createdAt: new Date("2023-01-01T10:00:00Z"),
      text: "Připomínka",
    },
  ],
  materials: [
    {
      id: "1",
      resolved: false,
      resolvedAt: null,
      text: "Cement",
      neededBy: new Date("2023-01-05"),
    },
    { id: "2", resolved: true, resolvedAt: new Date("2023-01-02"), text: "Písek", neededBy: null },
  ],
  addenda: [
    { id: "1", authorName: "Add", createdAt: new Date("2023-01-01T11:00:00Z"), text: "Dodatek" },
  ],
  photos: [
    { id: "p1", capturedAt: new Date("2023-01-01") },
    { id: "p2", capturedAt: new Date("2023-01-01") },
  ],
};

describe("PrintCoverPage", () => {
  it("renders with minimum required fields", () => {
    const html = renderToStaticMarkup(
      React.createElement(PrintCoverPage, {
        project: mockProjectData,
        dateRangeLabel: "Leden 2023",
        daysCount: 31,
      }),
    );
    expect(html).toContain("Stavební deník");
    expect(html).toContain("Test Project");
    expect(html).toContain("Test Address 123");
    expect(html).toContain("Leden 2023");
    expect(html).toContain("31");
    // Verify absent optional fields
    expect(html).not.toContain("Č. stavebního povolení");
    expect(html).not.toContain("Číslo smlouvy");
  });

  it("renders with all optional fields", () => {
    const html = renderToStaticMarkup(
      React.createElement(PrintCoverPage, {
        project: mockProjectDataWithOptional,
        dateRangeLabel: "Leden 2023",
        daysCount: 31,
      }),
    );
    expect(html).toContain("P-123");
    expect(html).toContain("C-123");
    expect(html).toContain("v1");
    expect(html).toContain("TDS Name");
    expect(html).toContain("BOZP Name");
    expect(html).toContain("Designer Name");
  });
});

describe("PrintDailyRecord", () => {
  it("renders with empty data arrays and null optionals", () => {
    const html = renderToStaticMarkup(
      React.createElement(PrintDailyRecord, { day: baseDay, pageBreakBefore: false }),
    );
    expect(html).toContain("Záznam č. 1 ze dne");
    expect(html).not.toContain("Kontrolní den");
    expect(html).toContain("Slunečno");
    expect(html).not.toContain("°C"); // no temp
    expect(html).toContain("neuvedeno"); // workers total 0
    expect(html).not.toContain("Stavební objekt");
    expect(html).not.toContain("Připomínky");
    expect(html).not.toContain("Materiál na další dny");
    expect(html).not.toContain("Dodatky");
    expect(html).not.toContain("Fotografie");
  });

  it("renders with full data arrays and optionals", () => {
    const html = renderToStaticMarkup(
      React.createElement(PrintDailyRecord, { day: fullDay, pageBreakBefore: false }),
    );
    expect(html).toContain("Kontrolní den");
    expect(html).toContain("Podepsal: Signer");
    expect(html).toContain("Potvrdil investor: Ack");
    expect(html).toContain("10–20 °C");
    expect(html).toContain("srážky 0 mm");
    expect(html).toContain("vítr 5 km/h");
    expect(html).toContain("Pracovníci (3):");
    expect(html).toContain("Zedník 2×, Tesař 1×");
    expect(html).toContain("Stavební objekt");
    expect(html).toContain("SO 01");
    expect(html).toContain("Připomínky");
    expect(html).toContain("Materiál na další dny");
    expect(html).toContain("Dodatky");
    expect(html).toContain("Fotografie (2)");
    expect(html).toContain('src="/api/photos/p1?variant=thumb"');
  });

  it("applies correct CSS class for pageBreakBefore", () => {
    const html1 = renderToStaticMarkup(
      React.createElement(PrintDailyRecord, { day: baseDay, pageBreakBefore: true }),
    );
    expect(html1).toContain('class="day day-break"');

    const html2 = renderToStaticMarkup(
      React.createElement(PrintDailyRecord, { day: baseDay, pageBreakBefore: false }),
    );
    expect(html2).toContain('class="day"');
    expect(html2).not.toContain("day-break");
  });
});
