import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App, matchRoute } from "../App.js";
import { routes } from "../routes.js";

describe("REQ-216: flows are not an operator product", () => {
  it("does not register /flows in the SPA", () => {
    expect(matchRoute(routes, "/flows")).toBeUndefined();
  });

  it("does not offer a Flows destination in the private navigation", () => {
    render(<App pathname="/dashboard" />);

    expect(screen.queryByRole("link", { name: /flows|fluxos/i })).toBeNull();
    expect(document.querySelector('a[href="/flows"]')).toBeNull();
  });
});
