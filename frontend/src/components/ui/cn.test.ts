import { describe, expect, it } from "vitest";
import { buttonClasses } from "./buttonClasses";
import { cn } from "./cn";
import { badgeClassName, bannerClassName, cardClassName, controlClassName, tabLinkClassName } from "./uiClasses";

/** The classes of an element as a set, so a test does not depend on their order. */
const set = (classes: string) => new Set(classes.split(/\s+/).filter(Boolean));

describe("cn", () => {
  it("joins what is given and skips what is not there", () => {
    expect(cn("a", undefined, false, null, "", "b")).toBe("a b");
  });

  it("lets the later class win when two set the same thing", () => {
    expect(set(cn("w-full", "w-auto"))).toEqual(new Set(["w-auto"]));
    expect(set(cn("min-h-11", "min-h-0"))).toEqual(new Set(["min-h-0"]));
    expect(set(cn("p-4 sm:p-6", "p-0"))).toEqual(new Set(["sm:p-6", "p-0"]));
  });

  it("keeps the classes that do not conflict", () => {
    expect(set(cn("rounded-md border px-3 text-sm", "w-auto"))).toEqual(new Set(["rounded-md", "border", "px-3", "text-sm", "w-auto"]));
  });

  it("knows the tokens of index.css: a text colour does not replace a text size, and a token replaces a token", () => {
    // `text-ink-muted` is a colour and `text-lg` a size: both stay. A second size replaces the first.
    expect(set(cn("text-base text-ink", "text-lg"))).toEqual(new Set(["text-ink", "text-lg"]));
    expect(set(cn("text-sm text-ink", "text-danger-ink"))).toEqual(new Set(["text-sm", "text-danger-ink"]));
    expect(set(cn("bg-primary hover:bg-primary-hover", "bg-danger"))).toEqual(new Set(["bg-danger", "hover:bg-primary-hover"]));
    // a border width and a border colour are different things
    expect(set(cn("border border-input", "border-danger"))).toEqual(new Set(["border", "border-danger"]));
    expect(set(cn("border border-input", "border-2"))).toEqual(new Set(["border-input", "border-2"]));
  });

  it("treats a variant as its own context", () => {
    expect(set(cn("min-h-11 sm:pointer-fine:min-h-10", "min-h-12"))).toEqual(new Set(["sm:pointer-fine:min-h-10", "min-h-12"]));
  });
});

describe("a class given to a shared component wins over the one it brings", () => {
  it("Button", () => {
    const classes = set(buttonClasses({ block: true, className: "w-auto min-h-0 px-1" }));
    expect(classes.has("w-auto")).toBe(true);
    expect(classes.has("w-full")).toBe(false);
    expect(classes.has("min-h-0")).toBe(true);
    expect(classes.has("min-h-11")).toBe(false);
    expect(classes.has("px-1")).toBe(true);
    expect(classes.has("px-4")).toBe(false);
    // what was not overridden is still there
    expect(classes.has("rounded-md")).toBe(true);
    expect(classes.has("bg-primary")).toBe(true);
  });

  it("TextInput, TextArea and Select", () => {
    const classes = set(controlClassName("w-auto text-lg"));
    expect(classes.has("w-auto")).toBe(true);
    expect(classes.has("w-full")).toBe(false);
    expect(classes.has("text-lg")).toBe(true);
    expect(classes.has("text-base")).toBe(false);
    // the colour of the text and the boundary are not text size and border width
    expect(classes.has("text-ink")).toBe(true);
    expect(classes.has("border-input")).toBe(true);
    expect(classes.has("border")).toBe(true);
  });

  it("Card", () => {
    const classes = set(cardClassName({ compact: false, className: "p-0 bg-page" }));
    expect(classes.has("p-0")).toBe(true);
    expect(classes.has("p-4")).toBe(false);
    expect(classes.has("bg-page")).toBe(true);
    expect(classes.has("bg-surface")).toBe(false);
    expect(classes.has("rounded-lg")).toBe(true);
  });

  it("StatusBadge, Banner and the tab link", () => {
    expect(set(badgeClassName({ tone: "neutral", outlined: false, className: "px-0" })).has("px-2.5")).toBe(false);
    expect(set(badgeClassName({ tone: "neutral", outlined: false, className: "px-0" })).has("px-0")).toBe(true);
    expect(set(bannerClassName({ tone: "info", className: "p-0" })).has("p-3")).toBe(false);
    expect(set(bannerClassName({ tone: "info", className: "p-0" })).has("p-0")).toBe(true);
    expect(set(tabLinkClassName({ active: false, className: "min-h-0" })).has("min-h-11")).toBe(false);
    expect(set(tabLinkClassName({ active: false, className: "min-h-0" })).has("min-h-0")).toBe(true);
  });
});
