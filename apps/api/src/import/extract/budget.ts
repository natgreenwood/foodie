// Fixed limits on the work one extraction may do, shared by the JSON-LD and
// microdata readers (SEC-2 on NATG-245). The page is whatever the caller
// points at and extraction runs on the event loop, so without them a crafted
// page could hold every other request. A real recipe page sits far inside
// each limit; a page past one is treated as having no recipe.
export const LIMITS = {
  // Elements and JSON values visited, across both readers.
  nodes: 100_000,
  // Distinct properties on one item.
  propertiesPerItem: 200,
  // Elements below a microdata Recipe; arrays and objects in JSON-LD.
  depth: 64,
  // Values of one property; also the ingredient lines and steps of a draft.
  valuesPerProperty: 1_000,
} as const;

export type Limit = keyof typeof LIMITS;

export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
  constructor(readonly limit: Limit) {
    super(`extraction budget exceeded: ${limit} over ${LIMITS[limit]}`);
  }
}

// One per extraction, so the node count covers both readers.
export class Budget {
  private nodes = 0;

  visit(depth: number): void {
    if (++this.nodes > LIMITS.nodes) throw new BudgetExceededError("nodes");
    if (depth > LIMITS.depth) throw new BudgetExceededError("depth");
  }

  check(limit: "propertiesPerItem" | "valuesPerProperty", count: number) {
    if (count > LIMITS[limit]) throw new BudgetExceededError(limit);
  }
}
