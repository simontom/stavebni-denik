import { describe, expect, it } from "vitest";
import { HANDOVER_LIMITS, canEditHandover, handoverProblem, sideOfRole, signableSide, stateLabel, type Handover, type HandoverSignature } from "./handovers";

const signature = (side: "CONTRACTOR" | "CLIENT", signedById: string): HandoverSignature => ({
  side,
  signedById,
  signerName: "Jan Novák",
  signerRole: side === "CONTRACTOR" ? "BOSS" : "INVESTOR",
  signerCkaitNumber: side === "CONTRACTOR" ? "0012345" : null,
  signedAt: "2026-09-28T10:15:30.123Z",
  contentHash: "a".repeat(64),
  signatureHash: "b".repeat(64),
});

const handover = (patch: Partial<Handover> = {}): Handover => ({
  id: "h1",
  type: "Předání staveniště zhotoviteli",
  date: "2026-09-28",
  participants: "Novák, Svoboda",
  updatedAt: "2026-09-28T09:00:00Z",
  state: "DRAFT",
  createdById: "author",
  ...patch,
});

describe("which side of a handover protocol a person signs", () => {
  it("follows the role in the project: a manager for the contractor, an investor or the supervision for the client", () => {
    expect(sideOfRole("BOSS")).toBe("CONTRACTOR");
    expect(sideOfRole("INVESTOR")).toBe("CLIENT");
    expect(sideOfRole("INSPECTOR")).toBe("CLIENT");
  });

  it("is none for a worker, for somebody who is not a member and for a role nobody knows", () => {
    expect(sideOfRole("WORKER")).toBeNull();
    expect(sideOfRole(null)).toBeNull();
    expect(sideOfRole(undefined)).toBeNull();
    expect(sideOfRole("ADMIN")).toBeNull();
  });

  it("is offered to a person only while their side is open, and never to the person who signed the other side", () => {
    expect(signableSide("BOSS", "me", handover())).toBe("CONTRACTOR");
    expect(signableSide("INVESTOR", "me", handover())).toBe("CLIENT");
    // the other side signed, this one is open
    expect(signableSide("INVESTOR", "me", handover({ state: "SIGNED_BY_CONTRACTOR", contractorSignature: signature("CONTRACTOR", "x") }))).toBe("CLIENT");
    // this side signed already (by somebody else): nothing to offer
    expect(signableSide("BOSS", "me", handover({ state: "SIGNED_BY_CONTRACTOR", contractorSignature: signature("CONTRACTOR", "x") }))).toBeNull();
    expect(
      signableSide("INSPECTOR", "me", handover({ state: "COMPLETE", clientSignature: signature("CLIENT", "x"), contractorSignature: signature("CONTRACTOR", "y") })),
    ).toBeNull();
    // the same person signed the other side (a role that changed in between): the server refuses, so the page does not offer it
    expect(signableSide("INVESTOR", "me", handover({ state: "SIGNED_BY_CONTRACTOR", contractorSignature: signature("CONTRACTOR", "me") }))).toBeNull();
    // a worker has no side
    expect(signableSide("WORKER", "me", handover())).toBeNull();
    expect(signableSide(null, "me", handover())).toBeNull();
  });
});

describe("who may change a protocol", () => {
  it("is the manager, or the worker who made it, and only until one party has signed", () => {
    expect(canEditHandover("BOSS", "me", handover())).toBe(true);
    expect(canEditHandover("WORKER", "author", handover())).toBe(true);
    expect(canEditHandover("WORKER", "me", handover())).toBe(false);
    expect(canEditHandover("INVESTOR", "author", handover())).toBe(false);
    expect(canEditHandover("INSPECTOR", "me", handover())).toBe(false);
    expect(canEditHandover(null, "me", handover())).toBe(false);
    for (const state of ["SIGNED_BY_CONTRACTOR", "SIGNED_BY_CLIENT", "COMPLETE"] as const) {
      expect(canEditHandover("BOSS", "me", handover({ state })), `signed: ${state}`).toBe(false);
    }
  });
});

describe("the words for a state", () => {
  it("say who is awaited, not only that something is", () => {
    expect(stateLabel("DRAFT").text).toBe("Rozpracováno, čeká na podpisy");
    expect(stateLabel("SIGNED_BY_CONTRACTOR").text).toBe("Podepsal zhotovitel, čeká na stavebníka");
    expect(stateLabel("SIGNED_BY_CLIENT").text).toBe("Podepsal stavebník, čeká na zhotovitele");
    expect(stateLabel("COMPLETE").text).toBe("Podepsáno oběma stranami");
    expect(stateLabel("COMPLETE").tone).toBe("success");
  });
});

describe("the limits of the text, as the server has them", () => {
  const ok = { type: "Předání", date: "2026-09-28", participants: "Novák", notes: "", meters: [] };

  it("accept what is at the limit and refuse one character more, saying the limit", () => {
    expect(handoverProblem({ ...ok, type: "x".repeat(HANDOVER_LIMITS.type) })).toBeNull();
    expect(handoverProblem({ ...ok, type: "x".repeat(HANDOVER_LIMITS.type + 1) })).toContain("200");
    expect(handoverProblem({ ...ok, participants: "x".repeat(HANDOVER_LIMITS.participants) })).toBeNull();
    expect(handoverProblem({ ...ok, participants: "x".repeat(HANDOVER_LIMITS.participants + 1) })).toContain("2 000");
    expect(handoverProblem({ ...ok, notes: "x".repeat(HANDOVER_LIMITS.notes) })).toBeNull();
    expect(handoverProblem({ ...ok, notes: "x".repeat(HANDOVER_LIMITS.notes + 1) })).toContain("5 000");
  });

  it("count characters as a person counts them (an emoji is one)", () => {
    expect(handoverProblem({ ...ok, notes: "🚧".repeat(HANDOVER_LIMITS.notes) })).toBeNull();
  });

  it("limit the meters and what is said of each", () => {
    const meter = { medium: "Voda", serialNumber: "1", state: "2" };
    expect(handoverProblem({ ...ok, meters: Array.from({ length: HANDOVER_LIMITS.meters }, () => meter) })).toBeNull();
    expect(handoverProblem({ ...ok, meters: Array.from({ length: HANDOVER_LIMITS.meters + 1 }, () => meter) })).toContain("50");
    expect(handoverProblem({ ...ok, meters: [{ ...meter, state: "x".repeat(HANDOVER_LIMITS.meterField + 1) }] })).toContain("100");
  });

  it("require the type and the date of the handover", () => {
    expect(handoverProblem({ ...ok, type: "   " })).toMatch(/Typ/);
    expect(handoverProblem({ ...ok, date: "" })).toMatch(/Datum/);
  });
});
