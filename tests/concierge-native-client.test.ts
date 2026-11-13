import { describe, expect, it } from "vitest";
import {
  currentBalance,
  balanceGroupOf,
  memberGrade,
  resourceLabel,
  uniqueMembers,
} from "../src/client/features/concierge/NativeIntegration";
import type {
  Appointment,
  Balance,
  Member,
  NativeMemberSummary,
} from "../src/shared/concierge/types";
const native = (id: number, totalCents = 0) =>
  ({ id, totalCents, gradeLabel: "L4 望岳 · 享" }) as NativeMemberSummary;
const member = (id: string, nativeMember?: NativeMemberSummary) =>
  ({
    id,
    nativeMemberId: nativeMember?.id ?? null,
    nativeMember,
    cardTier: "旧人工级别",
  }) as Member;
const manual = { amountCents: 9999999 } as Balance;
describe("concierge native presentation semantics", () => {
  it("low balance is strictly below 30,000 yuan, including real zero; unavailable is separate", () => {
    expect(balanceGroupOf(member("low", native(1, 2999999)))).toBe("low");
    expect(balanceGroupOf(member("boundary", native(1, 3000000)))).toBe("normal");
    expect(balanceGroupOf(member("zero", native(1, 0)))).toBe("low");
    expect(balanceGroupOf(member("unknown"))).toBe("unknown");
  });
  it("native zero is a real balance; manual history never overrides native money or grade", () => {
    const m = member("one", native(1));
    expect(currentBalance(m, manual)).toBe(0);
    expect(memberGrade(m)).toBe("L4 望岳 · 享");
    expect(currentBalance({ ...m, nativeMember: null }, manual)).toBeNull();
    expect(currentBalance(member("old"), manual)).toBe(9999999);
    expect(currentBalance(member("unknown"))).toBeNull();
  });
  it("merged members count once, while unrelated legacy extensions remain distinct", () => {
    const a = member("old-A", native(2, 3000000)),
      b = member("B", native(2, 3000000));
    expect(
      uniqueMembers([a, b, member("legacy-A"), member("legacy-B")]).map(
        (m) => m.id,
      ),
    ).toEqual(["old-A", "legacy-A", "legacy-B"]);
    expect(
      uniqueMembers([a, b]).reduce((sum, m) => sum + currentBalance(m)!, 0),
    ).toBe(3000000);
  });
  it("resource display follows current catalog names and keeps area-only and historical fallbacks", () => {
    expect(
      resourceLabel({
        resource: "旧松风",
        nativeResource: { label: "新松风" },
      } as Appointment),
    ).toBe("新松风");
    expect(
      resourceLabel({
        resource: "",
        resourceGroup: "三层 · 按摩区 · 3人间",
      } as Appointment),
    ).toContain("3人间");
    expect(resourceLabel({ resource: "历史手写包厢" } as Appointment)).toBe(
      "历史手写包厢",
    );
  });
});
