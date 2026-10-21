import { useEffect, useRef, useState } from "react";
import {
  CatalogueError,
  fetchMeasurements,
  unitAbbreviation,
  type Measurement,
} from "./catalogue";
import {
  fetchRecipe,
  RecipeError,
  type Recipe,
  type RecipeLine,
} from "./recipes";
import { Link, useArrivalState } from "./router";

// /recipes/:id: one of the signed-in user's recipes, read-only. Arriving
// from the import's save, it says so, and whether the page had been
// imported before (only the save's response knows that).

type State =
  | { kind: "loading" }
  | { kind: "loaded"; recipe: Recipe; units: Map<number, Measurement> }
  | { kind: "error"; error: unknown };

function isSaveArrival(
  state: unknown,
): state is { saved: true; alreadyImported: boolean } {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as { saved?: unknown }).saved === true
  );
}

// The id in a /recipes/:id path, or null when the path is not one.
export function recipeIdFrom(pathname: string): number | null {
  const match = /^\/recipes\/([1-9][0-9]*)$/.exec(pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

function minutes(value: number): string {
  const h = Math.floor(value / 60);
  const m = value % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function formatter<T>(make: () => T, fallback: () => T): T {
  try {
    return make();
  } catch {
    // A profile locale Intl does not take.
    return fallback();
  }
}

export function RecipePage({ id, locale }: { id: number; locale: string }) {
  const arrival = useArrivalState();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const saved = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchRecipe(id, controller.signal),
      fetchMeasurements(controller.signal),
    ]).then(
      ([recipe, units]) =>
        setState({
          kind: "loaded",
          recipe,
          units: new Map(units.map((unit) => [unit.id, unit])),
        }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        if (
          !(err instanceof RecipeError && err.code === "not_found") &&
          !(err instanceof CatalogueError && err.code === "unauthenticated")
        ) {
          console.error("loading the recipe failed", id, err);
        }
        setState({ kind: "error", error: err });
      },
    );
    return () => controller.abort();
  }, [id, attempt]);

  const justSaved = isSaveArrival(arrival);
  const loaded = state.kind === "loaded";
  useEffect(() => {
    if (justSaved && loaded) saved.current?.focus();
  }, [justSaved, loaded]);

  if (state.kind === "loading") {
    return (
      <p role="status" className="health" data-tone="pending">
        Loading the recipe…
      </p>
    );
  }

  if (state.kind === "error") {
    if (
      state.error instanceof RecipeError &&
      state.error.code === "not_found"
    ) {
      return (
        <section aria-labelledby="recipe-title">
          <h2 id="recipe-title">Recipe not found</h2>
          <div role="alert" className="health" data-tone="bad">
            <p>
              There is no recipe of yours at this address. It may have been
              deleted.
            </p>
          </div>
          <p>
            <Link to="/">Import a recipe</Link>
          </p>
        </section>
      );
    }
    const unauthenticated =
      (state.error instanceof RecipeError ||
        state.error instanceof CatalogueError) &&
      state.error.code === "unauthenticated";
    const reason =
      state.error instanceof Error
        ? state.error.message
        : "an unexpected error";
    return (
      <>
        <div role="alert" className="health" data-tone="bad">
          <p>
            {unauthenticated
              ? "Your session has ended. Sign in again to see this recipe."
              : `Can't reach the API: ${reason}. Check the api container is running (docker compose ps), then try again.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setState({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </>
    );
  }

  const { recipe, units } = state;
  const numbers = formatter(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }),
    () => new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }),
  );
  const dates = formatter(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "long" }),
    () => new Intl.DateTimeFormat(undefined, { dateStyle: "long" }),
  );
  const source = recipe.sourceUrl === null ? null : new URL(recipe.sourceUrl);

  function amount(line: RecipeLine): string {
    const quantity =
      line.quantity === null ? "" : numbers.format(Number(line.quantity));
    const unit =
      line.measurementId === null ? undefined : units.get(line.measurementId);
    return [quantity, unit && unitAbbreviation(unit, locale)]
      .filter(Boolean)
      .join(" ");
  }

  return (
    <article aria-labelledby="recipe-title" className="recipe">
      {justSaved && (
        <p
          ref={saved}
          role="status"
          tabIndex={-1}
          className="health"
          data-tone="good"
        >
          Recipe saved.
        </p>
      )}
      {justSaved && arrival.alreadyImported && (
        <p className="notice">
          You had imported this page before. This is a second copy; the earlier
          recipe is unchanged.
        </p>
      )}

      <h2 id="recipe-title">{recipe.title}</h2>
      {(recipe.servings !== null ||
        recipe.prepMinutes !== null ||
        recipe.cookMinutes !== null) && (
        <dl className="facts">
          {recipe.servings !== null && (
            <>
              <dt>Servings</dt>
              <dd>{recipe.servings}</dd>
            </>
          )}
          {recipe.prepMinutes !== null && (
            <>
              <dt>Prep time</dt>
              <dd>{minutes(recipe.prepMinutes)}</dd>
            </>
          )}
          {recipe.cookMinutes !== null && (
            <>
              <dt>Cook time</dt>
              <dd>{minutes(recipe.cookMinutes)}</dd>
            </>
          )}
        </dl>
      )}

      <h3>Ingredients</h3>
      {recipe.ingredients.length === 0 ? (
        <p>This recipe has no ingredients.</p>
      ) : (
        <ul className="recipe-lines">
          {recipe.ingredients.map((line) => (
            <li key={line.position}>
              <span className="amount">{amount(line)}</span>
              <span>
                {line.ingredient.name ?? "Unnamed ingredient"}
                {line.prepNotes !== null && `, ${line.prepNotes}`}
                {line.notes !== null && (
                  <span className="line-notes">{line.notes}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>Steps</h3>
      {recipe.steps.length === 0 ? (
        <p>This recipe has no steps.</p>
      ) : (
        <ol>
          {recipe.steps.map((step) => (
            <li key={step.position}>{step.text}</li>
          ))}
        </ol>
      )}

      {recipe.tags.length > 0 && (
        <>
          <h3>Tags</h3>
          <ul className="tags">
            {recipe.tags.map((tag) => (
              <li key={tag} className="badge">
                {tag}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Source</h3>
      <dl className="facts">
        {source && recipe.sourceUrl !== null && (
          <>
            <dt>Page</dt>
            <dd>
              <a href={recipe.sourceUrl}>
                {source.host + source.pathname}
                <span aria-hidden="true" className="external">
                  {" "}
                  ↗
                </span>
              </a>
            </dd>
          </>
        )}
        <dt>Imported</dt>
        <dd>
          <time dateTime={recipe.createdAt}>
            {dates.format(new Date(recipe.createdAt))}
          </time>
        </dd>
      </dl>

      <p>
        <Link to="/">Import another recipe</Link>
      </p>
    </article>
  );
}
