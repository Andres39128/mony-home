import { describe, expect, it } from "vitest";
import { TOUR_AUTO_LAUNCH_ROUTE, TOUR_LABELS, TOURS, tourSelector } from "./registry";

describe("tour registry", () => {
  it("only lists (app) routes with at least one step", () => {
    for (const [route, steps] of Object.entries(TOURS)) {
      expect(route, "routes must be root-relative").toMatch(/^\//);
      expect(steps.length, `tour for ${route} must not be empty`).toBeGreaterThan(0);
    }
    expect(TOURS[TOUR_AUTO_LAUNCH_ROUTE]).toBeDefined();
  });

  it("every step has id, element, title and description", () => {
    for (const [route, steps] of Object.entries(TOURS)) {
      for (const step of steps) {
        expect(step.id.trim().length, `${route}:${step.id}`).toBeGreaterThan(0);
        expect(step.element.trim().length, `${route}:${step.id}`).toBeGreaterThan(0);
        expect(step.title.trim().length, `${route}:${step.id}`).toBeGreaterThan(0);
        expect(step.description.trim().length, `${route}:${step.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("step ids and anchor elements are unique within a page", () => {
    for (const [route, steps] of Object.entries(TOURS)) {
      const ids = steps.map((step) => step.id);
      const elements = steps.map((step) => step.element);
      expect(new Set(ids).size, `duplicate step id in ${route}`).toBe(ids.length);
      expect(new Set(elements).size, `duplicate data-tour anchor in ${route}`).toBe(
        elements.length,
      );
    }
  });

  it("builds attribute selectors from anchor ids", () => {
    expect(tourSelector({ element: "dashboard-kpis" })).toBe(
      '[data-tour="dashboard-kpis"]',
    );
    expect(TOUR_LABELS.doneBtnText).toBe("Entendido");
  });
});
