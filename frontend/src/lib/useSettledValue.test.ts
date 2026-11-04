// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettledValue } from "./useSettledValue";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSettledValue: what a screen reader is told is the value that has stopped changing", () => {
  it("starts with the value it is given, so nothing is announced when the page opens", () => {
    const { result } = renderHook(({ value }) => useSettledValue(value, 800), { initialProps: { value: "Celkem: 0 pracovníků" } });
    expect(result.current[0]).toBe("Celkem: 0 pracovníků");
  });

  it("does not follow every keystroke: the value is settled when it has been still for the delay", () => {
    const { result, rerender } = renderHook(({ value }) => useSettledValue(value, 800), { initialProps: { value: "a" } });
    for (const typed of ["b", "bc", "bcd"]) {
      rerender({ value: typed });
      act(() => vi.advanceTimersByTime(300));
      expect(result.current[0], `still "a" while "${typed}" is being typed`).toBe("a");
    }
    act(() => vi.advanceTimersByTime(800));
    expect(result.current[0]).toBe("bcd");
  });

  it("settles at once when asked (the field lost the focus)", () => {
    const { result, rerender } = renderHook(({ value }) => useSettledValue(value, 800), { initialProps: { value: "a" } });
    rerender({ value: "ab" });
    expect(result.current[0]).toBe("a");
    act(() => result.current[1]());
    expect(result.current[0]).toBe("ab");
    // and the timer that was running does not change it again
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current[0]).toBe("ab");
  });

  it("settles the value of the moment it is asked, not the one of an earlier render", () => {
    const { result, rerender } = renderHook(({ value }) => useSettledValue(value, 800), { initialProps: { value: "1" } });
    const settle = result.current[1];
    rerender({ value: "2" });
    rerender({ value: "3" });
    act(() => settle());
    expect(result.current[0]).toBe("3");
  });

  it("takes the timer away when the component goes", () => {
    const { rerender, unmount } = renderHook(({ value }) => useSettledValue(value, 800), { initialProps: { value: "a" } });
    rerender({ value: "b" });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
